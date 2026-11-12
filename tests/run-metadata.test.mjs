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
