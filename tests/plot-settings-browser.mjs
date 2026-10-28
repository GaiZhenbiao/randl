import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// Panel and section headers, the workspace → section → panel settings cascade,
// delete feedback with Undo, and full-screen panels.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-plot-settings-'));
let server, browser;
const errors = [];
try {
  server = await createServer(directory);
  const runs = [];
  for (let index = 0; index < 4; index++) {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'cascade',
      name: 'run-' + index,
      displayName: 'Run ' + index,
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 60 }, (_, step) =>
            JSON.stringify({
              _step: step,
              'train/loss': (index + 1) / (step + 1),
              'train/acc': step / (60 + index),
              'eval/loss': (index + 2) / (step + 2),
            }),
          ),
        },
      },
      complete: true,
      exitcode: 0,
    });
    runs.push(run.id);
  }
  // The stat-card example exercises the plugin option contract end to end.
  const example = await server.plugins.install(join(process.cwd(), 'examples/plugins/stat-card'));
  await server.plugins.change(example.id, 'enable');
  const view = await server.tools.execute('view_create', {
    project: 'test/cascade',
    name: 'Cascade',
    body: {
      generation: 'manual',
      visible: runs,
      solo: [],
      pinned: [runs[0]],
      sections: [
        { id: 'train', name: 'train' },
        { id: 'eval', name: 'eval' },
        { id: 'stats', name: 'stats' },
      ],
      plotSettings: { maxRuns: 2 },
      panels: [
        {
          id: 'p-loss',
          plugin: 'line',
          metric: 'train/loss',
          title: 'Train loss',
          section: 'train',
        },
        {
          id: 'p-acc',
          plugin: 'line',
          metric: 'train/acc',
          title: 'Train accuracy',
          section: 'train',
        },
        { id: 'p-eval', plugin: 'line', metric: 'eval/loss', title: 'Eval loss', section: 'eval' },
        {
          id: 'p-stat',
          plugin: 'stat-card',
          metric: 'eval/loss',
          title: 'Latest eval loss',
          section: 'stats',
        },
      ],
    },
  });
  const stored = async () => (await server.db.call('view', view.id)).body;
  const origin = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/test/cascade/workspace?view=${view.id}`);
  const panel = (id) => page.locator(`[data-panel-id="${id}"]`);
  const section = (id) => page.locator(`[data-section-id="${id}"]`);
  await expect(panel('p-loss').locator('canvas').first()).toBeVisible();

  // Panel header: [full screen] [settings] [⋮]; the title is not an action.
  await panel('p-loss').hover();
  const tools = await panel('p-loss')
    .locator('.chart-tools > *')
    .evaluateAll((items) =>
      items.map((item) =>
        (
          item.getAttribute('aria-label') ||
          item.querySelector('[aria-label]')?.getAttribute('aria-label') ||
          item.title ||
          item.textContent
        ).trim(),
      ),
    );
  assert.deepEqual(tools, ['Expand panel', 'Panel settings', 'Panel actions']);
  await panel('p-loss').locator('.chart-title').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.panel-editor-modal.is-visible')).toHaveCount(0);
  await panel('p-loss').getByRole('button', { name: 'Panel actions', exact: true }).click();
  const menuItems = await page
    .locator('.panel-actions-menu .bx--overflow-menu-options__option')
    .evaluateAll((items) =>
      items.map((item) => [
        item.textContent.trim(),
        item.classList.contains('bx--overflow-menu--divider'),
      ]),
    );
  assert.deepEqual(menuItems, [
    ['Duplicate', false],
    ['Move to first', false],
    ['Move earlier', false],
    ['Move later', false],
    ['Move to last', false],
    ['Export PNG', true],
    ['Export chart data (CSV)', false],
    ['Delete panel', true],
  ]);
  await page.keyboard.press('Escape');

  // Section actions stay visible at the section's trailing edge.
  await page.mouse.move(0, 0);
  const actionsAtRest = await section('train').evaluate((node) => {
    const visible = (selector) => {
      const element = node.querySelector(selector);
      return element && getComputedStyle(element).opacity === '1'
        ? element.getBoundingClientRect()
        : null;
    };
    const menu = visible('.section-actions .bx--overflow-menu');
    return {
      add: !!visible('.section-add'),
      settings: !!visible('.section-settings'),
      aligned:
        !!menu &&
        Math.abs(menu.right - node.querySelector('.charts').getBoundingClientRect().right) < 1,
    };
  });
  assert.deepEqual(actionsAtRest, { add: true, settings: true, aligned: true });

  // Section header: the chevron collapses; the title does nothing.
  const toggle = section('train').locator('.section-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await section('train').locator('.section-title').click();
  await page.waitForTimeout(300);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await section('train').locator('.section-heading').hover();
  await section('train')
    .getByRole('button', { name: 'train section actions', exact: true })
    .click();
  await expect(page.getByRole('menuitem', { name: 'Plot settings' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Workspace defaults: EMA smoothing for every panel.
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  let drawer = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await expect(drawer.getByRole('tab', { name: 'Panel list', exact: true })).toBeVisible();
  await expect(drawer.getByRole('combobox', { name: 'Panel settings', exact: true })).toHaveCount(
    0,
  );
  await drawer.getByRole('tab', { name: 'Smoothing', exact: true }).click();
  await drawer.getByRole('combobox', { name: 'Smoothing method', exact: true }).selectOption('ema');
  await expect(
    drawer.locator('[role="tabpanel"]:not([hidden]) .setting-origin').first(),
  ).toContainText('Set for this workspace');
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(drawer.getByRole('combobox', { name: 'Runs shown', exact: true })).toHaveValue(
    'limit',
  );
  await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect
    .poll(async () => (await stored()).plotSettings)
    .toEqual({
      maxRuns: 2,
      smoothingMethod: 'ema',
      smoothingValue: 0.6,
    });

  // Section settings show the inherited value and its source, and can override it.
  await section('train').locator('.section-heading').hover();
  await section('train')
    .getByRole('button', { name: 'train section settings', exact: true })
    .click();
  drawer = page.getByRole('dialog', { name: 'train section settings', exact: true });
  await drawer.getByRole('tab', { name: 'Smoothing', exact: true }).click();
  const method = drawer.getByRole('combobox', { name: 'Smoothing method', exact: true });
  const origin1 = drawer.locator('[role="tabpanel"]:not([hidden]) .setting-origin').first();
  await expect(method).toHaveValue('ema');
  await expect(origin1).toHaveText('From workspace settings');
  await method.selectOption('gaussian');
  await expect(origin1).toContainText('Set for this section');
  await origin1
    .getByRole('button', { name: 'Reset Smoothing to inherited value', exact: true })
    .click();
  await expect(method).toHaveValue('ema');
  await expect(origin1).toHaveText('From workspace settings');
  await method.selectOption('running');
  await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect
    .poll(async () => (await stored()).sectionSettings?.train)
    .toEqual({
      smoothingMethod: 'running',
      smoothingValue: 10,
    });

  // Panel settings name the nearest source; Display lists Show legend first.
  await panel('p-acc').hover();
  await panel('p-acc').getByRole('button', { name: 'Panel settings', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  await expect(editor.getByRole('tab', { name: 'Data', exact: true })).toBeFocused();
  await editor.getByRole('tab', { name: 'Smoothing', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: 'Smoothing method', exact: true })).toHaveValue(
    'running',
  );
  await expect(
    editor.locator('[role="tabpanel"]:not([hidden]) .setting-origin').first(),
  ).toHaveText('From section settings');
  await editor.getByRole('tab', { name: 'Display', exact: true }).click();
  const display = await editor
    .locator('[role="tabpanel"]:not([hidden]) .form-stack > *')
    .evaluateAll((items) =>
      items.map((item) => item.textContent.trim().split('\n')[0]).slice(0, 2),
    );
  assert.match(display[0], /Show legend/);
  await editor.getByText('Show legend', { exact: true }).click();
  await expect(
    editor.getByRole('combobox', { name: 'Legend position', exact: true }),
  ).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.panel-editor-modal.is-visible')).toHaveCount(0);
  await expect(
    panel('p-acc').getByRole('button', { name: 'Panel settings', exact: true }),
  ).toBeFocused();
  await panel('p-eval').hover();
  await panel('p-eval').getByRole('button', { name: 'Panel settings', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  await editor.getByRole('tab', { name: 'Smoothing', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: 'Smoothing method', exact: true })).toHaveValue(
    'ema',
  );
  await expect(
    editor.locator('[role="tabpanel"]:not([hidden]) .setting-origin').first(),
  ).toHaveText('From workspace settings');
  // The preview plots the same runs as the panel, including the pinned run.
  const legend = (scope) =>
    scope
      .locator('.chart-legend-item')
      .evaluateAll((items) => items.map((item) => item.textContent.trim()));
  await expect
    .poll(() => legend(editor.locator('.panel-editor-preview')))
    .toEqual(await legend(panel('p-eval')));
  assert.equal((await legend(panel('p-eval')))[0], 'Run 0');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toBeHidden();

  // Add panel starts with the metric choice.
  await page.getByRole('button', { name: 'Add panel', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Add panel', exact: true });
  await expect(editor.locator('.metric-picker input')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();

  // Runs shown reads Groups shown while grouping applies at that layer.
  await section('train').locator('.section-heading').hover();
  await section('train')
    .getByRole('button', { name: 'train section settings', exact: true })
    .click();
  drawer = page.getByRole('dialog', { name: 'train section settings', exact: true });
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(drawer.getByRole('combobox', { name: 'Runs shown', exact: true })).toHaveValue(
    'limit',
  );
  await expect(
    drawer.locator('[role="tabpanel"]:not([hidden]) .setting-origin').first(),
  ).toHaveText('From workspace settings');
  await drawer.getByRole('tab', { name: 'Grouping', exact: true }).click();
  await drawer
    .getByRole('combobox', { name: 'Group runs', exact: true })
    .fill('All runs as one group');
  await page.getByRole('option', { name: 'All runs as one group', exact: true }).click();
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(drawer.getByRole('combobox', { name: 'Groups shown', exact: true })).toBeVisible();
  await expect(
    drawer.getByRole('spinbutton', { name: 'Maximum groups', exact: true }),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Plugin options: the stat-card's options appear in its Display and Data tabs with their
  // source, reach the renderer resolved, and cascade from section settings.
  const stat = panel('p-stat');
  await stat.scrollIntoViewIfNeeded();
  await expect(stat.locator('strong').first()).toHaveText('0.0328');
  await stat.hover();
  await stat.getByRole('button', { name: 'Panel settings', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  await editor.getByRole('tab', { name: 'Display', exact: true }).click();
  const tabPanel = editor.locator('[role="tabpanel"]:not([hidden])');
  await expect(tabPanel.locator('h3.form-subheading')).toHaveText('Latest value');
  const decimals = editor.getByRole('spinbutton', { name: 'Decimal places', exact: true });
  await expect(decimals).toHaveValue('4');
  await expect(tabPanel.getByText('8 places', { exact: true })).toBeVisible();
  await decimals.fill('2');
  await decimals.press('Tab');
  await expect(tabPanel.locator('.setting-origin').first()).toContainText('Set for this panel');
  const threshold = editor.getByRole('spinbutton', { name: 'Threshold', exact: true });
  await expect(threshold).toBeDisabled();
  await editor.getByRole('combobox', { name: 'Trend marker', exact: true }).selectOption('arrow');
  await expect(threshold).toBeEnabled();
  await threshold.fill('0.01');
  await threshold.press('Tab');
  await editor.getByRole('tab', { name: 'Data', exact: true }).click();
  await editor.getByRole('textbox', { name: 'Value prefix', exact: true }).fill('≈');
  // The prefix follows the title field.
  const labels = await editor
    .locator('[role="tabpanel"]:not([hidden]) .bx--label')
    .evaluateAll((items) => items.map((item) => item.textContent.trim()));
  assert.equal(labels.indexOf('Value prefix'), labels.indexOf('Title') + 1, JSON.stringify(labels));
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () => (await stored()).panels.find((p) => p.id === 'p-stat').settings?.options)
    .toEqual({
      'stat-card': { decimals: 2, trend: 'arrow', threshold: 0.01, accent: '#0f62fe', prefix: '≈' },
    });
  await expect(stat.locator('strong').first()).toHaveText('▲ ≈0.03');
  // Section settings list the plugin's section-scope options; the prefix is panel-only.
  await section('stats').locator('.section-heading').hover();
  await section('stats')
    .getByRole('button', { name: 'stats section settings', exact: true })
    .click();
  drawer = page.getByRole('dialog', { name: 'stats section settings', exact: true });
  await drawer.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(drawer.getByRole('textbox', { name: 'Value prefix', exact: true })).toHaveCount(0);
  await drawer.getByRole('tab', { name: 'Display', exact: true }).click();
  const sectionDecimals = drawer.getByRole('spinbutton', { name: 'Decimal places', exact: true });
  await sectionDecimals.fill('1');
  await sectionDecimals.press('Tab');
  // The plugin's options follow the host's display settings under the plugin's name.
  const sectionOrigin = drawer.locator(
    'xpath=//h3[normalize-space()="Latest value"]/following-sibling::div[contains(@class,"setting-origin")][1]',
  );
  await expect(
    drawer.locator('[role="tabpanel"]:not([hidden]) h3.form-subheading').last(),
  ).toHaveText('Latest value');
  await expect(sectionOrigin).toContainText('Set for this section');
  await sectionOrigin
    .getByRole('button', { name: 'Reset Decimal places to inherited value' })
    .click();
  await expect(sectionOrigin).toHaveText('Default');
  await sectionDecimals.fill('1');
  await sectionDecimals.press('Tab');
  await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect
    .poll(async () => (await stored()).sectionSettings?.stats)
    .toEqual({ options: { 'stat-card': { decimals: 1 } } });
  // The panel's own value still overrides the section's.
  await expect(stat.locator('strong').first()).toHaveText('▲ ≈0.03');
  // A stored value its descriptor refuses (as an older plugin revision could have accepted)
  // falls back to the default, says so, and does not block other edits of the view.
  const current = await server.tools.execute('view_get', { id: view.id });
  current.body.panels.find((p) => p.id === 'p-stat').settings = {
    options: { 'stat-card': { decimals: 30 } },
  };
  await server.db.call('viewSave', current);
  await page.reload();
  await expect(stat.locator('strong').first()).toHaveText('0.0328');
  await stat.hover();
  await stat.getByRole('button', { name: 'Panel settings', exact: true }).click();
  await editor.getByRole('tab', { name: 'Display', exact: true }).click();
  await expect(editor.getByText('Saved value is not valid; using the default.')).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  // French labels come from the plugin's French catalog.
  await page.evaluate(() => localStorage.setItem('randl.language', 'fr'));
  await page.reload();
  await stat.hover();
  await stat.getByRole('button', { name: 'Paramètres du panneau', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Paramètres du panneau', exact: true });
  await editor.getByRole('tab', { name: 'Affichage', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: 'Décimales', exact: true })).toBeVisible();
  await expect(
    editor.getByRole('combobox', { name: 'Marqueur de tendance', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.setItem('randl.language', 'en'));
  await page.reload();

  // Renaming a section keeps focus in its heading.
  const actions = (id) => section(id).getByRole('button', { name: /section actions$/ });
  await section('eval').locator('.section-heading').hover();
  await actions('eval').click();
  await page.getByRole('menuitem', { name: 'Rename section', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(actions('eval')).toBeFocused();
  await actions('eval').click();
  await page.getByRole('menuitem', { name: 'Rename section', exact: true }).click();
  await page.keyboard.type('Evaluation');
  await page.keyboard.press('Enter');
  await expect(section('eval').locator('.section-title')).toContainText('Evaluation');
  await expect
    .poll(async () => (await stored()).sections.map((s) => s.name))
    .toEqual(['train', 'Evaluation', 'stats']);
  await expect(section('eval').locator('.section-toggle')).toBeFocused();
  await expect(section('eval').locator('.section-toggle')).toHaveAttribute('aria-expanded', 'true');

  // Deleting reports what was removed, offers Undo and moves focus to a neighbor.
  await panel('p-loss').hover();
  await panel('p-loss').getByRole('button', { name: 'Panel actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete panel', exact: true }).click();
  const toast = page.locator('.operation-toast');
  await expect(toast).toContainText('Panel Train loss deleted');
  await expect(
    panel('p-acc').getByRole('button', { name: 'Panel settings', exact: true }),
  ).toBeFocused();
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel('p-loss')).toBeVisible();
  await expect
    .poll(async () => (await stored()).panels.map((p) => p.id))
    .toEqual(['p-loss', 'p-acc', 'p-eval', 'p-stat']);
  await section('eval').locator('.section-heading').hover();
  await actions('eval').click();
  await page.getByRole('menuitem', { name: 'Delete section', exact: true }).click();
  await expect(toast).toContainText('Section Evaluation and its panel deleted');
  await expect(section('stats').locator('.section-toggle')).toBeFocused();
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel('p-eval')).toBeVisible();
  await expect
    .poll(async () => (await stored()).sections.map((s) => s.name))
    .toEqual(['train', 'Evaluation', 'stats']);

  // The toolbar stays pinned while panels scroll beneath it, except in short windows.
  const top = page.locator('.workspace-top');
  const pinnedBox = await top.boundingBox();
  await page.locator('main').evaluate((main) => (main.scrollTop = 600));
  await expect
    .poll(() => page.locator('main').evaluate((main) => main.scrollTop))
    .toBeGreaterThan(0);
  assert.deepEqual(await top.boundingBox(), pinnedBox);
  assert.ok(
    await top.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.left + 40, box.bottom - 4));
    }),
    'panels scroll beneath the toolbar',
  );
  await page.setViewportSize({ width: 1440, height: 400 });
  await expect(top).not.toHaveClass(/pinned/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(top).toHaveClass(/pinned/);
  await page.locator('main').evaluate((main) => (main.scrollTop = 0));

  // Full screen covers the viewport as a modal layer and restores on Escape.
  await panel('p-acc').hover();
  await panel('p-acc').getByRole('button', { name: 'Expand panel', exact: true }).click();
  const full = page.locator('.chart.fullscreen');
  await expect(full).toBeVisible();
  assert.deepEqual(await full.boundingBox(), { x: 0, y: 0, width: 1440, height: 900 });
  assert.ok(await page.evaluate(() => !!document.querySelector('header')?.closest('[inert]')));
  await expect(full.getByRole('button', { name: 'Exit full screen', exact: true })).toBeFocused();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    assert.ok(
      await page.evaluate(
        () =>
          document.activeElement === document.body ||
          !!document.querySelector('.chart.fullscreen')?.contains(document.activeElement),
      ),
      'focus stays in the full-screen panel',
    );
  }
  const canvas = await full.locator('canvas').first().boundingBox();
  assert.ok(canvas.width > 1300, 'the chart resizes to the viewport');
  await page.keyboard.press('Escape');
  await expect(full).toHaveCount(0);
  await expect(
    panel('p-acc').getByRole('button', { name: 'Expand panel', exact: true }),
  ).toBeFocused();
  assert.equal(
    await page.evaluate(() => !!document.querySelector('header')?.closest('[inert]')),
    false,
  );
  assert.deepEqual(errors, []);
  console.log('plot settings browser checks passed');
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
