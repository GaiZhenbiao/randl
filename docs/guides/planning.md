# Planning and the GPU queue

The **Plans** page holds what runs next: the project's best recipe, a timeline of its GPUs,
the queue of planned runs and a backlog of ideas. Host agents, small programs on each training
machine, take their work from the queue: they report the GPUs they see free and get back a plan
with its exact config and the GPU IDs to launch on.

```text
 idea ──promote──▶ plan (planned) ──plan_claim──▶ started ──run ends──▶ done
                       │   ▲                        │                  stopped (stopped, crashed, failed)
                       │   └── set back to planned ─┘
                       └──▶ cancelled
```

## 1. Register the GPUs

Each project lists the GPUs of its hosts. A GPU is identified by its host and its index in
PCI order, as `nvidia-smi` shows it:

```sh
randl gpus save --project team/navigation --host gpu-a --gpus 0,1,2,3 --model 'RTX 4090' --memory-gb 24 --by me
randl gpus save --project team/navigation --host gpu-b --gpus 0,1 --model H100 --memory-gb 80 --by me
randl gpus save --project team/navigation --host gpu-b --gpus 1 --reserved --note 'Interactive use' --by me
randl gpus list --project team/navigation
```

- `--reserved` keeps a GPU listed but never allocated; `--allowed` lifts that.
- `--replace` removes the host's other GPUs, for a machine whose cards changed.
- `randl gpus delete --project team/navigation --host gpu-b` removes a host.

## 2. Write plans

A plan is a run to try: its name, parent, what it changes and why, the rule for stopping it, its
exact config, and a **GPU request**:

```sh
randl plans save --project team/navigation --id v5 --name v5_wider_still \
  --json '{"parent": "team/navigation/wide02", "parentUpdate": 10000,
           "change": "Hidden layer widened from 512 to 1024 units",
           "hypothesis": "The gain from width has not saturated",
           "rule": "Stop if return trails v2 by 10 at update 15000",
           "resources": {"gpus": 2, "min_memory_gb": 24}, "updates": 20000}' \
  --config-yaml-file configs/v5.yaml --by me
```

