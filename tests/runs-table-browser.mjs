import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-runs-table-'));
const store = new Store(directory);
for (const count of [400, 10000])
  store.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const run = store.upsert({
        entity: 'test',
        project: 'table' + count,
        name: 'run-' + String(i).padStart(5, '0'),
        // Longer names mid-list only: column widths must not follow the rows on screen.
        displayName:
          'Trial ' +
          String(i).padStart(5, '0') +
          (Math.abs(i - count / 2) < 25
            ? ' with a long optimizer and learning-rate schedule description'
            : ''),
        config: { seed: { value: i % 32 } },
      });
      store.db
        .prepare("UPDATE runs SET state='finished',created=? WHERE id=?")
        .run(1000000 + i, run.id);
    }
  })();
store.db.close();
const afterLayout = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  browser = await launchBrowser();
  for (const count of [400, 10000]) {
    const project = 'test/table' + count;
    const selected = [project + '/run-00000'];
    const view = await server.tools.execute('view_create', {
      project,
      name: 'Table test',
      body: {
        generation: 'manual',
        panels: [],
        visible: selected,
        solo: [],
        runQuery: { sort: '-created' },
      },
    });
    for (const dimensions of [
      { width: 1440, height: 1444 },
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
      { width: 568, height: 320 },
      { width: 568, height: 320, touch: true },
    ]) {
      const { touch: touchOverride, ...viewport } = dimensions;
      const touch = touchOverride ?? viewport.width < 500;
      const page = await browser.newPage({
        viewport,
        ...(touch ? { hasTouch: true, isMobile: true } : {}),
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/${project}/runs?view=${view.id}`);
      const region = page.locator('.runs-table-region');
      await expect(region.locator('.table-run-name').first()).toBeVisible();
      if (count === 400 && viewport.width === 1440 && viewport.height === 1444) {
        const colorButton = region.locator('.run-color-button').first();
        await colorButton.click();
        const picker = page.getByRole('dialog', { name: /^Color for / });
        await picker.getByRole('button', { name: 'Blue', exact: true }).click();
        await page.keyboard.press('Escape');
        for (const dark of [true, false]) {
          await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
          await expect(colorButton.locator('.run-color')).toHaveCSS(
            'background-color',
            dark ? 'rgb(100, 153, 240)' : 'rgb(83, 138, 229)',
          );
          await colorButton.click();
          await expect(picker.getByRole('textbox', { name: 'Hex color', exact: true })).toHaveValue(
            '#538ae5',
          );
          await page.keyboard.press('Escape');
        }
        await colorButton.click();
        await picker.getByRole('button', { name: 'Reset to automatic', exact: true }).click();
        checks.push('Runs table and picker resolve palette choices live in both themes');
      }
      await expect(region.locator('[data-table-toggle]')).toHaveCount(0);
      await expect(
        region.getByRole('button', {
          name: /^(Toggle (visibility|solo)|Visibility for|Solo for|Solo group)/,
        }),
      ).toHaveCount(0);
      const scroller = await region.evaluateHandle((region) =>
        [...region.querySelectorAll('*')].find(
          (node) =>
            node.scrollHeight > node.clientHeight + 1 &&
            /(auto|scroll)/.test(getComputedStyle(node).overflowY),
        ),
      );
      assert.ok(await scroller.evaluate((node) => !!node), 'table has a bounded vertical scroller');
      const geometry = () =>
        scroller.evaluate((node) => {
          const b = node.getBoundingClientRect();
          return {
            top: b.top,
            bottom: b.bottom,
            height: node.clientHeight,
            scroll: node.scrollTop,
            extent: node.scrollHeight,
          };
        });
      await afterLayout(page);
      await expect.poll(async () => (await geometry()).height).toBeGreaterThan(50);
      const initial = await geometry();
      assert.ok(
        initial.bottom <= viewport.height + 1 && initial.bottom >= viewport.height - 40,
        `table fills available height at ${viewport.width}×${viewport.height}: ${JSON.stringify(initial)}`,
      );
      const coverage = () =>
        region.evaluate((region) => {
          const rows = [...region.querySelectorAll('tbody tr')].filter((row) =>
            row.querySelector('.table-run-name'),
          );
          const scroller = [...region.querySelectorAll('*')].find(
            (node) =>
              node.scrollHeight > node.clientHeight + 1 &&
              /(auto|scroll)/.test(getComputedStyle(node).overflowY),
          );
          const bounds = scroller.getBoundingClientRect(),
            header = region.querySelector('thead th').getBoundingClientRect();
          const top = Math.max(bounds.top, header.bottom),
            bottom = Math.min(bounds.bottom, innerHeight);
          const filled = rows.reduce((sum, row) => {
            const b = row.getBoundingClientRect();
            return sum + Math.max(0, Math.min(bottom, b.bottom) - Math.max(top, b.top));
          }, 0);
          return {
            filled,
            available: bottom - top,
            mounted: rows.length,
            headerTop: header.top,
            scrollerTop: bounds.top,
          };
        });
      const columnWidths = () =>
        region
          .locator('thead th')
          .evaluateAll((cells) =>
            cells.map((cell) => Math.round(cell.getBoundingClientRect().width)),
          );
      const initialWidths = await columnWidths();
      for (const position of [0, 0.5, 1, 0.25, 0, 1]) {
        await scroller.evaluate((node, position) => {
          node.scrollTop = position * (node.scrollHeight - node.clientHeight);
        }, position);
        await afterLayout(page);
        assert.deepEqual(
          await columnWidths(),
          initialWidths,
          `column widths stay fixed while scrolling (${count}/${position})`,
        );
        const fill = await coverage();
        assert.ok(
          fill.filled >= fill.available - 3,
          `no blank virtual window at ${count}/${position}: ${JSON.stringify(fill)}`,
        );
        assert.ok(fill.mounted < 100, 'mounted rows remain bounded');
        assert.ok(
          Math.abs(fill.headerTop - fill.scrollerTop) <= 2,
          'column headings stay aligned with the scroll viewport',
        );
        assert.ok(
          await region
            .locator('thead th')
            .first()
            .evaluate((cell) => {
              const bounds = cell.getBoundingClientRect();
              return cell.contains(
                document.elementFromPoint(
                  bounds.x + bounds.width / 2,
                  bounds.y + bounds.height / 2,
                ),
              );
            }),
          'Scrolled rows cannot intercept the heading checkbox',
        );
        if (position === 1)
          await expect(
            region.getByRole('link', { name: 'Trial 00000', exact: true }),
          ).toBeVisible();
        if (position === 0)
          await expect(
            region.getByRole('link', {
              name: 'Trial ' + String(count - 1).padStart(5, '0'),
              exact: true,
            }),
          ).toBeVisible();
      }
      const lastCheckbox = region.getByRole('checkbox', {
        name: 'Select Trial 00000',
        exact: true,
      });
      await region.locator('label[for="' + (await lastCheckbox.getAttribute('id')) + '"]').click();
      await expect(lastCheckbox).toBeChecked();
      await expect(page.getByRole('region', { name: 'Selected run actions' })).toContainText(
        '1 selected',
      );
      assert.deepEqual(
        (await server.db.call('view', view.id)).body.visible,
        selected,
        'management checkbox leaves workspace visibility unchanged',
      );
      assert.deepEqual((await server.db.call('view', view.id)).body.solo, []);
      await page
        .getByRole('region', { name: 'Selected run actions' })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      await expect(
        region.getByRole('checkbox', { name: 'Select listed runs', exact: true }),
      ).toBeFocused();
      const nextHeight = viewport.height > 900 ? 900 : viewport.height + 180;
      await page.setViewportSize({ ...viewport, height: nextHeight });
      await afterLayout(page);
      const resized = await geometry();
      assert.ok(
        resized.bottom <= nextHeight + 1 && resized.bottom >= nextHeight - 40,
        'table adapts after resize',
      );
      await scroller.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await afterLayout(page);
      await expect(region.getByRole('link', { name: 'Trial 00000', exact: true })).toBeVisible();
      if (viewport.width === 1440 && viewport.height === 900) {
        await scroller.evaluate((node) => {
          node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
        });
        await afterLayout(page);
        const originRow = await region.evaluate((region) => {
          const host = region.querySelector('[data-runs-scroller]'),
            header = host.querySelector('thead th').getBoundingClientRect();
          return [...host.querySelectorAll('tbody tr[data-row]')].find(
            (row) => row.getBoundingClientRect().top >= header.bottom,
          ).dataset.row;
        });
        const originLink = () => region.locator('tr[data-row="' + originRow + '"] .table-link');
        await originLink().focus();
        const originalTop = await scroller.evaluate((node) => node.scrollTop);
        await scroller.evaluate((node) => {
          node.scrollTop = 0;
        });
        await afterLayout(page);
        await expect(page.locator('[data-runs-scroller]')).toBeFocused();
        await scroller.evaluate((node, top) => {
          node.scrollTop = top;
        }, originalTop);
        await afterLayout(page);
        await expect(originLink()).toBeFocused();
        await originLink().click();
        await page.waitForURL(/\/runs\/run-/);
        await page.goBack();
        await page.waitForURL(`${origin}/${project}/runs?view=${view.id}`);
        await expect(originLink()).toBeFocused();
        await expect
          .poll(() => region.locator('[data-runs-scroller]').evaluate((node) => node.scrollTop))
          .toBe(originalTop);
        const restored = region.locator('[data-runs-scroller]');
        await originLink().click();
        await page.waitForURL(/\/runs\/run-/);
        await page.goBack();
        const immediateSearch = page.getByRole('searchbox', {
          name: 'Search runs by name or ID',
          exact: true,
        });
        await immediateSearch.focus();
        await page.keyboard.type('Trial', { delay: 120 });
        await expect(immediateSearch).toBeFocused();
        await expect(immediateSearch).toHaveValue('Trial');
        await immediateSearch.fill('');
        await restored.focus();
        await page.keyboard.press('End');
        await afterLayout(page);
        await expect(region.getByRole('link', { name: 'Trial 00000', exact: true })).toBeVisible();
        await expect(restored).toBeFocused();
        await page.keyboard.press('Home');
        await afterLayout(page);
        await expect(
          region.getByRole('link', {
            name: 'Trial ' + String(count - 1).padStart(5, '0'),
            exact: true,
          }),
        ).toBeVisible();
        const search = page.getByRole('searchbox', {
          name: 'Search runs by name or ID',
          exact: true,
        });
        const frame = await restored.boundingBox();
        await search.fill('Trial 0000');
        await expect(region.locator('.table-run-name')).toHaveCount(10);
        const shortFrame = await restored.boundingBox();
        assert.ok(
          Math.abs(shortFrame.height - frame.height) <= 1,
          'short datasets retain the allocated table height',
        );
        assert.equal(
          await restored.evaluate((node) => node.scrollHeight > node.clientHeight + 1),
          false,
          'short dataset has no virtual spacer scrolling',
        );
        await search.fill('no matching experiment');
        await expect(region.locator('thead')).toBeHidden();
        await expect(restored).toHaveAttribute('tabindex', '-1');
        await expect(restored).toHaveCount(1);
        const zeroFrame = await restored.boundingBox();
        assert.ok(
          Math.abs(zeroFrame.height - frame.height) <= 1,
          'zero results preserve the table surface',
        );
        await expect(region.locator('.empty-table')).toContainText('No matching runs');
        await region.getByRole('button', { name: 'Clear search', exact: true }).click();
        await expect(region.locator('.table-run-name').first()).toBeVisible();
        await expect(search).toHaveValue('');
        await expect(search).toBeFocused();
        await expect.poll(() => restored.evaluate((node) => node.scrollTop)).toBe(0);
        await search.fill('no matching experiment');
        await expect(region.locator('thead')).toBeHidden();
        await search.fill('');
        await expect(search).toBeFocused();
        await expect.poll(() => restored.evaluate((node) => node.scrollTop)).toBe(0);
        // The search text is per-tab state and never part of the saved view.
        assert.equal((await server.db.call('view', view.id)).body.runQuery?.search, undefined);
      }
      await page.close();
    }
    if (count === 400) {
      const translatedView = await server.tools.execute('view_create', {
        project,
        name: 'Translated table',
        body: {
          ...view.body,
          filters: Array.from({ length: 12 }, () => ({
            field: 'config.seed',
            operator: 'eq',
            value: '0',
          })),
        },
      });
      for (const language of ['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
        for (const viewport of [
          { width: 320, height: 640 },
          { width: 568, height: 320 },
          { width: 520, height: 700 },
          { width: 555, height: 700 },
        ]) {
          const page = await browser.newPage({ viewport, hasTouch: true, isMobile: true });
          page.on('pageerror', (error) => errors.push(error.message));
          await page.addInitScript(
            (language) => localStorage.setItem('randl.language', language),
            language,
          );
          await page.goto(`${origin}/${project}/runs?view=${translatedView.id}`);
          await expect(page.locator('.table-run-name').first()).toBeVisible();
          await afterLayout(page);
          const layout = await page.evaluate(() => {
            const host = document.querySelector('[data-runs-scroller]');
            const header = host.querySelector('thead').getBoundingClientRect();
            const row = host.querySelector('tbody tr[data-row]').getBoundingClientRect();
            const buttons = [...document.querySelectorAll('.runs-table-toolbar button')].filter(
              (button) => !button.closest('.runs-table-search'),
            );
            const exportButton = buttons.at(-1).getBoundingClientRect();
            const columnsButton = buttons.at(-2).getBoundingClientRect();
            const main = document.getElementById('main');
            const toolbar = document.querySelector('.runs-table-toolbar').getBoundingClientRect();
            const controlsInBounds = buttons.every((button) => {
              const b = button.getBoundingClientRect();
              return b.left >= toolbar.left && b.right <= toolbar.right;
            });
            return {
              controlsInBounds,
              header: header.height,
              row: row.height,
              available: host.clientHeight,
              outerScroll: main.scrollHeight - main.clientHeight,
              overflow: document.documentElement.scrollWidth - innerWidth,
              exportY: exportButton.top,
              columnsY: columnsButton.top,
            };
          });
          assert.ok(layout.header <= 49, `${language}: headings remain one line`);
          assert.ok(
            layout.available >= layout.header + layout.row - 1,
            `${language}: at least one whole row remains available`,
          );
          assert.ok(
            layout.outerScroll <= 1 && layout.overflow <= 1,
            `${language}: ordinary controls fit the viewport`,
          );
          assert.ok(
            layout.controlsInBounds,
            `${language}: toolbar actions stay inside the visible toolbar`,
          );
          assert.equal(layout.exportY, layout.columnsY, `${language}: Export stays with Columns`);
          await page.close();
        }
      }
      checks.push(
        'All five languages retain a usable short table and grouped column/export controls with twelve filters',
      );
    }
    checks.push(
      `${count} runs: full-height continuous table, bounded rows, first/last access in both directions, resizing, and independent management selection`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
