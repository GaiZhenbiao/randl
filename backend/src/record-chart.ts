import { recordTransformError } from './record-chart-errors.js';
import {
  compileExpression,
  expressionLimits,
  validateComputedMetrics,
  type ComputedMetric,
} from './expressions.js';
import { chartResolution } from './chart-diff.js';
import type { HistoryStore } from './history-store.js';
type Row = Record<string, any>;
// Object.keys reorders integer property names. Imported JSON can retain a different
// textual order, and system custom axes use the last matching top-level key.
function systemAxisValue(raw: Row, content: string, axis: string): unknown {
  const prefixed = 'system.' + axis;
  if (
    !/^(0|[1-9]\d*)$/.test(axis) ||
    Number(axis) >= 4294967295 ||
    !Object.hasOwn(raw, axis) ||
    !Object.hasOwn(raw, prefixed)
  ) {
    let value: unknown;
    for (const key of Object.keys(raw)) if (key === axis || key === prefixed) value = raw[key];
    return value;
  }
  let depth = 0,
    value: unknown;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      const start = i++;
      for (; i < content.length; i++) {
        if (content[i] === '\\') i++;
        else if (content[i] === '"') break;
      }
      if (depth === 1) {
        let next = i + 1;
        while (/\s/.test(content[next] || '')) next++;
        if (content[next] === ':') {
          const key = JSON.parse(content.slice(start, i + 1));
          if (key === axis || key === prefixed) value = raw[key];
        }
      }
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return value;
}

type Store = {
  history: Pick<
    HistoryStore,
    'hasPoints' | 'stats' | 'series' | 'minValue' | 'lineStats' | 'lines'
  >;
  run: (id: string) => Row | undefined;
  metricSettings: (ids: string[], metrics?: string[]) => Row;
};
export type RecordTransform =
  | { kind: 'align'; normalization: 'none' | 'percent' }
  | { kind: 'compute'; expressions: ComputedMetric[]; align?: 'none' | 'percent' };
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
// One scan of every run's records: the inputs that must all be present in a record, the output
// series it produces, and the per-record evaluation (undefined omits the record).
export type Pass = {
  inputs: string[];
  outputs: string[];
  evaluate: (values: number[]) => number[] | undefined;
};
function percent(values: number[]) {
  if (values.some((value) => value < 0)) throw recordTransformError('negative');
  const maximum = Math.max(...values);
  if (maximum === 0) return;
  const total = values.reduce((sum, value) => sum + value / maximum, 0);
  return values.map((value) => (100 * (value / maximum)) / total);
}
/**
 * Computed metrics that are neither stacked nor grouped are planned, streamed and refined
 * like plain metrics: each run's computed points are cached and decimated per request.
 * Grouped transforms are aggregated per run on shared buckets (database groupedChart).
 */
export const streamedTransform = (args: Row) =>
  args.recordTransform?.kind === 'compute' &&
  !args.recordTransform.align &&
  !(args.settings?.groupBy && args.settings.groupBy !== 'none') &&
  args.mode !== 'snapshot';
