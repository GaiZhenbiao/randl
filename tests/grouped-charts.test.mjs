// Grouped charts: per-run bucket aggregation, member counts, computed and stacked groups,
// and selections beyond the 1,000-run chart limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { recordTransformLimits } from '../backend/dist/record-chart.js';
import { GroupBuckets, RunBuckets, planGroupBuckets } from '../backend/dist/group-chart.js';
import { ChartSelections, selectionToken } from '../backend/dist/chart-selection.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-grouped-')),
    store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}
function run(store, name, rows, config = {}) {
  const r = store.upsert({ entity: 'local', project: 'grouped', name, config });
  store.ingest(r.id, {
    files: {
      'wandb-history.jsonl': { offset: 0, content: rows.map((row) => JSON.stringify(row)) },
    },
    complete: true,
  });
  return r.id;
}
const steps = (from, to, every, row) => {
  const rows = [];
  for (let step = from; step <= to; step += every) rows.push({ _step: step, ...row(step) });
  return rows;
};

test('runs logging at different intervals share buckets and each counts once', async (t) => {
  const store = await fixture(t),
    dense = run(
      store,
      'dense',
      steps(0, 1023, 1, () => ({ loss: 1 })),
    ),
    sparse = run(
      store,
      'sparse',
      steps(0, 1023, 10, () => ({ loss: 3 })),
    ),
    late = run(
      store,
      'late',
      steps(512, 1023, 4, () => ({ loss: 5 })),
    );
  const data = store.chart({
      runs: [dense, sparse, late],
      metrics: ['loss'],
      pixels: 32,
      settings: { groupBy: 'all', aggregation: 'mean', spread: 'minmax' },
    }),
    values = data.series[0].values.loss,
    bands = data.series[0].bands.loss;
  // 64 buckets of 16 steps: every bucket holds the dense and the sparse run; the late run
  // starts halfway. Exact-X aggregation averaged a single run at 90% of the steps.
  assert.equal(data.bucketWidth, 16);
  assert.equal(values.length, 64);
  assert.deepEqual(
    bands.map((band) => band[3]),
    values.map((point) => (point[0] < 512 ? 2 : 3)),
  );
  for (const [x, value] of values) assert.equal(value, x < 512 ? 2 : 3);
  assert.ok(bands.every((band) => band[1] === 1 && band[2] === (band[0] < 512 ? 3 : 5)));
  // A point is placed at the last step any member logged in its bucket.
  assert.deepEqual(
    values.slice(0, 2).map((point) => point[0]),
    [15, 31],
  );
  assert.equal(data.sampled, true);
});

test('wall-clock groups aggregate runs whose timestamps never coincide', async (t) => {
  const store = await fixture(t),
    ids = [0, 1, 2].map((r) =>
      run(
        store,
        'wall' + r,
        steps(0, 999, 1, (step) => ({ _timestamp: 1.7e9 + r * 0.37 + step * (1 + r / 10), v: r })),
      ),
    );
  const data = store.chart({
    runs: ids,
    metrics: ['v'],
    pixels: 64,
    settings: { groupBy: 'all', xAxis: '_relative_wall', spread: 'stddev' },
  });
  const counts = data.series[0].bands.v.map((band) => band[3]);
  // Every run covers the first 999 seconds, so those buckets average all three runs.
  const shared = data.series[0].values.v.filter((point) => point[0] < 990);
  assert.ok(shared.length > 10);
  assert.ok(shared.every((point) => point[1] === 1));
  assert.ok(counts.slice(0, shared.length).every((count) => count === 3));
  assert.ok(counts.at(-1) === 1, 'only the slowest run reaches the end');
});

