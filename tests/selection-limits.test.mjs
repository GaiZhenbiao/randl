import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from '../backend/dist/server.js';
import limits from '../backend/src/selection-limits.json' with { type: 'json' };
const limit = limits.maxSelectedRuns;
const format = (value) => value.toLocaleString('en-US');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-selection-'));
  const server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const view = await server.tools.execute('view_create', {
    name: 'Selection test',
    project: 'test/bulk',
  });
  return { server, directory, view };
}
const ids = (count) => Array.from({ length: count }, (_, i) => `test/bulk/run-${i}`);

test('large selections persist in full through HTTP and shared tools; limits preserve the saved version', async (t) => {
  const { server, view } = await fixture(t);
  const selected = ids(limit);
  let saved = await server.tools.execute('runs_select', { view: view.id, visible: selected });
  assert.deepEqual(saved.body.visible, selected);
  const solo = await server.app.inject({
    method: 'POST',
    url: '/api/tools/runs_select',
    payload: { view: view.id, solo: selected },
  });
  assert.equal(solo.statusCode, 200, solo.body);
  saved = solo.json();
  assert.deepEqual(saved.body.visible, selected);
  assert.deepEqual(saved.body.solo, selected);
  for (const field of ['visible', 'solo']) {
    const expectedCode = field === 'visible' ? 'VISIBLE_RUN_LIMIT' : 'SOLO_RUN_LIMIT';
    await assert.rejects(
      server.tools.execute('runs_select', { view: view.id, visible: [], [field]: ids(limit + 1) }),
      (error) => error.code === expectedCode && error.statusCode === 400,
    );
    for (const [url, payload, method] of [
      ['/api/tools/runs_select', { view: view.id, visible: [], [field]: ids(limit + 1) }, 'POST'],
      [
        '/api/views/' + view.id,
        {
          name: saved.name,
          project: saved.project,
          version: saved.version,
          body: { ...saved.body, [field]: ids(limit + 1) },
        },
        'PUT',
      ],
      [
        '/api/tools/view_create',
        { name: 'Oversized', body: { panels: [], visible: [], solo: [], [field]: ids(limit + 1) } },
        'POST',
      ],
    ]) {
      if (method === 'PUT') delete payload.id;
      const response = await server.app.inject({ method, url, payload });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().code, expectedCode, response.body);
      assert.equal(
        response.json().error,
        `A view can ${field === 'visible' ? 'show' : 'solo'} up to ${format(limit)} runs; this request has ${format(limit + 1)}.`,
      );
    }
    assert.deepEqual(await server.db.call('view', view.id), saved);
  }
  const invalid = await server.app.inject({
    method: 'POST',
    url: '/api/tools/runs_select',
    payload: { view: view.id, visible: [selected[0], selected[0]] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'DUPLICATE_RUN_IDS');
  assert.equal(
    invalid.json().error,
    `Each run ID can appear once in visible; ${selected[0]} appears more than once.`,
  );
  const duplicatePut = await server.app.inject({
    method: 'PUT',
    url: '/api/views/' + view.id,
    payload: {
      name: saved.name,
      project: saved.project,
      version: saved.version,
      body: { ...saved.body, solo: [selected[1], selected[2], selected[1]] },
    },
  });
  assert.equal(duplicatePut.statusCode, 400, duplicatePut.body);
  assert.equal(duplicatePut.json().code, 'DUPLICATE_RUN_IDS');
  assert.match(duplicatePut.json().error, /once in solo; test\/bulk\/run-1 appears/);
  await assert.rejects(
    server.tools.execute('runs_select', { view: view.id, visible: [selected[3], selected[3]] }),
    (error) => error.code === 'DUPLICATE_RUN_IDS' && /run-3 appears/.test(error.message),
  );
  assert.deepEqual(await server.db.call('view', view.id), saved);
  const stale = await server.app.inject({
    method: 'PUT',
    url: '/api/views/' + view.id,
    payload: { name: view.name, project: view.project, version: view.version, body: view.body },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'VIEW_CONFLICT');
  const audit = await server.db.call('auditList');
  const selectionAudit = audit.filter((item) => item.tool === 'runs_select');
  assert.equal(selectionAudit.length, 2);
  assert.ok(
    JSON.stringify(selectionAudit).length < 2000,
    'selection audit stores counts, not the IDs',
  );
  const chart = await server.app.inject({
    method: 'POST',
    url: '/api/chart',
    payload: { runs: ids(1001), metrics: ['loss'] },
  });
  assert.equal(chart.statusCode, 400, 'chart run bound stays independent of selection limit');
});

test('CLI selects IDs at the limit using a JSON file or standard input and refuses ambiguous input', async (t) => {
  const { server, directory, view } = await fixture(t);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${server.app.server.address().port}`;
  const selected = ids(limit),
    path = join(directory, 'ids.json');
  await writeFile(path, JSON.stringify(selected));
  const cli = (args, input = '') =>
    new Promise((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        [resolve('backend/dist/cli.js'), 'select', '--url', base, '--view', view.id, ...args],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolveExit({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  let result = await cli(['--visible-file', path]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).body.visible, selected);
  result = await cli(['--solo-file', '-'], JSON.stringify(selected));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).body.solo, selected);
  assert.deepEqual((await server.db.call('view', view.id)).body.visible, selected);
  for (const args of [
    ['--visible', '', '--visible-file', path],
    ['--visible-file', '-', '--solo-file', '-'],
  ]) {
    result = await cli(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Use /);
  }
  for (const [args, input, pattern] of [
    [
      ['--visible-file', '-'],
      'run-1,run-2',
      /^--visible-file \(standard input\): expected a JSON array of run IDs \(/,
    ],
    [
      ['--visible-file', '-'],
      '{"ids":[]}',
      /^--visible-file \(standard input\): expected a JSON array of run IDs$/m,
    ],
    [
      ['--solo-file', join(directory, 'missing.json')],
      '',
      /--solo-file .*missing\.json: file not found/,
    ],
  ]) {
    result = await cli(args, input);
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  result = await cli(['--solo-file', '-'], JSON.stringify(ids(limit + 1)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`up to ${format(limit)} runs`));
  assert.deepEqual((await server.db.call('view', view.id)).body.solo, selected);
});
