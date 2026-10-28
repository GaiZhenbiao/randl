import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Each smoothing method visibly smooths at its default on steps far apart, on a custom
// metric X axis and on wall time; the editor offers per-method ranges and remembers values.
// npm run build && PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:smoothing
const expect = playwrightExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-smoothing-'));
const checks = [];
let server, browser;
try {
  server = await createServer(directory);
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'smoothing',
    name: 'noisy',
    displayName: 'Noisy run',
  });
  // Steps 1e7 apart with uneven gaps; global_step is a custom X near 1e9.
  const content = Array.from({ length: 160 }, (_, i) =>
    JSON.stringify({
      _step: i * 10_000_000 + (i % 3) * 2_000_000,
      _timestamp: 1_790_000_000 + i * 60 + (i % 4) * 7,
      global_step: 1_000_000_000 + i * 12_500_000,
      loss: Math.sin(i / 15) + (i % 2 ? 1 : -1),
    }),
  );
  await server.db.call('ingest', run.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content } },
    complete: true,
  });
  const methods = ['ema', 'twema', 'gaussian', 'running'];
  const panels = [];
  for (const [axis, xAxis] of [
    ['step', '_step'],
    ['custom', 'global_step'],
    ['time', '_timestamp'],
  ])
    for (const method of methods)
      panels.push({
        id: `${axis}-${method}`,
        plugin: 'line',
        metric: 'loss',
        metrics: ['loss'],
        title: `${axis} ${method}`,
        section: axis,
        settings: { xAxis, smoothingMethod: method },
      });
  const view = await server.tools.execute('view_create', {
    project: 'test/smoothing',
    name: 'Smoothing',
    body: {
      generation: 'manual',
      panels,
      sections: ['step', 'custom', 'time'].map((id) => ({ id, name: id })),
      sectionLayouts: Object.fromEntries(
        ['step', 'custom', 'time'].map((id) => [id, { width: 340, height: 240, rows: 2 }]),
      ),
      visible: [run.id],
      solo: [],
    },
  });
  const base = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/test/smoothing/workspace?view=' + view.id);

  // Smoothed values come from the model; original values remain in the inspector only.
  async function traces(id) {
    const chart = page.locator(`[data-panel-id="${id}"] [_echarts_instance_]`);
    await expect(chart.locator('canvas').first()).toBeVisible();
    return chart.evaluate(async (host) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
      const mod = await import(url),
        instance = Object.values(mod)
          .find((v) => v?.getInstanceByDom)
          .getInstanceByDom(host);
      const series = instance.getOption().series.find((s) => s.randlKey);
      return { smoothed: series.data, hasOriginalMetadata: 'randlOriginal' in series };
    });
  }
  const roughness = (points) =>
    points.slice(1).reduce((sum, p, i) => sum + Math.abs(p[1] - points[i][1]), 0);
  const results = {};
  for (const panel of panels) {
    await page.locator(`[data-panel-id="${panel.id}"]`).scrollIntoViewIfNeeded();
    const { smoothed, hasOriginalMetadata } = await traces(panel.id);
    assert.equal(hasOriginalMetadata, false, 'ECharts must not clone inspector originals');
    const original = content.map((line) => {
      const row = JSON.parse(line);
      return [row._step, row.loss];
    });
    const host = page.locator(`[data-panel-id="${panel.id}"] [_echarts_instance_]`);
    await host.focus();
    await host.press('End');
    const last = original.at(-1)[1];
    const expected = new Intl.NumberFormat('en-US', {
      maximumFractionDigits: Math.max(
        1,
        Math.min(6, 7 - (Math.abs(last) >= 1 ? Math.floor(Math.log10(Math.abs(last))) + 1 : 0)),
      ),
    }).format(last);
    await expect(
      page.locator('.plot-inspector[data-local="true"]:not([hidden]) [data-label="Original"]'),
    ).toHaveText(expected);
    await host.press('Escape');
    assert.ok(original?.length > 100, panel.id);
    assert.equal(smoothed.length, original.length);
    const ratio = roughness(smoothed) / roughness(original);
    results[panel.id] = Number(ratio.toFixed(3));
    assert.ok(ratio < 0.5, `${panel.id} smooths visibly at its default (${ratio})`);
  }
  checks.push(
    'every method visibly smooths at its default on 1e7 steps, a custom X near 1e9 and wall time',
  );

  // The editor offers each method's range and default and remembers chosen values.
  await page.locator('main').evaluate((main) => (main.scrollTop = 0));
  const first = page.locator('[data-panel-id="step-ema"]');
  await first.hover();
  await first.getByRole('button', { name: 'Panel settings', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  await editor.getByRole('tab', { name: 'Smoothing', exact: true }).click();
  const method = editor.getByRole('combobox', { name: 'Smoothing method', exact: true });
  const slider = (name) => editor.getByRole('spinbutton', { name, exact: true });
  const range = async (name) =>
    slider(name).evaluate((input) => [Number(input.min), Number(input.max), Number(input.step)]);
  await expect(slider('Weight')).toHaveValue('0.6');
  assert.deepEqual(await range('Weight'), [0, 0.99, 0.01]);
  await method.selectOption('twema');
  await expect(slider('Weight')).toHaveValue('0.6');
  assert.deepEqual(await range('Weight'), [0, 0.99, 0.01]);
  await slider('Weight').fill('0.9');
  await slider('Weight').press('Tab');
  await method.selectOption('gaussian');
  await expect(slider('Standard deviation (points)')).toHaveValue('3');
  assert.deepEqual(await range('Standard deviation (points)'), [0.5, 50, 0.5]);
  await method.selectOption('running');
  await expect(slider('Window (points)')).toHaveValue('10');
  assert.deepEqual(await range('Window (points)'), [1, 500, 1]);
  await method.selectOption('twema');
  await expect(slider('Weight')).toHaveValue('0.9');
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () => {
      const stored = await server.tools.execute('view_get', { id: view.id });
      return stored.body.panels.find((p) => p.id === 'step-ema').settings;
    })
    .toMatchObject({ smoothingMethod: 'twema', smoothingValue: 0.9 });
  checks.push('editor ranges and defaults per method; a chosen value returns when switching back');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, roughnessRatios: results, errors }, null, 2));
} catch (error) {
  console.error({ checks });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
