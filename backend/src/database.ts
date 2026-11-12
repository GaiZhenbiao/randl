import panelLimits from './panel-limits.json' with { type: 'json' };
import { historyStep, numericFields } from './history-record.js';
import { HistoryStore } from './history-store.js';
import { managementError } from './management-errors.js';
import { Projects } from './project-store.js';
import selectionLimits from './selection-limits.json' with { type: 'json' };
import { validateComputedMetrics } from './expressions.js';
import { snapshotStopError } from './run-snapshot.js';
import {
  recordChartJob,
  recordPasses,
  streamedTransform,
  type Columns,
  type Pass,
} from './record-chart.js';
import { GroupBuckets, RunBuckets, planGroupBuckets, type Extent } from './group-chart.js';
import { Conversations } from './conversations.js';
import { runFieldCatalog, liveRuntimeSQL, groupRuns, groupSeries } from './run-fields.js';
import { metricDefinitions, definitionFor, environmentMetadata } from './run-metadata.js';
import { advanceRuntime, plausibleRuntime, type RuntimeState } from './run-runtime.js';
import { parseLoggedJSON } from './logged-json.js';
import { Artifacts } from './artifact-store.js';
import { Ledger } from './ledger.js';
import {
  RunMatcher,
  acyclic,
  configPath,
  configValues,
  diffConfigs,
  edgeChangeLimit,
  flattenConfig,
  ignoredKey,
  lineageNode,
  loggedChanges,
  resolveParent,
  type LineageEdge,
  type LineageNode,
  type LineageRun,
  type LineageSettings,
} from './lineage.js';
import Database from 'better-sqlite3';
import { bucketWidth, chartResolution, chartSampled, type Series } from './chart-diff.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { limitMedia, mediaCount, mediaPaths } from './media-items.js';
export type Row = Record<string, any>;
const summaryBytes = (value: { summaries: Float64Array[] }) =>
  value.summaries.reduce((sum, item) => sum + item.byteLength + 64, 64);
/** Runs a job to completion. */
function drain<T>(job: Generator<void, T>) {
  for (;;) {
    const step = job.next();
    if (step.done) return step.value;
  }
}
/**
 * A history record with one top-level key renamed and the key order kept, or undefined when
 * the record lacks the key or already has the new one. Records are stored as JSON.stringify
 * output, so re-serializing changes nothing else.
 */
function renameKey(content: string, from: string, to: string) {
  if (!content.includes(JSON.stringify(from))) return undefined;
  const record = JSON.parse(content);
  if (!Object.hasOwn(record, from) || Object.hasOwn(record, to)) return undefined;
  return JSON.stringify(renameRecord(record, from, to));
}
function renameRecord(record: Row, from: string, to: string) {
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => [name === from ? to : name, value]),
  );
}
/** Increasing offsets as [first, last] runs, so a long history's rename log stays small. */
function offsetRanges(offsets: number[]) {
  const ranges: [number, number][] = [];
  for (const offset of offsets)
    if (ranges.length && ranges.at(-1)![1] === offset - 1) ranges.at(-1)![1] = offset;
    else ranges.push([offset, offset]);
  return ranges;
}
/**
 * The step for a logged value between two records, at their step-per-value rate, or undefined
 * when a neighbour is missing or the step would not be a whole number.
 */
function inferStep(
  value: number | undefined,
  near: { below?: { value: number; step: number }; above?: { value: number; step: number } },
) {
  const { below, above } = near;
  if (value === undefined || !below || !above) return undefined;
  const step = below.step + ((value - below.value) * (above.step - below.step)) / (above.value - below.value);
  return Number.isInteger(step) ? step : undefined;
}
/** True once `ms` have passed since it last returned true: when a job should yield. */
function slicer(ms = 15) {
  let start = performance.now();
  return () => {
    const now = performance.now();
    if (now - start < ms) return false;
    start = now;
    return true;
  };
}
/** Whether a chart result is a job to be advanced, rather than a finished chart. */
export const isJob = (value: unknown): value is Generator<void, Row> =>
  !!value && typeof (value as Generator).next === 'function' && Symbol.iterator in (value as object);
/**
 * Files to keep per media entry: at most `perEntry` each and `total` together, with at least
 * one per entry that has files, so every run stays visible. Unused shares go to entries with
 * more files.
 */
