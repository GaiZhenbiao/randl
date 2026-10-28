import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../backend/dist/server.js';
const key = 'test-key-not-a-secret-0000000000000000000000000000000000000000000';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'randl-auth-'));
  const server = await createServer(dir, { apiKey: key, ...options });
  t.after(async () => {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ...server, dir };
}
test('every protected route family rejects unauthenticated and encoded prefixes', async (t) => {
  const { app, db } = await fixture(t);
  await db.call('upsert', { entity: 'e', project: 'p', name: 'r' });
  const cases = [
    ['GET', '/%61pi/runs'],
    ['POST', '/%67raphql'],
    ['POST', '/%66iles/e/p/r/file_stream'],
    ['PUT', '/%75pload/e/p/r/test.bin'],
    ['GET', '/%73torage/artifacts/00000000-0000-0000-0000-000000000000/manifest'],
    ['POST', '/%61pi/agent/chat'],
    ['GET', '/api/agent/providers'],
    ['POST', '/api/agent/credential'],
    ['DELETE', '/api/agent/credential/deepseek'],
    ['POST', '/api/agent/test'],
    ['GET', '/%61pi/plugins/test/revisions/x/source/main.js'],
    ['DELETE', '/%61pi/views/test'],
  ];
  for (const [method, url] of cases) {
    const r = await app.inject({
      method,
      url,
      ...(['POST', 'PUT'].includes(method) ? { payload: {} } : {}),
    });
    assert.equal(r.statusCode, 401, method + ' ' + url + ': ' + r.body);
  }
  assert.equal((await app.inject('/api/runs')).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/runs', headers: { authorization: 'Bearer ' + key } }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/runs',
        headers: { authorization: 'Basic ' + Buffer.from('api:' + key).toString('base64') },
      })
    ).statusCode,
    200,
  );
});
test('secure browser sessions expire, revoke on logout/key change, and reject wrong origin', async (t) => {
  const { app, db } = await fixture(t, { publicUrl: 'https://randl.example.com' });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: 'randl.example.com', origin: 'https://randl.example.com' },
    payload: { key },
  });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  assert.match(setCookie, /__Host-randl=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await app.inject({ url: '/api/runs', headers: { cookie } })).statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/tools/view_create',
        headers: { cookie, origin: 'https://evil.example' },
        payload: { name: 'bad' },
      })
    ).statusCode,
    403,
  );
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  assert.equal((await app.inject({ url: '/api/runs', headers: { cookie } })).statusCode, 401);
  const login2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key } });
  const cookie2 = login2.headers['set-cookie'].split(';')[0];
  await db.call('authConfigure', 'new-key-fingerprint');
  assert.equal(
    (await app.inject({ url: '/api/runs', headers: { cookie: cookie2 } })).statusCode,
    401,
  );
});
test('SDK storage signatures are method/path/expiry scoped', async (t) => {
  const { app, db } = await fixture(t);
  await db.call('upsert', { entity: 'e', project: 'p', name: 'r' });
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: 'Bearer ' + key },
    payload: {
      query: 'mutation CreateRunFiles { createRunFiles }',
      variables: { entity: 'e', project: 'p', run: 'r', files: ['file.bin'] },
    },
  });
  const url = new URL(response.json().data.createRunFiles.files[0].uploadUrl);
  const valid = url.pathname + url.search;
  assert.equal(
    (await app.inject({ method: 'PUT', url: valid, payload: Buffer.from('content') })).statusCode,
    200,
  );
  assert.equal((await app.inject({ method: 'GET', url: valid })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: valid.replace('file.bin', 'other.bin'),
        payload: Buffer.from('bad'),
      })
    ).statusCode,
    401,
  );
  url.searchParams.set('expires', '1');
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: url.pathname + url.search,
        payload: Buffer.from('bad'),
      })
    ).statusCode,
    401,
  );
});
test('login failures are bounded and remote hosting fails closed without required settings', async (t) => {
  const { app } = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'wrong' } }))
        .statusCode,
      401,
    );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'wrong' } }))
      .statusCode,
    429,
  );
  const dir = await mkdtemp(join(tmpdir(), 'randl-host-'));
  try {
    await assert.rejects(createServer(dir, { host: '0.0.0.0' }), /requires/);
    await assert.rejects(
      createServer(dir, { host: '0.0.0.0', apiKey: key, publicUrl: 'http://randl.example.com' }),
      /HTTPS/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
