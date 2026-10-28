import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createServer } from '../backend/dist/server.js';
import { toolCatalog } from '../backend/dist/tools.js';
import { launchBrowser } from './helpers.mjs';

// An isolated real Pi session with a local protocol fixture, not a mocked browser/API.
// Build first; PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH optionally selects Chromium.
const expect = baseExpect.configure({ timeout: 10_000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-agent-browser-'));
const previousDirectory = process.cwd();
process.chdir(directory);
let server, provider, browser, page;
const modelRequests = [];
let viewId,
  slowStarted = false,
  slowClosed = false,
  completeRetry = false;
const providerErrors = [],
  requests = [],
  browserErrors = [],
  externalRequests = [];
const textOf = (content) =>
  typeof content === 'string' ? content : content.map((part) => part.text || '').join('');

async function openAssistant(copy = { 'assistant.title': 'Assistant' }) {
  await page.locator('.bx--header').waitFor();
  const entry = page.getByRole('button', { name: copy['assistant.title'], exact: true });
  await entry.click();
}

let advanceInterleave,
  interleaveStep = 0;
const pauseInterleave = () =>
  new Promise((resolve) => {
    interleaveStep++;
    advanceInterleave = resolve;
  });
const openingText = '  **Inspecting** the workspace.';
const middleText = 'Reading the saved view.\n\n```text\nloss\n```';

async function respond(response, { text, call, pause }) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const chunk = (delta, finish = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-randl-browser-fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'browser-tool-loop',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  chunk({ role: 'assistant' });
  if (text) chunk({ content: text });
  if (pause) await pause();
  if (call) {
    const args = JSON.stringify(call.args),
      middle = Math.floor(args.length / 2);
    chunk({
      tool_calls: [
        {
          index: 0,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: args.slice(0, middle) },
        },
      ],
    });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] });
    chunk({}, 'tool_calls');
  } else {
    chunk({}, 'stop');
  }
  response.end('data: [DONE]\n\n');
}

