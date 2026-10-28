import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// Excluding outliers from the automatic Y range: the settings cascade, explicit bounds,
// real values in the inspector, smoothing, grouped spread, drag zoom and reset, each
// chart type, and the percentile controls (typing, slider, keyboard, limits, inheritance).
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-outliers-'));
let server, browser;
const errors = [],
  checked = [];
try {
  server = await createServer(directory);
  const runs = [];
  // Values near 1, with one spike up in run 0 and one down in run 1.
  const loss = (step, index) =>
    index === 0 && step === 150
      ? 500
      : index === 1 && step === 151
        ? -400
        : 1 + 0.2 * Math.sin(step / 15) + 0.1 * index + (step < 100 ? 0 : -0.3);
  for (let index = 0; index < 3; index++) {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'outliers',
      name: 'run-' + index,
      displayName: 'Run ' + index,
      summaryMetrics: { score: [10, 20, 300][index] },
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          // Shares of 1, 2 and 3, with a spike to 200 in run 2; a histogram with one
          // dominant bin at the last step.
          content: Array.from({ length: 300 }, (_, step) =>
            JSON.stringify({
              _step: step,
              loss: loss(step, index),
              phase: step / 10,
              share: index === 2 && step === 150 ? 200 : 1 + index,
              ...(step === 299
                ? {
                    dist: {
                      _type: 'histogram',
                      bins: Array.from({ length: 31 }, (_, bin) => bin),
                      values: Array.from({ length: 30 }, (_, bin) =>
                        bin === 12 ? 500 : 3 + (bin % 4),
                      ),
                    },
                  }
                : {}),
            }),
          ),
        },
      },
      complete: true,
      exitcode: 0,
    });
    runs.push(run.id);
  }
  const view = await server.tools.execute('view_create', {
    project: 'test/outliers',
    name: 'Outliers',
    body: {
      generation: 'manual',
      visible: runs,
      solo: [],
      sections: [
        { id: 'charts', name: 'charts' },
        { id: 'types', name: 'types' },
      ],
      sectionLayouts: {
        charts: { width: 460, height: 300, rows: 2 },
        types: { width: 460, height: 300, rows: 3 },
      },
      panels: [
        { id: 'line', plugin: 'line', metric: 'loss', title: 'Loss' },
        {
          id: 'grouped',
          plugin: 'line',
          metric: 'loss',
          title: 'Grouped',
          settings: {
            groupBy: 'all',
            aggregation: 'mean',
            spread: 'minmax',
            smoothingMethod: 'ema',
          },
        },
        { id: 'fixed', plugin: 'line', metric: 'loss', title: 'Fixed', settings: { yMax: 1000 } },
        { id: 'stacked', plugin: 'stacked-area', metric: 'share', title: 'Share' },
      ]
        .map((panel) => ({ ...panel, section: 'charts' }))
        .concat(
          [
            { id: 'percent', plugin: 'percent-area', metric: 'share', title: 'Percent' },
            // Shares ignore explicit Y bounds, such as a range inherited for loss charts.
            {
              id: 'percent-bounded',
              plugin: 'percent-area',
              metric: 'share',
              title: 'Percent with Y bounds',
              settings: { yMin: 20, yMax: 30 },
            },
            {
              id: 'bar',
              plugin: 'bar',
              metric: 'summary.score',
              metrics: ['summary.score'],
              title: 'Score',
            },
            {
              id: 'scatter',
              plugin: 'scatter-history',
              metric: 'loss',
              metrics: ['loss', 'phase'],
              title: 'Loss by phase',
            },
            { id: 'histogram', plugin: 'histogram', metric: 'dist', title: 'Distribution' },
          ].map((panel) => ({ ...panel, section: 'types' })),
        ),
    },
  });
  const stored = async () => (await server.db.call('view', view.id)).body;
  const origin = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/test/outliers/workspace?view=${view.id}`);
  const panel = (id) => page.locator(`[data-panel-id="${id}"]`);
  const ready = async (id) => {
    await expect(panel(id).locator('canvas').first()).toBeVisible();
    await expect(panel(id)).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  // Axis extents, the plot rectangle and X pixels in page coordinates, read from ECharts.
  const inspect = async (id, xs = []) => {
    await panel(id).scrollIntoViewIfNeeded();
    await ready(id);
    return page.evaluate(
      async ({ id, xs }) => {
        const engineURL = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => /\/assets\/engine-[^/]+\.js(?:\?|$)/.test(name));
        const echarts = Object.values(await import(engineURL)).find(
          (value) => value && typeof value.getInstanceByDom === 'function',
        );
        const host = [
          ...document.querySelectorAll(`[data-panel-id="${id}"] [_echarts_instance_]`),
        ].find((element) => echarts.getInstanceByDom(element));
        const chart = echarts.getInstanceByDom(host),
          model = chart.getModel(),
          rect = model.getComponent('grid', 0).coordinateSystem.getRect(),
          box = host.getBoundingClientRect();
        return {
          x: model.getComponent('xAxis', 0).axis.scale.getExtent(),
          y: model.getComponent('yAxis', 0).axis.scale.getExtent(),
          bands: chart.getOption().series.filter((s) => String(s.stack).startsWith('band:')).length,
          top: box.top + rect.y,
          height: rect.height,
          pixels: xs.map((x) => box.left + chart.convertToPixel({ xAxisIndex: 0 }, x)),
        };
      },
      { id, xs },
    );
  };
  const ids = [
    'line',
    'grouped',
    'fixed',
    'stacked',
    'percent',
    'percent-bounded',
    'bar',
    'scatter',
    'histogram',
  ];
  for (const id of ids) {
    await panel(id).scrollIntoViewIfNeeded();
    await ready(id);
  }
  await page.mouse.move(0, 0);
  const unfitted = Object.fromEntries(
    await Promise.all(ids.map(async (id) => [id, (await inspect(id)).y])),
  );
  const before = { y: unfitted.line };
  assert.ok(before.y[0] <= -400 && before.y[1] >= 500, `spikes set the range (${before.y})`);
  assert.ok(unfitted.stacked[1] >= 200, `the stack total spike sets Y (${unfitted.stacked})`);
  assert.deepEqual(unfitted.percent, [0, 100]);
  assert.deepEqual(unfitted['percent-bounded'], [0, 100]);
  assert.ok(unfitted.bar[1] >= 300 && unfitted.scatter[1] >= 500 && unfitted.histogram[1] >= 500);

  // Workspace settings turn it on for every line panel.
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  let drawer = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await drawer.getByRole('tab', { name: 'Axes', exact: true }).click();
  const option = (scope) =>
    scope.getByRole('checkbox', { name: 'Exclude outliers from the Y range', exact: true });
  const tabOrigin = (scope) =>
    scope.locator('[role="tabpanel"]:not([hidden]) .setting-origin').last();
  const percentile = (scope, bound) =>
    scope.getByRole('spinbutton', { name: bound + ' percentile', exact: true });
  const thumb = (scope, bound) =>
    scope.getByRole('slider', { name: bound + ' percentile', exact: true });
  const optionOrigin = (scope) =>
    scope.locator('[role="tabpanel"]:not([hidden]) .setting-origin').nth(-2);
  await expect(option(drawer)).not.toBeChecked();
  for (const bound of ['Lower', 'Upper']) await expect(percentile(drawer, bound)).toBeDisabled();
  await expect(percentile(drawer, 'Lower')).toHaveValue('5');
  await expect(percentile(drawer, 'Upper')).toHaveValue('95');
  await drawer.getByText('Exclude outliers from the Y range', { exact: true }).click();
  await expect(option(drawer)).toBeChecked();
  // Workspace settings show an origin only for values they set.
  const origins = drawer.locator('[role="tabpanel"]:not([hidden]) .setting-origin');
  await expect(origins).toHaveCount(1);
  await expect(origins).toContainText('Set for this workspace');
  await percentile(drawer, 'Lower').fill('2');
  await percentile(drawer, 'Lower').press('Tab');
  await expect(origins).toHaveCount(2);
  await expect(tabOrigin(drawer)).toContainText('Set for this workspace');
  await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect
    .poll(async () => (await stored()).plotSettings)
    .toEqual({ excludeOutliers: true, outlierLower: 2, outlierUpper: 95 });
  await ready('line');
  let fitted;
  await expect.poll(async () => (fitted = await inspect('line')).y[1] < 5).toBe(true);
  assert.ok(fitted.y[0] > 0 && fitted.y[1] > 1, `Y fits the bulk (${fitted.y})`);
  checked.push(`workspace setting: Y ${before.y.join('–')} → ${fitted.y.join('–')}`);

  // Smoothed groups keep their spread band, which is clipped rather than widening Y.
  const grouped = await inspect('grouped');
  assert.ok(grouped.bands > 0, 'the spread band is drawn');
  assert.ok(grouped.y[1] < 5 && grouped.y[0] > -5, `grouped Y fits the bulk (${grouped.y})`);
  checked.push(`grouped, smoothed: Y ${grouped.y.join('–')} with ${grouped.bands} band series`);

  // An explicit bound wins; the other bound still excludes outliers.
  const fixed = await inspect('fixed');
  assert.equal(fixed.y[1], 1000);
  assert.ok(fixed.y[0] > 0, `the automatic minimum excludes the low spike (${fixed.y})`);
  checked.push(`explicit Y maximum wins: Y ${fixed.y.join('–')}`);

  // The inspector reports the clipped spike's real value.
  const [spike] = (await inspect('line', [150])).pixels;
  await page.mouse.move(spike, fitted.top + fitted.height / 2);
  const popup = page.locator('.plot-inspector[data-local="true"]:visible');
  await expect(popup).toContainText('150');
  await expect(popup).toContainText('500');
  checked.push('inspector shows the clipped value 500');

  // Drag zoom refits Y to the bulk of the zoomed range; a click resets it.
  const [from, to] = (await inspect('line', [200, 290])).pixels;
  const middle = fitted.top + fitted.height / 2;
  await page.mouse.move(from, middle);
  await page.mouse.down();
  await page.mouse.move(to, middle, { steps: 6 });
  await page.mouse.up();
  const reset = panel('line').locator('.chart-reset');
  await expect(reset).toBeVisible();
  let zoomed;
  await expect
    .poll(async () => {
      zoomed = await inspect('line');
      return Math.abs(zoomed.x[0] - 200) < 3 && zoomed.y[1] < fitted.y[1];
    })
    .toBe(true);
  assert.ok(zoomed.y[1] < 1.3 && zoomed.y[0] > 0.3, `zoomed Y fits the range (${zoomed.y})`);
  await page.mouse.click((from + to) / 2, middle);
  await expect(reset).toHaveCount(0);
  await expect.poll(async () => (await inspect('line')).y).toEqual(fitted.y);
  checked.push(`zoom 200–290: Y ${zoomed.y.join('–')}; reset restores ${fitted.y.join('–')}`);

  // Every chart type fits the bulk of its values.
  const fit = {};
  for (const id of ['stacked', 'percent', 'scatter', 'histogram'])
    await expect
      .poll(async () => {
        fit[id] = (await inspect(id)).y;
        return String(fit[id]) !== String(unfitted[id]);
      })
      .toBe(true);
  assert.ok(fit.stacked[0] === 0 && fit.stacked[1] < 20, `stack totals (${fit.stacked})`);
  assert.ok(fit.percent[0] > 0 && fit.percent[1] < 100, `band boundaries (${fit.percent})`);
  assert.deepEqual((await inspect('percent-bounded')).y, fit.percent);
  assert.ok(fit.scatter[1] < 5 && fit.scatter[0] > -5, `scatter Y (${fit.scatter})`);
  assert.ok(fit.histogram[0] === 0 && fit.histogram[1] < 50, `bin counts (${fit.histogram})`);
  // Three bars at the 2nd and 95th percentiles keep their whole range.
  assert.deepEqual((await inspect('bar')).y, unfitted.bar);
  checked.push('fitted: ' + JSON.stringify(fit));

  // The stacked inspector reports the real value of the clipped spike.
  {
    const box = await inspect('stacked', [150]);
    await page.mouse.move(box.pixels[0], box.top + box.height / 2);
    const popup = page.locator('.plot-inspector[data-local="true"]:visible');
    await expect(popup).toContainText('200');
    await page.mouse.move(0, 0);
    checked.push('stacked inspector shows the clipped value 200');
  }

  // The panel editor names the source; a full explicit range disables the option.
  await panel('line').hover();
  await panel('line').getByRole('button', { name: 'Panel settings', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  await editor.getByRole('tab', { name: 'Axes', exact: true }).click();
  await expect(option(editor)).toBeChecked();
  await expect(optionOrigin(editor)).toHaveText('From workspace settings');
  await expect(tabOrigin(editor)).toHaveText('From workspace settings');
  await editor.getByRole('spinbutton', { name: 'Y minimum', exact: true }).fill('0');
  await editor.getByRole('spinbutton', { name: 'Y maximum', exact: true }).fill('3');
  await expect(option(editor)).toBeDisabled();
  await expect(percentile(editor, 'Upper')).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toBeHidden();
  checked.push('panel editor: inherited source; disabled by a full explicit range');

  // Percentile controls on a bar panel: typing, limits, keyboard, drag and reset.
  const openEditor = async (id) => {
    await panel(id).scrollIntoViewIfNeeded();
    await panel(id).hover();
    await panel(id).getByRole('button', { name: 'Panel settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Panel settings', exact: true });
    await dialog.getByRole('tab', { name: 'Axes', exact: true }).click();
    return dialog;
  };
  editor = await openEditor('bar');
  await expect(option(editor)).toBeChecked();
  await expect(percentile(editor, 'Lower')).toHaveValue('2');
  await expect(tabOrigin(editor)).toHaveText('From workspace settings');
  // The median drops the top bar: 10, 20 and 300 fit 0–20.
  await percentile(editor, 'Upper').fill('50');
  await percentile(editor, 'Upper').press('Tab');
  await expect(tabOrigin(editor)).toContainText('Set for this panel');
  // The lower percentile must stay below the upper one; values stay within 0–100.
  const invalid = editor.getByText('The lower percentile must be less than the upper percentile.', {
    exact: true,
  });
  const save = editor.getByRole('button', { name: 'Save panel', exact: true });
  await percentile(editor, 'Lower').fill('70');
  await percentile(editor, 'Lower').press('Tab');
  await expect(invalid).toBeVisible();
  await expect(save).toBeDisabled();
  await percentile(editor, 'Lower').fill('50');
  await percentile(editor, 'Lower').press('Tab');
  await expect(invalid).toBeVisible();
  await percentile(editor, 'Lower').fill('49');
  await percentile(editor, 'Lower').press('Tab');
  await expect(invalid).toHaveCount(0);
  await expect(save).toBeEnabled();
  await percentile(editor, 'Upper').fill('150');
  await percentile(editor, 'Upper').press('Tab');
  await expect(percentile(editor, 'Upper')).toHaveValue('100');
  // Keyboard: Home, arrows and Shift for large steps.
  await thumb(editor, 'Lower').focus();
  await thumb(editor, 'Lower').press('Home');
  await expect(percentile(editor, 'Lower')).toHaveValue('0');
  await thumb(editor, 'Lower').press('ArrowRight');
  await expect(percentile(editor, 'Lower')).toHaveValue('1');
  await thumb(editor, 'Upper').focus();
  await thumb(editor, 'Upper').press('ArrowLeft');
  await expect(percentile(editor, 'Upper')).toHaveValue('99');
  await thumb(editor, 'Upper').press('Shift+ArrowLeft');
  await expect(percentile(editor, 'Upper')).toHaveValue('74');
  // Dragging the upper thumb to the start makes it 0, below the lower percentile.
  const handle = await thumb(editor, 'Upper').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 600, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(percentile(editor, 'Upper')).toHaveValue('0');
  await expect(invalid).toBeVisible();
  await percentile(editor, 'Upper').fill('50');
  await percentile(editor, 'Upper').press('Tab');
  await expect(invalid).toHaveCount(0);
  await save.click();
  await expect(editor).toBeHidden();
  await expect
    .poll(async () => (await stored()).panels.find((item) => item.id === 'bar').settings)
    .toEqual({ outlierLower: 1, outlierUpper: 50 });
  let bar;
  await expect.poll(async () => (bar = await inspect('bar')).y[1] < 300).toBe(true);
  assert.deepEqual(bar.y, [0, 20]);
  checked.push(`bar at the 1st–50th percentile: Y ${unfitted.bar.join('–')} → ${bar.y.join('–')}`);
  // Reset returns to the inherited percentiles.
  editor = await openEditor('bar');
  await expect(tabOrigin(editor)).toContainText('Set for this panel');
  await editor
    .getByRole('button', { name: 'Reset Outlier percentiles to inherited value', exact: true })
    .click();
  await expect(tabOrigin(editor)).toHaveText('From workspace settings');
  await expect(percentile(editor, 'Lower')).toHaveValue('2');
  await expect(percentile(editor, 'Upper')).toHaveValue('95');
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await inspect('bar')).y).toEqual(unfitted.bar);
  checked.push('percentiles: typed, validated, keyboard, drag, saved, reset to inherited');

  // A histogram has the option without Y bounds.
  editor = await openEditor('histogram');
  await expect(option(editor)).toBeChecked();
  await expect(editor.getByRole('spinbutton', { name: 'Y maximum', exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toBeHidden();

  // A section turns it off again and can reset to the inherited value.
  await page.locator('[data-section-id="charts"] .section-heading').hover();
  await page.getByRole('button', { name: 'charts section settings', exact: true }).click();
  drawer = page.getByRole('dialog', { name: 'charts section settings', exact: true });
  await drawer.getByRole('tab', { name: 'Axes', exact: true }).click();
  await expect(optionOrigin(drawer)).toHaveText('From workspace settings');
  await expect(tabOrigin(drawer)).toHaveText('From workspace settings');
  await drawer.getByText('Exclude outliers from the Y range', { exact: true }).click();
  await expect(option(drawer)).not.toBeChecked();
  await expect(optionOrigin(drawer)).toContainText('Set for this section');
  await expect(percentile(drawer, 'Lower')).toBeDisabled();
  await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect
    .poll(async () => (await stored()).sectionSettings?.charts)
    .toEqual({ excludeOutliers: false });
  await expect.poll(async () => (await inspect('line')).y[1] >= 500).toBe(true);
  checked.push('section override turns it off');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: checked }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ completedChecks: checked }));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
