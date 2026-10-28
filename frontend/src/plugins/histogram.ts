import { fitOutliers, renderer, type Host } from './shared';
export const create = (host: Host) =>
  renderer(host, (ctx) => {
    // The first run with a histogram at the step shown.
    const entry = ctx.data.entries?.find((item) => item.value);
    if (!entry) throw Error(ctx.translate('charts.errors.noHistogram'));
    const value = entry.value;
    if (!Array.isArray(value.bins) || !Array.isArray(value.values))
      throw Error(ctx.translate('charts.errors.invalidHistogram'));
    const option = {
      animation: false,
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 20, bottom: 35, top: 20 },
      xAxis: {
        type: 'category',
        data: value.bins.slice(0, -1).map((b: number) => Number(b.toPrecision(3)).toString()),
        axisLabel: { color: ctx.dark ? '#c6c6c6' : '#525252' },
      },
      yAxis: { type: 'value', axisLabel: { color: ctx.dark ? '#c6c6c6' : '#525252' } },
      series: [
        {
          name: ctx.panel.metric,
          type: 'bar',
          barCategoryGap: 0,
          data: value.values,
          itemStyle: { color: ctx.dark ? '#78a9ff' : '#0043ce' },
        },
      ],
    };
    // Excluding outliers fits the bin counts from zero, so a dominant bin leaves the plot
    // edge and the other bins fill it.
    fitOutliers(
      option.yAxis,
      ctx.panel.settings || {},
      [value.values.map((count: number, index: number) => [index, count])],
      { bounds: false, xMin: null, xMax: null, log: false, zero: true },
    );
    return option;
  });
