import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-run-query-'));
const store = new Store(directory);
store.db.transaction(() => {
  for (let index = 0; index < 10000; index++) {
    const run = store.upsert({
      entity: 'test',
      project: 'large-query',
      name: `run-${String(index).padStart(5, '0')}`,
      displayName: `Trial ${String(index).padStart(5, '0')}`,
      config: { seed: { value: index % 32 } },
    });
    store.db.prepare("UPDATE runs SET state='finished' WHERE id=?").run(run.id);
  }
})();
store.db.close();
let server, browser;
const samples = [],
  errors = [];
try {
  server = await createServer(directory);
  const base = await listen(server);
  const view = await server.tools.execute('view_create', {
    project: 'test/large-query',
    name: 'Large run query',
    body: {
      generation: 'manual',
      panels: [],
      visible: [],
      solo: [],
      sections: [{ id: 's0', name: 'Charts' }],
      filters: [{ field: 'config.seed', operator: 'gte', value: '16' }],
      filterMode: 'all',
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const initialQuery = page.waitForResponse(
    (response) => response.url() === base + '/api/runs/query' && response.ok(),
  );
  await page.goto(base + '/test/large-query/workspace?view=' + view.id);
  const matches = await (await initialQuery).json();
  assert.equal(matches.ids.length, 4992);
  await expect(page.locator('.run-row').first()).toBeVisible();
  const search = page.getByPlaceholder('Search runs by name or ID', { exact: true });
  for (const query of ['09983', '09951', '09919']) {
    const started = performance.now();
    await search.fill(query);
    await expect(page.locator('.run-row')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Trial ' + query, exact: true })).toBeVisible();
    samples.push(performance.now() - started);
    await search.fill('');
    await expect.poll(() => page.locator('.run-row').count()).toBeGreaterThan(1);
  }
  // A name match outside the active filter must stay excluded.
  await search.fill('09984');
  await expect(page.locator('.run-row')).toHaveCount(0);
  await search.fill('');
  await expect.poll(() => page.locator('.run-row').count()).toBeGreaterThan(1);
  assert.ok((await page.locator('.run-row').count()) <= 40, 'Large result lists stay virtualized');
  const median = [...samples].sort((a, b) => a - b)[1];
  assert.ok(median < 1000, `Filtered name search median ${median.toFixed(1)} ms exceeds 1000 ms`);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        fixture: { runs: 10000, matchingRuns: 4992, panels: 0 },
        searchMs: samples,
        medianMs: median,
        browser: browser.version(),
        node: process.version,
        errors,
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
