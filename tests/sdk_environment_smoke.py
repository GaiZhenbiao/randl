"""Verify environment, metric definitions, alerts and system metrics with the real SDK."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid


def main():
    base = os.environ.get("RANDL_URL", "http://127.0.0.1:8742").rstrip("/")
    if urllib.parse.urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("SDK tests require a loopback RANDL_URL")
    env = dict(os.environ)
    env.update(WANDB_BASE_URL=base, WANDB_API_KEY=env.get("RANDL_API_KEY") or "0" * 40, WANDB_MODE="online", WANDB_SILENT="true")
    run_name = "environment-" + uuid.uuid4().hex[:12]
    env["RANDL_FIXTURE_RUN"] = run_name
    with tempfile.TemporaryDirectory(prefix="randl-sdk-environment-") as directory:
        root = Path(directory)
        script = root / "train.py"
        script.write_text('''import os, time, wandb
with wandb.init(entity="local", project="sdk-environment", id=os.environ["RANDL_FIXTURE_RUN"], config={"learning_rate":0.01}, settings=wandb.Settings(init_timeout=30, x_stats_sampling_interval=0.5)) as run:
    run.define_metric("epoch")
    run.define_metric("val/*", step_metric="epoch", summary="min,max")
    run.define_metric("debug/loss", hidden=True)
    for epoch in range(4):
        run.log({"epoch":epoch*10,"val/loss":4-epoch,"debug/loss":epoch})
        time.sleep(0.6)
    run.alert(title="Environment test", text="Synthetic alert", level=wandb.AlertLevel.WARN)
''')
        def git(*args):
            return subprocess.run(["git", "-c", "user.name=Randl SDK test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q")
        git("add", "train.py")
        git("commit", "-qm", "Synthetic SDK fixture")
        commit = git("rev-parse", "HEAD")
        env["WANDB_DIR"] = str(root)
        result = subprocess.run([sys.executable, str(script), "--label", "space value", ""], cwd=root, env=env, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise AssertionError("SDK environment fixture failed: " + result.stderr[-2000:])
    headers = {"Authorization": "Bearer " + env["WANDB_API_KEY"]}
    def api(path, body=None):
        request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers={**headers, **({"Content-Type":"application/json"} if body is not None else {})})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    run_id = "local/sdk-environment/" + run_name
    detail = api("/api/run?id=" + urllib.parse.quote(run_id))
    run = detail["run"]
    metadata = json.loads(run["metadata"])
    for field in ["os", "python", "executable", "args"]:
        assert field in metadata, "Missing metadata field: " + field
    assert run["host"] and run["program"], "Missing host or program"
    assert run["git_commit"] == commit, "Git commit mismatch"
    assert run["exit_code"] == 0 and run["state"] == "finished"
    assert 1 <= run["runtime"] < 30, "Runtime outside fixture bounds"
    assert detail["alerts"][0]["title"] == "Environment test"
    metrics = api("/api/metrics", {"runs":[run_id]})
    assert metrics["definitions"]["val/loss"]["stepMetric"] == "epoch"
    assert metrics["definitions"]["debug/loss"]["hidden"] is True
    summary = json.loads(run["summary"])
    assert summary["val/loss"]["min"] == 1 and summary["val/loss"]["max"] == 4
    chart = api("/api/chart", {"runs":[run_id],"metrics":["val/loss"],"pixels":100})
    assert chart["xAxis"] == "epoch"
    assert chart["series"][0]["values"]["val/loss"] == [[0,4],[10,3],[20,2],[30,1]]
    system_keys = [key for key in metrics["metrics"] if key.startswith("system/")]
    assert system_keys, "No real SDK system metrics arrived"
    system = api("/api/chart", {"runs":[run_id],"metrics":[system_keys[0]],"pixels":100})
    assert len(system["series"][0]["values"][system_keys[0]]) >= 2
    print(json.dumps({"run":run_id,"environment_fields":"passed","git_commit":"passed","runtime":"passed","metric_definitions":"passed","summary_aggregates":"passed","alert":"passed","system_metrics":"passed"}))


if __name__ == "__main__":
    main()
