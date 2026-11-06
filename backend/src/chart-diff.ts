import panelLimits from './panel-limits.json' with { type: 'json' };
// Bucket widths are powers of two aligned to x = 0, so every point a coarser width keeps
// is also kept by any finer width. Responses at two resolutions differ only by additions.
export function bucketWidth(range: number, buckets: number) {
  return 2 ** Math.ceil(Math.log2(Math.max(range, Number.MIN_VALUE) / Math.max(1, buckets)));
}
// A base response diffed against a request with an X range keeps only that range, as
// the client does when it applies the diff.
export function clipChart(data: any, settings: any = {}) {
  const lo = settings?.xMin,
    hi = settings?.xMax;
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return data;
  const inside = (p: number[]) =>
    (!Number.isFinite(lo) || p[0] >= lo) && (!Number.isFinite(hi) || p[0] <= hi);
  const clip = (values: Record<string, number[][]>) =>
    Object.fromEntries(
      Object.entries(values).map(([metric, points]) => [metric, points.filter(inside)]),
    );
  return {
    ...data,
    series: (data.series || []).map((s: Series) => ({
      ...s,
      values: clip(s.values),
      ...(s.means ? { means: clip(s.means) } : {}),
    })),
  };
}
type Resolution = keyof typeof panelLimits.resolution.points;
// `pixels` is the plot's CSS width; canvas device-pixel density does not affect sampling.
export function chartResolution(requested: unknown, pixels = 1024) {
  const level = (
    typeof requested === 'string' && requested in panelLimits.resolution.points
      ? requested
      : panelLimits.resolution.default
  ) as Resolution;
  const perPixel = (panelLimits.resolution.bucketsPerPixel as Record<string, number>)[level];
  return {
    level,
    buckets: perPixel ? Math.max(1, Math.floor(pixels * perPixel)) : null,
    points: panelLimits.resolution.points[level],
    width: null as number | null,
  };
}
/** Whether any series lost points to downsampling. */
export const chartSampled = (
  plan: { metrics: string[]; counts: Record<string, number[]> },
  series: { id: string; values: Record<string, unknown[]> }[],
) => series.some((s) => plan.metrics.some((m, j) => plan.counts[s.id][j] > s.values[m].length));
export type Series = {
  id: string;
  values: Record<string, number[][]>;
  /** Downsampled metrics: each bucket's mean at its last X, the input to smoothing. */
  means?: Record<string, number[][]>;
  [key: string]: any;
};
// Point patches per metric that turn `before` into `after`.
function diffMetrics(before: Record<string, number[][]>, after: Record<string, number[][]>) {
  const metrics: Record<string, any> = {};
  for (const metric of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(metric in after)) {
      metrics[metric] = { delete: true };
      continue;
    }
    if (!(metric in before)) {
      metrics[metric] = { replace: after[metric] };
      continue;
    }
    const a = before[metric] || [],
      b = after[metric] || [];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (
      new Set(a.map((p) => p[0])).size !== a.length ||
      new Set(b.map((p) => p[0])).size !== b.length
    ) {
      metrics[metric] = { replace: b };
      continue;
    }
    const map = new Map(a.map((p) => [p[0], p]));
    const upsert = [];
    for (const point of b) {
      const prev = map.get(point[0]);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(point)) upsert.push(point);
      map.delete(point[0]);
    }
    metrics[metric] = { upsert, remove: [...map.keys()] };
  }
  return metrics;
}
/**
 * The change that turns `old` into `series`: point patches of `values` (`metrics`) and of
 * `means`, a replacement, or null.
 */
export function diffSeries(old: Series | undefined, series: Series) {
  if (!old) return { replace: series };
  const metrics = diffMetrics(old.values, series.values),
    means = diffMetrics(old.means || {}, series.means || {});
  const { values: _, means: __, ...metadata } = series,
    { values: ___, means: ____, ...oldMetadata } = old;
  if (
    Object.keys(metrics).length ||
    Object.keys(means).length ||
    JSON.stringify(metadata) !== JSON.stringify(oldMetadata)
  )
    return {
      id: series.id,
      metadata,
      metrics,
      ...(Object.keys(means).length ? { means } : {}),
    };
  return null;
}
export function chartDiff(previous: any, next: any) {
  if (previous.media || next.media) return null;
  const before = new Map<string, Series>((previous.series || []).map((s: Series) => [s.id, s]));
  const changed = [];
  for (const series of next.series as Series[]) {
    const change = diffSeries(before.get(series.id), series);
    before.delete(series.id);
    if (change) changed.push(change);
  }
  const { series: _, ...metadata } = next,
    order = next.series.map((s: Series) => s.id);
  // The order is sent only when it differs; with many runs it outweighs a live update.
  return {
    delta: true,
    metadata,
    changed,
    removed: [...before.keys()],
    ...(JSON.stringify(order) === JSON.stringify((previous.series || []).map((s: Series) => s.id))
      ? {}
      : { order }),
  };
}
