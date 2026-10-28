import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect, request } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';

// Drag-to-zoom on X, click to reset, minimum drag, refinement requests and hover after zoom.
// npm run build
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/drag-zoom-browser.mjs
const expect = playwrightExpect.configure({ timeout: 15000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-drag-zoom-'));
let backend, api, browser;
const checked = [];

try {
  backend = await createServer(directory);
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  // Chart response bodies as sent, streamed or not.
  const sent = [];
  backend.app.server.on('request', (req, res) => {
    if (req.url !== '/api/chart') return;
    const chunks = [],
      write = res.write.bind(res),
      end = res.end.bind(res);
    res.write = (chunk, ...rest) => {
      chunks.push(Buffer.from(chunk));
      return write(chunk, ...rest);
    };
    res.end = (chunk, ...rest) => {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
      sent.push(Buffer.concat(chunks).toString());
      return end(chunk, ...rest);
    };
  });
  const baseURL = `http://127.0.0.1:${backend.app.server.address().port}`;
  api = await request.newContext({ baseURL });
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await api.fetch(path, { method, data: body });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const entity = 'browser-zoom',
    project = 'fixture',
    scope = entity + '/' + project,
    steps = 20000;
  // Large values before step 10,000 and small ones after, so Y must refit when zoomed.
  const loss = (step, run) =>
    step < 10000 ? 100 + Math.sin(step / 40) : 1 + 0.1 * Math.sin(step / 7 + run);
  for (const [run, name] of ['a', 'b'].entries()) {
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: { entity, project, name },
    });
    for (let offset = 0; offset < steps; offset += 5000)
      await call(`/files/${scope}/${name}/file_stream`, {
        files: {
          'wandb-history.jsonl': {
            offset,
            content: Array.from({ length: 5000 }, (_, i) =>
              JSON.stringify({
                _step: offset + i,
                loss: loss(offset + i, run),
                share: 1 + run + Math.cos((offset + i) / 300),
              }),
            ),
          },
        },
      });
  }
  const view = await call('/api/tools/view_create', { project: scope, name: 'Zoom' });
  view.body.visible = ['a', 'b'].map((name) => scope + '/' + name);
  view.body.generation = 'manual';
  view.body.sections = [{ id: 'charts', name: 'Charts' }];
  view.body.sectionLayouts = { charts: { width: 600, height: 340, rows: 1 } };
  view.body.panels = [
    { id: 'line', plugin: 'line', metric: 'loss', metrics: ['loss'], title: 'Loss' },
    {
      id: 'stacked',
      plugin: 'stacked-area',
      metric: 'share',
      metrics: ['share'],
      title: 'Share',
    },
  ].map((panel) => ({ ...panel, section: 'charts', settings: { smoothingMethod: 'none' } }));
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: view.project, version: view.version, body: view.body },
    'PUT',
  );

  const before = await call('/api/views/' + view.id);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [],
    charts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/chart') charts.push(JSON.parse(r.postData()));
  });
  await page.goto(`${baseURL}/${scope}/workspace?view=${view.id}`);
  const ready = async (id) => {
    const panel = page.locator(`[data-panel-id="${id}"]`);
    await expect(panel.locator('canvas').first()).toBeVisible();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect(panel.locator('.chart-status')).toHaveCount(0);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  // Axis extents and the plot rectangle in page coordinates, read from ECharts.
  const inspect = (id) =>
    page.evaluate(async (id) => {
      const engineURL = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => /\/assets\/engine-[^/]+\.js(?:\?|$)/.test(name));
      const module = await import(engineURL);
      const echarts = Object.values(module).find(
        (value) => value && typeof value.getInstanceByDom === 'function',
      );
      const panel = document.querySelector(`[data-panel-id="${id}"]`);
      const host = [...panel.querySelectorAll('[_echarts_instance_]')].find((element) =>
        echarts.getInstanceByDom(element),
      );
      const chart = echarts.getInstanceByDom(host),
        model = chart.getModel(),
        rect = model.getComponent('grid', 0).coordinateSystem.getRect(),
        box = host.getBoundingClientRect();
      return {
        x: model.getComponent('xAxis', 0).axis.scale.getExtent(),
        y: model.getComponent('yAxis', 0).axis.scale.getExtent(),
        left: box.left + rect.x,
        top: box.top + rect.y,
        width: rect.width,
        height: rect.height,
      };
    }, id);
  const pixelX = (id, value) =>
    page.evaluate(
      async ({ id, value }) => {
        const engineURL = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => /\/assets\/engine-[^/]+\.js(?:\?|$)/.test(name));
        const echarts = Object.values(await import(engineURL)).find(
          (v) => v && typeof v.getInstanceByDom === 'function',
        );
        const host = [
          ...document.querySelectorAll(`[data-panel-id="${id}"] [_echarts_instance_]`),
        ].find((element) => echarts.getInstanceByDom(element));
        return (
          host.getBoundingClientRect().left +
          echarts.getInstanceByDom(host).convertToPixel({ xAxisIndex: 0 }, value)
        );
      },
      { id, value },
    );
  const quiet = async () => {
    let before;
    do {
      before = charts.length;
      await page.waitForTimeout(400);
    } while (charts.length !== before);
  };
  for (const id of ['line', 'stacked']) await ready(id);
  await quiet();
  const reset = (id) => page.locator(`[data-panel-id="${id}"] .chart-reset`);
  const popup = page.locator('.plot-inspector[data-local="true"]:visible');
  const full = await inspect('line');
  assert.ok(full.y[1] >= 100, `unzoomed Y reaches the early values (${full.y})`);
  const middle = full.top + full.height / 2;

  // A drag shorter than the minimum is a click: no zoom and no request.
  let from = charts.length;
  const start = await pixelX('line', 12000);
  await page.mouse.move(start, middle);
  await page.mouse.down();
  await page.mouse.move(start + 3, middle, { steps: 2 });
  await page.mouse.up();
  await quiet();
  await expect(reset('line')).toHaveCount(0);
  assert.equal(charts.length, from, 'a 3 px drag neither zooms nor requests');
  checked.push('a 3 px drag is a click: no zoom, no request');

  // Hover shows values; a drag hides them and draws a full-height band.
  await page.mouse.move(start + 20, middle);
  await expect(popup).toHaveCount(1);
  const end = await pixelX('line', 18000);
  await page.mouse.move(start, middle);
  await expect(popup).toHaveCount(1);
  await page.mouse.down();
  await page.mouse.move((start + end) / 2, middle, { steps: 4 });
  const band = page.locator('[data-panel-id="line"] .chart-zoom-band');
  await expect(band).toBeVisible();
  await expect(popup).toHaveCount(0);
  const bandBox = await band.boundingBox();
  assert.ok(Math.abs(bandBox.height - full.height) <= 1, 'the band spans the plot height');
  assert.ok(Math.abs(bandBox.x - start) <= 2, 'the band starts where the drag began');
  from = charts.length;
  const sentBefore = sent.length;
  await page.mouse.move(end, middle, { steps: 4 });
  await page.mouse.up();
  await expect(band).toBeHidden();
  await expect(reset('line')).toBeVisible();
  await ready('line');
  await quiet();
  const zoomed = await inspect('line');
  assert.ok(
    Math.abs(zoomed.x[0] - 12000) < 40 && Math.abs(zoomed.x[1] - 18000) < 40,
    `X zooms to the band (${zoomed.x})`,
  );
  assert.ok(zoomed.y[1] < 5, `Y fits the visible values (${zoomed.y})`);
  const refinements = charts.slice(from);
  assert.equal(refinements.length, 1, 'one request for the zoomed range');
  assert.ok(refinements[0].baseRevision, 'the zoomed range is diffed against drawn points');
  assert.ok(Math.abs(refinements[0].settings.xMin - 12000) < 40);
  const changes = sent
    .slice(sentBefore)
    .flatMap((text) => text.split('\n').filter(Boolean))
    .flatMap((line) => JSON.parse(line).changed || []);
  assert.ok(changes.length, 'the zoomed range arrives as a delta');
  assert.ok(
    changes.every((change) => !change.replace && !change.metrics.loss.remove.length),
    'zooming in only adds points',
  );
  const added = changes.reduce((sum, change) => sum + change.metrics.loss.upsert.length, 0);
  checked.push(
    `drag zoom: X ${zoomed.x.map(Math.round).join('–')}, Y ${zoomed.y.map((v) => v.toFixed(2)).join('–')}; one request adding ${added} points`,
  );

  // The zoom is this tab's state: the saved view and its panel settings are unchanged.
  const saved = await call('/api/views/' + view.id);
  assert.equal(saved.version, before.version, 'zooming saves nothing');
  assert.deepEqual(saved.body.panels.find((panel) => panel.id === 'line').settings, {
    smoothingMethod: 'none',
  });
  checked.push('zoom is not saved to the view');

  // Hover still reads values after zooming.
  await page.mouse.move((start + end) / 2, middle);
  await expect(popup).toHaveCount(1);
  checked.push('hover values after zoom');

  // A click inside the plot resets the zoom from stored points.
  from = charts.length;
  await page.mouse.click((start + end) / 2, middle);
  await expect(reset('line')).toHaveCount(0);
  await ready('line');
  await quiet();
  assert.equal(charts.length, from, 'reset needs no request');
  const restored = await inspect('line');
  assert.ok(restored.x[0] <= 0 && restored.x[1] >= 19999, `X restored (${restored.x})`);
  checked.push('click resets without a request');

  // Touch: a swipe scrolls rather than selecting; a long press then a drag zooms.
  const touch = (type, x, y) =>
    page.evaluate(
      ({ type, x, y }) => {
        const target = document.elementFromPoint(x, y);
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: x,
            clientY: y,
          }),
        );
      },
      { type, x, y },
    );
  await touch('pointerdown', start, middle);
  await touch('pointermove', start + 60, middle);
  await touch('pointerup', start + 60, middle);
  await page.waitForTimeout(600);
  await expect(reset('line')).toHaveCount(0);
  await touch('pointerdown', start, middle);
  await page.waitForTimeout(600);
  await expect(band).toBeVisible();
  await touch('pointermove', end, middle);
  await touch('pointerup', end, middle);
  await expect(reset('line')).toBeVisible();
  await reset('line').click();
  await expect(reset('line')).toHaveCount(0);
  checked.push('touch: a swipe does not select; long press and drag zooms');

  // Stacked areas zoom the same way, also in full screen.
  const stacked = page.locator('[data-panel-id="stacked"]');
  await stacked.hover();
  await stacked.locator('.chart-expand').click();
  await expect(page.locator('[data-panel-id="stacked"].fullscreen')).toBeVisible();
  await ready('stacked');
  const box = await inspect('stacked');
  const a = await pixelX('stacked', 4000),
    b = await pixelX('stacked', 8000),
    y = box.top + box.height / 2;
  await page.mouse.move(a, y);
  await page.mouse.down();
  await page.mouse.move(b, y, { steps: 6 });
  await page.mouse.up();
  await expect(reset('stacked')).toBeVisible();
  await ready('stacked');
  const stackedZoom = await inspect('stacked');
  assert.ok(
    Math.abs(stackedZoom.x[0] - 4000) < 40 && Math.abs(stackedZoom.x[1] - 8000) < 40,
    `stacked X zooms (${stackedZoom.x})`,
  );
  await reset('stacked').click();
  await expect(reset('stacked')).toHaveCount(0);
  await page.keyboard.press('Escape');
  checked.push('stacked area zooms in full screen; Reset zoom restores it');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: checked }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ completedChecks: checked }));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await api?.dispose();
  await backend?.app.close();
  await rm(directory, { recursive: true, force: true });
}
