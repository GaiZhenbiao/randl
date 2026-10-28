"""Illustrative experiments for the README screenshots, logged with the stock W&B SDK.

Every value is synthetic: metric curves come from closed-form shapes plus seeded noise,
images are procedurally drawn sprites, and videos are rendered CartPole simulations and
denoising animations encoded with ffmpeg. Point WANDB_BASE_URL at a scratch randl server.

    WANDB_BASE_URL=http://127.0.0.1:8980 WANDB_API_KEY=0000000000000000000000000000000000000000 \\
      .venv-sdk/bin/python scripts/readme-demo.py --work-dir tmp/readme/work

Each run spreads its logging over about `--pace` seconds (default 60), so runtimes are not
zero. `--live SECONDS` logs one Lunar Lander run slowly for that long instead, so a run is
running while screenshots are taken. Requires numpy, Pillow and ffmpeg on PATH.
"""

import argparse
import math
import os
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import wandb
from PIL import Image, ImageDraw, ImageFont

ENTITY = "demo"


def settings(program):
    """Keeps this machine's name, paths and system metrics out of the illustrative runs."""
    return wandb.Settings(x_disable_meta=True, x_disable_stats=True, disable_git=True,
                          save_code=False, host="gpu-node-01", program=program,
                          program_relpath=program, program_abspath="/srv/experiments/" + program)


def encode(frames, path, fps):
    """Encodes RGB frames (H x W x 3 uint8) to an H.264 MP4 file."""
    height, width = frames[0].shape[:2]
    process = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart", path],
        stdin=subprocess.PIPE,
    )
    for frame in frames:
        process.stdin.write(frame.tobytes())
    process.stdin.close()
    if process.wait():
        raise RuntimeError("ffmpeg failed for " + path)
    return path


# CartPole -----------------------------------------------------------------------------

def sigmoid(value):
    return 1 / (1 + math.exp(-value))


def cartpole_return(lr, seed, t, rng):
    """Mean episodic return at training fraction t for a learning rate and seed."""
    shift = (seed - 2) * 0.04
    if lr == 1e-4:
        value = 470 * sigmoid((t - 0.62 - shift) * 9) + 20
    elif lr == 3e-4:
        value = 480 * sigmoid((t - 0.3 - shift) * 12) + 18 - 25 * math.exp(-((t - 0.7) / 0.03) ** 2)
    elif lr == 1e-3:
        dips = 140 * math.exp(-((t - 0.45 - shift) / 0.04) ** 2) + 210 * math.exp(-((t - 0.78) / 0.03) ** 2)
        value = 470 * sigmoid((t - 0.16 - shift) * 16) + 20 - dips
    else:
        value = 230 * math.exp(-((t - 0.22 - shift) / 0.12) ** 2) + 30 + 15 * math.sin(t * 40 + seed)
    return float(np.clip(value * (1 + rng.normal(0, 0.08)), 9, 500))


def cartpole_frames(quality, seed, frames=100, size=(360, 220)):
    """A CartPole episode where a noisier controller stands for a weaker policy."""
    rng = np.random.default_rng(seed)
    width, height = size
    font = ImageFont.load_default(size=13)
    x, x_dot, theta, theta_dot = rng.uniform(-0.05, 0.05, 4)
    episode, t, result = 1, 0, []
    explore = 0.9 * (1 - quality) ** 1.2
    for _ in range(frames):
        for _ in range(2):
            push = 10 * theta + 2.2 * theta_dot + 0.35 * x + 0.9 * x_dot
            if rng.random() < explore:
                push = rng.normal()
            force = 10.0 if push > 0 else -10.0
            cos, sin = math.cos(theta), math.sin(theta)
            temp = (force + 0.05 * theta_dot**2 * sin) / 1.1
            theta_acc = (9.8 * sin - cos * temp) / (0.5 * (4 / 3 - 0.1 * cos**2 / 1.1))
            x_acc = temp - 0.05 * theta_acc * cos / 1.1
            x, x_dot = x + 0.02 * x_dot, x_dot + 0.02 * x_acc
            theta, theta_dot = theta + 0.02 * theta_dot, theta_dot + 0.02 * theta_acc
            t += 1
            if abs(theta) > 0.21 or abs(x) > 2.4:
                x, x_dot, theta, theta_dot = rng.uniform(-0.05, 0.05, 4)
                episode, t = episode + 1, 0
        image = Image.new("RGB", size, (250, 250, 248))
        draw = ImageDraw.Draw(image)
        scale, track = width / 4.8, height * 0.68
        cart_x = width / 2 + x * scale
        draw.line([(0, track + 12), (width, track + 12)], fill=(60, 60, 60), width=2)
        draw.rectangle([cart_x - 26, track - 6, cart_x + 26, track + 10], fill=(38, 50, 56))
        dx, dy = math.sin(theta) * scale, -math.cos(theta) * scale
        nx, ny = -dy / scale * 4.5, dx / scale * 4.5
        base = (cart_x, track - 6)
        draw.polygon([(base[0] + nx, base[1] + ny), (base[0] + dx + nx, base[1] + dy + ny),
                      (base[0] + dx - nx, base[1] + dy - ny), (base[0] - nx, base[1] - ny)],
                     fill=(202, 152, 101))
        draw.ellipse([cart_x - 4, track - 10, cart_x + 4, track - 2], fill=(129, 132, 203))
        draw.text((10, 8), f"episode {episode}   t = {t}", fill=(80, 80, 80), font=font)
        result.append(np.asarray(image))
    return result


