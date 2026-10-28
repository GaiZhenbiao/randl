import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const limits = JSON.parse(
  await readFile(new URL('../backend/src/panel-limits.json', import.meta.url)),
);
const modules = new Map();
async function moduleURL(path) {
  if (modules.has(path)) return modules.get(path);
  let source = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  source = source.replace(
    /import panelLimits from .*?;/,
    `const panelLimits = ${JSON.stringify(limits)};`,
  );
  for (const [name, file] of [
    ['./api', '../frontend/src/api.ts'],
    ['./chart-data', '../frontend/src/chart-data.ts'],
    ['../../backend/src/chart-diff', '../backend/src/chart-diff.ts'],
    ['../../backend/src/chart-selection', '../backend/src/chart-selection.ts'],
  ])
    if (source.includes(`from '${name}'`))
      source = source.replace(`from '${name}'`, `from '${await moduleURL(file)}'`);
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  modules.set(path, url);
  return url;
}
const api = await import(await moduleURL('../frontend/src/api.ts'));
const {
  chartSelection,
  loadChart,
  storedChart,
  chartBytes,
  rendererCost,
  retainHiddenRenderer,
  releaseHiddenRenderer,
} = await import(await moduleURL('../frontend/src/chart-loader.ts'));
const chart = (n = 2) => ({
  metrics: ['v'],
  sampled: false,
  queryMs: 0,
  series: [{ id: 'a', name: 'A', values: { v: Array.from({ length: n }, (_, i) => [i, i / 3]) } }],
});
test('decoded scalar responses share identity and keep pairs in the serialized source', async (t) => {
  api.clearCache();
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify(chart()), { headers: { 'content-type': 'application/json' } }),
  );
  const request = { runs: ['a'], metrics: ['v'], pixels: 512 },
    versions = '[["a",1]]';
  const result = await loadChart('/api/chart', request, versions, new AbortController().signal);
  const stored = storedChart('/api/chart', request, versions);
  assert.equal(stored.read(), result);
  assert.equal(
    await loadChart('/api/chart', request, versions, new AbortController().signal),
    result,
  );
  const wire = JSON.parse(api.peek(stored.id).json);
  assert.deepEqual(wire.series[0].values.v, [
    [0, 0],
    [1, 1 / 3],
  ]);
  result.series[0].values.v[0][1] = 999; // Simulate a plugin violating the read-only contract.
  assert.equal(
    JSON.parse(api.peek(stored.id).json).series[0].values.v[0][1],
    0,
    'the serialized recovery copy is independent',
  );
  api.forget(stored.id);
  assert.equal(storedChart('/api/chart', request, versions), undefined);
  const next = await loadChart('/api/chart', request, versions, new AbortController().signal);
  assert.notEqual(next, result);
  assert.equal(chartBytes(result), 256 + 64 + 2 * 48);
});
test('decoded LRU has count and byte bounds and invalidates changed revisions', () => {
  api.clearCache();
  const request = (i) => ({ runs: ['a'], metrics: ['v'], mode: 'snapshot', i });
  const put = (i, data = chart(), versions = '1') => {
    const id = JSON.stringify(['/api/chart', request(i)]);
    api.remember(id, { json: JSON.stringify(data), versions, order: i });
    return storedChart('/api/chart', request(i), versions).read();
  };
  const first = put(0);
  for (let i = 1; i <= 64; i++) put(i);
  assert.notEqual(storedChart('/api/chart', request(0), '1').read(), first);
  const renewed = put(0, chart(3), '2');
  assert.equal(storedChart('/api/chart', request(0), '2').read(), renewed);
  const medium = put(80, chart(120000));
  put(81, chart(120000));
  assert.notEqual(
    storedChart('/api/chart', request(80), '1').read(),
    medium,
    'combined byte cost evicts the oldest entry',
  );
  const large = put(100, chart(350000));
  assert.notEqual(
    storedChart('/api/chart', request(100), '1').read(),
    large,
    'oversized decoded entries are not kept',
  );
  api.clearCache();
});

