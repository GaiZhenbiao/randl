import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { listen } from './helpers.mjs';

// run_metadata_update: backfilling config keys, tags and notes on stored runs.
test('run metadata updates change only config keys, tags and notes, idempotently', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const run = await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'r1',
    config: {
      _wandb: { value: { cli_version: '0.30.0' } },
      rl: { value: { lr: 1e-6 } },
      lineage: { value: { parent: null, relation: [], hypothesis: 'old' } },
    },
    tags: ['keep', 'verdict:running'],
    summaryMetrics: { loss: 1 },
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': { offset: 0, content: [JSON.stringify({ _step: 0, loss: 1 })] },
    },
    complete: true,
  });
  const stored = () => server.db.call('run', run.id);
  const before = await stored();
  const call = (payload) =>
    server.app.inject({ method: 'POST', url: '/api/tools/run_metadata_update', payload });

  const lineage = {
    parent: { run_id: 'abc', update: 543000 },
    relation: ['initialize_from', 'grown_head'],
    changes: { 'model.head': [512, 1024] },
  };
  const first = await call({
    id: run.id,
    config: { lineage },
    configMerge: { rl: { checkpoint: { save_dir: '/c/r1' } } },
    addTags: ['verdict:adopted'],
    removeTags: ['verdict:running'],
    notes: 'Backfilled',
    by: 'aeroseeker-backfill',
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().changed, true);
  const after = await stored();
  const config = JSON.parse(after.config);
  assert.deepEqual(config.lineage, { value: lineage });
  assert.deepEqual(config.rl, { value: { lr: 1e-6, checkpoint: { save_dir: '/c/r1' } } });
  assert.deepEqual(config._wandb, { value: { cli_version: '0.30.0' } });
  assert.deepEqual(JSON.parse(after.tags), ['keep', 'verdict:adopted']);
  assert.equal(after.notes, 'Backfilled');
  for (const field of ['state', 'summary', 'history_count', 'runtime', 'finished', 'heartbeat'])
    assert.deepEqual(after[field], before[field], field);
  assert.equal(after.revision, before.revision + 1);

  // The same request again changes nothing, not even the revision.
  const repeat = await call({
    id: run.id,
    config: { lineage },
    configMerge: { rl: { checkpoint: { save_dir: '/c/r1' } } },
    addTags: ['verdict:adopted'],
    removeTags: ['verdict:running'],
    notes: 'Backfilled',
  });
  assert.equal(repeat.json().changed, false);
  assert.equal((await stored()).revision, after.revision);

  // Null removes a nested key (merge) or a whole key (replace); tags can be replaced.
  const removal = await call({
    id: run.id,
    configMerge: { rl: { checkpoint: null } },
    config: { lineage: null },
    tags: ['only'],
  });
  assert.deepEqual(removal.json().config, { rl: { lr: 1e-6 } });
  assert.deepEqual(removal.json().tags, ['only']);

  // Updates are audited with their caller.
  const audit = await server.db.call('auditList');
  const entry = audit.find(
    (item) => item.tool === 'run_metadata_update' && item.arguments.includes('aeroseeker-backfill'),
  );
  assert.ok(entry, 'audited with the caller');

  // SDK-reserved keys and unknown runs are refused.
  assert.equal((await call({ id: run.id, config: { _wandb: {} } })).statusCode, 400);
  const missing = await call({ id: 'e/p/none', tags: [] });
  assert.equal(missing.statusCode, 404);
});

test('a metadata update leaves an imported snapshot run a snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-metadata-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  const { id } = store.upsert({ entity: 'e', project: 'p', name: 'imported', state: 'finished' });
  store.db.prepare("UPDATE runs SET snapshot_at=1,snapshot_source='Synthetic' WHERE id=?").run(id);
  store.db.close();
  const server = await createServer(directory);
  t.after(() => server.app.close());
  await server.tools.execute('run_metadata_update', { id, addTags: ['verdict:adopted'] });
  const run = await server.db.call('run', id);
  assert.equal(run.snapshot_at, 1);
  assert.equal(run.state, 'finished');
  assert.deepEqual(JSON.parse(run.tags), ['verdict:adopted']);
});

