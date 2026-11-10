import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';

// Shell, run page, project page and settings details from the 2026-10-14 UI audit.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-shell-details-'));
const store = new Store(directory);
const longName = (i) =>
  'ppo' +
  (400 + i) +
  '_cartpole_envs16_mlp512_rollout2048_minibatch64_epochs10_gae095_clip02_vfcoef05_entcoef001_lr3e4_seed1';
store.db.transaction(() => {
  for (let i = 0; i < 120; i++) {
    const run = store.upsert({
      entity: 'shell',
      project: 'details',
      name: 'run-' + String(i).padStart(3, '0'),
      displayName: longName(i),
    });
    store.db
      .prepare("UPDATE runs SET state='finished',created=? WHERE id=?")
      .run(1000000 + i, run.id);
  }
})();
store.db.close();
const project = 'shell/details';
// The newest run is listed first, so its group heading stays mounted beside it.
const runId = project + '/run-118';
let server, browser;
const checks = [];
try {
  server = await createServer(directory);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  const grouped = await server.tools.execute('view_create', {
    project,
    name: 'Grouped',
    body: {
      generation: 'manual',
      panels: [],
      visible: [runId],
      solo: [],
      runQuery: { sort: '-created', group: 'state' },
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // The page title keeps one vertical position on every page.
  const titleTop = () =>
    page.locator('.page-bar h1').evaluate((e) => Math.round(e.getBoundingClientRect().top));
  await page.goto(origin + '/');
  await expect(page.locator('.page-bar h1')).toHaveText('Projects');
  const projectsTop = await titleTop();
  await page.goto(origin + '/' + project + '/overview');
  await expect(page.locator('.overview-runs tbody tr').first()).toBeVisible();
  assert.equal(await titleTop(), projectsTop, 'title top matches on Projects and project pages');
  // The brand, the page's title and controls, and the app actions share one header row.
  for (const width of [1440, 1056, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      '/',
      '/' + project + '/overview',
      '/' + runId.replace(project, project + '/runs'),
    ]) {
      await page.goto(origin + path);
      await expect(page.locator('.bx--header .page-bar h1')).toBeVisible();
      const row = await page.evaluate(() => {
        const header = document.querySelector('.bx--header').getBoundingClientRect(),
          title = document.querySelector('.page-bar h1').getBoundingClientRect(),
          brand = document.querySelector('.bx--header__name').getBoundingClientRect();
        return {
          header: header.height,
          mainTop: Math.round(document.querySelector('main').getBoundingClientRect().top),
          outside: [
            ...document.querySelectorAll('.bx--header a, .bx--header button, .bx--header select'),
          ]
            .map((element) => element.getBoundingClientRect())
            .filter((r) => r.width && (r.left < -0.5 || r.right > innerWidth + 0.5)).length,
          titleWidth: Math.round(title.width),
          brand: brand.width > 0,
        };
      });
      assert.equal(row.header, 48, `${width} ${path}: one header row`);
      assert.equal(row.mainTop, 48, `${width} ${path}: content starts below the header`);
      assert.equal(row.outside, 0, `${width} ${path}: header controls fit`);
      assert.ok(row.titleWidth >= 40, `${width} ${path}: the page title stays readable`);
      assert.equal(row.brand, width > 760, `${width} ${path}: brand on wide screens`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The brand is the way back to the project list.
  await page.goto(origin + '/' + project + '/overview');
  await page.locator('.bx--header__name').click();
  await expect(page).toHaveURL(origin + '/?page=overview');
  await expect(page.locator('.page-bar h1')).toHaveText('Projects');
  await page.goto(origin + '/' + project + '/overview');
  await expect(page.locator('.overview-runs tbody tr').first()).toBeVisible();
  checks.push('one header row holds the brand, page title and actions at every width');

  // Page surfaces reach the viewport edge when nothing scrolls.
  assert.equal(
    await page.locator('main').evaluate((m) => m.offsetWidth - m.clientWidth),
    0,
    'main reserves no empty scrollbar gutter',
  );
  // Overview uses the Runs table's timestamp name and one-line names with an ellipsis.
  await expect(page.locator('.overview-runs th').last()).toHaveText('Created');
  const overviewName = await page
    .locator('.overview-runs .table-link-text')
    .first()
    .evaluate((e) => ({
      ellipsis: getComputedStyle(e).textOverflow,
      clipped: e.scrollWidth > e.clientWidth,
      height: e.getBoundingClientRect().height,
    }));
  assert.deepEqual(overviewName.ellipsis, 'ellipsis');
  assert.ok(overviewName.clipped && overviewName.height < 24, 'overview names stay on one line');
  await expect(page.getByRole('button', { name: 'Deleted runs' })).toHaveCount(0);
  checks.push('title alignment, page gutter and overview names/timestamps');

  await page.goto(origin + '/' + project + '/settings');
  await expect(page.getByRole('button', { name: 'Deleted runs' })).toBeVisible();
  const settings = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.project-settings .bx--btn')].find(
      (b) => b.textContent.trim() === 'View deleted runs',
    );
    const field = document.querySelector('.project-settings .bx--text-input');
    return (
      button && {
        button: Math.round(button.getBoundingClientRect().left),
        field: Math.round(field.getBoundingClientRect().left),
      }
    );
  });
  assert.ok(
    settings && settings.button === settings.field,
    'Deleted runs aligns with the settings form edge',
  );

  await page.goto(origin + '/' + project + '/artifacts');
  await expect(page.locator('.empty-table')).toHaveText('No artifacts yet');
  await page.getByRole('searchbox', { name: 'Search artifacts' }).fill('missing');
  await expect(page.locator('.empty-table p')).toHaveText('No matching artifacts');
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search artifacts' }).fill('');
  await expect(page.locator('.empty-table')).toHaveText('No artifacts yet');
  checks.push('single Deleted runs entry point and artifact empty/no-match states');

  // Runs table names fill their cell and end with a rendered ellipsis.
  await page.goto(origin + '/' + project + '/runs');
  const tableName = await page
    .locator('tbody tr[data-row] .table-link-text')
    .first()
    .evaluate((e) => ({
      ellipsis: getComputedStyle(e).textOverflow,
      clipped: e.scrollWidth > e.clientWidth,
      fill: e.closest('td').getBoundingClientRect().right - e.getBoundingClientRect().right,
    }));
  assert.equal(tableName.ellipsis, 'ellipsis');
  assert.ok(
    tableName.clipped && tableName.fill < 40,
    'run name uses the column width: ' + JSON.stringify(tableName),
  );

  // The runs heading holds Filter, Group and Sort; the Runs page stays reachable from the rail.
  await page.goto(origin + '/' + project + '/workspace');
  const runsHeading = page.locator('.run-sidebar .runs-heading');
  for (const name of ['Filter', 'Group', 'Sort'])
    await expect(runsHeading.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand runs table' })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Project pages', exact: true })
    .getByRole('button', { name: 'Runs', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs/);
  checks.push(
    'runs table ellipsis; Filter, Group and Sort in the runs heading; Runs page from the rail',
  );

  // A run opened from the Runs page titles the header and names that origin in Back.
  await page.getByRole('link', { name: longName(110), exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/run-110/);
  await expect(page.locator('.page-bar h1')).toHaveText(longName(110));
  await page.getByRole('button', { name: 'Back to runs' }).click();
  await expect(page).toHaveURL(/\/details\/runs(\?|$)/);
  await expect(
    page.locator('tbody tr[data-row="' + project + '/run-110"] .table-link'),
  ).toBeFocused();

  // The active tab's search shares the tab row and follows the tabs in focus order.
  await page.goto(origin + '/' + project + '/runs/run-110/logs');
  await expect(
    page.locator('.run-tab-actions').getByRole('searchbox', { name: 'Search logs' }),
  ).toBeVisible();
  const row = await page.evaluate(() => {
    const nav = document.querySelector('.run-tabs > .bx--tabs').getBoundingClientRect(),
      actions = document.querySelector('.run-tab-actions').getBoundingClientRect();
    return {
      nav: Math.round(nav.top),
      actions: Math.round(actions.top),
      right: Math.round(actions.right),
    };
  });
  assert.equal(row.actions, row.nav, 'tab actions share the tab row: ' + JSON.stringify(row));
  await expect(
    page.locator('.run-tab-actions').getByRole('searchbox', { name: 'Search logs' }),
  ).toBeVisible();
  await expect(page.locator('.page-row, .page-toolbar, .metadata-toolbar')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Logs' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('searchbox', { name: 'Search logs' })).toBeFocused();

  // Not-found pages name their state in the header's title.
  await page.goto(origin + '/' + project + '/runs/missing');
  await expect(page.locator('.page-bar h1')).toHaveText('Run not found');
  checks.push('run origin in Back, tab-row actions and not-found headings');

  // Back from a run returns focus to that run in the list, through history and directly.
  await page.goto(origin + '/' + project + '/workspace?view=' + (grouped.view?.id || grouped.id));
  const runName = page.locator(`aside [data-run-id="${runId}"] [data-control="name"]`);
  await runName.waitFor();
  await runName.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/runs\/run-118/);
  // The state and export action share the header; no separate status row remains.
  await expect(page.locator('.page-bar .run-state-tag')).toHaveText('Finished');
  await expect(page.locator('.page-bar .run-export')).toHaveText('Export full history');
  const groupLabel = await page
    .locator('aside .run-group .group-label')
    .first()
    .evaluate((e) => e.getBoundingClientRect().width);
  assert.ok(groupLabel > 150, 'run-page group label uses the free width: ' + groupLabel);
  await expect(page.locator('aside .side-footer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to workspace' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator(`aside [data-run-id="${runId}"] [data-control="name"]`)).toBeFocused();
  // A directly loaded run far down the list is scrolled into view before it is focused.
  for (const id of [runId, project + '/run-005']) {
    await page.goto(origin + '/' + project + '/runs/' + id.split('/').pop() + '/overview');
    await page.getByRole('button', { name: 'Back to workspace' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/workspace/);
    const returned = page.locator(`aside [data-run-id="${id}"] [data-control="name"]`);
    await expect(returned).toBeFocused();
    const inside = await returned.evaluate((e) => {
      const row = e.closest('[data-run-id]').getBoundingClientRect(),
        list = document.getElementById('run-list').getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom;
    });
    assert.ok(inside, id + ' row is fully visible after Back');
  }
  checks.push('run heading state/export, run-page group label, Back focus restoration');

  // Run overview copy action follows its value at row height; empty states share one style.
  await page.goto(origin + '/' + project + '/runs/run-118/overview');
  const copy = await page
    .locator('.copy-value')
    .first()
    .evaluate((dd) => {
      const code = dd.querySelector('code').getBoundingClientRect(),
        button = dd.querySelector('.bx--btn').getBoundingClientRect();
      return { gap: button.left - code.right, height: dd.getBoundingClientRect().height };
    });
  assert.ok(
    copy.gap >= 0 && copy.gap <= 8 && copy.height <= 20,
    'copy button sits beside its value: ' + JSON.stringify(copy),
  );
  const empty = [];
  for (const tab of ['logs', 'files', 'artifacts']) {
    await page.goto(origin + '/' + project + '/runs/run-118/' + tab);
    await expect(page.locator('.run-tabs .empty-table:visible').first()).toBeVisible();
    empty.push(
      ...(await page.locator('.run-tabs .empty-table:visible').evaluateAll((items) =>
        items.map((e) => ({
          text: e.textContent.trim(),
          font: getComputedStyle(e).fontFamily,
          size: getComputedStyle(e).fontSize,
        })),
      )),
    );
  }
  assert.deepEqual(
    new Set(empty.map((e) => e.size + e.font)).size,
    1,
    'run-page empty states share one style',
  );
  assert.ok(
    empty.every((e) => !e.text.endsWith('.') && !e.font.includes('Mono')),
    JSON.stringify(empty),
  );
  checks.push('inline copy action and uniform run-page empty states');

  // App settings page: General tab, Theme field, field fill, field-height Install.
  await page.locator('#app-settings').click();
  const dialog = page.locator('.app-settings-page');
  await expect(dialog.getByRole('tab', { name: 'General' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
  const fill = await dialog
    .getByRole('combobox', { name: 'Theme', exact: true })
    .evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.equal(fill, 'rgb(255, 255, 255)', 'the page\'s fields stand out from its background');
  await dialog.getByRole('tab', { name: 'Panel plugins' }).click();
  const install = await page.evaluate(() => ({
    input: document.querySelector('#plugin-source').getBoundingClientRect().height,
    button: [...document.querySelectorAll('.plugin-install .bx--btn')][0].getBoundingClientRect()
      .height,
  }));
  assert.equal(install.button, install.input, 'Install matches the source field height');
  checks.push('App settings labels, drawer field fill and Install height');

  // App settings are a page of their own, beside Projects and Server; every tab shows.
  assert.equal(
    await page.locator('.bx--header #app-settings').count(),
    0,
    'App settings left the header',
  );
  const rail = page.getByRole('navigation', { name: 'Project pages', exact: true });
  for (const name of ['Projects', 'Server', 'App settings'])
    await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'App settings', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page).toHaveURL(/[?&]page=app-settings/);
  for (const name of ['General', 'Assistant', 'Panel plugins', 'Storage'])
    await expect(dialog.getByRole('tab', { name, exact: true })).toBeInViewport({ ratio: 1 });
  // Storage: the media limit is a switch with its size, never a special number.
  await dialog.getByRole('tab', { name: 'Storage', exact: true }).click();
  const limitSwitch = dialog.getByRole('switch', { name: 'Limit media per run' }),
    limitSize = dialog.getByRole('spinbutton', { name: 'Limit per run (MB)' }),
    saveLimit = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(limitSwitch).toBeChecked();
  await expect(limitSize).toHaveValue('500');
  await expect(saveLimit).toBeDisabled();
  await limitSize.fill('0');
  await expect(dialog.getByText('Enter a whole number from 1 to 1,048,576.')).toBeVisible();
  await expect(saveLimit).toBeDisabled();
  await limitSize.fill('750');
  await saveLimit.click();
  await expect(dialog.getByText('Saved. Runs over the limit are being thinned.')).toBeVisible();
  await dialog.locator('label[for="media-limit-enabled"]').click();
  await expect(limitSwitch).not.toBeChecked();
  await expect(limitSize).toHaveCount(0);
  await saveLimit.click();
  await expect(dialog.getByText('Saved. Runs keep all their media.')).toBeVisible();
  const storedLimit = await page.evaluate(() =>
    fetch('/api/tools/settings_get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((response) => response.json()),
  );
  assert.deepEqual(storedLimit, { mediaLimit: { enabled: false, megabytes: 750 } });
  checks.push('App settings page in the navigation; media limit switch and size');
  await page.close();

  // Mobile: the page's name stays visible in the header's one row and the runs drawer closes from the trailing edge.
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  for (const path of ['/overview', '/workspace', '/runs/run-118']) {
    await mobile.goto(origin + '/' + project + path);
    // The workspace is named by its view; other pages by their title.
    const title = mobile.locator(
      path === '/workspace' ? '.page-bar :is(.view-name, select)' : '.page-bar h1',
    );
    await expect(title).toBeVisible();
    const current = await title.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { width: r.width, right: r.right };
    });
    assert.ok(
      current.width > 40 && current.right <= 390,
      path + ' page title visible: ' + JSON.stringify(current),
    );
  }
  await mobile.goto(origin + '/' + project + '/overview');
  const overviewRow = await mobile
    .locator('.overview-runs tbody tr')
    .first()
    .evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(overviewRow < 50, 'overview rows stay one line on mobile: ' + overviewRow);
  assert.ok(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= 390),
    'no page-level horizontal scroll',
  );
  await mobile.goto(origin + '/' + project + '/workspace');
  await mobile.locator('#open-runs').click();
  const heading = await mobile.evaluate(() => {
    const h = document.querySelector('.runs-heading h2').getBoundingClientRect();
    const close = [...document.querySelectorAll('.runs-heading .bx--btn')].at(-1);
    const drawer = document.querySelector('aside.run-sidebar').getBoundingClientRect();
    return {
      title: h.left - drawer.left,
      close: close.getAttribute('aria-label') || close.textContent.trim(),
      inset: drawer.right - close.getBoundingClientRect().right,
    };
  });
  assert.ok(
    heading.title <= 16 && heading.close.includes('Close runs') && heading.inset <= 16,
    JSON.stringify(heading),
  );
  checks.push('mobile page title, overview rows and drawer header layout');
  await mobile.close();

  // CJK headings keep weight with regular-only system fonts.
  const zh = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  await zh.goto(origin + '/' + project + '/runs/run-118/overview');
  await expect(zh.locator('.run-overview h3').first()).toBeVisible();
  assert.equal(
    await zh.locator('html').evaluate((e) => getComputedStyle(e).fontSynthesisWeight),
    'auto',
  );
  await zh.close();
  checks.push('CJK weight synthesis');
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
