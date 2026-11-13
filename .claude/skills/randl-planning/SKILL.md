---
name: randl-planning
description: Plan training runs in randl and run its GPU queue - register hosts' GPUs, write plans with GPU requests and exact configs, reorder, claim, release and cancel queued plans, manage the ideas backlog, write resume plans, and build a host agent against plan_claim. Use when asked to queue or schedule runs, plan the next experiments, allocate GPUs, or write the per-host agent that launches randl plans.
---

# Planning and the GPU queue in randl

Plans are runs to try next. Waiting plans form one queue; host agents report free GPUs to
`plan_claim` and get a plan with its exact config and GPU IDs. Details:
[planning guide](../../../docs/guides/planning.md),
[tools](../../../docs/reference/tools.md#planning).

Setup as in the tracking skill: `RANDL_URL`, `RANDL_API_KEY` if set, `alias randl=…`, and
`--by NAME` on every change.

## 1. Register GPUs (once per host)

Indices are PCI order, as `nvidia-smi` prints them.

```sh
randl gpus save --project team/navigation --host gpu-a --gpus 0,1,2,3 --model 'RTX 4090' --memory-gb 24 --by me
randl gpus save --project team/navigation --host gpu-a --gpus 3 --reserved --note 'Interactive use' --by me
randl gpus list --project team/navigation
```

`--reserved` = never allocated; `--allowed` undoes it; `--replace` drops the host's other GPUs.

## 2. Write a plan

```sh
randl plans save --project team/navigation --id v5 --name v5_wider_still \
  --json '{"parent": "team/navigation/wide02", "parentUpdate": 10000, "change": "Hidden layer widened from 512 to 1024 units", "hypothesis": "The gain from width has not saturated", "rule": "Stop if return trails v2 by 10 at update 15000", "resources": {"gpus": 2, "min_memory_gb": 24}, "updates": 20000}' \
  --config-yaml-file configs/v5.yaml --by me
```

- `resources`: `gpus` (on one host), optional `min_memory_gb`, `model` (substring), `hosts`.
- `config_yaml` is returned verbatim to the agent: pass the real file, not a summary.
- Order with `queue` (position) or `after` (`"plan:v4"` or a run ID to follow).
- Re-saving identical content reports `unchanged`; omitted fields keep their values.

## 3. Work the queue

```sh
randl plans queue --project team/navigation
randl plans move --project team/navigation --id v6 --before v5 --by me
randl plans claim --project team/navigation --host gpu-a --free-gpus 0,1,3 --by gpu-a-agent --dry-run
```

| Need                                 | Do                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Release a claim whose run never ran  | `randl plans save --project P --id ID --json '{"status": "planned"}' --by me`                                |
| Cancel, keep in history              | `randl plans save --project P --id ID --json '{"status": "cancelled"}' --by me`                              |
| Delete                               | `randl plans delete --project P --id ID --by me`                                                             |
| See the projected start of each plan | `randl tool project_occupancy --json '{"project": "team/navigation"}'` (`unfit` lists plans no host can run) |

Allocation: head of queue first; a later plan may backfill GPUs the head cannot use; after six
hours waiting the head makes a fitting host hold GPUs for it (`status: "held"`). GPUs named by a
running run's `lineage.compute` are never given out. Claims lapse after 30 minutes without the
run logging. `started`, `done` and `stopped` are set by randl from the claim and the run.

## 4. Resume plans

To continue an existing run: `"resume_run": "team/navigation/wide02"` in the plan JSON. The
resumed run must log `lineage.plan` = the new plan's ID; resume plans never bind by name.

## 5. Ideas

```sh
randl ideas save --project team/navigation --id curriculum --title 'Curriculum over obstacle density' \
  --priority high --json '{"hypothesis": "Starting sparse speeds up early learning", "waits_on": [{"kind": "plan", "id": "v5"}]}' --by me
randl ideas promote --project team/navigation --id curriculum --json '{"resources": {"gpus": 1}}' --by me
randl ideas from-plan --project team/navigation --plan v6 --by me
randl ideas list --project team/navigation
```

`IDEA_PLAN_EXISTS`: the plan ID is taken; pass `--plan NEW_ID`. `PLAN_NOT_WAITING`: only
waiting or cancelled plans become ideas.

## 6. A host agent

Loop on each training host (the guide has a complete Python version):

1. Find free GPUs (for example `nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits`).
2. Call `plan_claim`:

   ```http
   POST /api/tools/plan_claim

   {"project": "team/navigation", "host": "gpu-a", "free_gpus": [0, 1, 3], "by": "gpu-a-agent"}
   ```

3. On `"status": "claimed"` and no `"repeat": true`: write `plan.config_yaml` to a file and
   launch with `CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=<gpu_ids>`. The run must log
   `{"lineage": {"plan": plan.id, "compute": {...gpu_ids...}}}` at start; that binds it.
4. `"empty"` or `"held"`: launch nothing. Sleep about a minute and repeat.

`repeat: true` means the claim is already yours and waiting for its run: do not launch twice.
`PLAN_HOST_UNKNOWN` means the host has no GPUs registered (step 1).

## Checklist

- [ ] Inventory matches the hardware (`randl gpus list`).
- [ ] Every plan has `resources` and the exact `config_yaml`.
- [ ] `randl plans claim … --dry-run` returns the plan you expect before agents run.
- [ ] After launch, the plan shows `started` and its run appears in `randl plans list`.
