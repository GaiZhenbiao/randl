import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// Grouping by run state in the run list, the Runs table and charts, including a run that
// finishes while the page is open. Run list grouping only organizes the list: charts plot
// each run unless their own grouping setting aggregates them.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-run-state-group-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const origin = await listen(server);
  const stream = (id, body) =>
    fetch(`${origin}/files/${id}/file_stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => assert.ok(response.ok));
  const history = (value) => ({
    'wandb-history.jsonl': {
      offset: 0,
      content: [0, 1, 2].map((step) => JSON.stringify({ _step: step, loss: value + step })),
    },
  });
  // The running run is the oldest, so newest-first order lists it last.
  const ids = [];
  for (const [name, finish] of [
    ['live', null],
    ['done', { complete: true }],
    ['broken', { complete: true, exitcode: 1 }],
  ]) {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'state',
      name,
      displayName: name,
    });
    await stream(run.id, { files: history(ids.length), ...finish });
    ids.push(run.id);
  }
  const [live] = ids;
  const view = await server.tools.execute('view_create', {
    project: 'test/state',
    name: 'State',
    body: {
      generation: 'manual',
      visible: ids,
      solo: [],
      panels: [
        { id: 'p-loss', plugin: 'line', metric: 'loss', title: 'Loss' },
        {
          id: 'p-running',
          plugin: 'line',
          metric: 'loss',
          title: 'Loss by activity',
          settings: { groupBy: 'running' },
        },
      ],
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/test/state/workspace?view=${view.id}`);
  const groups = (selector) =>
    page
      .locator(selector)
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          [...node.querySelectorAll('.group-field, .group-value, .group-count')]
            .map((part) => part.textContent.trim())
            .join(' '),
        ),
      );
  const legend = (panel = 'p-loss') =>
    page
      .locator(`[data-panel-id="${panel}"] .chart-legend-item`)
      .evaluateAll((items) => items.map((item) => item.textContent.trim()));
  await expect(page.locator('[data-panel-id="p-loss"] canvas').first()).toBeVisible();
  await expect.poll(() => legend('p-running')).toEqual(['State: Running', 'State: Not running']);
  // The legend splits a name to crop it; the space at the split stays visible.
  const spaced = await page
    .locator('[data-panel-id="p-running"] .chart-legend-label')
    .evaluateAll((labels) =>
      labels.map((label) => {
        const probe = document.createElement('span');
        probe.textContent = label.textContent;
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
        label.parentElement.append(probe);
        const full = probe.getBoundingClientRect().width;
        probe.remove();
        const parts = [...label.children].reduce(
          (sum, part) => sum + part.getBoundingClientRect().width,
          0,
        );
        return Math.abs(parts - full) < 1;
      }),
    );
  assert.deepEqual(spaced, [true, true]);
  checks.push('A chart grouped by Running / not running aggregates without run list grouping');

  const group = page.locator('.heading-control button[title^="Group"]');
  await group.click();
  const choice = page.getByRole('combobox', { name: 'Group by' });
  await choice.click();
  const options = await page
    .locator('.bx--list-box__menu-item')
    .evaluateAll((items) => items.map((item) => item.textContent.trim()));
  assert.equal(options[options.indexOf('State') + 1], 'Running / not running', options.join(', '));
  await page.getByRole('option', { name: 'State', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(group).toHaveAttribute('title', 'Group: State');
  await expect
    .poll(() => groups('.run-group'))
    .toEqual(['State Running 1', 'State Finished 1', 'State Failed 1']);
  await expect.poll(legend).toEqual(['broken', 'done', 'live']);
  assert.equal((await server.db.call('view', view.id)).body.plotSettings?.groupBy, undefined);
  checks.push('State groups list running runs first; ungrouped charts still plot every run');

  await group.click();
  await choice.click();
  await page.getByRole('option', { name: 'Running / not running', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(group).toHaveAttribute('title', 'Group: Running / not running');
  await expect
    .poll(async () => {
      const body = (await server.db.call('view', view.id)).body;
      return [body.runQuery?.group, body.plotSettings?.groupBy];
    })
    .toEqual(['running', undefined]);
  await expect.poll(() => groups('.run-group')).toEqual(['State Running 1', 'State Not running 2']);
  await expect.poll(legend).toEqual(['broken', 'done', 'live']);
  await expect(
    page.getByRole('button', { name: 'Visibility for group State: Not running', exact: true }),
  ).toBeVisible();
  checks.push('Running / not running groups the run list without aggregating charts');

  const table = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  table.on('pageerror', (error) => errors.push(error.message));
  await table.goto(`${origin}/test/state/runs?view=${view.id}`);
  const tableGroups = () =>
    table
      .locator('.table-group')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          [...node.querySelectorAll('.group-field, .group-value, .group-count')]
            .map((part) => part.textContent.trim())
            .join(' '),
        ),
      );
  await expect.poll(tableGroups).toEqual(['State Running 1', 'State Not running 2']);

  // Finishing the run moves it to the other group in each open page without a reload.
  const charts = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chart') charts.push(request.url());
  });
  await stream(live, { complete: true });
  await expect.poll(() => groups('.run-group')).toEqual(['State Not running 3']);
  await expect.poll(tableGroups).toEqual(['State Not running 3']);
  await expect.poll(() => legend('p-running')).toEqual(['State: Not running']);
  await expect.poll(legend).toEqual(['broken', 'done', 'live']);
  assert.ok(charts.length > 0, 'the grouped chart reloads its data');
  await stream(live, {
    files: {
      'wandb-history.jsonl': {
        offset: 3,
        content: [JSON.stringify({ _step: 3, loss: 9 })],
      },
    },
  });
  await expect.poll(() => groups('.run-group')).toEqual(['State Running 1', 'State Not running 2']);
  await expect.poll(tableGroups).toEqual(['State Running 1', 'State Not running 2']);
  await expect.poll(() => legend('p-running')).toEqual(['State: Running', 'State: Not running']);
  checks.push('Run list, Runs table and chart groups follow a run that finishes and resumes');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
