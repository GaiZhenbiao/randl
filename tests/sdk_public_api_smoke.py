"""Resume a run without naming an entity, then read it through wandb.Api() and continue.

`tests/sdk-gate.mjs` serves this script with the server's default entity set to
`demo` and a sampled snapshot `demo/cartpole-ppo/captured` whose stored
history and summary end at step 19999. This mirrors a training job that calls
wandb.init(entity=None, project=..., id=..., resume="must"), reads
wandb.Api().run(path).lastHistoryStep and logs explicit steps after it.
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

TRAIN = '''import json, sys, wandb
run = wandb.init(project="cartpole-ppo", id="captured", resume="must",
                 settings=wandb.Settings(init_timeout=30))
remote = wandb.Api(timeout=30).run(run.entity + "/cartpole-ppo/captured")
last = remote.lastHistoryStep
listed = [item.id for item in wandb.Api(timeout=30).runs("demo/cartpole-ppo")]
for i in range(3):
    run.log({"loss": 0.25 - i / 100}, step=last + 1 + i)
print(json.dumps({"entity": run.entity, "last": last, "state": remote.state, "name": remote.name, "id": remote.id,
                  "lr": remote.config.get("lr"), "summary_loss": remote.summary.get("loss"),
                  "history_lines": remote.historyLineCount, "listed": listed}), flush=True)
run.finish()
'''


def main():
    base = os.environ.get("RANDL_URL", "http://127.0.0.1:8742").rstrip("/")
    if urllib.parse.urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("SDK tests require a loopback RANDL_URL")
    env = {key: value for key, value in os.environ.items() if not key.startswith("WANDB_")}
    env.update(WANDB_BASE_URL=base, WANDB_API_KEY=os.environ.get("RANDL_API_KEY") or "0" * 40,
               WANDB_MODE="online", WANDB_SILENT="true")
    headers = {"Authorization": "Bearer " + env["WANDB_API_KEY"]}

    def api(path, body=None):
        request = urllib.request.Request(
            base + path, data=json.dumps(body).encode() if body is not None else None,
            headers={**headers, **({"Content-Type": "application/json"} if body is not None else {})})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)

    run_id = "demo/cartpole-ppo/captured"
    with tempfile.TemporaryDirectory(prefix="randl-sdk-public-api-") as directory:
        env["WANDB_DIR"] = directory
        script = os.path.join(directory, "train.py")
        with open(script, "w") as handle:
            handle.write(TRAIN)
        result = subprocess.run([sys.executable, script], cwd=directory, env=env,
                                capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise AssertionError("Training job failed: " + result.stderr[-3000:])
        seen = json.loads(result.stdout.strip().splitlines()[-1])
    assert seen["entity"] == "demo", seen
    assert seen["last"] == 19999, seen
    assert seen["id"] == "captured" and seen["name"] == "Imported capture", seen
    assert seen["lr"] == 0.01, seen
    assert seen["state"] == "running" and seen["summary_loss"] == 1.0001, seen
    assert seen["history_lines"] == 202, seen
    assert seen["listed"] == ["captured"], seen
    run = api("/api/run?id=" + urllib.parse.quote(run_id))["run"]
    assert run["snapshot_at"] is None and run["state"] == "finished", run["state"]
    chart = api("/api/chart", {"runs": [run_id], "metrics": ["loss"], "settings": {"resolution": "full"}})
    loss = chart["series"][0]["values"]["loss"]
    assert loss[-3:] == [[20000, 0.25], [20001, 0.24], [20002, 0.23]], loss[-3:]
    print(json.dumps({"default_entity": "passed", "last_history_step": seen["last"],
                      "api_run_fields": "passed", "api_runs_list": "passed",
                      "explicit_steps_after_last": "passed"}))


if __name__ == "__main__":
    main()
