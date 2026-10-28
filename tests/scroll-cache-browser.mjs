import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect, request } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';

// Panels scrolled back into view reuse stored responses; live updates still refresh them.
// npm run build
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/scroll-cache-browser.mjs
const expect = playwrightExpect.configure({ timeout: 15000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-scroll-cache-'));
let backend, api, browser;
// 1×1 PNG.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

try {
  backend = await createServer(directory);
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const baseURL = `http://127.0.0.1:${backend.app.server.address().port}`;
  // Requests that reach the server, whatever the browser reports about its caches.
  const hits = [];
  backend.app.server.on('request', (req) => hits.push(req.url.split('?')[0]));
  const count = (path, from = 0) => hits.slice(from).filter((url) => url === path).length;
  api = await request.newContext({ baseURL });
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await api.fetch(path, { method, data: body });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const entity = 'browser-scroll',
    project = 'cache',
    scope = entity + '/' + project,
    metrics = Array.from({ length: 24 }, (_, i) => 'metric/' + String(i).padStart(2, '0'));
  // Sized so stored responses (about 6 MB) exceed the former 8 MiB accounting.
  const names = Array.from({ length: 16 }, (_, i) => 'r' + String(i).padStart(2, '0')),
    steps = 700;
  const row = (step, value) =>
    JSON.stringify({
      _step: step,
      ...Object.fromEntries(
        metrics.map((m, i) => [m, value ?? Math.sin(step / 50 + i) * 1.234567]),
      ),
    });
  for (const name of names) {
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: { entity, project, name, displayName: name.toUpperCase() },
    });
    await call(`/files/${scope}/${name}/file_stream`, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: steps }, (_, step) => row(step)),
        },
      },
    });
  }
  const upload = await api.fetch(`/upload/${scope}/r00/media/images/sample.png`, {
    method: 'PUT',
    data: png,
    headers: { 'content-type': 'image/png' },
  });
  assert.ok(upload.ok(), await upload.text());
  await call(`/files/${scope}/r00/file_stream`, {
    files: {
      'wandb-history.jsonl': {
        offset: steps,
        content: [
          JSON.stringify({
            _step: steps,
            sample: {
              _type: 'image-file',
              path: 'media/images/sample.png',
              sha256: 'fixture-digest',
              width: 1,
              height: 1,
            },
          }),
        ],
      },
    },
  });
  const view = await call('/api/tools/view_create', { project: scope, name: 'Scroll cache' });
  view.body.visible = names.map((name) => scope + '/' + name);
  view.body.generation = 'manual';
  view.body.sections = [{ id: 'charts', name: 'Charts' }];
  view.body.sectionLayouts = { charts: { width: 360, height: 300, rows: 13 } };
  view.body.panels = [
    { id: 'image', plugin: 'image', metric: 'sample', title: 'Sample', section: 'charts' },
    ...metrics.map((metric, i) => ({
      id: 'panel-' + i,
      plugin: 'line',
      metric,
      metrics: [metric],
      title: metric,
      section: 'charts',
    })),
  ];
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: view.project, version: view.version, body: view.body },
    'PUT',
  );

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    window.scrollTasks = [];
    new PerformanceObserver((list) =>
      window.scrollTasks.push(
        ...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })),
      ),
    ).observe({ type: 'longtask', buffered: true });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const chartBodies = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/chart') chartBodies.push(JSON.parse(r.postData()));
  });
  await page.goto(`${baseURL}/${scope}/workspace?view=${view.id}`);
  await expect(page.locator('[data-panel-id="panel-0"] canvas')).toBeVisible();
  const main = page.locator('main');
  // Every panel stays mounted on one section page; 12 hidden renderers are kept.
  await expect(page.locator('.chart')).toHaveCount(metrics.length + 1);
  // Panels intersecting the scroll area must show their chart, not a loading state.
  // `margin` matches the panels' 100 px viewport margin, within which they load.
  const showing = (margin = 0) =>
    page.evaluate((margin) => {
      const area = document.querySelector('main').getBoundingClientRect();
      return [...document.querySelectorAll('.chart')]
        .filter((chart) => {
          const box = chart.getBoundingClientRect();
          return box.bottom > area.top - margin && box.top < area.bottom + margin;
        })
        .map((chart) => chart.dataset.panelId);
    }, margin);
  const drawn = (id) =>
    page.evaluate((id) => {
      const chart = document.querySelector(`[data-panel-id="${id}"]`);
      if (/Loading/.test(chart.querySelector('.chart-status')?.textContent || '')) return false;
      return id === 'image'
        ? chart.querySelector('img')?.naturalWidth > 0
        : !!chart.querySelector('canvas');
    }, id);
  const settle = async () => {
    for (const id of await showing()) await expect.poll(() => drawn(id)).toBe(true);
  };
  const height = await main.evaluate((element) => element.scrollHeight - element.clientHeight);
  assert.ok(height > 2000, `workspace scrolls ${height}px`);
  const positions = [];
  for (let y = 0; y < height; y += 400) positions.push(y);
  positions.push(height, ...positions.slice().reverse());
  const scrollThrough = async (list) => {
    for (const y of list) {
      await main.evaluate((element, y) => element.scrollTo(0, y), y);
      await page.waitForTimeout(40);
      await settle();
    }
  };
  const scrollCycle = () => scrollThrough(positions);
  const quiet = async () => {
    let before;
    do {
      before = hits.length;
      await page.waitForTimeout(400);
    } while (hits.length !== before);
  };

  await scrollCycle();
  await quiet();
  const loaded = hits.length;
  // More than twelve panels leave the viewport after the first ones, which are disposed.
  await scrollThrough(positions.slice(0, positions.length / 2 + 1));
  await expect(page.locator('[data-panel-id="panel-0"] canvas')).toHaveCount(0);
  await expect(page.locator('[data-panel-id="panel-12"] canvas').first()).toBeAttached();
  await scrollThrough(positions.slice(positions.length / 2));
  await scrollCycle();
  // Count actual option updates, including newly mounted renderers. Separate rAF
  // callbacks can still bunch into one browser task and exceed the scroll budget.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/assets\/engine-[^/]+\.js/.test(name));
    const engine = Object.values(await import(url)).find((value) => value?.getInstanceByDom);
    const chart = engine.getInstanceByDom(
      document.querySelector('[data-panel-id] [_echarts_instance_]'),
    );
    const prototype = Object.getPrototypeOf(chart),
      setOption = prototype.setOption;
    window.scrollUpdates = [];
    prototype.setOption = function (...args) {
      window.scrollUpdates.push(document.timeline.currentTime);
      return setOption.apply(this, args);
    };
    window.restoreScrollProbe = () => (prototype.setOption = setOption);
  });
  const cycleStart = await page.evaluate(() => performance.now());
  await scrollCycle();
  await quiet();
  const longTasks = await page.evaluate(
    (start) =>
      window.scrollTasks
        .filter((task) => task.start >= start)
        .reduce((sum, task) => sum + task.duration, 0),
    cycleStart,
  );
  assert.ok(longTasks <= 50, `warm scroll long tasks: ${longTasks} ms`);
  const updates = await page.evaluate(() => {
    window.restoreScrollProbe();
    return window.scrollUpdates;
  });
  assert.ok(updates.length > 0, 'warm scrolling exercises evicted renderer rebuilds');
  assert.equal(new Set(updates).size, updates.length, 'chart rebuilds yield between frames');
  assert.deepEqual(
    {
      chart: count('/api/chart', loaded),
      media: count('/api/media', loaded),
      preview: count('/api/run-file-preview', loaded),
    },
    { chart: 0, media: 0, preview: 0 },
    'unchanged panels redraw from stored responses',
  );

  // A live update refreshes visible panels with a delta against the stored response.
  const visible = (await showing(100)).filter((id) => id !== 'image'),
    beforeUpdate = hits.length,
    bodiesBefore = chartBodies.length;
  await call(`/files/${scope}/r00/file_stream`, {
    files: { 'wandb-history.jsonl': { offset: steps + 1, content: [row(steps + 1, 9876)] } },
  });
  await expect.poll(() => count('/api/chart', beforeUpdate)).toBeGreaterThanOrEqual(visible.length);
  await quiet();
  const refreshed = chartBodies.slice(bodiesBefore);
  assert.equal(refreshed.length, visible.length, 'only visible panels refresh at once');
  assert.ok(
    refreshed.every((body) => body.baseRevision),
    'refresh requests a delta',
  );
  assert.deepEqual(
    refreshed.map((body) => body.metrics[0]).sort(),
    visible.map((id) => metrics[Number(id.slice(6))]).sort(),
  );
  const first = page.locator(`[data-panel-id="${visible[0]}"]`);
  await first.hover();
  await first.getByRole('button', { name: 'Panel actions' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Export chart data (CSV)' }).click(),
  ]);
  assert.match(await readFile(await download.path(), 'utf8'), new RegExp(`,${steps + 1},9876\\n`));

  // Panels that were off screen refresh once when they return, then redraw from storage.
  const afterUpdate = hits.length;
  await scrollCycle();
  await quiet();
  const offscreen = metrics.length - visible.length;
  assert.equal(count('/api/chart', afterUpdate), offscreen, 'each off-screen chart refreshes once');
  assert.equal(count('/api/media', beforeUpdate), 1, 'the media panel refreshes once');
  assert.equal(count('/api/run-file-preview', beforeUpdate), 0, 'unchanged media is reused');
  const settled = hits.length;
  await scrollCycle();
  await quiet();
  assert.equal(count('/api/chart', settled) + count('/api/media', settled), 0);

  // Renderers kept for hidden panels are disposed with the workspace.
  await scrollThrough(positions.slice(0, positions.length / 2 + 1));
  const kept = await page.locator('[data-panel-id] [_echarts_instance_]').count();
  assert.ok(kept > (await showing()).length, `hidden panels keep renderers (${kept})`);
  await page
    .getByRole('navigation', { name: 'Project pages', exact: true })
    .getByRole('button', { name: 'Overview', exact: true })
    .click();
  await expect(page.locator('[data-panel-id]')).toHaveCount(0);
  await expect(page.locator('.overview-chart').first()).toBeVisible();
  await expect(
    page.locator('[_echarts_instance_]:not([_echarts_instance_=""]):not(.overview-chart)'),
  ).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('[data-panel-id] canvas').first()).toBeVisible();
  await settle();
  await quiet();
  assert.equal(count('/api/chart', settled), 0, 'returning draws stored responses');
  assert.deepEqual(errors, []);
  console.log(
    `PASS scroll cache: 0 requests across two scroll cycles; ${longTasks} ms warm long tasks; ${updates.length} rebuilds in separate frames; live update refreshed ${visible.length} visible panels, then ${offscreen} off-screen panels once each; ${kept} kept renderers released on leaving`,
  );
} finally {
  await browser?.close();
  await api?.dispose();
  await backend?.app.close();
  await rm(directory, { recursive: true, force: true });
}
