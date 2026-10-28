import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { advanceRuntime } from '../backend/dist/run-runtime.js';
import { Store } from '../backend/dist/database.js';

const fold = (reports, started = 0) =>
  reports.reduce((state, [raw, at]) => advanceRuntime(state, raw, at), {
    runtime: 0,
    raw: null,
    rawAt: null,
    started,
  }).runtime;

test('reported runtimes accumulate active time and skip pauses, inflated values and negatives', () => {
  // Continuous logging: the last report.
  assert.equal(fold([[10, 10], [70, 70], [130, 130]]), 130);
  // A correct resume after a one-hour pause continues from the earlier value.
  assert.equal(fold([[10, 10], [100, 100], [130, 3700], [190, 3760]]), 190);
  // SDK 0.30.0 inflates a resumed run's value by a constant (wandb/wandb#12999): the jump
  // is ignored after an hour's pause and later increments count.
  assert.equal(fold([[10, 10], [100, 100], [6.4e9, 3700], [6.4e9 + 60, 3760]]), 160);
  // The same jump without a pause counts the elapsed wall time.
  assert.equal(fold([[10, 10], [100, 100], [6.4e9, 130], [6.4e9 + 60, 190]]), 190);
  // Negative, decreasing values keep their increments.
  assert.equal(fold([[-8e9, 10], [-8e9 + 30, 40], [-8e9 + 60, 70]], 0), 60);
  // A first value larger than the time since the run started is not trusted.
  assert.equal(fold([[9e9, 100], [9e9 + 50, 150]]), 50);
  // Missing and non-numeric values are ignored.
  assert.equal(fold([[undefined, 10], ['5', 20], [30, 30], [null, 40], [60, 60]]), 60);
});

async function store(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-runtime-'));
  const value = new Store(directory);
  t.after(async () => {
    value.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store: value };
}
const history = (rows) => ({
  files: {
    'wandb-history.jsonl': {
      offset: rows.offset || 0,
      content: rows.map(([step, runtime, timestamp]) =>
        JSON.stringify({ _step: step, _runtime: runtime, _timestamp: timestamp, loss: step }),
      ),
    },
  },
});

test('a hosted W&B-shaped run with an offset jump and a negative resumed segment counts only active time', () => {
  // As observed on a hosted run: normal values, then a +5.6e9 offset 30 s after the previous
  // record (not a pause), then an 18,062 s pause and a resumed segment around -7.99e9.
  const reports = [];
  for (let t = 0; t <= 9000; t += 30) reports.push([t, t]);
  for (let t = 9030; t <= 17891.8; t += 30) reports.push([5.613862218e9 + t, t]);
  reports.push([5.613862218e9 + 17891.8, 17891.8]);
  const resumedAt = 17891.8 + 18062;
  for (let s = 0; s <= 17899.5; s += 30) reports.push([-7.991901887e9 + s, resumedAt + s]);
  reports.push([-7.991901887e9 + 17899.5, resumedAt + 17899.5]);
  const runtime = fold(reports);
  assert.ok(Math.abs(runtime - (17891.8 + 17899.5)) < 31, String(runtime));
});

test('ingest keeps the active runtime when a resumed SDK reports inflated values', async (t) => {
  const { store: db } = await store(t);
  const run = db.upsert({ entity: 'local', project: 'p', name: 'resumed' });
  const start = run.created;
  db.ingest(run.id, history([[0, 1, start + 1], [1, 100, start + 100]]));
  db.ingest(run.id, { files: {}, complete: true, exitcode: 0 });
  const paused = db.run(run.id).runtime;
  assert.ok(paused >= 100 && paused < 105, paused);
  // Resumed an hour later: the SDK reports 1e9 times the elapsed seconds.
  const later = start + 3700;
  const resumed = history([[2, 6e9, later], [3, 6e9 + 30, later + 30]]);
  resumed.files['wandb-history.jsonl'].offset = 2;
  db.ingest(run.id, resumed);
  db.ingest(run.id, { files: {}, complete: true, exitcode: 0 });
  const total = db.run(run.id).runtime;
  assert.ok(total >= paused + 30 && total < paused + 40, `${paused} -> ${total}`);
});

test('the rebuild script fixes implausible stored runtimes from history in time order; parallel runs add up', async (t) => {
  const { directory, store: db } = await store(t);
  const ids = [];
  for (const name of ['a', 'b']) {
    const run = db.upsert({ entity: 'local', project: 'p', name });
    db.ingest(run.id, history([[0, 1, run.created + 1], [1, 600, run.created + 600]]));
    db.ingest(run.id, { files: {}, complete: true, exitcode: 0 });
    ids.push(run.id);
  }
  // Simulate stored data from before this rule: an inflated runtime and a history
  // supplement appended out of order.
  db.db.prepare('UPDATE runs SET finished=created+1200').run();
  db.db.prepare('UPDATE runs SET runtime=? WHERE id=?').run(9.2e9, ids[0]);
  db.db
    .prepare('INSERT INTO stream_tail VALUES(?,?,?,?)')
    .run(db.history.runKey(ids[0]), db.history.ensureFileId('wandb-history.jsonl'), 2, JSON.stringify({ _step: 0.5, _runtime: 300, _timestamp: db.run(ids[0]).created + 300 }));
  db.db.close();
  const raw = new Database(join(directory, 'randl.sqlite3'));
  raw.exec('ALTER TABLE runs DROP COLUMN runtime_raw; ALTER TABLE runs DROP COLUMN runtime_raw_at');
  raw.close();
  const script = await promisify(execFile)(process.execPath, ['scripts/rebuild-runtimes.mjs', '--data-dir', directory]);
  assert.equal(JSON.parse(script.stdout).rebuilt, 1);
  const reopened = new Store(directory);
  t.after(() => reopened.db.close());
  const [a, b] = ids.map((id) => reopened.run(id).runtime);
  assert.ok(a >= 599 && a <= 605, String(a));
  assert.ok(b >= 599 && b <= 605, String(b));
  const project = reopened.projectGet('local/p');
  assert.ok(Math.abs(project.totalCompute - (a + b)) < 1, 'Total compute sums parallel runs');
});
