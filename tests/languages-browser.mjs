import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const directory = await mkdtemp(join(tmpdir(), 'randl-languages-'));
let server, browser;
const errors = [],
  checked = [];
try {
  server = await createServer(directory);
  const base = await listen(server);
  await server.db.call('upsert', {
    entity: 'local',
    project: 'languages',
    name: 'fixture',
    displayName: 'Settings',
    config: { label: { value: 'Settings' } },
  });
  await server.db.call('ingest', 'local/languages/fixture', {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [
          JSON.stringify({ _step: 0, Settings: 1 }),
          JSON.stringify({ _step: 1, Settings: 2 }),
        ],
      },
    },
    complete: true,
    exitcode: 0,
  });
  const view = await server.tools.execute('view_create', {
    name: 'Settings',
    project: 'local/languages',
    body: {
      panels: [{ id: 'language-panel', plugin: 'line', metric: 'Settings', title: 'Settings' }],
      visible: ['local/languages/fixture'],
      solo: [],
      generation: 'manual',
    },
  });
  browser = await launchBrowser();
  const en = JSON.parse(
    await readFile(new URL('../frontend/src/locales/en.json', import.meta.url), 'utf8'),
  );
  /** Visible control text that overflows its control, and tab lists that need scrolling. */
  const clipped = (page) =>
    page.evaluate(() => {
      const visible = (element) => {
        const box = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        return (
          box.width > 1 &&
          box.height > 1 &&
          style.visibility !== 'hidden' &&
          style.clip !== 'rect(0px, 0px, 0px, 0px)' &&
          !element.closest('.bx--visually-hidden, [aria-hidden="true"]')
        );
      };
      const found = [];
      for (const element of document.querySelectorAll(
        'button, [role="tab"], .bx--label, legend, h1, h2, h3',
      )) {
        if (!visible(element) || getComputedStyle(element).textOverflow === 'ellipsis') continue;
        const box = element.getBoundingClientRect(),
          walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || !visible(node.parentElement)) continue;
          if (getComputedStyle(node.parentElement).textOverflow === 'ellipsis') continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const text = range.getBoundingClientRect();
          if (text.width && (text.left < box.left - 1 || text.right > box.right + 1))
            found.push(node.textContent.trim().slice(0, 60));
        }
      }
      for (const list of document.querySelectorAll('[role="tablist"]'))
        if (visible(list) && list.scrollWidth > list.clientWidth + 1)
          found.push('tab list: ' + list.textContent.trim().slice(0, 60));
      return found;
    });
  for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'es']) {
    const copy = JSON.parse(
      await readFile(new URL('../frontend/src/locales/' + lang + '.json', import.meta.url), 'utf8'),
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(lang + ': ' + e.message));
    await page.goto(base + '/local/languages/workspace?view=' + view.id);
    await page.getByRole('button', { name: en['app.settings.title'], exact: true }).click();
    await page.getByRole('combobox', { name: en['app.settings.language.label'], exact: true }).selectOption(lang);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await page
      .getByRole('dialog', { name: copy['app.settings.title'], exact: true })
      .getByRole('button', { name: copy['common.action.close'], exact: true })
      .click();
    await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', view.id);
    await expect(page.locator('.view-name .bx--visually-hidden')).toHaveText(
      copy['views.picker.saved'].replace('{name}', 'Settings'),
    );
    await expect(page.locator('.view-name > [aria-hidden="true"]')).toHaveText('Settings');
    // Project rail labels stay inside their buttons and clear the selected-page indicator.
    const railLabels = await page.locator('.project-rail > .bx--btn').evaluateAll((buttons) =>
      buttons.flatMap((button) => {
        const text = [...button.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
        );
        if (!text) return [];
        const range = document.createRange();
        range.selectNodeContents(text);
        const label = range.getBoundingClientRect(),
          box = button.getBoundingClientRect();
        return [
          {
            text: text.textContent.trim(),
            left: label.left - box.left,
            right: box.right - label.right,
            lines: Math.round(label.height / 14),
          },
        ];
      }),
    );
    for (const label of railLabels) {
      assert.ok(label.left >= 4 && label.right >= 1, `${lang}: ${label.text} fits the rail`);
      assert.ok(label.lines <= 2, `${lang}: ${label.text} uses at most two lines`);
    }
    assert.deepEqual(await clipped(page), [], `${lang}: workspace controls fit at 1440px`);
    await page.locator('[data-panel-id="language-panel"]').hover();
    await page
      .locator('[data-panel-id="language-panel"]')
      .getByRole('button', { name: copy['panel.toolbar.settings'], exact: true })
      .click();
    const editor = page.getByRole('dialog', { name: copy['panelSettings.title.edit'], exact: true });
    for (const tab of ['data', 'axes', 'smoothing', 'grouping', 'display']) {
      await editor.getByRole('tab', { name: copy['panelSettings.tabs.' + tab], exact: true }).click();
      assert.deepEqual(await clipped(page), [], `${lang}: panel settings ${tab} fit at 1440px`);
    }
    await editor.getByRole('button', { name: copy['common.action.cancel'], exact: true }).click();
    await expect(page.locator('[data-panel-id="language-panel"] .chart-title')).toHaveText(
      'Settings',
    );
    await expect(page.locator('.run-name').first()).toHaveText(/Settings/);
    await page.locator('.run-color-button').first().click();
    const picker = page.locator('.color-popover');
    for (const color of [
      'red',
      'orange',
      'peach',
      'yellow',
      'lime',
      'kellyGreen',
      'forest',
      'seafoam',
      'cyan',
      'blue',
      'purple',
      'pink',
      'magenta',
      'maroon',
      'brown',
      'gray',
    ])
      await expect(
        picker.getByRole('button', { name: copy['colors.palette.' + color], exact: true }),
      ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.run-name').first().click();
    await page.getByRole('tab', { name: copy['runPage.tabs.config'], exact: true }).click();
    await expect(page.locator('.metadata-scalar')).toHaveText('Settings');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.getByRole('tab', { name: copy['runPage.tabs.config'], exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(
        page.getByRole('combobox', { name: copy['runPage.tabs.label'], exact: true }),
      ).toHaveValue('config');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      assert.deepEqual(await clipped(page), [], `${lang}: run page controls fit at ${width}px`);
      await page.getByRole('button', { name: copy['app.nav.open'], exact: true }).click();
      const nav = page.getByRole('navigation', { name: copy['app.nav.label'], exact: true });
      await expect(nav.getByRole('link', { name: copy['nav.workspace'], exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await page.keyboard.press('Escape');
      await expect(nav).toHaveCount(0);
    }
    checked.push(lang);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      languages: checked,
      checks: [
        'language selection and reload',
        'raw view/run/panel/config data preserved',
        'all sixteen preset color controls have localized accessible names',
        'direct run tab reload',
        '390/320px navigation and document bounds',
        'no clipped control text in the workspace, panel settings tabs and run page',
      ],
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
