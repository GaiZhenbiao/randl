import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';
test('view conflicts and deletions preserve stable codes, status and params across worker and HTTP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-errors-')),
    server = await createServer(directory);
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const view = await server.tools.execute('view_create', {
    name: 'Synthetic view',
    project: 'local/fixture',
  });
  const request = {
    id: view.id,
    name: view.name,
    project: view.project,
    body: view.body,
    version: view.version,
  };
  await server.tools.execute('view_save', request);
  await assert.rejects(server.db.call('viewSave', request), {
    code: 'VIEW_CONFLICT',
    statusCode: 409,
    params: { view: view.id },
  });
  const conflict = await server.app.inject({
    method: 'POST',
    url: '/api/tools/view_save',
    payload: request,
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), {
    error: 'View changed in another session',
    code: 'VIEW_CONFLICT',
    params: { view: view.id },
  });
  await server.tools.execute('view_delete', { id: view.id });
  const deleted = await server.app.inject({
    method: 'POST',
    url: '/api/tools/view_save',
    payload: request,
  });
  assert.equal(deleted.statusCode, 409);
  assert.equal(deleted.json().code, 'VIEW_DELETED');
  assert.deepEqual(deleted.json().params, { view: view.id });
  const invalid = await server.app.inject({
    method: 'POST',
    url: '/api/tools/view_save',
    payload: { ...request, name: 42 },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, undefined);
  const blank = await server.app.inject({
    method: 'POST',
    url: '/api/tools/view_create',
    payload: { name: '   ' },
  });
  assert.equal(blank.statusCode, 400);
  assert.equal(blank.json().code, 'VIEW_NAME_REQUIRED');
  const lookup = await server.app.inject('/api/views/' + view.id);
  assert.equal(lookup.statusCode, 404);
  assert.deepEqual(lookup.json(), {
    error: 'View not found',
    code: 'VIEW_NOT_FOUND',
    params: { view: view.id },
  });
  const missing = await server.app.inject('/api/run?id=local/fixture/missing');
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'RUN_NOT_FOUND');
});

test('frontend errors translate only recognized codes and preserve arbitrary external text', async () => {
  const { readFile } = await import('node:fs/promises'),
    ts = (await import('typescript')).default;
  const source = await readFile(new URL('../frontend/src/api.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { ApiError, apiMessage } = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
  assert.deepEqual(
    apiMessage(new ApiError('Fallback', 409, 'VIEW_CONFLICT', { view: 'synthetic' })),
    { key: 'views.errors.conflict', values: { view: 'synthetic' } },
  );
  assert.deepEqual(apiMessage(new ApiError('Settings', 502, 'EXTERNAL_PROVIDER')), {
    text: 'Settings',
  });
  assert.deepEqual(apiMessage(Error('views.errors.conflict')), { text: 'views.errors.conflict' });
  for(const code of ['__proto__','constructor','toString'])assert.deepEqual(apiMessage(new ApiError('External text',500,code)),{text:'External text'});
  assert.deepEqual(apiMessage(new ApiError('Run not found', 400, 'RUN_NOT_FOUND')), {
    key: 'runs.errors.notFound',
    values: {},
  });
});

test('literal Message content bypasses catalog lookup, and missing keys fail loudly outside production', async () => {
  const { readFile } = await import('node:fs/promises'),
    ts = (await import('typescript')).default;
  let source = await readFile(new URL('../frontend/src/i18n.ts', import.meta.url), 'utf8');
  const english = JSON.parse(
    await readFile(new URL('../frontend/src/locales/en.json', import.meta.url), 'utf8'),
  );
  source = source
    .replace(
      "import english from './locales/en.json';",
      'const english=' + JSON.stringify(english) + ';',
    )
    .replace("'svelte/store'", JSON.stringify(import.meta.resolve('svelte/store')));
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
  const { get } = await import('svelte/store');
  assert.equal(get(module.t)({ text: 'views.errors.conflict' }), 'views.errors.conflict');
  for (const value of ['__proto__', 'constructor', 'toString', 'Missing English sentence'])
    assert.throws(() => get(module.t)(value), /Missing interface message/);
  assert.equal(
    get(module.t)({ key: 'views.errors.conflict', values: {} }),
    english['views.errors.conflict'],
  );
});
