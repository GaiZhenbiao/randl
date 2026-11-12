// The experiment ledger kept beside runs (README "Experiment ledger"): topic findings with their
// versions, the current best recipe and its history, planned runs and their queues, and run
// journals. Records have caller-chosen ids, so a repeated save is a no-op, and every change is
// a tool call that the audit log records.
import { ensureTables } from './schema.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { managementError } from './management-errors.js';

type Row = Record<string, any>;
export type Citation = { run: string; update?: number; step?: number; note?: string };
/** Where a record came from, such as lines of a handbook it was extracted from. */
export type Source = { document: string; lines?: [number, number]; quote?: string };
export type Finding = {
  project: string;
  id: string;
  topic: string;
  title: string;
  body: string;
  status: 'finding' | 'ruled_out';
  citations: Citation[];
  source: Source | null;
  version: number;
  created: number;
  updated: number;
  by: string;
};
export type Plan = {
  project: string;
  id: string;
  name: string;
  parent: string | null;
  parentUpdate: number | null;
  hypothesis: string;
  change: string;
  config: Row | null;
  baseline: string | null;
  rule: string;
  host: string;
  slot: string;
  queue: number | null;
  /** The run or plan this one is queued after, when its position is stated that way. */
  after: string | null;
  /** GPU indices on its host; otherwise those its slot last used. */
  gpus?: number[] | null;
  /** How much progress (updates) it will train, for its estimated length. */
  updates?: number | null;
  /**
   * planned: waiting in its slot's queue; started: claimed by a supervisor or carried out by
   * a running run; done: its run finished; stopped: its run was stopped, crashed or failed;
   * cancelled: set aside by a person or agent. Only planned and cancelled are set by callers;
   * the server sets the rest (Store.syncPlans).
   */
  status: PlanStatus;
  /** The exact config file text the run is launched with, stored and returned verbatim. */
  config_yaml?: string | null;
  /** The run this plan continues in its own directory, when it resumes one. */
  resume_run?: string | null;
  /** The run carrying it out, once one logs `lineage.plan` equal to its id. */
  run?: string | null;
  /** 'lineage' once that run logged this plan's id; else it was matched by its id or name. */
  binding?: 'lineage' | null;
  /** The supervisor that took it from its slot's queue (plan_claim). */
  claim?: { by: string; host: string; at: number } | null;
  /** Status changes, oldest first. */
  events?: PlanEvent[];
  source: Source | null;
  created: number;
  updated: number;
  by: string;
};
export type PlanStatus = 'planned' | 'started' | 'done' | 'stopped' | 'cancelled';
export type PlanEvent = {
  at: number;
  status: PlanStatus | 'claimed' | 'claim_expired' | 'moved';
  by?: string;
  run?: string;
  note?: string;
};
/** A claim whose run has not logged after this long returns its plan to the queue. */
export const claimTimeout = 30 * 60;

/** Seconds since the epoch from seconds or an ISO date, else now. */
export function seconds(value: number | string | undefined, now = Date.now() / 1000) {
  if (value === undefined) return now;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed))
    throw managementError('LEDGER_TIME_INVALID', `Unreadable time: ${value}`, { time: value });
  return parsed / 1000;
}
const notFound = (kind: string, id: string) =>
  managementError('LEDGER_NOT_FOUND', `${kind} not found: ${id}`, { id }, 404);

export class Ledger {
  constructor(readonly db: Database.Database) {
    // Tables from an earlier version gain the columns added since.
    ensureTables(
      db,
      `
      CREATE TABLE IF NOT EXISTS findings(project TEXT NOT NULL,id TEXT NOT NULL,topic TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,citations TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'null',version INTEGER NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,by TEXT NOT NULL,deleted REAL,PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS finding_versions(project TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL,by TEXT NOT NULL,time REAL NOT NULL,PRIMARY KEY(project,id,version));
      CREATE TABLE IF NOT EXISTS recipe_events(id INTEGER PRIMARY KEY,project TEXT NOT NULL,run TEXT NOT NULL,since REAL NOT NULL,reason TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'null',by TEXT NOT NULL,created REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS recipe_history ON recipe_events(project,since);
      CREATE TABLE IF NOT EXISTS planned_runs(project TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,by TEXT NOT NULL,PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS run_journal(id TEXT PRIMARY KEY,run TEXT NOT NULL,time REAL NOT NULL,update_index REAL,step REAL,text TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'null',by TEXT NOT NULL,created REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS run_journal_time ON run_journal(run,time);
    `,
    );
  }

