import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { EventEmitter } from 'node:events';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';

async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-values-'));
  const store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

async function serverFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-management-'));
  const server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return server;
}

test('shared view save rejects invalid hide patterns without changing the saved view', async (t) => {
  const { tools, db, app } = await serverFixture(t);
  const view = await tools.execute('view_create', { name: 'Pattern validation' });
  const edit = {
    id: view.id,
    name: view.name,
    project: view.project,
    version: view.version,
    body: { ...view.body, generation: 'automatic', hidePattern: '[unterminated' },
  };
  await assert.rejects(tools.execute('view_save', edit), /pattern|expression/i);
  assert.deepEqual(await db.call('view', view.id), view);
  const { id: _id, ...httpEdit } = edit;
  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/views/' + view.id,
    payload: httpEdit,
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().error, /pattern|expression/i);
  const saved = await tools.execute('view_save', {
    ...edit,
    body: { ...edit.body, generation: 'manual', hidePattern: '^debug/' },
  });
  assert.equal(saved.body.hidePattern, '^debug/');
  assert.equal(saved.body.generation, 'manual');
  assert.equal(saved.version, view.version + 1);
});

test('lightweight metric_count changes only when a new recorded metric key appears', async (t) => {
  const { db, app } = await serverFixture(t);
  const run = await db.call('upsert', { name: 'metric-count' });
  const metadata = async () => (await db.call('runMetas', [run.id]))[0];
  const ingest = (row, offset) =>
    db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': { offset, content: [JSON.stringify(row)] },
      },
    });
  assert.equal((await metadata()).metric_count, 0);
  await ingest({ _step: 0, loss: 2 }, 0);
  const first = await metadata();
  assert.ok(first.metric_count > 0);
  await ingest({ _step: 1, loss: 1 }, 1);
  assert.equal((await metadata()).metric_count, first.metric_count);
  assert.ok((await metadata()).revision > first.revision);
  await ingest({ _step: 1, loss: 1 }, 1);
  assert.equal((await metadata()).metric_count, first.metric_count);
  await ingest({ _step: 2, distribution: { _type: 'histogram', values: [1], bins: [0, 1] } }, 2);
  assert.equal((await metadata()).metric_count, first.metric_count + 1);
  await ingest({ _step: 3, distribution: { _type: 'histogram', values: [3], bins: [0, 1] } }, 3);
  assert.equal((await metadata()).metric_count, first.metric_count + 1);
  const list = (await app.inject('/api/runs')).json().runs.find((item) => item.id === run.id);
  assert.equal(list.metric_count, first.metric_count + 1);
});

test('dynamic run values preserve numeric, false, null, dotted and quoted fields', async (t) => {
  const store = await storeFixture(t);
  const run = store.upsert({
    entity: 'e',
    project: 'p',
    name: 'r',
    tags: ['baseline'],
    config: {
      lr: { value: 0.003 },
      enabled: { value: false },
      'a.b': { value: 0 },
      'quote"key': { value: 17 },
      optimizer: { value: { beta: 0.9 } },
    },
    summaryMetrics: { score: 0, flag: false, absent: null, nested: { accuracy: 0.95 }, 'a.b': 2 },
  });
  const fields = [
    'config.lr',
    'config.enabled',
    'config.a.b',
    'config.quote"key',
    'config.optimizer',
    'summary.score',
    'summary.flag',
    'summary.absent',
    'summary.nested.accuracy',
    'summary.a.b',
    'summary.missing',
    'tags',
    'history_count',
  ];
  assert.deepEqual(store.runValues([run.id], fields), [
    {
      id: run.id,
      values: {
        'config.lr': 0.003,
        'config.enabled': false,
        'config.a.b': 0,
        'config.quote"key': 17,
        'config.optimizer': { beta: 0.9 },
        'summary.score': 0,
        'summary.flag': false,
        'summary.absent': null,
        'summary.nested.accuracy': 0.95,
        'summary.a.b': 2,
        'summary.missing': null,
        tags: ['baseline'],
        history_count: 0,
      },
    },
  ]);
  assert.deepEqual(store.runValues([], fields), []);
});

