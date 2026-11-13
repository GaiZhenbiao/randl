# W&B compatibility

randl implements the parts of the W&B protocol that the Python SDK uses for tracking. Its
GraphQL adapter handles the SDK's named operations; it is not a general W&B GraphQL server.
Requests it does not support return errors rather than pretending to store data.

It is tested with the real `wandb` **0.30.0** package, in online mode, against isolated servers
with and without an API key (`npm run test:sdk`; see [Testing](../contributing/testing.md)).

## Supported

| Works                                                                             | Notes                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `wandb.init`, `run.log`, config, summary, tags, groups, notes                     |                                                                     |
| Images, video, audio, tables and histograms                                       | Media, table and histogram panels                                   |
| `define_metric` step metrics and hidden metrics                                   | Summary aggregation is computed by the SDK and stored as received   |
| Finish, failure, resume (`resume="allow"` / `"must"`) and stop from the dashboard | Runs without contact for 10 minutes are marked crashed              |
| Run files, environment metadata, system metrics and console logs                  |                                                                     |
| Artifacts: log, version, alias, use and download                                  | Files up to 10 GiB each                                             |
| `wandb login --host`, `WANDB_MODE=offline` with `wandb sync`                      |                                                                     |
| `run.alert()`                                                                     | Shown on the run page (latest 100); no email or chat notifications  |
| `wandb.Api()` reading runs                                                        | `Api().run(...)` and `Api().runs("entity/project")` without filters |

## Not supported

Reports, Sweeps, Registry, Launch, Weave, Vega or Plotly custom charts, W&B accounts and teams
(randl has a single owner), external artifact references, distributed artifacts, multipart
artifact uploads, and public API calls beyond reading runs. SDK features outside the tested
operations are not implied by `wandb.init()` and `wandb.log()` working.

## Run lifecycle

- **States.** A run is `running` from its first contact. It becomes `finished` or `failed`
  when the SDK finishes, and `crashed` after `--run-timeout` seconds (default 600) without
  contact; renewed contact returns it to running. A run marked **stopped** in randl is reported
  as `killed`.
- **Stop.** **Stop** in the dashboard (or `randl runs stop`) sets a stop request that the
  SDK's default handler reads; the run then ends as stopped.
- **Resume.** `wandb.init(id=…, resume="allow")` or `"must"` continues a run at its next
  history offset. A run marked stopped that resumes and logs new history runs again.
- **Duplicate uploads.** The file stream keeps offsets, so retried SDK requests do not add
  duplicate history; a conflicting replay fails instead of replacing data.

## Runtime

A run's runtime is its active time, like W&B's `_runtime`: it continues across resumes and
excludes pauses. randl adds each reported `_runtime` as an increment over the previous report.
An increment counts only when it is non-negative and no longer than the wall time between the
two reports; otherwise the wall time counts, up to 600 seconds (a longer gap is a pause). While
a run is running, the server advances it with elapsed time; completion freezes it.

SDK 0.30.0 reports a resumed run's `_runtime` with a large offset
([wandb/wandb#12999](https://github.com/wandb/wandb/issues/12999), fixed in later releases). The
increment rule ignores such jumps, so the stored runtime stays right, but the `_runtime` values in
those history rows are stored as sent.

For data written before this rule, stop the server and run
`node scripts/rebuild-runtimes.mjs --data-dir DIR` once.

## Environment and command

randl reads `wandb-metadata.json` after upload and stores host, OS, Python, executable,
program and arguments, git, CPU and GPU, memory and SDK version. Files up to 1 MiB are parsed;
larger or malformed ones stay downloadable. The run page reconstructs the logged command with
POSIX quoting (not for Windows metadata); interpreter flags, the working directory and
environment variables are not reconstructed.

## Metric definitions

`define_metric` step metrics and hidden settings are read from SDK metadata. A chart without an
explicit X axis uses the step metric the compared runs define in common. Hidden metrics get no
automatic panel but can be charted explicitly.

## Imported snapshots

Runs prepared from another tracker's data can be marked as snapshots (a capture time and source).
They show their source state, have no Stop action (`RUN_SNAPSHOT_STOP_UNAVAILABLE` when a stop
request holds only snapshots) and keep their recorded runtime. Resuming one with the SDK turns it
into an ordinary live run that keeps its imported data and continues after the source's last
`_step`. There is no import command or interface; snapshots are a storage contract for data
preparation scripts.

## Public API

`Api().run("entity/project/run")` returns `config`, `summary`, `state`, `historyLineCount` and
`lastHistoryStep`; `Api().runs("entity/project")` lists runs without filters. Run filters,
sweeps, history downloads and files are not supported. The default entity is the server's
`--entity` (`local` unless set).
