import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { Store } from '../backend/dist/database.js';
import { chartDiff, clipChart } from '../backend/dist/chart-diff.js';

// Downsampled charts keep each bucket's minimum and maximum. Smoothing those samples follows
// the midpoint of each bucket's extremes, so a right-skewed metric's smoothed line rose as a
// panel narrowed. Smoothing now uses each bucket's mean, sent beside the samples.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}
const { smooth, smoothingSource } = await load('../frontend/src/chart-math.ts');
const { applyChartDiff } = await load('../frontend/src/chart-data.ts');

async function storeTest(t) {
  const dir = await mkdtemp(join(tmpdir(), 'randl-smoothing-sampling-'));
  const store = new Store(dir);
  t.after(async () => {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}
const history = (rows, offset = 0) => ({
  files: { 'wandb-history.jsonl': { offset, content: rows.map((r) => JSON.stringify(r)) } },
});
// A seeded generator, so the data and the tolerances are reproducible.
function random(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}
// Like a training loop's seconds per update: about 0.59 s, and 1–6 s in one row of twenty.
function skewedRows(count) {
  const next = random(7);
  return Array.from({ length: count }, (_, i) => {
    const spike = next() < 0.05,
      collection = spike ? 1 + 5 * next() : 0.54 + 0.02 * next(),
      update = 0.04 + 0.01 * next();
    return { _step: i, collection, update, total: collection + update };
  });
}
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
// The smoothed line's level: its mean over the second half, after EMA warm-up.
const level = (points) => mean(points.slice(Math.floor(points.length / 2)).map((p) => p[1]));
const rows = skewedRows(60_000),
  truth = mean(rows.slice(30_000).map((row) => row.total));

for (const [label, request] of [
  ['plain metric', { metrics: ['total'] }],
  [
    'computed metric',
    {
      metrics: ['cycle'],
      recordTransform: {
        kind: 'compute',
        expressions: [{ name: 'cycle', expression: '${collection}+${update}' }],
      },
    },
  ],
])
  test(`EMA of a downsampled skewed ${label} follows the data at any panel width`, async (t) => {
    const s = await storeTest(t),
      r = s.upsert({ name: 'r' });
    s.ingest(r.id, history(rows));
    const metric = request.metrics[0],
      full = s.chart({ runs: [r.id], ...request, settings: { resolution: 'full' } });
    assert.equal(full.bucketWidth, null);
    assert.equal(full.series[0].means, undefined, 'unsampled charts send no means');
    for (const pixels of [200, 400, 800]) {
      const data = s.chart({ runs: [r.id], ...request, pixels }),
        series = data.series[0],
        width = data.bucketWidth;
      assert.ok(data.sampled && width > 1, `${pixels} px is downsampled`);
      // The means are exactly each aligned bucket's mean, at its last X.
      const buckets = new Map();
      for (const row of rows) {
        const key = Math.floor(row._step / width),
          bucket = buckets.get(key) || { x: 0, values: [] };
        bucket.x = row._step;
        bucket.values.push(row.total);
        buckets.set(key, bucket);
      }
      const expected = [...buckets.values()].map((b) => [b.x, mean(b.values)]);
      assert.equal(series.means[metric].length, expected.length);
      series.means[metric].forEach(([x, y], i) => {
        assert.equal(x, expected[i][0]);
        assert.ok(Math.abs(y - expected[i][1]) < 1e-9, `${pixels} px bucket ${i} mean`);
      });
      // The smoothed line sits at the data's level; smoothing the samples, as before, did not.
      const smoothed = smooth(smoothingSource(series, metric, 'ema', 0.95), 'ema', 0.95),
        samples = smooth(series.values[metric], 'ema', 0.95);
      assert.ok(
        Math.abs(level(smoothed) / truth - 1) < 0.03,
        `${pixels} px: smoothed ${level(smoothed)} vs mean ${truth}`,
      );
      assert.ok(level(samples) > 1.25 * truth, `${pixels} px samples are biased upward`);
      // It also matches an EMA over every row whose weight spans the same X per step.
      const rowsPerBucket = rows.length / expected.length,
        exact = smooth(
          rows.map((row) => [row._step, row.total]),
          'ema',
          0.95 ** (1 / rowsPerBucket),
        ),
        at = new Map(exact.map(([x, y]) => [x, y]));
      const errors = smoothed
        .slice(Math.floor(smoothed.length / 2))
        .map(([x, y]) => Math.abs(y / at.get(x) - 1));
      assert.ok(mean(errors) < 0.03, `${pixels} px: mean error ${mean(errors)}`);
      // Unsmoothed lines still draw the sampled extrema, spikes included.
      assert.equal(smoothingSource(series, metric, 'none', 0), series.values[metric]);
      assert.equal(smoothingSource(series, metric, 'ema', 0), series.values[metric]);
      assert.ok(Math.max(...series.values[metric].map((p) => p[1])) > 5);
    }
  });

test('bucket means are diffed and clipped like sampled points', async (t) => {
  const s = await storeTest(t),
    r = s.upsert({ name: 'r' });
  s.ingest(r.id, history(rows.slice(0, 20_000)));
  const request = { runs: [r.id], metrics: ['total'], pixels: 400 },
    before = s.chart(request);
  s.ingest(r.id, history(rows.slice(20_000, 20_100), 20_000));
  const after = s.chart(request),
    delta = chartDiff(before, after);
  assert.equal(after.bucketWidth, before.bucketWidth);
  // Appending changes only the last buckets' means.
  const patch = delta.changed[0].means.total;
  assert.ok(patch.upsert.length <= 4 && patch.remove.length <= 1, JSON.stringify(patch));
  assert.deepEqual(applyChartDiff(before, delta), after);
  // A finer width replaces every mean, as means do not nest across widths.
  const finer = s.chart({ ...request, pixels: 1600 });
  assert.deepEqual(applyChartDiff(after, chartDiff(after, finer)), finer);
  // Dropping to no downsampling removes the means.
  const full = s.chart({ ...request, settings: { resolution: 'full' } });
  assert.deepEqual(applyChartDiff(after, chartDiff(after, full)), full);
  const clipped = clipChart(after, { xMin: 5000, xMax: 6000 });
  assert.ok(clipped.series[0].means.total.every(([x]) => x >= 5000 && x <= 6000));
  assert.ok(clipped.series[0].means.total.length > 0);
});
