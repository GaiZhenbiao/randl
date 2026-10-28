import { bucketWidth } from './chart-diff.js';
import { recordTransformError } from './record-chart-errors.js';
// Grouped charts aggregate runs on shared X buckets, as W&B does for bucketed line plots:
// each run is first reduced to one value per bucket (its mean, plus its minimum and maximum
// for min/max aggregation and bands), then a bucket aggregates the runs that logged in it.
// A run logging ten times as often still counts once, and every aggregated point reports
// how many runs it describes. Buckets are aligned powers of two (see chart-diff), so runs
// logging at different steps or times share them. Memory is bounded by the bucket count,
// not by the number of runs.

/** A run's X coverage for one output: its point count and lowest and highest X. */
export type Extent = { n: number; lo: number | null; hi: number | null };
export const groupLimits = {
  // Median keeps every run's value per bucket; past this many, buckets widen.
  medianValues: 4_000_000,
};
const span = (lo: number, hi: number, width: number) =>
  Math.floor(hi / width) - Math.floor(lo / width) + 1;
/**
 * The bucket width for a grouped chart. `slots` is the number of aggregated lines (groups
 * times outputs); their buckets share the resolution's point budget. Without
 * downsampling (`buckets` null) exact X values are aggregated while every point fits.
 */
export function planGroupBuckets(
  extents: Extent[],
  resolution: { buckets: number | null; points: number },
  slots: number,
  median = false,
) {
  const present = extents.filter(
    (e) => e.n > 0 && Number.isFinite(e.lo) && Number.isFinite(e.hi),
  ) as { n: number; lo: number; hi: number }[];
  if (!present.length) return { width: null, natural: null, range: null };
  let lo = Infinity,
    hi = -Infinity,
    total = 0;
  for (const e of present) {
    lo = Math.min(lo, e.lo);
    hi = Math.max(hi, e.hi);
    total += e.n;
  }
  const points = Math.max(1, resolution.points);
  slots = Math.max(1, slots);
  // A single X value needs no buckets.
  if (
    lo === hi ||
    (resolution.buckets === null &&
      total <= points &&
      (!median || total <= groupLimits.medianValues))
  )
    return { width: null, natural: null, range: [lo, hi] as [number, number] };
  const natural = resolution.buckets === null ? null : bucketWidth(hi - lo, resolution.buckets);
  let width = natural ?? bucketWidth(hi - lo, Math.max(1, Math.floor(points / slots)));
  while (slots * span(lo, hi, width) > points) width *= 2;
  if (median) {
    const values = (w: number) =>
      present.reduce((sum, e) => sum + Math.min(e.n, span(e.lo, e.hi, w)), 0);
    while (values(width) > groupLimits.medianValues) width *= 2;
  }
  return { width, natural, range: [lo, hi] as [number, number] };
}

/**
 * Reduces one run's observations to per-bucket statistics. Each bucket keeps its last
 * (highest) X, a logged position as in W&B's bucketed lines, and for each output its mean,
 * minimum and maximum. `finish` returns them packed by bucket order: [key, lastX,
 * (mean, min, max) per output] per bucket.
 */
