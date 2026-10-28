import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../backend/dist/database.js';
import { metricDefinitions } from '../backend/dist/run-metadata.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-environment-'));
  const store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}
const history = (rows, offset = 0) => ({
  files: { 'wandb-history.jsonl': { offset, content: rows.map(JSON.stringify) } },
});
test('SDK metric definitions resolve indexed steps, hidden flags, summaries and globs', () => {
  const values = metricDefinitions({
    _wandb: {
      value: {
        m: [
          { 1: 'epoch' },
          { 1: 'val/loss', 5: 1, 6: [1, 3], 7: [2, 1], 8: 1 },
          { 2: 'debug/*', 6: [2] },
        ],
      },
    },
  });
  assert.equal(values.find((d) => d.name === 'val/loss').stepMetric, 'epoch');
  assert.deepEqual(values.find((d) => d.name === 'val/loss').summary, ['max', 'min']);
  assert.equal(values.find((d) => d.name === 'debug/*').hidden, true);
});
test('run environment persists reuploads and contributes typed query fields', async (t) => {
  const store = await fixture(t);
  const run = store.upsert({
    entity: 'local',
    project: 'environment',
    name: 'one',
    host: 'from-upsert',
    commit: 'abc',
    repo: 'https://example.test/repo',
    program: 'train.py',
  });
  store.runMetadata(run.id, {
    host: 'worker-01',
    os: 'Test OS',
    python: '3.12',
    cpu_count: 8,
    memory: { total: 16384 },
    git: { commit: 'def', remote: 'https://example.test/repo' },
    program: 'train.py',
    args: ['--lr', '0.1'],
  });
  const record = store.run(run.id);
  assert.equal(record.host, 'worker-01');
  assert.equal(record.git_commit, 'def');
  assert.equal(JSON.parse(record.metadata).python, '3.12');
  assert.deepEqual(
    store.queryRuns({
      filters: [
        { field: 'host', operator: 'eq', value: 'worker-01' },
        { field: 'cpu_count', operator: 'gte', value: '8' },
      ],
    }),
    [run.id],
  );
  assert.deepEqual(store.runValues([run.id], ['host', 'python', 'memory'])[0].values, {
    host: 'worker-01',
    python: '3.12',
    memory: 16384,
  });
  assert.deepEqual(store.runMetadata(run.id, []), { updated: false });
  assert.equal(store.run(run.id).host, 'worker-01');
  store.runMetadata(run.id, { host: 'worker-02' });
  assert.equal(store.run(run.id).host, 'worker-02');
  assert.equal(JSON.parse(store.run(run.id).metadata).python, '3.12');
});
test('stale runs freeze at last contact and resume without counting disconnected time', async (t) => {
  const store = await fixture(t),
    run = store.upsert({ entity: 'local', project: 'environment', name: 'stale' }),
    now = Date.now() / 1000;
  store.db
    .prepare('UPDATE runs SET runtime=5,runtime_at=?,heartbeat=? WHERE id=?')
    .run(now - 710, now - 700, run.id);
  assert.deepEqual(store.staleRuns(now, 600), [run.id]);
  assert.equal(store.run(run.id).state, 'crashed');
  assert.equal(store.run(run.id).runtime, 15);
  store.ingest(run.id, { files: {} });
  const resumed = store.run(run.id);
  assert.equal(resumed.state, 'running');
  assert.ok(resumed.runtime >= 15 && resumed.runtime < 16);
  store.ingest(run.id, {
    ...history([{ _step: 0, _runtime: 16, loss: 1 }]),
    complete: true,
    exitcode: 7,
  });
  const finished = store.run(run.id);
  assert.equal(finished.state, 'failed');
  assert.equal(finished.exit_code, 7);
  assert.ok(finished.runtime >= 16 && finished.runtime < 17);
  assert.ok(finished.finished);
  const end = finished.finished;
  store.ingest(run.id, {
    ...history([{ _step: 0, _runtime: 16, loss: 1 }]),
    complete: true,
    exitcode: 7,
  });
  assert.equal(store.run(run.id).finished, end);
});
test('defined X axes are used for default chart requests and explicit axes override them', async (t) => {
  const store = await fixture(t);
  const run = store.upsert({
    entity: 'local',
    project: 'environment',
    name: 'axis',
    config: {
      _wandb: { value: { m: [{ 1: 'epoch' }, { 2: 'val/*', 5: 1 }, { 1: 'debug/loss', 6: [2] }] } },
    },
  });
  store.ingest(
    run.id,
    history([
      { _step: 0, epoch: 2, 'val/loss': 9, 'debug/loss': 99 },
      { _step: 1, epoch: 4, 'val/loss': 5 },
    ]),
  );
  const definitions = store.metricSettings([run.id]);
  assert.equal(definitions['val/loss'].stepMetric, 'epoch');
  assert.equal(definitions['debug/loss'].hidden, true);
  const inferred = store.chart({ runs: [run.id], metrics: ['val/loss'] });
  assert.equal(inferred.xAxis, 'epoch');
  assert.deepEqual(inferred.series[0].values['val/loss'], [
    [2, 9],
    [4, 5],
  ]);
  const explicit = store.chart({
    runs: [run.id],
    metrics: ['val/loss'],
    settings: { xAxis: '_step' },
  });
  assert.deepEqual(explicit.series[0].values['val/loss'], [
    [0, 9],
    [1, 5],
  ]);
  const another = store.upsert({ entity: 'local', project: 'environment', name: 'plain' });
  store.ingest(another.id, history([{ _step: 0, 'val/loss': 1, 'debug/loss': 2 }]));
  const combined = store.metricSettings([run.id, another.id]);
  assert.equal(combined['val/loss'].stepMetric, undefined);
  assert.equal(combined['debug/loss'].hidden, false);
});
test('SDK alerts are retained and throttle identical titles within wait duration', async (t) => {
  const store = await fixture(t),
    run = store.upsert({ entity: 'local', project: 'environment', name: 'alerts' });
  store.alert({
    run: run.id,
    title: 'Loss diverged',
    text: 'Synthetic warning',
    severity: 'WARN',
    waitDuration: 60,
  });
  store.alert({
    run: run.id,
    title: 'Loss diverged',
    text: 'Synthetic warning',
    severity: 'WARN',
    waitDuration: 60,
  });
  const alerts = store.alerts(run.id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'WARN');
  assert.equal(alerts[0].text, 'Synthetic warning');
});
test('unreported terminal runtime is missing rather than zero', async (t) => {
  const store = await fixture(t),
    run = store.upsert({ name: 'missing-runtime' });
  store.db
    .prepare("UPDATE runs SET state='finished',runtime=0,runtime_reported=0 WHERE id=?")
    .run(run.id);
  assert.equal(store.run(run.id).runtime, null);
  assert.equal(store.runValues([run.id], ['runtime'])[0].values.runtime, null);
  assert.deepEqual(
    store.queryRuns({ filters: [{ field: 'runtime', operator: 'exists', value: '' }] }),
    [],
  );
});
test('metadata upload accepts malformed bytes while preserving the previous environment', async (t) => {
  const { createServer } = await import('../backend/dist/server.js');
  const directory = await mkdtemp(join(tmpdir(), 'randl-metadata-upload-')),
    server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = await server.db.call('upsert', {
    entity: 'local',
    project: 'upload',
    name: 'metadata',
  });
  const upload = (body) =>
    server.app.inject({
      method: 'PUT',
      url: '/upload/local/upload/metadata/wandb-metadata.json',
      headers: { 'content-type': 'application/octet-stream' },
      payload: body,
    });
  assert.equal(
    (await upload(JSON.stringify({ os: 'Test OS', python: '3.12', host: 'test-host' }))).statusCode,
    200,
  );
  assert.equal((await upload('{bad JSON')).statusCode, 200);
  assert.equal((await server.db.call('run', run.id)).host, 'test-host');
  const file = await server.app.inject(
    '/api/run-files?run=' + encodeURIComponent(run.id) + '&path=wandb-metadata.json',
  );
  assert.equal(file.body, '{bad JSON');
});
test('imported snapshots retain capture state and runtime across every projection and stale sweep', async (t) => {
  const store = await fixture(t);
  const run = store.upsert({ entity: 'local', project: 'snapshots', name: 'running-capture' });
  const captured = 1700000000;
  store.db.prepare('UPDATE runs SET snapshot_at=?,snapshot_source=?,runtime=23,runtime_reported=1,runtime_at=?,heartbeat=? WHERE id=?')
    .run(captured, 'Synthetic archive', captured - 20, captured - 10, run.id);
  assert.deepEqual(store.staleRuns(Date.now() / 1000, 10), []);
  for (const actual of [store.run(run.id), store.runs()[0], store.runMetas([run.id])[0]]) {
    assert.equal(actual.state, 'running');
    assert.equal(actual.snapshot_at, captured);
    assert.equal(actual.snapshot_source, 'Synthetic archive');
    assert.equal(actual.runtime, 23);
    assert.equal(actual.runtime_at, captured - 20);
  }
  assert.equal(store.runValues([run.id], ['runtime'])[0].values.runtime, 23);
  assert.deepEqual(store.queryRuns({ filters: [{ field: 'runtime', operator: 'eq', value: '23' }] }), [run.id]);
  assert.throws(() => store.runManage({ action: 'stop', ids: [run.id] }), /snapshot/);
  assert.equal(store.run(run.id).stop_requested, 0);
  store.db.prepare('UPDATE runs SET runtime=0,runtime_reported=0 WHERE id=?').run(run.id);
  assert.equal(store.run(run.id).runtime, null);
  assert.equal(store.runValues([run.id], ['runtime'])[0].values.runtime, null);
  assert.deepEqual(store.queryRuns({ filters: [{ field: 'runtime', operator: 'exists', value: '' }] }), []);
});

