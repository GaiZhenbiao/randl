import {managementError} from './management-errors.js';
import selectionLimits from './selection-limits.json' with { type: 'json' };
import { checkSelectionLimits } from './selection-limits.js';
import panelLimits from './panel-limits.json' with {type:'json'};
import {KeyedLocks} from './locks.js';
import { invalidOption, optionKeyPattern, optionLimits, pluginIdPattern } from './plugin-options.js';
import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import {
  mediaCapMax,
  mediaCapSetting,
  mediaLimit,
  projectLimitSetting,
  projectMediaLimit,
} from './media-cap.js';
import type { Plugins } from './plugins.js';
import { lineageDefaults, type LineageSettings } from './lineage.js';
type Args = Record<string, any>;
const string = { type: 'string', maxLength: 4096 },
  strings = { type: 'array', items: string, maxItems: 1000 },
  selectedRuns = { ...strings, maxItems: selectionLimits.maxSelectedRuns, uniqueItems: true };
/** Run fields that can group runs, matching the browser's group choices. */
const groupField =
  '(?:state|running|group_name|job_type|tags|host|program|git_commit|username|os|python|gpu|(?:config|summary)\\.(?!_).+)';
/** An empty run-list group means no grouping; there is no separate sentinel. */
export const runGroupRule =
  'must be empty (no grouping) or a run field such as config.seed, summary.loss or tags';
