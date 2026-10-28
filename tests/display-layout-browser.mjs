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
  // neighbours show in the width that leaves. Only the current run has a renderer.
  await expect(panel('grid').locator('canvas')).toHaveCount(1);
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
  // A swipe on the stage moves one item.
  const stageBox = await carousel.locator('.carousel-stage').boundingBox();
  await carousel.locator('.carousel-stage').evaluate((stage, box) => {
    const at = (type, x) =>
      stage.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: 'touch',
          clientX: x,
          clientY: box.y + box.height / 2,
          bubbles: true,
        }),
      );
    at('pointerdown', box.x + box.width * 0.7);
    at('pointerup', box.x + box.width * 0.3);
  }, stageBox);
  await expect(slide).toHaveAttribute('aria-label', '4 of 40: Run 36');
  // Pinning a run moves it first; the current run stays shown at its new position.
  await page.locator('.run-row').filter({ hasText: 'Run 30' }).hover();
  await page.getByRole('button', { name: 'Pin Run 30', exact: true }).click();
  await expect(slide).toHaveAttribute('aria-label', '5 of 40: Run 36');
  // Reload keeps the layout but not the position.
  await page.reload();
  await expect(slide).toHaveAttribute('aria-label', /^1 of 40: /);
  checks.push('Coverflow moves by buttons, keys, strip and swipe, and keeps its run across pins');

  // A very wide panel shows as many neighbors as its width holds, more than three on each
  // side; only those and one hidden beyond each edge have elements, all sparklines, and the
  // current run keeps the one renderer.
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
        sparklines: node.querySelectorAll('.carousel-peek .cell-sparkline').length,
        canvases: node.closest('[data-panel-id]').querySelectorAll('canvas').length,
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
  assert.equal(middle.sparklines, middle.items - 1, JSON.stringify(middle));
  assert.equal(middle.canvases, 1, JSON.stringify(middle));
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await panel('grid').screenshot({ path: join(screenshots, 'chart-coverflow-3200.png') });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('Coverflow at 3200 px: many neighbors per side, one renderer, bounded elements');

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
