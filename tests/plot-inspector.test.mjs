import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(
  new URL('../frontend/src/plugins/plot-inspector.ts', import.meta.url),
  'utf8',
);
const code = ts.transpileModule(
  source
    .replace(/import \{\s*seriesLabel\s*\} from '.\/series-label';/, '')
    .replace(
      /import \{\s*runTextColor\s*\} from '..\/run-colors';/,
      'const runTextColor = (color) => color;',
    ),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { nearestPoint, inspectorRows, inspectNumber } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
test('nearest observations include independently sampled runs and original values', () => {
  const series = [
    {
      name: 'A',
      key: 'a',
      points: [
        [0, 3],
        [2, 7],
      ],
      original: [
        [0, 2],
        [2, 8],
      ],
    },
    {
      name: 'B',
      key: 'b',
      points: [
        [0, 4],
        [1, 6],
        [3, 10],
      ],
    },
    { name: 'Empty', key: 'c', points: [] },
  ];
  assert.deepEqual(
    inspectorRows(series, 1.6, new Set()).map(({ name, x, value, originalValue }) => ({
      name,
      x,
      value,
      originalValue,
    })),
    [
      { name: 'A', x: 2, value: 7, originalValue: 8 },
      { name: 'B', x: 1, value: 6, originalValue: undefined },
    ],
  );
  assert.deepEqual(
    inspectorRows(series, 1.6, new Set(['A'])).map((s) => s.name),
    ['B'],
  );
  assert.equal(nearestPoint([], 1), -1);
  assert.equal(nearestPoint([[0, 1]], 10), 0);
});
test('tooltip numeric formatting preserves large integers and meaningful small values', () => {
  assert.equal(inspectNumber(12345678.9, 'en'), '12,345,678.9');
  assert.equal(inspectNumber(0.000000001234567, 'en'), '1.23457E-9');
  assert.equal(inspectNumber(0, 'en'), '0');
  assert.equal(inspectNumber(12345678.9, 'ja'), '12,345,678.9');
});

test('hover excludes runs beyond their sampled X range and handles one-point runs', () => {
  const series = [
    {
      name: 'early',
      key: 'e',
      points: [
        [0, 1],
        [10, 2],
      ],
    },
    {
      name: 'late',
      key: 'l',
      points: [
        [100, 3],
        [110, 4],
      ],
    },
    { name: 'single', key: 's', points: [[50, 5]] },
  ];
  assert.deepEqual(inspectorRows(series, 80, new Set()), []);
  assert.deepEqual(
    inspectorRows(series, 50, new Set()).map((s) => s.name),
    ['single'],
  );
  assert.deepEqual(
    inspectorRows(series, 53, new Set(), 4).map((s) => s.name),
    ['single'],
  );
  assert.deepEqual(
    inspectorRows(series, 14, new Set()).map((s) => s.name),
    ['early'],
  );
  assert.deepEqual(inspectorRows(series, 94, new Set()), []);
});
