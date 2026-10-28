import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

// The pure `extent(ctx)` exports that give grid cells a shared Y range, loaded through Vite
// as the browser loads them.
const vite = await createServer({
  root: new URL('../frontend', import.meta.url).pathname,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
});
test.after(() => vite.close());
const load = (name) => vite.ssrLoadModule('/src/plugins/' + name + '.ts');
const ctx = (series, settings = {}, metrics = ['loss']) => ({
  locale: 'en',
  translate: (key) => key,
  localize: (key) => key,
  options: {},
  colors: {},
  dark: false,
  data: { metrics, sampled: false, queryMs: 0, series },
  panel: {
    id: 'p',
    plugin: 'line',
    metric: metrics[0],
    metrics,
    settings: { smoothingMethod: 'none', ...settings },
  },
});
const run = (id, points, extra = {}) => ({ id, name: id, values: { loss: points }, ...extra });

test('line and area extents cover the plotted values inside the X range', async () => {
  const { extent } = await load('line');
  const points = [
    [0, 1],
    [1, 5],
    [2, -3],
    [3, 2],
  ];
  assert.deepEqual(extent(ctx([run('a', points)])), [-3, 5]);
  assert.deepEqual(extent(ctx([run('a', points)], { xMin: 0, xMax: 1 })), [1, 5]);
  // Explicit bounds replace their side; log axes ignore values that are not positive.
  assert.deepEqual(extent(ctx([run('a', points)], { yMax: 10 })), [-3, 10]);
  assert.deepEqual(extent(ctx([run('a', points)], { yScale: 'log' })), [1, 5]);
  assert.equal(extent(ctx([run('a', [])])), null);
  // A group's spread band counts with its upper and lower bounds.
  const banded = run('g', points, {
    runIds: ['a', 'b'],
    bands: { loss: points.map(([x, y]) => [x, y - 1, y + 4, 2]) },
  });
  assert.deepEqual(extent(ctx([banded], { spread: 'minmax' })), [-4, 9]);
  // Excluding outliers uses the fitted bounds.
  const spiky = Array.from({ length: 100 }, (_, x) => [x, x === 50 ? 1000 : x % 10]);
  const [lo, hi] = extent(ctx([run('a', spiky)], { excludeOutliers: true }));
  assert.ok(lo <= 0 && hi < 100, JSON.stringify([lo, hi]));
});

test('stacked extents sum the stack from zero; percent stacks keep 0–100', async () => {
  const stacked = await load('stacked-area'),
    percent = await load('percent-area');
  const series = [
    run('a', [
      [0, 1],
      [1, 2],
    ]),
    run('b', [
      [0, 3],
      [1, 4],
    ]),
  ];
  assert.deepEqual(stacked.extent(ctx(series)), [0, 6]);
  assert.deepEqual(percent.extent(ctx(series)), [0, 100]);
});
