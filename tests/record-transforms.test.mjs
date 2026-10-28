import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-record-transform-')),
    store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}
function run(store, name, rows) {
  const r = store.upsert({ entity: 'local', project: 'transform', name });
  store.ingest(r.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content: rows.map(JSON.stringify) } },
    complete: true,
  });
  return r.id;
}
// The former ratio transform as a computed metric; expected values are the ratio's results.
const compute = (...pairs) => ({
  kind: 'compute',
  expressions: pairs.map(([name, expression]) => ({ name, expression })),
});
const divide = compute(['a / b', '${a} / ${b}']);
const align = { kind: 'align', normalization: 'none' };
test('division pairs only the same raw record, retains repeated custom X and skips missing/zero/nonfinite inputs', async (t) => {
  const store = await fixture(t),
    id = run(store, 'ratio', [
      { _step: 0, epoch: 1, a: 2 },
      { _step: 0, epoch: 1, b: 4 },
      { _step: 1, epoch: 2, a: 4, b: 2 },
      { _step: 2, epoch: 2, a: 9, b: 3 },
      { _step: 3, epoch: 3, a: 1, b: 0 },
      { _step: 4, epoch: 4, a: null, b: 1 },
      { _step: 5, epoch: 5, a: 1e308, b: 1e-308 },
    ]);
  const data = store.chart({
    runs: [id],
    metrics: ['a / b'],
    settings: { xAxis: 'epoch' },
    recordTransform: divide,
  });
  assert.deepEqual(data.metrics, ['a / b']);
  assert.deepEqual(data.series[0].values['a / b'], [
    [2, 2],
    [2, 3],
  ]);
  assert.equal(data.omittedRecords, 5);
});
test('ratio is calculated before between-run aggregation and spread', async (t) => {
  const store = await fixture(t),
    first = run(store, 'one', [{ _step: 0, a: 1, b: 1 }]),
    second = run(store, 'two', [{ _step: 0, a: 9, b: 3 }]);
  const data = store.chart({
    runs: [first, second],
    metrics: ['a / b'],
    settings: { groupBy: 'all', aggregation: 'mean', spread: 'minmax' },
    recordTransform: divide,
  });
  assert.deepEqual(data.series[0].values['a / b'], [[0, 2]]);
  // Bands report the number of runs aggregated at each X.
  assert.deepEqual(data.series[0].bands['a / b'], [[0, 1, 3, 2]]);
});
test('aligned components omit incomplete records and percentage uses only selected components per record', async (t) => {
  const store = await fixture(t),
    id = run(store, 'aligned', [
      { _step: 0, a: 10 },
      { _step: 1, b: 3 },
      { _step: 2, a: 2, b: 6, excluded: 1000 },
      { _step: 3, a: 0, b: 0 },
      { _step: 4, a: 1e308, b: 1e308 },
    ]);
  const plain = store.chart({ runs: [id], metrics: ['a', 'b'], recordTransform: align });
  assert.deepEqual(plain.series[0].values.a, [
    [2, 2],
    [3, 0],
    [4, 1e308],
  ]);
  assert.deepEqual(plain.series[0].values.b, [
    [2, 6],
    [3, 0],
    [4, 1e308],
  ]);
  const percent = store.chart({
    runs: [id],
    metrics: ['a', 'b'],
    recordTransform: { kind: 'align', normalization: 'percent' },
  });
  assert.deepEqual(
    percent.series[0].values.a.map((point) => point[0]),
    [2, 4],
  );
  assert.ok(Math.abs(percent.series[0].values.a[0][1] - 25) < 1e-12);
  assert.equal(percent.series[0].values.a[1][1], 50);
  assert.deepEqual(
    percent.series[0].values.b.map((point) => point[0]),
    [2, 4],
  );
  assert.ok(Math.abs(percent.series[0].values.b[0][1] - 75) < 1e-12);
  assert.equal(percent.series[0].values.b[1][1], 50);
  const negative = run(store, 'negative', [{ _step: 0, a: -1, b: 4 }]);
  assert.throws(
    () =>
      store.chart({
        runs: [negative],
        metrics: ['a', 'b'],
        recordTransform: { kind: 'align', normalization: 'percent' },
      }),
    { code: 'CHART_TRANSFORM_NEGATIVE' },
  );
});
test('shared downsampling preserves component spikes and aligned X within the requested budget', async (t) => {
  const store = await fixture(t),
    id = run(
      store,
      'spikes',
      Array.from({ length: 1000 }, (_, i) => ({
        _step: i,
        a: i === 101 ? 100 : 0,
        b: i === 889 ? 200 : 0,
      })),
    );
  const data = store.chart({
      runs: [id],
      metrics: ['a', 'b'],
      pixels: 16,
      settings: { resolution: 'low' },
      recordTransform: align,
    }),
    values = data.series[0].values;
  assert.equal(data.sampled, true);
  // Low: one bucket per two of 16 pixels, a minimum and maximum per metric.
  assert.ok(values.a.length <= 2 * 2 * 8 + 2);
  assert.deepEqual(
    values.a.map((p) => p[0]),
    values.b.map((p) => p[0]),
  );
  assert.ok(values.a.some((p) => p[0] === 101 && p[1] === 100));
  assert.ok(values.b.some((p) => p[0] === 889 && p[1] === 200));
  assert.equal(values.a[0][0], 0);
  assert.equal(values.a.at(-1)[0], 999);
});
test('aligned grouped bands share one set of indices and retain between-run spread spikes', async (t) => {
  const store = await fixture(t),
    rows = Array.from({ length: 1000 }, (_, i) => ({ _step: i, a: 1, b: 1 }));
  const first = run(store, 'baseline', rows),
    second = run(
      store,
      'spread',
      rows.map((r, i) => ({ ...r, a: i === 333 ? 50 : 1, b: i === 777 ? 70 : 1 })),
    );
  const data = store.chart({
      runs: [first, second],
      metrics: ['a', 'b'],
      pixels: 32,
      settings: { groupBy: 'all', aggregation: 'median', spread: 'minmax', resolution: 'low' },
      recordTransform: align,
    }),
    series = data.series[0];
  const xs = series.values.a.map((p) => p[0]);
  assert.deepEqual(
    xs,
    series.values.b.map((p) => p[0]),
  );
  assert.deepEqual(
    xs,
    series.bands.a.map((p) => p[0]),
  );
  // Spikes keep their value in the band of the bucket that contains them.
  const width = data.bucketWidth,
    bucket = (x) => Math.floor(x / width);
  assert.ok(series.bands.a.some((p) => bucket(p[0]) === bucket(333) && p[2] === 50));
  assert.ok(series.bands.b.some((p) => bucket(p[0]) === bucket(777) && p[2] === 70));
  assert.ok(series.bands.a.every((p) => p[3] === 2));
  assert.ok(xs.length <= 16 + 1);
});
test('transform HTTP schema and revision identity distinguish transformations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-transform-http-')),
    server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = await server.db.call('upsert', {
    entity: 'local',
    project: 'transform',
    name: 'http',
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': { offset: 0, content: [JSON.stringify({ _step: 0, a: 2, b: 4 })] },
    },
  });
  const body = { runs: [run.id], metrics: ['a', 'b'], recordTransform: align };
  const get = (payload) => server.app.inject({ method: 'POST', url: '/api/chart', payload });
  const plain = (await get(body)).json(),
    percent = (
      await get({ ...body, recordTransform: { kind: 'align', normalization: 'percent' } })
    ).json();
  assert.notEqual(plain.revision, percent.revision);
  assert.equal((await get({ ...body, baseRevision: plain.revision })).json().unchanged, true);
  assert.equal(
    (await get({ ...body, recordTransform: { kind: 'align', normalization: 'unknown' } }))
      .statusCode,
    400,
  );
  assert.equal((await get({ ...body, mode: 'snapshot' })).statusCode, 400);
  assert.equal((await get({ ...body, recordTransform: divide })).statusCode, 400);
  const unsafe = await get({
    ...body,
    metrics: ['x'],
    recordTransform: compute(['x', '${a}.constructor']),
  });
  assert.equal(unsafe.statusCode, 400);
  assert.equal(unsafe.json().code, 'EXPRESSION_UNEXPECTED');
  assert.deepEqual(unsafe.json().params, { token: '.', position: 5, name: 'x' });
  assert.equal(
    (await get({ ...body, metrics: ['a / b'], recordTransform: divide })).json().series[0].values[
      'a / b'
    ][0][1],
    0.5,
  );
});

