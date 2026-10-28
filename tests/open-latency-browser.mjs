import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Open-latency budgets, measured from the trusted pointerdown to the first animation frame
// in which the dialog (or its ready state) has a layout box. See docs/performance.md.
const VISIBLE_BUDGET_MS = 250,
  READY_BUDGET_MS = 250,
  CATALOG_DELAY_MS = 1500,
  RUNS = 1100,
  CONFIG_KEYS_PER_RUN = 4;
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-open-latency-'));
const store = new Store(directory);
const runIds = [];
store.db.transaction(() => {
  for (let index = 0; index < RUNS; index++) {
    const config = { seed: { value: index % 8 } };
    for (let key = 0; key < CONFIG_KEYS_PER_RUN; key++) config[`p${index}_${key}`] = { value: key };
    const run = store.upsert({
      entity: 'test',
      project: 'open-latency',
      name: `run-${String(index).padStart(5, '0')}`,
      displayName: `Trial ${String(index).padStart(5, '0')}`,
      config,
    });
    // The last run ID sorts into the second 1,000-run catalog batch.
    store.db
      .prepare("UPDATE runs SET state='finished',created=? WHERE id=?")
      .run(1_700_000_000 + index, run.id);
    store.ingest(run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: [
            JSON.stringify({
              _step: 0,
              loss: 1 / (index + 1),
              ...(index === RUNS - 1 ? { 'late/only': 1 } : {}),
            }),
          ],
        },
      },
    });
    runIds.push(run.id);
  }
})();
store.db.close();
let server, browser;
const errors = [],
  report = {};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  server = await createServer(directory);
  const base = await listen(server);
  const view = await server.tools.execute('view_create', {
    project: 'test/open-latency',
    name: 'Open latency',
    body: {
      generation: 'manual',
      panels: [{ id: 'loss-panel', section: 's0', plugin: 'line', metric: 'loss', title: 'Loss' }],
      visible: runIds,
      solo: [],
      sections: [{ id: 's0', name: 'Charts' }],
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  let catalogRequests = 0;
  await page.route('**/api/metrics', async (route) => {
    catalogRequests++;
    await new Promise((done) => setTimeout(done, CATALOG_DELAY_MS));
    await route.continue();
  });
  const workspace = base + '/test/open-latency/workspace?view=' + view.id;
  const load = async () => {
    await page.goto(workspace);
    await expect(page.locator('.chart-title').first()).toBeVisible();
    await page.waitForTimeout(500);
  };
  // Records the time from pointerdown to the first frame in which each selector has a box.
  async function measure(trigger, visible, ready = visible) {
    await trigger.hover();
    await page.evaluate(
      ([visible, ready]) => {
        const timing = (window.__openTiming = { start: null, visible: null, ready: null });
        addEventListener('pointerdown', (event) => (timing.start = event.timeStamp), {
          capture: true,
          once: true,
        });
        const shown = (selector) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return !!box && box.width > 0 && box.height > 0;
        };
        const frame = () => {
          if (timing.start !== null) {
            const elapsed = performance.now() - timing.start;
            if (timing.visible === null && shown(visible)) timing.visible = elapsed;
            if (timing.ready === null && shown(ready)) timing.ready = elapsed;
          }
          if (timing.visible === null || timing.ready === null) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      },
      [visible, ready],
    );
    await trigger.click({ noWaitAfter: true });
    await page.waitForFunction(() => window.__openTiming.visible !== null, null, {
      timeout: 10000,
    });
    return page.evaluate(() => window.__openTiming);
  }
  const waitReady = () =>
    page.waitForFunction(() => window.__openTiming.ready !== null, null, { timeout: 10000 });
  const modal = '.bx--modal.is-visible .bx--modal-container',
    editorReady = '.bx--modal.is-visible .metric-picker[aria-busy="false"] input:not([disabled])',
    picker = page.locator('.bx--modal.is-visible .metric-picker');
  const closeEditor = async () => {
    await page.locator('.bx--modal.is-visible .bx--modal-footer .bx--btn--secondary').click();
    await expect(page.locator('.bx--modal.is-visible')).toHaveCount(0);
  };

  await load();
  const addButton = page.getByRole('button', { name: 'Add panel', exact: true });
  // A first open shows the editor before the catalog response and marks the field as loading.
  const cold = await measure(addButton, modal, editorReady);
  assert.ok(cold.visible < VISIBLE_BUDGET_MS, `Add panel became visible after ${cold.visible} ms`);
  await expect(picker).toHaveAttribute('aria-busy', 'true');
  await expect(picker.getByText('Loading metrics…')).toBeVisible();
  await waitReady();
  report.addPanelFirstOpen = await page.evaluate(() => ({
    visible: window.__openTiming.visible,
    ready: window.__openTiming.ready,
  }));
  assert.ok(report.addPanelFirstOpen.ready >= CATALOG_DELAY_MS, 'Ready waits for the catalog');
  // Catalog requests are split at 1,000 runs; a metric logged only by the last run is listed.
  assert.equal(catalogRequests, 2);
  await picker.locator('input').fill('late/only');
  await expect(page.getByRole('option', { name: 'late/only', exact: true })).toBeVisible();
  await picker.locator('input').fill('');
  await closeEditor();

  // Reopening uses the cached catalog: no request and no loading state.
  const warm = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    warm.push(await measure(addButton, modal, editorReady));
    await waitReady();
    warm[attempt] = await page.evaluate(() => window.__openTiming);
    await closeEditor();
  }
  assert.equal(catalogRequests, 2, 'Reopening with unchanged runs reuses the catalog');
  report.addPanelReopen = {
    visible: median(warm.map((t) => t.visible)),
    ready: median(warm.map((t) => t.ready)),
  };
  assert.ok(report.addPanelReopen.visible < VISIBLE_BUDGET_MS, JSON.stringify(report));
  assert.ok(report.addPanelReopen.ready < READY_BUDGET_MS, JSON.stringify(report));

  // New data in a compared run invalidates the cached catalog. The outdated catalog stays
  // usable while its replacement loads, and the new metric appears afterwards.
  const liveRun = runIds.at(-1);
  await server.db.call('ingest', liveRun, {
    files: {
      'wandb-history.jsonl': {
        offset: 1,
        content: [JSON.stringify({ _step: 1, loss: 0.5, 'fresh/metric': 1 })],
      },
    },
  });
  server.live.changedRun(liveRun);
  await page.waitForTimeout(1000);
  const refreshed = await measure(addButton, modal, editorReady);
  await waitReady();
  report.addPanelAfterLiveUpdate = await page.evaluate(() => ({
    visible: window.__openTiming.visible,
    ready: window.__openTiming.ready,
  }));
  assert.ok(refreshed.visible < VISIBLE_BUDGET_MS, JSON.stringify(report));
  assert.ok(report.addPanelAfterLiveUpdate.ready < READY_BUDGET_MS, JSON.stringify(report));
  await expect.poll(() => catalogRequests).toBe(4);
  await expect(picker).toHaveAttribute('aria-busy', 'false');
  await picker.locator('input').fill('fresh/metric');
  await expect(page.getByRole('option', { name: 'fresh/metric', exact: true })).toBeVisible();
  await picker.locator('input').fill('');
  await closeEditor();

  // Editing before the catalog arrives keeps the panel's metric selected.
  await load();
  const lossPanel = page.locator('.chart', {
    has: page.locator('.chart-title', { hasText: 'Loss' }),
  });
  await lossPanel.hover();
  const editing = await measure(lossPanel.locator('.chart-settings'), modal, editorReady);
  assert.ok(
    editing.visible < VISIBLE_BUDGET_MS,
    `Edit panel became visible after ${editing.visible} ms`,
  );
  await expect(picker).toHaveAttribute('aria-busy', 'true');
  await expect(picker.locator('.bx--tag', { hasText: 'loss' })).toBeVisible();
  await waitReady();
  report.editPanelFirstOpen = await page.evaluate(() => ({
    visible: window.__openTiming.visible,
    ready: window.__openTiming.ready,
  }));
  await expect(picker.locator('.bx--tag', { hasText: 'loss' })).toBeVisible();
  await expect(
    page.locator('.bx--modal.is-visible .bx--modal-footer .bx--btn--primary'),
  ).toBeEnabled();
  await closeEditor();

  // Thousands of config fields: grouping choices are built in linear time.
  const group = page.getByRole('button', { name: 'Group', exact: true }),
    groupTimes = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    groupTimes.push((await measure(group, '.context-popover:popover-open')).visible);
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-popover:popover-open')).toHaveCount(0);
  }
  report.groupPopover = median(groupTimes);
  assert.ok(report.groupPopover < VISIBLE_BUDGET_MS, JSON.stringify(report));

  const settings = page.getByRole('button', { name: 'Workspace settings', exact: true }),
    settingsTimes = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    settingsTimes.push((await measure(settings, '.side-drawer')).visible);
    await page.keyboard.press('Escape');
    await expect(page.locator('.side-drawer')).toHaveCount(0);
  }
  report.workspaceSettings = median(settingsTimes);
  assert.ok(report.workspaceSettings < VISIBLE_BUDGET_MS, JSON.stringify(report));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        fixture: {
          runs: RUNS,
          configFields: RUNS * CONFIG_KEYS_PER_RUN,
          catalogDelayMs: CATALOG_DELAY_MS,
        },
        budgetsMs: { visible: VISIBLE_BUDGET_MS, ready: READY_BUDGET_MS },
        ...report,
        browser: browser.version(),
        node: process.version,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