  // Findings: one current record per id, every earlier version kept.
  private findingRow(project: string, id: string) {
    return this.db
      .prepare('SELECT * FROM findings WHERE project=? AND id=? AND deleted IS NULL')
      .get(project, id) as Row | undefined;
  }
  private finding(row: Row): Finding {
    const { deleted: _, citations, source, ...rest } = row;
    return { ...rest, citations: JSON.parse(citations), source: JSON.parse(source) } as Finding;
  }
  findingSave(args: Row) {
    return this.db.transaction(() => {
      const now = Date.now() / 1000,
        old = this.findingRow(args.project, args.id);
      if (args.version !== undefined && (old?.version ?? 0) !== args.version)
        throw managementError(
          'FINDING_CONFLICT',
          'This finding changed since it was read; reload it before saving.',
          { id: args.id, version: old?.version ?? 0 },
          409,
        );
      const next = {
        topic: args.topic ?? old?.topic ?? '',
        title: args.title ?? old?.title ?? args.id,
        body: args.body ?? old?.body ?? '',
        status: args.status ?? old?.status ?? 'finding',
        citations: JSON.stringify(args.citations ?? (old ? JSON.parse(old.citations) : [])),
        source: JSON.stringify(args.source ?? (old ? JSON.parse(old.source) : null)),
      };
      if (
        old &&
        (Object.keys(next) as (keyof typeof next)[]).every((key) => next[key] === old[key])
      )
        return { status: 'unchanged', finding: this.finding(old) };
      if (args.dryRun) return { status: old ? 'updated' : 'created', dryRun: true };
      // Versions continue past a deleted finding with the same id.
      const version =
          (
            this.db
              .prepare('SELECT coalesce(max(version),0) n FROM finding_versions WHERE project=? AND id=?')
              .get(args.project, args.id) as Row
          ).n + 1,
        by = args.by ?? '';
      // A deleted finding with the same id is replaced, keeping its versions.
      this.db
        .prepare(
          'INSERT OR REPLACE INTO findings(project,id,topic,title,body,status,citations,source,version,created,updated,by,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
        )
        .run(
          args.project,
          args.id,
          next.topic,
          next.title,
          next.body,
          next.status,
          next.citations,
          next.source,
          version,
          old?.created ?? now,
          now,
          by,
        );
      const finding = this.finding(this.findingRow(args.project, args.id)!);
      this.db
        .prepare(
          'INSERT OR REPLACE INTO finding_versions(project,id,version,record,by,time) VALUES(?,?,?,?,?,?)',
        )
        .run(args.project, args.id, version, JSON.stringify(finding), by, now);
      return { status: old ? 'updated' : 'created', finding };
    })();
  }
  findingGet(project: string, id: string) {
    const row = this.findingRow(project, id);
    if (!row) throw notFound('Finding', id);
    const versions = (
      this.db
        .prepare(
          'SELECT version,record,by,time FROM finding_versions WHERE project=? AND id=? ORDER BY version DESC',
        )
        .all(project, id) as Row[]
    ).map((item) => ({ ...item, record: JSON.parse(item.record) }));
    return { finding: this.finding(row), versions };
  }
  findingDelete(project: string, id: string) {
    if (!this.findingRow(project, id)) return { status: 'unchanged' };
    this.db
      .prepare('UPDATE findings SET deleted=? WHERE project=? AND id=?')
      .run(Date.now() / 1000, project, id);
    return { status: 'deleted' };
  }
  /** A project's findings by topic, or those citing one run. */
  findings(project: string, run?: string) {
    return (
      this.db
        .prepare(
          'SELECT * FROM findings WHERE project=? AND deleted IS NULL ORDER BY topic,status,updated DESC',
        )
        .all(project) as Row[]
    )
      .map((row) => this.finding(row))
      .filter((finding) => !run || finding.citations.some((citation) => citation.run === run));
  }

