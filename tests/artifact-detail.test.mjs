import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';

const key = 'artifact-detail-test-key-not-a-secret-000000000000000000000000000000';
const authorized = { authorization: 'Bearer ' + key };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-artifact-detail-'));
  const server = await createServer(directory, { apiKey: key });
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { db } = server;
  const producer = await db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'producer',
    displayName: 'Original producer',
  });
  const newerProducer = await db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'producer-new',
  });
  const consumer = await db.call('upsert', { entity: 'e', project: 'p', name: 'consumer' });
  const outsideConsumer = await db.call('upsert', {
    entity: 'e',
    project: 'other',
    name: 'consumer',
  });
  const create = async (project, digest, aliases, runName) => {
    const artifact = await db.call('artifact', 'create', {
      entityName: 'e',
      projectName: project,
      artifactCollectionName: 'collection',
      artifactTypeName: 'dataset',
      digest,
      aliases,
      runName,
      metadata: JSON.stringify({ source: project }),
      description: 'Artifact detail fixture',
    });
    return artifact;
  };
  const first = await create('p', 'first-logical-digest', ['baseline'], 'producer');
  await db.call('artifact', 'file', {
    id: first.id,
    name: 'nested/data.bin',
    digest: 'file-md5',
    size: 7,
  });
  await db.call('artifact', 'commit', { id: first.id, size: 7, count: 1 });
  const second = await create('p', 'second-logical-digest', ['candidate notes'], 'producer-new');
  await db.call('artifact', 'commit', { id: second.id, size: 0, count: 0 });
  const other = await create('other', 'other-logical-digest', ['baseline']);
  await db.call('artifact', 'commit', { id: other.id, size: 0, count: 0 });
  for (const run of [consumer, consumer, outsideConsumer])
    await db.call('artifact', 'use', {
      artifactID: first.id,
      entityName: run.entity,
      projectName: run.project,
      runName: run.name,
    });
  return { ...server, first, second, other, producer, newerProducer, consumer, outsideConsumer };
}

test('artifact detail returns scoped versions, current aliases, files and run lineage', async (t) => {
  const { app, first, second, other, producer, consumer, outsideConsumer } = await fixture(t);
  const response = await app.inject({ url: '/api/artifacts/' + first.id, headers: authorized });
  assert.equal(response.statusCode, 200, response.body);
  const detail = response.json();
  assert.equal(detail.artifact.id, first.id);
  assert.deepEqual(detail.artifact.aliases, ['baseline']);
  assert.deepEqual(JSON.parse(detail.artifact.metadata), { source: 'p' });
  assert.equal(detail.artifact.description, 'Artifact detail fixture');
  assert.deepEqual(
    detail.versions.map((version) => [version.id, version.version]),
    [
      [second.id, 1],
      [first.id, 0],
    ],
  );
  assert.ok(detail.versions.every((version) => version.state === 'COMMITTED'));
  assert.ok(!detail.versions.some((version) => version.id === other.id));
  assert.deepEqual(detail.files, [{ name: 'nested/data.bin', digest: 'file-md5', size: 7 }]);
  assert.equal(detail.producer.id, producer.id);
  assert.equal(detail.producer.display_name, 'Original producer');
  assert.deepEqual(
    new Set(detail.consumers.map((run) => run.id)),
    new Set([consumer.id, outsideConsumer.id]),
  );
  assert.equal(detail.consumers.length, 2, 'Repeated use must not duplicate consumer lineage');
  const manual = (
    await app.inject({ url: '/api/artifacts/' + other.id, headers: authorized })
  ).json();
  assert.equal(manual.producer, null);
  assert.deepEqual(manual.consumers, []);
  assert.equal(manual.versions.length, 1);
});

test('alias removal is scoped to the specified version and project', async (t) => {
  const { app, db, first, second, other } = await fixture(t);
  const remove = (id, alias) =>
    app.inject({
      method: 'DELETE',
      url: `/api/artifacts/${id}/aliases/${encodeURIComponent(alias)}`,
      headers: authorized,
    });
  // A stale caller still viewing v0 must not remove latest after it moved to v1.
  assert.equal((await remove(first.id, 'latest')).statusCode, 200);
  assert.equal(
    (await db.call('artifact', 'resolve', { entity: 'e', project: 'p', name: 'collection:latest' }))
      .id,
    second.id,
  );
  assert.equal((await remove(first.id, 'baseline')).statusCode, 200);
  assert.equal(
    await db.call('artifact', 'resolve', {
      entity: 'e',
      project: 'p',
      name: 'collection:baseline',
    }),
    null,
  );
  assert.equal(
    (
      await db.call('artifact', 'resolve', {
        entity: 'e',
        project: 'other',
        name: 'collection:baseline',
      })
    ).id,
    other.id,
  );
  assert.equal((await remove(second.id, 'candidate notes')).statusCode, 200);
  assert.equal(
    await db.call('artifact', 'resolve', {
      entity: 'e',
      project: 'p',
      name: 'collection:candidate notes',
    }),
    null,
  );
  assert.equal((await remove(first.id, 'v0')).statusCode, 200);
  assert.equal(
    (await db.call('artifact', 'resolve', { entity: 'e', project: 'p', name: 'collection:v0' })).id,
    first.id,
    'Version references remain immutable',
  );
  const detail = (
    await app.inject({ url: '/api/artifacts/' + first.id, headers: authorized })
  ).json();
  assert.deepEqual(detail.artifact.aliases, []);
  assert.equal(detail.files.length, 1);
  assert.equal(detail.versions.length, 2);
});

test('artifact detail and alias removal require authentication including encoded API paths', async (t) => {
  const { app, db, first } = await fixture(t);
  for (const prefix of ['/api', '/%61pi']) {
    assert.equal((await app.inject({ url: `${prefix}/artifacts/${first.id}` })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `${prefix}/artifacts/${first.id}/aliases/baseline`,
        })
      ).statusCode,
      401,
    );
  }
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/artifacts/${first.id}/aliases/baseline`,
        headers: { authorization: 'Bearer invalid' },
      })
    ).statusCode,
    401,
  );
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/artifacts/${first.id}/aliases/baseline`,
        headers: { cookie, origin: 'https://untrusted.example' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await db.call('artifact', 'resolve', {
        entity: 'e',
        project: 'p',
        name: 'collection:baseline',
      })
    ).id,
    first.id,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/artifacts/${first.id}/aliases/baseline`,
        headers: { cookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    await db.call('artifact', 'resolve', {
      entity: 'e',
      project: 'p',
      name: 'collection:baseline',
    }),
    null,
  );
});
