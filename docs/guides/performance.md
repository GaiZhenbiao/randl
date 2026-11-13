# Performance

Randl stays responsive by loading only panels on or near the screen, sending each chart
only as many points as its width can show, caching responses in the browser and on the
server, and batching live updates. Most of this needs no setup. For the decisions and
measurements behind it, see the [performance history](../history/performance.md).

## Settings you can change

| Setting                 | Where                                                | Effect                                              |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Resolution              | Plot settings of the workspace, a section or a panel | Points per CSS pixel and the point limit per panel  |
| Runs shown              | The same plot settings                               | All runs, up to a maximum, or one focused run       |
| Grouping                | The same plot settings                               | Aggregates many runs into a few lines on the server |
| Visible and soloed runs | Runs sidebar                                         | Which runs every panel compares                     |

A panel uses its own plot setting, then its section's, then the workspace's. Cache
sizes, the live update interval and request concurrency are fixed in the code; no
environment variable changes them. See the [configuration reference](../reference/configuration.md)
for server options and the [panel API](../reference/panel-api.md) for plugin settings.

## Chart resolution

A line chart divides the panel's shared X range into buckets, counted from the plot's
width in CSS pixels rounded up to a power of two (16 to 16,384), so resizing within a
step reuses loaded points. Device pixel ratio does not change the request.

| Level           | Buckets per CSS pixel | Point limit per panel |
| --------------- | --------------------: | --------------------: |
| Low             |                   0.5 |                25,000 |
| Medium          |                     1 |                50,000 |
| High (default)  |                     2 |               100,000 |
| No downsampling |           every point |               500,000 |

The point limit counts every series in the panel. When a panel's runs and metrics would
exceed it, the server doubles the bucket width until they fit. A panel at No
downsampling that reaches its limit shows the points drawn and the total.

Each bucket keeps its first minimum and first maximum, and each series keeps its first
and last point, so a single spike survives at every level. The server also sends each
bucket's mean, which the browser uses for smoothing. Bucket widths are powers of two
aligned to X = 0, so a finer level contains every point of a coarser one and a growing
run changes only its last buckets.

## Loading, zoom and full screen

Panels start loading within half a screen of the viewport, so a short scroll finds them
drawn. A section with pages keeps the neighbouring pages mounted but hidden. The browser
runs at most four chart requests at a time and shares identical pending requests. A
request already sent for a panel that scrolls away finishes into the cache; a queued one
is dropped. Large responses stream in chunks of 4, 8, 16, 32 and then 64 runs, drawn at
most every 200 ms; runs not yet received keep their legend entry.

A stored response at least as detailed as a new request (a smaller panel, a lower level
or a narrower X range) serves it without a request. Otherwise the closest stored
response stays drawn while the server sends only the points it lacks. Zooming in,
enlarging a panel or opening it full screen fetches only missing points; returning to
the previous size fetches nothing.

## Live updates

A running run changes its revision with every row it logs. Panels batch those changes:

- New points apply on a shared 2-second tick, so the charts on screen redraw together.
- Only panels actually on screen take live updates. A panel scrolled into view catches
  up at once.
- While you hover, updates wait for the first tick at least 1 second after the hovered
  run or cursor last changed.
- A live update draws once, when all its points have arrived.

Any other change, such as a setting or a different run selection, applies at once.

## Hovering

Hovering a run in the sidebar, or moving over a chart, highlights that run in every
on-screen chart. Plain line charts draw it as an SVG overlay: a veil over the plot and
the run's lines on top, reduced to the first, lowest, highest and last point per pixel
column. The chart canvas is not redrawn. Area and stacked charts use ECharts' emphasis,
which redraws the canvas, so linked charts of those types wait until the hovered run has
stayed the same for 120 ms. Highlighting never changes line widths: the other runs dim.

Panels that show only the hovered run (**Runs shown → Focused run**) have to redraw for each
run. They take a hover at once when the pointer has been still, but during a sweep across
many runs they wait until it rests for 150 ms and then redraw once, for the run it stopped on.
The highlight in every other chart and in the run list follows the pointer meanwhile, and a
change of the hovered run never queues work: each chart draws only the latest one, at most
once a frame. Leaving one run row for the next does not pass through an empty hover.

## Runs per panel

A panel plots every visible or soloed run, up to 1,000 per ungrouped chart. Above that
it says so and sends no request until you hide runs or set **Runs shown** to a maximum.
Pinned runs are always included and do not count against the maximum. On a grouped
panel the maximum limits groups; grouped charts aggregate every selected run on the
server. **Focused run** loads one run at a time, the one you hover. In saved views and
the panel API this is the `maxRuns` setting: a number from 1 to 1,000, `focused`, or
unset for all runs.

