import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Agent } from '../backend/dist/agent.js';
import { DB } from '../backend/dist/db.js';
import { Plugins } from '../backend/dist/plugins.js';
import { Tools, toolCatalog } from '../backend/dist/tools.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function contentText(content) {
  return typeof content === 'string' ? content : content.map((part) => part.text || '').join('');
}

function streamResponse(response, { text, call, afterCall }) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const chunk = (delta, finish = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-randl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'tool-loop',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  chunk({ role: 'assistant' });
  if (text) chunk({ content: text });
  if (call) {
    const args = JSON.stringify(call.args);
    const middle = Math.floor(args.length / 2);
    chunk({
      tool_calls: [
        {
          index: 0,
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: args.slice(0, middle),
          },
        },
      ],
    });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] });
    if (afterCall) chunk({ content: afterCall });
    chunk({}, 'tool_calls');
  } else {
    chunk({}, 'stop');
  }
  response.end('data: [DONE]\n\n');
}

test(
  'real Pi streaming tool loop persists shared-tool edits and isolates cancellation',
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'randl-pi-loop-'));
    const previousDirectory = process.cwd();
    process.chdir(directory);
    t.after(() => {
      process.chdir(previousDirectory);
    });
    const db = new DB(join(directory, 'data'));
    const tools = new Tools(db, new Plugins(db, join(directory, 'data')));
    const requests = [];
    const providerErrors = [];
    const slowStarted = deferred();
    const slowClosed = deferred();
    let viewId;
    let agent;
    const first = await db.call('upsert', { entity: 'local', project: 'pi-test', name: 'visible' });
    const second = await db.call('upsert', { entity: 'local', project: 'pi-test', name: 'solo' });
    const provider = createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        let bytes = '';
        for await (const chunk of request) {
          bytes += chunk;
          assert.ok(bytes.length < 1024 * 1024, 'Unexpectedly large model request');
        }
        const body = JSON.parse(bytes);
        requests.push(body);
        assert.equal(body.model, 'tool-loop');
        assert.equal(body.stream, true);
        assert.deepEqual(
          new Set(body.tools.map((tool) => tool.function.name)),
          new Set(toolCatalog.map((tool) => tool.name)),
          'Pi must expose only the registered randl management tools',
        );
        const prompt = contentText(
          body.messages.filter((message) => message.role === 'user').at(-1).content,
        );
        const result = (id) =>
          body.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
        if (prompt === 'beta-isolated-request') {
          assert.ok(!JSON.stringify(body.messages).includes('alpha-private-request'));
          assert.ok(!JSON.stringify(body.messages).includes(viewId));
          streamResponse(response, { text: 'Beta has a separate conversation.' });
        } else if (prompt === 'wait-for-cancel') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write(': waiting for cancellation\n\n');
          response.on('close', () => slowClosed.resolve());
          slowStarted.resolve();
        } else if (prompt === 'clear-solo-alpha') {
          if (!result('clear-solo'))
            streamResponse(response, {
              call: {
                id: 'clear-solo',
                name: 'runs_select',
                args: { view: viewId, solo: [] },
              },
            });
          else streamResponse(response, { text: 'Solo cleared; visibility retained.' });
        } else {
          assert.equal(prompt, 'alpha-private-request');
          if (!result('create-view'))
            streamResponse(response, {
              text: '  Creating a comparison. 🧪',
              afterCall: ' The view will keep independent selections.',
              call: {
                id: 'create-view',
                name: 'view_create',
                args: { name: 'Pi-created comparison', project: 'local/pi-test' },
              },
            });
          else if (!result('select-runs')) {
            const created = JSON.parse(contentText(result('create-view').content));
            assert.equal(created.name, 'Pi-created comparison');
            viewId = created.id;
            streamResponse(response, {
              text: 'Selecting the runs.',
              call: {
                id: 'select-runs',
                name: 'runs_select',
                args: { view: viewId, visible: [first.id], solo: [second.id] },
              },
            });
          } else
            streamResponse(response, { text: 'Comparison created with independent selections.' });
        }
      } catch (error) {
        providerErrors.push(error);
        if (!response.headersSent)
          streamResponse(response, { text: 'The local fixture rejected this request.' });
        else response.end();
        slowStarted.resolve();
      }
    });
    t.after(async () => {
      if (agent?.activeId) await agent.cancel(agent.activeId);
      agent?.close();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await db.close();
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const runtime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(directory, 'models-cache.json'),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider('randl-test', {
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
      api: 'openai-completions',
      apiKey: 'test',
      models: [
        {
          id: 'tool-loop',
          name: 'Local protocol fixture',
          reasoning: false,
          input: ['text'],
          contextWindow: 32768,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    agent = new Agent(tools, join(directory, 'data'), undefined, async () => runtime);
    await agent.select({ provider: 'randl-test', id: 'tool-loop' });
    assert.deepEqual(await db.call('settingGet', 'agent-model'), {
      provider: 'randl-test',
      id: 'tool-loop',
    });
    const events = [];
    await agent.chat('alpha', 'alpha-private-request', (event) =>
      events.push(structuredClone(event)),
    );
    assert.deepEqual(providerErrors, []);
    assert.equal(requests.length, 3, 'Pi should continue after each tool result');
    const view = await db.call('view', viewId);
    assert.equal(view.name, 'Pi-created comparison');
    assert.deepEqual(view.body.visible, [first.id]);
    assert.deepEqual(view.body.solo, [second.id]);
    assert.deepEqual(
      events.filter((event) => event.type === 'tool_start').map((event) => event.name),
      ['view_create', 'runs_select'],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'tool_end').map((event) => [event.name, event.error]),
      [
        ['view_create', false],
        ['runs_select', false],
      ],
    );
    assert.ok(
      events.some((event) => event.type === 'text' && event.text.includes('Comparison created')),
    );
    assert.equal(events.at(-1).type, 'done');
    const saved = (await db.call('chatGet', { id: 'alpha' })).turns[0];
    const opening = 'Creating a comparison. 🧪 The view will keep independent selections.\n\n';
    const middle = 'Selecting the runs.\n\n';
    assert.equal(
      saved.response,
      opening + middle + 'Comparison created with independent selections.',
    );
    assert.deepEqual(
      saved.actions.map(({ at }) => at),
      [opening.length, opening.length + middle.length],
    );
    assert.equal(events.at(-1).turn.response, saved.response);
    assert.deepEqual(events.at(-1).turn.actions, saved.actions);
    let streamed = '';
    const sequence = [];
    for (const event of events) {
      if (event.type === 'text') streamed += event.text;
      if (event.type === 'tool_start') {
        assert.equal(
          event.at,
          streamed.length,
          'Tool position must match all preceding text deltas',
        );
        sequence.push(streamed.trim(), event.name);
      }
    }
    assert.deepEqual(sequence, [
      opening.trim(),
      'view_create',
      (opening + middle).trim(),
      'runs_select',
    ]);
    assert.equal(streamed.trim(), saved.response);

    await agent.chat('alpha', 'clear-solo-alpha', () => {});
    const cleared = await db.call('view', viewId);
    assert.deepEqual(cleared.body.visible, [first.id]);
    assert.deepEqual(cleared.body.solo, []);
    assert.deepEqual(
      (await db.call('auditList')).map((event) => event.tool),
      ['runs_select', 'runs_select', 'view_create'],
    );
    await agent.chat('beta', 'beta-isolated-request', () => {});
    assert.deepEqual(providerErrors, []);
    assert.equal(agent.sessions.size, 2);

    const pending = agent.chat('slow', 'wait-for-cancel', () => {});
    await slowStarted.promise;
    assert.deepEqual(providerErrors, []);
    assert.equal(agent.activeId, 'slow');
    await assert.rejects(agent.removeConversation('slow'), /Stop the active request/);
    assert.deepEqual(await agent.cancel('beta'), { cancelled: false });
    assert.equal(agent.busy, true, 'Another session must not cancel the active request');
    assert.deepEqual(await agent.cancel('slow'), { cancelled: true });
    await pending;
    await slowClosed.promise;
    assert.equal(agent.busy, false);
    assert.equal(agent.activeId, undefined);
    assert.deepEqual(await agent.removeConversation('slow'), { deleted: true });
    await assert.rejects(db.call('chatGet', { id: 'slow' }), /Conversation not found/);
    assert.ok(!agent.sessions.has('slow'));
    assert.equal((await db.call('views')).length, 1);
    assert.deepEqual(providerErrors, []);
  },
);