test('randl runs update-meta sends the update from the command line', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-metadata-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const url = await listen(server);
  const run = await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'r2',
    tags: ['a'],
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      'backend/dist/cli.js',
      'runs',
      'update-meta',
      '--url',
      url,
      '--id',
      run.id,
      '--config',
      JSON.stringify({ lineage: { hypothesis: 'h' } }),
      '--add-tags',
      'verdict:rejected',
      '--by',
      'cli-test',
    ],
    { env: { ...process.env, RANDL_API_KEY: '' } },
  );
  const result = JSON.parse(stdout);
  assert.deepEqual(result.config.lineage, { hypothesis: 'h' });
  assert.deepEqual(result.tags, ['a', 'verdict:rejected']);
});

// Metric renames and history writes on a stored run, through the store so history can be
// sealed into blocks first.
const drain = (job) => {
  for (;;) {
    const step = job.next();
    if (step.done) return step.value;
  }
};
async function historyFixture(t, rows) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  t.after(() => store.db.close());
  const { id } = store.upsert({
    entity: 'e',
    project: 'p',
    name: 'r',
    summaryMetrics: { old: rows.at(-1).old, keep: 1 },
    config: {
      _wandb: { value: { m: [{ 1: 'old', 4: 'epoch' }] } },
    },
  });
  store.ingest(id, {
    files: {
      'wandb-history.jsonl': { offset: 0, content: rows.map((row) => JSON.stringify(row)) },
    },
    complete: true,
  });
  const key = store.history.runKey(id);
  store.history.transaction(() =>
    store.history.sealRun(key, { until: Infinity, points: Infinity, lines: Infinity }, true),
  );
  const records = () =>
    [...store.history.lines(key, 'wandb-history.jsonl')].map((line) => JSON.parse(line.content));
  const series = (name) => {
    const { steps, values } = store.history.series(key, name);
    return Array.from(steps, (step, index) => [step, values[index]]);
  };
  const run = () => store.run(id);
  return { store, id, key, records, series, run };
}
const history = (count, make) => Array.from({ length: count }, (_, step) => make(step));

test('renaming a metric moves its history, points, summary and settings, and undoes', async (t) => {
  const rows = history(600, (step) => ({ _step: step, old: step / 10, loss: 1 }));
  const { store, id, records, series, run } = await historyFixture(t, rows);
  assert.ok(store.db.prepare('SELECT count(*) n FROM stream_blocks').get().n > 1, 'sealed blocks');
  const before = records();
  const { renames } = drain(
    store.metricsRename({ id, renames: [{ from: 'old', to: 'new' }], by: 't' }),
  );
  assert.equal(renames[0].status, 'renamed');
  assert.ok(records().every((row, index) => row.new === before[index].old && !('old' in row)));
  assert.deepEqual(Object.keys(records()[3]), ['_step', 'new', 'loss'], 'key order kept');
  assert.deepEqual(
    series('new'),
    rows.map((row) => [row._step, row.old]),
  );
  assert.deepEqual(series('old'), []);
  assert.deepEqual(store.keys([id]), ['loss', 'new']);
  assert.deepEqual(JSON.parse(run().summary), { keep: 1, new: 59.9 });
  assert.equal(JSON.parse(run().metric_definitions)[0].name, 'new');
  // Repeating changes nothing; renaming onto an existing key needs a merge.
  assert.equal(
    drain(store.metricsRename({ id, renames: [{ from: 'old', to: 'new' }] })).renames[0].status,
    'unchanged',
  );
  assert.throws(
    () => drain(store.metricsRename({ id, renames: [{ from: 'loss', to: 'new' }] })),
    /the new key exists; merge to combine/,
  );
  assert.throws(
    () => drain(store.metricsRename({ id, renames: [{ from: 'loss', to: 'new' }], merge: true })),
    /a step or record has both keys/,
  );
  // Undo restores the original records exactly.
  const undone = drain(store.metricsRenameUndo({ undo: renames[0].undo }));
  assert.equal(undone.status, 'undone');
  assert.deepEqual(records(), before);
  assert.deepEqual(
    series('old'),
    rows.map((row) => [row._step, row.old]),
  );
  assert.deepEqual(JSON.parse(run().summary), { old: 59.9, keep: 1 });
  assert.equal(drain(store.metricsRenameUndo({ undo: renames[0].undo })).status, 'unchanged');
});

