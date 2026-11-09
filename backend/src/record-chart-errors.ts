export const recordTransformErrors: Record<string, string> = {
  historyRequired: 'This chart calculation requires history data.',
  invalid: 'This chart data request is invalid.',
  metricLimit: 'Choose between one and eight metrics for this chart calculation.',
  oneStream: 'Use metrics from either run history or system events, not both.',
  negative: 'Percentage calculations require nonnegative metric values.',
  nonFinite:
    'The aggregate exceeds the numeric range. Narrow the X range, compare fewer runs or turn off spread.',
};
// Codes are CHART_TRANSFORM_<NAME>; the frontend maps each to charts.transforms.errors.<name>.
export const recordTransformCode = (name: string) =>
  'CHART_TRANSFORM_' + name.replace(/[A-Z]/g, (letter) => '_' + letter).toUpperCase();
export function recordTransformError(name: string, params: Record<string, string | number> = {}) {
  const code = recordTransformCode(name);
  const message = (recordTransformErrors[name] || recordTransformErrors.invalid).replace(
    /\{(\w+)\}/g,
    (token, key) =>
      params[key] === undefined
        ? token
        : typeof params[key] === 'number'
          ? params[key].toLocaleString('en-US')
          : params[key],
  );
  return Object.assign(Error(message), { code, params, statusCode: 400 });
}