test('an SDK resume turns a snapshot into a live run that continues after its imported history', async (t) => {
  const store = await fixture(t);
  const run = store.upsert({ entity: 'local', project: 'snapshots', name: 'resumed', displayName: 'Imported name' });
  // A sampled import: steps 0..1900 every 100, then sparse records appended with earlier steps.
  store.ingest(run.id, history([
    ...Array.from({ length: 20 }, (_, i) => ({ _step: i * 100, _runtime: i * 10, loss: 20 - i })),
    { _step: 150, rare: 1 },
    { _step: 250, rare: 2 },
  ]));
  const captured = Date.now() / 1000 - 3600;
  store.db.prepare("UPDATE runs SET snapshot_at=?,snapshot_source=?,state='running',runtime=500,runtime_reported=1,runtime_at=?,heartbeat=?,summary=? WHERE id=?")
    .run(captured, 'W&B · test', captured, captured, JSON.stringify({ _step: 1999, _runtime: 500, loss: 1 }), run.id);
  // The resume status points after every stored offset and at the highest step.
  assert.equal(store.streamCount(run.id, 'wandb-history.jsonl'), 22);
  assert.equal(JSON.parse(JSON.parse(store.historyTail(run.id))[0])._step, 1900);
  const resumed = store.upsert({ entity: 'local', project: 'snapshots', name: 'resumed' });
  assert.equal(resumed.snapshot_at, null);
  assert.equal(resumed.snapshot_source, 'W&B · test');
  assert.equal(resumed.state, 'running');
  assert.ok(resumed.resumed_at > captured);
  assert.equal(resumed.display_name, 'Imported name');
  // Runtime continues from the imported value, not from the capture time.
  assert.ok(resumed.runtime >= 500 && resumed.runtime < 510);
  // SDK 0.30.0 reports resumed runtimes multiplied by 1e9; the server keeps measuring instead.
  store.ingest(run.id, history([{ _step: 2000, _runtime: 500e9, loss: 0.5 }], 22));
  const after = store.run(run.id);
  assert.equal(after.history_count, 23);
  assert.ok(after.runtime >= 500 && after.runtime < 510, String(after.runtime));
  assert.deepEqual(store.chart({ runs: [run.id], metrics: ['loss'] }).series[0].values.loss.at(-1), [2000, 0.5]);
  assert.equal(JSON.parse(store.historyTail(run.id))[0], JSON.stringify({ _step: 2000, _runtime: 500e9, loss: 0.5 }));
  // A live run is swept like any other once its process stops reporting.
  store.db.prepare('UPDATE runs SET heartbeat=? WHERE id=?').run(Date.now() / 1000 - 100, run.id);
  assert.deepEqual(store.staleRuns(Date.now() / 1000, 10), [run.id]);
  assert.throws(() => store.ingest(run.id, history([{ _step: 9, loss: 3 }], 3)), /Conflicting history replay/);
});