test('groups weight each run equally, whatever its records per X', async (t) => {
  const store = await fixture(t),
    a = run(store, 'repeat-a', [
      { _step: 0, a: 1 },
      { _step: 0, a: 3 },
    ]),
    b = run(store, 'repeat-b', [{ _step: 0, a: 10 }]);
  const result = store.chart({
    runs: [a, b],
    metrics: ['a'],
    settings: { groupBy: 'all' },
    recordTransform: align,
  });
  // Run means 2 and 10; the point store keeps the last value per step (3 and 10).
  assert.equal(result.series[0].values.a[0][1], 6);
  assert.equal(
    store.chart({ runs: [a, b], metrics: ['a'], settings: { groupBy: 'all' } }).series[0].values
      .a[0][1],
    6.5,
  );
});

test('system-event transforms preserve units, bounds and normalized custom keys', async (t) => {
  const store = await fixture(t),
    r = store.upsert({ entity: 'local', project: 'transform', name: 'system' });
  store.ingest(r.id, {
    files: {
      'wandb-events.jsonl': {
        offset: 0,
        content: [
          { _timestamp: 10, 'system.cpu': 2, 'system.gpu': 6, epoch: 1, 'system.epoch': 2 },
          { _timestamp: 11, 'system.cpu': 4, 'system.gpu': 4, epoch: 3 },
        ].map(JSON.stringify),
      },
    },
    complete: true,
  });
  const body = { runs: [r.id], metrics: ['system/cpu', 'system/gpu'], recordTransform: align };
  assert.deepEqual(store.chart(body).series[0].values['system/cpu'], [
    [10000, 2],
    [11000, 4],
  ]);
  assert.deepEqual(
    store.chart({ ...body, settings: { xAxis: '_relative_wall' } }).series[0].values['system/cpu'],
    [
      [0, 2],
      [1, 4],
    ],
  );
  assert.deepEqual(
    store.chart({ ...body, settings: { xAxis: 'epoch', xMin: 2, xMax: 2 } }).series[0].values[
      'system/cpu'
    ],
    [[2, 2]],
  );
  const percent = store.chart({
    ...body,
    recordTransform: { kind: 'align', normalization: 'percent' },
    settings: { xAxis: '_timestamp', xMin: 11000 },
  });
  assert.deepEqual(percent.series[0].values['system/gpu'], [[11000, 50]]);
});

