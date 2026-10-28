import {managementError} from './management-errors.js';
import selectionLimits from './selection-limits.json' with { type: 'json' };
import { checkSelectionLimits } from './selection-limits.js';
import panelLimits from './panel-limits.json' with {type:'json'};
import {KeyedLocks} from './locks.js';
import { invalidOption, optionKeyPattern, optionLimits, pluginIdPattern } from './plugin-options.js';
import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Plugins } from './plugins.js';
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
      case 'project_create': result = await this.db.call('projectCreate',a); break;
      case 'project_update': result = await this.db.call('projectUpdate',a); break;
      case 'project_delete': {
        const removed = await this.db.call('projectDelete',a);
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
    this.changed(name === 'runs_update' ? result.ids : removedRuns);
    return result;
  }
}
