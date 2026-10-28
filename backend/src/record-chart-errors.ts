export const recordTransformErrors: Record<string, string> = {
  sourceRecordLimit:
    'The selection exceeds {limit} stored records. A single run above this limit is not supported by this calculation.',
  sourceBytesLimit:
    'The selection exceeds {limit} MiB of stored data. A single run above this limit is not supported by this calculation.',
  recordBytesLimit:
    'A selected run contains a stored record larger than {limit} MiB. This calculation does not support that run.',

  historyRequired: 'This chart calculation requires history data.',
  invalid: 'This chart data request is invalid.',
  metricLimit: 'Choose between one and eight metrics for this chart calculation.',
  oneStream: 'Use metrics from either run history or system events, not both.',
  inputLimit:
    'Each run supports at most {limit} usable records for this calculation. Narrow the X range.',
  negative: 'Percentage calculations require nonnegative metric values.',
  requestSourceLimit:
    'This chart reads at most {limit} stored values per request. Narrow the X range or compare fewer runs.',
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
