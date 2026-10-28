import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const directory = await mkdtemp(join(tmpdir(), 'randl-agent-profile-browser-'));
const savedKey = process.env.DEEPSEEK_API_KEY;
const failures = [];
let server, browser;
try {
  process.env.DEEPSEEK_API_KEY = 'synthetic-profile-environment';
  const shared = join(directory, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await writeFile(
    join(shared, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'synthetic-shared-profile' } }),
    { mode: 0o600 },
  );
  server = await createServer(join(directory, 'data'), { piAgentDir: shared });
  const base = await listen(server);
  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'App settings', exact: true });
  async function selectProvider(id) {
    const p = (await server.agent.providers()).providers.find((p) => p.id === id);
    await dialog.getByRole('combobox', { name: 'Provider', exact: true }).fill(p.name);
    await page.getByRole('option', { name: p.name, exact: true }).click();
  }
  await selectProvider('deepseek');
  const providerPicker = dialog.getByRole('combobox', { name: 'Provider', exact: true });
  await providerPicker.click();
  assert.ok((await page.locator('.bx--list-box__menu-item:visible').count()) > 1);
  const imeDefaultPrevented = await providerPicker.evaluate((input) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(imeDefaultPrevented, false);
  await expect(providerPicker).toHaveAttribute('aria-expanded', 'true');
  await expect(providerPicker).toHaveValue('');
  await providerPicker.dispatchEvent('compositionend', { data: '' });
  await providerPicker.dispatchEvent('keyup', { key: 'Escape' });
  await expect(dialog).toBeVisible();
  await providerPicker.press('Escape');
  await expect(providerPicker).toHaveAttribute('aria-expanded', 'false');
  await expect(providerPicker).toHaveValue('DeepSeek');
  await providerPicker.press('ControlOrMeta+A');
  await providerPicker.pressSequentially('anthr');
  await expect(providerPicker).toHaveValue('anthr');
  await providerPicker.press('Enter');
  await providerPicker.press('Tab');
  await expect(providerPicker).toHaveValue('Anthropic');
  await selectProvider('deepseek');
  const keyboardModel = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await keyboardModel.focus();
  await keyboardModel.press('ControlOrMeta+A');
  await keyboardModel.pressSequentially('deepseek-flash');
  await expect(keyboardModel).toHaveValue('deepseek-flash');
  await keyboardModel.press('Enter');
  await expect(keyboardModel).toHaveValue('DeepSeek / DeepSeek V4.1 Flash');
  await keyboardModel.fill('DeepSeek');
  const visibleChoices = page.locator('.bx--list-box__menu-item:visible');
  await visibleChoices.nth(1).hover();
  await keyboardModel.fill('deepseek-flash');
  await keyboardModel.press('Enter');
  await expect(keyboardModel).toHaveValue('DeepSeek / DeepSeek V4.1 Flash');
  await keyboardModel.fill('DeepSeek');
  const hovered = (await visibleChoices.nth(1).innerText()).trim();
  await page.mouse.move(0, 0);
  await visibleChoices.nth(1).hover();
  await keyboardModel.press('Enter');
  await expect(keyboardModel).toHaveValue(hovered);
  for (const delay of [0, 100, 250]) {
    await keyboardModel.fill('gpt-5');
    await visibleChoices.nth(2).hover();
    await keyboardModel.pressSequentially('.4');
    await page.waitForTimeout(delay);
    const active = await keyboardModel.evaluate((input) =>
      document.getElementById(input.getAttribute('aria-activedescendant'))?.textContent?.trim(),
    );
    assert.equal(active, 'OpenAI / GPT-5.4');
    await keyboardModel.press('Enter');
    await expect(keyboardModel).toHaveValue('OpenAI / GPT-5.4');
    await providerPicker.fill('cloud');
    await visibleChoices.last().hover();
    await providerPicker.fill('op');
    await page.waitForTimeout(delay);
    const first = (await visibleChoices.first().innerText()).trim();
    await providerPicker.press('Enter');
    await expect(providerPicker).toHaveValue(first);
  }
  await selectProvider('deepseek');
  await keyboardModel.fill('Automatic');
  await keyboardModel.press('Enter');
  await expect(keyboardModel).toHaveValue('Automatic');
  await expect(
    keyboardModel.locator('..').getByRole('button', { name: 'Clear selected item' }),
  ).toHaveCount(0);
  await keyboardModel.fill('');
  await providerPicker.focus();
  await expect(keyboardModel).toHaveValue('Automatic');
  await expect(dialog.getByRole('button', { name: 'Save model', exact: true })).toBeDisabled();
  await selectProvider('amazon-bedrock');
  await expect(
    dialog.getByRole('button', { name: 'Sign in or configure with Pi', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  assert.ok(
    await dialog.evaluate(
      (el) =>
        !!(
          el.querySelector('.pi-setup').compareDocumentPosition(el.querySelector('.model-group')) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  );
  await selectProvider('deepseek');
  await dialog.getByRole('button', { name: 'Sign in or configure with Pi', exact: true }).click();

  await expect(dialog).toContainText("Credentials come from the server's environment variables.");
  const automaticTarget = (await server.agent.models()).automatic;
  let testedTarget;
  await page.route('**/api/agent/test', (route) => {
    testedTarget = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(dialog.locator('.model-group')).toContainText('Connection successful');
  assert.deepEqual(testedTarget, { provider: automaticTarget.provider, id: automaticTarget.id });
  await page.unroute('**/api/agent/test');

  await expect(dialog.getByRole('textbox', { name: 'API key', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Use a different API key', exact: true }).click();
  const key = dialog.getByRole('textbox', { name: 'API key', exact: true });
  await expect(key).toBeFocused();
  await key.fill('synthetic-unsaved');
  const initialModel = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await initialModel.click();
  await initialModel.press('Escape');
  await expect(initialModel).toHaveAttribute('aria-expanded', 'false');
  await expect(initialModel).toHaveValue('Automatic');
  await expect(key).toHaveValue('synthetic-unsaved');
  await key.focus();
  await key.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Use a different API key', exact: true }),
  ).toBeFocused();
  await dialog.getByRole('button', { name: 'Use a different API key', exact: true }).click();
  await expect(key).toHaveValue('');
  await key.fill('synthetic-saved-override');
  await dialog.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(dialog).toContainText('API key saved');
  await expect(key).toHaveValue('');
  await expect(key).toBeFocused();
  await dialog
    .locator('.key-group')
    .getByRole('button', { name: 'Close notification', exact: true })
    .click();
  await expect(key).toBeFocused();
  assert.equal(
    (await server.agent.providers()).providers.find((p) => p.id === 'deepseek').stored,
    true,
  );
  await expect(dialog).toContainText(
    'Keys saved or removed here also change the shared Pi profile:',
  );
  await dialog.getByRole('button', { name: 'Remove saved key', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Remove saved key?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.mouse.click(5, 5);
  await expect(confirmation).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog
    .locator('.key-group')
    .getByRole('button', { name: 'Remove saved key', exact: true })
    .click();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(
    dialog.locator('.key-group').getByRole('button', { name: 'Remove saved key', exact: true }),
  ).toBeFocused();
  assert.equal(
    (await server.agent.providers()).providers.find((p) => p.id === 'deepseek').stored,
    true,
  );
  await dialog
    .locator('.key-group')
    .getByRole('button', { name: 'Remove saved key', exact: true })
    .click();
  let releaseRemove;
  await page.route('**/api/agent/credential/deepseek', async (route) => {
    await new Promise((resolve) => {
      releaseRemove = resolve;
    });
    await route.continue();
  });
  await confirmation.getByRole('button', { name: 'Remove saved key', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Removing…', exact: true })).toBeDisabled();
  await expect.poll(() => typeof releaseRemove).toBe('function');
  releaseRemove();

  await expect(confirmation).not.toBeVisible();
  await expect(dialog).toContainText("Credentials come from the server's environment variables.");
  await expect(
    dialog.getByRole('button', { name: 'Use a different API key', exact: true }),
  ).toBeFocused();
  assert.equal(
    (await server.agent.providers()).providers.find((p) => p.id === 'deepseek').stored,
    false,
  );
  await page.unroute('**/api/agent/credential/deepseek');
  await selectProvider('openai');
  await expect(dialog.getByRole('button', { name: 'Replace API key', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Remove saved key', exact: true }).click();
  await expect(confirmation).toContainText(shared);
  await page.keyboard.press('Escape');
  await expect(confirmation).not.toBeVisible();
  await expect(dialog).toBeVisible();
  assert.ok(Object.hasOwn(JSON.parse(await readFile(join(shared, 'auth.json'), 'utf8')), 'openai'));
  await dialog.getByRole('button', { name: 'Remove saved key', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Remove saved key', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(dialog).toContainText('Saved API key removed');
  assert.equal(
    Object.hasOwn(JSON.parse(await readFile(join(shared, 'auth.json'), 'utf8')), 'openai'),
    false,
  );
  await dialog.getByRole('button', { name: 'Sign in or configure with Pi', exact: true }).click();
  await expect(dialog.locator('.pi-setup')).toContainText(shared);
  await dialog.getByRole('button', { name: 'Copy command', exact: true }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    server.agent.profile.information().setupCommand,
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);

    assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth));
  }
  await selectProvider('anthropic');
  await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
  // Pi writes after randl has already loaded this profile.
  const authPath = join(shared, 'auth.json');
  const credentials = JSON.parse(await readFile(authPath, 'utf8'));
  credentials.anthropic = { type: 'api_key', key: 'synthetic-external-login' };
  await writeFile(authPath, JSON.stringify(credentials), { mode: 0o600 });
  let releaseRefresh;
  await page.route('**/api/agent/providers', async (route) => {
    await new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Refresh providers', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Refreshing…', exact: true })).toBeDisabled();
  await expect.poll(() => typeof releaseRefresh).toBe('function');
  releaseRefresh();

  await expect(dialog).toContainText('Anthropic is configured');
  await page.unroute('**/api/agent/providers');
  const modelPicker = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await expect(modelPicker).toBeVisible();
  const item = (await server.agent.providers()).providers.find((p) => p.id === 'anthropic')
    .models[0];
  await modelPicker.fill(item.name);
  await page.getByRole('option', { name: 'Anthropic / ' + item.name, exact: true }).click();
  let releaseModel;
  await page.route('**/api/agent/model', async (route) => {
    await new Promise((resolve) => {
      releaseModel = resolve;
    });
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect.poll(() => typeof releaseModel).toBe('function');
  releaseModel();

  await expect(dialog.locator('.model-group')).toContainText('Model saved');
  await page.unroute('**/api/agent/model');
  assert.deepEqual((await server.agent.models()).selected, { provider: 'anthropic', id: item.id });
  await expect(dialog.getByRole('button', { name: 'Save model', exact: true })).toBeDisabled();
  await server.agent.credential('anthropic');
  await dialog.getByRole('button', { name: 'Sign in or configure with Pi', exact: true }).click();
  await dialog.getByRole('button', { name: 'Refresh providers', exact: true }).click();
  await expect(dialog).toContainText('Anthropic is not configured yet');
  await expect(modelPicker).toHaveValue('Anthropic / ' + item.name + ' (unavailable)');
  assert.deepEqual((await server.agent.models()).selected, { provider: 'anthropic', id: item.id });
  await modelPicker.fill('Automatic');
  await page.getByRole('option', { name: 'Automatic', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect.poll(async () => (await server.agent.models()).selected).toBe(null);
  await writeFile(authPath, JSON.stringify(credentials), { mode: 0o600 });
  await dialog.getByRole('button', { name: 'Refresh providers', exact: true }).click();
  await expect(dialog).toContainText('Anthropic is configured');
  await key.fill('synthetic-retained-draft');
  await page.route('**/api/agent/credential', (route) => route.abort());
  await dialog.getByRole('button', { name: 'Replace API key', exact: true }).click();
  await expect(dialog.locator('.key-group')).toContainText('API key was not saved');
  await expect(dialog.locator('.key-group')).toContainText('Unable to connect to randl.');
  await expect(key).toHaveValue('synthetic-retained-draft');
  await expect(key).toBeFocused();
  await page.unroute('**/api/agent/credential');
  await dialog
    .getByRole('combobox', { name: 'Provider', exact: true })
    .fill('unmatched-provider-query');
  await expect(dialog).toContainText('No matching options');
  await expect(key).toHaveCount(0);
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']) {
    const copy = JSON.parse(
      await readFile(
        new URL('../frontend/src/locales/' + locale + '.json', import.meta.url),
        'utf8',
      ),
    );
    for (const width of [1440, 390, 320]) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width < 760,
        isMobile: width < 760,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      await ctx.addInitScript((lang) => localStorage.setItem('randl.language', lang), locale);
      await ctx.route('**/*', (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
      );
      const tab = await ctx.newPage();
      tab.on('pageerror', (error) => failures.push(error.message));
      await tab.goto(base);
      await tab.getByRole('button', { name: copy['app.settings.title'], exact: true }).click();
      await tab.getByRole('tab', { name: copy['assistant.title'], exact: true }).click();
      const settings = tab.getByRole('dialog', { name: copy['app.settings.title'], exact: true });
      await settings
        .getByRole('button', { name: copy['assistant.settings.setup.title'], exact: true })
        .click();
      const copyButton = settings.getByRole('button', { name: copy['assistant.settings.setup.copyCommand'], exact: true });
      if (width < 760) await copyButton.tap();
      else {
        await copyButton.focus();
        await tab.keyboard.press('Enter');
      }
      await expect(tab.locator('.bx--tooltip-portal__content')).toHaveText(copy['common.status.copied']);
      await expect
        .poll(() => tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await expect(tab.locator('.bx--tooltip-portal__content')).not.toHaveText(copy['common.status.copied'], {
        timeout: 5000,
      });
      await expect
        .poll(() => tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await tab.mouse.move(0, 0);
      const snippetStyle = await settings.locator('.pi-setup .bx--snippet').evaluate((el) => ({
        surface: getComputedStyle(el).backgroundColor,
        drawer: getComputedStyle(el.closest('.side-drawer')).backgroundColor,
        bottom: getComputedStyle(el.querySelector('pre')).paddingBottom,
        top: getComputedStyle(el.querySelector('pre')).paddingTop,
        left: getComputedStyle(el.querySelector('pre')).paddingLeft,
        copy: getComputedStyle(el.querySelector('.bx--copy-btn')).backgroundColor,
      }));
      assert.notEqual(snippetStyle.surface, snippetStyle.drawer);
      assert.equal(snippetStyle.bottom, '0px');
      assert.equal(snippetStyle.top, '0px');
      assert.equal(snippetStyle.left, '0px');
      assert.equal(snippetStyle.copy, snippetStyle.surface);
      if (width === 390 || width === 320) {
        const catalog = (await server.agent.providers()).providers;
        for (const providerId of ['anthropic', 'openai-codex']) {
          const providerInfo = catalog.find((p) => p.id === providerId),
            providerName = providerInfo.name;
          const label = (key) => copy[key].replaceAll('{provider}', providerName);
          let oauthConfigured = true,
            apiKeyConfigured = false,
            overrideSaves = 0,
            deleteMode = 'failure',
            finishSignOut;
          await ctx.route('**/api/agent/providers', async (route) => {
            const response = await route.fetch(),
              data = await response.json();
            Object.assign(
              data.providers.find((p) => p.id === providerId),
              {
                configured: oauthConfigured || apiKeyConfigured,
                stored: apiKeyConfigured,
                credentialType: apiKeyConfigured ? 'api_key' : oauthConfigured ? 'oauth' : null,
                credentialSource: oauthConfigured || apiKeyConfigured ? 'stored' : null,
              },
            );
            await route.fulfill({ response, json: data });
          });
          await ctx.route('**/api/agent/credential', async (route) => {
            assert.equal(route.request().postDataJSON().provider, providerId);
            apiKeyConfigured = true;
            oauthConfigured = false;
            overrideSaves++;
            await route.fulfill({ json: { saved: true } });
          });
          await ctx.route('**/api/agent/credential/' + providerId, async (route) => {
            if (deleteMode === 'failure') {
              await new Promise((resolve) => {
                finishSignOut = resolve;
              });
              return route.fulfill({ status: 500, json: { error: 'Synthetic sign-out failure' } });
            }
            oauthConfigured = false;
            await route.fulfill({ json: { saved: false } });
          });
          await tab.reload();
          await tab.getByRole('button', { name: copy['app.settings.title'], exact: true }).click();
          await tab.getByRole('tab', { name: copy['assistant.title'], exact: true }).click();
          await settings
            .getByRole('combobox', { name: copy['assistant.settings.provider.label'], exact: true })
            .fill(providerName);
          await tab.getByRole('option', { name: providerName, exact: true }).tap();
          await expect(settings).toContainText(copy['assistant.settings.credentials.piSignIn']);
          await expect(
            settings.getByRole('button', { name: copy['assistant.settings.setup.useSignIn'], exact: true }),
          ).toHaveCount(0);
          await expect(settings).not.toContainText(
            copy['assistant.settings.credentials.external'],
          );
          if (providerInfo.apiKey) {
            await settings
              .getByRole('button', { name: copy['assistant.settings.apiKey.useInstead'], exact: true })
              .tap();
            await expect(settings).toContainText(
              copy['assistant.settings.apiKey.replacesSignIn'],
            );
            await settings.getByRole('button', { name: copy['common.action.cancel'], exact: true }).tap();
            await settings
              .getByRole('button', { name: copy['assistant.settings.apiKey.useInstead'], exact: true })
              .tap();
            const replacementNote = settings.getByText(
              copy['assistant.settings.apiKey.replacesSignIn'],
              { exact: true },
            );
            const keyField = settings.getByRole('textbox', { name: copy['assistant.settings.apiKey.label'], exact: true });
            await replacementNote.scrollIntoViewIfNeeded();
            const noteBox = await replacementNote.boundingBox(),
              keyBox = await keyField.boundingBox();
            assert.ok(noteBox.y + noteBox.height <= keyBox.y);
            assert.ok(await replacementNote.evaluate((el) => el.scrollWidth <= el.clientWidth));
            await keyField.fill('synthetic-oauth-replacement');
            await settings.getByRole('button', { name: copy['assistant.settings.apiKey.save'], exact: true }).tap();
            await expect(settings).toContainText(copy['assistant.settings.apiKey.saved']);
            assert.equal(overrideSaves, 1);
            await expect(tab.locator('.bx--modal.is-visible')).toHaveCount(0);
            await expect(settings).not.toContainText(copy['assistant.settings.credentials.piSignIn']);
            await expect(
              settings.getByRole('button', { name: copy['assistant.settings.setup.useSignIn'], exact: true }),
            ).toBeVisible();
            oauthConfigured = true;
            apiKeyConfigured = false;
            await tab.reload();
            await tab.getByRole('button', { name: copy['app.settings.title'], exact: true }).click();
            await tab.getByRole('tab', { name: copy['assistant.title'], exact: true }).click();
            await settings
              .getByRole('combobox', { name: copy['assistant.settings.provider.label'], exact: true })
              .fill(providerName);
            await tab.getByRole('option', { name: providerName, exact: true }).tap();
          }
          const signOut = settings.getByRole('button', { name: copy['assistant.settings.signOut.action'], exact: true });
          assert.ok(
            (await signOut.boundingBox()).width <
              (await settings.locator('.key-group').boundingBox()).width,
          );
          await signOut.tap();
          const signOutDialog = tab.getByRole('dialog', {
            name: label('assistant.settings.signOut.confirmTitle'),
            exact: true,
          });
          await expect(signOutDialog).toContainText(shared);
          await signOutDialog.getByRole('button', { name: copy['common.action.cancel'], exact: true }).tap();
          await expect(signOutDialog).not.toBeVisible();
          await expect(signOut).toBeFocused();
          await signOut.tap();
          await tab.keyboard.press('Escape');
          await expect(signOutDialog).not.toBeVisible();
          await expect(signOut).toBeFocused();
          await signOut.tap();
          await signOutDialog.getByRole('button', { name: copy['assistant.settings.signOut.action'], exact: true }).tap();
          await expect(
            settings.getByRole('button', { name: copy['assistant.settings.signOut.pending'], exact: true }),
          ).toBeDisabled();
          await expect.poll(() => typeof finishSignOut).toBe('function');
          finishSignOut();
          await expect(settings).toContainText(label('assistant.settings.signOut.failed'));
          await expect(signOut).toBeFocused();
          await settings
            .getByRole('button', { name: copy['common.notification.close'], exact: true })
            .tap();
          await expect(signOut).toBeFocused();
          deleteMode = 'success';
          await signOut.tap();
          await tab.waitForTimeout(200);
          await signOutDialog.evaluate((modal) => {
            window.confirmationTitles = [];
            const start = performance.now();
            function sample() {
              const style = getComputedStyle(modal);
              if (style.visibility !== 'hidden' && Number(style.opacity) > 0.02)
                window.confirmationTitles.push(
                  modal.querySelector('.bx--modal-header__heading').textContent.trim(),
                );
              if (performance.now() - start < 500) requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
          });
          await signOutDialog.getByRole('button', { name: copy['assistant.settings.signOut.action'], exact: true }).tap();
          await expect(settings).toContainText(label('assistant.settings.signOut.done'));
          await expect(
            providerInfo.apiKey
              ? settings.getByRole('textbox', { name: copy['assistant.settings.apiKey.label'], exact: true })
              : settings.getByRole('combobox', { name: copy['assistant.settings.provider.label'], exact: true }),
          ).toBeFocused();
          await expect(signOut).toHaveCount(0);
          await tab.waitForTimeout(550);
          const titles = await tab.evaluate(() => window.confirmationTitles);
          assert.ok(titles.length > 0);
          assert.ok(
            titles.every((title) => title === label('assistant.settings.signOut.confirmTitle')),
            JSON.stringify(titles),
          );
          await ctx.unroute('**/api/agent/providers');
          await ctx.unroute('**/api/agent/credential');
          await ctx.unroute('**/api/agent/credential/' + providerId);
        }
      }
      await ctx.close();
    }
  }
  await server.agent.select({ provider: 'anthropic', id: item.id });
  await server.agent.credential('anthropic');
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(
    (await server.agent.models()).models.length,
    0,
    'Last-credential fixture must have no available models',
  );
  await page.reload();
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
  const unavailablePicker = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await expect(unavailablePicker).toHaveValue('Anthropic / ' + item.name + ' (unavailable)');
  for (const theme of ['g10', 'g100']) {
    await page.evaluate((theme) => localStorage.setItem('randl.theme', theme), theme);
    await page.reload();
    await page.getByRole('button', { name: 'App settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await expect(unavailablePicker).toHaveValue('Anthropic / ' + item.name + ' (unavailable)');
    await unavailablePicker.click();
    // The menu opens unfiltered with no highlight; the saved unavailable model is listed first.
    await expect(unavailablePicker).toHaveValue('');
    await unavailablePicker.press('ArrowDown');
    const unavailableRow = dialog.locator('.model-group [role=option][aria-disabled="true"]');
    const readable = async () =>
      expect
        .poll(() =>
          unavailableRow.evaluate((row) => {
            const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
            const luminance = (color) =>
              rgb(color)
                .map((value) => {
                  const channel = value / 255;
                  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
            const text = getComputedStyle(
              row.querySelector('.bx--list-box__menu-item__option'),
            ).color;
            let surface = row,
              background = getComputedStyle(surface).backgroundColor;
            while (background === 'rgba(0, 0, 0, 0)' && surface.parentElement) {
              surface = surface.parentElement;
              background = getComputedStyle(surface).backgroundColor;
            }
            const a = luminance(text),
              b = luminance(background);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }),
        )
        .toBeGreaterThanOrEqual(4.5);
    await readable();
    const savedLabel = 'Anthropic / ' + item.name + ' (unavailable)';
    const saveModel = dialog.getByRole('button', { name: 'Save model', exact: true });
    await expect(unavailablePicker).toHaveAttribute(
      'aria-activedescendant',
      await unavailableRow.getAttribute('id'),
    );
    await expect(saveModel).toBeDisabled();
    await unavailablePicker.press('Enter');
    await expect(unavailablePicker).toHaveValue('');
    await expect(saveModel).toBeDisabled();
    await expect(unavailablePicker).toHaveAttribute('aria-expanded', 'true');
    await unavailablePicker.press('Escape');
    await expect(unavailablePicker).toHaveValue(savedLabel);
    await page.reload();
    await page.getByRole('button', { name: 'App settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await unavailablePicker.focus();
    await unavailablePicker.press('ArrowDown');
    await expect(unavailablePicker).toHaveAttribute(
      'aria-activedescendant',
      await unavailableRow.getAttribute('id'),
    );
    await unavailablePicker.press('Enter');
    await expect(unavailablePicker).toHaveAttribute('aria-expanded', 'true');
    await expect(saveModel).toBeDisabled();
    await page.getByRole('option', { name: 'Automatic', exact: true }).click();
    await unavailablePicker.click();
    await expect(unavailableRow).toHaveAttribute('aria-disabled', 'true');
    await readable();
    const box = await unavailableRow.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(unavailablePicker).toHaveAttribute('aria-expanded', 'true');
    await expect(unavailablePicker).toHaveValue('');
    assert.deepEqual((await server.agent.models()).selected, {
      provider: 'anthropic',
      id: item.id,
    });
    await unavailablePicker.press('Escape');
    await expect(unavailablePicker).toHaveValue('Automatic');
    await server.agent.credential('deepseek', 'synthetic-profile-enter-guard');
    const other = (await server.agent.models()).models.find(
      (model) => model.provider === 'deepseek',
    );
    await page.reload();
    await page.getByRole('button', { name: 'App settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await unavailablePicker.fill(other.name);
    await page.getByRole('option', { name: 'DeepSeek / ' + other.name, exact: true }).click();
    await unavailablePicker.click();
    await unavailablePicker.press('ArrowDown');
    await expect(unavailablePicker).toHaveAttribute(
      'aria-activedescendant',
      await unavailableRow.getAttribute('id'),
    );
    await unavailablePicker.press('Enter');
    await expect(unavailablePicker).toHaveAttribute('aria-expanded', 'true');
    await expect(saveModel).toBeEnabled();
    await unavailablePicker.press('Escape');
    await expect(unavailablePicker).toHaveValue('DeepSeek / ' + other.name);
    assert.deepEqual((await server.agent.models()).selected, {
      provider: 'anthropic',
      id: item.id,
    });
    await server.agent.credential('deepseek');
    await page.reload();
    await page.getByRole('button', { name: 'App settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await unavailablePicker.fill('Automatic');
    await page.getByRole('option', { name: 'Automatic', exact: true }).click();
  }
  await dialog.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(dialog).toContainText('Model saved');
  await expect(providerPicker).toBeFocused();
  await dialog.getByRole('button', { name: 'Close notification', exact: true }).click();
  await expect(providerPicker).toBeFocused();
  assert.deepEqual(failures, []);
  console.log(
    'PASS external-key override/cancel, keyboard focus, key removal fallback, shared-profile removal, command copy, 390/320px bounds',
  );
} finally {
  await browser?.close();
  await server?.app.close();
  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = savedKey;
  await rm(directory, { recursive: true, force: true });
}
