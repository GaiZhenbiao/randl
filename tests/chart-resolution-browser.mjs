import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect, request } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';

// Resolution levels, refinement on enlarging, live deltas and progressive drawing.
// npm run build
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/chart-resolution-browser.mjs
const expect = playwrightExpect.configure({ timeout: 20000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-resolution-'));
let backend, api, browser;
const checked = [];

try {
  backend = await createServer(directory);
  // Chart responses as the server sent them, streamed or not, for the page under test.
  let sent = [];
  await backend.app.listen({ host: '127.0.0.1', port: 0 });
  backend.app.server.on('request', (req, res) => {
    if (req.url !== '/api/chart') return;
    const list = sent,
      chunks = [],
      write = res.write.bind(res),
      end = res.end.bind(res);
    res.write = (chunk, ...rest) => {
      chunks.push(Buffer.from(chunk));
      return write(chunk, ...rest);
    };
    res.end = (chunk, ...rest) => {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString(),
        first = JSON.parse(text.split('\n')[0]);
      list.push({
        metric: (first.metadata || first).metrics?.[0],
        text,
        points: responsePoints(text),
      });
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
  const scope = 'browser-resolution/fixture';
  const value = (step, run) => Math.exp(-step / 6000) + 0.1 * Math.sin(step * 1.7 + run) + run / 10;
  const levels = ['low', 'medium', 'high', 'full'];
  // Each level plots its own copy of the metric: a stored finer response for the same
  // metric would otherwise stand in for a coarser panel without a request.
  const row = (step, loss, metrics) =>
    JSON.stringify({ _step: step, ...Object.fromEntries(metrics.map((m) => [m, loss])) });
  const seed = async (name, steps, run, metrics = ['loss']) => {
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: { entity: 'browser-resolution', project: 'fixture', name },
    });
    for (let offset = 0; offset < steps; offset += 5000)
      await call(`/files/${scope}/${name}/file_stream`, {
        files: {
          'wandb-history.jsonl': {
            offset,
            content: Array.from({ length: Math.min(5000, steps - offset) }, (_, i) =>
              row(offset + i, value(offset + i, run), metrics),
            ),
          },
        },
      });
    return scope + '/' + name;
  };
  const single = await seed(
    'single',
    20000,
    0,
    levels.map((level) => 'loss/' + level),
  );
  const many = [];
  for (let run = 0; run < 48; run++)
    many.push(await seed('many-' + String(run).padStart(2, '0'), 10000, run));
  const createView = async (name, visible, panels, layout) => {
    const view = await call('/api/tools/view_create', { project: scope, name });
    view.body.visible = visible;
    view.body.generation = 'manual';
    view.body.sections = [{ id: 'charts', name: 'Charts' }];
    view.body.sectionLayouts = { charts: layout };
    view.body.panels = panels.map((panel) => ({
      plugin: 'line',
      metric: 'loss',
      metrics: ['loss'],
      section: 'charts',
      ...panel,
      settings: { smoothingMethod: 'none', ...panel.settings },
    }));
    await call(
      '/api/views/' + view.id,
      { name: view.name, project: view.project, version: view.version, body: view.body },
      'PUT',
    );
    return view;
  };
  const levelsView = await createView(
    'Levels',
    [single],
    levels.map((resolution) => ({
      id: resolution,
      title: resolution,
      metric: 'loss/' + resolution,
      metrics: ['loss/' + resolution],
      settings: { resolution },
    })),
    { width: 320, height: 300, rows: 2 },
  );
  // The high panel is alone in its family, so no finer stored response can stand in
  // for it; the others keep it to a third of the width.
  const refineView = await createView(
    'Refine',
    [single],
    ['high', 'low', 'medium'].map((level) => ({
      id: level,
      title: level,
      metric: 'loss/' + level,
      metrics: ['loss/' + level],
      settings: { resolution: level },
    })),
    { width: 320, height: 300, rows: 1 },
  );
  const progressView = await createView(
    'Progressive',
    many,
    [{ id: 'all', title: 'All points', settings: { resolution: 'full', legend: true } }],
    { width: 900, height: 420, rows: 1 },
  );

  browser = await launchBrowser();
  // Points carried by a chart response, whether whole, streamed or a delta.
  const changesOf = (text) =>
    text
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => JSON.parse(line).changed || []);
  function responsePoints(text) {
    let total = 0;
    const add = (series) => {
      for (const points of Object.values(series.values)) total += points.length;
    };
    for (const line of text.split('\n').filter(Boolean)) {
      const value = JSON.parse(line);
      value.series?.forEach(add);
      for (const change of value.changed || [])
        if (change.replace) add(change.replace);
        else
          for (const patch of Object.values(change.metrics))
            total += (patch.upsert || patch.replace || []).length;
    }
    return total;
  }
  const open = async (view, width, deviceScaleFactor = 1) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor });
    const charts = (sent = []),
      requests = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/chart') requests.push(JSON.parse(r.postData()));
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseURL}/${scope}/workspace?view=${view.id}`);
    // A response's request: they pair up per metric in order.
    const bodyOf = (chart) =>
      requests.filter((body) => body.metrics[0] === chart.metric)[
        charts.filter((c) => c.metric === chart.metric).indexOf(chart)
      ];
    return { page, charts, errors, bodyOf };
  };
  const settled = async (page, id) => {
    const panel = page.locator(`[data-panel-id="${id}"]`);
    await expect(panel.locator('canvas').first()).toBeVisible();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect(panel.locator('.chart-status')).toHaveCount(0);
  };
  const quiet = async (charts) => {
    let before;
    do {
      before = charts.length;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (charts.length !== before);
  };

  // Each level draws more points; only “No downsampling” returns every point.
  const wide = await open(levelsView, 1440);
  for (const id of levels) await settled(wide.page, id);
  await quiet(wide.charts);
  const byLevel = Object.fromEntries(
    wide.charts.map((chart) => [chart.metric.split('/')[1], chart]),
  );
  assert.deepEqual(
    Object.keys(byLevel).sort(),
    [...levels].sort(),
    JSON.stringify(wide.charts.map((c) => [c.metric, c.points])),
  );
  const counts = levels.map((level) => byLevel[level].points);
  assert.ok(
    counts.every((count, i) => !i || count > counts[i - 1]),
    `point counts rise with resolution: ${counts}`,
  );
  assert.equal(byLevel.full.points, 20000);
  const highPixels = wide.bodyOf(byLevel.high).pixels;
  assert.ok(byLevel.high.points <= 2 * 2 * highPixels + 2, 'High: two min/max buckets per pixel');
  checked.push(`levels: ${counts.join(' < ')} points at ${highPixels} CSS px`);

  // Density changes canvas rendering, not the CSS-width budget or returned points.
  const dense = await open(levelsView, 1440, 2);
  for (const id of levels) await settled(dense.page, id);
  await quiet(dense.charts);
  for (const level of levels) {
    const chart = dense.charts.find((chart) => chart.metric === 'loss/' + level);
    assert.equal(dense.bodyOf(chart).pixels, wide.bodyOf(byLevel[level]).pixels, level);
    assert.equal(chart.points, byLevel[level].points, `${level}: DPR-independent points`);
  }
  checked.push(`DPR 2 matches DPR 1 pixels and points at every level, including Full`);
  assert.deepEqual(dense.errors, []);
  await dense.page.close();

  {
    // A live update sends only the new step to each visible panel.
    const { page, charts } = wide;
    sent = charts;
    let from = charts.length;
    await call(`/files/${scope}/single/file_stream`, {
      files: {
        'wandb-history.jsonl': {
          offset: 20000,
          content: [
            row(
              20000,
              9,
              levels.map((level) => 'loss/' + level),
            ),
          ],
        },
      },
    });
    await expect.poll(() => charts.length).toBe(from + levels.length);
    for (const id of levels) await settled(page, id);
    await quiet(charts);
    const live = charts.slice(from);
    assert.equal(live.length, levels.length);
    for (const chart of live) {
      assert.ok(wide.bodyOf(chart).baseRevision);
      assert.ok(chart.text.length < 1500, `live delta is ${chart.text.length} bytes`);
      const update = changesOf(chart.text);
      assert.equal(update.length, 1);
      assert.deepEqual(Object.values(update[0].metrics)[0].upsert.at(-1), [20000, 9]);
    }
    const [fullUpdate] = changesOf(live.find((c) => c.metric === 'loss/full').text);
    assert.deepEqual(fullUpdate.metrics['loss/full'], {
      upsert: [[20000, 9]],
      remove: [],
    });
    checked.push(
      `live update: ${live.map((chart) => chart.text.length).join(', ')} bytes per panel`,
    );
    assert.deepEqual(wide.errors, []);
    await page.close();
  }
  let fullscreenPixels;
  for (const dpr of [1, 2]) {
    // Full screen fetches only the points the panel lacks; returning needs nothing.
    const refined = await open(refineView, 1440, dpr);
    const { page, charts } = refined;
    for (const id of ['high', 'low', 'medium']) await settled(page, id);
    await quiet(charts);
    let from = charts.length;
    const high = page.locator('[data-panel-id="high"]');
    await high.hover();
    await high.locator('.chart-expand').click();
    await expect(page.locator('[data-panel-id="high"].fullscreen')).toBeVisible();
    await expect.poll(() => charts.length).toBe(from + 1);
    await settled(page, 'high');
    await quiet(charts);
    const enlarged = charts.slice(from);
    assert.equal(enlarged.length, 1, 'one refinement request');
    const [refinement] = enlarged;
    assert.ok(refined.bodyOf(refinement).pixels > highPixels);
    if (dpr === 1) fullscreenPixels = refined.bodyOf(refinement).pixels;
    else assert.equal(refined.bodyOf(refinement).pixels, fullscreenPixels);
    assert.ok(
      refined.bodyOf(refinement).baseRevision,
      'refinement is diffed against the drawn points',
    );
    const lines = refinement.text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const changes = lines.flatMap((line) => line.changed || []);
    assert.ok(
      lines.some((line) => line.delta || line.metadata),
      'a delta, not a full response',
    );
    assert.ok(
      changes.every((change) => !change.replace && change.metrics['loss/high'].remove.length === 0),
      'refining only adds points',
    );
    const added = changes.reduce(
      (sum, change) => sum + change.metrics['loss/high'].upsert.length,
      0,
    );
    assert.ok(added > 0 && added < 20000);
    from = charts.length;
    await page.keyboard.press('Escape');
    await expect(page.locator('.chart.fullscreen')).toHaveCount(0);
    await quiet(charts);
    assert.equal(charts.length, from, 'shrinking reuses the finer points');
    checked.push(`DPR ${dpr} full screen: one request adding ${added} points; restoring: none`);
    assert.deepEqual(refined.errors, []);
    await page.close();
  }
  // Runs are drawn as they arrive; the legend spans every run throughout, so its
  // (virtualized) track keeps one width.
  const progress = await open(progressView, 1440);
  const panel = progress.page.locator('[data-panel-id="all"]');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  const early = await progress.page.waitForFunction(
    () => {
      const article = document.querySelector('[data-panel-id="all"]');
      return (
        article.getAttribute('aria-busy') === 'true' &&
        article.querySelector('canvas') &&
        !article.querySelector('.chart-status') &&
        article.querySelector('.chart-legend-track')?.style.width
      );
    },
    null,
    { polling: 5 },
  );
  const legendWhileStreaming = await early.jsonValue();
  await settled(progress.page, 'all');
  assert.equal(
    await panel.locator('.chart-legend-track').evaluate((track) => track.style.width),
    legendWhileStreaming,
    'the legend does not grow as runs arrive',
  );
  const [streamed] = progress.charts;
  const lines = streamed.text.split('\n').filter(Boolean).length;
  assert.ok(lines > 3, 'the response streamed');
  assert.equal(streamed.points, 480000);
  assert.deepEqual(progress.errors, []);
  checked.push(
    `progressive: drawn while loading from ${lines} lines; legend width ${legendWhileStreaming} throughout`,
  );
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
