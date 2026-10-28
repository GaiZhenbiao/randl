import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { expect } from 'playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const keyFile = process.env.RANDL_AGENT_TEST_KEY_FILE;
if (!keyFile)
  throw Error(
    'Set RANDL_AGENT_TEST_KEY_FILE to a JSON file containing apiKey. This test sends live model requests.',
  );
const { apiKey } = JSON.parse(await readFile(keyFile, 'utf8'));
assert.ok(typeof apiKey === 'string' && apiKey.length > 0, 'The key file must contain apiKey');
const providerId = process.env.RANDL_AGENT_TEST_PROVIDER || 'deepseek',
  modelId = process.env.RANDL_AGENT_TEST_MODEL || 'deepseek-flash';
const dir = await mkdtemp(join(tmpdir(), 'randl-live-agent-'));
const en = JSON.parse(
  await readFile(new URL('../frontend/src/locales/en.json', import.meta.url), 'utf8'),
);
const server = await createServer(join(dir, 'data'));
let browser;
const summary = { checks: [], errors: [] };
try {
  const base = await listen(server);
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.ok(response.ok, path + ' ' + response.status);
    return data;
  };
  const project = 'local/live-agent-test';
  for (const name of ['alpha', 'beta']) {
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: {
        entity: 'local',
        project: 'live-agent-test',
        name,
        displayName: 'Synthetic ' + name,
        config: { seed: { value: name === 'alpha' ? 1 : 2 } },
      },
    });
    await call('/files/' + project + '/' + name + '/file_stream', {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: [
            JSON.stringify({ _step: 0, loss: 1, reward: 0 }),
            JSON.stringify({ _step: 1, loss: 0.5, reward: 1 }),
          ],
        },
      },
      complete: true,
      exitcode: 0,
    });
  }
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => summary.errors.push(e.message.replaceAll(apiKey, '[redacted]')));
  await page.goto(base + '/' + project + '/workspace');
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('tab', { name: en['assistant.title'], exact: true }).click();
  const settings = page.getByRole('dialog', { name: en['app.settings.title'], exact: true });
  await settings.getByRole('combobox', { name: 'Provider', exact: true }).fill(providerId);
  const providerInfo = (await call('/api/agent/providers')).providers.find(
    (p) => p.id === providerId,
  );
  assert.ok(providerInfo, 'Provider is available in Pi');
  await page.getByRole('option', { name: providerInfo.name, exact: true }).click();
  await settings.getByRole('textbox', { name: 'API key', exact: true }).fill(apiKey);
  await settings.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(settings.locator('.key-group .bx--inline-notification')).toContainText(
    'API key saved',
    {
      timeout: 15000,
    },
  );
  assert.equal(
    await settings.getByRole('textbox', { name: 'API key', exact: true }).inputValue(),
    '',
  );
  summary.checks.push('Browser saves provider key and clears secret field');
  const status = await call('/api/agent/providers');
  assert.ok(!JSON.stringify(status).includes(apiKey));
  assert.ok(status.providers.find((p) => p.id === providerId).configured);
  assert.ok(
    status.providers.some((p) => p.id === 'anthropic') &&
      status.providers.some((p) => p.id === 'openai'),
  );
  summary.checks.push('Multiple providers listed; secret absent from status');
  await settings.getByRole('combobox', { name: en['assistant.settings.model.label'], exact: true }).fill(modelId);
  const modelInfo = providerInfo.models.find((m) => m.id === modelId);
  assert.ok(modelInfo, 'Model is available in Pi');
  await page
    .getByRole('option', { name: providerInfo.name + ' / ' + modelInfo.name, exact: true })
    .click();
  await settings.getByRole('button', { name: en['assistant.settings.model.save'], exact: true }).click();
  await expect(settings.locator('.model-group .bx--inline-notification')).toContainText(
    en['assistant.settings.model.saved'],
  );
  await settings.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(settings.locator('.model-group .bx--inline-notification')).toContainText(
    'Connection successful',
    {
      timeout: 45000,
    },
  );
  summary.checks.push('Live provider connection check through settings');
  await settings
    .locator('.side-drawer-heading')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Assistant', exact: true });
  const text = drawer.locator('textarea');
  const stamp = Date.now(),
    name = 'Live agent ' + stamp;
  await text.fill(
    `Use the management tools on the synthetic project ${project}. Create a new saved view named "${name}". Add a line panel for loss titled "Loss comparison" and a line panel for reward titled "Reward comparison". Set visible runs to ${project}/alpha and ${project}/beta and solo BOTH runs while keeping both visible. Read the final view to verify it and report the result. Do not alter any other project.`,
  );
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, {
    timeout: 150000,
  });
  const views = (await call('/api/views')).views;
  const view = views.find((v) => v.name === name);
  assert.ok(view, 'Live agent created requested view');
  const saved = await call('/api/views/' + view.id);
  assert.deepEqual(saved.body.panels.map((p) => p.metric).sort(), ['loss', 'reward']);
  assert.deepEqual(saved.body.visible.sort(), [project + '/alpha', project + '/beta']);
  assert.deepEqual(saved.body.solo.sort(), [project + '/alpha', project + '/beta']);
  summary.checks.push('Live Pi creates view, adds panels, preserves independent multi-solo');

  const renamed = name + ' recovered';
  await call('/api/agent/credential/' + encodeURIComponent(providerId), undefined, 'DELETE');
  await text.fill(
    `Rename the existing saved view ${view.id} in synthetic project ${project} to "${renamed}". Keep its panels and run selections unchanged. Read the view to verify the result. Do not create another view or add panels.`,
  );
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(drawer).toContainText('Selected model is unavailable.');
  assert.equal((await call('/api/views/' + view.id)).name, name);
  await call('/api/agent/credential', { provider: providerId, key: apiKey });
  await drawer.getByRole('button', { name: 'Continue response', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, {
    timeout: 150000,
  });
  const recovered = await call('/api/views/' + view.id);
  assert.equal(recovered.name, renamed, 'Retry must send the original rename request');
  assert.deepEqual(recovered.body, saved.body);
  assert.equal((await call('/api/views')).views.length, views.length);
  summary.checks.push(
    'Live retry restores the original request after model access returns, preserving prior view changes',
  );

  console.log(JSON.stringify({ provider: providerId, model: modelId, ...summary }));
} catch (error) {
  summary.errors.push(String(error.message).replaceAll(apiKey, '[redacted]'));
  console.log(JSON.stringify({ provider: providerId, model: modelId, ...summary }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.app.close();
  await rm(dir, { recursive: true, force: true });
}
