import type { HistoryStore } from './history-store.js';
import { projectError } from './project-errors.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
type Row = Record<string, any>;
const identity = (id: unknown): [string, string] => {
  if (typeof id !== 'string' || !/^[^/]{1,256}\/[^/]{1,256}$/.test(id))
    throw projectError('projects.errors.invalidId');
  return id.split('/') as [string, string];
};
function validateName(value: unknown) {
  if (typeof value !== 'string' || !value.trim())
    throw projectError('projects.errors.nameRequired');
  if (value.trim().length > 200) throw projectError('projects.errors.nameTooLong');
  return value.trim();
}
function validateDescription(value: unknown) {
  if (typeof value !== 'string' || value.length > 5000)
    throw projectError('projects.errors.descriptionTooLong');
  return value;
}
export function runFolder(directory: string, run: string) {
  return join(directory, 'files', createHash('sha256').update(run).digest('hex'));
}
const runSummary = `SELECT entity,project,
  count(*) FILTER (WHERE deleted_at IS NULL) AS runs,
  max(max(coalesce(heartbeat,0),coalesce(finished,0))) AS activity,
  sum(stream_bytes) AS history,sum(file_bytes) AS files
  FROM runs GROUP BY entity,project`;
const artifactSummary = `SELECT a.entity,a.project,max(unixepoch(a.created)) AS activity,
  coalesce(sum(f.size),0) AS bytes
  FROM artifacts a LEFT JOIN artifact_files f ON f.artifact_id=a.id GROUP BY a.entity,a.project`;
/**
 * Project records and their derived details. Storage is logical: UTF-8 bytes of
 * streamed history/log lines (`runs.stream_bytes`, maintained from blocks and tails
 * by triggers), bytes of
 * uploaded run files (`runs.file_bytes`, maintained by the upload route) and artifact
 * file sizes. SQLite page allocation is not attributed to projects.
 */
