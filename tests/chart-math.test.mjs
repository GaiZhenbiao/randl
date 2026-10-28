import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/chart-math.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { outlierRange, stackEdges, smooth, smoothingAmount, smoothingParameters, smoothingSpacing } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
test('EMA is debiased and zero smoothing preserves input', () => {
  const points = [
      [0, 0],
      [1, 10],
      [2, 0],
    ],
    result = smooth(points, 'ema', 0.5);
  assert.ok(Math.abs(result[1][1] - 6.6666666667) < 1e-8);
  assert.ok(Math.abs(result[2][1] - 2.8571428571) < 1e-8);
  assert.deepEqual(smooth(points, 'ema', 0), points);
});
test('the running average counts points and the X-aware methods weigh X gaps', () => {
  assert.equal(
    smooth(
      [
        [0, 0],
        [1, 9],
        [2, 0],
      ],
      'running',
      3,
    )[1][1],
    3,
  );
  // One spacing is the panel X extent over the most intervals in one series: here 50.
  const uneven = [
      [0, 0],
      [1, 10],
      [100, 0],
    ],
    even = [
      [0, 0],
      [1, 10],
      [2, 0],
    ];
  assert.equal(smoothingSpacing([uneven]), 50);
  // After a long gap the history of a time-weighted EMA has decayed more than an EMA's.
  assert.ok(smooth(uneven, 'twema', 0.6, 1)[2][1] < 1e-6);
  assert.ok(smooth(uneven, 'ema', 0.6)[2][1] > 1);
  // On even spacing the time-weighted EMA equals the EMA.
  for (const [a, b] of smooth(even, 'twema', 0.6).map((p, i) => [p, smooth(even, 'ema', 0.6)[i]]))
    assert.ok(Math.abs(a[1] - b[1]) < 1e-12);
  // A Gaussian over X gives a distant point almost no weight.
  assert.ok(smooth(uneven, 'gaussian', 3, 1)[2][1] < 1e-6);
});

// Noisy series: a slow sine plus alternating noise, with jittered X spacing.
function series(scale, offset = 0) {
  return Array.from({ length: 200 }, (_, i) => [
    offset + scale * (i + (i % 3) * 0.2),
    Math.sin(i / 20) + (i % 2 ? 1 : -1),
  ]);
}
const roughness = (points) =>
  points.slice(1).reduce((sum, p, i) => sum + Math.abs(p[1] - points[i][1]), 0);
test('every method smooths visibly at its default and ignores X units and magnitude', () => {
  const base = series(1);
  for (const method of ['ema', 'twema', 'gaussian', 'running']) {
    const amount = smoothingParameters[method].value,
      reference = smooth(base, method, amount);
    assert.ok(
      roughness(reference) < roughness(base) * 0.4,
      `${method} default reduces point-to-point variation`,
    );
    // Steps 1e7 apart and millisecond wall times give the same smoothed values.
    for (const scaled of [series(1e7), series(60_000, Date.UTC(2026, 9, 15))]) {
      const result = smooth(scaled, method, amount);
      for (let i = 0; i < base.length; i++) {
        assert.equal(result[i][0], scaled[i][0]);
        assert.ok(Math.abs(result[i][1] - reference[i][1]) < 1e-9, `${method} at ${i}`);
      }
    }
  }
});

test('the Gaussian handles non-monotonic X and parameters are clamped to their ranges', () => {
  const points = series(1),
    shuffled = points.map((p, i) => points[(i * 7) % points.length]);
  const sorted = smooth(points, 'gaussian', 3),
    result = smooth(shuffled, 'gaussian', 3, smoothingSpacing([points]));
  shuffled.forEach((p, i) => {
    const j = points.indexOf(p);
    assert.ok(Math.abs(result[i][1] - sorted[j][1]) < 1e-9);
  });
  assert.equal(smoothingAmount('twema', 10), 0.99);
  assert.equal(smoothingAmount('gaussian', 0.1), 0.5);
  assert.equal(smoothingAmount('running', undefined), 10);
  assert.equal(smoothingAmount('ema', undefined), 0.6);
});