/** Validates a transform against the requested series and returns the passes that compute it. */
export function recordPasses(value: any, metrics: string[], mode?: string): Pass[] {
  if (mode === 'snapshot') throw recordTransformError('historyRequired');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw recordTransformError('invalid');
  const keys =
    value.kind === 'compute' ? ['kind', 'expressions', 'align'] : ['kind', 'normalization'];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw recordTransformError('invalid');
  if (!metrics.length || metrics.length > expressionLimits.series)
    throw recordTransformError('metricLimit');
  let passes: Pass[];
  if (value.kind === 'align') {
    if (!['none', 'percent'].includes(value.normalization)) throw recordTransformError('invalid');
    passes = [
      {
        inputs: metrics,
        outputs: metrics,
        evaluate: value.normalization === 'percent' ? percent : (values) => values,
      },
    ];
  } else if (value.kind === 'compute') {
    if (value.align !== undefined && !['none', 'percent'].includes(value.align))
      throw recordTransformError('invalid');
    const parsed = validateComputedMetrics(value.expressions);
    if (JSON.stringify(parsed.map((item) => item.name)) !== JSON.stringify(metrics))
      throw recordTransformError('invalid');
    if (value.align) {
      // Stacked components: one record yields every computed value or none.
      const inputs = [...new Set(parsed.flatMap((item) => item.inputs))],
        compiled = parsed.map((item) => compileExpression(item.tree, inputs));
      passes = [
        {
          inputs,
          outputs: metrics,
          evaluate: (values) => {
            const outputs = compiled.map((fn) => fn(values));
            if (!outputs.every(finite)) return;
            return value.align === 'percent' ? percent(outputs) : outputs;
          },
        },
      ];
    } else
      passes = parsed.map((item) => {
        const fn = compileExpression(item.tree, item.inputs);
        return {
          inputs: item.inputs,
          outputs: [item.name],
          evaluate: (values) => {
            const result = fn(values);
            return finite(result) ? [result] : undefined;
          },
        };
      });
  } else throw recordTransformError('invalid');
  const inputs = passes.flatMap((pass) => pass.inputs);
  if (
    inputs.some((metric) => metric.startsWith('system/')) &&
    !inputs.every((metric) => metric.startsWith('system/'))
  )
    throw recordTransformError('oneStream');
  return passes;
}
// Select record indices once for every component. Endpoints and bucket extrema are
// candidates; only exceptionally small budgets need a deterministic candidate trim.
export function alignedSample(points: number[][], budget: number) {
  if (points.length <= budget) return points;
  const dimensions = points[0].length - 1,
    buckets = Math.max(1, Math.floor((budget - 2) / (2 * dimensions)));
  const lo = points[0][0],
    hi = points.at(-1)![0],
    scale = Math.max(Math.abs(lo), Math.abs(hi));
  const position = (index: number) =>
    lo === hi
      ? index / (points.length - 1)
      : (points[index][0] / scale - lo / scale) / (hi / scale - lo / scale);
  const selected = new Set<number>([0, points.length - 1]);
  let current = -1,
    minima: number[] = [],
    maxima: number[] = [];
  const flush = () => {
    for (const index of [...minima, ...maxima]) selected.add(index);
  };
  points.forEach((point, index) => {
    const bucket = Math.min(buckets - 1, Math.floor(position(index) * buckets));
    if (bucket !== current) {
      flush();
      current = bucket;
      minima = Array(dimensions).fill(index);
      maxima = [...minima];
    }
    for (let d = 0; d < dimensions; d++) {
      if (point[d + 1] < points[minima[d]][d + 1]) minima[d] = index;
      if (point[d + 1] > points[maxima[d]][d + 1]) maxima[d] = index;
    }
  });
  flush();
  let indices = [...selected].sort((a, b) => a - b);
  if (indices.length > budget) {
    const remaining = new Set(indices.slice(1, -1)),
      kept = [0, points.length - 1];
    for (let slot = 1; slot < budget - 1; slot++) {
      const target = slot / (budget - 1);
      const nearest = [...remaining].reduce((best, index) =>
        Math.abs(position(index) - target) < Math.abs(position(best) - target) ? index : best,
      );
      kept.push(nearest);
      remaining.delete(nearest);
    }
    indices = kept.sort((a, b) => a - b);
  }
  return indices.map((index) => points[index]);
}
// Compact transformed records while scanning, keeping shared indices for every
// component. At most twice the output-row budget is retained, even for custom X
// that goes backwards or repeats. Validation/evaluation still visits every record.
export function alignedCollector(budget: number) {
  let points: number[][] = [],
    sampled = false,
    count = 0;
  return {
    add(point: number[]) {
      count++;
      points.push(point);
      if (points.length >= 2 * budget) {
        points = alignedSample(
          points.sort((a, b) => a[0] - b[0]),
          budget,
        );
        sampled = true;
      }
    },
    finish() {
      const selected = alignedSample(
        points.sort((a, b) => a[0] - b[0]),
        budget,
      );
      return { points: selected, count, sampled: sampled || selected.length < points.length };
    },
  };
}
export function collectAligned(observations: Iterable<number[]>, budget: number) {
  const collector = alignedCollector(budget);
  for (const point of observations) collector.add(point);
  return collector.finish();
}
/**
 * Computed points of one pass as columns ordered by X: `xs` and one array of values per
 * output, 8 bytes a value, as compact as the stored series they come from.
 */
export type Columns = { xs: Float64Array; ys: Float64Array[] };
/** Collects points into growing columns; `finish` orders them by X, ties in arrival order. */
export function columnCollector(outputs: number) {
  const stride = outputs + 1;
  let data = new Float64Array(stride * 1024),
    count = 0,
    ordered = true;
  return {
    add(point: number[]) {
      if (count * stride + stride > data.length) {
        const grown = new Float64Array(data.length * 2);
        grown.set(data);
        data = grown;
      }
      if (count && point[0] < data[(count - 1) * stride]) ordered = false;
      data.set(point, count++ * stride);
    },
    finish(): Columns {
      let order: ArrayLike<number> | undefined;
      if (!ordered) {
        const indices = new Uint32Array(count);
        for (let i = 0; i < count; i++) indices[i] = i;
        indices.sort((a, b) => data[a * stride] - data[b * stride] || a - b);
        order = indices;
      }
      const xs = new Float64Array(count),
        ys = Array.from({ length: outputs }, () => new Float64Array(count));
      for (let i = 0; i < count; i++) {
        const at = (order ? order[i] : i) * stride;
        xs[i] = data[at];
        for (let o = 0; o < outputs; o++) ys[o][i] = data[at + 1 + o];
      }
      return { xs, ys };
    },
  };
}
// Records evaluated between yields of a record-chart job.
const recordsPerYield = 4096;
/**
 * Computes an ungrouped transformed chart as a job: the database worker advances it in
 * slices, so it yields every few thousand records. With `raw`, series keep every computed
 * point (sorted by X) so a caller can cache them and decimate per request. With `visit`,
 * each pass's observations of the single requested run are handed to the sink it returns,
 * in record order, and no series are built.
 */
