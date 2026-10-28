import * as core from 'echarts/core';
import { setAsPrimitive } from 'zrender/lib/core/util';
import { LineChart, BarChart, ScatterChart, ParallelChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ParallelComponent,
  ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
core.use([
  LineChart,
  BarChart,
  ScatterChart,
  ParallelChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ParallelComponent,
  ToolboxComponent,
  CanvasRenderer,
]);
// ECharts already uses this clone marker for typed arrays. Numeric pairs have
// identical read-only ownership, while preserving stacked tooltip value semantics.
// Validate once per immutable array. Other data formats keep ECharts' normal copies.
const shared = new WeakSet<object>();
const configured = new WeakSet<core.EChartsType>();
export const echarts = {
  ...core,
  init(...args: Parameters<typeof core.init>) {
    const chart = core.init(...args);
    if (configured.has(chart)) return chart;
    configured.add(chart);
    const setOption = chart.setOption;
    chart.setOption = ((option: Parameters<typeof chart.setOption>[0], ...rest: unknown[]) => {
      const series = option.series
        ? Array.isArray(option.series)
          ? option.series
          : [option.series]
        : [];
      for (const item of series) {
        const data = item.data;
        if (
          Array.isArray(data) &&
          !shared.has(data) &&
          Object.isExtensible(data) &&
          data.every(
            (point) =>
              Array.isArray(point) &&
              point.length === 2 &&
              typeof point[0] === 'number' &&
              typeof point[1] === 'number',
          )
        ) {
          setAsPrimitive(data);
          shared.add(data);
        }
      }
      return Reflect.apply(setOption, chart, [option, ...rest]);
    }) as typeof chart.setOption;
    const appendData = chart.appendData;
    chart.appendData = (params) => {
      const series = (chart as any).getModel()?.getSeriesByIndex(params.seriesIndex);
      if (series) {
        const store = series.getRawData().getStore();
        const source = store.getProvider().getSource();
        if (shared.has(source.data)) {
          // ECharts' original-data provider appends in place. Detach just this
          // series before appendData so another panel's immutable input stays intact.
          const copy = source.data.slice();
          source.data = series.option.data = copy;
          store._provider = new (store.getProvider().constructor)(source);
        }
      }
      appendData.call(chart, params);
    };
    return chart;
  },
};
