import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { Store } from '../backend/dist/database.js';
function invariants(s, id, points, lines) {
  const h = s.history,
    k = h.runKey(id),
    m = h.metricId('value'),
    f = h.fileId('wandb-events.jsonl');
  const data = h.series(k, m);
  assert.deepEqual(
    Array.from(data.steps, (step, i) => [step, data.values[i]]),
    [...points].sort((a, b) => a[0] - b[0]),
  );
  assert.deepEqual(
    [...h.lines(k, f)].map((r) => [r.offset, r.content]),
    [...lines].sort((a, b) => a[0] - b[0]),
  );
  for (const [table, key, tail, column] of [
    ['point_blocks', 'metric', 'point_tail', 'step'],
    ['stream_blocks', 'file', 'stream_tail', 'offset'],
  ]) {
    const groups = new Map();
    for (const b of s.db.prepare(`SELECT * FROM ${table} ORDER BY run,${key},first`).all()) {
      const prev = groups.get(b[key]);
      assert.ok(prev === undefined || prev < b.first);
      groups.set(b[key], b.last);
    }
    for (const r of s.db.prepare(`SELECT * FROM ${tail}`).all())
      assert.ok(!groups.has(r[key]) || r[column] > groups.get(r[key]));
  }
  assert.equal(
    s.run(id).stream_bytes,
    [...lines.values()].reduce((n, v) => n + Buffer.byteLength(v), 0),
  );
}
test('randomized late writes, seals, partial top-ups and rollback match row semantics', () => {
  mkdirSync('tmp/storage-tests', { recursive: true });
  const dir = mkdtempSync('tmp/storage-tests/oracle-'),
    s = new Store(dir),
    id = s.upsert({ entity: 'test', project: 'oracle', name: 'run' }).id,
    h = s.history,
    k = h.runKey(id),
    m = h.ensureMetricId('value'),
    f = h.ensureFileId('wandb-events.jsonl'),
    points = new Map(),
    lines = new Map();
  assert.equal(s.db.pragma('user_version', { simple: true }), 2);
  assert.equal(s.db.pragma('page_size', { simple: true }), 4096);
  assert.equal(s.db.pragma('auto_vacuum', { simple: true }), 2);
  assert.equal(s.db.pragma('wal_autocheckpoint', { simple: true }), 256);
  let seed = 17;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  try {
    for (let batch = 0; batch < 30; batch++) {
      h.transaction(() => {
        for (let i = 0; i < 130; i++) {
          const step = batch < 12 ? batch * 130 + i : (rand() % 2100) - 50,
            value = rand() / 2 ** 32,
            offset = batch < 12 ? batch * 130 + i : rand() % 2100,
            line = JSON.stringify({ _timestamp: step, value });
          h.pointPut(k, m, step, value);
          h.linePut(k, f, offset, line);
          points.set(step, value);
          lines.set(offset, line);
        }
        h.finishWrites(k);
      });
      if (batch % 4 === 0)
        h.transaction(() =>
          h.sealRun(k, { until: Infinity, points: Infinity, lines: Infinity }, true),
        );
      invariants(s, id, points, lines);
    }
    assert.throws(
      () =>
        h.transaction(() => {
          h.pointPut(k, m, -100, 1);
          h.linePut(k, f, 0, '{"value":42}');
          h.finishWrites(k);
          h.ensureMetricId('rolled-back');
          throw Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(h.metricId('rolled-back'), undefined);
    invariants(s, id, points, lines);
    h.transaction(() => {
      h.pointPut(k, m, 9999, 4);
      h.finishWrites(k);
    });
    points.set(9999, 4);
    invariants(s, id, points, lines);
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('history replay is identical or atomically refused in tails and blocks', () => {
  const dir = mkdtempSync('tmp/storage-tests/replay-'),
    s = new Store(dir),
    id = s.upsert({ entity: 'test', project: 'replay', name: 'run' }).id;
  const payload = {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: Array.from({ length: 1100 }, (_, i) => JSON.stringify({ _step: i, value: i })),
      },
    },
  };
  try {
    assert.throws(
      () =>
        s.ingest(id, {
          files: { 'huge.log': { offset: Number.MAX_SAFE_INTEGER, content: ['x', 'y'] } },
        }),
      /Invalid file stream offset/,
    );
    assert.equal(s.history.fileId('huge.log'), undefined);
    s.ingest(id, payload);
    s.storageMaintain(10000);
    const before = s.run(id);
    s.ingest(id, payload);
    assert.equal(s.run(id).revision, before.revision);
    assert.throws(
      () =>
        s.ingest(id, {
          files: { 'wandb-history.jsonl': { offset: 0, content: ['{"_step":0,"value":-1}'] } },
        }),
      /Conflicting history replay/,
    );
    assert.equal(s.run(id).stream_bytes, before.stream_bytes);
    assert.equal(s.history.lastPoint(id, 'value').value, 1099);
    s.db.prepare("UPDATE runs SET snapshot_at=1,snapshot_source='Synthetic' WHERE id=?").run(id);
    const snapshot = s.db
      .prepare('SELECT snapshot_at,resumed_at,revision,updated,heartbeat FROM runs WHERE id=?')
      .get(id);
    assert.throws(
      () =>
        s.ingest(id, {
          files: { 'wandb-history.jsonl': { offset: 0, content: ['{"_step":0,"value":-1}'] } },
        }),
      /Conflicting history replay/,
    );
    assert.deepEqual(
      s.db
        .prepare('SELECT snapshot_at,resumed_at,revision,updated,heartbeat FROM runs WHERE id=?')
        .get(id),
      snapshot,
    );
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late inserts split oversized point and stream blocks without overlapping the tail', () => {
  const dir = mkdtempSync('tmp/storage-tests/split-'),
    s = new Store(dir),
    id = s.upsert({ entity: 'synthetic', project: 'split', name: 'run' }).id,
    h = s.history,
    k = h.runKey(id),
    m = h.ensureMetricId('value'),
    f = h.ensureFileId('wandb-events.jsonl'),
    points = new Map(),
    lines = new Map();
  try {
    h.transaction(() => {
      for (let i = 0; i < 1024; i++) {
        h.pointPut(k, m, i * 100, i);
        points.set(i * 100, i);
      }
      for (let i = 0; i < 256; i++) {
        const offset = i * 100,
          line = JSON.stringify({ value: i });
        h.linePut(k, f, offset, line);
        lines.set(offset, line);
      }
      h.finishWrites(k);
      h.sealRun(k, { until: Infinity, points: Infinity, lines: Infinity }, true);
    });
    h.transaction(() => {
      for (let i = 1; i < 2200; i++) {
        h.pointPut(k, m, i, -i);
        points.set(i, -i);
      }
      for (let i = 1; i < 600; i++) {
        const line = JSON.stringify({ value: -i });
        h.linePut(k, f, i, line);
        lines.set(i, line);
      }
      h.finishWrites(k);
    });
    invariants(s, id, points, lines);
    assert.ok(s.db.prepare('SELECT count(*) n FROM point_blocks').get().n > 1);
    assert.ok(s.db.prepare('SELECT count(*) n FROM stream_blocks').get().n > 1);
    assert.ok(s.db.prepare('SELECT max(n) n FROM point_blocks').get().n <= 2048);
    assert.ok(s.db.prepare('SELECT max(n) n FROM stream_blocks').get().n <= 512);
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