export function allocateFiles(counts: number[], perEntry: number, total: number) {
  const wanted = counts.map((count) => Math.min(count, perEntry)),
    quotas = wanted.map((count) => Math.min(count, 1));
  let left = total - quotas.reduce((sum, count) => sum + count, 0);
  for (let open = wanted.filter((count, i) => count > quotas[i]).length; left > 0 && open; ) {
    const share = Math.max(1, Math.floor(left / open));
    open = 0;
    for (const [i, count] of wanted.entries()) {
      if (left <= 0 || quotas[i] >= count) continue;
      const add = Math.min(share, count - quotas[i], left);
      quotas[i] += add;
      left -= add;
      if (quotas[i] < count) open++;
    }
  }
  return quotas;
}
export class Store {
  db: Database.Database;
  history: HistoryStore;
  artifacts: Artifacts;
  projectStore: Projects;
  conversations: Conversations;
  ledger: Ledger;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, 'randl.sqlite3'));
    const empty = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get();
    if (!empty && this.db.pragma('user_version', { simple: true }) !== 2) {
      this.db.close();
      throw Error(
        'This data directory uses an unsupported randl storage format. This server requires format 2; use a format-2 or empty data directory.',
      );
    }
    if (empty) {
      this.db.pragma('page_size=4096');
      this.db.pragma('auto_vacuum=INCREMENTAL');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('journal_size_limit=67108864');
    this.db.pragma('wal_autocheckpoint=256');
    this.db.pragma('busy_timeout = 10000');
    if(empty)this.db.exec('BEGIN');
    try {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,entity TEXT,project TEXT,name TEXT,display_name TEXT,state TEXT,created REAL,updated REAL,config TEXT DEFAULT '{}',summary TEXT DEFAULT '{}',tags TEXT DEFAULT '[]',notes TEXT DEFAULT '',history_count INTEGER DEFAULT 0,revision INTEGER DEFAULT 0,group_name TEXT DEFAULT '',job_type TEXT DEFAULT '',deleted_at REAL,stop_requested INTEGER DEFAULT 0,metadata TEXT DEFAULT '{}',host TEXT DEFAULT '',program TEXT DEFAULT '',git_remote TEXT DEFAULT '',git_commit TEXT DEFAULT '',username TEXT DEFAULT '',runtime REAL DEFAULT 0,runtime_at REAL,runtime_reported INTEGER DEFAULT 0,runtime_raw REAL,runtime_raw_at REAL,started REAL,heartbeat REAL,finished REAL,exit_code INTEGER,metric_revision INTEGER DEFAULT 0,metric_definitions TEXT DEFAULT '[]',snapshot_at REAL,snapshot_source TEXT,stream_bytes INTEGER NOT NULL DEFAULT 0,file_bytes INTEGER NOT NULL DEFAULT 0,resumed_at REAL,color_index INTEGER);
      CREATE INDEX IF NOT EXISTS running_run_heartbeats ON runs(heartbeat) WHERE state='running';
      CREATE INDEX IF NOT EXISTS project_runs ON runs(entity,project);
      CREATE TABLE IF NOT EXISTS server_settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires REAL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,archived INTEGER DEFAULT 0,description TEXT NOT NULL DEFAULT '',created REAL);
      CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY,name TEXT,project TEXT,body TEXT,version INTEGER DEFAULT 1,updated REAL);
      CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,manifest TEXT,source TEXT,revision TEXT,enabled INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time REAL,tool TEXT,arguments TEXT);
      CREATE TABLE IF NOT EXISTS run_alerts(id INTEGER PRIMARY KEY,run TEXT,title TEXT,text TEXT,severity TEXT,created REAL);
      CREATE TABLE IF NOT EXISTS metric_renames(id INTEGER PRIMARY KEY,run TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,merged INTEGER NOT NULL,offsets TEXT NOT NULL,steps TEXT,summary TEXT NOT NULL,by TEXT NOT NULL DEFAULT '',created REAL NOT NULL,undone REAL);
      CREATE INDEX IF NOT EXISTS run_alerts_run ON run_alerts(run,created);`);
    this.artifacts = new Artifacts(this.db);
    this.conversations = new Conversations(this.db);
    this.ledger = new Ledger(this.db);
    this.history = new HistoryStore(this.db);
    if (empty) {
      this.db.pragma('user_version=2');
      if (
        this.db.pragma('page_size', { simple: true }) !== 4096 ||
        this.db.pragma('auto_vacuum', { simple: true }) !== 2
      )
        throw Error('Invalid storage pragmas');
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS project_run_colors ON runs(entity,project,color_index)',
    );
    this.projectStore = new Projects(
      this.db,
      directory,
      (row, now) => this.presentRun(row, now)!,
      this.history,
    );
      if(empty)this.db.exec('COMMIT');
    }catch(error){
      if(this.db.inTransaction)this.db.exec('ROLLBACK');
      this.db.close();throw error;
    }
  }
  chatList(args:any){return this.conversations.list(args);}
  chatGet(args:any){return this.conversations.get(args);}
  chatEnsure(args:any){return this.conversations.ensure(args);}
  chatRename(args:any){return this.conversations.rename(args);}
  chatEntries(id:string){return this.conversations.entries(id);}
  chatCheckpoint(args:any){return this.conversations.checkpoint(args);}
  chatAppend(args:any){return this.conversations.append(args);}
  chatUpdate(args:any){return this.conversations.update(args);}
  chatReplace(args:any){return this.conversations.replace(args);}
  chatDelete(id:string){return this.conversations.delete(id);}
  settingGet(key: string) {
    const row = this.db.prepare('SELECT value FROM server_settings WHERE key=?').get(key) as
      Row | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  settingSet(key: string, value: any) {
    this.db
      .prepare('INSERT OR REPLACE INTO server_settings VALUES(?,?)')
      .run(key, JSON.stringify(value));
    return { ok: true };
  }
  settingDelete(key: string) {
    this.db.prepare('DELETE FROM server_settings WHERE key=?').run(key);
    return { ok: true };
  }
  authConfigure(fingerprint: string) {
    const previous = this.db
      .prepare("SELECT value FROM server_settings WHERE key='api-key-fingerprint'")
      .get() as Row | undefined;
    if (previous?.value !== fingerprint) {
      this.db.prepare('DELETE FROM sessions').run();
      this.db
        .prepare("INSERT OR REPLACE INTO server_settings VALUES('api-key-fingerprint',?)")
        .run(fingerprint);
    }
    return { ok: true };
  }
  sessionCreate(hash: string, expires: number) {
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(hash, expires);
    this.db
      .prepare(
        'DELETE FROM sessions WHERE hash NOT IN (SELECT hash FROM sessions ORDER BY expires DESC LIMIT 256)',
      )
      .run();
    return { ok: true };
  }
  sessionGet(hash: string) {
    return (
      this.db
        .prepare('SELECT expires FROM sessions WHERE hash=? AND expires>?')
        .get(hash, Date.now()) || null
    );
  }
  sessionDelete(hash: string) {
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);
    return { ok: true };
  }
  artifact(method: string, args: Row) {
    return this.artifacts.operation(method, args);
  }
  storageMaintain(budgetMs = 50, blockLimit = Infinity) {
    return this.history.maintain(budgetMs, blockLimit);
  }
  logs(id: string) {
    return this.history.logs(id);
  }
  exportHistory(id: string, file = 'wandb-history.jsonl', cursor = -1) {
    return this.history.linePage(id, file, cursor);
  }
  runEdit(args: Row) {
    const run = this.run(args.id);
    if (!run) throw managementError('RUN_NOT_FOUND', 'Run not found');
    if (args.displayName !== undefined && !String(args.displayName).trim())
      throw managementError('RUN_NAME_REQUIRED', 'Enter a run name.');
    this.db.transaction(() => {
      for (const [key, column] of Object.entries({
        displayName: 'display_name',
        notes: 'notes',
        tags: 'tags',
      }))
        if (args[key] !== undefined) {
          const value =
            key === 'tags'
              ? JSON.stringify([
                  ...new Set(args.tags.map((tag: string) => tag.trim()).filter(Boolean)),
                ])
              : key === 'displayName'
                ? String(args[key]).trim()
                : args[key];
          this.db.prepare(`UPDATE runs SET ${column}=? WHERE id=?`).run(value, args.id);
        }
      this.db.prepare('UPDATE runs SET revision=revision+1 WHERE id=?').run(args.id);
    })();
    return this.run(args.id);
  }
  /**
   * Changes a stored run's config keys, summary keys, tags or notes and nothing else: no state, runtime,
   * history, summary or snapshot change (the `run_metadata_update` tool). `config` replaces
   * top-level keys (null removes one); `configMerge` deep-merges objects into them (null
   * removes a nested key). Values are stored in W&B's `{value}` layout. A request that
   * changes nothing leaves the revision alone, so retries are harmless.
   */
  runMetadataUpdate(args: Row) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT config,tags,notes,summary FROM runs WHERE id=? AND deleted_at IS NULL')
        .get(args.id) as Row | undefined;
      if (!row) throw managementError('RUN_NOT_FOUND', 'Run not found', { run: args.id }, 404);
      const config = JSON.parse(row.config),
        unwrap = (key: string) => {
          const stored = config[key];
          return stored && typeof stored === 'object' && 'value' in stored ? stored.value : stored;
        };
      const merge = (target: any, patch: any): any => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
        const result =
          target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
        for (const [key, value] of Object.entries(patch))
          if (value === null) delete result[key];
          else result[key] = merge(result[key], value);
        return result;
      };
      for (const [key, value] of Object.entries(args.config ?? {}))
        if (value === null) delete config[key];
        else config[key] = { ...config[key], value };
      for (const [key, value] of Object.entries(args.configMerge ?? {}))
        config[key] = { ...config[key], value: merge(unwrap(key), value) };
      let tags: string[] = args.tags ?? JSON.parse(row.tags);
      const removed = new Set(args.removeTags ?? []);
      tags = [...new Set([...tags, ...(args.addTags ?? [])].map((tag) => tag.trim()))].filter(
        (tag) => tag && !removed.has(tag),
      );
      const summary = JSON.parse(row.summary);
      for (const [key, value] of Object.entries(args.summary ?? {}))
        if (value === null) delete summary[key];
        else summary[key] = value;
      const next = {
        config: JSON.stringify(config),
        tags: JSON.stringify(tags),
        notes: args.notes ?? row.notes,
        summary: JSON.stringify(summary),
      };
      const changed =
        next.config !== row.config ||
        next.tags !== row.tags ||
        next.notes !== row.notes ||
        next.summary !== JSON.stringify(JSON.parse(row.summary));
      if (changed)
        this.db
          .prepare('UPDATE runs SET config=?,tags=?,notes=?,summary=?,revision=revision+1 WHERE id=?')
          .run(next.config, next.tags, next.notes, next.summary, args.id);
      return {
        id: args.id,
        changed,
        config: Object.fromEntries(
          Object.keys(config)
            .filter((key) => !key.startsWith('_'))
            .map((key) => [key, unwrap(key)]),
        ),
        tags,
        notes: next.notes,
        summary: Object.fromEntries(Object.entries(summary).filter(([key]) => !key.startsWith('_'))),
      };
    })();
  }
  /** The stored run for an edit of its history, or a not-found error. */
  private editableRun(id: string) {
    const row = this.db
      .prepare('SELECT id,summary,metric_definitions FROM runs WHERE id=? AND deleted_at IS NULL')
      .get(id) as Row | undefined;
    const key = this.history.runKey(id);
    if (!row || key === undefined)
      throw managementError('RUN_NOT_FOUND', 'Run not found', { run: id }, 404);
    return { row, key };
  }
  /** Clears what derived data depends on a run's history, and marks the run changed. */
  private historyEdited(id: string, keysChanged: boolean) {
    this.history.resetCaches();
    this.derived.clear();
    this.derivedBytes = 0;
    this.db
      .prepare(
        `UPDATE runs SET revision=revision+1${keysChanged ? ',metric_revision=metric_revision+1' : ''} WHERE id=?`,
      )
      .run(id);
  }
  /** Whether a run has a metric: in its index, points, media or summary. */
  private hasMetric(key: number, summary: Row, name: string) {
    const metric = this.history.metricId(name);
    return (
      Object.hasOwn(summary, name) ||
      (metric !== undefined &&
        !!this.db
          .prepare(
            'SELECT 1 FROM run_metrics WHERE run=? AND metric=? UNION ALL SELECT 1 FROM point_tail WHERE run=? AND metric=? UNION ALL SELECT 1 FROM point_blocks WHERE run=? AND metric=? UNION ALL SELECT 1 FROM media WHERE run=? AND metric=? LIMIT 1',
          )
          .get(key, metric, key, metric, key, metric, key, metric))
    );
  }
  /**
   * Renames metric keys of a stored run (the `run_metrics_rename` tool): its history records,
   * points, media, index, summary and define_metric settings. A key whose source is gone and
   * whose target exists is already renamed and left alone. An existing target is refused unless
   * `merge` is set, and a merge is refused while any step or record holds both keys. Each
   * rename is logged in `metric_renames` for `metricsRenameUndo`. A job: history is rewritten
   * one block at a time, then the index and summary change in one transaction.
   */
  *metricsRename(args: Row): Generator<void, Row> {
    const renames = args.renames as { from: string; to: string }[],
      { row, key } = this.editableRun(args.id),
      summary = JSON.parse(row.summary),
      file = this.history.fileId('wandb-history.jsonl');
    // History records holding each source key, and holding both keys.
    const records = renames.map(() => 0),
      both = renames.map(() => 0);
    if (file !== undefined) {
      const due = slicer();
      for (const line of this.history.lines(key, file)) {
        let record: Row | undefined;
        renames.forEach(({ from, to }, index) => {
          if (!line.content.includes(JSON.stringify(from))) return;
          record ??= JSON.parse(line.content) as Row;
          if (!Object.hasOwn(record, from)) return;
          records[index]++;
          if (Object.hasOwn(record, to)) both[index]++;
        });
        if (due()) yield;
      }
    }
    const plan = renames.map(({ from, to }, index): Row => {
      const fromId = this.history.metricId(from),
        toId = this.history.metricId(to),
        points = fromId === undefined ? 0 : this.history.series(key, fromId).steps.length,
        counts = { records: records[index], points };
      if (from === to) return { from, to, status: 'refused', reason: 'same', ...counts };
      const source = this.hasMetric(key, summary, from),
        target = this.hasMetric(key, summary, to);
      if (!source) return { from, to, status: target ? 'unchanged' : 'missing', ...counts };
      if (!target) return { from, to, status: 'renamed', ...counts };
      if (!args.merge) return { from, to, status: 'refused', reason: 'exists', ...counts };
      const steps = toId === undefined ? new Set() : new Set(this.history.series(key, toId).steps);
      const overlap =
        both[index] ||
        (fromId !== undefined &&
          this.history.series(key, fromId).steps.some((step) => steps.has(step)));
      return overlap
        ? { from, to, status: 'refused', reason: 'both', ...counts }
        : { from, to, status: 'merged', ...counts };
    });
    if (args.dryRun) return { id: args.id, dryRun: true, renames: plan };
    const refused = plan.filter((item) => item.status === 'refused');
    if (refused.length)
      throw managementError(
        'METRIC_RENAMES_REFUSED',
        `Refused, so nothing was renamed: ${refused
          .slice(0, 3)
          .map(
            (item) =>
              `${item.from} → ${item.to} (${
                item.reason === 'exists'
                  ? 'the new key exists; merge to combine'
                  : item.reason === 'both'
                    ? 'a step or record has both keys'
                    : 'same name'
              })`,
          )
          .join('; ')}.`,
        { refused: refused.length },
        409,
      );
    // One pass over the stored history applies every rename; then each one's index, points
    // and summary change in its own transaction.
    const applied = plan.filter((item) => item.status === 'renamed' || item.status === 'merged'),
      offsets = applied.map(() => [] as number[]);
    if (file !== undefined && applied.length)
      yield* this.history.rewriteLines(key, file, (content, offset) => {
        let record: Row | undefined;
        applied.forEach(({ from, to }, index) => {
          if (!content.includes(JSON.stringify(from))) return;
          record ??= JSON.parse(content) as Row;
          if (!Object.hasOwn(record, from) || Object.hasOwn(record, to)) return;
          record = renameRecord(record, from, to);
          offsets[index].push(offset);
        });
        return record && JSON.stringify(record);
      });
    const done = new Map<Row, Row>();
    for (const [index, item] of applied.entries()) {
      done.set(
        item,
        this.applyRename(args.id, item.from, item.to, item.status === 'merged', offsets[index], args.by ?? ''),
      );
      yield;
    }
    return { id: args.id, renames: plan.map((item) => ({ ...item, ...done.get(item) })) };
  }
  /** A rename's index, points, media, summary and settings, after its records were rewritten. */
  private applyRename(
    id: string,
    from: string,
    to: string,
    target: boolean,
    offsets: number[],
    by: string,
  ): Row {
    const { key } = this.editableRun(id),
      fromId = this.history.metricId(from);
    return this.db.transaction(() => {
      const fresh = this.editableRun(id).row,
        summary = JSON.parse(fresh.summary),
        before = { [from]: summary[from], [to]: summary[to] };
      if (Object.hasOwn(summary, from)) {
        const value = summary[from];
        delete summary[from];
        if (!Object.hasOwn(summary, to)) summary[to] = value;
      }
      let moved: { points: number[]; media: number[] } | null = null;
      const toId = this.history.ensureMetricId(to);
      if (fromId !== undefined) {
        if (target) {
          const points = this.history.takePoints(key, fromId);
          for (const point of points) this.history.pointPut(key, toId, point.step, point.value);
          const media = (
            this.db.prepare('SELECT step FROM media WHERE run=? AND metric=?').all(key, fromId) as Row[]
          ).map((item) => item.step as number);
          this.db
            .prepare('UPDATE OR IGNORE media SET metric=? WHERE run=? AND metric=?')
            .run(toId, key, fromId);
          this.db.prepare('DELETE FROM run_metrics WHERE run=? AND metric=?').run(key, fromId);
          this.history.catalogAdd(key, toId);
          this.history.finishWrites(key);
          moved = { points: points.map((point) => point.step), media };
        } else this.history.relabelPoints(key, fromId, toId);
      }
      // define_metric settings follow a renamed key unless the target has its own.
      const definitions = JSON.parse(fresh.metric_definitions || '[]') as Row[];
      if (!target)
        for (const definition of definitions) {
          if (definition.name === from) definition.name = to;
          if (definition.stepMetric === from) definition.stepMetric = to;
        }
      this.db
        .prepare('UPDATE runs SET summary=?,metric_definitions=? WHERE id=?')
        .run(JSON.stringify(summary), JSON.stringify(definitions), id);
      const undo = this.db
        .prepare(
          'INSERT INTO metric_renames(run,source,target,merged,offsets,steps,summary,by,created) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          from,
          to,
          target ? 1 : 0,
          JSON.stringify(offsetRanges(offsets)),
          moved && JSON.stringify(moved),
          JSON.stringify(before),
          by,
          Date.now() / 1000,
        ).lastInsertRowid;
      this.historyEdited(id, true);
      return { undo: Number(undo) };
    })();
  }
  /** Reverses one logged rename (`run_metrics_rename_undo`); repeating it changes nothing. */
  *metricsRenameUndo(args: Row): Generator<void, Row> {
    const record = this.db.prepare('SELECT * FROM metric_renames WHERE id=?').get(args.undo) as
      Row | undefined;
    if (!record)
      throw managementError('METRIC_RENAME_NOT_FOUND', 'Rename not found', { undo: args.undo }, 404);
    if (record.undone) return { id: record.run, undo: record.id, status: 'unchanged' };
    const { row, key } = this.editableRun(record.run),
      summary = JSON.parse(row.summary);
    if (!record.merged && this.hasMetric(key, summary, record.source))
      throw managementError(
        'METRIC_RENAME_CHANGED',
        `${record.source} exists again; rename it before undoing.`,
        { metric: record.source },
        409,
      );
    const ranges = JSON.parse(record.offsets) as [number, number][],
      renamed = (offset: number) => ranges.some(([first, last]) => offset >= first && offset <= last),
      file = this.history.fileId('wandb-history.jsonl');
    if (file !== undefined)
      yield* this.history.rewriteLines(key, file, (content, offset) =>
        renamed(offset) ? renameKey(content, record.target, record.source) : undefined,
      );
    return this.db.transaction(() => {
      const fresh = this.editableRun(record.run).row,
        summary = JSON.parse(fresh.summary),
        before = JSON.parse(record.summary);
      for (const name of [record.source, record.target])
        if (Object.hasOwn(before, name)) summary[name] = before[name];
        else delete summary[name];
      const sourceId = this.history.ensureMetricId(record.source),
        targetId = this.history.metricId(record.target);
      if (targetId !== undefined) {
        if (!record.merged) this.history.relabelPoints(key, targetId, sourceId);
        else {
          const moved = JSON.parse(record.steps) as { points: number[]; media: number[] },
            points = new Set(moved.points);
          for (const point of this.history.takePoints(key, targetId))
            this.history.pointPut(key, points.has(point.step) ? sourceId : targetId, point.step, point.value);
          const media = this.db.prepare(
            'UPDATE OR IGNORE media SET metric=? WHERE run=? AND metric=? AND step=?',
          );
          for (const step of moved.media) media.run(sourceId, key, targetId, step);
          this.history.catalogAdd(key, sourceId);
          this.history.finishWrites(key);
        }
      }
      const definitions = JSON.parse(fresh.metric_definitions || '[]') as Row[];
      if (!record.merged)
        for (const definition of definitions) {
          if (definition.name === record.target) definition.name = record.source;
          if (definition.stepMetric === record.target) definition.stepMetric = record.source;
        }
      this.db
        .prepare('UPDATE runs SET summary=?,metric_definitions=? WHERE id=?')
        .run(JSON.stringify(summary), JSON.stringify(definitions), record.run);
      this.db
        .prepare('UPDATE metric_renames SET undone=? WHERE id=?')
        .run(Date.now() / 1000, record.id);
      this.historyEdited(record.run, true);
      return {
        id: record.run,
        undo: record.id,
        status: 'undone',
        from: record.target,
        to: record.source,
      };
    })();
  }
  /**
   * Writes numeric values into a stored run's history (`run_history_write`), such as audit
   * results computed after training. A row names its record by `_step` (`step`; a record is
   * added when none has it) or by logged fields (`match`, such as {"update": 473000}; more than
   * one match is refused). When no record matches, a record with the match fields is added at
   * the row's `step`, or at the step its neighbours imply: with one numeric match field, the
   * records just below and above that value fix a step-per-value rate, and an integer step
   * that no record uses is taken. Values merge into the record; a different stored value is a
   * conflict unless `replace` is set, and identical values change nothing. Every row gets a
   * status; with `dryRun` nothing is written, otherwise any refused row refuses the whole
   * request, so a run is never half written.
   */
  *historyWrite(args: Row): Generator<void, Row> {
    type Wanted = {
      step?: number;
      match?: Record<string, string | number | boolean>;
      values: Record<string, number>;
    };
    const { key } = this.editableRun(args.id),
      file = this.history.ensureFileId('wandb-history.jsonl'),
      rows = args.rows as Wanted[];
    const byStep = new Map<number, number[]>(),
      hits = rows.map(() => [] as { offset: number; record: Row }[]),
      probes = rows.map((row) =>
        row.match
          ? Object.entries(row.match).map(([name, value]) => JSON.stringify(name) + ':' + JSON.stringify(value))
          : [],
      );
    rows.forEach((row, index) => {
      if (row.step !== undefined) byStep.set(row.step, [...(byStep.get(row.step) ?? []), index]);
    });
    let last = -1;
    const due = slicer(),
      steps = new Set<number>(),
      // For rows matched by one numeric field: the records just below and above its value.
      near = rows.map(() => ({
        below: undefined as { value: number; step: number } | undefined,
        above: undefined as { value: number; step: number } | undefined,
      })),
      single = rows.map((row) => {
        const entries = Object.entries(row.match ?? {});
        return entries.length === 1 && typeof entries[0][1] === 'number'
          ? { name: entries[0][0], value: entries[0][1] as number, probe: JSON.stringify(entries[0][0]) + ':' }
          : undefined;
      });
    for (const line of this.history.lines(key, file)) {
      last = line.offset;
      let record: Row | undefined;
      const parse = () => (record ??= JSON.parse(line.content) as Row);
      const stepText = /"_step":(-?[\d.eE+]+)/.exec(line.content);
      if (stepText) steps.add(Number(stepText[1]));
      single.forEach((field, index) => {
        if (!field || !line.content.includes(field.probe)) return;
        const value = parse()[field.name],
          step = parse()._step;
        if (typeof value !== 'number' || typeof step !== 'number') return;
        const side = near[index];
        if (value < field.value && (!side.below || value > side.below.value))
          side.below = { value, step };
        if (value > field.value && (!side.above || value < side.above.value))
          side.above = { value, step };
      });
      const step = /"_step":(-?[\d.eE+]+)/.exec(line.content);
      for (const index of step ? (byStep.get(Number(step[1])) ?? []) : [])
        if (parse()._step === Number(step![1]) && !hits[index].length)
          hits[index].push({ offset: line.offset, record: parse() });
      rows.forEach((row, index) => {
        if (
          row.match &&
          probes[index].every((probe) => line.content.includes(probe)) &&
          Object.entries(row.match).every(([name, value]) => parse()[name] === value)
        )
          hits[index].push({ offset: line.offset, record: parse() });
      });
      if (due()) yield;
    }
    // Plan every row against the records as earlier rows leave them.
    const edited = new Map<number, Row>(),
      results: Row[] = [];
    const taken = new Set(steps);
    for (const [index, row] of rows.entries()) {
      const found = hits[index];
      if (row.match && found.length > 1) {
        results.push({ row: index, status: 'refused', reason: 'ambiguous', matches: found.length });
        continue;
      }
      if (!found.length) {
        const step = row.step ?? inferStep(single[index]?.value, near[index]);
        if (step === undefined || (row.match && taken.has(step))) {
          results.push({
            row: index,
            status: 'refused',
            reason: step === undefined ? 'no-match' : 'step-taken',
            matches: 0,
            ...(step === undefined ? {} : { step }),
          });
          continue;
        }
        taken.add(step);
        results.push({
          row: index,
          status: 'added',
          step,
          ...(row.step === undefined ? { inferred: true } : {}),
          keys: Object.keys(row.values).length,
        });
        continue;
      }
      const { offset } = found[0],
        record = edited.get(offset) ?? found[0].record,
        conflicts = Object.entries(row.values)
          .filter(([name, value]) => Object.hasOwn(record, name) && record[name] !== value)
          .map(([name]) => name);
      const step = historyStep(record, offset, false);
      if (conflicts.length && !args.replace) {
        results.push({ row: index, status: 'refused', reason: 'conflict', step, conflicts });
        continue;
      }
      const added = Object.keys(row.values).filter((name) => !Object.hasOwn(record, name)).length;
      if (!added && !conflicts.length) {
        results.push({ row: index, status: 'unchanged', step });
        continue;
      }
      edited.set(offset, { ...record, ...row.values });
      results.push({ row: index, status: 'merged', step, keys: added, replaced: conflicts.length });
    }
    const refused = results.filter((result) => result.status === 'refused');
    if (args.dryRun) return { id: args.id, dryRun: true, changed: false, rows: results };
    if (refused.length)
      throw managementError(
        'HISTORY_ROWS_REFUSED',
        `${refused.length} of ${rows.length} rows were refused (${refused
          .slice(0, 3)
          .map((result) => `row ${result.row}: ${result.reason}`)
          .join('; ')}); nothing was written. Run with dryRun for every row's status.`,
        { refused: refused.length },
        409,
      );
    const edits = new Map([...edited].map(([offset, record]) => [offset, JSON.stringify(record)]));
    if (edits.size) yield* this.history.rewriteLines(key, file, (_, offset) => edits.get(offset));
    return this.db.transaction(() => {
      let newKeys = false;
      const write = (step: number, values: Record<string, number>, stored?: Row) => {
        for (const [name, value] of Object.entries(values)) {
          if (stored?.[name] === value) continue;
          const metric = this.history.ensureMetricId(name);
          if (!this.hasMetric(key, {}, name)) newKeys = true;
          this.history.pointPut(key, metric, step, value);
          this.history.catalogAdd(key, metric);
        }
      };
      for (const [index, row] of rows.entries()) {
        const result = results[index];
        if (result.status === 'added') {
          const record = { _step: result.step, ...row.match, ...row.values },
            numbers = Object.fromEntries(
              Object.entries({ ...row.match, ...row.values }).filter(
                (entry): entry is [string, number] => typeof entry[1] === 'number',
              ),
            );
          this.history.linePut(key, file, ++last, JSON.stringify(record));
          write(result.step, numbers);
        } else if (result.status === 'merged') write(result.step, row.values, hits[index][0].record);
      }
      this.history.finishWrites(key);
      const changed = results.some((result) => result.status !== 'unchanged');
      if (changed) {
        this.db
          .prepare('UPDATE runs SET history_count=max(history_count,?) WHERE id=?')
          .run(last + 1, args.id);
        this.historyEdited(args.id, newKeys);
      } else this.history.resetCaches();
      return { id: args.id, changed, rows: results };
    })();
  }
  private presentRun(row:Row|undefined,now=Date.now()/1000){
    if(row&&row.state==='running'&&row.snapshot_at==null){row.runtime+=Math.max(0,now-(row.runtime_at??now));row.runtime_at=now;}else if(row&&!row.runtime_reported&&row.runtime===0)row.runtime=null;
    return row;
  }
  // An SDK writing to an imported snapshot resumes it: the run becomes an ordinary live run
  // and keeps its imported config, summary and history. snapshot_source keeps the
  // provenance; resumed_at tells imports that this server is now the run's source.
  private resumeSnapshot(id: string, now: number) {
    this.db
      .prepare(
        "UPDATE runs SET snapshot_at=NULL,state='running',runtime_at=?,heartbeat=?,finished=NULL,exit_code=NULL,stop_requested=0,resumed_at=?,revision=revision+1 WHERE id=?",
      )
      .run(now, now, now, id);
    return this.run(id)!;
  }
  /** Folds reported cumulative runtimes into the run's active runtime (see run-runtime.ts). */
  private foldRuntime(id: string, reports: { raw: unknown; at: number }[], now: number) {
    if (!reports.length) return;
    const run = this.db
      .prepare('SELECT runtime,runtime_raw,runtime_raw_at,started,created FROM runs WHERE id=?')
      .get(id) as Row;
    let state: RuntimeState = {
      runtime: run.runtime ?? 0,
      raw: run.runtime_raw,
      rawAt: run.runtime_raw_at,
      started: run.started ?? run.created,
    };
    for (const report of reports) state = advanceRuntime(state, report.raw, report.at);
    // The runtime now covers the latest report; a live run's display adds time from here.
    this.db
      .prepare(
        'UPDATE runs SET runtime=?,runtime_raw=?,runtime_raw_at=?,runtime_reported=1,runtime_at=? WHERE id=?',
      )
      .run(state.runtime, state.raw, state.rawAt, now, id);
  }
  /**
   * Recomputes runtimes whose stored value does not fit the run's wall-clock span by
   * replaying the reported `_runtime` of its stored history in time order, and records every run's last
   * reported value so later reports continue from it. `scripts/rebuild-runtimes.mjs` runs it
   * once on existing data. With run IDs, it replays exactly those runs, for importers that
   * write history directly.
   */
  rebuildRuntimes(ids?: string[]) {
    const columns =
      'SELECT id,state,snapshot_at,runtime,runtime_at,summary,started,created,finished,heartbeat,updated FROM runs';
    const runs = (
      ids
        ? ids.map((id) => this.db.prepare(columns + ' WHERE id=?').get(id)).filter(Boolean)
        : this.db.prepare(columns).all()
    ) as Row[];
    const history = {
        all: (id: string) =>
          [...this.history.lines(id, 'wandb-history.jsonl')]
            .map((row) => {
              const data = JSON.parse(row.content);
              return {
                offset: row.offset,
                raw: jsonExtractValue(data._runtime),
                at: jsonExtractValue(data._timestamp),
              };
            })
            .sort((a, b) => sqliteCompare(a.at, b.at) || a.offset - b.offset),
      },
      update = this.db.prepare(
        'UPDATE runs SET runtime=?,runtime_raw=?,runtime_raw_at=?,runtime_at=coalesce(?,runtime_at) WHERE id=?',
      );
    let rebuilt = 0;
    this.db.transaction(() => {
      for (const run of runs) {
        const summary = JSON.parse(run.summary || '{}'),
          raw = summary._wandb?.runtime ?? summary._runtime,
          started = run.started ?? run.created,
          last = run.finished ?? run.heartbeat ?? run.updated ?? started;
        if (!ids && plausibleRuntime(run.runtime ?? 0, started, last)) {
          // A live run's stored runtime is current as of runtime_at; the server measured it
          // as running until its last heartbeat, where reports continue from.
          const live = run.state === 'running' && run.snapshot_at == null;
          update.run(
            (run.runtime ?? 0) + (live ? Math.max(0, last - (run.runtime_at ?? last)) : 0),
            typeof raw === 'number' ? raw : null,
            typeof raw === 'number' ? last : null,
            live ? last : null,
            run.id,
          );
          continue;
        }
        let state: RuntimeState = { runtime: 0, raw: null, rawAt: null, started };
        for (const row of history.all(run.id) as Iterable<Row>)
          state = advanceRuntime(state, row.raw, typeof row.at === 'number' ? row.at : last);
        state = advanceRuntime(state, raw, last);
        // Imported histories may hold records out of logging order; replay them by time and
        // keep the result within the run's span.
        update.run(
          Math.min(state.runtime, Math.max(0, last - started)),
          state.raw,
          state.rawAt,
          state.rawAt,
          run.id,
        );
        rebuilt++;
      }
    })();
    return rebuilt;
  }
  /**
   * W&B public API historyKeys: the last history step (the larger of the stored records'
   * highest `_step` and the summary's `_step`) and each metric's stored value count.
   */
  historyKeys(id: string) {
    const run = this.run(id);
    if (!run) return null;
    const top = { step: this.history.stats(id, '_step').hi },
      summary = JSON.parse(run.summary || '{}')._step,
      steps = [top.step, summary].filter((value) => Number.isFinite(value)) as number[];
    const counts = [...this.history.metricCounts(id)].map(([metric, n]) => ({ metric, n }));
    return {
      lastStep: steps.length ? Math.max(...steps) : run.history_count - 1,
      keys: Object.fromEntries(
        counts
          .filter((row) => !String(row.metric).startsWith('system/'))
          .map((row) => [row.metric, { typeCounts: [{ type: 'number', count: row.n }] }]),
      ),
    };
  }
  /** The history record with the highest step: what a resuming SDK continues after. */
  historyTail(id: string) {
    const last = this.history.lastLine(id, 'wandb-history.jsonl'),
      top = this.history.stats(id, '_step').hi;
    if (last && top !== null && !(JSON.parse(last.content)._step >= top)) {
      const highest = this.history.highestStepLine(id, 'wandb-history.jsonl', top);
      if (highest !== undefined) return JSON.stringify([highest]);
    }
    return JSON.stringify(last ? [last.content] : []);
  }
  run(id: string) {
    return this.presentRun(
      this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined,
    );
  }
  runMetadata(id: string, value: unknown) {
    const run = this.run(id);
    if (!run) throw managementError('RUN_NOT_FOUND', 'Run not found');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { updated: false };
    const fields = environmentMetadata({ ...JSON.parse(run.metadata), ...value })!;
    const started =
      fields.started === undefined
        ? run.started
        : Math.min(run.started || fields.started, fields.started);
    this.db
      .prepare(
        `UPDATE runs SET metadata=?,host=CASE WHEN ?<>'' THEN ? ELSE host END,program=CASE WHEN ?<>'' THEN ? ELSE program END,git_remote=CASE WHEN ?<>'' THEN ? ELSE git_remote END,git_commit=CASE WHEN ?<>'' THEN ? ELSE git_commit END,started=?,revision=revision+1 WHERE id=?`,
      )
      .run(
        fields.metadata,
        fields.host,
        fields.host,
        fields.program,
        fields.program,
        fields.git_remote,
        fields.git_remote,
        fields.git_commit,
        fields.git_commit,
        started,
        id,
      );
    return { updated: true };
  }
  staleRuns(now: number, timeout: number) {
    // Runs in Deleted runs are included so a dead process cannot block project deletion.
    const rows = this.db
      .prepare(
        "SELECT id,runtime,runtime_at,heartbeat FROM runs WHERE state='running' AND snapshot_at IS NULL AND heartbeat<?",
      )
      .all(now - timeout) as Row[];
    const update = this.db.prepare(
      "UPDATE runs SET state='crashed',runtime=?,runtime_at=heartbeat,revision=revision+1 WHERE id=?",
    );
    this.db.transaction(() => {
      for (const row of rows)
        update.run(row.runtime + Math.max(0, row.heartbeat - row.runtime_at), row.id);
    })();
    return rows.map((row) => row.id);
  }
  alert(args: Row) {
    const run = this.run(args.run);
    if (!run) throw managementError('RUN_NOT_FOUND', 'Run not found');
    const now = Date.now() / 1000,
      previous = this.db
        .prepare(
          'SELECT created FROM run_alerts WHERE run=? AND title=? ORDER BY created DESC LIMIT 1',
        )
        .get(args.run, args.title) as Row | undefined;
    if (previous && args.waitDuration && now - previous.created < args.waitDuration)
      return { success: true };
    this.db
      .prepare('INSERT INTO run_alerts(run,title,text,severity,created) VALUES(?,?,?,?,?)')
      .run(args.run, args.title, args.text, args.severity || 'INFO', now);
    this.db.prepare('UPDATE runs SET revision=revision+1 WHERE id=?').run(args.run);
    return { success: true };
  }
  alerts(id:string){return this.db.prepare('SELECT * FROM run_alerts WHERE run=? ORDER BY created DESC LIMIT 100').all(id);}
  runs() {
    return (
      this.db
        .prepare(
          'SELECT id,entity,project,name,display_name,state,created,updated,history_count,revision,group_name,job_type,tags,stop_requested,host,program,git_commit,git_remote,username,runtime,runtime_at,runtime_reported,snapshot_at,snapshot_source,started,heartbeat,finished,exit_code,metric_revision,color_index,(SELECT count(*) FROM run_metrics WHERE run=(SELECT key FROM run_keys WHERE id=runs.id)) AS metric_count FROM runs WHERE deleted_at IS NULL ORDER BY created DESC',
        )
        .all() as Row[]
    ).map((row) => this.presentRun(row)!);
  }
  runMetas(ids: string[]) {
    if (!ids.length) return [];
    return (
      this.db
        .prepare(
          `SELECT id,entity,project,name,display_name,state,created,updated,history_count,revision,group_name,job_type,tags,stop_requested,host,program,git_commit,git_remote,username,runtime,runtime_at,runtime_reported,snapshot_at,snapshot_source,started,heartbeat,finished,exit_code,metric_revision,color_index,(SELECT count(*) FROM run_metrics WHERE run=(SELECT key FROM run_keys WHERE id=runs.id)) AS metric_count FROM runs WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        )
        .all(JSON.stringify(ids)) as Row[]
    ).map((row) => this.presentRun(row)!);
  }
  /** Current revisions of the given runs that exist, in one query. */
  runRevisions(ids: string[]) {
    return this.db
      .prepare(
        'SELECT id,revision FROM runs WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))',
      )
      .all(JSON.stringify(ids)) as { id: string; revision: number }[];
  }
  queryRuns(args: Row) {
    const conditions: string[] = [],
      params: any[] = [];
    for (const f of args.filters || []) {
      let expression: string;
      if (f.field !== 'tags' && Object.hasOwn(runFieldCatalog, f.field)) {
        const field = runFieldCatalog[f.field];
        if (field.path) {
          expression = 'json_extract(metadata,?)';
          params.push(field.path);
        } else expression = f.field === 'runtime' ? liveRuntimeSQL : field.column!;
      } else if (f.field.startsWith('config.')) {
        expression = 'coalesce(json_extract(config,?),json_extract(config,?))';
        const parts = f.field.slice(7).split('.');
        params.push(
          '$.' + JSON.stringify(f.field.slice(7)) + '.value',
          '$.' +
            JSON.stringify(parts[0]) +
            '.value' +
            parts
              .slice(1)
              .map((part: string) => '.' + JSON.stringify(part))
              .join(''),
        );
      } else if (f.field.startsWith('summary.')) {
        expression = 'json_extract(summary,?)';
        params.push('$.' + JSON.stringify(f.field.slice(8)));
      } else if (f.field === 'tags') {
        if (f.operator === 'exists') {
          conditions.push('json_array_length(tags)>0');
          continue;
        }
        if (!['eq', 'ne', 'contains'].includes(f.operator))
          throw Error('Tags support equals, does not equal, contains and exists');
        conditions.push(
          (f.operator === 'ne' ? 'NOT ' : '') +
            'EXISTS (SELECT 1 FROM json_each(runs.tags) WHERE value=?)',
        );
        params.push(f.value);
        continue;
      } else throw Error('Filter fields must be run fields, tags, config.KEY or summary.KEY');
      const operators: Row = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      if (f.operator === 'contains') {
        conditions.push(`instr(lower(CAST(${expression} AS TEXT)),lower(?))>0`);
        params.push(f.value);
      } else if (f.operator === 'exists') conditions.push(`${expression} IS NOT NULL`);
      else if (operators[f.operator]) {
        conditions.push(`${expression}${operators[f.operator]}?`);
        const numeric =
          (f.field.startsWith('config.') ||
            f.field.startsWith('summary.') ||
            ['number', 'date'].includes(runFieldCatalog[f.field]?.type)) &&
          f.value.trim() !== '' &&
          Number.isFinite(Number(f.value));
        params.push(numeric ? Number(f.value) : f.value);
      } else throw Error('Unknown filter operator');
    }
    const sql =
      'SELECT id FROM runs WHERE deleted_at IS NULL' +
      (conditions.length
        ? ' AND (' +
          conditions.map((c) => '(' + c + ')').join(args.mode === 'or' ? ' OR ' : ' AND ') +
          ')'
        : '');
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => r.id);
  }
  upsert(v: Row) {
    const entity = v.entity || 'local',
      project = v.project || 'uncategorized',
      name = v.name;
    if (
      [entity, project, name].some(
        (x) => typeof x !== 'string' || !x || x.includes('/') || x.length > 256,
      )
    )
      throw Error('Invalid entity, project or run name');
    const id = `${entity}/${project}/${name}`,
      now = Date.now() / 1000;
    this.history.transaction(() => {
      // As in W&B, a run's color index comes from a per-project counter at creation, so
      // later, deleted and restored runs never recolor others.
      this.db
        .prepare(
          "INSERT OR IGNORE INTO runs(id,entity,project,name,display_name,state,created,updated,started,heartbeat,runtime_at,color_index) SELECT ?,?,?,?,?,'running',?,?,?,?,?,coalesce(max(color_index)+1,0) FROM runs WHERE entity=? AND project=?",
        )
        .run(
          id,
          entity,
          project,
          name,
          v.displayName || name,
          now,
          now,
          now,
          now,
          now,
          entity,
          project,
        );
      this.db.prepare("UPDATE runs SET stop_requested=0 WHERE id=? AND state='killed'").run(id);
      this.history.ensureRunKey(id);
      const fields: Row = {
        displayName: 'display_name',
        config: 'config',
        summaryMetrics: 'summary',
        tags: 'tags',
        notes: 'notes',
        state: 'state',
        groupName: 'group_name',
        jobType: 'job_type',
        host: 'host',
        program: 'program',
        repo: 'git_remote',
        commit: 'git_commit',
        username: 'username',
      };
      let previous = this.run(id)!;
      if (previous.snapshot_at != null) previous = this.resumeSnapshot(id, now);
      if (
        previous.state === 'running' &&
        ['finished', 'failed', 'killed', 'crashed'].includes(v.state)
      )
        this.db
          .prepare(
            'UPDATE runs SET runtime=?,runtime_at=?,finished=coalesce(finished,?) WHERE id=?',
          )
          .run(previous.runtime ?? 0, now, now, id);
      if (v.state === 'running' && previous.state !== 'running')
        this.db
          .prepare(
            'UPDATE runs SET runtime_at=?,finished=NULL,exit_code=NULL,stop_requested=0 WHERE id=?',
          )
          .run(now, id);
      for (const [key, column] of Object.entries(fields))
        if (v[key] != null) {
          let value = v[key];
          if (['config', 'summaryMetrics', 'tags'].includes(key))
            value =
              typeof value === 'string'
                ? JSON.stringify(parseLoggedJSON(value))
                : JSON.stringify(value);
          this.db.prepare(`UPDATE runs SET ${column}=? WHERE id=?`).run(value, id);
        }
      if (v.config !== undefined) {
        const after = this.run(id)!,
          config = JSON.parse(after.config),
          internal = config._wandb?.value ?? config._wandb,
          definitions = JSON.stringify(metricDefinitions(config));
        if (internal?.cli_version)
          this.db
            .prepare('UPDATE runs SET metadata=? WHERE id=?')
            .run(
              JSON.stringify({ ...JSON.parse(after.metadata), sdkVersion: internal.cli_version }),
              id,
            );
        if (previous.metric_definitions !== definitions)
          this.db
            .prepare(
              'UPDATE runs SET metric_definitions=?,metric_revision=metric_revision+1 WHERE id=?',
            )
            .run(definitions, id);
      }
      if (v.summaryMetrics !== undefined) {
        const summary = JSON.parse(this.run(id)!.summary),
          raw = summary._wandb?.runtime ?? summary._runtime;
        if (raw !== undefined) this.foldRuntime(id, [{ raw, at: now }], now);
      }
      this.db.prepare('UPDATE runs SET updated=?,revision=revision+1 WHERE id=?').run(now, id);
      this.db
        .prepare('INSERT OR IGNORE INTO projects(id,name,created) VALUES(?,?,?)')
        .run(`${entity}/${project}`, project, now);
    });
    return this.run(id)!;
  }
  ingest(id: string, payload: Row) {
    const initial = this.run(id);
    if (!initial) throw Error('Initialize the run before streaming files');
    let before: Row = initial;
    const now = Date.now() / 1000;
    let changed = false,
      resumed = false;
    const reports: { raw: unknown; at: number }[] = [];
    this.history.transaction(() => {
      if (before.snapshot_at != null) before = this.resumeSnapshot(id, now);
      const runKey = this.history.ensureRunKey(id);
      for (const [file, item] of Object.entries(payload.files || {}) as [string, Row][]) {
        const fileKey = this.history.ensureFileId(file);
        if (!Array.isArray(item.content) || !Number.isSafeInteger(item.offset) || item.offset < 0 || item.content.length > Number.MAX_SAFE_INTEGER-item.offset+1)
          throw Error('Invalid file stream offset or content');
        for (const [index, originalLine] of item.content.entries()) {
          const line =
            ['wandb-history.jsonl', 'wandb-events.jsonl', 'wandb-summary.json'].includes(file) &&
            typeof originalLine === 'string'
              ? JSON.stringify(parseLoggedJSON(originalLine))
              : originalLine;
          if (typeof line !== 'string') throw Error('Stream rows must be strings');
          const position = item.offset + index;
          const previous = this.history.lineGet(runKey, fileKey, position);
          if (previous === line) continue;
          if (previous !== undefined && file === 'wandb-history.jsonl')
            throw Error('Conflicting history replay');
          this.history.linePut(runKey, fileKey, position, line);
          changed = true;
          if (file === 'wandb-history.jsonl' || file === 'wandb-events.jsonl') {
            const row = JSON.parse(line),
              system = file === 'wandb-events.jsonl',
              step = historyStep(row, position, system);
            if (!system) {
              resumed = before.state !== 'running';
              if (row._runtime !== undefined)
                reports.push({
                  raw: row._runtime,
                  at: typeof row._timestamp === 'number' ? row._timestamp : now,
                });
            }
            for (const field of numericFields(row, system)) {
              const mid = this.history.ensureMetricId(field.metric);
              this.history.pointPut(runKey, mid, step, field.value);
              if (field.catalog) this.history.catalogAdd(runKey, mid);
            }
            if (!system)
              for (const [key, value] of Object.entries(row))
                if (value && typeof value === 'object' && (value as Row)._type) {
                  const mid = this.history.ensureMetricId(key);
                  this.history.mediaPut(runKey, mid, step, JSON.stringify(value));
                  this.history.catalogAdd(runKey, mid);
                }
            if (system) this.db.prepare('UPDATE runs SET revision=revision+1 WHERE id=?').run(id);
            else
              this.db
                .prepare(
                  "UPDATE runs SET history_count=max(history_count,?),revision=revision+1,state='running' WHERE id=?",
                )
                .run(position + 1, id);
          } else if (file === 'wandb-summary.json') {
            const summary = JSON.parse(line);
            if ((summary._wandb?.runtime ?? summary._runtime) !== undefined)
              reports.push({ raw: summary._wandb?.runtime ?? summary._runtime, at: now });
            this.db
              .prepare('UPDATE runs SET summary=?,revision=revision+1 WHERE id=?')
              .run(line, id);
          }
        }
      }
      if (before.state === 'crashed' && !payload.complete) {
        resumed = true;
        changed = true;
        this.db.prepare("UPDATE runs SET state='running',revision=revision+1 WHERE id=?").run(id);
      }
      if (resumed)
        this.db
          .prepare(
            'UPDATE runs SET runtime=?,runtime_at=?,finished=NULL,exit_code=NULL,resumed_at=? WHERE id=?',
          )
          .run(before.runtime ?? 0, now, now, id);
      this.foldRuntime(id, reports, now);
      if (payload.complete) {
        const current = this.run(id)!;
        this.db
          .prepare(
            'UPDATE runs SET state=?,runtime=?,runtime_at=?,finished=coalesce(finished,?),exit_code=?,revision=revision+1 WHERE id=?',
          )
          .run(
            current.stop_requested || current.state === 'killed'
              ? 'killed'
              : payload.exitcode
                ? 'failed'
                : 'finished',
            current.runtime ?? 0,
            now,
            now,
            Number.isInteger(payload.exitcode) ? payload.exitcode : 0,
            id,
          );
        changed = true;
      }
      this.db
        .prepare(
          'UPDATE runs SET heartbeat=?,updated=CASE WHEN ? THEN ? ELSE updated END WHERE id=?',
        )
        .run(now, changed ? 1 : 0, now, id);
      this.history.finishWrites(runKey);
    });
    return { limits: {}, inserted: true, stopped: !!this.run(id)?.stop_requested };
  }
  tail(id: string, file: string) {
    const row = this.history.lastLine(id, file);
    return JSON.stringify(row ? [row.content] : []);
  }
  streamCount(id: string, file: string) {
    return this.history.lineCount(id, file);
  }
  /**
   * Logged media of one metric for a set of runs (docs/plugins.md#media-data). Across runs,
   * each run's entry at or before a value on the X axis (the latest by default), in the order
   * of `runs`; across steps, one run's entries by step. Across runs the response carries the
   * catalog of X values with media: of all the runs, or of `xRun` alone. Files per entry are allocated within the panel's
   * files-per-step limit.
   */
  media(args: Row) {
    const limits = panelLimits.media,
      files = args.files ?? limits.files.default,
      xAxis: string = args.xAxis || '_step',
      empty = { xValues: [], xValuesTruncated: false, x: null, entries: [], total: 0 },
      base = { metrics: [args.metric], series: [], sampled: false, xAxis };
    const metric = this.db.prepare('SELECT id FROM metric_names WHERE name=?').get(args.metric) as
      | Row
      | undefined;
    if (!args.runs.length || !metric) return { ...empty, ...base };
    const keys = new Map(
      (
        this.db
          .prepare(
            `SELECT k.id,k.key,r.display_name runName FROM run_keys k JOIN runs r ON r.id=k.id WHERE k.id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(args.runs)) as Row[]
      ).map((row) => [row.id, row]),
    );
    const runs = (args.runs as string[]).flatMap((id) => (keys.has(id) ? [keys.get(id)!] : []));
    const entry = (run: Row, row: Row | undefined, x: number | null = row ? row.step : null) => ({
      run: run.id,
      runName: run.runName,
      metric: args.metric,
      step: row ? row.step : null,
      x,
      value: row ? JSON.parse(row.value) : null,
    });
    const catalogRun = runs.find((run) => run.id === args.xRun);
    let entries: ReturnType<typeof entry>[],
      total: number,
      x: number | null = null,
      xValues: number[] = [],
      xValuesTruncated = false;
    if (args.across === 'steps') {
      const run = runs.find((item) => item.id === args.run);
      if (!run) return { ...empty, ...base };
      entries = (
        this.db
          .prepare(
            'SELECT step,value FROM media WHERE run=? AND metric=? ORDER BY step DESC LIMIT ?',
          )
          .all(run.key, metric.id, limits.entries) as Row[]
      )
        .reverse()
        .map((row) => entry(run, row));
      total = (
        this.db
          .prepare('SELECT count(*) n FROM media WHERE run=? AND metric=?')
          .get(run.key, metric.id) as Row
      ).n;
    } else if (xAxis === '_step') {
      const newest = (
        this.db
          .prepare(
            `SELECT DISTINCT step FROM media WHERE metric=? AND run IN (SELECT value FROM json_each(?)) ORDER BY step DESC LIMIT ?`,
          )
          .all(metric.id, JSON.stringify(runs.map((run) => run.key)), limits.steps + 1) as Row[]
      ).map((row) => row.step as number);
      xValues = newest.slice(0, limits.steps).reverse();
      xValuesTruncated = newest.length > limits.steps;
      x = args.x ?? xValues.at(-1) ?? null;
      // The catalog of one run, when the panel shows that run alone; Latest stays the
      // newest value of all the runs.
      if (catalogRun) {
        const own = this.db
          .prepare('SELECT step FROM media WHERE run=? AND metric=? ORDER BY step DESC LIMIT ?')
          .pluck()
          .all(catalogRun.key, metric.id, limits.steps + 1) as number[];
        xValues = own.slice(0, limits.steps).reverse();
        xValuesTruncated = own.length > limits.steps;
      }
      const at = this.db.prepare(
          'SELECT step,value FROM media WHERE run=? AND metric=? AND step<=? ORDER BY step DESC LIMIT 1',
        ),
        logged = this.db.prepare('SELECT 1 FROM media WHERE run=? AND metric=? LIMIT 1');
      // A run that logs the metric only after the step keeps its place without media.
      entries = runs.flatMap((run) => {
        const row = x === null ? undefined : (at.get(run.key, metric.id, x) as Row);
        return row || logged.get(run.key, metric.id) ? [entry(run, row)] : [];
      });
      total = entries.filter((item) => item.value).length;
    } else {
      // Another X axis: each media step takes the axis metric's value at that step, or its
      // last value before it, so media logged between two values of the axis stay reachable.
      const positions = runs.map((run) => this.mediaPositions(run.key, metric.id, xAxis)),
        distinct = [...new Set(positions.flatMap((item) => item.xs))].sort((a, b) => a - b);
      xValuesTruncated = distinct.length > limits.steps;
      xValues = xValuesTruncated ? distinct.slice(-limits.steps) : distinct;
      x = args.x ?? xValues.at(-1) ?? null;
      if (catalogRun) {
        xValues = [...new Set(positions[runs.indexOf(catalogRun)].xs)].sort((a, b) => a - b);
        xValuesTruncated = false;
      }
      const value = this.db.prepare(
          'SELECT step,value FROM media WHERE run=? AND metric=? AND step=?',
        ),
        logged = this.db.prepare('SELECT 1 FROM media WHERE run=? AND metric=? LIMIT 1');
      entries = runs.flatMap((run, index) => {
        const { steps, xs } = positions[index];
        if (!steps.length && !logged.get(run.key, metric.id)) return [];
        let found = -1;
        if (x !== null)
          for (let i = 0; i < xs.length; i++)
            if (xs[i] <= x && (found < 0 || xs[i] >= xs[found])) found = i;
        return [
          found < 0
            ? entry(run, undefined)
            : entry(run, value.get(run.key, metric.id, steps[found]) as Row, xs[found]),
        ];
      });
      total = entries.filter((item) => item.value).length;
    }
    // Across runs, each run shows up to `files` of its own files, whatever the other runs log.
    // The steps of one run share the response limit, each keeping at least one file.
    const counts = entries.map((item) => mediaCount(item.value));
    const quotas =
      args.across === 'steps'
        ? allocateFiles(counts, files, limits.responseFiles)
        : counts.map((count) => Math.min(count, files));
    for (const [index, item] of entries.entries())
      if (item.value && quotas[index] < counts[index]) {
        item.value = limitMedia(item.value, quotas[index]);
        Object.assign(item, { files: counts[index], filesTruncated: true });
      }
    return { xValues, xValuesTruncated, x, entries, total, ...base };
  }
  /**
   * A run's newest media steps of one metric that have a value on an X axis other than the
   * step, with those values, by step.
   */
  private mediaPositions(run: number, metric: number, axis: string) {
    const steps = (
        this.db
          .prepare('SELECT step FROM media WHERE run=? AND metric=? ORDER BY step DESC LIMIT ?')
          .pluck()
          .all(run, metric, panelLimits.media.steps) as number[]
      ).reverse(),
      result = { steps: [] as number[], xs: [] as number[] };
    if (!steps.length) return result;
    const source = axis === '_relative_wall' ? '_timestamp' : axis,
      origin = axis === '_relative_wall' ? this.history.minValue(run, source) : 0;
    if (this.history.metricId(source) === undefined || origin === null) return result;
    const series = this.history.series(run, source, { hi: steps.at(-1) }),
      scale = axis === '_timestamp' ? 1000 : 1;
    let at = 0;
    for (const step of steps) {
      while (at < series.steps.length && series.steps[at] <= step) at++;
      if (!at) continue;
      result.steps.push(step);
      result.xs.push(series.values[at - 1] * scale - origin);
    }
    return result;
  }
  /** Runs that logged media. */
  runsWithMedia() {
    return this.db
      .prepare('SELECT k.id FROM run_keys k WHERE EXISTS(SELECT 1 FROM media m WHERE m.run=k.key)')
      .pluck()
      .all() as string[];
  }
  /**
   * A run's media entries with every run file each names and their place (`x`) on the
   * project's thinning axis, for the media limit. A run with an entry that has no value on
   * that axis is placed by step throughout, so its places stay comparable.
   */
  runMediaFiles(id: string) {
    const run = this.history.runKey(id);
    if (run === undefined) return [];
    const rows = this.history.mediaRows(run),
      saved = this.settingGet('media-limit:' + id.split('/').slice(0, 2).join('/')),
      axis: string = typeof saved?.axis === 'string' && saved.axis ? saved.axis : '_step',
      places = new Map<string, number>();
    let placed = axis !== '_step';
    if (placed)
      for (const metric of new Set(rows.map((row) => row.metric))) {
        const { steps, xs } = this.mediaPositions(run, metric, axis);
        for (const [index, step] of steps.entries()) places.set(metric + ':' + step, xs[index]);
      }
    placed &&= rows.every((row) => places.has(row.metric + ':' + row.step));
    return rows.map((row) => ({
      metric: row.metric,
      step: row.step,
      x: placed ? places.get(row.metric + ':' + row.step)! : row.step,
      paths: [...mediaPaths(JSON.parse(row.value))],
    }));
  }
  /** Removes media entries of a run, as `[metric key, step]` pairs. */
  runMediaDelete(id: string, entries: [number, number][]) {
    const run = this.history.runKey(id);
    if (run === undefined) return 0;
    return this.history.transaction(() => {
      let removed = 0;
      for (const [metric, step] of entries) removed += this.history.mediaDelete(run, metric, step);
      if (removed) this.db.prepare('UPDATE runs SET revision=revision+1 WHERE id=?').run(id);
      return removed;
    });
  }
  metricSettings(ids: string[], names?: string[]) {
    if (!ids.length) return {};
    const rows = this.db
      .prepare(
        `SELECT id,metric_definitions FROM runs WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      )
      .all(JSON.stringify(ids)) as Row[];
    const totals = new Map<
      string,
      {
        count: number;
        hidden: number;
        steps: Set<string>;
        summary: Set<string>;
        goals: Set<string>;
      }
    >();
    // Every run's metric names in one query, in run order and then metric order.
    const runMetrics = new Map<string, string[]>();
    for (const row of this.db
      .prepare(
        'SELECT k.id,n.name FROM json_each(?) j JOIN run_keys k ON k.id=j.value JOIN run_metrics m ON m.run=k.key JOIN metric_names n ON n.id=m.metric' +
          (names?.length ? ' WHERE n.name IN (SELECT value FROM json_each(?))' : '') +
          ' ORDER BY k.id,m.metric',
      )
      .iterate(
        JSON.stringify(rows.map((row) => row.id)),
        ...(names?.length ? [JSON.stringify(names)] : []),
      ) as Iterable<Row>) {
      const list = runMetrics.get(row.id);
      if (list) list.push(row.name);
      else runMetrics.set(row.id, [row.name]);
    }
    for (const row of rows) {
      const definitions = JSON.parse(
          row.metric_definitions,
        ) as import('./run-metadata.js').MetricDefinition[],
        exact = new Map(definitions.filter((d) => !d.glob).map((d) => [d.name, d])),
        globs = definitions.filter((d) => d.glob);
      for (const metric of (runMetrics.get(row.id) || []).map((name) => ({ name }))) {
        const definition = exact.get(metric.name) || definitionFor(globs, metric.name);
        const info = totals.get(metric.name) || {
          count: 0,
          hidden: 0,
          steps: new Set<string>(),
          summary: new Set<string>(),
          goals: new Set<string>(),
        };
        info.count++;
        if (definition?.hidden) info.hidden++;
        info.steps.add(definition?.stepMetric || '_step');
        for (const summary of definition?.summary || []) info.summary.add(summary);
        if (definition?.goal) info.goals.add(definition.goal);
        totals.set(metric.name, info);
      }
    }
    return Object.fromEntries(
      [...totals].map(([name, info]) => [
        name,
        {
          hidden: info.hidden === info.count,
          ...(info.steps.size === 1 && !info.steps.has('_step')
            ? { stepMetric: [...info.steps][0] }
            : {}),
          summary: [...info.summary],
          ...(info.goals.size === 1 ? { goal: [...info.goals][0] } : {}),
        },
      ]),
    );
  }
  metricTypes(ids: string[]) {
    if (!ids.length) return {};
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT n.name AS metric,'scalar' AS kind FROM run_metrics m JOIN metric_names n ON n.id=m.metric JOIN run_keys k ON k.key=m.run WHERE k.id IN (${placeholders}) AND (NOT EXISTS(SELECT 1 FROM media d WHERE d.run=m.run AND d.metric=m.metric) OR EXISTS(SELECT 1 FROM point_tail p WHERE p.run=m.run AND p.metric=m.metric) OR EXISTS(SELECT 1 FROM point_blocks p WHERE p.run=m.run AND p.metric=m.metric)) UNION SELECT DISTINCT n.name,json_extract(value,'$._type') AS kind FROM media d JOIN metric_names n ON n.id=d.metric JOIN run_keys k ON k.key=d.run WHERE k.id IN (${placeholders})`,
      )
      .all(...ids, ...ids) as Row[];
    const kinds: Record<string, string[]> = Object.create(null);
    for (const row of rows)
      if (!row.metric.startsWith('_')) (kinds[row.metric] ||= []).push(row.kind);
    const metadata = this.db
      .prepare(
        `SELECT config,summary FROM runs WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      )
      .all(...ids) as Row[];
    for (const row of metadata)
      for (const source of ['config', 'summary']) {
        const pending = Object.entries(JSON.parse(row[source]))
          .filter(([key]) => !key.startsWith('_'))
          .map(([key, value]) => ({
            key: source + '.' + key,
            value:
              source === 'config' && value && typeof value === 'object' && 'value' in value
                ? (value as Row).value
                : value,
          }));
        while (pending.length) {
          const { key, value } = pending.pop()!;
          if (value && typeof value === 'object' && '_type' in value) continue;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [child, item] of Object.entries(value))
              pending.push({ key: key + '.' + child, value: item });
          } else if (['number', 'string', 'boolean'].includes(typeof value)) {
            const kind = typeof value === 'number' ? 'number' : 'category';
            if (!kinds[key]?.includes(kind)) (kinds[key] ||= []).push(kind);
          }
        }
      }
    return kinds;
  }
  keys(ids: string[]) {
    if (!ids.length) return [];
    return (
      this.db
        .prepare(
          `SELECT DISTINCT n.name FROM run_metrics m JOIN metric_names n ON n.id=m.metric JOIN run_keys k ON k.key=m.run WHERE k.id IN (${ids.map(() => '?').join(',')}) AND substr(n.name,1,1)!='_' ORDER BY n.name`,
        )
        .all(...ids) as Row[]
    ).map((r) => r.name);
  }
  points(id: string, metric: string, settings: Row = {}): number[][] {
    const points: number[][] = [],
      ordered = this.eachPoint(id, metric, settings, (x, y) => points.push([x, y]));
    return ordered ? points : points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  /**
   * Visits a run's plotted points of one metric without materializing them. Returns whether
   * they were visited in X order; custom X axes visit them in step order.
   */
  eachPoint(
    id: string,
    metric: string,
    settings: Row,
    visit: (x: number, y: number) => void,
  ): boolean {
    const axis = settings.xAxis || '_step',
      system = metric.startsWith('system/'),
      monotonic = axis === '_step' || (system && ['_timestamp', '_relative_wall'].includes(axis));
    const origin =
      axis === '_relative_wall'
        ? system
          ? this.history.stats(id, metric).lo
          : this.history.minValue(id, '_timestamp')
        : 0;
    const scale = axis === '_timestamp' || (system && axis === '_step') ? 1000 : 1;
    const data = this.history.series(
      id,
      metric,
      monotonic
        ? {
            lo: Number.isFinite(settings.xMin) ? settings.xMin : undefined,
            hi: Number.isFinite(settings.xMax) ? settings.xMax : undefined,
            scale,
            origin: origin ?? 0,
          }
        : {},
    );
    if (monotonic) {
      for (let i = 0; i < data.steps.length; i++)
        visit(data.steps[i] * scale - (origin ?? 0), data.values[i]);
      return true;
    }
    const x = this.history.series(
      id,
      system ? 'system/' + axis : axis === '_relative_wall' ? '_timestamp' : axis,
    );
    let j = 0;
    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      let value = step;
      if (x) {
        while (j < x.steps.length && x.steps[j] < step) j++;
        if (j === x.steps.length || x.steps[j] !== step) continue;
        value = x.values[j];
      }
      if (axis === '_relative_wall') {
        if (origin === null) continue;
        value -= origin;
      } else if (axis === '_timestamp' || (system && axis === '_step')) value *= 1000;
      if (
        (Number.isFinite(settings.xMin) && value < settings.xMin) ||
        (Number.isFinite(settings.xMax) && value > settings.xMax)
      )
        continue;
      visit(value, data.values[i]);
    }
    return false;
  }
  series(id: string, metric: string, width: number | null, settings: Row = {}) {
    const points = this.points(id, metric, settings);
    return width === null ? points : decimate(points, width);
  }
  seriesStats(id: string, metric: string, settings: Row = {}) {
    const axis = settings.xAxis || '_step',
      system = metric.startsWith('system/');
    if (axis === '_step' || (system && ['_timestamp', '_relative_wall'].includes(axis))) {
      const origin = axis === '_relative_wall' ? (this.history.stats(id, metric).lo ?? 0) : 0,
        scale = system && axis !== '_relative_wall' ? 1000 : 1,
        bounded = Number.isFinite(settings.xMin) || Number.isFinite(settings.xMax),
        stats = this.history.stats(
          id,
          metric,
          bounded ? { lo: Number.isFinite(settings.xMin)?settings.xMin:undefined, hi: Number.isFinite(settings.xMax)?settings.xMax:undefined, scale, origin } : undefined,
        );
      return {
        n: stats.n,
        lo: stats.lo === null ? null : stats.lo * scale - origin,
        hi: stats.hi === null ? null : stats.hi * scale - origin,
      };
    }
    const points = this.points(id, metric, settings);
    return { n: points.length, lo: points[0]?.[0] ?? null, hi: points.at(-1)?.[0] ?? null };
  }
  /** Each run's value of a grouping field, read in one query. */
  groupValues(ids: string[], field: string) {
    const values = new Map<string, unknown>();
    if (field === 'all') return values;
    for (const row of this.runValues(ids, [field === 'running' ? 'state' : field])) {
      const value = row.values[field === 'running' ? 'state' : field] ?? null;
      values.set(
        row.id,
        field === 'running'
          ? value === 'running'
          : field === 'tags' && Array.isArray(value)
            ? [...value].sort()
            : value,
      );
    }
    return values;
  }
  /** Runs grouped by a field in first-appearance order (running first for state groups). */
  groupRuns(ids: string[], field: string) {
    const values = this.groupValues(ids, field);
    return groupRuns(ids, field, (id) =>
      field === 'running' ? (values.get(id) ?? false) : values.get(id),
    );
  }
  snapshotChart(args: Row) {
    return drain(this.snapshotJob(args));
  }
  // Latest values per run; grouped snapshots can cover the whole selection, so they read
  // configuration and summary values in one query and yield between runs.
  *snapshotJob(args: Row): Generator<void, Row> {
    const settings = args.settings || {},
      metrics = [...new Set<string>(args.metrics)],
      grouped = settings.groupBy && settings.groupBy !== 'none',
      limit = typeof settings.maxRuns === 'number' ? settings.maxRuns : undefined,
      ids = [...new Set<string>(args.runs)].slice(0, grouped ? undefined : limit),
      present = grouped && new Set(this.runRevisions(ids).map((run) => run.id)),
      // Selection order is kept: it orders the groups.
      runs = (
        present
          ? ids.filter((id) => present.has(id)).map((id) => ({ id }))
          : ids.map((id) => this.run(id)).filter(Boolean)
      ) as Row[],
      fields = metrics.filter(
        (metric) => metric.startsWith('config.') || metric.startsWith('summary.'),
      ),
      stored = new Map(
        this.runValues(
          runs.map((run) => run.id),
          fields,
        ).map((row) => [row.id, row.values]),
      );
    const rows: Row[] = [];
    for (const run of runs) {
      const attributes: Row = {};
      for (const metric of metrics) {
        if (metric.startsWith('config.') || metric.startsWith('summary.'))
          attributes[metric] = stored.get(run.id)?.[metric] ?? null;
        else attributes[metric] = this.history.lastPoint(run.id, metric)?.value ?? null;
      }
      rows.push({
        id: run.id,
        name: run.display_name,
        attributes,
        values: Object.fromEntries(
          metrics.map((metric) => [
            metric,
            typeof attributes[metric] === 'number' ? [[0, attributes[metric]]] : [],
          ]),
        ),
      });
      if (rows.length % 256 === 0) yield;
    }
    if (!grouped) return { snapshot: true, sampled: false, metrics, series: rows };
    const byId = new Map(rows.map((row) => [row.id, row])),
      groups = this.groupRuns(
        rows.map((row) => row.id),
        settings.groupBy,
      );
    const series = [];
    for (const [key, runIds] of groups.slice(0, limit)) {
      const members = runIds.map((id) => byId.get(id)!);
      const attributes: Row = {};
      for (const metric of metrics) {
        const values = members
          .map((row) => row.attributes[metric])
          .filter((value) => value !== null);
        if (values.every((value) => typeof value === 'number')) {
          const sorted = (values as number[]).sort((a, b) => a - b);
          attributes[metric] = !sorted.length
            ? null
            : settings.aggregation === 'min'
              ? sorted[0]
              : settings.aggregation === 'max'
                ? sorted.at(-1)
                : settings.aggregation === 'median'
                  ? (sorted[Math.floor((sorted.length - 1) / 2)] +
                      sorted[Math.floor(sorted.length / 2)]) /
                    2
                  : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
        } else
          attributes[metric] = values.every((value) => value === values[0]) ? values[0] : 'Mixed';
      }
      series.push({
        ...groupSeries(settings.groupBy, key),
        attributes,
        runIds,
        values: Object.fromEntries(
          metrics.map((metric) => [
            metric,
            typeof attributes[metric] === 'number' ? [[0, attributes[metric]]] : [],
          ]),
        ),
      });
    }
    return { snapshot: true, sampled: false, metrics, series, groupCount: groups.length };
  }
  chart(args: Row) {
    const job = this.chartJob(args);
    return isJob(job) ? drain(job) : job;
  }
  /**
   * The chart for a request. Grouped history charts and snapshots are returned as jobs that
   * the database worker advances in time slices, so other requests run between their runs.
   */
  chartJob(args: Row): Row | Generator<void, Row> {
    if (streamedTransform(args)) return this.computedChart(args);
    if (args.mode === 'snapshot') {
      if (args.recordTransform !== undefined) recordPasses(args.recordTransform, [], args.mode);
      return this.snapshotJob(args);
    }
    if (args.settings?.groupBy && args.settings.groupBy !== 'none') return this.groupedChart(args);
    if (args.recordTransform !== undefined) return recordChartJob(this, args);
    const plan = this.plainPlan(args),
      series = this.plainSeries(plan, plan.ids);
    return { ...plan.result, sampled: chartSampled(plan, series), series };
  }
  private *computedChart(args: Row): Generator<void, Row> {
    const plan = yield* this.computedPlan(args),
      series = yield* this.computedSeries(plan, plan.ids);
    return { ...plan.result, sampled: chartSampled(plan as any, series), series };
  }
  // A run's plotted X range for one metric, from point metadata: for custom X axes, the X
  // metric's value range. It can exceed the plotted range; it only sizes the buckets.
  private extents(ids: string[], metric: string, settings: Row): Map<string, Extent> {
    const axis = settings.xAxis || '_step',
      system = metric.startsWith('system/'),
      monotonic = axis === '_step' || (system && ['_timestamp', '_relative_wall'].includes(axis)),
      own = this.history.extents(ids, metric),
      result = new Map<string, Extent>();
    const xs = monotonic
        ? own
        : this.history.extents(
            ids,
            system ? 'system/' + axis : axis === '_relative_wall' ? '_timestamp' : axis,
          ),
      lower = Number.isFinite(settings.xMin) ? settings.xMin : -Infinity,
      upper = Number.isFinite(settings.xMax) ? settings.xMax : Infinity;
    for (const [id, e] of own) {
      const x = xs.get(id);
      if (!x) continue;
      let lo: number, hi: number;
      if (monotonic) {
        const scale = system && axis !== '_relative_wall' ? 1000 : 1,
          origin = axis === '_relative_wall' ? e.lo : 0;
        lo = e.lo * scale - origin;
        hi = e.hi * scale - origin;
      } else if (axis === '_relative_wall') {
        lo = 0;
        hi = x.max - x.min;
      } else {
        const scale = axis === '_timestamp' || (system && axis === '_step') ? 1000 : 1;
        lo = x.min * scale;
        hi = x.max * scale;
      }
      lo = Math.max(lo, lower);
      hi = Math.min(hi, upper);
      result.set(id, lo <= hi ? { n: e.n, lo, hi } : { n: 0, lo: null, hi: null });
    }
    return result;
  }
  // Per-bucket summaries of some runs for every pass, cached by run revision, source and
  // width. Plain metrics on step or timestamp axes are read for all uncached runs at once.
  private *groupSummaries(
    ids: string[],
    revisions: Map<string, unknown>,
    passes: Pass[],
    transform: Row | undefined,
    settings: Row,
    width: number | null,
  ): Generator<void, { summaries: Float64Array[]; points: number; merged: number; omitted: number }[]> {
    type Summary = { summaries: Float64Array[]; points: number; merged: number; omitted: number };
    const suffix = JSON.stringify([
        transform ?? passes.map((pass) => pass.outputs[0]),
        [settings.xAxis, settings.xMin, settings.xMax],
        width,
      ]),
      keys = ids.map((id) => JSON.stringify(['group', id, revisions.get(id)]) + suffix),
      result: Summary[] = keys.map((key) => this.cachedValue(key)),
      missing = ids.filter((_, i) => !result[i]);
    const axis = settings.xAxis || '_step',
      batched = (metric: string) =>
        axis === '_step' || (metric.startsWith('system/') && axis === '_timestamp');
    if (!transform && missing.length > 1 && passes.every((pass) => batched(pass.outputs[0]))) {
      const computed = new Map<string, Summary>(
        missing.map((id) => [id, { summaries: [], points: 0, merged: 0, omitted: 0 }]),
      );
      for (const pass of passes) {
        const metric = pass.outputs[0],
          scale = metric.startsWith('system/') ? 1000 : 1,
          series = this.history.seriesMany(missing, metric, {
            lo: Number.isFinite(settings.xMin) ? settings.xMin : undefined,
            hi: Number.isFinite(settings.xMax) ? settings.xMax : undefined,
            scale,
          }),
          value = [0];
        for (const id of missing) {
          const summary = computed.get(id)!,
            buckets = new RunBuckets(width, 1),
            data = series.get(id);
          if (data)
            for (let i = 0; i < data.steps.length; i++) {
              value[0] = data.values[i];
              buckets.add(data.steps[i] * scale, value);
            }
          summary.points += data?.steps.length ?? 0;
          summary.merged += buckets.merged;
          summary.summaries.push(buckets.finish());
        }
      }
      ids.forEach((id, i) => {
        if (result[i]) return;
        result[i] = computed.get(id)!;
        this.rememberValue(keys[i], result[i], summaryBytes(result[i]), true);
      });
      return result;
    }
    for (let i = 0; i < ids.length; i++) {
      if (result[i]) continue;
      const id = ids[i];
      let points = 0,
        merged = 0,
        omitted = 0;
      const summaries: Float64Array[] = [];
      if (!transform)
        for (const pass of passes) {
          const buckets = new RunBuckets(width, 1),
            value = [0];
          this.eachPoint(id, pass.outputs[0], settings, (x, y) => {
            value[0] = y;
            buckets.add(x, value);
            points++;
          });
          merged += buckets.merged;
          summaries.push(buckets.finish());
        }
      else
        omitted = (yield* recordChartJob(
          this,
          {
            runs: [id],
            metrics: passes.flatMap((pass) => pass.outputs),
            recordTransform: transform,
            settings: { xAxis: settings.xAxis, xMin: settings.xMin, xMax: settings.xMax },
          },
          {
            passes,
            visit: (pass) => {
              const buckets = new RunBuckets(width, pass.outputs.length);
              return {
                add: (point) => {
                  buckets.add(point[0], point, 1);
                  points++;
                },
                finish: () => {
                  merged += buckets.merged;
                  summaries.push(buckets.finish());
                },
              };
            },
          },
        )).omittedRecords;
      result[i] = { summaries, points, merged, omitted };
      this.rememberValue(keys[i], result[i], summaryBytes(result[i]), true);
      yield;
    }
    return result;
  }
  /**
   * Grouped history charts: each run is reduced to per-bucket means on the request's shared
   * X buckets, then each bucket aggregates the group's runs that have data in it.
   */
  *groupedChart(args: Row): Generator<void, Row> {
    const settings = { ...args.settings },
      field = settings.groupBy as string,
      limit = typeof settings.maxRuns === 'number' ? settings.maxRuns : undefined,
      ids = [...new Set<string>(args.runs)],
      transform = args.recordTransform as Row | undefined,
      metrics = [...new Set<string>(args.metrics || [args.metric])],
      passes: Pass[] = transform
        ? recordPasses(transform, metrics, args.mode)
        : metrics.map((metric) => ({ inputs: [metric], outputs: [metric], evaluate: (v) => v })),
      outputs = passes.flatMap((pass) => pass.outputs),
      inputs = [...new Set(passes.flatMap((pass) => pass.inputs))];
    if (!settings.xAxis) {
      const definitions = this.metricSettings(ids, [inputs[0]]);
      if (definitions[inputs[0]]?.stepMetric) settings.xAxis = definitions[inputs[0]].stepMetric;
    }
    const system = transform
        ? inputs.every((metric) => metric.startsWith('system/'))
        : inputs[0]?.startsWith('system/'),
      xAxis = settings.xAxis || (system ? '_timestamp' : '_step');
    if (transform) settings.xAxis = xAxis;
    this.derivedEpoch++;
    const groups = this.groupRuns(ids, field),
      shown = groups.slice(0, limit),
      members = shown.flatMap(([, runIds]) => runIds);
    yield;
    // X extents of every pass, for every member run.
    const extents = passes.map((pass) => {
      const byInput = pass.inputs.map((input) => this.extents(members, input, settings));
      return members.map((id) => {
        let n = Infinity,
          lo = Infinity,
          hi = -Infinity;
        for (const extent of byInput) {
          const e = extent.get(id);
          if (!e?.n) return { n: 0, lo: null, hi: null };
          n = Math.min(n, e.n);
          lo = Math.min(lo, e.lo!);
          hi = Math.max(hi, e.hi!);
        }
        return { n, lo, hi };
      });
    });
    const sizes = new Map(
      members.map((id, i) => [id, extents.reduce((sum, pass) => sum + pass[i].n, 0)]),
    );
    const resolution = chartResolution(settings.resolution, args.pixels),
      median = settings.aggregation === 'median',
      plan = planGroupBuckets(extents.flat(), resolution, shown.length * outputs.length, median);
    const revisions = new Map(this.runRevisions(members).map((row) => [row.id, row.revision]));
    yield;
    const series = [];
    let total = 0,
      sampled = false,
      omittedRecords = 0;
    for (const [name, runIds] of shown) {
      const groups = passes.map(
        (pass) => new GroupBuckets(plan.width, pass.outputs.length, plan.range, median),
      );
      for (let start = 0; start < runIds.length; ) {
        // Chunks end after 256 runs or about 100,000 stored points, so the worker can serve
        // other requests between them.
        let end = start,
          points = 0;
        while (end < runIds.length && end - start < 256 && points < 100_000)
          points += sizes.get(runIds[end++]) || 0;
        const runs = yield* this.groupSummaries(
          runIds.slice(start, (start = end)),
          revisions,
          passes,
          transform,
          settings,
          plan.width,
        );
        for (const run of runs) {
          run.summaries.forEach((summary, index) => groups[index].addRun(summary));
          total += run.points;
          sampled ||= run.merged > 0;
          omittedRecords += run.omitted;
        }
        yield;
      }
      const values: Record<string, number[][]> = {},
        bands: Record<string, number[][]> = {};
      passes.forEach((pass, index) => {
        const points = groups[index].result(settings.aggregation, settings.spread);
        pass.outputs.forEach((metric, output) => {
          values[metric] = points.map((point) => [point.x, point.values[output][0]]);
          bands[metric] = points.map((point) => [
            point.x,
            point.values[output][1],
            point.values[output][2],
            point.n,
          ]);
        });
      });
      series.push({ ...groupSeries(field, name), runIds, values, bands });
    }
    return {
      sampled,
      metrics: outputs,
      series,
      xAxis,
      aggregated: true,
      groupCount: groups.length,
      resolution: resolution.level,
      bucketWidth: plan.width,
      xRange: plan.range,
      ...(plan.width !== plan.natural ? { pointLimit: { limit: resolution.points, total } } : {}),
      ...(transform ? { recordTransform: transform, omittedRecords } : {}),
    };
  }
  // Statistics and decimated points of unchanged runs are reused across requests; the
  // run revision changes whenever its history does.
  derived = new Map<string, { value: any; bytes: number; epoch: number }>();
  derivedBytes = 0;
  // Grouped charts scan more runs than the cache may hold. Entries a scan used are not
  // evicted for its later runs, so a repeated scan finds its first part cached rather than
  // evicting each entry just before it is needed again.
  derivedEpoch = 0;
  private remembered<T>(key: string, compute: () => T, bytes: (value: T) => number): T {
    const hit = this.cachedValue(key);
    if (hit !== undefined) return hit;
    const value = compute();
    this.rememberValue(key, value, bytes(value));
    return value;
  }
  private cachedValue(key: string) {
    const hit = this.derived.get(key);
    if (!hit) return undefined;
    this.derived.delete(key);
    this.derived.set(key, hit);
    hit.epoch = this.derivedEpoch;
    return hit.value;
  }
  private rememberValue(key: string, value: unknown, bytes: number, scan = false) {
    const limit = 64 * 1024 * 1024,
      size = bytes + key.length + 64,
      old = this.derived.get(key);
    if (old) {
      this.derived.delete(key);
      this.derivedBytes -= old.bytes;
    }
    if (size > limit) return;
    while (this.derivedBytes + size > limit) {
      const [first, entry] = this.derived.entries().next().value!;
      if (scan && entry.epoch === this.derivedEpoch) return;
      this.derived.delete(first);
      this.derivedBytes -= entry.bytes;
    }
    this.derived.set(key, { value, bytes: size, epoch: this.derivedEpoch });
    this.derivedBytes += size;
  }
  // Every computed point of one run as columns ordered by X, with the records the computation
  // omitted. Cached by run revision, transform and X source, within the derived-value cache;
  // a run too large for it is computed again for the next request.
  private *computedRun(
    id: string,
    revision: unknown,
    transform: Row,
    settings: Row,
  ): Generator<void, { values: Record<string, Columns>; omitted: number }> {
    const source = [settings.xAxis, settings.xMin, settings.xMax],
      key = JSON.stringify(['computed', id, revision, transform, source]),
      hit = this.cachedValue(key);
    if (hit) return hit;
    const data = yield* recordChartJob(
        this,
        {
          runs: [id],
          metrics: transform.expressions.map((item: Row) => item.name),
          recordTransform: transform,
          settings: { xAxis: settings.xAxis, xMin: settings.xMin, xMax: settings.xMax },
        },
        { raw: true },
      ),
      value = {
        values: data.series[0].values as Record<string, Columns>,
        omitted: data.omittedRecords as number,
      };
    const arrays = new Set(Object.values(value.values).flatMap(({ xs, ys }) => [xs, ...ys]));
    this.rememberValue(
      key,
      value,
      64 + [...arrays].reduce((sum, array) => sum + array.byteLength, 0),
    );
    return value;
  }
  /** chartPlan for computed metrics: the same bucket plan, from cached computed points. */
  *computedPlan(args: Row): Generator<void, Row> {
    const limit = typeof args.settings?.maxRuns === 'number' ? args.settings.maxRuns : undefined,
      ids = [...new Set(args.runs)].slice(0, limit) as string[],
      metrics = [...new Set<string>(args.metrics)],
      passes = recordPasses(args.recordTransform, metrics, args.mode),
      inputs = [...new Set(passes.flatMap((pass) => pass.inputs))],
      settings = { ...args.settings };
    if (!settings.xAxis) {
      const definitions = this.metricSettings(ids, [inputs[0]]);
      if (definitions[inputs[0]]?.stepMetric) settings.xAxis = definitions[inputs[0]].stepMetric;
    }
    settings.xAxis ||= inputs.every((metric) => metric.startsWith('system/')) ? '_timestamp' : '_step';
    const resolution = chartResolution(settings.resolution, args.pixels),
      runs = ids.map((id) => this.run(id)),
      // Only each run's statistics are retained; its points stay in the bounded cache.
      computed: { omitted: number; stats: Extent[] }[] = [];
    for (let i = 0; i < ids.length; i++) {
      const run = yield* this.computedRun(
        ids[i],
        runs[i]?.revision,
        args.recordTransform,
        settings,
      );
      computed.push({
        omitted: run.omitted,
        stats: metrics.map((m) => {
          const xs = run.values[m]?.xs;
          return xs?.length
            ? { n: xs.length, lo: xs[0], hi: xs[xs.length - 1] }
            : { n: 0, lo: null, hi: null };
        }),
      });
      yield;
    }
    const stats = computed.map((run) => run.stats),
      plan = planBuckets(stats.flat(), resolution),
      counts = stats.map((row) => row.map((item) => item.n)),
      total = counts.flat().reduce((sum, n) => sum + n, 0);
    return {
      ids,
      names: Object.fromEntries(ids.map((id, i) => [id, runs[i]?.display_name || id])),
      revisions: Object.fromEntries(ids.map((id, i) => [id, runs[i]?.revision])),
      counts: Object.fromEntries(ids.map((id, i) => [id, counts[i]])),
      metrics,
      settings,
      width: plan.width,
      recordTransform: args.recordTransform,
      result: {
        sampled: false,
        metrics,
        xAxis: settings.xAxis,
        ...chartResolutionResult(resolution, plan, total, plan.width !== resolution.width),
        recordTransform: args.recordTransform,
        omittedRecords: computed.reduce((sum, run) => sum + run.omitted, 0),
      },
    };
  }
  /** chartSeries for computed metrics: cached computed points decimated to the plan's width. */
  *computedSeries(plan: Row, ids: string[]): Generator<void, Series[]> {
    const series: Series[] = [];
    for (const id of ids) {
      const run = yield* this.computedRun(
        id,
        plan.revisions[id],
        plan.recordTransform,
        plan.settings,
      );
      series.push(
        sampledSeries(
          id,
          plan.names[id],
          plan.metrics.map((m: string) => [m, sampleColumns(run.values[m], plan.width)]),
        ),
      );
      yield;
    }
    return series;
  }
  /**
   * Run order, names and the bucket width shared by every series of a history chart; for
   * computed metrics a job, since it computes every uncached run.
   */
  chartPlan(args: Row): Row | Generator<void, Row> {
    return streamedTransform(args) ? this.computedPlan(args) : this.plainPlan(args);
  }
  private plainPlan(args: Row) {
    const limit = typeof args.settings?.maxRuns === 'number' ? args.settings.maxRuns : undefined,
      ids = [...new Set(args.runs)].slice(0, limit) as string[],
      metrics = [...new Set(args.metrics || [args.metric])] as string[],
      settings = { ...args.settings };
    if (!settings.xAxis) {
      const definitions = this.metricSettings(ids, [metrics[0]]);
      if (definitions[metrics[0]]?.stepMetric) settings.xAxis = definitions[metrics[0]].stepMetric;
    }
    const xAxis = settings.xAxis || (metrics[0]?.startsWith('system/') ? '_timestamp' : '_step'),
      resolution = chartResolution(settings.resolution, args.pixels),
      runs = ids.map((id) => this.run(id)),
      source = [settings.xAxis, settings.xMin, settings.xMax],
      stats = ids.map((id, i) =>
        metrics.map((m) =>
          this.remembered(
            JSON.stringify(['stats', id, runs[i]?.revision, m, source]),
            () => this.seriesStats(id, m, settings),
            () => 64,
          ),
        ),
      ),
      plan = planBuckets(stats.flat(), resolution),
      counts = stats.map((row) => row.map((s) => s.n)),
      total = counts.flat().reduce((sum, n) => sum + n, 0);
    return {
      ids,
      names: Object.fromEntries(ids.map((id, i) => [id, runs[i]?.display_name || id])),
      revisions: Object.fromEntries(ids.map((id, i) => [id, runs[i]?.revision])),
      counts: Object.fromEntries(ids.map((id, i) => [id, counts[i]])),
      metrics,
      settings,
      width: plan.width,
      result: {
        sampled: false,
        metrics,
        xAxis,
        ...chartResolutionResult(resolution, plan, total, plan.width !== resolution.width),
      },
    };
  }
  /** Decimated series for some of a plan's runs, in the plan's order (a job when computed). */
  chartSeries(plan: Row, ids: string[]): Series[] | Generator<void, Series[]> {
    return plan.recordTransform ? this.computedSeries(plan, ids) : this.plainSeries(plan as any, ids);
  }
  private plainSeries(
    plan: Pick<
      ReturnType<Store['plainPlan']>,
      'metrics' | 'settings' | 'width' | 'names' | 'revisions' | 'counts'
    >,
    ids: string[],
  ) {
    const source = [plan.settings.xAxis, plan.settings.xMin, plan.settings.xMax];
    return ids.map((id) =>
      sampledSeries(
        id,
        plan.names[id],
        plan.metrics.map((m, j) => [
          m,
          plan.counts[id][j]
            ? this.remembered(
                JSON.stringify(['series', id, plan.revisions[id], m, source, plan.width]),
                () => sampleSeries(this.points(id, m, plan.settings), plan.width),
                (sampled) => (sampled.points.length + (sampled.means?.length ?? 0)) * 48,
              )
            : { points: [] },
        ]),
      ),
    );
  }

  projects() { return this.projectStore.list(); }
  projectCreate(a:Row) { return this.projectStore.create(a); }
  projectUpdate(a:Row) { return this.projectStore.update(a); }
  projectGet(id:string) { return this.projectStore.get(id); }
  projectDelete(a: Row) {
    const result = this.db.transaction(() => {
      const removed = this.projectStore.delete(a);
      this.ledger.deleteProject(a.id);
      return removed;
    })();
    this.derived.clear();
    this.derivedBytes = 0;
    return result;
  }
  // The experiment ledger (ledger.ts). Journal entries need their run to exist.
  findingSave(a: Row) {
    return this.ledger.findingSave(a);
  }
  findingGet(a: Row) {
    return this.ledger.findingGet(a.project, a.id);
  }
  findingDelete(a: Row) {
    return this.ledger.findingDelete(a.project, a.id);
  }
  findings(a: Row) {
    return this.ledger.findings(a.project, a.run);
  }
  recipeSet(a: Row) {
    return this.ledger.recipeSet(a);
  }
  recipe(a: Row) {
    return this.ledger.recipe(a.project);
  }
  planSave(a: Row) {
    return this.ledger.planSave(a);
  }
  planDelete(a: Row) {
    return this.ledger.planDelete(a.project, a.id);
  }
  plans(a: Row) {
    return this.ledger.plans(a.project);
  }
  journalAdd(a: Row) {
    if (!this.db.prepare('SELECT 1 FROM runs WHERE id=? AND deleted_at IS NULL').get(a.run))
      throw managementError('RUN_NOT_FOUND', 'Run not found', { run: a.run }, 404);
    return this.ledger.journalAdd(a);
  }
  journal(a: Row) {
    return this.ledger.journal(a);
  }
  runFileWritten(id:string,delta:number) { return this.projectStore.fileWritten(id,delta); }
  storageTotals() { return this.projectStore.totals(); }
  views() {
    return this.db
      .prepare(
        "SELECT id,name,project,version,updated,json_extract(body,'$.run') AS run FROM views ORDER BY updated DESC",
      )
      .all();
  }
  /** The newest run creation time in a project; runs created later are new to a view. */
  runWatermark(project: string) {
    const [entity, name] = String(project).split('/');
    return (
      (this.db.prepare('SELECT max(created) n FROM runs WHERE entity=? AND project=?').get(entity, name) as Row)
        .n || 0
    );
  }
  view(id: string): Row | null {
    const row = this.db.prepare('SELECT * FROM views WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    const body = JSON.parse(row.body);
    // Workspace views show runs created after their last visibility choice (W&B default).
    if (!body.run && typeof body.visibleThrough === 'number' && Array.isArray(body.visible)) {
      const [entity, name] = String(row.project).split('/'),
        visible = new Set(body.visible),
        room = selectionLimits.maxSelectedRuns - body.visible.length;
      if (room > 0)
        for (const run of this.db
          .prepare(
            'SELECT id FROM runs WHERE entity=? AND project=? AND deleted_at IS NULL AND created>? ORDER BY created LIMIT ?',
          )
          .all(entity, name, body.visibleThrough, room) as Row[])
          if (!visible.has(run.id)) body.visible.push(run.id);
    }
    return { ...row, body };
  }
  deletedRuns(project = '') {
    return this.db
      .prepare(
        "SELECT id,entity,project,name,display_name,state,deleted_at FROM runs WHERE deleted_at IS NOT NULL AND (?='' OR entity||'/'||project=?) ORDER BY deleted_at DESC",
      )
      .all(project, project);
  }
  runManage(args: Row) {
    return this.db.transaction(() => {
      const ids: string[] = [];
      if (!['delete', 'restore', 'stop', 'add-tags', 'remove-tags'].includes(args.action))
        throw Error('Unknown run action');
      if(args.action==='stop' && args.ids.length && args.ids.every((id:string)=>this.run(id)?.snapshot_at!=null))throw snapshotStopError();
      for (const id of new Set<string>(args.ids)) {
        const run = this.run(id);
        if (!run) throw managementError('RUN_NOT_FOUND', 'Run not found');
        if (args.action === 'delete')
          this.db.prepare('UPDATE runs SET deleted_at=? WHERE id=?').run(Date.now() / 1000, id);
        else if (args.action === 'restore')
          this.db.prepare('UPDATE runs SET deleted_at=NULL WHERE id=?').run(id);
        else if (args.action === 'stop') {
          if (run.snapshot_at != null) continue;
          if (run.state !== 'running') continue;
          this.db.prepare('UPDATE runs SET stop_requested=1 WHERE id=?').run(id);
        } else {
          const tags = new Set<string>(JSON.parse(run.tags));
          for (const tag of args.tags || [])
            args.action === 'add-tags' ? tags.add(tag) : tags.delete(tag);
          if (tags.size > 100) throw Error('A run can have at most 100 tags');
          this.db.prepare('UPDATE runs SET tags=? WHERE id=?').run(JSON.stringify([...tags]), id);
        }
        this.db
          .prepare('UPDATE runs SET revision=revision+1,updated=? WHERE id=?')
          .run(Date.now() / 1000, id);
        ids.push(id);
      }
      return { ids, action: args.action };
    })();
  }
  runValues(ids: string[], fields: string[]) {
    if (!ids.length || !fields.length) return [];
    const columns = new Set(['id']);
    for (const field of fields) {
      if (field.startsWith('config.')) columns.add('config');
      else if (field.startsWith('summary.')) columns.add('summary');
      else if (Object.hasOwn(runFieldCatalog, field)) {
        const definition = runFieldCatalog[field];
        columns.add(definition.path ? 'metadata' : definition.column!);
        if (field === 'runtime') {
          columns.add('state');
          columns.add('runtime_at');
          columns.add('runtime_reported');
          columns.add('snapshot_at');
        }
      }
    }
    const rows = this.db
      .prepare(
        `SELECT ${[...columns].join(',')} FROM runs WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      )
      .all(JSON.stringify(ids)) as Row[];
    return rows.map((row) => {
      const config = JSON.parse(row.config || '{}'),
        summary = JSON.parse(row.summary || '{}'),
        values: Row = {};
      for (const field of fields) {
        if (field.startsWith('config.') || field.startsWith('summary.')) {
          const source = field.startsWith('config.') ? config : summary,
            key = field.slice(field.indexOf('.') + 1);
          let value;
          if (Object.hasOwn(source, key)) {
            value = source[key];
            if (
              field.startsWith('config.') &&
              value &&
              typeof value === 'object' &&
              Object.hasOwn(value, 'value')
            )
              value = value.value;
          } else {
            const [head, ...rest] = key.split('.');
            value = Object.hasOwn(source, head) ? source[head] : undefined;
            if (
              field.startsWith('config.') &&
              value &&
              typeof value === 'object' &&
              Object.hasOwn(value, 'value')
            )
              value = value.value;
            for (const part of rest)
              value =
                value && typeof value === 'object' && Object.hasOwn(value, part)
                  ? value[part]
                  : undefined;
          }
          values[field] = value ?? null;
        } else if (Object.hasOwn(runFieldCatalog, field)) {
          const definition = runFieldCatalog[field];
          if (definition.path) {
            let value: any = JSON.parse(row.metadata);
            for (const part of definition.path.slice(2).split('.')) value = value?.[part];
            values[field] = value ?? null;
          } else
            values[field] =
              field === 'tags'
                ? JSON.parse(row.tags)
                : field === 'runtime'
                  ? this.presentRun({ ...row })!.runtime
                  : row[definition.column!];
        }
      }
      return { id: row.id, values };
    });
  }
  /**
   * The config and summary field paths of each run, by run and revision: every write to a
   * run's config or summary raises its revision. Paths are shared strings across runs.
   */
  private fieldPaths = new Map<string, { revision: number; paths: string[] }>();
  private fieldPathNames = new Map<string, string>();
  private runFieldPaths(row: Row) {
    const paths: string[] = [];
    for (const column of ['config', 'summary']) {
      const source = JSON.parse(row[column]);
      const pending = Object.entries(source)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, value]) => ({
          path: column + '.' + key,
          value:
            column === 'config' && value && typeof value === 'object' && 'value' in value
              ? (value as any).value
              : value,
        }));
      while (pending.length && paths.length < 5000) {
        const { path, value } = pending.pop()!;
        if (value && typeof value === 'object' && '_type' in value) continue;
        let name = this.fieldPathNames.get(path);
        if (name === undefined) this.fieldPathNames.set(path, (name = path));
        paths.push(name);
        if (value && typeof value === 'object' && !Array.isArray(value))
          for (const [key, child] of Object.entries(value))
            pending.push({ path: path + '.' + key, value: child });
      }
    }
    return paths;
  }
  /** The run fields of a project's runs, or of all runs: catalog fields, then config and summary paths. */
  runFields(project = '') {
    const keys = new Set(Object.keys(runFieldCatalog));
    const rows = this.db
      .prepare(
        "SELECT id,revision FROM runs WHERE deleted_at IS NULL AND (?='' OR entity||'/'||project=?)",
      )
      .all(project, project) as Row[];
    const source = this.db.prepare('SELECT config,summary FROM runs WHERE id=?');
    for (const row of rows) {
      let cached = this.fieldPaths.get(row.id);
      if (!cached || cached.revision !== row.revision) {
        cached = { revision: row.revision, paths: this.runFieldPaths(source.get(row.id) as Row) };
        this.fieldPaths.set(row.id, cached);
      }
      for (const path of cached.paths) {
        if (keys.size >= 5000) break;
        keys.add(path);
      }
    }
    return [...keys].sort();
  }
  /** Edge diffs by child run, kept while neither run's revision nor the ignore list changes. */
  private lineageDiffs = new Map<string, { key: string; changes: string[] }>();
  /**
   * A project's lineage graph (README "Lineage"). Parent keys, tags and the `lineage` block are
   * read with json_extract; whole configs are parsed only to diff an edge whose `lineage` block
   * lists no changes, and those diffs are cached. A job, so the worker slices the diffs.
   */
  *lineage(project: string, settings: LineageSettings): Generator<void, Row> {
    const [entity, name] = project.split('/'),
      keys = [...settings.parentKeys, ...settings.identityKeys];
    const rows = this.db
      .prepare(
        `SELECT id,name,display_name,state,group_name,job_type,tags,created,revision,json_extract(config,'$.lineage.value') lineage,${keys
          .map((_, index) => `json_extract(config,?) k${index}`)
          .join(',')}${keys.length ? ',' : ''}json_extract(summary,?) latest FROM runs WHERE entity=? AND project=? AND deleted_at IS NULL ORDER BY created`,
      )
      .all(
        ...keys.map(configPath),
        '$."' + settings.metric.replace(/"/g, '""') + '"',
        entity,
        name,
      ) as Row[];
    yield;
    const path = (value: unknown) => (typeof value === 'string' && value ? value : null);
    const runs: LineageRun[] = rows.map((row) => {
      let lineage: Row | null = null;
      try {
        const parsed = row.lineage ? JSON.parse(row.lineage) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lineage = parsed;
      } catch {
        // A scalar `lineage` value is not a lineage block.
      }
      return {
        id: row.id,
        name: row.name,
        display_name: row.display_name || row.name,
        state: row.state,
        group: row.group_name || '',
        tags: JSON.parse(row.tags || '[]'),
        created: row.created,
        jobType: row.job_type || '',
        lineage,
        parents: settings.parentKeys.map((_, index) => path(row['k' + index])),
        identities: settings.identityKeys.map((_, index) =>
          path(row['k' + (settings.parentKeys.length + index)]),
        ),
      };
    });
    const extents = settings.metric
      ? this.history.extents(
          runs.map((run) => run.id),
          settings.metric,
        )
      : new Map();
    yield;
    const matcher = new RunMatcher(runs),
      revisions = new Map(rows.map((row) => [row.id as string, row.revision as number])),
      created = new Map(runs.map((run) => [run.id, run.created])),
      nodes: LineageNode[] = [],
      found: LineageEdge[] = [];
    const due = slicer();
    for (const [index, run] of runs.entries()) {
      const extent = extents.get(run.id),
        latest = rows[index].latest,
        recent = extent ? this.history.lastValues(run.id, settings.metric, settings.window) : [];
      const node = lineageNode(
        run,
        {
          latest: typeof latest === 'number' && settings.metric ? latest : null,
          best: extent ? (settings.goal === 'min' ? extent.min : extent.max) : null,
          recent: recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null,
        },
        matcher,
      );
      if (due()) yield;
      nodes.push(node);
      const parent = resolveParent(run, matcher, settings);
      if (!parent) continue;
      if ('unresolved' in parent) node.unresolved = parent.unresolved;
      else
        found.push({
          source: parent.id,
          target: run.id,
          relation: parent.relation,
          traits: parent.traits,
          update: parent.update,
          explicit: parent.explicit,
          ambiguous: parent.ambiguous,
          changedKeys: [],
          changeCount: 0,
          changeSource: 'lineage',
        });
    }
    const edges = acyclic(found, created),
      configs = new Map<string, Map<string, any>>(),
      config = this.db.prepare('SELECT config FROM runs WHERE id=?').pluck();
    const flat = (id: string) => {
      let values = configs.get(id);
      if (!values) {
        values = flattenConfig(configValues(JSON.parse(config.get(id) as string)));
        configs.set(id, values);
      }
      return values;
    };
    const ignore = [...settings.ignoreKeys, ...keys],
      byId = new Map(runs.map((run) => [run.id, run])),
      changed = new Map<LineageEdge, string[]>();
    for (const edge of edges) {
      let changes = loggedChanges(byId.get(edge.target)!.lineage);
      if (!changes) {
        edge.changeSource = 'diff';
        const key = JSON.stringify([
          revisions.get(edge.target),
          edge.source,
          revisions.get(edge.source),
          ignore,
        ]);
        const cached = this.lineageDiffs.get(edge.target);
        if (cached?.key === key) changes = cached.changes;
        else {
          changes = diffConfigs(flat(edge.source), flat(edge.target), ignore).map(
            (change) => change.key,
          );
          this.lineageDiffs.set(edge.target, { key, changes });
          yield;
        }
      }
      changed.set(edge, changes);
    }
    // Each link lists first the keys that change on the fewest links: what sets this child
    // apart, rather than keys most children change from an older parent.
    const frequency = new Map<string, number>();
    for (const list of changed.values())
      for (const key of list) frequency.set(key, (frequency.get(key) ?? 0) + 1);
    for (const [edge, list] of changed) {
      edge.changeCount = list.length;
      edge.changedKeys = [...list]
        .sort((a, b) => frequency.get(a)! - frequency.get(b)! || (a < b ? -1 : 1))
        .slice(0, edgeChangeLimit);
    }
    // Planned runs not yet carried out: no run names the plan or has its name.
    const planned = new Set(nodes.map((node) => node.plan).filter(Boolean)),
      names = new Set(nodes.map((node) => node.display_name));
    const plans = this.ledger
      .plans(project)
      .filter((plan) => plan.status === 'planned' && !planned.has(plan.id) && !names.has(plan.name));
    return {
      project,
      settings,
      nodes,
      edges,
      plans,
      recipe: this.ledger.recipe(project).current,
      counts: {
        runs: nodes.length,
        explicit: edges.filter((edge) => edge.explicit).length,
        matched: edges.filter((edge) => !edge.explicit).length,
        unresolved: nodes.filter((node) => node.unresolved).length,
      },
    };
  }
  /**
   * Runs against a baseline at matched values of a logged field (`runs_compare`): each run's
   * metric paired with the baseline's where both logged the same `x` (`update` by default, or
   * `_step`), with the count, mean and last difference.
   */
  runsCompare(a: Row) {
    const pairs = (id: string) => {
      const values = this.history.series(id, a.metric),
        result = new Map<number, number>();
      if (a.x === '_step') {
        values.steps.forEach((step, index) => result.set(step, values.values[index]));
        return result;
      }
      const xs = this.history.series(id, a.x),
        byStep = new Map<number, number>();
      xs.steps.forEach((step, index) => byStep.set(step, xs.values[index]));
      values.steps.forEach((step, index) => {
        const x = byStep.get(step);
        if (x !== undefined) result.set(x, values.values[index]);
      });
      return result;
    };
    const base = pairs(a.baseline);
    return {
      baseline: a.baseline,
      metric: a.metric,
      x: a.x,
      runs: (a.runs as string[]).map((run) => {
        const matched = [...pairs(run)]
          .filter(([x]) => base.has(x))
          .sort((left, right) => left[0] - right[0])
          .map(([x, value]) => ({ x, value, baseline: base.get(x)!, diff: value - base.get(x)! }));
        return {
          run,
          matched: matched.length,
          meanDiff: matched.length
            ? matched.reduce((sum, point) => sum + point.diff, 0) / matched.length
            : null,
          last: matched.at(-1) ?? null,
          points: matched.slice(-200),
        };
      }),
    };
  }
  /** Every config key whose value differs between two runs, marking those the ignore list hides. */
  configDiff(from: string, to: string, ignore: string[]) {
    const config = this.db.prepare('SELECT config FROM runs WHERE id=? AND deleted_at IS NULL');
    const read = (id: string) => {
      const row = config.get(id) as Row | undefined;
      if (!row) throw managementError('RUN_NOT_FOUND', 'Run not found', { run: id }, 404);
      return flattenConfig(configValues(JSON.parse(row.config)));
    };
    const hidden = ignoredKey(ignore);
    return {
      changes: diffConfigs(read(from), read(to), []).map((change) => ({
        ...change,
        ignored: hidden(change.key),
      })),
    };
  }
  viewSave(a: Row) {
    if (a.body.hidePattern) {
      try {
        new RegExp(a.body.hidePattern, 'i');
      } catch {
        throw managementError('VIEW_HIDE_PATTERN_INVALID', 'Enter a valid panel hide expression');
      }
    }
    return this.db.transaction(() => {
      const old = this.view(a.id);
      if (!old && a.version !== undefined)
        throw managementError(
          'VIEW_DELETED',
          'View was deleted in another session',
          { view: a.id },
          409,
        );
      if (old && old.version !== a.version)
        throw managementError(
          'VIEW_CONFLICT',
          'View changed in another session',
          { view: a.id },
          409,
        );
      if (!a.name.trim()) throw managementError('VIEW_NAME_REQUIRED', 'Enter a view name.');
      if (!a.body.run && a.body.visibleThrough === undefined)
        a.body.visibleThrough = this.runWatermark(a.project || '');
      for (const panel of a.body.panels || [])
        if (panel.expressions?.length)
          try {
            validateComputedMetrics(panel.expressions, panel.metrics || []);
          } catch (error) {
            const failure = error as Error & { params?: Record<string, string | number> };
            failure.params = { ...failure.params, panel: panel.title || panel.id };
            throw failure;
          }
      if (
        !a.body.run &&
        (!old || old.name !== a.name || old.project !== a.project) &&
        this.db
          .prepare(
            "SELECT id FROM views WHERE project=? AND name=? COLLATE NOCASE AND id<>? AND json_extract(body,'$.run') IS NULL",
          )
          .get(a.project || '', a.name.trim(), a.id)
      )
        throw managementError('VIEW_NAME_IN_USE', 'This view name is already in use.', {}, 409);
      this.db
        .prepare('INSERT OR REPLACE INTO views VALUES(?,?,?,?,?,?)')
        .run(
          a.id,
          a.name.trim(),
          a.project || '',
          JSON.stringify(a.body),
          (old?.version || 0) + 1,
          Date.now() / 1000,
        );
      return this.view(a.id);
    })();
  }
  viewDelete(id: string) {
    this.db.prepare('DELETE FROM views WHERE id=?').run(id);
    return { id };
  }
  plugins() {
    return (this.db.prepare('SELECT * FROM plugins ORDER BY id').all() as Row[]).map((r) => ({
      ...JSON.parse(r.manifest),
      source: r.source,
      revision: r.revision,
      enabled: !!r.enabled,
      builtin: false,
    }));
  }
  pluginSave(a: Row) {
    this.db
      .prepare('INSERT OR REPLACE INTO plugins VALUES(?,?,?,?,?)')
      .run(a.id, JSON.stringify(a.manifest), a.source, a.revision, a.enabled ? 1 : 0);
    return this.plugins();
  }
  pluginDelete(id: string) {
    this.db.prepare('DELETE FROM plugins WHERE id=?').run(id);
    return { id };
  }
  audit(a: Row) {
    this.db
      .prepare('INSERT INTO audit(time,tool,arguments) VALUES(?,?,?)')
      .run(Date.now() / 1000, a.tool, JSON.stringify(a.arguments));
    this.db.prepare('DELETE FROM audit WHERE id<(SELECT max(id)-5000 FROM audit)').run();
    return { ok: true };
  }
  auditList() {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all();
  }
}

