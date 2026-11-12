import type Database from 'better-sqlite3';

/**
 * Runs `CREATE TABLE IF NOT EXISTS` statements, then adds the columns a table created by an
 * earlier version lacks, so a column added later cannot break a deployed database. Each
 * declared table is compared with a temporary copy of its declaration; a missing column is
 * added with its type and default, and keeps NOT NULL only when it has a default (existing
 * rows need a value). A missing primary key column cannot be added, and stops startup.
 */
export function ensureTables(db: Database.Database, sql: string) {
  db.exec(sql);
  const added: string[] = [];
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g)) {
    const table = match[1],
      start = match.index! + match[0].length - 1;
    let depth = 0,
      end = start;
    for (; end < sql.length; end++) {
      if (sql[end] === '(') depth++;
      else if (sql[end] === ')' && --depth === 0) break;
    }
    const shadow = 'declared_' + table;
    db.exec(`DROP TABLE IF EXISTS temp.${shadow}`);
    db.exec(`CREATE TEMP TABLE ${shadow}${sql.slice(start, end + 1)}`);
    type Column = {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    };
    const declared = db.pragma(`temp.table_info(${shadow})`) as Column[],
      stored = new Set((db.pragma(`main.table_info(${table})`) as Column[]).map((c) => c.name));
    db.exec(`DROP TABLE temp.${shadow}`);
    for (const column of declared) {
      if (stored.has(column.name)) continue;
      if (column.pk) throw Error(`Table ${table} lacks its key column ${column.name}`);
      const hasDefault = column.dflt_value !== null;
      db.exec(
        `ALTER TABLE main.${table} ADD COLUMN "${column.name}" ${column.type}` +
          (column.notnull && hasDefault ? ' NOT NULL' : '') +
          (hasDefault ? ' DEFAULT ' + column.dflt_value : ''),
      );
      added.push(table + '.' + column.name);
    }
  }
  return added;
}