test('renderer retention charges canvas, multiplied traces and series, and bounds count and bytes', () => {
  const data = chart();
  const element = {
    querySelectorAll: (selector) =>
      selector === 'canvas'
        ? [
            { width: 100, height: 200 },
            { width: 10, height: 20 },
          ]
        : [{ naturalWidth: 4, naturalHeight: 3 }],
  };
  // Decoded media images count like canvases.
  assert.equal(
    rendererCost(element, data, 2),
    2 * (100 * 200 + 10 * 20 + 4 * 3) * 4 + 2 * chartBytes(data) * 2 + 2 * 16 * 1024,
  );
  const owners = Array.from({ length: 14 }, () => ({})),
    disposed = [];
  owners.forEach((owner, i) => retainHiddenRenderer(owner, () => disposed.push(i), 1));
  assert.deepEqual(disposed, [0, 1]);
  for (const owner of owners) releaseHiddenRenderer(owner);
  retainHiddenRenderer(owners[0], () => disposed.push(99), 160 * 1024 * 1024);
  assert.equal(disposed.at(-1), 99, 'one over-budget renderer is released');
  // A grid panel counts its mounted cells against the renderer count.
  disposed.length = 0;
  owners.slice(0, 6).forEach((owner, i) => retainHiddenRenderer(owner, () => disposed.push(i), 1));
  retainHiddenRenderer(owners[6], () => disposed.push('grid'), 1, 9);
  assert.deepEqual(disposed, [0, 1, 2], 'nine cells evict three single renderers');
  retainHiddenRenderer(owners[7], () => disposed.push('large grid'), 1, 13);
  assert.deepEqual(disposed.slice(3), [3, 4, 5, 'grid', 'large grid']);
  for (const owner of owners) releaseHiddenRenderer(owner);
});

test('grouped requests name a registered selection and register it again when forgotten', async (t) => {
  api.clearCache();
  const runs = Array.from({ length: 1500 }, (_, i) => ({ id: 'r' + i, revision: 1 })),
    selection = chartSelection(runs);
  assert.equal(chartSelection(runs), chartSelection(runs), 'shared run lists hash once');
  assert.notEqual(
    chartSelection(runs.map((run) => ({ ...run, revision: 2 }))).versions,
    selection.versions,
  );
  const calls = [];
  let known = false,
    forget = true;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([url, body.runs?.length ?? body.selection]);
    if (url === '/api/chart-selections') {
      known = true;
      return Response.json({ selection: selection.token });
    }
    if (forget || !known) {
      forget = known = false;
      return Response.json(
        { error: 'forgotten', code: 'CHART_SELECTION_UNKNOWN' },
        { status: 409 },
      );
    }
    return Response.json({ ...chart(), series: [] });
  });
  const request = {
    selection: selection.token,
    metrics: ['v'],
    settings: { groupBy: 'all' },
  };
  await loadChart('/api/chart', request, selection.versions, new AbortController().signal);
  assert.deepEqual(calls, [
    ['/api/chart-selections', 1500],
    ['/api/chart', selection.token],
    ['/api/chart-selections', 1500],
    ['/api/chart', selection.token],
  ]);
  api.clearCache();
});

test('a stored panel-width response serves the narrower cell-width request of a grid', async (t) => {
  api.clearCache();
  const sampled = { ...chart(40), sampled: true, bucketWidth: 1, xRange: [0, 1000] };
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify(sampled), { headers: { 'content-type': 'application/json' } }),
  );
  const versions = '[["a",1]]',
    request = (pixels) => ({ runs: ['a'], metrics: ['v'], pixels, settings: {} });
  await loadChart('/api/chart', request(1024), versions, new AbortController().signal);
  // Switching the panel to Grid asks for 256-pixel cells: the stored response is finer.
  const cell = storedChart('/api/chart', request(256), versions);
  assert.equal(cell.current, true);
  // Returning to one chart at a larger width needs more points.
  assert.equal(storedChart('/api/chart', request(4096), versions).current, false);
  api.clearCache();
});