type Stats = { lo?: number | null; hi?: number | null; n: number };
const estimate = (stats: Stats[], width: number | null) =>
  stats.reduce(
    (sum, s) =>
      sum +
      (!s.n || width === null
        ? s.n
        : Math.min(s.n, 2 * (Math.floor(s.hi! / width) - Math.floor(s.lo! / width) + 1) + 2)),
    0,
  );
// Chooses the bucket width for the panel's shared X range, then widens it until the
// panel's point limit holds.
export function planBuckets(stats: Stats[], resolution: ReturnType<typeof chartResolution>) {
  const present = stats.filter((s) => s.n),
    lo = Math.min(...present.map((s) => s.lo!)),
    hi = Math.max(...present.map((s) => s.hi!));
  resolution.width =
    resolution.buckets === null || !present.length
      ? null
      : bucketWidth(hi - lo, resolution.buckets);
  let width = resolution.width;
  if (estimate(present, width) > resolution.points) {
    width = bucketWidth(hi - lo, resolution.points / 2);
    while (estimate(present, width) > resolution.points) width *= 2;
  }
  return { width, range: present.length ? [lo, hi] : null };
}
function chartResolutionResult(
  resolution: ReturnType<typeof chartResolution>,
  plan: ReturnType<typeof planBuckets>,
  total: number,
  limited: boolean,
) {
  return {
    resolution: resolution.level,
    bucketWidth: plan.width,
    xRange: plan.range,
    ...(limited ? { pointLimit: { limit: resolution.points, total } } : {}),
  };
}
// Keeps both endpoints and the first minimum and maximum of each aligned bucket (and of
// spread bounds when present). Points must be ordered by X. Taking first occurrences at
// every width is what makes coarser results subsets of finer ones.
export function decimate(points: number[][], width: number) {
  if (points.length <= 2) return points;
  const spread = points[0].length > 2,
    keep = new Set([0, points.length - 1]);
  let bucket = NaN,
    low = 0,
    high = 0,
    lowBand = 0,
    highBand = 0;
  const flush = () => {
    keep.add(low).add(high);
    if (spread) keep.add(lowBand).add(highBand);
  };
  for (let i = 0; i < points.length; i++) {
    const point = points[i],
      next = Math.floor(point[0] / width);
    if (next !== bucket) {
      if (i) flush();
      bucket = next;
      low = high = lowBand = highBand = i;
      continue;
    }
    if (point[1] < points[low][1]) low = i;
    if (point[1] > points[high][1]) high = i;
    if (spread && point[2] < points[lowBand][2]) lowBand = i;
    if (spread && point[3] > points[highBand][3]) highBand = i;
  }
  flush();
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

// The mean of each aligned bucket, placed at the bucket's last X as grouped charts place
// their points. Smoothing uses them: the minima and maxima `decimate` keeps describe a
// bucket's range, not its level, so smoothing those samples follows the midpoint of a
// skewed bucket's extremes. Undefined when no bucket holds more than one point, since the
// means would then equal the points. Points must be ordered by X.
export function bucketMeans(points: number[][], width: number) {
  const means: number[][] = [];
  let bucket = NaN,
    count = 0,
    merged = false;
  for (const point of points) {
    const next = Math.floor(point[0] / width);
    if (next !== bucket) {
      bucket = next;
      count = 1;
      means.push([point[0], point[1]]);
      continue;
    }
    merged = true;
    const mean = means[means.length - 1];
    count++;
    mean[0] = point[0];
    // An incremental mean cannot overflow as a sum of large values can.
    mean[1] += point[1] / count - mean[1] / count;
  }
  return merged ? means : undefined;
}
/**
 * `sampleSeries` for a computed metric's columns, without building every point: the kept
 * extrema and, when a bucket holds several points, the bucket means.
 */
export function sampleColumns(columns: Columns | undefined, width: number | null): SampledSeries {
  if (!columns) return { points: [] };
  const xs = columns.xs,
    ys = columns.ys[0],
    n = xs.length,
    pair = (i: number) => [xs[i], ys[i]];
  if (width === null || !n) return { points: Array.from({ length: n }, (_, i) => pair(i)) };
  const keep = new Set([0, n - 1]),
    means: number[][] = [];
  let bucket = NaN,
    low = 0,
    high = 0,
    count = 0,
    merged = false;
  for (let i = 0; i < n; i++) {
    const next = Math.floor(xs[i] / width);
    if (next !== bucket) {
      if (i) keep.add(low).add(high);
      bucket = next;
      low = high = i;
      count = 1;
      means.push(pair(i));
      continue;
    }
    if (ys[i] < ys[low]) low = i;
    if (ys[i] > ys[high]) high = i;
    merged = true;
    const mean = means[means.length - 1];
    count++;
    mean[0] = xs[i];
    mean[1] += ys[i] / count - mean[1] / count;
  }
  keep.add(low).add(high);
  const points = [...keep].sort((a, b) => a - b).map(pair);
  return merged ? { points, means } : { points };
}
/** A series sampled to a bucket width: its extrema and, unless they equal them, its bucket means. */
export type SampledSeries = { points: number[][]; means?: number[][] };
export function sampleSeries(points: number[][], width: number | null): SampledSeries {
  if (width === null) return { points };
  const sampled = decimate(points, width),
    means = bucketMeans(points, width);
  return means ? { points: sampled, means } : { points: sampled };
}
// A response series from sampled metrics; `means` is present only for metrics that have them.
function sampledSeries(id: string, name: string, metrics: [string, SampledSeries][]): Series {
  const means = metrics.filter(([, sampled]) => sampled.means);
  return {
    id,
    name,
    values: Object.fromEntries(metrics.map(([m, sampled]) => [m, sampled.points])),
    ...(means.length
      ? { means: Object.fromEntries(means.map(([m, sampled]) => [m, sampled.means!])) }
      : {}),
  };
}

function jsonExtractValue(v: any): any {
  return v == null
    ? null
    : typeof v === 'boolean'
      ? Number(v)
      : typeof v === 'object'
        ? JSON.stringify(v)
        : v;
}
function sqliteCompare(a: any, b: any): number {
  const rank = (v: any) => (v === null ? 0 : typeof v === 'number' ? 1 : 2);
  return (
    rank(a) - rank(b) ||
    (typeof a === 'number' && typeof b === 'number'
      ? a - b
      : Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b))))
  );
}
