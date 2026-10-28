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
  const values = { ...old.values };
  for (const [metric, patch] of Object.entries(change.metrics) as [string, any][]) {
    if (patch.delete) {
      delete values[metric];
      continue;
    }
    if (patch.replace) {
      values[metric] = patch.replace;
      continue;
    }
    const points = new Map((values[metric] || []).map((p) => [p[0], p]));
    for (const x of patch.remove) points.delete(x);
    for (const point of patch.upsert) points.set(point[0], point);
    values[metric] = [...points.values()].sort((a, b) => a[0] - b[0]);
  }
  series.set(change.id, { ...change.metadata, values });
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