def cartpole_run(args):
    lr, seed, work, pace = args
    rng = np.random.default_rng(int(lr * 1e6) + seed)
    name = f"ppo-lr{lr:.0e}-s{seed}".replace("e-0", "e-")
    updates, batch = 400, 1024
    config = dict(env_id="CartPole-v1", algo="ppo", learning_rate=lr, seed=seed, num_envs=8,
                  num_steps=128, gamma=0.99, gae_lambda=0.95, clip_coef=0.2, ent_coef=0.01,
                  update_epochs=4, total_timesteps=updates * batch, anneal_lr=True)
    tags = ["lr-sweep", "baseline"] if lr == 3e-4 else ["lr-sweep"]
    with wandb.init(entity=ENTITY, project="cartpole-ppo", name=name, group=f"lr={lr:g}",
                    config=config, tags=tags, settings=settings("ppo_cartpole.py")) as run:
        run.define_metric("global_step")
        for prefix in ("charts/*", "losses/*", "rollout/*"):
            run.define_metric(prefix, step_metric="global_step")
        window, best = [], 0  # (episodes, falls) of the last 20 updates; best return
        floor = 0.12 + 0.05 * seed
        for update in range(updates):
            t = update / (updates - 1)
            ret = cartpole_return(lr, seed, t, rng)
            best = max(best, ret)
            entropy = floor + (0.69 - floor) * math.exp(-t * lr / 1e-4 * 1.6)
            entropy *= 1 + rng.normal(0, 0.015)
            episodes = max(1, round(batch / ret))
            window = (window + [(episodes, episodes - int(rng.binomial(episodes, min(1, (ret / 500) ** 4))))])[-20:]
            row = {
                "global_step": (update + 1) * batch,
                "charts/episodic_return": round(ret, 1),
                "charts/episodic_length": round(ret),
                "charts/learning_rate": lr * (1 - t),
                "charts/SPS": round(2450 + rng.normal(0, 60) - 300 * math.exp(-update / 5)),
                "losses/policy_loss": round(float(rng.normal(-0.012, 0.008) * (1 + lr / 3e-4) / 2), 5),
                "losses/value_loss": round(float(abs(rng.normal(0, 1)) * 40 * (1 - ret / 520) + 2), 3),
                "losses/entropy": round(entropy, 4),
                "losses/approx_kl": round(float(abs(rng.normal(0.004, 0.002)) * lr / 3e-4), 5),
                "losses/clipfrac": round(float(min(0.6, abs(rng.normal(0.05, 0.02)) * (lr / 3e-4) ** 0.7)), 4),
                "rollout/episodes": sum(item[0] for item in window),
                "rollout/pole_falls": sum(item[1] for item in window),
            }
            if update in (0, 80, 160, 240, 320, 399):
                quality = min(1, ret / 500)
                path = os.path.join(work, f"{name}-{update}.mp4")
                encode(cartpole_frames(quality, seed * 1000 + update), path, fps=25)
                row["rollout/video"] = wandb.Video(path, format="mp4", caption=f"return {ret:.0f}")
            run.log(row)
            time.sleep(pace / updates)
            if update % 40 == 0 or update == updates - 1:
                print(f"global_step={row['global_step']:>7} episodic_return={ret:6.1f} "
                      f"entropy={entropy:.3f} SPS={row['charts/SPS']:.0f}")
        run.summary["best_return"] = round(best, 1)
        if lr == 3e-4 and seed == 1:
            weights = os.path.join(work, "policy.npz")
            np.savez(weights, actor=rng.normal(size=(64, 4)), critic=rng.normal(size=(64, 4)))
            artifact = wandb.Artifact("ppo-cartpole-policy", type="model",
                                      metadata={"episodic_return": 500, "framework": "numpy"})
            artifact.add_file(weights)
            run.log_artifact(artifact, aliases=["best"])
    return name


# Sprite diffusion -----------------------------------------------------------------------