try {
  provider = createHTTPServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      let bytes = '';
      for await (const chunk of request) {
        bytes += chunk;
        assert.ok(bytes.length < 1024 * 1024, 'Unexpectedly large fixture request');
      }
      const body = JSON.parse(bytes);
      requests.push(body);
      assert.equal(body.stream, true);
      assert.equal(body.model, 'browser-tool-loop');
      assert.deepEqual(
        new Set(body.tools.map((tool) => tool.function.name)),
        new Set(toolCatalog.map((tool) => tool.name)),
      );
      const prompt = textOf(
        body.messages.filter((message) => message.role === 'user').at(-1).content,
      );
      const result = (id) =>
        body.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
      if (prompt.endsWith('Add the browser fixture loss panel.')) {
        assert.ok(
          prompt.startsWith(
            `Current project: local/agent-browser. Current saved view: ${viewId}.\n\n`,
          ),
          'UI omitted current view context',
        );
        if (!result('inspect-workspace'))
          await respond(response, {
            text: openingText,
            call: { id: 'inspect-workspace', name: 'workspace_snapshot', args: {} },
          });
        else if (!result('read-view')) {
          await pauseInterleave();
          await respond(response, {
            text: middleText,
            call: { id: 'read-view', name: 'view_get', args: { id: viewId } },
          });
        } else if (!result('add-panel')) {
          assert.equal(JSON.parse(textOf(result('read-view').content)).id, viewId);
          await respond(response, {
            call: {
              id: 'add-panel',
              name: 'panel_add',
              args: { view: viewId, plugin: 'line', metric: 'loss', title: 'Pi browser loss' },
            },
          });
        } else {
          await pauseInterleave();
          await respond(response, {
            text: 'Added the loss panel to your current view.',
            pause: pauseInterleave,
          });
        }
      } else if (prompt.endsWith('Recover the original unavailable-model request.')) {
        assert.ok(result('add-panel'), 'Retry lost prior completed tool results');
        await respond(response, {
          text: 'The original request was sent after the model returned.',
        });
      } else if (prompt.endsWith('Wait for cancellation.')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(': waiting for cancellation\n\n');
        response.on('close', () => {
          slowClosed = true;
        });
        slowStarted = true;
      } else if (prompt.endsWith('Check the new conversation.')) {
        assert.equal(body.messages.filter((message) => message.role === 'user').length, 1);
        assert.equal(body.messages.filter((message) => message.role === 'tool').length, 0);
        assert.ok(!JSON.stringify(body.messages).includes('Add the browser fixture loss panel.'));
        await respond(response, { text: 'This conversation has no earlier messages.' });
      } else if (prompt.endsWith('Check restored conversation.')) {
        assert.ok(
          body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'add-panel'),
          'Restored Pi history lost completed tool results',
        );
        await respond(response, { text: 'The saved tool history is available.' });
      } else if (prompt.endsWith('Check edited conversation.')) {
        assert.ok(
          !body.messages.some(
            (m) =>
              m.role === 'user' && textOf(m.content).endsWith('Recover after provider failure.'),
          ),
          'Editing kept the replaced prompt',
        );
        await respond(response, { text: 'The edited prompt replaced the later conversation.' });
      } else if (prompt.endsWith('Recover after provider failure.')) {
        await respond(response, { text: 'The provider is available again.' });
      } else if (
        prompt.endsWith('Exercise provider failure.') ||
        prompt.startsWith('Continue the previous request.')
      ) {
        assert.ok(
          body.messages.some(
            (message) =>
              message.role === 'user' &&
              textOf(message.content).endsWith('Exercise provider failure.'),
          ),
        );
        if (completeRetry && prompt.startsWith('Continue the previous request.')) {
          await respond(response, { text: 'The retried request completed.' });
          return;
        }
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message: 'Local provider fixture rejected this request.',
              type: 'invalid_request_error',
              code: 'fixture_error',
            },
          }),
        );
      } else throw Error('Unexpected browser fixture prompt');
    } catch (error) {
      providerErrors.push(error.message);
      if (!response.headersSent)
        await respond(response, { text: 'The local protocol fixture rejected this request.' });
      else response.end();
    }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(directory, 'models-cache.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const providerConfig = {
    name: 'Browser provider',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    api: 'openai-completions',
    apiKey: 'local-fixture',
    models: [
      {
        id: 'browser-tool-loop',
        name: 'Local browser fixture',
        reasoning: false,
        input: ['text'],
        contextWindow: 32768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  runtime.registerProvider('randl-browser-fixture', providerConfig);
  runtime.registerProvider('randl-unavailable-fixture', {
    ...providerConfig,
    name: 'Unavailable provider',
    models: [{ ...providerConfig.models[0], name: 'Unavailable fixture' }],
  });
  server = await createServer(join(directory, 'data'));
  server.agent.runtimeFactory = async () => runtime;
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const baseURL = `http://127.0.0.1:${server.app.server.address().port}`;
  const run = await server.db.call('upsert', {
    entity: 'local',
    project: 'agent-browser',
    name: 'fixture-run',
  });
  const ingested = await server.app.inject({
    method: 'POST',
    url: '/files/local/agent-browser/fixture-run/file_stream',
    payload: {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: [JSON.stringify({ _step: 0, loss: 2 }), JSON.stringify({ _step: 1, loss: 1 })],
        },
      },
    },
  });
  assert.equal(ingested.statusCode, 200);
  const view = await server.tools.execute('view_create', {
    name: 'Assistant browser fixture',
    project: 'local/agent-browser',
  });
  viewId = view.id;
  await server.tools.execute('runs_select', { view: viewId, visible: [run.id], solo: [] });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL) return route.continue();
    externalRequests.push(url.origin);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/api/agent/model')
      modelRequests.push({
        body: response.request().postDataJSON(),
        status: response.status(),
        result: await response.text(),
      });
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto(`${baseURL}/local/agent-browser/workspace?view=${viewId}`);
  await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', viewId);
  await openAssistant();
  const drawer = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(drawer.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'Automatic',
  );
  assert.equal(modelRequests.length, 0, 'Opening Assistant must not save a model');
  await drawer.getByRole('combobox', { name: 'Model', exact: true }).fill('Local browser fixture');
  await page
    .getByRole('option', { name: 'Browser provider / Local browser fixture', exact: true })
    .click();
  await expect
    .poll(() => server.db.call('settingGet', 'agent-model'))
    .toEqual({ provider: 'randl-browser-fixture', id: 'browser-tool-loop' });
  runtime.unregisterProvider('randl-unavailable-fixture');
  const modelPicker = drawer.getByRole('combobox', { name: 'Model', exact: true });
  await modelPicker.fill('Unavailable fixture');
  await page
    .getByRole('option', { name: 'Unavailable provider / Unavailable fixture', exact: true })
    .click();
  await expect(drawer).toContainText('Model was not saved');
  await expect(modelPicker).toHaveValue('Browser provider / Local browser fixture');
  assert.deepEqual(await server.db.call('settingGet', 'agent-model'), {
    provider: 'randl-browser-fixture',
    id: 'browser-tool-loop',
  });
  console.log(
    'PASS refused model selection restores the saved model and shows action-local feedback',
  );
  const message = drawer.getByRole('textbox', { name: 'Message', exact: true });
  const send = async (text) => {
    await message.fill(text);
    await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  };
  await send('Add the browser fixture loss panel.');
  const assistant = drawer.locator('.assistant-message').first();
  const parts = assistant.locator(':scope > .chat-markdown, :scope > .chat-tool-actions');
  const partKinds = () => parts.evaluateAll((nodes) => nodes.map((node) => node.className));
  const expectedParts = [
    'chat-markdown',
    'chat-tool-actions',
    'chat-markdown',
    'chat-tool-actions',
    'chat-markdown',
  ];
  await expect.poll(partKinds).toEqual(expectedParts.slice(0, 2));
  await expect(parts.nth(0).locator('strong')).toHaveText('Inspecting');
  const firstTool = assistant.locator('summary').first();
  await expect(firstTool).toContainText('Completed');
  await expect(firstTool).toBeFocused();
  await firstTool.press('Enter');
  await expect(assistant.locator('details').first()).toHaveAttribute('open', '');
  await expect.poll(() => interleaveStep).toBe(1);
  advanceInterleave();
  await expect.poll(partKinds).toEqual(expectedParts.slice(0, 4));
  await expect(assistant.locator('summary').last()).toContainText('Completed');
  await expect(assistant.locator('summary').last()).toBeFocused();
  await expect(parts.nth(2).locator('pre code')).toHaveText('loss\n');
  await expect.poll(() => interleaveStep).toBe(2);
  advanceInterleave();
  await expect.poll(partKinds).toEqual(expectedParts);
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(parts.nth(4)).toHaveText('Added the loss panel to your current view.');
  await expect.poll(() => interleaveStep).toBe(3);
  advanceInterleave();
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect.poll(partKinds).toEqual(expectedParts);
  // The final trimmed turn must preserve the existing details element and its state.
  await expect(assistant.locator('details').first()).toHaveAttribute('open', '');
  await firstTool.press('Enter');
  const captureDirectory = join(previousDirectory, 'tmp', 'interleave-captures');
  await mkdir(captureDirectory, { recursive: true });
  for (const theme of ['g10', 'g100']) {
    for (const width of [390, 1440]) {
      await page.evaluate((theme) => localStorage.setItem('randl.theme', theme), theme);
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await openAssistant();
      await expect.poll(partKinds).toEqual(expectedParts);
      await expect(assistant.locator('details[open]')).toHaveCount(0);
      await expect(assistant.locator('summary')).toHaveCount(3);
      const boxes = await parts.evaluateAll((nodes) =>
        nodes.map((node) => {
          const { top, bottom, left, right } = node.getBoundingClientRect();
          return { top, bottom, left, right };
        }),
      );
      for (let index = 1; index < boxes.length; index++) {
        const gap = boxes[index].top - boxes[index - 1].bottom;
        assert.ok(gap >= 0 && gap <= 32, `Unexpected part spacing: ${gap}`);
      }
      assert.ok(boxes.every((box) => box.left >= 0 && box.right <= width));
      await page.screenshot({ path: join(captureDirectory, `${theme}-${width}.png`) });
    }
  }
  console.log(
    'PASS text/tool DOM order during streaming and reload, Markdown boundaries, tool focus and details state',
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await drawer
    .locator('.assistant-message')
    .first()
    .getByRole('button', { name: 'Copy message', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(
      openingText.trim() + '\n\n' + middleText + '\n\nAdded the loss panel to your current view.',
    );
  await message.fill('First line');
  await message.press('Shift+Enter');
  await message.press('End');
  await message.type('Second line');
  await expect(message).toHaveValue('First line\nSecond line');
  await message.fill('');

  for (const name of ['Workspace', 'Saved view', 'Add panel'])
    await expect(
      drawer.locator('.chat-tool-actions summary').filter({ hasText: name }),
    ).toContainText('Completed');
  await expect
    .poll(async () =>
      (await server.db.call('view', viewId)).body.panels.map((panel) => [
        panel.plugin,
        panel.metric,
        panel.title,
      ]),
    )
    .toEqual([['line', 'loss', 'Pi browser loss']]);
  await expect(
    page.getByRole('article', { name: 'Pi browser loss', exact: true }).locator('canvas'),
  ).toBeVisible();
  assert.ok(
    (await server.db.call('auditList')).some((entry) => entry.tool === 'panel_add'),
    'UI tool execution did not use shared audited management tools',
  );
  assert.equal(requests.length, 4, 'Pi did not continue after each tool result');
  console.log(
    'PASS Assistant model selection, real Pi streaming tools, saved panel and visible feedback',
  );

  const beforeUnavailableRequest = requests.length;
  runtime.unregisterProvider('randl-browser-fixture');
  await send('Recover the original unavailable-model request.');
  await expect(drawer).toContainText('Selected model is unavailable.');
  assert.equal(requests.length, beforeUnavailableRequest);
  const savedSelection = await server.db.call('settingGet', 'agent-model'),
    modelWrites = modelRequests.length;
  await page.reload();
  await openAssistant();
  await expect(modelPicker).toHaveValue('randl-browser-fixture / browser-tool-loop (unavailable)');
  assert.deepEqual(await server.db.call('settingGet', 'agent-model'), savedSelection);
  assert.equal(
    modelRequests.length,
    modelWrites,
    'Reloading an unavailable saved model must not clear it',
  );
  runtime.registerProvider('randl-unavailable-fixture', {
    ...providerConfig,
    name: 'Other fixture provider',
    models: [{ ...providerConfig.models[0], name: 'Other fixture model' }],
  });
  for (const theme of ['g10', 'g100']) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [320, 568],
    ]) {
      await page.evaluate((theme) => localStorage.setItem('randl.theme', theme), theme);
      await page.setViewportSize({ width, height });
      await page.reload();
      await openAssistant();
      await expect(modelPicker).toHaveValue(
        'randl-browser-fixture / browser-tool-loop (unavailable)',
      );
      await modelPicker.click();
      const unavailableOption = drawer.getByRole('option', {
        name: 'randl-browser-fixture / browser-tool-loop (unavailable)',
        exact: true,
      });
      await expect
        .poll(() =>
          unavailableOption.evaluate((row) => {
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
      await modelPicker.fill('fixture');
      await modelPicker.press('ArrowUp');
      await expect(modelPicker).toHaveAttribute(
        'aria-activedescendant',
        await unavailableOption.getAttribute('id'),
      );
      await modelPicker.press('Enter');
      await expect(modelPicker).toHaveValue('fixture');
      assert.deepEqual(await server.db.call('settingGet', 'agent-model'), savedSelection);
      await modelPicker.press('Escape');
    }
  }
  runtime.unregisterProvider('randl-unavailable-fixture');
  assert.equal(
    modelRequests.length,
    modelWrites,
    'Inspecting an unavailable choice must not save it',
  );
  await page.evaluate(() => localStorage.setItem('randl.theme', 'g10'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await openAssistant();
  console.log(
    'PASS unavailable model text remains readable in both themes at desktop and mobile widths',
  );
  runtime.registerProvider('randl-browser-fixture', providerConfig);
  await drawer.getByRole('button', { name: 'Continue response', exact: true }).click();
  await expect(drawer).toContainText('The original request was sent after the model returned.');
  await expect(drawer).not.toContainText('Selected model is unavailable.');
  assert.equal(requests.length, beforeUnavailableRequest + 1);
  await expect(modelPicker).toHaveValue('Browser provider / Local browser fixture');
  await expect(drawer).not.toContainText('Selected model is unavailable.');
  console.log(
    'PASS retry after an unavailable model sends the original request and retains earlier tool history',
  );

  await send('Wait for cancellation.');
  await expect.poll(() => slowStarted).toBe(true);
  await expect(message).toBeEnabled();
  await message.fill('Draft during generation');
  await expect(drawer.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  await drawer.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => slowClosed).toBe(true);
  await expect.poll(() => server.agent.busy).toBe(false);
  await expect(message).toBeEnabled();
  await expect(drawer.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled();
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  console.log('PASS Assistant Stop closes the real provider stream and restores input');

  await drawer.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(drawer.locator('.chat-message')).toHaveCount(0);
  assert.equal(
    (await server.db.call('chatList', {})).length,
    1,
    'Starting a conversation preserves saved history',
  );
  await send('Check the new conversation.');
  await expect(drawer).toContainText('This conversation has no earlier messages.');
  assert.equal(
    (await server.db.call('view', viewId)).body.panels.length,
    1,
    'Conversation reset removed saved work',
  );
  console.log(
    'PASS New conversation starts with empty model history and preserves saved conversations and workspace edits',
  );

  await send('Exercise provider failure.');
  await expect(drawer).toContainText('Local provider fixture rejected this request.');
  await expect(message).toBeEnabled();
  await expect(drawer.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  await send('Recover after provider failure.');
  await expect(drawer).toContainText('The provider is available again.');
  await expect(message).toBeEnabled();
  assert.deepEqual(providerErrors, []);
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log('PASS Provider failure appears in Assistant and the same conversation recovers');
  await drawer
    .locator('.user-message')
    .last()
    .getByRole('button', { name: 'Edit message', exact: true })
    .click();
  await expect(message).toHaveValue('Recover after provider failure.');
  await expect(drawer).toContainText('Later messages will be replaced.');
  await send('Check edited conversation.');
  await expect(drawer).toContainText('The edited prompt replaced the later conversation.');
  await expect(
    drawer.locator('.user-message').filter({ hasText: 'Recover after provider failure.' }),
  ).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Conversation history', exact: true }).click();
  await expect(drawer.locator('.conversation-row')).toHaveCount(2);
  await drawer
    .getByRole('searchbox', { name: 'Search conversations', exact: true })
    .fill('Add the browser fixture');
  await expect(drawer.locator('.conversation-row')).toHaveCount(1);
  const historyRow = drawer.locator('.conversation-row');
  await historyRow.getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Rename conversation', exact: true }).click();
  await drawer
    .getByRole('textbox', { name: 'Rename conversation', exact: true })
    .fill('Panel setup');
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await drawer
    .getByRole('searchbox', { name: 'Search conversations', exact: true })
    .fill('Panel setup');
  await expect(drawer.locator('.conversation-link')).toHaveCount(1);
  await drawer.locator('.conversation-link').click();
  await expect(drawer).toContainText('Added the loss panel to your current view.');
  await expect(message).toHaveValue('Draft during generation');
  await page.reload();
  await openAssistant();
  await expect(drawer).toContainText('Added the loss panel to your current view.');
  await expect(message).toHaveValue('Draft during generation');
  for (const item of server.agent.sessions.values()) item.session.dispose();
  server.agent.sessions.clear();
  await send('Check restored conversation.');
  await expect(drawer).toContainText('The saved tool history is available.');
  await drawer.getByRole('button', { name: 'Conversation history', exact: true }).click();
  const renamed = drawer.locator('.conversation-row').filter({ hasText: 'Panel setup' });
  const confirmation = page.getByRole('dialog', { name: 'Delete conversation?', exact: true });
  const actions = renamed.getByRole('button', { name: /Actions for/ });
  for (const [width, height] of [
    [390, 844],
    [568, 320],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    for (const close of ['Escape', 'Cancel']) {
      await actions.click();
      await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
      await expect(confirmation).toBeVisible();
      if (close === 'Escape') await page.keyboard.press('Escape');
      else await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect(actions).toBeFocused();
    }
  }
  await actions.click();
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect.poll(async () => (await server.db.call('chatList', {})).length).toBe(1);
  await expect(message).toBeFocused();
  assert.equal((await server.db.call('view', viewId)).body.panels.length, 1);
  assert.deepEqual(providerErrors, []);
  assert.deepEqual(browserErrors, []);
  console.log(
    'PASS edit, history search, rename, draft reload, restored Pi tool history and conversation deletion',
  );
  await drawer.getByRole('button', { name: 'New conversation', exact: true }).click();
  await send('Check the new conversation.');
  await expect(drawer).toContainText('This conversation has no earlier messages.');
  const refusedId = await page.evaluate(() => sessionStorage.getItem('randl.agent.conversation'));
  const refusedTurn = (await server.db.call('chatGet', { id: refusedId })).turns[0];
  refusedTurn.parentEntry = 'unsaved-model-change';
  await server.db.call('chatUpdate', refusedTurn);
  const beforeRefusal = await server.db.call('chatGet', { id: refusedId });
  await drawer
    .locator('.user-message')
    .first()
    .getByRole('button', { name: 'Edit message', exact: true })
    .click();
  await message.fill('Retain this edited draft after a refused request.');
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(drawer).toContainText(
    'The saved request context is unavailable. Start a new conversation.',
  );
  await expect(message).toHaveValue('Retain this edited draft after a refused request.');
  await expect(drawer.locator('.edit-message-notice')).toBeVisible();
  assert.equal(
    await page.evaluate((id) => sessionStorage.getItem('randl.agent.draft:' + id), refusedId),
    'Retain this edited draft after a refused request.',
  );
  assert.deepEqual(await server.db.call('chatGet', { id: refusedId }), beforeRefusal);
  console.log('PASS a refused edit preserves its draft, edit mode and saved conversation');
  await drawer.getByRole('button', { name: 'New conversation', exact: true }).click();
  const beforeUnsent = (await server.db.call('chatList', {})).length;
  const refuseBeforeTurn = (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'error',
          text: 'Agent is busy; wait or cancel the active request',
        }) + '\n',
    });
  await page.route('**/api/agent/chat', refuseBeforeTurn);
  await send('Retain this unsent draft after a refused request.');
  await expect(drawer).toContainText('Agent is busy; wait or cancel the active request');
  await expect(message).toHaveValue('Retain this unsent draft after a refused request.');
  assert.equal((await server.db.call('chatList', {})).length, beforeUnsent);
  await page.unroute('**/api/agent/chat', refuseBeforeTurn);
  console.log('PASS a pre-turn refusal preserves a new draft and its original error');
  await drawer.getByRole('button', { name: 'New conversation', exact: true }).click();
  const layoutId = await page.evaluate(() => sessionStorage.getItem('randl.agent.conversation'));
  for (let index = 0; index < 8; index++)
    await server.agent.chat(layoutId, 'Recover after provider failure.', () => {});
  for (const language of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']) {
    const copy = JSON.parse(
      await readFile(
        new URL('../frontend/src/locales/' + language + '.json', import.meta.url),
        'utf8',
      ),
    );
    for (const theme of ['g10', 'g100']) {
      for (const [width, height] of [
        [1440, 900],
        [390, 844],
        [320, 568],
      ]) {
        runtime.registerProvider('randl-unavailable-fixture', {
          ...providerConfig,
          name: 'Unavailable provider',
          models: [{ ...providerConfig.models[0], name: 'Unavailable fixture' }],
        });
        await page.evaluate(
          ([theme, language]) => {
            localStorage.setItem('randl.theme', theme);
            localStorage.setItem('randl.language', language);
          },
          [theme, language],
        );
        await page.setViewportSize({ width, height });
        await page.reload();
        await openAssistant(copy);
        const layoutDrawer = page.getByRole('dialog', { name: copy['assistant.title'], exact: true });
        const layoutModelPicker = layoutDrawer.getByRole('combobox', {
          name: copy['assistant.chat.model'],
          exact: true,
        });
        const layoutMessage = layoutDrawer.getByRole('textbox', {
          name: copy['assistant.chat.messageLabel'],
          exact: true,
        });
        await expect(layoutModelPicker).toHaveValue('Browser provider / Local browser fixture');
        const messages = layoutDrawer.locator('.agent-messages');
        await expect(layoutDrawer.locator('.assistant-message')).toHaveCount(8);
        await messages.evaluate((node) => (node.scrollTop = node.scrollHeight));
        await expect
          .poll(() =>
            messages.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
          )
          .toBeLessThanOrEqual(1);
        await layoutModelPicker.fill('Unavailable fixture');
        runtime.unregisterProvider('randl-unavailable-fixture');
        await layoutDrawer
          .getByRole('option', { name: 'Unavailable provider / Unavailable fixture', exact: true })
          .click();
        await expect(layoutDrawer).toContainText(copy['assistant.settings.model.saveFailed']);
        await expect
          .poll(() =>
            messages.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
          )
          .toBeLessThanOrEqual(1);
        const jump = layoutDrawer.getByRole('button', {
          name: copy['assistant.chat.jumpToLatest'],
          exact: true,
        });
        await expect(jump).toHaveCount(0);
        await messages.evaluate((node) => (node.scrollTop = 0));
        await expect(jump).toBeVisible();
        const button = await jump.boundingBox(),
          transcript = await layoutDrawer.locator('.chat-transcript').boundingBox(),
          composer = await layoutDrawer.locator('.chat-composer').boundingBox();
        assert.ok(
          button.y >= transcript.y && button.y + button.height <= transcript.y + transcript.height,
        );
        assert.ok(button.y + button.height <= composer.y, 'Jump control overlaps composer');
        assert.ok(
          await jump.evaluate((button) =>
            [...button.childNodes]
              .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
              .every((node) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return range.getClientRects().length === 1;
              }),
          ),
          'Jump label wraps',
        );
        await jump.click();
        await expect
          .poll(() =>
            messages.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
          )
          .toBeLessThanOrEqual(1);
        await expect(jump).toHaveCount(0);
        await messages.evaluate((node) => (node.scrollTop = 0));
        await expect(jump).toBeVisible();
        await layoutMessage.fill('Draft kept after a keyboard jump');
        const requestsBeforeJump = requests.length;
        await layoutMessage.focus();
        await page.keyboard.press('Shift+Tab');
        await expect(jump).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(layoutMessage).toBeFocused();
        await expect(layoutMessage).toHaveValue('Draft kept after a keyboard jump');
        await expect(jump).toHaveCount(0);
        assert.equal(requests.length, requestsBeforeJump, 'Keyboard jump submitted the draft');
        await layoutMessage.fill('');
        await layoutDrawer
          .locator('.chat-composer')
          .getByRole('button', { name: copy['common.notification.close'], exact: true })
          .click();
        await expect
          .poll(() =>
            messages.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
          )
          .toBeLessThanOrEqual(1);
      }
    }
  }
  await server.agent.chat(layoutId, 'Exercise provider failure.', () => {});
  const reachable = async (control) => {
    await control.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        control.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return (
            box.height > 0 &&
            box.y >= 0 &&
            box.bottom <= innerHeight + 1 &&
            !!hit &&
            (node === hit || node.contains(hit))
          );
        }),
      )
      .toBe(true);
  };
  for (const theme of ['g10', 'g100']) {
    for (const [width, height, enlarged] of [
      [568, 320, false],
      [390, 844, false],
      [568, 320, true],
      [320, 568, true],
      [1440, 600, true],
    ]) {
      runtime.registerProvider('randl-unavailable-fixture', {
        ...providerConfig,
        name: 'Unavailable provider',
        models: [{ ...providerConfig.models[0], name: 'Unavailable fixture' }],
      });
      await page.evaluate((theme) => {
        localStorage.setItem('randl.theme', theme);
        localStorage.setItem('randl.language', 'en');
      }, theme);
      await page.setViewportSize({ width, height });
      await page.reload();
      await openAssistant();
      await expect(drawer.locator('.assistant-message')).toHaveCount(9);
      await message.fill('Keep this draft while recovering the failed request.');
      if (width <= 760) {
        const sendButton = drawer.getByRole('button', { name: 'Send', exact: true });
        const closeDrawer = drawer.getByRole('button', { name: 'Close', exact: true });
        await sendButton.focus();
        await page.keyboard.press('Tab');
        await expect(closeDrawer).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(sendButton).toBeFocused();
        await reachable(sendButton);
      }
      if (enlarged) {
        await reachable(message);
        const box = await message.boundingBox();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height + 200, { steps: 12 });
        await page.mouse.up();
        assert.ok((await message.boundingBox()).height <= Math.min(200, height * 0.3) + 1);
        await modelPicker.fill('Unavailable fixture');
        runtime.unregisterProvider('randl-unavailable-fixture');
        await drawer
          .getByRole('option', { name: 'Unavailable provider / Unavailable fixture', exact: true })
          .click();
        await expect(drawer).toContainText('Model was not saved');
      }
      const transcript = drawer.locator('.chat-transcript');
      assert.ok(
        (await transcript.boundingBox()).height >= 96,
        'Conversation collapsed in a short viewport',
      );
      const messages = drawer.locator('.agent-messages');
      await messages.evaluate((node) => (node.scrollTop = 0));
      const jump = drawer.getByRole('button', { name: 'Jump to new messages', exact: true });
      await reachable(jump);
      const button = await jump.boundingBox(),
        area = await transcript.boundingBox(),
        composer = await drawer.locator('.chat-composer').boundingBox();
      assert.ok(button.y >= area.y && button.y + button.height <= area.y + area.height);
      assert.ok(button.y + button.height <= composer.y);
      await jump.click();
      await expect
        .poll(() =>
          messages.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
        )
        .toBeLessThanOrEqual(1);
      const retry = drawer.getByRole('button', { name: 'Continue response', exact: true });
      await reachable(retry);
      const beforeRetry = requests.length;
      await retry.click();
      await expect.poll(() => requests.length).toBe(beforeRetry + 1);
      await expect(retry).toBeEnabled();
      await expect(message).toHaveValue('Keep this draft while recovering the failed request.');
      await reachable(message);
      await reachable(drawer.getByRole('button', { name: 'Send', exact: true }));
      if (enlarged) {
        await messages.evaluate((node) => (node.scrollTop = 0));
        const beforeDismiss = await messages.evaluate((node) => node.scrollTop);
        const close = drawer
          .locator('.chat-composer')
          .getByRole('button', { name: 'Close notification', exact: true });
        await reachable(close);
        await close.click();
        assert.equal(await messages.evaluate((node) => node.scrollTop), beforeDismiss);
      }
    }
  }
  console.log(
    'PASS short portrait/landscape transcript, draft, refusal notice, Send and real Continue remain reachable in both themes',
  );
  completeRetry = true;
  for (const keyboard of [true, false]) {
    await server.agent.chat(layoutId, 'Exercise provider failure.', () => {});
    await page.setViewportSize({ width: 568, height: 320 });
    await page.reload();
    await openAssistant();
    await message.fill('Draft remains after the retry completes.');
    const retry = drawer.getByRole('button', { name: 'Continue response', exact: true });
    if (keyboard) {
      await message.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(retry).toBeFocused();
      await page.keyboard.press('Enter');
    } else await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(drawer.locator('.assistant-message').last()).toContainText(
      'The retried request completed.',
    );
    await expect(message).toHaveValue('Draft remains after the retry completes.');
    if (keyboard) await expect(message).toBeFocused();
    else await expect(message).not.toBeFocused();
  }
  completeRetry = false;
  const disposableConversation = crypto.randomUUID();
  await server.agent.chat(disposableConversation, 'Recover after provider failure.', () => {});
  await drawer.getByRole('button', { name: 'Conversation history', exact: true }).click();
  const disposableRow = drawer.locator(`[data-conversation-id="${disposableConversation}"]`);
  await disposableRow.getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect(disposableRow).toHaveCount(0);
  await expect(confirmation).toBeHidden();
  await expect(
    drawer.getByRole('searchbox', { name: 'Search conversations', exact: true }),
  ).toBeFocused();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  for (const theme of ['g10', 'g100']) {
    for (const [width, height] of [
      [390, 844],
      [568, 320],
      [1440, 900],
    ]) {
      await page.evaluate((theme) => localStorage.setItem('randl.theme', theme), theme);
      await page.setViewportSize({ width, height });
      await page.reload();
      for (const keyboard of [false, true]) {
        const trigger = page.getByRole('button', { name: 'App settings', exact: true });
        if (keyboard) {
          await trigger.focus();
          await page.keyboard.press('Enter');
        } else await trigger.click();
        const settings = page.getByRole('dialog', { name: 'App settings', exact: true });
        await expect(settings).toBeVisible();
        await expect
          .poll(() => settings.evaluate((node) => node.contains(document.activeElement)))
          .toBe(true);
        for (const index of [0, 3]) {
          const accent = settings.locator('input[name="accent"]').nth(index);
          await accent.check();
          await accent.focus();
          await page.keyboard.press('Tab');
          if (width <= 760) {
            await expect(
              settings.getByRole('button', { name: 'Close', exact: true }),
            ).toBeFocused();
            await page.keyboard.press('Shift+Tab');
            await expect(accent).toBeFocused();
          } else
            assert.equal(
              await settings.evaluate((node) => node.contains(document.activeElement)),
              false,
            );
        }
        await settings.locator('h2').focus();
        await page.keyboard.press('Escape');
        await expect(settings).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
    }
  }
  console.log(
    'PASS conversation confirmation/retry focus, settings initial focus and native radio-group Tab behavior',
  );

  assert.deepEqual(providerErrors, []);
  assert.deepEqual(browserErrors, []);
  console.log(
    'PASS composer growth and keyboard jumps preserve position/focus; the jump label fits in five languages, both themes and three sizes',
  );
} catch (error) {
  console.error(
    'Assistant browser diagnostics:',
    JSON.stringify({
      modelRequests,
      providerErrors,
      browserErrors,
      model: page
        ? await page
            .getByRole('combobox', { name: 'Model', exact: true })
            .inputValue({ timeout: 1000 })
            .catch(() => null)
        : null,
      messages: page ? await page.locator('.agent-messages').allTextContents() : [],
    }),
  );
  throw error;
} finally {
  await browser?.close();
  if (server?.agent.activeId) await server.agent.cancel(server.agent.activeId);
  await server?.app.close();
  if (provider) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
  process.chdir(previousDirectory);
  await rm(directory, { recursive: true, force: true });
}
