# Performance history

A record of performance decisions that still shape randl, with the measurements that
justified them. Dates are when the change landed. Unless stated, measurements come from
headless Chromium on a shared development machine with a loopback server; they show the
size of an effect, not a guarantee on other hardware. For current behaviour and
settings, see the [performance guide](../guides/performance.md).

## Run search and stored selections — 2026-10-14

**Problem.** In a project of 10,000 runs with a filter matching about 5,000, each name
search scanned the matching IDs once per run. Restoring the run list scanned the stored
visibility or solo list the same way.

**Decision.** Membership tests use a `Set`; the run list keeps its order.

**Numbers.** Median name search fell from 3,998 ms to 39 ms. Restoring the list with
1,000 stored visible or soloed runs fell from 565–1,148 ms to 68–85 ms.

## Dialog open latency — 2026-10-14

**Problem.** On an imported project of about 390 runs and 910 metrics, the panel editor
took 3.5 s to open. It waited 2.4 s for the metric catalog, whose query probed the point
table for each of about 93,000 run–metric pairs, then spent 1.1 s grouping fields in a
loop that grew with the square of the field count.

**Decision.** Only run–metric pairs that also have media are probed, since a metric
without media is scalar. Grouping choices are built in one pass. Editors and settings
drawers open at once and show "Loading metrics…" until the catalog arrives. The browser
caches catalogs for eight run sets and requests them in groups of 1,000 runs, so metrics
of later runs are no longer missing.

**Numbers.** The catalog fell from 2.4 s to 0.3 s. Add panel became visible in 37–45 ms
instead of 3.4 s, and the Group popover in 14 ms instead of 522 ms.

## Every compared run in every panel — 2026-10-14

**Decision.** Panels plot every visible or soloed run unless a run limit is set; before,
they showed at most ten runs plus pinned runs by default. Going from 11 to 53 runs per panel on a 43-panel view raised the first
viewport from about 740 ms to 805 ms, the largest response from 123 KB to 546 KB and the
heap from 19 MB to 27 MB, an accepted cost for showing the whole comparison.

## Scrolling and caching — 2026-10-14

**Problem.** Scrolling a 120-panel workspace down and back requested every chart again.
The 8 MiB response cache counted characters as two bytes, and one panel of about 390
runs took 440 KB, so 31 mounted panels evicted one another.

**Decision.** The response store holds 64 MiB at one byte per JSON character. A panel
returning to view draws its stored response and asks for a delta only if a run changed.
Requests already sent for a panel that leaves view finish into the cache. Up to twelve
hidden panels keep their renderer. Media preview URLs carry a content digest.

**Numbers.** A second scroll cycle went from 28 requests and 5.1 MB to none. Keeping no
hidden renderers cost 1,505 ms of long tasks on a nearby scroll at 75 MiB of heap;
keeping twelve cost 164 ms at 132 MiB; keeping all 31 cost nothing at 195 MiB, but that
grows with section paging. Twelve was chosen.

## Chart resolution defaults — 2026-10-15

**Problem.** Every series was cut to 600 points or 20,000 divided by runs × metrics,
whichever was smaller: 51 points per run in a 387-run panel at any size. The bucket
grid followed each series' own range, so every appended step moved every bucket.

**Decision.** A Resolution setting (Low, Medium, High, No downsampling) sets buckets per
pixel of plot width, with point limits per panel of 25,000, 50,000, 100,000 and 500,000.
Each bucket keeps its first minimum and maximum. Bucket widths are powers of two aligned
to X = 0, so a finer level contains every point of a coarser one: resizing, raising the
level or zooming fetches only missing points, and an append changes only the last
buckets. Responses stream in growing chunks of runs.

**Choosing High.** Noisy 20,000-step runs were drawn at each level and compared pixel by
pixel with no downsampling, at device pixel ratio 1 and the budgets of the time. For one
run, 14.1% of line pixels differed at Low, 7.0% at Medium and 3.4% at High; for ten runs,
3.0%, 1.6% and 0.6%. Also keeping each bucket's first and last point was worse at an
equal point count (4.7%). High became the default.

**Live deltas.** For 20 runs × 20,000 steps, one appended row produced a 375-byte delta
instead of 5,390 bytes. During 30 s of live logging, transferred bytes fell from 3.95 MB
to 147 KB and heap growth from 36 MiB to 1.6 MiB. These figures predate the 2-second
live tick of 2026-11-13.

**CSS pixels (2026-10-21).** Budgets first counted device pixels, so a high-density
display requested twice the points. They now use CSS plot width; canvases still render
at device resolution. At device pixel ratio 2 on a 47-panel view, chart transfer fell
14% and first-viewport chart bodies 40%, with no measurable change in interaction time.

## Browser memory — 2026-10-20

**Problem.** On a 43-panel view of about 60 runs at device pixel ratio 2, the renderer
process held 845 MiB and the post-GC heap 155 MiB. Every series' points were copied
into ECharts options and models.

**Decision.** Point arrays are shared with ECharts instead of cloned, using a zrender
marker for immutable arrays. Inspector values stay outside chart options, and disposal
releases canvas backing stores. The hidden-renderer budget estimates canvas, point and
per-trace cost, at 12 MiB per GiB of device memory within 32–96 MiB. Linked hover work
is spread across frames. Typed-array series were rejected because stacked series passed
tooltips a different value shape than pair data.

**Numbers.** Renderer RSS fell from 845 to 538 MiB, the post-GC heap from 155 to 73 MiB
and hover from 110 ms to 21 ms. Heap growth over five minutes of live logging stayed
under 2 MiB. The 55 MiB heap target was not met and remains a target.

