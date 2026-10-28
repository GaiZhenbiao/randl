import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const js = ts.transpileModule(
  await readFile(new URL('../frontend/src/linked-frame.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { scheduleLinked, cancelLinked } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);
test('linked frames coalesce, prioritize, admit one panel per frame and cancel while preserving interaction order', () => {
  const callbacks = new Map();
  let sequence = 0;
  globalThis.requestAnimationFrame = (fn) => {
    callbacks.set(++sequence, fn);
    return sequence;
  };
  globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
  const frame = () => {
    const [id, fn] = callbacks.entries().next().value;
    callbacks.delete(id);
    fn();
  };
  const a = {},
    b = {},
    c = {},
    events = [];
  scheduleLinked(a, { highlight: () => events.push('stale') }, 5);
  scheduleLinked(
    a,
    { highlight: () => events.push('A highlight'), cursor: () => events.push('A cursor') },
    5,
  );
  scheduleLinked(
    b,
    {
      highlight: () => {
        events.push('B highlight');
      },
      cursor: () => events.push('B cursor'),
    },
    0,
  );
  scheduleLinked(c, { highlight: () => events.push('cancelled') }, 1);
  cancelLinked(c);
  assert.equal(callbacks.size, 1);
  frame();
  assert.deepEqual(events, ['B highlight', 'B cursor']);
  assert.equal(callbacks.size, 1);
  frame();
  assert.deepEqual(events, ['B highlight', 'B cursor', 'A highlight', 'A cursor']);
  assert.equal(callbacks.size, 0);
  scheduleLinked(c, { highlight: () => {} }, 0);
  cancelLinked(c);
  assert.equal(callbacks.size, 0);
  events.length = 0;
  scheduleLinked(a, { highlight: () => events.push('old A') }, 5);
  scheduleLinked(b, { highlight: () => events.push('B') }, 0);
  frame();
  scheduleLinked(b, { highlight: () => events.push('new B') }, 0);
  scheduleLinked(a, { highlight: () => events.push('new A') }, 5);
  frame();
  assert.deepEqual(
    events,
    ['B', 'new A'],
    'an older waiting panel cannot be starved by fresh priority work',
  );
  cancelLinked(b);
  events.length = 0;
  for (let i = 0; i < 5; i++) scheduleLinked({}, { cursor: () => events.push(i) }, i);
  frame();
  assert.deepEqual(events, [0, 1, 2, 3, 4], 'cursor-only work shares a frame');
  scheduleLinked(
    a,
    { highlight: () => events.push('highlight'), cursor: () => events.push('old cursor') },
    0,
  );
  scheduleLinked(a, { cursor: () => events.push('latest cursor') }, 0);
  frame();
  assert.deepEqual(
    events.slice(-2),
    ['highlight', 'latest cursor'],
    'cursor coalescing keeps a pending highlight',
  );
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});