  // The current best recipe: the latest event by `since`, with the whole history.
  recipeSet(args: Row) {
    const since = seconds(args.since),
      current = this.recipe(args.project).current;
    if (current && current.run === args.run && current.reason === args.reason)
      return { status: 'unchanged', ...this.recipe(args.project) };
    if (
      this.db
        .prepare('SELECT 1 FROM recipe_events WHERE project=? AND run=? AND since=? AND reason=?')
        .get(args.project, args.run, since, args.reason)
    )
      return { status: 'unchanged', ...this.recipe(args.project) };
    if (args.dryRun) return { status: 'set', dryRun: true };
    this.db
      .prepare(
        'INSERT INTO recipe_events(project,run,since,reason,source,by,created) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        args.project,
        args.run,
        since,
        args.reason,
        JSON.stringify(args.source ?? null),
        args.by ?? '',
        Date.now() / 1000,
      );
    return { status: 'set', ...this.recipe(args.project) };
  }
  recipe(project: string) {
    const history = this.db
      .prepare(
        'SELECT id,run,since,reason,source,by,created FROM recipe_events WHERE project=? ORDER BY since DESC,id DESC',
      )
      .all(project) as Row[];
    for (const event of history) event.source = JSON.parse(event.source);
    return { current: history[0] ?? null, history };
  }

  // Planned runs: a whole record per id; it binds to the run that logs `lineage.plan` = id.
  planSave(args: Row) {
    const now = Date.now() / 1000,
      old = this.db
        .prepare('SELECT * FROM planned_runs WHERE project=? AND id=?')
        .get(args.project, args.id) as Row | undefined,
      previous = old ? (JSON.parse(old.record) as Plan) : undefined;
    const field = <K extends keyof Plan>(key: K, fallback: Plan[K]): Plan[K] =>
      (args[key] !== undefined ? args[key] : (previous?.[key] ?? fallback)) as Plan[K];
    const optional = (key: string, value: unknown) => (value === null ? {} : { [key]: value });
    const record = {
      name: field('name', args.id),
      parent: field('parent', null),
      parentUpdate: field('parentUpdate', null),
      hypothesis: field('hypothesis', ''),
      change: field('change', ''),
      config: field('config', null),
      baseline: field('baseline', null),
      rule: field('rule', ''),
      host: field('host', ''),
      slot: field('slot', ''),
      queue: field('queue', null),
      after: field('after', null),
      status: field('status', 'planned'),
      source: field('source', null),
      // Left out while unset, so records saved before these fields existed stay unchanged.
      ...optional('gpus', field('gpus', null)),
      ...optional('updates', field('updates', null)),
      ...optional('config_yaml', field('config_yaml', null)),
      ...optional('resume_run', field('resume_run', null)),
      // Kept by the server, never set by a save.
      ...optional('run', previous?.run ?? null),
      ...optional('binding', previous?.binding ?? null),
      ...optional('claim', previous?.claim ?? null),
      ...optional('events', previous?.events?.length ? previous.events : null),
    };
    // A caller may set planned or cancelled; setting planned releases a pending claim.
    if (args.status === 'planned' && previous?.claim && !previous.run) {
      delete (record as Row).claim;
      (record as Row).events = [
        ...(previous.events ?? []),
        { at: now, status: 'planned', by: args.by ?? '', note: 'claim released' },
      ];
    } else if (args.status !== undefined && args.status !== previous?.status)
      (record as Row).events = [
        ...(previous?.events ?? []),
        { at: now, status: args.status, by: args.by ?? '' },
      ];
    if (old && JSON.stringify(record) === old.record)
      return { status: 'unchanged', plan: this.plan(old) };
    if (args.dryRun) return { status: old ? 'updated' : 'created', dryRun: true };
    this.db
      .prepare(
        'INSERT OR REPLACE INTO planned_runs(project,id,record,created,updated,by) VALUES(?,?,?,?,?,?)',
      )
      .run(args.project, args.id, JSON.stringify(record), old?.created ?? now, now, args.by ?? '');
    return {
      status: old ? 'updated' : 'created',
      plan: this.plan(
        this.db
          .prepare('SELECT * FROM planned_runs WHERE project=? AND id=?')
          .get(args.project, args.id) as Row,
      ),
    };
  }
  private plan(row: Row): Plan {
    return {
      project: row.project,
      id: row.id,
      ...JSON.parse(row.record),
      created: row.created,
      updated: row.updated,
      by: row.by,
    };
  }
  /** Replaces a plan's record as the server keeps it (status, run, claim, queue, events). */
  planWrite(project: string, id: string, record: Row, by = 'randl') {
    this.db
      .prepare('UPDATE planned_runs SET record=?,updated=?,by=? WHERE project=? AND id=?')
      .run(JSON.stringify(record), Date.now() / 1000, by, project, id);
  }
  /** A plan's stored record, without the row fields. */
  planRecord(project: string, id: string) {
    const row = this.db
      .prepare('SELECT record FROM planned_runs WHERE project=? AND id=?')
      .get(project, id) as Row | undefined;
    return row ? (JSON.parse(row.record) as Row) : undefined;
  }
  planDelete(project: string, id: string) {
    const changes = this.db
      .prepare('DELETE FROM planned_runs WHERE project=? AND id=?')
      .run(project, id).changes;
    return { status: changes ? 'deleted' : 'unchanged' };
  }
  plans(project: string) {
    return (
      this.db
        .prepare('SELECT * FROM planned_runs WHERE project=? ORDER BY created')
        .all(project) as Row[]
    ).map((row) => this.plan(row));
  }