test('a merge combines two keys logged at different steps, and its undo splits them', async (t) => {
  // An old run logged `old` at even steps and `new` at odd ones.
  const rows = history(400, (step) =>
    step % 2 ? { _step: step, new: step } : { _step: step, old: -step - 1 },
  );
  const { store, id, records, series } = await historyFixture(t, rows);
  const before = records();
  const { renames } = drain(
    store.metricsRename({ id, renames: [{ from: 'old', to: 'new' }], merge: true }),
  );
  assert.equal(renames[0].status, 'merged');
  assert.deepEqual(
    series('new'),
    rows.map((row) => [row._step, row.new ?? row.old]),
  );
  assert.ok(records().every((row) => !('old' in row)));
  drain(store.metricsRenameUndo({ undo: renames[0].undo }));
  assert.deepEqual(records(), before);
  assert.deepEqual(
    series('old'),
    rows.filter((row) => 'old' in row).map((row) => [row._step, row.old]),
  );
  assert.deepEqual(
    series('new'),
    rows.filter((row) => 'new' in row).map((row) => [row._step, row.new]),
  );
});

test('history writes merge audit values into records at their steps', async (t) => {
  const rows = history(500, (step) => ({ _step: step * 10, loss: step }));
  const { store, id, records, series, run } = await historyFixture(t, rows);
  const audit = 'audit/box/value';
  const write = (extra = {}) =>
    drain(
      store.historyWrite({
        id,
        rows: [
          { step: 1000, values: { [audit]: 0.5 } },
          { step: 4990, values: { [audit]: 0.75 } },
          // No record at this step: a new one is added.
          { step: 9000, values: { [audit]: 0.8 } },
        ],
        ...extra,
      }),
    );
  const revision = run().revision;
  const statuses = (result) => result.rows.map((row) => row.status);
  assert.deepEqual(statuses(write({ dryRun: true })), ['merged', 'merged', 'added']);
  assert.equal(run().revision, revision, 'a dry run writes nothing');
  assert.deepEqual(statuses(write()), ['merged', 'merged', 'added']);
  assert.ok(run().revision > revision);
  assert.deepEqual(records()[100], { _step: 1000, loss: 100, [audit]: 0.5 });
  assert.deepEqual(records().at(-1), { _step: 9000, [audit]: 0.8 });
  assert.deepEqual(series(audit), [
    [1000, 0.5],
    [4990, 0.75],
    [9000, 0.8],
  ]);
  assert.ok(store.keys([id]).includes(audit));
  // The same write again changes nothing; a different value needs replace.
  const again = run().revision;
  const repeat = write();
  assert.equal(repeat.changed, false);
  assert.deepEqual(statuses(repeat).slice(0, 2), ['unchanged', 'unchanged']);
  assert.equal(run().revision, again);
  assert.throws(
    () => drain(store.historyWrite({ id, rows: [{ step: 1000, values: { loss: 7 } }] })),
    /1 of 1 rows were refused \(row 0: conflict\); nothing was written/,
  );
  drain(store.historyWrite({ id, rows: [{ step: 1000, values: { loss: 7 } }], replace: true }));
  assert.equal(records()[100].loss, 7);
  assert.deepEqual(
    series('loss').find(([step]) => step === 1000),
    [1000, 7],
  );
});

