import { base, fitOutliers, optionExtent, renderer, legendName, type Host } from './shared';
import { color } from '../run-colors';
import type { PanelContext } from '../types';
function scatterOption(ctx: PanelContext) {
  const metrics = ctx.panel.metrics || [];
  if (metrics.length < 2) throw Error(ctx.translate('charts.errors.scatterMetrics'));
  const option = base(ctx);
  if (!ctx.cell?.compact) {
    option.xAxis.name = metrics[1];
    option.yAxis.name = metrics[0];
  }
  option.tooltip.trigger = 'item';
  if (ctx.data.snapshot) {
    for (const [axis, metric] of [
      ['xAxis', metrics[1]],
      ['yAxis', metrics[0]],
    ]) {
      const values = ctx.data.series
        .map((s) => s.attributes?.[metric])
        .filter((value) => value != null);
      if (values.some((value) => typeof value !== 'number')) {
        option[axis] = { ...option[axis], type: 'category', min: undefined, max: undefined };
        option[axis].data = [...new Set(values.map(String))];
      } else
        option[axis].type =
          ctx.panel.settings?.[axis === 'xAxis' ? 'xScale' : 'yScale'] === 'log' ? 'log' : 'value';
    }
    if (
      !ctx.data.series.some(
        (s) => s.attributes?.[metrics[0]] != null && s.attributes?.[metrics[1]] != null,
      )
    )
      throw Error(ctx.translate('charts.errors.scatterNoValues'));
  }
  option.series = ctx.data.series.map((s) => ({
    name: legendName(ctx, s, metrics[0]),
    randlRunIds: s.runIds || [s.id],
    type: 'scatter',
    symbolSize: 4,
    large: true,
    itemStyle: { color: color(s.id, ctx.colors, ctx.dark), opacity: 0.7 },
    data: ctx.data.snapshot
      ? s.attributes?.[metrics[0]] != null && s.attributes?.[metrics[1]] != null
        ? [
            [
              option.xAxis.type === 'category'
                ? String(s.attributes[metrics[1]])
                : s.attributes[metrics[1]],
              option.yAxis.type === 'category'
                ? String(s.attributes[metrics[0]])
                : s.attributes[metrics[0]],
            ],
          ]
        : []
      : s.values[metrics[0]] || [],
  }));
  // Excluding outliers fits the Y values of the points inside the X range.
  if (option.yAxis.type !== 'category')
    fitOutliers(
      option.yAxis,
      ctx.panel.settings || {},
      option.series.map((series: any) => series.data),
      option.xAxis.type === 'category' ? { xMin: null, xMax: null } : {},
    );
  return option;
}
export const create = (host: Host) => renderer(host, scatterOption);
export const extent = (ctx: PanelContext) =>
  optionExtent(scatterOption(ctx), ctx.panel.settings || {});
