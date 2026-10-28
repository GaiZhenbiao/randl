import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PiProfile } from '../backend/dist/pi-profile.js';
import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';

test('Pi profiles isolate credentials and defaults, and provider requests exclude server context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-pi-isolation-')),
    cwd = process.cwd();
  const savedEnvironment = new Map(
    ['PI_CODING_AGENT_DIR', 'RANDL_PI_AGENT_DIR', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].map(
      (name) => [name, process.env[name]],
    ),
  );
  const decoy = join(directory, 'decoy-pi'),
    poison = join(directory, 'working-directory'),
    aDir = join(directory, 'a'),
    bDir = join(directory, 'b'),
    sharedDir = join(directory, 'shared-pi');
  const requests = [],
    servers = [];
  let provider;
  const key = 'synthetic-isolation-key';
  try {
    await mkdir(decoy);
    await mkdir(join(poison, '.pi'), { recursive: true });
    await writeFile(join(poison, 'AGENTS.md'), 'PRIVATE_CONTEXT_MARKER_MUST_NOT_REACH_MODEL');
    await writeFile(join(poison, '.pi', 'SYSTEM.md'), 'PRIVATE_SYSTEM_MARKER_MUST_NOT_REACH_MODEL');
    process.chdir(poison);
    process.env.PI_CODING_AGENT_DIR = decoy;
    delete process.env.RANDL_PI_AGENT_DIR;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    provider = createHTTPServer(async (req, res) => {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes);
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'isolation',
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
    const models = {
      providers: Object.fromEntries(
        ['deepseek', 'openai'].map((name) => [
          name,
          {
            baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
            api: 'openai-completions',
          },
        ]),
      ),
    };
    async function prepare(profile) {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(join(profile, 'models.json'), JSON.stringify(models), { mode: 0o600 });
    }
    async function start(data, options = {}) {
      const server = await createServer(data, options);
      servers.push(server);
      return server;
    }
    await prepare(join(aDir, 'pi'));
    await prepare(join(bDir, 'pi'));
    let a = await start(aDir),
      b = await start(bDir);
    await a.agent.credential('deepseek', key);
    await a.agent.credential('openai', key + '-openai');
    let aProviders = await a.agent.providers(),
      bProviders = await b.agent.providers();
    assert.ok(aProviders.providers.find((p) => p.id === 'deepseek').stored);
    assert.ok(!bProviders.providers.find((p) => p.id === 'deepseek').configured);
    assert.equal(aProviders.configuration.directory, join(aDir, 'pi'));
    assert.equal(aProviders.configuration.shared, false);
    assert.equal(aProviders.configuration.environmentCredentials, true);
    assert.equal((await stat(join(aDir, 'pi'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(aDir, 'pi', 'auth.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(decoy), [], 'The inherited Pi directory must remain untouched');
    const openaiModel = aProviders.providers.find((p) => p.id === 'openai').models[0].id;
    await writeFile(
      join(poison, '.pi', 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai', defaultModel: openaiModel }),
    );
    await writeFile(
      join(aDir, 'pi', 'settings.json'),
      JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' }),
    );
    await a.agent.chat('isolated-conversation', 'Reply with OK.', () => {});
    assert.equal(
      requests.at(-1).model,
      'deepseek-flash',
      'Automatic must use the profile defaults, not the server cwd',
    );
    const allRequests = JSON.stringify(requests);
    for (const marker of [
      directory,
      poison,
      homedir(),
      'PRIVATE_CONTEXT_MARKER',
      'PRIVATE_SYSTEM_MARKER',
      '<cwd>',
    ])
      assert.ok(
        !allRequests.includes(marker),
        'Provider request included server context: ' +
          (marker.startsWith('PRIVATE') ? marker : 'path or cwd'),
      );
    assert.ok(allRequests.includes("randl's experiment management assistant"));
    await a.agent.select({ provider: 'deepseek', id: 'deepseek-flash' });
    await a.app.close();
    servers.splice(servers.indexOf(a), 1);
    a = await start(aDir);
    assert.ok((await a.agent.providers()).providers.find((p) => p.id === 'deepseek').stored);
    assert.deepEqual((await a.agent.models()).selected, {
      provider: 'deepseek',
      id: 'deepseek-flash',
    });
    await a.agent.chat('isolated-conversation', 'Reply with OK again.', () => {});
    assert.ok(
      requests.at(-1).messages.filter((message) => message.role === 'user').length >= 2,
      'Restart must restore conversation history',
    );
    assert.ok(!JSON.stringify(requests.at(-1)).includes(directory));
    await prepare(sharedDir);
    await writeFile(
      join(sharedDir, 'auth.json'),
      JSON.stringify({ deepseek: { type: 'api_key', key: 'synthetic-shared-key' } }),
      { mode: 0o600 },
    );
    const shared = await start(join(directory, 'shared-data'), { piAgentDir: sharedDir });
    const sharedProviders = await shared.agent.providers();
    assert.equal(sharedProviders.configuration.shared, true);
    assert.equal(sharedProviders.configuration.directory, sharedDir);
    assert.ok(sharedProviders.providers.find((p) => p.id === 'deepseek').stored);
    await shared.agent.credential('deepseek');
    assert.ok(
      !Object.hasOwn(JSON.parse(await readFile(join(sharedDir, 'auth.json'), 'utf8')), 'deepseek'),
    );
    process.env.RANDL_PI_AGENT_DIR = sharedDir;
    const envShared = await start(join(directory, 'env-data'));
    assert.equal(envShared.agent.profile.directory, sharedDir);
    assert.equal(envShared.agent.profile.shared, true);
    delete process.env.RANDL_PI_AGENT_DIR;
    const run = 'local/isolation/run',
      escape = encodeURIComponent('../../pi/auth.json');
    for (const path of [
      '/pi/auth.json',
      '/files/pi/auth.json',
      '/storage/pi/auth.json',
      '/api/run-files?run=' + run + '&path=' + escape,
      '/api/run-file-preview?run=' + run + '&path=' + escape,
      '/api/run-export?run=' + run + '&file=' + escape,
      '/storage/artifacts/unknown/files/' + escape,
    ]) {
      const response = await a.app.inject(path);
      assert.ok(response.statusCode >= 400, 'Private profile route should be refused: ' + path);
      assert.ok(!response.body.includes(key));
    }
    assert.deepEqual(await readdir(decoy), []);
  } finally {
    for (const server of servers) await server.app.close();
    provider?.closeAllConnections();
    if (provider) await new Promise((resolve) => provider.close(resolve));
    process.chdir(cwd);
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi setup command uses the installed CLI and quotes the selected profile path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-pi-command-'));
  try {
    const profile = new PiProfile(directory, join(directory, "profile's space $literal"));
    const { stdout } = await promisify(execFile)(
      'sh',
      ['-c', profile.information().setupCommand + ' --help'],
      { timeout: 30000 },
    );
    const captured = await promisify(execFile)('sh', [
      '-c',
      'npm() { printf "%s\\n" "$PI_CODING_AGENT_DIR" "$@"; }; ' +
        profile.information().setupCommand,
    ]);
    const [directoryArgument, ...argumentsPassed] = captured.stdout.trimEnd().split('\n');
    assert.equal(directoryArgument, profile.directory);
    assert.equal(argumentsPassed[0], 'exec');
    assert.equal(argumentsPassed[1], '--prefix');
    assert.deepEqual(argumentsPassed.slice(-3), ['--no', '--', 'pi']);
    assert.match(stdout, /Usage:|pi -|Options:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the existing credential endpoint signs out of an isolated or shared Pi OAuth profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-pi-signout-'));
  const originalFetch = globalThis.fetch;
  const environment = new Map(
    Object.entries(process.env).filter(([name]) => name.startsWith('ANTHROPIC_')),
  );
  const servers = [];
  let requests = 0;
  try {
    for (const name of environment.keys()) delete process.env[name];
    globalThis.fetch = async () => {
      requests++;
      throw Error('No provider request is allowed in the sign-out fixture');
    };
    for (const shared of [false, true]) {
      const data = join(directory, shared ? 'shared-data' : 'isolated-data');
      const profile = shared ? join(directory, 'shared-pi') : join(data, 'pi');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(profile, 'auth.json'),
        JSON.stringify({
          anthropic: {
            type: 'oauth',
            access: 'synthetic-access',
            refresh: 'synthetic-refresh',
            expires: Date.now() + 3600000,
          },
        }),
        { mode: 0o600 },
      );
      const server = await createServer(data, shared ? { piAgentDir: profile } : {});
      servers.push(server);
      const before = (await server.agent.providers()).providers.find((p) => p.id === 'anthropic');
      assert.equal(before.credentialType, 'oauth');
      assert.equal(before.configured, true);
      assert.equal(before.stored, false);
      const result = await server.app.inject({
        method: 'DELETE',
        url: '/api/agent/credential/anthropic',
      });
      assert.equal(result.statusCode, 200);
      assert.equal(
        Object.hasOwn(JSON.parse(await readFile(join(profile, 'auth.json'), 'utf8')), 'anthropic'),
        false,
      );
      const after = (await server.agent.providers()).providers.find((p) => p.id === 'anthropic');
      assert.equal(after.configured, false);
      assert.equal(after.credentialType, null);
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of environment) process.env[name] = value;
    for (const server of servers) await server.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
