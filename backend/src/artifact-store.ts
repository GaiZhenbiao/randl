import { managementError } from './management-errors.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
type Row = Record<string, any>;
export class Artifacts {
  constructor(readonly db: Database.Database) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,entity TEXT,project TEXT,name TEXT,type TEXT,version INTEGER,digest TEXT,state TEXT,description TEXT,metadata TEXT,created TEXT,updated TEXT,producer TEXT,manifest TEXT,size INTEGER DEFAULT 0,file_count INTEGER DEFAULT 0,UNIQUE(entity,project,name,version));CREATE TABLE IF NOT EXISTS artifact_aliases(entity TEXT,project TEXT,name TEXT,alias TEXT,artifact_id TEXT,PRIMARY KEY(entity,project,name,alias));CREATE TABLE IF NOT EXISTS artifact_files(artifact_id TEXT,name TEXT,digest TEXT,size INTEGER DEFAULT 0,PRIMARY KEY(artifact_id,name));CREATE TABLE IF NOT EXISTS artifact_clients(client_id TEXT PRIMARY KEY,artifact_id TEXT);CREATE TABLE IF NOT EXISTS artifact_usage(artifact_id TEXT,run TEXT,PRIMARY KEY(artifact_id,run));`,
    );
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Row | undefined;
  }
  resolve(entity: string, project: string, name: string) {
    const index = name.lastIndexOf(':'),
      collection = index < 0 ? name : name.slice(0, index),
      alias = index < 0 ? 'latest' : name.slice(index + 1);
    if (/^v\d+$/.test(alias))
      return this.db
        .prepare(
          "SELECT * FROM artifacts WHERE entity=? AND project=? AND name=? AND version=? AND state='COMMITTED'",
        )
        .get(entity, project, collection, Number(alias.slice(1))) as Row | undefined;
    return this.db
      .prepare(
        "SELECT a.* FROM artifacts a JOIN artifact_aliases x ON a.id=x.artifact_id WHERE x.entity=? AND x.project=? AND x.name=? AND x.alias=? AND a.state='COMMITTED'",
      )
      .get(entity, project, collection, alias) as Row | undefined;
  }
  create(input: Row) {
    return this.db.transaction(() => {
      const entity = input.entityName || 'local',
        project = input.projectName || 'uncategorized',
        name = input.artifactCollectionName,
        type = input.artifactTypeName || 'dataset';
      if (
        !name ||
        name.includes(':') ||
        [entity, project, name, type].some(
          (x) => typeof x !== 'string' || x.length > 256 || x.includes('/'),
        )
      )
        throw Error('Invalid artifact identity');
      const clientKey = input.clientID ? `${entity}/${project}/${input.clientID}` : null;
      const previous = clientKey
        ? (this.db
            .prepare('SELECT artifact_id FROM artifact_clients WHERE client_id=?')
            .get(clientKey) as Row | undefined)
        : undefined;
      if (previous) return this.get(previous.artifact_id)!;
      const existing = input.enableDigestDeduplication
        ? (this.db
            .prepare(
              "SELECT * FROM artifacts WHERE entity=? AND project=? AND name=? AND digest=? AND state='COMMITTED' ORDER BY version DESC LIMIT 1",
            )
            .get(entity, project, name, input.digest) as Row | undefined)
        : undefined;
      if (existing) {
        this.aliases(existing.id, input.aliases || []);
        if (clientKey)
          this.db.prepare('INSERT INTO artifact_clients VALUES(?,?)').run(clientKey, existing.id);
        return existing;
      }
      const version = (
          this.db
            .prepare(
              'SELECT coalesce(max(version)+1,0) AS n FROM artifacts WHERE entity=? AND project=? AND name=?',
            )
            .get(entity, project, name) as Row
        ).n,
        id = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO artifacts(id,entity,project,name,type,version,digest,state,description,metadata,created,updated,producer,manifest) VALUES(?,?,?,?,?,?,?,'PENDING',?,?,?,?,?,?)",
        )
        .run(
          id,
          entity,
          project,
          name,
          type,
          version,
          input.digest || '',
          input.description ?? null,
          typeof input.metadata === 'string'
            ? input.metadata
            : JSON.stringify(input.metadata || {}),
          now,
          now,
          input.runName ? `${entity}/${project}/${input.runName}` : null,
          JSON.stringify({ aliases: input.aliases || [] }),
        );
      if (clientKey) this.db.prepare('INSERT INTO artifact_clients VALUES(?,?)').run(clientKey, id);
      return this.get(id)!;
    })();
  }
  aliases(id: string, aliases: any[]) {
    const r = this.get(id);
    if (!r) throw managementError('ARTIFACT_NOT_FOUND', 'Artifact not found');
    for (const item of aliases) {
      const alias = typeof item === 'string' ? item : item.alias;
      if (!alias || /^v\d+$/.test(alias) || alias.includes('/')) continue;
      this.db
        .prepare('INSERT OR REPLACE INTO artifact_aliases VALUES(?,?,?,?,?)')
        .run(r.entity, r.project, r.name, alias, id);
    }
  }
  describe(r: Row | undefined) {
    if (!r) return null;
    const project = {
        id: `${r.entity}/${r.project}`,
        internalId: `${r.entity}/${r.project}`,
        name: r.project,
        entity: { name: r.entity },
      },
      collection = { __typename: 'ArtifactSequence', name: r.name, project };
    const aliases = (
      this.db.prepare('SELECT alias FROM artifact_aliases WHERE artifact_id=?').all(r.id) as Row[]
    ).map((a) => ({ id: r.id + ':' + a.alias, alias: a.alias, artifactCollection: collection }));
    return {
      id: r.id,
      artifactSequence: { ...collection, latestArtifact: { id: r.id } },
      versionIndex: r.version,
      artifactType: { name: r.type },
      description: r.description,
      metadata: r.metadata,
      ttlDurationSeconds: -1,
      ttlIsInherited: true,
      tags: [],
      historyStep: null,
      state: r.state,
      size: r.size,
      digest: r.digest,
      digestAlgorithm: 'MANIFEST_MD5',
      commitHash: null,
      fileCount: r.file_count,
      createdAt: r.created,
      updatedAt: r.updated,
      aliases,
    };
  }
  operation(method: string, a: Row): any {
    switch (method) {
      case 'create':
        return this.create(a);
      case 'get':
        return this.get(a.id);
      case 'describe':
        return this.describe(this.get(a.id));
      case 'resolve':
        return this.resolve(a.entity, a.project, a.name) || null;
      case 'files':
        return this.db
          .prepare('SELECT * FROM artifact_files WHERE artifact_id=? ORDER BY name')
          .all(a.id);
      case 'file': {
        if (this.get(a.id)?.state !== 'PENDING') throw Error('Artifact is not pending');
        this.db
          .prepare('INSERT OR REPLACE INTO artifact_files VALUES(?,?,?,?)')
          .run(a.id, a.name, a.digest || '', a.size || 0);
        return { ok: true };
      }
      case 'manifest': {
        if (this.get(a.id)?.state !== 'PENDING') throw Error('Artifact is not pending');
        this.db
          .prepare('UPDATE artifacts SET digest=coalesce(?,digest),updated=? WHERE id=?')
          .run(a.logicalDigest || null, new Date().toISOString(), a.id);
        return { id: a.id + '-manifest' };
      }
      case 'commit':
        return this.db.transaction(() => {
          const r = this.get(a.id);
          if (!r) throw managementError('ARTIFACT_NOT_FOUND', 'Artifact not found');
          if (r.state === 'COMMITTED') return r;
          const aliases = JSON.parse(r.manifest).aliases || [];
          this.db
            .prepare(
              "UPDATE artifacts SET state='COMMITTED',size=?,file_count=?,updated=? WHERE id=?",
            )
            .run(a.size, a.count, new Date().toISOString(), a.id);
          this.aliases(a.id, [...aliases, 'latest']);
          return this.get(a.id);
        })();
      case 'alias':
        this.aliases(a.id, a.aliases);
        return this.describe(this.get(a.id));
      case 'use': {
        if (!this.get(a.artifactID))
          throw managementError('ARTIFACT_NOT_FOUND', 'Artifact not found');
        this.db
          .prepare('INSERT OR IGNORE INTO artifact_usage VALUES(?,?)')
          .run(
            a.artifactID,
            `${a.entityName || 'local'}/${a.projectName || 'uncategorized'}/${a.runName}`,
          );
        return { artifact: { id: a.artifactID } };
      }
      case 'list':
        return (
          this.db.prepare('SELECT * FROM artifacts ORDER BY created DESC').all() as Row[]
        ).map((r) => ({
          ...r,
          aliases: (this.describe(r) as any).aliases.map((a: any) => a.alias),
        }));
      case 'detail': {
        const artifact = this.get(a.id);
        if (!artifact) throw managementError('ARTIFACT_NOT_FOUND', 'Artifact not found');
        const aliases = this.db
          .prepare('SELECT alias FROM artifact_aliases WHERE artifact_id=? ORDER BY alias')
          .all(a.id) as Row[];
        const versions = this.db
          .prepare(
            'SELECT id,version,state,created,size FROM artifacts WHERE entity=? AND project=? AND name=? ORDER BY version DESC',
          )
          .all(artifact.entity, artifact.project, artifact.name);
        const producer = artifact.producer
          ? this.db
              .prepare('SELECT id,display_name,state,entity,project,name FROM runs WHERE id=?')
              .get(artifact.producer)
          : null;
        const consumers = this.db
          .prepare(
            'SELECT r.id,r.display_name,r.state,r.entity,r.project,r.name FROM runs r JOIN artifact_usage u ON r.id=u.run WHERE u.artifact_id=? ORDER BY r.created DESC',
          )
          .all(a.id);
        return {
          artifact: { ...artifact, aliases: aliases.map((row) => row.alias) },
          versions,
          producer,
          consumers,
          files: this.db
            .prepare(
              'SELECT name,digest,size FROM artifact_files WHERE artifact_id=? ORDER BY name',
            )
            .all(a.id),
        };
      }
      case 'remove-alias':
        if (!this.get(a.id)) throw managementError('ARTIFACT_NOT_FOUND', 'Artifact not found');
        this.db
          .prepare('DELETE FROM artifact_aliases WHERE artifact_id=? AND alias=?')
          .run(a.id, a.alias);
        return { ok: true };
      case 'relations':
        return {
          outputs: this.db
            .prepare('SELECT id,name,version,type FROM artifacts WHERE producer=?')
            .all(a.run),
          inputs: this.db
            .prepare(
              'SELECT a.id,a.name,a.version,a.type FROM artifacts a JOIN artifact_usage u ON a.id=u.artifact_id WHERE u.run=?',
            )
            .all(a.run),
        };
      default:
        throw Error('Unknown artifact operation');
    }
  }
}
