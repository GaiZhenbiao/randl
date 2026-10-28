import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-panel-icons-'));
let server, browser;
const measurements = [],
  errors = [];
try {
  server = await createServer(directory);
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'icons',
    name: 'run',
    displayName: 'Icon fixture',
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: Array.from({ length: 200 }, (_, step) =>
          JSON.stringify({ _step: step, loss: 1 / (step + 1) }),
        ),
      },
    },
    complete: true,
    exitcode: 0,
  });
  const view = await server.tools.execute('view_create', {
    project: 'test/icons',
    name: 'Icons',
    body: {
      generation: 'manual',
      panels: [{ id: 'loss', plugin: 'line', metric: 'loss', title: 'Loss' }],
      visible: [run.id],
      solo: [],
    },
  });
  const origin = await listen(server);
  browser = await launchBrowser();
  for (const theme of ['g10', 'g100'])
    for (const [width, touch] of [
      [1440, false],
      [390, true],
      [320, true],
      [390, false],
      [1440, true],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        hasTouch: touch,
        isMobile: touch,
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((theme) => localStorage.setItem('randl.theme', theme), theme);
      await page.goto(`${origin}/test/icons/workspace?view=${view.id}`);
      const chart = page.locator('.chart').first();
      await expect(chart).toBeVisible();
      const expand = chart.getByRole('button', { name: 'Expand panel', exact: true });
      await expect(expand).toHaveAttribute('title', 'Expand panel');
      const measure = async (button, label, hit = false) => {
        const value = await button.evaluate((button, hit) => {
          const icon = button.querySelector('svg'),
            b = button.getBoundingClientRect(),
            s = icon.getBoundingClientRect();
          return {
            width: b.width,
            height: b.height,
            dx: s.x + s.width / 2 - b.x - b.width / 2,
            dy: s.y + s.height / 2 - b.y - b.height / 2,
            hit:
              !hit ||
              [
                [b.x + 2, b.y + 2],
                [b.right - 2, b.y + 2],
                [b.x + 2, b.bottom - 2],
                [b.right - 2, b.bottom - 2],
              ].every(([x, y]) => button.contains(document.elementFromPoint(x, y))),
          };
        }, hit);
        assert.ok(
          Math.abs(value.dx) <= 0.5 && Math.abs(value.dy) <= 0.5,
          `${theme}/${width}/${label}: ${JSON.stringify(value)}`,
        );
        assert.ok(value.hit, 'the entire button hit area remains active');
        measurements.push({ theme, viewportWidth: width, touch, label, ...value });
        return value;
      };
      await measure(expand, 'resting Expand');
      await expect(expand).not.toHaveAttribute('aria-pressed');
      if (!touch) await chart.hover();
      const box = await measure(expand, 'revealed Expand', true);
      const menu = chart.getByRole('button', { name: 'Panel actions', exact: true });
      await expect(menu).toHaveAttribute('title', 'Panel actions');
      const menuBox = await measure(menu, 'Panel actions', true);
      assert.equal(box.width, menuBox.width);
      assert.equal(box.height, menuBox.height);
      if (touch || width <= 760)
        assert.ok(
          box.width >= 40 && box.height >= 40,
          `${theme}/${width}/touch=${touch}: ${box.width}x${box.height}`,
        );
      await expand.focus();
      await expect(expand).toBeFocused();
      await measure(expand, 'focused Expand', true);
      await expand.click();
      const exit = page.getByRole('button', { name: 'Exit full screen', exact: true });
      await expect(exit).toBeFocused();
      await measure(exit, 'Exit full screen', true);
      await expect(exit).not.toHaveAttribute('aria-pressed');
      await page.keyboard.press('Escape');
      await expect(expand).toBeFocused();
      const settings = page.getByRole('button', { name: 'Workspace settings', exact: true });
      const settingsBox = await measure(settings, 'Workspace settings', true);
      if (touch || width <= 760) assert.ok(settingsBox.width >= 40 && settingsBox.height >= 40);
      await expect(settings).not.toHaveAttribute('aria-pressed');
      {
        await expect(chart.locator('.chart-canvas canvas')).toBeVisible();
        await expect(chart.locator('.chart-status')).toHaveCount(0);
        const plot = await chart.locator('.plot').boundingBox();
        await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -400);
        await page.keyboard.up('Control');
        const reset = chart.getByRole('button', { name: 'Reset zoom', exact: true });
        await expect(reset).toBeVisible();
        await reset.focus();
        await measure(reset, 'Reset zoom', true);
        await expect(reset).not.toHaveAttribute('aria-pressed');
        await reset.click();
        await expect(reset).toHaveCount(0);
        await expect(expand).toBeFocused();
      }
      await page.close();
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ measurements, errors }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
