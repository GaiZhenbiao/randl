import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import limits from '../backend/src/selection-limits.json' with { type: 'json' };
import { launchBrowser } from './helpers.mjs';
const expect = baseExpect.configure({ timeout: 15000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-bulk-browser-'));
const store = new Store(directory),
  runIds = [];
store.db.transaction(() => {
  for (let i = 0; i < 10000; i++) {
    const run = store.upsert({
      entity: 'test',
      project: 'bulk',
      name: `run-${String(i).padStart(5, '0')}`,
      displayName: `Trial ${String(i).padStart(5, '0')}`,
      config: { seed: { value: i % 32 } },
    });
    store.db
      .prepare("UPDATE runs SET state='finished',created=? WHERE id=?")
      .run(1000000 + i, run.id);
    if (i < 25 || i === 9999)
      store.ingest(run.id, {
        files: {
          'wandb-history.jsonl': {
            offset: 0,
            content: [0, 1].map((step) =>
              JSON.stringify({
                _step: step,
                loss: i + step,
                ...(i === 0 ? { last_run_metric: step } : {}),
              }),
            ),
          },
        },
        complete: true,
        exitcode: 0,
      });
    runIds.push(run.id);
  }
})();
store.db.close();
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/chart'))
      requests.push(request.postDataJSON());
  });
  await page.addInitScript(() => {
    window.longTasks = [];
    new PerformanceObserver((list) =>
      window.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: 'longtask' });
  });
  async function create(name, body = {}) {
    return server.tools.execute('view_create', {
      name,
      project: 'test/bulk',
      body: {
        generation: 'manual',
        panels: [{ id: 'p', plugin: 'line', metric: 'loss', title: 'Loss' }],
        visible: [],
        solo: [],
        plotSettings: { maxRuns: 20 },
        ...body,
      },
    });
  }
  async function open(view) {
    await page.goto(`${origin}/test/bulk/workspace?view=${view.id}`);
    await expect(page.locator('.run-row').first()).toBeVisible();
  }
  async function saved(view, visible, solo) {
    await expect
      .poll(async () => {
        const value = await server.db.call('view', view.id);
        return [value.body.visible.length, value.body.solo.length];
      })
      .toEqual([visible, solo]);
    await expect(page.locator('.save-status .current')).toHaveText('Saved');
  }
  const filtered = await create('Filtered4992', {
    filters: [{ field: 'config.seed', operator: 'gte', value: '16' }],
  });
  await open(filtered);
  await expect(page.locator('.run-row').first()).toHaveAttribute('aria-setsize', '4992');
  // Run search matches a full run ID and a pasted run URL, and saves nothing to the view.
  {
    const search = page.getByRole('searchbox', { name: 'Search runs by name or ID', exact: true });
    const version = (await server.db.call('view', filtered.id)).version;
    for (const query of [
      'test/bulk/run-00020',
      `${origin}/test/bulk/runs/run-00020?tab=logs`,
      'https://wandb.ai/test/bulk/runs/run-00020/overview',
    ]) {
      await search.fill(query);
      await expect(page.locator('.run-row')).toHaveCount(1);
      await expect(page.locator('.run-row').first()).toHaveAttribute('data-run-id', runIds[20]);
    }
    await search.fill('');
    await expect(page.locator('.run-row').first()).toHaveAttribute('aria-setsize', '4992');
    await page.waitForTimeout(400);
    assert.equal((await server.db.call('view', filtered.id)).version, version);
  }
  await expect(page.locator('.runs-heading .control-badge')).toHaveText('1');
  await expect(
    page.locator('.runs-heading').getByRole('button', { name: 'Filter', exact: true }),
  ).toHaveAttribute('title', 'Filter · 1');
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route('**/api/views/' + filtered.id, async (route) => {
    if (route.request().method() === 'PUT') await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await expect(page.locator('.save-status .current')).toHaveText('Saving…');
  await expect(page.locator('.operation-toast')).toHaveCount(0);
  release();
  await saved(filtered, 4992, 0);
  await expect(page.locator('.operation-toast')).toContainText('Listed runs shown');
  assert.ok(
    requests.every((request) => request.runs.length <= 20),
    'ungrouped chart budget remains 20',
  );
  await page.locator('.operation-toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(filtered, 0, 0);
  await page.unroute('**/api/views/' + filtered.id);
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await saved(filtered, 4992, 0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Hide listed runs', exact: true })).toBeVisible();
  checks.push(
    '4,992 listed runs persist in full; success waits for acknowledgement; Undo and reload agree with storage',
  );

  const all = await create('All10000');
  await open(all);
  await page.evaluate(() => (window.longTasks = []));
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await saved(all, 10000, 0);
  // There is no "solo all" control; Clear solo appears in the heading only while runs are soloed.
  const clearSolo = page.locator('.run-table-heading').getByRole('button', {
    name: 'Clear solo',
    exact: true,
  });
  await expect(clearSolo).toHaveCount(0);
  await expect(page.locator('.run-table-heading .toggle.solo:not(.clear-solo)')).toHaveCount(0);
  await page.locator('.run-row [data-toggle="solo"]').nth(0).click();
  await page.locator('.run-row [data-toggle="solo"]').nth(2).click();
  await saved(all, 10000, 2);
  await expect(clearSolo).toBeVisible();
  // While runs are soloed, visibility eyes stay readable against row and hover surfaces.
  const eyeContrast = () =>
    page.evaluate(() => {
      const rgb = (value) =>
        value
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number);
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((c) => c / 255)
          .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const background = (node) => {
        for (let el = node; el; el = el.parentElement) {
          const color = getComputedStyle(el).backgroundColor;
          if (!/rgba\(0, 0, 0, 0\)|transparent/.test(color)) return rgb(color);
        }
        return [255, 255, 255];
      };
      return Math.min(
        ...[...document.querySelectorAll('#run-list [data-toggle="visible"]')].map((eye) => {
          const [a, b] = [lum(rgb(getComputedStyle(eye).color)), lum(background(eye))].sort(
            (x, y) => y - x,
          );
          return (a + 0.05) / (b + 0.05);
        }),
      );
    });
  assert.ok((await eyeContrast()) >= 4.5, 'soloed-over visibility eyes keep their contrast');
  await clearSolo.focus();
  await page.keyboard.press('Enter');
  await saved(all, 10000, 0);
  await expect(clearSolo).toHaveCount(0);
  await expect(page.locator('#run-list')).toBeFocused();
  await expect(page.locator('.operation-toast')).toContainText('Solo cleared');
  await page.locator('.operation-toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(all, 10000, 2);
  await clearSolo.click();
  await saved(all, 10000, 0);
  await page.locator('.run-row [data-control="name"]').first().focus();
  await page.keyboard.press('End');
  await expect(page.locator('.run-row[aria-posinset="10000"] [data-control="name"]')).toBeFocused();
  await expect(
    page.locator('.run-row[aria-posinset="10000"] [data-toggle="visible"]'),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Home');
  const longest = await page.evaluate(() => Math.max(0, ...window.longTasks));
  assert.ok(
    longest < 2000,
    `10,000 selection heading task ${longest}ms must stay below 2 s (baseline 5.6 s)`,
  );
  assert.ok((await page.locator('.run-row').count()) < 80, 'rows stay virtualized');
  // Filter, Group and Sort are icon buttons in the runs heading; their tooltips name what is active.
  const heading = page.locator('.run-sidebar .runs-heading');
  const headingTops = await heading
    .locator('.heading-control .bx--btn')
    .evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
    );
  assert.equal(headingTops.length, 3);
  assert.equal(new Set(headingTops).size, 1, 'Filter, Group and Sort share the heading row');
  await expect(heading.getByRole('button', { name: 'Sort', exact: true })).toHaveAttribute(
    'title',
    'Sort: Created, descending',
  );
  await expect(heading.locator('.control-badge, .control-dot')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  const sortGap = await page.locator('.context-popover').evaluate((popover) => {
    const list = popover.querySelector('.bx--list-box__wrapper').getBoundingClientRect();
    const order = popover
      .querySelector('.bx--list-box__wrapper + .bx--form-item')
      .getBoundingClientRect();
    return Math.round(order.top - list.bottom);
  });
  assert.equal(sortGap, 32, 'Sort fields use the stacked-field spacing');
  await page.keyboard.press('Escape');
  checks.push(
    `10,000 visible runs and row solos persist independently; Clear solo appears only while runs are soloed; bounded rows/chart requests; longest task ${Math.round(longest)}ms`,
  );

  let failure = 'server';
  await page.route('**/api/views/' + all.id, async (route) => {
    if (route.request().method() !== 'PUT' || !failure) return route.continue();
    if (failure === 'network') return route.abort('connectionfailed');
    return route.fulfill({
      status: failure === 'refused' ? 400 : 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error:
          failure === 'refused'
            ? 'Enter a valid panel hide expression'
            : 'Database busy; retry shortly',
      }),
    });
  });
  await page.getByRole('button', { name: 'Hide listed runs', exact: true }).click();
  await expect(page.locator('.save-status .current')).toHaveText('Not saved');
  await expect(page.locator('.operation-toast')).toHaveCount(0);
  await expect(
    page.locator('#save-failure').getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as new view', exact: true })).toHaveCount(0);
  await expect(page.locator('#save-failure')).toContainText(
    'The server is busy. Retry in a moment.',
  );
  assert.equal((await server.db.call('view', all.id)).body.visible.length, 10000);
  await page.getByRole('combobox', { name: 'Saved view' }).selectOption(filtered.id);
  await expect(page.locator('#save-failure')).toBeFocused();
  await expect(page.getByText('Unable to complete action')).toHaveCount(0);
  failure = '';
  await page.locator('#save-failure').getByRole('button', { name: 'Retry', exact: true }).focus();
  await page.keyboard.press('Enter');
  await saved(all, 0, 0);
  await expect(page.getByRole('combobox', { name: 'Saved view' })).toBeFocused();
  await expect(page.locator('.operation-toast')).toContainText('Listed runs hidden');
  await expect(
    page.locator('.operation-toast').getByRole('button', { name: 'Undo', exact: true }),
  ).toBeVisible();
  failure = 'network';
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await expect(page.locator('.save-status .current')).toHaveText('Not saved');
  failure = '';
  await page.getByRole('button', { name: 'Undo view change', exact: true }).click();
  await saved(all, 0, 0);
  failure = 'refused';
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await expect(page.locator('.save-status .current')).toHaveText('Not saved');
  await expect(
    page.locator('#save-failure').getByRole('button', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo view change', exact: true })).toBeEnabled();
  failure = '';
  await page.getByRole('button', { name: 'Hide listed runs', exact: true }).click();
  await saved(all, 0, 0);
  await page.unroute('**/api/views/' + all.id);
  failure = '';
  let lose = true;
  await page.route('**/api/views/' + all.id, async (route) => {
    if (route.request().method() !== 'PUT' || !lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await expect(page.locator('.save-status .current')).toHaveText('Not saved');
  const applied = await server.db.call('view', all.id);
  assert.equal(applied.body.visible.length, 10000, 'the lost save was applied');
  await page.locator('#save-failure').getByRole('button', { name: 'Retry', exact: true }).click();
  await saved(all, 10000, 0);
  assert.equal((await server.db.call('view', all.id)).version, applied.version, 'no second write');
  await expect(page.getByRole('button', { name: 'Save as new view', exact: true })).toHaveCount(0);
  await expect(page.locator('.operation-toast')).toContainText('Listed runs shown');
  await page.locator('.operation-toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(all, 0, 0);
  await page.unroute('**/api/views/' + all.id);
  checks.push(
    'Network and 503 failures offer Retry; a busy server, a refusal and a lost response are distinct; Retry after a lost response confirms the stored save without a conflict; leaving focuses the failure; Retry restores the bulk Undo',
  );

  const before = await server.db.call('view', all.id);
  let conflictWritten = false;
  await page.route('**/api/views/' + all.id, async (route) => {
    if (route.request().method() === 'PUT' && !conflictWritten) {
      conflictWritten = true;
      await server.tools.execute('view_save', {
        id: all.id,
        name: before.name,
        project: before.project,
        version: before.version,
        body: { ...before.body, visible: [runIds[0]] },
      });
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await expect(page.locator('.save-status .current')).toHaveText('Not saved');
  await expect(page.getByRole('button', { name: 'Save as new view', exact: true })).toBeVisible();
  await expect(page.locator('#save-failure')).toContainText('changed in another session');
  await expect(page.locator('.operation-toast')).toHaveCount(0);
  await page.unroute('**/api/views/' + all.id);
  await page.getByRole('button', { name: 'Reload saved view', exact: true }).click();
  assert.equal((await server.db.call('view', all.id)).body.visible.length, 1);
  checks.push(
    'An actual second-writer conflict preserves the draft and offers conflict recovery without false success',
  );

  const grouped = await create('Grouped10000', {
    visible: runIds,
    plotSettings: { maxRuns: 20, groupBy: 'config.seed' },
  });
  requests.length = 0;
  const registrations = [];
  const registration = (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/chart-selections'))
      registrations.push(request.postDataJSON());
  };
  page.on('request', registration);
  await open(grouped);
  // Grouped charts aggregate every visible run: 32 seed groups, of which 20 are shown.
  await expect(page.locator('.chart-limit').first()).toContainText('20/32 groups');
  await expect(page.locator('.chart-status').first()).toBeHidden();
  page.off('request', registration);
  const groupedRequests = requests.filter((request) => request.settings?.groupBy === 'config.seed');
  assert.ok(groupedRequests.length >= 1);
  assert.ok(
    groupedRequests.every((request) => request.selection && !request.runs),
    'grouped chart requests name the selection instead of listing 10,000 runs',
  );
  assert.equal(registrations.length, 1, 'panels share one selection registration');
  assert.equal(registrations[0].runs.length, 10000);
  checks.push(
    'Grouped charts aggregate 10,000 visible runs through one shared selection registration',
  );
  const catalogRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/metrics'))
      catalogRequests.push(request.postDataJSON());
  });
  await page.locator('.chart').first().hover();
  await page.locator('.chart-settings').first().click();
  const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  await expect(editor).toBeVisible();
  const metric = editor.getByRole('combobox', { name: 'Y metrics', exact: true });
  await metric.fill('last_run_metric');
  await expect(page.getByRole('option', { name: 'last_run_metric', exact: true })).toBeVisible();
  assert.equal(catalogRequests.length, 10);
  assert.equal(new Set(catalogRequests.flatMap((request) => request.runs)).size, 10000);
  assert.ok(catalogRequests.every((request) => request.runs.length <= 1000));
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).not.toBeVisible();
  checks.push('Panel metric catalog includes runs beyond the first 1,000 using bounded requests');
  // A group heading names its group in the toast, and the toast's Undo restores storage.
  const groupedList = await create('Grouped list', {
    panels: [],
    runQuery: { group: 'config.seed' },
  });
  await open(groupedList);
  await expect(page.locator('.run-group .group-label').first()).not.toHaveAttribute(
    'data-value',
    'None',
  );
  const groupValue = await page
    .locator('.run-group .group-label')
    .first()
    .getAttribute('data-value');
  await expect(page.locator('.run-group').first().locator('.group-field')).toHaveText('seed');
  await expect(
    page.locator('.runs-heading').getByRole('button', { name: 'Group', exact: true }),
  ).toHaveAttribute('title', 'Group: Config · seed');
  await expect(page.locator('.runs-heading .control-dot')).toHaveCount(1);
  await expect(page.locator('.run-group [data-control="solo"]')).toHaveCount(0);
  const groupName = 'Config · seed: ' + groupValue;
  await page
    .getByRole('button', { name: 'Visibility for group ' + groupName, exact: true })
    .click();
  await expect(page.locator('.operation-toast')).toContainText(`Runs in ${groupName} shown`);
  const groupCount = (await server.db.call('view', groupedList.id)).body.visible.length;
  assert.ok(groupCount > 0 && groupCount < 10000);
  await page.locator('.operation-toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(groupedList, 0, 0);
  checks.push('Group heading toasts name the group and keep Undo');

  const extra = await server.db.call('upsert', {
    entity: 'test',
    project: 'bulk',
    name: 'extra',
    displayName: 'Extra run',
  });
  // Above 10,000 runs, run values load in batches, so config grouping still works.
  await open(groupedList);
  await expect(
    page.locator('.run-group .group-label:not([data-value="None"])').first(),
  ).toBeVisible();
  checks.push('Config grouping works in a project with more than 10,000 runs');
  // Stored IDs of runs that are not listed (for example deleted runs) fill the selection to its
  // limit without loading that many runs in the browser.
  const limit = limits.maxSelectedRuns,
    format = (value) => value.toLocaleString('en-US'),
    unlisted = (count) => Array.from({ length: count }, (_, i) => 'test/bulk/unlisted-' + i);
  const full = [...runIds, ...unlisted(limit - runIds.length)];
  // Stored IDs of unlisted runs count toward the limit; the message says so.
  const deletedNote = limit > runIds.length ? ' Deleted runs still count toward this limit.' : '';
  const capped = await create('Full selection', { visible: full, solo: full, panels: [] });
  await open(capped);
  const extraEye = page
    .locator('[data-entry-key="' + extra.id + '"]')
    .locator('[data-toggle="visible"]');
  const extraSolo = page
    .locator('[data-entry-key="' + extra.id + '"]')
    .locator('[data-toggle="solo"]');
  const puts = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/views/' + capped.id))
      puts.push(request);
  });
  await extraEye.click();
  await expect(
    page.getByText(
      `This view already shows ${format(limit)} runs, the most it can show. Hide runs you no longer need, then try again.${deletedNote}`,
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(extraEye).toHaveAttribute('aria-pressed', 'false');
  await extraSolo.focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByText(
      `This view already solos ${format(limit)} runs, the most it can solo. Clear solo for runs you no longer need, then try again.${deletedNote}`,
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(extraSolo).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await expect(extraEye).toHaveAttribute('aria-pressed', 'false');
  assert.equal(puts.length, 0, 'an over-limit change starts no save');
  const unchanged = await server.db.call('view', capped.id);
  assert.equal(unchanged.version, capped.version);
  assert.deepEqual(unchanged.body.visible, full);
  assert.deepEqual(unchanged.body.solo, full);
  await expect(page.getByRole('button', { name: 'Undo view change', exact: true })).toBeDisabled();
  await page.getByPlaceholder('Search runs by name or ID').fill('Extra run');
  await expect(page.locator('.side-footer')).toContainText('0 soloed · 10,000 hidden by filter');
  await page.getByPlaceholder('Search runs by name or ID').fill('');
  const nearly = await create('Nearly full', {
    visible: [...runIds.slice(0, 9990), ...unlisted(limit - runIds.length)],
    panels: [],
  });
  await open(nearly);
  await page.getByRole('button', { name: 'Show listed runs', exact: true }).click();
  await expect(
    page.getByText(
      `Showing these runs would make ${format(limit + 1)} runs visible. A view can show up to ${format(limit)}. Filter the list to fewer runs or hide some runs, then try again.${deletedNote}`,
      { exact: true },
    ),
  ).toBeVisible();
  await page.locator('.run-row [data-toggle="visible"][aria-pressed="true"]').first().click();
  await saved(nearly, limit - 11, 0);
  await expect(page.getByText(/would make .* runs visible/)).toHaveCount(0);
  checks.push(
    'Over-limit pointer, keyboard, and bulk selection attempts are refused before state, history, or storage changes; the message depends on the stored count, filtered totals name the view total, and the message clears once the stored selection changes',
  );

  // A view deleted elsewhere offers only Save as new view.
  {
    const doomed = await create('Deleted elsewhere', { panels: [] });
    await open(doomed);
    await server.tools.execute('view_delete', { id: doomed.id });
    await page.locator('.run-row [data-toggle="visible"]').first().click();
    const failureNotice = page.locator('#save-failure');
    await expect(failureNotice).toContainText('This view was deleted.');
    await expect(
      failureNotice.getByRole('button', { name: 'Reload saved view', exact: true }),
    ).toHaveCount(0);
    await failureNotice.getByRole('button', { name: 'Save as new view', exact: true }).click();
    await expect(page.locator('.save-status .current')).toHaveText('Saved');
  }
  checks.push('A deleted view offers Save as new view without a reload that cannot work');

  // Discarding a draft whose create response was lost removes the stored view.
  await server.db.call('upsert', {
    entity: 'test',
    project: 'discard',
    name: 'x-0',
    displayName: 'Discard run 0',
  });
  const discardRun = await server.db.call('upsert', {
    entity: 'test',
    project: 'discard',
    name: 'x-1',
    displayName: 'Discard run 1',
  });
  let loseDiscardCreate = true;
  await page.route('**/api/tools/view_create', async (route) => {
    if (!loseDiscardCreate) return route.continue();
    loseDiscardCreate = false;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.goto(`${origin}/test/discard/workspace`);
  await expect(page.locator('.run-row').first()).toBeVisible();
  await page.locator('[data-entry-key="' + discardRun.id + '"] [data-toggle="solo"]').click();
  await expect(page.locator('.save-status .current')).toHaveText('Not saved');
  await page
    .locator('#save-failure')
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click();
  await expect(page.locator('#save-failure')).toHaveCount(0);
  assert.equal(
    (await server.db.call('views')).filter((item) => item.project === 'test/discard').length,
    0,
    'Discard removes the view the lost create stored',
  );
  await page.locator('[data-entry-key="' + discardRun.id + '"] [data-toggle="visible"]').click();
  await expect(page.locator('.save-status .current')).toHaveText('Saved');
  const kept = (await server.db.call('views')).filter((item) => item.project === 'test/discard');
  assert.equal(kept.length, 1);
  assert.deepEqual((await server.db.call('view', kept[0].id)).body.solo, []);
  await page.unroute('**/api/tools/view_create');
  checks.push('Discard after a lost create removes the stored view; the next edit saves once');

  // A failed deletion is retried by the next Discard, but never deletes another session's change.
  for (const changedElsewhere of [false, true]) {
    const project = changedElsewhere ? 'discard-conflict' : 'discard-retry';
    await server.db.call('upsert', { entity: 'test', project, name: 'y-0', displayName: 'Y 0' });
    const target = await server.db.call('upsert', {
      entity: 'test',
      project,
      name: 'y-1',
      displayName: 'Y 1',
    });
    let lose = true,
      failDelete = true;
    await page.route('**/api/tools/view_create', async (route) => {
      if (!lose) return route.continue();
      lose = false;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.route('**/api/views/*', (route) =>
      route.request().method() === 'DELETE' && failDelete
        ? route.abort('connectionreset')
        : route.continue(),
    );
    await page.goto(`${origin}/test/${project}/workspace`);
    await expect(page.locator('.run-row').first()).toBeVisible();
    await page.locator('[data-entry-key="' + target.id + '"] [data-toggle="solo"]').click();
    await expect(page.locator('.save-status .current')).toHaveText('Not saved');
    const discard = page
      .locator('#save-failure')
      .getByRole('button', { name: 'Discard changes', exact: true });
    await discard.click();
    await expect(page.locator('#save-failure')).toContainText(
      'Your changes were not discarded. Check the connection, then discard them again.',
    );
    failDelete = false;
    const [stored] = (await server.db.call('views')).filter(
      (item) => item.project === 'test/' + project,
    );
    if (changedElsewhere) {
      const current = await server.db.call('view', stored.id);
      await server.tools.execute('view_save', {
        id: current.id,
        name: current.name,
        project: current.project,
        version: current.version,
        body: {
          ...current.body,
          panels: [{ id: 'other', plugin: 'line', metric: 'loss', title: 'Other' }],
        },
      });
    }
    await discard.click();
    if (changedElsewhere) {
      await expect(page.locator('#save-failure')).toContainText('changed in another session');
      await expect(
        page
          .locator('#save-failure')
          .getByRole('button', { name: 'Reload saved view', exact: true }),
      ).toBeVisible();
      const remaining = (await server.db.call('views')).filter(
        (item) => item.project === 'test/' + project,
      );
      assert.equal(remaining.length, 1, "another session's change is kept");
      assert.equal((await server.db.call('view', stored.id)).body.panels.length, 1);
    } else {
      await expect(page.locator('#save-failure')).toHaveCount(0);
      assert.equal(
        (await server.db.call('views')).filter((item) => item.project === 'test/' + project).length,
        0,
        'the retried Discard deletes the stored view',
      );
      await page.locator('[data-entry-key="' + target.id + '"] [data-toggle="visible"]').click();
      await expect(page.locator('.save-status .current')).toHaveText('Saved');
      assert.equal(
        (await server.db.call('views')).filter((item) => item.project === 'test/' + project).length,
        1,
      );
    }
    await page.unroute('**/api/tools/view_create');
    await page.unroute('**/api/views/*');
  }
  checks.push(
    'A failed Discard deletion is retried, and a change from another session turns it into a conflict instead',
  );

  // A never-saved draft whose create response is lost is adopted on Retry, not duplicated.
  await server.db.call('upsert', {
    entity: 'test',
    project: 'draft',
    name: 'd-0',
    displayName: 'Draft run 0',
  });
  const draftRun = await server.db.call('upsert', {
    entity: 'test',
    project: 'draft',
    name: 'd-1',
    displayName: 'Draft run 1',
  });
  let loseCreate = true;
  await page.route('**/api/tools/view_create', async (route) => {
    if (!loseCreate) return route.continue();
    loseCreate = false;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.goto(`${origin}/test/draft/workspace`);
  await expect(page.locator('.run-row').first()).toBeVisible();
  await page.locator('[data-entry-key="' + draftRun.id + '"] [data-toggle="solo"]').click();
  await expect(page.locator('.save-status .current')).toHaveText('Not saved');
  await expect(
    page.locator('#save-failure').getByRole('button', { name: 'Reload saved view', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('#save-failure').getByRole('button', { name: 'Discard changes', exact: true }),
  ).toBeVisible();
  await page.locator('#save-failure').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.save-status .current')).toHaveText('Saved');
  const draftViews = (await server.db.call('views')).filter(
    (item) => item.project === 'test/draft',
  );
  assert.equal(draftViews.length, 1, 'one view exists after Retry');
  assert.deepEqual((await server.db.call('view', draftViews[0].id)).body.solo, [draftRun.id]);
  await page.locator('[data-entry-key="' + draftRun.id + '"] [data-toggle="solo"]').click();
  await expect(page.locator('.save-status .current')).toHaveText('Saved');
  assert.deepEqual((await server.db.call('view', draftViews[0].id)).body.solo, []);
  await page.unroute('**/api/tools/view_create');
  checks.push(
    'A lost create response is adopted on Retry; never-saved drafts offer Discard instead of Reload',
  );

  // On a phone, a save failure and its recovery buttons appear inside the open runs drawer.
  const phone = await browser.newContext({
    viewport: { width: 320, height: 568 },
    hasTouch: true,
    isMobile: true,
  });
  await phone.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const mobile = await phone.newPage();
  mobile.on('pageerror', (error) => errors.push(error.message));
  let mobileFailure = true;
  await mobile.route('**/api/views/' + filtered.id, (route) =>
    route.request().method() === 'PUT' && mobileFailure
      ? route.abort('connectionreset')
      : route.continue(),
  );
  await mobile.goto(`${origin}/test/bulk/workspace?view=${filtered.id}`);
  await mobile.getByRole('button', { name: 'Show runs', exact: true }).click();
  await mobile.locator('.run-row [data-toggle="visible"]').first().tap();
  const notice = mobile.locator('.run-sidebar #save-failure');
  await expect(notice).toBeVisible();
  const retry = notice.getByRole('button', { name: 'Retry', exact: true });
  for (const control of [
    notice,
    retry,
    notice.getByRole('button', { name: 'Reload saved view', exact: true }),
  ]) {
    const box = await control.boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= 320.5,
      'failure fits the phone width: ' + JSON.stringify(box),
    );
  }
  mobileFailure = false;
  await retry.tap();
  await expect(notice).toHaveCount(0);
  await expect(mobile.locator('.operation-toast, .save-status').first()).toBeAttached();
  // The longer conflict buttons wrap inside the drawer in Japanese.
  await mobile.evaluate(() => localStorage.setItem('randl.language', 'ja'));
  await mobile.goto(`${origin}/test/bulk/workspace?view=${filtered.id}`);
  let conflictPending = true;
  await mobile.route('**/api/views/' + filtered.id, async (route) => {
    if (route.request().method() === 'PUT' && conflictPending) {
      conflictPending = false;
      const current = await server.db.call('view', filtered.id);
      await server.tools.execute('view_save', {
        id: filtered.id,
        name: current.name,
        project: current.project,
        version: current.version,
        body: { ...current.body, visible: [runIds[1]] },
      });
    }
    await route.continue();
  });
  await mobile.locator('#open-runs').tap();
  await mobile.locator('.run-row [data-toggle="visible"]').first().tap();
  const conflictNotice = mobile.locator('.run-sidebar #save-failure');
  await expect(conflictNotice).toBeVisible();
  const conflictButtons = conflictNotice.locator('button');
  assert.equal(await conflictButtons.count(), 2);
  const drawerBox = await mobile.locator('.run-sidebar').boundingBox();
  for (let index = 0; index < 2; index++) {
    const box = await conflictButtons.nth(index).boundingBox();
    assert.ok(
      box.x >= drawerBox.x && box.x + box.width <= drawerBox.x + drawerBox.width + 0.5,
      'conflict button fits the drawer: ' + JSON.stringify({ box, drawerBox }),
    );
  }
  assert.equal(
    await mobile.locator('.run-sidebar').evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  await phone.close();
  checks.push(
    'At 320 px a save failure appears inside the runs drawer with reachable recovery buttons, including the Japanese conflict pair',
  );

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
