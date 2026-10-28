import { base, renderer, legendName, type Host } from './shared';
import { color } from '../run-colors';
export const create = (host: Host) =>
  renderer(host, (ctx) => {
    const metrics = ctx.panel.metrics || [],
      text = ctx.dark ? '#c6c6c6' : '#525252';
    if (metrics.length < 2) throw Error(ctx.translate('charts.errors.parallelMetrics'));
    const categories = metrics.map((metric) => [
      ...new Set(
        ctx.data.series
          .map((s) => (ctx.data.snapshot ? s.attributes?.[metric] : s.values[metric]?.at(-1)?.[1]))
          .filter((value) => value != null),
      ),
    ]);
    return {
      animation: false,
      legend: base(ctx).legend,
      parallel: {
        left: 45,
        right: 45,
        top: 42,
        bottom: 56,
        parallelAxisDefault: {
          type: 'value',
          nameTextStyle: { color: text, fontSize: 11 },
          axisLabel: { color: text, fontSize: 10 },
        },
      },
      parallelAxis: metrics.map((name, dim) => ({
        dim,
        name: name.split('/').at(-1),
        ...(categories[dim].some((value) => typeof value !== 'number')
          ? { type: 'category', data: categories[dim].map(String) }
          : {}),
      })),
      series: ctx.data.series.map((s) => ({
        type: 'parallel',
        name: legendName(ctx, s, metrics[0]),
        randlRunIds: s.runIds || [s.id],
        lineStyle: {
          color: color(s.id, ctx.colors, ctx.dark),
          width: ctx.panel.settings?.lineWidth || 1.5,
          opacity: 0.7,
        },
        data: [
          metrics.map((metric, index) => {
            const value = ctx.data.snapshot
              ? s.attributes?.[metric]
              : s.values[metric]?.at(-1)?.[1];
            return value == null
              ? null
              : categories[index].some((value) => typeof value !== 'number')
                ? String(value)
                : value;
          }),
        ],
      })),
    };
  });
