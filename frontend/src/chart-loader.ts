import {
  api,
  ApiError,
  cached,
  forget,
  onForget,
  peek,
  remember,
  scheduled,
  streamed,
  type CacheEntry,
} from './api';
import { applyChartDiff, applySeriesChange } from './chart-data';
import { bucketWidth, clipChart } from '../../backend/src/chart-diff';
import { selectionToken } from '../../backend/src/chart-selection';
import panelLimits from '../../backend/src/panel-limits.json';
import type { ChartData } from './types';
type Entry = {
  controller: AbortController;
  users: number;
  started: boolean;
  promise: Promise<ChartData>;
  listeners: Set<(data: ChartData) => void>;
};
// Partial charts are passed on at most this often while a response streams in.
const progressInterval = 200;
// What a stored history response holds: its X range, resolution and bucket width.
type Detail = {
  family: string;
  level: string;
  xMin?: number;
  xMax?: number;
  bucketWidth: number | null;
  xRange: [number, number] | null;
  limited: boolean;
};
const inflight = new Map<string, Entry>();
// Grouped panels name their run selection by a token (see chart-selection). Panels sharing a
// run list share its token, computed once per list; the IDs are registered with the server
// on first use and again if it has forgotten them.
const selectionMemo = new WeakMap<
    readonly object[],
    { token: string; versions: string; ids: string[] }
  >(),
  selectionRuns = new Map<string, string[]>(),
  registered = new Map<string, Promise<unknown>>();
export function chartSelection(runs: readonly { id: string; revision?: number }[]) {
  let hit = selectionMemo.get(runs);
  if (!hit) {
    const ids = runs.map((run) => run.id);
    hit = {
      token: selectionToken(ids),
      versions: selectionToken(runs.map((run) => run.id + ':' + (run.revision ?? ''))),
      ids,
    };
    selectionMemo.set(runs, hit);
  }
  selectionRuns.delete(hit.token);
  selectionRuns.set(hit.token, hit.ids);
  while (selectionRuns.size > 32) selectionRuns.delete(selectionRuns.keys().next().value!);
  return hit;
}
function register(token: string, again = false) {
  if (again) registered.delete(token);
  let pending = registered.get(token);
  if (!pending) {
    const runs = selectionRuns.get(token);
    if (!runs) return Promise.reject(new ApiError('Chart selection unavailable', 409));
    pending = api('/api/chart-selections', { runs });
    pending.catch(() => registered.delete(token));
    registered.set(token, pending);
    while (registered.size > 32) registered.delete(registered.keys().next().value!);
  }
  return pending;
}
let serial = 0;
/** Release a consumer while allowing a started request to finish into the cache. */
export const finishInCache = 'finish-in-cache';
const finite = (value: unknown): value is number => Number.isFinite(value);
const levelOf = (request: any): string =>
  request.settings?.resolution ?? panelLimits.resolution.default;
// Requests that differ only in plot width, resolution or X range share a family: any
// member can serve as the diff base for another, and a finer one can stand in for it.
function familyOf(endpoint: string, request: any) {
  if (endpoint !== '/api/chart' || request.mode === 'snapshot') return;
  // Computed metrics join families when they are planned like plain metrics (not stacked or
  // grouped); other transforms are sampled per request and cannot stand in for each other.
  const transform = request.recordTransform,
    grouped = request.settings?.groupBy && request.settings.groupBy !== 'none';
  if (transform && !(transform.kind === 'compute' && !transform.align && !grouped)) return;
  const { pixels: _, settings = {}, ...rest } = request,
    { resolution: __, xMin: ___, xMax: ____, ...kept } = settings;
  return JSON.stringify([endpoint, { ...rest, settings: kept }]);
}
const families = new Map<string, Set<string>>();
// Pair-data fallback: charge measured pair-tree cost, not just numeric payload.
export function chartBytes(data: ChartData | null) {
  if (!data) return 0;
  let bytes = 0;
  for (const series of data.series) {
    bytes += 256;
    for (const points of Object.values(series.values)) bytes += 64 + points.length * 48;
    for (const band of Object.values(series.bands || {})) bytes += 64 + band.length * 56;
  }
  return bytes;
}
const decodedCache = new Map<string, { entry: CacheEntry; data: ChartData; bytes: number }>();
let decodedBytes = 0;
function forgetDecoded(id: string) {
  const old = decodedCache.get(id);
  if (old) decodedBytes -= old.bytes;
  decodedCache.delete(id);
}
function decoded(id: string, entry: CacheEntry, data?: ChartData): ChartData {
  const hit = decodedCache.get(id);
  if (hit?.entry === entry) {
    decodedCache.delete(id);
    decodedCache.set(id, hit);
    return hit.data;
  }
  forgetDecoded(id);
  const result = data || read(entry);
  // Media descriptors can be arbitrarily large: retain them only in the JSON store.
  if (result.entries) return result;
  const bytes = chartBytes(result) + entry.json.length * 2;
  if (bytes <= 16 * 1024 * 1024) {
    decodedCache.set(id, { entry, data: result, bytes });
    decodedBytes += bytes;
    while (decodedCache.size > 64 || decodedBytes > 16 * 1024 * 1024)
      forgetDecoded(decodedCache.keys().next().value!);
  }
  return result;
}
onForget((id, entry) => {
  forgetDecoded(id);
  const family = families.get(entry.meta?.family);
  family?.delete(id);
  if (family && !family.size) families.delete(entry.meta.family);
});
// Members are removed as the response store forgets them.
const members = (family: string) =>
  [...(families.get(family) || [])].map((id) => {
    const entry = peek(id)!;
    return { id, entry, detail: entry.meta as Detail };
  });
