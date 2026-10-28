"""Verify the Connect SDK commands: wandb login --host and wandb sync of an offline run."""
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
    key = os.environ.get("RANDL_API_KEY") or "0" * 40
    project = "sdk-connect-" + uuid.uuid4().hex[:8]
    script = 'import sys, wandb\nwith wandb.init(entity="local", project=sys.argv[1], name=sys.argv[2]) as run:\n    [run.log({"loss": 1 / (i + 1)}) for i in range(3)]\n'
    with tempfile.TemporaryDirectory(prefix="randl-sdk-connect-") as directory:
        root = Path(directory)
        (root / "train.py").write_text(script)
        # An isolated user account: wandb login writes its settings and netrc under HOME.
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(root),
            "WANDB_DIR": str(root),
            "WANDB_CONFIG_DIR": str(root / "config"),
            "WANDB_CACHE_DIR": str(root / "cache"),
            "WANDB_DATA_DIR": str(root / "data"),
            "WANDB_SILENT": "true",
        }

        def run(*args, extra=None):
            result = subprocess.run(args, cwd=root, env={**env, **(extra or {})}, capture_output=True, text=True, timeout=120)
            if result.returncode:
                raise AssertionError(" ".join(args[:4]) + " failed: " + result.stderr[-2000:])
            return result

        run(sys.executable, "-m", "wandb", "login", "--relogin", "--host", base, key)
        run(sys.executable, str(root / "train.py"), project, "after-login")
        run(sys.executable, str(root / "train.py"), project, "offline", extra={"WANDB_MODE": "offline"})
        offline = sorted(str(path) for path in (root / "wandb").glob("offline-run-*"))
        assert len(offline) == 1, "Expected one offline run directory"
        run(sys.executable, "-m", "wandb", "sync", *offline, extra={"WANDB_BASE_URL": base, "WANDB_API_KEY": key})
    request = urllib.request.Request(base + "/api/runs", headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(request, timeout=15) as response:
        runs = {item["display_name"]: item for item in json.load(response)["runs"] if item["project"] == project}
    for name in ["after-login", "offline"]:
        assert name in runs, "Run missing after " + name
        assert runs[name]["history_count"] == 3 and runs[name]["state"] == "finished", name
    print(json.dumps({"project": "local/" + project, "login_host": "passed", "offline_sync": "passed"}))


if __name__ == "__main__":
    main()
