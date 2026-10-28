import { base, fitOutliers, renderer, type Host } from './shared';
import type { PanelContext } from '../types';
import type { Point } from '../chart-math';
import { color } from '../run-colors';
export function barOptions(ctx: PanelContext) {
  const option = {
    ...base(ctx),
    yAxis: { ...base(ctx).yAxis, scale: ctx.panel.settings?.yScale === 'log' },
    xAxis: {
      type: 'category',
      data: ctx.data.series.map((s) => s.name),
      axisLabel: {
        width: 80,
        overflow: 'truncate',
        fontSize: 11,
        color: ctx.dark ? '#c6c6c6' : '#525252',
      },
    },
    series: (ctx.panel.metrics || [ctx.panel.metric]).map((metric) => ({
      name: metric,
      type: 'bar',
      randlDatumRunIds: ctx.data.series.map((series) => series.runIds || [series.id]),
      barMaxWidth: 32,
      data: ctx.data.series.map((s) => ({
        value: s.values[metric]?.at(-1)?.[1] ?? null,
        itemStyle: { color: color(s.id, ctx.colors, ctx.dark) },
      })),
    })),
  };
  // Excluding outliers fits the bar values; linear bars keep their zero baseline.
  fitOutliers(
    option.yAxis,
    ctx.panel.settings || {},
    option.series.map((series: { data: { value: number }[] }) =>
      series.data.map(({ value }, index: number) => [index, value] as Point),
    ),
    { xMin: null, xMax: null, zero: true },
  );
  return option;
}
export const create = (host: Host) => renderer(host, barOptions);