test('smoothing reuses immutable inputs with a two-setting LRU', () => {
  const points = [
    [0, 1],
    [3, 9],
    [20, 2],
  ];
  const a = smooth(points, 'ema', 0.5);
  assert.equal(smooth(points, 'ema', 0.5), a);
  smooth(points, 'running', 3);
  assert.equal(smooth(points, 'ema', 0.5), a, 'a cache hit touches the setting');
  smooth(points, 'gaussian', 1);
  assert.equal(smooth(points, 'ema', 0.5), a);
  smooth(points, 'twema', 0.6);
  smooth(points, 'running', 5);
  assert.notEqual(smooth(points, 'ema', 0.5), a, 'only two settings are retained');
  assert.deepEqual(points, [
    [0, 1],
    [3, 9],
    [20, 2],
  ]);
});
test('excluding outliers fits the 5th to 95th percentile of the shown plotted values', () => {
  const line = Array.from({ length: 100 }, (_, x) => [x, x === 40 ? 1e6 : x === 60 ? -1e6 : x]);
  // Percentile bounds 3 and 96 (indices floor(0.05 × 99) and ceil(0.95 × 99)) round
  // outward to steps of a fifth of the span, here 20.
  assert.deepEqual(outlierRange([line]), [0, 100]);
  // Every series contributes; X outside the shown range does not: 51 and 97, steps of 10.
  assert.deepEqual(outlierRange([line, [[0, 2e6]]], { xMin: 50, xMax: 99 }), [50, 100]);
  assert.deepEqual(
    outlierRange([line.map(([x, y]) => [x, y / 1000])], { xMin: 0, xMax: 9 }),
    [0, 0.01],
  );
  // Up to ten points keep their full range.
  assert.deepEqual(
    outlierRange([
      [
        [0, 1],
        [1, 100],
        [2, 3],
      ],
    ]),
    [0, 100],
  );
  // Non-finite values are ignored; log scales use positive values, rounded to one digit.
  assert.deepEqual(
    outlierRange(
      [
        [
          [0, NaN],
          [1, -5],
          [2, 0],
          [3, 0.43],
          [4, 8.2],
        ],
      ],
      { log: true },
    ),
    [0.4, 9],
  );
  assert.equal(outlierRange([[[0, -1]]], { log: true }), null);
  assert.equal(outlierRange([[]]), null);
  // A constant bulk gets a visible span around it.
  const flat = Array.from({ length: 50 }, (_, x) => [x, x === 10 ? 900 : 5]);
  assert.deepEqual(outlierRange([flat]), [4.4, 5.6]);
  assert.deepEqual(outlierRange([[[0, 0]]]), [-1, 1]);
  assert.deepEqual(outlierRange([flat], { log: true }), [2, 10]);
});
test('outlier percentiles are adjustable and can include zero or stay within limits', () => {
  const line = Array.from({ length: 101 }, (_, x) => [x, x]);
  // Indices floor(0.2 × 100) and ceil(0.6 × 100); 0 and 100 keep the full range.
  assert.deepEqual(outlierRange([line], { lower: 20, upper: 60 }), [20, 60]);
  assert.deepEqual(outlierRange([line], { lower: 0, upper: 100 }), [0, 100]);
  // Three values: the upper median drops the largest one.
  assert.deepEqual(
    outlierRange(
      [
        [
          [0, 1],
          [1, 2],
          [2, 90],
        ],
      ],
      { lower: 0, upper: 50 },
    ),
    [1, 2],
  );
  // Pairs outside 0 ≤ lower < upper ≤ 100 use 5 and 95.
  for (const [lower, upper] of [
    [60, 40],
    [50, 50],
    [-1, 95],
    [5, 101],
  ])
    assert.deepEqual(outlierRange([line], { lower, upper }), outlierRange([line]));
  // Marks drawn from zero keep it.
  const high = Array.from({ length: 50 }, (_, x) => [x, x === 7 ? 1000 : 50 + (x % 5)]);
  assert.deepEqual(outlierRange([high]), [50, 54]);
  assert.deepEqual(outlierRange([high], { zero: true }), [0, 60]);
  assert.deepEqual(outlierRange([high.map(([x, y]) => [x, -y])], { zero: true }), [-60, 0]);
  // Limits clamp the rounded range.
  const shares = Array.from({ length: 50 }, (_, x) => [x, x === 3 ? 2 : 97 + (x % 3)]);
  assert.deepEqual(outlierRange([shares], { limits: [0, 100] }), [97, 99]);
  assert.deepEqual(
    outlierRange(
      [
        [
          [0, 98],
          [1, 99.9],
        ],
      ],
      { lower: 0, upper: 100, limits: [0, 100] },
    ),
    [98, 100],
  );
});
test('stack edges are the totals of each stack or the boundaries between its bands', () => {
  const a = [
      [0, 1],
      [1, 2],
    ],
    b = [
      [0, 3],
      [1, -1],
    ],
    c = [
      [0, 5],
      [1, 5],
    ];
  // Positive values stack up and negative ones down, separately per stack.
  assert.deepEqual(stackEdges([[a, b], [c]]), [
    [
      [0, 4],
      [1, 2],
      [1, -1],
    ],
    [
      [0, 5],
      [1, 5],
    ],
  ]);
  // Boundaries between bands exclude the top of each stack.
  assert.deepEqual(stackEdges([[a, b, c], [c]], true), [
    [
      [0, 1],
      [1, 2],
      [0, 4],
      [1, 1],
    ],
    [],
  ]);
});
