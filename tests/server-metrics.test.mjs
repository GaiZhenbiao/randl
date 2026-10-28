import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerMetrics, routeGroup, BUCKET_MS, BUCKETS } from '../backend/dist/metrics.js';
import { createServer } from '../backend/dist/server.js';

test('routes are grouped by client and the event stream is not timed', () => {
  assert.equal(routeGroup('/graphql'), 'sdk');
  assert.equal(routeGroup('/files/e/p/r/file_stream'), 'sdk');
  assert.equal(routeGroup('/upload/e/p/r/a.txt'), 'sdk');
  assert.equal(routeGroup('/storage/artifacts/x/files/y'), 'sdk');
  assert.equal(routeGroup('/api/agent/chat'), 'agent');
  assert.equal(routeGroup('/api/conversations/x?since=1'), 'agent');
  assert.equal(routeGroup('/api/chart'), 'api');
  assert.equal(routeGroup('/api/events'), undefined);
  assert.equal(routeGroup('/assets/index.js'), 'ui');
});

test('buckets keep counts, bytes and percentile estimates within one histogram bin', () => {
  const metrics = new ServerMetrics(),
    t0 = 10 * BUCKET_MS;
  for (let i = 1; i <= 100; i++) metrics.request('api', i, i === 100 ? 500 : i === 99 ? 404 : 200, 10, 100, t0 + i);
  metrics.databaseCall(2, 3, false, t0);
  const [bucket] = metrics.buckets(0, t0 + 1000);
  const api = bucket.groups.api;
  assert.equal(api.count, 100);
  assert.equal(api.errors, 1);
  assert.equal(api.clientErrors, 1);
  assert.equal(api.requestBytes, 1000);
  assert.equal(api.responseBytes, 10000);
  for (const [value, expected] of [[api.p50, 50], [api.p95, 95], [api.p99, 99]])
    assert.ok(value / expected > 0.8 && value / expected < 1.25, `${value} vs ${expected}`);
  assert.equal(bucket.db.count, 1);
  assert.equal(bucket.db.maxQueue, 3);
  assert.equal(bucket.groups.sdk.count, 0);
  assert.equal(bucket.groups.sdk.p50, null);
});

test('the ring keeps a fixed number of minutes and returns only buckets since a time', () => {
  const metrics = new ServerMetrics();
  for (let minute = 0; minute < BUCKETS + 20; minute++) metrics.request('ui', 1, 200, 0, 0, minute * BUCKET_MS);
  const now = (BUCKETS + 19) * BUCKET_MS;
  const all = metrics.buckets(0, now);
  assert.equal(all.length, BUCKETS);
  assert.equal(all[0].t, 20 * BUCKET_MS);
  assert.deepEqual(metrics.buckets(now - BUCKET_MS, now).map((b) => b.t), [now - BUCKET_MS, now]);
});

test('the metrics endpoint reports requests, database calls and storage, and requires sign-in when enabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-metrics-'));
  const open = await createServer(join(directory, 'open'));
  const secured = await createServer(join(directory, 'secured'), { apiKey: 'k'.repeat(40) });
  t.after(async () => {
    await open.app.close();
    await secured.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await open.app.inject('/api/runs');
  await open.app.inject('/api/missing-route');
  await open.app.inject({ method: 'POST', url: '/graphql', payload: { query: 'query Viewer { viewer { id } }' } });
  const response = await open.app.inject('/api/server/metrics');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  const last = body.buckets.at(-1);
  assert.ok(last.groups.api.count >= 2);
  assert.ok(last.groups.api.clientErrors >= 1);
  assert.equal(last.groups.sdk.count, 1);
  assert.ok(last.db.count >= 1);
  assert.ok(body.storage.database > 0);
  assert.equal(typeof body.process.rss, 'number');
  const since = await open.app.inject('/api/server/metrics?since=' + (last.t + BUCKET_MS));
  assert.deepEqual(since.json().buckets, []);
  assert.equal((await secured.app.inject('/api/server/metrics')).statusCode, 401);
});
