import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/routes.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseRoute, pageURL } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);
const route = (path) => parseRoute(new URL(path, 'http://localhost'));
test('direct run tabs and encoded project names retain identity', () => {
  const parsed = route('/team/%E6%A3%AE%E6%9E%97/runs/run%20one/config');
  assert.equal(parsed.project, 'team/森林');
  assert.equal(parsed.run, 'team/森林/run one');
  assert.equal(parsed.runTab, 'config');
  assert.equal(route('/').page, 'overview');
  assert.equal(route(pageURL('team/森林', 'runs', 'abc')).view, 'abc');
});
test('malformed or surplus path segments produce a missing page', () => {
  for (const path of [
    '/single',
    '/%ZZ/b/workspace',
    '/team/project/workspace/extra',
    '/team/project/runs/id/config/extra',
    '/team/project/artifacts/type/name/v0/extra',
  ])
    assert.equal(route(path).page, 'not-found', path);
});
