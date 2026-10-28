import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { closeSync, fdatasyncSync, openSync } from 'node:fs';
import { join } from 'node:path';

// Copy/sync WAL pages away from the request worker. Keep a read snapshot across
// checkpoints so its next writer does not rewind and fsync a new WAL header on
// every poll. Rotate the WAL at 32 MiB or after one idle second instead.
const path = join(workerData.directory, 'randl.sqlite3');
const db = new Database(path, { fileMustExist: true });
db.pragma('busy_timeout=0');
db.pragma('wal_autocheckpoint=0');
const readers = [0, 1].map(() => new Database(path, { readonly: true, fileMustExist: true }));
const readSchema = readers.map((reader) =>
  reader.prepare('SELECT rootpage FROM sqlite_schema LIMIT 1'),
);
const readWal = db.prepare('PRAGMA wal_checkpoint(NOOP)');
const checkpointWal = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
const frameBytes = Number(db.pragma('page_size', { simple: true })) + 24;
let pin = -1,
  previousLog = -1,
  changedAt = performance.now(),
  retry = false,
  requested = false;
type Checkpoint = { busy: number; log: number; checkpointed: number };
const state = () => readWal.get() as Checkpoint;
function release() {
  if (pin >= 0) readers[pin].exec('ROLLBACK');
  pin = -1;
}
const timer = setInterval(() => {
  if (requested) return;
  const before = state();
  if (before.log !== previousLog) {
    previousLog = before.log;
    changedAt = performance.now();
  }
  if (before.log > before.checkpointed) {
    // There are uncheckpointed frames, so this read takes a WAL snapshot. Acquire
    // the new snapshot before releasing the old one: never leave a rewind gap.
    const next = pin === 0 ? 1 : 0;
    readers[next].exec('BEGIN');
    readSchema[next].get();
    release();
    pin = next;
    const fd = openSync(path + '-wal', 'r+');
    try {
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // This copies through the snapshot without making the request worker sync a
    // new header. Polling keeps the final catch-up small even under heavy writes.
    checkpointWal.get();
  }
  if (
    pin >= 0 &&
    (retry || state().log * frameBytes >= 32 * 1024 ** 2 || performance.now() - changedAt >= 1000)
  ) {
    requested = true;
    parentPort!.postMessage('checkpoint');
  }
}, 250);
parentPort!.on('message', (message) => {
  if (message === 'retry') {
    retry = true;
    return;
  }
  if (message === 'checkpoint') {
    // The application worker pauses admission for at most 20 ms. Release our
    // snapshots and finish the small remainder, allowing the next WAL to reuse
    // its file. Slow I/O never extends that admission window.
    release();
    const result = checkpointWal.get() as Checkpoint;
    const current = state();
    retry = result.busy !== 0 || current.log !== current.checkpointed;
    requested = false;
    parentPort!.postMessage('done');
    return;
  }
  clearInterval(timer);
  release();
  for (const reader of readers) reader.close();
  checkpointWal.get();
  db.close();
  parentPort!.close();
});