test('grouped computed metrics use a per-run budget and match their per-run results', async (t) => {
  const store = await fixture(t),
    inputs = recordTransformLimits.inputSlots;
  recordTransformLimits.inputSlots = 1000;
  t.after(() => (recordTransformLimits.inputSlots = inputs));
  // 400 records of two inputs per run: within the per-run limit, three runs exceed it together.
  const ids = [1, 2, 3].map((r) =>
    run(
      store,
      'rate' + r,
      steps(0, 399, 1, () => ({ hits: r, total: 4 })),
      { cohort: r === 3 ? 'b' : 'a' },
    ),
  );
  const transform = {
    kind: 'compute',
    expressions: [{ name: 'rate', expression: '${hits} / ${total}' }],
  };
  const ungrouped = store.chart({ runs: ids, metrics: ['rate'], recordTransform: transform });
  assert.deepEqual(
    ungrouped.series.map((series) => series.values.rate[0][1]),
    [0.25, 0.5, 0.75],
  );
  const grouped = store.chart({
    runs: ids,
    metrics: ['rate'],
    pixels: 64,
    recordTransform: transform,
    settings: { groupBy: 'config.cohort', aggregation: 'mean', spread: 'minmax' },
  });
  assert.deepEqual(
    grouped.series.map((series) => [series.name, series.runIds.length]),
    [
      ['a', 2],
      ['b', 1],
    ],
  );
  assert.ok(grouped.series[0].values.rate.every((point) => point[1] === 0.375));
  assert.ok(grouped.series[0].bands.rate.every((band) => band[1] === 0.25 && band[2] === 0.5));
  assert.ok(grouped.series[0].bands.rate.every((band) => band[3] === 2));
  assert.ok(grouped.series[0].values.rate.length <= 128 + 1);
  // A single run above the per-run limit is still refused when its points are cached.
  const large = run(
    store,
    'large',
    steps(0, 600, 1, () => ({ hits: 1, total: 2 })),
  );
  assert.throws(
    () => store.chart({ runs: [large], metrics: ['rate'], recordTransform: transform }),
    { code: 'CHART_TRANSFORM_INPUT_LIMIT', params: { limit: 500 } },
  );
});

test('grouped stacked areas bucket many distinct X values', async (t) => {
  const store = await fixture(t),
    ids = Array.from({ length: 40 }, (_, r) =>
      run(
        store,
        'stack' + r,
        steps(0, 999, 1, (step) => ({ epoch: step + r / 40, a: 1, b: 3 })),
      ),
    );
  // 40,000 distinct epochs: above the former 32,768 distinct-X limit per group.
  const data = store.chart({
    runs: ids,
    metrics: ['a', 'b'],
    pixels: 512,
    recordTransform: { kind: 'align', normalization: 'percent' },
    settings: { groupBy: 'all', xAxis: 'epoch' },
  });
  const { a, b } = data.series[0].values;
  assert.ok(a.length <= 1024 + 1);
  assert.deepEqual(
    a.map((point) => point[0]),
    b.map((point) => point[0]),
  );
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i][1] + b[i][1] - 100) < 1e-9);
  assert.equal(data.series[0].bands.a[0][3], 40);
});

test('bucket aggregation keeps large values finite and medians exact', () => {
  const plan = planGroupBuckets(
    [
      { n: 10, lo: 0, hi: 1000 },
      { n: 0, lo: null, hi: null },
    ],
    { buckets: 10, points: 1000 },
    1,
  );
  assert.equal(plan.width, 128);
  // Without downsampling, exact X positions are kept while every point fits.
  assert.equal(
    planGroupBuckets([{ n: 10, lo: 0, hi: 9 }], { buckets: null, points: 50 }, 1).width,
    null,
  );
  assert.ok(
    planGroupBuckets([{ n: 100, lo: 0, hi: 99 }], { buckets: null, points: 50 }, 1).width >= 2,
  );
  const groups = new GroupBuckets(1, 1, [0, 0], true);
  for (const value of [1.7e308, 1.7e308, -1.7e308, 5]) {
    const runBuckets = new RunBuckets(1, 1);
    runBuckets.add(0, [value]);
    groups.addRun(runBuckets.finish());
  }
  const [mean] = groups.result('mean', 'none'),
    [median] = groups.result('median', 'minmax');
  assert.equal(mean.n, 4);
  assert.ok(Number.isFinite(mean.values[0][0]));
  assert.ok(Math.abs(mean.values[0][0] - 1.7e308 / 4) / 1.7e308 < 1e-12);
  assert.deepEqual(median.values[0], [1.7e308 / 2 + 5 / 2, -1.7e308, 1.7e308]);
  assert.throws(() => groups.result('mean', 'stddev'), { code: 'CHART_TRANSFORM_NON_FINITE' });
});

test('selection tokens identify ordered run lists within a bounded store', () => {
  assert.equal(selectionToken(['a', 'b']), selectionToken(['a', 'b']));
  assert.notEqual(selectionToken(['a', 'b']), selectionToken(['b', 'a']));
  assert.notEqual(selectionToken(['ab']), selectionToken(['a', 'b']));
  const store = new ChartSelections(5),
    first = store.put(['a', 'b', 'c']),
    second = store.put(['d', 'e', 'f']);
  assert.equal(store.get(first), undefined, 'least recently used selection is forgotten');
  assert.deepEqual(store.get(second), ['d', 'e', 'f']);
});

