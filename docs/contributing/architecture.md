# Architecture

This page describes how randl is built: which process does what, how requests move through
it, and where each part lives in the source tree. It is for contributors. For the storage
format see [storage.md](storage.md); for tests see [testing.md](testing.md).

randl is one Node 22 process. Fastify serves the browser app, the JSON API, a server-sent
event stream and the endpoints the W&B SDK talks to. SQLite (through `better-sqlite3`) holds
everything except uploaded files. The frontend is a Svelte 5 and TypeScript single-page app
built by Vite, using `carbon-components-svelte`, Carbon icons and modular ECharts. The
Assistant runs on Pi (`@earendil-works/pi-coding-agent`), which is imported only when it is
first used.

## Processes and threads

| Thread             | Source                         | Owns                                                                          |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------- |
| HTTP (main thread) | `backend/src/server.ts`        | Fastify routes, authentication, live updates, caches, file I/O, the Assistant |
| Database worker    | `backend/src/db-worker.ts`     | The application `better-sqlite3` connection (`Store` in `database.ts`)        |
| Checkpoint worker  | `backend/src/db-checkpoint.ts` | A second connection that syncs and checkpoints the WAL                        |

The HTTP thread never runs SQL. `backend/src/db.ts` wraps the database worker: `db.call(name,
...args)` posts a named operation and returns a promise. The worker runs only names listed
in the `allowed` set at the top of `db-worker.ts`, each a method of `Store`; any other name
fails with "Unknown database operation". To add a database operation, add the method to
`Store` and its name to that set.

The queue is bounded: with 64 calls outstanding, `db.call` refuses at once with HTTP 503,
and the error handler adds `Retry-After: 1`, which W&B clients honor. SQLite lock
contention is also reported as 503 (`isDatabaseContention` in `management-errors.ts`).

Some operations are jobs: the `Store` method returns a generator instead of a value. The
worker advances a job in slices of about 20 ms and serves queued calls between slices, so a
long chart never starves SDK ingest. Jobs yield on their own schedule: most every 15 ms,
record-transform charts every 4,096 records. The HTTP side starts a job with
`db.job(signal, ...)`; when the request is abandoned, the signal cancels the job at its next
slice. Charts, lineage and GPU occupancy run as jobs.

