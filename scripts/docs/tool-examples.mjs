// One example request for every management tool, run in this order against a server seeded
// with the synthetic project below. scripts/docs-reference.mjs writes the requests and the
// responses they get into docs/reference/tools.md; tests/docs.test.mjs runs them again.
// Synthetic data only: no real projects, hosts or runs belong here.

export const project = 'team/navigation';
const run = (name) => `${project}/${name}`;
const history = (rows) => ({
  files: { 'wandb-history.jsonl': { offset: 0, content: rows.map((row) => JSON.stringify(row)) } },
});
const compute = (host, gpus, from = 0) => ({
  host,
  gpu_count: gpus.length,
  segments: [
    {
      from_update: from,
      to_update: null,
      host,
      gpu_count: gpus.length,
      gpu_ids: gpus,
      gpu_model: 'RTX 4090',
    },
  ],
});

/** Three finished runs, a lineage link between two of them, and one running run. */
export async function seed(server) {
  const call = (...args) => server.db.call(...args);
  const rows = (start, slope) =>
    Array.from({ length: 6 }, (_, i) => ({
      _step: i,
      update: (start + i) * 1000,
      'eval/return': start * slope + i * slope,
      'train/loss': 1 / (start + i + 1),
    }));
  await call('upsert', {
    entity: 'team',
    project: 'navigation',
    name: 'base01',
    displayName: 'v1_baseline',
    config: {
      lr: { value: 0.0003 },
      model: { value: { hidden: 256 } },
      lineage: {
        value: {
          parent: null,
          hypothesis: 'A plain PPO baseline',
          compute: compute('gpu-a', [0, 1]),
        },
      },
    },
  });
  await call('ingest', run('base01'), { ...history(rows(0, 10)), complete: true });
  await call('upsert', {
    entity: 'team',
    project: 'navigation',
    name: 'wide02',
    displayName: 'v2_wide',
    config: {
      lr: { value: 0.0003 },
      model: { value: { hidden: 512 } },
      lineage: {
        value: {
          parent: { run_id: 'base01', update: 5000 },
          relation: 'initialize_from',
          change: 'Hidden layer widened from 256 to 512 units',
          hypothesis: 'A wider policy reaches a higher return',
          compute: compute('gpu-a', [0, 1], 5000),
        },
      },
    },
  });
  await call('ingest', run('wide02'), { ...history(rows(5, 12)), complete: true });
  await call('upsert', {
    entity: 'team',
    project: 'navigation',
    name: 'lr03',
    displayName: 'v3_low_lr',
    config: {
      lr: { value: 0.0001 },
      model: { value: { hidden: 512 } },
      lineage: {
        value: { parent: { run_id: 'wide02', update: 10000 }, relation: 'initialize_from' },
      },
    },
  });
  await call('ingest', run('lr03'), { ...history(rows(10, 11)), complete: true });
  await call('upsert', {
    entity: 'team',
    project: 'navigation',
    name: 'live04',
    displayName: 'v4_live',
    config: {
      lr: { value: 0.0003 },
      lineage: { value: { parent: { run_id: 'wide02' }, compute: compute('gpu-a', [2]) } },
    },
  });
  await call('ingest', run('live04'), history(rows(10, 12)));
}

/**
 * Each example: the tool, its request (a value, or a function of the earlier responses by
 * tool name), the error codes callers branch on, and a note shown under the example.
 */
