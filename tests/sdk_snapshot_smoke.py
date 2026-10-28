"""Resume an imported snapshot with the unmodified W&B SDK and continue logging into it.

`tests/sdk-gate.mjs` prepares the snapshot named by RANDL_SNAPSHOT_RUN in project
local/sdk-snapshots: 200 sampled records of a 20,000-step history (last step 19999),
two sparse records appended with earlier steps, sampled system events and a summary
with `_step` 19999 and `_runtime` 500. The run is resumed with resume="must", then
resume="allow" in a process that is killed without finishing, then resume="must" again.
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

TRAIN = '''import os, signal, sys, time, wandb
identity, mode, count, ending = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
run = wandb.init(entity="local", project="sdk-snapshots", id=identity, resume=mode,
                 settings=wandb.Settings(init_timeout=30, x_file_stream_transmit_interval=0.05))
for i in range(count):
    run.log({"loss": 0.5 - i / 100, "resumed_metric": i})
print("STARTING_STEP", run.step - count, flush=True)  # run.step is the next step to log
if ending == "kill":
    time.sleep(18)  # past one 15-second file stream transmission, then die without finishing
    os.kill(os.getpid(), signal.SIGKILL)
run.finish()
'''


def main():
    base = os.environ.get("RANDL_URL", "http://127.0.0.1:8742").rstrip("/")
    if urllib.parse.urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("SDK tests require a loopback RANDL_URL")
    name = os.environ["RANDL_SNAPSHOT_RUN"]
    run_id = "local/sdk-snapshots/" + name
    env = dict(os.environ)
    env.update(WANDB_BASE_URL=base, WANDB_API_KEY=env.get("RANDL_API_KEY") or "0" * 40,
               WANDB_MODE="online", WANDB_SILENT="true")
    headers = {"Authorization": "Bearer " + env["WANDB_API_KEY"]}

    def api(path, body=None):
        request = urllib.request.Request(
            base + path, data=json.dumps(body).encode() if body is not None else None,
            headers={**headers, **({"Content-Type": "application/json"} if body is not None else {})})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)

    def run():
        return api("/api/run?id=" + urllib.parse.quote(run_id))["run"]

    def steps(metric):
        chart = api("/api/chart", {"runs": [run_id], "metrics": [metric], "settings": {"resolution": "full"}})
        return chart["series"][0]["values"][metric]

    before = run()
    assert before["snapshot_at"] is not None and before["state"] == "running"
    with tempfile.TemporaryDirectory(prefix="randl-sdk-snapshot-") as directory:
        env["WANDB_DIR"] = directory
        script = os.path.join(directory, "train.py")
        with open(script, "w") as handle:
            handle.write(TRAIN)

        def train(mode, count, ending="finish"):
            result = subprocess.run([sys.executable, script, name, mode, str(count), ending], cwd=directory,
                                    env=env, capture_output=True, text=True, timeout=180)
            if ending == "finish" and result.returncode:
                raise AssertionError("SDK resume failed: " + result.stderr[-3000:])
            line = [item for item in result.stdout.splitlines() if item.startswith("STARTING_STEP")]
            return int(line[0].split()[1]) if line else None

        # 1. resume="must": the snapshot becomes a live run and continues after step 19999.
        start_20000 = train("must", 5)
        assert start_20000 == 20000, start_20000
        first = run()
        assert first["snapshot_at"] is None and first["resumed_at"] is not None
        assert first["state"] == "finished", first["state"]
        assert first["history_count"] == 202 + 5
        assert first["display_name"] == "Imported capture"
        assert json.loads(first["config"])["lr"]["value"] == 0.01
        assert 500 <= first["runtime"] < 600, first["runtime"]
        loss = steps("loss")
        assert len(loss) == 200 + 5 and loss[-5][0] == 20000 and loss[-1] == [20004, 0.46]
        assert json.loads(first["summary"])["loss"] == 0.46

        # 2. resume="allow" in a process killed after its rows were transmitted.
        start_20005 = train("allow", 3, "kill")
        assert start_20005 == 20005, start_20005
        killed = run()
        delivered = killed["history_count"] - 207
        assert killed["state"] == "running" and delivered == 3, (killed["state"], delivered)

        # 3. resume="must" after the crash continues after the rows the killed process sent.
        start_after = train("must", 2)
        assert start_after >= 20005 + delivered, (start_after, delivered)
        last = run()
        assert last["state"] == "finished" and last["history_count"] == 207 + delivered + 2
        resumed = [point[0] for point in steps("resumed_metric")]
        assert resumed[:5] == list(range(20000, 20005)) and resumed[-2:] == [start_after, start_after + 1]
        assert len(set(resumed)) == len(resumed) == 5 + delivered + 2, resumed
        assert len({point[0] for point in steps("loss")}) == 200 + 5 + delivered + 2
        assert 500 <= last["runtime"] < 900, last["runtime"]
        system = api("/api/metrics", {"runs": [run_id]})["metrics"]
        assert "system/cpu" in system
    print(json.dumps({"snapshot": name, "resume_must": "passed", "resume_allow_killed": "passed",
                      "resume_after_crash": "passed", "imported_history_kept": "passed",
                      "rows_delivered_before_kill": delivered, "next_step_after_crash": start_after}))


if __name__ == "__main__":
    main()
