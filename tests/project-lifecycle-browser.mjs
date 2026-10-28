import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { expect as baseExpect } from '@playwright/test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from './helpers.mjs';

// Project lifecycle in a real browser against isolated temporary servers.
// Build first. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH optionally selects Chromium.
// RANDL_SDK_PYTHON (a Python with wandb installed) adds a real SDK first-run check.
const expect = baseExpect.configure({ timeout: 10_000 });
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'randl-project-browser-'));
const previousDirectory = process.cwd();
process.chdir(directory);
let failures = 0,
  browser;
const servers = [];
const browserErrors = [],
  externalRequests = [];

async function start(name, options = {}) {
  const server = await createServer(join(directory, name), options);
  await server.app.listen({ port: Number(options.port || 0), host: '127.0.0.1' });
  servers.push(server);
  return { server, baseURL: `http://127.0.0.1:${server.app.server.address().port}` };
}
async function context(baseURL, options = {}) {
  const created = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await created.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    externalRequests.push(url.origin);
    return route.abort();
  });
  created.on('page', (page) => page.on('pageerror', (error) => browserErrors.push(error.message)));
  return created;
}
async function check(name, task) {
  try {
    await task();
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name);
    console.error(error);
  }
}
async function sdkRun(server, baseURL, project, name, { finish = true } = {}) {
  const [entity, projectName] = project.split('/');
  const post = async (path, data) => {
    const response = await fetch(baseURL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await post('/graphql', {
    query: 'mutation UpsertBucket { upsertBucket }',
    variables: { entity, project: projectName, name, displayName: name },
  });
  await post(`/files/${project}/${name}/file_stream`, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _step: 0, loss: 2 }), JSON.stringify({ _step: 1, loss: 1 })],
      },
      'output.log': { offset: 0, content: ['训练开始'] },
    },
    ...(finish ? { complete: true, exitcode: 0 } : {}),
  });
  return `${project}/${name}`;
}
const rowCount = async (server) =>
  (await server.db.call('projects')).map((p) => p.id).sort().join(',');

