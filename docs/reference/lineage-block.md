# The lineage block

A run describes where it came from, what it changes and where it trains in a top-level
`lineage` config key. randl reads it for the [Lineage page](../guides/lineage.md), the
[ledger](../guides/ledger.md) and [planning](../guides/planning.md). Every field is optional.

```python
run.config.update({"lineage": {
    "parent": {"run_id": "wide02", "run_path": "team/navigation/wide02",
               "run_name": "v2_wide", "update": 10000,
               "checkpoint": "/checkpoints/v2_wide/update_00010000"},
    "relation": ["initialize_from", "grown_head"],
    "changes": {"model.hidden": [512, 1024]},
    "extends": [{"kind": "run", "reference": "v2_wide"}, {"kind": "file", "reference": "base.yaml"}],
    "recipe": "wide_policy",
    "change": "Hidden layer widened from 512 to 1024 units",
    "hypothesis": "The gain from width has not saturated",
    "result": "Return 131 at update 20000, +11 over v2",
    "verdict": {"status": "adopted", "reason": "Higher return at equal compute"},
    "plan": "v5",
    "examines": [],
    "compute": {"host": "gpu-a", "gpu_count": 2, "segments": [
        {"from_update": 10000, "to_update": None, "host": "gpu-a", "gpu_count": 2,
         "gpu_ids": [0, 1], "gpu_model": "RTX 4090"}]},
}})
```

## Fields

| Field        | Type               | Meaning                                                                                                                                                                                              |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parent`     | object or null     | The run this one started from. `null` means a cold start: no link, even if the config holds a checkpoint path. A parent equal to the run itself (an in-place resume or extension) adds no link.      |
| `relation`   | string or string[] | The link kind first, `initialize_from` (default), `resume` or `extend`; then traits such as `grown_head`, `grown_gru`, `added_inputs`, `added_frames`, `extends_config`. A string is the kind alone. |
| `changes`    | object             | Dotted config keys mapped to `[old, new]`. Names the link's changed keys instead of a computed diff.                                                                                                 |
| `change`     | string             | One sentence describing the change. Labels the link instead of the keys.                                                                                                                             |
| `hypothesis` | string             | What the run tests.                                                                                                                                                                                  |
| `result`     | string             | What it showed.                                                                                                                                                                                      |
| `verdict`    | string or object   | `adopted`, `rejected` or `running`, or `{status, reason}`. A `verdict:*` tag on the run takes precedence; `reason` is shown either way.                                                              |
| `extends`    | object[]           | Config bases, each `{kind, reference}`. Entries of kind `run` draw a weaker config-base link.                                                                                                        |
| `recipe`     | string             | The recipe name the run follows.                                                                                                                                                                     |
| `plan`       | string             | The ID of the [plan](../guides/planning.md) this run carries out. Binds the run to the plan.                                                                                                         |
| `examines`   | string[]           | For evaluation and diagnostic runs: the full IDs of the runs they examine. Those runs list them as evidence.                                                                                         |
| `compute`    | object             | Where the run trains; see below.                                                                                                                                                                     |

### parent

| Field        | Meaning                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `run_id`     | The parent's SDK run ID. Tried first.                                                             |
| `run_path`   | `entity/project/run_id`. Tried second.                                                            |
| `run_name`   | The parent's display name. Tried third.                                                           |
| `checkpoint` | A checkpoint path, matched like the [config fallback](../guides/lineage.md#runs-without-a-block). |
| `update`     | The parent's update (or step) the run started from.                                               |

A parent that matches no run leaves the run marked **unresolved** in
[`project_lineage`](tools.md#project_lineage).

### compute

| Field       | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| `host`      | The host the run trains on now.                           |
| `gpu_count` | How many GPUs it uses now.                                |
| `segments`  | One entry per placement, in order; a move adds a segment. |

Each segment:

| Field         | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `from_update` | The update the segment starts at.                                              |
| `to_update`   | The update it ends at, or `null` while it runs.                                |
| `host`        | The host.                                                                      |
| `gpu_count`   | How many GPUs.                                                                 |
| `gpu_ids`     | The GPU indices on the host, in PCI order. Rows of the GPU occupancy timeline. |
| `gpu_model`   | The GPU model, for display.                                                    |
| `slot`        | A legacy name for a group of GPUs; GPU requests have replaced slots.           |

randl times each segment from the run's history using the project's `progressKey` (default
`update`). A running run that logs no compute block sits on the GPUs its plan's claim was given.

## Where it is read

- The block is read from the stored config (`config.lineage.value` in W&B's layout); log it
  with `run.config.update` or pass it in `wandb.init(config=…)`.
- `run_metadata_update` with `configMerge` changes it after a run ends
  ([backfilling](../guides/lineage.md#backfilling-lineage)).
- Diffs leave out `lineage.*`, the parent and folder keys, and the project's ignored keys.
