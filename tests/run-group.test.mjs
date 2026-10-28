import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';

test('run list and chart grouping refuse unknown group fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-group-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.db
    .prepare('INSERT INTO views VALUES(?,?,?,?,?,?)')
    .run(
      'state',
      'View state',
      'test/group',
      JSON.stringify({ panels: [], visible: [], solo: [], runQuery: { group: 'state' } }),
      1,
      1,
    );
  store.db.close();
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const pick = ({ id, name, project, version, body }) => ({ id, name, project, version, body });
  const view = pick(await server.db.call('view', 'state'));
  for (const value of ['none', 'seed', 'config._private']) {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/views/state',
      payload: {
        name: view.name,
        project: view.project,
        version: view.version,
        body: { ...view.body, runQuery: { group: value } },
      },
    });
    assert.equal(response.statusCode, 400, value);
    assert.equal(
      response.json().error,
      'runQuery.group must be empty (no grouping) or a run field such as config.seed, summary.loss or tags.',
    );
  }
  for (const value of ['', 'state', 'running', 'tags', 'config.seed', 'summary.loss']) {
    const current = pick(await server.db.call('view', 'state'));
    const saved = await server.tools.execute('view_save', {
      ...current,
      body: { ...current.body, runQuery: { group: value } },
    });
    assert.equal(saved.body.runQuery.group, value);
  }
  for (const groupBy of ['seed', 'inherit']) {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/views/state',
      payload: {
        name: view.name,
        project: view.project,
        version: (await server.db.call('view', 'state')).version,
        body: { ...view.body, plotSettings: { groupBy } },
      },
    });
    assert.equal(response.statusCode, 400, groupBy);
    assert.equal(
      response.json().error,
      'plotSettings.groupBy must be none, all or a run field such as config.seed.',
    );
  }
});

test('state groupings list running runs first in every chart path and follow state changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-state-group-'));
  const store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const history = (rows, extra = {}) => ({
    files: {
      'wandb-history.jsonl': { offset: 0, content: rows.map((row) => JSON.stringify(row)) },
    },
    ...extra,
  });
  const run = (name, value, extra) => {
    const id = store.upsert({ entity: 'e', project: 'p', name }).id;
    store.ingest(id, history([{ _step: 0, a: value, b: 1 }], extra));
    return id;
  };
  // Runs in creation order: finished, failed, running, running.
  const finished = run('finished', 1, { complete: true }),
    failed = run('failed', 3, { complete: true, exitcode: 1 }),
    live = run('live', 5),
    other = run('other', 7);
  const runs = [finished, failed, live, other];
  const requests = (groupBy) => [
    { runs, metrics: ['a'], settings: { groupBy } },
    { runs, metrics: ['a'], mode: 'snapshot', settings: { groupBy } },
    {
      runs,
      metrics: ['a / b'],
      settings: { groupBy },
      recordTransform: {
        kind: 'compute',
        expressions: [{ name: 'a / b', expression: '${a} / ${b}' }],
      },
    },
  ];
  const groups = (data) =>
    data.series.map((series) => [series.name, series.group.value, series.runIds]);
  for (const request of requests('running')) {
    const data = store.chart(request);
    assert.deepEqual(groups(data), [
      ['Running', true, [live, other]],
      ['Not running', false, [finished, failed]],
    ]);
    const metric = request.metrics[0];
    assert.equal(data.series[0].values[metric].at(-1)[1], 6);
    assert.equal(data.series[1].values[metric].at(-1)[1], 2);
  }
  for (const request of requests('state'))
    assert.deepEqual(groups(store.chart(request)), [
      ['running', 'running', [live, other]],
      ['finished', 'finished', [finished]],
      ['failed', 'failed', [failed]],
    ]);
  // Running groups come first even when a limit keeps only one group.
  const limited = store.chart({
    runs,
    metrics: ['a'],
    settings: { groupBy: 'running', maxRuns: 1 },
  });
  assert.deepEqual(groups(limited), [['Running', true, [live, other]]]);
  assert.equal(limited.groupCount, 2);
  // Finishing changes the run's revision, so cached grouped charts are refreshed.
  const before = store.run(live).revision;
  store.ingest(live, { complete: true });
  assert.ok(store.run(live).revision > before);
  assert.deepEqual(groups(store.chart(requests('running')[0])), [
    ['Running', true, [other]],
    ['Not running', false, [finished, failed, live]],
  ]);
});
