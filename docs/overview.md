# Overview

randl is an experiment tracker you run yourself. Training code keeps using the stock `wandb`
Python package; two environment variables send its runs to randl instead of W&B's cloud. randl
stores them in one SQLite database and a folder of files, and serves a dashboard, a command
line (`randl`), an HTTP tools API and an optional AI Assistant from the same Node.js process
and port.

randl is young and unreleased: expect breaking changes. It is an independent implementation,
not affiliated with Weights & Biases.

## What it is for

- **Tracking:** metrics, config, summaries, media, files and artifacts logged with the W&B SDK,
  shown live in a fast dashboard. See [W&B compatibility](reference/wandb-compatibility.md).
- **Comparing:** saved workspaces of panels across many runs, grouping, smoothing and computed
  metrics.
- **Remembering:** how runs descend from each other (lineage) and what was learned from them
  (the ledger), next to the runs themselves.
- **Planning:** the runs to try next, as a queue that host agents take work from, placed on a
  timeline of your GPUs.

## Core concepts

| Object            | What it is                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entity**        | The first part of every ID, as in W&B. A run started without one uses the server's default entity, `local`.                                                                                  |
| **Project**       | `entity/project`, such as `team/navigation`. Holds runs, views, the ledger, the GPU inventory and plans. Created by the first run that logs to it, or by hand.                               |
| **Run**           | One `wandb.init()`: config, summary, tags, notes, history, files and media. Its ID is `entity/project/run_id`, where `run_id` is the SDK's run ID; its display name is the name shown.       |
| **State**         | `running`, `finished`, `failed`, `crashed` (no contact for 10 minutes) or **stopped** (ended on purpose before its plan; reported as `killed`, as W&B does).                                 |
| **History**       | A run's logged records, each with `_step` and the metrics logged together. Charts plot history against `_step`, time or any logged field.                                                    |
| **View**          | A saved workspace for a project: sections of panels, which runs are visible or soloed, colours, filters and plot settings.                                                                   |
| **Panel**         | One chart, table or media grid in a view. Every panel type is a **panel plugin**, built in or installed, with the same API.                                                                  |
| **Lineage**       | Links from each run to the run it started from (warm start, resume, extension), read from a `lineage` config block or from checkpoint paths in the config.                                   |
| **Ledger**        | What a project learned and plans: findings, run journals, the best recipe, verdicts, evidence runs, plans and ideas. Kept beside the runs, edited through tools, never part of the W&B data. |
| **GPU inventory** | The GPUs of each host a project may use: index, model, memory, and whether plans may use it.                                                                                                 |
| **Plan**          | A run to try next: what it changes, why, its exact config and the GPUs it asks for. Waiting plans form the **queue**; host agents claim them.                                                |
| **Idea**          | A backlog entry not yet planned: a hypothesis with evidence, priority and what it waits on. Promoting an idea makes a plan.                                                                  |
| **Tool**          | One management operation, such as `view_create` or `plan_claim`. The dashboard, the CLI and the Assistant all go through the same tools.                                                     |

## How the pieces fit

```text
 training code ── wandb SDK ──▶ ┐
 browser (dashboard) ─────────▶ ├─ randl server (one port) ─▶ SQLite worker ─▶ <data-dir>/
 randl CLI, scripts, agents ──▶ │      /graphql, /files/…       randl.sqlite3,
 host agents (plan_claim) ────▶ ┘      /api/tools/<name>        files, plugins, pi/
```

- The SDK talks W&B's protocol (`/graphql`, file streams and uploads).
- Everything else uses the [tools](reference/tools.md) at `/api/tools/<name>` and a few
  read endpoints for charts and files. The CLI is a thin client over the same tools.
- The server writes an audit entry for every change made through a tool, with its arguments
  and the `by` name the caller gives.

## Where to go next

- [Getting started](getting-started.md) to log a first run.
- [Workspace and panels](guides/workspace.md) to compare runs.
- [Lineage](guides/lineage.md), [the ledger](guides/ledger.md) and
  [planning](guides/planning.md) for the research workflow on top of tracking.
- [Deployment](guides/deployment.md) to host randl for a team or across machines.
