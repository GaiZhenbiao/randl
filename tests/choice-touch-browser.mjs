import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const directory = await mkdtemp(join(tmpdir(), 'randl-choice-touch-')),
  errors = [],
  checks = [];
let server,
  provider,
  browser,
  providerRequests = 0;
try {
  provider = createHTTPServer((req, res) => {
    providerRequests++;
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(directory, 'models.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider('randl-choice-touch', {
    name: 'Touch provider',
    baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
    api: 'openai-completions',
    apiKey: 'synthetic-choice-fixture',
    models: ['alpha', 'beta'].map((id) => ({
      id: 'touch-' + id,
      name: 'Touch ' + id,
      reasoning: false,
      input: ['text'],
      contextWindow: 32768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  server = await createServer(join(directory, 'data'));
  server.agent.runtimeFactory = async () => runtime;
  const base = await listen(server);
  browser = await launchBrowser();
  for (const [width, height, language] of [
    [320, 844, 'en'],
    [390, 844, 'en'],
    [320, 568, 'en'],
    [568, 320, 'en'],
    [320, 844, 'ko'],
  ]) {
    const catalog = JSON.parse(
      await readFile(
        new URL('../frontend/src/locales/' + language + '.json', import.meta.url),
        'utf8',
      ),
    );
    const t = (key) => catalog[key] || key;
    await server.agent.select({ provider: 'randl-choice-touch', id: 'touch-alpha' });
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(
      (language) => localStorage.setItem('randl.language', language),
      language,
    );
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    let modelRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/agent/models')
        modelRequests++;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    const entry = page.getByRole('button', { name: t('assistant.title'), exact: true });
    await entry.tap();
    const drawer = page.getByRole('dialog', { name: t('assistant.title'), exact: true }),
      model = drawer.getByRole('combobox', { name: t('assistant.chat.model'), exact: true });
    await expect(model).toHaveValue('Touch provider / Touch alpha');
    const before = await server.db.call('settingGet', 'agent-model');
    await model.tap();
    assert.deepEqual(await server.db.call('settingGet', 'agent-model'), before);
    await expect(drawer.getByRole('option')).toHaveCount(3);
    await expect(
      drawer.getByRole('option', { name: 'Touch provider / Touch alpha', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(model.locator('xpath=..').locator('.bx--list-box__selection')).toBeHidden();
    const send = drawer.getByRole('button', { name: t('assistant.chat.send'), exact: true });
    const sendBox = await send.boundingBox(),
      fieldBox = await model.boundingBox();
    assert.ok(sendBox.width >= 44 && sendBox.height >= 44);
    assert.ok(Math.abs(sendBox.y - fieldBox.y) < 1);
    await model.press('Escape');
    await expect(model).toHaveValue('Touch provider / Touch alpha');
    await drawer.getByRole('textbox', { name: t('assistant.chat.messageLabel'), exact: true }).fill('draft');
    await model.focus();
    await expect(model).toHaveAttribute('aria-expanded', 'true');
    await model.press('Tab');
    await expect(send).toBeFocused();
    await expect(model).toHaveValue('Touch provider / Touch alpha');
    assert.deepEqual(await server.db.call('settingGet', 'agent-model'), before);
    await model.tap();
    await model.fill('zzz');
    await expect(
      drawer.locator('p[role="status"]', { hasText: t('common.combobox.noMatches') }),
    ).toBeVisible();
    // A model refresh (for example on window focus) waits until the menu closes.
    let requests = modelRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(300);
    await expect(model).toHaveValue('zzz');
    assert.equal(modelRequests, requests);
    await model.press('Escape');
    await expect(model).toHaveValue('Touch provider / Touch alpha');
    await expect.poll(() => modelRequests).toBe(requests + 1);
    await expect(
      drawer.locator('p[role="status"]', { hasText: t('common.combobox.noMatches') }),
    ).toHaveCount(0);
    await model.tap();
    await model.fill('Touch beta');
    const beta = drawer.getByRole('option', { name: 'Touch provider / Touch beta', exact: true });
    await expect(beta).toBeVisible();
    assert.ok((await beta.boundingBox()).height >= 44);
    for (const selector of ['.bx--list-box__menu-icon']) {
      const box = await model.locator('xpath=..').locator(selector).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44);
    }
    // A refresh deferred while the menu is open runs once after the selection is saved.
    requests = modelRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await beta.tap();
    await expect(model).toHaveValue('Touch provider / Touch beta');
    await expect
      .poll(() => server.db.call('settingGet', 'agent-model'))
      .toEqual({ provider: 'randl-choice-touch', id: 'touch-beta' });
    await expect.poll(() => modelRequests).toBe(requests + 1);
    await model.tap();
    await model.press('Escape');
    await expect(model).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: t('common.action.close'), exact: true }).tap();
    await page.getByRole('button', { name: t('app.settings.title'), exact: true }).tap();
    await page.getByRole('tab', { name: t('assistant.title'), exact: true }).tap();
    const settings = page.getByRole('dialog', { name: t('app.settings.title'), exact: true }),
      providerPicker = settings.getByRole('combobox', { name: t('assistant.settings.provider.label'), exact: true });
    await providerPicker.tap();
    await providerPicker.locator('xpath=..').locator('.bx--list-box__menu-icon').tap();
    await expect(providerPicker).toHaveAttribute('aria-expanded', 'false');
    await providerPicker.pressSequentially('Touch');
    await expect(providerPicker).toHaveValue('Touch');
    await providerPicker.fill('Touch provider');
    const option = settings.getByRole('option', { name: 'Touch provider', exact: true });
    await expect(option).toBeVisible();
    assert.ok((await option.boundingBox()).height >= 44);
    await option.tap();
    const settingsModel = settings.getByRole('combobox', { name: t('assistant.settings.model.label'), exact: true });
    await settingsModel.tap();
    await settingsModel.locator('xpath=..').locator('.bx--list-box__menu-icon').tap();
    await expect(settingsModel).toHaveAttribute('aria-expanded', 'false');
    await settingsModel.pressSequentially('Touch');
    await expect(settingsModel).toHaveValue('Touch');
    await settingsModel.press('Escape');
    await expect(settings).toBeVisible();
    assert.deepEqual(await server.db.call('settingGet', 'agent-model'), {
      provider: 'randl-choice-touch',
      id: 'touch-beta',
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close();
    checks.push(
      width +
        'x' +
        height +
        ' ' +
        language +
        ' coarse Assistant model and settings Provider retain44px targets, nested Escape and stored selections',
    );
  }
  assert.equal(providerRequests, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, providerRequests }, null, 2));
} catch (error) {
  console.error({ checks });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.app.close();
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
