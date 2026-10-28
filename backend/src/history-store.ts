import type Database from 'better-sqlite3';
import {
  encodePoints,
  decodePoints,
  decodePointSteps,
  encodeLines,
  decodeLines,
  N_POINTS,
  N_LINES,
  LINE_BYTES,
  type Point,
  type Line,
  type PointBlock,
  type LineBlock,
} from './history-codec.js';
type Row = Record<string, any>;
type Key = number | string;
type Range = { lo?: number; hi?: number; scale?: number; origin?: number };
export type Budget = { until: number; points: number; lines: number };
export class HistoryStore {
  private statements = new Map<string, Database.Statement>();
  private dictionaries = {
    run_keys: new Map<string, number>(),
    metric_names: new Map<string, number>(),
    stream_files: new Map<string, number>(),
  };
  private bounds = new Map<string, number>();
  private counts = new Map<string, number>();
  private due = new Map<number, Set<number>>();
  private late = new Map<string, Map<number, number>>();
  private lateLines = new Map<string, Map<number, string>>();
  private decoded:
    | { id: number; run: number; file: number; first: number; last: number; rows: Line[] }
    | undefined;
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_keys(key INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS metric_names(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS stream_files(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS run_metrics(run INTEGER NOT NULL,metric INTEGER NOT NULL,PRIMARY KEY(run,metric)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS media(run INTEGER NOT NULL,metric INTEGER NOT NULL,step REAL NOT NULL,value TEXT NOT NULL,PRIMARY KEY(run,metric,step)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS point_tail(run INTEGER NOT NULL,metric INTEGER NOT NULL,step REAL NOT NULL,value REAL NOT NULL,PRIMARY KEY(run,metric,step)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS point_blocks(id INTEGER PRIMARY KEY,run INTEGER NOT NULL,metric INTEGER NOT NULL,first REAL NOT NULL,last REAL NOT NULL,n INTEGER NOT NULL,min_value REAL NOT NULL,max_value REAL NOT NULL,last_value REAL NOT NULL,codec INTEGER NOT NULL,steps BLOB NOT NULL,vals BLOB NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS point_blocks_series ON point_blocks(run,metric,first,last,n,min_value,max_value,last_value);
      CREATE TABLE IF NOT EXISTS stream_tail(run INTEGER NOT NULL,file INTEGER NOT NULL,offset INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(run,file,offset));
      CREATE TABLE IF NOT EXISTS stream_blocks(id INTEGER PRIMARY KEY,run INTEGER NOT NULL,file INTEGER NOT NULL,first INTEGER NOT NULL,last INTEGER NOT NULL,n INTEGER NOT NULL,bytes INTEGER NOT NULL,largest INTEGER NOT NULL,step_hi REAL,step_hi_offset INTEGER,body BLOB NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS stream_blocks_range ON stream_blocks(run,file,first,last,n,bytes,largest,step_hi,step_hi_offset);
    `);
    for (const [table, amount] of [
      ['stream_tail', 'length(CAST(NEW.content AS BLOB))'],
      ['stream_blocks', 'NEW.bytes'],
    ]) {
      const old = amount.replaceAll('NEW.', 'OLD.');
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_bytes_insert AFTER INSERT ON ${table} BEGIN UPDATE runs SET stream_bytes=stream_bytes+${amount} WHERE id=(SELECT id FROM run_keys WHERE key=NEW.run); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_bytes_update AFTER UPDATE OF ${table === 'stream_tail' ? 'content' : 'bytes'} ON ${table} BEGIN UPDATE runs SET stream_bytes=stream_bytes-${old}+${amount} WHERE id=(SELECT id FROM run_keys WHERE key=NEW.run); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_bytes_delete AFTER DELETE ON ${table} BEGIN UPDATE runs SET stream_bytes=stream_bytes-${old} WHERE id=(SELECT id FROM run_keys WHERE key=OLD.run); END;`);
    }
  }
  private sql(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }
  resetCaches() {
    for (const cache of Object.values(this.dictionaries)) cache.clear();
    this.bounds.clear();
    this.counts.clear();
    this.due.clear();
    this.late.clear();
    this.lateLines.clear();
    this.decoded = undefined;
  }
  transaction<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (e) {
      this.resetCaches();
      throw e;
    }
  }
  private dictionary(
    table: keyof HistoryStore['dictionaries'],
    name: string,
    create = false,
  ): number | undefined {
    const cache = this.dictionaries[table];
    let id = cache.get(name);
    if (id !== undefined) return id;
    const column = table === 'run_keys' ? 'id' : 'name',
      key = table === 'run_keys' ? 'key' : 'id';
    if (create) this.sql(`INSERT OR IGNORE INTO ${table}(${column}) VALUES(?)`).run(name);
    id = (
      this.sql(`SELECT ${key} AS id FROM ${table} WHERE ${column}=?`).get(name) as Row | undefined
    )?.id;
    if (id !== undefined) cache.set(name, id);
    return id;
  }
  runKey(id: string) {
    return this.dictionary('run_keys', id);
  }
  ensureRunKey(id: string) {
    return this.dictionary('run_keys', id, true)!;
  }
  metricId(name: string) {
    return this.dictionary('metric_names', name);
  }
  ensureMetricId(name: string) {
    return this.dictionary('metric_names', name, true)!;
  }
  fileId(name: string) {
    return this.dictionary('stream_files', name);
  }
  ensureFileId(name: string) {
    return this.dictionary('stream_files', name, true)!;
  }
  private run(key: Key) {
    return typeof key === 'number' ? key : (this.runKey(key) ?? -1);
  }
  private metric(key: Key) {
    return typeof key === 'number' ? key : (this.metricId(key) ?? -1);
  }
  private file(key: Key) {
    return typeof key === 'number' ? key : (this.fileId(key) ?? -1);
  }
  private bound(kind: 'point' | 'stream', run: number, key: number) {
    const id = `${kind}:${run}:${key}`;
    let value = this.bounds.get(id);
    if (value === undefined) {
      value =
        (
          this.sql(
            `SELECT last FROM ${kind}_blocks WHERE run=? AND ${kind === 'point' ? 'metric' : 'file'}=? ORDER BY first DESC LIMIT 1`,
          ).get(run, key) as Row | undefined
        )?.last ?? -Infinity;
      this.bounds.set(id, value!);
    }
    return value!;
  }
  pointPut(run: number, metric: number, step: number, value: number) {
    if (step <= this.bound('point', run, metric)) {
      const id = `${run}:${metric}`;
      let writes = this.late.get(id);
      if (!writes) {
        writes = new Map();
        this.late.set(id, writes);
      }
      writes.set(step, value);
      return;
    }
    const id = `${run}:${metric}`,
      count =
        (this.counts.get(id) ??
          (
            this.sql('SELECT count(*) n FROM point_tail WHERE run=? AND metric=?').get(
              run,
              metric,
            ) as Row
          ).n) + 1;
    this.counts.set(id, count);
    if (count >= N_POINTS) {
      let due = this.due.get(run);
      if (!due) {
        due = new Set();
        this.due.set(run, due);
      }
      due.add(metric);
    }
    this.sql('INSERT OR REPLACE INTO point_tail VALUES(?,?,?,?)').run(run, metric, step, value);
  }
  catalogAdd(run: number, metric: number) {
    this.sql('INSERT OR IGNORE INTO run_metrics VALUES(?,?)').run(run, metric);
  }
  mediaPut(run: number, metric: number, step: number, value: string) {
    this.sql('INSERT OR REPLACE INTO media VALUES(?,?,?,?)').run(run, metric, step, value);
  }
  private lineBlock(row: Row): Line[] {
    if (this.decoded?.id !== row.id)
      this.decoded = {
        id: row.id,
        run: row.run,
        file: row.file,
        first: row.first,
        last: row.last,
        rows: decodeLines(row as LineBlock),
      };
    return this.decoded!.rows;
  }
  lineGet(run: number, file: number, offset: number) {
    const staged = this.lateLines.get(`${run}:${file}`)?.get(offset);
    if (staged !== undefined) return staged;
    if (offset > this.bound('stream', run, file))
      return (
        this.sql('SELECT content FROM stream_tail WHERE run=? AND file=? AND offset=?').get(
          run,
          file,
          offset,
        ) as Row | undefined
      )?.content as string | undefined;
    const cached = this.decoded;
    if (
      cached &&
      cached.run === run &&
      cached.file === file &&
      offset >= cached.first &&
      offset <= cached.last
    )
      return cached.rows.find((row) => row.offset === offset)?.content;
    const block = this.sql(
      'SELECT * FROM stream_blocks WHERE run=? AND file=? AND first<=? AND last>=? ORDER BY first DESC LIMIT 1',
    ).get(run, file, offset, offset) as Row | undefined;
    return block ? this.lineBlock(block).find((r) => r.offset === offset)?.content : undefined;
  }
  linePut(run: number, file: number, offset: number, content: string): 'inserted' | 'replaced' {
    const previous = this.lineGet(run, file, offset);
    if (previous === content) return 'replaced';
    if (previous !== undefined && file === this.fileId('wandb-history.jsonl'))
      throw Error('Conflicting history replay');
    if (offset <= this.bound('stream', run, file)) {
      const key = `${run}:${file}`;
      let writes = this.lateLines.get(key);
      if (!writes) {
        writes = new Map();
        this.lateLines.set(key, writes);
      }
      writes.set(offset, content);
    } else
      this.sql(
        'INSERT INTO stream_tail VALUES(?,?,?,?) ON CONFLICT(run,file,offset) DO UPDATE SET content=excluded.content',
      ).run(run, file, offset, content);
    return previous === undefined ? 'inserted' : 'replaced';
  }
  private target(kind: 'point' | 'stream', run: number, key: number, value: number): Row {
    const column = kind === 'point' ? 'metric' : 'file';
    return (this.sql(
      `SELECT id FROM ${kind}_blocks WHERE run=? AND ${column}=? AND first<=? ORDER BY first DESC LIMIT 1`,
    ).get(run, key, value) ??
      this.sql(
        `SELECT id FROM ${kind}_blocks WHERE run=? AND ${column}=? ORDER BY first LIMIT 1`,
      ).get(run, key)) as Row;
  }
  private insertPoints(run: number, metric: number, rows: Point[]) {
    const b = encodePoints(rows);
    this.sql(
      'INSERT INTO point_blocks(run,metric,first,last,n,min_value,max_value,last_value,codec,steps,vals) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      run,
      metric,
      b.first,
      b.last,
      b.n,
      b.min_value,
      b.max_value,
      b.last_value,
      b.codec,
      b.steps,
      b.vals,
    );
    this.bounds.delete(`point:${run}:${metric}`);
  }
  private insertLines(run: number, file: number, rows: Line[]) {
    const name = (this.sql('SELECT name FROM stream_files WHERE id=?').get(file) as Row).name,
      b = encodeLines(rows, name === 'wandb-history.jsonl');
    this.sql(
      'INSERT INTO stream_blocks(run,file,first,last,n,bytes,largest,step_hi,step_hi_offset,body) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(run, file, b.first, b.last, b.n, b.bytes, b.largest, b.step_hi, b.step_hi_offset, b.body);
    this.bounds.delete(`stream:${run}:${file}`);
    this.decoded = undefined;
  }
  finishWrites(run: number) {
    for (const [key, writes] of this.lateLines) {
      const [r, f] = key.split(':').map(Number);
      if (r !== run) continue;
      const blocks = new Map<number, { row: Row; writes: Map<number, string> }>();
      for (const [offset, content] of writes) {
        const row = this.target('stream', r, f, offset);
        let item = blocks.get(row.id);
        if (!item) {
          item = { row, writes: new Map() };
          blocks.set(row.id, item);
        }
        item.writes.set(offset, content);
      }
      for (const { row, writes } of blocks.values()) {
        const block = this.sql('SELECT * FROM stream_blocks WHERE id=?').get(row.id) as Row;
        const merged = new Map(this.lineBlock(block).map((line) => [line.offset, line.content]));
        for (const [offset, content] of writes) merged.set(offset, content);
        const rows = [...merged]
          .sort((a, b) => a[0] - b[0])
          .map(([offset, content]) => ({ offset, content }));
        this.sql('DELETE FROM stream_blocks WHERE id=?').run(row.id);
        this.decoded = undefined;
        const oversized =
          rows.length > N_LINES * 2 ||
          rows.reduce((bytes, line) => bytes + Buffer.byteLength(line.content), 0) > LINE_BYTES * 2;
        const lineLimit = oversized ? N_LINES : N_LINES * 2,
          byteLimit = oversized ? LINE_BYTES : LINE_BYTES * 2;
        let part: Line[] = [],
          bytes = 0;
        for (const line of rows) {
          const n = Buffer.byteLength(line.content);
          if (part.length && (part.length >= lineLimit || bytes + n > byteLimit)) {
            this.insertLines(r, f, part);
            part = [];
            bytes = 0;
          }
          part.push(line);
          bytes += n;
        }
        if (part.length) this.insertLines(r, f, part);
      }
      this.lateLines.delete(key);
    }

    for (const [key, writes] of this.late) {
      const [r, m] = key.split(':').map(Number);
      if (r !== run) continue;
      const blocks = new Map<number, { row: Row; writes: Map<number, number> }>();
      for (const [step, value] of writes) {
        const row = this.target('point', r, m, step);
        let item = blocks.get(row.id);
        if (!item) {
          item = { row, writes: new Map() };
          blocks.set(row.id, item);
        }
        item.writes.set(step, value);
      }
      for (const { row, writes } of blocks.values()) {
        const data = decodePoints(
            this.sql('SELECT * FROM point_blocks WHERE id=?').get(row.id) as PointBlock,
          ),
          points = new Map<number, number>();
        data.steps.forEach((step, i) => points.set(step, data.values[i]));
        for (const [step, value] of writes) points.set(step, value);
        const rows = [...points]
          .sort((a, b) => a[0] - b[0])
          .map(([step, value]) => ({ step, value }));
        this.sql('DELETE FROM point_blocks WHERE id=?').run(row.id);
        const insert = (part: Point[]) => {
          if (part.length <= N_POINTS * 2) {
            this.insertPoints(r, m, part);
            return;
          }
          const mid = Math.ceil(part.length / 2);
          insert(part.slice(0, mid));
          insert(part.slice(mid));
        };
        insert(rows);
      }
      this.late.delete(key);
    }
    this.sealRun(run, { until: performance.now() + 24, points: 64, lines: 0 }, false, true);
  }
  private sealTransaction<T>(fn: () => T): T {
    // The caller owns rollback during ingestion and maintenance. Standalone seals
    // still commit atomically; reusing the owner avoids a savepoint per series.
    return this.db.inTransaction ? fn() : this.transaction(fn);
  }
  sealRun(run: number, budget: Budget, partial: boolean, inline = false): boolean {
    const metrics = inline
      ? [...(this.due.get(run) ?? [])].map((metric) => ({ metric }))
      : (this.sql(
          'SELECT id metric FROM metric_names m WHERE EXISTS(SELECT 1 FROM point_tail p WHERE p.run=? AND p.metric=m.id)',
        ).all(run) as { metric: number }[]);
    for (const { metric } of metrics) {
      const hint = this.counts.get(`${run}:${metric}`);
      if (!partial && hint !== undefined && hint < N_POINTS) continue;
      if (budget.points <= 0 || performance.now() >= budget.until) return false;
      const n = (
        this.sql('SELECT count(*) n FROM point_tail WHERE run=? AND metric=?').get(
          run,
          metric,
        ) as Row
      ).n;
      if (!partial && n < N_POINTS) {
        this.due.get(run)?.delete(metric);
        this.counts.set(`${run}:${metric}`, n);
        continue;
      }
      let remaining = n;
      while (remaining && (partial || remaining >= N_POINTS)) {
        if (budget.points <= 0 || performance.now() >= budget.until) return false;
        this.sealTransaction(() => {
          let rows: Point[] = [];
          const last = this.sql(
            'SELECT id,n FROM point_blocks WHERE run=? AND metric=? ORDER BY first DESC LIMIT 1',
          ).get(run, metric) as Row | undefined;
          if (last && last.n < N_POINTS) {
            const data = decodePoints(
              this.sql('SELECT * FROM point_blocks WHERE id=?').get(last.id) as PointBlock,
            );
            rows = Array.from(data.steps, (step, i) => ({ step, value: data.values[i] }));
            this.sql('DELETE FROM point_blocks WHERE id=?').run(last.id);
          }
          const tail = this.sql(
            'SELECT step,value FROM point_tail WHERE run=? AND metric=? ORDER BY step LIMIT ?',
          ).all(run, metric, N_POINTS - rows.length) as Point[];
          rows.push(...tail);
          this.insertPoints(run, metric, rows);
          this.sql('DELETE FROM point_tail WHERE run=? AND metric=? AND step<=?').run(
            run,
            metric,
            tail.at(-1)!.step,
          );
          remaining -= tail.length;
        });
        budget.points--;
        this.counts.set(`${run}:${metric}`, remaining);
        if (remaining < N_POINTS) this.due.get(run)?.delete(metric);
      }
    }
    if (inline) return true;
    const files = this.sql(
      "SELECT f.id file,(SELECT count(*) FROM stream_tail s WHERE s.run=? AND s.file=f.id) n,(SELECT sum(length(CAST(content AS BLOB))) FROM (SELECT content FROM stream_tail s WHERE s.run=? AND s.file=f.id LIMIT 256)) bytes FROM stream_files f WHERE f.name!='wandb-summary.json' AND EXISTS(SELECT 1 FROM stream_tail s WHERE s.run=? AND s.file=f.id)",
    ).all(run, run, run) as Row[];
    for (const { file, n, bytes } of files) {
      if (!partial && n < N_LINES && bytes < LINE_BYTES) continue;
      let remaining = n,
        remainingBytes = bytes;
      while (remaining && (partial || remaining >= N_LINES || remainingBytes >= LINE_BYTES)) {
        if (budget.lines <= 0 || performance.now() >= budget.until) return false;
        this.sealTransaction(() => {
          let rows: Line[] = [],
            size = 0;
          const last = this.sql(
            'SELECT * FROM stream_blocks WHERE run=? AND file=? ORDER BY first DESC LIMIT 1',
          ).get(run, file) as Row | undefined;
          if (last && last.n < N_LINES && last.bytes < LINE_BYTES) {
            rows = this.lineBlock(last).slice();
            size = last.bytes;
            this.sql('DELETE FROM stream_blocks WHERE id=?').run(last.id);
            this.decoded = undefined;
          }
          const tail = this.sql(
            'SELECT offset,content FROM stream_tail WHERE run=? AND file=? ORDER BY offset LIMIT ?',
          ).iterate(run, file, N_LINES - rows.length) as Iterable<Line>;
          let lastOffset: number | undefined;
          for (const row of tail) {
            const bytes = Buffer.byteLength(row.content);
            if (rows.length && size + bytes > LINE_BYTES) break;
            rows.push(row);
            size += bytes;
            lastOffset = row.offset;
            remaining--;
            remainingBytes -= bytes;
          }
          // A large next line cannot top up a partial block: retain that block, then seal it alone.
          this.insertLines(run, file, rows);
          if (lastOffset !== undefined)
            this.sql('DELETE FROM stream_tail WHERE run=? AND file=? AND offset<=?').run(
              run,
              file,
              lastOffset,
            );
          else {
            const row = this.sql(
              'SELECT offset,content FROM stream_tail WHERE run=? AND file=? ORDER BY offset LIMIT 1',
            ).get(run, file) as Line;
            this.insertLines(run, file, [row]);
            this.sql('DELETE FROM stream_tail WHERE run=? AND file=? AND offset=?').run(
              run,
              file,
              row.offset,
            );
            remaining--;
            remainingBytes -= Buffer.byteLength(row.content);
          }
        });
        budget.lines--;
      }
    }
    return true;
  }
  maintain(budgetMs: number, blockLimit = Infinity) {
    const budget = { until: performance.now() + budgetMs, points: blockLimit, lines: blockLimit };
    const runs = this.sql(
      "SELECT k.key,r.state,r.snapshot_at FROM runs r JOIN run_keys k ON k.id=r.id WHERE EXISTS(SELECT 1 FROM point_tail p WHERE p.run=k.key) OR EXISTS(SELECT 1 FROM stream_tail s WHERE s.run=k.key AND s.file NOT IN (SELECT id FROM stream_files WHERE name='wandb-summary.json')) ORDER BY (r.state='running' AND r.snapshot_at IS NULL) DESC,r.heartbeat",
    ).all() as Row[];
    for (const r of runs) {
      if (performance.now() >= budget.until) return true;
      const done = this.transaction(() =>
        this.sealRun(r.key, budget, r.state !== 'running' || r.snapshot_at !== null),
      );
      if (!done) return true;
    }
    if (
      performance.now() < budget.until &&
      Number(this.db.pragma('freelist_count', { simple: true })) *
        Number(this.db.pragma('page_size', { simple: true })) >
        64 * 1024 ** 2
    ) {
      this.db.pragma('incremental_vacuum(1024)');
      return true;
    }
    return false;
  }
  series(run: Key, metric: Key, range: Range = {}) {
    const r = this.run(run),
      m = this.metric(metric),
      lo = range.lo ?? -Infinity,
      hi = range.hi ?? Infinity,
      scale = range.scale ?? 1,
      origin = range.origin ?? 0;
    const capacity = (
      this.sql(
        'SELECT coalesce(sum(n),0) n FROM (SELECT n FROM point_blocks WHERE run=? AND metric=? AND last*?-?>=? AND first*?-?<=? UNION ALL SELECT count(*) n FROM point_tail WHERE run=? AND metric=? AND step*?-?>=? AND step*?-?<=?)',
      ).get(
        r,
        m,
        scale,
        origin,
        lo,
        scale,
        origin,
        hi,
        r,
        m,
        scale,
        origin,
        lo,
        scale,
        origin,
        hi,
      ) as Row
    ).n;
    const steps = new Float64Array(capacity),
      values = new Float64Array(capacity);
    let used = 0;
    for (const block of this.sql(
      'SELECT * FROM point_blocks WHERE run=? AND metric=? AND last*?-?>=? AND first*?-?<=? ORDER BY first',
    ).iterate(r, m, scale, origin, lo, scale, origin, hi) as Iterable<PointBlock>) {
      const data = decodePoints(block);
      if (block.first * scale - origin >= lo && block.last * scale - origin <= hi) {
        steps.set(data.steps, used);
        values.set(data.values, used);
        used += data.steps.length;
        continue;
      }
      for (let i = 0; i < data.steps.length; i++)
        if (data.steps[i] * scale - origin >= lo && data.steps[i] * scale - origin <= hi) {
          steps[used] = data.steps[i];
          values[used++] = data.values[i];
        }
    }
    for (const row of this.sql(
      'SELECT step,value FROM point_tail WHERE run=? AND metric=? AND step*?-?>=? AND step*?-?<=? ORDER BY step',
    ).iterate(r, m, scale, origin, lo, scale, origin, hi) as Iterable<Point>) {
      steps[used] = row.step;
      values[used++] = row.value;
    }
    return { steps: steps.subarray(0, used), values: values.subarray(0, used) };
  }
  stats(run: Key, metric: Key, range?: Range): { n: number; lo: number | null; hi: number | null } {
    const r = this.run(run),
      m = this.metric(metric);
    if (!range)
      return this.sql(
        'SELECT coalesce(sum(n),0) n,min(lo) lo,max(hi) hi FROM (SELECT sum(n) n,min(first) lo,max(last) hi FROM point_blocks WHERE run=? AND metric=? UNION ALL SELECT count(*) n,min(step) lo,max(step) hi FROM point_tail WHERE run=? AND metric=?)',
      ).get(r, m, r, m) as { n: number; lo: number | null; hi: number | null };
    const low = range.lo ?? -Infinity,
      high = range.hi ?? Infinity,
      scale = range.scale ?? 1,
      origin = range.origin ?? 0;
    const result = this.sql(
      'SELECT count(*) n,min(step) lo,max(step) hi FROM point_tail WHERE run=? AND metric=? AND step*?-?>=? AND step*?-?<=?',
    ).get(r, m, scale, origin, low, scale, origin, high) as {
      n: number;
      lo: number | null;
      hi: number | null;
    };
    const add = (n: number, lo: number, hi: number) => {
      result.n += n;
      result.lo = result.lo === null ? lo : Math.min(result.lo, lo);
      result.hi = result.hi === null ? hi : Math.max(result.hi, hi);
    };
    for (const b of this.sql(
      'SELECT id,first,last,n FROM point_blocks WHERE run=? AND metric=? AND last*?-?>=? AND first*?-?<=? ORDER BY first',
    ).iterate(r, m, scale, origin, low, scale, origin, high) as Iterable<Row>) {
      if (b.first * scale - origin >= low && b.last * scale - origin <= high)
        add(b.n, b.first, b.last);
      else {
        const steps = decodePointSteps(
          this.sql('SELECT first,last,n,codec,steps FROM point_blocks WHERE id=?').get(
            b.id,
          ) as PointBlock,
        );
        for (const step of steps)
          if (step * scale - origin >= low && step * scale - origin <= high) add(1, step, step);
      }
    }
    return result;
  }
  /**
   * series() for many runs at once (two queries instead of three per run), with steps scaled
   * by `range.scale` and no origin. Runs without points are absent.
   */
  seriesMany(runs: string[], metric: string, range: Omit<Range, 'origin'> = {}) {
    const result = new Map<string, { steps: Float64Array; values: Float64Array }>(),
      m = this.metricId(metric);
    if (m === undefined || !runs.length) return result;
    const lo = range.lo ?? -Infinity,
      hi = range.hi ?? Infinity,
      scale = range.scale ?? 1,
      list = JSON.stringify(runs),
      parts = new Map<string, { steps: Float64Array; values: Float64Array }[]>();
    const add = (run: string, steps: Float64Array, values: Float64Array) => {
      const list = parts.get(run);
      if (list) list.push({ steps, values });
      else parts.set(run, [{ steps, values }]);
    };
    for (const block of this.sql(
      'SELECT k.id rid,b.* FROM json_each(?) j JOIN run_keys k ON k.id=j.value JOIN point_blocks b ON b.run=k.key AND b.metric=? AND b.last*?>=? AND b.first*?<=? ORDER BY j.key,b.first',
    ).iterate(list, m, scale, lo, scale, hi) as Iterable<PointBlock & { rid: string }>) {
      const data = decodePoints(block);
      if (block.first * scale >= lo && block.last * scale <= hi)
        add(block.rid, data.steps, data.values);
      else {
        const steps: number[] = [],
          values: number[] = [];
        for (let i = 0; i < data.steps.length; i++)
          if (data.steps[i] * scale >= lo && data.steps[i] * scale <= hi) {
            steps.push(data.steps[i]);
            values.push(data.values[i]);
          }
        add(block.rid, Float64Array.from(steps), Float64Array.from(values));
      }
    }
    let run = '',
      steps: number[] = [],
      values: number[] = [];
    const flush = () => {
      if (steps.length) add(run, Float64Array.from(steps), Float64Array.from(values));
      steps = [];
      values = [];
    };
    for (const row of this.sql(
      'SELECT k.id rid,t.step,t.value FROM json_each(?) j JOIN run_keys k ON k.id=j.value JOIN point_tail t ON t.run=k.key AND t.metric=? AND t.step*?>=? AND t.step*?<=? ORDER BY j.key,t.step',
    ).iterate(list, m, scale, lo, scale, hi) as Iterable<Point & { rid: string }>) {
      if (row.rid !== run) {
        flush();
        run = row.rid;
      }
      steps.push(row.step);
      values.push(row.value);
    }
    flush();
    for (const [id, list] of parts) {
      if (list.length === 1) {
        result.set(id, list[0]);
        continue;
      }
      const size = list.reduce((sum, part) => sum + part.steps.length, 0),
        steps = new Float64Array(size),
        values = new Float64Array(size);
      let used = 0;
      for (const part of list) {
        steps.set(part.steps, used);
        values.set(part.values, used);
        used += part.steps.length;
      }
      result.set(id, { steps, values });
    }
    return result;
  }
  /** Point counts, step ranges and value ranges of one metric for many runs, from block metadata. */
  extents(runs: string[], metric: string) {
    const result = new Map<
      string,
      { n: number; lo: number; hi: number; min: number; max: number }
    >();
    if (!runs.length) return result;
    const rows = this.sql(
      `SELECT id,sum(n) n,min(lo) lo,max(hi) hi,min(vlo) min,max(vhi) max FROM (
        SELECT k.id,b.n,b.first lo,b.last hi,b.min_value vlo,b.max_value vhi FROM json_each(?) j JOIN run_keys k ON k.id=j.value JOIN point_blocks b ON b.run=k.key AND b.metric=(SELECT id FROM metric_names WHERE name=?)
        UNION ALL SELECT k.id,1,t.step,t.step,t.value,t.value FROM json_each(?) j JOIN run_keys k ON k.id=j.value JOIN point_tail t ON t.run=k.key AND t.metric=(SELECT id FROM metric_names WHERE name=?)
      ) GROUP BY id`,
    ).all(JSON.stringify(runs), metric, JSON.stringify(runs), metric) as Row[];
    for (const row of rows) result.set(row.id, row as any);
    return result;
  }
  minValue(run: Key, metric: Key): number | null {
    const r = this.run(run),
      m = this.metric(metric);
    return (
      this.sql(
        'SELECT min(v) v FROM (SELECT min(min_value) v FROM point_blocks WHERE run=? AND metric=? UNION ALL SELECT min(value) v FROM point_tail WHERE run=? AND metric=?)',
      ).get(r, m, r, m) as Row
    ).v;
  }
  lastPoint(run: Key, metric: Key): Point | null {
    const r = this.run(run),
      m = this.metric(metric);
    return (this.sql(
      'SELECT step,value FROM point_tail WHERE run=? AND metric=? ORDER BY step DESC LIMIT 1',
    ).get(r, m) ??
      this.sql(
        'SELECT last step,last_value value FROM point_blocks WHERE run=? AND metric=? ORDER BY first DESC LIMIT 1',
      ).get(r, m) ??
      null) as Point | null;
  }
  hasPoints(run: Key, metric: Key) {
    const r = this.run(run),
      m = this.metric(metric);
    return !!(
      this.sql('SELECT 1 FROM point_tail WHERE run=? AND metric=? LIMIT 1').get(r, m) ??
      this.sql('SELECT 1 FROM point_blocks WHERE run=? AND metric=? LIMIT 1').get(r, m)
    );
  }
  metricCounts(run: Key): Map<string, number> {
    return new Map(
      (
        this.sql(
          'SELECT name,sum(n) n FROM (SELECT metric,sum(n) n FROM point_blocks WHERE run=? GROUP BY metric UNION ALL SELECT metric,count(*) n FROM point_tail WHERE run=? GROUP BY metric) JOIN metric_names ON id=metric GROUP BY name ORDER BY name',
        ).all(this.run(run), this.run(run)) as Row[]
      ).map((r) => [r.name, r.n]),
    );
  }
  lineCount(run: Key, file: Key) {
    const r = this.run(run),
      f = this.file(file);
    return (
      this.sql(
        'SELECT coalesce(max(n)+1,0) n FROM (SELECT max(last) n FROM stream_blocks WHERE run=? AND file=? UNION ALL SELECT max(offset) n FROM stream_tail WHERE run=? AND file=?)',
      ).get(r, f, r, f) as Row
    ).n as number;
  }
  lastLine(run: Key, file: Key): Line | undefined {
    const r = this.run(run),
      f = this.file(file),
      tail = this.sql(
        'SELECT offset,content FROM stream_tail WHERE run=? AND file=? ORDER BY offset DESC LIMIT 1',
      ).get(r, f) as Line | undefined;
    if (tail) return tail;
    const b = this.sql(
      'SELECT * FROM stream_blocks WHERE run=? AND file=? ORDER BY first DESC LIMIT 1',
    ).get(r, f) as Row | undefined;
    return b ? this.lineBlock(b).at(-1) : undefined;
  }
  *lines(run: Key, file: Key, from = -1): Iterable<Line> {
    const r = this.run(run),
      f = this.file(file);
    for (const b of this.sql(
      'SELECT * FROM stream_blocks WHERE run=? AND file=? AND last>? ORDER BY first',
    ).iterate(r, f, from) as Iterable<Row>)
      for (const row of this.lineBlock(b)) if (row.offset > from) yield row;
    yield* this.sql(
      'SELECT offset,content FROM stream_tail WHERE run=? AND file=? AND offset>? ORDER BY offset',
    ).iterate(r, f, from) as Iterable<Line>;
  }
  linePage(run: Key, file: Key, cursor: number): Line[] {
    const rows: Line[] = [];
    const r = this.run(run),
      f = this.file(file),
      block = this.sql(
        'SELECT * FROM stream_blocks WHERE run=? AND file=? AND last>? ORDER BY first LIMIT 1',
      ).get(r, f, cursor) as Row | undefined;
    const source = block
      ? this.lineBlock(block)
      : (this.sql(
          'SELECT offset,content FROM stream_tail WHERE run=? AND file=? AND offset>? ORDER BY offset LIMIT 256',
        ).iterate(r, f, cursor) as Iterable<Line>);
    let size = 0;
    for (const row of source) {
      if (row.offset <= cursor) continue;
      const bytes = Buffer.byteLength(row.content);
      if (rows.length && (rows.length >= N_LINES || size + bytes > LINE_BYTES)) break;
      rows.push(row);
      size += bytes;
    }
    return rows;
  }
  lineStats(run: Key, file: Key): { records: number; bytes: number; largest: number } {
    const r = this.run(run),
      f = this.file(file);
    return this.sql(
      'SELECT coalesce(sum(n),0) records,coalesce(sum(bytes),0) bytes,coalesce(max(largest),0) largest FROM (SELECT sum(n) n,sum(bytes) bytes,max(largest) largest FROM stream_blocks WHERE run=? AND file=? UNION ALL SELECT count(*) n,sum(length(CAST(content AS BLOB))) bytes,max(length(CAST(content AS BLOB))) largest FROM stream_tail WHERE run=? AND file=?)',
    ).get(r, f, r, f) as { records: number; bytes: number; largest: number };
  }
  highestStepLine(run: Key, file: Key, step: number): string | undefined {
    const r = this.run(run),
      f = this.file(file);
    for (const b of this.sql(
      'SELECT * FROM stream_blocks WHERE run=? AND file=? AND step_hi>=? ORDER BY first',
    ).iterate(r, f, step) as Iterable<Row>)
      for (const row of this.lineBlock(b))
        if (JSON.parse(row.content)._step === step) return row.content;
    for (const row of this.sql(
      'SELECT content FROM stream_tail WHERE run=? AND file=? ORDER BY offset',
    ).iterate(r, f) as Iterable<Row>)
      if (JSON.parse(row.content)._step === step) return row.content;
  }
  logs(run: Key) {
    const r = this.run(run),
      f = this.file('output.log'),
      rows = this.sql(
        'SELECT offset,content FROM stream_tail WHERE run=? AND file=? ORDER BY offset DESC LIMIT 1000',
      ).all(r, f) as Line[];
    if (rows.length < 1000)
      for (const b of this.sql(
        'SELECT * FROM stream_blocks WHERE run=? AND file=? ORDER BY first DESC',
      ).iterate(r, f) as Iterable<Row>) {
        rows.push(
          ...this.lineBlock(b)
            .slice()
            .reverse()
            .slice(0, 1000 - rows.length),
        );
        if (rows.length === 1000) break;
      }
    return rows.reverse();
  }
  deleteRuns(keys: number[]) {
    for (const run of keys) {
      for (const table of [
        'point_tail',
        'point_blocks',
        'stream_tail',
        'stream_blocks',
        'run_metrics',
        'media',
      ])
        this.sql(`DELETE FROM ${table} WHERE run=?`).run(run);
      this.sql('DELETE FROM run_keys WHERE key=?').run(run);
    }
    this.resetCaches();
  }
}