test('nested SDK config values are unwrapped before traversing child fields', async (t) => {
  const store = await storeFixture(t);
  const run = store.upsert({
    name: 'nested',
    config: { optimizer: { value: { learning_rate: 0.01 } } },
  });
  assert.equal(
    store.runValues([run.id], ['config.optimizer.learning_rate'])[0].values[
      'config.optimizer.learning_rate'
    ],
    0.01,
  );
});

test('numeric metadata filters compare numbers and preserve string run names', async (t) => {
  const store = await storeFixture(t);
  const first = store.upsert({
    name: '2',
    config: { lr: { value: 0.002 } },
    summaryMetrics: { score: 2 },
  });
  const second = store.upsert({
    name: '10',
    config: { lr: { value: 0.01 } },
    summaryMetrics: { score: 10 },
  });
  store.db
    .prepare('UPDATE runs SET created=?,updated=?,history_count=? WHERE id=?')
    .run(2, 3, 2, first.id);
  store.db
    .prepare('UPDATE runs SET created=?,updated=?,history_count=? WHERE id=?')
    .run(10, 11, 10, second.id);
  for (const field of ['created', 'updated', 'history_count', 'summary.score']) {
    assert.deepEqual(
      store.queryRuns({ filters: [{ field, operator: 'gte', value: '10' }] }),
      [second.id],
      field,
    );
  }
  assert.deepEqual(
    store.queryRuns({ filters: [{ field: 'config.lr', operator: 'lt', value: '0.003' }] }),
    [first.id],
  );
  assert.deepEqual(store.queryRuns({ filters: [{ field: 'name', operator: 'eq', value: '10' }] }), [
    second.id,
  ]);
});

test('OR filters and dynamic metadata never bring trashed runs back into the active table', async (t) => {
  const store = await storeFixture(t);
  const active = store.upsert({ entity: 'e', project: 'p', name: 'active' });
  const deleted = store.upsert({
    entity: 'e',
    project: 'p',
    name: 'deleted',
    state: 'failed',
    config: { only_in_trash: { value: 7 } },
  });
  store.runManage({ ids: [deleted.id], action: 'delete' });
  assert.deepEqual(
    store.queryRuns({
      mode: 'or',
      filters: [
        { field: 'name', operator: 'eq', value: 'active' },
        { field: 'state', operator: 'eq', value: 'failed' },
      ],
    }),
    [active.id],
  );
  assert.deepEqual(store.runMetas([deleted.id]), []);
  assert.deepEqual(store.runValues([deleted.id], ['name', 'config.only_in_trash']), []);
  assert.ok(!store.runFields('e/p').includes('config.only_in_trash'));
  assert.equal(store.deletedRuns('e/p')[0].id, deleted.id);
  assert.deepEqual(store.deletedRuns('e/other'), []);
  store.runManage({ ids: [deleted.id], action: 'restore' });
  assert.equal(store.runMetas([deleted.id])[0].id, deleted.id);
  assert.equal(
    store.runValues([deleted.id], ['config.only_in_trash'])[0].values['config.only_in_trash'],
    7,
  );
});

