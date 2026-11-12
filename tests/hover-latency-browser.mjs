import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Hover budgets on a large workspace at a high-density display: 600 runs with 45 shown, each
// with a lineage block the size real ones have, and twelve line panels (some smoothed with
// their original traces). Measured twice: main-thread work per step from the browser's own
// counters, and, with the GPU compositing path (SwiftShader), the time from a pointer move to
// the second frame after it, which is where redrawing chart canvases shows. Hovering a run in
// the list highlights it in every chart and moving over a chart moves every chart's cursor;
// both used to redraw each chart's canvas at device resolution on every step.
const RUN_LIST_BUDGET_MS = Number(process.env.RUN_LIST_BUDGET_MS ?? 25),
  CHART_MOVE_BUDGET_MS = Number(process.env.CHART_MOVE_BUDGET_MS ?? 55),
  RUN_LIST_LATENCY_MS = Number(process.env.RUN_LIST_LATENCY_MS ?? 150),
  CHART_LATENCY_MS = Number(process.env.CHART_LATENCY_MS ?? 300),
  HEAP_BUDGET_MB = Number(process.env.HEAP_BUDGET_MB ?? 60),
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
      // A lineage block as backfilled ones are: changes, compute segments and text.
      config: {
        seed: { value: index },
        lineage: {
          value: {
            parent: { run_name: `v${index - 1}`, update: 500000 + index },
            changes: Object.fromEntries(
              Array.from({ length: 40 }, (_, key) => [
                `rl.algorithm.setting_${key}`,
                { from: key / 10, to: key / 10 + 0.5 },
              ]),
            ),
            compute: {
              host: 'host' + (index % 3),
              gpu_count: 2,
              segments: [
                {
                  from_update: 0,
                  to_update: null,
                  host: 'host' + (index % 3),
                  gpu_count: 2,
                  gpu_ids: [0, 1],
                  gpu_model: 'RTX 4090 48GB',
                },
              ],
            },
            hypothesis: 'A longer horizon steadies the critic. '.repeat(30),
            result: 'Holds rose at matched updates. '.repeat(30),
          },
        },
      },
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
  const measureIn = async (browser) => {
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
      { timeout: 30000 },
    );
    await page.waitForTimeout(3000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576;
    const taskTime = async () =>
      (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')
        .value;
    const frames = () =>
      page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now()))),
          ),
      );
    const rows = page.locator('.run-name');
    const boxes = [];
    for (let index = 0; index < 20; index++) boxes.push(await rows.nth(index).boundingBox());
    // A sweep as a reader makes one: a step every frame, then the work it left behind once the
    // pointer rests, spread over its steps; and the median time to the second frame per step.
    const measure = async (steps, move) => {
      for (let index = 0; index < 3; index++) await move(index);
      await page.waitForTimeout(300);
      const before = await taskTime(),
        latencies = [];
      for (let index = 0; index < steps; index++) {
        const start = await page.evaluate(() => performance.now());
        await move(index);
        latencies.push((await frames()) - start);
      }
      await page.waitForTimeout(300);
      latencies.sort((a, b) => a - b);
      return {
        work: (((await taskTime()) - before) * 1000) / steps,
        latency: latencies[Math.floor(latencies.length / 2)],
      };
    };
    const runList = await measure(20, (index) =>
      page.mouse.move(boxes[index].x + 24, boxes[index].y + boxes[index].height / 2),
    );
    const chart = await page.locator('.panel canvas, .chart canvas').first().boundingBox();
    const chartMove = await measure(24, (index) =>
      page.mouse.move(
        chart.x + 60 + index * ((chart.width - 120) / 24),
        chart.y + chart.height / 2,
      ),
    );
    await page.close();
    return { heap, runList, chartMove };
  };
  const round = (value) => Math.round(value * 10) / 10;
  browser = await launchBrowser();
  const plain = await measureIn(browser);
  await browser.close();
  browser = await launchBrowser({
    args: ['--enable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const gpu = await measureIn(browser);
  const report = {
    heapMB: round(plain.heap),
    runListHoverMs: round(plain.runList.work),
    chartMoveMs: round(plain.chartMove.work),
    gpuRunListLatencyMs: round(gpu.runList.latency),
    gpuChartLatencyMs: round(gpu.chartMove.latency),
    budgets: {
      heap: HEAP_BUDGET_MB,
      runList: RUN_LIST_BUDGET_MS,
      chartMove: CHART_MOVE_BUDGET_MS,
      runListLatency: RUN_LIST_LATENCY_MS,
      chartLatency: CHART_LATENCY_MS,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(plain.heap <= HEAP_BUDGET_MB, `the workspace holds ${round(plain.heap)} MB of heap`);
  assert.ok(
    plain.runList.work <= RUN_LIST_BUDGET_MS,
    `run-list hover took ${round(plain.runList.work)} ms of main-thread work`,
  );
  assert.ok(
    plain.chartMove.work <= CHART_MOVE_BUDGET_MS,
    `chart move took ${round(plain.chartMove.work)} ms of main-thread work`,
  );
  assert.ok(
    gpu.runList.latency <= RUN_LIST_LATENCY_MS,
    `run-list hover took ${round(gpu.runList.latency)} ms to its second frame`,
  );
  assert.ok(
    gpu.chartMove.latency <= CHART_LATENCY_MS,
    `chart move took ${round(gpu.chartMove.latency)} ms to its second frame`,
  );
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
