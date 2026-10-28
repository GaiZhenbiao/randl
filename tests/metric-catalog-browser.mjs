import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

const directory = await mkdtemp(join(tmpdir(), 'randl-metric-catalog-'));
let server, browser;
try {
  server = await createServer(directory);
  const base = await listen(server);
  async function seed(name, metric) {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'catalog',
      name,
      displayName: name,
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': { offset: 0, content: [JSON.stringify({ _step: 0, [metric]: 1 })] },
      },
    });
    return run;
  }
  const a = await seed('Alpha', 'alpha/value'),
    b = await seed('Beta', 'beta/value'),
    pin = await seed('Pinned', 'pin/value');
  await server.db.call('ingest', b.id, {
    files: {
      'wandb-history.jsonl': { offset: 1, content: [JSON.stringify({ _step: 1, 'beta/only': 2 })] },
    },
  });
  const view = await server.tools.execute('view_create', {
    project: 'test/catalog',
    name: 'Shown metrics',
    body: {
      generation: 'manual',
      visible: [a.id, pin.id],
      solo: [],
      pinned: [pin.id],
      sections: [{ id: 's', name: 'Charts' }],
      panels: [
        {
          id: 'p',
          section: 's',
          plugin: 'line',
          metric: 'beta/value',
          title: 'Saved metric',
          settings: { xAxis: 'beta/value' },
        },
        {
          id: 'focused',
          section: 's',
          plugin: 'stacked-area',
          metric: 'alpha/value',
          metrics: ['alpha/value', 'beta/value'],
          title: 'Focused metric',
          settings: { maxRuns: 'focused' },
        },
      ],
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [],
    requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().endsWith('/api/metrics')) requests.push(request.postDataJSON().runs);
  });
  await page.goto(base + '/test/catalog/workspace?view=' + view.id);
  const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  const y = editor.getByRole('combobox', { name: 'Y metrics', exact: true });
  const picker = editor.locator('.metric-picker');
  async function open(title = 'Saved metric') {
    const panel = page.getByRole('article', { name: title, exact: true });
    await panel.hover();
    await panel.getByRole('button', { name: 'Panel settings', exact: true }).click();
    await expect(picker).toHaveAttribute('aria-busy', 'false');
  }
  async function close() {
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).not.toBeVisible();
  }
  async function option(metric, present) {
    await y.fill(metric);
    if (present)
      await expect(page.getByRole('option', { name: metric, exact: true })).toBeVisible();
    else await expect(page.getByRole('option', { name: metric, exact: true })).toHaveCount(0);
  }
  // A loading catalog must not turn known references into warnings.
  let releaseCatalog;
  const catalogGate = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route('**/api/metrics', async (route) => {
    await catalogGate;
    await route.continue();
  });
  const savedPanel = page.getByRole('article', { name: 'Saved metric', exact: true });
  await savedPanel.hover();
  await savedPanel.getByRole('button', { name: 'Panel settings', exact: true }).click();
  await expect(picker).toHaveAttribute('aria-busy', 'true');
  await editor.getByRole('button', { name: 'Add computed metric', exact: true }).click();
  const loadingExpression = editor.getByRole('combobox', { name: 'Expression', exact: true });
  await loadingExpression.fill('${alpha/value}');
  await expect(editor.locator('.expression-warning')).toHaveCount(0);
  await loadingExpression.fill('${');
  await expect(editor.locator('.expression-input > .bx--form__helper-text')).toHaveText(
    'Loading metrics…',
  );
  releaseCatalog();
  await expect(picker).toHaveAttribute('aria-busy', 'false');
  await expect(
    editor.locator('.expression-input').getByRole('option', { name: 'alpha/value', exact: true }),
  ).toBeVisible();
  await page.unroute('**/api/metrics');
  await close();
  const warning = picker.getByText('Not logged by the shown runs: beta/value', { exact: true });
  await open();
  await expect(picker.getByText('beta/value', { exact: true })).toBeVisible();
  await expect(warning).toBeVisible();
  assert.deepEqual(new Set(requests.at(-1)), new Set([a.id, pin.id]));
  await option('alpha/value', true);
  await option('pin/value', true);
  // A stored missing metric is retained as a chip, not offered as a new choice.
  await option('beta/value', false);
  await option('beta/only', false);
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect
    .poll(async () => (await server.db.call('view', view.id)).body.panels[0].metrics)
    .toEqual(['beta/value']);
  await page.locator(`.run-row[data-run-id="${b.id}"] [data-control="visible"]`).click();
  await open();
  await expect(warning).toHaveCount(0);
  await picker.getByRole('button', { name: 'Remove beta/value', exact: true }).click();
  await option('beta/value', true);
  await option('beta/only', true);
  await close();
  // Solo replaces visibility; pins still obey the same comparison selection as plots.
  await page.locator(`.run-row[data-run-id="${a.id}"] [data-control="solo"]`).click();
  await open();
  await expect(warning).toBeVisible();
  await option('alpha/value', true);
  await option('pin/value', false);
  await option('beta/value', false);
  await option('beta/only', false);
  assert.deepEqual(requests.at(-1), [a.id]);
  const x = editor.getByRole('combobox', { name: 'X axis', exact: true });
  await expect(x).toHaveValue('beta/value');
  await expect(
    editor.getByText('Not logged by the shown runs: beta/value', { exact: true }).last(),
  ).toBeVisible();
  await x.fill('pin/value');
  await expect(page.getByRole('option', { name: 'pin/value', exact: true })).toHaveCount(0);
  await editor.getByRole('tab', { name: 'Data', exact: true }).click();
  await editor.getByRole('button', { name: 'Add computed metric', exact: true }).click();
  const expression = editor.getByRole('combobox', { name: 'Expression', exact: true });
  await expression.fill('${');
  await expect(
    editor.locator('.expression-input').getByRole('option', { name: 'alpha/value', exact: true }),
  ).toBeVisible();
  await expect(
    editor.locator('.expression-input').getByRole('option', { name: 'beta/value', exact: true }),
  ).toHaveCount(0);
  await expression.fill('${beta/only}');
  await expect(
    editor.getByText('Not logged by the compared runs: beta/only.', { exact: true }),
  ).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save panel', exact: true })).toBeEnabled();
  await expression.fill('${alpha/value} * 2');
  await expect(editor.locator('.expression-warning')).toHaveCount(0);
  await close();
  await page.getByRole('button', { name: 'Clear solo', exact: true }).click();
  await page
    .getByRole('searchbox', { name: 'Search runs by name or ID', exact: true })
    .fill('Alpha');
  await open();
  await option('pin/value', true);
  await option('beta/only', false);
  await expect(warning).toBeVisible();

  // Live metric arrival updates the open editor without reopening or losing its draft.
  await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Keep draft');
  await server.db.call('ingest', a.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 1,
        content: [JSON.stringify({ _step: 1, 'live/value': 2 })],
      },
    },
  });
  server.live.changedRun(a.id);
  await y.fill('live/value');
  await expect(page.getByRole('option', { name: 'live/value', exact: true })).toBeVisible();
  await expect(editor.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
    'Keep draft',
  );
  await close();
  await open('Focused metric');
  await option('pin/value', true);
  await expect(warning).toBeVisible();
  await close();
  await page.getByRole('searchbox', { name: 'Search runs by name or ID', exact: true }).fill('');
  await open();
  await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Keep arrival draft');
  const arriving = await seed('Arriving', 'arrival/value');
  server.live.changedRun(arriving.id);
  await expect.poll(() => requests.some((ids) => ids.includes(arriving.id))).toBe(true);
  await expect(picker).toHaveAttribute('aria-busy', 'false');
  await expect(editor.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
    'Keep arrival draft',
  );
  await y.fill('arrival/value');
  await expect(page.getByRole('option', { name: 'arrival/value', exact: true })).toBeVisible();
  await close();
  // Section and workspace settings use the same shown candidates as panel settings.
  for (const heading of ['Charts section settings', 'Workspace settings']) {
    const trigger = page.getByRole('button', { name: heading, exact: true });
    if (heading.startsWith('Charts')) await page.locator('.section-heading').first().hover();
    await trigger.click();
    const settings = page.getByRole('dialog', { name: heading, exact: true });
    await settings.getByRole('tab', { name: 'Axes', exact: true }).click();
    const axis = settings.getByRole('combobox', { name: 'X axis', exact: true });
    await axis.fill('arrival/value');
    await expect(page.getByRole('option', { name: 'arrival/value', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(settings).not.toBeVisible();
  }
  await server.tools.execute('runs_select', { view: view.id, visible: [], solo: [] });
  await expect(page.locator('.run-row [data-control="visible"][aria-pressed="true"]')).toHaveCount(
    0,
  );
  const beforeEmpty = requests.length;
  await open();
  await expect(picker.getByText('No runs are shown.', { exact: true })).toBeVisible();
  await expect(warning).toBeVisible();
  await expect(y).toBeDisabled();
  assert.equal(requests.length, beforeEmpty, 'Empty selection does not fetch all metrics');
  await close();
  // Settings drawers use that same empty set and retain the built-in time axes.
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
  await drawer.getByRole('tab', { name: 'Axes', exact: true }).click();
  await expect(drawer.getByText('No runs are shown.', { exact: true })).toBeVisible();
  assert.equal(requests.length, beforeEmpty);
  assert.deepEqual(errors, []);
  console.log(
    'Shown-run metric catalog: visibility, solo, pins, filters, saved selections, X/autocomplete, live refresh and empty settings passed',
  );
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