test('shared run tools add/remove tags atomically and audit only completed actions', async (t) => {
  const { app, db, tools } = await serverFixture(t);
  const first = await db.call('upsert', { name: 'tag-first', tags: ['baseline'] });
  const second = await db.call('upsert', { name: 'tag-second', tags: [] });
  await tools.execute('runs_update', {
    ids: [first.id, first.id, second.id],
    action: 'add-tags',
    tags: ['new', 'new'],
  });
  assert.deepEqual(JSON.parse((await db.call('run', first.id)).tags), ['baseline', 'new']);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tools/runs_update',
    payload: { ids: [first.id, second.id], action: 'remove-tags', tags: ['new'] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(JSON.parse((await db.call('run', second.id)).tags), []);
  await assert.rejects(
    tools.execute('runs_update', {
      ids: [first.id, 'missing'],
      action: 'add-tags',
      tags: ['must-rollback'],
    }),
    /not found/i,
  );
  assert.deepEqual(JSON.parse((await db.call('run', first.id)).tags), ['baseline']);
  await assert.rejects(
    tools.execute('runs_update', {
      ids: [first.id],
      action: 'add-tags',
      tags: Array.from({ length: 101 }, (_, i) => 'tag-' + i),
    }),
    /100 tags/,
  );
  assert.deepEqual(JSON.parse((await db.call('run', first.id)).tags), ['baseline']);
  await assert.rejects(
    tools.execute('runs_update', { ids: [first.id], action: 'invalid' }),
    /Unknown run action/,
  );
  assert.equal(
    (await db.call('auditList')).filter((event) => event.tool === 'runs_update').length,
    2,
  );
});

test('stop is a request until completion and is returned through both SDK protocols', async (t) => {
  const { app, db, tools } = await serverFixture(t);
  const running = await db.call('upsert', { entity: 'e', project: 'p', name: 'running' });
  const finished = await db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'finished',
    state: 'finished',
  });
  const result = await tools.execute('runs_update', {
    ids: [running.id, finished.id],
    action: 'stop',
  });
  assert.deepEqual(result.ids, [running.id]);
  assert.equal((await db.call('run', running.id)).state, 'running');
  assert.equal((await db.call('run', finished.id)).stop_requested, 0);
  const status = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: {
      query:
        'query RunStoppedStatus($entityName: String, $projectName: String, $runId: String!) { project { run { stopped } } }',
      variables: { entityName: 'e', projectName: 'p', runId: 'running' },
    },
  });
  assert.equal(status.json().data.project.run.stopped, true);
  const stream = await app.inject({
    method: 'POST',
    url: '/files/e/p/running/file_stream',
    payload: { files: {} },
  });
  assert.equal(stream.json().stopped, true);
  await db.call('ingest', running.id, { complete: true, exitcode: 1 });
  assert.equal((await db.call('run', running.id)).state, 'killed');
  await db.call('upsert', { entity: 'e', project: 'p', name: 'running' });
  assert.equal((await db.call('run', running.id)).stop_requested, 0);
  assert.equal((await db.call('run', running.id)).state, 'killed');
  await db.call('ingest', running.id, { complete: true, exitcode: 1 });
  assert.equal(
    (await db.call('run', running.id)).state,
    'killed',
    'A delayed completion replay must preserve the stopped state',
  );
  const resumed = await db.call('ingest', running.id, {
    files: {
      'wandb-history.jsonl': { offset: 0, content: ['{"_step":0,"loss":0.1}'] },
    },
  });
  assert.equal(resumed.stopped, false);
  assert.equal((await db.call('run', running.id)).state, 'running');
  await db.call('ingest', running.id, { complete: true, exitcode: 0 });
  assert.equal((await db.call('run', running.id)).state, 'finished');
});

test('delete/restore preserves history and sends removed/restored SSE metadata', async (t) => {
  const { app, db, tools } = await serverFixture(t);
  const run = await db.call('upsert', { entity: 'e', project: 'p', name: 'restore-me' });
  await db.call('ingest', run.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content: ['{"_step":0,"loss":3}'] } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const events = new EventEmitter(),
    frames = [];
  const request = get(`http://127.0.0.1:${app.server.address().port}/api/events`);
  t.after(() => request.destroy());
  const response = await new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  response.setEncoding('utf8');
  let buffer = '';
  response.on('data', (chunk) => {
    buffer += chunk;
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = frame.split('\n').find((value) => value.startsWith('data:'));
      if (line) {
        const value = JSON.parse(line.slice(5));
        frames.push(value);
        events.emit('data', value);
      }
    }
  });
  const waitFor = (predicate) => {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off('data', listener);
        reject(Error('Missing run-management SSE event'));
      }, 3000);
      const listener = (frame) => {
        if (predicate(frame)) {
          clearTimeout(timer);
          events.off('data', listener);
          resolve(frame);
        }
      };
      events.on('data', listener);
    });
  };
  await tools.execute('runs_update', { ids: [run.id], action: 'delete' });
  await waitFor((frame) => frame.removed?.includes(run.id));
  assert.ok(!(await db.call('runs')).some((item) => item.id === run.id));
  assert.equal((await db.call('run', run.id)).history_count, 1);
  await tools.execute('runs_update', { ids: [run.id], action: 'restore' });
  const restored = await waitFor((frame) => frame.runs?.some((item) => item.id === run.id));
  assert.equal(restored.runs.find((item) => item.id === run.id).history_count, 1);
  assert.deepEqual(
    (await db.call('chart', { runs: [run.id], metrics: ['loss'] })).series[0].values.loss,
    [[0, 3]],
  );
});
