import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';

const oauthError =
  'Could not refresh the browser sign-in for this provider. Try again, or sign in again with Pi on the randl server.';
function isolateEnvironment() {
  const saved = new Map(
    Object.entries(process.env).filter(
      ([name]) =>
        /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|TOKEN)$/.test(name) ||
        /^(AWS_|GOOGLE_|GCLOUD_|AZURE_|ANTHROPIC_|CLOUDFLARE_|RANDL_PI_)/.test(name),
    ),
  );
  for (const name of saved.keys()) delete process.env[name];
  return () => {
    for (const [name, value] of saved) process.env[name] = value;
  };
}
function userTexts(body) {
  return (body.messages || body.input)
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => part.text || '').join(''),
    );
}
async function fixture() {
  const restoreEnvironment = isolateEnvironment();
  const directory = await mkdtemp(join(tmpdir(), 'randl-agent-recovery-'));
  const requests = [],
    profile = join(directory, 'pi');
  let server,
    mode = 'ok',
    anthropicDelay = 0,
    toolCalls = 0;
  const provider = httpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ provider: req.url.split('/')[1], body });
    if (req.url.split('/')[1] === 'anthropic') {
      if (anthropicDelay) await new Promise((r) => setTimeout(r, anthropicDelay));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event) =>
        res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      send({
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      const toolName = (body.tools || []).map((t) => t.name).find((n) => /project_create/i.test(n));
      if (mode === 'oauth-tool' && toolName) {
        send({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_recovery', name: toolName, input: {} },
        });
        send({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              id: 'local/recovery-project',
              name: 'Recovery project',
            }),
          },
        });
        send({ type: 'content_block_stop', index: 0 });
        send({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 3 },
        });
      } else {
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } });
        send({ type: 'content_block_stop', index: 0 });
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        });
      }
      send({ type: 'message_stop' });
      res.end();
      return;
    }
    if (
      mode === 'failure' ||
      (mode === 'tool-failure' &&
        body.messages?.some(
          (message) =>
            message.role === 'tool' && message.tool_call_id === 'create-recovery-project',
        ))
    ) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic provider failure' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.endsWith('/responses')) {
      res.end(
        'event: response.completed\ndata: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'recovery',
              status: 'completed',
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }) +
          '\n\n',
      );
      return;
    }
    const tool = mode === 'tool-failure';
    if (tool) toolCalls++;
    const delta = tool
      ? {
          role: 'assistant',
          content: 'Creating the recovery project.',
          tool_calls: [
            {
              index: 0,
              id: 'create-recovery-project',
              type: 'function',
              function: {
                name: 'project_create',
                arguments: JSON.stringify({
                  id: 'local/recovery-project',
                  name: 'Recovery project',
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'OK' };
    res.end(
      'data: ' +
        JSON.stringify({
          id: 'recovery',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  await mkdir(profile, { mode: 0o700 });
  await writeFile(
    join(profile, 'models.json'),
    JSON.stringify({
      providers: Object.fromEntries(
        ['deepseek', 'openai', 'anthropic'].map((id) => [
          id,
          { baseUrl: 'http://127.0.0.1:' + provider.address().port + '/' + id + '/v1' },
        ]),
      ),
    }),
  );
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' }),
  );
  server = await createServer(directory);
  for (const id of ['deepseek', 'openai'])
    await server.agent.credential(id, 'synthetic-recovery-' + id);
  return {
    get server() {
      return server;
    },
    requests,
    profile,
    providerOrigin: 'http://127.0.0.1:' + provider.address().port,
    set mode(value) {
      mode = value;
    },
    set anthropicDelay(value) {
      anthropicDelay = value;
    },
    get toolCalls() {
      return toolCalls;
    },
    async restart() {
      await server.app.close();
      server = await createServer(directory);
    },
    async close() {
      await server?.app.close();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await rm(directory, { recursive: true, force: true });
      restoreEnvironment();
    },
  };
}

test('a failed turn after a model change keeps its parent and earlier context through edit and restart', async () => {
  const f = await fixture();
  try {
    for (const restart of [false, true]) {
      const id = 'unpersisted-' + restart;
      await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
      await f.server.agent.chat(id, 'FIRST_PROMPT_MARKER', () => {});
      const openai = (await f.server.agent.models()).models.find(
        (model) => model.provider === 'openai',
      );
      await f.server.agent.select({ provider: openai.provider, id: openai.id });
      await f.server.agent.credential('openai');
      const requestCount = f.requests.length;
      await assert.rejects(
        () => f.server.agent.chat(id, 'SECOND_PROMPT_MARKER', () => {}),
        /Selected model is unavailable/,
      );
      assert.equal(f.requests.length, requestCount);
      const failed = (await f.server.db.call('chatGet', { id })).turns.at(-1);
      assert.ok(
        (await f.server.db.call('chatEntries', id)).some(
          (entry) => entry.id === failed.parentEntry,
        ),
      );
      if (restart) await f.restart();
      await f.server.agent.credential('openai', 'synthetic-restored-openai');
      await f.server.agent.chat(id, 'EDITED_PROMPT_MARKER', () => {}, { replaceTurn: failed.id });
      assert.deepEqual(userTexts(f.requests.at(-1).body), [
        'FIRST_PROMPT_MARKER',
        'EDITED_PROMPT_MARKER',
      ]);
    }
  } finally {
    await f.close();
  }
});

test('retry sends an unsubmitted original prompt, and continuation keeps a completed tool result without repeating the prompt', async () => {
  const f = await fixture();
  try {
    for (const restart of [false, true]) {
      const id = 'retry-unsubmitted-' + restart;
      await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
      await f.server.agent.chat(id, 'FIRST_PROMPT_MARKER', () => {});
      await f.server.agent.credential('deepseek');
      await assert.rejects(
        () => f.server.agent.chat(id, 'ORIGINAL_PROMPT_MARKER', () => {}),
        /Selected model is unavailable/,
      );
      const failed = (await f.server.db.call('chatGet', { id })).turns.at(-1);
      if (restart) await f.restart();
      await f.server.agent.credential('deepseek', 'synthetic-restored-deepseek');
      await f.server.agent.chat(id, 'RETRY_ARGUMENT_MUST_NOT_REPLACE_ORIGINAL', () => {}, {
        retryTurn: failed.id,
      });
      assert.deepEqual(userTexts(f.requests.at(-1).body), [
        'FIRST_PROMPT_MARKER',
        'ORIGINAL_PROMPT_MARKER',
      ]);
      const turns = (await f.server.db.call('chatGet', { id })).turns;
      assert.equal(turns.length, 2);
      assert.equal(turns.at(-1).status, 'completed');
    }
    f.mode = 'tool-failure';
    await f.server.agent.chat(
      'retry-after-tool',
      'Create the recovery project. TOOL_PROMPT_MARKER',
      () => {},
    );
    const failed = (await f.server.db.call('chatGet', { id: 'retry-after-tool' })).turns.at(-1);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.actions.length, 1);
    assert.equal(failed.actions[0].status, 'completed');
    assert.equal(failed.response, 'Creating the recovery project.');
    assert.equal(failed.actions[0].at, failed.response.length);
    assert.equal(f.toolCalls, 1);
    await f.restart();
    f.mode = 'ok';
    await f.server.agent.chat('retry-after-tool', failed.prompt, () => {}, {
      retryTurn: failed.id,
    });
    const continued = (await f.server.db.call('chatGet', { id: 'retry-after-tool' })).turns.at(-1);
    assert.equal(continued.response, failed.response + '\n\nOK');
    assert.deepEqual(continued.actions, failed.actions);
    const body = f.requests.at(-1).body,
      prompts = userTexts(body);
    assert.equal(prompts.filter((text) => text.includes('TOOL_PROMPT_MARKER')).length, 1);
    assert.match(prompts.at(-1), /^Continue the previous request\./);
    assert.ok(
      body.messages.some(
        (message) => message.role === 'tool' && message.tool_call_id === 'create-recovery-project',
      ),
    );
    assert.equal(f.toolCalls, 1);
    assert.equal(
      (await f.server.db.call('projects')).filter(
        (project) => project.id === 'local/recovery-project',
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('model selection refreshes credential availability and leaves the saved selection unchanged on failure', async () => {
  const f = await fixture();
  try {
    await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
    const openai = (await f.server.agent.models()).models.find(
      (model) => model.provider === 'openai',
    );
    const path = join(f.profile, 'auth.json'),
      auth = JSON.parse(await readFile(path, 'utf8'));
    delete auth.openai;
    await writeFile(path, JSON.stringify(auth));
    for (const loaded of [false, true]) {
      if (loaded) await f.server.agent.chat('selection', 'FIRST_PROMPT_MARKER', () => {});
      const count = f.requests.length;
      const response = await f.server.app.inject({
        method: 'POST',
        url: '/api/agent/model',
        payload: { provider: openai.provider, id: openai.id },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: 'Selected model is unavailable.',
        code: 'AGENT_MODEL_UNAVAILABLE',
        params: {},
      });
      assert.deepEqual((await f.server.agent.models()).selected, {
        provider: 'deepseek',
        id: 'deepseek-flash',
      });
      assert.equal(f.requests.length, count);
    }
    auth.openai = { type: 'api_key', key: 'synthetic-restored-openai' };
    await writeFile(path, JSON.stringify(auth));
    assert.deepEqual(await f.server.agent.select({ provider: openai.provider, id: openai.id }), {
      provider: openai.provider,
      id: openai.id,
    });
  } finally {
    await f.close();
  }
});

test('OAuth refresh failures have concise catalog-backed errors and recover after choosing another model', async () => {
  const f = await fixture(),
    fetchBefore = globalThis.fetch,
    calls = [];
  try {
    globalThis.fetch = async (input, options) => {
      const url = String(input?.url || input);
      if (new URL(url).origin === f.providerOrigin) return fetchBefore(input, options);
      calls.push(url);
      throw Error('Synthetic OAuth failure with a private path and stack');
    };
    const path = join(f.profile, 'auth.json'),
      auth = JSON.parse(await readFile(path, 'utf8'));
    auth.anthropic = {
      type: 'oauth',
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: Date.now() - 1000,
    };
    await writeFile(path, JSON.stringify(auth), { mode: 0o600 });
    const model = (await f.server.agent.models()).models.find(
      (item) => item.provider === 'anthropic',
    );
    await f.server.agent.select({ provider: model.provider, id: model.id });
    const response = await f.server.app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { session: 'oauth-failure', message: 'ORIGINAL_PROMPT_MARKER' },
    });
    const events = response.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.find((event) => event.type === 'error').text, oauthError);
    assert.equal(
      (await f.server.db.call('chatGet', { id: 'oauth-failure' })).turns.at(-1).error,
      oauthError,
    );
    const connection = await f.server.app.inject({
      method: 'POST',
      url: '/api/agent/test',
      payload: { provider: model.provider, id: model.id },
    });
    assert.equal(connection.statusCode, 400);
    assert.deepEqual(connection.json(), { error: oauthError, code: 'AGENT_OAUTH_REFRESH', params: {} });
    await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
    await f.server.agent.chat('selection-with-session', 'FIRST_PROMPT_MARKER', () => {});
    const selected = await f.server.app.inject({
      method: 'POST',
      url: '/api/agent/model',
      payload: { provider: model.provider, id: model.id },
    });
    assert.equal(selected.statusCode, 200);
    const failedSwitch = await f.server.app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { session: 'selection-with-session', message: 'AFTER_MODEL_SWITCH_MARKER' },
    });
    const switchEvents = failedSwitch.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(switchEvents.find((event) => event.type === 'error').text, oauthError);
    const failedTurn = (
      await f.server.db.call('chatGet', { id: 'selection-with-session' })
    ).turns.at(-1);
    assert.ok(
      (await f.server.db.call('chatEntries', 'selection-with-session')).some(
        (entry) => entry.id === failedTurn.parentEntry,
      ),
    );
    await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
    await f.server.agent.chat('selection-with-session', failedTurn.prompt, () => {}, {
      retryTurn: failedTurn.id,
    });
    assert.deepEqual(userTexts(f.requests.at(-1).body), [
      'FIRST_PROMPT_MARKER',
      'AFTER_MODEL_SWITCH_MARKER',
    ]);
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((url) => url === 'https://platform.claude.com/v1/oauth/token'));
    const english = JSON.parse(
      await readFile(new URL('../frontend/src/locales/en.json', import.meta.url), 'utf8'),
    );
    assert.equal(english['assistant.errors.oauthRefresh'], oauthError);
  } finally {
    globalThis.fetch = fetchBefore;
    await f.close();
  }
});

test('idle eviction after a model change preserves saved context for retry and edit', async () => {
  const f = await fixture(),
    fetchBefore = globalThis.fetch;
  try {
    globalThis.fetch = (input, options) => {
      if (new URL(String(input?.url || input)).origin === f.providerOrigin)
        return fetchBefore(input, options);
      throw Error('Synthetic expired browser sign-in');
    };
    const path = join(f.profile, 'auth.json'),
      auth = JSON.parse(await readFile(path, 'utf8'));
    auth.anthropic = {
      type: 'oauth',
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: Date.now() - 1000,
    };
    await writeFile(path, JSON.stringify(auth));
    const model = (await f.server.agent.models()).models.find((m) => m.provider === 'anthropic');
    for (const operation of ['retryTurn', 'replaceTurn']) {
      const id = 'idle-' + operation;
      await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
      await f.server.agent.chat(id, 'FIRST_PROMPT_MARKER', () => {});
      await f.server.agent.select({ provider: model.provider, id: model.id });
      f.server.agent.sessions.get(id).last -= 21 * 60 * 1000;
      await assert.rejects(() => f.server.agent.chat(id, 'SECOND_PROMPT_MARKER', () => {}), {
        message: oauthError,
      });
      const failed = (await f.server.db.call('chatGet', { id })).turns.at(-1);
      assert.ok(
        (await f.server.db.call('chatEntries', id)).some(
          (entry) => entry.id === failed.parentEntry,
        ),
      );
      await f.restart();
      await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
      await f.server.agent.chat(id, 'EDITED_PROMPT_MARKER', () => {}, { [operation]: failed.id });
      assert.deepEqual(userTexts(f.requests.at(-1).body), [
        'FIRST_PROMPT_MARKER',
        operation === 'retryTurn' ? 'SECOND_PROMPT_MARKER' : 'EDITED_PROMPT_MARKER',
      ]);
    }
  } finally {
    globalThis.fetch = fetchBefore;
    await f.close();
  }
});

test('invalid retries and missing saved parents preserve every completed turn and session entry', async () => {
  const f = await fixture();
  try {
    const id = 'refused-retry';
    await f.server.agent.chat(id, 'FIRST_PROMPT_MARKER', () => {});
    const complete = await f.server.db.call('chatGet', { id });
    const entries = await f.server.db.call('chatEntries', id);
    for (const retryTurn of [complete.turns[0].id, 'unknown-turn']) {
      await assert.rejects(
        () => f.server.agent.chat(id, 'ignored', () => {}, { retryTurn }),
        /Request cannot be retried/,
      );
      assert.deepEqual(await f.server.db.call('chatGet', { id }), complete);
      assert.deepEqual(await f.server.db.call('chatEntries', id), entries);
    }
    await f.server.agent.credential('deepseek');
    await f.server.agent.credential('openai');
    await assert.rejects(() => f.server.agent.chat(id, 'UNSENT_PROMPT_MARKER', () => {}));
    const failed = (await f.server.db.call('chatGet', { id })).turns.at(-1);
    // Reproduce the old model-change boundary that was never checkpointed.
    failed.parentEntry = 'unsaved-model-change';
    await f.server.db.call('chatUpdate', failed);
    const before = await f.server.db.call('chatGet', { id });
    for (const operation of ['retryTurn', 'replaceTurn']) {
      await assert.rejects(
        () => f.server.agent.chat(id, 'ignored', () => {}, { [operation]: failed.id }),
        /saved request context is unavailable/,
      );
      assert.deepEqual(await f.server.db.call('chatGet', { id }), before);
      assert.deepEqual(await f.server.db.call('chatEntries', id), entries);
    }
  } finally {
    await f.close();
  }
});

test('preflight failure stays retryable when checkpoint writes are unavailable', async () => {
  const f = await fixture();
  try {
    const id = 'checkpoint-failure';
    await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
    await f.server.agent.chat(id, 'FIRST_PROMPT_MARKER', () => {});
    await f.server.agent.credential('deepseek');
    const originalCall = f.server.db.call.bind(f.server.db);
    let checkpointCalls = 0;
    f.server.db.call = (method, args) => {
      if (method === 'chatCheckpoint') {
        checkpointCalls++;
        return Promise.reject(Error('SQLITE_FULL synthetic'));
      }
      return originalCall(method, args);
    };
    await assert.rejects(
      () => f.server.agent.chat(id, 'SECOND_PROMPT_MARKER', () => {}),
      /Selected model is unavailable/,
    );
    const failed = (await originalCall('chatGet', { id })).turns.at(-1);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Selected model is unavailable.');
    assert.equal(checkpointCalls, 0);
    f.server.db.call = originalCall;
    await f.server.agent.credential('deepseek', 'synthetic-restored-deepseek');
    await f.server.agent.chat(id, 'ignored', () => {}, { retryTurn: failed.id });
    assert.deepEqual(userTexts(f.requests.at(-1).body), [
      'FIRST_PROMPT_MARKER',
      'SECOND_PROMPT_MARKER',
    ]);
  } finally {
    await f.close();
  }
});

test('OAuth refresh after a completed tool has concise errors in stream, saved turn, session and API', async () => {
  const f = await fixture(),
    fetchBefore = globalThis.fetch;
  try {
    globalThis.fetch = (input, options) => {
      if (new URL(String(input?.url || input)).origin === f.providerOrigin)
        return fetchBefore(input, options);
      throw Error('SYNTHETIC_PRIVATE_UPSTREAM_DETAIL');
    };
    const path = join(f.profile, 'auth.json'),
      auth = JSON.parse(await readFile(path, 'utf8'));
    auth.anthropic = {
      type: 'oauth',
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: Date.now() + 5 * 60000 + 6000,
    };
    await writeFile(path, JSON.stringify(auth));
    const model = (await f.server.agent.models()).models.find((m) => m.provider === 'anthropic');
    await f.server.agent.select({ provider: model.provider, id: model.id });
    f.mode = 'oauth-tool';
    f.anthropicDelay = 8000;
    const response = await f.server.app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { session: 'midturn', message: 'Create the recovery project' },
    });
    const events = response.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.find((event) => event.type === 'error').text, oauthError);
    const turn = (await f.server.db.call('chatGet', { id: 'midturn' })).turns.at(-1);
    assert.equal(turn.error, oauthError);
    assert.equal(turn.errorCode, 'AGENT_OAUTH_REFRESH');
    assert.equal(events.find((event) => event.type === 'error').code, 'AGENT_OAUTH_REFRESH');
    assert.equal(turn.actions[0].status, 'completed');
    const entries = await f.server.db.call('chatEntries', 'midturn');
    assert.equal(
      entries.find((entry) => entry.message?.errorMessage).message.errorMessage,
      oauthError,
    );
    const api = await f.server.app.inject({ method: 'GET', url: '/api/conversations/midturn' });
    for (const surface of [response.body, JSON.stringify(turn), JSON.stringify(entries), api.body])
      assert.doesNotMatch(
        surface,
        /platform\.claude\.com|stack=|file:\/\/|SYNTHETIC_PRIVATE_UPSTREAM_DETAIL/,
      );
  } finally {
    globalThis.fetch = fetchBefore;
    await f.close();
  }
});

test('model labels retain provider and model display names when credentials disappear, and preserve unknown IDs as fallback', async () => {
  const f = await fixture();
  try {
    await f.server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
    const available = await f.server.agent.models();
    const chosen = available.models.find(
      (model) => model.provider === 'deepseek' && model.id === 'deepseek-flash',
    );
    assert.equal(chosen.providerName, 'DeepSeek');
    assert.equal(chosen.name, 'DeepSeek V4.1 Flash');
    assert.deepEqual(available.selected, { provider: 'deepseek', id: 'deepseek-flash' });
    await f.server.agent.credential('deepseek');
    const unavailable = await f.server.agent.models();
    assert.ok(!unavailable.models.some((model) => model.provider === 'deepseek'));
    assert.deepEqual(unavailable.selectedDetails, {
      providerName: chosen.providerName,
      name: chosen.name,
    });
    assert.deepEqual(unavailable.selected, available.selected);
    await f.server.db.call('settingSet', 'agent-model', {
      provider: 'unknown-provider',
      id: 'unknown-model',
    });
    await f.restart();
    const unknown = await f.server.agent.models();
    assert.deepEqual(unknown.selected, { provider: 'unknown-provider', id: 'unknown-model' });
    assert.deepEqual(unknown.selectedDetails, {
      providerName: 'unknown-provider',
      name: 'unknown-model',
    });
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});
