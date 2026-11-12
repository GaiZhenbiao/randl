import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// The Findings page with 500 synthetic findings: a sortable list filtered by topic, status and
// text in the header rail, one reading pane, keyboard navigation, and bulk status changes and
// deletion.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-findings-browser-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const origin = await listen(server);
  const call = (name, payload) => server.tools.execute(name, payload);
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'findings',
    name: 'v1_base',
    displayName: 'v1_base',
    state: 'finished',
  });
  // One topic is a whole sentence, as imported ledgers have.
  const topics = [
    'Model',
    'Optimizer',
    'Reward',
    'Environment',
    'Evaluation / Flight physics and realism from the November 1 and 2 logs',
  ];
  for (let i = 0; i < 500; i++)
    await call('finding_save', {
      project: 'test/findings',
      id: 'f' + i,
      topic: topics[i % 5],
      title: `Finding ${i}: ${i % 7 ? 'helps' : 'stalls'}`,
      body: `Finding **${i}** rose at update ${1000 + i}.` + (i === 123 ? ' Needle here.' : ''),
      status: i % 4 ? 'finding' : 'ruled_out',
      citations: i % 3 ? [{ run: run.id, update: 1000 + i }] : [],
      by: i % 2 ? 'backfill' : 'me',
    });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const rows = page.locator('.findings-table tbody tr');
  const row = (id) => page.locator(`[data-finding="${id}"]`);

  // A link to one finding opens it whatever the list shows.
  await page.goto(`${origin}/test/findings/findings?finding=f123`);
  await expect(rows).toHaveCount(500);
  await expect(page.locator('.findings-reader h2')).toHaveText('Finding 123: helps');
  await expect(page.locator('.findings-reader')).toContainText('Needle here.');
  await expect(row('f123')).toBeInViewport();
  // The controls sit in the header; only the open finding's Markdown is rendered.
  const controls = page.getByRole('group', { name: 'Search and filter findings' });
  assert.equal(await controls.evaluate((element) => !!element.closest('header')), true);
  await expect(page.locator('.finding-body')).toHaveCount(1);
  // A long topic name in the filter does not push the page's action under the header's own.
  const action = await controls.getByRole('button', { name: 'New finding' }).boundingBox(),
    assistant = await page.getByRole('button', { name: 'Assistant' }).first().boundingBox();
  assert.ok(action.x + action.width <= assistant.x, 'the rail ends before the Assistant button');
  checks.push('A linked finding opens in the reading pane; controls sit in the header rail');

  // Filters: text (in titles and bodies), topic and status combine, each within a frame or two.
  const search = controls.getByRole('searchbox', { name: 'Search findings' });
  const find = async (text) => {
    if (!(await search.isVisible()))
      await controls.locator('.page-rail-search .bx--search-magnifier').click();
    await search.fill(text);
  };
  const timed = async (action, count) => {
    const start = Date.now();
    await action();
    await expect(rows).toHaveCount(count);
    return Date.now() - start;
  };
  const times = [
    await timed(() => find('needle'), 1),
    await timed(() => find(''), 500),
    await timed(() => controls.getByLabel('Topic').selectOption({ label: 'Reward' }), 100),
    await timed(() => controls.getByLabel('Status').selectOption({ label: 'Ruled out' }), 25),
  ];
  assert.ok(Math.max(...times) < 1000, 'filters update quickly: ' + times.join(', '));
  await expect(page.locator('.findings-list-bar')).toContainText('25 of 500');
  await controls.getByLabel('Topic').selectOption({ label: 'All topics' });
  await controls.getByLabel('Status').selectOption({ label: 'Any status' });
  await expect(rows).toHaveCount(500);
  checks.push(
    `Search, topic and status filters combine and update 500 rows quickly (${times.join(', ')} ms)`,
  );

  // Sorting by a column header, both ways.
  const titleHeader = page.getByRole('columnheader', { name: 'Title' });
  await titleHeader.getByRole('button').click();
  await expect(titleHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(rows.first()).toContainText('Finding 0:');
  await expect(rows.nth(1)).toContainText('Finding 1:');
  await titleHeader.getByRole('button').click();
  await expect(titleHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first()).toContainText('Finding 499:');
  checks.push('Column headers sort the list both ways');

  // Keyboard: arrows open the next and previous findings, Space checks one, / searches.
  await rows.first().click();
  await expect(page.locator('.findings-reader h2')).toHaveText('Finding 499: helps');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.findings-reader h2')).toHaveText('Finding 498: helps');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.findings-reader h2')).toHaveText('Finding 498: helps');
  await expect(page.locator('.findings-list-bar')).toContainText('2 selected');
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  // Typing in the search box does not move through the list.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.findings-reader h2')).toHaveText('Finding 498: helps');
  checks.push('Arrow keys move through findings, Space checks them and / searches');

  // Bulk: the two checked findings are ruled out, then deleted after a confirmation.
  await page.getByRole('button', { name: 'Mark as ruled out' }).click();
  await expect(page.locator('.findings-list-bar')).toContainText('500 findings');
  await expect(row('f498')).toContainText('Ruled out');
  await expect(row('f497')).toContainText('Ruled out');
  assert.equal(
    (await call('finding_get', { project: 'test/findings', id: 'f498' })).finding.version,
    2,
  );
  await row('f498').locator('input').check();
  await row('f497').locator('input').check();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 findings?' });
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rows).toHaveCount(498);
  await expect(page.locator('.findings-reader')).toHaveCount(0);
  assert.equal((await call('findings_list', { project: 'test/findings' })).findings.length, 498);
  checks.push('Checked findings change status together, and are deleted after a confirmation');

  // Narrow windows keep the controls in the header; the reader takes the page. On phones the
  // filters open from an icon and the header stays one row.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(() => controls.evaluate((element) => !!element.closest('header'))).toBe(true);
  await rows.first().click();
  await expect(page.locator('.findings-list')).toBeHidden();
  await page.getByRole('button', { name: 'Close finding' }).click();
  await expect(page.locator('.findings-list')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  const header = await page.locator('header').first().boundingBox();
  assert.ok(header.height <= 56, 'one header row on a phone: ' + header.height);
  await controls.getByRole('button', { name: 'Filter findings' }).click();
  const popover = page.getByRole('dialog', { name: 'Filter findings' });
  await popover.getByLabel('Status').selectOption({ label: 'Ruled out' });
  await expect(rows).toHaveCount(125);
  await popover.getByLabel('Status').selectOption({ label: 'Any status' });
  checks.push(
    'Narrow windows keep the controls in the header; phones open the filters from an icon',
  );

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
