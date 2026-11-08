import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { errorFields } from '../backend/dist/management-errors.js';

const align = { kind: 'align', normalization: 'none' };
// System-metric transforms read the raw event lines, the path that suspends mid-scan.
const events = (from, count) => ({
  files: {
    'wandb-events.jsonl': {
      offset: from,
      content: Array.from({ length: count }, (_, i) =>
        JSON.stringify({ _timestamp: from + i, 'system.cpu': (from + i) % 100 }),
      ),
    },
  },
});

test('a file_stream write between slices of a line-scanning chart job succeeds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-contention-')),
    store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { id } = store.upsert({ entity: 'local', project: 'contention', name: 'scan' });
  let offset = 0;
  for (const count of [6000, 6000, 100]) {
    store.ingest(id, events(offset, count));
    offset += count;
  }
  // The worker serves queued requests whenever a job yields; write at every such point.
  const job = store.chartJob({ runs: [id], metrics: ['system/cpu'], recordTransform: align });
  let step = job.next(),
    writes = 0;
  while (!step.done) {
    store.ingest(id, events(offset++, 1));
    writes++;
    step = job.next();
  }
  assert.ok(writes >= 2, 'the job suspends while scanning lines');
  assert.equal(store.history.lineStats(id, 'wandb-events.jsonl').records, offset);
  assert.ok(step.value.series[0].values['system/cpu'].length > 0);
});

test('file_stream posts keep succeeding while the worker scans lines for a chart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-contention-http-')),
    server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = await server.db.call('upsert', { entity: 'e', project: 'p', name: 'r' });
  let offset = 0;
  for (let i = 0; i < 6; i++) {
    await server.db.call('ingest', run.id, events(offset, 10000));
    offset += 10000;
  }
  const chart = server.db.call('chartJob', {
    runs: [run.id],
    metrics: ['system/cpu'],
    recordTransform: align,
  });
  let pending = true;
  void chart.finally(() => (pending = false)).catch(() => {});
  const statuses = [];
  while (pending || !statuses.length) {
    const response = await server.app.inject({
      method: 'POST',
      url: '/files/e/p/r/file_stream',
      payload: events(offset++, 1),
    });
    statuses.push([response.statusCode, response.body]);
  }
  assert.ok((await chart).series[0].values['system/cpu'].length > 0);
  assert.deepEqual(
    statuses.filter(([status]) => status !== 200),
    [],
  );
});

test('database contention is a retryable 503 with Retry-After, never a 4xx', async (t) => {
  const busy = TypeError('This database connection is busy executing a query');
  assert.equal(errorFields(busy).statusCode, 503);
  assert.equal(errorFields(TypeError('This statement is busy executing a query')).statusCode, 503);
  for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'])
    assert.equal(errorFields(Object.assign(Error('database is locked'), { code })).statusCode, 503);
  assert.equal(errorFields(Error('Unknown run')).statusCode, undefined);

  const directory = await mkdtemp(join(tmpdir(), 'randl-contention-status-')),
    server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = server.db.call.bind(server.db);
  for (const error of [busy, Object.assign(Error('database is locked'), { code: 'SQLITE_BUSY' })]) {
    server.db.call = (method, ...args) =>
      method === 'ingest' ? Promise.reject(error) : call(method, ...args);
    const response = await server.app.inject({
      method: 'POST',
      url: '/files/e/p/r/file_stream',
      payload: events(0, 1),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '1');
  }
  server.db.call = call;
});
