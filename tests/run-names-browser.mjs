import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// Run names (RunName.svelte) with synthetic runs: a 150-character name stays on one line,
// cut with an ellipsis, after the run's colour swatch, on every page that names runs; and a
// finding's cited runs graph the project's primary metric.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-run-names-browser-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const origin = await listen(server);
  const call = (name, payload) => server.tools.execute(name, payload);
  const long = ('v700_' + 'latched_const3e6_yaw02_lacmd_box_lsfloor35_'.repeat(4)).slice(0, 150);
  assert.equal(long.length, 150);
  const seed = async (name, displayName, lineage) => {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'names',
      name,
      displayName,
      state: 'finished',
      config: { lineage: { value: lineage } },
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 20 }, (_, i) =>
            JSON.stringify({ _step: i, update: 1000 + i * 100, 'audit/rate': 0.5 + i / 100 }),
          ),
        },
      },
      complete: true,
    });
    return run.id;
  };
  const longId = await seed('long', long, { parent: null }),
    childId = await seed('child', 'v701_child', { parent: { run_id: 'long', update: 1500 } });
  await call('project_lineage_settings_update', { id: 'test/names', metric: 'audit/rate' });
  await call('recipe_set', { project: 'test/names', run: longId, reason: 'Best so far' });
  await call('plan_save', {
    project: 'test/names',
    id: 'next',
    name: 'v702_next',
    host: 'hostA',
    slot: 'a',
    baseline: longId,
  });
  await call('finding_save', {
    project: 'test/names',
    id: 'long-holds',
    topic: 'Model',
    title: 'The long run holds',
    citations: [{ run: longId, update: 1500 }, { run: childId }],
  });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  /** Every name of the long run in `scope`: one line, cut, after a coloured swatch. */
  const oneLine = async (scope, where) => {
    const names = scope.locator('.run-label', { hasText: long.slice(0, 30) });
    await expect(names.first()).toBeVisible();
    for (const name of await names.all()) {
      if (!(await name.isVisible())) continue;
      const shape = await name.evaluate((element) => {
        const text = element.querySelector('.run-label-text'),
          dot = element.querySelector('.run-label-swatch');
        return {
          height: element.getBoundingClientRect().height,
          line: parseFloat(getComputedStyle(text).lineHeight) || 20,
          cut: text.scrollWidth > text.clientWidth,
          swatch: getComputedStyle(dot).backgroundColor,
          dotLeft: dot.getBoundingClientRect().left < text.getBoundingClientRect().left,
          title: element.getAttribute('title'),
        };
      });
      assert.ok(shape.height <= shape.line * 1.5 + 4, `${where}: one line (${shape.height}px)`);
      assert.ok(shape.cut, `${where}: the name is cut with an ellipsis`);
      assert.ok(shape.dotLeft, `${where}: the swatch comes first`);
      assert.notEqual(shape.swatch, 'rgba(0, 0, 0, 0)', `${where}: the swatch is coloured`);
      assert.equal(shape.title, long, `${where}: the full name shows on hover`);
    }
  };

  // The same colour as the Runs tab.
  await page.goto(`${origin}/test/names/runs`);
  const tableColor = await page
    .locator('.table-run-name', { hasText: long.slice(0, 20) })
    .locator('.run-color')
    .evaluate((element) => getComputedStyle(element).backgroundColor);

  await page.goto(`${origin}/test/names/lineage?run=test/names/child`);
  const details = page.locator('.lineage-details');
  await oneLine(details, 'Lineage parent');
  await page.goto(`${origin}/test/names/lineage?run=test/names/long`);
  await oneLine(details.locator('header'), 'Lineage header');
  assert.equal(
    await details
      .locator('header .run-label-swatch')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    tableColor,
  );
  checks.push('Lineage: the panel header and parent link keep a 150-character name on one line');

  await page.goto(`${origin}/test/names/plans`);
  await oneLine(page.locator('.recipe-tile'), 'Plans recipe');
  await oneLine(page.locator('.plan-lanes'), 'Plans lane baseline');
  checks.push('Plans: the recipe and a plan’s baseline do too');

  await page.goto(`${origin}/test/names/findings?finding=long-holds`);
  const reader = page.locator('.findings-reader');
  await oneLine(reader, 'Findings citation');
  // Each cited run graphs the primary metric; the cited update is marked.
  await expect(reader.locator('.finding-citation-chart .chart')).toHaveCount(2);
  await expect(reader.locator('.finding-citation-chart .chart-title').first()).toHaveText(
    'audit/rate',
  );
  await expect(reader.locator('.finding-citation-chart canvas').first()).toBeVisible();
  await expect(reader.locator('.finding-citation-at')).toHaveText(['@1,500']);
  checks.push('Findings: citations keep the name on one line and graph the primary metric');

  await page.goto(`${origin}/test/names/runs/long`);
  await oneLine(page.locator('header'), 'Run page header');
  await page.goto(`${origin}/test/names/overview`);
  await oneLine(page.locator('main'), 'Overview lists');
  checks.push('The run page header and the overview lists do too');

  // Keyboard focus shows the whole name.
  await page.goto(`${origin}/test/names/plans`);
  const link = page.locator('.recipe-tile .run-label');
  await link.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.equal(
    await link.evaluate((element) => getComputedStyle(element, '::after').content),
    JSON.stringify(long),
  );
  checks.push('Keyboard focus on a cut name shows it whole');

  // A run marked stopped keeps its state and reason in words; only running runs are marked
  // in run lists and on Lineage cards.
  await call('run_state_set', {
    id: childId,
    state: 'stopped',
    reason: 'Holds fell after u1500',
    by: 'test',
  });
  await server.db.call('upsert', {
    entity: 'test',
    project: 'names',
    name: 'live',
    displayName: 'v703_live',
    state: 'running',
  });
  await page.goto(`${origin}/test/names/runs`);
  const childRow = page.getByRole('row', { name: /v701_child/ });
  await expect(childRow).toContainText('Stopped');
  await expect(childRow.locator('.run-state')).toHaveCount(0);
  await expect(
    page
      .getByRole('row', { name: /v702_long|v700_/ })
      .first()
      .locator('.run-state'),
  ).toHaveCount(0);
  const liveRow = page.getByRole('row', { name: /v703_live/ });
  await expect(liveRow.locator('.run-state[data-state="running"]')).toHaveCount(1);
  // State labels line up whether or not a row is marked.
  const labelX = async (row) =>
    await row.locator('.run-state-label').evaluate((element) => {
      const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
      const range = document.createRange();
      range.selectNodeContents(text);
      return range.getBoundingClientRect().left;
    });
  assert.ok(Math.abs((await labelX(liveRow)) - (await labelX(childRow))) < 1);
  await page.goto(`${origin}/test/names/workspace`);
  const runList = page.locator('.run-name');
  await expect(runList.filter({ hasText: 'v703_live' }).locator('.running-name-dot')).toHaveCount(
    1,
  );
  await expect(runList.filter({ hasText: 'v701_child' })).toHaveCount(1);
  await expect(
    runList.filter({ hasText: 'v701_child' }).locator('.running-name-dot, .run-state'),
  ).toHaveCount(0);
  await page.goto(`${origin}/test/names/runs/child`);
  await expect(page.locator('.run-state-tag')).toHaveText('Stopped');
  await expect(page.locator('main')).toContainText('Holds fell after u1500');
  await page.goto(`${origin}/test/names/lineage?run=test%2Fnames%2Fchild`);
  await expect(page.locator('.lineage-details')).toContainText('Holds fell after u1500');
  const childCard = page.locator('.lineage-card', { hasText: 'v701' });
  await expect(childCard.locator('.lineage-card-state')).toHaveText('Stopped');
  await expect(childCard.locator('.run-state')).toHaveCount(0);
  checks.push(
    'Only running runs are marked in run lists and Lineage cards; stopped ones say so in words',
  );

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
