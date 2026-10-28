import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const expect = baseExpect.configure({ timeout: 10000 });
const afterLayout = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const directory = await mkdtemp(join(tmpdir(), 'randl-run-controls-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const url = await listen(server);
  const runs = [];
  for (let i = 0; i < 80; i++)
    runs.push(
      await server.db.call('upsert', {
        entity: 'test',
        project: 'controls',
        name: 'run-' + i,
        displayName: 'A long experiment name with configuration details and a readable suffix ' + i,
      }),
    );
  const view = await server.tools.execute('view_create', {
    project: 'test/controls',
    name: 'Controls',
    body: {
      generation: 'manual',
      panels: [],
      visible: [runs[0].id],
      solo: [],
      pinned: [runs[0].id],
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  const path = url + '/test/controls/workspace?view=' + view.id;
  await page.goto(path);
  const row = page.locator('[data-run-id="' + runs[0].id + '"]');
  await expect(row).toBeVisible();
  const name = row.locator('.run-name'),
    pin = row.locator('.run-pin'),
    menu = row.locator('.run-menu .bx--overflow-menu');
  await page.mouse.move(0, 0);
  await expect(pin).toHaveCSS('opacity', '0');
  await expect(row.locator('.run-menu')).toHaveCSS('opacity', '0');
  const before = await name.boundingBox(),
    rowBox = await row.boundingBox();
  assert.ok(
    rowBox.x + rowBox.width - before.x - before.width <= 9,
    'Name uses trailing row width at rest',
  );
  await row.hover();
  await expect(pin).toBeVisible();
  await expect(menu).toBeVisible();
  assert.deepEqual(await name.boundingBox(), before, 'Hover must not reflow the name');
  const mb = await menu.boundingBox(),
    pb = await pin.boundingBox();
  assert.ok(mb.x + mb.width <= pb.x + 0.1 && pb.x >= before.x && pb.x < before.x + before.width);
  for (const button of [menu, pin])
    assert.notEqual(
      await button.evaluate((n) => getComputedStyle(n.closest('.run-menu') || n).backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
  await menu.click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('menuitem', { name: 'Open run', exact: true })).toBeVisible();
  await expect(menu).toBeVisible();
  await expect(pin).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  checks.push(
    'Long names retain full layout width while opaque hover and open-menu actions overlay the trailing edge',
  );
  await name.focus();
  await page.keyboard.press('ArrowRight');
  await expect(menu).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(pin).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(pin).toBeFocused();
  await expect(pin).toHaveCSS('opacity', '1');
  await name.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeFocused();
  await expect(row.locator('.run-menu')).toHaveCSS('opacity', '1');
  await page.keyboard.press('ArrowRight');
  const initial = await server.db.call('view', view.id);
  await page.keyboard.press('Space');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(pin).toBeFocused();
  await expect.poll(async () => (await server.db.call('view', view.id)).body.pinned).toEqual([]);
  const after = await server.db.call('view', view.id);
  assert.deepEqual(after.body.visible, initial.body.visible);
  assert.deepEqual(after.body.solo, initial.body.solo);
  await page.keyboard.press('Space');
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(pin).toBeFocused();
  await page.locator('main').click({ position: { x: 200, y: 400 } });
  await page.mouse.move(0, 0);
  await expect(pin).toHaveCSS('opacity', '0');
  await expect(row.locator('.run-menu')).toHaveCSS('opacity', '0');
  checks.push(
    'Keyboard actions reveal controls, preserve focus across pin moves, preserve visibility/solo, and hide pinned actions at rest',
  );
  assert.ok((await page.locator('.run-row').count()) < runs.length);
  const touch = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
    isMobile: true,
  });
  touch.on('pageerror', (e) => errors.push(e.message));
  await touch.goto(path);
  const touchTargetId = await touch.locator('.run-row').nth(1).getAttribute('data-run-id');
  const touchRow = touch.locator('[data-run-id="' + touchTargetId + '"]');
  await expect(touchRow).toBeVisible();
  const touchPin = touchRow.locator('.run-pin'),
    touchMenu = touchRow.locator('.run-menu .bx--overflow-menu');
  await expect(touchPin).toBeVisible();
  await expect(touchMenu).toBeVisible();
  for (const item of [touchPin, touchMenu]) {
    const b = await item.boundingBox();
    assert.ok(b.width >= 40 && b.height >= 44);
  }
  await touchPin.tap();
  await expect(touchPin).toHaveAttribute('aria-pressed', 'true');
  await touchMenu.tap();
  await expect(touch.getByRole('menuitem', { name: 'Open run', exact: true })).toBeVisible();
  checks.push(
    'Touch exposes menu and pin without hover with 40×44 targets; virtualization remains bounded',
  );
  await touch.keyboard.press('Escape');
  await touchPin.tap();
  await expect(touchPin).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.pinned)
    .toEqual([runs[0].id]);
  for (const width of [820, 390, 320]) {
    await touch.setViewportSize({ width, height: 844 });
    await afterLayout(touch);
    if (await touch.getByRole('button', { name: 'Show runs', exact: true }).isVisible())
      await touch.getByRole('button', { name: 'Show runs', exact: true }).tap();
    if (width > 390) await expect(touchPin).toBeVisible();
    else await expect(touchPin).toBeHidden();
    for (const control of width > 390 ? [touchPin, touchMenu] : [touchMenu]) {
      assert.ok(
        await control.evaluate((n) => {
          const b = n.getBoundingClientRect(),
            bounds = n.closest('.run-row').getBoundingClientRect();
          return b.x >= bounds.x && b.right <= bounds.right;
        }),
      );
    }
    assert.deepEqual(
      await touch.evaluate(() => {
        const header = [
          ...document.querySelector('.run-table-heading').querySelectorAll('button svg'),
        ];
        const row = [...document.querySelector('.run-row').querySelectorAll('.toggle svg')];
        return header.map((n, i) => {
          const a = n.getBoundingClientRect(),
            b = row[i].getBoundingClientRect();
          return a.x + a.width / 2 - b.x - b.width / 2;
        });
      }),
      // The heading has no solo toggle; Clear solo appears there only while runs are soloed.
      [0],
      'Visibility heading icon aligns with its run column',
    );
    assert.ok(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const close = touch.locator('aside').getByRole('button', { name: 'Close runs', exact: true });
    if (await close.isVisible()) await close.tap();
  }
  checks.push('Touch actions remain reachable and within the run row at 820, 390 and 320 pixels');
  for (const theme of ['g10', 'g100']) {
    await page.evaluate((theme) => localStorage.setItem('randl.theme', theme), theme);
    await page.reload();
    await expect(row).toBeVisible();
    await page.mouse.move(0, 0);
    await name.focus();
    const baselineSurface = await row.evaluate(
      (n) => getComputedStyle(n.closest('aside')).backgroundColor,
    );
    assert.equal(await pin.evaluate((n) => getComputedStyle(n).backgroundColor), baselineSurface);
    await row.hover();
    const surface = await row.evaluate((n) => getComputedStyle(n).backgroundColor);
    assert.equal(await pin.evaluate((n) => getComputedStyle(n).backgroundColor), surface);
    assert.equal(
      await row.locator('.run-menu').evaluate((n) => getComputedStyle(n).backgroundColor),
      surface,
    );
  }
  checks.push('Light and dark action surfaces match focused and hovered row backgrounds');
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 1980));
  const deepRow = page.locator('.run-row[aria-posinset="61"]');
  await expect(deepRow).toBeVisible();
  const deepId = await deepRow.getAttribute('data-run-id');
  await deepRow.hover();
  await deepRow.locator('.run-pin').click();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.pinned.includes(deepId))
    .toBe(true);
  assert.ok(Math.abs((await page.locator('#run-list').evaluate((n) => n.scrollTop)) - 1980) <= 36);
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
  const movedRow = page.locator('[data-run-id="' + deepId + '"]');
  await movedRow.hover();
  await movedRow.locator('.run-pin').click();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.pinned.includes(deepId))
    .toBe(false);
  assert.equal(await page.locator('#run-list').evaluate((n) => n.scrollTop), 0);
  await page.mouse.move(0, 0);
  assert.ok(
    await page
      .locator('.run-row .run-menu')
      .evaluateAll((nodes) => nodes.every((n) => getComputedStyle(n).opacity === '0')),
  );
  const firstMenu = page.locator('.run-row').first().locator('.run-menu .bx--overflow-menu');
  await page.locator('.run-row').first().hover();
  await firstMenu.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 2200));
  await expect(page.getByRole('menu')).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const row = document.activeElement.closest('.run-row');
        if (!row) return false;
        const bounds = row.getBoundingClientRect();
        const viewport = document.getElementById('run-list').getBoundingClientRect();
        return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
      }),
    )
    .toBe(true);
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
  checks.push(
    'Pointer pinning retains the viewport and scrolling an open menu out preserves list focus',
  );
  const focusedRowFullyVisible = () =>
    page.evaluate(() => {
      const row = document.activeElement.closest('.run-row');
      if (!row) return false;
      const r = row.getBoundingClientRect(),
        l = document.getElementById('run-list').getBoundingClientRect();
      return r.top >= l.top && r.bottom <= l.bottom;
    });
  for (const distance of [4, 20]) {
    await page.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
    await expect(page.locator('.run-row').first()).toHaveAttribute('aria-posinset', '1');
    const focusedName = page.locator('.run-row').first().locator('.run-name');
    await focusedName.focus();
    await page.locator('#run-list').hover();
    await page.mouse.wheel(0, distance);
    await expect.poll(() => page.locator('#run-list').evaluate((n) => n.scrollTop)).toBe(distance);
    await expect(focusedName).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(focusedRowFullyVisible).toBe(true);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(focusedRowFullyVisible).toBe(true);
  }
  for (const distance of [600, 610, 2500, 2900]) {
    await page.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
    await expect(page.locator('.run-row').first()).toHaveAttribute('aria-posinset', '1');
    await page.locator('.run-row').first().locator('.run-name').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    const expected = await page
      .locator('#run-list')
      .evaluate((n, distance) => Math.min(distance, n.scrollHeight - n.clientHeight), distance);
    await page.locator('#run-list').hover();
    await page.mouse.wheel(0, distance);
    await expect.poll(() => page.locator('#run-list').evaluate((n) => n.scrollTop)).toBe(expected);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const row = document.activeElement.closest('.run-row');
          if (!row) return false;
          const r = row.getBoundingClientRect(),
            l = document.getElementById('run-list').getBoundingClientRect();
          return r.top >= l.top && r.bottom <= l.bottom;
        }),
      )
      .toBe(true);
  }
  // A list about 50 px tall: at most one full row, as the focus-fallback checks below need.
  await page.setViewportSize({ width: 1440, height: 243 });
  await afterLayout(page);
  assert.ok(
    (await page.locator('#run-list').evaluate((n) => n.clientHeight)) < 58,
    'the list shows less than two rows',
  );
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
  await expect(page.locator('.run-row').first()).toHaveAttribute('aria-posinset', '1');
  await page.locator('.run-row').first().locator('.run-name').focus();
  await page.locator('#run-list').hover();
  for (let step = 1; step <= 6; step++) {
    await page.mouse.wheel(0, 50);
    await expect.poll(() => page.locator('#run-list').evaluate((n) => n.scrollTop)).toBe(step * 50);
  }
  for (const key of ['ArrowDown', 'End', 'Home', 'PageDown', 'PageUp']) {
    await page.keyboard.press(key);
    await expect.poll(focusedRowFullyVisible).toBe(true);
  }
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
  await expect(page.locator('.run-row').first()).toHaveAttribute('aria-posinset', '1');
  await page.locator('.run-row').first().locator('.run-name').focus();
  await page.mouse.wheel(0, 50);
  await expect(page.locator('#run-list')).toBeFocused();
  await page.mouse.wheel(0, -14);
  await expect.poll(focusedRowFullyVisible).toBe(true);
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
  await expect(page.locator('.run-row').first()).toHaveAttribute('aria-posinset', '1');
  await page.locator('.run-row').first().locator('.run-name').focus();
  await page.mouse.wheel(0, 50);
  await expect(page.locator('#run-list')).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await afterLayout(page);
  await expect.poll(focusedRowFullyVisible).toBe(true);
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 600));
  const resizedRunId = await page.locator('.run-row').evaluateAll((rows) => {
    const list = document.getElementById('run-list').getBoundingClientRect();
    return rows
      .filter((row) => {
        const r = row.getBoundingClientRect();
        return r.top >= list.top && r.bottom <= list.bottom;
      })
      .at(-1)
      .getAttribute('data-run-id');
  });
  for (const kind of ['name', 'menu', 'pin']) {
    const row = page.locator('[data-run-id="' + resizedRunId + '"]');
    await row.evaluate((n) => n.scrollIntoView({ block: 'end' }));
    await afterLayout(page);
    const control = row.locator('[data-control="' + kind + '"]');
    await control.focus();
    for (const height of [330, 900, 330, 420, 700, 330, 900]) {
      await page.setViewportSize({ width: 1440, height });
      await afterLayout(page);
      await expect(control).toBeFocused();
      await expect.poll(focusedRowFullyVisible).toBe(true);
    }
  }
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = n.scrollHeight));
  await expect(page.locator('.run-row').last()).toHaveAttribute(
    'aria-posinset',
    String(runs.length),
  );
  const endRunId = await page.locator('.run-row').last().getAttribute('data-run-id');
  for (const kind of ['name', 'menu', 'pin']) {
    const control = page.locator('[data-run-id="' + endRunId + '"] [data-control="' + kind + '"]');
    await control.focus();
    for (const height of [330, 900, 330, 700, 330, 900]) {
      await page.setViewportSize({ width: 1440, height });
      await afterLayout(page);
      await expect(control).toBeFocused();
      await expect.poll(focusedRowFullyVisible).toBe(true);
    }
  }
  for (const width of [568, 900, 1024]) {
    await page.setViewportSize({ width, height: 700 });
    await afterLayout(page);
    await page.goto(path);
    await page.locator('.run-row').first().waitFor({ state: 'attached' });
    await afterLayout(page);
    if (await page.locator('aside').evaluate((node) => node.inert))
      await page.getByRole('button', { name: 'Show runs', exact: true }).first().click();
    await expect(page.locator('aside')).toHaveJSProperty('inert', false);
    await page.locator('#run-list [tabindex="0"]').focus();
    await page.keyboard.press('End');
    await expect(page.locator('.run-row').last()).toHaveAttribute(
      'aria-posinset',
      String(runs.length),
    );
    const id = await page.locator('.run-row').last().getAttribute('data-run-id');
    for (const kind of ['name', 'menu', 'pin']) {
      const control = page.locator('[data-run-id="' + id + '"] [data-control="' + kind + '"]');
      await control.focus();
      for (const height of [330, 700, 330, 900, 330, 700]) {
        await page.setViewportSize({ width, height });
        await afterLayout(page);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await expect(control).toBeFocused();
        await expect.poll(focusedRowFullyVisible).toBe(true);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await afterLayout(page);
  await page.goto(path);
  checks.push(
    'Manual scroll retains its offset; layout changes preserve and reveal the focused run and control',
  );

  async function setView(body) {
    const current = await server.db.call('view', view.id);
    const response = await fetch(url + '/api/views/' + view.id, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: current.name,
        project: current.project,
        body: { ...current.body, ...body },
        version: current.version,
      }),
    });
    assert.ok(response.ok);
    await page.reload();
  }
  await setView({ runQuery: { group: 'state' } });
  await expect(page.locator('.run-group')).toHaveCount(1);
  await expect(page.locator('.run-row').first()).toHaveAttribute('data-run-id', runs[0].id);
  await expect(page.locator('.run-row').first()).toHaveClass(/last-pinned/);
  const groupedTarget = page.locator('.run-row').nth(3),
    groupedId = await groupedTarget.getAttribute('data-run-id');
  await groupedTarget.hover();
  await groupedTarget.locator('.run-pin').click();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.pinned.includes(groupedId))
    .toBe(true);
  const firstTwo = await page
    .locator('.run-row')
    .evaluateAll((nodes) => nodes.slice(0, 2).map((n) => n.dataset.runId));
  assert.deepEqual(new Set(firstTwo), new Set([runs[0].id, groupedId]));
  await expect(page.locator('.run-row.last-pinned')).toHaveCount(1);
  await expect(page.locator('.run-row').nth(1)).toHaveClass(/last-pinned/);
  checks.push('Grouped pins form an ordered first block with one divider');
  await setView({ runQuery: {}, pinned: runs.slice(0, 20).map((r) => r.id) });
  await page.locator('#run-list').evaluate((n) => (n.scrollTop = 600));
  const unpinned = page
    .locator('.run-row')
    .filter({ has: page.locator('.run-pin[aria-pressed="false"]') })
    .first();
  await unpinned.hover();
  await unpinned.locator('.run-menu .bx--overflow-menu').click();
  await page.getByRole('menuitem', { name: 'Pin run', exact: true }).click();
  await expect(
    page.getByText('You can pin up to 20 runs. Unpin a run to pin another.', { exact: true }),
  ).toBeVisible();
  assert.equal((await server.db.call('view', view.id)).body.pinned.length, 20);
  const refreshed = Promise.all(
    ['/api/views', '/api/projects', '/api/plugins'].map((path) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path && response.request().method() === 'GET',
      ),
    ),
  );
  const background = await fetch(url + '/api/tools/view_create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: 'test/controls',
      name: 'Background event',
      body: { generation: 'manual', panels: [], visible: [], solo: [] },
    }),
  });
  assert.ok(background.ok);
  await Promise.all((await refreshed).map((response) => response.finished()));
  await afterLayout(page);
  await expect(
    page.getByText('You can pin up to 20 runs. Unpin a run to pin another.', { exact: true }),
  ).toBeVisible();
  let releaseSave;
  const saveGate = new Promise((resolve) => (releaseSave = resolve));
  await page.route('**/api/views/' + view.id, async (route) => {
    if (route.request().method() === 'PUT') await saveGate;
    await route.continue();
  });
  const saveStarted = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/views/' + view.id),
  );
  await page.locator('.run-row [data-control="visible"]').first().click();
  await saveStarted;
  await page.getByRole('button', { name: 'Close notification', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#run-list')).toBeFocused();
  const saveFinished = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/views/' + view.id),
  );
  releaseSave();
  await (await saveFinished).finished();
  await page.unroute('**/api/views/' + view.id);
  await page.locator('.run-row').last().hover();
  await page.locator('.run-row').last().locator('.run-menu .bx--overflow-menu').click();
  await page.getByRole('menuitem', { name: 'Pin run', exact: true }).click();
  await expect(page.locator('.bx--inline-notification')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close notification', exact: true }).click();
  checks.push('The enabled pin menu action explains the cap and recovery without changing pins');
  await setView({ pinned: [runs[0].id] });
  for (const action of ['rename', 'stop']) {
    const endpoint = action === 'rename' ? '**/api/run' : '**/api/tools/runs_update';
    await page.route(endpoint, (route) =>
      route.request().method() === (action === 'rename' ? 'PATCH' : 'POST')
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Injected action failure' }),
          })
        : route.continue(),
    );
    await page.locator('.run-row').first().hover();
    await page.locator('.run-row').first().locator('.run-menu .bx--overflow-menu').click();
    await page
      .getByRole('menuitem', { name: action === 'rename' ? 'Rename' : 'Stop run', exact: true })
      .click();
    if (action === 'rename') {
      const dialog = page.getByRole('dialog', { name: 'Rename run', exact: true });
      await dialog.getByRole('textbox', { name: 'Run name', exact: true }).fill('Recovery test');
      await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
      await expect(page.locator('.bx--inline-notification')).toHaveCount(1);
      await expect(dialog.getByRole('textbox', { name: 'Run name', exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: 'Close notification', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(dialog.getByRole('textbox', { name: 'Run name', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
    } else {
      // Stopping confirms in a danger modal that names the run; a failure stays in the modal.
      const dialog = page.getByRole('dialog', { name: /^Stop .+\?$/ });
      await expect(dialog).toBeVisible();
      const stop = dialog.getByRole('button', { name: 'Stop run', exact: true });
      await stop.click();
      await expect(dialog.locator('.bx--inline-notification')).toContainText(
        'The stop request failed. Try again.',
      );
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    await page.unroute(endpoint);
  }
  checks.push(
    'Run action errors stay in their popover and restore field or action focus on dismissal',
  );
  for (const language of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']) {
    const messages = JSON.parse(
      await readFile(
        new URL('../frontend/src/locales/' + language + '.json', import.meta.url),
        'utf8',
      ),
    );
    await touch.evaluate((language) => localStorage.setItem('randl.language', language), language);
    await touch.setViewportSize({ width: 320, height: 700 });
    await afterLayout(touch);
    await touch.goto(path);
    await touch.locator('#open-runs').tap();
    await touch.locator('.run-row').first().locator('.run-menu .bx--overflow-menu').tap();
    await touch.getByRole('menuitem', { name: messages['runs.actions.rename'], exact: true }).tap();
    const actionDialog = touch.getByRole('dialog', { name: messages['runs.rename.title'], exact: true });
    const nameInput = actionDialog.getByRole('textbox', {
      name: messages['runs.fields.displayName'],
      exact: true,
    });
    await nameInput.fill('');
    await nameInput.press('Enter');
    const actionError = actionDialog.locator('.bx--inline-notification');
    await expect(actionError).toContainText(messages['runs.errors.nameRequired']);
    assert.ok(
      await actionError.evaluate((notice) => {
        const r = notice.getBoundingClientRect(),
          form = notice.closest('form').getBoundingClientRect();
        return r.left >= form.left && r.right <= form.right + 1;
      }),
    );
    await actionDialog
      .getByRole('button', { name: messages['common.notification.close'], exact: true })
      .tap();
    await expect(nameInput).toBeFocused();
    await nameInput.press('Escape');

    for (const [width, height] of [
      [320, 568],
      [390, 844],
    ]) {
      await touch.setViewportSize({ width, height });
      await afterLayout(touch);
      await touch.goto(path);
      await touch.locator('#open-runs').tap();
      for (const edge of ['first', 'bottom']) {
        const id = await touch.locator('#run-list').evaluate((list, edge) => {
          const bounds = list.getBoundingClientRect();
          const rows = [...list.querySelectorAll('.run-row')].filter((row) => {
            const box = row.getBoundingClientRect();
            return box.top >= bounds.top && box.bottom <= bounds.bottom;
          });
          return (edge === 'first' ? rows[0] : rows.at(-1)).dataset.runId;
        }, edge);
        const control = touch.locator('[data-run-id="' + id + '"] .run-menu .bx--overflow-menu');
        await control.tap();
        const menu = touch.getByRole('menu');
        await expect(menu).toBeVisible();
        assert.ok(
          await menu
            .getByRole('menuitem')
            .evaluateAll((items) => items.every((n) => n.getBoundingClientRect().height >= 44)),
        );
        assert.ok(
          await menu
            .getByRole('menuitem')
            .evaluateAll((items) =>
              items.every(
                (node, i) =>
                  !i ||
                  items[i - 1].getBoundingClientRect().bottom <=
                    node.getBoundingClientRect().top + 0.1,
              ),
            ),
          'Touch menu hit targets must not overlap',
        );
        assert.ok(
          await menu.evaluate((node) => {
            const required = [...node.children].reduce(
              (sum, item) => sum + item.getBoundingClientRect().height,
              0,
            );
            return (
              required + 2 > parseFloat(getComputedStyle(node).maxHeight) ||
              node.scrollHeight <= node.clientHeight + 1
            );
          }),
          'A menu that fits its available space should not need internal scrolling',
        );
        await touch.keyboard.press('End');
        await expect(menu.getByRole('menuitem').last()).toBeFocused();
        await expect
          .poll(async () => {
            const m = await menu.boundingBox(),
              last = await menu.getByRole('menuitem').last().boundingBox();
            return last.y >= m.y - 1 && last.y + last.height <= m.y + m.height + 1;
          })
          .toBe(true);
        await expect
          .poll(
            async () => {
              const b = await menu.boundingBox();
              return (
                b && b.x >= 0 && b.y >= 0 && b.x + b.width <= width && b.y + b.height <= height
              );
            },
            { message: language + ' ' + width + ' ' + edge + ' menu must fit viewport' },
          )
          .toBe(true);
        await touch.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(control).toBeFocused();
      }
    }
  }
  checks.push(
    'First and bottom-row menus fit 320/390px in all five languages and Escape restores their trigger',
  );
  await touch.evaluate(() => localStorage.setItem('randl.language', 'en'));
  await touch.setViewportSize({ width: 430, height: 844 });
  await afterLayout(touch);
  await touch.goto(path);
  await touch.locator('#open-runs').tap();
  const resizingRow = touch.locator('.run-row').first(),
    resizingName = resizingRow.locator('.run-name');
  await resizingName.focus();
  await touch.setViewportSize({ width: 390, height: 844 });
  await afterLayout(touch);
  await expect(resizingName).toBeFocused();
  await touch.setViewportSize({ width: 430, height: 844 });
  await afterLayout(touch);
  await resizingRow.locator('.run-pin').focus();
  await touch.setViewportSize({ width: 390, height: 844 });
  await afterLayout(touch);
  await expect(resizingName).toBeFocused();
  await resizingRow.locator('.run-menu .bx--overflow-menu').tap();
  await expect(touch.getByRole('menu')).toBeVisible();
  await touch.setViewportSize({ width: 430, height: 844 });
  await afterLayout(touch);
  await expect
    .poll(() => touch.evaluate(() => !!document.activeElement.closest('[role="menu"]')))
    .toBe(true);
  await touch.keyboard.press('Escape');
  const rememberedPin = touch.locator('.run-row').first().locator('.run-pin');
  await rememberedPin.focus();
  await touch.keyboard.press('Tab');
  await touch.setViewportSize({ width: 390, height: 844 });
  await afterLayout(touch);
  const stop = touch.locator('#run-list [tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeVisible();
  await stop.focus();
  await touch.keyboard.press('Tab');
  await touch.keyboard.press('Shift+Tab');
  await expect(stop).toBeFocused();
  checks.push(
    'Touch breakpoint changes replace a hidden remembered pin tab stop with the run name',
  );

  const pinLimit = 'runs.pin.limit';
  for (const language of ['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const messages = JSON.parse(
      await readFile(
        new URL('../frontend/src/locales/' + language + '.json', import.meta.url),
        'utf8',
      ),
    );
    await touch.evaluate((language) => localStorage.setItem('randl.language', language), language);
    for (const [width, height] of [
      [320, 700],
      [390, 700],
      [320, 460],
      [667, 375],
      [568, 320],
    ]) {
      await setView({ pinned: runs.slice(0, 20).map((r) => r.id) });
      await touch.setViewportSize({ width, height });
      await afterLayout(touch);
      await touch.goto(path);
      await touch.locator('#open-runs').tap();
      await touch.locator('#run-list').evaluate((n) => (n.scrollTop = n.scrollHeight));
      await expect(touch.locator('.run-row').last()).toHaveAttribute(
        'aria-posinset',
        String(runs.length),
      );
      const targetRow = touch.locator('.run-row').last(),
        targetId = await targetRow.getAttribute('data-run-id');
      await targetRow.locator('.run-menu .bx--overflow-menu').tap();
      await touch.getByRole('menuitem').nth(2).tap();
      const notice = touch.locator('aside .bx--inline-notification');
      await expect(notice).toContainText(messages[pinLimit]);
      const cappedRow = touch.locator('[data-run-id="' + targetId + '"]');
      await expect(cappedRow.locator('.run-name')).toBeFocused();
      assert.ok(await touch.locator('aside').evaluate((n) => n.scrollWidth === n.clientWidth));
      if (height <= 460 || language === 'ko' || language === 'zh-Hant') {
        await afterLayout(touch);
        await touch.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
        await expect(touch.locator('.run-row').first()).toHaveAttribute('aria-posinset', '1');
        const victimId = await touch.locator('.run-row').first().getAttribute('data-run-id');
        const victimMenu = touch.locator(
          '[data-run-id="' + victimId + '"] .run-menu .bx--overflow-menu',
        );
        await victimMenu.focus();
        await touch.keyboard.press('Enter');
        await touch.getByRole('menuitem').nth(2).focus();
        await touch.keyboard.press('Enter');
        await expect
          .poll(async () => (await server.db.call('view', view.id)).body.pinned.length)
          .toBe(19);
        await touch.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await expect(victimMenu).toBeFocused();
        await touch.keyboard.press('Enter');
        await touch.getByRole('menuitem').nth(2).focus();
        await touch.keyboard.press('Enter');
        await expect
          .poll(async () => (await server.db.call('view', view.id)).body.pinned.length)
          .toBe(20);
        await expect(victimMenu).toBeFocused();
        await touch.locator('#run-list').evaluate((n) => (n.scrollTop = n.scrollHeight));
        await cappedRow.locator('.run-menu .bx--overflow-menu').tap();
        await touch.getByRole('menuitem').nth(2).tap();
        await expect(notice).toContainText(messages[pinLimit]);
        await expect(cappedRow.locator('.run-name')).toBeFocused();
      }
      if (width === 390 && height === 700) {
        for (const [rotatedWidth, rotatedHeight] of [
          [568, 320],
          [667, 375],
          [740, 360],
          [568, 320],
          [390, 700],
          [568, 320],
          [320, 568],
          [568, 320],
          [width, height],
        ]) {
          await touch.setViewportSize({ width: rotatedWidth, height: rotatedHeight });
          await afterLayout(touch);
          await touch.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          await expect(cappedRow.locator('.run-name')).toBeFocused();
          await expect
            .poll(() =>
              cappedRow.evaluate((row) => {
                const list = row.closest('#run-list');
                if (!list) return false;
                const r = row.getBoundingClientRect(),
                  l = list.getBoundingClientRect();
                return (
                  r.top >= l.top && r.bottom <= l.bottom && r.top >= 0 && r.bottom <= innerHeight
                );
              }),
            )
            .toBe(true);
        }
      }
      assert.ok(
        await cappedRow.evaluate((row) => {
          const r = row.getBoundingClientRect(),
            l = row.closest('#run-list').getBoundingClientRect();
          return r.top >= l.top && r.bottom <= l.bottom && r.top >= 0 && r.bottom <= innerHeight;
        }),
      );
      assert.ok(
        await notice.evaluate((n) => {
          const r = n.getBoundingClientRect();
          return (
            !n.closest('[inert]') &&
            n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          );
        }),
      );
      const cdp = await touch.context().newCDPSession(touch),
        tree = await cdp.send('Accessibility.getFullAXTree');
      assert.ok(tree.nodes.some((n) => !n.ignored && n.name?.value?.includes(messages[pinLimit])));
      await cdp.detach();
      if (height <= 460) {
        await notice
          .getByRole('button', { name: messages['common.notification.close'], exact: true })
          .focus();
        // Filter, Group and Sort sit in the heading now, so the search field precedes the notice.
        await touch.keyboard.press('Shift+Tab');
        await expect(touch.locator('#run-search')).toBeFocused();
        assert.ok(
          await touch.locator('#run-search').evaluate((input) => {
            const r = input.getBoundingClientRect(),
              head = document.querySelector('.runs-heading').getBoundingClientRect();
            return (
              r.top >= head.bottom &&
              r.bottom <= innerHeight &&
              input.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
        );
      }
      await notice.getByRole('button', { name: messages['common.notification.close'], exact: true }).tap();
      await expect(touch.locator('.runs-heading h2')).toBeFocused();
      await expect(notice).toHaveCount(0);
      await touch.locator('#run-list').evaluate((n) => (n.scrollTop = 0));
      const pinIndicator = touch
        .locator('.run-row')
        .first()
        .getByRole('img', { name: messages['runs.pin.pinned'], exact: true });
      if (width <= 390) await expect(pinIndicator).toBeVisible();
      else await expect(pinIndicator).toHaveCount(0);
      await touch.locator('.run-row').first().locator('.run-menu .bx--overflow-menu').tap();
      await touch.getByRole('menuitem').nth(2).tap();
      await expect
        .poll(async () => (await server.db.call('view', view.id)).body.pinned.length)
        .toBe(19);
      await touch.locator('#run-list').evaluate((n) => (n.scrollTop = n.scrollHeight));
      await touch.locator('[data-run-id="' + targetId + '"] .run-menu .bx--overflow-menu').tap();
      await touch.getByRole('menuitem').nth(2).tap();
      await expect
        .poll(async () => (await server.db.call('view', view.id)).body.pinned.includes(targetId))
        .toBe(true);
      await expect(notice).toHaveCount(0);
    }
  }
  checks.push(
    'Mobile pin-limit feedback is visible and AX-exposed, closes with stable focus, and supports pointer/keyboard unpin/pin recovery in all five languages',
  );
  await mkdir('tmp/swatches', { recursive: true });
  for (const width of [1440, 390, 320]) {
    const palettePage = await browser.newPage({
      viewport: { width, height: 900 },
      hasTouch: width <= 390,
      isMobile: width <= 390,
    });
    palettePage.on('pageerror', (e) => errors.push(e.message));
    for (const theme of ['light', 'dark']) {
      await palettePage.emulateMedia({ colorScheme: theme });
      for (const location of ['workspace', 'runs', 'runs/run-0']) {
        await palettePage.goto(url + '/test/controls/' + location + '?view=' + view.id);
        let runId;
        if (location === 'runs') {
          const color = palettePage.locator('.runs-table-region .run-color-button').first();
          runId = await color.locator('xpath=ancestor::tr').getAttribute('data-row');
          await color.click();
        } else {
          await palettePage.locator('.run-row').first().waitFor({ state: 'attached' });
          const showRuns = palettePage.getByRole('button', { name: 'Show runs', exact: true });
          if (await showRuns.isVisible()) await showRuns.click();
          const run = palettePage.locator('.run-row').first();
          runId = await run.getAttribute('data-run-id');
          if (width > 390) await run.hover();
          await run.locator('.run-menu .bx--overflow-menu').click();
          await palettePage.getByRole('menuitem', { name: 'Change color', exact: true }).click();
        }
        const picker = palettePage.getByRole('dialog', { name: /^Color for / });
        const swatches = picker.locator('.color-swatches button');
        await expect(swatches).toHaveCount(16);
        const boxes = await swatches.evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              radius: getComputedStyle(n).borderRadius,
            };
          }),
        );
        const rows = [...new Set(boxes.map((b) => b.y))];
        assert.equal(rows.length, 2);
        for (const y of rows) assert.equal(boxes.filter((b) => b.y === y).length, 8);
        assert.deepEqual(
          boxes.slice(0, 8).map((b) => b.x),
          boxes.slice(8).map((b) => b.x),
        );
        for (const b of boxes) {
          assert.equal(b.radius, '50%');
          assert.equal(b.width, b.height);
          assert.ok(b.width >= 24 && b.height >= 24);
          assert.ok(b.x >= 0 && b.x + b.width <= width);
        }
        // Initial focus stays in the unchanged hex input; Tab reaches every preset in order.
        await expect(picker.getByRole('textbox', { name: 'Hex color', exact: true })).toBeFocused();
        for (let i = 0; i < 16; i++) {
          await palettePage.keyboard.press('Tab');
          await expect(swatches.nth(i)).toBeFocused();
          await expect(swatches.nth(i)).toHaveCSS('outline-style', 'solid');
          await expect(swatches.nth(i)).toHaveCSS('outline-width', '2px');
          await expect(swatches.nth(i)).toHaveCSS('outline-offset', '2px');
          if (i === 3 || i === 10) {
            await palettePage.keyboard.press(i === 3 ? 'Space' : 'Enter');
            await expect(swatches.nth(i)).toHaveAttribute('aria-pressed', 'true');
            await expect(swatches.locator('svg')).toHaveCount(1);
            const hex = await picker
              .getByRole('textbox', { name: 'Hex color', exact: true })
              .inputValue();
            await expect
              .poll(async () => (await server.db.call('view', view.id)).body.runColors[runId])
              .toBe(hex);
          }
        }
        await palettePage.keyboard.press('Shift+Tab');
        await expect(swatches.nth(14)).toBeFocused();
        await palettePage.screenshot({
          path: `tmp/swatches/${location.replaceAll('/', '-')}-${width}-${theme}.png`,
        });
        await palettePage.keyboard.press('Escape');
        await expect(picker).toHaveCount(0);
      }
    }
    await palettePage.close();
  }
  checks.push(
    'Preset colors form two rows of eight 24px circles, with keyboard focus and persisted Space/Enter selection in all picker locations at 1440/390/320px in both themes',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