export class RunBuckets {
  private keys = new Map<number, number>();
  private data: Float64Array;
  private used = 0;
  private lastKey = NaN;
  private lastSlot = -1;
  private ordered = true;
  /** Observations folded into a bucket that already had one. */
  merged = 0;
  readonly stride: number;
  constructor(
    readonly width: number | null,
    readonly outputs: number,
  ) {
    // key, count, last X, then mean/min/max per output
    this.stride = 3 + 3 * outputs;
    this.data = new Float64Array(this.stride * 8);
  }
  add(x: number, values: ArrayLike<number>, offset = 0) {
    const key = this.width === null ? x : Math.floor(x / this.width);
    let slot: number;
    if (key === this.lastKey) slot = this.lastSlot;
    else {
      const found = this.keys.get(key);
      if (found === undefined) {
        if (this.used && key < this.lastKey) this.ordered = false;
        slot = this.used++;
        if (slot * this.stride + this.stride > this.data.length) {
          const grown = new Float64Array(this.data.length * 2);
          grown.set(this.data);
          this.data = grown;
        }
        this.keys.set(key, slot);
        const base = slot * this.stride;
        this.data[base] = key;
        this.data[base + 1] = 0;
        this.data[base + 2] = x;
        for (let i = 0; i < this.outputs; i++) {
          const value = values[offset + i];
          this.data[base + 3 + 3 * i] = value;
          this.data[base + 4 + 3 * i] = value;
          this.data[base + 5 + 3 * i] = value;
        }
      } else {
        slot = found;
        if (key < this.lastKey) this.ordered = false;
      }
      this.lastKey = key;
      this.lastSlot = slot;
    }
    const base = slot * this.stride,
      count = ++this.data[base + 1];
    if (count === 1) return;
    this.merged++;
    // Incremental means avoid overflowing a sum of large values.
    if (x > this.data[base + 2]) this.data[base + 2] = x;
    for (let i = 0; i < this.outputs; i++) {
      const value = values[offset + i],
        at = base + 3 + 3 * i;
      this.data[at] += value / count - this.data[at] / count;
      if (value < this.data[at + 1]) this.data[at + 1] = value;
      if (value > this.data[at + 2]) this.data[at + 2] = value;
    }
  }
  /** Packed buckets ordered by key, without the per-bucket counts. */
  finish(): Float64Array {
    const width = 2 + 3 * this.outputs,
      out = new Float64Array(this.used * width);
    let order: number[] | undefined;
    if (!this.ordered)
      order = Array.from({ length: this.used }, (_, i) => i).sort(
        (a, b) => this.data[a * this.stride] - this.data[b * this.stride],
      );
    for (let i = 0; i < this.used; i++) {
      const slot = order ? order[i] : i,
        base = slot * this.stride;
      out[i * width] = this.data[base];
      out[i * width + 1] = this.data[base + 2];
      out.set(this.data.subarray(base + 3, base + this.stride), i * width + 2);
    }
    return out;
  }
}
export type GroupPoint = { x: number; n: number; values: [number, number, number][] };
/**
 * Aggregates per-run bucket summaries of one group. Buckets are dense over the planned X
 * range when a width is set, otherwise keyed by exact X. Means and spreads are kept as
 * running moments in power-of-two scaled units, so large values cannot overflow them.
 */
