import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// The Lineage page: runs linked by a logged lineage block and by checkpoint paths, the details
// panel and its diffs, filters, collapsing rejected branches, keyboard movement, gestures,
// settings, and the hand-off to and from the workspace.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-lineage-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const origin = await listen(server);
  const metric = 'audit/primary/value';
  const config = (name, init, extra = {}, lr = 1e-6) =>
    Object.fromEntries(
      Object.entries({
        rl: {
          checkpoint: { save_dir: '/ckpt/' + name, initialize_from: init },
          algorithm: { lr },
        },
        ...extra,
      }).map(([key, value]) => [key, { value }]),
    );
  const seed = async (name, cfg, tags, values, running = false) => {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'lineage',
      name,
      displayName: name,
      config: cfg,
      tags,
      state: 'finished',
      summaryMetrics: { [metric]: values.at(-1) },
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: values.map((value, step) => JSON.stringify({ _step: step, [metric]: value })),
        },
      },
      ...(running ? {} : { complete: true }),
    });
    return run.id;
  };
  await seed('v100_root', config('v100_root', null), ['verdict:adopted'], [0.5, 0.75]);
  // v101 starts from a copied warm source of v100 and changes the learning rate.
  await seed(
    'v101_lr',
    config('v101_lr', '/other/host/warm_sources/v100_u00001000/update_00001000', {}, 2e-6),
    [],
    [0.6],
  );
  await seed(
    'v102_head',
    config('v102_head', null, {
      model: { head: 1024 },
      lineage: {
        parent: { run_id: 'v100_root', update: 2000 },
        relation: ['initialize_from', 'grown_head'],
        changes: { 'model.head': [512, 1024] },
        hypothesis: 'A wider head holds more boxes',
        compute: {
          host: 'Sirius',
          gpu_count: 2,
          segments: [
            {
              from_update: 2000,
              to_update: 2500,
              host: 'polaris',
              gpu_count: 1,
              gpu_ids: [3],
              gpu_model: 'RTX 4090 24GB',
              slot: 'polaris_012',
            },
            {
              from_update: 2500,
              to_update: null,
              host: 'Sirius',
              gpu_count: 2,
              gpu_ids: null,
              gpu_model: 'RTX 4090 48GB',
              slot: null,
            },
          ],
        },
      },
    }),
    ['verdict:rejected'],
    [0.4],
  );
  // The one running run.
  await seed(
    'v103_below',
    config('v103_below', '/ckpt/v102_head/update_00003000'),
    [],
    [0.45],
    true,
  );
  await seed('lonely', config('lonely', null), [], [0.1]);
  await server.tools.execute('project_lineage_settings_update', {
    id: 'test/lineage',
    metric,
    scale: 512,
  });

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${origin}/test/lineage/lineage`);
  const cards = page.locator('.lineage-card');
  const card = (name) => cards.filter({ hasText: name });
  await expect(cards).toHaveCount(4);
  await expect(page.locator('.lineage-summary')).toHaveText(
    '4 runs shown · 1 run without lineage hidden',
  );
  await expect(card('v100')).toContainText('384/512');
  await expect(card('v100')).toContainText('best 384/512');
  await expect(card('v100').locator('[aria-label="Adopted"]')).toHaveCount(1);
  await expect(page.locator('.lineage-edges .lineage-edge')).toHaveCount(3);
  await expect(page.locator('.lineage-edges .lineage-edge.matched')).toHaveCount(2);
  await expect(page.locator('.lineage-edge-label', { hasText: '@1K · lr' })).toHaveCount(1);
  await expect(page.locator('.lineage-edge-label', { hasText: '@2K · +grown head' })).toHaveCount(
    1,
  );
  await expect(card('v102')).toContainText('Sirius · 2× RTX 4090 48GB');
  checks.push('Cards show verdicts, hardware and scaled metrics; both kinds of link draw');

  // The page opens at 100% on the running run, which has a rippling accent ring.
  const transform = async () =>
    (await page.locator('.lineage-canvas').getAttribute('style'))
      .match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)
      .slice(1)
      .map(Number);
  assert.equal((await transform())[2], 1);
  const running = card('v103');
  await expect(running).toHaveClass(/running/);
  await expect(running).toBeInViewport({ ratio: 1 });
  const animation = () =>
    running.evaluate((item) => getComputedStyle(item, '::after').animationName);
  assert.equal(await animation(), 'lineage-ripple');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await animation(), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push('The page opens at 100% on the running run; its ripple respects reduced motion');

  // Cards carry each run's workspace colour.
  const swatch = (name) =>
    card(name)
      .locator('.lineage-swatch')
      .evaluate((item) => getComputedStyle(item).backgroundColor);
  const lineageColors = { v100: await swatch('v100'), v101: await swatch('v101') };
  assert.notEqual(lineageColors.v100, lineageColors.v101);

  // Ctrl+wheel (and a touchpad pinch, which browsers send the same way) zooms at the
  // pointer; a plain wheel or two-finger scroll pans; two fingers on a touch screen pinch.
  const [, , zoomBefore] = await transform();
  await page.mouse.move(200, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await transform())[2]).toBeGreaterThan(zoomBefore);
  const [, yBefore] = await transform();
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await transform())[1]).toBeCloseTo(yBefore - 120);
  const touch = await context.newCDPSession(page);
  const fingers = (spread) => [
    { x: 600 - spread, y: 500, id: 1 },
    { x: 600 + spread, y: 500, id: 2 },
  ];
  const [, , pinchBefore] = await transform();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(100) });
  for (const spread of [80, 60, 40])
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: fingers(spread),
    });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await transform())[2]).toBeCloseTo(pinchBefore * 0.4, 1);
  checks.push('Wheel and touchpad scrolling pan; Ctrl+wheel and touch pinches zoom');

  // Arranged by start update, cards sit left to right in the order their runs started.
  const left = async (name) => parseFloat(await card(name).evaluate((item) => item.style.left));
  await page.getByRole('combobox', { name: /Arrange by/ }).click();
  await page.getByRole('option', { name: 'Start update' }).click();
  await expect.poll(async () => (await left('v101')) < (await left('v102'))).toBe(true);
  assert.ok((await left('v100')) < (await left('v101')));
  assert.ok((await left('v102')) < (await left('v103')));
  await page.getByRole('combobox', { name: /Arrange by/ }).click();
  await page.getByRole('option', { name: 'Lineage depth' }).click();
  await expect.poll(async () => (await left('v101')) === (await left('v102'))).toBe(true);
  checks.push('Cards can be arranged by start update and back by lineage depth');

  await card('v102').click();
  const details = page.locator('.lineage-details');
  const parentDiff = details.locator('section', { hasText: 'Config changes from parent' });
  await expect(details.locator('h2')).toHaveText('v102_head');
  await expect(details).toContainText('A wider head holds more boxes');
  await expect(details).toContainText('Initialized from update 2,000 · logged by the run');
  await expect(details.locator('.lineage-traits')).toHaveText('grown_head');
  await expect(details).toContainText('Updates 2,000–2,500');
  await expect(details).toContainText('polaris · polaris_012');
  await expect(details).toContainText('1× RTX 4090 24GB (3)');
  await expect(parentDiff.locator('.lineage-diff-row dt')).toHaveText(['model.head']);
  await expect(parentDiff.locator('.lineage-diff-row').first()).toContainText('Not set');
  await parentDiff.getByText('Show 1 ignored key').click();
  await expect(parentDiff.locator('.lineage-diff-row dt')).toHaveText([
    'model.head',
    'rl.checkpoint.save_dir',
  ]);
  assert.match(page.url(), /\?run=test%2Flineage%2Fv102_head&select=v102_head$/);
  checks.push('The details panel shows the hypothesis, relation and the diff against the parent');

  // Keyboard: Left moves to the parent card, Escape closes the panel and keeps focus.
  await card('v102').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(card('v100')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(page.locator('.lineage-card:focus')).toHaveCount(1);
  checks.push('Arrow keys follow links and Escape closes the details panel');

  await page.getByText('Collapse rejected branches').click();
  await expect(cards).toHaveCount(3);
  await expect(card('v102')).toContainText('1 run collapsed');
  await page.getByText('Collapse rejected branches').click();
  await page.getByRole('searchbox', { name: 'Filter runs by name' }).fill('v103');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.lineage-card.context')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Filter runs by name' }).fill('');
  await page.getByText('Show runs without lineage').click();
  await expect(cards).toHaveCount(5);
  checks.push('Filters keep connecting ancestors; rejected branches and unlinked runs toggle');

  // A reload keeps the selected run; Open run reaches the run page and Back returns.
  await card('v101').click();
  await page.reload();
  await expect(details.locator('h2')).toHaveText('v101_lr');
  await expect(details).toContainText('Initialized from update 1,000 · matched by checkpoint path');
  await details.getByRole('link', { name: 'Open run' }).click();
  await expect(page).toHaveURL(/\/test\/lineage\/runs\/v101_lr/);
  await page.getByRole('button', { name: 'Back to lineage' }).click();
  await expect(details.locator('h2')).toHaveText('v101_lr');
  checks.push('Selection survives reload and the run page returns to the lineage');

  // Shift-click picks runs; the root-to-run path joins them; the workspace shows exactly them.
  await card('v102').click({ modifiers: ['Shift'] });
  await expect(page.locator('.lineage-selection')).toContainText('2 runs selected');
  await page.getByRole('button', { name: 'Select path from root' }).click();
  await expect(page.locator('.lineage-selection')).toContainText('3 runs selected');
  await expect(page.locator('.lineage-card.picked')).toHaveCount(3);
  assert.deepEqual(new URL(page.url()).searchParams.get('select').split(',').sort(), [
    'v100_root',
    'v101_lr',
    'v102_head',
  ]);
  await page.getByRole('button', { name: 'Compare in workspace' }).click();
  await expect(page).toHaveURL(/\/test\/lineage\/workspace/);
  await expect(page.getByText('Showing 3 runs from the lineage')).toBeVisible();
  const viewId = new URL(page.url()).searchParams.get('view');
  await expect
    .poll(async () => (await server.db.call('view', viewId))?.body.solo.slice().sort())
    .toEqual(['test/lineage/v100_root', 'test/lineage/v101_lr', 'test/lineage/v102_head']);
  // The same colour in the workspace's run list as on the lineage card.
  const listColor = (id) =>
    page
      .locator(`[data-color-id="${id}"] .run-color`)
      .evaluate((item) => getComputedStyle(item).backgroundColor);
  assert.equal(await listColor('test/lineage/v100_root'), lineageColors.v100);
  assert.equal(await listColor('test/lineage/v101_lr'), lineageColors.v101);
  checks.push('Chosen runs (clicks, path) open soloed in the workspace with the same colours');

  // Back from the workspace: the runs table and a run page each open the lineage on runs.
  await page.goto(`${origin}/test/lineage/runs`);
  for (const name of ['v101_lr', 'v103_below'])
    await page
      .getByRole('row', { name: new RegExp(name) })
      .getByRole('checkbox')
      .check({ force: true });
  await page.getByRole('button', { name: 'Show in lineage' }).click();
  await expect(page).toHaveURL(/\/test\/lineage\/lineage\?run=/);
  await expect(page.locator('.lineage-card.picked')).toHaveCount(2);
  await expect(details.locator('h2')).toHaveText(/v101_lr|v103_below/);
  await page.goto(`${origin}/test/lineage/runs/v102_head`);
  await page.getByRole('link', { name: 'Show in lineage' }).click();
  await expect(details.locator('h2')).toHaveText('v102_head');
  checks.push('Show in lineage from the runs table and a run page selects those runs');

  // Lasso: Shift+drag around cards adds them to the selection.
  await page.getByRole('button', { name: 'Clear selection' }).click();
  const box = async (name) => card(name).boundingBox();
  const a = await box('v101'),
    b = await box('v102');
  await page.mouse.move(Math.min(a.x, b.x) - 10, Math.min(a.y, b.y) - 10);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(
    Math.max(a.x + a.width, b.x + b.width) + 10,
    Math.max(a.y + a.height, b.y + b.height) + 10,
    { steps: 5 },
  );
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('.lineage-card.picked')).toHaveCount(2);
  checks.push('Shift+drag draws a lasso that selects cards');

  // Hosts: filter to one (its ancestors stay as context) and colour cards by host.
  await page.getByRole('combobox', { name: /^Host/ }).click();
  await page.getByRole('option', { name: 'Sirius' }).click();
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.lineage-card.context')).toHaveCount(1);
  await page.getByRole('combobox', { name: /Color by/ }).click();
  await page.getByRole('option', { name: 'Host' }).click();
  await expect(card('v102').locator('.lineage-swatch')).toHaveCount(1);
  await expect(card('v100').locator('.lineage-swatch')).toHaveCount(0);
  await page.getByRole('combobox', { name: /^Host/ }).click();
  await page.getByRole('option', { name: 'All hosts' }).click();
  await page.getByRole('combobox', { name: /Color by/ }).click();
  await page.getByRole('option', { name: 'Run color' }).click();
  checks.push('Runs can be filtered and coloured by the host they trained on');

  await page.getByRole('button', { name: 'Lineage settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lineage settings' });
  await dialog.getByLabel('Display scale').fill('');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(card('v100')).toContainText('0.75');
  const stored = await server.tools.execute('project_lineage_settings_get', { id: 'test/lineage' });
  assert.equal(stored.scale, null);
  checks.push('Lineage settings save and redraw the cards');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