| Field                     | Meaning                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `resources.gpus`          | How many GPUs, all on one host.                                                                         |
| `resources.min_memory_gb` | Minimum memory per GPU.                                                                                 |
| `resources.model`         | A model name to match, case-insensitive substring (`4090`, `H100`).                                     |
| `resources.hosts`         | Hosts it may run on; any host when omitted.                                                             |
| `config_yaml`             | The config file text, returned verbatim to the agent that claims the plan.                              |
| `config`                  | The same config as JSON, for display and diffs.                                                         |
| `resume_run`              | A run this plan continues in its own directory (see [resume plans](#resume-plans)).                     |
| `updates`                 | How far it trains, for the projected end. Else the config's budget, else the usual length on that host. |
| `queue` / `after`         | A queue position, or a run or `plan:<id>` to wait for and follow.                                       |

The [`plan_save`](../reference/tools.md#plan_save) reference lists every field. Saving the same
plan again with the same content reports `unchanged`. Planned runs also appear on the Lineage
page as dashed cards linked from their parent.

## 3. The queue

Waiting plans form one queue for all hosts, ordered by queue position, then by the `after` chain
(a plan follows what it waits for), then by creation:

```sh
randl plans queue --project team/navigation
randl plans move --project team/navigation --id v6 --before v5 --by me
```

On the Plans page, drag a waiting plan up or down, or use **Move earlier** and **Move later**.
Above the queue, each host's GPUs show as free, running, claimed or reserved. Each waiting plan
shows its GPU request, where and when it is projected to start, how long it runs and what runs
alongside it. A plan no host can run says why: no GPUs registered, no allowed host, or too few
matching GPUs. **History** in the header lists plans that are over (done, stopped and
cancelled) by month.

### How plans are allocated

When an agent reports free GPUs, randl walks the queue head first and gives the first plan whose
request fits:

1. **Fit.** The plan's hosts include this host and enough free, allowed GPUs match its memory
   and model. It gets the lowest-numbered matching GPUs.
2. **Backfill.** A later plan may take GPUs the head cannot use yet.
3. **Head hold.** Once the head has waited six hours, a host that could run it holds its GPUs
   for it instead of backfilling (`status: "held"`).
4. **Busy GPUs.** GPUs that a running run's compute block names, or that another claim holds,
   are never given out, whatever the agent reports.

Claims are atomic: two agents never get the same plan or GPU.

### Projection and the GPU timeline

The **GPU occupancy** timeline has a row per GPU, grouped by host. It shows past runs, running
runs up to now and on to their estimated end, claimed plans, and waiting plans where the
allocator would start them (hatched), with a line from the run or plan whose GPUs each takes
next. Reserved GPUs are struck through.

The projection runs the same allocation rules forward in time. A running run's end comes from
its progress: its summary's `progressKey` (default `update`) counted toward the config's
`budgetKey` (default `rl.algorithm.total_updates`) from `startKey`
(`rl.algorithm.start_update`), at its recent pace. Set these keys in Lineage settings.
[`project_occupancy`](../reference/tools.md#project_occupancy) returns the timeline, with plans
that fit no host as `unfit`.

## 4. Host agents

A host agent is a loop on each training machine. randl does not ship one; it is a few lines
against [`plan_claim`](../reference/tools.md#plan_claim):

```http
POST /api/tools/plan_claim

{ "project": "team/navigation", "host": "gpu-a", "free_gpus": [0, 1, 3], "by": "gpu-a-agent" }
```

The response is one of:

| `status`  | Meaning                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- |
| `claimed` | `plan` (with `config_yaml` verbatim, `resume_run`, `updates`, `parent`) and `gpu_ids` to launch on |
| `empty`   | Nothing waiting fits these GPUs; `waiting` counts the queue                                        |
| `held`    | The head of the queue has waited too long and this host is holding GPUs for it                     |

The agent must then:

1. Launch the run on `gpu_ids` (with `CUDA_DEVICE_ORDER=PCI_BUS_ID` and
   `CUDA_VISIBLE_DEVICES` set from them), using `config_yaml` exactly.
2. Make the run log `lineage.plan` equal to `plan.id`, and its GPUs in `lineage.compute` (see
   [the lineage block](../reference/lineage-block.md#compute)). That binds the run to the plan.
3. Keep polling. While a claim waits for its run, the same agent reporting those GPUs free gets
   the same claim back (`repeat: true`), so a restarted agent does not launch twice.

A minimal agent in Python:

```python
import json, os, subprocess, time, urllib.request

URL = os.environ.get("RANDL_URL", "http://127.0.0.1:8742")
KEY = os.environ.get("RANDL_API_KEY")
PROJECT, HOST = "team/navigation", "gpu-a"

def tool(name, args):
    headers = {"content-type": "application/json"}
    if KEY:
        headers["authorization"] = "Bearer " + KEY
    request = urllib.request.Request(f"{URL}/api/tools/{name}", json.dumps(args).encode(), headers)
    with urllib.request.urlopen(request) as response:
        return json.load(response)

def free_gpus():
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,memory.used", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True).stdout
    return [int(index) for index, used in (line.split(", ") for line in out.splitlines()) if int(used) < 500]

while True:
    claim = tool("plan_claim", {"project": PROJECT, "host": HOST, "free_gpus": free_gpus(), "by": HOST + "-agent"})
    if claim["status"] == "claimed" and not claim.get("repeat"):
        plan = claim["plan"]
        path = f"configs/{plan['id']}.yaml"
        with open(path, "w") as file:
            file.write(plan["config_yaml"] or "")
        env = {**os.environ, "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
               "CUDA_VISIBLE_DEVICES": ",".join(map(str, claim["gpu_ids"]))}
        # train.py logs {"lineage": {"plan": plan["id"], "compute": ...}} when it starts.
        subprocess.Popen(["python", "train.py", "--config", path, "--plan", plan["id"]], env=env)
    time.sleep(60)
```

Try a claim without taking anything with `--dry-run`:

```sh
randl plans claim --project team/navigation --host gpu-a --free-gpus 0,1,3 --by gpu-a-agent --dry-run
```

### Releasing and cancelling

| To                                      | Do                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Release a claim whose run never started | Set the plan back to planned: `randl plans save … --json '{"status": "planned"}'`          |
| Let a stuck claim go                    | Nothing: a claim lapses after 30 minutes without its run logging, and the plan waits again |
| Cancel a plan, keeping it in history    | `randl plans save … --json '{"status": "cancelled"}'`                                      |
| Remove a plan entirely                  | `randl plans delete --project team/navigation --id v6 --by me`                             |

A claimed plan's GPUs are released when its run ends, when the claim lapses, or when the plan
is set back to planned.

### Plan status

| Status      | Set by                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------- |
| `planned`   | You, when saving; waiting in the queue                                                        |
| `started`   | randl, when an agent claims it or a run logs `lineage.plan` equal to its ID (or has its name) |
| `done`      | randl, when its run finishes                                                                  |
| `stopped`   | randl, when its run is stopped, crashes or fails                                              |
| `cancelled` | You                                                                                           |

### Resume plans

A plan with `resume_run` continues an existing run in its own directory. It binds only to a run
that logs `lineage.plan` equal to the new plan's ID, never by name or by the old run's earlier
state, so the earlier plan keeps how it ended. If a stopped run is resumed and logs new history,
it is running again (see [the stopped state](ledger.md#the-stopped-state)).

## 5. Ideas

Ideas are the backlog of experiments not yet planned: a title, hypothesis, evidence,
prerequisites, priority (`high`, `medium`, `low`) and what they wait on (runs, plans, findings),
marked once those are in.

```sh
randl ideas save --project team/navigation --id curriculum --title 'Curriculum over obstacle density' \
  --priority high --json '{"hypothesis": "Starting sparse speeds up early learning",
                           "waits_on": [{"kind": "plan", "id": "v5"}]}' --by me
randl ideas promote --project team/navigation --id curriculum --json '{"resources": {"gpus": 1}}' --by me
randl ideas from-plan --project team/navigation --plan v6 --priority low --by me
```

- **Promote** makes a plan from an idea; the plan links back to it, and the idea becomes
  `promoted`. On the Plans page, **Promote** opens the plan editor first.
- **From plan** turns a waiting or cancelled plan back into an idea, keeping its fields as a
  draft that a later promote restores.

## 6. The recipe

The Plans page also shows the best recipe and its history. See
[Experiment ledger](ledger.md#best-recipe).
