import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const js = ts.transpileModule(
  await readFile(new URL('../frontend/src/plugins/tile-view.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { gridGeometry, layoutRows, windowRows, fitSize, moveIndex, flowLayout, flowBound } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('columns follow the width for a fixed item size, and tiles stretch to fill', () => {
  assert.deepEqual(gridGeometry(1000, 240), { columns: 4, width: 244 });
  assert.deepEqual(gridGeometry(1000, 400), { columns: 2, width: 496 });
  // A size wider than the content gives one column of the content's width.
  assert.deepEqual(gridGeometry(300, 960), { columns: 1, width: 300 });
  assert.equal(gridGeometry(488, 240).columns, 2);
  assert.equal(gridGeometry(487, 240).columns, 1);
});

test('rows hold up to the column count, take their tallest tile and start groups anew', () => {
  const { rows, total } = layoutRows(5, 2, (index) => (index === 3 ? 50 : 30));
  assert.deepEqual(
    rows.map((row) => [row.start, row.end, row.top, row.height]),
    [
      [0, 2, 0, 30],
      [2, 4, 38, 50],
      [4, 5, 96, 30],
    ],
  );
  assert.equal(total, 126);
  const grouped = layoutRows(
    5,
    4,
    () => 10,
    (index) => (index < 3 ? 'a' : 'b'),
    20,
  );
  assert.deepEqual(
    grouped.rows.map((row) => [row.header ?? '', row.start, row.end]),
    [
      ['a', 0, 0],
      ['', 0, 3],
      ['b', 3, 3],
      ['', 3, 5],
    ],
  );
  assert.deepEqual(
    layoutRows(0, 3, () => 10),
    { rows: [], total: 0 },
  );
});

test('the window covers the viewport plus one overscan row on each side', () => {
  const { rows } = layoutRows(100, 4, () => 92); // rows every 100 px
  assert.deepEqual(windowRows(rows, 0, 250), [0, 4]);
  assert.deepEqual(windowRows(rows, 1000, 250), [9, 14]);
  assert.deepEqual(windowRows(rows, 2400, 250), [23, 25]);
  assert.deepEqual(windowRows(rows, 0, 250, 0), [0, 3]);
});

test('small sizes grow until the mounted tiles fit the cap', () => {
  const height = (width) => Math.round(width * 0.62) + 24;
  // 2,000 px wide and 900 px high at 80 px would mount far more than 36 cells.
  const size = fitSize(2000, 900, 200, 36, height);
  const { columns, width } = gridGeometry(2000, size);
  const rows = Math.ceil(900 / (height(width) + 8)) + 3;
  assert.ok(rows * columns <= 36, JSON.stringify({ size, columns, rows }));
  assert.ok(gridGeometry(2000, size - 8).columns > columns || size === 200);
  // A size that already fits is kept, and a single column always fits.
  assert.equal(fitSize(600, 300, 240, 36, height), 240);
  // A tall viewport grows tiles to a single column, which always fits.
  assert.equal(fitSize(200, 10000, 80, 36, height), 104);
  assert.equal(gridGeometry(200, 104).columns, 1);
});

test('navigation keys move by cell, row, page and to the ends, within partial rows', () => {
  const { rows } = layoutRows(10, 4, () => 10); // rows: 0–3, 4–7, 8–9
  const key = (index, name, modifiers = {}) =>
    moveIndex(index, { key: name, ctrlKey: false, metaKey: false, ...modifiers }, rows, 2);
  assert.equal(key(1, 'ArrowRight'), 2);
  assert.equal(key(3, 'ArrowRight'), 3, 'no wrap at a row end');
  assert.equal(key(4, 'ArrowLeft'), 4);
  assert.equal(key(1, 'ArrowDown'), 5);
  assert.equal(key(7, 'ArrowDown'), 9, 'the last partial row clamps to its last tile');
  assert.equal(key(9, 'ArrowDown'), 9);
  assert.equal(key(9, 'ArrowUp'), 5);
  assert.equal(key(6, 'Home'), 4);
  assert.equal(key(5, 'End'), 7);
  assert.equal(key(5, 'Home', { ctrlKey: true }), 0);
  assert.equal(key(5, 'End', { metaKey: true }), 9);
  assert.equal(key(1, 'PageDown'), 9);
  assert.equal(key(9, 'PageUp'), 1);
  assert.equal(key(1, 'Enter'), undefined);
  // Header rows are skipped.
  const grouped = layoutRows(
    6,
    4,
    () => 10,
    (index) => (index < 2 ? 'a' : 'b'),
    20,
  ).rows;
  assert.equal(moveIndex(1, { key: 'ArrowDown' }, grouped, 1), 3);
});

/** A Cover Flow item's corners as drawn: [x, y] in the stage, left then right, top then bottom. */
function corners(item, width) {
  const origin = [width / 2, item.top + item.originY],
    turn = (item.rotate * Math.PI) / 180;
  return [-1, 1].flatMap((side) =>
    [-item.originY, item.height - item.originY].map((y) => {
      const local = (side * item.width * item.scale) / 2,
        x = local * Math.cos(turn) + item.x,
        z = -local * Math.sin(turn) + item.z,
        k = item.perspective / (item.perspective - z);
      return [origin[0] + x * k, origin[1] + y * item.scale * k];
    }),
  );
}
test('Cover Flow fits the current item at its aspect and turns its neighbors toward it', () => {
  const wide = 64 / 27,
    items = flowLayout(1200, 300, 2, 6, (index) => (index === 3 ? 9 / 16 : wide), 32);
  const center = items.get(2);
  // Height-limited: the whole height under the footer, at the file's own aspect.
  assert.equal(center.height, 268);
  assert.ok(Math.abs(center.width / center.height - wide) < 1e-9);
  assert.deepEqual([center.x, center.z, center.rotate, center.scale], [0, 0, 0, 1]);
  // Every item keeps its own aspect and the current item's size.
  for (const item of items.values()) assert.equal(item.scale, 1);
  assert.ok(Math.abs(items.get(3).width / items.get(3).height - 9 / 16) < 1e-9);
  // Neighbors face the middle, turned strongly, and stack outward, nearest on top.
  assert.equal(items.get(1).rotate, 70);
  assert.equal(items.get(3).rotate, -70);
  assert.ok(items.get(3).z < 0);
  assert.ok(items.get(3).x > center.width / 2 && items.get(4).x > items.get(3).x);
  assert.ok(items.get(1).x < -center.width / 2);
  assert.ok(items.get(2).order > items.get(3).order && items.get(3).order > items.get(4).order);
  // The current item is the largest that fits the stage: width-limited, it takes the whole
  // width, with or without neighbors; without an aspect (charts), it fills the stage.
  assert.equal(flowLayout(1000, 2000, 1, 3, () => wide).get(1).width, 1000);
  assert.equal(flowLayout(390, 2000, 0, 3, () => wide).get(0).width, 390);
  assert.equal(flowLayout(390, 2000, 0, 1, () => wide).get(0).width, 390);
  const chart = flowLayout(1000, 300, 1, 3, () => undefined).get(1);
  assert.deepEqual([chart.width, chart.height], [1000, 300]);
  // A current item that fills the width leaves no neighbor shown on either side; one on each
  // side is placed hidden beyond the stage's edge, so moving slides it in or out. Its height
  // does not move the floor.
  for (const flat of [false, true]) {
    const filled = flowLayout(800, 400, 2, 5, (index) => (index === 3 ? 9 / 16 : wide), 32, flat);
    assert.deepEqual([...filled.keys()].sort(), [1, 2, 3], String(flat));
    assert.ok(filled.get(1).hidden && filled.get(3).hidden && !filled.get(2).hidden);
    const [[rightInner]] = corners(filled.get(3), 800),
      [, , [leftInner]] = corners(filled.get(1), 800);
    assert.ok(rightInner >= 800 && leftInner <= 0, `${leftInner} ${rightInner}`);
    const center = filled.get(2);
    assert.equal(center.width, 800);
    assert.ok(Math.abs(center.top - (368 - center.height) / 2) < 1e-9);
  }
  // Space on one side only, at the first item: no neighbor on the left at all.
  const first = flowLayout(1200, 300, 0, 6, () => wide, 32);
  assert.ok(![...first.keys()].some((index) => index < 0));
  assert.ok(!first.get(1).hidden);
  // A neighbor shows only with a usable slice inside the stage, never a sliver: here its
  // inner edge would be 6 px inside each edge.
  const tight = flowLayout(640, 300, 1, 3, () => (2 * (320 - 6 - 268 * 0.08)) / 268, 32);
  assert.ok(tight.get(1).width < 640 && tight.get(0).hidden && tight.get(2).hidden);
  const roomier = flowLayout(640, 300, 1, 3, () => (2 * (320 - 20 - 268 * 0.08)) / 268, 32);
  assert.ok(!roomier.get(0).hidden && !roomier.get(2).hidden);
  // Reduced motion: flat, side by side, without overlap, on the same floor.
  const flat = flowLayout(1200, 400, 2, 6, () => wide, 32, true);
  for (const [index, item] of flat) assert.deepEqual([item.rotate, item.z], [0, 0], String(index));
  const [[rightInner], [, rightBottom]] = corners(flat.get(3), 1200);
  assert.ok(rightInner >= 600 + flat.get(2).width / 2, String(rightInner));
  assert.ok(Math.abs(rightBottom - (flat.get(2).top + flat.get(2).height)) < 1e-6);
});

test('Cover Flow items stand on one floor, with a gap beside the current item and tight stacks', () => {
  // A wide stage around a 4:3 item leaves room for stacks; one neighbor is 9:16.
  const width = 1600,
    items = flowLayout(width, 300, 3, 9, (index) => (index === 6 ? 9 / 16 : 4 / 3), 32),
    center = items.get(3),
    drawn = new Map([...items].map(([index, item]) => [index, corners(item, width)])),
    floor = center.top + center.height;
  // All share one viewer and one vanishing point, on the floor in the middle of the stage.
  assert.equal(new Set([...items.values()].map((item) => item.perspective)).size, 1);
  for (const [index, item] of items) {
    assert.ok(Math.abs(item.top + item.originY - floor) < 1e-9, String(index));
    // Bottom corners lie on the floor line at any depth; outer edges keep the item's height.
    const [topLeft, bottomLeft, topRight, bottomRight] = drawn.get(index);
    for (const [, y] of [bottomLeft, bottomRight]) assert.ok(Math.abs(y - floor) < 1e-6);
    const outer = index < 3 ? [topLeft, bottomLeft] : [topRight, bottomRight];
    if (index !== 3) assert.ok(Math.abs(outer[1][1] - outer[0][1] - item.height) < 1e-6);
  }
  // The tallest shown item is centered in the room above the footer.
  assert.ok(!items.get(6).hidden);
  assert.ok(Math.abs(floor - (268 + items.get(6).height) / 2) < 1e-9);
  // Projected inner edges: a clear gap beside the current item, then small steps, each
  // neighbor mostly hidden behind the one nearer the middle.
  const inner = (index) => Math.abs(drawn.get(index)[index < 3 ? 2 : 0][0] - width / 2),
    outer = (index) => Math.abs(drawn.get(index)[index < 3 ? 0 : 2][0] - width / 2);
  for (const direction of [-1, 1]) {
    const first = 3 + direction,
      gap = inner(first) - center.width / 2;
    assert.ok(gap >= 8 && gap <= center.height * 0.1, String(gap));
    for (let step = 2; step <= 3; step++) {
      const at = 3 + direction * step,
        nearer = at - direction;
      if (!items.has(at)) continue;
      assert.ok(inner(at) - inner(nearer) <= center.height * 0.2, String(at));
      const shown = outer(at) - Math.max(outer(nearer), inner(at));
      assert.ok(shown < (outer(at) - inner(at)) * 0.5, `${at} shows ${shown}`);
    }
  }
  // Turned neighbors are much narrower than they are wide.
  assert.ok(outer(4) - inner(4) < items.get(4).width * 0.45);
  // Neighbors stop at the stage's edge, with one hidden beyond the shown ones.
  const narrow = flowLayout(600, 300, 3, 9, () => 4 / 3, 32),
    hidden = [...narrow].filter(([, item]) => item.hidden).map(([index]) => index);
  assert.deepEqual(hidden.sort(), [1, 5]);
  assert.ok(!narrow.has(0) && !narrow.has(6));
});

test('Cover Flow shows as many neighbors as the width holds, within a bound', () => {
  // Shown and placed neighbors on each side of the middle of 400 4:3 charts, 300 px high.
  const sides = (width, height = 300, flat = false, count = 400, index = 200, footer = 0) => {
    const items = flowLayout(width, height, index, count, () => 4 / 3, footer, flat),
      onSide = (direction, hidden) =>
        [...items].filter(
          ([at, item]) => Math.sign(at - index) === direction && (hidden ? true : !item.hidden),
        ).length;
    return { left: onSide(-1), right: onSide(1), placed: onSide(1, true), items };
  };
  for (const flat of [false, true]) {
    // Narrow: the current item fills the width; only the hidden one waits on each side.
    const narrow = sides(400, 300, flat);
    assert.deepEqual([narrow.left, narrow.right, narrow.placed], [0, 0, 1], String(flat));
    // Wide and very wide stages show more neighbors the wider they are, beyond the old caps.
    let last = 0;
    for (const width of [800, 1600, 3200, 6400]) {
      const { left, right, placed } = sides(width, 300, flat);
      assert.equal(left, right, `${width} ${flat}`);
      assert.ok(right >= last, `${width} ${flat}`);
      assert.equal(placed, right + 1, `${width} ${flat}`);
      last = right;
    }
    assert.ok(sides(3200, 300, flat).right > 3, String(flat));
    assert.ok(sides(6400, 300, flat).right > sides(1600, 300, flat).right, String(flat));
    // Bounded by the items there are: every one shows, with none hidden past the ends.
    const few = sides(20000, 300, flat, 9, 4);
    assert.deepEqual([few.left, few.right, few.placed], [4, 4, 4], String(flat));
    assert.ok(![...few.items.values()].some((item) => item.hidden));
  }
  // Every shown neighbor's inner edge is inside the stage; the hidden ones' are not, or the
  // neighbors before them reach the stage's edge.
  const wide = sides(3200).items;
  for (const [at, item] of wide)
    if (at !== 200) {
      const xs = corners(item, 3200).map(([x]) => x),
        inner = at < 200 ? Math.max(...xs) : 3200 - Math.min(...xs);
      if (!item.hidden) assert.ok(inner > 12, `${at} ${inner}`);
    }
  // A short stage, with a small current item, still steps its neighbors at least the least
  // visible width apart, so no side places more than the bound.
  assert.equal(flowBound(3200), 135);
  for (const flat of [false, true]) {
    const short = sides(3200, 40, flat, 1000, 500, 32);
    assert.ok(short.right > 3 && short.placed <= flowBound(3200), JSON.stringify(short.right));
    const inner = [...short.items]
      .filter(([at, item]) => at > 500 && !item.hidden)
      .map(([, item]) => Math.min(...corners(item, 3200).map(([x]) => x)));
    for (let i = 1; i < inner.length; i++) assert.ok(inner[i] - inner[i - 1] >= 12 - 1e-6);
  }
});