  // Run journals: append-only entries, idempotent by key or by content.
  journalAdd(args: Row) {
    const time = seconds(args.time),
      id =
        args.key ??
        createHash('sha256')
          .update(JSON.stringify([args.run, args.update ?? null, args.step ?? null, args.text]))
          .digest('hex')
          .slice(0, 24);
    const old = this.db.prepare('SELECT * FROM run_journal WHERE id=?').get(id) as Row | undefined;
    if (old) {
      if (old.run === args.run && old.text === args.text)
        return { status: 'unchanged', entry: this.entry(old) };
      throw managementError(
        'JOURNAL_KEY_IN_USE',
        `Journal entry ${id} already holds other text; entries are never changed.`,
        { key: id },
        409,
      );
    }
    if (args.dryRun) return { status: 'added', dryRun: true };
    this.db
      .prepare(
        'INSERT INTO run_journal(id,run,time,update_index,step,text,source,by,created) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        args.run,
        time,
        args.update ?? null,
        args.step ?? null,
        args.text,
        JSON.stringify(args.source ?? null),
        args.by ?? '',
        Date.now() / 1000,
      );
    return {
      status: 'added',
      entry: this.entry(this.db.prepare('SELECT * FROM run_journal WHERE id=?').get(id) as Row),
    };
  }
  private entry({ update_index, source, ...row }: Row) {
    return { ...row, update: update_index, source: JSON.parse(source) };
  }
  /** One run's journal, or a project's (runs whose id starts with the project). */
  journal(args: { run?: string; project?: string }) {
    const rows = args.run
      ? this.db.prepare('SELECT * FROM run_journal WHERE run=? ORDER BY time,created').all(args.run)
      : this.db
          .prepare('SELECT * FROM run_journal WHERE substr(run,1,?)=? ORDER BY time,created')
          .all(args.project!.length + 1, args.project + '/');
    return (rows as Row[]).map((row) => this.entry(row));
  }

  /** Removes a project's ledger with the project (`project_delete`). */
  deleteProject(project: string) {
    for (const table of ['findings', 'finding_versions', 'recipe_events', 'planned_runs'])
      this.db.prepare(`DELETE FROM ${table} WHERE project=?`).run(project);
    this.db
      .prepare('DELETE FROM run_journal WHERE substr(run,1,?)=?')
      .run(project.length + 1, project + '/');
  }
}
