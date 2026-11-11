import type { MessageKey, Translator } from './i18n';

// Media panels step through their runs' media along an X axis: the step by default, or the
// axis the panel's X axis setting names, as charts do.
const names: Record<string, MessageKey> = {
  _step: 'charts.xAxis.step',
  _runtime: 'charts.xAxis.runtime',
  _relative_wall: 'charts.xAxis.relativeWall',
  _timestamp: 'charts.xAxis.wallTime',
};
export const axisName = (axis: string, translate: Translator) =>
  names[axis] ? translate(names[axis]) : axis;
/** A value on an axis: a date and time for wall time, otherwise a number. */
export function axisValue(axis: string, value: number, locale: string) {
  return axis === '_timestamp'
    ? new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(value))
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 4, useGrouping: false }).format(value);
}
/** A position on an axis, such as "Step 120" or "epoch: 3". */
export function axisPosition(axis: string, value: number, translate: Translator, locale: string) {
  return axis === '_step'
    ? translate('media.toolbar.step', { step: value })
    : translate('charts.tooltip.axisValue', {
        axis: axisName(axis, translate),
        value: axisValue(axis, value, locale),
      });
}
/** The index of the value nearest to `value` in an ascending list, or -1 when it is empty. */
export function nearestIndex(values: number[], value: number) {
  let low = 0,
    high = values.length - 1;
  if (high < 0) return -1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (values[middle] <= value) low = middle;
    else high = middle;
  }
  return value - values[low] <= values[high] - value ? low : high;
}
/**
 * Where to mark `values` (ascending) along a track `width` pixels long that spans `min` to
 * `max`, as percentages of the track. A value closer than `gap` pixels to the previous mark
 * gets none, so ticks never crowd; the last value always has a mark.
 */
export function axisTicks(values: number[], min: number, max: number, width: number, gap: number) {
  if (values.length < 2 || width <= 0 || max <= min) return [];
  const ticks: number[] = [];
  values.forEach((value, index) => {
    const at = ((value - min) / (max - min)) * width;
    if (ticks.length && at - ticks.at(-1)! < gap) {
      if (index === values.length - 1) ticks[ticks.length - 1] = at;
    } else ticks.push(at);
  });
  return ticks.map((at) => (at / width) * 100);
}