## Browser memory

| Cache                                    | Budget                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| Chart and media responses                | 64 MiB, least recently used first out                                             |
| Decoded chart responses                  | 64 entries within about 16 MiB                                                    |
| Renderers of panels outside the viewport | 12 panels within 32–96 MiB (12 MiB per GiB of device memory; 48 MiB when unknown) |
| Editor metric catalogs                   | 8 run sets                                                                        |

A panel returning to view draws its stored response and requests an update only if one
of its runs changed. Older hidden renderers are rebuilt from stored responses, one panel
per animation frame. Canvases render at the device pixel ratio, capped at 2.

## Many runs and long histories

- Hide runs you are not comparing: every panel compares the visible set.
- Group hundreds or thousands of runs. A grouped panel registers its run list once and
  requests a few aggregate lines.
- Set **Runs shown** to a maximum, or to **Focused run**, where every run is not needed.
- Keep Resolution at High. Use No downsampling on single panels that need every point,
  and Medium or Low on dashboards of many wide panels.
- Split large workspaces into sections with pages; only nearby pages are mounted.

## Storage and server costs

History is stored in zlib-compressed immutable blocks of 1,024 points or 256 raw lines,
with small tails for the newest rows. Values keep full Float64 precision. Block indexes
hold ranges, counts, extremes and latest values, so a chart reads only blocks in its X
range. Sealing tails and reclaiming space run in short idle maintenance steps.

One database worker owns the SQLite connection. Computed metrics, stacked areas, grouped
charts and snapshots run as jobs in 20 ms slices that yield every 4,096 records, so SDK
writes and other panels are served in between; a job stops when its request is
abandoned. The server keeps 16 MiB of chart responses and 64 MiB of per-run derived
series. An unchanged chart returns a revision token, and a changed one a point diff when
that is smaller. Text responses of 1 KiB or more are compressed with Brotli or gzip.
Recording request metrics was measured at about 0.3 µs per request. See
the [architecture notes](../contributing/architecture.md) for the full request flow.

## Performance budgets

Each suite creates its own temporary database, except `test:resources`, which runs
against a separate seeded server ([testing](../contributing/testing.md)).

| What is measured                                                                                              | Budget                                                      | Script                       |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| Name search over 10,000 runs, median of three                                                                 | under 1,000 ms; at most 40 rows mounted                     | `npm run test:run-query`     |
| Restoring the run list with 1,000 stored visible or soloed runs, median of three                              | under 500 ms                                                | `npm run test:run-selection` |
| Add panel, Edit panel, Workspace settings, Group popover (1,100 runs, catalog delayed 1.5 s): time to visible | under 250 ms                                                | `npm run test:open-latency`  |
| Panel editor ready with a cached catalog                                                                      | under 250 ms                                                | `npm run test:open-latency`  |
| Warm scroll through 25 panels and back                                                                        | 0 chart or media requests; at most 50 ms of long tasks      | `npm run test:scroll-cache`  |
| Live append                                                                                                   | only visible charts refresh; off-screen ones once on return | `npm run test:scroll-cache`  |
| Live delta                                                                                                    | under 1,500 bytes per panel                                 | `npm run test:resolution`    |
| Points at High                                                                                                | two per bucket plus endpoints, equal at DPR 1 and 2         | `npm run test:resolution`    |
| Chart requests in flight                                                                                      | at most 4                                                   | `npm run test:resources`     |
| Hidden renderers; canvas backing                                                                              | at most 12 beyond those showing; at most 1.25 × plot area   | `npm run test:resources`     |
| Server chart cache                                                                                            | at most 16 MiB                                              | `npm run test:resources`     |
| Heap growth over repeated page cycles (`RANDL_RESOURCE_CYCLES`, default 6)                                    | at most 4 MiB                                               | `npm run test:resources`     |
| Grid of up to 1,000 cells, one scroll cycle                                                                   | at most 36 cells mounted; heap within 10 MiB                | `npm run test:resources`     |
| Hover, 45 of 600 runs in 12 line panels at DPR 2: main-thread work per step                                   | 25 ms (run list), 55 ms (chart move)                        | `npm run test:hover-latency` |
| The same with GPU compositing: median time to the second frame                                                | 150 ms (run list), 300 ms (chart move)                      | `npm run test:hover-latency` |
| The same workspace's JavaScript heap                                                                          | at most 60 MB                                               | `npm run test:hover-latency` |
| Three runs streaming 83 metrics every 3 s: redraws per chart in 15 s                                          | at most 8, none during a hover                              | `npm run test:hover-latency` |
| The same: idle main-thread share; hover p90 to the second frame; work per step                                | 12%; 100 ms; 35 ms                                          | `npm run test:hover-latency` |
