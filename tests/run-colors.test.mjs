import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { Store } from '../backend/dist/database.js';
const source = await readFile(new URL('../frontend/src/run-colors.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { componentColor, runPalette, color, runTextColor, resolveRunColors, resolvePaletteColor } =
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
// W&B web app (production bundle 8b7b506f0): COLORS16 and the ROBIN16 round-robin order.
const COLORS16 = [
  '#F07FDD',
  '#C2327A',
  '#F0434F',
  '#FAB796',
  '#E57439',
  '#FFB83D',
  '#9BC750',
  '#479A5F',
  '#87CEBF',
  '#229487',
  '#5BC5DB',
  '#538AE5',
  '#865ED6',
  '#DC4BDC',
  '#AD6F50',
  '#A1A9AD',
];
const ROBIN16 = [11, 2, 7, 12, 0, 4, 8, 13, 5, 10, 9, 3, 6, 14, 1, 15].map((i) =>
  COLORS16[i].toLowerCase(),
);
// W&B-derived dark palette corrected for Carbon g100 contrast (see wandb-reference.md).
const DARK16 = [
  '#6499f0',
  '#ff8b96',
  '#5aaa71',
  '#bf98ff',
  '#cb5eb9',
  '#ea7e45',
  '#4c8f7e',
  '#ff7cff',
  '#b8723c',
  '#328ea3',
  '#48b6a9',
  '#ca8463',
  '#638f39',
  '#cf9476',
  '#ff9fe4',
  '#7b8488',
];
function linearRGB(hex) {
  return [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
}
function contrast(foreground, background) {
  const luminance = (hex) =>
    linearRGB(hex).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
  return (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
}
function oklab(hex) {
  const [r, g, b] = linearRGB(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
test('dark series and text contrast on Carbon chart, sidebar, table and tooltip surfaces', () => {
  // g100 ui-01/layer, hover-ui/layer-hover, and the shared ECharts tooltip background.
  for (const background of ['#262626', '#353535', '#393939']) {
    for (const { light, dark } of runPalette) {
      assert.ok(contrast(dark, background) >= 3, `${light} series on ${background}`);
      assert.ok(
        contrast(runTextColor(dark, true), background) >= 4.5,
        `${light} text on ${background}`,
      );
    }
  }
});
test('dark palette colors retain perceptual separation', () => {
  const colors = runPalette.map(({ dark }) => oklab(dark));
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const delta = Math.hypot(...colors[i].map((channel, k) => channel - colors[j][k]));
      assert.ok(delta >= 0.04, `palette entries ${i} and ${j}: OKLab ΔE ${delta}`);
    }
  }
});
// W&B's colorFromName hash, kept literal here as an independent reference.
function wandbHash(s) {
  return s.split('').reduce((a, b) => {
    a = (a << 10) - a + b.charCodeAt(0);
    return a & a;
  }, 0);
}
test('the palette preserves W&B ROBIN16 light values and assignment order', () => {
  assert.deepEqual(
    runPalette,
    ROBIN16.map((light, i) => ({ light, dark: DARK16[i] })),
  );
});
test('runs take the palette color of their creation index, wrapping after 16', () => {
  const runs = Array.from({ length: 40 }, (_, i) => ({ id: 'e/p/r' + i, color_index: i })),
    colors = resolveRunColors(runs);
  for (const [i, run] of runs.entries()) assert.equal(colors[run.id], ROBIN16[i % 16]);
  assert.equal(colors['e/p/r0'], '#538ae5');
  assert.equal(colors['e/p/r16'], colors['e/p/r0']);
  // Order and the presence of other runs do not change a run's color.
  const subset = resolveRunColors([runs[30], runs[3]].reverse());
  assert.equal(subset[runs[30].id], colors[runs[30].id]);
  assert.equal(subset[runs[3].id], colors[runs[3].id]);
});
test('explicit view colors override the default', () => {
  const colors = resolveRunColors(
    [
      { id: 'a', color_index: 0 },
      { id: 'b', color_index: 1 },
    ],
    { a: '#123456' },
  );
  assert.deepEqual(colors, { a: '#123456', b: ROBIN16[1] });
  assert.equal(color('a', colors), '#123456');
});
test('runs without an index and group series use W&B name hashing', () => {
  for (const name of ['3kq8x2mz', 'p5w0n7ad', 'group:"sweep-a"', '', 'ünïcode'])
    assert.equal(color(name), ROBIN16[Math.abs(wandbHash(name)) % 16]);
  const colors = resolveRunColors([{ id: 'e/p/3kq8x2mz', name: '3kq8x2mz' }]);
  assert.equal(colors['e/p/3kq8x2mz'], color('3kq8x2mz'));
});
test('palette choices resolve in either theme and custom hex values stay as stored', () => {
  const runs = ROBIN16.map((_, i) => ({ id: String(i), color_index: i + 16 }));
  for (const dark of [false, true]) {
    const expected = dark ? DARK16 : ROBIN16;
    assert.deepEqual(Object.values(resolveRunColors(runs, {}, dark)), expected);
    for (const [i, light] of ROBIN16.entries()) {
      assert.equal(resolvePaletteColor(light.toUpperCase(), dark), expected[i]);
      const overrides = { picked: light.toUpperCase(), custom: '#12Ab56', unloaded: light };
      assert.deepEqual(resolveRunColors([], overrides, dark), {
        picked: expected[i],
        custom: '#12Ab56',
        unloaded: expected[i],
      });
      assert.equal(
        overrides.picked,
        light.toUpperCase(),
        'resolution never rewrites saved choices',
      );
    }
    // A custom value equal to a dark variant is still a custom value, even in light mode.
    assert.equal(resolvePaletteColor(DARK16[0], dark), DARK16[0]);
    for (const name of ['group:"sweep-a"', 'ünïcode']) {
      assert.equal(color(name, {}, dark), expected[Math.abs(wandbHash(name)) % 16]);
      assert.equal(resolveRunColors([{ id: 'run', name }], {}, dark).run, color(name, {}, dark));
    }
  }
});
test('legend and tooltip text use the matching theme variants', () => {
  const text = {
    0: ['#538ae5', '#6da3fa'],
    2: ['#479a5f', '#62b379'],
    4: ['#e077cf', '#e47ed3'],
    5: ['#e57439', '#f2854c'],
    6: ['#6eb8a8', '#68af9f'],
    7: ['#cc45cc', '#ff87ff'],
    8: ['#f0a118', '#df904a'],
    9: ['#1fa8d4', '#32afd9'],
    11: ['#e09267', '#de8f66'],
    12: ['#81a83d', '#87af4a'],
    13: ['#b87654', '#d39472'],
    15: ['#818a8f', '#9aa4a9'],
  };
  for (const [i, light] of ROBIN16.entries()) {
    assert.equal(runTextColor(light.toUpperCase(), false), text[i]?.[0] ?? light.toUpperCase());
    assert.equal(runTextColor(DARK16[i], true), text[i]?.[1] ?? DARK16[i]);
  }
  assert.equal(runTextColor('#12Ab56', true), '#12Ab56');
  assert.equal(runTextColor('#12Ab56', false), '#12Ab56');
});
test('the server assigns color indexes at creation per project and never reuses them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'randl-colors-'));
  let store = new Store(dir);
  t.after(async () => {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const create = (project, name) => store.upsert({ entity: 'e', project, name });
  const a = create('p', 'a'),
    b = create('p', 'b'),
    other = create('q', 'x');
  assert.equal(a.color_index, 0);
  assert.equal(b.color_index, 1);
  assert.equal(other.color_index, 0);
  // Updating a run keeps its index.
  assert.equal(
    store.upsert({ entity: 'e', project: 'p', name: 'a', state: 'finished' }).color_index,
    0,
  );
  // Deleted runs keep their index, so later runs and restored runs are not recolored.
  store.runManage({ action: 'delete', ids: [b.id] });
  assert.equal(create('p', 'c').color_index, 2);
  store.runManage({ action: 'restore', ids: [b.id] });
  assert.equal(store.run(b.id).color_index, 1);
  assert.deepEqual(
    Object.fromEntries(
      store
        .runs()
        .filter((run) => run.project === 'p')
        .map((run) => [run.name, run.color_index]),
    ),
    { a: 0, b: 1, c: 2 },
  );
  assert.equal(store.runMetas([a.id])[0].color_index, 0);

});

test('area components use the W&B round-robin palette in both themes, including wraparound', () => {
  for (const dark of [false, true]) {
    const expected = dark ? DARK16 : ROBIN16;
    for (let i = 0; i < 32; i++) assert.equal(componentColor(i, dark), expected[i % 16]);
    // Test displayed (sRGB-composited) fills, including the cycle boundary.
    const fills = expected.map((hex) => {
      const background = dark ? 38 : 255;
      return (
        '#' +
        [1, 3, 5]
          .map((i) =>
            Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.85 + background * 0.15)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('')
      );
    });
    for (let i = 0; i < fills.length; i++) {
      const ratio = contrast(fills[i], dark ? '#262626' : '#ffffff');
      assert.ok(Math.max(ratio, 1 / ratio) >= (dark ? 3.1 : 1.5));
      const a = oklab(fills[i]),
        b = oklab(fills[(i + 1) % fills.length]);
      assert.ok(
        Math.hypot(...a.map((c, k) => c - b[k])) >= 0.1,
        `adjacent blended components ${i}`,
      );
    }
  }
});
