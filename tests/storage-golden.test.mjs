import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { Store } from '../backend/dist/database.js';
import { populate, capture } from './storage-golden.mjs';
test('format-1 golden readers survive tails, full sealing and resumed tails', () => {
  mkdirSync('tmp/storage-tests', { recursive: true });
  const dir = mkdtempSync('tmp/storage-tests/golden-'),
    store = new Store(dir),
    now = Date.now;
  Date.now = () => 1700005000000;
  try {
    const seal = store.history.sealRun;
    store.history.sealRun = () => false;
    const ids = populate(store);
    store.history.sealRun = seal;
    assert.equal(store.db.prepare('SELECT count(*) n FROM point_blocks').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM stream_blocks').get().n, 0);
    const expected = JSON.parse(
      readFileSync(new URL('./fixtures/storage-golden.json', import.meta.url)),
    );
    assert.deepEqual(capture(store, ids), expected);
    const revisions = store.db.prepare('SELECT revision,updated FROM runs ORDER BY id').all();
    for (const id of ids)
      store.history.transaction(() =>
        store.history.sealRun(
          store.history.runKey(id),
          { until: Infinity, points: Infinity, lines: Infinity },
          true,
        ),
      );
    assert.deepEqual(capture(store, ids), expected);
    assert.deepEqual(
      store.db.prepare('SELECT revision,updated FROM runs ORDER BY id').all(),
      revisions,
    );
    for (const id of ids)
      store.ingest(id, {
        files: {
          'wandb-history.jsonl': {
            offset: store.streamCount(id, 'wandb-history.jsonl'),
            content: ['{"_step":5000,"a":3,"b":2}'],
          },
        },
        complete: true,
      });
    const resumed = capture(store, ids);
    store.storageMaintain(10000);
    assert.deepEqual(capture(store, ids), resumed);
  } finally {
    Date.now = now;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
