# Contributing

randl is a Node.js server (`backend/`) and a Svelte single-page app (`frontend/`) in one npm
workspace. This page gets you running and lists the rules every change follows. Read
[architecture](architecture.md) before larger changes.

## Development setup

Requirements: Node.js 22.19 or newer, npm, and a C++ toolchain if `better-sqlite3` has no
prebuilt binary for your platform. Python is needed for the W&B SDK tests, and `ffmpeg` for media
fixtures and video posters.

```sh
npm ci
npm run build
npm start
```

For frontend work, keep the server running and start Vite in another terminal; it proxies API,
SDK and file requests to the backend on port 8742:

```sh
npm run dev
```

Use a scratch data directory and another port for development builds, never a data directory
you care about:

```sh
npm run randl -- serve --port 8744 --data-dir /tmp/randl-dev
node scripts/seed-demo.mjs --data-dir /tmp/randl-demo     # synthetic demo projects
```

## Where things live

| Path                        | What                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `backend/src/server.ts`     | HTTP routes: SDK protocol, charts, files, tools, plugins, Assistant      |
| `backend/src/tools.ts`      | The management tool catalog and its dispatcher                           |
| `backend/src/database.ts`   | Database operations, run in the database worker                          |
| `backend/src/ledger.ts`     | Findings, journals, recipes, plans, ideas, GPU inventory                 |
| `backend/src/plan-queue.ts` | Queue order, allocation and projection                                   |
| `backend/src/cli.ts`        | The `randl` command                                                      |
| `frontend/src/`             | Pages and components (`*.svelte`), shared helpers (`ui.ts`, `routes.ts`) |
| `frontend/src/plugins/`     | Built-in panel plugins and the plugin registry                           |
| `frontend/src/locales/`     | Interface text in seven languages                                        |
| `tests/`                    | Unit tests (`*.test.mjs`) and browser suites (`*-browser.mjs`)           |
| `docs/`                     | This documentation                                                       |
| `.claude/skills/`           | Agent skills                                                             |

## Rules for every change

- **Stack.** Svelte 5 and TypeScript with Vite, `carbon-components-svelte` and Carbon icons,
  modular ECharts, Fastify, SQLite in a worker, Pi for the Assistant, `markdown-it` with raw
  HTML disabled. Ask before adding or replacing a major dependency. No Docker; no Vega or
  Plotly.
- **Unreleased project.** Prefer a clean breaking change over a compatibility shim for randl's
  own internals; delete what you replace (code, CSS, message keys, tests, docs) in the same
  change.
- **One path for every client.** The dashboard, CLI and Assistant use the same tools and the
  same panel plugin contract; no agent-only behaviour, no privileged built-in charts.
- **Validate at the boundary.** HTTP input is checked once, by the route's JSON Schema. Inside,
  rely on types; guard only states that can occur, and say why when it is not obvious.
- **Bounded resources.** Keep the run list, caches, queues, mounted rows and chart instances
  bounded; release renderers, timers, observers and listeners.
- **Selections.** Keep independent visibility and multiple solos working with drag and
  keyboard, not only clicks.
- **Plugins.** Never run downloaded plugin install or build scripts.
- **Interface text** goes through the language catalogs ([design system](design-system.md#localization)).
  Logged data (run names, metric keys) is shown as logged.
- **Private data stays out of Git.** No credentials, experiment data, profiling captures or
  machine-specific paths in code, tests, fixtures or docs; tests use synthetic data. Scratch
  files go in the ignored `tmp/` directory.

## Before you commit

1. `npm run check` and `npm test` pass.
2. The browser suites for the area you changed pass ([testing](testing.md)).
3. You reviewed your own diff.
4. Docs match the change. Change a tool or CLI command, then run `npm run docs` to regenerate
   the [tool](../reference/tools.md) and [CLI](../reference/cli.md) references; `npm test` fails
   while they are stale. Every `randl` command and tool request in `docs/` and
   `.claude/skills/` is checked against the code.

## Writing documentation

- Describe current behaviour in the present tense. Change history belongs in commits; dated
  decision records go in [docs/history](../history/README.md).
- Give each fact one home and link to it.
- Use the synthetic project `team/navigation`, hosts `gpu-a` and `gpu-b`, and run IDs such as
  `wide02` in examples.
- Commands must run as written; examples must agree with each other (ports, IDs, paths).
- Scope claims to evidence: name the tested SDK version, the measured workload.
