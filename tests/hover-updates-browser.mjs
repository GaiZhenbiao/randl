import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect, request } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const expect = playwrightExpect.configure({ timeout: 15000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-hover-updates-'));
let backend, api, browser;
try {
  backend = await createServer(directory);
  const baseURL = await listen(backend);
  // Pace the real NDJSON response so the pointer enters before all runs arrive.
  let pace = true;
  backend.app.server.on('request', (req, res) => {
    if (req.url !== '/api/chart' || !pace) return;
    const write = res.write.bind(res),
      end = res.end.bind(res);
    let chain = Promise.resolve();
    res.write = (chunk, ...args) => {
      chain = chain.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (!res.destroyed) write(chunk, ...args);
      });
      return true;
    };
    res.end = (...args) => {
      chain.then(() => end(...args));
      return res;
    };
  });
  api = await request.newContext({ baseURL });
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await api.fetch(path, { method, data: body });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  const scope = 'test/hover-updates',
    ids = [];
  const row = (step, run) =>
    JSON.stringify({
      _step: step,
      value: step + (16 - run) * 20,
      other: step / 2 + (16 - run) * 20,
    });
  for (let run = 0; run < 16; run++) {
    const name = 'r' + run;
    ids.push(scope + '/' + name);
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: { entity: 'test', project: 'hover-updates', name },
    });
    await call('/files/' + ids[run] + '/file_stream', {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 4000 }, (_, step) => row(step, run)),
        },
      },
    });
  }
  const view = await call('/api/tools/view_create', { project: scope, name: 'Hover updates' });
  Object.assign(view.body, {
    generation: 'manual',
    visible: ids,
    sections: [{ id: 'charts', name: 'Charts' }],
    sectionLayouts: { charts: { width: 500, height: 400, rows: 1 } },
    panels: ['primary', 'linked'].map((id) => ({
      id,
      plugin: 'line',
      section: 'charts',
      metric: 'value',
      metrics: ['value', 'other'],
      settings: { smoothingMethod: 'none', tooltipLimit: 4 },
    })),
  });
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: scope, version: view.version, body: view.body },
    'PUT',
  );
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${baseURL}/${scope}/workspace?view=${view.id}`);
  await expect(page.locator('[data-panel-id="primary"] canvas').first()).toBeVisible();
  await expect(page.locator('[data-panel-id="primary"] .chart-status')).toHaveCount(0);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
    const ec = Object.values(await import(url)).find((v) => v?.getInstanceByDom);
    window.probe = {
      charts: {},
      phase: 'stream',
      events: [],
      frames: 0,
      missingFrames: 0,
      emphasisFrames: 0,
    };
    for (const id of ['primary', 'linked']) {
      const host = document.querySelector(`[data-panel-id="${id}"] [_echarts_instance_]`),
        chart = ec.getInstanceByDom(host);
      const stats = { paints: 0, blank: 0, updates: 0, clears: 0, leaves: 0, moves: 0 };

      probe.charts[id] = { host, chart, stats };
      host.addEventListener('pointerleave', () => stats.leaves++);
      host.addEventListener('pointermove', () => stats.moves++);
      for (const [key, count] of [
        ['setOption', 'updates'],
        ['clear', 'clears'],
      ]) {
        const original = chart[key];
        chart[key] = function (...args) {
          stats[count]++;
          return original.apply(this, args);
        };
      }
      const painter = chart.getZr().painter,
        original = painter.refresh;
      painter.refresh = function (...args) {
        stats.paints++;
        const result = original.apply(this, args);
        if (!chart.getZr().storage.getDisplayList().length) stats.blank++;
        return result;
      };
    }
    probe.position = () => {
      const { host, chart } = probe.charts.primary,
        box = host.getBoundingClientRect();
      const grid = chart.getModel().getComponent('grid').coordinateSystem.getRect();
      return { x: box.left + grid.x + grid.width * 0.7, y: box.top + grid.y + grid.height * 0.3 };
    };
    probe.snapshot = () => {
      const { chart, host } = probe.charts.primary,
        box = host.getBoundingClientRect();
      const raw = chart.convertFromPixel({ xAxisIndex: 0 }, probe.pointer.x - box.left);
      const series = chart.getOption().series.filter((s) => s.randlKey && s.data.length);
      const nearest = series
        .flatMap((s) => s.data.map((p) => p[0]))
        .reduce((a, b) => (Math.abs(a - raw) <= Math.abs(b - raw) ? a : b));
      const tip = document.querySelector('.plot-inspector[data-local="true"]');
      const rowValues = [
        ...document.querySelectorAll('.plot-inspector:not([hidden]) .plot-inspector-row'),
      ].map((row) => {
        const series = chart.getOption().series.find((s) => s.randlKey === row.dataset.seriesKey);
        const point = series.data.reduce((a, b) =>
          Math.abs(a[0] - nearest) <= Math.abs(b[0] - nearest) ? a : b,
        );
        return {
          actual: row.querySelector('.plot-inspector-value').textContent,
          expected: new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(point[1]),
        };
      });
      const focusedKey = tip?.querySelector('[data-nearest="true"]')?.dataset.seriesKey;
      const focused = series.find((s) => s.randlKey === focusedKey);
      const focusedPoint = focused?.data.reduce((a, b) =>
        Math.abs(a[0] - nearest) <= Math.abs(b[0] - nearest) ? a : b,
      );
      const dot = host.parentElement.querySelector('.plot-inspector-point');
      const dotPixel = focusedPoint && chart.convertToPixel({ gridIndex: 0 }, focusedPoint);

      return {
        phase: probe.phase,
        stats: Object.fromEntries(
          Object.entries(probe.charts).map(([id, { stats }]) => [id, { ...stats }]),
        ),
        expectedX: nearest,
        focusedKey,
        rowValues,
        dotPixel,
        actualDot: [parseFloat(dot.style.left), parseFloat(dot.style.top)],
        cursors: document.querySelectorAll('.plot-inspector-cursor:not([hidden])').length,
        linkedHeading: document.querySelector(
          '.plot-inspector[data-local="false"] .plot-inspector-heading',
        )?.textContent,
        canvases: document.querySelectorAll('canvas').length,
        heading: tip?.querySelector('.plot-inspector-heading')?.textContent,
        text: tip?.textContent,
        visible: document.querySelectorAll('.plot-inspector:not([hidden])').length,
        dots: document.querySelectorAll('.plot-inspector-point:not([hidden])').length,
        hidden: [...probe.events],
        emphasis: chart
          .getModel()
          .getSeries()
          .filter((s) =>
            chart.getViewOfSeriesModel(s)._polyline?.currentStates.includes('emphasis'),
          )
          .map((s) => s.option.randlKey),
        width: chart.getWidth(),
      };
    };
  });
  const pointer = await page.evaluate(() => probe.position());
  await page.evaluate((p) => (probe.pointer = p), pointer);
  await page.mouse.move(pointer.x, pointer.y);
  await expect(page.locator('.plot-inspector:visible')).toHaveCount(2);
  await page.evaluate(() => {
    probe.initial = probe.snapshot();
    function frame() {
      probe.frames++;
      if (
        ['.plot-inspector', '.plot-inspector-cursor', '.plot-inspector-point'].some(
          (selector) => document.querySelectorAll(selector + ':not([hidden])').length !== 2,
        )
      )
        probe.missingFrames++;
      const chart = probe.charts.primary.chart;
      const emphasized = chart
        .getModel()
        .getSeries()
        .filter((s) => chart.getViewOfSeriesModel(s)._polyline?.currentStates.includes('emphasis'));
      // Incoming runs can change the nearest series. ECharts applies that action
      // on its next frame; emphasis must never disappear during the handoff.
      if (emphasized.length !== 1) probe.emphasisFrames++;
      probe.frame = requestAnimationFrame(frame);
    }
    probe.frame = requestAnimationFrame(frame);
    const observer = new MutationObserver((records) => {
      records.forEach((r, i) => {
        if (
          r.attributeName !== 'hidden' ||
          !r.target.matches('.plot-inspector,.plot-inspector-cursor,.plot-inspector-point')
        )
          return;
        const next = records
          .slice(i + 1)
          .find((n) => n.target === r.target && n.attributeName === 'hidden');
        const hidden = next ? next.oldValue !== null : r.target.hidden;
        if ((r.oldValue !== null) !== hidden)
          probe.events.push({ phase: probe.phase, node: r.target.className, hidden });
      });
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['hidden'],
    });
  });
  await expect(page.locator('[data-panel-id="primary"]')).toHaveAttribute('aria-busy', 'false');
  await page.waitForTimeout(300);
  const results = [
    await page.evaluate(() => probe.initial),
    await page.evaluate(() => probe.snapshot()),
  ];
  pace = false;
  await page.evaluate(() => {
    probe.phase = 'idle';
  });
  await page.waitForTimeout(600);
  results.push(await page.evaluate(() => probe.snapshot()));
  for (let update = 0; update < 3; update++) {
    await page.evaluate((i) => (probe.phase = 'live-' + i), update);
    const step = 5000 + update * 1000;
    await call('/files/' + ids[0] + '/file_stream', {
      files: { 'wandb-history.jsonl': { offset: 4000 + update, content: [row(step, 0)] } },
    });
    await expect
      .poll(() =>
        page.evaluate(
          (step) =>
            probe.charts.primary.chart
              .getOption()
              .series.some((s) => s.data.some((p) => p[0] === step)),
          step,
        ),
      )
      .toBe(true);
    await page.waitForTimeout(300);
    results.push(await page.evaluate(() => probe.snapshot()));
  }
  await page.evaluate(() => {
    probe.phase = 'resize';
    document.querySelector('[data-panel-id="primary"] .chart-canvas').style.width = '85%';
  });
  await page.waitForTimeout(1800);
  results.push(await page.evaluate(() => probe.snapshot()));
  const frames = await page.evaluate(() => {
    cancelAnimationFrame(probe.frame);
    return { total: probe.frames, missing: probe.missingFrames, emphasis: probe.emphasisFrames };
  });
  assert.deepEqual(errors, []);
  assert.ok(frames.total > 30, 'Observed hover over multiple rendered frames');
  assert.equal(frames.emphasis, 0, 'Emphasis never disappears or expands to several series');
  assert.equal(frames.missing, 0, 'Popup, cursor and dot stay visible in every frame');
  assert.ok(results[1].stats.primary.updates > 0, 'Pointer rests on a partially streamed chart');
  assert.notDeepEqual(
    results[0].rowValues,
    results[1].rowValues,
    'Streamed runs update visible values',
  );
  assert.notEqual(
    results[0].text,
    results[1].text,
    'Inspector incorporates incoming streamed runs',
  );
  assert.notEqual(results.at(-1).width, results.at(-2).width, 'Resize changed the plot width');
  for (const result of results) {
    assert.deepEqual(result.hidden, [], result.phase + ': no hide/show transitions');
    assert.equal(result.visible, 2);
    assert.equal(result.cursors, 2);
    assert.equal(result.dots, 2);
    assert.equal(result.canvases, results[0].canvases, 'Canvas resources stay bounded');
    assert.equal(
      result.heading,
      'Step ' + new Intl.NumberFormat('en-US').format(result.expectedX),
      result.phase + ': resample stationary pointer',
    );
    assert.equal(result.linkedHeading, result.heading, 'Linked inspector follows the local cursor');
    for (const row of result.rowValues)
      assert.equal(row.actual, row.expected, result.phase + ': current values');
    assert.deepEqual(
      result.emphasis,
      [result.focusedKey],
      result.phase + ': only the inspected series is emphasized',
    );
    for (let axis = 0; axis < 2; axis++)
      assert.ok(
        Math.abs(result.actualDot[axis] - result.dotPixel[axis]) < 0.1,
        'Dot follows inspected point',
      );
    for (const stats of Object.values(result.stats)) {
      assert.equal(stats.clears, 0, 'Never clear the chart during updates');
      assert.equal(stats.blank, 0, 'Never paint an empty display list');
      assert.equal(stats.leaves, 0, 'No popup/pointer event loop');
    }
    assert.equal(result.stats.primary.moves, 1, 'Pointer never moves after entering');
  }
  for (let index = 3; index < results.length; index++)
    assert.notEqual(
      results[index].heading,
      results[index - 1].heading,
      'Values follow live data and resize',
    );
  assert.equal(
    results[2].stats.primary.paints,
    results[1].stats.primary.paints,
    'No idle repaint loop',
  );
  console.log(
    JSON.stringify(
      {
        phases: results.map(({ phase, stats, heading }) => ({ phase, stats, heading })),
        frames,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await api?.dispose();
  await backend?.app.close();
  await rm(directory, { recursive: true, force: true });
}