export const chartGroupRule = 'must be none, all or a run field such as config.seed';
const runGroup = { ...string, pattern: `^(?:${groupField})?$`, description: runGroupRule };
/** Chart settings also need `none` (override an inherited grouping) and `all`. */
const chartGroup = {
  ...string,
  pattern: `^(?:none|all|${groupField})$`,
  description: chartGroupRule,
};
function schema(properties: Args = {}, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}
/** Top-level config keys and their new values; `_` keys belong to the SDK. */
const configPatch = {
  type: 'object',
  propertyNames: { pattern: '^[^_]', maxLength: 512 },
  maxProperties: 100,
};
/** A metric key a rename may use; `_` keys belong to the SDK. */
const metricName = { type: 'string', minLength: 1, maxLength: 512, pattern: '^[^_]' };
const lineageKeys = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 512 },
  maxItems: 50,
};
/** The server setting holding a project's lineage settings. */
export const lineageSetting = (project: string) => 'lineage:' + project;
/** A project's lineage settings, defaults filled in. */
async function lineageSettings(db: DB, project: string): Promise<LineageSettings> {
  return { ...lineageDefaults, ...(await db.call('settingGet', lineageSetting(project))) };
}
export const settingsSchema = schema({
  maxRuns: {
    anyOf: [
      { type: ['integer', 'null'], minimum: 1, maximum: panelLimits.chartRuns },
      { type: 'string', const: 'focused' },
    ],
  },
  legendPosition: string,
  legendTemplate: string,
  tooltipLimit: { type: 'integer', minimum: 1, maximum: 100 },
  tooltipFullNames: { type: 'boolean' },
  tooltipColoredNames: { type: 'boolean' },
  tooltipOnlyHighlighted: { type: 'boolean' },
  xAxis: string,
  xScale: string,
  yScale: string,
  xMin: { type: ['number', 'null'] },
  xMax: { type: ['number', 'null'] },
  yMin: { type: ['number', 'null'] },
  yMax: { type: ['number', 'null'] },
  excludeOutliers: { type: 'boolean' },
  outlierLower: { type: 'number', minimum: 0, maximum: 100 },
  outlierUpper: { type: 'number', minimum: 0, maximum: 100 },
  smoothingMethod: { type: 'string', enum: ['none', 'ema', 'twema', 'gaussian', 'running'] },
  smoothingValue: { type: 'number', minimum: 0 },
  showOriginal: { type: 'boolean' },
  showPoints: { type: 'boolean' },
  legend: { type: 'boolean' },
  lineWidth: { type: 'number', minimum: 0.5, maximum: 8 },
  groupBy: chartGroup,
  aggregation: string,
  spread: string,
  resolution: { type: 'string', enum: Object.keys(panelLimits.resolution.points) },
  // cellLayout panels: every run or group in one chart, a grid of cells, or one cell at a time.
  // itemLayout (media) panels: a grid of items or one at a time.
  layout: { type: 'string', enum: ['single', 'grid', 'coverflow'] },
  itemSize: {
    type: 'integer',
    minimum: panelLimits.itemSize.min,
    maximum: panelLimits.itemSize.max,
  },
  sharedY: { type: 'boolean' },
  // Media panels: runs at one step, or the steps of one run; files shown per step.
  mediaAcross: { type: 'string', enum: ['runs', 'steps'] },
  mediaFiles: { type: 'integer', minimum: 1, maximum: panelLimits.media.files.max },
  // Plugin option values by plugin ID; each installed plugin's descriptors check them in Tools.
  options: {
    type: 'object',
    maxProperties: optionLimits.plugins,
    propertyNames: { pattern: pluginIdPattern.source },
    additionalProperties: {
      type: 'object',
      maxProperties: optionLimits.options,
      propertyNames: { pattern: optionKeyPattern.source },
      additionalProperties: {
        anyOf: [
          { type: 'boolean' },
          { type: 'number' },
          { type: 'string', maxLength: optionLimits.text },
        ],
      },
    },
  },
});
// Computed metrics: named expressions over metrics of the same history record (docs/plugins.md).
const expressionsSchema = {
  type: 'array',
  maxItems: panelLimits.maxMetrics,
  items: schema(
    { name: { ...string, maxLength: 200 }, expression: { ...string, maxLength: 1000 } },
    ['name', 'expression'],
  ),
};
export const panelSchema = schema(
  {
    id: string,
    section: string,
    plugin: string,
    metric: string,
    metrics: { type: 'array', items: string, maxItems: panelLimits.maxMetrics },
    title: string,
    settings: settingsSchema,
    expressions: expressionsSchema,
  },
  ['id', 'plugin', 'metric'],
);
export const viewBodySchema = schema(
  {
    sections: {
      type: 'array',
      items: schema({ id: string, name: string, collapsed: { type: 'boolean' } }, ['id', 'name']),
      maxItems: 500,
    },
    sectionLayouts: {
      type: 'object',
      additionalProperties: schema({
        width: { type: 'number', minimum: 240, maximum: 3000 },
        height: { type: 'number', minimum: 220, maximum: 800 },
        rows: { type: 'integer', minimum: 1, maximum: 20 },
      }),
      maxProperties: 500,
    },
    generation: { type: 'string', enum: ['automatic', 'manual'] },
    hiddenMetrics: { type: 'array', items: string, maxItems: 5000 },
    hidePattern: string,
    panels: { type: 'array', items: panelSchema, maxItems: 500 },
    pinned: {...strings,maxItems:20,uniqueItems:true},
    visible: selectedRuns,
    // Runs created after this time (run creation seconds) are shown in addition to `visible`.
    visibleThrough: { type: 'number', minimum: 0 },
    solo: selectedRuns,
    run: string,
    runQuery: schema({
      sort: string,
      group: runGroup,
      columns: { type: 'array', items: string, maxItems: panelLimits.maxColumns },
    }),
    runColors: {
      type: 'object',
      additionalProperties: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' },
      maxProperties: 10000,
    },
    plotSettings: settingsSchema,
    sectionSettings: { type: 'object', additionalProperties: settingsSchema, maxProperties: 500 },
    filters: {
      type: 'array',
      items: schema({ field: string, operator: string, value: string }, [
        'field',
        'operator',
        'value',
      ]),
      maxItems: 20,
    },
    filterMode: string,
  },
  ['panels', 'visible', 'solo'],
);
export const toolCatalog = [
  {
    name: 'runs_update',
    description:
      'Move runs to trash, restore them, request a stop, or add/remove tags. Actions: delete, restore, stop, add-tags, remove-tags.',
    parameters: schema({ ids: strings, action: string, tags: strings }, ['ids', 'action']),
  },

  {
    name: 'workspace_snapshot',
    description: 'List projects, saved views and installed panel plugins.',
    parameters: schema(),
  },
  {
    name: 'runs_list',
    description: 'List all lightweight run metadata. Optional project id filters entity/project.',
    parameters: schema({ project: string }),
  },
  {
    name: 'settings_get',
    description:
      'Read the server settings. mediaLimit says whether runs are limited in logged media files (enabled) and to how many megabytes each; projects use it unless they set their own (project_media_limit_get).',
    parameters: schema(),
  },
  {
    name: 'settings_update',
    description:
      'Change server settings. Not available to the Assistant. mediaLimit turns the per-run media limit on or off (enabled) and sets its size (megabytes, kept when omitted). While it is on, every run over the limit, finished runs included, permanently loses media entries, thinned evenly over its steps, keeping the first and the newest of every key.',
    agent: false,
    parameters: schema(
      {
        mediaLimit: schema(
          {
            enabled: { type: 'boolean' },
            megabytes: { type: 'integer', minimum: 1, maximum: mediaCapMax },
          },
          ['enabled'],
        ),
      },
      ['mediaLimit'],
    ),
  },
  {
    name: 'project_media_limit_get',
    description:
      "Read a project's media limit settings: inherit (use the server's limit), its own enabled and megabytes, the thinning axis its runs' media are spaced on (_step, _runtime, _relative_wall, _timestamp or a metric), and the limit in effect.",
    parameters: schema({ id: string }, ['id']),
  },
  {
    name: 'project_media_limit_update',
    description:
      "Change the supplied fields of a project's media limit settings. Not available to the Assistant. inherit: true uses the server's limit; false uses the project's own enabled and megabytes. axis is the metric the media of the project's runs are spaced on when thinned. Runs over the limit in effect permanently lose media entries.",
    agent: false,
    parameters: schema(
      {
        id: string,
        inherit: { type: 'boolean' },
        enabled: { type: 'boolean' },
        megabytes: { type: 'integer', minimum: 1, maximum: mediaCapMax },
        axis: { type: 'string', minLength: 1, maxLength: 512 },
      },
      ['id'],
    ),
  },
  {
    name: 'media_limit_apply',
    description:
      'Apply the media limit to every run and wait for the result; the server also does this on its own at startup and when the limit changes. dryRun: true only reports the runs, entries, files and bytes that would be removed; dryRun: false permanently deletes media of runs over the limit.',
    agent: false,
    parameters: schema({ dryRun: { type: 'boolean' } }, ['dryRun']),
  },
  {
    name: 'project_lineage',
    description:
      "Read a project's run lineage graph: one node per run (state, verdict from verdict:* tags, hypothesis, latest and best value of the lineage metric) and one edge per run that started from another run's checkpoint (relation, parent update, explicit when the run logged a lineage config block, the first changed config keys and their count). Runs whose named parent matched no run carry unresolved.",
    parameters: schema({ id: string }, ['id']),
  },
  {
    name: 'project_lineage_settings_get',
    description:
      "Read a project's lineage settings: the metric shown on each node, its display scale and goal (max or min), the config keys holding a run's parent checkpoint path (parentKeys) and its own folder or name (identityKeys), and the config keys left out of diffs (ignoreKeys, * matches any characters).",
    parameters: schema({ id: string }, ['id']),
  },
  {
    name: 'project_lineage_settings_update',
    description:
      "Change the supplied fields of a project's lineage settings (see project_lineage_settings_get). scale null shows the metric's value unscaled.",
    parameters: schema(
      {
        id: string,
        metric: { type: 'string', maxLength: 512 },
        scale: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
        goal: { type: 'string', enum: ['max', 'min'] },
        parentKeys: lineageKeys,
        identityKeys: lineageKeys,
        ignoreKeys: lineageKeys,
      },
      ['id'],
    ),
  },
  {
    name: 'run_metadata_update',
    description:
      "Change a stored run's config keys, tags or notes without touching its state, history, summary, files or runtime; for backfilling metadata such as a lineage block or verdict:* tags. config replaces top-level config keys with JSON values (null removes a key); configMerge deep-merges objects into top-level keys (a null leaf removes that nested key); summary sets top-level summary keys (null removes one), for example a final audit value; tags replaces the tag list, addTags and removeTags edit it; notes replaces the notes. by names the caller (a script or person) in the audit log. Keys starting with _ are reserved. Repeating a request changes nothing. A running run's SDK sends its whole config again on its next config update, which replaces keys set here.",
    parameters: schema(
      {
        id: string,
        config: configPatch,
        configMerge: configPatch,
        summary: configPatch,
        tags: { ...strings, maxItems: 100 },
        addTags: { ...strings, maxItems: 100 },
        removeTags: { ...strings, maxItems: 100 },
        notes: { type: 'string', maxLength: 100000 },
        by: { type: 'string', maxLength: 200 },
      },
      ['id'],
    ),
  },
  {
    name: 'run_metrics_rename',
    description:
      "Rename metric keys of a stored run, for example old names to current ones so runs compare: its history records, chart points, logged media, metric index, summary and define_metric settings. Not available to the Assistant. renames is a list of {from, to}. A key already renamed (from gone, to present) is left alone; a target that already exists is refused unless merge is true, and a merge is refused when a step or history record holds both keys. Each rename reports its status (renamed, merged, unchanged, missing, or refused with exists, both or same) and how many history records and points hold the old key; dryRun: true only reports, and one refused rename refuses the whole request. Each applied rename returns an undo id for run_metrics_rename_undo. by names the caller in the audit log.",
    agent: false,
    parameters: schema(
      {
        id: string,
        renames: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: schema({ from: metricName, to: metricName }, ['from', 'to']),
        },
        merge: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        by: { type: 'string', maxLength: 200 },
      },
      ['id', 'renames'],
    ),
  },
  {
    name: 'run_metrics_rename_undo',
    description:
      'Reverse one metric rename by the undo id run_metrics_rename returned. Not available to the Assistant. Repeating it changes nothing.',
    agent: false,
    parameters: schema(
      { undo: { type: 'integer', minimum: 1 }, by: { type: 'string', maxLength: 200 } },
      ['undo'],
    ),
  },
  {
    name: 'run_history_write',
    description:
      "Write numeric values into a stored run's history, such as audit results computed after training (the SDK cannot log at earlier steps). Not available to the Assistant. Each row is {step, values} (the record with that _step, or a new record) or {match, values}, where match names logged fields such as {\"update\": 473000} and exactly one record must match. values maps metric names to numbers and merges into the record; a different stored value is refused unless replace is true, and identical values change nothing. Every row gets a status (merged, added, unchanged, or refused with no-match, ambiguous or conflict). dryRun: true writes nothing; otherwise one refused row refuses the whole request. by names the caller in the audit log.",
    agent: false,
    parameters: schema(
      {
        id: string,
        rows: {
          type: 'array',
          minItems: 1,
          maxItems: 100000,
          items: {
            ...schema(
              {
              step: { type: 'number' },
              match: {
                type: 'object',
                minProperties: 1,
                maxProperties: 20,
                propertyNames: { maxLength: 512 },
                additionalProperties: { type: ['string', 'number', 'boolean'] },
              },
              values: {
                type: 'object',
                propertyNames: { pattern: '^[^_]', maxLength: 512 },
                additionalProperties: { type: 'number' },
                minProperties: 1,
                maxProperties: 1000,
              },
              },
              ['values'],
            ),
            oneOf: [{ required: ['step'] }, { required: ['match'] }],
          },
        },
        replace: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        by: { type: 'string', maxLength: 200 },
      },
      ['id', 'rows'],
    ),
  },
  {
    name: 'runs_config_diff',
    description:
      "List every config key whose value differs from run from to run to, with both values; ignored marks keys the project's lineage settings leave out of diffs.",
    parameters: schema({ from: string, to: string }, ['from', 'to']),
  },
  {name:'run_get',description:'Read a run, its environment, configuration, summary, runtime, and logged alerts.',parameters:schema({id:string},['id'])},
  {
    name: 'metrics_list',
    description: 'List available metric names, data kinds, and SDK-defined step/hidden/summary settings for runs.',
    parameters: schema({ runs: strings }, ['runs']),
  },
  { name:'project_create', description:'Create a project with a display name and optional description.', parameters:schema({id:string,name:{type:'string',maxLength:200},description:{type:'string',maxLength:5000}},['id','name']) },
  { name:'project_update', description:'Update only the supplied project fields: display name, description or archived status.', parameters:schema({id:string,name:{type:'string',maxLength:200},description:{type:'string',maxLength:5000},archived:{type:'boolean'}},['id']) },
  { name:'project_get', description:'Read project details, run counts, runtime and logical storage bytes.', parameters:schema({id:string},['id']) },
  { name:'project_delete', description:'Permanently delete a project and all its data after user confirmation. Refuses while local runs are running.', tier:'confirm', agentParameters:schema({id:string},['id']), parameters:schema({id:string,confirm:string,expected:schema(Object.fromEntries(['runs','deletedRuns','artifactVersions','views'].map(key=>[key,{type:'integer',minimum:0}])),['runs','deletedRuns','artifactVersions','views'])},['id','confirm']) },
  {
    name: 'view_save',
    description: 'Save a complete view with an optimistic version check. Read it first.',
    parameters: schema(
      {
        id: string,
        name: string,
        project: string,
        body: viewBodySchema,
        version: { type: 'integer', minimum: 1 },
      },
      ['id', 'name', 'project', 'body', 'version'],
    ),
  },
  {
    name: 'view_delete',
    description: 'Delete a saved view without deleting run data.',
    parameters: schema({ id: string }, ['id']),
  },
  {
    name: 'view_get',
    description: 'Read a complete saved view before changing it.',
    parameters: schema({ id: string }, ['id']),
  },
  {
    name: 'view_create',
    description: 'Create a named view in an entity/project, or empty project for all.',
    parameters: schema({ name: string, project: string, run: string, body: viewBodySchema }, [
      'name',
    ]),
  },
  {
    name: 'view_rename',
    description: 'Rename a saved view.',
    parameters: schema({ id: string, name: string }, ['id', 'name']),
  },
  {
    name: 'panel_add',
    description:
      'Add a plugin panel to a view. metric is the primary key; metrics supplies extra axes for scatter/parallel or the components of a stacked or percent area. On plugins with the expressions setting, expressions adds computed metrics: [{name, expression}], where the expression references metrics of the same history record as ${metric/name} and may use numbers, + - * / % **, comparisons, && || !, ?: and Math functions, for example {name: "Collision rate", expression: "${collisions} / ${episodes}"}. metric may be omitted when expressions are given.',
    parameters: schema(
      {
        view: string,
        plugin: string,
        metric: string,
        metrics: { type: 'array', items: string, maxItems: panelLimits.maxMetrics },
        title: string,
        settings: settingsSchema,
        expressions: expressionsSchema,
      },
      ['view', 'plugin'],
    ),
  },
  {
    name: 'panel_update',
    description:
      'Change a panel plugin, metrics, computed metrics (expressions; null removes them), axes or title. Plugin options go in settings.options[pluginId]; see plugins_list.',
    parameters: schema(
      {
        view: string,
        id: string,
        plugin: string,
        metric: string,
        metrics: { type: 'array', items: string, maxItems: panelLimits.maxMetrics },
        title: string,
        settings: settingsSchema,
        expressions: { ...expressionsSchema, type: ['array', 'null'] },
      },
      ['view', 'id'],
    ),
  },
  {
    name: 'panel_remove',
    description: 'Remove one panel from a saved view, preserving experiment data.',
    parameters: schema({ view: string, id: string }, ['view', 'id']),
  },
  {
    name: 'runs_select',
    description:
      'Set visibility and/or multi-solo selections. Active solos override visibility without changing it. Runs created after a visibility change are visible until hidden.',
    parameters: schema({ view: string, visible: selectedRuns, solo: selectedRuns }, ['view']),
  },
  {
    name: 'plugins_list',
    description: 'List built-in and installed panel plugins and their enabled state.',
    parameters: schema(),
  },
];
export class Tools {
  private viewLocks=new KeyedLocks();
  private queuedWrites=0;
  constructor(
    readonly db: DB,
    readonly plugins: Plugins,
    readonly changed: (ids?: string[]) => void = () => {},
    readonly cleanupProject: (result:Args)=>Promise<number> = async()=>0,
    readonly applyMediaLimit: (dryRun: boolean) => Promise<Args> = async () => ({}),
    readonly mediaLimitChanged: () => void = () => {},
  ) {}
  async execute(name: string, a: Args) {
    const tool = toolCatalog.find((t) => t.name === name);
    if (!tool) throw Error('Unknown tool');
    if (name === 'runs_select') checkSelectionLimits(a);
    if (name === 'view_save' || name === 'view_create') checkSelectionLimits(a.body);
    await this.checkOptions(name, a);
    if(['panel_add','panel_update','panel_remove','runs_select','view_rename','view_delete','view_save'].includes(name)){
      if(this.queuedWrites>=128)throw Object.assign(Error('Workspace is busy. Try again shortly.'), { statusCode: 503 });
      this.queuedWrites++;
      try{return await this.viewLocks.run(a.view||a.id,()=>this.perform(name,a));}finally{this.queuedWrites--;}
    }
    return this.perform(name,a);
  }
  // Every writer (browser, CLI, agent) reaches views through these tools, so option values are
  // checked against the installed plugins' descriptors here and nowhere else.
  private async checkOptions(name: string, a: Args) {
    const panelWrite = name === 'panel_add' || name === 'panel_update';
    if (!panelWrite && name !== 'view_save' && name !== 'view_create') return;
    // Submitted layers by location: [kind, id, settings].
    const submitted: [string, string, Args | undefined][] = panelWrite
      ? [['panel', a.id, a.settings]]
      : a.body
        ? [
            ['workspace', '', a.body.plotSettings],
            ...Object.entries(a.body.sectionSettings || {}).map(
              ([id, settings]) => ['section', id, settings as Args] as [string, string, Args],
            ),
            ...a.body.panels.map((item: Args) => ['panel', item.id, item.settings]),
          ]
        : [];
    if (!submitted.some(([, , settings]) => settings?.options)) return;
    const previous =
      name === 'view_save' || name === 'panel_update'
        ? (await this.db.call('view', name === 'view_save' ? a.id : a.view))?.body
        : undefined;
    const stored = (kind: string, id: string) =>
      kind === 'workspace'
        ? previous?.plotSettings
        : kind === 'section'
          ? previous?.sectionSettings?.[id]
          : previous?.panels.find((item: Args) => item.id === id)?.settings;
    const failure = invalidOption(
      submitted.map(([kind, id, settings]) => ({ settings, stored: stored(kind, id) })),
      await this.plugins.list(),
    );
    if (failure)
      throw managementError(
        'PLUGIN_OPTION_INVALID',
        `${failure.plugin}: “${failure.key}” has an invalid value.`,
        failure,
      );
  }
  private async perform(name:string,a:Args){
    let result: any, removedRuns: string[] | undefined;
    switch (name) {
      case 'workspace_snapshot':
        return {
          projects: await this.db.call('projects'),
          views: await this.db.call('views'),
          plugins: await this.plugins.list(),
        };
      case 'settings_get':
        return { mediaLimit: await mediaLimit(this.db) };
      case 'settings_update': {
        const limit = {
          enabled: a.mediaLimit.enabled,
          megabytes: a.mediaLimit.megabytes ?? (await mediaLimit(this.db)).megabytes,
        };
        await this.db.call('settingSet', mediaCapSetting, limit);
        this.mediaLimitChanged();
        result = { mediaLimit: limit };
        break;
      }
      case 'project_media_limit_get':
        await this.db.call('projectGet', a.id);
        return projectMediaLimit(this.db, a.id);
      case 'project_media_limit_update': {
        await this.db.call('projectGet', a.id);
        const { effective: _, ...current } = await projectMediaLimit(this.db, a.id),
          { id, ...changes } = a;
        await this.db.call('settingSet', projectLimitSetting(id), { ...current, ...changes });
        this.mediaLimitChanged();
        result = await projectMediaLimit(this.db, id);
        break;
      }
      case 'media_limit_apply':
        if (a.dryRun !== false) return this.applyMediaLimit(true);
        result = await this.applyMediaLimit(false);
        break;
      case 'runs_list':
        return (await this.db.call('runs')).filter(
          (r: any) => !a.project || r.entity + '/' + r.project === a.project,
        );
      case 'run_get':{const run=await this.db.call('run',a.id);if(!run)throw managementError('RUN_NOT_FOUND', 'Run not found');return {run,alerts:await this.db.call('alerts',a.id)};}
      case 'metrics_list':
        return {metrics:await this.db.call('keys',a.runs),kinds:await this.db.call('metricTypes',a.runs),definitions:await this.db.call('metricSettings',a.runs)};
      case 'plugins_list':
        return this.plugins.list();
      case 'runs_update':
        result = await this.db.call('runManage', a);
        break;
      case 'project_get': return this.db.call('projectGet',a.id);
      case 'project_lineage':
        await this.db.call('projectGet', a.id);
        return this.db.call('lineage', a.id, await lineageSettings(this.db, a.id));
      case 'project_lineage_settings_get':
        await this.db.call('projectGet', a.id);
        return lineageSettings(this.db, a.id);
      case 'project_lineage_settings_update': {
        await this.db.call('projectGet', a.id);
        const { id, ...changes } = a;
        await this.db.call('settingSet', lineageSetting(id), {
          ...(await lineageSettings(this.db, id)),
          ...changes,
        });
        result = await lineageSettings(this.db, id);
        break;
      }
      case 'run_metadata_update': {
        const { by: _, ...changes } = a;
        result = await this.db.call('runMetadataUpdate', changes);
        break;
      }
      case 'run_metrics_rename':
        result = await this.db.call('metricsRename', a);
        break;
      case 'run_metrics_rename_undo':
        result = await this.db.call('metricsRenameUndo', a);
        break;
      case 'run_history_write':
        result = await this.db.call('historyWrite', a);
        break;
      case 'runs_config_diff': {
        const run = await this.db.call('run', a.to);
        if (!run) throw managementError('RUN_NOT_FOUND', 'Run not found');
        const { ignoreKeys, parentKeys, identityKeys } = await lineageSettings(
          this.db,
          run.entity + '/' + run.project,
        );
        return this.db.call('configDiff', a.from, a.to, [
          ...ignoreKeys,
          ...parentKeys,
          ...identityKeys,
        ]);
      }
      case 'project_create': result = await this.db.call('projectCreate',a); break;
      case 'project_update': result = await this.db.call('projectUpdate',a); break;
      case 'project_delete': {
        const removed = await this.db.call('projectDelete',a);
        await this.db.call('settingDelete', projectLimitSetting(a.id));
        const cleanupFailed=await this.cleanupProject(removed);
        const {runIds,artifactIds,...summary}=removed;
        result={...summary,cleanupFailed};
        removedRuns=runIds;
        break;
      }
      case 'view_save':
        result = await this.db.call('viewSave', a);
        break;
      case 'view_delete':
        result = await this.db.call('viewDelete', a.id);
        break;
      case 'view_get':
        return this.db.call('view', a.id);
      case 'view_create':
        result = await this.db.call('viewSave', {
          id: randomUUID(),
          name: a.name,
          project: a.project || '',
          body: a.body || {
            panels: [],
            visible: [],
            solo: [],
            ...(a.run ? { run: a.run } : {}),
          },
        });
        break;
      default: {
        const view = await this.db.call('view', a.view || a.id);
        if (!view) throw managementError('VIEW_NOT_FOUND', 'View not found');
        if (name === 'view_rename') view.name = a.name;
        else if (name === 'runs_select') {
          if (a.visible) {
            view.body.visible = a.visible;
            // An explicit choice covers every run that exists now.
            delete view.body.visibleThrough;
          }
          if (a.solo) view.body.solo = a.solo;
        } else if (name === 'panel_remove')
          view.body.panels = view.body.panels.filter((p: any) => p.id !== a.id);
        else if (name === 'panel_add' || name === 'panel_update') {
          const p =
            name === 'panel_add'
              ? {
                  id: randomUUID(),
                  plugin: a.plugin,
                  metric: '',
                  metrics: [],
                  settings: a.settings || {},
                }
              : view.body.panels.find((p: any) => p.id === a.id);
          if (!p) throw Error('Panel not found');
          if (
            !(await this.plugins.list()).some(
              (meta) => meta.id === (a.plugin || p.plugin) && meta.enabled,
            )
          )
            throw Error('Panel plugin is not enabled');
          for (const key of ['plugin', 'metric', 'metrics', 'title', 'settings', 'expressions'])
            if (a[key] != null) p[key] = a[key];
          if (a.expressions === null || (Array.isArray(p.expressions) && !p.expressions.length))
            delete p.expressions;
          const computed = new Set((p.expressions || []).map((item: any) => item.name));
          if (a.metric && !a.metrics) p.metrics = computed.has(a.metric) ? [] : [a.metric];
          p.metric ||= p.metrics[0] || p.expressions?.[0]?.name || '';
          if (!p.metric) throw Error('Choose a metric or add a computed metric.');
          p.title ||= p.metric;
          if (
            p.expressions &&
            !(await this.plugins.list()).some(
              (meta) => meta.id === p.plugin && meta.settings.common.includes('expressions'),
            )
          )
            throw Error('This panel type does not support computed metrics.');
          if (name === 'panel_add') view.body.panels.push(p);
          if (view.body.panels.length > 500) throw Error('At most 500 panels per view');
        } else throw Error('Unknown management tool');
        result = await this.db.call('viewSave', view);
      }
    }
    const summarizeSelection = (value: Args) => {
      const result = { ...value };
      for (const field of ['visible', 'solo']) {
        if (Array.isArray(result[field])) {
          result[field + 'Count'] = result[field].length;
          delete result[field];
        }
      }
      return result;
    };
    const auditArgs = name === 'project_delete'
      ? { id: a.id, counts: result.counts }
      : name === 'runs_select'
      ? summarizeSelection(a)
      : ['view_save', 'view_create'].includes(name) && a.body
        ? { ...a, body: summarizeSelection(a.body) }
        : a;
    await this.db.call('audit', { tool: name, arguments: auditArgs });
    this.changed(
      name === 'runs_update'
        ? result.ids
        : [
              'run_metadata_update',
              'run_metrics_rename',
              'run_metrics_rename_undo',
              'run_history_write',
            ].includes(name)
          ? [result.id]
          : removedRuns,
    );
    return result;
  }
}
