# Writing panel plugins

Every randl panel, including the built-in line, media and table panels, is a plugin:
a directory with a `panel.json` manifest and a browser ES module. Installed plugins use
the same host, data requests and settings as the built-in ones.

The [stat-card example](examples/plugins/stat-card) shows the latest value of a metric
for each run and adds its own options to the panel editor. Install and enable it with:

```sh
npm run randl -- plugins install --source ./examples/plugins/stat-card
npm run randl -- plugins enable --id stat-card
```

## Manifest

```json
{
  "id": "stat-card",
  "name": "Latest value",
  "version": "1.1.0",
  "apiVersion": 1,
  "entry": "panel.js",
  "metricSelection": "single",
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
        "unit": "options.decimals.unit",
        "default": 4,
        "label": "options.decimals.label"
      }
    ]
  },
  "locales": { "en": "locales/en.json", "fr": "locales/fr.json" }
}
```

IDs use lowercase letters, digits and hyphens; built-in IDs are reserved. The entry must
be a `.js` file inside the plugin directory. Symlinks are rejected, and the source
(excluding `.git` and `node_modules`) is limited to 20 MiB. randl never runs build or
install scripts, so a plugin that needs a build must ship its built browser module.

| Field             | Values and behavior                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataKind`        | `scalar` (default) requests history; `snapshot` requests one observation per run; `media` requests logged media.                                                                             |
| `metricTypes`     | Compatible metric kinds. Defaults to `["scalar"]`. Config and summary leaves use `number` or `category`; media uses logged `_type` values such as `histogram`, `image-file` or `table-file`. |
| `metricSelection` | `single`, `multiple` (default), `xy` or `axes`. Panels accept up to eight metrics; `xy` stores them as `[Y, X]`.                                                                             |
| `renderer`        | `dom` omits ECharts; other panels receive the shared modular ECharts instance.                                                                                                               |
| `recordTransform` | Optional `{"kind": "align", "normalization": "none" \| "percent"}`: multi-metric panels receive the metrics aligned within each history record, as stacked charts need.                      |
| `settings`        | Host settings the panel uses and the plugin's own options; see below.                                                                                                                        |
| `locales`         | Locale IDs mapped to the plugin's own JSON message catalogs.                                                                                                                                 |

## Renderer lifecycle

```js
export function create({ element, echarts, apiVersion, onRange, onHover, onCursor }) {
  return {
    update({ data, panel, options, dark, colors, locale, translate, localize }) {
      // Render data into element. Release data retained from earlier updates.
    },
    resize() {},
    destroy() {
      // Release listeners, canvases, timers and retained data.
      element.replaceChildren();
    },
  };
}
```

`create` and `update` may return promises; `resize` and `destroy` are synchronous. The
host resizes the renderer with its container and destroys it when the panel is removed
or evicted from the pool of hidden renderers (at most twelve, within a memory budget). A
hidden renderer may still receive `update`. Errors thrown by the lifecycle appear in the
panel.

`update` receives:

- `data`: for history panels, `series: [{id, name, values}]`, where `values` maps each
  metric to `[x, value]` pairs. While a response streams in, runs not yet received have
  `pending: true` and empty values. Grouped series add `runIds`, `group` and
  `bands[metric]` rows of `[x, lower, upper, runs]`. Snapshot series add `attributes`.
- `panel`: the panel's metrics, title and resolved host settings (`panel.settings`).
- `options`: every option the plugin declares, resolved through the workspace, section
  and panel layers and defaulted.
- `colors`: run IDs mapped to their colors for the current theme; `dark` is true in the
  dark theme. Theme changes call `update` again with the cached data.
- `locale`, `translate(key, values)` for randl's own message keys, and
  `localize(key, values)` for the plugin's catalogs. Format numbers and dates with
  `Intl` and the given locale; keep run names, metric keys and file names as logged.

Treat `data` and all its arrays as read-only: the host shares one decoded response
between panels. Copy arrays before transforming them, and replace ECharts data with
`setOption` rather than mutating it.

## Shared interactions

- `onRange({xMin, xMax})` after a zoom, or `onRange(null)` to reset; the host requests
  history for that range.
- `onHover(runIds)` highlights runs in the run list and other panels (pass `[]` when the
  pointer leaves). Implement `highlightRuns(runIds, local)` to respond; `local` is true
  when this panel owns the hover.
- `onCursor({axis, value, runOrder})` shares an X position, or `onCursor(null)` clears
  it. Implement `showCursor(cursor)` to show the cursor of another panel.
- Implement `exportImage()`, returning a PNG data URL, to enable **Export PNG**.
- Grid-capable plugins may export a pure `extent(ctx)` function returning the
  `[min, max]` Y range their chart would show, so **Shared Y range** can apply.

## Settings and options

`settings.common` lists the host settings a panel uses, and their controls appear in the
panel editor: `axes`, `yAxis`, `outliers`, `smoothing`, `grouping`, `legend`,
`legendLabels`, `points`, `lineWidth`, `tooltip`, `spread`, `original`, `expressions`,
`cellLayout` (the host's Grid and Coverflow layouts) and `itemLayout` (the plugin lays out
items itself at the host's item size, as media panels do). A plugin declares at most one
of the last two.

`settings.options` adds up to 32 typed options to the editor tabs:

| Field                | Rule                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                | A letter followed by up to 31 letters or digits, unique within the plugin.                                                            |
| `tab`                | `data`, `axes`, `smoothing`, `grouping` or `display`.                                                                                 |
| `after`              | Optional host control to follow, such as `title`, `legend` or `smoothing`; otherwise the option goes at the end of the tab.           |
| `type`               | `number`, `integer`, `boolean`, `select`, `text` or `color` (`#rrggbb`).                                                              |
| `control`            | Numbers: `input` (default) or `slider` (needs `min` and `max`). Selects: `dropdown` (default) or `radio` (up to 5 choices).           |
| `min`, `max`, `step` | Finite, with `min` below `max` and a positive `step`.                                                                                 |
| `unit`               | Message key shown with a numeric value.                                                                                               |
| `choices`            | Selects: 1–50 `{value, label}` entries with unique values.                                                                            |
| `maxLength`          | Text: 1–200, default 200. Render text as text, never as HTML.                                                                         |
| `default`            | Required, and must satisfy the option.                                                                                                |
| `label`, `help`      | Message keys of at most 128 characters.                                                                                               |
| `scopes`             | A subset of `panel`, `section` and `workspace` (default all).                                                                         |
| `inheritGroup`       | Options sharing this identifier override and reset together.                                                                          |
| `enabledWhen`        | `{key, in: [values]}` over another option or `legend`, `layout`, `smoothingMethod` or `groupBy`; the control is disabled while false. |

