# Panel plugin API

Every dashboard panel in randl is a panel plugin: a directory with a `panel.json` manifest
and a browser ES module. The built-in line, media, table and GPU occupancy panels use the
same host, data requests, settings and renderer lifecycle as installed ones.

This page is the reference for that contract. For a walkthrough that builds a plugin step
by step, see [Building a custom panel](../guides/custom-panels.md). The
[stat-card example](../../examples/plugins/stat-card/) uses most of the features below.

## Plugin directory

```text
stat-card/
  panel.json          manifest, at the root of the directory
  panel.js            the entry module named by "entry"
  locales/en.json     message catalogs named by "locales"
  locales/fr.json
```

| Rule        | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Manifest    | `panel.json` at the root; a regular file (not a symlink) of at most 64 KiB, parsed as JSON.                                                |
| Entry       | A `.js` file inside the directory, named by `entry` relative to the root.                                                                  |
| Symlinks    | Refused anywhere in the directory.                                                                                                         |
| Size        | At most 20 MiB of files in total. `.git` and `node_modules` directories are skipped and not counted.                                       |
| Build step  | None. randl runs no install or build scripts; a plugin that needs bundling ships its built module.                                         |
| Other files | Copied as is. The entry module can import them with relative URLs, and the host serves `.js`, `.css` and `.json` with their content types. |

## Manifest

This manifest writes out every data field. The stat-card example's own `panel.json` sets
only `metricSelection` of them and declares more options.

```json
{
  "id": "stat-card",
  "name": "Latest value",
  "version": "1.1.0",
  "apiVersion": 1,
  "entry": "panel.js",
  "dataKind": "scalar",
  "metricTypes": ["scalar"],
  "metricSelection": "single",
  "renderer": "dom",
  "settings": {
    "common": [],
    "options": [
      {
        "key": "decimals",
        "tab": "display",
        "type": "integer",
        "control": "slider",
        "min": 0,
        "max": 8,
        "step": 1,
        "unit": "options.decimals.unit",
        "default": 4,
        "label": "options.decimals.label"
      }
    ]
  },
  "locales": { "en": "locales/en.json", "fr": "locales/fr.json" }
}
```

### Required fields

