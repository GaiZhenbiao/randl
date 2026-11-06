import type { ChartData } from './types';
type Series = ChartData['series'][number];
/** Applies one entry of a chart delta's `changed` list to series keyed by ID. */
export function applySeriesChange(series: Map<string, Series>, change: any) {
  if (change.replace) {
    series.set(change.replace.id, change.replace);
    return;
  }
  const old = series.get(change.id);
  if (!old) throw Error('Chart base revision is unavailable');
  const values = patchMetrics(old.values, change.metrics),
    means = patchMetrics(old.means || {}, change.means || {});
  series.set(change.id, {
    ...change.metadata,
    values,
    ...(Object.keys(means).length ? { means } : {}),
  });
}
// Applies per-metric point patches (see diffSeries) to a copy of `before`.
function patchMetrics(
  before: Record<string, [number, number][]>,
  patches: Record<string, any>,
): Record<string, [number, number][]> {
  const after = { ...before };
  for (const [metric, patch] of Object.entries(patches)) {
    if (patch.delete) {
      delete after[metric];
      continue;
    }
    if (patch.replace) {
      after[metric] = patch.replace;
      continue;
    }
    const points = new Map((after[metric] || []).map((p) => [p[0], p]));
    for (const x of patch.remove) points.delete(x);
    for (const point of patch.upsert) points.set(point[0], point);
    after[metric] = [...points.values()].sort((a, b) => a[0] - b[0]);
  }
  return after;
}
export function applyChartDiff(previous: ChartData, response: any): ChartData {
  if (response.unchanged) return previous;
  if (!response.delta) return response;
  const series = new Map(previous.series.map((s) => [s.id, s]));
  for (const id of response.removed) series.delete(id);
  for (const change of response.changed) applySeriesChange(series, change);
  return {
    ...response.metadata,
    series: (response.order ?? previous.series.map((s) => s.id))
      .map((id: string) => series.get(id))
      .filter(Boolean),
  };
}
