import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const directory = await mkdtemp(join(tmpdir(), 'randl-snapshots-'));
let server, browser;
try {
  const store = new Store(directory);
  const run = store.upsert({
    entity: 'local',
    project: 'snapshot',
    name: 'captured',
    displayName: 'Captured fixture',
  });
  store.ingest(run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _step: 0, _runtime: 23, loss: 1 })],
      },
    },
  });
  store.db
    .prepare(
      'UPDATE runs SET snapshot_at=?,snapshot_source=?,runtime=23,runtime_reported=1,runtime_at=?,heartbeat=? WHERE id=?',
    )
    .run(1700000000, 'Synthetic source', 1699999990, 1699999990, run.id);
  store.db.close();
  server = await createServer(directory);
  const view = await server.tools.execute('view_create', {
    name: 'Snapshot fixture',
    project: 'local/snapshot',
    body: { visible: [run.id], solo: [], pinned: [run.id], panels: [], generation: 'manual' },
  });
  const base = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ locale: 'en-US' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/local/snapshot/workspace?view=' + view.id);
  const link = page.locator('.run-name').filter({ hasText: 'Captured fixture' });
  // An imported snapshot shows its stored state like any run.
  await expect(link.locator('small')).toHaveText('Running · captured');
  await expect(link).toHaveAttribute('title', 'Captured fixture · Running');
  await expect(link.locator('.running-name-dot')).toHaveCount(1);
  await page.getByRole('button', { name: 'Actions for Captured fixture', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Stop run', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The project overview counts it as running, with no separate snapshot note.
  await page.goto(base + '/local/snapshot/overview');
  await expect(page.locator('.tile-running dd')).toHaveText('1');
  await page.goto(base + '/local/snapshot/runs/captured/overview');
  const runtime = page
    .locator('dt')
    .filter({ hasText: /^Runtime$/ })
    .locator('+ dd');
  await expect(runtime).toHaveText('23s');
  await expect(
    page.getByRole('link', { name: 'Export imported history', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.snapshot-note')).toContainText('Resuming this run ID with the W&B SDK continues it here.');
  await expect(
    page
      .locator('dt')
      .filter({ hasText: /^Source$/ })
      .locator('+ dd'),
  ).toHaveText('Synthetic source');
  const captureText = await page
    .locator('dt')
    .filter({ hasText: /^Captured$/ })
    .locator('+ dd')
    .innerText();
  assert.match(captureText, /2023/);
  await page.waitForTimeout(1500);
  await expect(runtime).toHaveText('23s');
  await page.reload();
  await expect(runtime).toHaveText('23s');
  assert.equal((await server.db.call('run', run.id)).state, 'running');
  const { readFile } = await import('node:fs/promises'),
    ts = (await import('typescript')).default;
  const code = ts.transpileModule(
    await readFile(new URL('../frontend/src/api.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const { ApiError, apiMessage } = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
  assert.deepEqual(
    apiMessage(
      new ApiError(
        'Imported snapshots cannot receive stop requests',
        400,
        'RUN_SNAPSHOT_STOP_UNAVAILABLE',
      ),
    ),
    { key: 'runs.snapshot.stopUnavailable', values: {} },
  );
  const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,locale:'en-US'});
  const touch=await touchContext.newPage();
  await touch.goto(base+'/local/snapshot/workspace?view='+view.id);
  await touch.getByRole('button',{name:'Show runs',exact:true}).tap();
  await expect(touch.locator('.run-name').filter({hasText:'Captured fixture'}).locator('small')).toHaveText('Running · captured');
  await touchContext.close();
  assert.deepEqual(errors, []);
  console.log(
    'PASS snapshot shows its stored state; capture date, source, frozen runtime and no Stop action',
  );
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
