import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';
const panelSettings = (page, title) =>
  page
    .getByRole('article', { name: title, exact: true })
    .getByRole('button', { name: 'Panel settings', exact: true });
async function openPanelSettings(page, title) {
  await page.getByRole('article', { name: title, exact: true }).hover();
  await panelSettings(page, title).click();
}

const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-columns-')),
  checks = [],
  errors = [];
let server, browser;
try {
  server = await createServer(directory);
  const config = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => ['parameter_' + String(i).padStart(2, '0'), { value: i }]),
  );
  const long = 'configuration_with_a_shared_prefix_and_distinctive_suffix_';
  config[long + 'alpha'] = { value: 1 };
  config[long + 'beta'] = { value: 2 };
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'columns',
    name: 'fixture',
    config,
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [
          JSON.stringify({ _step: 0, loss: 1, reward: 2, score: 3, quality: 4 }),
          JSON.stringify({ _step: 1, loss: 2, reward: 3, score: 4, quality: 5 }),
        ],
      },
    },
    complete: true,
    exitcode: 0,
  });
  const view = await server.tools.execute('view_create', {
    project: 'test/columns',
    name: 'Columns fixture',
    body: {
      panels: [],
      visible: [run.id],
      solo: [],
      runQuery: { columns: ['created', 'history_count', 'state'] },
    },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + server.app.server.address().port,
    url = base + '/test/columns/runs?view=' + view.id;
  browser = await launchBrowser();
  const stored = async () => (await server.db.call('view', view.id)).body.runQuery.columns;
  const reset = async (columns) => {
    const current = await server.db.call('view', view.id);
    await server.tools.execute('view_save', {
      id: view.id,
      name: current.name,
      project: current.project,
      version: current.version,
      body: { ...current.body, runQuery: { ...current.body.runQuery, columns } },
    });
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  const dialog = page.getByRole('dialog', { name: 'Run columns', exact: true }),
    input = dialog.getByRole('combobox', { name: 'Visible columns', exact: true });
  const open = async () => {
    await page.getByRole('button', { name: 'Columns', exact: true }).click();
    await expect(input).toBeFocused();
  };
  await open();
  await expect(dialog.getByRole('group', { name: 'Visible columns', exact: true })).toBeVisible();
  assert.equal(await input.evaluate((node) => getComputedStyle(node).borderBottomWidth), '0px');
  await expect(dialog.locator('.column-picker-chips .bx--tag')).toHaveText([
    'Created',
    'History records',
    'State',
  ]);
  await expect(dialog.locator('.bx--tag--filter')).toHaveCount(3);
  await input.fill('parameter_07');
  await input.press('Enter');
  await expect.poll(stored).toEqual(['created', 'history_count', 'state', 'config.parameter_07']);
  await dialog.getByRole('button', { name: 'Remove History records', exact: true }).click();
  await expect(input).toBeFocused();
  await expect.poll(stored).toEqual(['created', 'state', 'config.parameter_07']);
  await input.press('Backspace');
  await expect.poll(stored).toEqual(['created', 'state']);
  await expect(dialog.locator('.column-picker > span[role=status]')).toContainText(
    'Removed Config · parameter_07',
  );
  checks.push(
    'Named chips append selections, remove one item and Backspace removes only the final chip',
  );
  await input.fill('parameter');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await input.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog).toBeVisible();
  await input.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Columns', exact: true })).toBeFocused();
  await reset(['created', 'history_count', 'state']);
  await page.reload();
  await open();
  await dialog.getByRole('button', { name: 'Change order', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Change order', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Change order', exact: true }).click();
  const earlier = dialog.getByRole('button', { name: 'Move State earlier', exact: true });
  await earlier.focus();
  await page.keyboard.press('Enter');
  await expect(earlier).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(stored).toEqual(['state', 'created', 'history_count']);
  await expect(earlier).toBeFocused();
  await expect(earlier).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect.poll(stored).toEqual(['state', 'created', 'history_count']);
  const toLast = dialog.getByRole('button', { name: 'Move State to last', exact: true }),
    toFirst = dialog.getByRole('button', { name: 'Move State to first', exact: true });
  await expect(toFirst).toHaveAttribute('aria-disabled', 'true');
  await toLast.focus();
  await page.keyboard.press('Enter');
  await expect.poll(stored).toEqual(['created', 'history_count', 'state']);
  await expect(toLast).toBeFocused();
  await expect(toLast).toHaveAttribute('aria-disabled', 'true');
  await expect(
    dialog.getByRole('button', { name: 'Move State later', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(stored).toEqual(['created', 'history_count', 'state']);
  await toFirst.click();
  await expect.poll(stored).toEqual(['state', 'created', 'history_count']);
  await expect(toFirst).toBeFocused();
  await expect(toFirst).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Change order', exact: true })).toBeFocused();
  await input.fill('parameter_07');
  await input.press('Enter');
  await expect.poll(stored).toEqual(['state', 'created', 'history_count', 'config.parameter_07']);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await open();
  await expect(dialog.locator('.column-picker-chips .bx--tag')).toHaveText([
    'State',
    'Created',
    'History records',
    'Config · parameter_07',
  ]);
  checks.push(
    'Successive Escape closes one layer; keyed reorder, including to first and last, retains item focus and adding preserves the stored custom order',
  );
  await input.fill('no_such_field');
  await expect(dialog.locator('p[role=status]')).toContainText('No matching fields');
  await input.fill('parameter_08');
  await input.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    ),
  );
  assert.deepEqual(await stored(), ['state', 'created', 'history_count', 'config.parameter_07']);
  await input.press('Enter');
  await expect.poll(stored).toContain('config.parameter_08');
  checks.push(
    'No-match and composing Enter leave selection intact; ordinary Enter adds the highlighted field',
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  for (const theme of ['g10', 'g100']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((theme) => localStorage.setItem('randl.theme', theme), theme);
    const p = await context.newPage();
    await reset(['created', 'history_count', 'state']);
    await p.goto(url);
    await p.getByRole('button', { name: 'Columns', exact: true }).click();
    await p.getByRole('button', { name: 'Change order', exact: true }).click();
    const disabled = p.getByRole('button', { name: 'Move Created earlier', exact: true }),
      enabled = p.getByRole('button', { name: 'Move Created later', exact: true });
    for (const mode of ['rest', 'hover', 'focus']) {
      if (mode === 'hover') await disabled.hover();
      if (mode === 'focus') await disabled.focus();
      const sample = async (button) =>
        button.evaluate((node) => ({
          svg: getComputedStyle(node.querySelector('svg')).fill,
          paths: [...node.querySelectorAll('svg path:not([data-icon-path]):not([fill=none])')].map(
            (path) => getComputedStyle(path).fill,
          ),
        }));
      const a = await sample(disabled),
        b = await sample(enabled);
      assert.notEqual(a.svg, b.svg, theme + ' ' + mode);
      assert.ok(
        a.paths.every((fill) => fill === a.svg),
        JSON.stringify({ theme, mode, a, b }),
      );
    }
    await context.close();
  }
  checks.push(
    'Disabled order chevrons retain a distinct painted fill at rest, hover and focus in both themes',
  );
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 900 : 640 },
      hasTouch: width !== 1440,
      isMobile: width !== 1440,
    });
    const p = await context.newPage();
    await reset(
      Array.from({ length: 32 }, (_, i) => 'config.parameter_' + String(i).padStart(2, '0')),
    );
    await p.goto(url);
    await p.getByRole('button', { name: 'Columns', exact: true }).click();
    const d = p.getByRole('dialog', { name: 'Run columns', exact: true }),
      q = d.getByRole('combobox', { name: 'Visible columns', exact: true });
    await expect(q).toHaveAttribute('readonly', '');
    await expect(q).toHaveAccessibleDescription(
      'You can choose up to 32 columns. Remove one to add another.',
    );
    await expect(d.locator('.column-picker-chip-region')).toHaveClass(/more-below/);
    await expect(q).toBeFocused();
    await expect(d).toContainText('You can choose up to 32 columns. Remove one to add another.');
    const bounds = await d.boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.x + bounds.width <= width + 1 &&
        bounds.y + bounds.height <= (width === 1440 ? 900 : 640) + 1,
      JSON.stringify(bounds),
    );
    await q.press('Backspace');
    await expect.poll(stored).toHaveLength(31);
    await q.fill('parameter_39');
    await q.press('Enter');
    await expect.poll(stored).toHaveLength(32);
    assert.equal((await stored()).at(-1), 'config.parameter_39');
    await d.getByRole('button', { name: 'Close', exact: true }).click();
    await reset(['config.' + long + 'alpha', 'config.' + long + 'beta', 'config.no_longer_logged']);
    await p.reload();
    await p.getByRole('button', { name: 'Columns', exact: true }).click();
    const chips = d.locator('.column-picker-chips');
    await expect(chips).toContainText(long + 'alpha');
    await expect(chips).toContainText(long + 'beta');
    assert.ok(await chips.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
    const remove = d.getByRole('button', { name: 'Remove Config · no_longer_logged', exact: true });
    if (width !== 1440) {
      const r = await remove.boundingBox();
      assert.ok(r.width >= 44 && r.height >= 44);
      await remove.tap();
    } else await remove.click();
    await expect.poll(stored).toEqual(['config.' + long + 'alpha', 'config.' + long + 'beta']);
    await q.focus();
    await q.press('Backspace');
    await q.press('Backspace');
    await expect.poll(stored).toEqual([]);
    await d.getByRole('button', { name: 'Close', exact: true }).click();
    await p.reload();
    await p.getByRole('button', { name: 'Columns', exact: true }).click();
    await expect(d.locator('.bx--tag')).toHaveCount(0);
    await context.close();
  }
  checks.push(
    'Desktop and320/390 touch layouts bound32 chips, enforce capacity, expose long names, remove unavailable saved fields and preserve an empty selection',
  );
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 568, height: 320 },
      hasTouch: touch,
      isMobile: touch,
    });
    const p = await context.newPage();
    await reset(['created', 'history_count', 'state']);
    await p.goto(url);
    await p.getByRole('button', { name: 'Columns', exact: true }).click();
    const d = p.getByRole('dialog', { name: 'Run columns', exact: true }),
      q = d.getByRole('combobox', { name: 'Visible columns', exact: true });
    await q.fill('parameter');
    const list = p.getByRole('listbox', { name: 'Visible columns', exact: true });
    await expect(list).toBeVisible();
    const menu = await list.boundingBox();
    assert.ok(
      menu.y < 88 && menu.y >= 0 && menu.y + menu.height <= 320,
      JSON.stringify({ touch, menu }),
    );
    if (touch) {
      for (const selector of ['.bx--list-box__selection', '.bx--list-box__menu-icon']) {
        const box = await d.locator(selector).boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify({ selector, box }));
      }
      const boxes = await list
        .getByRole('option')
        .evaluateAll((nodes) => nodes.slice(0, 3).map((n) => n.getBoundingClientRect().toJSON()));
      for (let i = 0; i < boxes.length; i++) {
        assert.ok(boxes[i].height >= 44);
        if (i) assert.ok(boxes[i].y >= boxes[i - 1].bottom);
      }
    }
    await q.press('Enter');
    await expect.poll(stored).toContain('config.parameter_00');
    await context.close();
  }
  checks.push(
    'Top-layer menus use short-window space above main; coarse-pointer controls and virtualized options meet44px targets without overlap',
  );
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']) {
    const copy = JSON.parse(
      await readFile(
        new URL('../frontend/src/locales/' + locale + '.json', import.meta.url),
        'utf8',
      ),
    );
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale,
      hasTouch: true,
      isMobile: true,
    });
    const p = await context.newPage();
    await reset(['created', 'history_count', 'state']);
    await p.goto(url);
    await p.getByRole('button', { name: copy['runs.table.columns'], exact: true }).click();
    const d = p.getByRole('dialog', { name: copy['runs.columns.title'], exact: true });
    await expect(
      d.getByRole('combobox', { name: copy['runs.columns.visible'], exact: true }),
    ).toBeFocused();
    await expect(d.locator('.column-picker-chips .bx--tag')).toHaveText([
      copy['runs.fields.created'],
      copy['runs.fields.historyCount'],
      copy['runs.fields.state'],
    ]);
    await d.getByRole('button', { name: copy['runs.columns.changeOrder'], exact: true }).tap();
    await expect(d.getByRole('button', { name: copy['runs.columns.orderDone'], exact: true })).toBeVisible();
    await context.close();
  }
  checks.push('Five languages show localized selected names and ordering controls');
  await server.db.call('upsert', { entity: 'test', project: 'smallcolumns', name: 'fixture' });
  const available = (await server.db.call('runFields', 'test/smallcolumns')).filter(
    (id) => !['name', 'display_name'].includes(id),
  );
  assert.ok(available.length < 32 && available.length > 0);
  const smallView = await server.tools.execute('view_create', {
    project: 'test/smallcolumns',
    name: 'All columns',
    body: { panels: [], visible: [], solo: [], runQuery: { columns: available } },
  });
  await page.goto(base + '/test/smallcolumns/runs?view=' + smallView.id);
  await open();
  await expect(
    dialog.getByText('All available fields are selected.', { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveAttribute('placeholder', '');
  await expect(input).toHaveAccessibleDescription('All available fields are selected.');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.locator('.bx--list-box__menu-icon')).not.toBeVisible();
  await input.press('Backspace');
  await expect
    .poll(async () => (await server.db.call('view', smallView.id)).body.runQuery.columns.length)
    .toBe(available.length - 1);
  await input.fill(available.at(-1));
  await input.press('Enter');
  await expect
    .poll(async () => (await server.db.call('view', smallView.id)).body.runQuery.columns)
    .toEqual(available);
  await expect(
    dialog.getByText('All available fields are selected.', { exact: true }),
  ).toBeVisible();
  checks.push(
    'A small catalog exposes the all-selected explanation and remains removable and searchable',
  );

  for (const width of [320, 390])
    for (const metrics of [['loss'], ['loss', 'reward', 'score']]) {
      const editorView = await server.tools.execute('view_create', {
        project: 'test/columns',
        name: 'Metric width ' + width + ' ' + metrics.length,
        body: {
          generation: 'manual',
          panels: [
            {
              id: 'metric-width',
              plugin: 'line',
              metric: metrics[0],
              metrics,
              title: 'Metric width',
            },
          ],
          visible: [run.id],
          solo: [],
        },
      });
      const context = await browser.newContext({
        viewport: { width, height: 640 },
        hasTouch: true,
        isMobile: true,
      });
      const p = await context.newPage();
      await p.goto(base + '/test/columns/workspace?view=' + editorView.id);
      await panelSettings(p, 'Metric width').tap();
      const d = p.getByRole('dialog', { name: 'Panel settings', exact: true }),
        q = d.getByRole('combobox', { name: 'Y metrics', exact: true });
      assert.equal(await p.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
      await q.fill('reward');
      const box = await q.evaluate((node) => ({
        width:
          node.getBoundingClientRect().width -
          parseFloat(getComputedStyle(node).paddingLeft) -
          parseFloat(getComputedStyle(node).paddingRight),
        scroll: node.scrollLeft,
      }));
      assert.ok(box.width >= 80 && box.scroll === 0, JSON.stringify({ width, metrics, box }));
      await d.getByRole('button', { name: 'Cancel', exact: true }).tap();
      await expect(d).not.toBeVisible();
      await context.close();
    }
  checks.push(
    'Metric search keeps a readable text area at320/390coarse with one or three chips and44px actions',
  );
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
