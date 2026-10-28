import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../backend/dist/database.js';
import { createServer, Cache } from '../backend/dist/server.js';
async function storeTest(t) {
  const dir = await mkdtemp(join(tmpdir(), 'randl-test-'));
  const store = new Store(dir);
  t.after(async () => {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}
async function serverTest(t) {
  const dir = await mkdtemp(join(tmpdir(), 'randl-http-'));
  const server = await createServer(dir);
  t.after(async () => {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ...server, dir };
}
const history = (rows, offset = 0) => ({
  files: { 'wandb-history.jsonl': { offset, content: rows.map((r) => JSON.stringify(r)) } },
});
test('history retries, persistence, conflict rollback, finish and resume', async (t) => {
  const s = await storeTest(t),
    r = s.upsert({ entity: 'e', project: 'p', name: 'r' });
  const rows = Array.from({ length: 30 }, (_, i) => ({ _step: i, loss: 1 / (i + 1) }));
  s.ingest(r.id, history(rows));
  s.ingest(r.id, history(rows));
  assert.equal(s.run(r.id).history_count, 30);
  assert.equal(s.run(r.id).revision, r.revision + 30);
  assert.throws(() => s.ingest(r.id, history([{ _step: 0, loss: 9 }])));
  s.ingest(r.id, { complete: true, exitcode: 1 });
  s.ingest(r.id, history(rows));
  assert.equal(s.run(r.id).state, 'failed');
  s.ingest(r.id, history([{ _step: 30, loss: 0.01 }], 30));
  assert.equal(s.run(r.id).state, 'running');
  assert.deepEqual(JSON.parse(s.tail(r.id, 'wandb-history.jsonl')).map(JSON.parse), [
    { _step: 30, loss: 0.01 },
  ]);
});
test('bounded decimation preserves spikes, endpoints and order', async (t) => {
  const s = await storeTest(t),
    r = s.upsert({ name: 'r' });
  s.ingest(
    r.id,
    history(
      Array.from({ length: 2000 }, (_, i) => ({
        _step: i,
        loss: i === 417 ? 100 : i === 801 ? -100 : Math.sin(i),
      })),
    ),
  );
  // Width 64 over 2,000 steps: 32 buckets, two points each plus endpoints.
  const points = s.series(r.id, 'loss', 64);
  assert.ok(points.length <= 66);
  assert.ok(points.some((p) => p[0] === 417 && p[1] === 100));
  assert.ok(points.some((p) => p[0] === 801 && p[1] === -100));
  assert.equal(points[0][0], 0);
  assert.equal(points.at(-1)[0], 1999);
  assert.deepEqual(
    points,
    [...points].sort((a, b) => a[0] - b[0]),
  );
  assert.equal(s.chart({ runs: [r.id], metrics: ['loss'], pixels: 256 }).sampled, true);
  assert.equal(s.chart({ runs: [r.id], metrics: ['loss'], pixels: 2048 }).sampled, false);
});
test('view conflicts and missing version cannot overwrite agent changes', async (t) => {
  const s = await storeTest(t),
    v = s.viewSave({ id: 'v', name: 'v', body: { panels: [], visible: [], solo: [] } });
  s.viewSave({ ...v, name: 'new' });
  assert.throws(() => s.viewSave({ ...v, name: 'stale' }));
  assert.throws(() => s.viewSave({ id: 'v', name: 'unversioned', body: {} }));
  assert.equal(s.view('v').name, 'new');
});
test('cache byte bound, replacement and LRU', () => {
  const cache = new Cache(10);
  cache.put('a', Buffer.alloc(5));
  cache.put('b', Buffer.alloc(5));
  cache.get('a');
  cache.put('c', Buffer.alloc(4));
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.size, 9);
  cache.put('a', Buffer.alloc(1));
  assert.equal(cache.size, 5);
  cache.put('huge', Buffer.alloc(11));
  assert.equal(cache.size, 5);
});
test('HTTP protections, strict tool validation, audit and data routes', async (t) => {
  const { app, db } = await serverTest(t);
  for (const headers of [
    { host: 'evil.example' },
    { host: 'localhost', origin: 'https://evil.example' },
    { host: 'localhost', 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal((await app.inject({ url: '/api/runs', headers })).statusCode, 403);
  const call = (url, body) => app.inject({ url, method: 'POST', payload: body });
  assert.equal((await call('/api/tools/view_create', { name: 'x', extra: true })).statusCode, 400);
  const view = (await call('/api/tools/view_create', { name: 'Test' })).json();
  assert.equal(view.name, 'Test');
  assert.equal(
    (
      await app.inject({
        url: '/api/views/' + view.id,
        method: 'PUT',
        payload: { name: 'bad', project: '', body: view.body },
      })
    ).statusCode,
    400,
  );
  await app.inject({
    url: '/api/views/' + view.id,
    method: 'PUT',
    payload: { name: 'Good', project: '', body: view.body, version: view.version },
  });
  assert.equal((await db.call('auditList'))[0].tool, 'view_save');
  const unknown = (
    await call('/graphql', { query: 'mutation Unsupported { createArtifact }' })
  ).json();
  assert.ok(unknown.errors);
  assert.equal(
    (await call('/api/chart', { runs: Array(1001).fill('r'), metrics: ['loss'] })).statusCode,
    400,
  );
});
test('plugin source installation, identity, content revisions, paths and disable', async (t) => {
  const { plugins, db, app, dir } = await serverTest(t);
  const source = join(dir, 'source');
  await mkdir(source);
  const manifest = {
    id: 'stat-aa',
    name: 'Test',
    version: '1.0',
    apiVersion: 1,
    entry: 'panel.js',
  };
  await writeFile(join(source, 'panel.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'panel.js'), 'export const a=1');
  const p = await plugins.install(source);
  assert.equal(p.enabled, false);
  await plugins.change(p.id, 'enable');
  await writeFile(join(source, 'panel.js'), 'export const a=2');
  const updated = await plugins.change(p.id, 'update');
  assert.notEqual(p.revision, updated.revision);
  assert.equal(updated.enabled, true);
  const url = `/api/plugins/${p.id}/revisions/${updated.revision}/source/panel.js`;
  assert.equal((await app.inject(url)).body, 'export const a=2');
  await writeFile(join(source, 'panel.json'), JSON.stringify({ ...manifest, id: 'other-id' }));
  await assert.rejects(plugins.change(p.id, 'update'), /does not match/);
  assert.equal((await plugins.list()).filter((p) => !p.builtin).length, 1);
  await plugins.change(p.id, 'disable');
  assert.equal((await app.inject(url)).statusCode, 404);
  await plugins.change(p.id, 'remove');
  assert.equal((await db.call('plugins')).length, 0);
});
test('plugin options: install checks descriptors and catalogs, and every writer checks values', async (t) => {
  const { plugins, app, tools, dir } = await serverTest(t);
  const example = join(process.cwd(), 'examples/plugins/stat-card');
  const installed = await plugins.install(example);
  assert.equal(installed.settings.options.length, 5);
  assert.deepEqual(installed.locales, { en: 'locales/en.json', fr: 'locales/fr.json' });
  await plugins.change(installed.id, 'enable');
  const catalog = await app.inject(
    `/api/plugins/stat-card/revisions/${installed.revision}/source/locales/fr.json`,
  );
  assert.equal(catalog.headers['content-type'], 'application/json');
  assert.equal(catalog.json()['options.decimals.label'], 'Décimales');
  // A manifest whose labels are missing from its English catalog, or that has no catalog.
  const source = join(dir, 'invalid');
  await mkdir(join(source, 'locales'), { recursive: true });
  await writeFile(join(source, 'panel.js'), 'export function create() {}');
  const manifest = JSON.parse(await readFile(join(example, 'panel.json'), 'utf8'));
  const install = async (changes, catalog = { 'options.decimals.label': 'Decimals' }) => {
    await writeFile(
      join(source, 'panel.json'),
      JSON.stringify({ ...manifest, id: 'invalid-card', ...changes }),
    );
    await writeFile(join(source, 'locales/en.json'), JSON.stringify(catalog));
    return plugins.install(source);
  };
  const english = { locales: { en: 'locales/en.json' } };
  await assert.rejects(install(english), /locales.en does not define/);
  await assert.rejects(install({}), /fr names locales\/fr.json, which is not a file/);
  await assert.rejects(install({ locales: undefined }), /English catalog/);
  await assert.rejects(install({ locales: { en: 'locales/en.json' } }, ['list']), /flat map/);
  await assert.rejects(install({ ...english, settings: ['legend'] }), /must be an object/);
  await assert.rejects(
    install({ ...english, settings: { common: ['ratio'] } }),
    /unknown capability/,
  );
  await assert.rejects(install({ locales: { en: '../en.json' } }), /inside the source/);
  // Values are checked against the installed descriptors on every write path.
  const view = await tools.execute('view_create', { name: 'Options' });
  const body = (options) => ({ ...view.body, plotSettings: { options } });
  const put = (options) =>
    app.inject({
      url: '/api/views/' + view.id,
      method: 'PUT',
      payload: { name: view.name, project: '', version: view.version, body: body(options) },
    });
  const refused = await put({ 'stat-card': { decimals: 9 } });
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(
    [refused.json().code, refused.json().params],
    ['PLUGIN_OPTION_INVALID', { plugin: 'stat-card', key: 'decimals' }],
  );
  await assert.rejects(
    tools.execute('panel_add', {
      view: view.id,
      plugin: 'stat-card',
      metric: 'loss',
      settings: { options: { 'stat-card': { trend: 'sideways' } } },
    }),
    (error) => error.code === 'PLUGIN_OPTION_INVALID' && error.params.key === 'trend',
  );
  // Undeclared keys and plugins that are not installed are kept within the shape limits.
  const kept = await put({ 'stat-card': { decimals: 3, retired: true }, gone: { size: 'x' } });
  assert.equal(kept.statusCode, 200, kept.body);
  assert.deepEqual((await tools.execute('view_get', { id: view.id })).body.plotSettings.options, {
    'stat-card': { decimals: 3, retired: true },
    gone: { size: 'x' },
  });
  const current = await tools.execute('view_get', { id: view.id });
  const shape = (options) =>
    app.inject({
      url: '/api/tools/view_save',
      method: 'POST',
      payload: { ...current, body: { ...current.body, plotSettings: { options } } },
    });
  assert.equal((await shape({ 'stat-card': { prefix: 'x'.repeat(201) } })).statusCode, 400);
  assert.equal(
    (await shape(Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['p' + i + 'x', {}]))))
      .statusCode,
    400,
  );
  assert.equal((await shape({ 'stat-card': { Bad: 1 } })).statusCode, 400);
});
test('media: steps catalog, latest at or before a step per run, steps of one run, file limits', async (t) => {
  const { app, db } = await serverTest(t);
  const images = (step, count) => ({
    _step: step,
    gallery: {
      _type: 'images/separated',
      count,
      filenames: Array.from({ length: count }, (_, i) => `media/images/g_${step}_${i}.png`),
      captions: Array.from({ length: count }, (_, i) => `item ${i}`),
      width: 32,
      height: 24,
    },
  });
  const ids = [];
  for (const [name, rows] of [
    ['a', [images(0, 4), images(10, 4), images(20, 4)]],
    ['b', [images(5, 2), images(15, 2)]],
    ['late', [images(30, 1)]],
    ['none', [{ _step: 0, loss: 1 }]],
  ]) {
    const run = await db.call('upsert', {
      entity: 'e',
      project: 'm',
      name,
      displayName: name.toUpperCase(),
    });
    await db.call('ingest', run.id, history(rows.map((row) => row)));
    ids.push(run.id);
  }
  const media = async (body) => {
    const response = await app.inject({ url: '/api/media', method: 'POST', payload: body });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  // Latest: each run's newest entry at or before the newest logged step, in input order.
  const latest = await media({ runs: [ids[2], ids[1], ids[0], ids[3]], metric: 'gallery' });
  assert.deepEqual(latest.steps, [0, 5, 10, 15, 20, 30]);
  assert.equal(latest.step, 30);
  assert.deepEqual(
    latest.entries.map((entry) => [entry.runName, entry.step]),
    [
      ['LATE', 30],
      ['B', 15],
      ['A', 20],
    ],
  );
  assert.equal(latest.total, 3);
  // At step 12: B shows step 5, A step 10, and the late run keeps its place without media.
  const at = await media({ runs: ids, metric: 'gallery', step: 12 });
  assert.deepEqual(
    at.entries.map((entry) => [entry.runName, entry.step, entry.value?.filenames.length ?? null]),
    [
      ['A', 10, 4],
      ['B', 5, 2],
      ['LATE', null, null],
    ],
  );
  assert.equal(at.total, 2);
  // Files per step are shared among runs, at least one each.
  const limited = await media({ runs: ids, metric: 'gallery', step: 12, files: 3 });
  assert.deepEqual(
    limited.entries.map((entry) => [
      entry.value?.filenames.length,
      entry.files,
      entry.filesTruncated,
    ]),
    [
      [2, 4, true],
      [1, 2, true],
      [undefined, undefined, undefined],
    ],
  );
  assert.deepEqual(limited.entries[0].value.captions, ['item 0', 'item 1']);
  // Steps of one run: every entry by step, each within the files limit.
  const steps = await media({
    runs: ids,
    metric: 'gallery',
    across: 'steps',
    run: ids[0],
    files: 2,
  });
  assert.deepEqual(
    steps.entries.map((entry) => [entry.step, entry.value.filenames.length]),
    [
      [0, 2],
      [10, 2],
      [20, 2],
    ],
  );
  assert.equal(steps.total, 3);
  assert.equal(steps.step, null);
  // Unknown metrics, runs outside the request and invalid limits.
  assert.deepEqual((await media({ runs: ids, metric: 'missing' })).entries, []);
  assert.deepEqual(
    (await media({ runs: [ids[1]], metric: 'gallery', across: 'steps', run: ids[0] })).entries,
    [],
  );
  for (const files of [0, 1001, 2.5])
    assert.equal(
      (
        await app.inject({
          url: '/api/media',
          method: 'POST',
          payload: { runs: ids, metric: 'gallery', files },
        })
      ).statusCode,
      400,
    );
});
test('media file allocation keeps one file per entry and shares the rest evenly', async () => {
  const { allocateFiles } = await import('../backend/dist/database.js');
  assert.deepEqual(allocateFiles([6, 6, 6], 100, 100), [6, 6, 6]);
  assert.deepEqual(
    allocateFiles([600, 600, 600, 600, 600, 600], 100, 100),
    [17, 17, 17, 17, 16, 16],
  );
  assert.deepEqual(allocateFiles([1, 50, 50], 100, 10), [1, 5, 4]);
  assert.deepEqual(allocateFiles([3, 3, 3, 3], 100, 2), [1, 1, 1, 1]);
  assert.deepEqual(allocateFiles([0, 9], 4, 100), [0, 4]);
});
test('shared tools preserve independent visibility and solo', async (t) => {
  const { app, tools } = await serverTest(t);
  const v = await tools.execute('view_create', { name: 'Comparison' });
  await tools.execute('runs_select', { view: v.id, visible: ['a', 'c'], solo: ['b', 'd'] });
  let next = await tools.execute('view_get', { id: v.id });
  assert.deepEqual(next.body.visible, ['a', 'c']);
  assert.deepEqual(next.body.solo, ['b', 'd']);
  await tools.execute('runs_select', { view: v.id, solo: [] });
  next = await tools.execute('view_get', { id: v.id });
  assert.deepEqual(next.body.visible, ['a', 'c']);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/tools/runs_select',
    payload: { view: v.id, solo: [5] },
  });
  assert.equal(invalid.statusCode, 400);
});
test('Pi SDK registers only randl tools without making a model request', async (t) => {
  const { createAgentSession, SessionManager, SettingsManager, createExtensionRuntime } =
    await import('@earendil-works/pi-coding-agent');
  const { toolCatalog } = await import('../backend/dist/tools.js');
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const { session } = await createAgentSession({
    tools: toolCatalog.map((t) => t.name),
    customTools: toolCatalog.map((t) => ({
      ...t,
      label: t.name,
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    })),
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({}),
  });
  t.after(() => session.dispose());
  assert.deepEqual(new Set(session.getActiveToolNames()), new Set(toolCatalog.map((t) => t.name)));
});
test('constant custom X stays bounded and exact record joins omit missing X', async (t) => {
  const s = await storeTest(t),
    r = s.upsert({ name: 'r' });
  s.ingest(
    r.id,
    history(
      Array.from({ length: 1000 }, (_, i) => ({ _step: i, epoch: 1, loss: i === 417 ? 1000 : i })),
    ),
  );
  const result = s.series(r.id, 'loss', 16, { xAxis: 'epoch' });
  assert.ok(result.length <= 16);
  assert.ok(result.some((p) => p[1] === 1000));
  assert.deepEqual(s.series(r.id, 'loss', 16, { xAxis: 'absent' }), []);
});
test('wall/process axes and system event timestamps stay separate', async (t) => {
  const s = await storeTest(t),
    r = s.upsert({ name: 'r' });
  s.ingest(
    r.id,
    history([
      { _step: 0, _timestamp: 100, _runtime: 0, loss: 4 },
      { _step: 1, _timestamp: 200, _runtime: 1, loss: 3 },
    ]),
  );
  assert.deepEqual(s.series(r.id, 'loss', 16, { xAxis: '_relative_wall' }), [
    [0, 4],
    [100, 3],
  ]);
  assert.deepEqual(s.series(r.id, 'loss', 16, { xAxis: '_runtime' }), [
    [0, 4],
    [1, 3],
  ]);
  s.ingest(r.id, {
    files: {
      'wandb-events.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _timestamp: 100, 'system.cpu': 15 })],
      },
    },
  });
  assert.deepEqual(s.series(r.id, 'system/cpu', 16, { xAxis: '_timestamp' }), [[100000, 15]]);
  assert.equal(s.run(r.id).history_count, 2);
});
test('group statistics use raw aligned records and preserve spread spikes', async (t) => {
  const s = await storeTest(t);
  const ids = [];
  for (const [i, value] of [0, 2, 4].entries()) {
    const r = s.upsert({ name: 'r' + i });
    ids.push(r.id);
    s.ingest(r.id, history([{ _step: 0, loss: value }]));
  }
  const data = s.chart({
    runs: ids,
    metrics: ['loss'],
    settings: { groupBy: 'all', aggregation: 'mean', spread: 'stddev' },
  });
  assert.equal(data.series[0].values.loss[0][1], 2);
  assert.ok(Math.abs(data.series[0].bands.loss[0][2] - (2 + Math.sqrt(8 / 3))) < 1e-10);
  const { decimate } = await import('../backend/dist/database.js');
  const points = Array.from({ length: 1000 }, (_, i) => [
    i,
    0,
    i === 417 ? -100 : 0,
    i === 417 ? 100 : 0,
  ]);
  const reduced = decimate(points, 64);
  assert.ok(reduced.length <= 16 * 4 + 2);
  assert.ok(reduced.some((p) => p[0] === 417));
  const coarse = decimate(points, 128).map((p) => p[0]),
    fine = new Set(reduced.map((p) => p[0]));
  assert.ok(
    coarse.every((x) => fine.has(x)),
    'aggregated levels nest',
  );
});
test('aligned bucket widths nest, including ties and negative X', async (t) => {
  const s = await storeTest(t),
    { chartDiff } = await import('../backend/dist/chart-diff.js');
  const r = s.upsert({ name: 'r' });
  s.ingest(
    r.id,
    history(
      Array.from({ length: 3000 }, (_, i) => ({
        _step: i,
        flag: i % 7 === 0 ? 1 : 0,
        offset: i - 1500,
        loss: Math.sin(i / 37),
      })),
    ),
  );
  for (const [metric, settings] of [
    ['flag', {}],
    ['loss', {}],
    ['loss', { xAxis: 'offset' }],
  ])
    for (const width of [256, 64, 16, 4]) {
      const coarse = s.series(r.id, metric, width, settings),
        fine = s.series(r.id, metric, width / 2, settings),
        kept = new Set(fine.map((p) => p.join()));
      assert.ok(fine.length > coarse.length, `${metric} ${width} refines`);
      assert.ok(
        coarse.every((p) => kept.has(p.join())),
        `${metric} ${JSON.stringify(settings)} width ${width} nests in ${width / 2}`,
      );
      const before = { metrics: [metric], series: [{ id: r.id, values: { [metric]: coarse } }] },
        after = { metrics: [metric], series: [{ id: r.id, values: { [metric]: fine } }] },
        delta = chartDiff(before, after);
      assert.deepEqual(delta.changed[0].metrics[metric].remove, []);
    }
  const full = s.chart({ runs: [r.id], metrics: ['loss'], settings: { resolution: 'full' } });
  assert.equal(full.series[0].values.loss.length, 3000);
  assert.equal(full.bucketWidth, null);
  assert.equal(full.sampled, false);
  const low = s.chart({
      runs: [r.id],
      metrics: ['loss'],
      pixels: 400,
      settings: { resolution: 'low' },
    }),
    high = s.chart({
      runs: [r.id],
      metrics: ['loss'],
      pixels: 400,
      settings: { resolution: 'high' },
    });
  assert.ok(low.series[0].values.loss.length < high.series[0].values.loss.length);
  assert.ok(high.series[0].values.loss.length <= 2 * 400 * 2 + 2);
  assert.equal(low.bucketWidth, 16, '200 buckets over 3,000 steps round up to width 16');
});
test('config and labels invalidate chart revisions and filters use real types', async (t) => {
  const s = await storeTest(t),
    r = s.upsert({
      name: 'r',
      config: { lr: { value: 0.003 } },
      summaryMetrics: { score: 0 },
      tags: ['baseline'],
    });
  const version = r.revision;
  s.upsert({ name: 'r', displayName: 'Renamed' });
  assert.ok(s.run(r.id).revision > version);
  assert.deepEqual(
    s.queryRuns({
      filters: [
        { field: 'config.lr', operator: 'lt', value: '0.01' },
        { field: 'summary.score', operator: 'eq', value: '0' },
      ],
    }),
    [r.id],
  );
  assert.deepEqual(
    s.queryRuns({ filters: [{ field: 'tags', operator: 'eq', value: 'baseline' }] }),
    [r.id],
  );
});
test('artifact client retries and repeat commits preserve immutable versions', async (t) => {
  const s = await storeTest(t),
    input = {
      entityName: 'e',
      projectName: 'p',
      artifactCollectionName: 'model',
      artifactTypeName: 'model',
      digest: 'logical',
      clientID: 'retry',
    };
  const a = s.artifact('create', input),
    again = s.artifact('create', input);
  assert.equal(a.id, again.id);
  s.artifact('manifest', { id: a.id, digest: 'manifest-file-hash' });
  assert.equal(s.artifact('get', { id: a.id }).digest, 'logical');
  s.artifact('commit', { id: a.id, size: 0, count: 0 });
  assert.throws(() => s.artifact('manifest', { id: a.id, logicalDigest: 'changed' }));
  assert.throws(() => s.artifact('file', { id: a.id, name: 'bad' }));
  assert.equal(s.artifact('commit', { id: a.id, size: 1, count: 1 }).size, 0);
});
test('stream upload preserves bytes without content type', async (t) => {
  const { app, db } = await serverTest(t);
  await db.call('upsert', { entity: 'e', project: 'p', name: 'r' });
  const bytes = Buffer.from([0, 1, 255, 10, 34, 93]);
  const put = await app.inject({ method: 'PUT', url: '/upload/e/p/r/binary.bin', payload: bytes });
  assert.equal(put.statusCode, 200, put.body);
  const get = await app.inject('/api/run-files?run=e%2Fp%2Fr&path=binary.bin');
  assert.deepEqual(get.rawPayload, bytes);
});
test('worker startup failure, pending termination and queue recovery are explicit', async (t) => {
  const { DB } = await import('../backend/dist/db.js');
  const dir = await mkdtemp(join(tmpdir(), 'randl-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'not-a-directory');
  await writeFile(file, 'x');
  const broken = new DB(file);
  await assert.rejects(broken.call('runs'));
  await broken.close();
  const db = new DB(join(dir, 'valid'));
  const pending = Array.from({ length: 64 }, () => db.call('runs'));
  await assert.rejects(db.call('runs'), /busy/);
  await Promise.all(pending);
  assert.deepEqual(await db.call('runs'), []);
  const dying = db.call('runs');
  await db.worker.terminate();
  await Promise.allSettled([dying]);
  await assert.rejects(db.call('runs'), /stopped/);
  await db.close();
});
test('interrupted uploads preserve the old file and remove partial files', async (t) => {
  const { writeUpload } = await import('../backend/dist/upload.js');
  const { Readable } = await import('node:stream');
  const dir = await mkdtemp(join(tmpdir(), 'randl-upload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'model.bin');
  await writeFile(path, 'original');
  async function* interrupted() {
    yield Buffer.from('replacement');
    throw Error('cancelled');
  }
  await assert.rejects(writeUpload(path, Readable.from(interrupted())), /cancelled/);
  assert.equal(await readFile(path, 'utf8'), 'original');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), ['model.bin']);
});
test('exports span every page and system CSV preserves values', async (t) => {
  const { app, db } = await serverTest(t);
  const run = await db.call('upsert', { name: 'export' });
  await db.call(
    'ingest',
    run.id,
    history(Array.from({ length: 150 }, (_, i) => ({ _step: i, loss: i }))),
  );
  let response = await app.inject('/api/run-export?run=' + encodeURIComponent(run.id));
  assert.equal(response.body.trim().split('\n').length, 150);
  await db.call('ingest', run.id, {
    files: {
      'wandb-events.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _timestamp: 100, 'system.cpu': 15 })],
      },
    },
  });
  response = await app.inject(
    '/api/run-export?run=' + encodeURIComponent(run.id) + '&file=wandb-events.jsonl&format=csv',
  );
  assert.match(response.body, /system\/cpu/);
  assert.match(response.body, /"15"/);
});
test('non-finite logged numbers become null without corrupting quoted strings or retries', async (t) => {
  const s = await storeTest(t),
    r = s.upsert({ name: 'nan' });
  const payload = {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: ['{"_step":0,"loss":NaN,"score":Infinity,"label":"NaN and Infinity"}'],
      },
      'wandb-summary.json': { offset: 0, content: ['{"loss":NaN,"label":"NaN"}'] },
    },
  };
  s.ingest(r.id, payload);
  s.ingest(r.id, payload);
  assert.equal(s.run(r.id).history_count, 1);
  assert.deepEqual(JSON.parse(s.run(r.id).summary), { loss: null, label: 'NaN' });
  assert.deepEqual(s.series(r.id, 'loss'), []);
  assert.equal(JSON.parse(s.exportHistory(r.id)[0].content).label, 'NaN and Infinity');
});
test('media lists of videos are allocated per file and sized; previews and downloads serve byte ranges', async (t) => {
  const { app, db } = await serverTest(t);
  const run = await db.call('upsert', { entity: 'e', project: 'p', name: 'v' });
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  for (const i of [0, 1, 2]) {
    const put = await app.inject({
      method: 'PUT',
      url: `/upload/e/p/v/media/videos/clip_${i}.mp4`,
      payload: bytes,
    });
    assert.equal(put.statusCode, 200, put.body);
  }
  // A GIF's header names its size: 32 × 18.
  const gif = Buffer.from([...Buffer.from('GIF89a'), 32, 0, 18, 0, 0, 0, 0, 0x3b]);
  await app.inject({ method: 'PUT', url: '/upload/e/p/v/media/videos/loop.gif', payload: gif });
  const clip = (i) => ({
    _type: 'video-file',
    path: `media/videos/clip_${i}.mp4`,
    sha256: 'd' + i,
    size: 1000,
    caption: 'episode ' + i,
  });
  await db.call(
    'ingest',
    run.id,
    history([
      {
        _step: 0,
        clips: { _type: 'videos', count: 3, videos: [0, 1, 2].map(clip) },
        loop: { _type: 'video-file', path: 'media/videos/loop.gif' },
        logged: { _type: 'video-file', path: 'media/videos/loop.gif', width: 7, height: 3 },
      },
    ]),
  );
  const media = (body) => app.inject({ url: '/api/media', method: 'POST', payload: body });
  const all = (await media({ runs: [run.id], metric: 'clips' })).json();
  assert.equal(all.entries[0].value.videos.length, 3);
  // Videos logged without a size get the one their header names; a logged size stays, and a
  // file without a readable header has none.
  const size = async (metric) => {
    const { value } = (await media({ runs: [run.id], metric })).json().entries[0];
    return [value.width, value.height];
  };
  assert.deepEqual(await size('loop'), [32, 18]);
  assert.deepEqual(await size('logged'), [7, 3]);
  assert.equal(all.entries[0].value.videos[0].width, undefined);
  const limited = (await media({ runs: [run.id], metric: 'clips', files: 2 })).json().entries[0];
  assert.deepEqual(
    [limited.value.videos.map((item) => item.caption), limited.files, limited.filesTruncated],
    [['episode 0', 'episode 1'], 3, true],
  );
  const types = (
    await app.inject({ url: '/api/metrics', method: 'POST', payload: { runs: [run.id] } })
  ).json();
  assert.deepEqual(types.kinds.clips, ['videos']);
  const url = '/api/run-file-preview?run=e%2Fp%2Fv&path=media%2Fvideos%2Fclip_1.mp4';
  const whole = await app.inject(url);
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(Number(whole.headers['content-length']), 1000);
  const part = await app.inject({ url, headers: { range: 'bytes=100-199' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], 'bytes 100-199/1000');
  assert.deepEqual(part.rawPayload, bytes.subarray(100, 200));
  const tail = await app.inject({ url, headers: { range: 'bytes=-10' } });
  assert.deepEqual(tail.rawPayload, bytes.subarray(990));
  const stale = await app.inject({ url, headers: { range: 'bytes=0-9', 'if-range': '"old"' } });
  assert.equal(stale.statusCode, 200);
  const outside = await app.inject({ url, headers: { range: 'bytes=5000-' } });
  assert.equal(outside.statusCode, 416);
  assert.equal(outside.headers['content-range'], 'bytes */1000');
  const download = await app.inject({
    url: '/api/run-files?run=e%2Fp%2Fv&path=media%2Fvideos%2Fclip_2.mp4',
    headers: { range: 'bytes=0-3' },
  });
  assert.equal(download.statusCode, 206);
  assert.deepEqual(download.rawPayload, bytes.subarray(0, 4));
});