test('subnormal and extreme grouped values remain bounded or report an explicit spread error', async (t) => {
  const store = await fixture(t),
    ids = ['tiny-a', 'tiny-b'].map((name) => run(store, name, [{ _step: 0, a: Number.MIN_VALUE }]));
  for (const aggregation of ['mean', 'median']) {
    const data = store.chart({
      runs: ids,
      metrics: ['a'],
      settings: { groupBy: 'all', aggregation, spread: 'minmax' },
      recordTransform: align,
    });
    assert.equal(data.series[0].values.a[0][1], Number.MIN_VALUE);
    assert.deepEqual(data.series[0].bands.a[0], [0, Number.MIN_VALUE, Number.MIN_VALUE, 2]);
  }
  const large = [0, 1.7e308, 1.7e308].map((a, i) => run(store, 'large-' + i, [{ _step: 0, a }]));
  assert.throws(
    () =>
      store.chart({
        runs: large,
        metrics: ['a'],
        settings: { groupBy: 'all', spread: 'stddev' },
        recordTransform: align,
      }),
    { code: 'CHART_TRANSFORM_NON_FINITE' },
  );
});

test('incomplete negative percent records are omitted and computed metric requests are validated', async (t) => {
  const store = await fixture(t),
    id = run(store, 'negative-sparse', [
      { _step: 0, a: -5 },
      { _step: 1, a: 2, b: 2 },
    ]);
  const data = store.chart({
    runs: [id],
    metrics: ['a', 'b'],
    recordTransform: { kind: 'align', normalization: 'percent' },
  });
  assert.deepEqual(data.series[0].values.a, [[1, 50]]);
  assert.equal(data.omittedRecords, 1);
  assert.throws(() => store.chart({ runs: [id], metrics: ['a', 'b'], recordTransform: divide }), {
    code: 'CHART_TRANSFORM_INVALID',
  });
  assert.throws(
    () =>
      store.chart({
        runs: [id],
        metrics: ['r', 'r'],
        recordTransform: compute(['r', '${a}'], ['r', '${b}']),
      }),
    { code: 'COMPUTED_METRIC_DUPLICATE' },
  );
  assert.throws(
    () =>
      store.chart({ runs: [id], metrics: ['r'], recordTransform: compute(['r', 'Math.random()']) }),
    { code: 'EXPRESSION_UNKNOWN_MATH' },
  );
});

