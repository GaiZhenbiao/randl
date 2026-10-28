import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-focused-run-'));
let server, browser;
try {
  const store = new Store(directory),
    runs = [];
  for (let i = 0; i < 24; i++) {
    const run = store.upsert({
      entity: 'test',
      project: 'focus',
      name: 'r' + i,
      displayName: 'Composition run ' + i,
      config: { cohort: { value: 'group-' + Math.floor(i / 8) } },
    });
    store.db.prepare('UPDATE runs SET created=? WHERE id=?').run(1700000000 + i, run.id);
    store.ingest(run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 200 }, (_, step) =>
            JSON.stringify({ _step: step, a: i + 2, b: 2 }),
          ),
        },
      },
      complete: true,
    });
    runs.push(run);
  }
  // Five inputs used to refuse the entire selection after 50,000 usable records.
  // The newest run also exceeds that threshold on its own.
  const largeRuns = [];
  for (let i = 0; i < 24; i++) {
    const run = store.upsert({
      entity: 'test',
      project: 'large-focus',
      name: 'r' + i,
      displayName: 'Large run ' + i,
    });
    store.db.prepare('UPDATE runs SET created=? WHERE id=?').run(1700000000 + i, run.id);
    store.ingest(run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: i === 23 ? 60001 : 3000 }, (_, step) =>
            JSON.stringify({
              _step: step,
              iteration: step * 2,
              a: i + 1 + (step % 7),
              b: 2,
              c: 3,
              d: 4,
              e: 5,
            }),
          ),
        },
      },
      complete: true,
    });
    largeRuns.push(run);
  }
  store.db.close();
  server = await createServer(directory);
  const panel = (id, plugin, metrics, settings) => ({
    id,
    plugin,
    title: id,
    metric: metrics[0],
    metrics,
    settings,
    section: 's',
  });
  const view = await server.tools.execute('view_create', {
    project: 'test/focus',
    name: 'Focused composition',
    body: {
      generation: 'manual',
      visible: runs.slice(0, 23).map((r) => r.id),
      visibleThrough: 1800000000,
      solo: [],
      pinned: [runs[0].id],
      plotSettings: { maxRuns: 'focused' },
      sections: [{ id: 's', name: 'Composition' }],
      sectionLayouts: { s: { width: 600, height: 320, rows: 2 } },
      panels: [
        panel('line', 'line', ['a']),
        // Focused run takes precedence over the panel's grid layout.
        panel('percent', 'percent-area', ['a', 'b'], { layout: 'grid' }),
        panel('stack', 'stacked-area', ['a', 'b']),
        panel('group', 'stacked-area', ['a', 'b'], { groupBy: 'config.cohort' }),
      ],
    },
  });
  const origin = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, locale: 'en-US' });
  const errors = [],
    requests = [],
    responses = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/'))
      requests.push({ url: request.url(), method: request.method(), body: request.postDataJSON() });
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/chart'))
      // A response the page navigated away from has no body; it carries no bytes to count.
      responses.push(
        response.body().then(
          (body) => body.byteLength,
          () => 0,
        ),
      );
  });
  const started = performance.now();
  await page.goto(origin + '/test/focus/workspace?view=' + view.id);
  await expect(page.locator('[data-panel-id="percent"] .chart-focused-run')).toHaveText(
    runs[22].display_name,
  );
  await expect(page.locator('[data-panel-id="percent"] [role="grid"]')).toHaveCount(0);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.chart')].every(
      (n) => n.getAttribute('aria-busy') === 'false' && n.querySelector('canvas'),
    ),
  );
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
    const mod = await import(url);
    const engine = Object.values(mod).find((v) => v?.getInstanceByDom);
    window.focusChart = (id) =>
      engine.getInstanceByDom(
        document.querySelector(`[data-panel-id="${id}"] [_echarts_instance_]`),
      );
  });
  const header = (id) => page.locator(`[data-panel-id="${id}"] .chart-focused-run`);
  async function calmAreas() {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const paths = [];
          for (const id of ['stack', 'percent', 'group']) {
            const chart = window.focusChart(id);
            chart.getModel().eachSeries((model) => {
              chart.getViewOfSeriesModel(model).group.traverse((el) => {
                if (el.type === 'ec-polygon')
                  paths.push({ opacity: el.style.opacity, states: el.currentStates });
              });
            });
          }
          return paths;
        }),
      )
      .toEqual(Array.from({ length: 6 }, () => ({ opacity: 0.85, states: [] })));
  }
  async function shown(index) {
    for (const id of ['stack', 'percent']) {
      await expect(header(id)).toHaveText(runs[index].display_name);
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              // A chart being rebuilt for the new run briefly has no option; keep polling.
              window
                .focusChart(id)
                ?.getOption()
                ?.series?.map((s) => s.randlKey),
            id,
          ),
        )
        .toEqual(['a', 'b'].map((metric) => runs[index].id + ':' + metric));
    }
  }
  await shown(22);
  await expect(header('group')).toContainText('group-2');
  assert.equal(await header('line').count(), 0, 'incompatible panels ignore inherited focus mode');
  assert.equal(await page.evaluate(() => window.focusChart('line').getOption().series.length), 23);
  const initialMs = performance.now() - started;
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  const heapBefore = await heap();
  const storedBefore = await server.db.call('view', view.id);
  let requestStart = requests.length;
  const bytes = await Promise.all(responses);

  let releaseCold, releaseLate;
  const lateGate = new Promise((resolve) => {
    releaseLate = resolve;
  });
  const coldGate = new Promise((resolve) => {
    releaseCold = resolve;
  });
  await page.route('**/api/chart', async (route) => {
    const body = route.request().postDataJSON();
    if (body.runs?.length === 1 && body.runs[0] === runs[0].id) await coldGate;
    if (body.runs?.length === 1 && body.runs[0] === runs[1].id) await lateGate;
    await route.continue();
  });
  // Hover the old run's actual line at step 100; linked composition values and popup follow it.
  const point = await page.evaluate(() => {
    const chart = window.focusChart('line'),
      box = chart.getDom().getBoundingClientRect();
    const p = chart.convertToPixel({ gridIndex: 0 }, [100, 2]);
    return { x: box.left + p[0], y: box.top + p[1] };
  });
  await page.mouse.move(point.x, point.y);
  await expect
    .poll(() => requests.slice(requestStart).filter((r) => r.url.endsWith('/api/chart')).length)
    .toBe(2);
  await shown(22); // A cold hover keeps the previous chart and header until data arrives.
  await calmAreas();
  releaseCold();
  await shown(0);
  await calmAreas();
  await expect(header('group')).toContainText('group-0');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .focusChart('group')
          .getOption()
          .series.map((s) => s.data[100][1]),
      ),
    )
    .toEqual([5.5, 2]);
  await expect(page.locator('[data-panel-id="percent"] .chart-legend-item')).toHaveCount(2);
  for (const item of await page.locator('[data-panel-id="percent"] .chart-legend-item').all())
    await expect(item).toHaveAttribute('title', /Composition run 0/);
  await expect(
    page.locator('[data-panel-id="percent"] .plot-inspector[data-local="false"]'),
  ).toBeVisible();
  assert.deepEqual(
    await page.evaluate(() =>
      window
        .focusChart('percent')
        .getOption()
        .series.map((s) => s.data[100][1]),
    ),
    [50, 50],
  );
  await page.mouse.move(1590, 10);
  await shown(22);

  await page.locator(`[data-entry-key="${runs[21].id}"]`).hover();
  await shown(21);
  await calmAreas();
  await page.mouse.move(1590, 10);
  await shown(22);
  const coldRequests = requests.slice(requestStart);
  assert.equal(coldRequests.length, 4, 'one cold load per run and composition panel');
  assert.ok(coldRequests.every((r) => r.url.endsWith('/api/chart') && r.body.runs.length === 1));
  requestStart = requests.length;
  // Each switch uses already loaded data. Measure mouseenter to rendered options plus one frame.
  const latencies = [];
  for (let i = 0; i < 10; i++) {
    const index = i % 2 ? 21 : 0;
    const row = page.locator(`[data-entry-key="${runs[index].id}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.evaluate((node, runId) => {
      window.focusLatency = new Promise((resolve) => {
        node.addEventListener(
          'mouseenter',
          () => {
            const start = performance.now();
            function check() {
              if (
                window
                  .focusChart('percent')
                  .getOption()
                  .series.every((s) => s.randlKey.startsWith(runId + ':'))
              )
                requestAnimationFrame(() => resolve(performance.now() - start));
              else requestAnimationFrame(check);
            }
            requestAnimationFrame(check);
          },
          { once: true },
        );
      });
    }, runs[index].id);
    await row.hover();
    await shown(index);
    latencies.push(await page.evaluate(() => window.focusLatency));
    await calmAreas();
    await page.mouse.move(1590, 10);
    await shown(22);
  }
  assert.ok(
    latencies.every((ms) => ms <= 50),
    `cached switches stay within 50 ms: ${latencies}`,
  );
  assert.deepEqual(requests.slice(requestStart), [], 'cached switches make no requests');
  // Warm five adjacent rows, then sweep them within one frame. Each renderer should
  // paint the final state once, with no queued intermediate emphasis remaining.
  for (const index of [18, 19, 20, 21, 22]) {
    await page.locator(`[data-entry-key="${runs[index].id}"]`).hover();
    await shown(index);
  }
  await page.mouse.move(1590, 10);
  await shown(22);
  requestStart = requests.length;
  const paints = await page.evaluate(
    async (ids) => {
      await new Promise((resolve) => {
        let frames = 0;
        const step = () => (++frames === 5 ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      });
      const counts = {},
        listeners = [];
      for (const id of ['line', 'stack', 'percent', 'group']) {
        const chart = window.focusChart(id);
        counts[id] = 0;
        const listener = () => counts[id]++;
        chart.getZr().on('rendered', listener);
        listeners.push([chart, listener]);
      }
      for (const id of ids) {
        document
          .querySelector(`[data-entry-key="${id}"]`)
          .dispatchEvent(new MouseEvent('mouseenter'));
        await Promise.resolve();
      }
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      for (const [chart, listener] of listeners) chart.getZr().off('rendered', listener);
      for (const id of ids)
        document
          .querySelector(`[data-entry-key="${id}"]`)
          .dispatchEvent(new MouseEvent('mouseleave'));
      return counts;
    },
    [18, 19, 20, 21, 22].map((index) => runs[index].id),
  );
  assert.ok(
    Object.values(paints).every((count) => count <= 1),
    `sidebar sweep paints once per chart: ${JSON.stringify(paints)}`,
  );
  await shown(22);
  // A hidden run still exists in the sidebar but cannot become the displayed candidate.
  await page.locator(`[data-entry-key="${runs[23].id}"]`).hover();
  await shown(22);
  await page.mouse.move(1590, 10);
  // Self-hover keeps the latest run and reports that run's components.
  await page.locator('[data-panel-id="percent"] canvas').first().hover();
  await shown(22);
  await expect(page.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
  // A keyboard inspection can remain focused while an external row takes hover ownership.
  await page.locator('[data-panel-id="percent"] [role="application"]').focus();
  await page.keyboard.press('ArrowRight');
  await page.locator(`[data-entry-key="${runs[21].id}"]`).hover();
  await shown(21);
  await calmAreas();
  await page.mouse.move(1590, 10);
  await shown(22);
  await expect(page.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400); // Include the view-save debounce in the no-save assertion.
  assert.deepEqual(requests.slice(requestStart), [], 'hover switches make no API requests');
  assert.deepEqual(
    await server.db.call('view', view.id),
    storedBefore,
    'hover never saves the view',
  );

  // Cached focus reuses models; a new revision releases the old OptionManager backup.
  await page.locator(`[data-entry-key="${runs[21].id}"]`).hover();
  await shown(21);
  await page.evaluate(
    () => (window.previousFocusModel = window.focusChart('percent').getModel().getSeriesByIndex(0)),
  );
  await page.locator(`[data-entry-key="${runs[0].id}"]`).hover();
  await shown(0);
  assert.equal(
    await page.evaluate(
      () =>
        window.previousFocusModel === window.focusChart('percent').getModel().getSeriesByIndex(0),
    ),
    true,
    'cached data reuses the focused model',
  );
  const live = await server.app.inject({
    method: 'POST',
    url: '/files/' + runs[0].id + '/file_stream',
    payload: {
      files: {
        'wandb-history.jsonl': {
          offset: 200,
          content: [JSON.stringify({ _step: 200, a: 9, b: 1 })],
        },
      },
    },
  });
  assert.equal(live.statusCode, 200);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.focusChart('percent').getModel().getSeriesByIndex(0).getRawData().count(),
      ),
    )
    .toBe(201);
  assert.equal(
    await page.evaluate(
      () =>
        window.previousFocusModel !== window.focusChart('percent').getModel().getSeriesByIndex(0),
    ),
    true,
    'live data replaces the model and its obsolete backup',
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.focusChart('percent').getModel().getSeriesByIndex(0).option.data.at(-1),
    ),
    [200, 90],
  );
  await page.evaluate(() => delete window.previousFocusModel);
  await page.mouse.move(1590, 10);
  await shown(22);

  // A superseded load finishes into the cache without replacing the current focus.
  const lateStart = requests.length;
  await page.locator(`[data-entry-key="${runs[1].id}"]`).hover();
  await expect.poll(() => requests.length - lateStart).toBe(2);
  await shown(22);
  await page.mouse.move(1590, 10);
  const lateResponses = Promise.all(
    ['none', 'percent'].map((normalization) =>
      page.waitForResponse((response) => {
        if (!response.url().endsWith('/api/chart')) return false;
        const body = response.request().postDataJSON();
        return (
          body.runs?.length === 1 &&
          body.runs[0] === runs[1].id &&
          body.recordTransform.normalization === normalization
        );
      }),
    ),
  );
  releaseLate();
  for (const response of await lateResponses) await response.finished();
  await shown(22);
  const lateCachedStart = requests.length;
  await page.locator(`[data-entry-key="${runs[1].id}"]`).hover();
  await shown(1);
  await page.mouse.move(1590, 10);
  await shown(22);
  assert.deepEqual(requests.slice(lateCachedStart), [], 'superseded completed requests are cached');
  assert.deepEqual(await server.db.call('view', view.id), storedBefore);
  const heapAfter = await heap();

  // Explicit selection is saved by the ordinary editor and can override inherited focus with All.
  const target = page.locator('[data-panel-id="percent"]');
  await target.hover();
  await target.getByRole('button', { name: 'Panel settings', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  const choice = drawer.getByRole('combobox', { name: 'Runs shown', exact: true });
  await expect(choice).toHaveValue('focused');
  await choice.selectOption('all');
  await drawer.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await server.db.call('view', view.id)).body.panels.find((p) => p.id === 'percent')?.settings
          ?.maxRuns,
    )
    .toBe(null);
  await expect(header('percent')).toHaveCount(0);
  await target.hover();
  await target.getByRole('button', { name: 'Panel settings', exact: true }).click();
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  await choice.selectOption('focused');
  await drawer.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await server.db.call('view', view.id)).body.panels.find((p) => p.id === 'percent')?.settings
          ?.maxRuns,
    )
    .toBe('focused');
  await shown(22);
  await page.reload();
  await expect(header('percent')).toHaveText(runs[22].display_name);
  await server.tools.execute('panel_update', {
    view: view.id,
    id: 'group',
    settings: { groupBy: 'all' },
  });
  for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']) {
    const copy = JSON.parse(
      await readFile(new URL('../frontend/src/locales/' + lang + '.json', import.meta.url), 'utf8'),
    );
    await page.evaluate((lang) => localStorage.setItem('randl.language', lang), lang);
    await page.reload();
    await expect(header('group')).toHaveText(copy['charts.groups.allRuns']);
    await expect(header('percent')).toHaveText(runs[22].display_name);
    await expect(header('percent')).toHaveAttribute(
      'title',
      copy['panel.focusedRun'].replace('{name}', runs[22].display_name),
    );
    await expect(page.locator('[data-panel-id="percent"] h3')).toHaveAttribute(
      'aria-describedby',
      'focused-percent',
    );
    await target.hover();
    await target.getByRole('button', { name: copy['panel.toolbar.settings'], exact: true }).click();
    const localized = drawer.getByRole('combobox', {
      name: copy['panelSettings.data.limit.label'],
      exact: true,
    });
    await expect(localized).toHaveValue('focused');
    await expect(localized.locator('option:checked')).toHaveText(copy['panelSettings.data.limit.focused']);
    await drawer.getByRole('button', { name: copy['common.action.cancel'], exact: true }).click();
  }
  // Large candidate set and a single large run: default and cold hover must render.
  await page.evaluate(() => localStorage.setItem('randl.language', 'en'));
  const largeView = await server.tools.execute('view_create', {
    project: 'test/large-focus',
    name: 'Large focused run',
    body: {
      generation: 'manual',
      visible: largeRuns.map((run) => run.id),
      visibleThrough: 1800000000,
      solo: [],
      panels: [
        {
          id: 'large',
          plugin: 'percent-area',
          title: 'Large composition',
          metric: 'a',
          metrics: ['a', 'b', 'c', 'd', 'e'],
          settings: { xAxis: 'iteration', maxRuns: 'focused' },
        },
      ],
    },
  });
  const manyView = await server.tools.execute('view_create', {
    project: 'test/large-focus',
    name: 'Many small focused candidates',
    body: { ...largeView.body, visible: largeRuns.slice(0, 23).map((run) => run.id) },
  });
  const manyRequestStart = requests.length;
  await page.goto(origin + '/test/large-focus/workspace?view=' + manyView.id);
  await expect(header('large')).toHaveText('Large run 22');
  await expect(page.locator('[data-panel-id="large"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-panel-id="large"] .chart-status')).toHaveCount(0);
  const manyCalls = requests.slice(manyRequestStart).filter((r) => r.url.endsWith('/api/chart'));
  assert.equal(manyCalls.length, 1, '69,000 combined records request only the focused run');
  assert.deepEqual(manyCalls[0].body.runs, [largeRuns[22].id]);
  const largeStart = performance.now(),
    largeRequestStart = requests.length;
  await page.goto(origin + '/test/large-focus/workspace?view=' + largeView.id);
  await expect(header('large')).toHaveText('Large run 23');
  await expect(page.locator('[data-panel-id="large"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-panel-id="large"] .chart-status')).toHaveCount(0);
  const largeInitialMs = performance.now() - largeStart;
  const largeCalls = requests.slice(largeRequestStart).filter((r) => r.url.endsWith('/api/chart'));
  assert.equal(largeCalls.length, 1);
  assert.deepEqual(largeCalls[0].body.runs, [largeRuns[23].id]);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/chart',
    payload: largeCalls[0].body,
  });
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.sampled, true);
  const pointCount = Object.values(result.series[0].values).reduce(
    (n, points) => n + points.length,
    0,
  );
  assert.ok(pointCount <= 100000);
  await expect
    .poll(() =>
      page.locator('[data-panel-id="large"] [_echarts_instance_]').evaluate(async (host) => {
        const url = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
        const engine = Object.values(await import(url)).find((v) => v?.getInstanceByDom);
        const series = engine.getInstanceByDom(host).getOption()?.series || [];
        return {
          keys: series.map((s) => s.randlKey),
          points: series.reduce((n, s) => n + s.data.length, 0),
        };
      }),
    )
    .toEqual({
      keys: ['a', 'b', 'c', 'd', 'e'].map((m) => largeRuns[23].id + ':' + m),
      points: pointCount,
    });
  const components = Object.values(result.series[0].values);
  assert.equal(components[0].at(-1)[0], 120000);
  for (let i = 0; i < components[0].length; i++) {
    assert.ok(components.every((points) => points[i][0] === components[0][i][0]));
    assert.ok(Math.abs(components.reduce((n, points) => n + points[i][1], 0) - 100) < 1e-9);
  }
  await page.locator(`[data-entry-key="${largeRuns[20].id}"]`).hover();
  await expect(header('large')).toHaveText('Large run 20');
  await page.mouse.move(1590, 10);
  await expect(header('large')).toHaveText('Large run 23');
  const cachedStart = requests.length;
  await page.locator(`[data-entry-key="${largeRuns[20].id}"]`).hover();
  await expect(header('large')).toHaveText('Large run 20');
  await page.mouse.move(1590, 10);
  await expect(header('large')).toHaveText('Large run 23');
  assert.deepEqual(requests.slice(cachedStart), []);
  assert.equal((await server.db.call('view', largeView.id)).version, largeView.version);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        candidates: 23,
        initialMs,
        heapBefore,
        heapAfter,
        recordsPerRun: 200,
        initialChartResponses: bytes.length,
        responseBytes: bytes,
        coldRequests: coldRequests.length,
        cachedHoverRequests: 0,
        combinedRecords: 69000,
        large: {
          candidates: 24,
          records: 129001,
          newestRecords: 60001,
          initialMs: largeInitialMs,
          points: pointCount,
          bytes: response.rawPayload.length,
          queryMs: result.queryMs,
        },
        hoverSaves: 0,
        switchMs: latencies,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
