import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createServer } from '../backend/dist/server.js';
import test from 'node:test';
import { tmpdir } from 'node:os';
test('agent provider settings persist, serialize changes and keep key values private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-agent-settings-'));
  const keyA = 'synthetic-review-key-alpha',
    keyB = 'synthetic-review-key-beta';
  let server,
    mode = 'ok',
    requests = [],
    held = [],
    errorEcho = keyB;
  const provider = httpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ auth: req.headers.authorization, body });
    if (mode === 'error') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `Invalid key supplied: ${errorEcho}`, type: 'authentication_error' },
        }),
      );
      return;
    }
    if (mode === 'hold') {
      held.push(res);
      return;
    }
    if (req.url.endsWith('/responses')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: response.completed\ndata: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'fixture-response',
              status: 'completed',
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }) +
          '\n\n',
      );
      return;
    }
    reply(res);
  });
  function reply(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  }
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  async function runtime() {
    const r = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(directory, 'cache.json'),
      allowModelNetwork: false,
    });
    r.registerProvider('openai', {
      baseUrl: `http://127.0.0.1:${provider.address().port}`,
      api: 'openai-completions',
    });
    r.registerProvider('deepseek', {
      baseUrl: `http://127.0.0.1:${provider.address().port}`,
      api: 'openai-completions',
    });
    await r.refresh({ allowNetwork: false });
    return r;
  }
  async function start() {
    const r = await runtime();
    server = await createServer(join(directory, 'data'));
    server.agent.runtimeFactory = async () => r;
    return r;
  }
  async function inject(method, url, payload) {
    return server.app.inject({ method, url, ...(payload ? { payload } : {}) });
  }
  async function until(fn) {
    for (let i = 0; i < 100; i++) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('Timeout waiting for fixture');
  }
  const results = [];
  try {
    let r = await start();
    const initial = await inject('GET', '/api/agent/providers');
    assert.equal(initial.statusCode, 200);
    assert.ok(!initial.body.includes(keyA));
    for (const id of [
      'amazon-bedrock',
      'google-vertex',
      'cloudflare-ai-gateway',
      'cloudflare-workers-ai',
    ]) {
      const item = initial.json().providers.find((provider) => provider.id === id);
      assert.ok(item, id + ' must be present in the provider catalog');
      assert.equal(item.apiKey, false);
      assert.equal(item.serverSetup, true);
      assert.equal(
        (await inject('POST', '/api/agent/credential', { provider: id, key: keyA })).statusCode,
        400,
      );
    }
    assert.equal(
      (await inject('POST', '/api/agent/credential', { provider: 'deepseek', key: keyA }))
        .statusCode,
      200,
    );
    let status = (await inject('GET', '/api/agent/providers'))
      .json()
      .providers.find((p) => p.id === 'deepseek');
    assert.ok(status.stored && status.configured);
    assert.equal(
      (await inject('POST', '/api/agent/model', { provider: 'deepseek', id: 'deepseek-flash' }))
        .statusCode,
      200,
    );
    assert.equal(
      (await inject('POST', '/api/agent/test', { provider: 'deepseek', id: 'deepseek-flash' }))
        .statusCode,
      200,
    );
    assert.equal(requests.at(-1).auth, `Bearer ${keyA}`);
    assert.equal(
      (await inject('POST', '/api/agent/credential', { provider: 'deepseek', key: keyB }))
        .statusCode,
      200,
    );
    assert.equal(
      (await inject('POST', '/api/agent/test', { provider: 'deepseek', id: 'deepseek-flash' }))
        .statusCode,
      200,
    );
    assert.equal(requests.at(-1).auth, `Bearer ${keyB}`);
    results.push({
      check: 'Connect, replace, selected model, real Pi local completion',
      pass: true,
    });
    const secondModel = r.getModels('openai')[0].id;
    assert.equal(
      (await inject('POST', '/api/agent/credential', { provider: 'openai', key: keyA })).statusCode,
      200,
    );
    const secondResponse = await inject('POST', '/api/agent/test', {
      provider: 'openai',
      id: secondModel,
    });
    assert.equal(secondResponse.statusCode, 200, secondResponse.body);
    assert.equal(requests.at(-1).auth, `Bearer ${keyA}`);
    results.push({ check: 'Provider setup and testing also operate through OpenAI', pass: true });
    await server.app.close();
    r = await start();
    assert.deepEqual((await inject('GET', '/api/agent/models')).json().selected, {
      provider: 'deepseek',
      id: 'deepseek-flash',
    });
    assert.equal(
      (await inject('POST', '/api/agent/test', { provider: 'deepseek', id: 'deepseek-flash' }))
        .statusCode,
      200,
    );
    assert.equal(requests.at(-1).auth, `Bearer ${keyB}`);
    results.push({ check: 'Credential and model survive server/runtime restart', pass: true });
    mode = 'error';
    const errored = await inject('POST', '/api/agent/test', {
      provider: 'deepseek',
      id: 'deepseek-flash',
    });
    results.push({
      check: 'Provider error response redacts submitted key',
      pass: !errored.body.includes(keyB),
      status: errored.statusCode,
    });
    const events = [];
    await server.agent.chat('secret-review', 'Respond OK', (e) => events.push(e));
    results.push({
      check: 'Chat error events redact submitted key',
      pass: !JSON.stringify(events).includes(keyB),
    });
    mode = 'hold';
    held = [];
    const a = server.agent.testConnection('deepseek', 'deepseek-flash');
    const b = server.agent.testConnection('deepseek', 'deepseek-flash');
    const settled = Promise.allSettled([a, b]);
    await until(() => held.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    reply(held[0]);
    await a;
    results.push({
      check: 'Concurrent connection tests are mutually excluded',
      pass: held.length === 1,
      activeRequests: held.length,
      busyWhileSecondPending: server.agent.busy,
    });
    if (held[1]) reply(held[1]);
    await settled;
    mode = 'ok';
    assert.equal((await inject('DELETE', '/api/agent/credential/deepseek')).statusCode, 200);
    status = (await inject('GET', '/api/agent/providers'))
      .json()
      .providers.find((p) => p.id === 'deepseek');
    results.push({
      check: 'Removing saved key disconnects configured provider',
      pass: !status.stored && !status.configured,
    });
    // Simulate Pi CLI changing the same isolated auth store, with no private state involved.
    const external = await runtime();
    await external.login('deepseek', 'api_key', { prompt: async () => keyA, notify: () => {} });
    const stale = (await inject('GET', '/api/agent/providers'))
      .json()
      .providers.find((p) => p.id === 'deepseek');
    const listed = (await inject('GET', '/api/agent/models'))
      .json()
      .models.some((m) => m.provider === 'deepseek');
    results.push({
      check: 'Reopening settings after external Pi login refreshes availability',
      pass: stale.configured && listed,
      stored: stale.stored,
      configured: stale.configured,
      listed,
    });
    mode = 'ok';
    await server.agent.chat('rotation-review', 'Respond OK', () => {});
    const conversation = server.agent.sessions.get('rotation-review').session,
      history = JSON.stringify(conversation.messages);
    await server.agent.select({ provider: 'deepseek', id: 'deepseek-v4-pro' });
    assert.equal(server.agent.sessions.get('rotation-review').session, conversation);
    assert.equal(JSON.stringify(conversation.messages), history);
    await server.agent.credential('deepseek', keyA);
    assert.equal(server.agent.sessions.get('rotation-review').session, conversation);
    assert.equal(JSON.stringify(conversation.messages), history);
    results.push({ check: 'Changing model or API key preserves conversation history', pass: true });
    const keyC = 'synthetic-rotated-externally';
    await external.login('deepseek', 'api_key', { prompt: async () => keyC, notify: () => {} });
    mode = 'error';
    errorEcho = keyC;
    const rotatedEvents = [];
    await server.agent.chat('rotation-review', 'Respond again', (e) => rotatedEvents.push(e));
    results.push({
      check: 'Existing conversation redacts externally rotated key',
      pass: !JSON.stringify(rotatedEvents).includes(keyC),
    });
    mode = 'ok';
    const literalBang = '!synthetic-literal-key';
    assert.equal(
      (await inject('POST', '/api/agent/credential', { provider: 'deepseek', key: literalBang }))
        .statusCode,
      200,
    );
    const bangTest = await inject('POST', '/api/agent/test', {
      provider: 'deepseek',
      id: 'deepseek-flash',
    });
    results.push({
      check: 'Leading exclamation mark remains literal key data',
      pass: bangTest.statusCode === 200 && requests.at(-1).auth === `Bearer ${literalBang}`,
    });
    const literalKey = 'synthetic-$MISSING_VARIABLE-${ALSO_MISSING}-$$-$!-key';
    assert.equal(
      (await inject('POST', '/api/agent/credential', { provider: 'deepseek', key: literalKey }))
        .statusCode,
      200,
    );
    const literalTest = await inject('POST', '/api/agent/test', {
      provider: 'deepseek',
      id: 'deepseek-flash',
    });
    results.push({
      check: 'Dollar signs in submitted API keys retain literal bytes',
      pass: literalTest.statusCode === 200 && requests.at(-1).auth === `Bearer ${literalKey}`,
    });
    const noLeak = await inject('GET', '/api/agent/providers');
    assert.ok(!noLeak.body.includes(keyA) && !noLeak.body.includes(keyB));
    results.push({ check: 'Provider/model metadata never includes dummy keys', pass: true });
    for (const result of results) assert.equal(result.pass, true, result.check);
  } finally {
    await server?.app.close();
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    await rm(directory, { recursive: true, force: true });
  }
});
