import { managementError } from './management-errors.js';
import { promises as fs, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from './db.js';
export function artifactFolder(directory: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid artifact id');
  return join(directory, 'artifacts', id);
}
export function artifactFile(directory: string, id: string, name: string) {
  return join(
    artifactFolder(directory, id),
    'files',
    createHash('sha256').update(name).digest('hex'),
  );
}
export async function artifactQuery(
  db: DB,
  body: any,
  origin: string,
  directory: string,
  signUrl = (url: string, _method: string) => url,
): Promise<any | undefined> {
  const query = body.query || '',
    op = query.match(/\b(?:query|mutation)\s+(\w+)/)?.[1] || '',
    v = body.variables || {},
    call = (method: string, args: any) => db.call('artifact', method, args);
  const url = (id: string, name?: string, method = 'GET') =>
    signUrl(
      `${origin}/storage/artifacts/${id}/${name === undefined ? 'manifest' : `files/${encodeURIComponent(name)}`}`,
      method,
    );
  const describe = (id: string) => call('describe', { id });
  const connection = (files: any[], id: string) => ({
    pageInfo: { endCursor: null, hasNextPage: false },
    edges: files.map((f) => ({ node: { name: f.name, directUrl: url(id, f.name) } })),
  });
  if (op === 'CreateArtifact') {
    const r = await call('create', v.input || v);
    return {
      createArtifact: {
        artifact: { id: r.id, state: r.state, artifactSequence: { latestArtifact: { id: r.id } } },
      },
    };
  }
  if (op === 'CreateArtifactManifest') {
    const a = v.input || v,
      id = a.artifactID;
    await call('manifest', { id, digest: a.digest });
    return {
      createArtifactManifest: {
        artifactManifest: {
          id: id + '-manifest',
          file: {
            id: id + '-manifest-file',
            uploadUrl: url(id, undefined, 'PUT'),
            uploadHeaders: ['Content-Type: application/octet-stream'],
          },
        },
      },
    };
  }
  if (op === 'CreateArtifactFiles') {
    const input = v.input || v;
    const edges = [];
    for (const f of input.artifactFiles || []) {
      const id = f.artifactID;
      await call('file', { id, name: f.name, digest: f.md5 || f.digest });
      edges.push({
        node: {
          storagePath: `randl/${id}/${f.name}`,
          uploadUrl: url(id, f.name, 'PUT'),
          uploadHeaders: ['Content-Type: application/octet-stream'],
          uploadMultipartUrls: null,
          artifact: { id },
        },
      });
    }
    return { createArtifactFiles: { files: { edges } } };
  }
  if (op === 'CommitArtifact') {
    const id = v.artifactID || v.input?.artifactID;
    const existing = await call('get', { id });
    if (existing?.state === 'COMMITTED')
      return { commitArtifact: { artifact: { id, digest: existing.digest } } };
    const manifest = JSON.parse(
      await fs.readFile(join(artifactFolder(directory, id), 'manifest.json'), 'utf8'),
    );
    let size = 0,
      count = 0;
    for (const [name, entry] of Object.entries(manifest.contents || {}) as [string, any][]) {
      if (entry.ref) throw Error('External artifact references are not supported');
      const hash = createHash('md5');
      let fileSize = 0;
      for await (const chunk of createReadStream(artifactFile(directory, id, name))) {
        hash.update(chunk);
        fileSize += chunk.length;
      }
      if (hash.digest('base64') !== entry.digest)
        throw Error('Artifact checksum mismatch: ' + name);
      size += fileSize;
      count++;
      await call('file', { id, name, digest: entry.digest, size: fileSize });
    }
    const r = await call('commit', { id, size, count });
    return { commitArtifact: { artifact: { id, digest: r.digest } } };
  }
  if (op === 'ArtifactByID') return { artifact: await describe(v.id) };
  if (op === 'ArtifactMembershipByName') {
    const r = await call('resolve', { entity: v.entity, project: v.project, name: v.name });
    if (!r) return { project: { artifactCollectionMembership: null } };
    const artifact = await describe(r.id);
    return {
      project: {
        artifactCollectionMembership: {
          id: r.id + '-membership',
          versionIndex: r.version,
          createdAt: r.created,
          aliases: artifact.aliases.map((a: any) => ({ id: a.id, alias: a.alias })),
          artifactCollection: artifact.artifactSequence,
          artifact,
        },
      },
    };
  }
  if (op === 'UseArtifact' || query.includes('useArtifact(input:'))
    return { useArtifact: await call('use', v.input || v) };
  if (['FetchArtifactManifest', 'ArtifactManifest'].includes(op)) {
    const id = v.id || v.artifact_id;
    return { artifact: { currentManifest: { file: { directUrl: url(id) } } } };
  }
  if (op === 'GetArtifactMembershipFileUrls') {
    const r = await call('resolve', {
      entity: v.entity,
      project: v.project,
      name: v.collection + ':' + v.alias,
    });
    if (!r) throw managementError('ARTIFACT_NOT_FOUND', 'Artifact not found');
    return {
      project: {
        artifactCollection: {
          __typename: 'ArtifactSequence',
          artifactMembership: { files: connection(await call('files', { id: r.id }), r.id) },
        },
      },
    };
  }
  if (['ArtifactFileURLsByManifestEntries', 'ArtifactFileURLs'].includes(op)) {
    const files = await call('files', { id: v.id });
    return {
      artifact: {
        [op === 'ArtifactFileURLs' ? 'files' : 'filesByManifestEntries']: connection(files, v.id),
      },
    };
  }
  return undefined;
}
