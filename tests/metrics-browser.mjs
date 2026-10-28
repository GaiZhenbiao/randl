import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const panelSettings = (page, title) =>
  page
    .getByRole('article', { name: title, exact: true })
    .getByRole('button', { name: 'Panel settings', exact: true });
async function openPanelSettings(page, title) {
  await page.getByRole('article', { name: title, exact: true }).hover();
  await panelSettings(page, title).click();
}

async function pressSectionButton(scope, name) {
  const button = scope.getByRole('button', { name, exact: true });
  await button.locator('xpath=ancestor::div[contains(@class,"section-heading")]').hover();
  await button.click();
}

const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-metrics-')),
  checks = [];
let server, browser;
try {
  server = await createServer(directory);
  const base = await listen(server);
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'metrics',
    name: 'fixture',
  });
  const values = Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => ['train/metric' + String(i).padStart(3, '0'), i]),
  );
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _step: 0, ...values, 'train/loss': 2, 'train/reward': 1 })],
      },
    },
    complete: true,
    exitcode: 0,
  });
  const view = await server.tools.execute('view_create', {
    project: 'test/metrics',
    name: 'Metric picker',
    body: {
      generation: 'manual',
      panels: [
        {
          id: 'picker',
          plugin: 'line',
          metric: 'train/loss',
          metrics: ['train/loss'],
          title: 'Metric picker fixture',
          section: 's0',
        },
      ],
      sections: [{ id: 's0', name: 'Metrics' }],
      visible: [run.id],
      solo: [],
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/test/metrics/workspace?view=' + view.id);
  await openPanelSettings(page, 'Metric picker fixture');
  const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  const y = editor.getByRole('combobox', { name: 'Y metrics', exact: true }),
    x = editor.getByRole('combobox', { name: 'X axis', exact: true });
  const title = editor.getByRole('textbox', { name: 'Title', exact: true });
  for (const [stored, query, expected] of [
    ['train/metric300', 'metric25', 'train/metric250'],
    ['train/metric250', 'metric25', 'train/metric250'],
    ['train/metric300', 'metric2', 'train/metric200'],
  ]) {
    for (const delay of [0, 250]) {
      const axis = editor.getByRole('combobox', { name: 'X axis', exact: true });
      await axis.fill(stored);
      await axis.press('Enter');
      await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
      await expect
        .poll(async () => (await server.db.call('view', view.id)).body.panels[0].settings.xAxis)
        .toBe(stored);
      await openPanelSettings(page, 'Metric picker fixture');
      await axis.click();
      await page.mouse.move(20, 20);
      await page.keyboard.type(query);
      if (delay) await page.waitForTimeout(delay);
      await expect
        .poll(() =>
          axis.evaluate((input) => {
            const option = document.getElementById(input.getAttribute('aria-activedescendant'));
            const list = input.closest('.editor-choice').querySelector('[role="listbox"]');
            if (!option || !list) return null;
            const r = option.getBoundingClientRect(),
              b = list.getBoundingClientRect();
            return r.top >= b.top - 1 && r.bottom <= b.bottom + 1
              ? option.textContent.trim()
              : null;
          }),
        )
        .toBe(expected);
      await axis.press('Enter');
      await expect(axis).toHaveValue(expected);
      await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
      await expect
        .poll(async () => (await server.db.call('view', view.id)).body.panels[0].settings.xAxis)
        .toBe(expected);
      await openPanelSettings(page, 'Metric picker fixture');
    }
  }
  const initialAxis = editor.getByRole('combobox', { name: 'X axis', exact: true });
  await initialAxis.fill('Step');
  await initialAxis.press('Enter');
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await openPanelSettings(page, 'Metric picker fixture');
  checks.push(
    'Typing after opening a stored metric axis reveals the first match and Enter stores it at 0/250ms',
  );
  const titleFill = await title.evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.equal(
    await x.evaluate((node) => getComputedStyle(node.closest('.bx--list-box')).backgroundColor),
    titleFill,
  );
  assert.equal(
    await y.evaluate(
      (node) => getComputedStyle(node.closest('.metric-picker-field')).backgroundColor,
    ),
    titleFill,
  );
  const patternButton = editor.getByRole('button', {
    name: 'Match a regular expression',
    exact: true,
  });
  const toggleBox = await patternButton.boundingBox(),
    glyphBox = await patternButton.locator('span').boundingBox();
  assert.ok(
    Math.abs(
      glyphBox.x - toggleBox.x - (toggleBox.x + toggleBox.width - glyphBox.x - glyphBox.width),
    ) <= 1,
    'Regex glyph must be centered inside the button',
  );

  for (const [tabName, label, query, expected, fallback] of [
    ['Data', 'X axis', 'runtime', 'Runtime (seconds)', 'Step'],
    ['Grouping', 'Group runs', 'one group', 'All runs as one group', 'No grouping'],
    ['Display', 'Legend labels', 'ID', 'Run ID', 'Run name'],
  ]) {
    await editor.getByRole('tab', { name: tabName, exact: true }).click();
    const choice = editor.getByRole('combobox', { name: label, exact: true });
    await choice.click();
    assert.ok(
      (await page.getByRole('listbox', { name: label, exact: true }).getByRole('option').count()) >
        1,
    );
    await choice.press('Escape');
    await expect(choice).toHaveAttribute('aria-expanded', 'false');
    await choice.pressSequentially(query);
    await expect(choice).toHaveValue(query);
    await choice.press('Enter');
    await expect(choice).toHaveValue(expected);
    for (const menuOpen of [false, true]) {
      if (menuOpen) {
        await choice.click();
        await choice.fill(query);
      }
      await choice
        .locator('xpath=ancestor::div[contains(@class,"editor-choice")]')
        .getByRole('button', { name: 'Clear selected item', exact: true })
        .click();
      await expect(choice).toHaveValue(fallback);
      await choice.press('Tab');
      await expect(choice).toHaveValue(fallback);
      if (!menuOpen) {
        await choice.click();
        await choice.fill(query);
        await choice.press('Enter');
        await expect(choice).toHaveValue(expected);
      }
    }
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openPanelSettings(page, 'Metric picker fixture');
  }

  for (const [tabName, label] of [
    ['Data', 'X axis'],
    ['Grouping', 'Group runs'],
    ['Display', 'Legend labels'],
  ]) {
    await editor.getByRole('tab', { name: tabName, exact: true }).click();
    const choice = editor.getByRole('combobox', { name: label, exact: true });
    await choice.click();
    await choice.press('Escape');
    await choice
      .locator('xpath=ancestor::div[contains(@class,"editor-choice")]')
      .getByRole('button', { name: 'Clear selected item', exact: true })
      .click();
    await choice.press('Escape');
    await expect(editor).not.toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true }),
    ).not.toBeVisible();
    await openPanelSettings(page, 'Metric picker fixture');
  }
  checks.push(
    'Plain choices expose all options, preserve closed-menu typing, and show their reset default',
  );

  await title.fill('Keep this draft');
  await title.press('Escape');
  const discardDialog = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true });
  await discardDialog.getByRole('button', { name: 'Keep editing', exact: true }).dblclick();
  await expect(editor).toBeVisible();
  await expect(title).toHaveValue('Keep this draft');
  await expect(editor.getByRole('tab', { name: 'Data', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(editor).toBeVisible();
  await expect(title).toHaveValue('Keep this draft');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openPanelSettings(page, 'Metric picker fixture');
  for (const key of ['Enter', 'Space']) {
    const before = (await server.db.call('view', view.id)).version;
    await title.fill('Keep this draft');
    await title.press('Escape');
    await discardDialog.getByRole('button', { name: 'Keep editing', exact: true }).focus();
    await page.keyboard.press(key);
    await page.keyboard.press(key);
    await expect(editor).toBeVisible();
    await expect(title).toHaveValue('Keep this draft');
    assert.equal((await server.db.call('view', view.id)).version, before);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openPanelSettings(page, 'Metric picker fixture');
  }
  checks.push(
    'Double-click and repeated keyboard activation of Keep editing preserve the draft without saving',
  );

  for (const [plugin, tabName, label, initial, suffix, expected, metricField] of [
    ['line', 'Data', 'Y metrics', 'metric2', '5', 'train/metric250', true],
    ['scatter-history', 'Data', 'X metric', 'metric2', '5', 'train/metric250', true],
    ['scatter-history', 'Data', 'Y metric', 'metric2', '5', 'train/metric250', true],
    ['line', 'Data', 'X axis', 'metric2', '5', 'train/metric250', false],
    ['line', 'Grouping', 'Group runs', 'o', 'u', 'No grouping', false],
    ['line', 'Display', 'Legend labels', 'Run', 'd', 'Run ID', false],
  ]) {
    for (const delay of [0, 100, 250]) {
      await editor.getByRole('combobox', { name: 'Panel type', exact: true }).selectOption(plugin);
      await editor.getByRole('tab', { name: tabName, exact: true }).click();
      const choice = editor.getByRole('combobox', { name: label, exact: true });
      const field = metricField
        ? choice.locator('xpath=ancestor::fieldset[contains(@class,"metric-picker")]')
        : null;
      if (field) {
        for (const close of await field.getByRole('button', { name: /^Remove / }).all())
          await close.click();
      }
      await choice.fill(initial);
      const options = page.getByRole('listbox', { name: label, exact: true }).getByRole('option');
      await options.nth(label === 'Legend labels' ? 1 : 2).hover();
      if (label === 'Legend labels') await page.keyboard.press('Control+A');
      await page.keyboard.type(suffix);
      if (delay) await page.waitForTimeout(delay);
      await expect
        .poll(() =>
          choice.evaluate((input) =>
            document
              .getElementById(input.getAttribute('aria-activedescendant'))
              ?.textContent?.trim(),
          ),
        )
        .toBe(expected);
      await choice.press('Enter');
      if (field) await expect(field.locator('.bx--tag').last()).toHaveText(expected);
      else await expect(choice).toHaveValue(expected);
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await openPanelSettings(page, 'Metric picker fixture');
    }
  }
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await y.fill('metric2');
    const movingOptions = page
      .getByRole('listbox', { name: 'Y metrics', exact: true })
      .getByRole('option');
    const borders = () =>
      movingOptions.evaluateAll((rows) =>
        rows.map(
          (row) =>
            getComputedStyle(row.querySelector('.bx--list-box__menu-item__option')).borderTopColor,
        ),
      );
    await movingOptions.nth(2).hover();
    await page.keyboard.type('5');
    await page.waitForTimeout(250);
    const restingBorders = await borders();
    assert.equal(
      restingBorders[2],
      restingBorders[4],
      colorScheme + ': parked row keeps its ordinary divider',
    );
    assert.equal(
      restingBorders[3],
      restingBorders[4],
      colorScheme + ': row after parked pointer keeps its divider',
    );
    await y.press('ArrowDown');
    await page.waitForTimeout(250);
    await expect
      .poll(() =>
        y.evaluate((input) =>
          document.getElementById(input.getAttribute('aria-activedescendant'))?.textContent?.trim(),
        ),
      )
      .toBe('train/metric251');
    const arrowBorders = await borders();
    assert.equal(
      arrowBorders[2],
      arrowBorders[1],
      colorScheme + ': adjacent highlight suppresses the parked row divider',
    );
    assert.equal(arrowBorders[3], arrowBorders[4], colorScheme + ': later divider remains visible');
    await movingOptions.nth(3).hover();
    await y.press('Enter');
    await expect(editor.locator('.metric-picker-chips .bx--tag').last()).toHaveText(
      'train/metric253',
    );
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openPanelSettings(page, 'Metric picker fixture');
  }
  checks.push(
    'Shared fields keep keyboard highlight stable under a stationary pointer at 0/100/250ms; arrows and deliberate hover change it',
  );

  for (const [plugin, label, metricField] of [
    ['line', 'Y metrics', true],
    ['scatter-history', 'X metric', true],
    ['scatter-history', 'Y metric', true],
    ['line', 'X axis', false],
  ]) {
    for (const distance of [80, 160, 400]) {
      await editor.getByRole('combobox', { name: 'Panel type', exact: true }).selectOption(plugin);
      const choice = editor.getByRole('combobox', { name: label, exact: true });
      const field = metricField
        ? choice.locator('xpath=ancestor::fieldset[contains(@class,"metric-picker")]')
        : null;
      if (field)
        for (const close of await field.getByRole('button', { name: /^Remove / }).all())
          await close.click();
      await choice.fill('metric');
      const menu = page.getByRole('listbox', { name: label, exact: true });
      // The field and its menu are in view first, so neither hovering a row nor typing
      // scrolls the form under the pointer.
      await choice.evaluate(async (input) => {
        const fields = input.closest('.panel-editor-fields');
        fields.scrollTop +=
          input.getBoundingClientRect().top - fields.getBoundingClientRect().top - 8;
        await Promise.all(
          document.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });
      const row = menu.getByRole('option').nth(2);
      await row.hover();
      const box = await row.boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // Hover can scroll a clipped option and reposition its menu in the taller form.
      await page.mouse.move(point.x, point.y);
      await page.keyboard.type('0');
      await page.waitForTimeout(100);
      const before = await menu.evaluate((node) => node.scrollTop);
      await page.mouse.wheel(0, distance);
      await expect.poll(() => menu.evaluate((node) => node.scrollTop)).toBeGreaterThan(before);
      await page.waitForTimeout(250);
      const hovered = await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('[role="option"]')?.textContent?.trim(),
        point,
      );
      assert.ok(hovered, 'A wheel-scroll choice stays under the pointer');
      await expect
        .poll(() =>
          choice.evaluate((input) =>
            document
              .getElementById(input.getAttribute('aria-activedescendant'))
              ?.textContent?.trim(),
          ),
        )
        .toBe(hovered);
      await choice.press('Enter');
      if (field) await expect(field.locator('.bx--tag').last()).toHaveText(hovered);
      else await expect(choice).toHaveValue(hovered);
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await openPanelSettings(page, 'Metric picker fixture');
    }
  }
  checks.push(
    'Intentional wheel scrolling highlights the visible pointer choice and Enter selects it at small and virtualized scroll distances',
  );

  await y.click();
  const pickerCaret = editor.locator('.metric-picker .bx--list-box__menu-icon');
  await pickerCaret.click();
  await expect(y).toBeFocused();
  await expect(y).toHaveAttribute('aria-expanded', 'false');
  await y.pressSequentially('metric250');
  await y.press('Enter');
  await expect(editor.locator('.metric-picker-chips .bx--tag')).toHaveCount(2);
  await pickerCaret.click();
  await expect(y).toBeFocused();
  await expect(y).toHaveAttribute('aria-expanded', 'false');
  await y.press('Backspace');
  await expect(editor.locator('.metric-picker-chips .bx--tag')).toHaveCount(1);
  await title.focus();
  checks.push('Caret open/close keeps input focus for typing and Backspace');
  await editor
    .getByRole('combobox', { name: 'Panel type', exact: true })
    .selectOption('scatter-history');
  const singleMetric = editor.getByRole('combobox', { name: 'Y metric', exact: true });
  await singleMetric.click();
  await page
    .getByRole('listbox', { name: 'Y metric', exact: true })
    .getByRole('option')
    .nth(2)
    .hover();
  await page.keyboard.type('metric008');
  await expect(singleMetric).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Enter');
  await expect(editor.locator('.metric-picker-chips .bx--tag')).toHaveText(['train/metric008']);
  await expect(singleMetric).toHaveAttribute('aria-expanded', 'false');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openPanelSettings(page, 'Metric picker fixture');
  checks.push(
    'A single-metric choice stays keyboard-selectable when filtering shrinks the list below the pointer',
  );
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (let count = 1; count <= 8; count++) {
      if (count > 1) {
        const metric = 'train/metric' + String(count).padStart(3, '0');
        await y.fill(metric);
        await page.getByRole('option', { name: metric, exact: true }).click();
      }
      await expect
        .poll(async () => {
          const input = await y.boundingBox(),
            toggle = await patternButton.boundingBox();
          return Math.abs(input.y + input.height / 2 - toggle.y - toggle.height / 2);
        })
        .toBeLessThanOrEqual(1);
    }
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openPanelSettings(page, 'Metric picker fixture');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('Regex toggle stays on the input row at intermediate chip counts and desktop widths');

  await y.focus();
  await y.fill('metric2');
  const compositionResults = [];
  for (const key of ['Enter', 'Escape']) {
    await y.fill('metric2');
    const prevented = await y.evaluate((node, key) => {
      const event = new KeyboardEvent('keydown', {
        key,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      node.dispatchEvent(new CompositionEvent('compositionend', { data: '測定', bubbles: true }));
      node.dispatchEvent(
        new KeyboardEvent('keyup', { key, isComposing: false, bubbles: true, cancelable: true }),
      );
      return event.defaultPrevented;
    }, key);
    compositionResults.push({
      key,
      prevented,
      chips: await editor.locator('.metric-picker-chips .bx--tag').count(),
      query: await y.inputValue(),
      expanded: await y.getAttribute('aria-expanded'),
    });
  }
  assert.deepEqual(
    compositionResults,
    ['Enter', 'Escape'].map((key) => ({
      key,
      prevented: false,
      chips: 1,
      query: 'metric2',
      expanded: 'true',
    })),
    'Composition keys must preserve the open query and selection',
  );
  await y.press('Enter');
  await expect(editor.locator('.metric-picker-chips .bx--tag')).toHaveCount(2);
  await expect(y).toHaveValue('');
  await y.press('Backspace');
  await expect(editor.locator('.metric-picker-chips .bx--tag')).toHaveCount(1);
  await title.focus();
  checks.push(
    'IME composition Enter/Escape preserve query and selection; ordinary Enter commits afterward',
  );
  await y.click();
  await page
    .getByRole('listbox', { name: 'Y metrics', exact: true })
    .getByRole('option')
    .nth(2)
    .click();
  await page.keyboard.type('metric250');
  await expect(
    page.getByRole('listbox', { name: 'Y metrics', exact: true }).getByRole('option'),
  ).toHaveCount(1);
  await expect(y).toHaveAttribute('aria-activedescendant', /.+/);
  await y.evaluate((input) => {
    input.parentElement.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter')
          input.dataset.highlightAtEnter =
            document
              .getElementById(input.getAttribute('aria-activedescendant'))
              ?.textContent?.trim() || '';
      },
      { capture: true, once: true },
    );
  });
  await page.keyboard.press('Enter');
  const highlightedAfterTyping = await y.getAttribute('data-highlight-at-enter');
  assert.ok(
    highlightedAfterTyping,
    'A matching metric must be visibly highlighted when Enter is pressed',
  );
  await expect(editor.locator('.metric-picker-chips .bx--tag')).toHaveCount(3);
  await expect(editor.locator('.metric-picker-chips .bx--tag').last()).toHaveText(
    highlightedAfterTyping,
  );
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openPanelSettings(page, 'Metric picker fixture');
  checks.push(
    'Clicking a choice, leaving the pointer over the menu, typing and Enter selects the visible highlight',
  );

  // Data comes first: Y metrics, then the X axis, then the optional title.
  assert.ok(
    (await y.boundingBox()).y < (await x.boundingBox()).y &&
      (await x.boundingBox()).y < (await title.boundingBox()).y,
  );
  const chips = editor.locator('.metric-picker-chips .bx--tag');
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveText(['train/loss']);
  await y.focus();
  await expect(
    page.getByRole('listbox', { name: 'Y metrics', exact: true }).getByRole('option').first(),
  ).toBeVisible();
  assert.ok(
    (await page
      .getByRole('listbox', { name: 'Y metrics', exact: true })
      .getByRole('option')
      .count()) < 100,
    'Large choices must be virtualized',
  );
  await expect(page.getByRole('option', { name: 'train/loss', exact: true })).toHaveCount(0);
  await y.fill('train/reward');
  await y.press('Enter');
  await expect(chips).toHaveText(['train/loss', 'train/reward']);
  await expect(y).toHaveValue('');
  await expect(y).toBeFocused();
  await expect(y).toHaveAttribute('aria-expanded', 'true');
  await y.press('Backspace');
  await expect(chips).toHaveText(['train/loss']);
  await title.focus();
  await expect(y).toHaveAttribute('aria-expanded', 'false');
  await y.focus();
  await expect(y).toHaveAttribute('aria-expanded', 'true');
  checks.push(
    'X precedes Y; chips appear once; selection stays open and Backspace removes only the last metric',
  );
  await y.fill('train/metric599');
  await page.getByRole('option', { name: 'train/metric599', exact: true }).click();
  await expect(chips).toHaveText(['train/loss', 'train/metric599']);
  await y.press('Escape');
  await expect(editor).toBeVisible();
  await expect(y).toHaveAttribute('aria-expanded', 'false');
  checks.push(
    'virtualized choices include metrics beyond the first hundred; Escape closes only the list',
  );
  await y.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor).toBeVisible();
  await y.fill('not-a-metric');
  await expect(
    editor.getByText('No matching metrics', { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await y.press('Escape');
  await editor.getByRole('button', { name: 'Match a regular expression', exact: true }).click();
  const patternInput = editor.getByRole('textbox', {
    name: 'Match a regular expression',
    exact: true,
  });
  await patternInput.fill('(');
  await patternInput.press('Enter');
  await expect(editor).toBeVisible();
  await expect(
    editor.getByText('Enter a valid regular expression.', { exact: true }),
  ).toBeVisible();
  assert.equal((await server.db.call('view', view.id)).body.panels[0].metrics.length, 1);
  await patternInput.fill('^train/metric00[0-2]$');
  await expect(
    editor.getByText('3 matching metrics not yet selected', { exact: true }),
  ).toBeVisible();
  await patternInput.press('Enter');
  await expect(chips).toHaveCount(5);
  await expect(y).toBeFocused();
  await expect(y).toHaveAttribute('aria-expanded', 'false');
  for (const metric of ['train/metric010', 'train/metric011', 'train/metric012']) {
    await y.fill(metric);
    await page.getByRole('option', { name: metric, exact: true }).click();
  }
  await expect(chips).toHaveCount(8);
  await expect(editor.locator('.metric-picker .bx--list-box__menu-icon')).not.toBeVisible();
  await expect(
    editor.getByText('Remove a metric or computed metric to add another.', { exact: true }).first(),
  ).toBeVisible();
  await y.click();
  await y.press('Backspace');
  await expect(chips).toHaveCount(7);
  await expect(editor.locator('.metric-picker .bx--list-box__menu-icon')).toBeVisible();
  await y.fill('train/metric01');
  const metricMenu = page.getByRole('listbox', { name: 'Y metrics', exact: true });
  const menuBounds = await metricMenu.boundingBox();
  const fieldBounds = await y
    .locator('xpath=ancestor::*[contains(@class, "metric-picker-field")]')
    .boundingBox();
  assert.ok(
    menuBounds.y + menuBounds.height <= fieldBounds.y ||
      menuBounds.y >= fieldBounds.y + fieldBounds.height,
    'The metric menu must leave selected chips uncovered',
  );
  await page.getByRole('option', { name: 'train/metric013', exact: true }).hover();
  await y.press('Enter');
  await expect(chips).toHaveCount(8);
  await expect(chips.last()).toHaveText('train/metric013');
  await patternButton.click();
  await patternInput.fill('^train/metric00[0-2]$');
  await expect(
    editor.getByText('All matching metrics are already selected.', { exact: true }),
  ).toBeVisible();
  await patternInput.fill('^train/metric00[0-3]$');
  await expect(
    editor.getByText('1 matching metric not yet selected', { exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole('button', { name: 'Add matching metrics', exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByText('Remove a metric or computed metric to add another.', { exact: true }).first(),
  ).toHaveCount(1);
  await patternButton.click();

  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.panels[0].metrics.length)
    .toBe(8);
  checks.push(
    'regex adds explicit matching keys; the eight-metric limit is enforced while editing and persists',
  );
  await openPanelSettings(page, 'Metric picker fixture');
  await editor
    .getByRole('combobox', { name: 'Panel type', exact: true })
    .selectOption('scatter-history');
  const xMetric = editor.getByRole('combobox', { name: 'X metric', exact: true }),
    yMetric = editor.getByRole('combobox', { name: 'Y metric', exact: true });
  assert.ok((await xMetric.boundingBox()).y < (await yMetric.boundingBox()).y);
  await expect(chips).toHaveCount(2);
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.panels[0].metrics.length)
    .toBe(2);
  checks.push('XY plugins present X first and save exactly two distinct metrics');
  await openPanelSettings(page, 'Metric picker fixture');
  await editor.getByRole('button', { name: 'Remove train/metric599', exact: true }).click();
  await expect(chips).toHaveCount(1);
  await expect(
    editor.getByText('Choose two distinct metrics for scatter', { exact: true }),
  ).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeDisabled();
  await xMetric.fill('train/metric599');
  await page.getByRole('option', { name: 'train/metric599', exact: true }).click();
  await expect(chips).toHaveCount(2);
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeEnabled();
  await editor.getByRole('button', { name: 'Remove train/loss', exact: true }).click();
  await expect(
    editor.getByText('Choose two distinct metrics for scatter', { exact: true }),
  ).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeDisabled();
  await yMetric.click();
  await page
    .getByRole('listbox', { name: 'Y metric', exact: true })
    .getByRole('option')
    .nth(2)
    .hover();
  await page.keyboard.type('metric008');
  await expect(yMetric).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Enter');
  await expect(editor.locator('.metric-picker-chips .bx--tag')).toContainText([
    'train/metric599',
    'train/metric008',
  ]);
  await editor.getByRole('combobox', { name: 'Panel type', exact: true }).selectOption('line');
  for (const metric of [
    'train/metric021',
    'train/metric022',
    'train/metric023',
    'train/metric024',
  ]) {
    await y.fill(metric);
    await page.getByRole('option', { name: metric, exact: true }).click();
  }
  await y.press('Escape');
  await expect(y).toHaveAttribute('aria-expanded', 'false');

  for (const viewport of [
    { width: 1440, height: 600 },
    { width: 1280, height: 560 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () =>
        editor.evaluate((node) => {
          const layout = node.querySelector('.panel-editor-layout');
          const categories = node.querySelector('.editor-categories');
          return categories.classList.contains('compact-categories') === layout.clientWidth < 600;
        }),
      )
      .toBe(true);
    const dataCategory = editor.getByRole('combobox', { name: 'Panel settings', exact: true });
    await expect
      .poll(
        async () =>
          (await dataCategory.isVisible()) ||
          (await editor.getByRole('tab', { name: 'Data', exact: true }).isVisible()),
      )
      .toBe(true);
    if (await dataCategory.isVisible()) {
      await dataCategory.focus();
      await dataCategory.selectOption({ label: 'Data' });
    } else await editor.getByRole('tab', { name: 'Data', exact: true }).click();
    const metricInput = editor.getByRole('combobox', { name: 'Y metrics', exact: true });
    await metricInput.focus();
    await metricInput.fill('metric');
    const optionsBox = page.getByRole('listbox', { name: 'Y metrics', exact: true });
    await expect(optionsBox).toBeVisible();
    const menuBox = await optionsBox.boundingBox(),
      saveBox = await editor.getByRole('button', { name: 'Save panel', exact: true }).boundingBox();
    assert.ok(
      menuBox.y >= 0 && menuBox.y + menuBox.height <= Math.min(viewport.height, saveBox.y),
      'Metric choices fit above the footer and inside the viewport',
    );
    for (const close of await editor.locator('.metric-picker-chips .bx--tag__close-icon').all()) {
      await close.scrollIntoViewIfNeeded();
      assert.ok(
        await close.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
        'Every metric removal button remains reachable while suggestions are open',
      );
    }
    await metricInput.press('Escape');
    const category = editor.getByRole('combobox', { name: 'Panel settings', exact: true });
    await expect
      .poll(
        async () =>
          (await category.isVisible()) ||
          (await editor.getByRole('tab', { name: 'Display', exact: true }).isVisible()),
      )
      .toBe(true);
    if (await category.isVisible()) {
      await category.focus();
      await category.selectOption({ label: 'Display' });
    } else await editor.getByRole('tab', { name: 'Display', exact: true }).click();
    const lastSetting = editor.getByRole('checkbox', {
      name: 'Show highlighted runs only',
      exact: true,
    });
    await lastSetting.focus();
    await lastSetting.press('Space');
    await expect(lastSetting).toBeChecked();
    const settingBox = await lastSetting.locator('..').boundingBox(),
      footerBox = await editor
        .getByRole('button', { name: 'Save panel', exact: true })
        .boundingBox();
    assert.ok(
      settingBox.y + settingBox.height <= footerBox.y,
      'The final display setting must scroll fully above the footer: ' +
        JSON.stringify({
          viewport,
          settingBox,
          footerBox,
          layout: await editor.locator('.panel-editor-layout').boundingBox(),
          content: await editor.locator('.bx--modal-content').boundingBox(),
          field: await editor.locator('.panel-editor-fields').boundingBox(),
        }),
    );
    await lastSetting.press('Space');
    await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeVisible();
    const bounds = await editor
      .getByRole('button', { name: 'Save panel', exact: true })
      .boundingBox();
    assert.ok(bounds.y + bounds.height <= viewport.height);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await server.db.call('view', view.id)).body.panels[0].plugin, 'scatter-history');
  checks.push('narrow layouts keep save/cancel reachable; cancel preserves the saved panel');
  await openPanelSettings(page, 'Metric picker fixture');
  const beforeComposition = (await server.db.call('view', view.id)).version;
  async function compositionCycle(field, key) {
    await field.focus();
    const prevented = await field.evaluate((node, key) => {
      const down = new KeyboardEvent('keydown', {
        key,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(down);
      node.dispatchEvent(new CompositionEvent('compositionend', { data: '測定', bubbles: true }));
      node.dispatchEvent(
        new KeyboardEvent('keyup', { key, isComposing: false, bubbles: true, cancelable: true }),
      );
      return down.defaultPrevented;
    }, key);
    assert.equal(prevented, false, 'Composition keeps native key behavior');
    await expect(editor).toBeVisible();
    assert.equal((await server.db.call('view', view.id)).version, beforeComposition);
    await expect(page.locator('.panel-editor-modal')).toHaveClass(/is-visible/);
  }
  for (const key of ['Enter', 'Escape']) await compositionCycle(title, key);
  await editor.getByRole('combobox', { name: 'Panel type', exact: true }).selectOption('line');
  await patternButton.click();
  await patternInput.fill('^train/metric00[0-2]$');
  for (const key of ['Enter', 'Escape']) {
    await compositionCycle(patternInput, key);
    await expect(chips).toHaveCount(2);
    await expect(patternInput).toHaveValue('^train/metric00[0-2]$');
  }
  await patternInput.press('Enter');
  await expect(chips).toHaveCount(5);
  await expect(patternInput).not.toBeVisible();
  assert.equal((await server.db.call('view', view.id)).version, beforeComposition);
  checks.push(
    'Title and regex composition ending before keyup cannot submit, discard, or reopen the editor',
  );
  await title.fill('Saved with Enter');
  await title.press('Enter');
  await expect(editor).not.toBeVisible();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.panels[0].title)
    .toBe('Saved with Enter');
  await expect(editor).not.toBeVisible();
  checks.push(
    'Enter adds valid regex matches without saving; Title Enter saves once and stays closed',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [label, setting] of [
    ['Maximum runs', 'maxRuns'],
    ['Line width', 'lineWidth'],
    ['Maximum entries', 'tooltipLimit'],
  ]) {
    await openPanelSettings(page, 'Saved with Enter');
    if (setting !== 'maxRuns')
      await editor.getByRole('tab', { name: 'Display', exact: true }).click();
    else {
      const mode = editor.getByRole('combobox', { name: 'Runs shown', exact: true });
      await expect(mode).toHaveValue('all');
      await mode.selectOption('limit');
    }
    const numberInput = editor.getByRole('spinbutton', { name: label, exact: true });
    await numberInput.fill('7');
    await numberInput.press('Enter');
    await expect(editor).not.toBeVisible();
    await expect
      .poll(async () => (await server.db.call('view', view.id)).body.panels[0].settings[setting])
      .toBe(7);
  }
  checks.push(
    'Enter commits slider number drafts before saving Maximum runs, Line width and Maximum entries',
  );
  for (const choiceCase of [
    {
      label: 'X axis',
      tab: 'Data',
      query: 'wall',
      value: '_relative_wall',
      text: 'Wall elapsed (seconds)',
      key: 'xAxis',
    },
    {
      label: 'X axis',
      tab: 'Data',
      query: 'wall',
      hover: 'Wall time',
      value: '_timestamp',
      text: 'Wall time',
      key: 'xAxis',
    },
    {
      label: 'Group runs',
      tab: 'Grouping',
      query: 'one group',
      value: 'all',
      text: 'All runs as one group',
      key: 'groupBy',
    },
    {
      label: 'Legend labels',
      tab: 'Display',
      query: 'ID',
      value: '{id}',
      text: 'Run ID',
      key: 'legendTemplate',
    },
  ]) {
    await openPanelSettings(page, 'Saved with Enter');
    if (choiceCase.tab !== 'Data')
      await editor.getByRole('tab', { name: choiceCase.tab, exact: true }).click();
    const choice = editor.getByRole('combobox', { name: choiceCase.label, exact: true });
    await choice.click();
    await choice.fill('');
    const menu = page.getByRole('listbox', { name: choiceCase.label, exact: true });
    await menu
      .getByRole('option')
      .nth(Math.min(2, (await menu.getByRole('option').count()) - 1))
      .hover();
    await choice.fill(choiceCase.query);
    await expect(choice).toHaveAttribute('aria-activedescendant', /.+/);
    if (choiceCase.hover)
      await menu.getByRole('option', { name: choiceCase.hover, exact: true }).hover();
    await choice.press('Enter');
    await expect(choice).toHaveValue(choiceCase.text);
    await expect(choice).toHaveAttribute('aria-expanded', 'false');
    await choice.click();
    await choice.fill('no-such-choice');
    await choice.press('Escape');
    await expect(choice).toHaveValue(choiceCase.text);
    await expect(editor).toBeVisible();
    await choice.press('Escape');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(choice).toHaveValue(choiceCase.text);
    await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
    await expect
      .poll(
        async () => (await server.db.call('view', view.id)).body.panels[0].settings[choiceCase.key],
      )
      .toBe(choiceCase.value);
  }
  checks.push(
    'X axis, grouping and legend choices persist typed/hovered selections and preserve them through Escape',
  );
  const beforeRepeat = (await server.db.call('view', view.id)).version;
  await openPanelSettings(page, 'Saved with Enter');
  await title.fill('Enter repeat fixture');
  await page.keyboard.down('Enter');
  await expect(editor).not.toBeVisible();
  await expect(panelSettings(page, 'Enter repeat fixture')).toBeFocused();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect(editor).not.toBeVisible();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).version)
    .toBe(beforeRepeat + 1);
  await panelSettings(page, 'Enter repeat fixture').focus();
  await page.keyboard.down('Enter');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('tab', { name: 'Data', exact: true })).toBeFocused();
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect(editor).toBeVisible();
  assert.equal((await server.db.call('view', view.id)).version, beforeRepeat + 1);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  checks.push('Held Enter performs one save or one open, without repeating across restored focus');
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    const touchContext = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', (error) => errors.push(error.message));
    await touchPage.goto(base + '/test/metrics/workspace?view=' + view.id);
    await panelSettings(touchPage, 'Enter repeat fixture').tap();
    const touchEditor = touchPage.getByRole('dialog', { name: 'Panel settings', exact: true });
    const touchInput = touchEditor.getByRole('combobox', { name: 'Y metrics', exact: true });
    const touchChips = touchEditor.locator('.metric-picker-chips .bx--tag');
    for (const metric of ['train/metric010', 'train/metric011']) {
      await touchInput.fill(metric);
      await touchPage.getByRole('option', { name: metric, exact: true }).tap();
      await expect(touchInput).toBeFocused();
      await expect
        .poll(async () =>
          touchInput.evaluate((node) => {
            const input = node.getBoundingClientRect();
            const modal = node.closest('.panel-editor-modal');
            const clip = modal.querySelector('.bx--modal-content').getBoundingClientRect();
            const footer = modal.querySelector('.bx--modal-footer').getBoundingClientRect();
            return (
              input.top >= clip.top &&
              input.bottom <= footer.top &&
              document.elementFromPoint(input.x + input.width / 2, input.y + input.height / 2) ===
                node
            );
          }),
        )
        .toBe(true);
    }
    await expect(touchChips).toHaveCount(7);
    const touchField = touchEditor.locator('.metric-picker-field');
    const touchScroller = touchEditor.locator('.bx--modal-content');
    const fieldBeforeScroll = await touchField.boundingBox();
    const clipBeforeScroll = await touchScroller.boundingBox();
    const startX = fieldBeforeScroll.x + 8;
    const startY = Math.max(fieldBeforeScroll.y + 40, clipBeforeScroll.y + 40);
    const scrollBeforeWheel = await touchScroller.evaluate((node) => node.scrollTop);
    await touchPage.mouse.move(startX, startY);
    await touchPage.mouse.wheel(0, 20);
    await expect
      .poll(async () => touchScroller.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(scrollBeforeWheel);
    const geometryOutsideField = () =>
      touchInput.evaluate((node) => {
        const field = node.closest('.metric-picker-field').getBoundingClientRect();
        const menu = node
          .closest('.metric-picker-field')
          .querySelector('[role=listbox]')
          .getBoundingClientRect();
        return menu.bottom <= field.top || menu.top >= field.bottom;
      });
    await expect.poll(geometryOutsideField).toBe(true);
    const scrollBeforeSwipe = await touchScroller.evaluate((node) => node.scrollTop);
    const session = await touchContext.newCDPSession(touchPage);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y: startY }],
    });
    for (let step = 1; step <= 6; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX, y: startY - step * 5 }],
      });
      await touchPage.waitForTimeout(25);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
    await expect
      .poll(async () => touchScroller.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(scrollBeforeSwipe);
    await expect.poll(geometryOutsideField).toBe(true);
    await touchInput.fill('metric250');
    const touchMenu = touchPage.getByRole('listbox', { name: 'Y metrics', exact: true });
    await expect(touchMenu.getByRole('option')).toHaveCount(1);
    await expect
      .poll(async () =>
        touchInput.evaluate((node) => {
          const field = node.closest('.metric-picker-field').getBoundingClientRect();
          const menu = node
            .closest('.metric-picker-field')
            .querySelector('[role=listbox]')
            .getBoundingClientRect();
          return menu.bottom <= field.top || menu.top >= field.bottom;
        }),
      )
      .toBe(true);
    await touchMenu.getByRole('option', { name: 'train/metric250', exact: true }).tap();
    await expect(touchChips).toHaveCount(8);
    await touchEditor.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await touchContext.close();
  }
  assert.equal((await server.db.call('view', view.id)).body.panels[0].metrics.length, 5);
  checks.push(
    'Touch chip wrapping keeps the focused input above the footer; filtering preserves full-field menu anchoring',
  );
  for (const width of [320, 390]) {
    for (const key of ['Enter', 'Space']) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const touchPage = await context.newPage();
      touchPage.on('pageerror', (error) => errors.push(error.message));
      const before = (await server.db.call('view', view.id)).version;
      await touchPage.goto(base + '/test/metrics/workspace?view=' + view.id);
      await panelSettings(touchPage, 'Enter repeat fixture').tap();
      const touchEditor = touchPage.getByRole('dialog', { name: 'Panel settings', exact: true });
      const touchTitle = touchEditor.getByRole('textbox', { name: 'Title', exact: true });
      await touchTitle.fill('Keep touch draft');
      await touchTitle.press('Escape');
      const keep = touchPage
        .getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })
        .getByRole('button', { name: 'Keep editing', exact: true });
      const box = await keep.boundingBox();
      await touchPage.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await touchPage.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(
        touchEditor.getByRole('combobox', { name: 'Panel settings', exact: true }),
      ).toBeFocused();
      await touchPage.keyboard.press(key);
      await expect(touchEditor).toBeVisible();
      await expect(touchTitle).toHaveValue('Keep touch draft');
      assert.equal((await server.db.call('view', view.id)).version, before);
      await context.close();
    }
  }
  checks.push(
    'Double taps keep focus in the editor category; subsequent Enter or Space cannot discard or save the draft',
  );
  for (const [width, height, touch] of [
    [1440, 900, false],
    [390, 844, true],
    [768, 1024, true],
  ]) {
    for (const changed of [false, true]) {
      for (const keepFirst of [false, true]) {
        const sections = [0, 1, 2].map((i) => ({ id: 's' + i, name: 'Section ' + i }));
        const dismissalView = await server.tools.execute('view_create', {
          project: 'test/metrics',
          name: `Dismissal ${width} ${changed} ${keepFirst}`,
          body: {
            generation: 'manual',
            visible: [run.id],
            solo: [],
            sections,
            panels: Array.from({ length: 9 }, (_, i) => ({
              id: 'dismiss' + i,
              plugin: 'line',
              metric: 'train/loss',
              title: 'Dismissal panel ' + i,
              section: 's' + Math.floor(i / 3),
            })),
            sectionLayouts: Object.fromEntries(
              sections.map((section) => [section.id, { width: 360, height: 220, rows: 1 }]),
            ),
          },
        });
        const context = await browser.newContext({
          viewport: { width, height },
          hasTouch: touch,
          isMobile: touch,
        });
        const dismissalPage = await context.newPage();
        dismissalPage.on('pageerror', (error) => errors.push(error.message));
        await dismissalPage.goto(base + '/test/metrics/workspace?view=' + dismissalView.id);
        const opener = panelSettings(dismissalPage, 'Dismissal panel 0');
        if (touch) await opener.tap();
        else await openPanelSettings(dismissalPage, 'Dismissal panel 0');
        const dialog = dismissalPage.getByRole('dialog', { name: 'Panel settings', exact: true });
        const input = dialog.getByRole('textbox', { name: 'Title', exact: true });
        if (changed || keepFirst) await input.fill('Unsaved dismissal draft');
        if (keepFirst) {
          await input.press('Escape');
          const keep = dismissalPage.getByRole('button', { name: 'Keep editing', exact: true });
          if (touch) await keep.tap();
          else await keep.click();
          await dismissalPage.waitForTimeout(700);
        }
        const before = (await server.db.call('view', dismissalView.id)).version;
        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
        if (touch) {
          const box = await cancel.boundingBox();
          const cx = box.x + box.width / 2,
            cy = box.y + box.height / 2;
          await dismissalPage.touchscreen.tap(cx, cy);
          await dismissalPage.waitForTimeout(100);
          await dismissalPage.touchscreen.tap(cx, cy);
        } else await cancel.dblclick();
        await expect(dialog).not.toBeVisible();
        await expect(opener).toBeFocused();
        await dismissalPage.waitForTimeout(300);
        const stored = await server.db.call('view', dismissalView.id);
        assert.equal(stored.version, before, `Cancel continuation changed workspace at ${width}px`);
        assert.equal(stored.body.panels[0].title, 'Dismissal panel 0');
        assert.ok(stored.body.sections.every((section) => !section.collapsed));
        const next = panelSettings(dismissalPage, 'Dismissal panel 3');
        if (touch) await next.tap();
        else await openPanelSettings(dismissalPage, 'Dismissal panel 3');
        await expect(dialog).toBeVisible();
        await expect(input).toHaveValue('Dismissal panel 3');
        const close = dialog.getByRole('button', { name: 'Close', exact: true });
        if (touch) {
          const box = await close.boundingBox();
          await dismissalPage.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          await dismissalPage.waitForTimeout(100);
          await dismissalPage.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        } else await close.dblclick();
        await expect(dismissalPage.locator('[role="dialog"]:visible')).toHaveCount(0);
        await expect(next).toBeFocused();
        assert.equal((await server.db.call('view', dismissalView.id)).version, before);
        await context.close();
      }
    }
  }
  checks.push(
    'Repeated Cancel activation closes once, preserves workspace sections and view version, and allows the next independent action',
  );
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
  ]) {
    for (const gesture of ['offset', 'four-fast', 'four-separated']) {
      const sections = [0, 1, 2].map((i) => ({ id: 's' + i, name: 'Section ' + i }));
      const dismissalView = await server.tools.execute('view_create', {
        project: 'test/metrics',
        name: `Painted dismissal ${width} ${gesture}`,
        body: {
          generation: 'manual',
          visible: [run.id],
          solo: [],
          sections,
          panels: Array.from({ length: 9 }, (_, i) => ({
            id: 'paint' + i,
            plugin: 'line',
            metric: 'train/loss',
            title: 'Panel ' + i,
            section: 's' + Math.floor(i / 3),
          })),
          sectionLayouts: Object.fromEntries(
            sections.map((section) => [section.id, { width: 360, height: 220, rows: 1 }]),
          ),
        },
      });
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: true,
        isMobile: true,
      });
      await context.addInitScript(() => {
        window.dismissalClicks = [];
        // Clicks that reach the page after the editor's capture-phase guards.
        window.reachedClicks = [];
        window.addEventListener('click', (event) => window.reachedClicks.push(event.detail));
        window.addEventListener(
          'click',
          (event) => {
            const modal = document.querySelector('.panel-editor-modal');
            window.dismissalClicks.push({
              detail: event.detail,
              painted: !!modal && getComputedStyle(modal).visibility !== 'hidden',
              target:
                event.target
                  .closest?.('.section-title')
                  ?.querySelector('span')
                  ?.textContent.trim() ||
                event.target.closest?.('button')?.textContent.trim() ||
                event.target.tagName,
            });
          },
          true,
        );
      });
      const touchPage = await context.newPage();
      touchPage.on('pageerror', (error) => errors.push(error.message));
      await touchPage.goto(base + '/test/metrics/workspace?view=' + dismissalView.id);
      await panelSettings(touchPage, 'Panel 0').tap();
      const dialog = touchPage.getByRole('dialog', { name: 'Panel settings', exact: true });
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      await expect(cancel).toBeVisible();
      await touchPage.waitForTimeout(400);
      const box = await cancel.boundingBox(),
        cx = box.x + box.width / 2,
        cy = box.y + box.height / 2;
      const before = (await server.db.call('view', dismissalView.id)).version;
      await touchPage.evaluate(() => {
        window.dismissalClicks = [];
        window.reachedClicks = [];
      });
      await touchPage.touchscreen.tap(cx, cy);
      const count = gesture === 'offset' ? 2 : 4;
      for (let press = 1; press < count; press++) {
        await touchPage.waitForTimeout(
          gesture === 'four-separated' ? 150 : gesture === 'four-fast' ? 90 : 100,
        );
        await touchPage.touchscreen.tap(
          cx + (gesture === 'offset' ? (width === 768 ? -24 : 24) : 0),
          cy,
        );
      }
      await expect(dialog).not.toBeVisible();
      await expect(touchPage.locator('.panel-editor-closing-shield')).not.toBeVisible();
      const clicks = await touchPage.evaluate(() => window.dismissalClicks),
        reached = await touchPage.evaluate(() => window.reachedClicks);
      const independent = clicks
        .slice(1)
        .filter((click) => !click.painted && click.detail === 1);
      await touchPage.waitForTimeout(350);
      const stored = await server.db.call('view', dismissalView.id);
      // Presses that pass the closed editor reach whatever lies under Cancel (a section title
      // or a section's row-resize handle, depending on layout); neither changes the view.
      assert.equal(stored.version, before, JSON.stringify({ width, gesture, clicks }));
      assert.equal(!!stored.body.sections[2].collapsed, false);
      if (gesture === 'offset')
        assert.equal(independent.length, 0, 'A painted Cancel button retains its input shield');
      // Of four taps 150 ms apart, the second continues the Cancel sequence while the editor
      // closes and never produces a click. Later taps reach what lies under Cancel. A press
      // that continues the Cancel sequence (detail > 1) is stopped; a fresh press (detail 1)
      // acts normally. Whether the fourth tap is fresh depends on that control: a section
      // title continues counting, a resize handle restarts it.
      if (gesture === 'four-separated') {
        assert.equal(clicks.length, count - 1, JSON.stringify({ width, clicks }));
        assert.ok(clicks.slice(1).every((click) => !click.painted), JSON.stringify(clicks));
        // The Cancel press reaches its button; afterwards only fresh presses get through.
        assert.ok(
          independent.length >= 1 && reached.slice(1).length >= 1 && reached.slice(1).every((detail) => detail === 1),
          'A fresh detail1 press after the dialog disappears acts normally: ' +
            JSON.stringify({ width, clicks, reached }),
        );
      }
      if (gesture === 'offset') {
        const opener = panelSettings(touchPage, 'Panel 0');
        const nextTitle = panelSettings(touchPage, 'Panel 3');
        await opener.tap();
        await touchPage.waitForTimeout(350);
        const target = await nextTitle.boundingBox();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).tap();
        await touchPage.waitForTimeout(120);
        const shield = touchPage.locator('.panel-editor-closing-shield');
        await expect(shield).toBeVisible();
        const cdp = await context.newCDPSession(touchPage);
        const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await expect(shield).not.toBeVisible();
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: point.x + 2, y: point.y + 2 }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
        await touchPage.waitForTimeout(100);
        await expect(touchPage.locator('[role="dialog"]:visible')).toHaveCount(0);
        assert.equal((await server.db.call('view', dismissalView.id)).version, before);
        await touchPage.waitForTimeout(800);
        await nextTitle.tap();
        await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
          'Panel 3',
        );
        await dialog
          .getByRole('textbox', { name: 'Title', exact: true })
          .fill('Discard transition draft');
        await touchPage.keyboard.press('Escape');
        const prompt = touchPage.getByRole('dialog', {
          name: 'Discard unsaved changes?',
          exact: true,
        });
        await expect(prompt).toBeVisible();
        await prompt.evaluate((node) => {
          const modal = node.closest('.panel-editor-modal');
          window.discardFrames = [];
          const sample = () => {
            const style = getComputedStyle(modal);
            if (style.visibility === 'hidden') return;
            window.discardFrames.push({
              heading: modal.querySelector('.bx--modal-header__heading').textContent.trim(),
              footer: [...modal.querySelectorAll('.bx--modal-footer button')].map((button) =>
                button.textContent.trim(),
              ),
              danger: modal.classList.contains('bx--modal--danger'),
            });
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await prompt.getByRole('button', { name: 'Discard changes', exact: true }).tap();
        await expect(touchPage.locator('.panel-editor-modal')).not.toBeVisible();
        const frames = await touchPage.evaluate(() => window.discardFrames);
        assert.ok(frames.length > 1);
        assert.ok(
          frames.every(
            (frame) =>
              frame.heading === 'Discard unsaved changes?' &&
              frame.danger &&
              JSON.stringify(frame.footer) === JSON.stringify(['Keep editing', 'Discard changes']),
          ),
          JSON.stringify(frames),
        );
        await expect(nextTitle).toBeFocused();
        assert.equal((await server.db.call('view', dismissalView.id)).version, before);
      }
      await touchPage.waitForTimeout(800);
      const section = touchPage
        .getByRole('region', { name: 'Section 2', exact: true })
        .locator('.section-toggle');
      const expanded = await section.getAttribute('aria-expanded');
      await section.tap();
      await expect(section).toHaveAttribute(
        'aria-expanded',
        expanded === 'true' ? 'false' : 'true',
      );
      await context.close();
      if (width === 768 && gesture === 'offset') {
        const mouseContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const focusPage = await mouseContext.newPage();
        focusPage.on('pageerror', (error) => errors.push(error.message));
        await focusPage.goto(base + '/test/metrics/workspace?view=' + dismissalView.id);
        const next = panelSettings(focusPage, 'Panel 3');
        await openPanelSettings(focusPage, 'Panel 0');
        const focusDialog = focusPage.getByRole('dialog', { name: 'Panel settings', exact: true });
        await focusPage.waitForTimeout(350);
        const nextBox = await next.boundingBox();
        await focusDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await focusPage.mouse.move(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
        await focusPage.mouse.down();
        await expect(focusPage.locator('.panel-editor-closing-shield')).not.toBeVisible();
        await focusPage.mouse.up();
        await expect(focusPage.locator('[role="dialog"]:visible')).toHaveCount(0);
        await openPanelSettings(focusPage, 'Panel 3');
        await expect(focusDialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
          'Panel 3',
        );
        await focusPage.keyboard.press('Escape');
        await expect(focusDialog).not.toBeVisible();
        await expect(next).toBeFocused();
        await mouseContext.close();
      }
    }
  }
  checks.push(
    'Closing paint retains input through held mouse/touch release; fresh presses work, and Discard labels stay consistent during the fade',
  );
  const beforeDrawerComposition = (await server.db.call('view', view.id)).version;
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await drawer.getByRole('tab', { name: 'Panel list', exact: true }).click();
  const hidePattern = drawer.getByRole('textbox', { name: 'Hide panels matching', exact: true });
  await hidePattern.fill('draft-pattern');
  for (const key of [
    { key: 'Enter', isComposing: true, keyCode: 13 },
    { key: 'Escape', isComposing: true, keyCode: 27 },
    { key: 'Escape', isComposing: false, keyCode: 229 },
  ]) {
    assert.equal(
      await hidePattern.evaluate((node, key) => {
        const down = new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true });
        node.dispatchEvent(down);
        node.dispatchEvent(new CompositionEvent('compositionend', { data: '測定', bubbles: true }));
        node.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: key.key,
            isComposing: false,
            bubbles: true,
            cancelable: true,
          }),
        );
        return down.defaultPrevented;
      }, key),
      false,
    );
    await expect(drawer).toBeVisible();
    await expect(hidePattern).toHaveValue('draft-pattern');
    assert.equal((await server.db.call('view', view.id)).version, beforeDrawerComposition);
  }
  await hidePattern.press('Escape');
  await expect(drawer).not.toBeVisible();
  assert.equal((await server.db.call('view', view.id)).version, beforeDrawerComposition);
  checks.push(
    'Settings drawer preserves a composing draft through Enter/Escape and closes on ordinary Escape',
  );
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const settingsDrawer = page.locator('.side-drawer');
  await settingsDrawer.getByRole('tab', { name: 'Axes', exact: true }).click();
  const workspaceAxis = settingsDrawer.getByRole('combobox', { name: 'X axis', exact: true });
  await workspaceAxis.fill('wall');
  await workspaceAxis.press('Enter');
  await expect(workspaceAxis).toHaveValue('Wall elapsed (seconds)');
  await settingsDrawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.plotSettings?.xAxis)
    .toBe('_relative_wall');
  checks.push('The workspace settings consumer stores a typed axis choice');
  await expect(settingsDrawer).not.toBeVisible();
  await pressSectionButton(page, 'Metrics section settings');
  await settingsDrawer.getByRole('tab', { name: 'Axes', exact: true }).click();
  const sectionAxis = settingsDrawer.getByRole('combobox', { name: 'X axis', exact: true });
  await sectionAxis.fill('metric250');
  await sectionAxis.press('Enter');
  await expect(sectionAxis).toHaveValue('train/metric250');
  await settingsDrawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.sectionSettings?.s0?.xAxis)
    .toBe('train/metric250');
  checks.push('The section settings consumer stores a typed axis choice');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  console.error({ checks });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