function covers(detail: Detail, request: any) {
  const lo = request.settings?.xMin,
    hi = request.settings?.xMax;
  return (
    (!finite(detail.xMin) || (finite(lo) && lo >= detail.xMin)) &&
    (!finite(detail.xMax) || (finite(hi) && hi <= detail.xMax))
  );
}
const sameRange = (detail: Detail, request: any) =>
  (detail.xMin ?? null) === (request.settings?.xMin ?? null) &&
  (detail.xMax ?? null) === (request.settings?.xMax ?? null);
// Whether stored points are at least as detailed as the request needs, so a smaller
// panel or lower resolution needs no request.
function satisfies(detail: Detail, request: any) {
  if (!covers(detail, request)) return false;
  if (detail.bucketWidth === null && !detail.limited) return true;
  if (detail.limited && detail.level === levelOf(request) && sameRange(detail, request))
    return true;
  const perPixel = (panelLimits.resolution.bucketsPerPixel as Record<string, number>)[
    levelOf(request)
  ];
  if (!perPixel || detail.bucketWidth === null) return false;
  if (!detail.xRange) return true;
  const lo = request.settings?.xMin,
    hi = request.settings?.xMax,
    range = (finite(hi) ? hi : detail.xRange[1]) - (finite(lo) ? lo : detail.xRange[0]);
  return (
    detail.bucketWidth <= bucketWidth(range, Math.max(1, Math.floor(request.pixels * perPixel)))
  );
}
const read = (entry: CacheEntry) => JSON.parse(entry.json) as ChartData;
/**
 * The stored response to draw for a request: `current` when it reflects these run
 * revisions at sufficient detail, otherwise the closest stand-in while a request runs.
 */
export function storedChart(endpoint: string, request: any, versions: string) {
  const identity = JSON.stringify([endpoint, request]),
    exact = cached(identity),
    family = familyOf(endpoint, request);
  if (exact?.versions === versions)
    return { id: identity, versions, current: true, read: () => decoded(identity, exact) };
  const related = family ? members(family).filter((m) => covers(m.detail, request)) : [];
  const match = related.find((m) => m.entry.versions === versions && satisfies(m.detail, request));
  if (match) {
    cached(match.id);
    return { id: match.id, versions, current: true, read: () => decoded(match.id, match.entry) };
  }
  const standIn = exact
    ? { id: identity, entry: exact }
    : related.sort((a, b) => b.entry.order - a.entry.order)[0];
  return (
    standIn && {
      id: standIn.id,
      versions: standIn.entry.versions,
      current: false,
      read: () => decoded(standIn.id, standIn.entry),
    }
  );
}
// The family member the server diffs against: the widest X range, then the newest.
function baseFor(identity: string, family: string | undefined, request: any) {
  const exact = peek(identity);
  if (exact || !family) return exact && { id: identity, entry: exact };
  const all = members(family),
    covering = all.filter((m) => covers(m.detail, request));
  return (covering.length ? covering : all).sort(
    (a, b) =>
      Number(finite(a.detail.xMin) || finite(a.detail.xMax)) -
        Number(finite(b.detail.xMin) || finite(b.detail.xMax)) || b.entry.order - a.entry.order,
  )[0];
}
function store(identity: string, family: string | undefined, entry: CacheEntry) {
  remember(identity, entry);
  // A response larger than the whole store is not kept, so it supersedes nothing.
  if (!family || !peek(identity)) return;
  const detail: Detail = entry.meta;
  // Older or coarser members within the new response's range are superseded by it.
  for (const m of members(family))
    if (
      m.id !== identity &&
      covers(detail, { settings: { xMin: m.detail.xMin, xMax: m.detail.xMax } }) &&
      (m.entry.versions !== entry.versions ||
        (detail.bucketWidth ?? 0) <= (m.detail.bucketWidth ?? 0))
    )
      forget(m.id);
  if (!families.has(family)) families.set(family, new Set());
  families.get(family)!.add(identity);
}
// The revisions behind a stored response, in the request's run order.
function revisionsFor(versions: string, runs: string[]) {
  const known = new Map<string, number>(JSON.parse(versions));
  return runs.map((id) => known.get(id) ?? null);
}
/**
 * Loads a chart, reusing stored points where possible. A streamed response reports
 * partial charts to `onProgress`: arrived series replace the stand-in's, and runs not
 * yet seen have empty series so legends and colors stay put.
 */