test('aligned small budgets spread candidates across fractional and extreme X ranges', async () => {
  const { alignedSample } = await import('../backend/dist/record-chart.js');
  for (const scale of [1, 1.7e308]) {
    const points = Array.from({ length: 2000 }, (_, i) => [
      scale * ((i / 1999) * 2 - 1),
      ...Array.from({ length: 8 }, (_, m) => Math.sin((i * (m + 1)) / 17)),
    ]);
    const result = alignedSample(points, 16);
    assert.equal(result.length, 16);
    assert.deepEqual(result[0], points[0]);
    assert.deepEqual(result.at(-1), points.at(-1));
    assert.ok(result.every((point) => point.every(Number.isFinite)));
  }
  const constant = Array.from({ length: 2000 }, (_, i) => [0, Math.sin(i / 10)]);
  assert.ok(alignedSample(constant, 64).length > 30);
});

test('aligned charts exceed the old input budget; raw computation limits remain', async (t) => {
  const store = await fixture(t),
    metrics = Array.from({ length: 8 }, (_, i) => 'm' + i);
  const id = run(
    store,
    'slot-limit',
    Array.from({ length: 62501 }, (_, i) => ({
      _step: i,
      ...Object.fromEntries(metrics.map((metric) => [metric, i])),
    })),
  );
  const large = store.chart({ runs: [id], metrics, recordTransform: align });
  assert.equal(large.sampled, true);
  assert.ok(
    Object.values(large.series[0].values).reduce((n, points) => n + points.length, 0) <= 100000,
  );
  assert.equal(large.series[0].values.m0.at(-1)[0], 62500);
  assert.throws(
    () =>
      store.chart({
        runs: [id],
        metrics: ['sum'],
        recordTransform: compute(['sum', metrics.map((m) => '${' + m + '}').join('+')]),
      }),
    {
      code: 'CHART_TRANSFORM_INPUT_LIMIT',
      params: { limit: 62500 },
    },
  );
  // Grouped aggregates are bucketed, so a long run needs no distinct-X limit.
  const grouped = store.chart({
    runs: [id],
    metrics,
    pixels: 1024,
    settings: { groupBy: 'all' },
    recordTransform: align,
  });
  assert.equal(grouped.sampled, true);
  assert.ok(grouped.series[0].values.m0.length <= 2048 + 1);
  // A bucket is placed at its last logged X and holds the mean of the run's records in it.
  const last = grouped.series[0].values.m0.at(-1);
  assert.equal(last[0], 62500);
  assert.ok(last[1] < 62500 && last[1] > 62500 - grouped.bucketWidth);
  const computed = store.chart({
    runs: [id],
    metrics: ['sum', 'first'],
    recordTransform: {
      ...compute(['sum', metrics.map((m) => '${' + m + '}').join('+')], ['first', '${m0}']),
      align: 'none',
    },
  });
  assert.equal(computed.series[0].values.sum.at(-1)[1], 500000);
  const copy = store.upsert({ entity: 'local', project: 'transform', name: 'full-budget' });
  store.history.transaction(()=>{
    const target=store.history.runKey(copy.id),file=store.history.ensureFileId('wandb-history.jsonl');
    let cursor=-1;for(;;){const page=store.history.linePage(id,'wandb-history.jsonl',cursor);if(!page.length)break;for(const row of page)store.history.linePut(target,file,row.offset,row.content);cursor=page.at(-1).offset;}
    for(const metric of store.history.metricCounts(id).keys()){const data=store.history.series(id,metric),mid=store.history.ensureMetricId(metric);data.steps.forEach((step,i)=>store.history.pointPut(target,mid,step,data.values[i]));}
    store.history.finishWrites(target);
  });
  const full = store.chart({
    runs: [id, copy.id],
    metrics,
    settings: { resolution: 'full' },
    recordTransform: align,
  });
  assert.equal(full.sampled, true);
  assert.deepEqual(full.pointLimit, { limit: 500000, total: 1000016 });
  assert.ok(
    full.series.reduce(
      (count, series) =>
        count + Object.values(series.values).reduce((n, points) => n + points.length, 0),
      0,
    ) <= 500000,
  );
  const ranged = store.chart({
    runs: [id],
    metrics,
    settings: { xMin: 0, xMax: 10 },
    recordTransform: align,
  });
  assert.equal(ranged.series[0].values.m0.length, 11);
  store.history.transaction(()=>{store.history.pointPut(store.history.runKey(id),store.history.metricId('m0'),62500,-1);store.history.finishWrites(store.history.runKey(id));});
  assert.throws(
    () =>
      store.chart({
        runs: [id],
        metrics,
        recordTransform: { kind: 'align', normalization: 'percent' },
      }),
    { code: 'CHART_TRANSFORM_NEGATIVE' },
  );
  const missing = store.chart({
    runs: [id],
    metrics: metrics.map((metric) => 'missing' + metric),
    recordTransform: align,
  });
  assert.deepEqual(missing.series[0].values.missingm0, []);
  assert.equal(missing.omittedRecords, 62501);
  assert.equal(
    store.chart({
      runs: [id],
      metrics: ['m0'],
      settings: { groupBy: 'all', xMax: 10 },
      recordTransform: align,
    }).series[0].values.m0.length,
    11,
  );
});