export const examples = [
  { tool: 'workspace_snapshot', request: {} },
  { tool: 'plugins_list', request: {} },
  { tool: 'settings_get', request: {} },
  {
    tool: 'settings_update',
    request: { mediaLimit: { enabled: false } },
  },
  {
    tool: 'project_create',
    request: { id: 'team/scratch', name: 'Scratch' },
    errors: ['projects.errors.invalidId', 'projects.errors.alreadyExists'],
  },
  {
    tool: 'project_update',
    request: { id: 'team/scratch', description: 'Short trials before a full run' },
  },
  { tool: 'project_get', request: { id: project }, errors: ['projects.errors.notFound'] },
  { tool: 'project_media_limit_get', request: { id: project } },
  {
    tool: 'project_media_limit_update',
    request: { id: project, inherit: false, enabled: true, megabytes: 2048 },
  },
  { tool: 'media_limit_apply', request: { dryRun: true } },
  { tool: 'runs_list', request: { project } },
  { tool: 'run_get', request: { id: run('wide02') }, errors: ['RUN_NOT_FOUND'] },
  { tool: 'metrics_list', request: { runs: [run('base01'), run('wide02')] } },
  {
    tool: 'runs_update',
    request: { ids: [run('base01'), run('wide02')], action: 'add-tags', tags: ['baseline'] },
  },
  {
    tool: 'run_metadata_update',
    request: {
      id: run('wide02'),
      configMerge: { lineage: { result: 'Return 120 at update 10000, +20 over v1' } },
      addTags: ['verdict:adopted'],
      by: 'backfill-script',
    },
    errors: ['RUN_NOT_FOUND'],
  },
  {
    tool: 'run_state_set',
    request: {
      id: run('lr03'),
      state: 'stopped',
      reason: 'Return fell behind v2 after update 12000',
      by: 'me',
    },
    errors: ['RUN_STATE_RUNNING', 'RUN_NOT_FOUND'],
  },
  {
    tool: 'run_metrics_rename',
    request: {
      id: run('base01'),
      renames: [{ from: 'train/loss', to: 'losses/policy' }],
      by: 'me',
    },
    errors: ['METRIC_RENAMES_REFUSED'],
  },
  {
    tool: 'run_metrics_rename_undo',
    request: (done) => ({ undo: done.run_metrics_rename.renames[0].undo, by: 'me' }),
    errors: ['METRIC_RENAME_NOT_FOUND', 'METRIC_RENAME_CHANGED'],
  },
  {
    tool: 'run_history_write',
    request: {
      id: run('wide02'),
      rows: [{ match: { update: 10000 }, values: { 'audit/success': 0.73 } }],
      by: 'audit-script',
    },
    errors: ['HISTORY_ROWS_REFUSED'],
  },
  { tool: 'project_lineage_settings_get', request: { id: project } },
  {
    tool: 'project_lineage_settings_update',
    request: { id: project, metric: 'eval/return', goal: 'max', progressKey: 'update' },
  },
  { tool: 'project_lineage', request: { id: project } },
  {
    tool: 'runs_config_diff',
    request: { from: run('base01'), to: run('wide02') },
    errors: ['RUN_NOT_FOUND'],
  },
  {
    tool: 'runs_compare',
    request: { baseline: run('wide02'), runs: [run('lr03')], metric: 'eval/return', x: 'update' },
  },
  {
    tool: 'view_create',
    request: { project, name: 'Width study' },
    errors: ['VIEW_NAME_REQUIRED', 'VIEW_NAME_IN_USE'],
  },
  {
    tool: 'view_get',
    request: (done) => ({ id: done.view_create.id }),
    note: 'A view that does not exist returns `null`.',
  },
  {
    tool: 'view_rename',
    request: (done) => ({ id: done.view_create.id, name: 'Width and learning rate' }),
    errors: ['VIEW_NAME_IN_USE'],
  },
  {
    tool: 'panel_add',
    request: (done) => ({
      view: done.view_create.id,
      plugin: 'line',
      metric: 'eval/return',
      settings: { xAxis: 'update', smoothingMethod: 'ema', smoothingValue: 0.6 },
    }),
    errors: ['VIEW_NOT_FOUND', 'PLUGIN_OPTION_INVALID'],
  },
  {
    tool: 'panel_update',
    request: (done) => ({
      view: done.view_create.id,
      id: done.panel_add.body.panels.at(-1).id,
      title: 'Return by update',
    }),
    errors: ['VIEW_NOT_FOUND', 'PLUGIN_OPTION_INVALID'],
  },
  {
    tool: 'runs_select',
    request: (done) => ({ view: done.view_create.id, solo: [run('wide02'), run('lr03')] }),
    errors: ['VISIBLE_RUN_LIMIT', 'SOLO_RUN_LIMIT'],
  },
  {
    tool: 'view_save',
    request: (done) => {
      const view = done.runs_select;
      return {
        id: view.id,
        name: view.name,
        project: view.project,
        version: view.version,
        body: { ...view.body, pinned: [run('wide02')] },
      };
    },
    errors: ['VIEW_CONFLICT', 'VIEW_DELETED'],
    note: '`version` is the version you read; a newer saved version is refused with `VIEW_CONFLICT`.',
  },
  {
    tool: 'panel_remove',
    request: (done) => ({ view: done.view_create.id, id: done.panel_add.body.panels.at(-1).id }),
  },
  { tool: 'view_delete', request: (done) => ({ id: done.view_create.id }) },
  {
    tool: 'finding_save',
    request: {
      project,
      id: 'width-helps',
      topic: 'Model',
      title: 'A wider policy reaches a higher return',
      body: 'v2 doubled the hidden layer and gained 20 return by update 10000.',
      citations: [{ run: run('wide02'), update: 10000 }],
      by: 'me',
    },
    errors: ['FINDING_CONFLICT'],
  },
  { tool: 'findings_list', request: { project } },
  {
    tool: 'finding_get',
    request: { project, id: 'width-helps' },
    errors: ['LEDGER_NOT_FOUND'],
  },
  { tool: 'finding_delete', request: { project, id: 'width-helps', by: 'me' } },
  {
    tool: 'recipe_set',
    request: { project, run: run('wide02'), reason: 'Best return at equal compute', by: 'me' },
    errors: ['LEDGER_TIME_INVALID'],
  },
  { tool: 'recipe_get', request: { project } },
  {
    tool: 'journal_add',
    request: {
      run: run('wide02'),
      update: 8000,
      text: 'Return jumped after the entropy bonus decayed.',
      by: 'me',
    },
    errors: ['LEDGER_TIME_INVALID', 'JOURNAL_KEY_IN_USE'],
  },
  {
    tool: 'journal_list',
    request: { run: run('wide02') },
    errors: ['RUN_NOT_FOUND'],
    note: '`RUN_NOT_FOUND` means neither `run` nor `project` was given; an unknown run has no entries.',
  },
  {
    tool: 'evidence_save',
    request: {
      project,
      id: 'eval-wide02',
      name: 'eval_v2_u10000',
      job_type: 'evaluation',
      created: '2026-01-15T09:00:00Z',
      examines: [run('wide02')],
      summary: { success_rate: 0.73, episodes: 512 },
      files: [{ name: 'episodes.csv', host: 'gpu-a', path: '/data/eval/episodes.csv' }],
      by: 'eval-script',
    },
    errors: ['LEDGER_TIME_INVALID'],
  },
  {
    tool: 'gpus_save',
    request: {
      project,
      host: 'gpu-a',
      gpus: [0, 1, 2, 3],
      model: 'RTX 4090',
      memory_gb: 24,
      by: 'me',
    },
  },
  { tool: 'gpus_list', request: { project } },
  {
    tool: 'plan_save',
    request: {
      project,
      id: 'v5',
      name: 'v5_wider_still',
      parent: run('wide02'),
      parentUpdate: 10000,
      change: 'Hidden layer widened from 512 to 1024 units',
      hypothesis: 'The gain from width has not saturated',
      rule: 'Stop if return trails v2 by 10 at update 15000',
      resources: { gpus: 2, min_memory_gb: 24 },
      updates: 20000,
      estimated_hours: 14,
      config_yaml: 'model:\n  hidden: 1024\nlr: 0.0003\n',
      by: 'me',
    },
  },
  {
    tool: 'plan_save',
    label: 'a second plan',
    request: {
      project,
      id: 'v6',
      name: 'v6_low_lr',
      parent: run('wide02'),
      resources: { gpus: 1 },
      queue: 1,
      by: 'me',
    },
  },
  { tool: 'plans_list', request: { project } },
  { tool: 'plan_queue', request: { project } },
  {
    tool: 'plan_move',
    request: { project, id: 'v5', before: 'v6', by: 'me' },
    errors: ['LEDGER_NOT_FOUND', 'PLAN_NOT_WAITING'],
  },
  {
    tool: 'plan_claim',
    request: { project, host: 'gpu-a', free_gpus: [0, 1, 3], by: 'gpu-a-agent' },
    errors: ['PLAN_HOST_UNKNOWN'],
  },
  { tool: 'project_occupancy', request: { project } },
  {
    tool: 'idea_save',
    request: {
      project,
      id: 'curriculum',
      title: 'Curriculum over obstacle density',
      hypothesis: 'Starting sparse speeds up early learning',
      evidence: 'v2 learned slowly in dense scenes for its first 3000 updates',
      waits_on: [{ kind: 'plan', id: 'v5' }],
      priority: 'high',
      by: 'me',
    },
    errors: ['IDEA_STATUS_INVALID'],
  },
  { tool: 'idea_list', request: { project } },
  {
    tool: 'idea_promote',
    request: { project, id: 'curriculum', resources: { gpus: 1 }, queue: 1, by: 'me' },
    errors: ['LEDGER_NOT_FOUND', 'IDEA_PROMOTED', 'IDEA_PLAN_EXISTS'],
  },
  {
    tool: 'idea_from_plan',
    request: { project, plan: 'v6', priority: 'low', by: 'me' },
    errors: ['LEDGER_NOT_FOUND', 'PLAN_NOT_WAITING', 'IDEA_EXISTS'],
  },
  { tool: 'idea_delete', request: { project, id: 'curriculum', by: 'me' } },
  { tool: 'plan_delete', request: { project, id: 'curriculum', by: 'me' } },
  { tool: 'gpus_delete', request: { project, host: 'gpu-a', gpus: [3], by: 'me' } },
  {
    tool: 'project_delete',
    request: { id: 'team/scratch', confirm: 'Scratch' },
    errors: [
      'projects.errors.confirmName',
      'projects.errors.runningRuns',
      'projects.errors.changed',
    ],
    note: "`confirm` must equal the project's display name. `expected` (counts of runs, deleted runs, artifact versions and views) refuses the deletion when the project has changed since you counted.",
  },
];
