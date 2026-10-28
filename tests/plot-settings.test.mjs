import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
// Transpiles a frontend module to a data URL, replacing its relative imports.
async function load(name, imports = {}) {
  let js = ts.transpileModule(
    await readFile(new URL(`../frontend/src/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  for (const [specifier, url] of Object.entries(imports))
    js = js.replaceAll(`'${specifier}'`, `'${url}'`);
  return 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
}
const { resolvePlotSettings, sourceOf, groupOf, settingValue, withSetting } = await import(
  await load('plot-settings', { './chart-math': await load('chart-math') })
);

test('panel settings override section settings, which override workspace settings', () => {
  const { settings, sources } = resolvePlotSettings([
    { scope: 'workspace', settings: { xAxis: '_runtime', yScale: 'log', maxRuns: 5 } },
    { scope: 'section', settings: { yScale: 'linear', maxRuns: null } },
    { scope: 'panel', settings: { yMin: 0 } },
  ]);
  assert.deepEqual(
    {
      xAxis: settings.xAxis,
      yScale: settings.yScale,
      maxRuns: settings.maxRuns,
      yMin: settings.yMin,
    },
    { xAxis: '_runtime', yScale: 'linear', maxRuns: null, yMin: 0 },
  );
  assert.deepEqual(
    [sources.xAxis, sources.yScale, sources.maxRuns, sources.yMin, sources.legend],
    ['workspace', 'section', 'section', 'panel', undefined],
  );
  assert.equal(sourceOf(sources, ['yScale', 'yMin']), 'panel');
  assert.equal(sourceOf(sources, ['legend']), 'default');
});

test('smoothing and grouping override as whole groups and resolve to concrete values', () => {
  const inherited = resolvePlotSettings([
    { scope: 'workspace', settings: { smoothingMethod: 'gaussian', smoothingValue: 30 } },
    {
      scope: 'section',
      settings: { groupBy: 'config.lr', aggregation: 'median', spread: 'minmax' },
    },
  ]).settings;
  assert.equal(inherited.smoothingMethod, 'gaussian');
  assert.equal(inherited.smoothingValue, 30);
  const panel = resolvePlotSettings([
    { scope: 'workspace', settings: { smoothingMethod: 'gaussian', smoothingValue: 30 } },
    {
      scope: 'section',
      settings: { groupBy: 'config.lr', aggregation: 'median', spread: 'minmax' },
    },
    { scope: 'panel', settings: { smoothingMethod: 'ema', groupBy: 'none' } },
  ]);
  assert.equal(panel.settings.smoothingMethod, 'ema');
  assert.equal(panel.settings.smoothingValue, 0.6, 'the workspace amount does not leak into EMA');
  assert.equal(panel.settings.groupBy, 'none');
  assert.equal(panel.settings.aggregation, undefined);
  assert.equal(panel.settings.spread, undefined);
  const none = resolvePlotSettings([]).settings;
  assert.equal(none.smoothingMethod, 'none');
  assert.equal(none.smoothingValue, undefined);
});

test('plugin options cascade per key, and an inherit group overrides together', () => {
  const plugin = {
    id: 'stat-card',
    settings: {
      common: [],
      options: [
        { key: 'decimals', type: 'integer', default: 2 },
        { key: 'threshold', type: 'number', default: 0, inheritGroup: 'threshold' },
        { key: 'accent', type: 'color', default: '#0f62fe', inheritGroup: 'threshold' },
      ],
    },
  };
  const layers = [
    {
      scope: 'workspace',
      settings: { options: { 'stat-card': { decimals: 3, threshold: 5, accent: '#ff0000' } } },
    },
    { scope: 'section', settings: { options: { other: { flag: true } } } },
    { scope: 'panel', settings: { options: { 'stat-card': { threshold: 9 } } } },
  ];
  const { settings, sources } = resolvePlotSettings(layers, [plugin]);
  // The panel's threshold replaces the workspace's threshold and accent; decimals inherit.
  assert.deepEqual(settings.options, {
    'stat-card': { decimals: 3, threshold: 9 },
    other: { flag: true },
  });
  assert.equal(sources['options.stat-card.decimals'], 'workspace');
  assert.equal(sources['options.stat-card.threshold'], 'panel');
  assert.equal(sources['options.stat-card.accent'], undefined);
  assert.equal(
    sourceOf(sources, ['options.stat-card.accent', 'options.stat-card.decimals']),
    'workspace',
  );
  assert.deepEqual(groupOf('options.stat-card.accent', [plugin]), [
    'options.stat-card.threshold',
    'options.stat-card.accent',
  ]);
  assert.deepEqual(groupOf('options.stat-card.decimals', [plugin]), ['options.stat-card.decimals']);
  // Without the plugin's descriptors each key cascades alone.
  assert.deepEqual(resolvePlotSettings(layers).settings.options['stat-card'], {
    decimals: 3,
    threshold: 9,
    accent: '#ff0000',
  });
  assert.equal(settingValue(layers[0].settings, 'options.stat-card.decimals'), 3);
  assert.deepEqual(withSetting(layers[2].settings, 'options.stat-card.threshold', undefined), {});
  assert.deepEqual(withSetting({}, 'options.stat-card.decimals', 1), {
    options: { 'stat-card': { decimals: 1 } },
  });
});

test('a plugin default for a host setting applies only when no layer sets it', () => {
  const layers = [{ scope: 'section', settings: { layout: 'grid', mediaAcross: 'steps' } }];
  const media = resolvePlotSettings(layers, [], { itemSize: 200 });
  assert.equal(media.settings.itemSize, 200);
  assert.equal(media.sources.itemSize, 'default');
  assert.equal(media.settings.mediaAcross, 'steps');
  const sized = resolvePlotSettings(
    [...layers, { scope: 'panel', settings: { itemSize: 320 } }],
    [],
    { itemSize: 200 },
  );
  assert.deepEqual([sized.settings.itemSize, sized.sources.itemSize], [320, 'panel']);
});

const { focusedRun, focusedSeries, supportsFocusedRun } = await import(await load('focused-run'));
test('focused run cascades and can be reset to all or a numeric limit', () => {
  for (const [layer, expected] of [
    [{}, 'focused'],
    [{ maxRuns: null }, null],
    [{ maxRuns: 2 }, 2],
  ]) {
    const result = resolvePlotSettings([
      { scope: 'workspace', settings: { maxRuns: 5 } },
      { scope: 'section', settings: { maxRuns: 'focused' } },
      { scope: 'panel', settings: layer },
    ]);
    assert.equal(result.settings.maxRuns, expected);
    assert.equal(result.sources.maxRuns, Object.hasOwn(layer, 'maxRuns') ? 'panel' : 'section');
  }
  assert.equal(supportsFocusedRun({ recordTransform: { kind: 'align' } }, 2), true);
  assert.equal(supportsFocusedRun({ recordTransform: { kind: 'align' } }, 1), false);
  assert.equal(supportsFocusedRun({}, 2), false);
});

test('excluding outliers inherits independently of the Y bounds and can be turned off', () => {
  const { settings, sources } = resolvePlotSettings([
    { scope: 'workspace', settings: { excludeOutliers: true } },
    { scope: 'panel', settings: { yMax: 10 } },
  ]);
  assert.deepEqual([settings.excludeOutliers, sources.excludeOutliers], [true, 'workspace']);
  assert.deepEqual(sourceOf(sources, ['yScale', 'yMin', 'yMax']), 'panel');
  const off = resolvePlotSettings([
    { scope: 'workspace', settings: { excludeOutliers: true } },
    { scope: 'section', settings: { excludeOutliers: false } },
  ]);
  assert.deepEqual([off.settings.excludeOutliers, off.sources.excludeOutliers], [false, 'section']);
});

test('outlier percentiles inherit as a pair, separately from the option', () => {
  const { settings, sources } = resolvePlotSettings([
    { scope: 'workspace', settings: { excludeOutliers: true, outlierLower: 10, outlierUpper: 90 } },
    { scope: 'section', settings: { outlierUpper: 80 } },
  ]);
  // Setting one percentile replaces the pair, so an inherited lower bound cannot meet a
  // new upper bound below it.
  assert.deepEqual(
    [settings.excludeOutliers, settings.outlierLower, settings.outlierUpper],
    [true, undefined, 80],
  );
  assert.equal(sources.excludeOutliers, 'workspace');
  assert.equal(sourceOf(sources, ['outlierLower', 'outlierUpper']), 'section');
  const inherited = resolvePlotSettings([
    { scope: 'workspace', settings: { outlierLower: 2, outlierUpper: 98 } },
    { scope: 'panel', settings: { excludeOutliers: true } },
  ]);
  assert.deepEqual([inherited.settings.outlierLower, inherited.settings.outlierUpper], [2, 98]);
  assert.equal(sourceOf(inherited.sources, ['outlierLower', 'outlierUpper']), 'workspace');
});

test('focused run chooses latest creation, external hover, and visible group membership', () => {
  const runs = [
    { id: 'old', created: 1 },
    { id: 'new', created: 3 },
    { id: 'middle', created: 2 },
  ];
  const series = runs.map(({ id }) => ({ id, name: id, values: {} }));
  const pick = (focus, items = series) => focusedSeries(items, runs, focus, 'self');
  assert.equal(pick(null).id, 'new');
  assert.equal(focusedRun(runs, null, 'self').id, 'new');
  assert.equal(
    pick({ source: 'other', ids: ['new'] }, [series[0]]).id,
    'old',
    'keep the loaded run while the target loads',
  );
  assert.equal(pick({ source: 'other', ids: ['old'] }).id, 'old');
  assert.equal(pick({ source: 'self', ids: ['old'] }).id, 'new');
  assert.equal(pick({ source: 'other', ids: ['hidden'] }).id, 'new');
  assert.equal(pick(null, [series[0], series[2]]).id, 'middle');
  assert.equal(pick(null, []), undefined);
  assert.equal(
    focusedSeries(series, runs.slice(1), { source: 'other', ids: ['old'] }, 'self').id,
    'new',
    'stale response members cannot rejoin visibility',
  );
  const groups = [
    { id: 'g1', runIds: ['old', 'new'] },
    { id: 'g2', runIds: ['middle'] },
  ];
  assert.equal(pick(null, groups).id, 'g1');
  assert.equal(pick({ source: 'other', ids: ['middle'] }, groups).id, 'g2');
  assert.equal(pick({ source: 'other', ids: ['missing', 'middle', 'old'] }, groups).id, 'g2');
  assert.equal(
    focusedSeries(
      series,
      runs.map((r) => ({ ...r, created: 1 })),
      null,
      'self',
    ).id,
    'old',
    'creation ties use stable descending ID',
  );
});

const { runFocus, setHoveredRuns } = await import(
  await load('hover', { 'svelte/store': import.meta.resolve('svelte/store') })
);
test('hover ownership survives a stale leave and clears on owner cleanup', () => {
  let current;
  const unsubscribe = runFocus.subscribe((value) => {
    current = value;
  });
  setHoveredRuns('panel', ['one']);
  setHoveredRuns('run-list', ['two']);
  setHoveredRuns('panel', []);
  assert.deepEqual(current, { source: 'run-list', ids: ['two'] });
  setHoveredRuns('run-list', []);
  assert.equal(current, null);
  unsubscribe();
});

const { scheduled } = await import(await load('api'));
test('chart scheduling limits concurrency and cancels queued hover loads immediately', async () => {
  let active = 0,
    maximum = 0;
  const releases = [];
  const jobs = Array.from({ length: 4 }, () =>
    scheduled(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => releases.push(resolve));
      active--;
    }, new AbortController().signal),
  );
  const controller = new AbortController();
  let ran = false;
  const queued = scheduled(async () => {
    ran = true;
  }, controller.signal);
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(active, 4);
  assert.equal(ran, false);
  releases.forEach((resolve) => resolve());
  await Promise.all(jobs);
  assert.equal(maximum, 4);
  await scheduled(async () => {
    ran = true;
  }, new AbortController().signal);
  assert.equal(ran, true);
});
