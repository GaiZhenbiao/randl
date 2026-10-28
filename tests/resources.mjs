import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect as playwrightExpect, request } from '@playwright/test';
import { demoURL, launchBrowser } from './helpers.mjs';

// Use a separate seeded server. This test creates and deletes only its own view.
// RANDL_URL=http://127.0.0.1:8744 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:resources
const expect = playwrightExpect.configure({ timeout: 10000 });
const baseURL = demoURL();
const cycles = Number(process.env.RANDL_RESOURCE_CYCLES || 6);
assert.ok(Number.isInteger(cycles) && cycles >= 2 && cycles <= 12, 'Use 2–12 resource cycles');
const api = await request.newContext({
  baseURL,
  extraHTTPHeaders: process.env.RANDL_API_KEY
    ? { Authorization: 'Bearer ' + process.env.RANDL_API_KEY }
    : {},
});
async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await api.fetch(path, { method, data: body });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

let browser;
let view, gridView;
try {
  if (process.env.RANDL_API_KEY) await call('/api/auth/login', { key: process.env.RANDL_API_KEY });
  const runs = (await call('/api/runs')).runs;
  const counts = new Map();
  for (const run of runs) {
    const project = run.entity + '/' + run.project;
    counts.set(project, (counts.get(project) || 0) + 1);
  }
  const project =
    process.env.RANDL_RESOURCE_PROJECT ||
    [...counts].filter(([name]) => name.startsWith('demo/')).sort((a, b) => b[1] - a[1])[0]?.[0];
  assert.ok(
    project && counts.has(project),
    'Seed a synthetic demo project, or name an isolated fixture with RANDL_RESOURCE_PROJECT',
  );
  const selected = runs.filter((run) => run.entity + '/' + run.project === project).slice(0, 8);
  assert.equal(selected.length, 8, 'The resource fixture requires at least eight runs');
  const catalog = await call('/api/metrics', { runs: selected.map((run) => run.id) });
  const metrics = catalog.metrics
    .filter((key) => !key.startsWith('system/') && catalog.kinds[key]?.includes('scalar'))
    .slice(0, 8);
  assert.ok(metrics.length, 'The fixture requires scalar history');
  const sections = [
    { id: 'resource-a', name: 'Resource section A' },
    { id: 'resource-b', name: 'Resource section B' },
  ];
  view = await call('/api/tools/view_create', {
    project,
    name: 'Resource verification ' + randomUUID(),
  });
  view.body.visible = selected.map((run) => run.id);
  view.body.sections = sections;
  view.body.sectionLayouts = Object.fromEntries(
    sections.map((section) => [section.id, { width: 360, height: 250, rows: 1 }]),
  );
  view.body.panels = Array.from({ length: 32 }, (_, index) => ({
    id: 'resource-' + index,
    title: 'Resource panel ' + String(index + 1).padStart(2, '0'),
    section: sections[Math.floor(index / 16)].id,
    plugin: 'line',
    metric: metrics[index % metrics.length],
  }));
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: view.project, version: view.version, body: view.body },
    'PUT',
  );

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: await api.storageState(),
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [],
    consoleErrors = [],
    failedResponses = [];
  const pending = new Set(),
    uniqueQueries = new Set(),
    visitedPanels = new Set();
  let totalRequests = 0,
    maxActive = 0,
    abortedRequests = 0,
    maxDeclaredResponseBytes = 0;
  let maxCanvases = 0,
    maxMountedPanels = 0,
    maxMountedChartHosts = 0,
    maxCanvasRGBAEstimate = 0;
  const metricsRequests = [],
    sinceValues = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname !== '/api/server/metrics') return;
    metricsRequests.push(Date.now());
    sinceValues.push(url.searchParams.get('since'));
  });
  const isChartRequest = (req) =>
    ['/api/chart', '/api/media'].includes(new URL(req.url()).pathname);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('request', (req) => {
    if (!isChartRequest(req)) return;
    pending.add(req);
    totalRequests++;
    maxActive = Math.max(maxActive, pending.size);
    const body = req.postDataJSON();
    delete body.baseRevision;
    uniqueQueries.add(JSON.stringify([new URL(req.url()).pathname, body]));
  });
  page.on('requestfinished', (req) => pending.delete(req));
  page.on('requestfailed', (req) => {
    if (pending.delete(req)) abortedRequests++;
  });
  page.on('response', (response) => {
    if (!isChartRequest(response.request())) return;
    if (!response.ok())
      failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
    maxDeclaredResponseBytes = Math.max(
      maxDeclaredResponseBytes,
      Number(response.headers()['content-length']) || 0,
    );
  });

  async function settleCharts() {
    await expect.poll(() => pending.size).toBe(0);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }

  async function inspectMounted() {
    const value = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-panel-id]').length;
      const canvases = [...document.querySelectorAll('canvas')];
      const area = document.querySelector('main').getBoundingClientRect();
      const showingCards = [...document.querySelectorAll('[data-panel-id]')].filter((node) => {
        const box = node.getBoundingClientRect();
        return box.bottom > area.top - 100 && box.top < area.bottom + 100;
      }).length;
      const plotRGBA = [...document.querySelectorAll('.chart-canvas')].reduce((sum, node) => {
        const box = node.getBoundingClientRect();
        return sum + box.width * box.height * Math.min(devicePixelRatio, 2) ** 2 * 4;
      }, 0);
      return {
        cards,
        showingCards,
        plotRGBA,
        canvases: canvases.length,
        chartHosts: document.querySelectorAll('[_echarts_instance_]:not([_echarts_instance_=""])')
          .length,
        rgbaEstimate: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0),
      };
    });
    maxCanvases = Math.max(maxCanvases, value.canvases);
    maxMountedPanels = Math.max(maxMountedPanels, value.cards);
    maxMountedChartHosts = Math.max(maxMountedChartHosts, value.chartHosts);
    maxCanvasRGBAEstimate = Math.max(maxCanvasRGBAEstimate, value.rgbaEstimate);
    assert.ok(
      value.cards <= 12,
      `Pagination mounted ${value.cards} cards for two one-row sections`,
    );
    assert.ok(
      value.chartHosts <= value.cards,
      `Mounted charts ${value.chartHosts} exceed cards ${value.cards}`,
    );
    assert.ok(value.chartHosts <= value.showingCards + 12, 'hidden renderer count is bounded');
    assert.ok(
      value.rgbaEstimate <= value.plotRGBA * 1.25,
      'canvas backing fits mounted plot geometry',
    );
    assert.ok(
      value.canvases <= value.cards * 2,
      `Mounted canvases ${value.canvases} exceed two per card`,
    );
    return value;
  }

  async function memorySample(phase, cycle) {
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    return {
      phase,
      cycle,
      jsHeapUsedBytes: heap.usedSize,
      jsHeapAllocatedBytes: heap.totalSize,
      ...(heap.embedderHeapUsedSize === undefined
        ? {}
        : { embedderHeapUsedBytes: heap.embedderHeapUsedSize }),
      ...(heap.backingStorageSize === undefined
        ? {}
        : { backingStorageBytes: heap.backingStorageSize }),
      dom,
    };
  }

  async function visitSection(section, cycle) {
    const region = page.locator(`[data-section-id="${section.id}"]`);
    await region.scrollIntoViewIfNeeded();
    const previous = region.getByRole('button', {
      name: 'Previous panels in ' + section.name,
      exact: true,
    });
    const next = region.getByRole('button', {
      name: 'Next panels in ' + section.name,
      exact: true,
    });
    while (await previous.isEnabled()) await previous.click();
    let pages = 0;
    while (true) {
      await expect(region.locator('canvas').first()).toBeVisible();
      await settleCharts();
      const ids = await region
        .locator('[data-panel-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.panelId));
      ids.forEach((id) => visitedPanels.add(id));
      const label = (await region.locator('.section-page').innerText()).match(/(\d+)\D+(\d+)/);
      assert.ok(label, 'Pagination must describe the displayed range');
      assert.equal(ids.length, Number(label[2]) - Number(label[1]) + 1);
      assert.equal(Number(await region.locator('.section-count').innerText()), 16);
      await inspectMounted();
      const plot = region.locator('[_echarts_instance_]').first();
      const box = await plot.boundingBox();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      await expect(page.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
      pages++;
      assert.ok(pages <= 16, 'Section pagination failed to make progress');
      if (await next.isDisabled()) break;
      const marker = `${cycle}-${section.id}-${pages}`;
      await region
        .locator('canvas')
        .evaluateAll(
          (nodes, token) => nodes.forEach((node) => (node.dataset.resourcePage = token)),
          marker,
        );
      await next.click();
      await expect
        .poll(() =>
          region
            .locator('[data-panel-id]')
            .evaluateAll((nodes) => nodes.map((node) => node.dataset.panelId)),
        )
        .not.toEqual(ids);
      await expect(page.locator(`canvas[data-resource-page="${marker}"]`)).toHaveCount(0);
    }
    return pages;
  }

  let overviewChartHosts = [];
  // Leaving the overview disposes its charts: the hosts leave the document and ECharts
  // clears its instance marker on dispose.
  async function overviewChartsReleased() {
    await expect(page.locator('.overview-chart')).toHaveCount(0);
    for (const host of overviewChartHosts)
      assert.deepEqual(
        await host.evaluate((node) => [
          node.isConnected,
          node.getAttribute('_echarts_instance_') || '',
        ]),
        [false, ''],
        'An overview chart was not disposed',
      );
    for (const host of overviewChartHosts) await host.dispose();
    overviewChartHosts = [];
  }
  const start = performance.now();
  await page.goto(
    baseURL +
      '/' +
      project.split('/').map(encodeURIComponent).join('/') +
      '/workspace?view=' +
      view.id,
  );
  await page.locator('canvas').first().waitFor();
  const firstCanvasMs = Math.round(performance.now() - start);
  await settleCharts();
  const initialWorkspace = await memorySample('initial workspace; cache not fully warm', 0);
  const overviews = [],
    pageVisits = [];
  let requestsAfterWarmup;
  for (let cycle = 0; cycle < cycles; cycle++) {
    await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', view.id);
    const pages = [];
    for (const section of sections)
      pages.push({ section: section.id, pages: await visitSection(section, cycle) });
    pageVisits.push({ cycle, sections: pages });
    assert.equal(
      visitedPanels.size,
      32,
      'Every panel must remain reachable through section pagination',
    );
    await page
      .getByRole('navigation', { name: 'Project pages', exact: true })
      .getByRole('button', { name: 'Overview', exact: true })
      .click();
    // Workspace panels are gone; only the overview's own summary charts remain.
    await expect(page.locator('[data-panel-id]')).toHaveCount(0);
    await expect(page.locator('.plot-inspector')).toHaveCount(0);
    await expect(page.locator('.plot-inspector-cursor')).toHaveCount(0);
    const overviewHosts = page.locator('.overview-chart');
    await expect(overviewHosts.first()).toBeVisible();
    // The project overview draws two summary bars (run states and storage).
    await expect(page.getByRole('img', { name: 'Storage', exact: true })).toBeVisible();
    const overviewCharts = await overviewHosts.count();
    assert.ok(overviewCharts <= 2, `Overview mounted ${overviewCharts} summary charts`);
    assert.equal(metricsRequests.length, 0, 'The project overview does not poll server metrics');
    await expect(
      page.locator('.overview-chart[_echarts_instance_]:not([_echarts_instance_=""])'),
    ).toHaveCount(overviewCharts);
    await expect(page.locator('[_echarts_instance_]:not([_echarts_instance_=""])')).toHaveCount(
      overviewCharts,
    );
    assert.equal(
      await page.locator('canvas').count(),
      await page.locator('.overview-chart canvas').count(),
      'Every canvas on the overview belongs to a summary chart',
    );
    assert.ok(
      (await page.locator('canvas').count()) <= overviewCharts,
      'One canvas per overview chart',
    );
    overviewChartHosts = await overviewHosts.elementHandles();
    await settleCharts();
    overviews.push(
      await memorySample('overview after full pagination; overview summary charts only', cycle),
    );
    if (cycle === 0) requestsAfterWarmup = totalRequests;
    if (cycle + 1 < cycles) {
      await page
        .getByRole('navigation', { name: 'Project pages', exact: true })
        .getByRole('button', { name: 'Workspace', exact: true })
        .click();
      await expect(page.locator('[data-panel-id]').first()).toBeVisible();
      await overviewChartsReleased();
    }
  }
  // A grid panel of every project run (up to 1,000 cells): scrolling top to bottom and back
  // keeps mounted renderers and canvases bounded and returns the heap and DOM to baseline.
  const gridRuns = runs.filter((run) => run.entity + '/' + run.project === project).slice(0, 1000);
  gridView = await call('/api/tools/view_create', {
    project,
    name: 'Resource grid ' + randomUUID(),
  });
  gridView.body.visible = gridRuns.map((run) => run.id);
  gridView.body.sections = [{ id: 'grid', name: 'Grid' }];
  gridView.body.panels = [
    {
      id: 'resource-grid',
      title: 'Resource grid',
      section: 'grid',
      plugin: 'line',
      metric: metrics[0],
      settings: { layout: 'grid', itemSize: 200 },
    },
  ];
  await call(
    '/api/views/' + gridView.id,
    {
      name: gridView.name,
      project: gridView.project,
      version: gridView.version,
      body: gridView.body,
    },
    'PUT',
  );
  await page.goto(
    baseURL +
      '/' +
      project.split('/').map(encodeURIComponent).join('/') +
      '/workspace?view=' +
      gridView.id,
  );
  const gridPanel = page.locator('[data-panel-id="resource-grid"]');
  await gridPanel.hover();
  await gridPanel.getByRole('button', { name: 'Expand panel', exact: true }).click();
  await expect(gridPanel.locator('.cell-plot canvas').first()).toBeVisible();
  await settleCharts();
  await page.evaluate(() => {
    window.resourceLongTasks = [];
    new PerformanceObserver((list) =>
      window.resourceLongTasks.push(...list.getEntries().map((entry) => entry.duration)),
    ).observe({ type: 'longtask' });
  });
  const gridCounts = () =>
    gridPanel.evaluate((node) => ({
      cells: node.querySelectorAll('[role="gridcell"]').length,
      canvases: node.querySelectorAll('.cell-plot canvas').length,
      scrollTop: node.querySelector('.tile-scroller').scrollTop,
      scrollMax:
        node.querySelector('.tile-scroller').scrollHeight -
        node.querySelector('.tile-scroller').clientHeight,
    }));
  let gridMaxCells = 0,
    gridMaxCanvases = 0;
  const scrollBox = await gridPanel.locator('.tile-scroller').boundingBox();
  await page.mouse.move(scrollBox.x + 8, scrollBox.y + scrollBox.height / 2);
  async function scrollGrid() {
    for (const direction of [1, -1])
      for (let step = 0; step < 400; step++) {
        await page.mouse.wheel(0, direction * 600);
        await page.waitForTimeout(16);
        const counts = await gridCounts();
        gridMaxCells = Math.max(gridMaxCells, counts.cells);
        gridMaxCanvases = Math.max(gridMaxCanvases, counts.canvases);
        assert.ok(counts.cells <= 36, `The grid mounted ${counts.cells} cells`);
        assert.ok(
          counts.canvases <= counts.cells,
          `${counts.canvases} canvases for ${counts.cells} cells`,
        );
        if (direction > 0 ? counts.scrollTop >= counts.scrollMax : counts.scrollTop === 0) break;
      }
    await settleCharts();
  }
  // The first cycle fills the renderer pool and the response cache; the second is measured.
  await scrollGrid();
  const gridBaseline = await memorySample('grid at top after one scroll cycle', 0);
  await scrollGrid();
  const gridReturned = await memorySample('grid back at top after another cycle', 1);
  const gridLongTasks = await page.evaluate(() => window.resourceLongTasks);
  assert.ok(
    gridReturned.jsHeapUsedBytes - gridBaseline.jsHeapUsedBytes <= 10 * 1024 * 1024,
    'A grid scroll cycle keeps the heap within 10 MiB of its baseline',
  );
  for (const counter of ['nodes', 'jsEventListeners'])
    assert.ok(
      Math.abs(gridReturned.dom[counter] - gridBaseline.dom[counter]) <=
        Math.max(50, gridBaseline.dom[counter] * 0.05),
      `${counter} returned to the grid baseline: ${gridBaseline.dom[counter]} → ${gridReturned.dom[counter]}`,
    );
  const gridCycle = {
    cells: gridRuns.length,
    maxMountedCells: gridMaxCells,
    maxCellCanvases: gridMaxCanvases,
    longTasksOver50Ms: gridLongTasks.filter((duration) => duration > 50).length,
    longestTaskMs: Math.max(0, ...gridLongTasks),
    heapBaselineBytes: gridBaseline.jsHeapUsedBytes,
    heapAfterBytes: gridReturned.jsHeapUsedBytes,
    domBaseline: gridBaseline.dom,
    domAfter: gridReturned.dom,
  };
  await page.keyboard.press('Escape');

  // The Server page polls metrics every 10 s, asks only for new minutes, and stops when
  // left; its charts are disposed like the overview's.
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Project pages', exact: true })
    .getByRole('button', { name: 'Server', exact: true })
    .click();
  const serverHosts = page.locator('.overview-chart');
  await expect(page.getByRole('img', { name: 'Requests per minute', exact: true })).toBeVisible();
  const serverCharts = await serverHosts.count();
  assert.ok(serverCharts <= 6, `Server page mounted ${serverCharts} charts`);
  await expect(page.locator('[_echarts_instance_]:not([_echarts_instance_=""])')).toHaveCount(
    serverCharts,
  );
  overviewChartHosts = await serverHosts.elementHandles();
  const onServer = metricsRequests.length;
  await page.waitForTimeout(10_500);
  const serverPolls = metricsRequests.length - onServer;
  assert.ok(
    serverPolls >= 1 && serverPolls <= 2,
    `Server page polled ${serverPolls} times in 10.5 s`,
  );
  assert.ok(
    sinceValues.slice(1).every((value) => Number(value) > 0),
    'Server page polls requested only minutes since its newest bucket',
  );
  await page
    .getByRole('navigation', { name: 'Project pages', exact: true })
    .getByRole('button', { name: 'Projects', exact: true })
    .click();
  await overviewChartsReleased();
  const leftServer = metricsRequests.length;
  await page.waitForTimeout(10_500);
  assert.equal(
    metricsRequests.length,
    leftServer,
    'Server metrics polling continued after leaving the Server page',
  );
  assert.ok(maxActive <= 4, `Chart concurrency ${maxActive}`);
  assert.ok(
    totalRequests <= metrics.length * 2 + 4,
    `Repeated pagination made ${totalRequests} chart requests for ${metrics.length} unique metric inputs`,
  );
  assert.ok(
    totalRequests - requestsAfterWarmup <= metrics.length,
    'Warm navigation repeatedly refetched unchanged data',
  );
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  const backendCacheBytes = (await call('/api/health')).cacheBytes;
  assert.ok(backendCacheBytes <= 16 * 1024 * 1024, 'Backend chart cache exceeded its byte cap');
  const matchedHeaps = overviews.map((sample) => sample.jsHeapUsedBytes);
  assert.ok(
    matchedHeaps.at(-1) - matchedHeaps[0] <= 4 * 1024 * 1024,
    'matched overview heap growth stays within 4 MiB',
  );
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        fixture: 'synthetic',
        projectRuns: counts.get(project),
        selectedRuns: selected.length,
        panels: 32,
        sections: 2,
        configuredRowsPerSection: 1,
        metrics: metrics.length,
        cycles,
        viewport: '1440x900',
        firstCanvasMs,
        maxActiveChartRequests: maxActive,
        totalChartRequests: totalRequests,
        uniqueChartQueries: uniqueQueries.size,
        requestsAfterWarmup: totalRequests - requestsAfterWarmup,
        abortedChartRequests: abortedRequests,
        maxDeclaredResponseBytes,
        visitedPanels: visitedPanels.size,
        maxMountedPanels,
        maxMountedChartHosts,
        maxCanvases,
        serverMetricsPolls: serverPolls,
        maxCanvasRGBAEstimateBytes: maxCanvasRGBAEstimate,
        backendCacheBytes,
        pageVisits,
        gridCycle,
        initialWorkspace,
        matchedOverviewGCSamples: overviews,
        matchedOverviewHeapRangeBytes: Math.max(...matchedHeaps) - Math.min(...matchedHeaps),
        matchedOverviewFinalMinusFirstBytes: matchedHeaps.at(-1) - matchedHeaps[0],
        measurementScope:
          'CDP JavaScript heap and DOM counters only. Canvas RGBA is width*height*4 arithmetic, not measured allocation. No browser RSS, GPU memory, or total-tab memory was measured; this synthetic fixture does not explain hosted W&B memory use.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (view) await call('/api/views/' + view.id, undefined, 'DELETE');
  if (gridView) await call('/api/views/' + gridView.id, undefined, 'DELETE');
  await api.dispose();
}
