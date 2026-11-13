# Experiment ledger

Beside its runs, each project keeps what was learned from them: findings, run journals,
verdicts, the best recipe and evidence. The ledger lives in randl's database, is edited through
[tools](../reference/tools.md#experiment-ledger) (each also a CLI command), and is never sent to
or read from the W&B SDK.

Every ledger record follows the same rules:

- **Caller-chosen IDs.** You name each record, so repeating a request changes nothing and a
  backfill script can run twice.
- **`by`.** Every change names its author, and the audit log keeps it with the arguments.
- **`dryRun`.** Reports `created`, `updated` or `unchanged` without writing.
- **`source`.** Findings, journal entries, recipe promotions, plans and evidence may carry
  `{document, lines: [first, last], quote}`, shown as where the record came from.

The built-in Assistant cannot use the ledger tools; scripts, the CLI and coding agents can.

## Findings

A finding is a Markdown note under a topic that cites the runs (and updates) it rests on. Its
status is `finding` or `ruled_out`. The **Findings** page lists them with search, topic and
status filters, and shows the open one beside the list with a chart of the lineage metric for
each cited run, marking the cited update.

```sh
randl findings save --project team/navigation --id width-helps --topic Model \
  --title "A wider policy reaches a higher return" --body-file finding.md \
  --cite team/navigation/wide02@10000 --by me
```

Every edit keeps the previous version. A save may name the `version` it started from; a save
over a newer version is refused with `FINDING_CONFLICT`, so two editors cannot overwrite each
other. Deleting a finding keeps its versions. A run's overview and its Lineage panel list the
findings that cite it.

## Run journals

A journal is a run's dated log, separate from its notes. Entries are only ever added, optionally
at an update or step:

```sh
randl journal add --run team/navigation/wide02 --update 8000 \
  --text "Return jumped after the entropy bonus decayed." --by me
randl journal list --run team/navigation/wide02
```

`--key` gives an entry an ID, so a script can add it again safely; without one, the run,
update, step and text identify it.

## Verdicts

A run's verdict is a tag: `verdict:adopted`, `verdict:rejected` or `verdict:running`. Tags win
over `lineage.verdict.status`, whose `reason` is shown either way. Set them when a run ends:

```sh
randl runs update-meta --id team/navigation/wide02 \
  --add-tags verdict:adopted --remove-tags verdict:running \
  --merge '{"lineage": {"result": "Return 120 at update 10000, +20 over v1"}}' --by me
```

## The stopped state

A run that ended on purpose before its plan is **stopped**: a purple square wherever its state
appears, with the reason on its run page and in Lineage. Run lists report it as `killed`, as
W&B does.

- A run stopped from randl (**Stop** in the runs table, or `randl runs stop`) is stopped when its
  SDK ends.
- A run stopped elsewhere is marked afterwards:

```sh
randl runs set-state --id team/navigation/lr03 --state stopped \
  --reason "Return fell behind v2 after update 12000" --by me
```

A running run is refused with `RUN_STATE_RUNNING`; mark it once it ends. The mark survives a
later finish report or re-upload from the SDK. If the same run is resumed and logs new history
after the mark, it is running again: the mark and its reason are cleared, and the audit log
records the resume. `--state finished` (or `failed`, `crashed`) undoes a mark.

## Best recipe

The recipe is the run the project builds on, with since when and why. Promoting a run keeps
every earlier promotion as history; the recipe's card on the Lineage page carries a star.

```sh
randl recipe set --project team/navigation --run team/navigation/wide02 \
  --reason "Best return at equal compute" --by me
randl recipe get --project team/navigation
```

## Evidence

Evaluations, diagnostics and calibration studies are runs of their own with a `job_type` of
`evaluation`, `diagnostic` or `calibration`, naming the runs they examine in
`lineage.examines`. The examined run's Lineage panel lists them and their files, and findings
can cite them.

Log one with the SDK (`wandb.init(job_type="evaluation", config={"lineage": {"examines": [...]}})`),
or import one made earlier with [`evidence_save`](../reference/tools.md#evidence_save), dated
when it was made. Files are either uploaded afterwards with
`PUT /upload/<entity>/<project>/<id>/<name>` or kept as references to a host and path.

## Correcting stored runs

Three tools change a finished run's stored data. They are not available to the Assistant, and
each change is audited with its `by`.

| Task                                                     | Command                                             | Tool                                                               |
| -------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| Change config keys, tags, notes or summary keys          | `randl runs update-meta`                            | [`run_metadata_update`](../reference/tools.md#run_metadata_update) |
| Rename metric keys so older runs compare with newer ones | `randl runs rename-metrics` (undo with `--undo ID`) | [`run_metrics_rename`](../reference/tools.md#run_metrics_rename)   |
| Write values into history, such as late audit results    | `randl runs write-history`                          | [`run_history_write`](../reference/tools.md#run_history_write)     |

- `update-meta`: `--config` replaces top-level keys (`null` removes one); `--merge` deep-merges
  into them (a `null` leaf removes that key). Keys starting with `_` belong to the SDK and are
  refused. The run's state, history and files are untouched.
- `rename-metrics`: rewrites history records, chart points, media, the metric index, summary and
  `define_metric` settings. An existing target is refused unless `--combine`; every rename
  returns an undo ID.
- `write-history`: each row names its record by a logged field (`{"match": {"update": 10000},
"values": {...}}`) or by `step`. A conflicting stored value is refused unless `--replace`;
  one refused row refuses the whole request. `--dry-run` reports what each row would do.

```sh
randl runs write-history --id team/navigation/wide02 \
  --rows '[{"match": {"update": 10000}, "values": {"audit/success": 0.73}}]' --by audit-script
```

## Comparing runs

Lineage cards show the mean of the metric's last N values (**Recent mean over** in Lineage
settings), and the open run's panel compares the selected runs with it at matching updates.
From a script:

```sh
randl tool runs_compare --json '{"baseline": "team/navigation/wide02", "runs": ["team/navigation/lr03"], "metric": "eval/return"}'
```
