import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createServer } from '../backend/dist/server.js';
import { ensureTables } from '../backend/dist/schema.js';

// A database from an earlier version keeps working after columns are added to its tables.
test('startup adds columns that tables from an earlier version lack', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let server = await createServer(directory);
  await server.app.close();
  // The ledger tables as the first ledger release created them: no `source` columns; and
  // metric renames without `by`. One journal entry is already there.
  const raw = new Database(join(directory, 'randl.sqlite3'));
  raw.exec(`
    DROP TABLE findings; DROP TABLE recipe_events; DROP TABLE run_journal; DROP TABLE metric_renames;
    CREATE TABLE findings(project TEXT NOT NULL,id TEXT NOT NULL,topic TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,citations TEXT NOT NULL,version INTEGER NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,by TEXT NOT NULL,deleted REAL,PRIMARY KEY(project,id));
    CREATE TABLE recipe_events(id INTEGER PRIMARY KEY,project TEXT NOT NULL,run TEXT NOT NULL,since REAL NOT NULL,reason TEXT NOT NULL,by TEXT NOT NULL,created REAL NOT NULL);
    CREATE TABLE run_journal(id TEXT PRIMARY KEY,run TEXT NOT NULL,time REAL NOT NULL,update_index REAL,step REAL,text TEXT NOT NULL,by TEXT NOT NULL,created REAL NOT NULL);
    CREATE TABLE metric_renames(id INTEGER PRIMARY KEY,run TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,merged INTEGER NOT NULL,offsets TEXT NOT NULL,steps TEXT,summary TEXT NOT NULL,created REAL NOT NULL,undone REAL);
  `);
  raw
    .prepare('INSERT INTO run_journal(id,run,time,text,by,created) VALUES(?,?,?,?,?,?)')
    .run('old', 'e/p/base', 100, 'Logged before the upgrade', 'me', 100);
  raw.close();

  server = await createServer(directory);
  t.after(() => server.app.close());
  await server.db.call('upsert', { entity: 'e', project: 'p', name: 'base', state: 'finished' });
  const call = async (name, payload) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tools/' + name,
      payload,
    });
    assert.equal(response.statusCode, 200, name + ': ' + response.body);
    return response.json();
  };
  const source = { document: 'handbook', lines: [1, 2] };
  await call('journal_add', { run: 'e/p/base', key: 'new', text: 'After the upgrade', source });
  const { entries } = await call('journal_list', { run: 'e/p/base' });
  assert.deepEqual(
    entries.map((entry) => [entry.text, entry.source]),
    [
      ['Logged before the upgrade', null],
      ['After the upgrade', source],
    ],
  );
  await call('finding_save', { project: 'e/p', id: 'f', title: 'Kept', source });
  assert.deepEqual((await call('finding_get', { project: 'e/p', id: 'f' })).finding.source, source);
  await call('recipe_set', { project: 'e/p', run: 'e/p/base', reason: 'best', source });
  assert.deepEqual((await call('recipe_get', { project: 'e/p' })).current.source, source);
  // The rename log gained `by` with its default.
  const check = new Database(join(directory, 'randl.sqlite3'), { readonly: true });
  t.after(() => check.close());
  const by = check.pragma('table_info(metric_renames)').find((column) => column.name === 'by');
  assert.equal(by.dflt_value, "''");
  assert.equal(by.notnull, 1);
});

test('ensureTables adds only missing columns and refuses a missing key column', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(a TEXT, b TEXT); INSERT INTO t VALUES(1, 2)');
  const added = ensureTables(
    db,
    "CREATE TABLE IF NOT EXISTS t(a TEXT, b TEXT, c TEXT NOT NULL DEFAULT 'x', d REAL NOT NULL);",
  );
  assert.deepEqual(added, ['t.c', 't.d']);
  assert.deepEqual(db.prepare('SELECT * FROM t').get(), { a: '1', b: '2', c: 'x', d: null });
  assert.deepEqual(ensureTables(db, 'CREATE TABLE IF NOT EXISTS t(a TEXT, b TEXT);'), []);
  db.exec('CREATE TABLE k(x TEXT)');
  assert.throws(
    () => ensureTables(db, 'CREATE TABLE IF NOT EXISTS k(id TEXT PRIMARY KEY, x TEXT);'),
    /lacks its key column id/,
  );
});
