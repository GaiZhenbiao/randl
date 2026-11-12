import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createServer } from '../backend/dist/server.js';
import { listen } from './helpers.mjs';

// run_state_set: marking a run that ended as stopped on purpose (state killed), and back.
test('a run that ended is marked stopped with a reason, idempotently, and stays stopped', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const run = await server.db.call('upsert', { entity: 'e', project: 'p', name: 'r1' });
  const call = async (payload, status = 200) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tools/run_state_set',
      payload,
    });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const stored = () => server.db.call('run', run.id);

  // Still running: refused, and nothing changes.
  const refused = await call({ id: run.id, state: 'stopped' }, 409);
  assert.equal(refused.code, 'RUN_STATE_RUNNING');
  assert.equal((await stored()).state, 'running');

  await server.db.call('ingest', run.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content: [JSON.stringify({ _step: 0, x: 1 })] } },
    complete: true,
  });
  assert.equal((await stored()).state, 'finished');

  const reason = 'Collision rate kept rising after u550000';
  assert.deepEqual(await call({ id: run.id, state: 'stopped', reason, by: 'me', dryRun: true }), {
    status: 'updated',
    dryRun: true,
    id: run.id,
    state: 'stopped',
    previous: 'finished',
  });
  assert.equal((await stored()).state, 'finished');
  const marked = await call({ id: run.id, state: 'stopped', reason, by: 'me' });
  assert.equal(marked.status, 'updated');
  const after = await stored();
  assert.deepEqual([after.state, after.state_reason, after.state_by], ['killed', reason, 'me']);
  assert.ok(after.state_at > 0);
  // The same request again changes nothing and is not audited again.
  assert.equal(
    (await call({ id: run.id, state: 'stopped', reason, by: 'me' })).status,
    'unchanged',
  );
  const audited = (await server.db.call('auditList')).filter(
    (entry) => entry.tool === 'run_state_set',
  );
  assert.equal(audited.length, 1);

  // A later finish from the SDK or a re-sync does not undo the mark.
  await server.db.call('upsert', { entity: 'e', project: 'p', name: 'r1', state: 'finished' });
  await server.db.call('ingest', run.id, {
    files: { 'wandb-history.jsonl': { offset: 1, content: [JSON.stringify({ _step: 1, x: 2 })] } },
    complete: true,
  });
  assert.equal((await stored()).state, 'killed');
  // Run lists and the lineage graph carry the state and the reason.
  const lineage = await server.tools.execute('project_lineage', { id: 'e/p' });
  const node = lineage.nodes.find((item) => item.id === run.id);
  assert.deepEqual([node.state, node.stateReason], ['killed', reason]);

  // Back to finished: the reason goes.
  await call({ id: run.id, state: 'finished', by: 'me' });
  const back = await stored();
  assert.deepEqual([back.state, back.state_reason], ['finished', null]);
  await call({ id: 'e/p/missing', state: 'stopped' }, 404);
});

test('randl runs set-state marks a run stopped from the command line', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-run-state-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const url = await listen(server);
  const run = await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'r2',
    state: 'crashed',
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      'backend/dist/cli.js',
      'runs',
      'set-state',
      '--url',
      url,
      '--id',
      run.id,
      '--state',
      'stopped',
      '--reason',
      'Superseded by v661',
      '--by',
      'cli-test',
    ],
    { env: { ...process.env, RANDL_API_KEY: '' } },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.state, 'stopped');
  assert.equal((await server.db.call('run', run.id)).state_reason, 'Superseded by v661');
});
