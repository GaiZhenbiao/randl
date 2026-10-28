import { base, fitOutliers, legendName, smoothingFor } from './shared';
import { smooth, stackEdges, type Point } from '../chart-math';
import { color, componentColor } from '../run-colors';
import type { PanelContext } from '../types';

// Stacked and percent area charts.
// - One metric: the runs or groups are stacked. Their X positions differ, so values are
//   interpolated onto shared positions within the range all of them cover.
// - Several metrics (plain or computed): each run or group stacks its own components. The host
//   requests them aligned per record, so every component of a series has the same X positions (and, for
//   percent, is already a share of that record's total). Components take the run
//   palette in metric order; a run's identity is in the legend and tooltip names.
export function stackedOption(ctx: PanelContext, percent: boolean) {
  const option = base(ctx),
    settings = ctx.panel.settings || {},
    { method, amount, spacing } = smoothingFor(ctx);
  const areaStyle = { opacity: 0.85 };
  const transform = ctx.data.recordTransform;
  if (
    transform?.kind === 'align' ||
    (transform?.kind === 'compute' && transform.align && ctx.data.metrics.length > 1)
  ) {
    const metrics = ctx.data.metrics;
    // With one run or group, the hover popup names each component by its metric alone,
    // without the key prefix every component shares (the legend keeps the full key).
    const single = ctx.data.series.length === 1;
    let shared = metrics.reduce((prefix, metric) => {
      let i = 0;
      while (i < prefix.length && prefix[i] === metric[i]) i++;
      return prefix.slice(0, i);
    });
    shared = shared.slice(
      0,
      Math.max(...['/', '_', '.', '-'].map((c) => shared.lastIndexOf(c))) + 1,
    );
    const component = (metric: string) =>
      metrics.length > 1 && metric.length > shared.length ? metric.slice(shared.length) : metric;
    option.series = ctx.data.series.flatMap((series) =>
      metrics.map((metric, index) => {
        const raw = series.values[metric] || [],
          points = smooth(raw, method, amount, spacing),
          name = legendName(ctx, series, metric, true);
        return {
          name,
          randlLabel: single ? component(metric) : name,
          randlOriginal: method !== 'none' ? raw : undefined,
          randlMembers: series.bands?.[metric],
          randlPercent: percent,
          randlKey: series.id + ':' + metric,
          randlMetric: metric,
          randlRunIds: series.runIds || [series.id],
          type: 'line',
          stack: 'components:' + series.id,
          data: points,
          showSymbol: settings.showPoints || points.length === 1,
          symbolSize: points.length === 1 ? 6 : 4,
          lineStyle: { width: settings.lineWidth || 1.5 },
          itemStyle: { color: componentColor(index, ctx.dark) },
          areaStyle,
          emphasis: { focus: 'series' },
        };
      }),
    );
  } else {
    const metric = ctx.data.metrics[0] ?? ctx.panel.metric,
      series = ctx.data.series
        .map((item) => ({
          ...item,
          points: smooth(item.values[metric] || [], method, amount, spacing),
        }))
        .filter((item) => item.points.length);
    if (percent && series.some((item) => item.points.some((point) => point[1] < 0)))
      throw Error(ctx.translate('charts.errors.percentNegative'));
    if (!series.length) return { ...option, series: [] };
    const lo = Math.max(...series.map((item) => item.points[0][0])),
      hi = Math.min(...series.map((item) => item.points.at(-1)![0]));
    if (lo > hi) throw Error(ctx.translate('charts.errors.noOverlap'));
    // Stack at logged X positions inside the shared range, so hover reports real steps.
    // Evenly spaced positions are kept when there are more than 300.
    const logged = [
      ...new Set(
        series.flatMap((item) =>
          item.points.map((point) => point[0]).filter((x) => x >= lo && x <= hi),
        ),
      ),
    ].sort((a, b) => a - b);
    const steps =
      logged.length <= 300
        ? logged
        : Array.from(
            { length: 300 },
            (_, i) => logged[Math.round((i * (logged.length - 1)) / 299)],
          );
    const n = steps.length;
    const interpolate = (points: number[][], x: number) => {
      let i = 0;
      while (i < points.length - 2 && points[i + 1][0] < x) i++;
      const a = points[i],
        b = points[i + 1] || a;
      return a[1] + (b[1] - a[1]) * (b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]));
    };
    const share = (rows: number[][], index: number, i: number) =>
      (rows[index][i] / (rows.reduce((sum, row) => sum + row[i], 0) || 1)) * 100;
    const values = series.map((item) => steps.map((x) => interpolate(item.points, x)));
    const originals =
      method === 'none'
        ? undefined
        : series.map((item) => steps.map((x) => interpolate(item.values[metric], x)));
    option.series = series.map((item, index) => ({
      name: legendName(ctx, item, metric),
      randlOriginal:
        originals &&
        steps.map((x, i) => [x, percent ? share(originals, index, i) : originals[index][i]]),
      randlPercent: percent,
      randlKey: item.id + ':' + metric,
      randlMetric: metric,
      randlRunIds: item.runIds || [item.id],
      type: 'line',
      showSymbol: settings.showPoints || n === 1,
      stack: 'runs',
      areaStyle,
      lineStyle: { width: settings.lineWidth || 1.5 },
      itemStyle: { color: color(item.id, ctx.colors, ctx.dark) },
      emphasis: { focus: 'series' },
      data: steps.map((x, i) => [x, percent ? share(values, index, i) : values[index][i]]),
    }));
  }
  // Stacks are drawn from zero, so an automatic Y axis includes it.
  option.yAxis.scale = false;
  if (percent) {
    option.yAxis.min = 0;
    option.yAxis.max = 100;
    option.yAxis.axisLabel.formatter = '{value}%';
  }
  // Excluding outliers fits the stack totals from zero, or for shares the boundaries
  // between bands within 0–100 %, so the region where the shares move fills the plot.
  // Shares ignore explicit Y bounds, which an inherited range for other charts may set.
  const stacks = new Map<string, Point[][]>();
  for (const item of option.series) {
    const stack = stacks.get(item.stack) || [];
    stack.push(item.data);
    stacks.set(item.stack, stack);
  }
  fitOutliers(
    option.yAxis,
    settings,
    stackEdges([...stacks.values()], percent),
    percent ? { bounds: false, limits: [0, 100] } : { zero: true },
  );
  return option;
}
