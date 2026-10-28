import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DB } from '../backend/dist/db.js';
import { createServer } from '../backend/dist/server.js';
test('the server seals finished tails on its idle maintenance tick without changing run revisions', async () => {
  mkdirSync('tmp/storage-tests', { recursive: true });
  const dir = mkdtempSync('tmp/storage-tests/timer-'),
    server = await createServer(dir);
  try {
    const run = await server.db.call('upsert', {
      entity: 'synthetic',
      project: 'maintenance',
      name: 'run',
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 20 }, (_, i) => JSON.stringify({ _step: i, value: i })),
        },
      },
      complete: true,
    });
    const before = await server.db.call('run', run.id),
      raw = new Database(dir + '/randl.sqlite3', { readonly: true });
    try {
      const deadline = Date.now() + 15000;
      while (!raw.prepare('SELECT 1 FROM stream_blocks LIMIT 1').get() && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      assert.ok(
        raw.prepare('SELECT 1 FROM stream_blocks LIMIT 1').get(),
        'maintenance must not be starved by the heartbeat timer',
      );
      assert.equal(raw.prepare('SELECT count(*) n FROM point_tail').get().n, 0);
    } finally {
      raw.close();
    }
    const after = await server.db.call('run', run.id);
    for (const key of ['revision', 'updated', 'stream_bytes'])
      assert.equal(after[key], before[key]);
  } finally {
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project deletion returns free pages incrementally without a full VACUUM', async () => {
  const { Store } = await import('../backend/dist/database.js');
  const dir = mkdtempSync('tmp/storage-tests/reclaim-'),
    store = new Store(dir);
  let worker;
  try {
    const id = store.upsert({ entity: 'synthetic', project: 'reclaim', name: 'run' }).id,
      k = store.history.runKey(id),
      f = store.history.ensureFileId('output.log');
    const line = 'x'.repeat(128 * 1024);
    store.history.transaction(() => {
      for (let i = 0; i < 800; i++) store.history.linePut(k, f, i, line);
    });
    store.ingest(id, { complete: true });
    const before = store.db.pragma('page_count', { simple: true }),
      physicalBefore = statSync(dir + '/randl.sqlite3').size;
    worker = new DB(dir);
    await worker.call('projectDelete', { id: 'synthetic/reclaim', confirm: 'reclaim' });
    const page = store.db.pragma('page_size', { simple: true }),
      free = () => store.db.pragma('freelist_count', { simple: true }) * page,
      initial = free();
    assert.ok(initial > 64 * 1024 ** 2);
    const limit = Math.ceil((initial - 64 * 1024 ** 2) / (1024 * page)) + 2;
    let ticks = 0;
    while (free() > 64 * 1024 ** 2 && ticks++ < limit) await worker.call('storageMaintain');
    for (let i = 0; i < 100 && statSync(dir + '/randl.sqlite3').size >= physicalBefore; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(free() <= 64 * 1024 ** 2);
    assert.ok(store.db.pragma('page_count', { simple: true }) < before);
    assert.ok(
      statSync(dir + '/randl.sqlite3').size < physicalBefore,
      'reclaimed pages must reach the main file without closing the connection',
    );
  } finally {
    await worker?.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one-block maintenance calls yield unfinished work without changing logical history', async () => {
  const { Store } = await import('../backend/dist/database.js');
  const dir = mkdtempSync('tmp/storage-tests/quantum-'),
    store = new Store(dir);
  try {
    const id = store.upsert({ entity: 'synthetic', project: 'quantum', name: 'run' }).id;
    store.ingest(id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 300 }, (_, i) =>
            JSON.stringify({ _step: i, a: i / 7, b: i / 3, c: i }),
          ),
        },
      },
      complete: true,
    });
    const before = store.run(id);
    let calls = 0,
      more,
      previousPoints = 0,
      previousLines = 0;
    do {
      more = store.storageMaintain(50, 1);
      const points = store.db.prepare('SELECT count(*) n FROM point_blocks').get().n;
      const lines = store.db.prepare('SELECT count(*) n FROM stream_blocks').get().n;
      assert.ok(points - previousPoints <= 1);
      assert.ok(lines - previousLines <= 1);
      previousPoints = points;
      previousLines = lines;
      assert.ok(++calls < 20);
    } while (more);
    assert.ok(calls >= 4);
    assert.equal(store.db.prepare('SELECT count(*) n FROM point_tail').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM stream_tail').get().n, 0);
    const after = store.run(id);
    for (const field of ['revision', 'updated', 'stream_bytes', 'history_count'])
      assert.equal(after[field], before[field]);
    assert.equal([...store.history.lines(id, 'wandb-history.jsonl')].length, 300);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
