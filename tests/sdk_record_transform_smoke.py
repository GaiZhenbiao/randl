"""Check same-record chart transforms through real W&B SDK logging."""
import json
import math
import os
import tempfile
import urllib.parse
import urllib.request
import uuid

base = os.environ.get("RANDL_URL", "http://127.0.0.1:8742").rstrip("/")
if urllib.parse.urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise ValueError("SDK tests require a loopback RANDL_URL")
key = os.environ.get("RANDL_API_KEY") or "0" * 40
os.environ.update(WANDB_BASE_URL=base, WANDB_API_KEY=key, WANDB_MODE="online", WANDB_SILENT="true")
import wandb

name = "record-transform-" + uuid.uuid4().hex[:12]
with tempfile.TemporaryDirectory(prefix="randl-sdk-record-transform-") as directory:
    with wandb.init(entity="local", project="sdk-record-transform", id=name, dir=directory) as run:
        run.define_metric("epoch")
        run.define_metric("a", step_metric="epoch")
        run.define_metric("b", step_metric="epoch")
        for row in [
            {"epoch": 0, "a": 1, "b": 2},
            {"epoch": 1, "a": 2},
            {"epoch": 2, "b": 3},
            {"epoch": 3, "a": 0, "b": 0},
            {"epoch": 4, "a": 6, "b": 2},
        ]:
            run.log(row)

def chart(transform, metrics=("a", "b")):
    body = {"runs": ["local/sdk-record-transform/" + name], "metrics": list(metrics), "recordTransform": transform}
    request = urllib.request.Request(base + "/api/chart", json.dumps(body).encode(),
        {"Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(request) as response:
        return json.load(response)

ratio = chart({"kind": "compute", "expressions": [{"name": "ratio", "expression": "${a} / ${b}"}]}, ["ratio"])
assert ratio["xAxis"] == "epoch"
assert ratio["series"][0]["values"]["ratio"] == [[0, 0.5], [4, 3]]
aligned = chart({"kind": "align", "normalization": "none"})
assert aligned["series"][0]["values"]["a"] == [[0, 1], [3, 0], [4, 6]]
assert aligned["series"][0]["values"]["b"] == [[0, 2], [3, 0], [4, 2]]
percent = chart({"kind": "align", "normalization": "percent"})
a, b = [percent["series"][0]["values"][metric] for metric in ["a", "b"]]
assert [point[0] for point in a] == [0, 4]
assert all(math.isclose(left[1] + right[1], 100) for left, right in zip(a, b))
assert math.isclose(a[0][1], 100 / 3)
assert a[1][1] == 75
print(json.dumps({"sdk": wandb.__version__, "same_record_computed_metric": "passed",
    "sparse_record_alignment": "passed", "selected_metric_percentage": "passed",
    "defined_x_axis": "passed"}))