test('grouped charts aggregate selections beyond the chart run limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-grouped-http-')),
    store = new Store(directory),
    ids = [];
  store.db.transaction(() => {
    for (let r = 0; r < 1500; r++)
      ids.push(
        run(
          store,
          'r' + String(r).padStart(4, '0'),
          steps(0, 199, 1 + (r % 3), (step) => ({ loss: (r % 2) + step / 1000 })),
          { parity: r % 2 },
        ),
      );
  })();
  store.db.close();
  const server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (url, payload) => server.app.inject({ method: 'POST', url, payload });
  const settings = { groupBy: 'config.parity', aggregation: 'mean', spread: 'stddev' };
  // A grouped request may name up to the selection limit inline; others keep the chart limit.
  assert.equal(
    (await post('/api/chart', { runs: ids, metrics: ['loss'], pixels: 64 })).statusCode,
    400,
  );
  const unknown = await post('/api/chart', {
    selection: selectionToken(ids),
    metrics: ['loss'],
    settings,
  });
  assert.equal(unknown.statusCode, 409);
  assert.equal(unknown.json().code, 'CHART_SELECTION_UNKNOWN');
  const registered = (await post('/api/chart-selections', { runs: ids })).json();
  assert.equal(registered.selection, selectionToken(ids));
  // Eight-step buckets: every run logs in every bucket.
  const response = await post('/api/chart', {
    selection: registered.selection,
    metrics: ['loss'],
    pixels: 16,
    settings,
  });
  assert.equal(response.statusCode, 200);
  const data = response.json();
  assert.deepEqual(
    data.series.map((series) => [series.name, series.runIds.length]),
    [
      ['0', 750],
      ['1', 750],
    ],
  );
  assert.ok(data.series[0].bands.loss.every((band) => band[3] === 750));
  const inline = (
    await post('/api/chart', { runs: ids, metrics: ['loss'], pixels: 16, settings })
  ).json();
  assert.deepEqual(inline.series, data.series);
  assert.equal(
    (
      await post('/api/chart', {
        selection: registered.selection,
        metrics: ['loss'],
        pixels: 16,
        settings,
        baseRevision: data.revision,
      })
    ).json().unchanged,
    true,
  );
  // The database worker serves other requests between slices of a grouped job, and an
  // abandoned job stops.
  const order = [];
  const job = server.db
    .job(new AbortController().signal, 'chartJob', {
      runs: ids,
      metrics: ['loss'],
      pixels: 1024,
      settings: { ...settings, xAxis: '_step', resolution: 'full' },
    })
    .then(() => order.push('grouped'));
  const quick = server.db.call('runRevisions', ids.slice(0, 1)).then(() => order.push('quick'));
  await Promise.all([job, quick]);
  assert.deepEqual(order, ['quick', 'grouped']);
  const controller = new AbortController(),
    abandoned = server.db.job(controller.signal, 'chartJob', {
      runs: ids,
      metrics: ['loss'],
      pixels: 2048,
      settings: { groupBy: 'config.parity', xMin: 1 },
    });
  controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
});

test('long computed and stacked charts are sliced jobs within a request-wide read limit', async (t) => {
  const store = await fixture(t),
    { isJob } = await import('../backend/dist/database.js'),
    limit = recordTransformLimits.requestValues;
  t.after(() => (recordTransformLimits.requestValues = limit));
  const ids = [1, 2, 3].map((r) =>
    run(
      store,
      'job' + r,
      steps(0, 9999, 1, () => ({ hits: r, total: 4 })),
    ),
  );
  const transform = {
      kind: 'compute',
      expressions: [{ name: 'rate', expression: '${hits} / ${total}' }],
    },
    request = { runs: ids, metrics: ['rate'], recordTransform: transform };
  for (const body of [
    request,
    { ...request, settings: { groupBy: 'all' } },
    {
      runs: ids,
      metrics: ['hits', 'total'],
      recordTransform: { kind: 'align', normalization: 'none' },
    },
  ]) {
    const job = store.chartJob(body);
    assert.ok(isJob(job));
    let slices = 0;
    for (let step = job.next(); !step.done; step = job.next()) slices++;
    // 30,000 records yield at least every 4,096 records.
    assert.ok(slices >= 7, String(slices));
  }
  assert.ok(isJob(store.chartPlan(request)));
  // Each run is within its own budget; together they exceed a lowered request limit.
  recordTransformLimits.requestValues = 25000;
  assert.throws(() => store.chart({ ...request, settings: { xMax: 5e9 } }), {
    code: 'CHART_TRANSFORM_REQUEST_SOURCE_LIMIT',
    params: { limit: 25000 },
  });
});