The checkpoint worker is started by the database worker, not by the HTTP thread. It is
described in [storage.md](storage.md#wal-and-checkpoints). On shutdown the database worker
closes the checkpoint worker first, then its own connection.

## SDK ingest

The W&B SDK speaks to four kinds of endpoint:

| Route                                           | Handler                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /graphql`                                 | `sdkQuery` in `backend/src/sdk.ts` (runs, viewer, server info) and `artifactQuery` in `artifact-api.ts` (artifacts) |
| `POST /files/:entity/:project/:run/file_stream` | The `ingest` database operation                                                                                     |
| `PUT /upload/:entity/:project/:run/*`           | Run files, written to the data directory by the HTTP thread                                                         |
| `PUT /storage/artifacts/:id/...`                | Artifact manifests and files                                                                                        |

The GraphQL adapter answers the SDK's named operations by matching the query text; it is
not a general GraphQL server. A run's ID is `entity/project/name`; when the SDK names no
entity, the server's default entity (`--entity`, `RANDL_ENTITY`, else `local`) is used.

A file-stream request is one SQLite transaction. The SDK sends lines of
`wandb-history.jsonl`, `wandb-events.jsonl`, `wandb-summary.json`, `output.log` and others
with a starting offset. For each line, the store compares the line already at that offset:
an identical line is skipped, so a retried request adds nothing; a different line at an
existing history offset fails the whole request ("Conflicting history replay") rather than
replacing data. History and event lines also update the numeric point index used by charts.
After the transaction, the HTTP thread marks the run changed for live updates.

Run file uploads go to `files/<SHA-256 of the run ID>/` in the data directory. The upload
route adds the file's size change to the run's `file_bytes`; if the run was deleted while
the body streamed, the file is removed and the upload gets 404. An uploaded
`wandb-metadata.json` (up to 1 MiB) is parsed into the run's metadata. Media uploads notify
the media limit (see [storage.md](storage.md#media-limit)).

Signed upload and download URLs (`?expires=...&signature=...`, an HMAC with the API key,
valid for at most an hour) let the SDK reach `/upload` and `/storage` without a bearer
header when an API key is set. W&B compatibility in detail is in
[../reference/wandb-compatibility.md](../reference/wandb-compatibility.md).

## Chart queries

`POST /api/chart` returns the series of one panel. The request names runs (or a registered
selection), up to eight metrics, the plot width in CSS pixels, and the panel's settings.

### Bucketing

The server downsamples each series to buckets of X. `chartResolution` in
`backend/src/chart-diff.ts` turns the panel's Resolution setting and `pixels` into a bucket
count, using `backend/src/panel-limits.json`:

| Resolution     | Buckets per CSS pixel | Point limit per panel |
| -------------- | --------------------- | --------------------- |
| Low            | 0.5                   | 25,000                |
| Medium         | 1                     | 50,000                |
| High (default) | 2                     | 100,000               |
| Full           | no downsampling       | 500,000               |

Bucket widths are powers of two aligned to X = 0 (`bucketWidth`), so a finer level's
buckets nest inside a coarser level's, and a growing run changes only its last buckets.
`planBuckets` in `database.ts` chooses the width for the panel's shared X range, then
doubles it until the estimated points fit the level's point limit; the response then carries
`pointLimit` so the panel can say how many points it shows. `decimate` keeps each series'
two endpoints and the first minimum and maximum in each bucket; `bucketMeans` adds each
bucket's mean, which the browser smooths. Taking first occurrences is what makes a coarser
result a subset of a finer one.

The browser rounds the plot width up to a power of two before sending `pixels`
(`Panel.svelte`), so resizing within a step reuses loaded points. Device pixel ratio does
not affect sampling.

### Limits and selections

An ungrouped chart compares at most `chartRuns` runs (1,000). A grouped chart aggregates the
whole selection, up to 100,000 runs (`selection-limits.json`). Grouped panels do not resend
the IDs: they register the list once with `POST /api/chart-selections` and send its content
token (`backend/src/chart-selection.ts`). The server keeps registered lists in memory, up to
1,000,000 IDs in total, least recently used first out. A request naming a forgotten token
gets HTTP 409, and the browser registers the list again.

### Caching and diffs

A chart's revision is a SHA-256 of the request and the revisions of its runs. The server
keeps up to 16 MiB of serialized responses by revision (`Cache` in `server.ts`).

- If the request's `baseRevision` equals the current revision, the reply is
  `{unchanged: true}`.
- If the server still holds the base response, it replies with a point diff
  (`chartDiff`, `diffSeries` in `chart-diff.ts`); otherwise, given the client's earlier run
  revisions (`baseVersions`), it resends only series whose run changed.
- A diff is sent only when it is smaller than 90% of the full reply.

Ungrouped history charts are streamed as newline-delimited JSON when the client accepts
`application/x-ndjson`: a metadata line, then series in chunks of 4 runs doubling up to 64,
then a final line. Each chunk is compressed and flushed as it is written, so panels draw runs
as they arrive. Grouped, snapshot and some record-transform charts return one JSON body.

Inside the database worker, statistics and decimated points of unchanged runs are kept in a
derived-value cache of up to 64 MiB, keyed by run revision.

Media panels use `POST /api/media`; their revision is a hash of the response content, so a
live run that logs only scalars gets `{unchanged: true}` for its media panels.

### Browser side

`frontend/src/chart-loader.ts` and `frontend/src/api.ts` manage chart requests:

- Identical pending requests are shared; at most four chart requests run at once.
- Up to 64 MiB of serialized chart and media responses are kept, least recently used out.
  A second cache holds up to 64 decoded responses within an estimated 16 MiB.
- A stored response that is at least as detailed as a new request (a smaller plot, a lower
  level, a narrower X range) serves it without a request. Otherwise the closest stored
  response stays drawn while the server sends a diff against it.
- Panels mount from half a screen above to half a screen below the viewport. A panel that
  returns to view draws its stored response and requests an update only if a run's
  revision changed.
- Panels out of view keep at most twelve renderers within an estimated 32 to 96 MiB
  (12 MiB per GiB of reported device memory); the least recently hidden are destroyed
  first and rebuilt from stored responses.
- `panel-frame.ts` admits one panel data update per animation frame;
  `linked-frame.ts` coalesces linked hover and cursor updates across panels.

Measured costs and the history of these choices are in
[../history/performance.md](../history/performance.md); current budgets are in
[../guides/performance.md](../guides/performance.md).

## Live updates

`GET /api/events` is a server-sent event stream (`backend/src/live.ts`). Code that changes a
run calls `live.changedRun(id)`; tool calls and writes to views, plugins and artifacts call
`live.changedWorkspace()`. Changes are batched for 120 ms, then one event carries the
changed runs' metadata (from the `runMetas` operation), the IDs of runs that no longer exist,
and whether the workspace changed.

Each run's `revision` increases when its data changes. The browser (`App.svelte`) replaces
its run rows from the event; panels whose runs' revisions changed request a diff from
`/api/chart`. If reading the metadata fails, the server sends a `reset` event and clients
reload their snapshot, as they do on reconnect (`ready`).

Every send checks the client's session first, so a signed-out client stops receiving data.
A client more than 64 KiB behind is dropped. A comment line every 25 seconds keeps proxies
from closing the stream.

## Management tools

The dashboard, the `randl` CLI and the Assistant change things through one catalog:
`toolCatalog` in `backend/src/tools.ts`. Each entry has a name, a description and a JSON
schema for its arguments. The server registers each tool as
`POST /api/tools/<name>`, validating the body with that schema (no type coercion, no
unknown fields), and lists the catalog at `GET /api/tools`. The CLI's commands are thin
wrappers around these routes (`backend/src/cli.ts`; `randl tool NAME --json ...` calls any
tool). The tool reference, generated from the catalog, is [../reference/tools.md](../reference/tools.md);
the CLI reference is [../reference/cli.md](../reference/cli.md).

`Tools.execute` checks selection limits and plugin option values, then runs the tool. Writes
to one view are serialized by a per-view lock, with at most 128 queued (503 above that).
Writes to an existing view must name its current `version`; a stale version is refused with
409 and code VIEW_CONFLICT, so two browsers or the Assistant cannot silently overwrite each
other.

Every tool call that changes something is recorded in the `audit` table: the tool name, its
arguments and the time. Reads, dry runs and repeats that change nothing are not recorded.
Run selections are recorded as counts rather than ID lists, and a project deletion as the
project ID and its counts. Nothing in the server reads the log back yet; it is for
inspection with SQLite.

### The Assistant's subset

The Assistant gets only tools without `agent: false`. Server settings, the media limit,
run history edits and every ledger and planning tool are excluded; the CLI and dashboard
use them. `project_delete` has `tier: 'confirm'`: Pi sees an ID-only schema, and the call
pauses until the person confirms in the browser (see [The Assistant](#the-assistant)).

### Errors

Management errors carry an English message, an HTTP status and optionally a `code` and
`params`, and keep them across the database worker (`errorFields` in
`backend/src/management-errors.ts`). Only codes listed in that file are sent to clients;
library error codes are dropped. HTTP error bodies are `{error, code?, params?}`. The browser's
`ApiError` keeps these fields, and `apiMessage` in `frontend/src/api.ts` maps known codes to
catalog messages in the person's language. Project errors use catalog keys as codes
(`backend/src/project-errors.ts`). Scripts may branch on codes; the list in
`management-errors.ts` is the contract, and `tests/docs.test.mjs` checks that the docs name
only codes from it.

## Experiment ledger and planning

The ledger keeps what was learned beside the runs. Its tables are created by `Ledger` in
`backend/src/ledger.ts`:

| Record        | Table                          | Notes                                                       |
| ------------- | ------------------------------ | ----------------------------------------------------------- |
| Findings      | `findings`, `finding_versions` | One current record per ID; every earlier version kept       |
| Recipe        | `recipe_events`                | The project's current best run and its history              |
| Planned runs  | `planned_runs`                 | Waiting work with a GPU request                             |
| Ideas         | `ideas`                        | A backlog of experiments waiting on runs, plans or findings |
| GPU inventory | `gpu_inventory`                | Each project's hosts and GPUs, and which may be allocated   |
| Run journals  | `run_journal`                  | Notes on a run's timeline                                   |

Records have caller-chosen IDs, so saving the same record twice is a no-op. Every change is
a tool call and is audited.

`backend/src/plan-queue.ts` is pure logic over plans:

- `queueOrder` orders waiting plans: an explicit queue position first, then the plan they
  are queued after, then creation time.
- `choose` is the allocator behind `plan_claim`: a host agent reports its free GPUs, and the
  first waiting plan that fits gets specific GPU IDs. Later plans may backfill, unless the
  head of the queue has waited longer than six hours and the host could run it, in which
  case the host holds the GPUs for it.
- `project` runs the same rules forward in time for the Plans page's projected schedule.
- A plan's status follows the run that carries it out (`statusFromRun`). A claim whose run
  has not logged within 30 minutes returns the plan to the queue.

`backend/src/lineage.ts` derives which run each run started from: from an explicit `lineage`
config block when the training code logs one, else by matching a checkpoint path in one of
the project's parent config keys against run folder names. It also diffs configs along each
edge. Lineage settings are stored per project as a server setting.

`backend/src/occupancy.ts` builds the GPU timeline: which runs held which GPUs of each host
(from runs' `lineage.compute` segments), which hold them now and until when, and when queued
plans should start (using `project` from `plan-queue.ts`). Lineage and occupancy run as
database jobs.

## Frontend

`frontend/src/main.ts` mounts `App.svelte`, which holds the shell, routing, the run list and
the live-update connection. `frontend/src/routes.ts` parses URLs:

| URL                                                       | Page                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/?page=overview`, `/?page=server`, `/?page=app-settings` | Server-wide pages (project list, server metrics, App settings)                                           |
| `/entity/project/workspace`                               | The project workspace (also `overview`, `runs`, `artifacts`, `settings`, `lineage`, `plans`, `findings`) |
| `/entity/project/runs/run/tab`                            | A run page and its tab                                                                                   |
| `/entity/project/artifacts/type/name/version`             | An artifact version                                                                                      |

A `view` query parameter selects a saved view. Workspaces are made of sections and panels;
`Panel.svelte` hosts one panel: it measures the plot, loads data through `chart-loader.ts`,
and mounts the panel's plugin.

### Panel plugins

Every chart and media panel is a plugin, bundled or installed, with one lifecycle.
`frontend/src/plugins/registry.ts` maps bundled plugin IDs (`line`, `area`, `stacked-area`,
`percent-area`, `bar`, `scatter`, `scatter-history`, `parallel`, `image`, `audio`, `video`,
`table`, `histogram`, `gpu-occupancy`) to lazily imported modules, and loads installed ones
from `/api/plugins/<id>/revisions/<revision>/source/<entry>`. `mountPlugin` calls the
module's `create({element, echarts, apiVersion: 1, ...})` and checks that the result has
`update`, `resize` and `destroy`; optional `highlightRuns`, `showCursor` and `exportImage`
are wrapped so a plugin error cannot break the page. Canvas plugins share the modular
ECharts build in `plugins/engine.ts`. The contract for plugin authors is
[../reference/panel-api.md](../reference/panel-api.md).

Interface text lives in seven catalogs in `frontend/src/locales/`. Components and tokens
follow [design-system.md](design-system.md).

## Plugins on the server

`backend/src/plugins.ts` installs, updates, enables, disables and removes plugins
(`/api/plugins`, `randl plugins ...`). A source is a local directory or the root URL of an
HTTPS GitHub repository, cloned with `git clone --depth=1` and hooks disabled. Installation:

- reads `panel.json` (at most 64 KiB, no symlink) and checks the manifest: an ID that is not
  a bundled one, `apiVersion` 1, a name, a version, and an `entry` JavaScript module inside
  the source;
- checks option descriptors and locale catalogs (`backend/src/plugin-options.ts`);
- copies the files, skipping `.git` and `node_modules`, refusing symlinks and anything over
  20 MiB, into `plugins/<id>/` in the data directory;
- records the SHA-256 of the copied files as the plugin's revision, so an update changes its
  module URLs.

It never runs build or install scripts. A newly installed plugin is disabled until enabled;
enabled plugins are trusted frontend code. Bundled plugins can only be enabled or disabled.
Source files are served only for an enabled plugin at its current revision, and only from
inside its folder.

## The Assistant

`backend/src/agent.ts` runs chats on Pi. The Pi profile (credentials, model list, settings)
is the `pi/` folder of the data directory unless `--pi-agent-dir` or `RANDL_PI_AGENT_DIR`
names a shared one (`backend/src/pi-profile.ts`). Each session gets randl's management tools
as Pi custom tools, randl's system prompt, and no skills, prompt templates, context files or
project extensions; Pi's settings are read in memory with the project untrusted.

- At most four live sessions are kept, and an idle session is disposed after 20 minutes.
  Conversation turns and Pi session entries are stored in SQLite
  (`backend/src/conversations.ts`), so a session is restored when reopened.
- A turn times out after 120 seconds, not counting time spent waiting for a confirmation.
- Provider keys the Assistant learns are redacted from error messages, as are the data,
  profile, working and home directories.
- `project_delete` goes through `ProjectConfirmations` (`agent-confirmations.ts`): the turn
  and its timeout pause, a `confirmation` event with a random token goes to the browser that
  owns the turn, and `POST /api/agent/confirm` must return that token and the project's
  displayed name. The token is never stored, logged or shown to the model. A declined call
  returns a normal tool result, and repeating it in the same turn is declined without asking
  again.

## Authentication

`backend/src/auth.ts` runs before every route.

- By default the server listens on `127.0.0.1` and needs no key.
- Binding to another host, or a public URL that is not loopback, requires both
  `--public-url` (HTTPS, an origin only) and `RANDL_API_KEY` (at least 40 characters).
- Requests to an unknown `Host` get 403. Cross-origin requests get 403 unless they come from
  the public URL (or, locally, the Vite dev server on port 5173).
- With a key, every route except the sign-in routes and static assets needs the key as a
  bearer token (or HTTP Basic password, which the SDK uses), a session cookie, or a signed
  `/upload` or `/storage` URL.
- `POST /api/auth/login` exchanges the key for a random session token. Only the token's
  SHA-256 is stored. The cookie is `HttpOnly`, `SameSite=Strict`, and `__Host-` prefixed and
  `Secure` behind HTTPS; it lasts 12 hours by default, at most a week. Ten failed attempts
  from one address lock it out for a minute.

Deployment, reverse proxies and key handling are covered in
[../guides/deployment.md](../guides/deployment.md); every option is in
[../reference/configuration.md](../reference/configuration.md).

## Server metrics and compression

Fastify hooks time every request except the event stream and count it in one-minute buckets
per route group: SDK (`/graphql`, `/files`, `/upload`, `/storage`, `/sdk`), Assistant
(`/api/agent`, `/api/conversations`), other API, and interface assets
(`backend/src/metrics.ts`). Each bucket keeps request, 4xx and 5xx counts, bytes in and out,
and a latency histogram whose bins grow by 25%. A separate histogram records database worker
call times and queue depth. 180 minutes are kept.
`GET /api/server/metrics?since=<ms>` returns them with process memory, the worker queue,
the database and WAL file sizes, and logical storage totals; the Server page polls it every
10 seconds while open.

JSON and other text responses of at least 1 KiB are compressed with Brotli (quality 4) or
gzip, whichever the client accepts (`backend/src/compression.ts`). Media and byte ranges are
sent as they are. The frontend build writes gzip and Brotli copies of static text assets
(`scripts/compress-assets.mjs`), which the server sends when accepted.

## Source layout

| Path                                                                                  | Contents                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `backend/src/server.ts`                                                               | Fastify app, routes, chart streaming, caches, uploads                       |
| `backend/src/database.ts`                                                             | `Store`: every SQL operation, chart planning and bucketing                  |
| `backend/src/db.ts`, `db-worker.ts`, `db-checkpoint.ts`                               | Database worker client, worker, checkpoint worker                           |
| `backend/src/history-store.ts`, `history-codec.ts`                                    | Compressed history blocks and tails                                         |
| `backend/src/schema.ts`                                                               | Table creation and column upgrades                                          |
| `backend/src/sdk.ts`, `artifact-api.ts`                                               | W&B GraphQL adapter for runs and artifacts                                  |
| `backend/src/tools.ts`                                                                | Management tool catalog and execution                                       |
| `backend/src/cli.ts`                                                                  | The `randl` command                                                         |
| `backend/src/ledger.ts`, `plan-queue.ts`, `occupancy.ts`, `lineage.ts`                | Ledger, queue, GPU timeline, lineage                                        |
| `backend/src/agent.ts`, `pi-profile.ts`, `agent-confirmations.ts`, `conversations.ts` | The Assistant                                                               |
| `backend/src/auth.ts`                                                                 | Host and origin checks, API key, sessions, signed URLs                      |
| `backend/src/plugins.ts`, `plugin-options.ts`                                         | Plugin installation and option checks                                       |
| `backend/src/media-cap.ts`                                                            | The media limit                                                             |
| `backend/src/*.json`                                                                  | Shared limits (`panel-limits.json`, `selection-limits.json`) and run fields |
| `frontend/src/`                                                                       | Svelte components, chart loading, routes, theme                             |
| `frontend/src/plugins/`                                                               | Bundled panel plugins, the registry and the ECharts engine                  |
| `frontend/src/locales/`                                                               | Interface text catalogs                                                     |
| `tests/`                                                                              | Unit, browser, performance and W&B SDK tests                                |
| `scripts/`                                                                            | Demo seeding, docs generation, screenshots, maintenance scripts             |
| `examples/plugins/`                                                                   | Installable plugin examples                                                 |
| `deploy/`                                                                             | Reverse-proxy example                                                       |
| `docs/`                                                                               | Guides, references and these contributor notes                              |
| `.data/`                                                                              | Default data directory (ignored)                                            |
| `vendor/wandb/`                                                                       | Optional W&B SDK reference checkout (ignored)                               |

The frontend imports a few backend modules directly (`chart-diff.ts`, `chart-selection.ts`,
`plugin-options.ts`, the limit JSON files) so both sides share one definition.
