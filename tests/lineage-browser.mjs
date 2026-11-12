import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// The Lineage page: runs linked by a logged lineage block and by checkpoint paths, the details
// panel and its diffs, filters, collapsing rejected branches, keyboard movement and settings.
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
  const seed = async (name, cfg, tags, values) => {
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
        relation: 'grown_head',
        changes: { 'model.head': [512, 1024] },
        hypothesis: 'A wider head holds more boxes',
      },
    }),
    ['verdict:rejected'],
    [0.4],
  );
  await seed('v103_below', config('v103_below', '/ckpt/v102_head/update_00003000'), [], [0.45]);
  await seed('lonely', config('lonely', null), [], [0.1]);
  await server.tools.execute('project_lineage_settings_update', {
    id: 'test/lineage',
    metric,
    scale: 512,
  });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  await expect(page.locator('.lineage-edge')).toHaveCount(3);
  await expect(page.locator('.lineage-edge.matched')).toHaveCount(2);
  await expect(page.locator('.lineage-edge-label', { hasText: '@1K · lr' })).toHaveCount(1);
  checks.push('Cards show verdicts and scaled metrics; logged and path-matched links both draw');

  // Ctrl+wheel zooms at the pointer; a plain wheel pans.
  const transform = async () =>
    (await page.locator('.lineage-canvas').getAttribute('style'))
      .match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)
      .slice(1)
      .map(Number);
  const [, , zoomBefore] = await transform();
  await page.mouse.move(200, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await transform())[2]).toBeGreaterThan(zoomBefore);
  const [, yBefore] = await transform();
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await transform())[1]).toBeCloseTo(yBefore - 120);
  checks.push('The wheel pans the graph and Ctrl+wheel zooms it');

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
  await expect(details.locator('h2')).toHaveText('v102_head');
  await expect(details).toContainText('A wider head holds more boxes');
  await expect(details).toContainText('Head grown from update 2,000 · logged by the run');
  await expect(details.locator('.lineage-diff-row dt')).toHaveText(['model.head']);
  await expect(details.locator('.lineage-diff-row').first()).toContainText('Not set');
  await details.getByText('Show 1 ignored key').click();
  await expect(details.locator('.lineage-diff-row dt')).toHaveText([
    'model.head',
    'rl.checkpoint.save_dir',
  ]);
  assert.match(page.url(), /\?run=test%2Flineage%2Fv102_head$/);
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
