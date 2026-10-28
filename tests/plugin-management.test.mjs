import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createServer } from '../backend/dist/server.js';
import { Plugins, builtins } from '../backend/dist/plugins.js';

test('built-in enable state persists through manager instances and server restarts without duplicate registry entries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-builtin-settings-'));
  let server;
  t.after(async () => {
    await server?.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const restart = async () => {
    await server?.app.close();
    server = await createServer(directory);
  };
  const assertRegistry = async (manager, enabled) => {
    const plugins = await manager.list();
    assert.equal(plugins.length, new Set(plugins.map((plugin) => plugin.id)).size);
    assert.equal(plugins.filter((plugin) => plugin.id === 'line').length, 1);
    assert.equal(plugins.find((plugin) => plugin.id === 'line').builtin, true);
    assert.equal(plugins.find((plugin) => plugin.id === 'line').enabled, enabled);
    assert.equal(plugins.find((plugin) => plugin.id === 'area').enabled, true);
  };
  await restart();
  await assertRegistry(server.plugins, true);
  const disabled = await server.app.inject({
    method: 'POST',
    url: '/api/plugins/line/disable',
    payload: {},
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().enabled, false);
  await assertRegistry(new Plugins(server.db, directory), false);
  assert.equal(
    (await server.tools.execute('plugins_list', {})).find((plugin) => plugin.id === 'line').enabled,
    false,
  );
  assert.ok(
    !(await server.db.call('plugins')).some((plugin) => plugin.id === 'line'),
    'Built-in overrides must not create duplicate external-plugin records',
  );
  assert.equal(
    builtins.find((plugin) => plugin.id === 'line').enabled,
    true,
    'A local override must not mutate global built-in defaults',
  );

  await restart();
  await assertRegistry(server.plugins, false);
  const view = await server.tools.execute('view_create', { name: 'Disabled plugin check' });
  await assert.rejects(
    server.tools.execute('panel_add', { view: view.id, plugin: 'line', metric: 'loss' }),
    /not enabled/i,
  );
  const enabled = await server.app.inject({
    method: 'POST',
    url: '/api/plugins/line/enable',
    payload: {},
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const edited = await server.tools.execute('panel_add', {
    view: view.id,
    plugin: 'line',
    metric: 'loss',
  });
  assert.equal(edited.body.panels[0].plugin, 'line');
  await restart();
  await assertRegistry(server.plugins, true);
  const removed = await server.app.inject({
    method: 'POST',
    url: '/api/plugins/line/remove',
    payload: {},
  });
  assert.equal(removed.statusCode, 400, removed.body);
  assert.match(removed.json().error, /built.?in|bundled/i);
  await assertRegistry(server.plugins, true);
});

const modules = new Map();
async function frontendModule(relative) {
  if (modules.has(relative)) return modules.get(relative);
  const file = new URL('../frontend/src/' + relative + '.ts', import.meta.url);
  const source = await readFile(file, 'utf8');
  let code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies = [...code.matchAll(/from\s+(['"])(\.[^'"]+)\1/g)].map((match) => match[2]);
  for (const dependency of new Set(dependencies)) {
    let url;
    if(dependency.endsWith('.json')){
      const data=await readFile(new URL(dependency,file),'utf8');url='data:text/javascript;base64,'+Buffer.from('export default '+data).toString('base64');
    }else{
      const absolute=new URL(dependency+'.ts',file),root=new URL('../frontend/src/',import.meta.url);
      url=await frontendModule(absolute.pathname.slice(root.pathname.length,-3));
    }
    code = code
      .replaceAll("'" + dependency + "'", JSON.stringify(url))
      .replaceAll('"' + dependency + '"', JSON.stringify(url));
  }
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  modules.set(relative, url);
  return url;
}

test('bar plot options include zero on linear scales and preserve explicit or logarithmic axes', async () => {
  const { barOptions } = await import(await frontendModule('plugins/bar'));
  let option;
  const update = (values, settings = {}) =>
    (option = barOptions({
      locale: 'en',
      translate: (key) => key,
      panel: { id: 'bar', plugin: 'bar', metric: 'score', metrics: ['score'], settings },
      dark: false,
      data: {
        snapshot: true,
        sampled: false,
        metrics: ['score'],
        series: values.map((value, index) => ({
          id: 'r' + index,
          name: 'Run ' + index,
          attributes: { score: value },
          values: { score: value === null ? [] : [[0, value]] },
        })),
      },
    }));
  for (const values of [
    [2, 4],
    [-2, -4],
    [-3, 5],
  ]) {
    update(values);
    assert.equal(option.yAxis.type, 'value');
    assert.equal(option.yAxis.scale, false, 'Linear bars must retain the default zero baseline');
    assert.equal(option.yAxis.min, undefined);
    assert.equal(option.yAxis.max, undefined);
    assert.deepEqual(
      option.series[0].data.map((point) => point.value),
      values,
    );
  }
  update([2, null], { yMin: 1, yMax: 5 });
  assert.equal(option.yAxis.min, 1);
  assert.equal(option.yAxis.max, 5);
  assert.equal(
    option.series[0].data[1].value,
    null,
    'A zero baseline must not turn missing values into zeros',
  );
  update([2, 4], { yScale: 'log' });
  assert.equal(option.yAxis.type, 'log');
  assert.equal(option.yAxis.scale, true);
});
