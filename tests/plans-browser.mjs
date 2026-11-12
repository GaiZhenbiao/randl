import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// The Plans page with synthetic hosts, runs and plans: the recipe and its history, one lane per
// host slot, and the GPU occupancy timeline (a `gpu-occupancy` panel) that scrolls and zooms
// through time and opens the run or plan behind a bar.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-plans-browser-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const origin = await listen(server);
  const call = (name, payload) => server.tools.execute(name, payload);
  const compute = (slot, gpus) => ({
    host: 'hostA',
    gpu_count: gpus.length,
    segments: [
      {
        from_update: 0,
        to_update: null,
        host: 'hostA',
        gpu_count: gpus.length,
        gpu_ids: gpus,
        gpu_model: 'Test GPU 24GB',
        slot,
      },
    ],
  });
  const seed = async (name, state, lineage, updates) => {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'plans',
      name,
      displayName: name,
      ...(state ? { state } : {}),
      config: { lineage: { value: lineage }, train: { value: { budget: 1000, start: 0 } } },
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: updates.map((update, index) => JSON.stringify({ _step: index, update })),
        },
      },
    });
    return run.id;
  };
  const done = await seed(
    'p1_done',
    'finished',
    { verdict: 'adopted', compute: compute('a12', [1, 2]) },
    [500, 1000],
  );
  const live = await seed('p2_live', null, { compute: compute('a12', [1, 2]) }, [250, 500]);
  // A running run that logs no compute block and carries no plan: its GPUs are unknown.
  const bare = await seed('p4_bare', null, {}, [250, 500]);
  // The finished run trained 10 to 4 hours ago; the live one started 2 hours ago.
  const now = Date.now() / 1000,
    hour = 3600,
    raw = new Database(join(directory, 'randl.sqlite3'));
  raw
    .prepare(
      "UPDATE runs SET state='finished',started=?,created=?,finished=?,heartbeat=? WHERE id=?",
    )
    .run(now - 10 * hour, now - 10 * hour, now - 4 * hour, now - 4 * hour, done);
  raw
    .prepare('UPDATE runs SET started=?,created=?,heartbeat=? WHERE id=?')
    .run(now - 2 * hour, now - 2 * hour, now, live);
  raw
    .prepare('UPDATE runs SET started=?,created=?,heartbeat=? WHERE id=?')
    .run(now - hour, now - hour, now, bare);
  raw.close();
  await call('project_lineage_settings_update', {
    id: 'test/plans',
    budgetKey: 'train.budget',
    startKey: 'train.start',
  });
  await call('recipe_set', { project: 'test/plans', run: done, reason: 'First adopted run' });
  await call('plan_save', {
    project: 'test/plans',
    id: 'p3',
    name: 'p3_next',
    host: 'hostA',
    slot: 'a12',
    queue: 1,
    hypothesis: 'A constant rate holds the gain.',
    baseline: done,
    rule: 'Stop if the audit falls below p1 at matched updates.',
  });

  // Queued after the run whose GPUs are unknown: it still waits for that run's end.
  await call('plan_save', {
    project: 'test/plans',
    id: 'p5',
    name: 'p5_after',
    host: 'hostB',
    gpus: [0],
    after: bare,
  });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${origin}/test/plans/plans`);

  // The recipe with its history, and the lane: the live run's progress and estimated end, then
  // the plan queued behind it with its hypothesis, baseline, stop rule and estimated start.
  await expect(page.locator('.recipe-tile')).toContainText('p1_done');
  await expect(page.locator('.recipe-timeline li')).toHaveCount(1);
  const lane = page.getByRole('region', { name: 'hostA · a12' });
  await expect(lane.locator('.plan-lane-head')).toContainText('GPUs 1, 2 · Test GPU 24GB');
  const running = lane.locator('.plan-running-card');
  await expect(running).toContainText('p2_live');
  await expect(running).toContainText('Update 500 of 1,000 (50%)');
  await expect(running).toContainText(/Estimated end.*\(in 2h\)/);
  const queued = lane.locator('.plan-card', { hasText: 'p3_next' });
  await expect(queued.locator('.plan-position')).toHaveText('1');
  await expect(queued).toContainText(/Starts about .* \(in 2h\)/);
  await expect(queued).toContainText('A constant rate holds the gain.');
  await expect(queued).toContainText('Stop if the audit falls below p1');
  await expect(queued.getByRole('link', { name: 'p1_done' })).toBeVisible();
  // The run without a compute block: named in the timeline's note, in a lane of its own, and
  // still holding back the plan queued after it (500 of 1000 updates in an hour: 1 h more).
  await expect(page.locator('.occupancy-note')).toHaveText(
    '1 running run logs no GPUs, so it is not shown: p4',
  );
  const loose = page.getByRole('region', { name: 'No host or slot' });
  await expect(loose.locator('.plan-running-card')).toContainText('p4_bare');
  await expect(loose.locator('.plan-running-card')).toContainText('Not logged');
  await expect(
    page.getByRole('region', { name: 'hostB' }).locator('.plan-card', { hasText: 'p5_after' }),
  ).toContainText(/Starts about .* \(in 1h\)/);
  checks.push('Lanes show the running run’s progress and end, then queued plans with their start');

  // The timeline: GPU rows 0 to 2 of hostA, a bar of each kind and the now line.
  const timeline = page.locator('.occupancy');
  await expect(timeline.locator('.occupancy-host')).toHaveText([/hostA/, /hostB/]);
  await expect(timeline.locator('.occupancy-row-label')).toHaveText([
    'GPU 0',
    'GPU 1',
    'GPU 2',
    'GPU 0',
  ]);
  for (const [kind, count] of [
    ['past', 1],
    ['running', 1],
    ['remaining', 1],
    ['planned', 2],
  ])
    await expect(timeline.locator('.occupancy-track .kind-' + kind)).toHaveCount(count);
  await expect(timeline.locator('.occupancy-track .kind-past')).toHaveClass(/verdict-adopted/);
  await expect(timeline.locator('.occupancy-now')).toHaveCount(1);
  // Bars cover both GPUs as one block; the plan follows the running run's estimated end.
  const box = async (kind) =>
    timeline
      .locator(kind === 'planned' ? '[data-id="plan:p3"]' : '.occupancy-track .kind-' + kind)
      .boundingBox();
  const [past, remaining, planned] = [
    await box('past'),
    await box('remaining'),
    await box('planned'),
  ];
  assert.ok(past.height > 40, 'a two-GPU bar spans two rows');
  assert.ok(Math.abs(planned.x - (remaining.x + remaining.width)) < 4);
  checks.push('The timeline shows GPU rows by host, bars by kind, the now line and the queue');

  // It scrolls sideways; the buttons and Ctrl+wheel zoom in time.
  const scroller = timeline.locator('.occupancy-scroll');
  const width = () => timeline.locator('.occupancy-content').evaluate((el) => el.offsetWidth);
  const before = await width();
  await timeline.getByRole('button', { name: 'Zoom in on time' }).click();
  await expect.poll(width).toBeGreaterThan(before);
  // Zoomed in, the timeline is wider than its view and scrolls sideways.
  const [scrollWidth, clientWidth, start] = await scroller.evaluate((el) => [
    el.scrollWidth,
    el.clientWidth,
    el.scrollLeft,
  ]);
  assert.ok(scrollWidth > clientWidth, 'the timeline is wider than its view');
  await scroller.evaluate((el) => (el.scrollLeft -= 200));
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeLessThan(start);
  const zoomed = await width();
  const view = await scroller.boundingBox();
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');
  await expect.poll(width).toBeLessThan(zoomed);
  await timeline.getByRole('button', { name: 'Go to now' }).click();
  checks.push('The timeline scrolls sideways and zooms with its buttons and Ctrl+wheel');

  // A run's bar opens its run; a plan's bar opens the plan.
  await timeline.locator('.occupancy-track .kind-past').hover();
  await expect(timeline.locator('.occupancy-tooltip')).toContainText('p1_done');
  await expect(timeline.locator('.occupancy-tooltip')).toContainText('Adopted');
  await timeline.locator('[data-id="plan:p3"]').click();
  const dialog = page.getByRole('dialog', { name: 'Edit plan' });
  await expect(dialog.getByLabel('Run name')).toHaveValue('p3_next');
  // Naming its GPUs moves it to them.
  await dialog.getByLabel('GPUs').fill('0, 1');
  await dialog.getByLabel('Updates to train').fill('500');
  await dialog.getByRole('button', { name: 'Save plan' }).click();
  await expect(dialog).toBeHidden();
  const { plans } = await call('plans_list', { project: 'test/plans' });
  const saved = plans.find((item) => item.id === 'p3');
  assert.deepEqual(saved.gpus, [0, 1]);
  assert.equal(saved.updates, 500);
  await expect.poll(async () => (await box('planned')).y).toBeLessThan((await box('remaining')).y);
  await timeline.locator('.occupancy-track .kind-past').click();
  await expect(page).toHaveURL(/\/test\/plans\/runs\/p1_done/);
  checks.push('Bars open their run or plan; a plan given GPUs moves to those rows');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
