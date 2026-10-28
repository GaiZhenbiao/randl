import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Grouped charts over more than 1,000 visible runs that log at different intervals and
// wall-clock times: a computed metric whose runs together exceed the per-run input budget,
// a stacked area with far more distinct X values than the former per-group limit, and
// hover popups that name the aggregate and its run count.
// npm run build && PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/grouped-charts-browser.mjs
const expect = playwrightExpect.configure({ timeout: 30000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-grouped-browser-'));
const checks = [],
  errors = [];
const total = 1200,
  ids = [];
const seed = new Store(directory);
seed.db.transaction(() => {
  for (let r = 0; r < total; r++) {
    const every = [1, 3, 7][r % 3],
      run = seed.upsert({
        entity: 'test',
        project: 'grouped',
        name: 'r' + String(r).padStart(4, '0'),
        config: { cohort: { value: r % 2 ? 'wide' : 'narrow' } },
      });
    const rows = [];
    for (let step = (r % 5) * every; step < 660; step += every)
      rows.push(
        JSON.stringify({
          _step: step,
          _timestamp: 1.7e9 + r * 0.13 + step * (1 + (r % 4) / 10),
          epoch: step + r / total,
          loss: (r % 2) + Math.exp(-step / 200),
          hits: 1 + (r % 2),
          total: 4,
        }),
      );
    seed.ingest(run.id, {
      files: { 'wandb-history.jsonl': { offset: 0, content: rows } },
      complete: true,
      exitcode: 0,
    });
    ids.push(run.id);
  }
})();
seed.db.close();
let server, browser;
try {
  server = await createServer(directory);
  const base = await listen(server);
  const panel = (id, plugin, metrics, extra = {}) => ({
    id,
    plugin,
    metric: metrics[0],
    metrics,
    title: id,
    section: 's',
    ...extra,
  });
  const view = await server.tools.execute('view_create', {
    project: 'test/grouped',
    name: 'Grouped 1,200',
    body: {
      generation: 'manual',
      visible: ids,
      solo: [],
      plotSettings: { groupBy: 'config.cohort', aggregation: 'mean', spread: 'stddev' },
      sections: [{ id: 's', name: 'Grouped' }],
      sectionLayouts: { s: { width: 640, height: 320, rows: 2 } },
      panels: [
        panel('loss', 'line', ['loss'], { settings: { xAxis: '_relative_wall' } }),
        panel('rate', 'line', [], {
          metric: 'rate',
          expressions: [{ name: 'rate', expression: '${hits} / ${total}' }],
        }),
        panel('stack', 'stacked-area', ['hits', 'total'], { settings: { xAxis: 'epoch' } }),
      ],
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const charts = [],
    registrations = [],
    responses = new Map();
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/chart') charts.push(request.postDataJSON());
    if (path === '/api/chart-selections') registrations.push(request.postDataJSON());
  });
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/chart' || !response.ok()) return;
    const body = response.request().postDataJSON();
    responses.set(body.metrics.join(','), await response.json());
  });
  const started = performance.now();
  await page.goto(`${base}/test/grouped/workspace?view=${view.id}`);
  for (const id of ['loss', 'rate', 'stack'])
    await expect(page.locator(`.chart[data-panel-id="${id}"] canvas`).first()).toBeVisible();
  await expect
    .poll(() => ['loss', 'rate', 'hits,total'].every((key) => responses.has(key)))
    .toBe(true);
  await expect(page.locator('.chart-status')).toHaveCount(0);
  const drawn = performance.now() - started;
  assert.equal(registrations.length, 1, 'panels share one selection registration');
  assert.equal(registrations[0].runs.length, total);
  assert.ok(charts.every((body) => body.selection && !body.runs));
  // Groups follow the run list order; sort them by name for the checks below.
  for (const data of responses.values()) {
    data.series.sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(
      data.series.map((series) => [series.name, series.runIds.length]),
      [
        ['narrow', total / 2],
        ['wide', total / 2],
      ],
    );
  }
  checks.push(
    `${total} grouped runs: one selection registration, three panels drawn in ${Math.round(drawn)} ms (database ${[
      ...responses.values(),
    ]
      .map((data) => Math.round(data.queryMs) + ' ms')
      .join(', ')})`,
  );
  // The selection's runs together exceed the 500,000-input budget, which applies per run.
  const rate = responses.get('rate');
  assert.ok(rate.series.every((series) => series.values.rate.length > 100));
  assert.ok(rate.series[0].values.rate.every((point) => point[1] === 0.25));
  assert.ok(rate.series[1].values.rate.every((point) => point[1] === 0.5));
  checks.push('grouped computed metric aggregates per-run results beyond the request budget');
  // About 190,000 distinct epochs per group, above the former 32,768 limit, stay aligned.
  const stack = responses.get('hits,total');
  for (const series of stack.series)
    assert.deepEqual(
      series.values.hits.map((point) => point[0]),
      series.values.total.map((point) => point[0]),
    );
  checks.push(
    `grouped stacked area buckets ${stack.series[0].values.hits.length} points per component`,
  );
  // Wall-clock positions never coincide between runs; buckets still aggregate many runs,
  // and the hover popup names how many.
  const loss = responses.get('loss'),
    counts = loss.series[0].bands.loss.map((band) => band[3]);
  assert.ok(
    counts.filter((count) => count > 100).length > counts.length / 2,
    'most buckets aggregate many runs',
  );
  const chart = page.locator('.chart[data-panel-id="loss"] canvas').first(),
    box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  const popup = page.locator('.plot-inspector[data-local="true"]');
  await expect(popup).toBeVisible();
  const members = await popup.locator('.plot-inspector-members').allTextContents();
  assert.equal(members.length, 2, members.join(' | '));
  for (const text of members) {
    const count = Number(/^Mean of ([\d,]+) runs?$/.exec(text)?.[1].replace(/,/g, ''));
    assert.ok(count > 1 && count <= total / 2, text);
  }
  checks.push(`hover names the aggregate and its runs: ${members.join(', ')}`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