test('history rows can name their record by a logged field instead of the step', async (t) => {
  // Steps here are offset from updates, as in runs resumed with step offsets.
  const rows = history(300, (index) => ({
    _step: 7000 + index * 3,
    update: 1000 + index * 10,
    loss: index,
  }));
  rows.push({ _step: 9000, update: 1500, loss: 0 }); // a second record logged at update 1500
  const { store, id, records, series } = await historyFixture(t, rows);
  const audit = 'audit/box/value';
  const merge = (extra = {}) =>
    drain(
      store.historyWrite({
        id,
        rows: [
          { match: { update: 1100 }, values: { [audit]: 0.6 } },
          { match: { update: 1500 }, values: { [audit]: 0.7 } },
          { match: { update: 1234 }, values: { [audit]: 0.8 } },
        ],
        ...extra,
      }),
    );
  assert.deepEqual(
    merge({ dryRun: true }).rows.map(({ status, reason, step }) => [status, reason, step]),
    [
      ['merged', undefined, 7030],
      ['refused', 'ambiguous', undefined],
      ['refused', 'no-match', undefined],
    ],
  );
  assert.throws(() => merge(), /2 of 3 rows were refused/);
  assert.deepEqual(series(audit), [], 'nothing written');
  const one = drain(
    store.historyWrite({ id, rows: [{ match: { update: 1100 }, values: { [audit]: 0.6 } }] }),
  );
  assert.deepEqual(one.rows, [{ row: 0, status: 'merged', step: 7030, keys: 1, replaced: 0 }]);
  assert.deepEqual(records()[10], { _step: 7030, update: 1100, loss: 10, [audit]: 0.6 });
  assert.deepEqual(series(audit), [[7030, 0.6]]);
});

test('a rename dry run counts the records and points of each key', async (t) => {
  const rows = history(50, (step) =>
    step < 20 ? { _step: step, old: step } : { _step: step, b: 1 },
  );
  const { store, id, records } = await historyFixture(t, rows);
  const before = records();
  const plan = drain(
    store.metricsRename({
      id,
      renames: [
        { from: 'old', to: 'new' },
        { from: 'b', to: 'old' },
        { from: 'gone', to: 'x' },
      ],
      dryRun: true,
    }),
  );
  assert.deepEqual(
    plan.renames.map(({ from, status, reason, records, points }) => [
      from,
      status,
      reason,
      records,
      points,
    ]),
    [
      ['old', 'renamed', undefined, 20, 20],
      ['b', 'refused', 'exists', 30, 30],
      ['gone', 'missing', undefined, 0, 0],
    ],
  );
  assert.deepEqual(records(), before);
  // One refused rename refuses them all.
  assert.throws(
    () =>
      drain(
        store.metricsRename({
          id,
          renames: [
            { from: 'old', to: 'new' },
            { from: 'b', to: 'old' },
          ],
        }),
      ),
    /nothing was renamed/,
  );
  assert.deepEqual(records(), before);
});

