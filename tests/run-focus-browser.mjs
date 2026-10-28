import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-run-focus-'));
const frames = (page, count = 2) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let seen = 0;
        const next = () => (++seen >= count ? resolve() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    count,
  );
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  for (let i = 0; i < 102; i++)
    await server.db.call('upsert', {
      entity: 'test',
      project: 'focus',
      name: 'run-' + i,
      displayName: 'Experiment ' + i,
    });
  const view = await server.tools.execute('view_create', {
    project: 'test/focus',
    name: 'Focus test',
    body: { generation: 'manual', panels: [], visible: [], solo: [] },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  browser = await launchBrowser();

  /** Opens the runs drawer on a touch phone with the second row's name focused. */
  async function open(viewport, { touchscreen = true, scrollend = true } = {}) {
    const page = await browser.newPage(
      touchscreen ? { viewport, hasTouch: true, isMobile: true } : { viewport },
    );
    page.on('pageerror', (error) => errors.push(error.message));
    if (!scrollend)
      await page.addInitScript(() => {
        for (const proto of [HTMLElement.prototype, Element.prototype, Document.prototype])
          delete proto.onscrollend;
        delete window.onscrollend;
      });
    await page.goto(`${origin}/test/focus/workspace?view=${view.id}`);
    if (touchscreen) await page.getByRole('button', { name: 'Show runs', exact: true }).click();
    const list = page.locator('#run-list');
    await expect(list).toBeVisible();
    await page.locator('.run-row').nth(1).locator('[data-control="name"]').focus();
    await frames(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points = []) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((point, id) => ({ id, ...point })),
      });
    /** Moves one held finger in 5 px steps, pausing like a real gesture. */
    async function drag(x, y, distance) {
      await touch('touchStart', [{ x, y }]);
      for (let moved = 5; moved <= distance; moved += 5) {
        await touch('touchMove', [{ x, y: y - moved }]);
        await page.waitForTimeout(16);
      }
      return y - distance;
    }
    const offset = () => list.evaluate((node) => node.scrollTop);
    return { page, list, touch, drag, offset };
  }
  /** Records the list offset for a number of frames. */
  const sampleOffsets = (page, count) =>
    page.evaluate(
      (count) =>
        new Promise((resolve) => {
          const list = document.querySelector('#run-list'),
            offsets = [];
          const next = () => {
            offsets.push(list.scrollTop);
            offsets.length >= count ? resolve(offsets) : requestAnimationFrame(next);
          };
          next();
        }),
      count,
    );
  const reversals = (offsets) => offsets.slice(1).filter((value, index) => value < offsets[index]);
  /** Focuses the last fully visible row without scrolling, then shrinks the window by 144 px. */
  async function shrinkAndCheckReveal(page, width, height) {
    await page.evaluate(() => {
      const list = document.querySelector('#run-list').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#run-list .run-row')].filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top >= list.top && box.bottom <= list.bottom;
      });
      rows.at(-1).querySelector('[data-control="name"]').focus({ preventScroll: true });
    });
    await frames(page);
    await page.setViewportSize({ width, height: height - 144 });
    await frames(page, 4);
    return focusedRowVisible(page);
  }
  /** Whether the focused row lies fully inside both the list and the window. */
  const focusedRowVisible = (page) =>
    page.evaluate(() => {
      const row = document.activeElement?.closest('[data-entry-key]');
      if (!row) return false;
      const box = row.getBoundingClientRect(),
        list = document.querySelector('#run-list').getBoundingClientRect();
      return box.top >= list.top - 0.5 && box.bottom <= Math.min(list.bottom, innerHeight) + 0.5;
    });

  // A held drag that starts on a row name keeps its offset through height changes.
  const results = [];
  for (const moves of [17, 20, 70])
    for (const nextHeight of [0, 700, 960]) {
      const { page, list, touch, drag, offset } = await open({ width: 390, height: 844 });
      const box = await list.boundingBox();
      const x = box.x + box.width / 2;
      const startY = box.y + (moves > 20 ? 500 : 300);
      let y = await drag(x, startY, moves * 5);
      const before = await offset();
      if (nextHeight) {
        await page.setViewportSize({ width: 390, height: nextHeight });
        await frames(page);
      }
      const after = await offset();
      assert.equal(
        after,
        before,
        `held touch after ${moves} moves keeps the list offset at height ${nextHeight}`,
      );
      for (let i = 0; i < 4; i++) {
        y -= 5;
        await touch('touchMove', [{ x, y }]);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(120);
      await touch('touchEnd');
      await page.waitForTimeout(100);
      const end = await offset();
      results.push({ moves, nextHeight, before, after, end });
      assert.ok(end > before, 'finger drag continues after the height change');
      await expect(list.locator(':focus')).toHaveCount(1);
      await page.close();
    }
  for (const moves of [17, 20, 70]) {
    const cases = results.filter((result) => result.moves === moves);
    assert.ok(
      cases.every((item) => Math.abs(item.end - cases[0].end) <= 2),
      'resize adds no distance to a held touch drag: ' + JSON.stringify(cases),
    );
  }
  checks.push('Held touch drags from a run name keep their offset through height changes');

  // Starting on a visibility or solo toggle re-renders its icon before touch events arrive.
  for (const control of ['visible', 'solo']) {
    const { page, list, touch, drag, offset } = await open({ width: 390, height: 844 });
    const target = await page
      .locator('.run-row')
      .nth(9)
      .locator(`[data-control="${control}"]`)
      .boundingBox();
    await drag(target.x + target.width / 2, target.y + target.height / 2, 90);
    await page.waitForTimeout(60);
    const before = await offset();
    await page.setViewportSize({ width: 390, height: 700 });
    await frames(page, 4);
    assert.equal(await offset(), before, `held drag from the ${control} toggle keeps its offset`);
    await touch('touchEnd');
    await page.close();
  }
  checks.push('Held touch drags that start on visibility or solo toggles keep their offset');

  // A long drag removes the touched row; after lifting, a height change reveals focus again.
  {
    const { page, touch, list, drag, offset } = await open({ width: 390, height: 844 });
    const row = await page
      .locator('.run-row')
      .nth(5)
      .locator('[data-control="name"]')
      .boundingBox();
    await drag(row.x + 40, row.y + row.height / 2, 710);
    await touch('touchEnd');
    await page.waitForTimeout(300);
    assert.equal(await focusedRowVisible(page), false, 'focused row is partly hidden');
    const before = await offset();
    await page.setViewportSize({ width: 390, height: 700 });
    await frames(page, 4);
    await expect(list.locator(':focus')).toHaveCount(1);
    assert.equal(await focusedRowVisible(page), true, 'later height change reveals focus');
    assert.ok(Math.abs((await offset()) - before) <= 48, 'reveal scrolls only as needed');
    await page.close();
  }
  checks.push('After a long drag lifts, a later height change reveals the focused row');

  // While a finger rests on a row clipped by the drawer, a height change does not scroll the drawer.
  {
    const { page, touch } = await open({ width: 568, height: 210 });
    const target = await page.evaluate(() => {
      const drawer = document.querySelector('.run-sidebar'),
        list = document.querySelector('#run-list');
      drawer.scrollTop = 0;
      const bottom = drawer.getBoundingClientRect().bottom;
      const row = [...list.querySelectorAll('.run-row')].find((item) => {
        const box = item.getBoundingClientRect();
        return box.top < bottom - 8 && box.bottom > bottom + 2;
      });
      row.querySelector('[data-control="name"]').focus({ preventScroll: true });
      const box = row.getBoundingClientRect();
      return {
        x: box.left + 120,
        y: (Math.max(box.top, list.getBoundingClientRect().top) + bottom) / 2,
        scrollable: drawer.scrollHeight > drawer.clientHeight,
      };
    });
    assert.ok(target.scrollable, 'the drawer scrolls at this size');
    await frames(page);
    const drawerOffset = () => page.locator('.run-sidebar').evaluate((node) => node.scrollTop);
    const before = await drawerOffset();
    await touch('touchStart', [{ x: target.x, y: target.y }]);
    await touch('touchMove', [{ x: target.x + 1, y: target.y }]);
    await page.setViewportSize({ width: 568, height: 200 });
    await frames(page, 4);
    assert.equal(await drawerOffset(), before, 'held touch keeps the drawer offset');
    await touch('touchEnd');
    await page.close();
  }
  checks.push('A resting finger keeps the drawer offset through a height change');

  // Momentum after a fling belongs to the gesture, with or without native scrollend.
  for (const scrollend of [true, false]) {
    const { page, touch } = await open({ width: 390, height: 844 }, { scrollend });
    const box = await page.locator('#run-list').boundingBox();
    const x = box.x + box.width / 2,
      y = box.y + 450;
    await touch('touchStart', [{ x, y }]);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', [{ x, y: y - 25 * i }]);
      await page.waitForTimeout(8);
    }
    await touch('touchEnd');
    const offsets = sampleOffsets(page, 90);
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 390, height: 700 });
    assert.deepEqual(
      reversals(await offsets),
      [],
      `a height change during momentum does not reverse it (scrollend ${scrollend})`,
    );
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 390, height: 844 });
    await frames(page, 4);
    assert.ok(
      await shrinkAndCheckReveal(page, 390, 844),
      `the hold ends after momentum (scrollend ${scrollend})`,
    );
    await page.close();
  }
  checks.push('Momentum scrolling keeps its direction through a height change, then the hold ends');

  // Lifting one of two fingers keeps the hold; lifting the last finger ends it.
  {
    const { page, touch } = await open({ width: 390, height: 844 });
    const toggle = await page
      .locator('.run-row')
      .nth(4)
      .locator('[data-control="solo"]')
      .boundingBox();
    const name = await page
      .locator('.run-row')
      .nth(6)
      .locator('[data-control="name"]')
      .boundingBox();
    const first = { x: toggle.x + toggle.width / 2, y: toggle.y + toggle.height / 2 },
      second = { x: name.x + 40, y: name.y + name.height / 2 };
    await touch('touchStart', [first]);
    await touch('touchStart', [first, second]);
    await touch('touchEnd', [{ ...second, id: 1 }]);
    await touch('touchEnd');
    await page.waitForTimeout(100);
    assert.ok(await shrinkAndCheckReveal(page, 390, 844), 'the hold ends after both fingers lift');
    await page.close();
  }
  checks.push('Two-finger touches end the hold when the last finger lifts');

  // Mouse drag-to-solo auto-scroll is manual scrolling: a height change does not reverse it.
  {
    const { page, list } = await open({ width: 1280, height: 800 }, { touchscreen: false });
    const box = await list.boundingBox();
    const solo = await page
      .locator('.run-row')
      .nth(1)
      .locator('[data-control="solo"]')
      .boundingBox();
    const x = solo.x + solo.width / 2;
    await page.mouse.move(x, solo.y + solo.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++)
      await page.mouse.move(x, solo.y + ((box.y + box.height - 8 - solo.y) * i) / 10);
    await page.waitForTimeout(300);
    const offsets = sampleOffsets(page, 40);
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 1280, height: 680 });
    assert.deepEqual(reversals(await offsets), [], 'auto-scroll keeps its direction');
    await page.mouse.move(x, box.y + 200);
    await page.mouse.up();
    await frames(page, 3);
    await page.close();
  }
  checks.push('Drag auto-scroll keeps its direction through a height change');

  // On a touch screen a toggle is tapped, scrolled past, or held and dragged across rows.
  {
    const { page, touch, list, offset } = await open({ width: 390, height: 844 });
    const stored = async () => (await server.db.call('view', view.id)).body.visible.length;
    const eye = async (index) => {
      const box = await page
        .locator('.run-row')
        .nth(index)
        .locator('[data-control="visible"]')
        .boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const before = await stored();
    const tap = await eye(1);
    await touch('touchStart', [tap]);
    await touch('touchEnd');
    await expect.poll(stored).toBe(before + 1);
    // A quick swipe that starts on an eye scrolls the list and changes nothing.
    const swipe = await eye(6);
    await touch('touchStart', [swipe]);
    for (let moved = 10; moved <= 150; moved += 10) {
      await touch('touchMove', [{ x: swipe.x, y: swipe.y - moved }]);
      await page.waitForTimeout(16);
    }
    await touch('touchEnd');
    await page.waitForTimeout(400);
    assert.ok((await offset()) > 0, 'the swipe scrolled the list');
    assert.equal(await stored(), before + 1, 'a swipe toggles nothing');
    // Playwright's tap sends a synthesized click as well; the toggle changes once.
    await list.evaluate((node) => (node.scrollTop = 0));
    await frames(page, 3);
    await page.locator('.run-row').nth(2).locator('[data-control="visible"]').tap();
    await expect.poll(stored).toBe(before + 2);
    await page.close();
  }
  checks.push(
    'Touch: a tap toggles once; a swipe that starts on a toggle scrolls without toggling',
  );

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, results, errors }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
