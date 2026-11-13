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
    estimated_hours: 3,
  });

  // The GPU inventory: three GPUs on hostA, one on hostB, and one on hostR kept for others.
  await call('gpus_save', {
    project: 'test/plans',
    host: 'hostA',
    gpus: [0, 1, 2],
    model: 'Test GPU',
    memory_gb: 24,
  });
  await call('gpus_save', { project: 'test/plans', host: 'hostB', gpus: [0], memory_gb: 24 });
  await call('gpus_save', {
    project: 'test/plans',
    host: 'hostR',
    gpus: [0],
    memory_gb: 80,
    allowed: false,
  });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${origin}/test/plans/plans`);

  // The recipe with its history, then the queue: the running runs with their progress and
  // end, then the waiting plans in claim order, each with its GPU request and projected start.
  await expect(page.locator('.recipe-tile')).toContainText('p1_done');
  await expect(page.locator('.recipe-timeline')).toHaveCount(0);
  await page.getByRole('button', { name: '1 promotion' }).click();
  await expect(page.locator('.side-drawer .recipe-timeline li')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.side-drawer')).toHaveCount(0);
  const queue = page.locator('.plan-queue');
  const running = queue.locator('.queue-running', { hasText: 'p2_live' });
  await expect(running).toContainText('Update 500 of 1,000 (50%)');
  await expect(running).toContainText('ends in 2h');
  await expect(running.locator('td.queue-col-gpus')).toContainText('hostA · GPUs 1, 2');
  // p3 was saved with slot a12, which last ran on two GPUs: it asks for two on hostA.
  const queued = queue.locator('.plan-row', { hasText: 'p3_next' });
  await expect(queued.locator('td.queue-col-gpus')).toContainText('2 GPUs · hostA');
  await expect(queued).toContainText(/in 2h · runs about/);
  await expect(queued.locator('td.queue-col-gpus')).toContainText('hostA · GPUs 0, 1');
  // Its hypothesis, stop rule and baseline open under it.
  await queued.getByRole('button', { name: 'p3_next' }).click();
  const details = queue.locator('#plan-details-p3');
  await expect(details).toContainText('A constant rate holds the gain.');
  await expect(details).toContainText('Stop if the audit falls below p1');
  await expect(details.getByRole('link', { name: 'p1_done' })).toBeVisible();
  // The run without a compute block: named in the timeline's note, listed as running, and
  // still holding back the plan queued after it (500 of 1000 updates in an hour: 1 h more).
  await expect(page.locator('.occupancy-note')).toHaveText(
    '1 running run logs no GPUs, so it is not shown: p4',
  );
  await expect(queue.locator('.queue-running', { hasText: 'p4_bare' })).toContainText('Not logged');
  // p5, queued after it, goes first in claim order and starts on hostB when it ends.
  await expect(queue.locator('.plan-row.status-planned .queue-name')).toHaveText([
    'p5_after',
    'p3_next',
  ]);
  await expect(queue.locator('.plan-row', { hasText: 'p5_after' })).toContainText(
    /in 1h · runs 3h, as its plan estimates/,
  );
  // The GPU strip: each host's GPUs now, the reserved host last.
  const strip = page.locator('.gpu-host');
  await expect(strip.locator('strong')).toHaveText(['hostA', 'hostB', 'hostR']);
  await expect(strip.nth(0).locator('.gpu-cell')).toHaveClass([
    /state-free/,
    /state-running/,
    /state-running/,
  ]);
  await expect(strip.nth(2)).toContainText('Not for plans');
  checks.push('The queue shows runs on their GPUs, then plans with their request and start');

  // The timeline: each host's GPUs from the inventory, reserved ones marked, a bar of each
  // kind, the now line, and a line from the run to the plan that takes its GPUs next.
  const timeline = page.locator('.occupancy');
  await expect(timeline.locator('.occupancy-host')).toHaveText([/hostA/, /hostB/, /hostR/]);
  await expect(timeline.locator('.occupancy-row-label')).toHaveText([
    'GPU 0',
    'GPU 1',
    'GPU 2',
    'GPU 0',
    'GPU 0',
  ]);
  await expect(timeline.locator('.occupancy-row-label.reserved')).toHaveCount(1);
  for (const [kind, count] of [
    ['past', 1],
    ['running', 1],
    ['remaining', 1],
    ['planned', 2],
  ])
    await expect(timeline.locator('.occupancy-track .kind-' + kind)).toHaveCount(count);
  await expect(timeline.locator('.occupancy-track .kind-past')).toHaveClass(/verdict-adopted/);
  await expect(timeline.locator('.occupancy-now')).toHaveCount(1);
  // The panel is as tall as its rows: no scrolling inside it but sideways.
  const fit = await timeline
    .locator('.occupancy-scroll')
    .evaluate((el) => [el.scrollHeight, el.clientHeight, getComputedStyle(el).overflowY]);
  assert.ok(fit[0] <= fit[1] + 1 && fit[2] === 'hidden', JSON.stringify(fit));
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
  // The panel's title and its legend sit 8 px in from its border, as in the workspace.
  const insets = await page.locator('.plans-occupancy .chart').evaluate((element) => {
    const box = element.getBoundingClientRect(),
      range = document.createRange();
    range.selectNodeContents(element.querySelector('.chart-title'));
    return [range, element.querySelector('.occupancy-legend')].map((item) =>
      Math.round(item.getBoundingClientRect().left - box.left),
    );
  });
  assert.deepEqual(insets, [9, 9]);
  checks.push('The timeline shows GPU rows by host, bars by kind, and the projected order');

  // It scrolls sideways; the buttons and Ctrl+wheel zoom in time.
  const scroller = timeline.locator('.occupancy-scroll');
  const width = () => timeline.locator('.occupancy-content').evaluate((el) => el.offsetWidth);
  const before = await width();
  await timeline.getByRole('button', { name: 'Zoom in on time' }).click();
  await expect.poll(width).toBeGreaterThan(before);
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

  // A run's bar opens its run; a plan's bar opens the plan, whose GPU request is edited.
  await timeline.locator('.occupancy-track .kind-past').hover();
  await expect(timeline.locator('.occupancy-tooltip')).toContainText('p1_done');
  await expect(timeline.locator('.occupancy-tooltip')).toContainText('Adopted');
  await timeline.locator('[data-id="plan:p3"]').click();
  const dialog = page.getByRole('dialog', { name: 'Edit plan' });
  await expect(dialog.getByLabel('Run name')).toHaveValue('p3_next');
  await expect(dialog.getByLabel('GPUs', { exact: true })).toHaveValue('2');
  await expect(dialog.getByRole('checkbox', { name: 'hostA' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'hostR' })).toHaveCount(0);
  // One GPU fits hostA's free GPU 0 now.
  await dialog.getByLabel('GPUs', { exact: true }).fill('1');
  await dialog.getByLabel('Minimum memory (GB)').fill('16');
  await dialog.getByLabel('Updates to train').fill('500');
  await dialog.getByRole('button', { name: 'Save plan' }).click();
  await expect(dialog).toBeHidden();
  const { plans } = await call('plans_list', { project: 'test/plans' });
  const saved = plans.find((item) => item.id === 'p3');
  assert.deepEqual(saved.resources, { gpus: 1, min_memory_gb: 16, hosts: ['hostA'] });
  assert.equal(saved.updates, 500);
  await expect
    .poll(async () => ((await box('planned'))?.y ?? Infinity) - ((await box('remaining'))?.y ?? 0))
    .toBeLessThan(0);
  await expect(queue.locator('.plan-row', { hasText: 'p3_next' })).toContainText('Now');
  await timeline.locator('.occupancy-track .kind-past').click();
  await expect(page).toHaveURL(/\/test\/plans\/runs\/p1_done/);
  checks.push('Bars open their run or plan; a plan asking for fewer GPUs starts on a free one');

  // The queue reorders by dragging or with the Earlier button; a host agent's claim shows
  // on its GPUs; finished plans go to the history.
  for (const [id, position] of [
    ['q4', 2],
    ['q5', 3],
  ])
    await call('plan_save', {
      project: 'test/plans',
      id,
      name: id + '_next',
      queue: position,
      resources: { gpus: 1, hosts: ['hostA'] },
    });
  await page.goto(`${origin}/test/plans/plans`);
  const order = async () =>
    (await call('plan_queue', { project: 'test/plans' })).plans.map((plan) => plan.id);
  await expect(queue.locator('#plan-q5')).toBeVisible();
  assert.deepEqual(await order(), ['p5', 'p3', 'q4', 'q5']);
  await queue
    .locator('#plan-q5')
    .dragTo(queue.locator('#plan-p3'), { targetPosition: { x: 200, y: 4 } });
  await expect.poll(order).toEqual(['p5', 'q5', 'p3', 'q4']);
  await expect(queue.locator('.plan-position')).toHaveText(['1', '2', '3', '4']);
  await queue
    .locator('#plan-q4')
    .getByRole('button', { name: 'Move earlier in the queue' })
    .click();
  await expect.poll(order).toEqual(['p5', 'q5', 'q4', 'p3']);
  // A host agent on hostA with GPU 0 free: p5 is for hostB, so q5 takes GPU 0.
  const claim = await call('plan_claim', {
    project: 'test/plans',
    host: 'hostA',
    free_gpus: [0],
    by: 'agent-a',
  });
  assert.deepEqual([claim.plan.id, claim.gpu_ids], ['q5', [0]]);
  await page.reload();
  const claimedRow = queue.locator('#plan-q5');
  await expect(claimedRow).toContainText('Claimed');
  await expect(claimedRow).toContainText('by agent-a on hostA');
  await expect(claimedRow.locator('td.queue-col-gpus')).toContainText('hostA · GPUs 0');
  await expect(strip.nth(0).locator('.gpu-cell').first()).toHaveClass(/state-claimed/);
  // A plan no host can run is marked, in the queue and under the timeline.
  await call('plan_save', {
    project: 'test/plans',
    id: 'huge',
    name: 'huge_plan',
    resources: { gpus: 8 },
  });
  await page.reload();
  await expect(queue.locator('#plan-huge td.queue-col-when')).toHaveText(
    'No host has enough matching GPUs',
  );
  await expect(page.locator('.occupancy-note')).toContainText('1 plan fits no host: huge');
  // A cancelled plan leaves the queue for the history, opened from the header rail: plans
  // that are over, filtered by status and searched, each read beside the list.
  await call('plan_save', { project: 'test/plans', id: 'p3', status: 'cancelled' });
  await page.reload();
  await expect(queue.locator('#plan-q4')).toBeVisible();
  await expect(queue.locator('#plan-p3')).toHaveCount(0);
  const over = (await call('plans_list', { project: 'test/plans' })).plans.filter((plan) =>
    ['done', 'stopped', 'cancelled'].includes(plan.status),
  ).length;
  const historyButton = page
    .locator('.page-rail-controls')
    .getByRole('button', { name: /History/ });
  await expect(historyButton).toContainText(String(over));
  await historyButton.click();
  const history = page.getByRole('dialog', { name: 'Plan history' });
  await expect(history).toBeVisible();
  const rows = history.locator('.plan-history-row');
  await expect(rows).toHaveCount(over);
  await history.getByRole('button', { name: /^Cancelled/ }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  const reader = history.locator('.plan-history-reader');
  await expect(reader.locator('#plan-p3')).toContainText('Cancelled');
  await expect(reader.locator('.plan-history-events')).toContainText('Cancelled');
  await history.getByRole('button', { name: /^All/ }).click();
  await history.getByRole('searchbox').fill('no such plan');
  await expect(history.locator('.empty-table')).toHaveText('No plans match.');
  await history.getByRole('searchbox').fill('p3');
  await expect(rows).toHaveCount(1);
  // Editing a plan from the history comes back to the history.
  await reader.getByRole('button', { name: 'Edit plan' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit plan' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(history).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(history).toHaveCount(0);
  checks.push('The queue reorders and shows claims and plans that fit nowhere; history opens');

  // Ideas: the backlog by priority with what each waits on; promoting one opens the plan
  // editor, and saving puts the plan in the queue linked to the idea.
  await call('idea_save', {
    project: 'test/plans',
    id: 'wide',
    title: 'Wider floor',
    hypothesis: 'A wider floor helps.',
    priority: 'high',
    waits_on: [{ kind: 'run', id: live }],
  });
  await page.reload();
  const ideas = page.locator('.plan-ideas');
  const ideaRow = ideas.locator('#idea-wide');
  await expect(ideaRow.locator('.idea-priority')).toHaveText('High');
  await expect(ideaRow.locator('.idea-link')).toContainText('p2_live');
  await expect(ideaRow.locator('.idea-link.met')).toHaveCount(0);
  await ideas.getByRole('button', { name: 'New idea' }).click();
  const ideaEditor = page.getByRole('dialog', { name: 'New idea' });
  await ideaEditor.getByLabel('Title').fill('Cold start');
  await ideaEditor.getByRole('button', { name: 'Save idea' }).click();
  await expect(ideas.locator('#idea-cold-start')).toBeVisible();
  await expect(ideas.locator('.idea-row').first()).toHaveAttribute('id', 'idea-wide');
  await ideaRow.getByRole('button', { name: 'Promote', exact: true }).click();
  const promote = page.getByRole('dialog', { name: 'Promote idea to a plan' });
  await expect(promote).toContainText('Wider floor');
  await promote.getByLabel('GPUs', { exact: true }).fill('2');
  await promote.getByRole('checkbox', { name: 'hostA' }).check({ force: true });
  await promote.getByRole('button', { name: 'Promote to plan' }).click();
  await expect(promote).toHaveCount(0);
  await expect(queue.locator('#plan-wide')).toBeVisible();
  await expect(ideas.locator('#idea-wide')).toHaveCount(0);
  await ideas.getByRole('button', { name: /^Promoted/ }).click();
  await expect(ideas.locator('#idea-wide')).toContainText('Plan wide');
  const made = (await call('plans_list', { project: 'test/plans' })).plans.find(
    (plan) => plan.id === 'wide',
  );
  assert.deepEqual(
    [made.idea, made.hypothesis, made.resources],
    ['wide', 'A wider floor helps.', { gpus: 2, hosts: ['hostA'] }],
  );
  checks.push('Ideas list by priority; promoting one makes a plan asking for its GPUs');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
