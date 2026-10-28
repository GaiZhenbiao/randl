"""Prove a stop request interrupts an actual W&B SDK child process.

The SDK uses its default stop handler and default polling interval. No SDK
internals, callbacks, signals, or transport responses are mocked.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid


def child(identity, directory):
    import wandb

    run = wandb.init(
        entity="local", project="sdk-stop-tests", id=identity,
        dir=directory, resume="never",
        settings=wandb.Settings(init_timeout=20, x_file_stream_transmit_interval=0.05),
    )
    start = time.monotonic()
    step = 0
    try:
        while time.monotonic() - start < 75:
            run.log({"loss": 1 / (step + 1)})
            step += 1
            time.sleep(0.05)
    except KeyboardInterrupt:
        print("SDK_STOP_INTERRUPTED", flush=True)
        run.finish(exit_code=1)
        wandb.teardown()
        print(json.dumps({"sdk": wandb.__version__, "logged_steps": step}), flush=True)
        return
    run.finish()
    raise AssertionError("SDK stop request did not interrupt training within 75 seconds")


def resumed_child(identity, directory):
    import wandb

    run = wandb.init(
        entity="local", project="sdk-stop-tests", id=identity,
        dir=directory, resume="must",
        settings=wandb.Settings(init_timeout=20, x_file_stream_transmit_interval=0.05),
    )
    assert run.resumed, "Stopped run was not resumed by the SDK"
    run.log({"loss": 0.125})
    run.finish()
    wandb.teardown()
    print("SDK_STOP_RESUME_FINISHED", flush=True)


def main():
    base = os.environ.get("RANDL_URL", "http://127.0.0.1:8742").rstrip("/")
    if urllib.parse.urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("SDK stop smoke requires a loopback RANDL_URL")
    key = os.environ.get("RANDL_API_KEY") or "0" * 40
    identity = "sdk-stop-" + uuid.uuid4().hex[:12]
    run_id = "local/sdk-stop-tests/" + identity
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(route, body=None):
        headers = {"Authorization": "Bearer " + key}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        with opener.open(urllib.request.Request(base + route, data=data, headers=headers), timeout=10) as response:
            return json.load(response)

    with tempfile.TemporaryDirectory(prefix="randl-sdk-stop-") as directory:
        env = {
            **os.environ,
            "WANDB_BASE_URL": base, "WANDB_API_KEY": key,
            "WANDB_MODE": "online", "WANDB_SILENT": "true",
            "WANDB_DIR": directory, "WANDB_CACHE_DIR": str(Path(directory) / "cache"),
            "WANDB_DATA_DIR": str(Path(directory) / "staging"),
        }
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--child", identity, directory],
            cwd=directory, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    output = process.communicate()[0].replace(key, "[redacted]")
                    raise AssertionError("SDK child exited before stop request: " + output)
                record = next((run for run in request("/api/runs")["runs"] if run["id"] == run_id), None)
                if record and record["history_count"] > 0:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("SDK child did not upload a history row before the deadline")
            requested = time.monotonic()
            result = request("/api/tools/runs_update", {"ids": [run_id], "action": "stop"})
            assert result["ids"] == [run_id], result
            output = process.communicate(timeout=55)[0].replace(key, "[redacted]")
            elapsed = time.monotonic() - requested
            assert process.returncode == 0, output
            assert "SDK_STOP_INTERRUPTED" in output, output
            record = request("/api/run?" + urllib.parse.urlencode({"id": run_id}))["run"]
            assert record["state"] == "killed", record["state"]
            assert record["stop_requested"] == 1
            assert record["history_count"] > 0
            stopped_records = record["history_count"]
            resumed = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--resume-child", identity, directory],
                cwd=directory, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=30,
            )
            resumed_output = resumed.stdout.replace(key, "[redacted]")
            assert resumed.returncode == 0, resumed_output
            assert "SDK_STOP_RESUME_FINISHED" in resumed_output, resumed_output
            record = request("/api/run?" + urllib.parse.urlencode({"id": run_id}))["run"]
            assert record["state"] == "finished", record["state"]
            assert record["stop_requested"] == 0
            assert record["history_count"] == stopped_records + 1, record["history_count"]
            print(json.dumps({
                "run": run_id, "sdk_stop_interrupt": "passed", "resume_after_stop": "passed",
                "final_state": record["state"],
                "delivery_seconds": round(elapsed, 2), "history_records": record["history_count"],
            }))
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child(sys.argv[2], sys.argv[3])
    elif len(sys.argv) > 1 and sys.argv[1] == "--resume-child":
        resumed_child(sys.argv[2], sys.argv[3])
    else:
        main()