export class Projects {
  constructor(
    readonly db: Database.Database,
    readonly directory: string,
    readonly presentRun: (row: Row, now: number) => Row,
    readonly history: HistoryStore,
  ) {}
  list() {
    return this.db
      .prepare(
        `SELECT p.id,p.name,p.description,p.archived,p.created,coalesce(r.runs,0) AS runs,
          nullif(max(coalesce(r.activity,0),coalesce(a.activity,0)),0) AS lastActivity,
          coalesce(r.history,0)+coalesce(r.files,0)+coalesce(a.bytes,0) AS storage
        FROM projects p
        LEFT JOIN (${runSummary}) r ON r.entity||'/'||r.project=p.id
        LEFT JOIN (${artifactSummary}) a ON a.entity||'/'||a.project=p.id
        ORDER BY p.name COLLATE NOCASE,p.id`,
      )
      .all();
  }
  create(a: Row) {
    identity(a.id);
    const name = validateName(a.name),
      description = validateDescription(a.description ?? '');
    if (this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(a.id))
      throw projectError('projects.errors.alreadyExists', { id: a.id });
    this.db
      .prepare('INSERT INTO projects(id,name,description,created) VALUES(?,?,?,?)')
      .run(a.id, name, description, Date.now() / 1000);
    return this.get(a.id);
  }
  update(a: Row) {
    identity(a.id);
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(a.id))
      throw projectError('projects.errors.notFound', {}, 404);
    if (!['name', 'description', 'archived'].some((k) => a[k] !== undefined))
      throw projectError('projects.errors.emptyUpdate');
    const values: Row = {};
    if (a.name !== undefined) values.name = validateName(a.name);
    if (a.description !== undefined) values.description = validateDescription(a.description);
    if (a.archived !== undefined) values.archived = a.archived ? 1 : 0;
    const fields = Object.keys(values);
    this.db
      .prepare(`UPDATE projects SET ${fields.map((f) => f + '=?').join(',')} WHERE id=?`)
      .run(...fields.map((f) => values[f]), a.id);
    return this.get(a.id);
  }
  get(id: string): Row {
    const [entity, project] = identity(id),
      row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Row | undefined;
    if (!row) throw projectError('projects.errors.notFound', {}, 404);
    const runs = this.db
      .prepare(
        `SELECT id,state,deleted_at,heartbeat,finished,runtime,runtime_at,runtime_reported,stream_bytes,file_bytes,snapshot_at FROM runs WHERE entity=? AND project=?`,
      )
      .all(entity, project) as Row[];
    const one = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as Row).n;
    const owned = 'SELECT id FROM artifacts WHERE entity=? AND project=?';
    const artifactVersions = one(
      'SELECT count(*) n FROM artifacts WHERE entity=? AND project=?',
      entity,
      project,
    );
    const artifactCollections = one(
      'SELECT count(DISTINCT name) n FROM artifacts WHERE entity=? AND project=?',
      entity,
      project,
    );
    const crossProjectUsers = one(
      `SELECT count(DISTINCT u.run) n FROM artifact_usage u JOIN runs r ON r.id=u.run
       WHERE u.artifact_id IN (${owned}) AND NOT(r.entity=? AND r.project=?)`,
      entity,
      project,
      entity,
      project,
    );
    const views = one(
      `SELECT count(*) n FROM views WHERE project=? OR json_extract(body,'$.run') IN (SELECT id FROM runs WHERE entity=? AND project=?)`,
      id,
      entity,
      project,
    );
    const artifacts = one(
      `SELECT coalesce(sum(size),0) n FROM artifact_files WHERE artifact_id IN (${owned})`,
      entity,
      project,
    );
    const artifactActivity = one(
      'SELECT max(unixepoch(created)) n FROM artifacts WHERE entity=? AND project=?',
      entity,
      project,
    );
    const now = Date.now() / 1000,
      states: Row = Object.create(null);
    let compute = 0,
      lastActivity = artifactActivity || 0,
      history = 0,
      files = 0;
    for (const r of runs) {
      lastActivity = Math.max(lastActivity, r.heartbeat || 0, r.finished || 0);
      history += r.stream_bytes;
      files += r.file_bytes;
      if (r.deleted_at == null) {
        states[r.state] = (states[r.state] || 0) + 1;
        compute += this.presentRun({ ...r }, now).runtime || 0;
      }
    }
    // Imported snapshots have no local process, so they do not block project deletion.
    const running = runs.filter((r) => r.state === 'running' && r.snapshot_at == null);
    const largestRuns = this.db
      .prepare(
        `SELECT id,name,display_name,deleted_at IS NOT NULL AS deleted,stream_bytes AS history,file_bytes AS files
         FROM runs WHERE entity=? AND project=? AND stream_bytes+file_bytes>0
         ORDER BY stream_bytes+file_bytes DESC LIMIT 5`,
      )
      .all(entity, project);
    const largestArtifacts = this.db
      .prepare(
        `SELECT a.id,a.name,a.version,a.type,coalesce(sum(f.size),0) AS bytes FROM artifacts a
         JOIN artifact_files f ON f.artifact_id=a.id WHERE a.entity=? AND a.project=?
         GROUP BY a.id ORDER BY bytes DESC LIMIT 5`,
      )
      .all(entity, project);
    return {
      ...row,
      states,
      artifactCollections,
      crossProjectUsers,
      totalCompute: compute,
      lastActivity: lastActivity || null,
      storage: { history, files, artifacts },
      largestRuns,
      largestArtifacts,
      runningRuns: running.length,
      runningDeletedRuns: running.filter((r) => r.deleted_at != null).length,
      counts: {
        runs: runs.length,
        deletedRuns: runs.filter((r) => r.deleted_at != null).length,
        artifactVersions,
        views,
      },
    };
  }
  /** Logical bytes across all projects, for the server overview. */
  totals() {
    const runs = this.db
      .prepare(
        'SELECT coalesce(sum(stream_bytes),0) AS history,coalesce(sum(file_bytes),0) AS files FROM runs',
      )
      .get() as Row;
    const artifacts = (
      this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM artifact_files').get() as Row
    ).n;
    return { history: runs.history, files: runs.files, artifacts };
  }
  /** Adds the size change of one uploaded run file. Returns false when the run no longer exists. */
  fileWritten(run: string, delta: number) {
    return (
      this.db
        .prepare(
          'UPDATE runs SET file_bytes=max(0,file_bytes+?),updated=?,revision=revision+1 WHERE id=?',
        )
        .run(delta, Date.now() / 1000, run).changes > 0
    );
  }
  delete(a: Row) {
    return this.history.transaction(() => {
      const info = this.get(a.id);
      if (a.confirm !== info.name)
        throw projectError('projects.errors.confirmName', { name: info.name });
      if (info.runningRuns)
        throw projectError('projects.errors.runningRuns', { count: info.runningRuns }, 409);
      if (
        a.expected &&
        Object.keys(info.counts).some((key) => a.expected[key] !== info.counts[key])
      )
        throw projectError('projects.errors.changed', {}, 409);
      const [entity, project] = identity(a.id);
      const runQuery = 'SELECT id FROM runs WHERE entity=? AND project=?',
        artifactQuery = 'SELECT id FROM artifacts WHERE entity=? AND project=?';
      const runs = (this.db.prepare(runQuery).all(entity, project) as Row[]).map((r) => r.id);
      const artifacts = (this.db.prepare(artifactQuery).all(entity, project) as Row[]).map(
        (r) => r.id,
      );
      this.db
        .prepare(`DELETE FROM views WHERE project=? OR json_extract(body,'$.run') IN (${runQuery})`)
        .run(a.id, entity, project);
      this.db
        .prepare(
          `DELETE FROM artifact_usage WHERE run IN (${runQuery}) OR artifact_id IN (${artifactQuery})`,
        )
        .run(entity, project, entity, project);
      for (const table of ['artifact_files', 'artifact_aliases', 'artifact_clients'])
        this.db
          .prepare(`DELETE FROM ${table} WHERE artifact_id IN (${artifactQuery})`)
          .run(entity, project);
      this.db.prepare('DELETE FROM artifacts WHERE entity=? AND project=?').run(entity, project);
      // Delete the run rows before their stream rows so the byte triggers find nothing to update.
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS deleted_project_runs(id TEXT PRIMARY KEY)');
      this.db.exec('DELETE FROM deleted_project_runs');
      const remember = this.db.prepare('INSERT INTO deleted_project_runs VALUES(?)');
      for (const run of runs) remember.run(run);
      this.db.prepare('DELETE FROM runs WHERE entity=? AND project=?').run(entity, project);
      this.history.deleteRuns(runs.map((id: string) => this.history.runKey(id)!));
      this.db.exec('DELETE FROM run_alerts WHERE run IN (SELECT id FROM temp.deleted_project_runs)');
      this.db.exec('DELETE FROM deleted_project_runs');
      this.db.prepare('DELETE FROM projects WHERE id=?').run(a.id);
      return {
        id: a.id,
        name: info.name,
        counts: info.counts,
        storage: info.storage,
        runIds: runs,
        artifactIds: artifacts,
      };
    });
  }
}