| Field        | Rule                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | Matches `^[a-z][a-z0-9-]{1,63}$`: a lowercase letter, then 1–63 lowercase letters, digits or hyphens. Built-in IDs are reserved. |
| `name`       | String shown in the panel type list.                                                                                             |
| `version`    | String. Informational; the installed content revision, not the version, identifies the code.                                     |
| `apiVersion` | Must be `1`. The host passes the same value to `create`.                                                                         |
| `entry`      | String path of the browser module (see [Plugin directory](#plugin-directory)).                                                   |

### Data fields

These fields choose what the host requests and how the panel editor picks metrics. The
server stores them as written and does not check them at install; the host treats a
missing or unrecognised value as the default.

| Field             | Values                                                    | Default      | Effect                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataKind`        | `scalar`, `snapshot`, `media`, `occupancy`                | `scalar`     | What `data` holds: metric history, one value per run, logged media, or the project's GPU occupancy. See [Data shapes](#data-shapes). The editor's panel type list leaves out `occupancy` plugins; add such panels with `panel_add`.         |
| `metricTypes`     | Array of metric kinds                                     | `["scalar"]` | Metrics the editor offers. History metrics are `scalar`; config and summary leaves are `number` or `category`; media metrics use their logged `_type`, such as `histogram`, `image-file`, `images/separated`, `video-file` or `table-file`. |
| `metricSelection` | `single`, `multiple`, `xy`, `axes`, `none`                | `multiple`   | `single`: one metric. `multiple`: up to 8. `xy`: two, stored as `[Y, X]`; the host sets `panel.settings.xAxis` to X. `axes`: 2–8 axes. `xy` and `axes` need two distinct fields. `none`: no metric picker.                                  |
| `renderer`        | `dom`, or anything else                                   | ECharts      | `dom`: `create` receives no `echarts`. Any other value: the host loads its ECharts build and passes it.                                                                                                                                     |
| `recordTransform` | `{"kind": "align", "normalization": "none" \| "percent"}` | none         | Checked at install: exactly these two keys. See [Record transforms](#record-transforms).                                                                                                                                                    |
| `settings`        | `{common, options, defaults}`                             | empty        | Checked at install. See [Settings and options](#settings-and-options).                                                                                                                                                                      |
| `locales`         | Object of locale ID to catalog path                       | none         | Checked at install. See [Locales and messages](#locales-and-messages).                                                                                                                                                                      |

Other top-level fields are stored and returned by `GET /api/plugins` unchanged.

When a workspace generates panels automatically, scalar metrics get the built-in `line`
panel, and a media metric gets the first enabled plugin with `dataKind: "media"` whose
`metricTypes` include the metric's logged type.

### Built-in plugins

Built-in plugins have the same shape, with `builtin: true`, version `1.0.0` and no entry
or revision. Their IDs cannot be installed.

| ID                | `dataKind`  | `metricSelection` | `renderer` | Notes                                                     |
| ----------------- | ----------- | ----------------- | ---------- | --------------------------------------------------------- |
| `line`            | `scalar`    | `multiple`        | `echarts`  |                                                           |
| `area`            | `scalar`    | `multiple`        | `echarts`  |                                                           |
| `stacked-area`    | `scalar`    | `multiple`        | `echarts`  | `recordTransform` align, `none`                           |
| `percent-area`    | `scalar`    | `multiple`        | `echarts`  | `recordTransform` align, `percent`                        |
| `bar`             | `snapshot`  | `multiple`        | `echarts`  | `metricTypes`: `scalar`, `number`                         |
| `scatter`         | `snapshot`  | `xy`              | `echarts`  | `metricTypes`: `scalar`, `number`, `category`             |
| `scatter-history` | `scalar`    | `xy`              | `echarts`  | Pairs X and Y from the same history record                |
| `parallel`        | `snapshot`  | `axes`            | `echarts`  | `metricTypes`: `scalar`, `number`, `category`             |
| `image`           | `media`     | `single`          | `dom`      | `image-file`, `images/separated`; options `fit`, `smooth` |
| `audio`           | `media`     | `single`          | `dom`      | `audio-file`, `audio`                                     |
| `video`           | `media`     | `single`          | `dom`      | `video-file`, `videos`; options `loop`, `autoplay`        |
| `table`           | `media`     | `single`          | `dom`      | `table-file`                                              |
| `histogram`       | `media`     | `single`          | `echarts`  | `histogram`                                               |
| `gpu-occupancy`   | `occupancy` | `none`            | `dom`      | Project-wide; drawn read-only on the Plans page           |

## Renderer lifecycle

The entry module exports `create`, and optionally `extent`:

```js
export function create({ element, echarts, apiVersion, onRange, onHover, onCursor, onOpen }) {
  return {
    update({ data, panel, options, dark, colors, locale, translate, localize, cell }) {
      // Draw `data` into `element`. Release anything kept from the previous update.
    },
    resize() {},
    destroy() {
      // Release listeners, timers, canvases and retained data.
      element.replaceChildren();
    },
  };
}

// Optional, pure: the [min, max] Y range the chart would show for a context, or null.
export function extent(ctx) {
  return null;
}
```

### Create arguments

`create(host)` receives one object. It may return the renderer or a promise of it.

| Property     | Type                                                 | Meaning                                                                                                                  |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `element`    | `HTMLDivElement`                                     | A fresh `div` sized `100%` × `100%` inside the panel. The plugin owns its contents. The host removes it after `destroy`. |
| `echarts`    | object or `undefined`                                | The host's modular ECharts build; `undefined` when `renderer` is `dom`. See [ECharts build](#echarts-build).             |
| `apiVersion` | `1`                                                  | The host's panel API version.                                                                                            |
| `onRange`    | `(range: {xMin, xMax} \| null) => void`              | Report a zoom; `null` resets it. See [Zoom ranges](#zoom-ranges).                                                        |
| `onHover`    | `(runIds: string[]) => void`                         | Report hovered runs; `[]` when the pointer leaves. See [Linked hover](#linked-hover).                                    |
| `onCursor`   | `(cursor: {axis, value, runOrder?} \| null) => void` | Share an X position with other panels. See [Linked cursors](#linked-cursors).                                            |
| `onOpen`     | `(target: {run: string} \| {plan: string}) => void`  | Ask the host to open a run or a plan. See [Opening runs and plans](#opening-runs-and-plans).                             |

In a read-only dashboard the host ignores `onHover` and `onCursor`.

### Renderer methods

| Method                         | Required | Called when                                                                                                                      |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `update(ctx)`                  | yes      | New data, settings, options, colors, theme or language. May return a promise.                                                    |
| `resize()`                     | yes      | The panel's plot area changes size. Synchronous.                                                                                 |
| `destroy()`                    | yes      | The panel is removed, its plugin changes, or the host evicts it while hidden. Synchronous.                                       |
| `highlightRuns(runIds, local)` | no       | The hovered runs change anywhere in the dashboard, and before each `update`. `local` is true when this panel reported the hover. |
| `showCursor(cursor)`           | no       | Another panel shares or clears a cursor (`null`). Not called for the panel's own cursor.                                         |
| `exportImage()`                | no       | The user chooses **Export PNG**. Return a PNG data URL, or a promise of one. Without this method the menu has no **Export PNG**. |

`create` must return an object with `update`, `resize` and `destroy` functions; otherwise
the panel shows that required rendering methods are missing.

### Update context

`update(ctx)` receives:

| Property    | Type                                      | Meaning                                                                                                    |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `data`      | object                                    | The response for the panel's `dataKind`. Read-only. See [Data shapes](#data-shapes).                       |
| `panel`     | object                                    | The panel: `id`, `plugin`, `metric`, `metrics`, `title`, `section`, `expressions`, and `settings` (below). |
| `options`   | `Record<string, number\|boolean\|string>` | Every option the plugin declares, resolved and defaulted. See [Option values](#option-values).             |
| `dark`      | boolean                                   | True in the dark theme.                                                                                    |
| `colors`    | `Record<string, string>`                  | Run IDs to hex colors for the current theme. See [Theming](#theming).                                      |
| `locale`    | string                                    | Interface language: `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `fr` or `es`.                                  |
| `translate` | `(key, values?) => string`                | Resolves randl's own message keys. See [Locales and messages](#locales-and-messages).                      |
| `localize`  | `(key, values?) => string`                | Resolves the plugin's own catalogs.                                                                        |
| `cell`      | `{index, count, compact}` or absent       | Set when the renderer draws one cell of a grid. See [Grid layout](#grid-layout).                           |

`panel.settings` holds the host settings resolved through the workspace, section and
panel layers, without plugin options:

- Every key of the view's plot settings that a layer sets (see
  [Plot settings](tools.md#plot-settings)), such as `xScale`, `yMin`, `smoothingMethod`,
  `groupBy`, `legend` or `layout`. A key no layer sets is absent.
- `smoothingMethod` is always present (`none` when no layer smooths), and
  `smoothingValue` is present whenever a method is.
- `xAxis` is the axis of the response when it has one, and for `xy` panels the X metric.
- `xMin` and `xMax` include a zoom reported through `onRange`.
- `itemSize` follows the size slider while it moves, for `itemLayout` panels.
- `marks`, when present, lists reference points `{x, label?}` the host asks the chart to
  draw as vertical lines. It is not stored in views.

With [computed metrics](#computed-metrics), `panel.metric` and `panel.metrics` are the
names of every series, plain metrics first, matching `data.metrics`.

### When the host calls update

- After `create` resolves, once data, options and the plugin's catalogs are ready.
- On every change to any property of the context. A theme, language or run color change
  calls `update` again with the same `data`.
- Only while the panel is showing: within half a screen of the viewport, expanded, or
  holding focus. Changes made while it is hidden are kept, and the latest one is applied
  when it shows again. A panel that returns without changes is not updated.
- Live runs: new points from running runs reach a panel on a shared 2-second tick, and
  not while the pointer is hovering a chart. Other changes apply at once.
- While a history response streams in, `update` receives partial data (see
  [Scalar history data](#scalar-history-data)).
- The host schedules updates across animation frames and does not wait for a returned
  promise. A rejection from an older `update` is ignored once a newer one has started.

### Hidden renderers

A panel that leaves the viewport keeps its renderer, so scrolling back redraws nothing.
The host keeps at most 12 hidden renderers (a grid counts each mounted cell) within an
estimated memory budget of 32–96 MiB, scaled by the device's memory. Beyond that, the
least recently hidden are destroyed and later created again from cached responses. A
plugin cannot tell an eviction from any other `destroy`.

### Errors

| Failure                                                      | What the host does                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Module has no `create` export                                | Shows an error in the panel.                                                                               |
| `create` throws or rejects                                   | Disposes any ECharts instance on `element`, releases its canvases, removes it, shows the message.          |
| `create` returns an incomplete renderer                      | Same cleanup; shows that required rendering methods are missing.                                           |
| `create` resolves after the panel moved on                   | Calls `destroy` on the late renderer at once.                                                              |
| `update` throws or rejects                                   | Shows the error's `message`; the next successful `update` clears it.                                       |
| `resize`, `highlightRuns`, `showCursor`, `exportImage` throw | Shows the message in that panel only. `exportImage` then yields no image.                                  |
| `destroy` throws                                             | Catches the error without showing it, and still disposes ECharts, releases canvases and removes `element`. |
| Plugin disabled                                              | The panel says its plugin is unavailable; the module is not loaded.                                        |

Errors a plugin throws are shown as written; translate them with `localize` first.

## Data shapes

Treat `data` and every array in it as read-only. The host decodes one response and shares
it between panels, grid cells and later visits; mutating it corrupts other panels until a
reload. Copy arrays before sorting or transforming them.

### Scalar history data

`dataKind: "scalar"` panels receive the chart response for the panel's metrics:

| Field             | Type                            | Meaning                                                                         |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `metrics`         | `string[]`                      | The requested series, in order.                                                 |
| `series`          | object[]                        | One per run, or one per group when grouping applies.                            |
| `xAxis`           | string                          | The X axis: `_step`, `_runtime`, `_relative_wall`, `_timestamp` or a metric.    |
| `xRange`          | `[min, max]` or null            | The X range of the response.                                                    |
| `sampled`         | boolean                         | True when the response is downsampled.                                          |
| `bucketWidth`     | number or null                  | X width of each min/max bucket; null when every point is included.              |
| `resolution`      | `low`, `medium`, `high`, `full` | The resolution used.                                                            |
| `pointLimit`      | `{limit, total}`                | Present when the panel's point limit, not its resolution, set the bucket width. |
| `groupCount`      | number                          | Grouped responses: the number of groups before the run limit.                   |
| `recordTransform` | object                          | The transform applied, for computed metrics and aligned stacks.                 |
| `omittedRecords`  | number                          | Records left out by a transform.                                                |
| `revision`        | string                          | Identifies the response.                                                        |

Each entry of `series`:

| Field     | Type                                        | Meaning                                                                                                                                          |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`      | string                                      | The run ID, or a group's key.                                                                                                                    |
| `name`    | string                                      | The run's display name, or the group's.                                                                                                          |
| `values`  | `Record<metric, [x, value][]>`              | Points in X order. Missing observations are omitted, never filled.                                                                               |
| `means`   | `Record<metric, [x, mean][]>`               | Downsampled ungrouped series: each bucket's mean at the last X logged in it, for buckets holding several points. Smooth from these when present. |
| `pending` | `true`                                      | While streaming: this run has not arrived and its `values` are empty. Keep its legend entry so the layout does not move.                         |
| `group`   | `{field, value}`                            | Grouped series: the grouping field and this group's value (`field` is `all` for one group of every run).                                         |
| `runIds`  | `string[]`                                  | Grouped series: every member run.                                                                                                                |
| `bands`   | `Record<metric, [x, lower, upper, runs][]>` | Grouped series: one row per point of `values`. See [Grouped charts](#grouped-charts).                                                            |

### Snapshot data

`dataKind: "snapshot"` panels receive one observation per run, with `snapshot: true` and
`sampled: false`. Each series adds `attributes`, a map of metric to value:

- A `config.` or `summary.` field reads that stored value: number, string, boolean or
  null.
- Any other metric reads the run's latest history value, or null.
- Numeric attributes also appear as `values[metric] = [[0, value]]`; other metrics have
  empty `values`.

Grouped snapshot series aggregate their members' numeric values with the panel's
aggregation (mean, median, min or max). A non-numeric field keeps the members' common
value, or the string `"Mixed"` when they differ. The response then has `groupCount`.

### Media data

`dataKind: "media"` panels receive the `POST /api/media` response for `panel.metric`:

| Field                          | Meaning                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xAxis`                        | The axis media are placed on: `_step` (default), `_runtime`, `_relative_wall`, `_timestamp` or a metric.                                                                                                      |
| `xValues`                      | Across runs: the distinct axis values where the runs logged the metric, ascending, at most the newest 10,000. Empty across the steps of one run.                                                              |
| `xValuesTruncated`             | True when `xValues` was cut to 10,000.                                                                                                                                                                        |
| `x`                            | Across runs: the value shown. Null across the steps of one run.                                                                                                                                               |
| `entries`                      | `{run, runName, metric, step, x, value}` objects. Across runs: each run's entry at the greatest axis value at or before `x`, in run order. Across steps: one run's entries by step, at most the newest 1,000. |
| `total`                        | Runs with media at `x`, or the entries the run logged.                                                                                                                                                        |
| `metrics`, `series`, `sampled` | `[metric]`, `[]` and `false`, so code written for history data does not fail.                                                                                                                                 |
| `revision`                     | Identifies the response.                                                                                                                                                                                      |

Each entry's `value` is the W&B SDK's media descriptor, with its `_type`. A run that logs
the metric only later keeps its place with `step`, `x` and `value` null. A list logged
under one key is one entry with several files (`images/separated` lists `filenames`;
`videos` and `audio` list file descriptors). The host also adds:

| Entry field                   | Meaning                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `files`                       | The number of files logged, when the descriptor lists fewer (`filesTruncated: true`).        |
| `missing`                     | Paths of files the SDK has not uploaded yet. The response revision changes when they arrive. |
| `value.width`, `value.height` | For video descriptors without a size, the size read from the file's header.                  |

The panel's **Files per step** (`mediaFiles`, 1–1,000, default 100) bounds the files listed
per step; across runs they are shared among the runs, each keeping at least one.

#### File URLs

Load a logged file through the dashboard's session:

```text
/api/run-file-preview?run=<run id>&path=<file path>&digest=<sha256>
/api/run-file-poster?run=<run id>&path=<file path>&digest=<sha256>
```

URL-encode each value. `digest` is optional: pass the logged SHA-256 so the browser caches
the file as immutable; without it the browser revalidates. The preview endpoint serves
images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`), video (`.mp4`, `.webm`) and audio
(`.mp3`, `.wav`, `.ogg`) with byte ranges, so players can stream and seek. For a
`.table.json` file it returns `{columns, data, truncated}` with at most 200 rows, and
refuses tables over 8 MiB. The poster endpoint returns a video's first frame as a JPEG
image, or `501` when the server has no `ffmpeg`.

#### Media position and the shown run

The host keeps the media position in the browser tab and draws the step slider and item
size controls itself; the renderer draws the entries it receives. A renderer that shows a
single run reports it by dispatching a bubbling `randl:media-run` event from `element`,
with `detail: {run}` (the run ID, or `undefined` when it shows several runs again). The
slider then spans that run's media.

### Occupancy data

`dataKind: "occupancy"` panels are project-wide: the host calls the
[`project_occupancy`](tools.md#project_occupancy) tool for the panel's project, again each
minute while the panel shows, instead of reading runs' metrics. `data` is its result plus
empty `series` and `metrics`:

| Field      | Meaning                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `now`      | Server time, in seconds.                                                                                                                                                                                                                      |
| `hosts`    | `{host, model, rows, reserved?}`. Each row is `{key, gpu}`; `gpu` is null for a row of runs that logged no GPU indices. `reserved` lists GPUs kept out of allocation.                                                                         |
| `bars`     | `{id, run, plan, name, host, slot, gpus, count, start, end, kind, state, verdict, estimated, unknownLength, rows, …}`. `start` and `end` are seconds. `kind` is `past`, `running`, `remaining` or `planned`. `rows` are the row keys covered. |
| `unplaced` | `{id, name}` of running runs that log no compute block.                                                                                                                                                                                       |
| `unfit`    | `{id, name, reason}` of waiting plans no host can run.                                                                                                                                                                                        |

Bars may also carry `lane` and `lanes` (bars overlapping in time), `follows`, `claimed`,
`inferred`, and for running runs `progress`, `budget`, `from`, `rate` and `audit`.

### ECharts build

`echarts` is the `echarts/core` namespace with these modules registered: line, bar,
scatter and parallel charts; grid, tooltip, legend, data zoom, parallel, toolbox and mark
line components; the canvas renderer. Other chart types are not available through it.

`echarts.init` returns a chart whose `setOption` shares numeric `[x, y]` arrays with
ECharts' models instead of copying them. Those arrays, and arrays returned by
`getOption()`, are read-only: replace data with `setOption` when it changes.
`appendData` copies the affected series first, so it cannot change another panel's input.

## Shared interactions

### Zoom ranges

Call `onRange({xMin, xMax})` after the user zooms, or `onRange(null)` to reset. The host
puts the range into `panel.settings.xMin` and `xMax` and, for plugins that declare `axes`,
requests history for that range, which returns finer points. Without `axes` the request is
not narrowed. The range resets when the panel's X axis or saved bounds change.

### Linked hover

Call `onHover(runIds)` while the pointer is over runs, and `onHover([])` when it leaves.
The host highlights those runs in the run list and in other panels by calling their
`highlightRuns(runIds, local)`. `local` is true only in the panel that reported the hover;
it is false for hover from another panel, the run list or the runs table, and for a
cleared hover. Use it to tell local emphasis from linked inspection.

### Linked cursors

Call `onCursor({axis, value, runOrder})` to share an X position, and `onCursor(null)` to
clear it. `axis` is the X axis name, so receivers can ignore cursors on other axes.
`runOrder` is optional: the run IDs of the reporting panel's inspector rows in display
order, before any row limit. Other panels receive it through `showCursor(cursor)`.

Report `onHover` before the matching `onCursor`; the host then calls `highlightRuns`
before `showCursor`. The reporting panel gets its own changes immediately; other panels
may receive them over the following frames, and only while they are on screen. Hidden and
destroyed renderers receive no queued calls.

### Opening runs and plans

Call `onOpen({run: runId})` or `onOpen({plan: planId})`. Where the panel is shown in a
page that can open them, such as the Plans page, the host opens the run's page or the
plan's editor; elsewhere the call does nothing.

### Image export

Implement `exportImage()` to add **Export PNG** to the panel menu. A grid composes up to
64 cells, with their captions, by drawing each in turn through one off-screen renderer and
calling its `exportImage()`; larger grids disable the item. Coverflow exports the current
cell.

## Settings and options

```json
"settings": {
  "common": ["legend", "tooltip"],
  "options": [
    { "key": "trend", "tab": "display", "after": "legend", "type": "select",
      "default": "none", "label": "options.trend.label",
      "choices": [ { "value": "none", "label": "options.trend.none" },
                   { "value": "arrow", "label": "options.trend.arrow" } ] }
  ],
  "defaults": { "itemSize": 240 }
}
```

`settings` has at most three keys. Omitting it is the same as
`{"common": [], "options": []}`. Any unknown key, capability or descriptor field refuses
the install.

### Host settings

`settings.common` lists the host settings the panel uses, without repeats. Their controls
appear in the panel editor and their values reach `panel.settings`.

| Capability     | Editor controls                                              | Keys in `panel.settings`                                                            |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `axes`         | X axis choice; X and Y scale and bounds                      | `xAxis`, `xScale`, `yScale`, `xMin`, `xMax`, `yMin`, `yMax`                         |
| `yAxis`        | Y scale and bounds only                                      | `yScale`, `yMin`, `yMax`                                                            |
| `outliers`     | Fit the Y range to percentiles                               | `excludeOutliers`, `outlierLower`, `outlierUpper` (default 5 and 95)                |
| `smoothing`    | Smoothing method and amount                                  | `smoothingMethod`, `smoothingValue`                                                 |
| `original`     | Show the unsmoothed line                                     | `showOriginal`                                                                      |
| `grouping`     | Group by, aggregation                                        | `groupBy`, `aggregation`                                                            |
| `spread`       | Band around a grouped line                                   | `spread`: `none`, `stddev`, `stderr` or `minmax`                                    |
| `legend`       | Legend on/off and position                                   | `legend`, `legendPosition`                                                          |
| `legendLabels` | Legend label template                                        | `legendTemplate`                                                                    |
| `points`       | Show points                                                  | `showPoints`                                                                        |
| `lineWidth`    | Line width                                                   | `lineWidth`                                                                         |
| `tooltip`      | Hover popup rows and names                                   | `tooltipLimit`, `tooltipFullNames`, `tooltipColoredNames`, `tooltipOnlyHighlighted` |
| `expressions`  | Computed metrics                                             | `panel.expressions`; see [Computed metrics](#computed-metrics)                      |
| `cellLayout`   | **Data → Layout**: Combined, Grid, Coverflow; shared Y range | `layout`, `itemSize`, `sharedY`; see [Grid layout](#grid-layout)                    |
| `itemLayout`   | Item size and layout for plugins that tile items             | `layout`, `itemSize`, and for media `mediaAcross`, `mediaFiles`                     |

A plugin declares at most one of `cellLayout` and `itemLayout`.

The server applies only `xAxis`, `xMin`, `xMax`, `groupBy`, `aggregation`, `spread`,
`maxRuns` and `resolution` when it answers a data request. Without `axes`, the host leaves
the X axis and X bounds out of the request; without `spread`, the spread. Every other key
(scales, Y bounds, outliers, smoothing, legend, points, line width, tooltip) is the
renderer's to apply; the built-in charts smooth in the browser.

| `smoothingMethod` | `smoothingValue` meaning                                   | Range, default |
| ----------------- | ---------------------------------------------------------- | -------------- |
| `ema`             | Weight of the previous smoothed value per point (debiased) | 0–0.99, 0.6    |
| `twema`           | The same weight per point spacing of X                     | 0–0.99, 0.6    |
| `gaussian`        | Kernel standard deviation in point spacings                | 0.5–50, 3      |
| `running`         | Centered window, in points                                 | 1–500, 10      |

`settings.defaults` may give `itemSize` (an integer, 80–960) a default for this plugin,
used when no settings layer sets it. It is its only key.

### Option descriptors

`settings.options` adds up to 32 typed options to the editor's tabs.

| Field                | Rule                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                | Required. Matches `^[a-z][a-zA-Z0-9]{0,31}$`: a lowercase letter, then up to 31 letters or digits. Unique within the plugin.                                                                        |
| `tab`                | Required. `data`, `axes`, `smoothing`, `grouping` or `display`. A tab holding only plugin options appears for that plugin.                                                                          |
| `after`              | Optional. A host control of that tab to follow; see [Option placement](#option-placement).                                                                                                          |
| `type`               | Required. `number`, `integer`, `boolean`, `select`, `text` or `color`.                                                                                                                              |
| `control`            | Optional. `number`, `integer`: `input` (default) or `slider`. `select`: `dropdown` (default) or `radio`. No other type takes a control.                                                             |
| `min`, `max`, `step` | Numeric types only. Finite numbers; `min` below `max`; `step` positive. A slider needs `min` and `max`.                                                                                             |
| `unit`               | Numeric types only. Message key shown with the value.                                                                                                                                               |
| `choices`            | `select` only, and required there: 1–50 `{value, label}` objects; `value` a string or finite number, unique; `label` a message key. `radio`: at most 5.                                             |
| `maxLength`          | `text` only. Integer 1–200; default 200.                                                                                                                                                            |
| `default`            | Required. Must satisfy the option, as a stored value must.                                                                                                                                          |
| `label`              | Required. Message key, 1–128 characters.                                                                                                                                                            |
| `help`               | Optional. Message key, 1–128 characters.                                                                                                                                                            |
| `scopes`             | Optional. Non-empty, unique subset of `panel`, `section`, `workspace`. Default: all three.                                                                                                          |
| `inheritGroup`       | Optional. Identifier with the same pattern as `key`. Options sharing it override and reset together.                                                                                                |
| `enabledWhen`        | Optional. `{key, in}`: `key` names another option of this plugin or the host setting `legend`, `layout`, `smoothingMethod` or `groupBy`; `in` is a non-empty array of strings, numbers or booleans. |

A value satisfies its option when:

| `type`    | Valid values                                                                  |
| --------- | ----------------------------------------------------------------------------- |
| `boolean` | `true` or `false`                                                             |
| `number`  | A finite number within `min` and `max` when set                               |
| `integer` | An integer within `min` and `max` when set                                    |
| `select`  | Exactly one of the `choices` values (type included)                           |
| `text`    | A string of at most `maxLength` characters. Render it as text, never as HTML. |
| `color`   | A `#rrggbb` string                                                            |

`enabledWhen` disables the control while the condition is false; it stays visible and
keeps its value. The condition reads the resolved option values first, then the resolved
host setting.

### Option placement

With `after`, an option follows that host control when the editor shows it. Without
`after`, or when that control is not shown, it goes at the end of its tab under the
plugin's name. Section and workspace settings list every option at the end of its tab.

| Tab         | Controls an option can follow                                           |
| ----------- | ----------------------------------------------------------------------- |
| `data`      | `metrics`, `xAxis`, `title`, `section`, `shown`, `layout`, `resolution` |
| `axes`      | `xAxis`, `bounds`, `outliers`                                           |
| `smoothing` | `smoothing`, `original`                                                 |
| `grouping`  | `groupBy`, `aggregation`, `spread`                                      |
| `display`   | `legend`, `points`, `lineWidth`, `tooltip`, `itemSize`                  |

The editor shows a control only for the capabilities that need it: for example `layout`
needs `cellLayout`, `resolution` is not shown for `media` and `snapshot` panels, and
`itemSize` shows only for grids.

### Option values

Option values are stored in a view's plot settings as `options[pluginId][key]`, at the
workspace, section and panel layers, and cascade key by key like the host settings: a more
specific layer overrides a broader one, and a layer that omits a key inherits it. Keys of
one `inheritGroup` replace each other together.

The renderer receives `options` with every declared key. A stored value that does not
satisfy its option, such as one saved for an earlier plugin version, gives the default,
and the editor says so; the stored value is not rewritten. Options never reach data
requests, and `panel.settings` never contains them.

A panel stores only its own plugin's options, and the editor keeps only keys declared for
the layer's scope. Every write (the browser, the CLI and the assistant through the view
and panel tools, and `PUT /api/views/:id`) checks submitted values against the installed
plugin and refuses a changed invalid value with `400` and code `PLUGIN_OPTION_INVALID`,
`params: {plugin, key}`. Values of plugins that are not installed, undeclared keys and
unchanged stored values are accepted, so updating or removing a plugin never makes a view
unsavable. A layer holds options for at most 64 plugins, each with at most 32 keys;
string values are at most 200 characters.

[`plugins_list`](tools.md#plugins_list) returns each plugin's descriptors, so the
assistant and scripts can discover option keys. [`panel_add`](tools.md#panel_add) and
`panel_update` take option values in `settings.options`.

### Locales and messages

`locales` maps locale IDs to message catalogs inside the plugin:

| Rule      | Value                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Locale ID | Matches `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, such as `en`, `fr` or `zh-Hant`.                                                   |
| Path      | A string ending in `.json`, inside the plugin directory, naming a regular file of at most 64 KiB.                              |
| Content   | A flat JSON object of string keys to string messages.                                                                          |
| English   | When `settings.options` is not empty, `locales.en` is required and must define every `label`, `help`, `unit` and choice label. |

`localize(key, values)` and the editor resolve a key in the catalog for the interface
language (for example `zh-Hant`), then its base language (`zh`), then English, then return
the key itself. `{name}` placeholders take `values[name]`; numbers are formatted for the
locale. Catalogs have no plural forms. A plugin catalog never resolves randl's own keys.
Catalogs load from the plugin's revisioned source and are cached per revision and
language.

`translate(key, values)` resolves randl's interface catalogs, such as
`charts.tooltip.more` or `charts.groups.allRuns`. For a plural pair (`key.one`,
`key.other`), pass the base key and a numeric `count`. `translate({text})` returns `text`
unchanged. An unknown key throws in development builds and automated browsers and returns
the key in production, so external plugins should keep their own text in their own
catalogs.

Format numbers and dates with `Intl` and `locale`. Show run names, metric keys and file
names as logged. A language change calls `update` again.

## Grid layout

A plugin that declares `cellLayout` gets **Data → Layout**:

| `layout`    | Shows                                                  |
| ----------- | ------------------------------------------------------ |
| `single`    | Every run or group in one chart (default).             |
| `grid`      | One cell per run, or per group while grouping applies. |
| `coverflow` | One cell at a time, with its neighbors beside it.      |

Each cell is an ordinary renderer of the same plugin with the same lifecycle. With fewer
than two cells the panel draws one chart with an unchanged context. Otherwise each cell's
context differs from the panel's:

| Property                      | In a cell                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `data`                        | The panel's response with `series` limited to that cell's one series. The arrays are shared and read-only. |
| `panel.settings.legend`       | `false` when the panel plots one metric; the cell caption names the run.                                   |
| `panel.settings.xMin`, `xMax` | While X is automatic, the X extent of all cells, so runs of different lengths compare.                     |
| `panel.settings.yMin`, `yMax` | With **Axes → Shared Y range** (`sharedY`), the union of every cell's `extent`, rounded outward.           |
| `cell`                        | `{index, count, compact}`; `compact` is true below 280 CSS pixels of cell width.                           |

`itemSize` (80–960, default 240) sets the cell width; cells are at least 200 pixels wide
and at most 36 renderers mount per panel. The host reuses renderers for cells scrolling in
through `update`. Hover in a cell reaches other cells and panels as usual; zooming any cell
zooms the panel. The panel requests its data once.

### Shared Y range

`extent(ctx)` is an optional named export of the module, not a renderer method. It is
called with a cell's context, for every cell, mounted or not, and returns the `[min, max]`
Y range the chart would show for it, or null. It must be pure and synchronous; a throw
counts as null. Explicit `yMin` and `yMax` still apply. Without `extent`, **Shared Y range**
is unavailable for the plugin.

## Computed metrics

A plugin that declares the `expressions` capability lets a scalar history panel add
computed metrics: named expressions over metrics of the same history record. The panel
stores them as `expressions: [{name, expression}]` beside its plain `metrics`. The host
requests every series through one transform; the renderer receives all of them as
metrics, plain first (see [Update context](#update-context)).

A record contributes to a computed metric only when every referenced metric is present and
finite there and the result is finite, so division by zero is omitted. Each computed
metric is evaluated separately. Expressions are parsed by randl, never evaluated as
JavaScript:

| Form       | Syntax                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Metric     | `${name}`: the name is everything up to the first `}`, so `${train/loss}` and `${a b}` work.                                                                                               |
| Number     | `2`, `0.5`, `.5`, `1e-3`                                                                                                                                                                   |
| Arithmetic | `+`, `-`, `*`, `/`, `%`, `**`. `**` is right-associative and binds tighter than unary minus.                                                                                               |
| Comparison | `<`, `<=`, `>`, `>=`, `==`, `!=`, `===`, `!==`; `==` equals `===`. Results are 1 or 0.                                                                                                     |
| Logic      | `&&`, `\|\|`, `!` (results 1 or 0; a value is true when it is not 0 or NaN), and `test ? a : b`.                                                                                           |
| Math       | `Math.` and `abs sign sqrt cbrt exp expm1 log log1p log2 log10 sin cos tan asin acos atan sinh cosh tanh floor ceil round trunc` (one argument), `atan2 pow` (two), `min max hypot` (1–8). |
| Constants  | `Math.PI`, `Math.E`, `Math.LN2`, `Math.LN10`, `Math.LOG2E`, `Math.LOG10E`, `Math.SQRT2`, `Math.SQRT1_2`                                                                                    |

Limits: 1,000 characters, 200 syntax nodes and nesting depth 32 per expression; up to 8
series per panel, plain and computed together; names unique, non-empty and at most 200
characters. An expression must reference a metric. Violations are refused with `400` and a
structured code such as `EXPRESSION_UNKNOWN_NAME`, `EXPRESSION_TOO_LONG`,
`EXPRESSION_NO_METRIC` or `COMPUTED_METRIC_LIMIT`, with a 1-based `position` for syntax
errors. Saved views, the panel tools and the chart endpoint apply the same checks.

## Record transforms

`recordTransform: {"kind": "align", "normalization": "none" | "percent"}` declares that the
panel stacks several metrics. When the panel has two or more series, the host requests
them aligned within each history record:

- A record is kept only when every requested metric is finite in it. Nothing is
  interpolated or carried forward.
- `percent` divides each component by the record's sum of components and multiplies by 100. Records with a negative input are refused (`CHART_TRANSFORM_NEGATIVE`); records whose
  total is zero are omitted.
- With computed metrics, the computed and plain series are aligned together.

A panel with one series gets ordinary history. A plugin with a `recordTransform` also
supports **Runs shown → Focused run** (`maxRuns: "focused"`) when it has two or more
series: the host then passes `data.series` with only the focused run or group, the one
hovered elsewhere or else the newest, and the renderer needs no extra code. A hover applies at
once when no other run was hovered in the last 150 ms; during a sweep across runs the panel
waits until the pointer rests that long, so it redraws once for the run the pointer stops on.

## Grouped charts

When `groupBy` applies, the server aggregates history on X buckets shared by every run of
the request, and each group is one series:

1. Each run reduces its points in a bucket to its mean, minimum and maximum there, so a
   run logging more often still counts once.
2. Each bucket aggregates the member runs with data in it. `aggregation` `mean` and
   `median` use the run means; `min` and `max` use the run minima and maxima.
3. The point is placed at the last X any member logged in the bucket.

`bands[metric]` rows are `[x, lower, upper, runs]`, matching `values[metric]` by X.
`runs` is the number of members aggregated at that X. `spread` sets the band: `stddev`
(population standard deviation of the run means), `stderr` (that over √runs), `minmax`
(lowest run minimum to highest run maximum), or `none` (lower and upper equal the value).
Smoothing applies after aggregation. `maxRuns` limits the groups shown after every member
has contributed; `groupCount` reports the total.

## Theming

| Input                  | Use                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dark`                 | The theme flag. Choose text, grid and background colors from it.                                                                                                   |
| `colors`               | Run ID to color, already resolved for the theme: the view's override, or the run's palette color. Palette colors switch with the theme; custom hex overrides stay. |
| Series without a color | Group series and IDs missing from `colors` have no host color. Pick a stable color from the series `id`.                                                           |

A theme change calls `update` again with the same data and new `dark` and `colors`.
`element` sits in the dashboard document, so the dashboard's CSS custom properties are
visible to it, but randl does not define a theming API for plugins: rely on `dark` and
`colors` and set your own colors.

## Installation and trust

### Sources

| Source          | Rule                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local directory | A path the server process can read, resolved against the server's working directory. Use an absolute path when the CLI and server run in different places.                                                  |
| GitHub          | Exactly `https://github.com/<owner>/<repo>`, optionally with a trailing `/`; no credentials, query or fragment. The server clones the default branch at depth 1 with Git hooks disabled, within 90 seconds. |
| Anything else   | Refused, including other `://` URLs.                                                                                                                                                                        |

```sh
randl plugins install --source ./examples/plugins/stat-card
randl plugins enable --id stat-card
```

The server validates the manifest, catalogs and settings, copies the directory into its
data directory and records the source. A new plugin is installed **disabled**. Installing
an ID that is already installed is refused; use update.

### Revisions

Each install computes a `revision`: the SHA-256 of every copied file's relative path and
content. The browser loads the module from a URL containing the revision, so relative
imports and catalogs come from the same revision, and browsers never mix files from two
versions. A GitHub install also records the cloned commit as `sourceCommit`.

### Updates

`update` installs again from the recorded source: the same directory path, or the GitHub
URL's current default branch. The new manifest must keep the installed ID. The plugin
keeps its enabled state. If the copy or record fails, the previous files are restored.

Built-in plugins can be enabled and disabled, but not updated or removed; they change with
randl itself.

```sh
randl plugins list
randl plugins update --id stat-card
randl plugins disable --id stat-card
randl plugins remove --id stat-card
```

### Trust

An enabled plugin's module runs in the dashboard's origin, with the user's session: it can
read and change anything the dashboard can. Enable only code you trust. Plugin management
uses the same authentication as the rest of the API: a dashboard session, or the server
API key when one is configured (see [Configuration](configuration.md)).

A disabled plugin's source is not served, its panels show that the plugin is unavailable,
and panels cannot be added or changed to use it.

## HTTP endpoints

| Method and path                                     | Body       | Returns                                                                |
| --------------------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| `GET /api/plugins`                                  |            | `{plugins: [...]}`: built-in plugins, then installed ones by ID.       |
| `POST /api/plugins/install`                         | `{source}` | The installed plugin.                                                  |
| `POST /api/plugins/:id/enable`                      | `{}`       | The plugin.                                                            |
| `POST /api/plugins/:id/disable`                     | `{}`       | The plugin.                                                            |
| `POST /api/plugins/:id/update`                      | `{}`       | The updated plugin. Installed plugins only.                            |
| `POST /api/plugins/:id/remove`                      | `{}`       | `{removed: id}`. Installed plugins only; deletes its files and record. |
| `GET /api/plugins/:id/revisions/:revision/source/*` |            | A file of the installed revision.                                      |

A plugin in the list is its manifest, as stored after validation, plus:

| Field          | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `builtin`      | True for built-in plugins.                                        |
| `enabled`      | Whether panels can use it. Built-ins default to enabled.          |
| `source`       | Installed plugins: the absolute directory path or the GitHub URL. |
| `revision`     | Installed plugins: the content revision.                          |
| `sourceCommit` | GitHub installs: the commit that was cloned.                      |

`settings` is returned in complete form, with `common` and `options` always present.

Failures (an invalid manifest, an unknown ID, an unknown action, an ID mismatch on update,
removing a built-in) return `400` with `{error}`. The source endpoint returns `404` when
the plugin is disabled, missing, built in, or `:revision` is not its current revision. It
serves `.js` as `application/javascript`, `.css` as `text/css`, `.json` as
`application/json` and other files as `application/octet-stream`, and refuses paths
outside the plugin directory.

The CLI's `randl plugins` commands call these endpoints. Testing plugins in a browser is
described in [Testing](../contributing/testing.md).