## Warm scroll frame scheduling — 2026-10-21

**Problem.** Scrolling back occasionally produced a 54 ms task: four panels rebuilt
evicted charts in one animation frame, followed by a 16 ms commit.

**Decision.** The shared panel host admits one data update per animation frame; hiding
a panel cancels its queued work.

**Numbers.** The largest warm task fell from 54 ms to 24 ms, five consecutive test runs
recorded no long tasks, and first-chart time did not regress.

## Storage format 2 — 2026-10-21

**Problem.** Format 1 stored a row per point and per history line, about 19 KB per
record on a real import; a full import of one large project was projected at 65 GB.

**Decision.** History moved to zlib-compressed immutable blocks of 1,024 points or 256
raw lines, keeping Float64 values and exact text, with covering indexes for ranges,
counts and extremes. Pages stay 4,096 bytes with rowid tables: WITHOUT ROWID tables were
larger at every page size, and 8,192-byte pages saved only 0.17%. Transposing Float64 bytes saved 19% of point payload but
tripled encode time, so it was dropped. A helper worker checkpoints the WAL from
alternating read snapshots, so the writer does not stall on checkpoints.

**Numbers.** A synthetic fixture of about 37,000 histories fell from 826 MB to 49 MB,
and a 2.2 GB synthetic database converted to 144 MB. Point blocks with their index cost
2.9 bytes per point. Every chart-query and ingest gate passed; ingest stayed at about
1,300 records/s, within 1% of format 1. A 30-minute soak of four SDK processes kept the
worker's longest call at 44 ms.

## Grouped charts — 2026-10-23

**Problem.** Groups averaged only values at exactly the same X, so on wall-time axes
every point described one run. Large groups hit input and X-value limits, and above
1,000 runs a grouped panel showed the request limit.

**Decision.** Each run is reduced to means on shared, aligned X buckets, and the group
aggregates the runs present in each bucket. Grouped panels register their run list once
and name it by a token in each request.

**Numbers.** For 453 runs on relative wall time, points describing a single run fell
from 100% to 27%. Cold grouped charts over 453 runs took 187–916 ms, where several had
been refused; cached ones 9–30 ms. Database heap growth per grouped request fell from
33–280 MiB to 1–16 MiB. At 100,000 runs, inline IDs would add 2.9 MiB to every request.

## Sliced chart jobs — 2026-10-23

**Problem.** An ungrouped computed chart over many long runs held the single database
worker for over a second, delaying SDK writes as long.

**Decision.** Computed metrics, stacked compositions, grouped charts and snapshots run
as worker jobs in 20 ms slices that yield between runs and every 4,096 records, and stop
when their request is abandoned.

**Numbers.** With an SDK run logging every 5 ms, the longest worker hold fell from
1,088–1,255 ms to 43–76 ms and the worst ingest delay from 1,251 ms to 97 ms.

## Media grids and video posters — 2026-10-23

**Decision.** Grid layouts mount only cells near the viewport (at most 36). Video tiles
show a server-made first-frame poster when `ffmpeg` is available and take their shape
from the file header (2026-10-26).

**Numbers.** Scrolling a 1,000-cell grid mounted at most 28 cells with no task over
50 ms. A server poster costs 32–78 KB and no video bytes; the browser fallback reads
about 1 MB of each video.

## Transfer and compression — 2026-11-08

**Problem.** Opening and scrolling a 555-run workspace transferred 4.2 MB of
uncompressed API responses; an idle half minute moved 367 kB of unchanged media lists.

**Decision.** Text responses of 1 KiB or more use Brotli (quality 4) or gzip, including
streamed charts. Media responses carry a content-hash revision and return
`{ unchanged }`. Run-field paths are kept per run revision.

**Numbers.** The run list fell from 500 kB to 48 kB and a chart response from 51 kB to
6 kB. Run fields went from 254–291 ms per request to 10–20 ms after the first.

## Unlimited chart transforms — 2026-11-10

**Problem.** Stacked and percent areas over runs that resumed and logged earlier steps
again parsed every stored record as JSON and were refused above 128 MiB of history.

**Decision.** History transforms read the point store, joined on step; a step logged
again keeps its latest values. The record, byte, per-run input and per-request value
limits were removed, since chart jobs already run in slices. Cached computed series keep
typed columns at 8 bytes per value.

**Numbers.** A percent area over 36 such runs went from refused to 347 ms (2 ms cached);
over 560 runs it took 5.5 s. The process stayed under 241 MiB resident.

## Hover and live streaming — 2026-11-13

**Problem.** On a workspace of about 45 shown runs and 50 panels at device pixel ratio
2, each change of the hovered run redrew every chart canvas through ECharts' emphasis;
with GPU compositing a run-list hover took 385 ms to its second frame. Live runs also
redrew every chart showing them on each streamed row: with three runs logging 83 metrics
every 3 s, 16% of the idle main thread went to redraws, and a hover during an update
took up to 887 ms (p90).

**Decision.** Plain line charts draw the hovered run as an SVG overlay over the
unchanged canvas; areas and stacks keep ECharts' emphasis, delayed 120 ms in linked
charts. Only on-screen panels follow linked hover. Live points apply on a shared 2 s
tick, only on screen, not within 1 s of a hover change, and draw once when complete.

**Numbers.** Median run-list hover fell from 385 ms to 45 ms and chart moves from 158 ms
to 47 ms; main-thread work per step fell from about 73 ms to 25 ms. While streaming, the
idle main-thread share fell from 16% to 7.5% and hover p90 from 887 ms to 69 ms. These
became budgets in `npm run test:hover-latency`.
