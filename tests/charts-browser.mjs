import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect, request } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';
async function pressSectionButton(scope, name) {
  const button = scope.getByRole('button', { name, exact: true });
  await button.locator('xpath=ancestor::div[contains(@class,"section-heading")]').hover();
  await button.click();
}

// Uses built frontend assets and an isolated backend. Fixtures enter through HTTP.
// npm run build
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/charts-browser.mjs
const expect = playwrightExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-chart-browser-'));
let backend, api, browser;
const checked = [];

try {
  backend = await createServer(directory);
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  const baseURL = `http://127.0.0.1:${backend.app.server.address().port}`;
  api = await request.newContext({ baseURL });
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await api.fetch(path, { method, data: body });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    const value = await response.json();
    assert.ok(!value.errors, JSON.stringify(value.errors));
    return value;
  };
  const entity = 'browser-charts',
    project = 'renderer-fixture',
    scope = entity + '/' + project;
  const runs = [
    {
      name: 'a',
      displayName: 'A',
      model: 'small',
      cohort: 'pair',
      lr: 0.001,
      score: 10,
      loss: [1, 3, 5],
      reward: 1,
      progress: [10, null, 30],
    },
    {
      name: 'b',
      displayName: 'B',
      model: 'large',
      cohort: 'pair',
      lr: 0.002,
      score: 20,
      loss: [3, 5, 7],
      reward: 3,
      progress: [20, 40, 60],
    },
    {
      name: 'c',
      displayName: 'C',
      model: 'small',
      cohort: 'other',
      lr: 0.003,
      score: 30,
      loss: [2, 4, 6],
      reward: 6,
      progress: [15, 30, 45],
    },
  ];
  for (const run of runs) {
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: {
        entity,
        project,
        name: run.name,
        displayName: run.displayName,
        config: {
          model: { value: run.model },
          cohort: { value: run.cohort },
          lr: { value: run.lr },
        },
        summaryMetrics: { score: run.score },
      },
    });
    await call(`/files/${scope}/${run.name}/file_stream`, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: run.loss.map((loss, step) =>
            JSON.stringify({
              _step: step,
              loss,
              reward: run.reward,
              epoch: 1000 + step * 10,
              ...(step ? { late: step } : {}),
              ...(step === 2 ? { final: run.score } : {}),
              ...(run.progress[step] === null ? {} : { progress: run.progress[step] }),
            }),
          ),
        },
      },
      complete: true,
      exitcode: 0,
    });
  }
  const panels = [
    {
      id: 'line',
      plugin: 'line',
      metric: 'loss',
      metrics: ['loss'],
      settings: { tooltipColoredNames: true },
    },
    { id: 'area', plugin: 'area', metric: 'loss', metrics: ['loss'] },
    { id: 'percent-area', plugin: 'percent-area', metric: 'reward', metrics: ['reward'] },
    { id: 'bar', plugin: 'bar', metric: 'summary.score', metrics: ['summary.score'] },
    {
      id: 'scatter',
      plugin: 'scatter',
      metric: 'summary.score',
      metrics: ['summary.score', 'config.model'],
    },
    {
      id: 'scatter-history',
      plugin: 'scatter-history',
      metric: 'loss',
      metrics: ['loss', 'progress'],
    },
    {
      id: 'parallel',
      plugin: 'parallel',
      metric: 'config.model',
      metrics: ['config.model', 'summary.score', 'config.lr'],
    },
    {
      id: 'spread',
      plugin: 'line',
      metric: 'loss',
      metrics: ['loss'],
      settings: { groupBy: 'config.cohort', aggregation: 'mean', spread: 'stddev' },
    },
    { id: 'fit', plugin: 'line', metric: 'loss', metrics: ['loss'], settings: { xAxis: 'epoch' } },
    { id: 'fit-section-range', plugin: 'line', metric: 'loss', metrics: ['loss'] },
    {
      id: 'fit-log',
      plugin: 'line',
      metric: 'loss',
      metrics: ['loss'],
      settings: { xAxis: 'epoch', xScale: 'log' },
    },
    { id: 'single-point', plugin: 'line', metric: 'final', metrics: ['final'] },
    { id: 'short-span', plugin: 'line', metric: 'late', metrics: ['late'] },
    { id: 'limited', plugin: 'line', metric: 'loss', metrics: ['loss'], settings: { maxRuns: 2 } },
    {
      id: 'limited-groups',
      plugin: 'line',
      metric: 'loss',
      metrics: ['loss'],
      settings: { groupBy: 'config.model', aggregation: 'mean', maxRuns: 1 },
    },
  ].map((panel) => ({
    ...panel,
    title:
      'Fixture ' +
      panel.id +
      (panel.id === 'limited' ? ' with a title long enough to compete for the header' : ''),
    section: panel.id,
    settings: { smoothingMethod: 'none', legend: true, ...panel.settings },
  }));
  // A second view compares more runs than the former default limit of ten. Create them
  // before the first view so that view's visibility choice excludes them.
  const extraRuns = Array.from({ length: 9 }, (_, index) => 'extra-' + index);
  for (const [index, name] of extraRuns.entries()) {
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: { entity, project, name, displayName: 'Extra ' + index },
    });
    await call(`/files/${scope}/${name}/file_stream`, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: [0, 1].map((step) => JSON.stringify({ _step: step, loss: index + step })),
        },
      },
      complete: true,
      exitcode: 0,
    });
  }
  const view = await call('/api/tools/view_create', {
    project: scope,
    name: 'Built-in renderer fixture',
  });
  view.body.visible = runs.map((run) => scope + '/' + run.name);
  view.body.generation = 'manual';
  view.body.panels = panels;
  view.body.sections = panels.map((panel) => ({ id: panel.id, name: panel.title }));
  view.body.sectionSettings = { 'fit-section-range': { xAxis: 'epoch', xMin: 990, maxRuns: 2 } };
  view.body.sectionLayouts = Object.fromEntries(
    panels.map((panel) => [panel.id, { width: 600, height: 300, rows: 1 }]),
  );
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: view.project, version: view.version, body: view.body },
    'PUT',
  );

  const allRunsView = await call('/api/tools/view_create', { project: scope, name: 'All runs' });
  allRunsView.body.visible = [...runs.map((run) => run.name), ...extraRuns].map(
    (name) => scope + '/' + name,
  );
  allRunsView.body.generation = 'manual';
  allRunsView.body.sections = [{ id: 'all', name: 'All runs' }];
  allRunsView.body.panels = [
    {
      id: 'all-runs',
      plugin: 'line',
      metric: 'loss',
      metrics: ['loss'],
      section: 'all',
      settings: { maxRuns: null, smoothingMethod: 'none' },
    },
    { id: 'default-runs', plugin: 'line', metric: 'loss', metrics: ['loss'], section: 'all' },
  ];
  await call(
    '/api/views/' + allRunsView.id,
    {
      name: allRunsView.name,
      project: allRunsView.project,
      version: allRunsView.version,
      body: allRunsView.body,
    },
    'PUT',
  );

  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  const pendingCharts = new Set();
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chart') pendingCharts.add(request);
  });
  page.on('requestfinished', (request) => pendingCharts.delete(request));
  page.on('requestfailed', (request) => pendingCharts.delete(request));
  const errors = [],
    consoleErrors = [],
    failedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('response', (response) => {
    if (!response.ok() && new URL(response.url()).pathname.startsWith('/api/'))
      failedRequests.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  await page.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
  await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', view.id);

  async function inspect(id, legendAction) {
    const panel = page.locator(`[data-panel-id="${id}"]`);
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('canvas').first()).toBeVisible();
    await expect(panel.locator('.chart-status')).toHaveCount(0);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    return page.evaluate(
      async ({ id, legendAction }) => {
        const engineURL = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => /\/assets\/engine-[^/]+\.js(?:\?|$)/.test(name));
        if (!engineURL) throw Error('Built ECharts engine chunk was not loaded');
        const module = await import(engineURL);
        const echarts = Object.values(module).find(
          (value) => value && typeof value.getInstanceByDom === 'function',
        );
        if (!echarts) throw Error('Engine export with getInstanceByDom was not found');
        const panel = document.querySelector(`[data-panel-id="${CSS.escape(id)}"]`);
        const host = [...panel.querySelectorAll('[_echarts_instance_]')].find((element) =>
          echarts.getInstanceByDom(element),
        );
        const chart = host && echarts.getInstanceByDom(host);
        if (!chart) throw Error('Panel has no live ECharts instance');
        if (legendAction) {
          chart.dispatchAction(legendAction);
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        }
        const option = JSON.parse(JSON.stringify(chart.getOption()));
        const model = chart.getModel();
        const axes = ['xAxis', 'yAxis'].map((kind) => {
          const axis = model.getComponent(kind, 0)?.axis;
          return axis
            ? {
                kind,
                extent: axis.scale.getExtent(),
                labels: axis.getViewLabels().map((label) => label.tick.value),
              }
            : null;
        });
        const series = model.getSeries().map((item) => ({
          name: item.name,
          type: item.subType,
          filtered: model.isSeriesFiltered(item),
          count: item.getData().count(),
        }));
        const painted = [...panel.querySelectorAll('canvas')].some((canvas) => {
          const context = canvas.getContext('2d');
          if (!context || !canvas.width || !canvas.height) return false;
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
          return false;
        });
        return { option, axes, series, painted };
      },
      { id, legendAction },
    );
  }

  // Palette choices retain their light hex while the UI, canvas and PNG follow the theme.
  await inspect('line');
  const linePanel = page.locator('[data-panel-id="line"]');
  const runDot = (name) => page.locator(`[data-color-id="${scope}/${name}"]`);
  const picker = page.getByRole('dialog', { name: /^Color for / });
  await runDot('a').click();
  await picker.getByRole('button', { name: 'Cyan', exact: true }).click();
  await page.keyboard.press('Escape');
  await runDot('b').click();
  await picker.getByRole('textbox', { name: 'Hex color', exact: true }).fill('#123456');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await call('/api/views/' + view.id)).body.runColors)
    .toEqual({
      [scope + '/a']: '#5bc5db',
      [scope + '/b']: '#123456',
    });
  for (const dark of [true, false]) {
    await inspect('line');
    await expect.poll(() => pendingCharts.size).toBe(0);
    const chartRequests = [];
    const recordRequest = (request) => {
      if (new URL(request.url()).pathname === '/api/chart') chartRequests.push(request.url());
    };
    page.on('request', recordRequest);
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    const hex = dark ? '#328ea3' : '#5bc5db';
    const rgb = dark ? 'rgb(50, 142, 163)' : 'rgb(91, 197, 219)';
    await expect(page.locator('html')).toHaveAttribute('theme', dark ? 'g100' : 'g10');
    if (dark) {
      await expect(linePanel).toHaveCSS('background-color', 'rgb(38, 38, 38)');
      await expect(page.locator('.run-sidebar')).toHaveCSS('background-color', 'rgb(38, 38, 38)');
      const runRow = runDot('a').locator('xpath=ancestor::*[contains(@class,"run-row")]');
      await runRow.hover();
      await expect(runRow).toHaveCSS('background-color', 'rgb(53, 53, 53)');
    }
    await expect
      .poll(
        async () =>
          (await inspect('line')).option.series.find((s) => s.name === 'A').itemStyle.color,
      )
      .toBe(hex);
    assert.equal(
      (await inspect('line')).option.series.find((s) => s.name === 'B').itemStyle.color,
      '#123456',
    );
    await expect(runDot('a').locator('.run-color')).toHaveCSS('background-color', rgb);
    await expect(
      linePanel.getByRole('button', { name: 'A', exact: true }).locator('.chart-legend-marker'),
    ).toHaveCSS('background-color', rgb);
    const host = linePanel.locator('[_echarts_instance_]');
    await host.focus();
    await page.keyboard.press('Home');
    const row = page
      .locator('.plot-inspector[data-local="true"]:visible .plot-inspector-row')
      .filter({ hasText: 'A' })
      .first();
    await expect(row.locator('.plot-inspector-marker')).toHaveCSS('background-color', rgb);
    await expect(row.locator('.plot-inspector-label > span')).toHaveCSS(
      'color',
      dark ? 'rgb(50, 175, 217)' : 'rgb(31, 168, 212)',
    );
    await page.keyboard.press('Escape');
    page.off('request', recordRequest);
    assert.deepEqual(chartRequests, [], 'theme changes reuse chart data');
    await runDot('a').click();
    await expect(picker.getByRole('textbox', { name: 'Hex color', exact: true })).toHaveValue(
      '#5bc5db',
    );
    await expect(picker.getByRole('button', { name: 'Cyan', exact: true })).toHaveCSS(
      'background-color',
      rgb,
    );
    await expect(picker.getByRole('button', { name: 'Cyan', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await picker.getByRole('button', { name: 'Cyan', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal((await call('/api/views/' + view.id)).body.runColors[scope + '/a'], '#5bc5db');

    await linePanel.hover();
    await linePanel.getByRole('button', { name: 'Panel actions', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export PNG', exact: true }).click();
    const download = await downloadPromise;
    const png = await readFile(await download.path());
    const hasColor = await page.evaluate(
      async ({ data, hex }) => {
        const image = new Image();
        image.src = data;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const expected = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        for (let i = 0; i < pixels.length; i += 4)
          if (expected.every((c, j) => Math.abs(pixels[i + j] - c) <= 1) && pixels[i + 3] === 255)
            return true;
        return false;
      },
      { data: 'data:image/png;base64,' + png.toString('base64'), hex },
    );
    assert.ok(hasColor, 'PNG contains the current theme series color');
  }
  for (const name of ['a', 'b']) {
    await runDot(name).click();
    await picker.getByRole('button', { name: 'Reset to automatic', exact: true }).click();
  }
  checked.push(
    'light/dark palette, persisted choices, custom colors, sidebar, legend, inspector and PNG; no theme refetch',
  );

  const line = await inspect('line');
  assert.ok(line.painted);
  assert.equal(line.option.series.length, 3);
  for (const run of runs)
    assert.deepEqual(
      line.option.series.find((series) => series.name === run.displayName).data,
      run.loss.map((value, step) => [step, value]),
    );
  assert.ok(line.series.every((series) => series.type === 'line' && series.count === 3));
  checked.push('line: exact history data');
  const legend = page.locator('[data-panel-id="line"] .chart-legend');
  await expect(legend).toBeVisible();
  await legend.evaluate((element) => {
    element.style.width = '120px';
    element.style.right = 'auto';
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => legend.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await legend.getByRole('button', { name: 'C', exact: true }).click();
  let hiddenByLegend = await inspect('line');
  assert.ok(hiddenByLegend.series.find((series) => series.name === 'C').filtered);
  await page.reload();
  hiddenByLegend = await inspect('line');
  assert.ok(
    hiddenByLegend.series.find((series) => series.name === 'C').filtered,
    'Legend selection survives reload',
  );
  await legend.evaluate((element) => (element.scrollLeft = element.scrollWidth));
  await legend.getByRole('button', { name: 'C', exact: true }).click();
  await legend.getByRole('button').last().focus();
  await page.keyboard.press('Home');
  await expect(legend.getByRole('button').first()).toBeFocused();
  assert.equal(await page.locator('.sample-badge').count(), 0);
  await expect(page.getByText('Sampled', { exact: true })).toHaveCount(0);
  checked.push(
    'legend: native horizontal scroll, keyboard navigation and series toggling without pagination',
  );
  await legend.getByRole('button').first().hover();
  // A focused panel stays mounted while scrolled away; release focus to test disposal.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.locator('main').evaluate((element) => (element.scrollTop = element.scrollHeight));
  // Fewer than twelve panels left the viewport after it, so the renderer is kept.
  await expect(page.locator('[data-panel-id="line"] canvas').first()).toBeAttached();
  await page.locator('main').evaluate((element) => (element.scrollTop = 0));
  await inspect('line');
  await expect(page.locator('[data-panel-id="line"] .chart-status')).toHaveCount(0);
  checked.push('legend hover survives leaving and re-entering the viewport');

  const area = await inspect('area');
  assert.ok(area.painted);
  assert.equal(area.option.series.length, 3);
  for (const run of runs) {
    const series = area.option.series.find((series) => series.name === run.displayName);
    assert.deepEqual(
      series.data,
      run.loss.map((value, step) => [step, value]),
    );
    assert.ok(series.areaStyle.opacity > 0);
  }
  checked.push('area: exact history and fill');

  const percent = await inspect('percent-area');
  assert.ok(percent.painted);
  assert.equal(percent.option.yAxis[0].min, 0);
  assert.equal(percent.option.yAxis[0].max, 100);
  // Shares are stacked at logged X positions and add up to 100 at each of them.
  for (const index of percent.option.series[0].data.keys()) {
    assert.ok(Number.isInteger(percent.option.series[0].data[index][0]));
    const sum = percent.option.series.reduce((total, series) => total + series.data[index][1], 0);
    assert.ok(Math.abs(sum - 100) < 1e-9);
  }
  for (const run of runs) {
    const series = percent.option.series.find((series) => series.name === run.displayName);
    assert.equal(series.stack, 'runs');
    assert.ok(Math.abs(series.data[0][1] - run.reward * 10) < 1e-9);
  }
  checked.push('percent area: normalized stacked percentages');

  const bar = await inspect('bar');
  assert.ok(bar.painted);
  assert.equal(bar.option.xAxis[0].type, 'category');
  assert.equal(bar.option.yAxis[0].scale, false);
  assert.equal(
    bar.axes.find((axis) => axis?.kind === 'yAxis').extent[0],
    0,
    'Positive bars must render from zero',
  );
  assert.deepEqual(new Set(bar.option.xAxis[0].data), new Set(['A', 'B', 'C']));
  assert.deepEqual(
    Object.fromEntries(
      bar.option.xAxis[0].data.map((name, index) => [name, bar.option.series[0].data[index].value]),
    ),
    { A: 10, B: 20, C: 30 },
  );
  checked.push('bar: summary values and actual zero-baseline extent');

  const scatter = await inspect('scatter');
  assert.ok(scatter.painted);
  assert.equal(scatter.option.xAxis[0].type, 'category');
  assert.deepEqual(new Set(scatter.option.xAxis[0].data), new Set(['small', 'large']));
  assert.equal(scatter.option.yAxis[0].type, 'value');
  for (const run of runs)
    assert.deepEqual(scatter.option.series.find((series) => series.name === run.displayName).data, [
      [run.model, run.score],
    ]);
  assert.ok(scatter.series.every((series) => series.type === 'scatter' && series.count === 1));
  checked.push('scatter: categorical config X and numeric summary Y');

  const historyScatter = await inspect('scatter-history');
  assert.ok(historyScatter.painted);
  assert.equal(historyScatter.option.xAxis[0].name, 'progress');
  for (const run of runs)
    assert.deepEqual(
      historyScatter.option.series.find((series) => series.name === run.displayName).data,
      run.loss.flatMap((value, step) =>
        run.progress[step] === null ? [] : [[run.progress[step], value]],
      ),
    );
  checked.push('history scatter: exact same-record X/Y pairs and omitted missing X');

  const parallel = await inspect('parallel');
  assert.ok(parallel.painted);
  assert.equal(parallel.option.parallelAxis[0].type, 'category');
  assert.deepEqual(new Set(parallel.option.parallelAxis[0].data), new Set(['small', 'large']));
  for (const run of runs)
    assert.deepEqual(
      parallel.option.series.find((series) => series.name === run.displayName).data,
      [[run.model, run.score, run.lr]],
    );
  assert.ok(parallel.series.every((series) => series.type === 'parallel' && series.count === 1));
  checked.push('parallel: categorical and numeric snapshot dimensions');

  const spread = await inspect('spread');
  assert.ok(spread.painted);
  const pairSeries = spread.option.series.filter((series) => series.randlRunIds?.length === 2);
  assert.equal(pairSeries.length, 3, 'Group must have a mean trace plus two band traces');
  const mean = pairSeries.find((series) => series.randlKey);
  assert.deepEqual(mean.data, [
    [0, 2],
    [1, 4],
    [2, 6],
  ]);
  const band = pairSeries.filter((series) => !series.randlKey);
  assert.deepEqual(band[0].data, [
    [0, 1],
    [1, 3],
    [2, 5],
  ]);
  assert.deepEqual(band[1].data, [
    [0, 2],
    [1, 2],
    [2, 2],
  ]);
  assert.ok(pairSeries.every((series) => series.name === mean.name));
  const hidden = await inspect('spread', { type: 'legendUnSelect', name: mean.name });
  assert.ok(
    hidden.series.filter((series) => series.name === mean.name).every((series) => series.filtered),
  );
  assert.ok(hidden.series.some((series) => series.name !== mean.name && !series.filtered));
  const restored = await inspect('spread', { type: 'legendSelect', name: mean.name });
  assert.ok(
    restored.series
      .filter((series) => series.name === mean.name)
      .every((series) => !series.filtered),
  );
  checked.push('group spread: mean/stddev bounds and synchronized legend filtering');

  const xExtent = (result) => result.axes.find((axis) => axis?.kind === 'xAxis').extent;
  const fit = await inspect('fit');
  assert.ok(fit.painted);
  assert.deepEqual(xExtent(fit), [1000, 1020], 'Automatic X range fits the data, not zero');
  const yFit = fit.axes.find((axis) => axis?.kind === 'yAxis').extent;
  assert.ok(yFit[0] > 0 && yFit[0] <= 1, 'Automatic Y range does not extend to zero');
  const zoomRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/chart' &&
      request.postDataJSON()?.settings?.xMin === 1005,
  );
  await inspect('fit', { type: 'dataZoom', start: 25, end: 75 });
  const zoomed = (await zoomRequest).postDataJSON().settings;
  assert.deepEqual([zoomed.xMin, zoomed.xMax], [1005, 1015], 'Zoom requests the visible X range');
  await expect.poll(async () => xExtent(await inspect('fit'))).toEqual([1005, 1015]);
  await page.locator('[data-panel-id="fit"] .chart-reset').click();
  await expect.poll(async () => xExtent(await inspect('fit'))).toEqual([1000, 1020]);
  checked.push('x axis: fits the data range; zoom requests its range; reset restores the fit');

  const sectionRange = await inspect('fit-section-range');
  assert.deepEqual(xExtent(sectionRange), [990, 1020], 'Section X minimum overrides the fit');
  const logFit = await inspect('fit-log');
  assert.equal(logFit.option.xAxis[0].type, 'log');
  assert.deepEqual(
    xExtent(logFit).map((value) => Math.round(value)),
    [1000, 1020],
    'Logarithmic X range fits the data',
  );
  // Linear axes hide their bound labels; at least one label must remain.
  const shownLabels = (result) => {
    const axis = result.axes.find((item) => item?.kind === 'xAxis');
    return result.option.xAxis[0].axisLabel.showMinLabel === false
      ? axis.labels.filter((value) => value > axis.extent[0] && value < axis.extent[1])
      : axis.labels;
  };
  assert.ok(shownLabels(logFit).length, 'A logarithmic X range within one decade keeps labels');
  const shortSpan = await inspect('short-span');
  assert.deepEqual(xExtent(shortSpan), [1, 2]);
  assert.deepEqual(
    shownLabels(shortSpan),
    [1, 2],
    'A one-step range labels its whole-number bounds',
  );
  checked.push('x axis: section range and logarithmic scale');

  const single = await inspect('single-point');
  assert.ok(single.painted);
  assert.ok(single.series.every((series) => series.count === 1));
  assert.ok(single.option.series.every((series) => series.showSymbol === true));
  const [singleMin, singleMax] = xExtent(single);
  assert.ok(singleMin < 2 && singleMax > 2, 'A lone X value lies inside the plot');
  assert.equal(singleMin + singleMax, 4, 'A lone X value is centered');
  assert.deepEqual(shownLabels(single), [2], 'A lone step is labeled with whole numbers only');
  checked.push('single-point series: shown as markers centered on the X axis');

  const limited = await inspect('limited');
  assert.equal(limited.series.length, 2);
  const note = (id) => page.locator(`[data-panel-id="${id}"] .chart-limit`);
  await expect(note('limited').locator('[aria-hidden="true"]')).toHaveText('2/3 runs');
  await expect(note('limited')).toHaveAttribute('title', '2 of 3 runs');
  await expect(page.locator('[data-panel-id="limited"] .chart-title')).toHaveAccessibleDescription(
    '2 of 3 runs',
  );
  const limitedGroups = await inspect('limited-groups');
  assert.equal(limitedGroups.series.filter((series) => !series.name.endsWith('band')).length, 1);
  await expect(note('limited-groups').locator('[aria-hidden="true"]')).toHaveText('1/2 groups');
  await expect(note('limited-groups')).toHaveAttribute('title', '1 of 2 groups');
  await expect(page.locator('[data-panel-id="line"] .chart-limit')).toHaveCount(0);
  const trailing = await page.locator('[data-panel-id="limited"]').evaluate((panel) => {
    const title = panel.querySelector('.chart-title').getBoundingClientRect(),
      note = panel.querySelector('.chart-limit').getBoundingClientRect(),
      tools = panel.querySelector('.chart-tools')?.getBoundingClientRect();
    return { gap: note.left - title.right, toolsGap: tools ? tools.left - note.right : null };
  });
  assert.ok(
    trailing.gap >= 0 && trailing.gap <= 12 && (trailing.toolsGap === null || trailing.toolsGap > 24),
    'The run count trails the panel title, not the panel tools: ' + JSON.stringify(trailing),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const header = await page.locator('[data-panel-id="limited"]').evaluate((panel) => {
    const title = panel.querySelector('.chart-title'),
      note = panel.querySelector('.chart-limit');
    return {
      titleCut: title.scrollWidth > title.clientWidth,
      note: note.clientWidth,
      noteMin: parseFloat(getComputedStyle(note).minWidth),
    };
  });
  assert.ok(
    !header.titleCut || header.note <= header.noteMin,
    'The run count yields space before the panel title: ' + JSON.stringify(header),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await pressSectionButton(page, 'Fixture fit-section-range section settings');
  const drawer = page.locator('.side-drawer');
  const shown = drawer.getByRole('combobox', { name: 'Runs shown', exact: true });
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(shown).toHaveValue('limit');
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(drawer.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(shown).toHaveValue('all');
  await expect(shown.locator('option[value="inherit"]')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(baseURL + '/' + scope + '/workspace?view=' + allRunsView.id);
  for (const id of ['all-runs', 'default-runs']) {
    const all = await inspect(id);
    assert.equal(all.series.length, 12, id + ' plots every visible run');
    await expect(page.locator(`[data-panel-id="${id}"] .chart-limit`)).toHaveCount(0);
  }
  checked.push(
    'run limits: every visible run by default; an explicit limit is stated; drawers reload per scope',
  );

  await page
    .getByRole('navigation', { name: 'Project pages', exact: true })
    .getByRole('button', { name: 'Overview', exact: true })
    .click();
  // Workspace charts are gone; the overview's own summary charts may already be drawn.
  await expect(page.locator('canvas:not(.overview-chart canvas)')).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedRequests, []);
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        runs: runs.length,
        panels: panels.length,
        checks: checked,
        unhandledErrors: 0,
      },
      null,
      2,
    ),
  );
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
