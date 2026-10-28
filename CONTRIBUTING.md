# Contributing to randl

## Development setup

Requirements: Node.js 22.19 or newer, npm, and a C++ build toolchain if `better-sqlite3`
has no prebuilt binary for your platform. Python is needed for the W&B SDK tests, and
`ffmpeg` for media fixtures and video posters.

```sh
npm ci
npm run build
npm start
```

For frontend work, keep the server running and start Vite in another terminal; it
proxies API, SDK and file-transfer requests to the backend:

```sh
npm run dev
```

Use a separate data directory for experiments with development builds:

```sh
npm run randl -- serve --port 8743 --data-dir /path/to/scratch-data
```

## Architecture

- **Frontend** (`frontend/src/`): a Svelte 5 and TypeScript single-page app built with
  Vite, using `carbon-components-svelte`, Carbon icons and modular ECharts. Every chart
  and media panel is a plugin with the same lifecycle as installed ones
  ([PLUGINS.md](PLUGINS.md)).
- **Backend** (`backend/src/`): Fastify serves the app, the JSON API, server-sent
  events and the W&B SDK endpoints (a GraphQL adapter for the SDK's named operations,
  file streams and uploads). A dedicated worker thread owns the SQLite connection; the
  HTTP process never runs SQL on its event loop, and long chart jobs run in time slices
  so ingestion is never starved.
- **Storage**: run metadata sits apart from history. History is kept twice, losslessly:
  the exact logged text and a numeric index, both in zlib-compressed blocks with small
  uncompressed tails. Chart queries keep each bucket's minimum and maximum, with bucket
  widths aligned to powers of two so finer resolutions refine coarser ones.
- **Management tools**: the browser, the `randl` CLI and the Pi assistant share one tool
  catalog (`backend/src/tools.ts`). There is no assistant-only behavior.

| Directory           | Contents                                                            |
| ------------------- | ------------------------------------------------------------------- |
| `backend/src/`      | HTTP server, SQLite worker, SDK adapter, tools, CLI, Pi integration |
| `frontend/src/`     | Svelte components, theme tokens, panel plugins, language catalogs   |
| `tests/`            | Unit, browser and real-SDK compatibility tests                      |
| `scripts/`          | Synthetic fixtures and development utilities                        |
| `examples/plugins/` | Installable plugin examples                                         |
| `deploy/`           | Reverse-proxy example                                               |

## Conventions

- Use Carbon components and tokens; keep secondary actions on hover, focus and touch.
- Put interface text in all seven catalogs in `frontend/src/locales/` (English,
  Simplified Chinese, Traditional Chinese (Taiwan), Japanese, Korean, French and
  Spanish). Never translate logged data such as run names or metric keys.
- Keep the run list and chart resources bounded; selections must work with drag and
  keyboard as well as clicks.
- Never execute downloaded plugin install or build scripts.
- Keep credentials, experiment data and profiling captures out of Git and logs. Put
  scratch files in the ignored `tmp/` directory.
- Update README.md, DEPLOYMENT.md or PLUGINS.md when commands or contracts change.

## Tests

```sh
npm run check   # TypeScript and Svelte checks
npm test        # unit tests
npm run build
```

Browser suites use Playwright's Chromium (`npx playwright install chromium`, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`). Most start their own isolated fixtures:

```sh
npm run test:charts
npm run test:zoom
npm run test:display
npm run test:runs-table
npm run test:metrics
npm run test:plugins
npm run test:languages
npm run test:mobile-nav
```

`package.json` lists every suite (`test:*`). `test:browser` and `test:resources` need a
seeded demo server:

```sh
node scripts/seed-demo.mjs --data-dir /tmp/randl-demo
npm run randl -- serve --port 8744 --data-dir /tmp/randl-demo
# In another terminal:
RANDL_URL=http://127.0.0.1:8744 npm run test:browser
RANDL_URL=http://127.0.0.1:8744 npm run test:resources
```

`test:media` checks media panels against the run that `tests/sdk_smoke.py` logs to that
server (`RANDL_URL=... .venv-sdk/bin/python tests/sdk_smoke.py`, then
`RANDL_URL=... npm run test:media`). To include the image grid checks, seed
`demo/media-demo` first with `node scripts/seed-media.mjs --data-dir /tmp/randl-demo`
while the server is stopped.

### W&B SDK compatibility

SDK tests use an isolated Python environment and temporary loopback servers:

```sh
python -m venv .venv-sdk
.venv-sdk/bin/pip install -r tests/requirements-sdk.txt
npm run test:sdk
```

`test:sdk` checks logging, media, artifacts, stop and resume, resuming imported runs,
`wandb login --host` and `wandb sync`, with and without an API key. Set
`RANDL_SDK_PYTHON` to use another interpreter and `RANDL_SDK_SCRIPTS=a.py,b.py` to run
some of the scripts. The individual scripts in `tests/` can also run against a server
named by `RANDL_URL`; they create labeled runs there.

### Assistant

`test:agent` and `test:projects` connect Pi to a local test provider. To test a real
provider, put its key in a private JSON file containing `apiKey` and run the opt-in test,
which uses synthetic data and sends billable requests (DeepSeek by default; set
`RANDL_AGENT_TEST_PROVIDER` and `RANDL_AGENT_TEST_MODEL` for another Pi provider):

```sh
RANDL_AGENT_TEST_KEY_FILE=/path/to/private-key.json npm run test:agent:live
```

## README screenshots

The screenshots in `.github/assets/readme/` come from illustrative data only.
`scripts/readme-demo.py` logs synthetic experiments with the real W&B SDK (procedural
curves, sprites and CartPole videos), and `scripts/readme-screenshots.mjs` starts a
server on a scratch directory, logs that data, builds the views and captures the pages:

```sh
npm run build
RANDL_SDK_PYTHON=.venv-sdk/bin/python node scripts/readme-screenshots.mjs --data-dir /tmp/randl-readme
```

It needs `ffmpeg` and a Python environment with `wandb`, `numpy` and `Pillow`. Pass
`--only hero,grid` to recapture some scenes, and `--serve` to keep the server running.
