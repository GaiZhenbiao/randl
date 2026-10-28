// Stop a real W&B SDK run from the browser: confirm in the run page, see the SDK end the run,
// and check the run menu and Runs table stop actions, including an imported snapshot.
// Needs the SDK environment: RANDL_SDK_PYTHON (default .venv-sdk/bin/python).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { Store } from '../backend/dist/database.js';
import { createServer } from '../backend/dist/server.js';
const expect = baseExpect.configure({ timeout: 15000 });
const python = process.env.RANDL_SDK_PYTHON || resolve('.venv-sdk/bin/python');
const directory = await mkdtemp(join(tmpdir(), 'randl-run-stop-')),
  sdkDirectory = await mkdtemp(join(tmpdir(), 'randl-run-stop-sdk-'));
// A run with no SDK process and an imported snapshot captured while running.
const store = new Store(directory);
for (const name of ['idle-a', 'idle-b'])
  store.upsert({ entity: 'local', project: 'sdk-stop-tests', name, displayName: 'Idle ' + name });
const snapshot = store.upsert({
  entity: 'local',
  project: 'sdk-stop-tests',
  name: 'captured',
  displayName: 'Imported capture',
});
store.db
  .prepare("UPDATE runs SET state='running',snapshot_at=?,snapshot_source=? WHERE id=?")
  .run(1700000500, 'Synthetic source', snapshot.id);
store.db.close();
let server, browser, child;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  const identity = 'ui-stop-' + Math.random().toString(16).slice(2, 10),
    runId = 'local/sdk-stop-tests/' + identity;
  let output = '';
  child = spawn(python, ['tests/sdk_stop_smoke.py', '--child', identity, sdkDirectory], {
    env: {
      ...process.env,
      WANDB_BASE_URL: origin,
      WANDB_API_KEY: '0'.repeat(40),
      WANDB_MODE: 'online',
      WANDB_SILENT: 'true',
      WANDB_DIR: sdkDirectory,
      WANDB_CACHE_DIR: join(sdkDirectory, 'cache'),
      WANDB_DATA_DIR: join(sdkDirectory, 'staging'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolveExit) => child.on('exit', resolveExit));
  await expect
    .poll(async () => (await server.db.call('run', runId))?.history_count || 0, { timeout: 30000 })
    .toBeGreaterThan(0);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/local/sdk-stop-tests/runs/${identity}`);
  const name = (await server.db.call('run', runId)).display_name;
  // The imported snapshot's menu explains why it cannot be stopped.
  const snapshotRow = page.locator(`[data-run-id="${snapshot.id}"]`);
  await snapshotRow.hover();
  await snapshotRow.locator('.run-menu .bx--overflow-menu').click();
  await expect(
    page.getByRole('menuitem', { name: 'Imported runs cannot be stopped', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  checks.push('Imported snapshots show why they cannot be stopped');
  // Stop the SDK run from the run page header, confirmed in a danger modal.
  const stopButton = page.locator('.run-stop');
  await expect(stopButton).toHaveText('Stop run');
  await stopButton.click();
  const dialog = page.getByRole('dialog', { name: `Stop ${name}?`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.bx--btn--danger')).toHaveText('Stop run');
  await dialog.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.operation-toast')).toContainText('Stop requested');
  await expect(stopButton).toHaveText('Stop requested');
  const code = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('SDK did not stop: ' + output)), 60000),
    ),
  ]);
  assert.equal(code, 0, output);
  assert.match(output, /SDK_STOP_INTERRUPTED/);
  await expect(page.locator('.operation-toast')).toContainText(`${name} stopped`, {
    timeout: 30000,
  });
  await expect(stopButton).toHaveCount(0);
  assert.equal((await server.db.call('run', runId)).state, 'killed');
  checks.push(
    'A confirmed stop on the run page ends the real SDK run, and the page reports it live',
  );
  // The Runs table stops several selected runs after one confirmation.
  await page.goto(`${origin}/local/sdk-stop-tests/runs`);
  for (const run of ['Idle idle-a', 'Idle idle-b'])
    await page.getByRole('checkbox', { name: `Select ${run}`, exact: true }).check({ force: true });
  await page
    .getByRole('region', { name: 'Selected run actions', exact: true })
    .getByRole('button', { name: 'Stop', exact: true })
    .click();
  const bulk = page.getByRole('dialog', { name: 'Stop 2 runs?', exact: true });
  await bulk.getByRole('button', { name: 'Stop runs', exact: true }).click();
  await expect(bulk).toBeHidden();
  for (const run of ['idle-a', 'idle-b'])
    await expect
      .poll(async () => (await server.db.call('run', 'local/sdk-stop-tests/' + run)).stop_requested)
      .toBe(1);
  checks.push('The Runs table requests a stop for selected runs after one confirmation');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  if (child && child.exitCode === null) child.kill();
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
  await rm(sdkDirectory, { recursive: true, force: true });
}
