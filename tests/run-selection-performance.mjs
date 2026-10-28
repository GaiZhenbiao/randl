import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-run-selection-'));
const store = new Store(directory);
const runIds = [];
store.db.transaction(() => {
  for (let index = 0; index < 10000; index++) {
    const run = store.upsert({
      entity: 'test',
      project: 'large-selection',
      name: `run-${String(index).padStart(5, '0')}`,
      displayName: `Trial ${String(index).padStart(5, '0')}`,
      config: { seed: { value: index % 32 } },
    });
    store.db
      .prepare("UPDATE runs SET state='finished',created=? WHERE id=?")
      .run(1000000 + index, run.id);
    if (index < 4)
      store.ingest(run.id, {
        files: {
          'wandb-history.jsonl': {
            offset: 0,
            content: [0, 1].map((step) => JSON.stringify({ _step: step, loss: index + step / 10 })),
          },
        },
        complete: true,
        exitcode: 0,
      });
    runIds.push(run.id);
  }
})();
store.db.close();
let server, browser;
const scenarios = [],
  errors = [];
try {
  server = await createServer(directory);
  const base = await listen(server);
  browser = await launchBrowser();
  for (const scenario of [
    { name: 'Visibility, unfiltered', visible: runIds.slice(0, 1000), solo: [], filters: [] },
    {
      name: 'Visibility, filtered',
      visible: runIds.slice(0, 1000),
      solo: [],
      filters: [{ field: 'config.seed', operator: 'gte', value: '16' }],
    },
    {
      name: 'Multi-solo, unfiltered',
      visible: runIds.slice(0, 1000),
      solo: runIds.slice(1000, 2000),
      filters: [],
    },
    {
      name: 'Multi-solo, filtered',
      visible: runIds.slice(0, 1000),
      solo: runIds.slice(1000, 2000),
      filters: [{ field: 'config.seed', operator: 'gte', value: '16' }],
    },
  ]) {
    const view = await server.tools.execute('view_create', {
      project: 'test/large-selection',
      name: scenario.name,
      body: {
        generation: 'manual',
        panels: [],
        visible: scenario.visible,
        solo: scenario.solo,
        sections: [{ id: 's0', name: 'Charts' }],
        filters: scenario.filters,
        filterMode: 'all',
      },
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    const query = scenario.filters.length
      ? page.waitForResponse(
          (response) => response.url() === base + '/api/runs/query' && response.ok(),
        )
      : null;
    await page.goto(base + '/test/large-selection/workspace?view=' + view.id);
    if (query) assert.equal((await (await query).json()).ids.length, 4992);
    await expect(page.locator('.run-row').first()).toBeVisible();
    const selectionCount = scenario.filters.length ? '496' : '1,000';
    const selectionLabel =
      selectionCount +
      (scenario.solo.length ? ' soloed' : ' visible') +
      (scenario.filters.length ? ' · 504 hidden by filter' : '');
    await expect(page.locator('.side-footer span').first()).toHaveText(selectionLabel);
    const search = page.getByPlaceholder('Search runs by name or ID', { exact: true });
    const restoreMs = [];
    for (const queryText of ['09983', '09951', '09919']) {
      await search.fill(queryText);
      await expect(page.locator('.run-row')).toHaveCount(1);
      await expect(
        page.getByRole('link', { name: 'Trial ' + queryText, exact: true }),
      ).toBeVisible();
      const started = performance.now();
      await search.fill('');
      await expect.poll(() => page.locator('.run-row').count()).toBeGreaterThan(1);
      restoreMs.push(performance.now() - started);
      await expect(page.locator('.side-footer span').first()).toHaveText(selectionLabel);
    }
    const medianMs = [...restoreMs].sort((a, b) => a - b)[1];
    scenarios.push({
      name: scenario.name,
      visible: scenario.visible.length,
      solo: scenario.solo.length,
      restoreMs,
      medianMs,
    });
    assert.ok(
      (await page.locator('.run-row').count()) <= 40,
      'The result list remains virtualized',
    );
    await page.close();
  }
  const view = await server.tools.execute('view_create', {
    project: 'test/large-selection',
    name: 'Plotted selections',
    body: {
      generation: 'manual',
      panels: [
        { id: 'selection-chart', section: 's0', plugin: 'line', metric: 'loss', title: 'Loss' },
      ],
      visible: runIds.slice(0, 2),
      solo: [],
      sections: [{ id: 's0', name: 'Charts' }],
      runQuery: { sort: '-created' },
    },
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/test/large-selection/workspace?view=' + view.id);
  await page
    .getByRole('searchbox', { name: 'Search runs by name or ID', exact: true })
    .fill('0000');
  await expect(page.locator('.run-row')).toHaveCount(10);
  const plotted = async (indices) => {
    const names = [...indices]
      .sort((a, b) => b - a)
      .map((index) => 'Trial ' + String(index).padStart(5, '0'));
    await expect
      .poll(
        async () =>
          await page
            .locator('[data-panel-id="selection-chart"] .chart-legend-label')
            .allTextContents(),
      )
      .toEqual(names);
  };
  const toggle = (index, kind) =>
    page.locator(`[data-run-id="${runIds[index]}"] [data-toggle="${kind}"]`).click();
  await plotted([0, 1]);
  await toggle(2, 'solo');
  await plotted([2]);
  await toggle(3, 'solo');
  await plotted([2, 3]);
  await toggle(0, 'visible');
  await plotted([2, 3]);
  await expect
    .poll(async () => (await server.tools.execute('view_get', { id: view.id })).body.visible)
    .toEqual([runIds[1]]);
  await toggle(2, 'solo');
  await plotted([3]);
  await toggle(3, 'solo');
  await plotted([1]);
  await toggle(0, 'visible');
  await plotted([0, 1]);
  await expect
    .poll(async () => {
      const saved = await server.tools.execute('view_get', { id: view.id });
      return { visible: saved.body.visible.slice().sort(), solo: saved.body.solo };
    })
    .toEqual({ visible: runIds.slice(0, 2).sort(), solo: [] });
  await page.close();
  console.log(
    JSON.stringify(
      {
        fixture: { runs: 10000, historyRows: 8 },
        performancePanels: 0,
        plottedSelection: { panels: 1, runsWithHistory: 4, passed: true },
        browser: browser.version(),
        node: process.version,
        scenarios,
        errors,
      },
      null,
      2,
    ),
  );
  for (const scenario of scenarios)
    assert.ok(
      scenario.medianMs < 500,
      `${scenario.name}: median time to restore the list was ${scenario.medianMs.toFixed(1)} ms (limit 500 ms)`,
    );
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
