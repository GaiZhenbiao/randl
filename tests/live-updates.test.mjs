import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createServer } from '../backend/dist/server.js';
import { chartDiff } from '../backend/dist/chart-diff.js';

const source = await readFile(new URL('../frontend/src/chart-data.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { applyChartDiff } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
);
const authKey = 'randl-live-test-key-not-a-secret-00000000000000000000000000000000';
const history = (rows, offset = 0) => ({
  files: { 'wandb-history.jsonl': { offset, content: rows.map((row) => JSON.stringify(row)) } },
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-live-'));
  const server = await createServer(directory, options);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, base: `http://127.0.0.1:${server.app.server.address().port}` };
}

async function subscribe(t, base, headers = {}) {
  const events = new EventEmitter();
  const frames = [];
  let closed = false;
  let buffer = '';
  const request = get(base + '/api/events', { headers });
  t.after(() => request.destroy());
  request.on('error', (error) => events.emit('failure', error));
  events.on('failure', () => {});
  const response = await new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  assert.equal(response.statusCode, 200);
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const lines = buffer.slice(0, boundary).split('\n');
      buffer = buffer.slice(boundary + 2);
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      const frame = {
        event:
          lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim() || 'message',
        data: JSON.parse(data),
      };
      frames.push(frame);
      events.emit('frame', frame);
    }
  });
  response.on('close', () => {
    closed = true;
    events.emit('closed');
  });
  response.on('error', (error) => events.emit('failure', error));
  const waitFor = (predicate, milliseconds = 1500) => {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const finish = (error, frame) => {
        clearTimeout(timer);
        events.off('frame', onFrame);
        if (error) reject(error);
        else resolve(frame);
      };
      const onFrame = (frame) => {
        if (predicate(frame)) finish(null, frame);
      };
      const timer = setTimeout(
        () => finish(Error('Expected live event was not delivered')),
        milliseconds,
      );
      events.on('frame', onFrame);
    });
  };
  const waitClosed = () =>
    closed
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            events.off('closed', onClose);
            reject(Error('Revoked live stream stayed open'));
          }, 1500);
          const onClose = () => {
            clearTimeout(timer);
            resolve();
          };
          events.once('closed', onClose);
        });
  await waitFor((frame) => frame.event === 'ready');
  return { frames, waitFor, waitClosed };
}

test('chart deltas reconstruct exact values, duplicate X, metadata and series order', () => {
  const previous = {
    metrics: ['loss'],
    sampled: true,
    revision: 'old',
    series: [
      { id: 'remove', name: 'Removed', values: { loss: [[0, 1]] } },
      {
        id: 'update',
        name: 'Before',
        values: {
          loss: [
            [0, 1],
            [1, 2],
            [2, 3],
          ],
        },
        bands: { loss: [[0, 0, 2]] },
      },
      {
        id: 'duplicate',
        values: {
          loss: [
            [0, 1],
            [0, 5],
          ],
        },
      },
    ],
  };
  const next = {
    metrics: ['loss'],
    sampled: false,
    revision: 'new',
    series: [
      {
        id: 'duplicate',
        values: {
          loss: [
            [0, 9],
            [0, 11],
            [1, 3],
          ],
        },
      },
      { id: 'add', name: 'Added', values: { loss: [[0, -5]] } },
      {
        id: 'update',
        name: 'After',
        values: {
          loss: [
            [1, 8],
            [2, 3],
            [3, 4],
          ],
        },
        bands: { loss: [[1, 0, 16]] },
      },
    ],
  };
  const original = structuredClone(previous);
  assert.deepEqual(applyChartDiff(previous, chartDiff(previous, next)), next);
  assert.deepEqual(previous, original, 'Applying a delta must not mutate the cached base');
  assert.equal(chartDiff({ media: [], series: [] }, { media: [], series: [] }), null);
});

test('chart deltas remove absent metric keys instead of retaining empty metrics', () => {
  const previous = {
    metrics: ['loss', 'score'],
    series: [{ id: 'r', values: { loss: [[0, 1]], score: [[0, 2]] } }],
  };
  const next = { metrics: ['loss'], series: [{ id: 'r', values: { loss: [[0, 1]] } }] };
  assert.deepEqual(applyChartDiff(previous, chartDiff(previous, next)), next);
});

test('chart deltas retain a newly requested metric with no recorded points', () => {
  const previous = { metrics: ['loss'], series: [{ id: 'r', values: { loss: [[0, 1]] } }] };
  const next = {
    metrics: ['loss', 'sparse'],
    series: [{ id: 'r', values: { loss: [[0, 1]], sparse: [] } }],
  };
  assert.deepEqual(applyChartDiff(previous, chartDiff(previous, next)), next);
});

test('server chart revisions distinguish unchanged data, appended history and renamed metadata', async (t) => {
  const { app, db } = await fixture(t);
  const run = await db.call('upsert', { entity: 'e', project: 'p', name: 'r' });
  await db.call(
    'ingest',
    run.id,
    history(Array.from({ length: 200 }, (_, i) => ({ _step: i, loss: i / 10 }))),
  );
  const body = { runs: [run.id], metrics: ['loss'], pixels: 1024 };
  const chart = async (extra = {}) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chart',
      payload: { ...body, ...extra },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const first = await chart();
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(await chart({ baseRevision: first.revision }), {
    unchanged: true,
    revision: first.revision,
  });
  await app.inject({
    method: 'POST',
    url: '/files/e/p/r/file_stream',
    payload: history([{ _step: 200, loss: -7 }], 200),
  });
  const delta = await chart({ baseRevision: first.revision });
  assert.equal(delta.delta, true, 'A small append should use the cached base revision');
  const appended = applyChartDiff(first, delta);
  assert.deepEqual(appended, await chart());
  assert.deepEqual(appended.series[0].values.loss.at(-1), [200, -7]);
  await app.inject({
    method: 'PATCH',
    url: '/api/run',
    payload: { id: run.id, displayName: 'Renamed' },
  });
  const renamed = applyChartDiff(appended, await chart({ baseRevision: appended.revision }));
  assert.equal(renamed.series[0].name, 'Renamed');
  assert.notEqual(renamed.revision, appended.revision);
  const unavailableBase = await chart({ baseRevision: 'f'.repeat(64) });
  assert.ok(!unavailableBase.delta && !unavailableBase.unchanged);
  assert.deepEqual(unavailableBase, renamed);
});

