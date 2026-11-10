import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Swiping between a section's pages of panels: touch drags and touchpad scrolls move the pages
// with the finger, stretch past the ends, and settle on a page; a Coverflow panel in the
// section keeps its own swipes.
// npm run build
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/swipe-browser.mjs
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-swipe-'));
let server, browser;
const errors = [];
const checks = [];
try {
  server = await createServer(directory);
  const runs = [];
  for (let index = 0; index < 6; index++) {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'pages',
      name: 'run-' + index,
      displayName: 'Run ' + index,
      config: {},
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 20 }, (_, step) =>
            JSON.stringify({ _step: step, a: step * index, b: index / (step + 1), c: step }),
          ),
        },
      },
      complete: true,
      exitcode: 0,
    });
    runs.push(run.id);
  }
  // Six panels, two to a page: three pages. The first is a Coverflow.
  const view = await server.tools.execute('view_create', {
    project: 'test/pages',
    name: 'Pages',
    body: {
      generation: 'manual',
      visible: runs,
      solo: [],
      sections: [
        { id: 'paged', name: 'Paged' },
        { id: 'rows', name: 'Rows' },
        { id: 'after', name: 'After' },
      ],
      sectionLayouts: {
        paged: { width: 600, height: 300, rows: 1 },
        rows: { width: 600, height: 200, rows: 2 },
        after: { width: 600, height: 200, rows: 1 },
      },
      panels: [
        {
          id: 'flow',
          plugin: 'line',
          metric: 'a',
          title: 'Flow',
          section: 'paged',
          settings: { layout: 'coverflow' },
        },
        ...['a', 'b', 'c', 'a', 'b'].map((metric, index) => ({
          id: 'p' + index,
          plugin: 'line',
          metric,
          title: 'Panel ' + index,
          section: 'paged',
        })),
        // Two columns of two rows: a full first page and a second of one row.
        ...['a', 'b', 'c', 'a', 'b'].map((metric, index) => ({
          id: 'r' + index,
          plugin: 'line',
          metric,
          title: 'Row panel ' + index,
          section: 'rows',
        })),
        ...['a', 'b'].map((metric, index) => ({
          id: 'after' + index,
          plugin: 'line',
          metric,
          title: 'After panel ' + index,
          section: 'after',
        })),
      ],
    },
  });
  const origin = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/test/pages/workspace?view=${view.id}`);
  const section = page.locator('section.metric-section[data-section-id="paged"]'),
    grid = section.locator('.section-grid'),
    label = section.locator('.section-page'),
    pages = grid.locator('.charts'),
    track = grid.locator('.section-track');
  await expect(label).toHaveText('1–2');
  await expect(section.locator('[data-panel-id="p0"] canvas').first()).toBeVisible();
  const unit = (await grid.evaluate((node) => node.clientWidth)) + 32,
    shift = () =>
      track.evaluate((node) =>
        Number(node.style.transform.match(/translateX\(([-\d.e]+)px/)?.[1] ?? 0),
      ),
    rest = async () => {
      await expect(grid).not.toHaveClass(/swiping/);
      await expect(pages).toHaveCount(1);
    },
    cdp = await page.context().newCDPSession(page);
  // A touch drag that starts on a chart takes the pages with the finger, the next page beside
  // the current one; released past halfway, they settle on the next page.
  async function drag(from, pagesMoved, during) {
    const box = await from.boundingBox(),
      x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 10, y }],
    });
    for (let tenth = 1; tenth <= 10; tenth++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - 10 - (pagesMoved * unit * tenth) / 10, y }],
      });
    await during?.();
    await page.waitForTimeout(300);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await drag(section.locator('[data-panel-id="p0"] canvas').first(), 0.6, async () => {
    await expect(grid).toHaveClass(/swiping/);
    await expect(pages).toHaveCount(2);
    await expect.poll(shift).toBeLessThan(-0.55 * unit);
    assert.ok((await shift()) > -0.65 * unit, String(await shift()));
    await expect(label).toHaveText('1–2');
  });
  await expect(label).toHaveText('3–4');
  await rest();
  await expect(section.locator('[data-panel-id="p1"]')).toBeVisible();
  // A drag that moves too little, released still, stays on its page.
  await drag(section.locator('[data-panel-id="p1"] canvas').first(), 0.3);
  await rest();
  await expect(label).toHaveText('3–4');
  checks.push('a touch drag moves the pages with the finger and settles on the nearest page');

  // Past the last page the pages stretch like a rubber band and spring back.
  await page.getByRole('button', { name: 'Next panels in Paged', exact: true }).click();
  await expect(label).toHaveText('5–6');
  const shifts = [];
  await drag(section.locator('[data-panel-id="p3"] canvas').first(), 0.5, async () => {
    shifts.push(await shift());
  });
  assert.ok(shifts[0] < 0 && shifts[0] > -0.5 * unit * 0.6, 'stretches less: ' + shifts);
  await expect(label).toHaveText('5–6');
  await rest();
  checks.push('past the last page the pages stretch and spring back');

  // A horizontal touchpad scroll pages the same way; a vertical one scrolls the page.
  const box = await section.locator('[data-panel-id="p3"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(-(unit * 1.1), 0);
  await expect(label).toHaveText('3–4');
  await rest();
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(200);
  await expect(label).toHaveText('3–4');
  checks.push('horizontal touchpad scrolls page; vertical ones do not');

  // The page buttons move the pages as a swipe settles: the next page slides in beside the
  // current one. Each frame's shift and section height, while `action` runs.
  const frames = (target, action) =>
    Promise.all([
      target.evaluate(
        (node) =>
          new Promise((resolve) => {
            const values = [],
              start = performance.now(),
              track = node.querySelector('.section-track');
            const tick = () => {
              values.push({
                shift: Number(track.style.transform.match(/translateX\(([-\d.e]+)px/)?.[1] ?? 0),
                height: node.getBoundingClientRect().height,
              });
              if (performance.now() - start < 700) requestAnimationFrame(tick);
              else resolve(values);
            };
            requestAnimationFrame(tick);
          }),
      ),
      action(),
    ]).then(([values]) => values);
  const moving = await frames(grid, () =>
    page.getByRole('button', { name: 'Previous panels in Paged', exact: true }).click(),
  );
  await expect(label).toHaveText('1–2');
  await rest();
  const between = moving.filter((frame) => frame.shift < -0.1 * unit && frame.shift > -0.9 * unit);
  assert.ok(between.length >= 3, 'the pages slide: ' + JSON.stringify(moving.map((f) => f.shift)));
  checks.push('the page buttons slide the pages');
  // A page with fewer rows: the section's height moves to it with the pages, and back.
  const rowsSection = page.locator('section.metric-section[data-section-id="rows"]'),
    rowsGrid = rowsSection.locator('.section-grid'),
    rowsLabel = rowsSection.locator('.section-page');
  await rowsSection.scrollIntoViewIfNeeded();
  await expect(rowsLabel).toHaveText('1–4');
  const tall = (await rowsGrid.boundingBox()).height;
  const shrinking = await frames(rowsGrid, () =>
    page.getByRole('button', { name: 'Next panels in Rows', exact: true }).click(),
  );
  await expect(rowsLabel).toHaveText('5–5');
  await expect(rowsGrid).not.toHaveClass(/swiping/);
  const short = (await rowsGrid.boundingBox()).height;
  assert.ok(short < tall * 0.7, `${short} < ${tall}`);
  const heights = shrinking.map((frame) => frame.height);
  assert.ok(
    heights.filter((height) => height < tall - 10 && height > short + 10).length >= 3,
    'the height moves: ' + heights,
  );
  for (let index = 1; index < heights.length; index++)
    assert.ok(heights[index] <= heights[index - 1] + 0.5, 'shrinks steadily: ' + heights);
  assert.ok(Math.abs(heights.at(-1) - short) < 1, heights.at(-1) + ' ends at ' + short);
  const growing = (
    await frames(rowsGrid, () =>
      page.getByRole('button', { name: 'Previous panels in Rows', exact: true }).click(),
    )
  ).map((frame) => frame.height);
  assert.ok(
    growing.filter((height) => height > short + 10 && height < tall - 10).length >= 3,
    'the height moves back: ' + growing,
  );
  await expect(rowsGrid).not.toHaveClass(/swiping/);
  assert.ok(Math.abs((await rowsGrid.boundingBox()).height - tall) < 1);
  checks.push("a page with fewer rows: the section's height moves with the pages");
  // Other sections keep their compositor layers while a section's pages move: a chart moved
  // into or out of a layer is drawn again, which flickers.
  const afterSection = page.locator('section.metric-section[data-section-id="after"]');
  await expect(afterSection.locator('canvas').first()).toBeVisible();
  const turn = async () => {
    for (const name of ['Next panels in Rows', 'Previous panels in Rows']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(rowsGrid).toHaveClass(/swiping/);
      await expect(rowsGrid).not.toHaveClass(/swiping/);
    }
  };
  await turn();
  await cdp.send('DOM.getDocument', { depth: -1 });
  const trees = [];
  const record = (event) => trees.push(event.layers || []);
  cdp.on('LayerTree.layerTreeDidChange', record);
  await cdp.send('LayerTree.enable');
  await page.waitForTimeout(200);
  await turn();
  await turn();
  await cdp.send('LayerTree.disable');
  cdp.off('LayerTree.layerTreeDidChange', record);
  const changed = new Set();
  for (let index = 1; index < trees.length; index++) {
    const before = new Map(trees[index - 1].map((layer) => [layer.layerId, layer.backendNodeId])),
      after = new Map(trees[index].map((layer) => [layer.layerId, layer.backendNodeId]));
    for (const [id, node] of after) if (!before.has(id) && node) changed.add(node);
    for (const [id, node] of before) if (!after.has(id) && node) changed.add(node);
  }
  const outside = [];
  for (const backendNodeId of changed) {
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId }).catch(() => null);
    if (!resolved) continue;
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: `function () {
        const element = this.nodeType === 1 ? this : this.parentElement;
        if (!element?.isConnected || element.closest('[data-section-id="rows"]')) return '';
        return (element.closest('[data-section-id]')?.dataset.sectionId || 'page') + ' ' +
          element.nodeName + '.' + String(element.className);
      }`,
      returnByValue: true,
    });
    if (result.value) outside.push(result.value);
  }
  assert.ok(trees.length > 2, 'the layer tree was recorded: ' + trees.length);
  assert.deepEqual(outside, [], 'layers outside the moving section changed');
  checks.push("other sections keep their layers while a section's pages move");
  // A panel menu still opens over the section after its own.
  const lastRow = rowsSection.locator('[data-panel-id="r2"]');
  await lastRow.hover();
  await lastRow.getByRole('button', { name: 'Panel actions', exact: true }).click();
  const lastItem = page.locator('.panel-actions-menu .bx--overflow-menu-options__btn').last();
  await expect(lastItem).toBeVisible();
  await lastItem.scrollIntoViewIfNeeded();
  const itemBox = await lastItem.boundingBox();
  assert.ok(
    itemBox.y + itemBox.height > (await afterSection.boundingBox()).y,
    'the menu reaches past the section',
  );
  assert.ok(
    await lastItem.evaluate((element, [x, y]) => element.contains(document.elementFromPoint(x, y)), [
      itemBox.x + itemBox.width / 2,
      itemBox.y + itemBox.height / 2,
    ]),
    'the menu is on top',
  );
  await page.keyboard.press('Escape');
  checks.push('a panel menu opens over the section after its own');
  // Under reduced motion the buttons change the page at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await frames(rowsGrid, () =>
    page.getByRole('button', { name: 'Next panels in Rows', exact: true }).click(),
  );
  await expect(rowsLabel).toHaveText('5–5');
  assert.ok(
    still.every((frame) => frame.shift === 0),
    'no slide: ' + still.map((f) => f.shift),
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push('reduced motion changes the page at once');

  // A swipe on the Coverflow panel moves its runs, not the section's pages.
  await section.scrollIntoViewIfNeeded();
  await expect(label).toHaveText('1–2');
  const slide = section.locator('.carousel-slide');
  await expect(slide).toHaveAttribute('aria-label', /^1 of 6: /);
  await expect.poll(() => slide.evaluate((el) => el.style.transform)).toBe('none');
  await drag(slide, 0.3);
  await expect(slide).toHaveAttribute('aria-label', /^2 of 6: /);
  await expect(label).toHaveText('1–2');
  await rest();
  const stage = section.locator('.carousel-stage'),
    stageBox = await stage.boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.wheel(stageBox.width * 0.3, 0);
  await expect(slide).toHaveAttribute('aria-label', /^3 of 6: /);
  await expect(label).toHaveText('1–2');
  checks.push('a Coverflow panel in the section keeps its own swipes');

  // Coverflow's previous and next buttons show to a hovering mouse, not after a touchpad or
  // touch gesture until the mouse moves again.
  const next = section.getByRole('button', { name: 'Next item', exact: true }),
    shown = () => next.evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(stageBox.x + stageBox.width / 2 + 5, stageBox.y + stageBox.height / 2);
  await expect.poll(shown).toBe('1');
  await page.mouse.wheel(stageBox.width * 0.3, 0);
  await expect(slide).toHaveAttribute('aria-label', /^4 of 6: /);
  await expect.poll(shown).toBe('0');
  await page.mouse.move(stageBox.x + stageBox.width / 2 + 20, stageBox.y + stageBox.height / 2);
  await expect.poll(shown).toBe('1');
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y - 200);
  await expect.poll(shown).toBe('0');
  checks.push("Coverflow's buttons show to a hovering mouse, not after gestures");
  await cdp.detach();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
