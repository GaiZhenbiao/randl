---
name: randl-tracking
description: Log training runs to a randl server with the W&B SDK and record what was learned from them through randl's tools API and CLI - lineage blocks, run journals, verdicts, findings, the stopped state, the best recipe, evidence runs and history corrections - and read runs back to query and compare them. Use when training code should log to randl, or when asked to note, judge, stop-mark, cite or look up randl runs.
---

# Tracking runs and the ledger in randl

randl is a self-hosted server the stock `wandb` SDK logs to. Everything beyond logging goes
through tools: `POST /api/tools/<name>` with JSON, or the `randl` CLI that wraps them. Full
contracts: [tool reference](../../../docs/reference/tools.md),
[ledger guide](../../../docs/guides/ledger.md), [lineage block](../../../docs/reference/lineage-block.md).

## 0. Connect

```sh
export RANDL_URL=http://127.0.0.1:8742          # the server; ask if unknown
export RANDL_API_KEY=…                          # only if the server has a key
alias randl="node /path/to/randl/backend/dist/cli.js"
randl status
```

Every command prints JSON; errors go to stderr with a non-zero exit. Pass `--by NAME` on every
change so the audit log says who made it.

## 1. Log a run from training code

```sh
export WANDB_BASE_URL="$RANDL_URL"
export WANDB_API_KEY="${RANDL_API_KEY:-0000000000000000000000000000000000000000}"
```

Log where the run came from when it starts (all fields optional):

```python
run = wandb.init(project="navigation", entity="team", config=cfg)
run.config.update({"lineage": {
    "parent": {"run_id": "wide02", "update": 10000},   # or None for a cold start
    "relation": "initialize_from",                     # or resume, extend
    "change": "Hidden layer widened from 512 to 1024 units",
    "hypothesis": "The gain from width has not saturated",
    "plan": "v5",                                       # the plan this run carries out, if any
    "compute": {"host": "gpu-a", "gpu_count": 2, "segments": [
        {"from_update": 10000, "to_update": None, "host": "gpu-a", "gpu_count": 2, "gpu_ids": [0, 1]}]},
}})
```

Log a progress field (such as `update`) in every history record; journals, findings and
comparisons refer to it.

## 2. Read back

```sh
randl runs --project team/navigation | jq '.[] | {id, display_name, state}'
randl runs show --id team/navigation/wide02
randl tool metrics_list --json '{"runs": ["team/navigation/wide02"]}'
randl tool runs_config_diff --json '{"from": "team/navigation/base01", "to": "team/navigation/wide02"}'
randl tool runs_compare --json '{"baseline": "team/navigation/wide02", "runs": ["team/navigation/lr03"], "metric": "eval/return", "x": "update"}'
randl tool project_lineage --json '{"id": "team/navigation"}'
```

Run IDs are `entity/project/<SDK run id>`; the display name is `display_name`. States:
`running`, `finished`, `failed`, `crashed`, `killed` (stopped on purpose).

## 3. Record what happened

| Record             | Command                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Journal entry      | `randl journal add --run RUN --update 8000 --text "…" --key KEY --by me`                                                                  |
| Verdict and result | `randl runs update-meta --id RUN --add-tags verdict:adopted --remove-tags verdict:running --merge '{"lineage": {"result": "…"}}' --by me` |
| Finding            | `randl findings save --project P --id ID --topic T --title "…" --body-file f.md --cite RUN@10000 --by me`                                 |
| Stopped on purpose | `randl runs set-state --id RUN --state stopped --reason "…" --by me` (after it ends)                                                      |
| Best recipe        | `randl recipe set --project P --run RUN --reason "…" --by me`                                                                             |

For example:

```sh
randl journal add --run team/navigation/wide02 --update 8000 --text "Return jumped after the entropy bonus decayed." --by me
randl findings save --project team/navigation --id width-helps --topic Model \
  --title "A wider policy reaches a higher return" --body-file finding.md --cite team/navigation/wide02@10000 --by me
randl runs set-state --id team/navigation/lr03 --state stopped --reason "Return fell behind v2 after update 12000" --by me
randl recipe set --project team/navigation --run team/navigation/wide02 --reason "Best return at equal compute" --by me
```

Rules:

- **IDs are yours.** Findings, journal keys, evidence and plans use caller-chosen IDs; repeating
  a request reports `unchanged`. Use stable IDs so reruns are safe.
- **Dry-run** ledger writes with `--dry-run` (tools: `"dryRun": true`) when unsure.
- **Findings conflict.** Pass the `version` you read to `finding_save`; `FINDING_CONFLICT`
  means someone saved after you read. Read again with `randl findings get`, merge, save.
- **Stopping.** `RUN_STATE_RUNNING` means the run has not ended; stop it with
  `randl runs stop --ids RUN` and mark it after. A mark survives later finish reports; a resumed
  run that logs new history clears it.
- **Edit metadata after runs end.** A running SDK re-sends its config and replaces keys set with
  `update-meta`.

## 4. Evidence and corrections

Import an evaluation made earlier as its own run:

```http
POST /api/tools/evidence_save

{"project": "team/navigation", "id": "eval-wide02", "job_type": "evaluation", "created": "2026-01-15T09:00:00Z", "examines": ["team/navigation/wide02"], "summary": {"success_rate": 0.73}, "by": "eval-script"}
```

Write values computed after training into history (match a record by a logged field):

```sh
randl runs write-history --id team/navigation/wide02 \
  --rows '[{"match": {"update": 10000}, "values": {"audit/success": 0.73}}]' --dry-run --by me
```

Drop `--dry-run` once every row reports `merged` or `added`. Rename metric keys so old runs compare
with new ones with `randl runs rename-metrics --id RUN --rename old=new --by me` (prints undo IDs).

## Checklist

- [ ] `randl status` answers, against the server the user named (never guess a production one).
- [ ] Each change carries `--by`.
- [ ] Verified by reading back (`randl findings get`, `randl journal list --run RUN`,
      `randl runs show --id RUN`).
