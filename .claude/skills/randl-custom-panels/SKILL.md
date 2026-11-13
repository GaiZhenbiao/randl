---
name: randl-custom-panels
description: Create a custom randl dashboard panel (a panel plugin) end to end - the panel.json manifest, the browser module and its lifecycle, data access, options and catalogs, theming and dark mode, the hover and performance rules, tests with randl's plugin suites, and installing and enabling it on a server. Use when asked to build, change, debug or install a randl panel, chart type or plugin.
---

# Building a randl panel plugin

A panel plugin is a folder: `panel.json`, a browser ES module, and `locales/en.json` when it
has options. Built-in panels use the same API. Contract:
[panel plugin API](../../../docs/reference/panel-api.md); walkthrough:
[custom panels guide](../../../docs/guides/custom-panels.md).

> **Finding the docs.** Links here are relative to the randl repository, where this skill lives
> in `.claude/skills/randl-custom-panels/`. If the skill was loaded through a symlink (for example from
> `~/.claude/skills/randl-custom-panels`), a link may not resolve: resolve the symlink to the checkout with
> `readlink -f ~/.claude/skills/randl-custom-panels/SKILL.md`, then read `docs/` at the root of that
> checkout (`git -C "$(dirname "$(readlink -f ~/.claude/skills/randl-custom-panels/SKILL.md)")" rev-parse --show-toplevel`).

The working example in [example/](example/) (`latest-bars`) passes randl's plugin tests. Start
by copying it.

## 1. Copy and rename

From the randl checkout:

```sh
cp -r .claude/skills/randl-custom-panels/example my-panel
```

In `my-panel/panel.json` set:

- `id`: new; 2–64 lowercase letters, digits, hyphens, starting with a letter; not a built-in ID
  (`line`, `bar`, `table`…).
- `name`, `version` (bump on every update), `apiVersion: 1`, `entry: "panel.js"`.
- `renderer: "dom"` for DOM/SVG panels; omit it to get the shared `echarts` in `create`.
- `dataKind`: `scalar` (history, default), `snapshot` (one value per run from config/summary),
  `media`, or `occupancy`.
- `metricSelection`: `single`, `multiple`, `xy`, `axes` or `none`; `metricTypes` if not scalar.
- `settings.common`: host settings to reuse (for example `legend`, `smoothing`, `axes`,
  `expressions`, `outliers`); `settings.options`: your own, each `{key, tab, type, default,
label, …}` with types `boolean`, `integer`, `number`, `select`, `color`, `text`.
- Every option `label`, `help`, `unit` and choice label is a key in `locales/en.json`.

## 2. Write the module

```js
export function create({ element, echarts, apiVersion, onHover, onRange, onCursor, onOpen }) {
  return {
    update({ data, panel, options, colors, dark, locale, translate, localize }) {},
    highlightRuns(ids, local) {}, // optional: linked hover
    showCursor(cursor) {}, // optional: linked X cursor
    exportImage() {}, // optional: PNG data URL for export
    resize() {},
    destroy() {},
  };
}
```

- Scalar data: `data.series = [{id, name, values: {[metric]: [[x, y], …]}, pending?}]`; grouped
  series add `runIds`, `group` and `bands`. Other kinds: see the API reference.
- `panel.metric` / `panel.metrics` are the chosen metrics; `panel.settings` the resolved host
  settings; `options` your options with defaults.
- `colors[runId]` is the run's colour for the current theme; `dark` is the theme.

## 3. Follow the rules

- `data` is shared and read-only: copy before sorting or changing.
- `highlightRuns` restyles only (opacity, class, overlay); never rebuild or redraw there.
- Call `onHover([id])` when the run under the pointer changes and `onHover([])` on leave.
- No timers that redraw: the host sends live data every 2 s at most, only on screen, and not
  while the pointer rests on a chart.
- `destroy` removes listeners, timers, observers, canvases (`chart.dispose()` for ECharts).
- Logged text (run names, metric keys) via `textContent`, never `innerHTML`.
- Colours: `colors` for runs; for chrome, values chosen from `dark`. Carbon variables resolve
  but are not API, so only ever use them with a fallback:
  `var(--cds-text-primary, ${dark ? '#f4f4f4' : '#161616'})`.
- Numbers and dates with `Intl` and `locale`; your messages with `localize(key)`.

## 4. Test

Add the module to the browser lifecycle suite and an install test, as the example does:

- `tests/plugin-browser.mjs`: add `['my-panel', await readFile(…/panel.js, 'utf8')]` to the
  `modules` map and a `check(...)` that switches to it with `mode('my-panel')` and asserts what
  it draws for the fixture run (`Fixture run`, `loss` values 2 then 1).
- `tests/plugin-management.test.mjs`: install the folder with `server.plugins.install(dir)`,
  enable it, `panel_add` with an option, and expect `PLUGIN_OPTION_INVALID` for a bad value.

```sh
npm run build -w backend
node --test tests/plugin-management.test.mjs tests/plugin-options.test.mjs
npm run test:plugins
```

Browser suites need Chromium: `npx playwright install chromium` or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome`.

## 5. Install and enable

The server reads the source path, so give an absolute path on the server's machine (or a public
GitHub repository URL with the manifest at its root):

```sh
randl plugins install --source "$PWD/my-panel"
randl plugins enable --id my-panel
randl tool panel_add --json '{"view": "VIEW_ID", "plugin": "my-panel", "metric": "eval/return"}'
randl plugins update --id my-panel
```

Install errors name the problem: a missing English key (`locales.en does not define …`), an
unknown `settings.common` capability, an entry outside the folder, a symlink. Plugins start
disabled; enabling runs the code in the dashboard with access to all data, so confirm with the
user before enabling on a shared server.

## Checklist

- [ ] `id` unique; `version` bumped; every label key in `locales/en.json`.
- [ ] No mutation of `data`; `highlightRuns` does not redraw; `destroy` cleans up.
- [ ] Both themes checked; text via `textContent`.
- [ ] `node --test tests/plugin-management.test.mjs` and `npm run test:plugins` pass.
- [ ] Installed, enabled, and a panel added and seen in the dashboard.