PALETTES = [((46, 196, 182), (25, 80, 120)), ((255, 159, 28), (140, 60, 20)),
            ((231, 29, 54), (90, 20, 50)), ((136, 84, 208), (40, 30, 90)),
            ((88, 196, 80), (30, 90, 40)), ((240, 200, 40), (120, 80, 10)),
            ((60, 140, 230), (20, 40, 110)), ((240, 110, 170), (110, 30, 80))]


def sprite(index, color, size=96):
    """A mirrored 10x10 pixel creature in two colors on a dark background."""
    rng = np.random.default_rng(1000 + index)
    half = rng.random((10, 5)) < 0.5
    half[0, :] = half[-1, :] = False
    shape = np.concatenate([half, half[:, ::-1]], axis=1)
    accent = (rng.random((10, 10)) < 0.25) & shape
    accent |= accent[:, ::-1]
    light, dark = PALETTES[color % len(PALETTES)]
    grid = np.full((10, 10, 3), (18, 20, 28), dtype=np.float64)
    grid[shape] = light
    grid[accent] = dark
    padded = np.full((12, 12, 3), (18, 20, 28), dtype=np.float64)
    padded[1:11, 1:11] = grid
    return np.kron(padded, np.ones((size // 12, size // 12, 1)))


def denoised(clean, clarity, rng):
    """A sample partway to `clean`: blurred blobs under noise early, crisp pixels late."""
    noise = rng.normal(70, 60, clean.shape)
    size = clean.shape[1::-1]
    blurred = Image.fromarray(clean.astype(np.uint8)).resize((4, 4), Image.BILINEAR)
    soft = np.asarray(blurred.resize(size, Image.BICUBIC), dtype=np.float64)
    weight = clarity**1.4
    mixed = weight * clean + (1 - weight) * (0.55 * soft + 0.45 * noise)
    return np.clip(mixed, 0, 255).astype(np.uint8)


def sprite_run(args):
    index, name, ceiling, schedule, work, pace = args
    rng = np.random.default_rng(len(name) * 7 + int(ceiling * 100))
    config = dict(model="unet-small", image_size=96, timesteps=1000, noise_schedule=schedule,
                  batch_size=128, learning_rate=2e-4, ema_decay=0.999 if "ema" in name else None,
                  sampler="ddim" if "ddim" in name else "ddpm")
    with wandb.init(entity=ENTITY, project="sprite-diffusion", name=name, config=config,
                    settings=settings("train_diffusion.py")) as run:
        steps, evaluations = 2000, 10
        for step in range(0, steps + 1, 5):
            t = step / steps
            row = {
                "train/loss": round(float(0.02 + 0.03 * (1 - ceiling) / 0.22 + 0.6 * math.exp(-t * (7 + 4 * ceiling))
                                          + abs(rng.normal(0, 0.006))), 5),
                "train/grad_norm": round(float(0.4 + 2.5 * math.exp(-t * 6) + abs(rng.normal(0, 0.15))), 4),
                "train/lr": 2e-4 * min(1, step / 100) * (0.5 + 0.5 * math.cos(math.pi * t)),
            }
            if step % (steps // evaluations) == 0:
                clarity = ceiling * (step / steps) ** 0.6
                row["eval/fid"] = round(float(12 + 240 * (1 - clarity) ** 2 + rng.normal(0, 2)), 2)
                row["samples"] = [
                    wandb.Image(denoised(sprite(index * 8 + i, i), clarity, rng), caption=f"sample {i}")
                    for i in range(8)
                ]
                if step in (0, steps // 2, steps):
                    frames = []
                    for k in range(40):
                        image = denoised(sprite(index * 8 + 3, 3), clarity * k / 39, rng)
                        frames.append(np.asarray(Image.fromarray(image).resize((192, 192), Image.NEAREST)))
                    frames += frames[-1:] * 12
                    path = os.path.join(work, f"{name}-{step}.mp4")
                    row["denoising"] = wandb.Video(encode(frames, path, fps=16), format="mp4")
            run.log(row, step=step)
            time.sleep(pace / 400)
        if name == "ddpm-cosine":
            data = os.path.join(work, "sprites.npz")
            np.savez(data, sprites=np.stack([sprite(i, i) for i in range(8)]).astype(np.uint8))
            dataset = wandb.Artifact("sprites-96px", type="dataset", metadata={"classes": 8})
            dataset.add_file(data)
            run.log_artifact(dataset)
    return name


# Lunar Lander and text classification ---------------------------------------------------

def lander_row(t, quality, rng):
    return {
        "charts/episodic_return": round(float(-180 + (230 + 60 * quality) * sigmoid((t - 0.4) * 8) + rng.normal(0, 25)), 1),
        "charts/epsilon": round(max(0.05, 1 - t * 2), 3),
        "losses/td_loss": round(float(abs(rng.normal(0, 1)) * 6 * math.exp(-t * 2) + 0.5), 4),
        "losses/q_values": round(float(20 * sigmoid((t - 0.3) * 6) + rng.normal(0, 0.8)), 3),
    }


def lander_run(args):
    name, quality, seconds, failed = args
    rng = np.random.default_rng(int(quality * 1000) + len(name))
    config = dict(env_id="LunarLander-v3", algo="dqn", buffer_size=100_000, learning_rate=6.3e-4,
                  double_q="double" in name, dueling="dueling" in name, prioritized="per" in name)
    run = wandb.init(entity=ENTITY, project="lunar-lander-dqn", name=name, config=config,
                     settings=settings("dqn_lunar.py"))
    total = 120 if failed else 300
    for step in range(total):
        run.log(lander_row(step / 299, quality, rng), step=step * 1000)
        time.sleep(seconds / total)
    if failed:
        print("ValueError: replay buffer sample returned NaN priorities")
    run.finish(exit_code=1 if failed else 0)
    return name


def text_run(args):
    name, lr, final, failed, pace = args
    rng = np.random.default_rng(int(lr * 1e7))
    config = dict(model="distilbert-base-uncased", dataset="sst2", learning_rate=lr,
                  batch_size=32, warmup_ratio=0.06, epochs=3)
    run = wandb.init(entity=ENTITY, project="sentiment-distilbert", name=name, config=config,
                     settings=settings("finetune_sst2.py"))
    last = 600 if failed else 1260
    for step in range(0, last + 1, 10):
        t = step / 1260
        row = {"train/loss": round(float(0.18 + 0.52 * math.exp(-t * 5) + abs(rng.normal(0, 0.03))), 4)}
        if step % 210 == 0:
            row["eval/accuracy"] = round(float(0.5 + (final - 0.5) * (1 - math.exp(-t * 6)) + rng.normal(0, 0.004)), 4)
            row["eval/f1"] = round(row["eval/accuracy"] - 0.004, 4)
        run.log(row, step=step)
        time.sleep(pace / 127)
    if failed:
        print("RuntimeError: CUDA out of memory while allocating 1.50 GiB")
    run.finish(exit_code=1 if failed else 0)
    return name


def mnist_run(args):
    name, hidden = args
    rng = np.random.default_rng(hidden)
    with wandb.init(entity=ENTITY, project="mnist-mlp", name=name, config={"hidden": hidden},
                    settings=settings("mlp.py")) as run:
        for epoch in range(20):
            run.log({"val/accuracy": round(float(0.97 + 0.012 * (1 - math.exp(-epoch / 4)) * hidden / 512
                                                 + rng.normal(0, 0.001)), 4)}, step=epoch)
    return name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--live", type=float, default=0)
    parser.add_argument("--pace", type=float, default=60, help="seconds each run spends logging")
    options = parser.parse_args()
    work = os.path.abspath(options.work_dir)
    os.makedirs(work, exist_ok=True)
    if options.live:
        lander_run(("dqn-dueling-s2", 0.8, options.live, False))
        return
    pace = options.pace
    jobs = [(cartpole_run, (lr, seed, work, pace * (0.8 + seed / 10)))
            for lr in (1e-4, 3e-4, 1e-3, 3e-3) for seed in (1, 2, 3)]
    jobs += [(sprite_run, (index, name, ceiling, schedule, work, pace * 1.3))
             for index, (name, ceiling, schedule) in enumerate(
                 (("ddpm-linear", 0.78, "linear"), ("ddpm-cosine", 0.92, "cosine"),
                  ("ddpm-cosine-ema", 1.0, "cosine"), ("ddim-50", 0.86, "cosine")))]
    jobs += [(lander_run, (name, quality, pace * (0.6 + quality / 2), name == "dqn-noisy"))
             for name, quality in (("dqn-baseline", 0.3), ("dqn-double", 0.55), ("dqn-per", 0.7),
                                   ("dqn-dueling-s1", 0.75), ("dqn-noisy", 0.5))]
    jobs += [(text_run, args + (pace * 0.7,)) for args in
             (("lr2e-5-bs32", 2e-5, 0.905, False), ("lr3e-5-bs32", 3e-5, 0.912, False),
              ("lr5e-5-bs32", 5e-5, 0.908, False), ("lr5e-5-bs64", 5e-5, 0.9, True))]
    jobs += [(mnist_run, (f"mlp-{hidden}", hidden)) for hidden in (128, 512)]
    with ProcessPoolExecutor(len(jobs)) as pool:
        futures = [pool.submit(function, args) for function, args in jobs]
        for future in futures:
            print("logged", future.result(), flush=True)


if __name__ == "__main__":
    main()
