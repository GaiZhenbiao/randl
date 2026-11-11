import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Grid layout of chart panels: one cell per run or group, reflowing with the item size,
// virtualized, keyboard operable, with linked hover, cursors and zoom.
// npm run build
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/display-layout-browser.mjs
// Screenshots go to RANDL_SCREENSHOTS when it names a directory.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-display-layout-'));
const screenshots = process.env.RANDL_SCREENSHOTS;
let server, browser;
const errors = [];
const checks = [];
try {
  server = await createServer(directory);
  const runs = [];
  for (let index = 0; index < 40; index++) {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'cells',
      name: 'run-' + String(index).padStart(2, '0'),
      displayName: 'Run ' + String(index).padStart(2, '0'),
      config: { seed: { value: index % 4 } },
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          // Runs log different lengths, so a shared X range is visible.
          content: Array.from({ length: 30 + index }, (_, step) =>
            JSON.stringify({
              _step: step,
              loss: (index + 1) / (step + 1),
              reward: index * step,
            }),
          ),
        },
      },
      complete: true,
      exitcode: 0,
    });
    runs.push(run.id);
  }
  const view = await server.tools.execute('view_create', {
    project: 'test/cells',
    name: 'Cells',
    body: {
      generation: 'manual',
      visible: runs,
      solo: [],
      sections: [
        { id: 'cells', name: 'cells' },
        { id: 'other', name: 'other' },
      ],
      sectionLayouts: { cells: { width: 3000, height: 520, rows: 1 } },
      panels: [
        {
          id: 'grid',
          plugin: 'line',
          metric: 'loss',
          title: 'Loss',
          section: 'cells',
          settings: { layout: 'grid', itemSize: 240 },
        },
        { id: 'combined', plugin: 'line', metric: 'reward', title: 'Reward', section: 'other' },
        {
          id: 'groups',
          plugin: 'line',
          metric: 'reward',
          title: 'Reward by seed',
          section: 'other',
          settings: { layout: 'grid', groupBy: 'config.seed' },
        },
      ],
    },
  });
  const stored = async () => await server.db.call('view', view.id);
  const origin = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/test/cells/workspace?view=${view.id}`);
  const panel = (id) => page.locator(`[data-panel-id="${id}"]`);
  const grid = panel('grid').getByRole('grid', { name: 'Loss' });
  const cells = grid.getByRole('gridcell');
  await expect(cells.first()).toBeVisible();
  await expect(panel('grid').locator('.cell-plot canvas').first()).toBeVisible();

  // Reflow: the item size fixes the cell width; the column count follows the panel width.
  const layout = () =>
    grid.evaluate((node) => ({
      columns: Number(node.getAttribute('aria-colcount')),
      rows: Number(node.getAttribute('aria-rowcount')),
      width: node.querySelector('[role="gridcell"]').getBoundingClientRect().width,
      mounted: node.querySelectorAll('[role="gridcell"]').length,
      canvases: node.querySelectorAll('.cell-plot canvas').length,
    }));
  const wide = await layout();
  assert.ok(wide.columns >= 4, JSON.stringify(wide));
  assert.ok(wide.width >= 240 && wide.width < 2 * 240 + 8, JSON.stringify(wide));
  assert.equal(wide.rows, Math.ceil(40 / wide.columns));
  assert.ok(wide.mounted < 40, 'rows outside the viewport are not mounted');
  assert.ok(wide.mounted <= 36 && wide.canvases <= wide.mounted * 2, JSON.stringify(wide));
  await expect(panel('grid').locator('.cell-toolbar .cell-count')).toHaveText('40 runs');
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(async () => (await layout()).columns).toBeLessThan(wide.columns);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await layout()).columns).toBe(wide.columns);
  checks.push('cells reflow with the panel width and mount only visible rows');

  // The size slider reflows live and saves once on release; undo restores the size.
  const before = (await stored()).version;
  await panel('grid').hover();
  const slider = panel('grid').locator('.cell-toolbar .bx--slider__thumb');
  await expect(slider).toBeVisible();
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
  await expect.poll(async () => (await layout()).columns).toBeLessThan(wide.columns);
  assert.equal((await stored()).version, before, 'dragging does not save');
  await page.mouse.up();
  await expect.poll(async () => (await stored()).version).toBe(before + 1);
  const saved = (await stored()).body.panels.find((p) => p.id === 'grid').settings.itemSize;
  assert.ok(saved > 240 && saved % 8 === 0, String(saved));
  await page.waitForTimeout(500);
  assert.equal((await stored()).version, before + 1, 'one release saves one version');
  await panel('grid').getByRole('button', { name: 'Larger items', exact: true }).click();
  await expect
    .poll(async () => (await stored()).body.panels.find((p) => p.id === 'grid').settings.itemSize)
    .toBe(Math.min(960, saved + 40));
  await page.getByRole('button', { name: 'Undo view change', exact: true }).click();
  await page.getByRole('button', { name: 'Undo view change', exact: true }).click();
  await expect
    .poll(async () => (await stored()).body.panels.find((p) => p.id === 'grid').settings.itemSize)
    .toBe(240);
  await expect.poll(async () => (await layout()).columns).toBe(wide.columns);
  checks.push('the size slider reflows live, saves one version on release and undoes');

  // Keyboard: a roving tab stop, arrows by cell and row, Home/End, and Page keys.
  await cells.first().focus();
  const focused = () =>
    page.evaluate(() => {
      const cell = document.activeElement.closest('[role="gridcell"]');
      return cell && document.activeElement === cell ? Number(cell.dataset.index) : null;
    });
  assert.equal(await grid.locator('[role="gridcell"][tabindex="0"]').count(), 1);
  assert.equal(await panel('grid').locator('.cell-plot [tabindex="0"]').count(), 0);
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(), 1);
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(), 1 + wide.columns);
  await page.keyboard.press('End');
  assert.equal(await focused(), 2 * wide.columns - 1);
  await page.keyboard.press('Home');
  assert.equal(await focused(), wide.columns);
  await page.keyboard.press('Control+End');
  assert.equal(await focused(), 39);
  await expect(grid.locator('[data-index="39"]')).toBeInViewport();
  await page.keyboard.press('PageUp');
  assert.ok((await focused()) < 39 - wide.columns + 1);
  await page.keyboard.press('Control+Home');
  assert.equal(await focused(), 0);
  // The focused cell stays mounted while it scrolls out of view.
  await grid
    .locator('xpath=..')
    .evaluate((scroller) => (scroller.scrollTop = scroller.scrollHeight));
  await page.waitForTimeout(200);
  assert.equal(await focused(), 0);
  await expect(grid.locator('[data-index="0"]')).toHaveCount(1);
  await expect(grid.locator('[data-index="39"]')).toHaveCount(1);
  // Enter moves into the cell's chart; Escape returns to the cell.
  await grid.locator('xpath=..').evaluate((scroller) => (scroller.scrollTop = 0));
  await cells.first().focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await page.evaluate(() => document.activeElement.closest('.cell-plot') !== null),
    true,
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.equal(await focused(), 0);
  checks.push('arrow, Home/End, Page and Enter/Escape keys move through cells');

  // Linked hover: the hovered run's cell gets the outline; other cells are not dimmed.
  const firstRow = page.locator('.run-row').first();
  const firstName = (await firstRow.textContent()).trim();
  await firstRow.hover();
  await expect(grid.locator('.cell-linked')).toHaveCount(1);
  assert.match(
    firstName,
    new RegExp((await grid.locator('.cell-linked .cell-name').textContent()).trim()),
  );
  await page.mouse.move(0, 0);
  await expect(grid.locator('.cell-linked')).toHaveCount(0);
  // Hovering a cell highlights its run in the sidebar.
  const plot = panel('grid').locator('.cell-plot').first();
  const plotBox = await plot.boundingBox();
  await page.mouse.move(plotBox.x + plotBox.width * 0.5, plotBox.y + plotBox.height * 0.4);
  await expect(page.locator('.run-row.highlighted')).toHaveCount(1);
  // Sibling cells show the cursor at the same X. Runs log different lengths, so equal
  // offsets also show that every cell has the same X range.
  const offsets = () =>
    panel('grid')
      .locator('.cell-plot')
      .evaluateAll((plots) =>
        plots.flatMap((plot) => {
          const cursor = plot.querySelector('.plot-inspector-cursor:not([hidden])');
          return cursor
            ? [cursor.getBoundingClientRect().left - plot.getBoundingClientRect().left]
            : [];
        }),
      );
  await expect.poll(async () => (await offsets()).length).toBeGreaterThan(3);
  const lefts = await offsets();
  assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 2, JSON.stringify(lefts));
  checks.push('hover outlines the matching cell, highlights its run and syncs cursors');

  // Dragging in one cell zooms every cell; Reset zoom restores them.
  await page.mouse.move(plotBox.x + plotBox.width * 0.3, plotBox.y + plotBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(plotBox.x + plotBox.width * 0.6, plotBox.y + plotBox.height * 0.5, {
    steps: 6,
  });
  await page.mouse.up();
  const reset = panel('grid').getByRole('button', { name: 'Reset zoom', exact: true });
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(reset).toHaveCount(0);
  checks.push('drag zoom in a cell applies to the panel and resets');

  // Grouping: one cell per group, with its member count.
  const groups = panel('groups');
  await groups.scrollIntoViewIfNeeded();
  await expect(groups.getByRole('gridcell')).toHaveCount(4);
  await expect(groups.locator('.cell-members').first()).toHaveText('10 runs');
  await expect(groups.locator('.cell-toolbar .cell-count')).toHaveText('4 groups');
  checks.push('grouped grids show one cell per group');

  // Layout and size survive reload; the editor disables Layout under Focused run.
  await page.reload();
  await expect(grid.getByRole('gridcell').first()).toBeVisible();
  await panel('combined').hover();
  await panel('combined').getByRole('button', { name: 'Panel settings', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  const combined = editor.getByRole('tab', { name: 'Combined', exact: true });
  await expect(combined).toHaveAttribute('aria-selected', 'true');
  await editor.getByRole('tab', { name: 'Grid', exact: true }).click();
  await expect(editor.locator('.panel-editor-preview [role="grid"]')).toBeVisible();
  await editor.getByRole('tab', { name: 'Display', exact: true }).click();
  await expect(editor.getByRole('slider', { name: 'Item size' })).toBeVisible();
  await editor.getByRole('tab', { name: 'Axes', exact: true }).click();
  await editor.getByText('Shared Y range', { exact: true }).click();
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () => (await stored()).body.panels.find((p) => p.id === 'combined').settings)
    .toEqual({ layout: 'grid', sharedY: true });
  await expect(panel('combined').getByRole('gridcell').first()).toBeVisible();
  checks.push('the editor sets Layout, item size and a shared Y range');

  // Image export composes every cell, with captions, in the grid's columns.
  await page.goto(`${origin}/test/cells/workspace?view=${view.id}`);
  await expect(cells.first().locator('canvas')).toBeVisible();
  const exported = await layout();
  await panel('grid').hover();
  await panel('grid').getByRole('button', { name: 'Panel actions', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export PNG', exact: true }).click();
  const png = await readFile(await (await download).path());
  const [pngWidth, pngHeight] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.equal(
    pngWidth,
    2 * (exported.columns * (Math.round(exported.width) + 8) - 8),
    JSON.stringify(exported),
  );
  assert.equal(pngHeight % (2 * exported.rows), 0);
  assert.ok(pngHeight > 2 * exported.rows * 100);
  checks.push('PNG export composes the cells in their columns');

  // Coverflow: one run at a time; the strip, keys, swipes and pins keep the current run.
  const current = await stored();
  current.body.panels.find((p) => p.id === 'grid').settings = { layout: 'coverflow' };
  await server.db.call('viewSave', current);
  await page.reload();
  const carousel = panel('grid').getByRole('region', { name: 'Loss', exact: true });
  await expect(carousel).toHaveAttribute('aria-roledescription', 'carousel');
  const slide = carousel.locator('.carousel-slide');
  await expect(slide).toHaveAttribute('aria-label', '1 of 40: Run 39');
  await expect(slide.locator('canvas').first()).toBeVisible();
  const previous = carousel.getByRole('button', { name: 'Previous item', exact: true }),
    next = carousel.getByRole('button', { name: 'Next item', exact: true });
  await expect(previous).toBeDisabled();
  // Charts take a fixed 4:3 shape: the current run is the largest 4:3 box in the stage, and
  // neighbours show in the width that leaves. Every item with an element draws its chart.
  await expect
    .poll(async () =>
      panel('grid').evaluate((node) => [
        node.querySelectorAll('.carousel-item').length,
        node.querySelectorAll('.carousel-item .cell-plot [_echarts_instance_]').length,
      ]),
    )
    .toEqual(await panel('grid').evaluate((node) => {
      const items = node.querySelectorAll('.carousel-item').length;
      return [items, items];
    }));
  assert.equal(await slide.evaluate((el) => getComputedStyle(el).transform), 'none');
  const [slideBox, chartStage] = await Promise.all([
    slide.boundingBox(),
    carousel.locator('.carousel-stage').boundingBox(),
  ]);
  assert.ok(Math.abs(slideBox.width / slideBox.height - 4 / 3) < 0.02, JSON.stringify(slideBox));
  assert.ok(
    slideBox.width <= chartStage.width + 1 && slideBox.height <= chartStage.height + 1,
    JSON.stringify([slideBox, chartStage]),
  );
  if (chartStage.width - slideBox.width > 48)
    await expect(carousel.locator('.carousel-peek:visible').first()).toBeVisible();
  for (const transform of await carousel
    .locator('.carousel-peek')
    .evaluateAll((all) => all.map((el) => el.style.transform)))
    assert.match(transform, /rotateY\(-70deg\)/);
  // Neighbors have clean edges: no shading overlay, shadow or filter.
  for (const decoration of await carousel
    .locator('.carousel-peek')
    .evaluateAll((all) =>
      all.map((el) => [
        getComputedStyle(el, '::after').content,
        getComputedStyle(el).boxShadow,
        getComputedStyle(el).filter,
        getComputedStyle(el).backgroundImage,
      ]),
    ))
    assert.deepEqual(decoration, ['none', 'none', 'none', 'none']);
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await panel('grid').screenshot({ path: join(screenshots, 'chart-coverflow-light.png') });
  }
  await slide.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slide).toHaveAttribute('aria-label', '2 of 40: Run 38');
  await expect(slide).toBeFocused();
  await page.keyboard.press('End');
  await expect(slide).toHaveAttribute('aria-label', '40 of 40: Run 00');
  await expect(next).toBeDisabled();
  await page.keyboard.press('Home');
  const tabs = carousel.getByRole('tab');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(carousel.getByRole('tab', { selected: true })).toBeFocused();
  await expect(carousel.getByRole('tab', { selected: true })).toHaveAccessibleName('Run 38');
  await carousel.getByRole('tab', { name: 'Run 37', exact: true }).click();
  await expect(slide).toHaveAttribute('aria-label', '3 of 40: Run 37');
  await expect(carousel.locator('.carousel-counter')).toHaveText('3 of 40');
  // The drag that moves the items by one: how far the current run moves on screen to its
  // neighbor's place.
  const stage = carousel.locator('.carousel-stage'),
    stageBox = await stage.boundingBox(),
    settled = () => expect.poll(() => slide.evaluate((el) => el.style.transform)).toBe('none'),
    scrub = await carousel.evaluate((node) => {
      const at = Number(node.querySelector('.carousel-slide').dataset.index),
        transform = node.querySelector(`.carousel-item[data-index="${at + 1}"]`).style.transform,
        [, p, x, z] = transform.match(
          /perspective\(([-\d.e]+)px\) translate3d\(([-\d.e]+)px, 0px, ([-\d.e]+)px\)/,
        );
      return Math.max(48, Math.abs(x) * (p / (p - z)));
    }),
    turn = (index) =>
      carousel
        .locator(`.carousel-item[data-index="${index}"]`)
        .evaluate((el) => Number(el.style.transform.match(/rotateY\(([-\d.e]+)deg\)/)?.[1] ?? 0));
  // A short, slow touch drag on the stage stays on the current run; a short flick moves one.
  const touchDrag = (moves, every) =>
    stage.evaluate(
      async (stage, { box, moves, every }) => {
        const y = box.y + box.height / 2,
          at = (type, x) =>
            stage.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 7,
                pointerType: 'touch',
                clientX: x,
                clientY: y,
                bubbles: true,
              }),
            );
        let x = box.x + box.width / 2;
        at('pointerdown', x);
        for (const move of moves) {
          await new Promise((resolve) => setTimeout(resolve, every));
          at('pointermove', (x -= move));
        }
        at('pointerup', x);
      },
      { box: stageBox, moves, every },
    );
  const unmoved = await slide.getAttribute('aria-label');
  await touchDrag([12, 6, 6, 6, 6, 4, 0, 0, 0, 0, 0], 30);
  await expect(stage).not.toHaveClass(/swiping/);
  await expect(slide).toHaveAttribute('aria-label', unmoved);
  await settled();
  await touchDrag([12, 16, 16, 16], 16);
  await expect(slide).toHaveAttribute('aria-label', '4 of 40: Run 36');
  // A real touch drag that starts on the current chart moves the items continuously with the
  // finger: halfway between two runs, both stand half turned and the current run stays. On
  // release the runs move on at once, frame by frame, to the nearest run.
  {
    await settled();
    const box = await slide.boundingBox(),
      x = box.x + box.width / 2,
      y = box.y + box.height / 2,
      cdp = await page.context().newCDPSession(page),
      // The drag takes up from the 10 px where it is known to be horizontal.
      to = (items) =>
        cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x - 10 - items * scrub, y }],
        });
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - 10, y }],
      });
      for (let tenths = 1; tenths <= 15; tenths++) await to(tenths / 10);
      await expect(stage).toHaveClass(/swiping/);
      await expect.poll(() => turn(4)).toBeGreaterThan(30);
      assert.ok((await turn(4)) < 40, String(await turn(4)));
      assert.ok(Math.abs((await turn(5)) + 35) < 5, String(await turn(5)));
      await expect(slide).toHaveAttribute('aria-label', '4 of 40: Run 36');
      for (let tenths = 16; tenths <= 23; tenths++) await to(tenths / 10);
      await page.waitForTimeout(300);
      await carousel.evaluate((node) => {
        const item = () => node.querySelector('.carousel-item[data-index="5"]'),
          turned = () => Number(item().style.transform.match(/rotateY\(([-\d.e]+)deg\)/)?.[1] ?? 0);
        window.turns = [];
        node.addEventListener('pointerup', () => (window.released = performance.now()), {
          once: true,
        });
        const frame = (now) => {
          if (window.released !== undefined && now > window.released) window.turns.push(turned());
          if (window.turns.length < 12) requestAnimationFrame(frame);
        };
        window.held = turned();
        requestAnimationFrame(frame);
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp.detach();
    }
    await expect(slide).toHaveAttribute('aria-label', '6 of 40: Run 34');
    // From 0.3 of the way to the next run, Run 34 turns back to face the viewer from the first
    // frames after the release on, in one motion, without a pause after the drag.
    const { held, turns } = await page.evaluate(async () => {
      while (window.turns.length < 12) await new Promise(requestAnimationFrame);
      return { held: window.held, turns: window.turns };
    });
    assert.ok(Math.abs(held - 21) < 3, 'released 0.3 on: ' + held);
    assert.ok(turns[1] < held, 'moves at once: ' + [held, turns]);
    for (let index = 1; index < turns.length; index++)
      assert.ok(turns[index] <= turns[index - 1] && turns[index] >= -0.01, 'one motion: ' + turns);
    await expect(stage).not.toHaveClass(/swiping/);
    await settled();
    // A vertical drag is the page's.
    await stage.evaluate((stage, box) => {
      const at = (type, y) =>
        stage.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 8,
            pointerType: 'touch',
            clientX: box.x + box.width / 2,
            clientY: y,
            bubbles: true,
          }),
        );
      at('pointerdown', box.y + 10);
      at('pointermove', box.y + 80);
      at('pointerup', box.y + 120);
    }, stageBox);
    await expect(slide).toHaveAttribute('aria-label', '6 of 40: Run 34');
  }
  // A horizontal touchpad scroll over the chart moves the items as a drag does and settles on
  // the nearest run once it ends; a vertical one does not move the items.
  {
    const box = await slide.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(-(scrub * 2 + 10), 0);
    await expect(slide).toHaveAttribute('aria-label', '4 of 40: Run 36');
    await settled();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    await expect(slide).toHaveAttribute('aria-label', '4 of 40: Run 36');
  }
  // Past the first run a drag stretches like a rubber band: the farther, the less it moves, but
  // it does not stop. On release the run settles back quickly.
  {
    await slide.focus();
    await page.keyboard.press('Home');
    await expect(slide).toHaveAttribute('aria-label', '1 of 40: Run 39');
    await settled();
    const box = await slide.boundingBox(),
      x = box.x + box.width / 2,
      y = box.y + box.height / 2,
      atRest = await slide.evaluate((el) => parseFloat(el.style.left)),
      shift = async () => (await slide.evaluate((el) => parseFloat(el.style.left))) - atRest,
      cdp = await page.context().newCDPSession(page),
      to = (items) =>
        cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x + 10 + items * scrub, y }],
        });
    const shifts = [];
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 10, y }],
      });
      for (const items of [0.5, 1, 1.5]) {
        await to(items);
        await page.waitForTimeout(50);
        shifts.push(await shift());
      }
      await page.waitForTimeout(300);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp.detach();
    }
    assert.ok(
      shifts[0] > 0 && shifts[1] > shifts[0] && shifts[2] > shifts[1],
      'no hard stop: ' + shifts,
    );
    assert.ok(shifts[2] - shifts[1] < shifts[1] - shifts[0], 'ever less: ' + shifts);
    assert.ok(shifts[2] < scrub * 1.5, 'less than the finger: ' + shifts);
    const back = await stage.evaluate(
      (node) =>
        new Promise((resolve) => {
          const start = performance.now(),
            check = () =>
              node.classList.contains('swiping')
                ? requestAnimationFrame(check)
                : resolve(performance.now() - start);
          check();
        }),
    );
    assert.ok(back < 500, 'springs back quickly: ' + back);
    await expect(slide).toHaveAttribute('aria-label', '1 of 40: Run 39');
    await settled();
  }
  // Touchpad gestures, as a touchpad scrolls: `deltas` of the fingers moving, then of the glide
  // after they lift, an event `every` ms. Returns the first run's `left` frame by frame, and
  // how many frames passed while the events were sent.
  const touchpad = (fingers, glide = [], every = 16, x = false) =>
    slide.evaluate(
      async (slide, { fingers, glide, every, x }) => {
        // The run's left, or for a run between two its x along the row.
        const read = (slide) =>
          x
            ? Number(slide.style.transform.match(/translate3d\(([-\d.e]+)px/)?.[1] ?? 0) +
              parseFloat(slide.style.left)
            : parseFloat(slide.style.left);
        const target = slide.querySelector('canvas') ?? slide,
          box = target.getBoundingClientRect(),
          lefts = [],
          wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let done = false;
        const frame = () => {
          lefts.push(read(slide));
          if (!done) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        for (const deltaX of [...fingers, ...glide]) {
          target.dispatchEvent(
            new WheelEvent('wheel', {
              deltaX,
              deltaMode: 0,
              clientX: box.x + box.width / 2,
              clientY: box.y + box.height / 2,
              bubbles: true,
              cancelable: true,
            }),
          );
          await wait(every);
        }
        const sent = lefts.length,
          stage = slide.closest('.carousel-stage');
        while (stage.classList.contains('swiping')) await wait(16);
        done = true;
        return { lefts, sent };
      },
      { fingers, glide, every, x },
    );
  // A slow touchpad swipe follows the fingers however slowly they move, with pauses between
  // events, and settles on the nearest run when they lift still.
  {
    await settled();
    // About 0.3 px/ms in uneven steps, 1.6 runs in all.
    const steps = Array.from(
        { length: 60 },
        (_, index) => ([3, 5, 2, 6, 4][index % 5] * scrub * 1.6) / 240,
      ),
      moved = steps.reduce((sum, step) => sum + step, 0),
      { lefts: xs } = await touchpad(steps, [], 45, true);
    // The first run moves left with the fingers, never back while they move.
    const tracked = new Set(xs).size,
      far = xs.indexOf(Math.min(...xs));
    assert.ok(tracked > 20, 'follows the fingers: ' + xs);
    for (let index = 1; index < far; index++)
      assert.ok(xs[index] <= xs[index - 1] + 0.01, 'never back while moving: ' + xs);
    assert.ok(Math.abs(moved / scrub - 1.6) < 1e-9);
    await expect(slide).toHaveAttribute('aria-label', '3 of 40: Run 37');
    await settled();
    await slide.focus();
    await page.keyboard.press('Home');
    await expect(slide).toHaveAttribute('aria-label', '1 of 40: Run 39');
    await settled();
  }
  // A touchpad swipe past the first run stretches; once the fingers lift, the glide's first
  // events hand over to the spring, which takes the run back in one motion, and the rest of
  // the glide does not drag again.
  {
    const left = () => slide.evaluate((el) => parseFloat(el.style.left)),
      atRest = await left(),
      glide = Array.from({ length: 30 }, (_, index) => -40 * 0.88 ** (index + 1)),
      { lefts, sent } = await touchpad(Array(8).fill(-40), glide);
    const peak = Math.max(...lefts),
      top = lefts.indexOf(peak);
    assert.ok(peak > atRest, 'stretched: ' + [atRest, peak]);
    // The spring takes over while the glide still sends events.
    const back = lefts.findIndex((value, index) => index > top && value < peak - 1);
    assert.ok(back > 0 && back < sent - 5, 'takes over from the glide: ' + [back, sent]);
    for (let index = top + 1; index < lefts.length; index++)
      assert.ok(lefts[index] <= lefts[index - 1] + 0.01, 'one motion back: ' + lefts);
    await expect(slide).toHaveAttribute('aria-label', '1 of 40: Run 39');
    await settled();
    assert.equal(await left(), atRest);
  }
  await carousel.getByRole('tab', { name: 'Run 36', exact: true }).click();
  await expect(slide).toHaveAttribute('aria-label', '4 of 40: Run 36');
  // Pinning a run moves it first; the current run stays shown at its new position.
  await page.locator('.run-row').filter({ hasText: 'Run 30' }).hover();
  await page.getByRole('button', { name: 'Pin Run 30', exact: true }).click();
  await expect(slide).toHaveAttribute('aria-label', '5 of 40: Run 36');
  // Reload keeps the layout but not the position.
  await page.reload();
  await expect(slide).toHaveAttribute('aria-label', /^1 of 40: /);
  checks.push(
    'Coverflow moves by buttons, keys, strip, touch drags and touchpad scrolls, and keeps its run across pins',
  );

  // A very wide panel shows as many neighbors as its width holds, more than three on each
  // side; only those and one hidden beyond each edge have elements, each with the chart it
  // shows when current, inert, so the renderers are bounded by what the width holds.
  await page.setViewportSize({ width: 3200, height: 1000 });
  await expect(slide).toHaveAttribute('aria-label', /^1 of 40: /);
  const flowCounts = () =>
    carousel.evaluate((node) => {
      const items = [...node.querySelectorAll('.carousel-item')],
        shown = items.filter(
          (el) =>
            el.classList.contains('carousel-peek') && getComputedStyle(el).visibility !== 'hidden',
        );
      return {
        stage: node.querySelector('.carousel-stage').clientWidth,
        items: items.length,
        left: shown.filter((el) => el.dataset.side === 'left').length,
        right: shown.filter((el) => el.dataset.side === 'right').length,
        hidden: items.length - shown.length - 1,
        charts: node.querySelectorAll('.carousel-item .cell-plot [_echarts_instance_]').length,
        inert: [...node.querySelectorAll('.carousel-peek .cell-plot')].every((plot) => plot.inert),
        // Each chart fills its item's plot, also for items that entered at an edge.
        misdrawn: [...node.querySelectorAll('.carousel-item .cell-plot')].filter((plot) => {
          const canvas = plot.querySelector('canvas');
          return (
            !canvas ||
            Math.abs(canvas.offsetWidth - plot.offsetWidth) > 1 ||
            Math.abs(canvas.offsetHeight - plot.offsetHeight) > 1
          );
        }).length,
      };
    });
  await page.waitForTimeout(600);
  const atStart = await flowCounts();
  assert.ok(atStart.stage > 2400, JSON.stringify(atStart));
  assert.equal(atStart.left, 0, JSON.stringify(atStart));
  assert.ok(atStart.right > 3 && atStart.hidden <= 1, JSON.stringify(atStart));
  assert.equal(atStart.items, 1 + atStart.right + atStart.hidden, JSON.stringify(atStart));
  await slide.focus();
  for (let step = 0; step < 19; step++) await page.keyboard.press('ArrowRight');
  await expect(slide).toHaveAttribute('aria-label', /^20 of 40: /);
  await page.waitForTimeout(600);
  const middle = await flowCounts();
  assert.ok(middle.left > 3 && middle.right > 3, JSON.stringify(middle));
  assert.ok(middle.hidden <= 2, JSON.stringify(middle));
  assert.equal(
    middle.items,
    1 + middle.left + middle.right + middle.hidden,
    JSON.stringify(middle),
  );
  assert.equal(middle.charts, middle.items, JSON.stringify(middle));
  assert.ok(middle.inert, JSON.stringify(middle));
  assert.equal(middle.misdrawn, 0, JSON.stringify(middle));
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await panel('grid').screenshot({ path: join(screenshots, 'chart-coverflow-3200.png') });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Moves in quick succession bring in neighbors at the edge while others still slide; each
  // chart still fills its item once they come to rest.
  await page.waitForTimeout(600);
  for (let step = 0; step < 6; step++) {
    await next.click();
    await page.waitForTimeout(150);
  }
  await expect.poll(async () => (await flowCounts()).misdrawn).toBe(0);
  checks.push('Coverflow at 3200 px: many neighbors per side, a chart for each, bounded elements');

  // Phone widths: one column, the count without the size control.
  const restored = await stored();
  restored.body.panels.find((p) => p.id === 'grid').settings = { layout: 'grid', itemSize: 240 };
  restored.body.pinned = [];
  await server.db.call('viewSave', restored);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/test/cells/workspace?view=${view.id}`);
    await expect(grid.getByRole('gridcell').first()).toBeVisible();
    await expect.poll(async () => (await layout()).columns).toBe(1);
    await expect(panel('grid').locator('.cell-toolbar .cell-count')).toBeVisible();
    await expect(panel('grid').locator('.cell-size')).toHaveCount(0);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'no page-level horizontal scroll at ' + width,
    );
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await panel('grid').screenshot({ path: join(screenshots, `grid-${width}-light.png`) });
    }
  }
  checks.push('phone widths show one column and the count only');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
