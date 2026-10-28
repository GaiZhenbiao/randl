import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';

test('runs created after the last visibility choice are visible; explicitly hidden runs stay hidden', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-new-runs-'));
  const server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = async (name) => {
    const created = await server.db.call('upsert', { entity: 'local', project: 'p', name });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return created.id;
  };
  const tools = server.tools;
  const a = await run('a'),
    b = await run('b');
  const view = await tools.execute('view_create', { name: 'Compare', project: 'local/p', body: { panels: [], visible: [a], solo: [] } });
  assert.deepEqual((await tools.execute('view_get', { id: view.id })).body.visible, [a], 'existing hidden run b stays hidden');
  const c = await run('c');
  assert.deepEqual((await tools.execute('view_get', { id: view.id })).body.visible, [a, c], 'new run c is visible');
  await tools.execute('runs_select', { view: view.id, visible: [a], solo: [] });
  const d = await run('d');
  const after = await tools.execute('view_get', { id: view.id });
  assert.deepEqual(after.body.visible, [a, d], 'hidden c stays hidden and later run d is visible');
  assert.deepEqual(after.body.solo, [], 'solo is unchanged');
  await tools.execute('runs_select', { view: view.id, solo: [a] });
  await run('e');
  const solo = await tools.execute('view_get', { id: view.id });
  assert.deepEqual(solo.body.solo, [a], 'arriving runs never join solo');
  assert.ok(solo.body.visible.includes(d) && !solo.body.visible.includes(b));
  const runView = await tools.execute('view_create', { name: 'Run view', project: 'local/p', body: { panels: [], visible: [a], solo: [], run: a } });
  await run('f');
  assert.deepEqual((await tools.execute('view_get', { id: runView.id })).body.visible, [a], 'run pages are unaffected');
});