test('literal metric/custom-X names and omitted-record range semantics stay exact', async (t) => {
  const store = await fixture(t),
    axis = 'phase."quoted"/轴';
  const id = run(store, 'literal', [
    { _step: 0, [axis]: null, 'config.value': 1, b: 1 },
    { _step: 1, [axis]: 1, 'config.value': 2 },
    { _step: 2, [axis]: 2, 'config.value': 3, b: 3 },
    { _step: 3, [axis]: 3, 'config.value': 4, b: 4 },
  ]);
  const body = {
    runs: [id],
    metrics: ['ratio'],
    settings: { xAxis: axis },
    recordTransform: compute(['ratio', '${config.value} / ${b}']),
  };
  const full = store.chart(body);
  assert.deepEqual(full.series[0].values.ratio, [
    [2, 1],
    [3, 1],
  ]);
  assert.equal(full.omittedRecords, 2);
  const ranged = store.chart({ ...body, settings: { xAxis: axis, xMin: 2, xMax: 2 } });
  assert.deepEqual(ranged.series[0].values.ratio, [[2, 1]]);
  assert.equal(ranged.omittedRecords, 0);
});

test('source-byte limits use UTF8 stored bytes before parsing oversized records', async (t) => {
  const store = await fixture(t),
    // Without its own _step the record must be parsed, so the byte limits apply.
    id = run(store, 'wide-record', [{ a: 1, note: '中'.repeat(350000) }]);
  assert.throws(() => store.chart({ runs: [id], metrics: ['a'], recordTransform: align }), {
    code: 'CHART_TRANSFORM_RECORD_BYTES_LIMIT',
    params: { limit: 1 },
  });
  assert.deepEqual(store.chart({ runs: [id], metrics: ['a'] }).series[0].values.a, [[0, 1]]);
  // With unique steps the point store answers without reading the record.
  const stepped = run(store, 'wide-stepped', [{ _step: 0, a: 1, note: '中'.repeat(350000) }]);
  assert.deepEqual(
    store.chart({ runs: [stepped], metrics: ['a'], recordTransform: align }).series[0].values.a,
    [[0, 1]],
  );
  const overflow = store.upsert({ entity: 'local', project: 'transform', name: 'wide-source' });
  store.history.pointPut(store.history.runKey(overflow.id),store.history.ensureMetricId('a'),0,1);
  const insert = store.db.prepare(
    "INSERT INTO stream_tail VALUES(?,?,?,?)",
  );
  store.db.transaction(() => {
    for (let i = 0; i < 129; i++) insert.run(store.history.runKey(overflow.id),store.history.ensureFileId('wandb-history.jsonl'),i,JSON.stringify({a:1,note:'x'.repeat(1048400)}));
  })();
  assert.throws(
    () => store.chart({ runs: [overflow.id], metrics: ['a'], recordTransform: align }),
    { code: 'CHART_TRANSFORM_SOURCE_BYTES_LIMIT', params: { limit: 128 } },
  );
});

test('sparse eval metrics consume only usable records under the input limit', async (t) => {
  const store = await fixture(t),
    rows = Array.from({ length: 130000 }, (_, i) => ({
      _step: i,
      loss: i,
      ...(i % 1000 === 0 ? { ea: 2, eb: 4 } : {}),
    }));
  const id = run(store, 'sparse-eval', rows);
  const result = store.chart({
    runs: [id],
    metrics: ['ratio'],
    recordTransform: compute(['ratio', '${ea} / ${eb}']),
  });
  assert.equal(result.series[0].values.ratio.length, 130);
  assert.equal(result.omittedRecords, 129870);
  assert.ok(result.series[0].values.ratio.every((point) => point[1] === 0.5));
});

