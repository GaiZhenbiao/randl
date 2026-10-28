import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';

test('displayed Automatic target matches real Pi requests; unavailable explicit models never fall back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-routing-'));
  const environment = new Map(
    [
      ...new Set([
        'DEEPSEEK_API_KEY',
        'OPENAI_API_KEY',
        'RANDL_PI_AGENT_DIR',
        ...Object.keys(process.env).filter(
          (name) =>
            /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|TOKEN)$/.test(name) ||
            /^(AWS_|GOOGLE_|GCLOUD_|AZURE_|ANTHROPIC_|CLOUDFLARE_)/.test(name),
        ),
      ]),
    ].map((name) => [name, process.env[name]]),
  );
  const requests = [];
  let server, provider;
  try {
    for (const name of environment.keys()) delete process.env[name];
    provider = httpServer(async (req, res) => {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes);
      requests.push({ provider: req.url.split('/')[1], id: body.model, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url.endsWith('/responses'))
        res.end(
          'event: response.completed\ndata: ' +
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'routing',
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            }) +
            '\n\n',
        );
      else
        res.end(
          'data: ' +
            JSON.stringify({
              id: 'routing',
              object: 'chat.completion.chunk',
              created: 1,
              model: body.model,
              choices: [
                { index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
        );
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const profile = join(directory, 'pi');
    await mkdir(profile, { mode: 0o700 });
    await writeFile(
      join(profile, 'models.json'),
      JSON.stringify({
        providers: Object.fromEntries(
          ['deepseek', 'openai'].map((id) => [
            id,
            {
              baseUrl: 'http://127.0.0.1:' + provider.address().port + '/' + id + '/v1',
            },
          ]),
        ),
      }),
    );
    await writeFile(
      join(profile, 'settings.json'),
      JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' }),
    );
    server = await createServer(directory);
    await server.agent.credential('deepseek', 'synthetic-routing-deepseek');
    await server.agent.credential('openai', 'synthetic-routing-openai');
    async function chatAndMatch() {
      const status = await server.agent.models(),
        expected = status.selected || status.automatic;
      assert.ok(expected);
      const before = requests.length,
        events = [];
      await server.agent.chat('routing-conversation', 'Reply with OK.', (event) =>
        events.push(event),
      );
      assert.ok(requests.length > before, 'Pi must contact the local provider');
      assert.equal(requests.at(-1).provider, expected.provider);
      assert.equal(requests.at(-1).id, expected.id);
      assert.equal(
        events.some((event) => event.type === 'error'),
        false,
        JSON.stringify(events.filter((event) => event.type === 'error')),
      );
    }
    assert.equal((await server.agent.models()).automatic.provider, 'deepseek');
    await chatAndMatch();
    const openai = (await server.agent.models()).models.find(
      (model) => model.provider === 'openai',
    );
    await server.agent.select({ provider: openai.provider, id: openai.id });
    await chatAndMatch();
    await server.agent.credential('openai');
    const before = requests.length,
      events = [];
    await assert.rejects(
      () =>
        server.agent.chat('routing-conversation', 'Reply again.', (event) => events.push(event)),
      /Selected model is unavailable/,
    );
    assert.equal(requests.length, before);
    assert.equal(
      (await server.db.call('chatGet', { id: 'routing-conversation' })).turns.at(-1).error,
      'Selected model is unavailable.',
    );
    assert.deepEqual((await server.agent.models()).selected, { provider: 'openai', id: openai.id });
    const authPath = join(profile, 'auth.json');
    async function externalKey(id) {
      const data = JSON.parse(await readFile(authPath, 'utf8'));
      data[id] = { type: 'api_key', key: 'synthetic-external-' + id };
      await writeFile(authPath, JSON.stringify(data), { mode: 0o600 });
    }
    await externalKey('openai');
    const [catalog, status] = await Promise.all([server.agent.providers(), server.agent.models()]);
    assert.ok(catalog.providers.find((item) => item.id === 'openai').configured);
    assert.ok(status.models.some((item) => item.provider === 'openai'));
    await chatAndMatch();
    await server.agent.select({ provider: '', id: '' });
    await chatAndMatch();
    await server.agent.credential('deepseek');
    assert.equal((await server.agent.models()).automatic.provider, 'openai');
    await chatAndMatch();
    await externalKey('deepseek');
    await Promise.all([server.agent.models(), server.agent.providers()]);
    assert.equal((await server.agent.models()).automatic.provider, 'deepseek');
    await chatAndMatch();
    // Refresh on the chat path itself, with no intervening settings request.
    await server.agent.select({ provider: '', id: '' });
    await server.agent.chat('direct-refresh', 'FIRST_REFRESH_MARKER', () => {});
    const withoutDefault = JSON.parse(await readFile(authPath, 'utf8'));
    delete withoutDefault.deepseek;
    await writeFile(authPath, JSON.stringify(withoutDefault), { mode: 0o600 });
    await server.agent.chat('direct-refresh', 'SECOND_REFRESH_MARKER', () => {});
    assert.equal(requests.at(-1).provider, 'openai');
    await externalKey('deepseek');
    await server.agent.chat('direct-refresh', 'THIRD_REFRESH_MARKER', () => {});
    assert.equal(requests.at(-1).provider, 'deepseek');
    assert.ok(JSON.stringify(requests.at(-1).body).includes('FIRST_REFRESH_MARKER'));
    assert.ok(JSON.stringify(requests.at(-1).body).includes('SECOND_REFRESH_MARKER'));

    for (const loaded of [true, false]) {
      for (const retryFirst of [false, true]) {
        const id = 'history-' + loaded + '-' + retryFirst;
        await server.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
        await server.agent.chat(id, 'FIRST_PROMPT_MARKER', () => {});
        const checkpoint = await server.db.call('chatEntries', id);
        const parent = checkpoint.findLast((entry) => entry.type !== 'session' && entry.id).id;
        if (!loaded) {
          server.agent.sessions.get(id).session.dispose();
          server.agent.sessions.delete(id);
        }
        await server.agent.credential('deepseek');
        const count = requests.length;
        await assert.rejects(
          () => server.agent.chat(id, 'SECOND_PROMPT_MARKER', () => {}),
          /Selected model is unavailable/,
        );
        assert.equal(requests.length, count);
        const failed = (await server.db.call('chatGet', { id })).turns.at(-1);
        assert.equal(failed.parentEntry, parent);
        await externalKey('deepseek');
        if (retryFirst) {
          await server.agent.chat(id, failed.prompt, () => {}, { retryTurn: failed.id });
          assert.equal((await server.db.call('chatGet', { id })).turns.at(-1).parentEntry, parent);
        }
        await server.agent.chat(id, 'EDITED_PROMPT_MARKER', () => {}, { replaceTurn: failed.id });
        const captured = JSON.stringify(requests.at(-1).body);
        assert.ok(
          captured.includes('FIRST_PROMPT_MARKER'),
          'Editing an unavailable-model turn must preserve earlier context',
        );
        assert.ok(captured.includes('EDITED_PROMPT_MARKER'));
      }
    }

    // A malformed defaults file is an explicit configuration error and recovers in place.
    const settingsPath = join(profile, 'settings.json'),
      savedSettings = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, '{ not json');
    assert.equal((await server.app.inject('/api/agent/providers')).statusCode, 200);
    const unavailableCatalog = await server.app.inject('/api/agent/models');
    assert.equal(unavailableCatalog.statusCode, 400);
    assert.deepEqual(unavailableCatalog.json(), {
      error: 'Assistant settings could not be loaded. Check the server configuration.',
      code: 'AGENT_SETTINGS_UNAVAILABLE',
      params: {},
    });
    const requestCount = requests.length;
    await assert.rejects(
      () => server.agent.chat('bad-settings', 'SETTINGS_RECOVERY_MARKER', () => {}),
      /^Error: Assistant settings could not be loaded\. Check the server configuration\.$/,
    );
    assert.equal(requests.length, requestCount);
    await writeFile(settingsPath, savedSettings);
    assert.equal((await server.app.inject('/api/agent/models')).statusCode, 200);
    await server.agent.chat('bad-settings', 'SETTINGS_RECOVERY_MARKER', () => {});
    assert.equal(requests.length, requestCount + 1);
    assert.ok(JSON.stringify(requests.at(-1).body).includes('SETTINGS_RECOVERY_MARKER'));

    server.agent.selectedModel = { provider: 'openai', id: 'removed-model' };
    const missingEvents = [],
      missingBefore = requests.length;
    await assert.rejects(
      () =>
        server.agent.chat('missing-model', 'Reply with OK.', (event) => missingEvents.push(event)),
      /Selected model is unavailable/,
    );
    assert.equal(requests.length, missingBefore);
    assert.equal(
      (await server.db.call('chatGet', { id: 'missing-model' })).turns.at(-1).error,
      'Selected model is unavailable.',
    );
    await server.agent.select({ provider: '', id: '' });
    await writeFile(authPath, '{}', { mode: 0o600 });
    const noProviderRequests = requests.length;
    await assert.rejects(
      () => server.agent.chat('no-provider', 'NO_PROVIDER_MARKER', () => {}),
      /^Error: Connect a provider in Assistant settings\.$/,
    );
    assert.equal(requests.length, noProviderRequests);
  } finally {
    await server?.app.close();
    provider?.closeAllConnections();
    if (provider) await new Promise((resolve) => provider.close(resolve));
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
