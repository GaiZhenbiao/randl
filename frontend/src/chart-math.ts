export type Point = [number, number];
export type Smoothing = 'none' | 'ema' | 'twema' | 'gaussian' | 'running';
// Parameter ranges and defaults. EMA and time-weighted EMA take a weight; the Gaussian a
// standard deviation and the running average a window, both counted in points. None of
// them depends on the X-axis units or magnitude.
export const smoothingParameters: Record<
  Exclude<Smoothing, 'none'>,
  { min: number; max: number; step: number; value: number }
> = {
  ema: { min: 0, max: 0.99, step: 0.01, value: 0.6 },
  twema: { min: 0, max: 0.99, step: 0.01, value: 0.6 },
  gaussian: { min: 0.5, max: 50, step: 0.5, value: 3 },
  running: { min: 1, max: 500, step: 1, value: 10 },
};
// The value a method uses: the stored value clamped to its range, or its default.
export function smoothingAmount(method: Smoothing, value?: number) {
  if (method === 'none') return 0;
  const { min, max, value: fallback } = smoothingParameters[method];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
// One point spacing in X units for the X-aware methods: the X extent of a panel's series
// divided by the most intervals any one series has. The densest series then has about one
// spacing between points, and every series in the panel is smoothed over the same X span.
export function smoothingSpacing(series: Point[][]) {
  let lo = Infinity,
    hi = -Infinity,
    count = 0;
  for (const points of series) {
    for (const [x] of points) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    count = Math.max(count, points.length);
  }
  return hi > lo && count > 1 ? (hi - lo) / (count - 1) : 1;
}
function calculateSmooth(
  points: Point[],
  method: Smoothing,
  amount: number,
  spacing = smoothingSpacing([points]),
): Point[] {
  if (method === 'none' || !points.length || amount <= 0) return points;
  if (method === 'ema' || method === 'twema') {
    // Debiased exponential moving average. The time-weighted variant applies the weight once
    // per point spacing of X, so a gap of several spacings decays the history further.
    const weight = Math.min(0.999, amount);
    let sum = 0,
      normalization = 0,
      last = points[0][0];
    return points.map(([x, y]) => {
      const decay = method === 'ema' ? weight : Math.pow(weight, Math.max(0, x - last) / spacing);
      last = x;
      sum = decay * sum + y;
      normalization = decay * normalization + 1;
      return [x, sum / normalization];
    });
  }
  if (method === 'running') {
    const radius = Math.floor(Math.min(501, Math.max(1, amount)) / 2),
      prefix = [0];
    for (const p of points) prefix.push(prefix.at(-1)! + p[1]);
    return points.map(([x], i) => {
      const lo = Math.max(0, i - radius),
        hi = Math.min(points.length, i + radius + 1);
      return [x, (prefix[hi] - prefix[lo]) / (hi - lo)];
    });
  }
  if (method === 'gaussian') {
    // Kernel over X distance; the standard deviation is `amount` point spacings and the
    // kernel is cut at four standard deviations.
    // Points are visited in X order, so custom X metrics need not be monotonic.
    const sigma = amount * spacing,
      order = points.map((_, i) => i).sort((a, b) => points[a][0] - points[b][0]),
      result: Point[] = new Array(points.length);
    let start = 0;
    for (const i of order) {
      const x = points[i][0];
      while (points[order[start]][0] < x - 4 * sigma) start++;
      let sum = 0,
        weights = 0;
      for (let k = start; k < order.length && points[order[k]][0] <= x + 4 * sigma; k++) {
        const distance = (points[order[k]][0] - x) / sigma,
          weight = Math.exp(-0.5 * distance * distance);
        sum += weight * points[order[k]][1];
        weights += weight;
      }
      result[i] = [x, sum / weights];
    }
    return result;
  }
  return points;
}

// Inputs are immutable and shared by the decoded response cache. Keep only the
// two most recently used settings per input; the WeakMap cannot retain old inputs.
const smoothed = new WeakMap<Point[], { key: string; out: Point[] }[]>();
export function smooth(
  points: Point[],
  method: Smoothing,
  amount: number,
  spacing = smoothingSpacing([points]),
): Point[] {
  if (method === 'none' || !points.length || amount <= 0) return points;
  const key = `${method}|${amount}|${spacing}`;
  const entries = smoothed.get(points) || [];
  const index = entries.findIndex((entry) => entry.key === key);
  const entry =
    index < 0
      ? { key, out: calculateSmooth(points, method, amount, spacing) }
      : entries.splice(index, 1)[0];
  entries.push(entry);
  if (entries.length > 2) entries.shift();
  smoothed.set(points, entries);
  return entry.out;
}
export const outlierPercentiles = { lower: 5, upper: 95 };
export type OutlierOptions = {
  xMin?: number | null;
  xMax?: number | null;
  log?: boolean;
  lower?: number;
  upper?: number;
  // Include zero, for marks drawn from it (bars and stacks).
  zero?: boolean;
  // Keep the range inside these bounds (0–100 % for shares).
  limits?: [number, number];
};
// The automatic Y range when outliers are excluded, as in W&B: from the lower to the
// upper percentile (5th and 95th by default) of the plotted values with X inside the
// shown range. Each bound snaps outward to a plotted value, so with the defaults a
// series of up to ten points keeps its full range, and then to a round number, so the
// axis labels its ends legibly. Log scales consider positive values only. A percentile
// pair outside 0 ≤ lower < upper ≤ 100 uses the defaults. Null leaves the range automatic.
export function outlierRange(
  series: Point[][],
  { xMin, xMax, log = false, lower, upper, zero = false, limits }: OutlierOptions = {},
): [number, number] | null {
  if (!(
    typeof lower === 'number' &&
    typeof upper === 'number' &&
    0 <= lower &&
    lower < upper &&
    upper <= 100
  ))
    ({ lower, upper } = outlierPercentiles);
  let count = 0;
  for (const points of series) count += points.length;
  const values = new Float64Array(count);
  let n = 0;
  for (const points of series)
    for (const [x, y] of points)
      if (
        Number.isFinite(y) &&
        (!log || y > 0) &&
        (xMin == null || x >= xMin) &&
        (xMax == null || x <= xMax)
      )
        values[n++] = y;
  if (!n) return null;
  const sorted = values.subarray(0, n).sort();
  let lo = sorted[Math.floor((lower / 100) * (n - 1))],
    hi = sorted[Math.ceil((upper / 100) * (n - 1))];
  let range = niceRange(lo, hi, { log, zero });
  if (limits) range = [Math.max(limits[0], range[0]), Math.min(limits[1], range[1])];
  return range[0] < range[1] ? range : null;
}
/** A range around `lo`–`hi` whose bounds are round numbers, so the axis labels its ends. */
export function niceRange(
  lo: number,
  hi: number,
  { log = false, zero = false }: { log?: boolean; zero?: boolean } = {},
): [number, number] {
  if (log) {
    if (lo === hi) [lo, hi] = [lo / 2, hi * 2];
    return [roundDigit(lo, Math.floor), roundDigit(hi, Math.ceil)];
  }
  if (zero) [lo, hi] = [Math.min(lo, 0), Math.max(hi, 0)];
  if (lo === hi) [lo, hi] = [lo - (Math.abs(lo) / 10 || 1), hi + (Math.abs(hi) / 10 || 1)];
  const step = niceStep((hi - lo) / 5);
  return [round(Math.floor(lo / step) * step), round(Math.ceil(hi / step) * step)];
}
// The edges of stacked areas at each X, as points: for each stack (a list of series on
// shared X positions), the top of its positive values and the bottom of its negative
// ones; or, with `inner`, every boundary between two of its bands.
export function stackEdges(stacks: Point[][][], inner = false): Point[][] {
  return stacks.map((stack) => {
    const sums = new Map<number, [number, number]>(),
      edges: Point[] = [];
    for (const [index, points] of stack.entries())
      for (const [x, y] of points) {
        if (!Number.isFinite(y)) continue;
        const sum = sums.get(x) || [0, 0];
        sum[y < 0 ? 1 : 0] += y;
        sums.set(x, sum);
        if (inner && index < stack.length - 1) edges.push([x, sum[0] + sum[1]]);
      }
    if (!inner)
      for (const [x, [positive, negative]] of sums) {
        edges.push([x, positive]);
        if (negative < 0) edges.push([x, negative]);
      }
    return edges;
  });
}
function niceStep(value: number) {
  const scale = 10 ** Math.floor(Math.log10(value)),
    fraction = value / scale;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * scale;
}
// One significant digit, rounded in the given direction.
function roundDigit(value: number, direction: (value: number) => number) {
  const scale = 10 ** Math.floor(Math.log10(value));
  return round(direction(value / scale) * scale);
}
const round = (value: number) => Number(value.toPrecision(12));