export function* recordChartJob(
  store: Store,
  args: Row,
  options: {
    raw?: boolean;
    visit?: (pass: Pass) => { add: (point: number[]) => void; finish: () => void };
    /** The request's validated passes, when the caller computes runs one at a time. */
    passes?: Pass[];
  } = {},
): Generator<void, Row> {
  const requested = [...new Set<string>(args.metrics || [])],
    transform = args.recordTransform as RecordTransform;
  const passes = options.passes ?? recordPasses(transform, requested, args.mode);
  const inputs = [...new Set(passes.flatMap((pass) => pass.inputs))];
  const metrics = passes.flatMap((pass) => pass.outputs);
  const settings = { ...args.settings },
    limit = typeof settings.maxRuns === 'number' ? settings.maxRuns : undefined;
  const ids = [...new Set<string>(args.runs)].slice(0, limit);
  if (!settings.xAxis) {
    const definitions = store.metricSettings(ids, [inputs[0]]);
    if (definitions[inputs[0]]?.stepMetric) settings.xAxis = definitions[inputs[0]].stepMetric;
  }
  const system = inputs.every((metric) => metric.startsWith('system/'));
  const xAxis = settings.xAxis || (system ? '_timestamp' : '_step');
  // The panel's resolution sets the buckets across the plot; each metric keeps a minimum
  // and maximum per bucket. Records are sampled without aligned bucket widths, so a
  // refinement replaces series rather than adding points.
  // Each pass samples its own outputs: a minimum and maximum per bucket for each of them,
  // within the request's point limit shared by every output of every group.
  const resolution = chartResolution(settings.resolution, args.pixels),
    budgetFor = (pass: Pass) =>
      Math.max(
        2,
        Math.min(
          resolution.buckets === null ? Infinity : 2 * pass.outputs.length * resolution.buckets + 2,
          Math.floor(resolution.points / Math.max(1, ids.length * metrics.length)),
        ),
      );
  let omittedRecords = 0,
    sampled = false,
    totalPoints = 0,
    work = 0;
  // Applies a pass to one record; undefined omits it.
  function transformRecord(pass: Pass, value: (metric: string) => unknown): number[] | undefined {
    const values = pass.inputs.map(value);
    if (!values.every(finite)) {
      omittedRecords++;
      return;
    }
    const output = pass.evaluate(values);
    if (!output) {
      omittedRecords++;
      return;
    }
    return output;
  }
  // History is read from the point store, which holds one value per run, metric and step:
  // a record's numeric fields at its _step (or, without one, its line offset), the latest
  // record winning when a resumed run logs a step again, as plain charts show it. Joining
  // the inputs on the step pairs each step's values without parsing JSON. The steps are
  // those of _step and of the inputs, so records without _step take part too.
  function* pointObservations(
    pass: Pass,
    id: string,
    bounded: boolean,
    missing: boolean,
    origin: number | null,
  ): Generator<number[] | null> {
    const xValues =
        xAxis === '_step'
          ? undefined
          : store.history.series(id, xAxis === '_relative_wall' ? '_timestamp' : xAxis),
      inputs = missing ? [] : pass.inputs.map((metric) => store.history.series(id, metric)),
      positions = inputs.map(() => 0),
      sources = [store.history.series(id, '_step').steps, ...inputs.map((input) => input.steps)],
      cursors = sources.map(() => 0);
    let xp = 0,
      considered = 0,
      retained = 0;
    for (;;) {
      // The next step of any source: their union, in order.
      let step = Infinity;
      for (let i = 0; i < sources.length; i++)
        if (cursors[i] < sources[i].length && sources[i][cursors[i]] < step)
          step = sources[i][cursors[i]];
      if (step === Infinity) break;
      for (let i = 0; i < sources.length; i++) if (sources[i][cursors[i]] === step) cursors[i]++;
      // null asks the job to yield.
      if (++work % recordsPerYield === 0) yield null;
      let x: number | null = step;
      if (xValues) {
        while (xp < xValues.steps.length && xValues.steps[xp] < step) xp++;
        x = xValues.steps[xp] === step ? xValues.values[xp] : null;
      }
      if (x !== null) {
        if (xAxis === '_timestamp') x *= 1000;
        else if (xAxis === '_relative_wall') x = origin === null ? null : x - origin;
      }
      if (
        bounded &&
        (!finite(x) ||
          (finite(settings.xMin) && x < settings.xMin) ||
          (finite(settings.xMax) && x > settings.xMax))
      )
        continue;
      considered++;
      if (missing || !finite(x)) continue;
      const values: number[] = [];
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        while (positions[i] < input.steps.length && input.steps[positions[i]] < step)
          positions[i]++;
        if (input.steps[positions[i]] !== step) break;
        values.push(input.values[positions[i]]);
      }
      if (values.length !== inputs.length) continue;
      retained++;
      const output = transformRecord(pass, (metric) => values[pass.inputs.indexOf(metric)]);
      if (output) yield [x, ...output];
    }
    omittedRecords += considered - retained;
  }
  function* observations(pass: Pass, id: string): Generator<number[] | null> {
    const file = system ? 'wandb-events.jsonl' : 'wandb-history.jsonl',
      bounded = finite(settings.xMin) || finite(settings.xMax);
    const missing = pass.inputs.some((metric) => !store.history.hasPoints(id, metric));
    if (missing && !bounded) {
      omittedRecords += store.history.lineStats(id, file).records;
      return;
    }
    const origin =
      xAxis === '_relative_wall'
        ? store.history.minValue(id, system ? 'system/_timestamp' : '_timestamp')
        : null;
    if (xAxis === '_relative_wall' && !finite(origin)) {
      if (!bounded) omittedRecords += store.history.lineStats(id, file).records;
      return;
    }
    if (!system) {
      yield* pointObservations(pass, id, bounded, missing, origin);
      return;
    }
    // System events are read record by record, a page of lines at a time: their custom axes
    // follow the record's own keys.
    for (const entry of store.history.lines(id, file)) {
      if (++work % recordsPerYield === 0) yield null;
      const raw = JSON.parse(entry.content),
        value = ['_step', '_timestamp', '_relative_wall'].includes(xAxis)
          ? (raw._timestamp ?? entry.offset)
          : systemAxisValue(raw, entry.content, xAxis);
      let x = typeof value === 'number' ? value : null;
      if (x !== null) {
        if (xAxis === '_timestamp' || xAxis === '_step') x *= 1000;
        if (xAxis === '_relative_wall') x = origin === null ? null : x - origin;
      }
      if (
        bounded &&
        (!finite(x) ||
          (finite(settings.xMin) && x < settings.xMin) ||
          (finite(settings.xMax) && x > settings.xMax))
      )
        continue;
      if (missing || !finite(x)) {
        omittedRecords++;
        continue;
      }
      const row: Row = Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [
          'system/' + key.replace(/^system\./, ''),
          value,
        ]),
      );
      const output = transformRecord(pass, (metric) =>
        Object.hasOwn(row, metric) ? row[metric] : undefined,
      );
      if (output) yield [x, ...output];
    }
  }
  if (options.visit) {
    for (const pass of passes) {
      const sink = options.visit(pass);
      for (const point of observations(pass, ids[0]))
        if (point) sink.add(point);
        else yield;
      sink.finish();
    }
    return { omittedRecords } as Row;
  }
  const series = [];
  for (const id of ids) {
    const values: Record<string, number[][] | Columns> = {};
    for (const pass of passes) {
      const outputs = pass.outputs;
      // With `raw`, every point is kept, as columns; otherwise points are reduced to the
      // pass's budget as they are read.
      if (options.raw) {
        const collector = columnCollector(outputs.length);
        for (const point of observations(pass, id))
          if (point) collector.add(point);
          else yield;
        const { xs, ys } = collector.finish();
        outputs.forEach((metric, index) => (values[metric] = { xs, ys: [ys[index]] }));
        continue;
      }
      const collector = alignedCollector(budgetFor(pass));
      for (const point of observations(pass, id))
        if (point) collector.add(point);
        else yield;
      const collected = collector.finish(),
        points = collected.points;
      sampled ||= collected.sampled;
      totalPoints += collected.count * outputs.length;
      outputs.forEach((metric, index) => {
        values[metric] = points.map((point) => [point[0], point[1 + index]]);
      });
    }
    series.push({ id, name: store.run(id)?.display_name || id, values });
    yield;
  }
  return {
    sampled,
    metrics,
    series,
    xAxis,
    recordTransform: transform,
    omittedRecords,
    ...(resolution.level === 'full' && sampled
      ? { resolution: 'full', pointLimit: { limit: resolution.points, total: totalPoints } }
      : {}),
  } as Row;
}