test('metric renames and history writes are tools with audit, summary and a CLI', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-metrics-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const url = await listen(server);
  const run = await server.db.call('upsert', { entity: 'e', project: 'p', name: 'r3' });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _step: 0, old: 1 }), JSON.stringify({ _step: 1, old: 2 })],
      },
    },
    complete: true,
  });
  const cli = async (...args) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ['backend/dist/cli.js', ...args, '--url', url],
          {
            env: { ...process.env, RANDL_API_KEY: '' },
          },
        )
      ).stdout,
    );
  const renamed = await cli(
    'runs',
    'rename-metrics',
    '--id',
    run.id,
    '--rename',
    'old=new',
    '--by',
    'cli',
  );
  assert.equal(renamed.renames[0].status, 'renamed');
  const written = await cli(
    'runs',
    'write-history',
    '--id',
    run.id,
    '--rows',
    JSON.stringify([{ step: 1, values: { 'audit/x': 0.5 } }]),
  );
  assert.deepEqual(written.rows, [{ row: 0, status: 'merged', step: 1, keys: 1, replaced: 0 }]);
  const summary = await cli('runs', 'update-meta', '--id', run.id, '--summary', '{"audit/x": 0.5}');
  assert.equal(summary.summary['audit/x'], 0.5);
  const undone = await cli('runs', 'rename-metrics', '--undo', String(renamed.renames[0].undo));
  assert.equal(undone.status, 'undone');
  const audit = await server.db.call('auditList');
  for (const tool of ['run_metrics_rename', 'run_history_write', 'run_metrics_rename_undo'])
    assert.ok(
      audit.some((entry) => entry.tool === tool),
      tool,
    );
  const refused = await server.app.inject({
    method: 'POST',
    url: '/api/tools/run_metrics_rename',
    payload: { id: run.id, renames: [{ from: 'old', to: '_step' }] },
  });
  assert.equal(refused.statusCode, 400);
  // Refusals carry their code over HTTP, so scripts can tell them apart.
  const conflict = await server.app.inject({
    method: 'POST',
    url: '/api/tools/run_history_write',
    payload: { id: run.id, rows: [{ step: 1, values: { 'audit/x': 0.9 } }] },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'HISTORY_ROWS_REFUSED');
});

test('a matched row with no record is added at the given or the implied step', async (t) => {
  // Records every 100 updates, two steps per update, offset by 5000; one record logs no update.
  const rows = history(10, (index) => ({
    _step: 5000 + index * 200,
    update: index * 100,
    loss: index,
  }));
  rows.push({ _step: 5150, loss: -1 });
  const { store, id, records, series } = await historyFixture(t, rows);
  const audit = 'audit/box/value';
  const result = drain(
    store.historyWrite({
      id,
      rows: [
        // Between updates 300 and 400: step 5600 + 50 × 2.
        { match: { update: 350 }, values: { [audit]: 0.5 } },
        // Given its step outright.
        { match: { update: 2000 }, step: 9000, values: { [audit]: 0.6 } },
        // Beyond the last record: no neighbour above, so no step to infer.
        { match: { update: 5000 }, values: { [audit]: 0.7 } },
        // Implied step 5150 is already used by another record.
        { match: { update: 75 }, values: { [audit]: 0.8 } },
      ],
      dryRun: true,
    }),
  );
  assert.deepEqual(
    result.rows.map(({ status, reason, step, inferred }) => [status, reason, step, inferred]),
    [
      ['added', undefined, 5700, true],
      ['added', undefined, 9000, undefined],
      ['refused', 'no-match', undefined, undefined],
      ['refused', 'step-taken', 5150, undefined],
    ],
  );
  drain(
    store.historyWrite({
      id,
      rows: [
        { match: { update: 350 }, values: { [audit]: 0.5 } },
        { match: { update: 2000 }, step: 9000, values: { [audit]: 0.6 } },
      ],
    }),
  );
  assert.deepEqual(records().slice(-2), [
    { _step: 5700, update: 350, [audit]: 0.5 },
    { _step: 9000, update: 2000, [audit]: 0.6 },
  ]);
  assert.deepEqual(series(audit), [
    [5700, 0.5],
    [9000, 0.6],
  ]);
  assert.ok(series('update').some(([step, value]) => step === 5700 && value === 350));
  // Running it again finds the added records and changes nothing.
  const again = drain(
    store.historyWrite({ id, rows: [{ match: { update: 350 }, values: { [audit]: 0.5 } }] }),
  );
  assert.deepEqual(
    again.rows.map((row) => row.status),
    ['unchanged'],
  );
});
