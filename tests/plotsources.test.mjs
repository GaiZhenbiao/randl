import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { builtins } from '../backend/dist/plugins.js';

const history = (rows, offset = 0) => ({
  files: { 'wandb-history.jsonl': { offset, content: rows.map((row) => JSON.stringify(row)) } },
});
const summary = (value) => ({
  files: { 'wandb-summary.json': { offset: 0, content: [JSON.stringify(value)] } },
});

async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-plot-sources-'));
  const store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

async function serverFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-plot-http-'));
  const server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return server;
}

test('metric catalog distinguishes mixed scalar/media names and typed metadata leaves', async (t) => {
  const { app, db } = await serverFixture(t);
  const run = await db.call('upsert', {
    name: 'catalog',
    config: {
      seed: { value: 0 },
      optimizer: { value: { beta: 0.9 } },
      model: { value: 'small' },
      enabled: { value: false },
    },
    summaryMetrics: { score: 0, split: 'validation', nested: { accuracy: 0.75 } },
  });
  await db.call(
    'ingest',
    run.id,
    history([
      { _step: 0, loss: 3, mixed: 1 },
      {
        _step: 1,
        loss: 2,
        mixed: { _type: 'histogram', values: [2], bins: [0, 1] },
        distribution: { _type: 'histogram', values: [1], bins: [0, 1] },
      },
    ]),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/metrics',
    payload: { runs: [run.id] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const catalog = response.json();
  assert.deepEqual(new Set(catalog.metrics), new Set(['loss', 'mixed', 'distribution']));
  assert.deepEqual(new Set(catalog.kinds.mixed), new Set(['scalar', 'histogram']));
  assert.deepEqual(catalog.kinds.distribution, ['histogram']);
  assert.deepEqual(catalog.kinds.loss, ['scalar']);
  for (const field of [
    'config.seed',
    'config.optimizer.beta',
    'summary.score',
    'summary.nested.accuracy',
  ])
    assert.deepEqual(catalog.kinds[field], ['number'], field);
  for (const field of ['config.model', 'config.enabled', 'summary.split'])
    assert.deepEqual(catalog.kinds[field], ['category'], field);
  assert.ok(!Object.hasOwn(catalog.kinds, '_step'));
  assert.deepEqual(
    (await app.inject({ method: 'POST', url: '/api/metrics', payload: { runs: [] } })).json(),
    { metrics: [], kinds: {}, definitions: {} },
  );
});

test('valid metric names that shadow Object properties do not break the catalog', async (t) => {
  const { app, db } = await serverFixture(t);
  const run = await db.call('upsert', { name: 'property-names' });
  await db.call('ingest', run.id, history([{ _step: 0, constructor: 1, toString: 2 }]));
  const response = await app.inject({
    method: 'POST',
    url: '/api/metrics',
    payload: { runs: [run.id] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().kinds.constructor, ['scalar']);
  assert.deepEqual(response.json().kinds.toString, ['scalar']);
});

test('snapshot attributes retain categories and zero without manufacturing numeric points', async (t) => {
  const store = await storeFixture(t);
  const run = store.upsert({
    name: 'snapshot',
    displayName: 'Snapshot run',
    config: { lr: { value: 0 }, model: { value: 'small' }, enabled: { value: false } },
    summaryMetrics: { loss: 0.25, nested: { accuracy: 0.9 } },
  });
  store.ingest(
    run.id,
    history([
      { _step: 0, loss: 10 },
      { _step: 5, loss: 8 },
    ]),
  );
  const metrics = [
    'loss',
    'config.lr',
    'config.model',
    'config.enabled',
    'summary.loss',
    'summary.nested.accuracy',
    'summary.missing',
  ];
  const data = store.chart({ runs: [run.id], metrics, mode: 'snapshot' });
  assert.equal(data.snapshot, true);
  assert.equal(data.sampled, false);
  assert.equal(data.series.length, 1);
  assert.equal(data.series[0].name, 'Snapshot run');
  assert.deepEqual(data.series[0].attributes, {
    loss: 8,
    'config.lr': 0,
    'config.model': 'small',
    'config.enabled': false,
    'summary.loss': 0.25,
    'summary.nested.accuracy': 0.9,
    'summary.missing': null,
  });
  assert.deepEqual(data.series[0].values.loss, [[0, 8]]);
  assert.deepEqual(data.series[0].values['config.lr'], [[0, 0]]);
  assert.deepEqual(data.series[0].values['summary.loss'], [[0, 0.25]]);
  for (const field of ['config.model', 'config.enabled', 'summary.missing'])
    assert.deepEqual(data.series[0].values[field], [], field);
});

async function groupedFixture(t) {
  const store = await storeFixture(t);
  const runs = [];
  for (const [index, group, value, label] of [
    [0, 'a', 2, 'same'],
    [1, 'b', 100, 'different'],
    [2, 'a', 10, 'same'],
  ]) {
    const run = store.upsert({
      name: 'r' + index,
      config: { cohort: { value: group }, label: { value: label } },
      summaryMetrics: { score: value },
    });
    store.ingest(run.id, history([{ _step: 0, loss: value }]));
    runs.push(run.id);
  }
  return { store, runs };
}

test('snapshot maxRuns limits groups after all members contribute to aggregates', async (t) => {
  const { store, runs } = await groupedFixture(t);
  const data = store.chart({
    runs,
    metrics: ['loss', 'summary.score', 'config.label'],
    mode: 'snapshot',
    settings: { groupBy: 'config.cohort', aggregation: 'mean', maxRuns: 1 },
  });
  assert.equal(data.series.length, 1);
  assert.deepEqual(data.series[0].runIds, [runs[0], runs[2]]);
  assert.equal(data.series[0].attributes.loss, 6);
  assert.equal(data.series[0].attributes['summary.score'], 6);
  assert.equal(data.series[0].attributes['config.label'], 'same');
  assert.deepEqual(data.series[0].values.loss, [[0, 6]]);
  const all = store.chart({
    runs,
    metrics: ['config.label'],
    mode: 'snapshot',
    settings: { groupBy: 'all', maxRuns: 1 },
  });
  assert.equal(all.series[0].attributes['config.label'], 'Mixed');
  assert.deepEqual(all.series[0].runIds, runs);
});

test('history maxRuns limits groups without biasing the mean toward early runs', async (t) => {
  const { store, runs } = await groupedFixture(t);
  const data = store.chart({
    runs,
    metrics: ['loss'],
    settings: { groupBy: 'config.cohort', aggregation: 'mean', maxRuns: 1 },
  });
  assert.equal(data.series.length, 1);
  assert.deepEqual(data.series[0].runIds, [runs[0], runs[2]]);
  assert.deepEqual(data.series[0].values.loss, [[0, 6]]);
  for (const mode of ['history', 'snapshot']) {
    const limited = store.chart({
      runs: [runs[0], runs[0], runs[1], runs[2]],
      metrics: ['loss'],
      mode,
      settings: { maxRuns: 2 },
    });
    assert.deepEqual(
      limited.series.map((series) => series.id),
      [runs[0], runs[1]],
      mode,
    );
  }
});

test('all and focused maxRuns fetch every candidate; grouped responses count all groups', async (t) => {
  const { store, runs } = await groupedFixture(t);
  for (const mode of ['history', 'snapshot'])
    for (const maxRuns of [null, 'focused']) {
      const all = store.chart({ runs, metrics: ['loss'], mode, settings: { maxRuns } });
      assert.deepEqual(
        all.series.map((series) => series.id),
        runs,
        mode,
      );
      const grouped = store.chart({
        runs,
        metrics: ['loss'],
        mode,
        settings: { groupBy: 'config.cohort', maxRuns: 1 },
      });
      assert.equal(grouped.series.length, 1, mode);
      assert.equal(grouped.groupCount, 2, mode);
    }
});

test('snapshot aggregation handles even medians, extrema and missing values', async (t) => {
  const store = await storeFixture(t);
  const runs = [0, 2, 10, 100, null].map(
    (value, i) => store.upsert({ name: 'aggregate-' + i, summaryMetrics: { score: value } }).id,
  );
  for (const [aggregation, expected] of [
    ['mean', 28],
    ['median', 6],
    ['min', 0],
    ['max', 100],
  ]) {
    const data = store.chart({
      runs,
      metrics: ['summary.score'],
      mode: 'snapshot',
      settings: { groupBy: 'all', aggregation, maxRuns: 1 },
    });
    assert.equal(data.series[0].attributes['summary.score'], expected, aggregation);
    assert.deepEqual(data.series[0].runIds, runs);
  }
  const missing = store.chart({
    runs,
    metrics: ['summary.absent'],
    mode: 'snapshot',
    settings: { groupBy: 'all' },
  });
  assert.equal(missing.series[0].attributes['summary.absent'], null);
  assert.deepEqual(missing.series[0].values['summary.absent'], []);
});

test('summary-only changes invalidate snapshot caches while exact replay remains unchanged', async (t) => {
  const { app, db } = await serverFixture(t);
  const run = await db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'summary-cache',
    summaryMetrics: { score: 0, phase: 'initial' },
  });
  const body = { runs: [run.id], metrics: ['summary.score', 'summary.phase'], mode: 'snapshot' };
  const chart = async (baseRevision) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chart',
      payload: { ...body, ...(baseRevision ? { baseRevision } : {}) },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const first = await chart();
  const payload = summary({ score: 0.75, phase: 'complete' });
  const stream = await app.inject({
    method: 'POST',
    url: '/files/e/p/summary-cache/file_stream',
    payload,
  });
  assert.equal(stream.statusCode, 200);
  assert.equal((await db.call('run', run.id)).history_count, 0);
  assert.ok((await db.call('run', run.id)).revision > run.revision);
  assert.notEqual((await chart(first.revision)).unchanged, true);
  const current = await chart();
  assert.notEqual(current.revision, first.revision);
  assert.equal(current.series[0].attributes['summary.score'], 0.75);
  assert.equal(current.series[0].attributes['summary.phase'], 'complete');
  await app.inject({ method: 'POST', url: '/files/e/p/summary-cache/file_stream', payload });
  assert.deepEqual(await chart(current.revision), { unchanged: true, revision: current.revision });
  await app.inject({
    method: 'POST',
    url: '/files/e/p/summary-cache/file_stream',
    payload: summary({ score: 0.75, phase: 'reviewed' }),
  });
  assert.notEqual((await chart(current.revision)).unchanged, true);
  assert.equal((await chart()).series[0].attributes['summary.phase'], 'reviewed');
});

test('plugin data contracts separate snapshot, history and typed media inputs', () => {
  const plugin = (id) => builtins.find((item) => item.id === id);
  for (const id of ['bar', 'scatter', 'parallel']) {
    assert.equal(plugin(id).dataKind, 'snapshot');
    assert.ok(plugin(id).metricTypes.includes('number'));
  }
  assert.ok(plugin('scatter').metricTypes.includes('category'));
  assert.ok(plugin('parallel').metricTypes.includes('category'));
  assert.ok(!plugin('bar').metricTypes.includes('category'));
  assert.equal(plugin('scatter-history').dataKind, 'scalar');
  assert.deepEqual(plugin('line').metricTypes, ['scalar']);
  assert.equal(plugin('histogram').dataKind, 'media');
  assert.deepEqual(plugin('histogram').metricTypes, ['histogram']);
  assert.equal(plugin('histogram').metricSelection, 'single');
});

test('grouped custom axes preserve format-1 floating-point accumulation',async(t)=>{
 const store=await storeFixture(t),run=store.upsert({entity:'synthetic',project:'order',name:'run'});
 store.ingest(run.id,history([1e16,-1e16,1].map((value,_step)=>({_step,value,x:1}))));
 const request={runs:[run.id],metrics:['value'],settings:{xAxis:'x',groupBy:'all',aggregation:'mean'}};
 // The run's mean at x = 1, accumulated in record order without overflow or cancellation.
 const before=store.chart(request).series[0].values.value;
 assert.deepEqual(before,[[1,1/3]]);
 store.ingest(run.id,{complete:true});store.storageMaintain(10000);
 assert.deepEqual(store.chart(request).series[0].values.value,before);
});

test('non-finite internal range endpoints retain the format-1 unbounded semantics',async(t)=>{
 const store=await storeFixture(t),run=store.upsert({entity:'synthetic',project:'bounds',name:'run'});
 store.ingest(run.id,history([{_step:0,value:2},{_step:1,value:3},{_step:2,value:4}]));
 for(const xMin of [NaN,Infinity,-Infinity]){
  assert.deepEqual(store.series(run.id,'value',null,{xMin,xMax:1}),[[0,2],[1,3]]);
  assert.deepEqual(store.seriesStats(run.id,'value',{xMin,xMax:1}),{n:2,lo:0,hi:1});
 }
});