test('source-record preflight bounds scans even with a narrow requested range', async (t) => {
  const store = await fixture(t),
    r = store.upsert({ entity: 'local', project: 'transform', name: 'source-count' });
  store.history.pointPut(store.history.runKey(r.id),store.history.ensureMetricId('a'),0,1);
  store.db
    .prepare(
      "WITH RECURSIVE records(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM records WHERE n<1000000) INSERT INTO stream_tail SELECT ?,?,n,? FROM records",
    )
    .run(store.history.runKey(r.id),store.history.ensureFileId('wandb-history.jsonl'),JSON.stringify({ _step: 0, a: 1 }));
  assert.throws(
    () =>
      store.chart({
        runs: [r.id],
        metrics: ['a'],
        settings: { xMin: 0, xMax: 0 },
        recordTransform: align,
      }),
    { code: 'CHART_TRANSFORM_SOURCE_RECORD_LIMIT', params: { limit: 1000000 } },
  );
});

test('computed metrics are stored through the shared tools and refused where unsupported', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-computed-panel-')),
    server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const plugins = await server.tools.execute('plugins_list', {});
  for (const id of ['line', 'area', 'stacked-area', 'percent-area'])
    assert.ok(plugins.find((plugin) => plugin.id === id).settings.common.includes('expressions'), id);
  assert.ok(!plugins.find((plugin) => plugin.id === 'bar').settings.common.includes('expressions'));
  assert.ok(!plugins.some((plugin) => plugin.settings.common.includes('ratio')));
  const view = await server.tools.execute('view_create', { name: 'Computed', project: 'local/x' });
  const added = await server.tools.execute('panel_add', {
    view: view.id,
    plugin: 'line',
    expressions: [{ name: 'Truncation rate', expression: '${truncations} / ${episodes}' }],
  });
  const panel = added.body.panels[0];
  assert.deepEqual(panel.expressions, [
    { name: 'Truncation rate', expression: '${truncations} / ${episodes}' },
  ]);
  assert.deepEqual(panel.metrics, []);
  assert.equal(panel.metric, 'Truncation rate');
  assert.equal(panel.title, 'Truncation rate');
  await assert.rejects(
    server.tools.execute('panel_update', {
      view: view.id,
      id: panel.id,
      expressions: [{ name: 'x', expression: 'globalThis.process' }],
    }),
    { code: 'EXPRESSION_UNKNOWN_NAME', statusCode: 400 },
  );
  await assert.rejects(
    server.tools.execute('panel_update', { view: view.id, id: panel.id, plugin: 'bar' }),
    /does not support computed metrics/,
  );
  const mixed = await server.tools.execute('panel_update', {
    view: view.id,
    id: panel.id,
    metrics: ['loss'],
  });
  assert.deepEqual(mixed.body.panels[0].metrics, ['loss']);
  assert.equal(mixed.body.panels[0].expressions.length, 1);
  const cleared = await server.tools.execute('panel_update', {
    view: view.id,
    id: panel.id,
    expressions: null,
  });
  assert.equal(cleared.body.panels[0].expressions, undefined);
  const duplicate = await server.app.inject({
    method: 'PUT',
    url: '/api/views/' + view.id,
    payload: {
      name: view.name,
      project: view.project,
      version: cleared.version,
      body: {
        ...cleared.body,
        panels: [
          {
            ...cleared.body.panels[0],
            expressions: [{ name: 'loss', expression: '${a} * 2' }],
          },
        ],
      },
    },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.json().code, 'COMPUTED_METRIC_DUPLICATE');
  assert.equal(duplicate.json().params.name, 'loss');
  const legacy = await server.app.inject({
    method: 'PUT',
    url: '/api/views/' + view.id,
    payload: {
      name: view.name,
      project: view.project,
      version: cleared.version,
      body: {
        ...cleared.body,
        panels: [{ ...cleared.body.panels[0], transform: { kind: 'divide', output: 'r' } }],
      },
    },
  });
  assert.equal(legacy.statusCode, 400);
});