export function loadChart(
  endpoint: string,
  request: any,
  versions: string,
  signal: AbortSignal,
  onProgress?: (data: ChartData) => void,
): Promise<ChartData> {
  const stored = storedChart(endpoint, request, versions);
  if (stored?.current) return Promise.resolve(stored.read());
  const identity = JSON.stringify([endpoint, request]),
    family = familyOf(endpoint, request),
    key = identity + '|' + versions;
  let entry = inflight.get(key);
  // An entry whose last user just released it is cancelled; it cannot be joined.
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController(),
      order = ++serial;
    entry = {
      controller,
      users: 0,
      started: false,
      promise: Promise.resolve(null as any),
      listeners: new Set(),
    };
    const current = entry;
    entry.promise = scheduled(async () => {
      current.started = true;
      const base = baseFor(identity, family, request),
        start: ChartData | undefined = base && clipChart(read(base.entry), request.settings),
        working = new Map((start?.series || []).map((s) => [s.id, s]));
      let metadata: any,
        runIds: string[] = [],
        last = 0,
        timer: ReturnType<typeof setTimeout> | undefined;
      const partial = (): ChartData => ({
        ...metadata,
        series: runIds.map(
          (id) =>
            working.get(id) || {
              id,
              name: '',
              pending: true,
              values: Object.fromEntries(metadata.metrics.map((m: string) => [m, []])),
            },
        ),
      });
      const report = () => {
        timer = undefined;
        last = performance.now();
        const data = partial();
        for (const listener of current.listeners) listener(data);
      };
      const progress = () => {
        if (timer || !current.listeners.size) return;
        timer = setTimeout(report, Math.max(0, last + progressInterval - performance.now()));
      };
      if (request.selection) await register(request.selection);
      const post = () =>
        streamed(
          endpoint,
          {
            ...request,
            ...(base?.entry.revision ? { baseRevision: base.entry.revision } : {}),
            ...(base?.id === identity && endpoint === '/api/chart' && request.runs
              ? {
                  baseVersions: revisionsFor(base.entry.versions, request.runs),
                  baseWidth: base.entry.meta?.bucketWidth ?? null,
                }
              : {}),
          },
          controller.signal,
          onLine,
        );
      const onLine = (line: any) => {
        if (line.error) throw new ApiError(line.error, 500, line.code, line.params);
        if (line.metadata) {
          metadata = line.metadata;
          runIds = line.order ?? [...new Set<string>(request.runs)];
        }
        for (const change of line.changed || []) applySeriesChange(working, change);
        if (line.done) {
          for (const id of line.removed) working.delete(id);
          metadata = { ...metadata, sampled: line.sampled, revision: line.revision };
        } else progress();
      };
      const response = await post()
        .catch(async (error) => {
          // The server forgets selections when it restarts or many others were registered.
          if (!(error instanceof ApiError && error.code === 'CHART_SELECTION_UNKNOWN')) throw error;
          await register(request.selection, true);
          return post();
        })
        .finally(() => clearTimeout(timer));
      const data: ChartData =
          response === undefined
            ? partial()
            : response.unchanged || response.delta
              ? applyChartDiff(start!, response)
              : response,
        latest = peek(identity);
      if (!latest || order >= latest.order)
        store(identity, family, {
          json: response?.unchanged ? base!.entry.json : JSON.stringify(data),
          versions,
          revision: data.revision,
          order,
          meta: family && {
            family,
            level: levelOf(request),
            xMin: request.settings?.xMin,
            xMax: request.settings?.xMax,
            bucketWidth: data.bucketWidth ?? null,
            xRange: data.xRange ?? null,
            limited: !!data.pointLimit,
          },
        });
      const stored = peek(identity);
      return stored?.order === order ? decoded(identity, stored, data) : data;
    }, controller.signal).finally(() => {
      if (inflight.get(key) === current) inflight.delete(key);
    });
    inflight.set(key, entry);
  }
  entry.users++;
  const current = entry;
  if (onProgress) current.listeners.add(onProgress);
  return new Promise((resolve, reject) => {
    let released = false;
    const release = (reason?: unknown) => {
      if (released) return;
      released = true;
      if (onProgress) current.listeners.delete(onProgress);
      signal.removeEventListener('abort', abort);
      current.users--;
      // A started request for a hidden panel or a prior focus finishes into the cache:
      // the server computes it either way, and the panel may scroll back.
      if (!current.users && !(current.started && reason === finishInCache)) {
        current.controller.abort();
        if (inflight.get(key) === current) inflight.delete(key);
      }
    };
    const abort = () => {
      release(signal.reason);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    current.promise.then(
      (data) => {
        if (!released) resolve(data);
        release();
      },
      (error) => {
        if (!released) reject(error);
        release();
      },
    );
  });
}
export function chartDataSettings(settings: any) {
  return Object.fromEntries(
    ['xAxis', 'xMin', 'xMax', 'groupBy', 'aggregation', 'spread', 'maxRuns', 'resolution']
      .filter((key) => settings?.[key] !== undefined)
      .map((key) => [key, settings[key]]),
  );
}
// Panels that leave the viewport keep their renderer, so scrolling back nearby redraws
// nothing. The most recently hidden are kept within a count and an estimated heap
// budget; older ones are disposed and later rebuilt from stored responses.
const hiddenRenderers = new Map<object, { dispose: () => void; bytes: number; weight: number }>(),
  hiddenRendererLimit = {
    count: 12,
    bytes:
      Math.min(
        96,
        Math.max(32, 12 * ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4)),
      ) *
      1024 *
      1024,
  };
