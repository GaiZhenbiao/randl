// ECharts options for the project overview. Colors follow the Carbon theme in use:
// state colors match the run list (running uses the success token), and categorical
// series use Carbon's categorical data-visualization palette.
export type Part = { name: string; value: number; color: string };
const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
export function chartColors(dark: boolean) {
  return {
    text: dark ? '#c6c6c6' : '#525252',
    grid: dark ? '#393939' : '#e0e0e0',
    axis: dark ? '#6f6f6f' : '#a8a8a8',
    tooltip: dark ? '#393939' : '#ffffff',
    tooltipText: dark ? '#f4f4f4' : '#161616',
    categorical: dark
      ? ['#8a3ffc', '#33b1ff', '#08bdba', '#ff7eb6', '#d2a106']
      : ['#6929c4', '#1192e8', '#005d5d', '#9f1853', '#b28600'],
  };
}
export function stateColors(dark: boolean): Record<string, string> {
  return {
    running: cssVar('--cds-support-02', dark ? '#42be65' : '#24a148'),
    finished: dark ? '#8d8d8d' : '#8d8d8d',
    failed: cssVar('--cds-support-01', dark ? '#fa4d56' : '#da1e28'),
    crashed: dark ? '#ff832b' : '#ff832b',
    killed: dark ? '#6f6f6f' : '#c6c6c6',
  };
}
function tooltip(dark: boolean) {
  const c = chartColors(dark);
  return {
    confine: true,
    backgroundColor: c.tooltip,
    borderColor: c.axis,
    textStyle: { color: c.tooltipText, fontSize: 12 },
  };
}
/** One horizontal bar split into parts, for shares of a whole. */
export function shareBar(parts: Part[], dark: boolean, format: (value: number) => string) {
  const shown = parts.filter((part) => part.value > 0);
  return {
    animation: false,
    textStyle: { fontFamily: 'IBM Plex Sans,system-ui,sans-serif' },
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    tooltip: { ...tooltip(dark), trigger: 'item', formatter: (p: any) => `${p.seriesName}: ${format(p.value)}` },
    xAxis: { type: 'value', show: false, max: shown.reduce((sum, part) => sum + part.value, 0) || 1 },
    yAxis: { type: 'category', show: false, data: [''] },
    series: shown.map((part) => ({
      type: 'bar',
      name: part.name,
      stack: 'total',
      data: [part.value],
      barWidth: '100%',
      itemStyle: { color: part.color, borderColor: dark ? '#161616' : '#ffffff', borderWidth: 1 },
      emphasis: { disabled: true },
    })),
  };
}
type Series = { name: string; values: (number | null)[]; color: string; dashed?: boolean };
/** Per-minute series on a time axis. Stacked series render as bars. */
export function minuteChart(
  times: number[],
  series: Series[],
  dark: boolean,
  options: { stacked?: boolean; format: (value: number) => string; locale: string; min?: number },
) {
  const c = chartColors(dark);
  return {
    animation: false,
    textStyle: { fontFamily: 'IBM Plex Sans,system-ui,sans-serif', fontSize: 11, color: c.text },
    grid: { left: 52, right: 12, top: 28, bottom: 24 },
    legend: { top: 0, left: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: c.text, fontSize: 11 } },
    tooltip: {
      ...tooltip(dark),
      trigger: 'axis',
      valueFormatter: (value: number | null) => (value == null ? '—' : options.format(value)),
    },
    xAxis: {
      type: 'time',
      min: options.min,
      axisLine: { lineStyle: { color: c.axis } },
      axisLabel: {
        color: c.text,
        hideOverlap: true,
        formatter: (value: number) =>
          new Intl.DateTimeFormat(options.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLabel: { color: c.text, hideOverlap: true, formatter: options.format },
      splitLine: { lineStyle: { color: c.grid } },
    },
    series: series.map((item) => ({
      type: options.stacked ? 'bar' : 'line',
      name: item.name,
      stack: options.stacked ? 'total' : undefined,
      barMaxWidth: 8,
      // Minutes without traffic have no value; markers keep isolated minutes visible.
      showSymbol: item.values.some((value) => value == null),
      symbolSize: 4,
      connectNulls: false,
      lineStyle: item.dashed ? { type: 'dashed', width: 1.5 } : { width: 1.5 },
      itemStyle: { color: item.color },
      emphasis: { focus: 'series' },
      data: times.map((t, index) => [t, item.values[index]]),
    })),
  };
}
