import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const js = ts.transpileModule(
  (await readFile(new URL('../frontend/src/media-axis.ts', import.meta.url), 'utf8')).replace(
    /^import type .*$/m,
    '',
  ),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { axisTicks, nearestIndex } = await import('data:text/javascript,' + encodeURIComponent(js));

test('the slider marks every value with media when they fit', () => {
  assert.deepEqual(axisTicks([0, 4, 8], 0, 8, 400, 8), [0, 50, 100]);
});

test('crowded values leave ticks out, keeping a gap and the last value', () => {
  const values = Array.from({ length: 1001 }, (_, i) => i);
  const ticks = axisTicks(values, 0, 1000, 200, 8);
  assert.ok(ticks.length <= 200 / 8 + 1, `${ticks.length} ticks`);
  assert.ok(ticks.length >= 200 / 8 - 1, `${ticks.length} ticks`);
  assert.equal(ticks[0], 0);
  assert.equal(ticks.at(-1), 100);
  for (let i = 1; i < ticks.length; i++) assert.ok(((ticks[i] - ticks[i - 1]) / 100) * 200 >= 8);
  // Values bunched at the start keep one tick there; the spaced ones keep theirs.
  assert.deepEqual(axisTicks([0, 1, 2, 3, 50, 100], 0, 100, 100, 8), [0, 50, 100]);
});

test('no ticks without a range to mark', () => {
  assert.deepEqual(axisTicks([5], 5, 6, 400, 8), []);
  assert.deepEqual(axisTicks([0, 1], 0, 1, 0, 8), []);
});

test('nearestIndex takes the closer neighbour', () => {
  assert.equal(nearestIndex([0, 4, 8], 3.2), 1);
  assert.equal(nearestIndex([0, 4, 8], 1.9), 0);
  assert.equal(nearestIndex([], 1), -1);
});