let hiddenRendererBytes = 0,
  hiddenRendererWeight = 0;
/** Host-generic retention estimate, calibrated in performance.md (2026-10-20).
 * Shared pair sources, DataStore columns and layout are charged together. Canvas
 * includes an estimated compositor copy; series models/tasks add a fixed floor.
 * This is a retention budget, not measured RSS.
 */
export function rendererCost(element: HTMLElement, data: ChartData | null, series: number) {
  let canvas = 0;
  for (const node of element.querySelectorAll('canvas')) canvas += node.width * node.height * 4;
  // Decoded media images are charged like canvases.
  for (const node of element.querySelectorAll('img'))
    canvas += node.naturalWidth * node.naturalHeight * 4;
  const inputs = Math.max(1, (data?.series.length || 0) * (data?.metrics.length || 0));
  return 2 * canvas + 2 * chartBytes(data) * Math.max(1, series / inputs) + series * 16 * 1024;
}

/** Keeps a hidden panel's renderers; `weight` counts them (a grid's mounted cells). */
export function retainHiddenRenderer(
  owner: object,
  dispose: () => void,
  bytes: number,
  weight = 1,
) {
  releaseHiddenRenderer(owner);
  hiddenRenderers.set(owner, { dispose, bytes, weight });
  hiddenRendererBytes += bytes;
  hiddenRendererWeight += weight;
  while (
    hiddenRendererWeight > hiddenRendererLimit.count ||
    hiddenRendererBytes > hiddenRendererLimit.bytes
  ) {
    const [first, entry] = hiddenRenderers.entries().next().value!;
    releaseHiddenRenderer(first);
    entry.dispose();
  }
}
export function releaseHiddenRenderer(owner: object) {
  const entry = hiddenRenderers.get(owner);
  if (!entry) return;
  hiddenRendererBytes -= entry.bytes;
  hiddenRendererWeight -= entry.weight;
  hiddenRenderers.delete(owner);
}
