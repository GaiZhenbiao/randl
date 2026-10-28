import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { DB } from '../backend/dist/db.js';
import { Store } from '../backend/dist/database.js';

// A pinned WAL reader must not stop request processing. After it releases its
// snapshot, the checkpoint connection must catch up without a maintenance call.
test('background checkpoint progresses after a pinned reader and shuts down cleanly', async () => {
  mkdirSync('tmp/storage-tests', { recursive: true });
  const dir = mkdtempSync('tmp/storage-tests/checkpoint-');
  const db = new DB(dir);
  let reader;
  try {
    const { id } = await db.call('upsert', { entity: 'test', project: 'checkpoint', name: 'run' });
    reader = new Database(dir + '/randl.sqlite3', { readonly: true });
    reader.exec('BEGIN');
    assert.equal(reader.prepare('SELECT history_count FROM runs').get().history_count, 0);
    const before = statSync(dir + '/randl.sqlite3').size;
    for (let offset = 0; offset < 600; offset += 20)
      await db.call('ingest', id, {
        files: {
          'wandb-history.jsonl': {
            offset,
            content: Array.from({ length: 20 }, (_, j) =>
              JSON.stringify({
                _step: offset + j,
                value: (offset + j) / 7,
                text: 'retained text '.repeat(100),
              }),
            ),
          },
        },
      });
    assert.equal((await db.call('run', id)).history_count, 600);
    assert.equal(reader.prepare('SELECT history_count FROM runs').get().history_count, 0);
    reader.exec('ROLLBACK');
    for (let i = 0; i < 100 && statSync(dir + '/randl.sqlite3').size <= before; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(statSync(dir + '/randl.sqlite3').size > before);
    reader.close();
    reader = undefined;
    await db.close();
    const reopened = new Store(dir);
    try {
      assert.equal(reopened.run(id).history_count, 600);
      assert.equal([...reopened.history.lines(id, 'wandb-history.jsonl')][0].offset, 0);
      assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      reopened.db.close();
    }
  } finally {
    reader?.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continuous small writes keep appending to the WAL until idle instead of rewinding each poll', async () => {
  const dir = mkdtempSync('tmp/storage-tests/checkpoint-batch-'),
    db = new DB(dir);
  let observer;
  try {
    const { id } = await db.call('upsert', { entity: 'test', project: 'batch', name: 'run' });
    observer = new Database(dir + '/randl.sqlite3', { fileMustExist: true });
    const state = () => observer.pragma('wal_checkpoint(NOOP)')[0];
    let previousLog = 0;
    for (let offset = 0; offset < 600; offset += 20) {
      await db.call('ingest', id, {
        files: {
          'wandb-history.jsonl': {
            offset,
            content: Array.from({ length: 20 }, (_, j) =>
              JSON.stringify({
                _step: offset + j,
                value: offset + j,
                text: 'x'.repeat(2048),
              }),
            ),
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const current = state();
      assert.ok(
        current.log >= previousLog,
        'active sub-threshold writes must append instead of rewind',
      );
      previousLog = current.log;
    }
    const active = state();
    assert.ok(active.log * 4120 < 32 * 1024 ** 2);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(state().log, state().checkpointed, 'idle data must reach the main file');
    await db.call('ingest', id, {
      files: {
        'wandb-history.jsonl': {
          offset: 600,
          content: [JSON.stringify({ _step: 600, value: 600 })],
        },
      },
    });
    assert.ok(state().log < active.log, 'idle snapshots must release so the WAL can rewind');
    assert.equal((await db.call('run', id)).history_count, 601);
  } finally {
    observer?.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint catch-up permits WAL reuse during continuous batched ingestion', async () => {
  const dir = mkdtempSync('tmp/storage-tests/checkpoint-rollover-'),
    db = new DB(dir);
  let observer;
  try {
    const { id } = await db.call('upsert', { entity: 'test', project: 'rollover', name: 'run' });
    observer = new Database(dir + '/randl.sqlite3', { fileMustExist: true });
    let previous = 0,
      reused = false;
    for (let offset = 0; offset < 5000; offset += 100) {
      const content = Array.from({ length: 100 }, (_, j) =>
        JSON.stringify({
          _step: offset + j,
          ...Object.fromEntries(
            Array.from({ length: 160 }, (_, m) => [
              'training/metric/' + m,
              m < 30 ? Math.sin((offset + j) / 17 + m) : Math.floor((offset + j) / (m + 1)),
            ]),
          ),
        }),
      );
      await db.call('ingest', id, { files: { 'wandb-history.jsonl': { offset, content } } });
      const current = observer.pragma('wal_checkpoint(NOOP)')[0].log;
      if (current < previous) reused = true;
      previous = current;
    }
    assert.ok(reused, 'the WAL must reuse its file while writes continue, not only after idle');
    assert.equal((await db.call('run', id)).history_count, 5000);
  } finally {
    observer?.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
