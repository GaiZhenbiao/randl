# W&B workflow research

Research notes on the W&B workflows and visual conventions randl reproduces, with the
evidence behind its run colours, area hover and outlier handling. They record why randl
behaves as it does; the [guides](../README.md#guides) describe how it behaves now.
[W&B compatibility](../reference/wandb-compatibility.md) lists what is out of scope.

## Workspace structure

- `W01` Project navigation, run selection, and chart workspace are distinct regions.
- `W02` A run-level Back action preserves project/view context. In randl, the header
  holds the page's title and controls, and the brand returns to the project list.
- `W03` Project navigation and the run selector collapse independently.
- `W04` The run selector expands into a table with the same query. In randl, the
  workspace run list changes chart visibility and solo.
- `W05` Search, filters, grouping, sort order, and columns persist with the view.
- `W06` Run visibility and multiple solos work by click, keyboard, and drag.
- `W07` Workspace run groups support collapse and group-wide visibility/solo actions.
- `W08` Run menus provide backed metadata and lifecycle actions.
- `W09` Clicking the run color opens an anchored picker with a color plane, hue, hex,
  presets, reset, Escape/outside dismissal, and focus restoration.
- `W10` Workspace and section settings remain beside visible charts.
- `W11` Panel editing previews changes before Apply; Cancel restores the saved panel.
- `W12` Undo and redo cover reversible view and layout edits.

## Sections and panel layout

- `W13` Sections can be created, named, collapsed, reordered, and deleted with undo.
- `W14` Panels can be added to sections and moved within or between them.
- `W15` Corner resizing shows a preview without rebuilding charts during the drag.
- `W16` Release snaps the section to equal column widths and a shared panel height.
- `W17` Available width determines a usable column count after sidebar/window changes.
- `W18` Section-bottom resizing changes visible rows independently of card height.
- `W19` Section pagination, keyboard resizing, cancellation, and persistence work.
- `W20` Nested workspace/editor scrollers fit their bounds; check actual scrollWidth
  and scrollLeft, including tooltip and menu overflow.

## Data exploration

- `W21` Searchable metrics/configuration choices and scalar/media panel plugins.
- `W22` Correct custom X alignment, time axes, scales/ranges, smoothing, and originals.
- `W23` Group statistics, spread, run limits, legends, and tooltip preferences.
- `W24` Hover identity is shared between runs and companion plots without data requests.
- `W25` Zoom retrieves suitable data; reset and full-screen preserve selection context.
- `W26` Viewport disposal, cache reuse, changed-point transfer, and automatic updates.
- `W27` Full-history and displayed-sample exports have clear, tested semantics.
- `W28` Automatic/manual panel generation and metric search/hide patterns.

## Other tracking workflows

- `W29` Project listing, overview, settings, creation, archive, and restoration.
- `W30` Run metrics, metadata, tags/notes, config, summary, logs, files, and artifact links.
- `W31` Runs table columns, sorting, grouping, and bulk operations.
- `W32` Deleted-run recovery preserves history, files, and artifact relationships.
- `W33` Stop requests are verified with the real SDK, including resume afterward.
- `W34` Artifact collections, versions, aliases, metadata, files, producers, and consumers.
- `W35` CLI and Pi operate on the same persisted objects and management contracts.

## Run colors

The base palette is verified from cached source maps of W&B production bundle
`8b7b506f0`, originally fetched on 2026-10-15:

- [`colors-eOhTXrtC.js.map`](https://cdn.wandb.ai/production/8b7b506f0/assets/colors-eOhTXrtC.js.map):
  `src/weave/common/util/colors.ts`, `COLORS16` and `ROBIN16`.
- [`colors-TNhUF22_.js.map`](https://cdn.wandb.ai/production/8b7b506f0/assets/colors-TNhUF22_.js.map):
  `src/util/colors.ts`, creation-index/name-hash assignment, view overrides and
  `getTextColor`. The text hex constants are in
  `src/weave/common/css/globals_deprecated.styles.ts` (cached `Icon.js.map`).
- [`ColorPicker-54Pg_9BD.js.map`](https://cdn.wandb.ai/production/8b7b506f0/assets/ColorPicker-54Pg_9BD.js.map):
  `src/components/ColorPicker.tsx`, spectrum-order presets and
  `invertColorsInDarkMode = true`. Setting it false selects a Tailwind wrapper
  with Moon foreground/background tokens instead of the legacy picker styling.

**Correction to the earlier audit:** a color function with no theme argument
only establishes the pre-composited value. It does not establish the displayed
color. W&B's public Weave sources verify a legacy page-level dark-mode filter:

- [`weave-js/src/common/css/globals.less`](https://github.com/wandb/weave/blob/d2d95662595861c398c640a3cf70d83e92ac806f/weave-js/src/common/css/globals.less)
  defines `@nightModeFilter` as
  `invert(100%) hue-rotate(180deg) contrast(80%) brightness(120%)`.
- [`weave-js/src/common/css/Base.less`](https://github.com/wandb/weave/blob/d2d95662595861c398c640a3cf70d83e92ac806f/weave-js/src/common/css/Base.less)
  applies it to `.night-mode`; media and `.night-aware` elements get a reverse
  filter. This is verified at Weave commit
  `d2d95662595861c398c640a3cf70d83e92ac806f` (2025-04-28), not at the production
  bundle's revision.

**Inferred, not a current-production measurement:** the dark hex values below
are calculated from that published filter, applied to the verified base colors
and text colors. The current production CSS, chart ancestors, theme hooks and
Moon tokens could not be fetched in this environment. The cached maps establish
picker inversion but do not prove that every current chart uses the same filter.
No distinct production dark-palette constants were found in those cached maps;
this is not evidence that none exist. Do not describe these pairs as verified
pixel matches to today's W&B UI.

Calculation uses the CSS sRGB hue-rotation matrix. For input byte channels
`r,g,b`, let `L = .213r + .715g + .072b`. For each channel `c`, invert plus a
180-degree rotation gives `clamp(255 + c - 2L, 0, 255)`; contrast and brightness
give `clamp((.8c + 25.5) * 1.2, 0, 255)`, rounded to the nearest byte. These
are opaque swatch values; translucent areas and antialiased edges also depend on
the background. See the [CSS filter definition](https://www.w3.org/TR/filter-effects-1/#FilterFunction).

| Color (assignment order) | Light     | Dark (derived) | Light text | Dark text (derived) |
| ------------------------ | --------- | -------------- | ---------- | ------------------- |
| blue                     | `#538AE5` | `#6499F0`      | `#538AE5`  | `#6499F0`           |
| red                      | `#F0434F` | `#FF8B96`      | `#F0434F`  | `#FF8B96`           |
| kelly green              | `#479A5F` | `#5AAA71`      | `#479A5F`  | `#5AAA71`           |
| purple                   | `#865ED6` | `#BF98FF`      | `#865ED6`  | `#BF98FF`           |
| pink                     | `#F07FDD` | `#CB5EB9`      | `#E077CF`  | `#CF6ABF`           |
| orange                   | `#E57439` | `#EA7E45`      | `#E57439`  | `#EA7E45`           |
| seafoam                  | `#87CEBF` | `#296D5E`      | `#6EB8A8`  | `#3C8374`           |
| magenta                  | `#DC4BDC` | `#FF7CFF`      | `#CC45CC`  | `#FF87FF`           |
| yellow                   | `#FFB83D` | `#9B571F`      | `#F0A118`  | `#B76B1F`           |
| cyan                     | `#5BC5DB` | `#1F7F94`      | `#1FA8D4`  | `#21A4CE`           |
| forest                   | `#229487` | `#48B6A9`      | `#229487`  | `#48B6A9`           |
| peach                    | `#FAB796` | `#8D4D2D`      | `#E09267`  | `#B86D44`           |
| lime                     | `#9BC750` | `#4D771F`      | `#81A83D`  | `#6B912A`           |
| brown                    | `#AD6F50` | `#CF9476`      | `#B87654`  | `#CB8C6B`           |
| maroon                   | `#C2327A` | `#FF9FE4`      | `#C2327A`  | `#FF9FE4`           |
| gray                     | `#A1A9AD` | `#6C7478`      | `#818A8F`  | `#899297`           |

`ROBIN16` takes indexes 11, 2, 7, 12, 0, 4, 8, 13, 5, 10, 9, 3, 6, 14, 1, 15
of `COLORS16`. None of the filter-derived pairs are identical. In this W&B-derived
reference, seven text variants use their corresponding swatch value; randl's
contrast corrections below add three dark text overrides.

### Randl dark contrast corrections

Randl preserves every light swatch and light text value above. Its dark values
start with the W&B-derived colors, then raise OKLCH lightness only where contrast
is below 3:1 for graphics or 4.5:1 for text on the surfaces below:

- Charts, sidebar rows, Runs table cells, and the plot inspector use `#262626`
  (Carbon g100 `--cds-ui-01` / `--cds-layer`). Chart canvases are transparent.
- Hovered/highlighted sidebar rows, table rows, and legend items use `#353535`
  (`--cds-hover-ui` / `--cds-layer-hover`). See `frontend/src/style.css` and the
  installed `carbon-components-svelte/css/all.css`.
- The shared ECharts tooltip uses `#393939` in `frontend/src/plugins/shared.ts`.
  The Runs table uses its own selection checkboxes, without Carbon's selected-row
  classes; checking a row does not introduce the `#4c4c4c` selected-hover surface.

The tables give WCAG relative-luminance contrast ratios for opaque colors,
before → after, in that surface order. Unchanged values appear once. Values are
rounded to two decimals; thresholds are checked before rounding. Translucent
fills and antialiased edges are not covered by these opaque-color ratios.

**Series colors**

| Color       | W&B-derived dark | Randl dark | `#262626`   | `#353535`   | `#393939`   |
| ----------- | ---------------- | ---------- | ----------- | ----------- | ----------- |
| blue        | `#6499f0`        | `#6499f0`  | 5.30        | 4.30        | 4.05        |
| red         | `#ff8b96`        | `#ff8b96`  | 6.76        | 5.48        | 5.16        |
| kelly green | `#5aaa71`        | `#5aaa71`  | 5.35        | 4.34        | 4.08        |
| purple      | `#bf98ff`        | `#bf98ff`  | 6.59        | 5.34        | 5.03        |
| pink        | `#cb5eb9`        | `#cb5eb9`  | 4.21        | 3.41        | 3.21        |
| orange      | `#ea7e45`        | `#ea7e45`  | 5.45        | 4.42        | 4.16        |
| seafoam     | `#296d5e`        | `#4c8f7e`  | 2.48 → 3.99 | 2.01 → 3.23 | 1.89 → 3.05 |
| magenta     | `#ff7cff`        | `#ff7cff`  | 6.90        | 5.60        | 5.27        |
| yellow      | `#9b571f`        | `#b8723c`  | 2.72 → 3.97 | 2.21 → 3.22 | 2.08 → 3.03 |
| cyan        | `#1f7f94`        | `#328ea3`  | 3.26 → 3.99 | 2.64 → 3.23 | 2.49 → 3.04 |
| forest      | `#48b6a9`        | `#48b6a9`  | 6.15        | 4.99        | 4.70        |
| peach       | `#8d4d2d`        | `#ca8463`  | 2.33 → 5.04 | 1.89 → 4.08 | 1.78 → 3.85 |
| lime        | `#4d771f`        | `#638f39`  | 2.86 → 3.98 | 2.32 → 3.22 | 2.19 → 3.04 |
| brown       | `#cf9476`        | `#cf9476`  | 5.87        | 4.76        | 4.48        |
| maroon      | `#ff9fe4`        | `#ff9fe4`  | 8.17        | 6.62        | 6.23        |
| gray        | `#6c7478`        | `#7b8488`  | 3.18 → 3.96 | 2.57 → 3.21 | 2.42 → 3.02 |

**Text colors**

| Color       | W&B-derived dark | Randl dark | `#262626`   | `#353535`   | `#393939`   |
| ----------- | ---------------- | ---------- | ----------- | ----------- | ----------- |
| blue        | `#6499f0`        | `#6da3fa`  | 5.30 → 5.96 | 4.30 → 4.83 | 4.05 → 4.55 |
| red         | `#ff8b96`        | `#ff8b96`  | 6.76        | 5.48        | 5.16        |
| kelly green | `#5aaa71`        | `#62b379`  | 5.35 → 5.94 | 4.34 → 4.82 | 4.08 → 4.53 |
| purple      | `#bf98ff`        | `#bf98ff`  | 6.59        | 5.34        | 5.03        |
| pink        | `#cf6abf`        | `#e47ed3`  | 4.66 → 5.93 | 3.78 → 4.80 | 3.56 → 4.52 |
| orange      | `#ea7e45`        | `#f2854c`  | 5.45 → 5.93 | 4.42 → 4.81 | 4.16 → 4.53 |
| seafoam     | `#3c8374`        | `#68af9f`  | 3.38 → 5.92 | 2.74 → 4.80 | 2.58 → 4.52 |
| magenta     | `#ff87ff`        | `#ff87ff`  | 7.32        | 5.94        | 5.59        |
| yellow      | `#b76b1f`        | `#df904a`  | 3.70 → 5.93 | 3.00 → 4.80 | 2.82 → 4.52 |
| cyan        | `#21a4ce`        | `#32afd9`  | 5.24 → 5.96 | 4.24 → 4.83 | 4.00 → 4.55 |
| forest      | `#48b6a9`        | `#48b6a9`  | 6.15        | 4.99        | 4.70        |
| peach       | `#b86d44`        | `#de8f66`  | 3.83 → 5.93 | 3.10 → 4.81 | 2.92 → 4.52 |
| lime        | `#6b912a`        | `#87af4a`  | 4.11 → 5.95 | 3.33 → 4.83 | 3.14 → 4.54 |
| brown       | `#cb8c6b`        | `#d39472`  | 5.41 → 5.94 | 4.38 → 4.82 | 4.13 → 4.54 |
| maroon      | `#ff9fe4`        | `#ff9fe4`  | 8.17        | 6.62        | 6.23        |
| gray        | `#899297`        | `#9aa4a9`  | 4.77 → 5.95 | 3.87 → 4.82 | 3.64 → 4.54 |

All six changed series colors and eleven changed text colors keep their original
OKLCH hue and chroma before sRGB byte rounding (no gamut clipping was needed).
After rounding, the maximum hue change is 2.94° and the maximum
absolute chroma change is 0.0013. The minimum series contrast is
3.02:1; the minimum text contrast is
4.52:1, both on `#393939`.

Peach receives an additional 0.06 OKLCH lightness after reaching the contrast
target to separate it from yellow. Across all 120 dark-series pairs, the minimum
Euclidean OKLab ΔE is **0.04186** (peach / brown), with OKLab lightness
scaled 0–1 (equivalent to 4.186 on a 0–100 scale). Tests require at least
0.04 separation. This prevents nearly identical swatches; it is not a claim of
colorblind-safe identification. Existing run labels and selection indicators
remain necessary.

Blue, kelly green, and orange now have separate dark text overrides instead of
reusing their series colors. Custom hex colors still remain exactly as entered.
Unit tests cover all 16 graphics and resolved text colors against all three
surfaces, and browser tests cover theme changes, legends, inspectors, and PNGs.

An ungrouped W&B run without a custom color uses
`ROBIN16[defaultColorIndex % 16]`. Runs without a creation index, and grouped
series, hash a key with `(h << 10) - h + charCode` over 32-bit integers and use
`ROBIN16[abs(h) % 16]`; duplicate colors are allowed. The picker orders presets
red, orange, peach, yellow, lime, kelly green, forest, seafoam, cyan, blue, purple,
pink, magenta, maroon, brown, gray. W&B also offers two colorblind-safe palettes
and semantic legend colors; randl does not implement these options.

Randl resolves the pairs with its current theme for run dots, Runs table,
series (including group and stacked-component colors), legends, inspectors,
picker previews and PNG exports. Theme changes reuse cached chart data. Saved
`view.body.runColors` values stay canonical light-palette hex values or custom
hex values: selecting a preset stores its light value even in dark mode. Unlike
a whole-page filter, randl deliberately leaves custom hex values unchanged.

Inferred from a read-only query of 398 runs in one W&B project: the server sets
`defaultColorIndex` from a per-project counter at creation. Indexes were 0–15 and
advanced by one in creation order for 370 of 397 consecutive pairs; the others
were swaps between runs created in the same second or gaps where runs had been
deleted. Randl stores `color_index` when the server creates a run, using the
next index after the project's highest, including deleted runs. Existing
databases are numbered once in creation order. Randl hashes a grouped series by
its group value; W&B also includes the run set ID, so group colors differ from
W&B's.

## Reference evidence

The public [W&B example workspace](https://wandb.ai/example-team/sweep-demo) was
inspected with mutation requests blocked. A measured corner drag changed three
343×300 px cards into two 523×380 px columns across the section. Its bottom handle
changed visible rows while preserving card height. Randl uses one
continuous run list; section panel pagination is independent of run pagination.

- [Projects, workspace, and runs](https://docs.coreweave.com/products/wandb/track/project-page)
- [Workspace, section, and panel settings](https://docs.coreweave.com/products/wandb/app/features/cascade-settings)
- [Run colors](https://docs.coreweave.com/products/wandb/runs/run-colors)

## Area colors and contrast

Source audit on 2026-10-15, production revision `8b7b506f0`:

- The [W&B line plot reference](https://docs.wandb.ai/guides/app/features/panels/line-plot/reference)
  documents run-controlled line colors, area and percentage-area styles, and
  percentage values in stacked-area legends. It does not specify fill opacity.
- [`PanelEditor-TnHIk0yL.js.map`](https://cdn.wandb.ai/production/8b7b506f0/assets/PanelEditor-TnHIk0yL.js.map),
  `componentOutliers/convertLines.ts`, selects either `runColor` (run/group identity
  and overrides) or `color(metricIndex, lineOpacity)` when
  `colorEachMetricDifferently` is enabled. `useLines.ts` sends both stacked and
  percentage styles through `convertLinesToArea`; percentage normalization follows.
- [`colors-TNhUF22_.js.map`](https://cdn.wandb.ai/production/8b7b506f0/assets/colors-TNhUF22_.js.map),
  `src/util/colors.ts`, establishes an important distinction: default run colors
  use `ROBIN16`, while the legacy metric-index `color()` uses `COLORS10`.
  Randl deliberately uses the requested W&B **16 run colors** for components too;
  this is not an exact reproduction of W&B's optional metric-color palette.
- In the PanelEditor map, `componentOutliers/buildLines.ts` computes an input alpha
  of 0.375 for fewer than two estimated lines, 0.3 for two or three, 0.25 for four
  or five, and 0.2 for six or more (estimated runs × metrics).
  `uPlot/drawStackedAreas.ts` fills each stacked polygon with `Color(line.color)`;
  it adds no opacity constant or stroke. `uPlot/getUPlotOptions.ts` explicitly
  suppresses native strokes and points for these polygons. Thus there is no
  universal 0.6 stacked-fill constant in this renderer.
  **Inference:** those input alphas describe the final fill only if intermediate
  line transformations preserve them; the area conversion implementation was not
  recovered in this audit. No current-production pixel opacity was measured.
- Spread is separate: `uPlot/getBands.ts` fills with the auxiliary line's color,
  and `getUPlotOptions.ts` draws both band edges. The older react-vis path in
  `LinePlotPlot.tsx` uses `lineUtils.ts`: ordinary area borders are transparent;
  highlight uses alpha 0.3 and a dark border. These are distinct renderer paths,
  not evidence that every W&B chart draws the same borders. Dark-mode display
  remains subject to the [theme evidence limitations](#run-colors) above.

### Area hover

Source inspection on 2026-10-20 of the published
[`PanelEditor-TnHIk0yL.js.map`](https://cdn.wandb.ai/production/8b7b506f0/assets/PanelEditor-TnHIk0yL.js.map)
(revision `8b7b506f0`) found that `LinePlot.tsx` reads `run:name` from its shared
highlight source and sets the base layer's dim factor to 0.3 while a run is
active. `uPlot/drawStackedAreas.ts` supports a separate overlay drawing only the
highlighted run's polygons above that base. There is no single-metric exception
in these paths. This is source evidence of supported behavior, not a measurement
of a logged-in production workspace; caller settings can affect highlighting.

In Randl's single-metric Area, Stacked area and Percent area panels, each band
represents a run or group. External hover emphasizes that run's band (or the band
of the group containing it) and dims other bands with the same ECharts
emphasis/blur treatment as line charts. This follows W&B's supported distinction
between the highlighted run and a dimmed base, without claiming identical opacity.

Multi-metric component areas deliberately remain visually stable on external
hover: all components retain their fill and stroke opacity, including while a
Focused run composition loads or switches runs. Linked cursors, values and dots
continue to identify the run. Hover or keyboard inspection inside any area panel
still emphasizes its selected band.

### Randl rendering

All per-run areas retain the run's resolved palette/custom color; grouped areas
use their group's color. Stacked plain and computed components use `ROBIN16` in
metric order, identically across runs and themes. This round-robin order already
separates dark peach and brown with lime; it is retained rather than sorting by
hue or changing order with the theme. All sixteen colors are retained, including
wraparound. Custom colors remain the user's exact choices.

Stacked and percent fills use 0.85 opacity (previously 0.6 for components and
0.65 for runs). Ordinary areas use 0.3 in light mode and 0.4 in dark mode
(previously 0.13). Spread uses 0.22 / 0.32 (previously 0.18), and a grouped area
with spread fills the interval instead of also filling its mean to zero.
The existing colored series lines remain; no separators or additional band
borders are added. Spread edges remain unstroked. The stronger fill preserves
palette hues, chroma and run identity without introducing another color mapping.
Legend markers, inspector dots and popup rows use the same resolved series color.
PNG export composites the current fills over the current chart surface. Theme
changes rebuild options from cached data without chart requests.

The following measurements use all sixteen palette colors, sRGB alpha blending
with byte rounding over white (`#ffffff`) or Carbon g100 (`#262626`), then WCAG
relative luminance. They describe isolated, unhighlighted fills, not intersections
of overlapping runs, antialiased edges, custom colors or bands dimmed during hover.

| Fill              | Light opacity | Light fill/background | Dark opacity | Dark fill/background |
| ----------------- | ------------- | --------------------- | ------------ | -------------------- |
| Stacked / percent | 0.85          | 1.57–4.11:1           | 0.85         | 3.25–6.30:1          |
| Ordinary area     | 0.30          | 1.17–1.58:1           | 0.40         | 1.70–2.48:1          |
| Group spread      | 0.22          | 1.12–1.39:1           | 0.32         | 1.52–2.07:1          |

For comparison, component stacks at 0.6 were 1.37–2.66:1 in light mode and
2.29–3.89:1 in dark mode. Ordinary areas at 0.13 were 1.07–1.21:1 / 1.17–1.32:1;
spread at 0.18 was 1.10–1.31:1 / 1.25–1.48:1.

Adjacent component fills in palette order, including wraparound, measure **1.13–2.00:1**
in light mode and **1.005–1.93:1** in dark mode. Similar luminance does not imply
identical color: the minimum adjacent OKLab distance is **0.14217** light and
**0.10482** dark (0–1 lightness scale), compared with 0.09915 / 0.07709 at opacity
0.6. Tests require at least 0.1 for blended neighboring component colors.
The light palette includes pale swatches; these fills do **not** all meet 3:1,
and translucent supporting spread/area shading is intentionally lighter than its
primary series line. These measurements do not establish WCAG conformance or
colorblind-safe identification; the legend and hover values provide identities.

## Excluding outliers

Source inspection on 2026-10-22 of the published
[`PanelEditor-TnHIk0yL.js.map`](https://cdn.wandb.ai/production/8b7b506f0/assets/PanelEditor-TnHIk0yL.js.map)
(revision `8b7b506f0`):

- `WorkspaceDrawer/Settings/runLinePlots/LinePlotConfigExcludeOutliers.tsx` is a
  switch labeled **Outliers**, "Exclude extreme outliers when scaling charts". It
  appears in the panel editor's data tab and in workspace settings, stored as
  `excludeOutliers: 'exclude-outliers' | 'include-outliers'` (replacing the older
  `ignoreOutliers`). It is disabled in the full-fidelity "Line" point mode.
- `vis/useCalculatedDomain.ts` takes the 5th percentile (`d3.quantile`) of each
  point's lower value and the 95th of its upper value over points inside the user X
  range, then uses the lowest value at or above the first and the highest at or below
  the second. A user Y bound replaces its automatic bound.
- `vis/LinePlot.tsx` and `vis/clampPoint.ts` leave points beyond that domain in place
  (clamped only ±100000 beyond it to keep rendering stable), so lines leave the plot
  edge; the crosshair uses unclamped values.
- `lineFilters/filterUnusedLines.ts` (`isExcludingOutliers`) hides every area line,
  including spread bands, while outliers are excluded.

Randl stores a boolean `excludeOutliers`, offers it beside the Y range for every chart
with a value axis except parallel coordinates, and computes the same percentiles over
the plotted traces (or the stack totals, band boundaries, bar values or bin counts), snapping each
bound outward to a plotted value and then to a round number for legible axis ends.
It deliberately keeps spread bands visible (they are clipped and do not set the
range), because a band the user chose should not disappear. It offers no filter that
removes values: that would change smoothing, grouping and hover values, and W&B has
no such option. Unlike W&B, whose percentiles are fixed at 5 and 95, the lower and upper
percentiles are adjustable (`outlierLower`, `outlierUpper`).
