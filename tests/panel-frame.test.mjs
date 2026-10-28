import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const js = ts.transpileModule(
  await readFile(new URL('../frontend/src/panel-frame.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { schedulePanel, cancelPanel } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);
test('panel updates yield between renderers, keep latest data and cancel hidden or destroyed panels', () => {
  const callbacks = new Map();
  let sequence = 0;
  globalThis.requestAnimationFrame = (fn) => {
    callbacks.set(++sequence, fn);
    return sequence;
  };
  globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
  const frame = () => {
    assert.equal(callbacks.size, 1);
    const [id, fn] = callbacks.entries().next().value;
    callbacks.delete(id);
    fn();
  };
  try {
    const a = {},
      b = {},
      c = {},
      events = [];
    schedulePanel(a, () => events.push('stale A'));
    schedulePanel(b, () => events.push('B'));
    schedulePanel(c, () => events.push('destroyed C'));
    schedulePanel(a, () => {
      events.push('latest A');
      schedulePanel(a, () => events.push('new A'));
    });
    cancelPanel(c);
    frame();
    assert.deepEqual(events, ['latest A']);
    frame();
    assert.deepEqual(events, ['latest A', 'B'], 'requeued work cannot starve a waiting panel');
    cancelPanel(a);
    assert.equal(callbacks.size, 0, 'hiding the last queued panel cancels the frame');
    schedulePanel(a, () => events.push('returned A'));
    frame();
    assert.deepEqual(events, ['latest A', 'B', 'returned A']);
    assert.equal(callbacks.size, 0);
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});

test('grid cell updates share a frame within the budget, and the first always runs', () => {
  const callbacks = new Map();
  let sequence = 0,
    now = 0;
  globalThis.requestAnimationFrame = (fn) => {
    callbacks.set(++sequence, fn);
    return sequence;
  };
  globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
  const realNow = performance.now;
  performance.now = () => now;
  const frame = () => {
    const [id, fn] = callbacks.entries().next().value;
    callbacks.delete(id);
    fn();
  };
  try {
    const events = [],
      cells = Array.from({ length: 6 }, () => ({})),
      panel = {};
    // Each cell takes 3 ms: the first runs, then cells while under 8 ms have passed.
    for (const [index, owner] of cells.entries())
      schedulePanel(
        owner,
        () => {
          events.push('cell ' + index);
          now += 3;
        },
        true,
      );
    schedulePanel(panel, () => events.push('panel'));
    cancelPanel(cells[4]);
    frame();
    assert.deepEqual(events, ['cell 0', 'cell 1', 'cell 2']);
    frame();
    assert.deepEqual(events.slice(3), ['cell 3', 'cell 5'], 'a cancelled cell is skipped');
    frame();
    assert.deepEqual(events.slice(5), ['panel'], 'a panel update takes its own frame');
    assert.equal(callbacks.size, 0);
    // A slow first cell still runs alone.
    schedulePanel(cells[0], () => (now += 50), true);
    schedulePanel(cells[1], () => events.push('next'), true);
    frame();
    assert.equal(events.at(-1), 'panel');
    frame();
    assert.equal(events.at(-1), 'next');
  } finally {
    performance.now = realNow;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});
