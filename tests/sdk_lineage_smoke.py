"""Check that a lineage config block logged by the real W&B SDK links runs on the Lineage page."""
import json
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

project = "sdk-lineage-" + uuid.uuid4().hex[:8]
parent_id, child_id, path_id = (uuid.uuid4().hex[:8] for _ in range(3))
with tempfile.TemporaryDirectory(prefix="randl-sdk-lineage-") as directory:
    checkpoint = lambda name: {"rl": {"checkpoint": {"save_dir": "/ckpt/" + name}}}
    with wandb.init(entity="local", project=project, id=parent_id, name="v621_parent",
                    dir=directory, config=checkpoint("v621_parent")) as run:
        run.log({"audit/primary": 0.5})
    # The block as the training code writes it: dotted keys inside changes stay one key.
    with wandb.init(entity="local", project=project, id=child_id, name="v647_child",
                    dir=directory, config=checkpoint("v647_child")) as run:
        run.config.update({"lineage": {
            "parent": {"run_id": parent_id, "run_name": "v621_parent", "update": 543000},
            "relation": "grown_head",
            "changes": {"model.command_head_dim": [512, 1024]},
            "recipe": {"name": "latched_box40"},
            "hypothesis": "A wider command head holds more boxes",
        }})
        run.log({"audit/primary": 0.7})
    # A run without the block is linked through its initialize_from path.
    config = checkpoint("v648_path")
    config["rl"]["checkpoint"]["initialize_from"] = "/other/warm_sources/v621_u00543000/update_00543000"
    with wandb.init(entity="local", project=project, id=path_id, name="v648_path",
                    dir=directory, config=config) as run:
        run.log({"audit/primary": 0.6})


def call(tool, body):
    request = urllib.request.Request(base + "/api/tools/" + tool, json.dumps(body).encode(),
        {"Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


graph = call("project_lineage", {"id": "local/" + project})
edges = {edge["target"].split("/")[-1]: edge for edge in graph["edges"]}
explicit, matched = edges[child_id], edges[path_id]
assert explicit["source"].endswith("/" + parent_id), explicit
assert (explicit["relation"], explicit["update"], explicit["explicit"]) == ("grown_head", 543000, True)
assert explicit["changedKeys"] == ["model.command_head_dim"], explicit
assert explicit["changeSource"] == "lineage"
assert matched["source"].endswith("/" + parent_id), matched
assert (matched["relation"], matched["update"], matched["explicit"]) == ("initialize_from", 543000, False)
child = next(node for node in graph["nodes"] if node["name"] == child_id)
assert child["hypothesis"] == "A wider command head holds more boxes"
assert child["recipe"] == {"name": "latched_box40"}
print(json.dumps({"sdk": wandb.__version__, "logged_lineage_block": "passed",
    "dotted_change_keys": "passed", "initialize_from_path": "passed"}))
