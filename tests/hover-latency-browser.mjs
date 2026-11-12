import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Hover budgets on a large workspace at a high-density display: 600 runs with 45 shown,
// twelve line panels (some smoothed with their original traces), measured as main-thread
// task time per hover from the browser's own counters. Hovering a run in the list highlights
// it in every chart, and moving over a chart moves every chart's cursor; both used to redraw
// each chart's canvas on every step, including charts off screen.
const RUN_LIST_BUDGET_MS = Number(process.env.RUN_LIST_BUDGET_MS ?? 25),
  CHART_MOVE_BUDGET_MS = Number(process.env.CHART_MOVE_BUDGET_MS ?? 55),
  RUNS = 600,
  SHOWN = 45,
  POINTS = Number(process.env.HOVER_POINTS ?? 300);
const directory = await mkdtemp(join(tmpdir(), 'randl-hover-latency-'));
const store = new Store(directory);
const runIds = [];
store.db.transaction(() => {
  for (let index = 0; index < RUNS; index++) {
    const run = store.upsert({
      entity: 'test',
      project: 'hover',
      name: `run-${String(index).padStart(4, '0')}`,
      displayName: `v${index}_latched_const1e6_yaw02_lacmd_box_lsfloor35_seed${51000 + index}`,
      config: { seed: { value: index } },
    });
    store.db
      .prepare("UPDATE runs SET state='finished',created=? WHERE id=?")
      .run(1_700_000_000 + index, run.id);
    if (index < SHOWN)
      store.ingest(run.id, {
        files: {
          'wandb-history.jsonl': {
            offset: 0,
            content: Array.from({ length: POINTS }, (_, step) =>
              JSON.stringify({
                _step: step,
                update: step * 1000,
                loss: 1 / (step + 1 + index) + Math.sin(step / 7 + index) * 0.01,
                reward: Math.log(step + 2) + index / 100 + Math.cos(step / 5) * 0.05,
                rate: Math.min(1, step / POINTS + index / 200),
              }),
            ),
          },
        },
      });
    runIds.push(run.id);
  }
})();
store.db.close();
let server, browser;
const errors = [];
try {
  // HOVER_FRONTEND measures another build of the interface, such as an older one.
  server = await createServer(
    directory,
    process.env.HOVER_FRONTEND ? { frontend: process.env.HOVER_FRONTEND } : undefined,
  );
  const base = await listen(server);
  const metrics = ['loss', 'reward', 'rate'];
  const panels = Array.from({ length: 12 }, (_, index) => ({
    id: 'p' + index,
    section: 's0',
    plugin: 'line',
    metric: metrics[index % 3],
    metrics: [metrics[index % 3]],
    title: metrics[index % 3] + ' ' + index,
    settings: {
      xAxis: 'update',
      ...(index % 2 ? { smoothingMethod: 'twema', smoothingValue: 0.9 } : {}),
    },
  }));
  const view = await server.tools.execute('view_create', {
    project: 'test/hover',
    name: 'Hover latency',
    body: {
      generation: 'manual',
      panels,
      visible: runIds.slice(0, SHOWN),
      solo: [],
      sections: [{ id: 's0', name: 'Charts' }],
      plotSettings: { showOriginal: true, tooltipColoredNames: true },
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/test/hover/workspace?view=${view.id}`);
  await page.waitForSelector('.run-name');
  await page.waitForFunction(
    () => document.querySelectorAll('.panel canvas, .chart canvas').length >= 4,
    null,
    {
      timeout: 30000,
    },
  );
  await page.waitForTimeout(3000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const taskTime = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
  const frames = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const rows = page.locator('.run-name');
  const boxes = [];
  for (let index = 0; index < 20; index++) boxes.push(await rows.nth(index).boundingBox());
  // A sweep as a reader makes one: a step every frame, then the work it left behind once the
  // pointer rests, spread over its steps.
  const measure = async (steps, move) => {
    for (let index = 0; index < 3; index++) await move(index);
    await page.waitForTimeout(300);
    const before = await taskTime();
    for (let index = 0; index < steps; index++) {
      await move(index);
      await frames();
    }
    await page.waitForTimeout(300);
    return (((await taskTime()) - before - 0) * 1000) / steps;
  };
  const runList = await measure(20, (index) =>
    page.mouse.move(boxes[index].x + 24, boxes[index].y + boxes[index].height / 2),
  );
  const chart = await page.locator('.panel canvas, .chart canvas').first().boundingBox();
  if (process.env.HOVER_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const chartMove = await measure(24, (index) =>
    page.mouse.move(chart.x + 60 + index * ((chart.width - 120) / 24), chart.y + chart.height / 2),
  );
  if (process.env.HOVER_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    (await import('node:fs')).writeFileSync(process.env.HOVER_PROFILE, JSON.stringify(profile));
  }
  const report = {
    runListHoverMs: Math.round(runList * 10) / 10,
    chartMoveMs: Math.round(chartMove * 10) / 10,
    budgets: { runList: RUN_LIST_BUDGET_MS, chartMove: CHART_MOVE_BUDGET_MS },
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(
    runList <= RUN_LIST_BUDGET_MS,
    `run-list hover took ${runList.toFixed(1)} ms of main-thread work`,
  );
  assert.ok(
    chartMove <= CHART_MOVE_BUDGET_MS,
    `chart move took ${chartMove.toFixed(1)} ms of main-thread work`,
  );
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
