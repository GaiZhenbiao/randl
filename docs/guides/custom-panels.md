# Custom panels

Every panel in randl, the built-in line chart included, is a **panel plugin**: a folder with a
`panel.json` manifest and a browser ES module. An installed plugin gets the same data, settings
and linked hover as the built-in panels. This guide builds one; the
[panel plugin API](../reference/panel-api.md) is the full contract.

Two complete examples ship with randl:

- [`latest-bars`](../../.claude/skills/randl-custom-panels/example/): each run's latest value as
  a bar in the run's colour, with one option and linked hover. About 90 lines.
- [`stat-card`](../../examples/plugins/stat-card/): the latest value as text, with an option of
  every kind the editor supports and a French catalog.

## 1. The folder

```text
latest-bars/
  panel.json          the manifest
  panel.js            the browser module
  locales/en.json     the plugin's own messages (required when it has options)
```

randl never runs install or build scripts. A plugin written in TypeScript or with
dependencies must ship its built, self-contained module. The source may be at most 20 MiB
(without `.git` and `node_modules`), and symlinks are refused.

## 2. The manifest

```json
{
  "id": "latest-bars",
  "name": "Latest value bars",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "panel.js",
  "renderer": "dom",
  "metricSelection": "single",
  "settings": {
    "common": [],
    "options": [
      {
        "key": "order",
        "tab": "display",
        "type": "select",
        "default": "value",
        "label": "options.order.label",
        "choices": [
          { "value": "value", "label": "options.order.value" },
          { "value": "name", "label": "options.order.name" }
        ]
      }
    ]
  },
  "locales": { "en": "locales/en.json" }
}
```

- `id`: 2–64 lowercase letters, digits and hyphens, starting with a letter; built-in IDs are
  reserved. It never changes across updates.
- `renderer: "dom"` skips loading ECharts. Leave it out to receive the shared `echarts`
  instance.
- `metricSelection`: `single`, `multiple` (default), `xy`, `axes` or `none`.
- `dataKind`: `scalar` history (default), `snapshot`, `media` or `occupancy`.
- `settings.common` opts into host settings (smoothing, axes, legend, grouping…);
  `settings.options` declares the plugin's own, shown in the panel editor.

## 3. The module

The module exports `create`, which returns the renderer:

```js
export function create({ element, apiVersion, onHover }) {
  if (apiVersion !== 1) throw new Error('Requires panel API v1');
  return {
    update({ data, panel, options, colors, dark, locale, localize }) {
      // Draw data.series into element.
    },
    highlightRuns(ids, local) {
      // Runs hovered here or in another panel: restyle, do not redraw.
    },
    resize() {},
    destroy() {
      element.replaceChildren();
    },
  };
}
```

For scalar panels, `data.series` is a list of `{id, name, values}`, where `values[metric]` is an
array of `[x, value]` pairs; series still streaming in have `pending: true`. `panel.metric` is
the chosen metric and `options` holds the plugin's options with defaults applied. The
[`latest-bars` module](../../.claude/skills/randl-custom-panels/example/panel.js) is a complete
renderer.

## 4. Rules that keep the dashboard fast

Panels share one page with dozens of others, many updating live. randl's own panels follow
these rules, and plugins should too:

- **Treat `data` as read-only.** The host shares the same arrays between panels and caches; copy
  before sorting or transforming.
- **Do no rendering work in `highlightRuns`.** Hover moves across every linked panel on each
  pointer move. Restyle what is drawn (opacity, a class, an overlay) and return. randl's line
  charts draw the hovered run in an SVG overlay rather than redrawing the canvas, and dim the
  other runs without making the hovered line thicker.
- **Report hover once per change.** Call `onHover([runId])` when the run under the pointer
  changes and `onHover([])` when it leaves, not on every pointer move.
- **Let the host pace updates.** Live data arrives at most every two seconds, only for panels on
  screen, and waits while the pointer rests on a chart. Do not add timers that redraw.
- **Release everything in `destroy`.** Listeners, timers, observers, canvases and retained data.
  The host keeps a bounded pool of hidden renderers and destroys the least recently hidden.
- **Set logged text as text.** Run names, metric keys and file names go through `textContent`,
  never `innerHTML`.

## 5. Theme and language

- `dark` is true in the dark theme, and `colors` maps run IDs to their colours for the current
  theme. A theme change calls `update` again with the same data.
- Base your colours on `colors` and `dark`. The panel's element sits in the dashboard's
  document, so Carbon variables such as `var(--cds-text-primary)` currently resolve, but they are
  not part of the plugin API: always give a fallback chosen from `dark`, as `latest-bars` does.
- `locale` is the interface language; format numbers and dates with `Intl`.
- `localize(key, values)` reads the plugin's own catalogs (`locales`), falling back to English
  and then the key. `translate(key, values)` reads randl's catalogs for shared messages.

## 6. Try it

Install from a folder the server can read (or a public GitHub repository URL), then enable it.
Installed plugins start disabled:

```sh
randl plugins install --source "$PWD/.claude/skills/randl-custom-panels/example"
randl plugins enable --id latest-bars
```

Add it to a view and set its option:

```sh
randl tool panel_add --json '{"view": "VIEW_ID", "plugin": "latest-bars", "metric": "eval/return", "settings": {"options": {"latest-bars": {"order": "name"}}}}'
```

After editing the source, `randl plugins update --id latest-bars` installs the new revision;
browsers load each revision from its own URL, so they never mix two versions.
`randl plugins disable` and `randl plugins remove` take it out again.

## 7. Test it

randl's own plugin tests show two levels of checks:

- **Install and options**, in Node: install the folder with the server's plugin manager, enable
  it, add a panel with an option, and expect a bad value to be refused with
  `PLUGIN_OPTION_INVALID`. See the `latest-bars` test at the end of
  `tests/plugin-management.test.mjs`.
- **Rendering**, in Chromium: `tests/plugin-browser.mjs` mounts plugin modules in the real
  `Panel.svelte` host with a fixture chart response, and checks that they render, survive
  errors and clean up. `npm run test:plugins` runs it.

See [Testing](../contributing/testing.md) for the browser setup.

## Trust

An enabled plugin runs in the dashboard's origin with access to all of its data, and the API key
that installs plugins grants everything else too. Install only code you have read or trust.