test('a stale save cannot recreate a view deleted by another client', async (t) => {
  const { tools, db } = await fixture(t);
  const view = await tools.execute('view_create', { name: 'Deleted elsewhere' });
  await tools.execute('view_delete', { id: view.id });
  await assert.rejects(
    tools.execute('view_save', {
      id: view.id,
      name: 'Stale draft',
      project: view.project,
      body: view.body,
      version: view.version,
    }),
    /deleted|not found|changed|version/i,
  );
  assert.equal(await db.call('view', view.id), null);
});

test('direct shared-tool mutations used by Pi publish workspace updates', async (t) => {
  const { base, tools } = await fixture(t);
  const stream = await subscribe(t, base);
  await tools.execute('view_create', { name: 'Agent edit' });
  await stream.waitFor((frame) => frame.data.workspace === true);
});

test('read-only tools and rejected mutations do not schedule workspace changes', async (t) => {
  const { app, tools, live } = await fixture(t);
  await tools.execute('workspace_snapshot', {});
  const read = await app.inject({ method: 'POST', url: '/api/tools/runs_list', payload: {} });
  assert.equal(read.statusCode, 200);
  const invalid = await app.inject({ method: 'POST', url: '/api/tools/view_create', payload: {} });
  assert.equal(invalid.statusCode, 400);
  assert.equal(live.workspace, false);
  assert.equal(live.timer, undefined);
});

test('SDK ingestion and run edits stream current lightweight metadata', async (t) => {
  const { app, base } = await fixture(t);
  const stream = await subscribe(t, base);
  const initialize = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: { entity: 'e', project: 'p', name: 'live-run', config: { seed: { value: 7 } } },
    },
  });
  assert.equal(initialize.statusCode, 200);
  const findRun = (frame) => frame.data.runs?.find((run) => run.id === 'e/p/live-run');
  const created = findRun(await stream.waitFor((frame) => findRun(frame)?.state === 'running'));
  assert.equal(created.history_count, 0);
  assert.ok(!('config' in created) && !('summary' in created), 'Events carry lightweight metadata');
  const finished = await app.inject({
    method: 'POST',
    url: '/files/e/p/live-run/file_stream',
    payload: {
      ...history([
        { _step: 0, loss: 2 },
        { _step: 1, loss: 1 },
      ]),
      complete: true,
      exitcode: 0,
    },
  });
  assert.equal(finished.statusCode, 200);
  const completed = findRun(await stream.waitFor((frame) => findRun(frame)?.state === 'finished'));
  assert.equal(completed.history_count, 2);
  assert.ok(completed.revision > created.revision);
  await app.inject({
    method: 'PATCH',
    url: '/api/run',
    payload: { id: 'e/p/live-run', displayName: 'New label' },
  });
  const renamed = findRun(
    await stream.waitFor((frame) => findRun(frame)?.display_name === 'New label'),
  );
  assert.ok(renamed.revision > completed.revision);
});

test('SDK artifact mutations publish workspace updates', async (t) => {
  const { app, base } = await fixture(t);
  const stream = await subscribe(t, base);
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: {
      query:
        'mutation CreateArtifact($input: CreateArtifactInput!) { createArtifact(input: $input) { artifact { id state } } }',
      variables: {
        input: {
          entityName: 'e',
          projectName: 'p',
          artifactCollectionName: 'live-artifact',
          artifactTypeName: 'dataset',
          digest: 'fixture',
          clientID: 'live-client',
        },
      },
    },
  });
  assert.ok(response.json().data?.createArtifact?.artifact?.id, response.body);
  await stream.waitFor((frame) => frame.data.workspace === true);
});

for (const revocation of ['logout', 'expiry'])
  test(`authenticated live stream stops after session ${revocation}`, async (t) => {
    const { app, db, base } = await fixture(t, { apiKey: authKey });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { key: authKey },
    });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const stream = await subscribe(t, base, { cookie });
    if (revocation === 'logout') {
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie },
      });
      assert.equal(logout.statusCode, 200);
    } else {
      const token = cookie.slice(cookie.indexOf('=') + 1);
      await db.call(
        'sessionCreate',
        createHash('sha256').update(token).digest('hex'),
        Date.now() - 1,
      );
    }
    assert.equal((await app.inject({ url: '/api/runs', headers: { cookie } })).statusCode, 401);
    await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: 'Bearer ' + authKey },
      payload: {
        query: 'mutation UpsertBucket { upsertBucket }',
        variables: { entity: 'e', project: 'p', name: 'private-after-revocation' },
      },
    });
    await stream.waitClosed();
    assert.ok(
      !stream.frames.some((frame) =>
        frame.data.runs?.some((run) => run.name === 'private-after-revocation'),
      ),
      'Revoked clients must not receive later private metadata',
    );
  });