export class GroupBuckets {
  private keys?: Map<number, number>;
  private origin = 0;
  private size = 0;
  private count: Float64Array;
  private lastX: Float64Array;
  private scale: Float64Array;
  private mean: Float64Array;
  private m2: Float64Array;
  private low: Float64Array;
  private high: Float64Array;
  private medians?: number[][];
  constructor(
    readonly width: number | null,
    readonly outputs: number,
    range: [number, number] | null,
    readonly median: boolean,
  ) {
    if (width !== null && range) {
      this.origin = Math.floor(range[0] / width);
      this.size = Math.floor(range[1] / width) - this.origin + 1;
    } else this.keys = new Map();
    this.count = new Float64Array(this.size);
    this.lastX = new Float64Array(this.size);
    const cells = this.size * outputs;
    this.scale = new Float64Array(cells);
    this.mean = new Float64Array(cells);
    this.m2 = new Float64Array(cells);
    this.low = new Float64Array(cells);
    this.high = new Float64Array(cells);
    if (median) this.medians = [];
  }
  // Resizes the bucket arrays to `size` slots, the existing ones starting at `offset`.
  private grow(size: number, offset = 0) {
    const resize = (array: Float64Array, factor: number) => {
      const next = new Float64Array(size * factor);
      next.set(array, offset * factor);
      return next;
    };
    this.count = resize(this.count, 1);
    this.lastX = resize(this.lastX, 1);
    this.scale = resize(this.scale, this.outputs);
    this.mean = resize(this.mean, this.outputs);
    this.m2 = resize(this.m2, this.outputs);
    this.low = resize(this.low, this.outputs);
    this.high = resize(this.high, this.outputs);
    if (this.medians) this.medians = [...Array(offset * this.outputs), ...this.medians];
  }
  private slot(key: number) {
    if (this.keys) {
      let slot = this.keys.get(key);
      if (slot === undefined) {
        slot = this.keys.size;
        this.keys.set(key, slot);
        if (slot >= this.count.length) this.grow(Math.max(64, this.count.length * 2));
      }
      return slot;
    }
    // The planned range is an estimate; buckets outside it extend the arrays.
    if (!this.size) {
      this.origin = key;
      this.size = 1;
      this.grow(1);
    } else if (key < this.origin) {
      const shift = Math.max(this.origin - key, this.size);
      this.grow(this.size + shift, shift);
      this.origin -= shift;
      this.size += shift;
    } else if (key >= this.origin + this.size) {
      const size = Math.max(key - this.origin + 1, 2 * this.size);
      this.grow(size);
      this.size = size;
    }
    return key - this.origin;
  }
  /** Adds one run's packed summary from RunBuckets.finish. */
  addRun(summary: Float64Array) {
    const width = 2 + 3 * this.outputs;
    for (let i = 0; i < summary.length; i += width) {
      const slot = this.slot(summary[i]),
        n = ++this.count[slot],
        x = summary[i + 1];
      if (n === 1 || x > this.lastX[slot]) this.lastX[slot] = x;
      for (let o = 0; o < this.outputs; o++) {
        const cell = slot * this.outputs + o,
          value = summary[i + 2 + 3 * o],
          lo = summary[i + 3 + 3 * o],
          hi = summary[i + 4 + 3 * o];
        if (n === 1) {
          this.low[cell] = lo;
          this.high[cell] = hi;
        } else {
          if (lo < this.low[cell]) this.low[cell] = lo;
          if (hi > this.high[cell]) this.high[cell] = hi;
        }
        const magnitude = Math.abs(value);
        if (magnitude > 2 * this.scale[cell]) {
          const next = 2 ** Math.floor(Math.log2(magnitude)),
            ratio = this.scale[cell] / next;
          this.mean[cell] *= ratio;
          this.m2[cell] *= ratio * ratio;
          this.scale[cell] = next;
        }
        const scaled = this.scale[cell] ? value / this.scale[cell] : 0,
          delta = scaled - this.mean[cell];
        this.mean[cell] += delta / n;
        this.m2[cell] += delta * (scaled - this.mean[cell]);
        if (this.medians) (this.medians[cell] ||= []).push(value);
      }
    }
  }
  /**
   * Aggregated points in X order: the last X any member logged in the bucket, the member
   * count and [value, lower, upper] per output.
   */
  result(aggregation = 'mean', spread = 'none'): GroupPoint[] {
    const slots: number[] = [];
    if (this.keys)
      for (const [, slot] of [...this.keys].sort((a, b) => a[0] - b[0])) slots.push(slot);
    else for (let slot = 0; slot < this.size; slot++) if (this.count[slot]) slots.push(slot);
    return slots.map((slot) => {
      const n = this.count[slot],
        values: [number, number, number][] = [];
      for (let o = 0; o < this.outputs; o++) {
        const cell = slot * this.outputs + o,
          minimum = this.low[cell],
          maximum = this.high[cell],
          scale = this.scale[cell];
        let value: number;
        if (aggregation === 'min') value = minimum;
        else if (aggregation === 'max') value = maximum;
        else if (aggregation === 'median') {
          const sorted = this.medians![cell].sort((a, b) => a - b),
            a = sorted[Math.floor((n - 1) / 2)],
            b = sorted[Math.ceil((n - 1) / 2)],
            sum = a + b;
          value = Number.isFinite(sum) ? sum / 2 : a / 2 + b / 2;
        } else {
          // Run means lie within the run minima and maxima; rounding must not leave them.
          value = Math.max(minimum, Math.min(maximum, scale * this.mean[cell]));
        }
        const std = scale * Math.sqrt(Math.max(0, this.m2[cell]) / n),
          deviation = spread === 'stddev' ? std : spread === 'stderr' ? std / Math.sqrt(n) : 0;
        const band: [number, number, number] =
          spread === 'minmax'
            ? [value, minimum, maximum]
            : [value, value - deviation, value + deviation];
        if (!band.every(Number.isFinite)) throw recordTransformError('nonFinite');
        values.push(band);
      }
      return { x: this.lastX[slot], n, values };
    });
  }
}