test('each computed metric uses only its own inputs; grouping and percent apply after evaluation', async (t) => {
  const store = await fixture(t),
    first = run(store, 'c1', [
      { _step: 0, a: 2, b: 4 },
      { _step: 1, a: 3 },
      { _step: 2, a: 5, b: 0 },
      { _step: 3, b: 8 },
    ]),
    second = run(store, 'c2', [{ _step: 0, a: 6, b: 4 }]);
  const both = compute(['half', '${a} / 2'], ['ratio', '${a} / ${b}'], ['twice b', '${b} * 2']);
  const data = store.chart({
    runs: [first],
    metrics: ['half', 'ratio', 'twice b'],
    recordTransform: both,
  });
  assert.deepEqual(data.series[0].values, {
    half: [
      [0, 1],
      [1, 1.5],
      [2, 2.5],
    ],
    ratio: [[0, 0.5]],
    'twice b': [
      [0, 8],
      [2, 0],
      [3, 16],
    ],
  });
  // Omitted per computed metric and summed: 1 for half, 3 for ratio, 1 for twice b.
  assert.equal(data.omittedRecords, 5);
  const grouped = store.chart({
    runs: [first, second],
    metrics: ['ratio'],
    recordTransform: compute(['ratio', '${a} / ${b}']),
    settings: { groupBy: 'all', aggregation: 'mean', spread: 'minmax' },
  });
  assert.deepEqual(grouped.series[0].values.ratio, [[0, 1]]);
  assert.deepEqual(grouped.series[0].bands.ratio, [[0, 0.5, 1.5, 2]]);
  const shares = store.chart({
    runs: [first],
    metrics: ['a', 'b + 1'],
    recordTransform: { ...compute(['a', '${a}'], ['b + 1', '${b} + 1']), align: 'percent' },
  });
  const round = (points) => points.map(([x, y]) => [x, Math.round(y * 1e9) / 1e9]);
  assert.deepEqual(
    round(shares.series[0].values.a),
    round([
      [0, 200 / 7],
      [2, 500 / 6],
    ]),
  );
  assert.deepEqual(
    round(shares.series[0].values['b + 1']),
    round([
      [0, 500 / 7],
      [2, 100 / 6],
    ]),
  );
  assert.equal(shares.omittedRecords, 2);
});

test('unique-step histories use the point store with results identical to the record scan', async (t) => {
  const store = await fixture(t);
  const ids = ['p1', 'p2'].map((name, n) =>
    run(
      store,
      name,
      Array.from({ length: 40 }, (_, i) => ({
        _step: i * 2,
        _timestamp: 1700000000 + i * 3 + n,
        _runtime: i * 1.5,
        // The X metric is missing from one record, a denominator from another.
        ...(i === 7 ? {} : { iteration: 100 + i * 10 }),
        a: (i % 5) + n,
        ...(i === 11 ? {} : { b: i % 4 }),
        c: 2 + (i % 3),
      })),
    ),
  );
  const requests = [];
  for (const xAxis of ['_step', 'iteration', '_timestamp', '_runtime', '_relative_wall'])
    for (const recordTransform of [
      divide,
      align,
      { kind: 'align', normalization: 'percent' },
      compute(['ratio', '${a} / ${b}'], ['log c', 'Math.log(${c}) * (${a} > 1 ? 1 : -1)']),
      { ...compute(['sum', '${a} + ${b}'], ['c', '${c}']), align: 'percent' },
    ])
      for (const bounds of [{}, { xMin: 20, xMax: 300 }])
        for (const group of [{}, { groupBy: 'all', aggregation: 'median', spread: 'minmax' }])
          requests.push({
            runs: ids,
            metrics:
              recordTransform.kind === 'compute'
                ? recordTransform.expressions.map((item) => item.name)
                : ['a', 'b', 'c'],
            pixels: 16,
            recordTransform,
            settings: { xAxis, resolution: 'low', ...bounds, ...group },
          });
  const viaPoints = requests.map((request) => store.chart(request));
  assert.ok(viaPoints.some((data) => data.omittedRecords > 0));
  assert.ok(viaPoints.some((data) => data.series.some((s) => Object.values(s.values)[0].length)));
  // Removing one _step point makes the counts differ, which forces the record scan.
  for (const id of ids)
    store.db.prepare('DELETE FROM point_tail WHERE run=? AND metric=? AND step=0').run(store.history.runKey(id),store.history.metricId('_step'));
  requests.forEach((request, index) =>
    assert.deepEqual(store.chart(request), viaPoints[index], JSON.stringify(request)),
  );
});

