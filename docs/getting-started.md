# Getting started

This page installs randl, logs a run with the W&B SDK and opens it in the dashboard. It takes
about five minutes.

## Requirements

- [Node.js](https://nodejs.org/) 22.19 or newer, with npm.
- A C++ toolchain only if `better-sqlite3` has no prebuilt binary for your platform.
- Python with the `wandb` package for your training code (tested with `wandb` 0.30.0).
- Optional: `ffmpeg`, for video poster images.

## 1. Install and start the server

From a clone of the repository:

```sh
npm ci
npm run build
npm start
```

The server listens on <http://127.0.0.1:8742> and keeps its data in `.data/`. Change either
with `npm start -- --port 9000 --data-dir /srv/randl`. [Configuration](reference/configuration.md)
lists every option.

## 2. Point the W&B SDK at it

In the shell that runs your training code:

```sh
pip install wandb numpy
export WANDB_BASE_URL=http://127.0.0.1:8742
export WANDB_API_KEY=0000000000000000000000000000000000000000
```

A local server without an API key accepts this placeholder key. Alternatives:

- `wandb login --relogin --host http://127.0.0.1:8742 KEY` saves randl as your default W&B host.
- Runs recorded with `WANDB_MODE=offline` upload later with `wandb sync wandb/offline-run-*`.

## 3. Log a run

Your code does not change:

```python
import numpy as np
import wandb

with wandb.init(project="quickstart", config={"lr": 3e-4, "batch_size": 64}) as run:
    for step in range(200):
        loss = 2.0 * np.exp(-step / 60) + 0.05 * np.random.rand()
        run.log({"train/loss": loss, "train/accuracy": 1 - loss / 2.1})
```

A run that names no entity goes to `local`. Start the server with `--entity NAME` (or set
`RANDL_ENTITY`) to use another default, such as your W&B user name.

## 4. Open the dashboard

Open <http://127.0.0.1:8742>. The run is in the **quickstart** project with a chart for each
metric. The project's **Settings → Connect SDK** shows the SDK settings with the project filled
in.

## 5. Try the command line

The `randl` CLI calls the same tools as the dashboard and prints JSON:

```sh
alias randl="node $PWD/backend/dist/cli.js"   # once, from the repository
randl status
randl runs --project local/quickstart
```

From here:

- [Workspace and panels](guides/workspace.md): build views to compare runs.
- [Lineage](guides/lineage.md): link runs to the runs they started from.
- [Scripting and agents](guides/scripting.md): drive randl from scripts and coding agents.
- [Deployment](guides/deployment.md): use randl from other machines with an API key.