Option values are stored in the view's plot settings and cascade from workspace to
section to panel like the host's own settings. The browser, the CLI and the Assistant
all validate them against the installed plugin. When `options` is not empty,
`locales.en` must define every label, help, unit and choice key; the editor uses the
interface language, then English.

## Media panels

A `dataKind: "media"` panel receives `entries` of `{run, runName, metric, step, value}`,
where `value` is the W&B SDK's media descriptor, plus the logged `steps` and the `step`
shown. Load a file from `/api/run-file-preview?run=RUN_ID&path=PATH` (add `&digest=` with
the logged SHA-256 so the browser can reuse its copy); the dashboard's session
authenticates the request, and range requests let players stream and seek. Declare
`itemLayout` to use the host's item size and step controls.

## Installing, updating and trust

Install from a local directory or the root URL of a public GitHub repository; the
manifest must be at its root. Installed plugins start disabled. Enabling one lets its
code run in the dashboard's origin with access to all of its data, so enable only code
you trust. The server API key also grants plugin management.

```sh
npm run randl -- plugins list
npm run randl -- plugins update --id stat-card
npm run randl -- plugins disable --id stat-card
npm run randl -- plugins remove --id stat-card
```

Updates must keep the plugin's ID. Each installed revision gets its own module URLs, so
browsers never mix files from two versions. Bundled plugins can be disabled but are
updated with randl itself.