test('computed metrics stream in run chunks with nested buckets like plain metrics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-computed-stream-')),
    server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const ids = [];
  for (const name of ['s1', 's2', 's3']) {
    const run = await server.db.call('upsert', { entity: 'local', project: 'stream', name });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 3000 }, (_, i) =>
            JSON.stringify({
              _step: i,
              a: Math.sin(i / 40) + name.length,
              ...(i % 2 ? { b: i } : {}),
            }),
          ),
        },
      },
    });
    ids.push(run.id);
  }
  const transform = compute(['a2', '${a} * 2'], ['ratio', '${a} / ${b}']);
  const body = (resolution, pixels = 200) => ({
    runs: ids,
    metrics: ['a2', 'ratio'],
    recordTransform: transform,
    pixels,
    settings: { resolution },
  });
  const streamed = await server.app.inject({
    method: 'POST',
    url: '/api/chart',
    headers: { accept: 'application/x-ndjson' },
    payload: body('low'),
  });
  assert.equal(streamed.headers['content-type'], 'application/x-ndjson');
  const lines = streamed.body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines[0].metadata.recordTransform.kind, 'compute');
  assert.equal(lines[0].metadata.omittedRecords, 3 * 1500);
  assert.ok(lines[0].metadata.bucketWidth > 0);
  assert.ok(lines.at(-1).done && lines.at(-1).sampled);
  const series = lines.flatMap((line) => line.changed || []).map((change) => change.replace);
  assert.deepEqual(
    series.map((item) => item.id),
    ids,
  );
  // The same request without streaming gives the same series; finer resolutions only add points.
  const whole = (
    await server.app.inject({ method: 'POST', url: '/api/chart', payload: body('low') })
  ).json();
  assert.deepEqual(whole.series, series);
  const fine = (
    await server.app.inject({ method: 'POST', url: '/api/chart', payload: body('high') })
  ).json();
  const full = (
    await server.app.inject({ method: 'POST', url: '/api/chart', payload: body('full') })
  ).json();
  for (const [index, item] of whole.series.entries())
    for (const metric of ['a2', 'ratio']) {
      const finer = new Set(
        fine.series[index].values[metric].map((point) => JSON.stringify(point)),
      );
      assert.ok(item.values[metric].every((point) => finer.has(JSON.stringify(point))));
      assert.ok(item.values[metric].length < fine.series[index].values[metric].length);
    }
  assert.equal(full.series[0].values.a2.length, 3000);
  assert.equal(full.series[0].values.ratio.length, 1500);
  assert.equal(full.series[0].values.ratio[0][1], (Math.sin(1 / 40) + 2) / 1);
  assert.equal(full.sampled, false);
});

test('streaming aligned collection bounds output and preserves paired extrema with unordered X', async () => {
  const { collectAligned } = await import('../backend/dist/record-chart.js');
  function* records() {
    for (let i = 0; i < 100000; i++) {
      const x = i % 2 ? -i : i,
        y = i === 51001 ? 100 : i === 81998 ? -50 : 1;
      yield [x, y, 2 * y];
    }
  }
  const result = collectAligned(records(), 256);
  assert.equal(result.sampled, true);
  assert.ok(result.points.length <= 256);
  assert.equal(result.points[0][0], -99999);
  assert.equal(result.points.at(-1)[0], 99998);
  assert.ok(result.points.some((p) => p[1] === 100));
  assert.ok(result.points.some((p) => p[1] === -50));
  assert.ok(result.points.every((p, i, all) => p[2] === 2 * p[1] && (!i || all[i - 1][0] <= p[0])));
});

test('imported system JSON keeps textual precedence for an integer custom-axis key',async(t)=>{
 const store=await fixture(t),run=store.upsert({entity:'synthetic',project:'integer-axis',name:'run'}),h=store.history,k=h.runKey(run.id);
 h.transaction(()=>{h.linePut(k,h.ensureFileId('wandb-events.jsonl'),0,'{"_timestamp":1,"system.1":3,"1":2,"a":4}');h.pointPut(k,h.ensureMetricId('system/a'),1,4);h.finishWrites(k);});
 const chart=store.chart({runs:[run.id],metrics:['system/a'],settings:{xAxis:'1'},recordTransform:{kind:'align',normalization:'none'}});
 assert.deepEqual(chart.series[0].values['system/a'],[[2,4]]);
});