try {
  browser = await launchBrowser();
  const { server, baseURL } = await start('local');
  await server.tools.execute('project_create', {
    id: 'audit/lifecycle',
    name: 'Lifecycle study',
    description: 'Synthetic runs for lifecycle checks.',
  });
  await sdkRun(server, baseURL, 'audit/lifecycle', 'finished-run');
  await sdkRun(server, baseURL, 'audit/older', 'older-run');
  await server.tools.execute('project_create', { id: 'audit/shelved', name: 'Shelved study' });
  await server.tools.execute('project_update', { id: 'audit/shelved', archived: true });
  const browserContext = await context(baseURL);
  const page = await browserContext.newPage();

  await check('project list shows totals, searches, and archives and restores from the row menu', async () => {
    await page.goto(baseURL + '/?page=overview');
    const table = page.getByRole('table').first();
    const row = table.getByRole('row').filter({ hasText: 'Lifecycle study' });
    await expect(row).toContainText('Synthetic runs for lifecycle checks.');
    await expect(row.getByRole('cell').nth(2)).toHaveText('1');
    await expect(row).toContainText(/\d+(\.\d)? (B|KiB)/);
    await expect(page.locator('#archived-projects table')).toBeHidden();
    const toggle = page.getByRole('button', { name: /Archived projects/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.locator('#archived-projects table')).toContainText('Shelved study');
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('older');
    await expect(page.locator('#active-projects table').getByRole('row')).toHaveCount(2);
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('');
    const menu = row.getByRole('button', { name: 'Actions for Lifecycle study' });
    await row.hover();
    await expect(menu).toHaveCSS('opacity', '1');
    await menu.click();
    const options = page.locator('.bx--overflow-menu-options').filter({ visible: true });
    const box = await options.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box.y + box.height <= viewport.height && box.x + box.width <= viewport.width, 'menu is inside the viewport');
    assert.equal(await options.evaluate((node) => !!node.closest('.bx--data-table-container')), false, 'menu floats outside the table');
    await page.getByRole('menuitem', { name: 'Archive project' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Archived Lifecycle study' })).toBeVisible();
    await expect(page.locator('#archived-projects table')).toContainText('Lifecycle study');
    assert.equal((await server.tools.execute('project_get', { id: 'audit/lifecycle' })).archived, 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('#active-projects table')).toContainText('Lifecycle study');
    const restored = await server.tools.execute('project_get', { id: 'audit/lifecycle' });
    assert.equal(restored.archived, 0);
    assert.equal(restored.name, 'Lifecycle study');
  });

  await check('create validates as typed and opens an empty workspace with SDK guidance', async () => {
    await page.goto(baseURL + '/?page=overview');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create project' });
    const name = dialog.getByRole('textbox', { name: 'Project name' });
    await dialog.getByRole('combobox', { name: 'Namespace' }).fill('audit');
    await dialog.getByRole('textbox', { name: 'Project name' }).click();
    await name.fill('lifecycle');
    await expect(dialog).toContainText('A project with ID audit/lifecycle already exists.');
    await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await name.fill('///');
    await expect(dialog).toContainText('Use at least one letter or digit in the name.');
    await name.fill('Onboarding $study');
    await dialog.getByRole('textbox', { name: 'Description (optional)' }).fill('First line\nSecond line');
    await expect(dialog).toContainText('Project ID: audit/Onboarding-study');
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await page.waitForURL((url) => url.pathname === '/audit/Onboarding-study/workspace');
    const created = await server.tools.execute('project_get', { id: 'audit/Onboarding-study' });
    assert.equal(created.description, 'First line\nSecond line');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
    await main.getByRole('button', { name: 'Connect SDK' }).click();
    const connect = page.getByRole('dialog', { name: 'Connect SDK' });
    await expect(connect).toContainText(`export WANDB_BASE_URL=${baseURL}`);
    await expect(connect).toContainText('export WANDB_API_KEY=0000000000000000000000000000000000000000');
    await expect(connect).toContainText(`wandb login --relogin --host ${baseURL}`);
    await expect(connect).toContainText('wandb.init(entity="audit", project="Onboarding-study")');
    await expect(connect).toContainText('wandb sync wandb/offline-run-*');
    await expect(connect).toContainText('The local server accepts this placeholder key.');
    await page.keyboard.press('Escape');
    await expect(connect).toBeHidden();
    await expect(main.getByRole('button', { name: 'Connect SDK' })).toBeFocused();
  });

  await check('the first SDK run becomes visible without a reload', async () => {
    await page.goto(baseURL + '/audit/Onboarding-study/workspace');
    await expect(page.getByRole('main').getByRole('heading', { name: 'No runs yet' })).toBeVisible();
    if (process.env.RANDL_SDK_PYTHON) {
      const work = await mkdtemp(join(directory, 'sdk-'));
      await exec(
        process.env.RANDL_SDK_PYTHON,
        [
          '-I',
          '-c',
          'import wandb\nwith wandb.init(entity="audit", project="Onboarding-study", name="sdk-first") as run:\n    [run.log({"loss": 1 / (i + 1)}) for i in range(3)]',
        ],
        {
          cwd: work,
          timeout: 120000,
          env: {
            PATH: process.env.PATH,
            HOME: work,
            WANDB_DIR: work,
            WANDB_CONFIG_DIR: join(work, 'config'),
            WANDB_CACHE_DIR: join(work, 'cache'),
            WANDB_DATA_DIR: join(work, 'data'),
            WANDB_BASE_URL: baseURL,
            WANDB_API_KEY: '0'.repeat(40),
          },
        },
      );
    } else await sdkRun(server, baseURL, 'audit/Onboarding-study', 'sdk-first');
    const sidebar = page.getByRole('complementary', { name: 'Run selection' });
    await expect(sidebar).toContainText('sdk-first', { timeout: 20_000 });
    await expect(sidebar).toContainText('1 visible');
    await expect(page.getByRole('main').getByRole('heading', { name: 'No runs yet' })).toBeHidden();
    await expect(page.locator('.chart').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No visible runs')).toHaveCount(0);
  });

  await check('a saved view shows newly arriving runs and keeps an explicitly hidden run hidden', async () => {
    await page.goto(baseURL + '/audit/Onboarding-study/workspace');
    const sidebar = page.getByRole('complementary', { name: 'Run selection' });
    await sdkRun(server, baseURL, 'audit/Onboarding-study', 'second-run');
    const second = sidebar.getByRole('button', { name: 'Visibility for second-run' });
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
    await sdkRun(server, baseURL, 'audit/Onboarding-study', 'third-run');
    const third = sidebar.getByRole('button', { name: 'Visibility for third-run' });
    await expect(third).toHaveAttribute('aria-pressed', 'true');
    await expect(second).toHaveAttribute('aria-pressed', 'false');
    await expect(sidebar.getByRole('button', { name: 'Solo for third-run' })).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(third).toHaveAttribute('aria-pressed', 'true');
    await expect(second).toHaveAttribute('aria-pressed', 'false');
  });

  await check('settings save name and description, keep archive state, and use Escape to reset', async () => {
    await server.tools.execute('project_update', { id: 'audit/lifecycle', archived: true });
    await page.goto(baseURL + '/audit/lifecycle/settings');
    const name = page.getByRole('textbox', { name: 'Project name' });
    await expect(name).toHaveValue('Lifecycle study');
    await name.fill('Draft name');
    await name.press('Escape');
    await expect(name).toHaveValue('Lifecycle study');
    await name.fill('   ');
    await expect(page.getByText('Enter a project name.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await name.fill('Lifecycle study 二');
    await page.getByRole('textbox', { name: 'Description' }).fill('Updated description');
    await name.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    const saved = await server.tools.execute('project_get', { id: 'audit/lifecycle' });
    assert.equal(saved.name, 'Lifecycle study 二');
    assert.equal(saved.description, 'Updated description');
    assert.equal(saved.archived, 1);
    await expect(page.getByRole('button', { name: 'Restore project' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore project' }).click();
    await expect(page.getByRole('button', { name: 'Archive project' })).toBeVisible();
    assert.equal((await server.tools.execute('project_get', { id: 'audit/lifecycle' })).name, 'Lifecycle study 二');
  });

  await check('overview edits the description and shows details without an empty run table', async () => {
    await page.goto(baseURL + '/audit/lifecycle/overview');
    await expect(page.getByRole('main')).toContainText('Updated description');
    await expect(page.locator('.overview-tiles').first()).toContainText('Finished1');
    await expect(page.getByRole('main')).toContainText('History and logs');
    await expect(page.locator('.overview-runs th').last()).toHaveText('Created');
    await page.getByRole('button', { name: 'Edit description' }).click();
    const field = page.getByRole('textbox', { name: 'Description' });
    await expect(field).toBeFocused();
    await field.fill('Line one');
    await field.press('Enter');
    await field.type('Line two');
    await field.press('Escape');
    await expect(page.getByRole('main')).toContainText('Updated description');
    await page.getByRole('button', { name: 'Edit description' }).click();
    await field.fill('Line one\nLine two');
    await field.press('Control+Enter');
    await expect(page.getByRole('button', { name: 'Edit description' })).toBeFocused();
    assert.equal(
      (await server.tools.execute('project_get', { id: 'audit/lifecycle' })).description,
      'Line one\nLine two',
    );
    await server.tools.execute('project_create', { id: 'audit/Empty-check', name: 'Empty check' });
    await page.goto(baseURL + '/audit/Empty-check/overview');
    await expect(page.getByRole('main').getByRole('heading', { name: 'No runs yet' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('table')).toHaveCount(0);
  });

  await check('overview highlights running runs live and shows only project content', async () => {
    await page.goto(baseURL + '/audit/lifecycle/overview');
    await expect(page.locator('.running-runs')).toHaveCount(0);
    await sdkRun(server, baseURL, 'audit/lifecycle', 'overview-live', { finish: false });
    const running = page.getByRole('region', { name: /Running/ });
    await expect(running).toContainText('overview-live');
    await expect(running.getByRole('link', { name: 'Logs' })).toHaveAttribute(
      'href',
      '/audit/lifecycle/runs/overview-live/logs',
    );
    await expect(page.locator('.tile-running dd')).toHaveText('1');
    const finished = Number(await page.locator('.overview-tiles').first().locator('dd').nth(2).textContent());
    const response = await fetch(baseURL + '/files/audit/lifecycle/overview-live/file_stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: {}, complete: true, exitcode: 0 }),
    });
    assert.equal(response.status, 200);
    await expect(page.locator('.running-runs')).toHaveCount(0);
    await expect(page.locator('.overview-tiles').first().locator('dd').nth(2)).toHaveText(String(finished + 1));
    await expect(page.getByText('Requests per minute')).toHaveCount(0);
  });

  await check('Server is a top-level page that polls only new minutes and stops when left', async () => {
    const polls = [];
    const listener = (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/server/metrics') polls.push(url.searchParams.get('since'));
    };
    page.on('request', listener);
    try {
      await page.goto(baseURL + '/?page=overview');
      const rail = page.getByRole('navigation', { name: 'Project pages' });
      await rail.getByRole('button', { name: 'Server', exact: true }).click();
      await page.waitForURL((url) => url.search === '?page=server');
      await expect(page.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible();
      await expect(page.locator('.bx--breadcrumb-item')).toHaveText(['Server']);
      const region = page.getByRole('region', { name: 'Server' });
      await expect(region).toContainText('Requests per minute');
      await expect(region.locator('canvas')).toHaveCount(6, { timeout: 15_000 });
      await expect.poll(() => polls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      assert.equal(polls[0], null, 'the first request reads every bucket');
      assert.ok(Number(polls[1]) > 0, 'later requests ask only for minutes since the newest bucket');
      await rail.getByRole('button', { name: 'Projects', exact: true }).click();
      await page.waitForURL((url) => url.search === '?page=overview');
      const left = polls.length;
      await page.waitForTimeout(10_500);
      assert.equal(polls.length, left, 'polling stopped after leaving the Server page');
      await page.goBack();
      await expect(page.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible();
    } finally {
      page.off('request', listener);
    }
  });

  await check('a running run disables deletion and states why', async () => {
    await sdkRun(server, baseURL, 'audit/lifecycle', 'live-run', { finish: false });
    await page.goto(baseURL + '/audit/lifecycle/settings');
    await expect(page.getByText('Stop or wait for 1 running runs before deleting this project.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete project…' })).toBeDisabled();
    await server.db.call('ingest', 'audit/lifecycle/live-run', { files: {}, complete: true, exitcode: 1 });
  });

  await check('typed confirmation deletes the project and other tabs show Project not found', async () => {
    const other = await browserContext.newPage();
    await other.goto(baseURL + '/audit/lifecycle/workspace');
    await expect(other.getByRole('complementary', { name: 'Run selection' })).toContainText('finished-run');
    await page.goto(baseURL + '/audit/lifecycle/settings');
    const before = await rowCount(server);
    const open = page.getByRole('button', { name: 'Delete project…' });
    await expect(open).toBeEnabled();
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Delete Lifecycle study 二?' });
    await expect(dialog.locator('dd').first()).toHaveText('3');
    const typed = dialog.getByRole('textbox', { name: 'Type Lifecycle study 二 to confirm' });
    await expect(typed).toBeFocused();
    await typed.fill('lifecycle study 二');
    await expect(dialog.getByRole('button', { name: 'Delete project' })).toBeDisabled();
    await typed.press('Enter');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    assert.equal(await rowCount(server), before);
    await open.click();
    await typed.fill('Lifecycle study 二');
    await typed.press('Enter');
    await page.waitForURL((url) => url.search === '?page=overview');
    await expect(page.getByRole('status').filter({ hasText: 'Deleted Lifecycle study 二' })).toBeVisible();
    assert.ok(!(await rowCount(server)).includes('audit/lifecycle'));
    assert.equal(await server.db.call('run', 'audit/lifecycle/finished-run'), undefined);
    await expect(other.getByRole('heading', { name: 'Project not found' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
    assert.ok(!(await rowCount(server)).includes('audit/lifecycle'));
    await other.close();
  });

  await check('phone layout keeps project actions reachable without page overflow', async () => {
    const phone = await context(baseURL, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const mobile = await phone.newPage();
    await mobile.goto(baseURL + '/?page=overview');
    const menu = mobile.getByRole('button', { name: 'Actions for older' });
    await expect(menu).toHaveCSS('opacity', '1');
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, 'page overflow ' + overflow);
    await menu.tap();
    const options = mobile.locator('.bx--overflow-menu-options').filter({ visible: true });
    const box = await options.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, 'touch menu is fully visible');
    await mobile.keyboard.press('Escape');
    await mobile.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await mobile.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Server', exact: true }).click();
    await expect(mobile.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible();
    await mobile.goto(baseURL + '/audit/older/workspace');
    await mobile.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await mobile.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name: 'Connect SDK' }).click();
    await expect(mobile.getByRole('dialog', { name: 'Connect SDK' })).toContainText(
      'wandb.init(entity="audit", project="older")',
    );
    await phone.close();
  });

  await check('Connect SDK uses the public URL and the key placeholder when sign-in is required', async () => {
    const key = randomBytes(24).toString('hex');
    const probe = createHTTPServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const publicUrl = `http://localhost:${port}`;
    const secured = await start('secured', { apiKey: key, publicUrl, port });
    await secured.server.tools.execute('project_create', { id: 'team/secure', name: 'Secure' });
    const securedContext = await context(publicUrl);
    const signed = await securedContext.newPage();
    await signed.goto(publicUrl + '/team/secure/workspace');
    await signed.getByLabel('API key').fill(key);
    await signed.getByRole('button', { name: 'Sign in' }).click();
    await signed.getByRole('main').getByRole('button', { name: 'Connect SDK' }).click();
    const connect = signed.getByRole('dialog', { name: 'Connect SDK' });
    await expect(connect).toContainText(`export WANDB_BASE_URL=${publicUrl}`);
    await expect(connect).toContainText('export WANDB_API_KEY=YOUR_RANDL_API_KEY');
    await expect(connect).toContainText('Replace YOUR_RANDL_API_KEY with this server’s API key');
    assert.ok(!(await signed.content()).includes(key), 'page source contains the API key');
    await securedContext.close();
  });

  await check('Assistant deletion waits for a typed confirmation in the owner tab', async () => {
    const provider = createHTTPServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      const lastUser = parsed.messages.findLastIndex((m) => m.role === 'user');
      const toolResult = parsed.messages.slice(lastUser).find((m) => m.role === 'tool');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        response.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'lifecycle', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: 'assistant' });
      if (!toolResult) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'delete-older-' + lastUser,
              type: 'function',
              function: { name: 'project_delete', arguments: JSON.stringify({ id: 'audit/older' }) },
            },
          ],
        });
        chunk({}, 'tool_calls');
      } else {
        chunk({ content: JSON.parse(toolResult.content).declined ? 'Kept the project.' : 'Deleted the project.' });
        chunk({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(directory, 'auth.json'),
        modelsPath: null,
        modelsStorePath: join(directory, 'models-cache.json'),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      runtime.registerProvider('lifecycle-fixture', {
        name: 'Lifecycle provider',
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        api: 'openai-completions',
        apiKey: 'local-fixture',
        models: [
          {
            id: 'lifecycle',
            name: 'Lifecycle fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      server.agent.runtimeFactory = async () => runtime;
      await server.db.call('settingSet', 'agent-model', { provider: 'lifecycle-fixture', id: 'lifecycle' });
      await page.goto(baseURL + '/audit/older/overview');
      await page.getByRole('button', { name: 'Assistant', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Assistant' });
      const send = async (text) => {
        await drawer.getByRole('textbox', { name: 'Message' }).fill(text);
        await drawer.getByRole('button', { name: 'Send', exact: true }).click();
      };
      await send('Delete the older project.');
      const card = drawer.getByRole('region', { name: 'Delete older?' });
      const typed = card.getByRole('textbox', { name: 'Type older to confirm' });
      await expect(typed).toBeFocused();
      await expect(card).toContainText('audit/older');
      assert.ok(await server.db.call('run', 'audit/older/older-run'), 'deleted before confirmation');
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
      await expect(page.getByRole('button', { name: /Assistant.*Confirmation needed/ })).toBeVisible();
      await page.getByRole('button', { name: /Assistant/ }).first().click();
      await expect(typed).toBeVisible();
      await typed.press('Escape');
      await expect(drawer).toContainText('Kept the project.');
      assert.ok(await server.db.call('run', 'audit/older/older-run'), 'declined deletion removed data');
      await send('Delete the older project now.');
      await typed.fill('older');
      await typed.press('Enter');
      await expect(drawer).toContainText('Deleted the project.');
      assert.equal(await server.db.call('run', 'audit/older/older-run'), undefined);
      await page.waitForURL((url) => url.search === '?page=overview');
      await expect(drawer).toBeVisible();
    } finally {
      await new Promise((resolve) => provider.close(resolve));
    }
  });
} finally {
  await browser?.close();
  for (const server of servers) await server.app.close();
  process.chdir(previousDirectory);
  await rm(directory, { recursive: true, force: true });
}
if (externalRequests.length) {
  failures++;
  console.error('FAIL external requests', externalRequests);
}
if (browserErrors.length) {
  failures++;
  console.error('FAIL browser errors', browserErrors);
}
console.log(failures ? `${failures} failed` : 'All project lifecycle browser checks passed');
process.exitCode = failures ? 1 : 0;
