import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect } from '@playwright/test';
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

// Configures a computed metric, a stacked area and a percent area through the panel editor and checks
// the rendered series against per-record values. Uses built frontend assets.
// npm run build && PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:transforms
const expect = playwrightExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-transform-browser-'));
let server, browser;
try {
  server = await createServer(directory);
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'transforms',
    name: 'composition',
    displayName: 'Composition run',
  });
  // Components are logged in the same records; ratio inputs share records except step 3.
  const records = [
    {
      _step: 0,
      iteration: 10,
      'cost/a': 1,
      'cost/b': 3,
      hits: 1,
      total: 4,
      'extra/one': 1,
      'extra/two': 2,
      'rollout/truncated_episodes': 1,
      'unreferenceable}name': 1,
      ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['metric/' + i, i])),
    },
    { _step: 1, iteration: 20, 'cost/a': 2, 'cost/b': 2, hits: 3, total: 6 },
    { _step: 2, iteration: 30, 'cost/a': 3, 'cost/b': 1, hits: 2, total: 8 },
    { _step: 3, iteration: 40, 'cost/a': 4, 'cost/b': 4, hits: 5 },
  ];
  await server.db.call('ingest', run.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content: records.map((r) => JSON.stringify(r)) } },
    complete: true,
  });
  const view = await server.tools.execute('view_create', {
    project: 'test/transforms',
    name: 'Transforms',
    body: {
      generation: 'manual',
      panels: [
        { id: 'ratio', plugin: 'line', metric: 'hits', metrics: ['hits'], title: 'Ratio fixture' },
        {
          id: 'stack',
          plugin: 'line',
          metric: 'cost/a',
          metrics: ['cost/a'],
          title: 'Stack fixture',
        },
      ],
      visible: [run.id],
      solo: [],
      plotSettings: { xAxis: 'iteration' },
    },
  });
  const base = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' }),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/test/transforms/workspace?view=' + view.id);
  const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  async function pick(label, metric) {
    const field = editor.getByRole('combobox', { name: label, exact: true });
    await field.fill(metric);
    await page.getByRole('option', { name: metric, exact: true }).click();
  }
  async function series(id) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    return page.evaluate(async (id) => {
      const engineURL = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => /\/assets\/engine-[^/]+\.js(?:\?|$)/.test(name));
      const module = await import(engineURL);
      const echarts = Object.values(module).find(
        (value) => value && typeof value.getInstanceByDom === 'function',
      );
      const panel = document.querySelector(`[data-panel-id="${CSS.escape(id)}"]`);
      const host = [...panel.querySelectorAll('[_echarts_instance_]')].find((element) =>
        echarts.getInstanceByDom(element),
      );
      const option = echarts.getInstanceByDom(host).getOption();
      return {
        series: option.series.map((item) => ({
          name: item.name,
          stack: item.stack,
          color: item.itemStyle?.color,
          data: item.data,
        })),
        yMax: option.yAxis[0].max,
      };
    }, id);
  }

  // Computed metric: hits / total within each record; the record without a denominator is
  // omitted. The expression is built with ${ autocomplete; unsafe input is refused.
  await openPanelSettings(page, 'Ratio fixture');
  const metricChoice = editor.getByRole('combobox', { name: 'Y metrics', exact: true });
  await metricChoice.fill('trun ep');
  await expect(
    page.getByRole('option', { name: 'rollout/truncated_episodes', exact: true }),
  ).toBeVisible();
  await expect(
    editor.locator('.metric-picker').getByText('No matching metrics', { exact: true }),
  ).toHaveCount(0);
  await metricChoice.press('Escape');
  await editor.getByRole('button', { name: 'Add computed metric', exact: true }).click();
  const names = editor.getByRole('textbox', { name: 'Name', exact: true }),
    expressions = editor.getByRole('combobox', { name: 'Expression', exact: true });
  await expect(expressions.first()).toBeFocused();
  await expressions.first().press('Tab');
  await expect(editor.getByRole('button', { name: 'Insert metric', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(names.first()).toBeFocused();
  await names.first().fill('Hit rate');
  const expression = expressions.first();
  await expression.click();
  await expression.press('Control+Space');
  await expect(expression).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.locator('.expression-options [role=option]')).toHaveCount(50);
  await expression.press('PageDown');
  await expect(expression).toHaveAttribute(
    'aria-activedescendant',
    (await expression.getAttribute('id')) + '-option-8',
  );
  await expression.press('PageUp');
  await expression.press('Enter');
  await expect(expression).toHaveValue(/^\$\{.+\}$/);
  await expression.fill('${hits}' + ' '.repeat(993));
  await expect(editor.locator('.expression-mirror').first()).toHaveText(
    '${hits}' + ' '.repeat(993),
    { useInnerText: false },
  );
  await expression.evaluate((input) => {
    const data = new DataTransfer();
    data.setData('text/plain', '${hits}\n/ ${total}');
    input.select();
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(expression).toHaveValue('${hits} / ${total}');
  await expression.fill('Math.lo');
  await expect(page.getByRole('option', { name: 'Math.log(x)', exact: true })).toBeVisible();
  await expression.press('Enter');
  await expect(expression).toHaveValue('Math.log()');
  assert.equal(await expression.evaluate((input) => input.selectionStart), 9);
  await expression.fill('${trun ep');
  await expect(editor.locator('.expression-options [role=option]').first()).toHaveText(
    'rollout/truncated_episodes',
  );
  await expression.press('Enter');
  await expect(expression).toHaveValue('${rollout/truncated_episodes}');
  await expression.fill('${unreferenceable');
  await expect(editor.locator('.expression-options [role=option]')).toHaveCount(0);
  await expression.fill('');
  await expression.dispatchEvent('compositionstart');
  await expression.fill('${測');
  await expression.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  await expect(expression).toHaveValue('${測');
  await expect(expression).toHaveAttribute('aria-expanded', 'false');
  await expect(editor).toBeVisible();
  await expression.dispatchEvent('compositionend', { data: '測' });
  await expression.fill('');
  await expression.pressSequentially('${hi');
  await expect(expression).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('option', { name: 'hits', exact: true })).toBeVisible();
  await expression.press('Enter');
  await expect(expression).toHaveValue('${hits}');
  // Escape closes only the suggestions, not the dialog.
  await expression.pressSequentially(' / ${');
  await expect(expression).toHaveAttribute('aria-expanded', 'true');
  await expression.press('Escape');
  await expect(expression).toHaveAttribute('aria-expanded', 'false');
  await expect(editor).toBeVisible();
  await expression.pressSequentially('TOT');
  await expect(expression).toHaveAttribute(
    'aria-activedescendant',
    (await expression.getAttribute('id')) + '-option-0',
  );
  await expression.press('Tab');
  await expect(expression).toHaveValue('${hits} / ${total}');
  await expect(expression).toBeFocused();
  await expect(expression).toHaveAttribute('aria-expanded', 'false');
  // Wrapping and highlighting remain aligned at desktop and phone widths.
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expression.fill('${rollout/truncated_episodes} / ${rollout/truncated_episodes}');
    await expect
      .poll(() =>
        expression.evaluate((input) => {
          const mirror = input.parentElement.querySelector('.expression-mirror');
          return {
            same: mirror.textContent === input.value,
            height: Math.abs(
              mirror.getBoundingClientRect().height - input.getBoundingClientRect().height,
            ),
          };
        }),
      )
      .toEqual({ same: true, height: 0 });
  }
  await expression.fill('${' + 'x'.repeat(997) + '}');
  await expect
    .poll(() =>
      expression.evaluate((input) => {
        const mirror = input.parentElement.querySelector('.expression-mirror');
        return Math.abs(mirror.getBoundingClientRect().width - input.clientWidth);
      }),
    )
    .toBeLessThanOrEqual(1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await expression.fill('${hits} / ${total}');
  // A second, unsafe expression blocks saving until it is removed.
  await editor.getByRole('button', { name: 'Add computed metric', exact: true }).click();
  await expressions.nth(1).fill('${hits} /');
  await expect(expressions.nth(1)).not.toHaveAttribute('aria-invalid', 'true');
  await names.nth(1).fill('Unsafe');
  await expect(expressions.nth(1)).toHaveAttribute('aria-invalid', 'true');
  await expect(editor.getByText('The expression ends too early.', { exact: false })).toBeVisible();
  await expressions.nth(1).fill('${hits} ) 2');
  await expect(editor.locator('.expression-mirror .is-error')).toHaveText(')');
  await expressions.nth(1).fill('${nope}');
  await expect(
    editor.getByText('Not logged by the compared runs: nope.', { exact: true }),
  ).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeEnabled();
  await expressions.nth(1).fill('constructor.constructor("return 1")()');
  await expect(
    editor.getByText('Unknown name “constructor” at position 1.', { exact: false }),
  ).toBeVisible();
  await expect(expressions.nth(1)).toHaveAttribute('aria-invalid', 'true');
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeDisabled();
  await expressions.nth(1).fill('${hits}');
  await names.nth(1).fill('');
  await expect(
    editor.getByText('“hits” is already a series in this panel.', { exact: false }),
  ).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'Remove computed metric hits', exact: true }).click();
  await expect(expressions).toHaveCount(1);
  // Plain and computed series share the same eight-series budget.
  const extra = ['cost/a', 'cost/b', 'total', 'iteration', 'extra/one', 'extra/two'];
  for (const metric of extra) await pick('Y metrics', metric);
  await expect(editor.getByText('8 of 8 series', { exact: true })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: 'Y metrics', exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await expect(
    editor.getByText('Remove a metric or computed metric to add another.', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    editor.getByRole('button', { name: 'Add computed metric', exact: true }),
  ).toBeDisabled();
  for (const metric of extra)
    await editor.getByRole('button', { name: 'Remove ' + metric, exact: true }).click();
  await expect(
    editor.getByRole('button', { name: 'Add computed metric', exact: true }),
  ).toBeEnabled();
  // The plain metric is removed, so the panel plots only the computed metric.
  await editor.getByRole('button', { name: 'Remove hits', exact: true }).click();
  await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('');
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Hit rate', exact: true })).toBeVisible();
  await expect
    .poll(async () => (await series('ratio')).series.map((item) => [item.name, item.data]))
    .toEqual([
      [
        'Composition run',
        [
          [10, 0.25],
          [20, 0.5],
          [30, 0.25],
        ],
      ],
    ]);
  const stored = (await server.tools.execute('view_get', { id: view.id })).body.panels[0];
  assert.deepEqual(stored.metrics, []);
  assert.deepEqual(stored.expressions, [{ name: 'Hit rate', expression: '${hits} / ${total}' }]);
  assert.equal(stored.metric, 'Hit rate');
  assert.equal(stored.title, 'Hit rate');
  const ratioPanel = page.getByRole('article', { name: 'Hit rate', exact: true });
  await expect(ratioPanel.locator('.chart-legend-item')).toHaveAttribute(
    'title',
    'Hit rate = ${hits} / ${total}',
  );
  await ratioPanel.getByRole('application').focus();
  await page.keyboard.press('Home');
  await expect(
    page.locator('.plot-inspector:visible .plot-inspector-label[title]'),
  ).toHaveAttribute('title', 'Hit rate = ${hits} / ${total}');
  await page.keyboard.press('Escape');

  // Auto names follow the expression until a name is typed, and survive save/reload.
  await openPanelSettings(page, 'Hit rate');
  await expression.fill('${hits} * 2');
  await expect(names.first()).toHaveValue('Hit rate');
  await names.first().fill('');
  await expect(names.first()).toHaveAttribute('placeholder', 'hits * 2');
  await editor.getByRole('button', { name: 'Add computed metric', exact: true }).click();
  await expressions.nth(1).fill('${total} * 2');
  await expect(names.nth(1)).toHaveValue('');
  await expect(names.nth(1)).toHaveAttribute('placeholder', 'total * 2');
  await editor.getByRole('button', { name: 'Add computed metric', exact: true }).click();
  await expressions.nth(2).fill('${hits} + 1');
  const actions = (name) =>
    editor.getByRole('button', { name: 'Actions for ' + name, exact: true });
  const item = (name) => page.getByRole('menuitem', { name, exact: true });
  const values = () => expressions.evaluateAll((nodes) => nodes.map((node) => node.value));
  await actions('hits + 1').click();
  await expect(item('Move hits + 1 to last')).toBeDisabled();
  await expect(item('Move hits + 1 later')).toBeDisabled();
  await item('Move hits + 1 to first').click();
  await expect(actions('hits + 1')).toBeFocused();
  await expect.poll(values).toEqual(['${hits} + 1', '${hits} * 2', '${total} * 2']);
  await expect(editor.locator('.computed-metrics > [role=status]')).toHaveText(
    'Moved hits + 1 to position 1.',
  );
  await actions('hits + 1').click();
  await expect(item('Move hits + 1 to first')).toBeDisabled();
  await expect(item('Move hits + 1 earlier')).toBeDisabled();
  await item('Move hits + 1 to last').click();
  await expect(actions('hits + 1')).toBeFocused();
  await expect.poll(values).toEqual(['${hits} * 2', '${total} * 2', '${hits} + 1']);
  await expect(editor.locator('.computed-metrics > [role=status]')).toHaveText(
    'Moved hits + 1 to position 3.',
  );
  await editor
    .getByRole('button', { name: 'Remove computed metric hits + 1', exact: true })
    .click();
  await editor.getByRole('button', { name: 'Actions for total * 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move total * 2 earlier', exact: true }).click();
  await expect(
    editor.getByRole('button', { name: 'Actions for total * 2', exact: true }),
  ).toBeFocused();
  await expect(expressions.first()).toHaveValue('${total} * 2');
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  assert.deepEqual(
    (await server.tools.execute('view_get', { id: view.id })).body.panels[0].expressions.map(
      (item) => item.name,
    ),
    ['total * 2', 'hits * 2'],
  );
  await openPanelSettings(page, 'Hit rate');
  await editor.getByRole('button', { name: 'Actions for total * 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move total * 2 later', exact: true }).press('Enter');
  await expect(
    editor.getByRole('button', { name: 'Actions for total * 2', exact: true }),
  ).toBeFocused();
  await editor.getByRole('button', { name: 'Actions for hits * 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate hits * 2', exact: true }).click();
  await expect(expressions.nth(1)).toBeFocused();
  await expect(names.nth(1)).toHaveAttribute('placeholder', 'hits * 2 (2)');
  await editor
    .getByRole('button', { name: 'Remove computed metric hits * 2 (2)', exact: true })
    .click();
  await expect(expressions.nth(1)).toBeFocused();
  await expressions.nth(1).fill('${nope}');
  await expect(
    editor.getByText('Not logged by the compared runs: nope.', { exact: true }),
  ).toBeVisible();
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  const renamed = (await server.tools.execute('view_get', { id: view.id })).body.panels[0];
  assert.deepEqual(renamed.expressions, [
    { name: 'hits * 2', expression: '${hits} * 2' },
    { name: 'nope', expression: '${nope}' },
  ]);
  await page.reload();
  await openPanelSettings(page, 'Hit rate');
  await expect(names.first()).toHaveValue('');
  await expect(names.nth(1)).toHaveValue('');
  await expect(names.nth(1)).toHaveAttribute('placeholder', 'nope');
  await expressions.nth(1).fill('${rollout/truncated_episodes} / ${total}');
  await names.nth(1).fill('Truncation rate');
  await expression.fill('${hits} / ${total}');
  await names.first().fill('Hit rate');
  await expect(expression).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // Theme, phone targets, containment and real rendered contrast.
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expression.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
      if (width < 672) {
        const targets = await editor
          .locator('.computed-name-actions button, .expression-insert')
          .evaluateAll((buttons) =>
            buttons.map((button) => ({
              width: button.getBoundingClientRect().width,
              height: button.getBoundingClientRect().height,
            })),
          );
        assert.ok(
          targets.every(({ width, height }) => width >= 44 && height >= 44),
          JSON.stringify(targets),
        );
      }
      if (process.env.RANDL_COMPUTED_SCREENSHOTS && width !== 320) {
        await mkdir(process.env.RANDL_COMPUTED_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.RANDL_COMPUTED_SCREENSHOTS, `after-${theme}-${width}.png`),
        });
      }
    }
    await expect
      .poll(() =>
        editor
          .locator('.token-ref')
          .first()
          .evaluate((node) => {
            const rgb = (text) =>
              text
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number);
            const lum = (color) =>
              rgb(color)
                .map((v) => {
                  const c = v / 255;
                  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
            const style = getComputedStyle(node),
              a = lum(style.color),
              b = lum(style.backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }),
      )
      .toBeGreaterThanOrEqual(4.5);
    await expressions.nth(1).fill('${nope} ) 2');
    await expect(expressions.nth(1)).toHaveAttribute('aria-invalid', 'true');
    for (const [selector, property, target] of [
      ['.expression-warning', 'color', 4.5],
      ['.expression-mirror .is-error', 'textDecorationColor', 3],
    ]) {
      const contrast = await editor
        .locator(selector)
        .last()
        .evaluate((node, property) => {
          const rgba = (text) => {
            const values = text.match(/[\d.]+/g).map(Number);
            return [values[0], values[1], values[2], values[3] ?? 1];
          };
          const parents = [];
          for (let n = node; n; n = n.parentElement) parents.unshift(n);
          let background = [255, 255, 255];
          for (const n of parents) {
            const c = rgba(getComputedStyle(n).backgroundColor);
            background = background.map((v, i) => c[i] * c[3] + v * (1 - c[3]));
          }
          const fg = rgba(getComputedStyle(node)[property]);
          const foreground = background.map((v, i) => fg[i] * fg[3] + v * (1 - fg[3]));
          const luminance = (rgb) =>
            rgb
              .map((v) => {
                const c = v / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              })
              .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
          const a = luminance(foreground),
            b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        }, property);
      assert.ok(contrast >= target, `${theme} ${selector}: ${contrast}`);
    }
    await expressions.nth(1).fill('${rollout/truncated_episodes} / ${total}');
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await editor
    .getByRole('button', { name: 'Remove computed metric Truncation rate', exact: true })
    .click();
  await expect(expression).toBeFocused();
  // Escape first closes completion, then invokes the ordinary discard guard.
  await expression.fill('${');
  await expression.press('Escape');
  await expect(editor).toBeVisible();
  await expression.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expression.fill('${hits} / ${total}');
  // Enter in the textarea saves without inserting a newline (Carbon itself excludes textareas).
  await expression.press('Enter');
  await expect(editor).not.toBeVisible();

  // Stacked area: each component keeps its value at the shared X positions of one record.
  await openPanelSettings(page, 'Stack fixture');
  await editor
    .getByRole('combobox', { name: 'Panel type', exact: true })
    .selectOption('stacked-area');
  await pick('Y metrics', 'cost/b');
  await editor.getByRole('combobox', { name: 'Y metrics', exact: true }).press('Escape');
  await expect(editor.locator('.computed-empty code')).toHaveText('${cost/a} / ${cost/b}');
  await editor.getByRole('button', { name: 'Use example', exact: true }).click();
  await expect(expression).toHaveValue('${cost/a} / ${cost/b}');
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeEnabled();
  await editor.getByRole('button', { name: 'Syntax', exact: true }).click();
  await expect(editor.getByText('A record is skipped', { exact: false })).toBeVisible();
  await editor
    .getByRole('button', { name: 'Remove computed metric cost/a / cost/b', exact: true })
    .click();
  await expect(
    editor.getByRole('button', { name: 'Add computed metric', exact: true }),
  ).toBeFocused();
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () => (await series('stack')).series.map((item) => [item.stack, item.data]))
    .toEqual([
      [
        'components:' + run.id,
        [
          [10, 1],
          [20, 2],
          [30, 3],
          [40, 4],
        ],
      ],
      [
        'components:' + run.id,
        [
          [10, 3],
          [20, 2],
          [30, 1],
          [40, 4],
        ],
      ],
    ]);
  const stacked = await series('stack');
  assert.notEqual(
    stacked.series[0].color,
    stacked.series[1].color,
    'Components need distinct colors',
  );

  // Percent area: the same components as shares of each record's total.
  await openPanelSettings(page, 'Stack fixture');
  await editor
    .getByRole('combobox', { name: 'Panel type', exact: true })
    .selectOption('percent-area');
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () =>
      (await series('stack')).series.map((item) =>
        item.data.map(([x, y]) => [x, Math.round(y * 1e9) / 1e9]),
      ),
    )
    .toEqual([
      [
        [10, 25],
        [20, 50],
        [30, 75],
        [40, 50],
      ],
      [
        [10, 75],
        [20, 50],
        [30, 25],
        [40, 50],
      ],
    ]);
  assert.equal((await series('stack')).yMax, 100);
  assert.deepEqual(errors, []);
  console.log(
    'PASS computed metric, stacked and percent composition panels configured in the editor',
  );
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
