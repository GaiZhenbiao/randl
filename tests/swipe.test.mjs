import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const js = ts
  .transpileModule(await readFile(new URL('../frontend/src/swipe.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  .outputText.replace("'wheel-gestures'", `'${import.meta.resolve('wheel-gestures')}'`);
const { rubberBand, unstretch, swipeTarget, springStep } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

test('a drag past the ends stretches like a rubber band, without a hard stop', () => {
  const at = (position) => rubberBand(position, 5, 100, 1000);
  assert.equal(at(2.4), 2.4);
  // 100 px past the start shows as (1 - 1 / 1.055) × 1000 px, about 52 px.
  assert.ok(Math.abs(at(-1) + (1 - 1 / 1.055) * 10) < 1e-9);
  // Farther always shows farther, ever less so, and never reaches the region's width.
  let previous = 0,
    step = Infinity;
  for (let past = 1; past <= 200; past++) {
    const now = at(4 + past) - 4;
    assert.ok(now > previous && now - previous < step && now < 10, String([past, now]));
    step = now - previous;
    previous = now;
  }
  // A new drag takes up a stretched position where it shows.
  for (const position of [-3, -0.4, 1.5, 4.2, 9])
    assert.ok(Math.abs(unstretch(at(position), 5, 100, 1000) - position) < 1e-6, String(position));
});

test('a released drag settles on the nearest item, on past it after a flick', () => {
  // Slow: the nearest item, so a drag that moves too little stays.
  assert.equal(swipeTarget(4.4, 10), 4);
  assert.equal(swipeTarget(4.6, 10), 5);
  assert.equal(swipeTarget(2.4, 10), 2);
  assert.equal(swipeTarget(4.2, 10, 0.2 / 300, 300), 4);
  assert.equal(swipeTarget(3.8, 10, -0.2 / 300, 300), 4);
  // A flick of 0.3 px/ms or more moves on to the next item its way, however short.
  assert.equal(swipeTarget(4.1, 10, 0.3 / 300, 300), 5);
  assert.equal(swipeTarget(3.9, 10, -0.3 / 300, 300), 3);
  assert.equal(swipeTarget(4, 10, 0.5 / 300, 300), 5);
  // Its way, even back from where the drag went.
  assert.equal(swipeTarget(4.6, 10, -0.5 / 300, 300), 4);
  // A fast flick carries on for 200 ms, at most 20 items a second.
  assert.equal(swipeTarget(4.6, 10, 0.01, 300), 7);
  assert.equal(swipeTarget(4.6, 100, 1, 300), 9);
  // Ends hold.
  assert.equal(swipeTarget(11, 10), 9);
  assert.equal(swipeTarget(-0.4, 10, -0.01, 300), 0);
});

test('the settling spring starts at the release speed and comes to rest in about 300 ms', () => {
  // Continuous with the drag: over the first millisecond it moves at the release speed.
  const first = springStep(-1, 0.01, 1);
  assert.ok(Math.abs(first.x - (-1 + 0.01)) < 0.001, String(first.x));
  // From rest a whole item away, nine tenths of the way in under 150 ms, at rest by 300 ms.
  let x = -1,
    v = 0,
    t = 0;
  while (Math.abs(x) > 0.1) (({ x, v } = springStep(x, v, 1)), t++);
  assert.ok(t < 150, String(t));
  ({ x, v } = springStep(-1, 0, 300));
  assert.ok(Math.abs(x) < 0.003 && Math.abs(v) < 0.0001, String([x, v]));
  // Steps compose: one 32 ms step is two 16 ms ones.
  const one = springStep(0.8, -0.003, 32),
    two = springStep(...Object.values(springStep(0.8, -0.003, 16)), 16);
  assert.ok(Math.abs(one.x - two.x) < 1e-12 && Math.abs(one.v - two.v) < 1e-12);
  // It does not overshoot from rest.
  for (let x = -1, v = 0, i = 0; i < 400; i++) {
    ({ x, v } = springStep(x, v, 4));
    assert.ok(x <= 0, String(x));
  }
});
