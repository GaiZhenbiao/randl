"""Exercise the unmodified W&B SDK against a running local randl server."""
import json
import time
import hashlib
import io
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import urllib.parse
import urllib.request
import uuid
import wave

import wandb
from PIL import Image


def main():
    base = os.environ.get("RANDL_URL", "http://127.0.0.1:8742").rstrip("/")
    if urllib.parse.urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("SDK smoke tests require a loopback RANDL_URL")
    os.environ["WANDB_BASE_URL"] = base
    api_key = os.environ.get("RANDL_API_KEY") or "0" * 40
    os.environ["WANDB_API_KEY"] = api_key
    os.environ["WANDB_MODE"] = "online"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get_response(route, **query):
        url = base + route + "?" + urllib.parse.urlencode(query)
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + api_key})
        with opener.open(request, timeout=20) as response:
            return response.read(), response.headers.get_content_type()

    def get(route, **query):
        return get_response(route, **query)[0]

    def post(route, body):
        request = urllib.request.Request(
            base + route, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
        )
        with opener.open(request, timeout=20) as response:
            return json.load(response)

    identity = "sdk-" + uuid.uuid4().hex[:12]
    run_id = "local/sdk-tests/" + identity
    payload = bytes(range(256)) * 7 + b"\x00\xff\r\nrandl SDK upload\x00"
    with tempfile.TemporaryDirectory(prefix="randl-sdk-") as directory:
        os.environ["WANDB_DIR"] = directory
        os.environ["WANDB_CACHE_DIR"] = str(Path(directory) / "cache")
        os.environ["WANDB_DATA_DIR"] = str(Path(directory) / "staging")
        image_path = Path(directory) / "image.png"
        image = Image.new("RGB", (4, 3))
        image.putdata([(x * 60, y * 70, 120) for y in range(3) for x in range(4)])
        image.save(image_path)
        audio_path = Path(directory) / "audio.wav"
        samples = [round(12000 * math.sin(2 * math.pi * 440 * i / 8000)) for i in range(800)]
        with wave.open(str(audio_path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(struct.pack("<" + "h" * len(samples), *samples))
        video_path = Path(directory) / "video.mp4"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i", "color=c=blue:s=16x16:r=4",
            "-frames:v", "2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-y", str(video_path),
        ], check=True, capture_output=True, timeout=20)
        # A longer clip with a keyframe each second, so players seek within it by byte range.
        reel_path = Path(directory) / "reel.mp4"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i", "testsrc=s=320x240:r=10:d=8",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", "-b:v", "400k",
            "-movflags", "+faststart", "-y", str(reel_path),
        ], check=True, capture_output=True, timeout=30)
        media_sources = {
            "image": (image_path.read_bytes(), "image-file", "image/png"),
            "audio": (audio_path.read_bytes(), "audio-file", "audio/wav"),
            "video": (video_path.read_bytes(), "video-file", "video/mp4"),
        }
        settings = wandb.Settings(init_timeout=20)
        run = wandb.init(
            entity="local", project="sdk-tests", id=identity,
            name="SDK compatibility test", config={"lr": 0.003},
            dir=directory, settings=settings, resume="never",
        )
        table_rows = [["first", 1], ["你好", 2]]
        for i in range(12):
            values = {"reward": i, "loss": 1 / (i + 1)}
            if i == 0:
                values["distribution"] = wandb.Histogram(np_histogram=([2, 1], [0, 1, 2]))
                values["examples"] = wandb.Table(columns=["label", "score"], data=table_rows)
                values["image"] = wandb.Image(str(image_path), caption="Tiny image fixture")
                values["audio"] = wandb.Audio(str(audio_path), caption="Short tone fixture")
                values["video"] = wandb.Video(str(video_path), format="mp4", caption="Two-frame fixture")
            if i in (0, 4, 8):
                # Several images per step, and video and audio at three steps.
                values["gallery"] = [
                    wandb.Image(str(image_path), caption=f"Gallery {i} · {k}") for k in range(3)
                ]
                values["clips"] = wandb.Video(str(video_path), format="mp4")
                values["tones"] = wandb.Audio(str(audio_path))
                # A list of videos logs one collection per step. (Audio lists need the
                # optional soundfile package; tests/media-browser.mjs logs one directly.)
                values["reels"] = [
                    wandb.Video(str(reel_path), format="mp4", caption=f"Reel {i} · {k}") for k in range(3)
                ]
            run.log(values)
        run.summary["result"] = 42
        upload = Path(directory) / "payload.bin"
        upload.write_bytes(payload)
        run.save(str(upload), base_path=directory, policy="now")
        run.finish()
        assert get("/api/run-files", run=run_id, path="payload.bin") == payload, (
            "SDK upload must preserve every binary byte"
        )
        histogram = post("/api/media", {"runs": [run_id], "metric": "distribution"})["entries"]
        assert len(histogram) == 1 and histogram[0]["step"] == 0, histogram
        assert histogram[0]["value"]["values"] == [2, 1], histogram
        assert histogram[0]["value"]["bins"] == [0, 1, 2], histogram
        tables = post("/api/media", {"runs": [run_id], "metric": "examples"})["entries"]
        assert len(tables) == 1 and tables[0]["step"] == 0, tables
        table = json.loads(get("/api/run-file-preview", run=run_id, path=tables[0]["value"]["path"]))
        assert table["columns"] == ["label", "score"], table
        assert table["data"] == table_rows, table
        assert not table["truncated"], table
        for metric, (expected_bytes, expected_type, expected_mime) in media_sources.items():
            entries = post("/api/media", {"runs": [run_id], "metric": metric})["entries"]
            assert len(entries) == 1 and entries[0]["step"] == 0, (metric, entries)
            value = entries[0]["value"]
            assert value["_type"] == expected_type, (metric, value)
            assert value["size"] == len(expected_bytes), (metric, value)
            assert value["sha256"] == hashlib.sha256(expected_bytes).hexdigest(), (metric, value)
            assert get("/api/run-files", run=run_id, path=value["path"]) == expected_bytes, metric
            preview, mime = get_response("/api/run-file-preview", run=run_id, path=value["path"])
            assert preview == expected_bytes, metric
            assert mime == expected_mime, (metric, mime)
            if metric == "image":
                assert (value["width"], value["height"]) == (4, 3), value
                with Image.open(io.BytesIO(preview)) as decoded:
                    assert decoded.size == (4, 3)
                    assert decoded.getpixel((3, 2)) == (180, 140, 120)
            elif metric == "audio":
                with wave.open(io.BytesIO(preview), "rb") as decoded:
                    assert (decoded.getnchannels(), decoded.getframerate(), decoded.getnframes()) == (1, 8000, 800)

        gallery = post("/api/media", {"runs": [run_id], "metric": "gallery"})
        assert gallery["steps"] == [0, 4, 8] and gallery["step"] == 8, gallery
        latest = gallery["entries"][0]["value"]
        assert latest["_type"] == "images/separated" and len(latest["filenames"]) == 3, latest
        assert (latest["width"], latest["height"]) == (4, 3), latest
        for path in latest["filenames"]:
            assert get("/api/run-file-preview", run=run_id, path=path) == image_path.read_bytes()
        at_step = post("/api/media", {"runs": [run_id], "metric": "gallery", "step": 5})
        assert [entry["step"] for entry in at_step["entries"]] == [4], at_step
        limited = post("/api/media", {"runs": [run_id], "metric": "gallery", "files": 2})
        entry = limited["entries"][0]
        assert len(entry["value"]["filenames"]) == 2 and entry["files"] == 3, entry
        reels = post("/api/media", {"runs": [run_id], "metric": "reels"})
        assert reels["steps"] == [0, 4, 8], reels
        reel = reels["entries"][0]["value"]
        assert reel["_type"] == "videos" and reel["count"] == 3, reel
        reel_bytes = reel_path.read_bytes()
        for k, item in enumerate(reel["videos"]):
            assert item["_type"] == "video-file" and item["sha256"] == hashlib.sha256(reel_bytes).hexdigest(), item
            assert get("/api/run-file-preview", run=run_id, path=item["path"]) == reel_bytes
        limited_reels = post("/api/media", {"runs": [run_id], "metric": "reels", "files": 2})["entries"][0]
        assert len(limited_reels["value"]["videos"]) == 2 and limited_reels["files"] == 3, limited_reels
        ranged = urllib.request.Request(
            base + "/api/run-file-preview?" + urllib.parse.urlencode({"run": run_id, "path": reel["videos"][1]["path"]}),
            headers={"Authorization": "Bearer " + api_key, "Range": "bytes=100-199"},
        )
        with opener.open(ranged, timeout=20) as response:
            assert response.status == 206, response.status
            assert response.headers["Content-Range"] == f"bytes 100-199/{len(reel_bytes)}", response.headers
            assert response.read() == reel_bytes[100:200]
        assert reel["captions"] == [f"Reel 8 · {k}" for k in range(3)], reel
        assert post("/api/metrics", {"runs": [run_id]})["kinds"]["reels"] == ["videos"]
        for metric in ("gallery", "clips", "tones", "reels"):
            across = post("/api/media", {"runs": [run_id], "metric": metric, "across": "steps", "run": run_id})
            assert [entry["step"] for entry in across["entries"]] == [0, 4, 8], (metric, across)
        before_resume = json.loads(get("/api/run", id=run_id))["run"]["runtime"]
        # The pause between the two sessions must not count as runtime.
        time.sleep(10)
        session_start = time.time()
        run = wandb.init(
            entity="local", project="sdk-tests", id=identity,
            resume="must", dir=directory, settings=settings,
        )
        assert run.resumed, "SDK did not acknowledge the existing run"
        run.log({"reward": 99, "loss": 0.001})
        run.finish()
        session = time.time() - session_start
        record = json.loads(get("/api/run", id=run_id))["run"]
        assert before_resume <= record["runtime"] <= before_resume + session + 2, (
            before_resume, record["runtime"], session,
        )
        assert record["history_count"] == 13, record["history_count"]
        assert record["state"] == "finished", record["state"]
        assert json.loads(record["config"])["lr"]["value"] == 0.003
        assert json.loads(record["summary"])["result"] == 42
        assert get("/api/run-files", run=run_id, path="payload.bin") == payload

        failed_id = identity + "-failed"
        failed = wandb.init(
            entity="local", project="sdk-tests", id=failed_id,
            dir=directory, settings=settings, resume="never",
        )
        failed.log({"loss": 3})
        failed.finish(exit_code=1)
        record = json.loads(get("/api/run", id="local/sdk-tests/" + failed_id))["run"]
        assert record["state"] == "failed", record["state"]
        assert record["history_count"] == 1, record["history_count"]
        # Catalogs are scoped to exactly the requested SDK runs, including media kinds.
        primary_catalog = post("/api/metrics", {"runs": [run_id]})
        failed_catalog = post("/api/metrics", {"runs": ["local/sdk-tests/" + failed_id]})
        assert "reward" in primary_catalog["metrics"]
        assert "image-file" in primary_catalog["kinds"]["image"]
        assert "loss" in failed_catalog["metrics"]
        assert "reward" not in failed_catalog["metrics"]
        assert "image" not in failed_catalog["kinds"]
        wandb.teardown()

    print(json.dumps({
        "sdk": wandb.__version__, "history_records": 13,
        "resume": "passed", "resume_runtime_excludes_pause": "passed", "binary_upload_bytes": len(payload),
        "summary_config": "passed", "failed_finish": "passed",
        "histogram_and_table": "passed", "run_scoped_catalog": "passed",
        "image_audio_video": "passed", "media_byte_comparisons": 6,
        "media_steps_and_lists": "passed", "video_lists_and_ranges": "passed",
    }))


if __name__ == "__main__":
    main()
