// One-time runtime rebuild for a data directory written before active-time runtimes.
// Stop the server first. Adds the runtime_raw columns when missing, rebuilds runs whose
// stored runtime exceeds their wall-clock span from their stored history, and records
// every run's last reported runtime so later reports continue from it.
//   node scripts/rebuild-runtimes.mjs --data-dir /path/to/data
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../backend/dist/database.js';
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
if (!values['data-dir']) throw Error('Choose the data directory with --data-dir');
const directory = resolve(values['data-dir']);
const raw = new Database(join(directory, 'randl.sqlite3'), { fileMustExist: true });
const columns = raw.prepare('PRAGMA table_info(runs)').all().map((column) => column.name);
for (const name of ['runtime_raw', 'runtime_raw_at'])
  if (!columns.includes(name)) raw.exec(`ALTER TABLE runs ADD COLUMN ${name} REAL`);
raw.close();
const store = new Store(directory);
const started = performance.now();
const rebuilt = store.rebuildRuntimes();
console.log(JSON.stringify({ rebuilt, milliseconds: Math.round(performance.now() - started) }));
store.db.close();
