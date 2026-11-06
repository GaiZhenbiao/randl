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
      sections: [{ id: 'paged', name: 'Paged' }],
      sectionLayouts: { paged: { width: 600, height: 300, rows: 1 } },
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

  // A swipe on the Coverflow panel moves its runs, not the section's pages.
  await page.getByRole('button', { name: 'Previous panels in Paged', exact: true }).click();
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
