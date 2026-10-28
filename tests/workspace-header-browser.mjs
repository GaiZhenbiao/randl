import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-workspace-header-'));
let server, browser;
const errors = [],
  measurements = [];
try {
  server = await createServer(directory);
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'header',
    name: 'run',
    displayName: 'Training run',
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: Array.from({ length: 100 }, (_, step) =>
          JSON.stringify({ _step: step, loss: 1 / (step + 1) }),
        ),
      },
    },
    complete: true,
    exitcode: 0,
  });
  const body = {
    generation: 'manual',
    visible: [run.id],
    solo: [],
    panels: [{ id: 'loss', plugin: 'line', metric: 'loss', title: 'Training loss' }],
  };
  const first = await server.tools.execute('view_create', {
    project: 'test/header',
    name: 'Training comparison',
    body,
  });
  const origin = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/test/header/workspace?view=${first.id}`);
  await expect(page.locator('.view-name')).toContainText('Training comparison');
  await expect(page.getByRole('combobox', { name: 'Saved view', exact: true })).toHaveCount(0);
  await expect(page.locator('.workspace-heading')).toHaveCount(0);
  // Every toolbar control stays inside the content box, and the search placeholder fits.
  const scanToolbar = async (page, widths, label) => {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const result = await page.locator('.workspace-toolbar').evaluate((toolbar) => {
        const style = getComputedStyle(toolbar),
          box = toolbar.getBoundingClientRect(),
          left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
        const outside = [...toolbar.querySelectorAll('button, select, input')]
          .filter(
            (element) =>
              element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden',
          )
          .filter((element) => {
            const r = element.getBoundingClientRect();
            return r.left < left - 0.5 || r.right > right + 0.5;
          })
          .map((element) => element.getAttribute('aria-label') || element.textContent.trim());
        const input = toolbar.querySelector('.panel-search input');
        let placeholder = true;
        if (input) {
          const s = getComputedStyle(input),
            context = document.createElement('canvas').getContext('2d');
          context.font = s.font;
          context.letterSpacing = s.letterSpacing;
          placeholder =
            context.measureText(input.placeholder).width <=
            input.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) + 0.5;
        }
        return { outside, placeholder, canvas: document.querySelector('main').clientWidth };
      });
      assert.deepEqual(result.outside, [], `${label} ${width}: controls inside the toolbar`);
      assert.ok(
        result.placeholder,
        `${label} ${width} (canvas ${result.canvas}): placeholder fits`,
      );
    }
  };
  const widthRange = (from, to, step) =>
    Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
  for (const lang of ['en', 'ja']) {
    await page.evaluate((lang) => localStorage.setItem('randl.language', lang), lang);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await scanToolbar(page, widthRange(1140, 1240, 2), `${lang} one view`);
  }
  await page.evaluate(() => localStorage.setItem('randl.language', 'en'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const second = await server.tools.execute('view_create', {
    project: 'test/header',
    name: 'Empty comparison',
    body: { ...body, panels: [] },
  });
  const selector = page.getByRole('combobox', { name: 'Saved view', exact: true });
  await expect(selector).toBeVisible();
  for (const view of [second, first, second, first]) {
    await selector.selectOption(view.id);
    await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', view.id);
    await expect(selector).toHaveValue(view.id);
    await expect(page).toHaveURL(`${origin}/test/header/workspace?view=${view.id}`);
    if (view.id === second.id) {
      await expect(page.getByRole('button', { name: 'Add panel', exact: true })).toHaveCount(1);
      await expect(page.getByRole('searchbox', { name: 'Search panels', exact: true })).toHaveCount(
        0,
      );
    }
  }
  for (const openMenu of [false, true]) {
    const choice = await selector.evaluate((select) => {
      const next = select.selectedIndex === 0 ? 1 : 0;
      return {
        key: next > select.selectedIndex ? 'ArrowDown' : 'ArrowUp',
        id: select.options[next].value,
      };
    });
    if (openMenu) await selector.click();
    else await selector.focus();
    await page.keyboard.press(choice.key);
    if (openMenu) await page.keyboard.press('Enter');
    await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', choice.id);
    await expect(selector).toHaveValue(choice.id);
    await page.getByRole('button', { name: 'View actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename view', exact: true });
    await expect(dialog.getByRole('textbox', { name: 'View name', exact: true })).toHaveValue(
      choice.id === first.id ? first.name : second.name,
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'View actions', exact: true })).toBeFocused();
  }
  const shown = (id) =>
    Promise.all([
      expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', id),
      expect(selector).toHaveValue(id),
      expect(page).toHaveURL(`${origin}/test/header/workspace?view=${id}`),
    ]);
  const keyboardChoose = async (id) => {
    const key = await selector.evaluate(
      (select, id) =>
        [...select.options].findIndex((option) => option.value === id) > select.selectedIndex
          ? 'ArrowDown'
          : 'ArrowUp',
      id,
    );
    await selector.focus();
    await page.keyboard.press(key);
  };
  const conflict = async () => {
    const id = await page.locator('.view-controls').getAttribute('data-view-id');
    const path = `**/api/views/${id}`;
    // Commit another writer after this browser built its request, so its version is stale.
    let pending = true;
    await page.route(path, async (route) => {
      if (pending && route.request().method() === 'PUT') {
        pending = false;
        const saved = await (await fetch(`${origin}/api/views/${id}`)).json();
        const response = await fetch(`${origin}/api/views/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: saved.name,
            project: saved.project,
            body: saved.body,
            version: saved.version,
          }),
        });
        assert.ok(response.ok);
      }
      await route.continue();
    });
    await page.locator('.section-toggle').first().click();
    const notice = page.locator('#save-failure');
    await expect(notice).toContainText('This view was changed in another session.');
    await page.unroute(path);
    await expect(notice).toContainText('Not saved');
    return notice;
  };
  await selector.selectOption(first.id);
  await shown(first.id);
  // A refused keyboard choice keeps the current view displayed.
  let notice = await conflict();
  await keyboardChoose(second.id);
  await expect(page.locator('#save-failure')).toBeVisible();
  await shown(first.id);
  // Resolving the conflict returns focus to the selector, and the same choice then succeeds.
  await notice.getByRole('button', { name: 'Reload saved view', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(notice).toHaveCount(0);
  await expect(selector).toBeFocused();
  await keyboardChoose(second.id);
  await shown(second.id);
  await page.goBack();
  await shown(first.id);
  await page.goForward();
  await shown(second.id);
  await keyboardChoose(first.id);
  await shown(first.id);
  notice = await conflict();
  await notice.getByRole('button', { name: 'Save as new view', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(notice).toHaveCount(0);
  await expect(selector).toBeFocused();
  await expect(selector.locator('option:checked')).toHaveText('Training comparison copy');
  for (const lang of ['en', 'ja']) {
    await page.evaluate((lang) => localStorage.setItem('randl.language', lang), lang);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await scanToolbar(page, widthRange(1240, 1340, 2), `${lang} several views`);
  }
  await page.evaluate(() => localStorage.setItem('randl.language', 'en'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // A view deleted in another session stays displayed and offers only Save as new view.
  const copyId = await selector.inputValue();
  const listed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/views' && response.request().method() === 'GET',
  );
  assert.equal((await fetch(`${origin}/api/views/${copyId}`, { method: 'DELETE' })).status, 200);
  await listed;
  await expect(selector.locator('option:checked')).toHaveText('Training comparison copy');
  await expect(selector).toHaveValue(copyId);
  await page.locator('.section-toggle').first().click();
  notice = page.locator('#save-failure');
  await expect(notice).toContainText('This view was deleted.');
  await expect(notice.getByRole('button', { name: 'Reload saved view', exact: true })).toHaveCount(
    0,
  );
  await notice.getByRole('button', { name: 'Save as new view', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(notice).toHaveCount(0);
  await expect(selector).toBeFocused();
  // Discard changes leaves a deleted view for another saved view.
  const deleteElsewhere = async (id) => {
    const listed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/views' && response.request().method() === 'GET',
    );
    assert.equal((await fetch(`${origin}/api/views/${id}`, { method: 'DELETE' })).status, 200);
    await listed;
  };
  const discardDeleted = async (id) => {
    await notice.getByRole('button', { name: 'Discard changes', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(notice).toHaveCount(0);
    await expect(selector).toBeFocused();
    await expect(page.locator('.view-controls')).not.toHaveAttribute('data-view-id', id);
    await expect(selector.locator(`option[value="${id}"]`)).toHaveCount(0);
    const current = await page.locator('.view-controls').getAttribute('data-view-id');
    await expect(page).toHaveURL(`${origin}/test/header/workspace?view=${current}`);
  };
  const copy2 = await selector.inputValue();
  await deleteElsewhere(copy2);
  await page.getByRole('button', { name: 'View actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.section-toggle').first().click();
  await expect(notice).toContainText('This view was deleted.');
  await expect(notice.getByRole('button', { name: 'Save as new view', exact: true })).toBeVisible();
  await discardDeleted(copy2);
  // A view deleted after a version conflict: Reload reports the deletion and offers Discard.
  const disposable = async (name) => {
    const created = await server.tools.execute('view_create', {
      project: 'test/header',
      name,
      body,
    });
    await expect(selector.locator(`option[value="${created.id}"]`)).toHaveCount(1);
    await selector.selectOption(created.id);
    await shown(created.id);
    return created;
  };
  const third = await disposable('Disposable comparison');
  notice = await conflict();
  await deleteElsewhere(third.id);
  await notice.getByRole('button', { name: 'Reload saved view', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(notice).toContainText('This view was deleted.');
  await expect(notice.getByRole('button', { name: 'Reload saved view', exact: true })).toHaveCount(
    0,
  );
  await expect(notice.getByRole('button', { name: 'Discard changes', exact: true })).toBeFocused();
  await discardDeleted(third.id);
  await disposable('Disposable for deletion');
  // Every way of closing Delete view keeps focus in the view controls.
  const viewActions = page.getByRole('button', { name: 'View actions', exact: true });
  const deleteDialog = page.getByRole('dialog', { name: 'Delete view?', exact: true });
  for (const close of ['Escape', 'Cancel', 'Close']) {
    await viewActions.click();
    await page.getByRole('menuitem', { name: 'Delete view', exact: true }).click();
    await expect(deleteDialog).toBeVisible();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await deleteDialog.getByRole('button', { name: close, exact: true }).click();
    await expect(deleteDialog).not.toBeVisible();
    await expect(viewActions).toBeFocused();
  }
  await viewActions.click();
  await page.getByRole('menuitem', { name: 'Delete view', exact: true }).click();
  await deleteDialog.getByRole('button', { name: 'Delete view', exact: true }).click();
  await expect(deleteDialog).not.toBeVisible();
  await expect(selector).toBeFocused();
  await page.close();
  for (const [width, touch, height = 900] of [
    ...[1440, 1280, 1056, 900, 761, 760, 700, 620, 619, 390, 320].map((width) => [
      width,
      width <= 760,
    ]),
    [320, false],
    [568, true, 320],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/test/header/workspace?view=${first.id}`);
    await expect(page.locator('.workspace-toolbar')).toHaveCount(1);
    await expect(page.locator('.chart')).toHaveCount(1);
    const geometry = await page.locator('.workspace-toolbar').evaluate((toolbar) => {
      const b = toolbar.getBoundingClientRect(),
        view = toolbar.querySelector('.view-group').getBoundingClientRect(),
        panels = toolbar.querySelector('.panel-group').getBoundingClientRect();
      const childrenFit = [
        ...toolbar.querySelectorAll('.panel-group > *, .chart-actions > button'),
      ].every((element) => {
        const r = element.getBoundingClientRect();
        return r.left >= panels.left - 1 && r.right <= panels.right + 1;
      });
      return {
        height: b.height,
        viewY: view.top,
        panelY: panels.top,
        childrenFit,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.ok(geometry.overflow <= 1, `${width}: no page overflow`);
    assert.ok(
      geometry.childrenFit,
      `${width}: panel controls stay inside their group's aligned gutters`,
    );
    if (width >= 1280) {
      assert.equal(geometry.viewY, geometry.panelY);
      assert.ok(geometry.height <= 49);
    }
    const newView = page.getByRole('button', { name: 'New view', exact: true });
    const newViewVisible = await newView.isVisible();
    await page.getByRole('button', { name: 'View actions', exact: true }).click();
    const menuNew = page.getByRole('menuitem', { name: 'New view', exact: true });
    assert.notEqual(
      newViewVisible,
      await menuNew.isVisible(),
      `${width}: New view is available once`,
    );
    if (!newViewVisible) {
      await expect(
        page.getByRole('menuitem', { name: 'Undo view change', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('menuitem', { name: 'Redo view change', exact: true }),
      ).toBeVisible();
    }
    // The menu ends inside the viewport, and its last item can be scrolled to and tapped.
    const menu = page.locator('.view-actions-menu');
    const lastItem = menu.locator('.bx--overflow-menu-options__btn').last();
    const inViewport = (locator) =>
      locator.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return r.top >= -0.5 && r.bottom <= innerHeight + 0.5;
      });
    assert.ok(await inViewport(menu), `${width}x${height}: menu fits`);
    if (!(await inViewport(lastItem))) {
      const box = await menu.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => inViewport(lastItem)).toBe(true);
      await lastItem.tap();
      const dialog = page.getByRole('dialog', { name: 'Delete view?', exact: true });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      // A height change refits the open menu; a width change (rotation) closes it.
      const viewActions = page.getByRole('button', { name: 'View actions', exact: true });
      await page.setViewportSize({ width, height: 600 });
      await viewActions.click();
      await expect(menu).toBeVisible();
      await page.setViewportSize({ width, height });
      await expect.poll(() => inViewport(menu)).toBe(true);
      await page.setViewportSize({ width: height, height: width });
      await expect(menu).toHaveCount(0);
      await page.setViewportSize({ width, height });
      await viewActions.click();
      await expect.poll(() => inViewport(menu)).toBe(true);
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Escape');
    measurements.push({ width, touch, ...geometry });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ measurements, errors }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
