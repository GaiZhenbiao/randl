import type { DB } from './db.js';
export async function sdkQuery(
  db: DB,
  body: any,
  origin: string,
  signUrl = (url: string, _method: string) => url,
  defaultEntity = 'local',
) {
  const q = String(body.query || ''),
    v = body.variables || {},
    entity = v.entity || v.entityName || defaultEntity,
    project = v.project || v.projectName || 'uncategorized',
    name = v.name || v.run || v.runName || v.runId,
    id = `${entity}/${project}/${name}`;
  const bucket = async (r: any) => ({
    ...r,
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    description: r.notes,
    summaryMetrics: r.summary,
    config: r.config,
    tags: JSON.parse(r.tags),
    sweepName: null,
    // New rows go after every stored offset, including sparse records appended on import.
    historyLineCount: Math.max(r.history_count, await db.call('streamCount', r.id, 'wandb-history.jsonl')),
    logLineCount: await db.call('streamCount', r.id, 'output.log'),
    eventsLineCount: await db.call('streamCount', r.id, 'wandb-events.jsonl'),
    historyTail: await db.call('historyTail', r.id),
    eventsTail: await db.call('tail', r.id, 'wandb-events.jsonl'),
    wandbConfig: JSON.stringify({ t: 1 }),
    project: {
      id: `${r.entity}/${r.project}`,
      name: r.project,
      entity: { id: r.entity, name: r.entity },
    },
  });
  if(q.includes('notifyScriptableRunAlert'))return {notifyScriptableRunAlert:await db.call('alert',{run:id,title:v.title,text:v.text,severity:v.severity,waitDuration:Number(v.waitDuration)/1000})};
  if (q.includes('upsertBucket'))
    return {
      upsertBucket: {
        bucket: await bucket(await db.call('upsert', { ...v, entity, project })),
        inserted: true,
      },
    };
  if (q.includes('createRunFiles')) {
    const uploadingRun=await db.call('run',id);
    if(!uploadingRun)throw Error('Unknown run');
    return {
      createRunFiles: {
        runID: id,
        uploadHeaders: ['Content-Type: application/octet-stream'],
        files: (v.files || []).map((file: string) => ({
          name: file,
          uploadUrl: signUrl(
            `${origin}/upload/${[entity, project, name, ...file.split('/')].map(encodeURIComponent).join('/')}`,
            'PUT',
          ),
        })),
      },
    };
  }
  if (q.includes('RunResumeStatus')) {
    const r = await db.call('run', id);
    return {
      model: {
        id: `${entity}/${project}`,
        name: project,
        entity: { id: entity, name: entity },
        bucket: r ? await bucket(r) : null,
      },
    };
  }
  // Public API (wandb.Api()): run lookup, last history step and run listing, read-only.
  const iso = (seconds: number | null | undefined) =>
    seconds == null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const publicRun = async (r: any) => ({
    id: r.id,
    projectId: 1,
    name: r.name,
    displayName: r.display_name,
    sweepName: null,
    state: r.state,
    config: r.config,
    group: r.group_name || null,
    jobType: r.job_type || null,
    commit: r.git_commit || null,
    readOnly: false,
    createdAt: iso(r.created),
    heartbeatAt: iso(r.heartbeat),
    description: r.notes || null,
    notes: r.notes || null,
    systemMetrics: '{}',
    summaryMetrics: r.summary,
    historyLineCount: Math.max(
      r.history_count,
      await db.call('streamCount', r.id, 'wandb-history.jsonl'),
    ),
    tags: JSON.parse(r.tags),
    user: { name: r.username || defaultEntity, username: r.username || defaultEntity },
    ...(/\bhistoryKeys\b/.test(q) ? { historyKeys: await db.call('historyKeys', r.id) } : {}),
  });
  const runQuery = /\bquery\s+(Run|RunHistoryKeys|Runs)\s*\(/.exec(q)?.[1];
  if (runQuery === 'Run' || runQuery === 'RunHistoryKeys') {
    const r = await db.call('run', id);
    return { project: r ? { run: await publicRun(r) } : null };
  }
  if (runQuery === 'Runs') {
    const filters = typeof v.filters === 'string' ? JSON.parse(v.filters || '{}') : v.filters || {};
    if (Object.keys(filters).length)
      throw Error('Run filters are not supported by randl; list runs without filters.');
    const all = (await db.call('runs')).filter(
        (r: any) => r.entity === entity && r.project === project,
      ),
      start = Number(v.cursor || 0),
      size = Math.min(1000, Number(v.perPage || 50)),
      page = all.slice(start, start + size);
    const nodes = [];
    for (const r of page) nodes.push(await publicRun(await db.call('run', r.id)));
    return {
      project: {
        internalId: 1,
        runCount: all.length,
        readOnly: false,
        runs: {
          edges: nodes.map((node, index) => ({ node, cursor: String(start + index + 1) })),
          pageInfo: { endCursor: String(start + page.length), hasNextPage: start + size < all.length },
        },
      },
    };
  }
  if (q.includes('RunStoppedStatus'))
    return { project: { run: { stopped: !!(await db.call('run', id))?.stop_requested } } };
  if (/\b__type\s*\(/.test(q)) {
    const fields = [
      'id',
      'name',
      'entityName',
      'modelName',
      'displayName',
      'config',
      'summaryMetrics',
      'tags',
      'notes',
      'groupName',
      'jobType',
      'state',
      'host',
      'commit',
      'jobProgram',
      'jobRepo',
    ];
    const aliases = [...q.matchAll(/(\w+)\s*:\s*__type\s*\(/g)].map((m) => m[1]);
    return Object.fromEntries(
      (aliases.length ? aliases : ['__type']).map((alias) => [
        alias,
        { name: 'UpsertBucketInput', fields: [], inputFields: fields.map((name) => ({ name })) },
      ]),
    );
  }
  if (q.includes('serverInfo') || q.includes('viewer')) {
    const result: Record<string, any> = {};
    if (q.includes('serverInfo'))
      result.serverInfo = {
        cliVersionInfo: JSON.stringify({
          min_cli_version: '0.12.0',
          max_cli_version: '99.0.0',
          latest_cli_version: '0.30.0',
        }),
        features: [],
        local: true,
        latestLocalVersionInfo: {
          outOfDate: false,
          latestVersionString: '0.99.0',
          versionOnThisInstanceString: '0.99.0',
        },
      };
    if (q.includes('viewer'))
      result.viewer = {
        id: defaultEntity,
        entity: defaultEntity,
        username: defaultEntity,
        email: defaultEntity + '@localhost',
        flags: '{}',
        teams: { edges: [] },
      };
    return result;
  }
  if (q.includes('OrganizationCoreWeaveOrganizationID') || q.includes('FetchOrgEntityFromEntity'))
    return { entity: { organization: null } };
  throw Error(
    'Unsupported W&B operation. Supported: scalar run logging, config, summary, files and resume.',
  );
}
