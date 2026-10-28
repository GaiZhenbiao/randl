import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../backend/dist/server.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-tool-clients-'));
  const key = 'synthetic-concurrency-owner-key'.padEnd(40, '0');
  let server;
  t.after(async () => {
    await server?.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  server = await createServer(directory, { apiKey: key });
  async function login() {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { key },
    });
    assert.equal(response.statusCode, 200);
    return String(response.headers['set-cookie']).split(';')[0];
  }
  const [first, second] = await Promise.all([login(), login()]);
  assert.notEqual(first, second, 'The clients use separate browser sessions');
  const view = await server.tools.execute('view_create', {
    name: 'Concurrent edits',
    project: 'local/tool-clients',
  });
  const run = await server.db.call('upsert', {
    entity: 'local',
    project: 'tool-clients',
    name: 'fixture',
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _step: 0, loss: 1, reward: 2 })],
      },
    },
    complete: true,
    exitcode: 0,
  });
  const seeded = await server.tools.execute('panel_add', {
    view: view.id,
    plugin: 'line',
    metric: 'loss',
    title: 'Original loss',
  });
  for (const headers of [{}, { cookie: 'randl_session=' + '0'.repeat(64) }]) {
    const unauthorized = await server.app.inject({
      method: 'POST',
      url: '/api/tools/runs_select',
      headers,
      payload: { view: view.id, visible: [] },
    });
    assert.equal(unauthorized.statusCode, 401);
  }
  const call = (cookie, name, payload) =>
    server.app.inject({
      method: 'POST',
      url: '/api/tools/' + name,
      headers: { cookie },
      payload,
    });
  return { server, first, second, view: seeded, run, panel: seeded.body.panels[0], call };
}
function pending() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function assertEdits(saved, run) {
  assert.deepEqual(saved.body.panels.map((panel) => panel.metric).sort(), ['loss', 'reward']);
  assert.equal(saved.body.panels.find((panel) => panel.metric === 'loss').title, 'Updated loss');
  assert.equal(saved.name, 'Renamed by tool');
  assert.deepEqual(saved.body.visible, [run.id]);
  assert.deepEqual(saved.body.solo, [run.id]);
}

test(
  'two logged-in clients and a shared tool serialize behind an active edit',
  { timeout: 10000 },
  async (t) => {
    const { server, first, second, view, run, panel, call } = await fixture(t);
    const readReached = pending(),
      releaseRead = pending(),
      guiQueued = pending();
    const originalCall = server.db.call.bind(server.db);
    const originalExecute = server.tools.execute.bind(server.tools);
    let held = false;
    server.db.call = async (method, ...args) => {
      const result = await originalCall(method, ...args);
      if (!held && method === 'view' && args[0] === view.id) {
        held = true;
        readReached.resolve();
        await releaseRead.promise;
      }
      return result;
    };
    server.tools.execute = (name, args) => {
      const result = originalExecute(name, args);
      if (name === 'view_save') guiQueued.resolve();
      return result;
    };
    let results;
    try {
      const update = call(first, 'panel_update', {
        view: view.id,
        id: panel.id,
        title: 'Updated loss',
      });
      await readReached.promise;
      results = Promise.all([
        update,
        call(second, 'panel_add', { view: view.id, plugin: 'line', metric: 'reward' }),
        call(second, 'runs_select', { view: view.id, visible: [run.id], solo: [run.id] }),
        server.tools.execute('view_rename', { id: view.id, name: 'Renamed by tool' }),
        server.app.inject({
          method: 'PUT',
          url: '/api/views/' + view.id,
          headers: { cookie: first },
          payload: {
            name: view.name,
            project: view.project,
            version: view.version,
            body: { ...view.body, plotSettings: { legend: false } },
          },
        }),
      ]);
      await guiQueued.promise;
      releaseRead.resolve();
      const [updated, added, selection, renamed, gui] = await results;
      for (const response of [updated, added, selection]) {
        assert.equal(response.statusCode, 200, response.body);
      }
      assert.equal(renamed.name, 'Renamed by tool');
      assert.equal(gui.statusCode, 409);
      assert.equal(gui.json().code, 'VIEW_CONFLICT');
      assert.match(gui.json().error, /changed in another session/);
    } finally {
      releaseRead.resolve();
      server.db.call = originalCall;
      server.tools.execute = originalExecute;
      await results?.catch(() => {});
    }
    const savedResponse = await server.app.inject({
      method: 'GET',
      url: '/api/views/' + view.id,
      headers: { cookie: second },
    });
    assert.equal(savedResponse.statusCode, 200);
    const saved = savedResponse.json();
    assertEdits(saved, run);
    assert.equal(saved.body.plotSettings?.legend, undefined);
    assert.equal(saved.version, view.version + 4);
    const stale = await server.app.inject({
      method: 'PUT',
      url: '/api/views/' + view.id,
      headers: { cookie: first },
      payload: { name: view.name, project: view.project, version: view.version, body: view.body },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'VIEW_CONFLICT');
    assert.match(stale.json().error, /changed in another session/);
    assert.deepEqual(await server.db.call('view', view.id), saved);
    const retried = await server.app.inject({
      method: 'PUT',
      url: '/api/views/' + view.id,
      headers: { cookie: first },
      payload: {
        name: saved.name,
        project: saved.project,
        version: saved.version,
        body: { ...saved.body, plotSettings: { legend: false } },
      },
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assertEdits(retried.json(), run);
    assert.equal(retried.json().body.plotSettings.legend, false);
    assert.equal(retried.json().version, saved.version + 1);
  },
);

test('mixed edits from two logged-in clients persist after a view save', async (t) => {
  const { server, first, second, view, run, panel, call } = await fixture(t);
  // Complete the save through the PUT route's shared handler before starting parallel edits.
  const savedByGui = await server.tools.execute('view_save', {
    id: view.id,
    name: view.name,
    project: view.project,
    version: view.version,
    body: { ...view.body, plotSettings: { legend: false } },
  });
  const [updated, added, selection, renamed] = await Promise.all([
    call(first, 'panel_update', { view: view.id, id: panel.id, title: 'Updated loss' }),
    call(second, 'panel_add', { view: view.id, plugin: 'line', metric: 'reward' }),
    call(second, 'runs_select', { view: view.id, visible: [run.id], solo: [run.id] }),
    call(first, 'view_rename', { id: view.id, name: 'Renamed by tool' }),
  ]);
  assert.equal(savedByGui.body.plotSettings.legend, false);
  for (const response of [updated, added, selection, renamed]) {
    assert.equal(response.statusCode, 200, response.body);
  }
  const saved = await server.db.call('view', view.id);
  assertEdits(saved, run);
  assert.equal(saved.body.plotSettings.legend, false);
  assert.equal(saved.version, view.version + 5);
});