test('uploads, alerts and artifact links are accepted for snapshot runs', async (t) => {
  const directory=await mkdtemp(join(tmpdir(),'randl-snapshot-writes-'));
  const store=new Store(directory),run=store.upsert({entity:'local',project:'snapshot',name:'captured'});
  store.db.prepare('UPDATE runs SET snapshot_at=?,snapshot_source=? WHERE id=?').run(1700000000,'Synthetic source',run.id);
  store.db.close();
  const {createServer}=await import('../backend/dist/server.js'),server=await createServer(directory);
  t.after(async()=>{await server.app.close();await rm(directory,{recursive:true,force:true});});
  const urls=await server.app.inject({method:'POST',url:'/graphql',payload:{query:'mutation { createRunFiles }',variables:{entity:'local',project:'snapshot',name:'captured',files:['notes.txt']}}});
  assert.equal(urls.json().data.createRunFiles.files[0].name,'notes.txt');
  const upload=await server.app.inject({method:'PUT',url:'/upload/local/snapshot/captured/notes.txt',headers:{'content-type':'application/octet-stream'},payload:'local bytes'});
  assert.equal(upload.statusCode,200);
  await server.db.call('alert',{run:run.id,title:'Local alert'});
  assert.equal((await server.db.call('alerts',run.id)).length,1);
  const artifact=await server.db.call('artifact','create',{entityName:'local',projectName:'snapshot',artifactCollectionName:'model',runName:'captured'});
  assert.ok(artifact.id);
});

test('mixed stop batches skip snapshots and stop eligible local runs',async(t)=>{
 const store=await fixture(t);
 const captured=store.upsert({entity:'local',project:'mixed',name:'capture'});
 const live=store.upsert({entity:'local',project:'mixed',name:'live'});
 store.db.prepare('UPDATE runs SET snapshot_at=? WHERE id=?').run(1700000000,captured.id);
 for(const state of ['finished','running']){
   store.db.prepare('UPDATE runs SET state=? WHERE id=?').run(state,captured.id);
   store.db.prepare('UPDATE runs SET stop_requested=0 WHERE id=?').run(live.id);
   assert.deepEqual(store.runManage({action:'stop',ids:[live.id,captured.id]}).ids,[live.id]);
   assert.equal(store.run(live.id).stop_requested,1);
   assert.equal(store.run(captured.id).stop_requested,0);
 }
});
