import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { accepts, negotiate, compressibleType } from '../backend/dist/compression.js';
import { createServer } from '../backend/dist/server.js';

test('the encoding is Brotli when accepted, then gzip, honoring q=0', () => {
  assert.equal(negotiate('gzip, deflate, br, zstd'), 'br');
  assert.equal(negotiate('gzip, deflate'), 'gzip');
  assert.equal(negotiate('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(negotiate('*'), 'br');
  assert.equal(negotiate('*;q=0'), undefined);
  assert.equal(negotiate('identity'), undefined);
  assert.equal(negotiate(undefined), undefined);
  assert.ok(!accepts('br, gzip;q=0', 'gzip'));
  assert.ok(accepts('br, gzip', 'gzip'));
  assert.ok(compressibleType('application/json; charset=utf-8'));
  assert.ok(compressibleType('application/x-ndjson'));
  assert.ok(compressibleType('text/csv'));
  assert.ok(!compressibleType('video/mp4'));
  assert.ok(!compressibleType('image/jpeg'));
  assert.ok(!compressibleType(undefined));
});

test('API JSON is compressed for clients that accept it and left alone otherwise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-compression-'));
  const server = await createServer(directory);
  try {
    for (let index = 0; index < 40; index++)
      await server.db.call('upsert', {
        entity: 'test',
        project: 'squeeze',
        name: 'run-' + index,
        displayName: 'A run with a fairly long display name ' + index,
        config: { learning_rate: 0.001 * index, batch_size: 64, optimizer: 'adam' },
      });
    const url = '/api/runs?project=test%2Fsqueeze';
    const plain = await server.app.inject({ url });
    assert.equal(plain.headers['content-encoding'], undefined);
    // Runtimes of the runs advance between requests; their IDs and names do not.
    const runsOf = (value) => value.runs.map((run) => [run.id, run.display_name]);
    const json = runsOf(plain.json());
    assert.ok(plain.rawPayload.length > 4096, String(plain.rawPayload.length));
    for (const [accept, encoding, decode] of [
      ['gzip, deflate, br', 'br', brotliDecompressSync],
      ['gzip', 'gzip', gunzipSync],
    ]) {
      const reply = await server.app.inject({ url, headers: { 'accept-encoding': accept } });
      assert.equal(reply.headers['content-encoding'], encoding);
      assert.match(String(reply.headers.vary), /Accept-Encoding/);
      assert.ok(reply.rawPayload.length < plain.rawPayload.length / 4, encoding);
      assert.deepEqual(runsOf(JSON.parse(decode(reply.rawPayload).toString())), json);
    }
    // Small responses are not worth compressing.
    const small = await server.app.inject({
      url: '/api/auth/status',
      headers: { 'accept-encoding': 'br' },
    });
    assert.equal(small.headers['content-encoding'], undefined);
  } finally {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('static assets are sent as the Brotli or gzip copy the client accepts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-compression-'));
  const assets = join(directory, 'frontend');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { brotliCompressSync, gzipSync } = await import('node:zlib');
  await mkdir(join(assets, 'assets'), { recursive: true });
  const script = 'console.log("randl");\n'.repeat(200);
  await writeFile(join(assets, 'index.html'), '<!doctype html>');
  await writeFile(join(assets, 'assets/app.js'), script);
  await writeFile(join(assets, 'assets/app.js.br'), brotliCompressSync(script));
  await writeFile(join(assets, 'assets/app.js.gz'), gzipSync(script));
  const server = await createServer(directory, { frontend: assets });
  try {
    for (const [accept, encoding, decode] of [
      ['gzip, deflate, br', 'br', brotliDecompressSync],
      ['br;q=0, gzip', 'gzip', gunzipSync],
      ['identity', undefined, (bytes) => bytes],
    ]) {
      const reply = await server.app.inject({
        url: '/assets/app.js',
        headers: { 'accept-encoding': accept },
      });
      assert.equal(reply.headers['content-encoding'], encoding, accept);
      assert.equal(decode(reply.rawPayload).toString(), script);
    }
  } finally {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a streamed chart arrives compressed, each part usable as it comes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-compression-'));
  const server = await createServer(directory);
  try {
    const runs = [];
    for (let index = 0; index < 6; index++) {
      const run = await server.db.call('upsert', {
        entity: 'test',
        project: 'stream',
        name: 'run-' + index,
        config: {},
      });
      await server.db.call('ingest', run.id, {
        files: {
          'wandb-history.jsonl': {
            offset: 0,
            content: Array.from({ length: 300 }, (_, step) =>
              JSON.stringify({ _step: step, loss: (index + 1) / (step + 1) }),
            ),
          },
        },
        complete: true,
        exitcode: 0,
      });
      runs.push(run.id);
    }
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    // Different widths, so neither request is served from the other's cached chart.
    const request = (encoding, pixels) =>
      fetch(address + '/api/chart', {
        method: 'POST',
        body: JSON.stringify({ runs, metrics: ['loss'], pixels }),
        headers: {
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
          'accept-encoding': encoding,
        },
      });
    const plain = await request('identity', 600);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(plain.headers.get('content-encoding'), null);
    const lines = (await plain.text()).trim().split('\n').map((line) => JSON.parse(line));
    // fetch decodes Brotli as it reads, part by part.
    const compressed = await request('br', 601);
    assert.equal(compressed.headers.get('content-encoding'), 'br');
    const decoded = (await compressed.text()).trim().split('\n').map((line) => JSON.parse(line));
    const series = (parts) =>
      parts.flatMap((part) => part.changed || []).map((change) => change.replace.id);
    assert.ok(lines.length > 2, 'the chart streams in parts: ' + lines.length);
    assert.equal(decoded.length, lines.length);
    assert.deepEqual(series(decoded), series(lines));
    assert.equal(series(decoded).length, runs.length);
    assert.ok(decoded.at(-1).done);
  } finally {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
