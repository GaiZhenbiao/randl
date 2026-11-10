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
