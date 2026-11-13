# Lineage

Research runs rarely start from scratch: a run warm-starts from another run's checkpoint,
resumes it, or extends it with a grown network. randl links each run to the run it started from
and draws the result on the project's **Lineage** page, so you can follow a line of experiments
across hundreds of runs.

## Linking runs

A run says where it came from in a `lineage` config block, logged when it starts:

```python
import wandb

run = wandb.init(project="navigation", config={"lr": 3e-4, "model": {"hidden": 512}})
run.config.update({"lineage": {
    "parent": {"run_id": "base01", "update": 5000},
    "relation": "initialize_from",
    "change": "Hidden layer widened from 256 to 512 units",
    "hypothesis": "A wider policy reaches a higher return",
}})
```

- `parent` names the run it started from: by SDK run ID (`run_id`), path (`run_path`), display
  name (`run_name`) or checkpoint path (`checkpoint`), tried in that order.
- `relation` is the kind of link, `initialize_from`, `resume` or `extend`, optionally followed
  by traits such as `grown_head`.
- `change` is one sentence for people; it labels the link on the page.
- `parent: null` says the run is a cold start: it gets no link even if its config holds a
  checkpoint path.

Every field is in [the lineage block reference](../reference/lineage-block.md). A run resumed
or extended in place (parent is itself) stays one card.

### Runs without a block

Runs that log no block are linked by checkpoint paths in their config, matched against other
runs' folders and names:

1. randl reads the run's **parent checkpoint keys** (by default `rl.checkpoint.initialize_from`,
   then `rl.checkpoint.resume`).
2. It matches the path's folder, or a `<name>_u<update>` label, from the end of the path against
   other runs' **run folder keys** (by default `rl.checkpoint.save_dir` and
   `rl.checkpoint.run_name`) and display names, ignoring the host-specific start of the path.
3. The update comes from an `update_<N>` folder or the label. When several runs share the name,
   the latest created before the child is linked and marked ambiguous.

Set the keys under **Lineage settings** on the page or with
[`project_lineage_settings_update`](../reference/tools.md#project_lineage_settings_update).

## The Lineage page

Each run is a card linked from its parent. A card shows the run's colour, state, verdict, the
host and GPUs it last trained on, and the latest and best value of the project's **lineage
metric**. Running runs have a rippling accent ring. Each link is labelled with the run's
`change`, or with the config keys that set it apart from its parent.

| Control              | What it does                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------- |
| **Filters**          | Group, tag, host; collapse rejected branches; show runs without lineage                  |
| **View**             | Arrange by lineage depth, start update or start time; colour by run or host; zoom        |
| **i**                | Counts and the legend of link styles and card markings                                   |
| **Lineage settings** | Metric, display scale, goal (higher or lower is better), parent, folder and ignored keys |
| Search               | Matches the start of a short name (`v6` finds v60–v69), or a name or ID anywhere         |
| Canvas buttons       | Zoom, **Fit all**, **Focus running runs**                                                |

Pan with two-finger scrolling, the wheel or Shift+drag; zoom with a pinch or Ctrl+wheel.

Select a card to open its panel: what changed, the hypothesis, result and verdict, relations,
compute segments, the metric along its lineage, findings and journal entries, evidence runs, and
every config difference from its parent or another run you pick, as a word diff under each key.

### Comparing runs

Drag a box around cards to select them (Ctrl- or ⌘-drag adds), or use **Select path from
root** or **Select branch**, then **Compare**: the project's workspace shows exactly those runs
as solos. The open run and the selection are in the URL (`?run=`, `?select=`), so a link reopens
them. **Show in lineage** on a run page or in the runs table opens the page on those runs.

## Verdicts and results

A run's verdict is its `verdict:adopted`, `verdict:rejected` or `verdict:running` tag; the
block's `verdict.status` applies only to runs without such a tag, and `verdict.reason` is shown
with it. Rejected branches can be collapsed. To record verdicts and results after a run ends,
see [Experiment ledger](ledger.md).

## Backfilling lineage

Runs logged before you adopted the block can get one afterwards without touching their history:

```sh
randl runs update-meta --id team/navigation/wide02 \
  --merge '{"lineage": {"parent": {"run_id": "base01", "update": 5000}, "change": "Wider hidden layer"}}' \
  --add-tags verdict:adopted --by backfill-script
```

A running run's SDK sends its whole config again with each config update and would replace a
block set this way, so backfill after runs end.

## Reading lineage from scripts

- [`project_lineage`](../reference/tools.md#project_lineage): the graph, one node per run and
  one edge per link.
- [`runs_config_diff`](../reference/tools.md#runs_config_diff): every config key that differs
  between two runs.
- [`runs_compare`](../reference/tools.md#runs_compare): runs against a baseline on one metric
  at matching updates.
