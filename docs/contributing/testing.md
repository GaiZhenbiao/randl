# Testing

This page lists every way to test randl and the rules tests follow. Commands run from the
repository root. For how the code is organized, see [architecture.md](architecture.md).

## Before you start

```sh
npm ci
npx playwright install chromium
npm run build
```

`npm run build` compiles the backend to `backend/dist/` and the frontend to `frontend/dist/`.
Browser suites start the server from `backend/dist/`, and the server serves the app from
`frontend/dist/`, so rebuild after changing either. Only `test:sdk`, `test:run-stop` and
`npm test` build the backend themselves; nothing builds the frontend for you.

To use a Chromium you already have instead of Playwright's download, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:charts
```

## Type checks

```sh
npm run check
```

This runs `tsc --noEmit` on the backend and `svelte-check` on the frontend.

## Unit tests

```sh
npm test
```

This builds the backend and runs every `tests/*.test.mjs` file with `node --test`. The tests
use `backend/dist/`, or load frontend TypeScript modules directly; they need neither the
frontend build, Chromium nor Python. To run one file:

```sh
npm run build -w backend
node --test tests/history-store.test.mjs
```

| Area                      | Files                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage and database      | `history-codec`, `history-store`, `storage-golden`, `storage-maintenance`, `db-checkpoint`, `db-contention`, `schema-upgrade`, `backend` (ingest, retries, resume, decimation, view conflicts), `compression`, `server-metrics`                                                                                                          |
| Runs                      | `run-management`, `run-metadata`, `run-state`, `run-runtime`, `run-environment`, `run-group`, `run-colors`, `run-format`, `view-new-runs`, `selection-limits`, `live-updates`                                                                                                                                                            |
| Charts and frontend logic | `chart-math`, `chart-extent`, `chart-cache`, `smoothing-sampling`, `grouped-charts`, `record-transforms`, `expressions`, `plotsources`, `plot-inspector`, `plot-settings`, `section-layout`, `tile-layout`, `panel-frame`, `linked-frame`, `swipe`, `search`, `navigation`, `media-axis`, `media-playback`, `chat-parts`, `localization` |
| Media                     | `media-items`, `media-cap`, `video-poster` (skips its ffmpeg cases when `ffmpeg` is missing)                                                                                                                                                                                                                                             |
| Tools, auth, plugins      | `tool-clients`, `tool-concurrency`, `structured-errors`, `auth`, `plugin-management`, `plugin-options`, `project-lifecycle`, `project-confirmations`, `artifact-detail`                                                                                                                                                                  |
| Assistant                 | `pi-agent`, `agent-isolation`, `agent-recovery`, `agent-routing`, `agent-settings`, `agent-redaction`, `conversations`                                                                                                                                                                                                                   |
| Ledger and planning       | `ledger`, `ideas`, `plan-queue`, `occupancy`, `lineage`, `lineage-graph`                                                                                                                                                                                                                                                                 |
| Docs                      | `docs` (see [Documentation checks](#documentation-checks))                                                                                                                                                                                                                                                                               |

Several of these run the built CLI (`backend/dist/cli.js`) as a child process, so CLI
parsing is tested alongside the tools.

## Browser suites

Each `npm run test:*` script below starts its own server on a temporary data directory and a
free loopback port, drives headless Chromium, and deletes the directory at the end. Run them
after `npm run build`.

### Charts

| Command                      | Covers                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:charts`        | Exact data for every chart type, X fit, zoom and legend hover; hover popups (smoothed and original values, keyboard, touch, phone width); area and stacked hover; hover stability while a response streams; focused-run overrides; grouped charts over 1,000 runs |
| `npm run test:resolution`    | Resolution levels, refinement when a panel grows, live deltas, progressive drawing                                                                                                                                                                                |
| `npm run test:zoom`          | Drag to zoom on X, click to reset, minimum drag, refinement after zoom                                                                                                                                                                                            |
| `npm run test:scroll-cache`  | Panels scrolled back into view reuse stored responses; live updates still refresh them                                                                                                                                                                            |
| `npm run test:smoothing`     | Each smoothing method over wide step gaps, a custom X axis and wall time                                                                                                                                                                                          |
| `npm run test:transforms`    | Computed metrics, stacked and percent area set up in the editor, checked against per-record values                                                                                                                                                                |
| `npm run test:display`       | Grid layout of chart panels: one cell per run or group, reflow, virtualization, keyboard, linked hover                                                                                                                                                            |
| `npm run test:plot-settings` | Workspace, section and panel settings cascade, delete with Undo, full screen; excluding outliers from the Y range                                                                                                                                                 |

### Workspace and panels

| Command                         | Covers                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run test:metrics`          | Metric catalog in the editors (loading, missing metrics, live arrival); the panel editor's metric form                  |
| `npm run test:reorder`          | Drag and keyboard reordering of panels and sections, saved order                                                        |
| `npm run test:swipe`            | Swiping between a section's pages with touch and touchpad                                                               |
| `npm run test:panel-icons`      | Panel header button sizes and hit areas across themes, widths and touch                                                 |
| `npm run test:workspace-header` | Header controls fit, search folding, view picker conflicts, deleted views                                               |
| `npm run test:plugins`          | The real `Panel.svelte` and plugin registry with external plugin modules, served by a Vite dev server (no randl server) |

### Runs

| Command                       | Covers                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run test:runs-table`     | Runs table colors in both themes, stable column widths, per-tab search                                            |
| `npm run test:columns`        | Runs table column picker; touch comboboxes in Assistant and settings                                              |
| `npm run test:run-controls`   | Run row actions on touch and at narrow widths, solo, pins, stop confirmation, color picker; grouping by run state |
| `npm run test:run-focus`      | Drag-to-solo and visibility toggles in the run list, focus and scroll stability                                   |
| `npm run test:bulk-selection` | Large selections and their limits, search by run ID or URL, metric catalogs beyond 1,000 runs                     |
| `npm run test:snapshots`      | An imported snapshot shows its stored state and source, without Stop                                              |
| `npm run test:run-stop`       | Stopping a real W&B SDK process from the browser (needs the [SDK environment](#wb-sdk-gate); builds the backend)  |

### Projects, ledger and shell

| Command                   | Covers                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run test:projects`   | Project lifecycle and connect instructions; with `RANDL_SDK_PYTHON` set, also a real SDK first run            |
| `npm run test:lineage`    | Lineage page, experiment ledger, Plans page and GPU timeline, Findings page with 500 findings, long run names |
| `npm run test:shell`      | Shell, run page, project page and settings details                                                            |
| `npm run test:mobile-nav` | The phone header menu and overlay navigation                                                                  |
| `npm run test:languages`  | Rail labels, workspace controls and settings fit in every interface language                                  |
| `npm run test:auth`       | A server with an API key: invalid key, sign-in and sign-out                                                   |
| `npm run test:agent`      | The Assistant against a local test provider (see [Assistant tests](#assistant-tests))                         |

### Performance

These measure time or memory against fixed budgets on seeded synthetic runs. Results depend
on the machine; run them on an otherwise idle one. Budgets and past measurements are in
[../guides/performance.md](../guides/performance.md) and
[../history/performance.md](../history/performance.md).

| Command                      | Measures                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `npm run test:run-query`     | Name search over 10,000 runs; the list stays virtualized                               |
| `npm run test:run-selection` | Restoring the run list after clearing a search, with large visible and solo selections |
| `npm run test:open-latency`  | Time from pointer down to a dialog's first layout with 1,100 runs                      |
| `npm run test:hover-latency` | Hover cost on the run list and charts with live streaming runs, and heap growth        |

## Suites that need a demo server

`test:browser`, `test:resources` and `test:media` run against a server you start, named by
`RANDL_URL`. They have no default URL, so they never touch a server by accident. They create
and delete only their own views and projects. Seed a scratch directory with synthetic runs
(the server must not be running on it), then serve it:

```sh
node scripts/seed-demo.mjs --data-dir /tmp/randl-demo
npm run randl -- serve --port 8744 --data-dir /tmp/randl-demo
```

`seed-demo.mjs` writes a `demo/synthetic-sweep` project (`--runs`, default 400; `--steps`,
default 800), leaving a few runs running. In another terminal:

```sh
RANDL_URL=http://127.0.0.1:8744 npm run test:browser
RANDL_URL=http://127.0.0.1:8744 npm run test:resources
```

- `test:browser` covers the run list, visibility and solo, view persistence, panel settings,
  run page links, live updates during view conflicts, the mobile drawer, section resize,
  pagination, automatic panels, bulk actions and the Runs table. `RANDL_BROWSER_FILTER` runs
  only checks whose name contains its value.
- `test:resources` cycles through pages and checks that heap, mounted charts and canvases
  return to their baseline. `RANDL_RESOURCE_CYCLES` sets the cycles (2 to 12, default 6) and
  `RANDL_RESOURCE_PROJECT` the project. If the server has an API key, set `RANDL_API_KEY`.

`test:media` checks media panels against the run that `tests/sdk_smoke.py` logs. Log it to
the demo server with the [SDK environment](#wb-sdk-gate), then run the suite:

```sh
RANDL_URL=http://127.0.0.1:8744 .venv-sdk/bin/python tests/sdk_smoke.py
RANDL_URL=http://127.0.0.1:8744 npm run test:media
```

It needs `ffmpeg`. To include the image grid checks, stop the server and seed
`demo/media-demo` first:

```sh
node scripts/seed-media.mjs --data-dir /tmp/randl-demo
```

## W&B SDK gate

The SDK gate checks randl against the real `wandb` package. It uses an isolated Python
environment, pinned in `tests/requirements-sdk.txt`:

```sh
python -m venv .venv-sdk
.venv-sdk/bin/pip install -r tests/requirements-sdk.txt
npm run test:sdk
```

`test:sdk` builds the backend and runs `tests/sdk-gate.mjs`, which:

1. starts a server on a temporary directory and loopback port, with an imported running
   snapshot;
2. runs each `tests/sdk_*.py` and `tests/artifact_sdk_smoke.py` script against it: logging,
   media, artifacts, stop and resume, environment metadata, snapshots, record transforms,
   lineage, `wandb login --host` and `wandb sync`;
3. runs the public API script against a second server whose default entity is `demo`;
4. repeats all of it with an API key;
5. finally runs the storage restart test: the server stops for 90 seconds while the SDK keeps
   logging, then restarts, and every row must arrive exactly once.

The gate takes several minutes. It uses `.venv-sdk/bin/python` relative to the current
directory; if that does not exist, it fails rather than skipping.

| Variable            | Effect                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `RANDL_SDK_PYTHON`  | Another Python with `wandb` installed                                                                                                      |
| `RANDL_SDK_SCRIPTS` | Comma-separated script names to run, such as `sdk_smoke.py,artifact_sdk_smoke.py`; the public API and restart scripts run only when listed |

```sh
RANDL_SDK_SCRIPTS=sdk_smoke.py,sdk_stop_smoke.py npm run test:sdk
```

Each script can also run on its own against a server named by `RANDL_URL` (and
`RANDL_API_KEY` if it has one); it creates labeled runs there. Use a scratch server, not one
with real data.

## Assistant tests

`test:agent` and `test:projects` connect Pi to a local test provider: an HTTP stand-in on
loopback that answers like a model, so no real provider is contacted and no key is needed.

The live test sends real, billable requests to a provider, using synthetic data only. Put
the key in a private JSON file outside the repository, `{"apiKey": "..."}`, and run:

```sh
RANDL_AGENT_TEST_KEY_FILE=/path/to/private-key.json npm run test:agent:live
```

It uses DeepSeek by default. Set `RANDL_AGENT_TEST_PROVIDER` and `RANDL_AGENT_TEST_MODEL`
to test another Pi provider and model. The test checks that the key is saved, cleared from
the form and absent from status output, that a connection test passes, that the model can
build a view through the tools, and that retry after a rename sends the original request.

## Documentation checks

`tests/docs.test.mjs` runs as part of `npm test`. It checks every Markdown file at the top
level, in `docs/` and in `.claude/skills/`:

- `docs/reference/tools.md` and `docs/reference/cli.md` match the code;
- relative links and `#anchors` resolve;
- every tool named in a `/api/tools/<name>` path exists, and every example request in an
  `http` block validates against the tool's schema;
- every backticked error code is one the server sends;
- every `randl` command in a shell block parses, with its required flags;
- skill files have valid frontmatter;
- nothing machine-specific or secret appears: home directory paths, key-like strings, long
  hex strings, and any term listed one per line in the ignored `tmp/private-terms.txt`.

After changing a tool, its schema or a CLI command, regenerate the references:

```sh
npm run docs
```

This builds the backend and runs `scripts/docs-reference.mjs`, which starts a server on a
temporary directory, seeds synthetic data, calls every tool with the examples in
`scripts/docs/tool-examples.mjs`, and writes both reference files with the responses it got.
`node scripts/docs-reference.mjs --check` reports a difference without writing.

## README screenshots

The screenshots in `.github/assets/readme/` come from illustrative data only.
`scripts/readme-demo.py` logs synthetic experiments with the real W&B SDK, and
`scripts/readme-screenshots.mjs` starts a server on a scratch directory, logs that data,
builds the views and captures the pages. The Assistant and CLI scenes use a local stand-in
model.

```sh
npm run build
RANDL_SDK_PYTHON=.venv-sdk/bin/python node scripts/readme-screenshots.mjs --data-dir /tmp/randl-readme
```

It needs `ffmpeg`, a Python environment with `wandb`, `numpy` and `Pillow`, and `bash`,
`jq` and `column` for the CLI scene. `--only hero,grid` recaptures some scenes, and
`--serve` keeps the server running afterwards. `--data-dir` must be new or one the script
created before.

## Rules for tests

- **One test per scenario.** Before adding a test, find the suite that owns the behavior and
  extend it. Add a new file only for a new area, and give it a `test:*` script if it is a
  browser suite.
- **Shared harness.** Browser and performance scripts use `tests/helpers.mjs`:
  `launchBrowser` (honors `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`), `listen` (a free loopback
  port), `demoURL` (reads `RANDL_URL`, with no default) and `sentText` (decodes a compressed
  response as sent).
- **Scratch data only.** A test makes its own data directory with `mkdtemp`, in the system
  temporary directory or under the repository's ignored `tmp/`, and removes it afterwards.
  Never point a test at a real data directory or a server with real data.
- **Synthetic data only.** Tests, fixtures and seed scripts use invented names such as
  `team/navigation` and hosts such as `gpu-a`. Never copy real experiment data, run names,
  paths or keys into the repository. `tests/fixtures/storage-golden.json` holds only hashes
  of synthetic output.
- **Loopback only.** Tests bind to `127.0.0.1` and contact no outside service, except the
  opt-in live Assistant test.
