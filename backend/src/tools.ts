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
/** Ledger record ids: caller-chosen and stable, so a repeated backfill is a no-op. */
const ledgerId = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^/]+$' };
const author = { type: 'string', maxLength: 200 };
const orNull = (value: Args) => ({ anyOf: [value, { type: 'null' }] });
/** Where a record came from: lines of a document, optionally quoted. */
const source = schema(
  {
    document: { type: 'string', minLength: 1, maxLength: 500 },
    lines: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2, maxItems: 2 },
    quote: { type: 'string', maxLength: 5000 },
  },
  ['document'],
);
const dryRun = { type: 'boolean' };
/** A plan's GPU request: how many GPUs on one host, and of what kind. */
const gpuRequest = schema(
  {
    gpus: { type: 'integer', minimum: 1, maximum: 64 },
    min_memory_gb: orNull({ type: 'number', minimum: 0 }),
    model: orNull({ type: 'string', maxLength: 200 }),
    hosts: orNull({ type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 64 }),
    same_host: { type: 'boolean', enum: [true] },
  },
  ['gpus'],
);
/** A planned run's fields, as plan_save and idea_promote take them. */
const planFields = {
  name: { type: 'string', minLength: 1, maxLength: 256 },
  parent: orNull({ type: 'string' }),
  parentUpdate: orNull({ type: 'number' }),
  hypothesis: { type: 'string', maxLength: 20000 },
  change: { type: 'string', maxLength: 2000 },
  config: orNull({ type: 'object' }),
  baseline: orNull({ type: 'string' }),
  rule: { type: 'string', maxLength: 5000 },
  host: { type: 'string', maxLength: 200 },
  slot: { type: 'string', maxLength: 200 },
  queue: orNull({ type: 'integer' }),
  after: orNull({ type: 'string', maxLength: 512 }),
  config_yaml: orNull({ type: 'string', maxLength: 1000000 }),
  resume_run: orNull({ type: 'string', maxLength: 512 }),
  gpus: orNull({
    type: 'array',
    items: { type: 'integer', minimum: 0, maximum: 1023 },
    maxItems: 64,
    uniqueItems: true,
  }),
  updates: orNull({ type: 'number', exclusiveMinimum: 0 }),
  /** How long it is expected to run, in hours; preferred over any inferred length. */
  estimated_hours: orNull({ type: 'number', exclusiveMinimum: 0, maximum: 100000 }),
  resources: orNull(gpuRequest),
};
/** The runs, plans and findings an idea waits on. */
const ideaLinks = {
  type: 'array',
  maxItems: 100,
  items: schema(
    { kind: { type: 'string', enum: ['run', 'plan', 'finding'] }, id: { type: 'string', minLength: 1, maxLength: 512 } },
    ['kind', 'id'],
  ),
};
const ideaPriority = { type: 'string', enum: ['high', 'medium', 'low'] };
/** Seconds since the epoch or an ISO date. */
const when = { anyOf: [{ type: 'number' }, { type: 'string', maxLength: 64 }] };
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
  xMin: orNull({ type: 'number' }),
  xMax: orNull({ type: 'number' }),
  yMin: orNull({ type: 'number' }),
  yMax: orNull({ type: 'number' }),
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
// Computed metrics: named expressions over metrics of the same history record (docs/reference/panel-api.md).
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
    description:
      "List all lightweight run metadata. Optional project id filters entity/project. state is running, finished, failed, crashed or killed (stopped on purpose; state_reason says why).",
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
      "Read a project's lineage settings: the metric shown on each node, its display scale and goal (max or min), the config keys holding a run's parent checkpoint path (parentKeys) and its own folder or name (identityKeys), the config keys left out of diffs (ignoreKeys, * matches any characters), and for the Plans page the summary key of a run's progress (progressKey, such as update) with the config keys of the progress it stops at (budgetKey) and starts from (startKey).",
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
        window: { type: 'integer', minimum: 1, maximum: 100 },
        progressKey: { type: 'string', maxLength: 512 },
        budgetKey: { type: 'string', maxLength: 512 },
        startKey: { type: 'string', maxLength: 512 },
      },
      ['id'],
    ),
  },
  {
    name: 'run_state_set',
    description:
      "Mark a run that has ended as stopped on purpose (state stopped: ended deliberately before its plan, as opposed to finished at its budget, failed or crashed), or set it back to finished, failed or crashed. reason says why it was stopped and shows on the run page and in Lineage. A running run is refused (code RUN_STATE_RUNNING): mark it once it ends. A stopped run stays stopped when its SDK or a re-sync later reports it finished. by names the caller in the audit log; the same request again changes nothing; dryRun reports what would change. Run lists report a stopped run's state as killed.",
    parameters: schema(
      {
        id: string,
        state: { type: 'string', enum: ['stopped', 'finished', 'failed', 'crashed'] },
        reason: { type: 'string', maxLength: 2000 },
        by: author,
        dryRun,
      },
      ['id', 'state'],
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
      "Write numeric values into a stored run's history, such as audit results computed after training (the SDK cannot log at earlier steps). Not available to the Assistant. Each row is {step, values} (the record with that _step, or a new record) or {match, values}, where match names logged fields such as {\"update\": 473000}. A matching record is merged into; several matches are refused (listing their steps) unless pick is first or last, which takes the matching record with the smallest or largest _step, as when a resumed run logged an update twice; with none, a record holding the match fields is added at the row's step if given, else at the step the neighbouring records imply (refused when that is not a whole, unused step). values maps metric names to numbers and merges into the record; a different stored value is refused unless replace is true, and identical values change nothing. Every row gets a status (merged, added, unchanged, or refused with no-match, ambiguous, step-taken or conflict; added rows report the step and whether it was inferred). dryRun: true writes nothing; otherwise one refused row refuses the whole request. by names the caller in the audit log.",
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
              pick: { type: 'string', enum: ['first', 'last'] },
              match: {
                type: 'object',
                minProperties: 1,
                maxProperties: 20,
                propertyNames: { maxLength: 512 },
                additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
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
            anyOf: [{ required: ['step'] }, { required: ['match'] }],
          },
        },
        replace: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        by: { type: 'string', maxLength: 200 },
      },
      ['id', 'rows'],
    ),
  },
  // The experiment ledger (ledger.ts, docs/guides/ledger.md). Records have caller-chosen
  // ids; saving identical content reports unchanged. The Assistant does not see the ledger.
  {
    name: 'findings_list',
    description: "List a project's findings by topic (status finding or ruled_out), or only those citing run.",
    agent: false,
    parameters: schema({ project: string, run: string }, ['project']),
  },
  {
    name: 'finding_get',
    description: 'Read one finding with all of its earlier versions.',
    agent: false,
    parameters: schema({ project: string, id: ledgerId }, ['project', 'id']),
  },
  {
    name: 'finding_save',
    description:
      'Create or update a finding by its id: topic, title, body (Markdown), status (finding or ruled_out) and citations (runs, optionally at an update or step, with a note). Omitted fields keep their value. Every change is kept as a version; version, when given, must be the current one. by names the author.',
    agent: false,
    parameters: schema(
      {
        project: string,
        id: ledgerId,
        topic: { type: 'string', maxLength: 200 },
        title: { type: 'string', maxLength: 500 },
        body: { type: 'string', maxLength: 200000 },
        status: { type: 'string', enum: ['finding', 'ruled_out'] },
        citations: {
          type: 'array',
          maxItems: 500,
          items: schema(
            {
              run: string,
              update: { type: 'number' },
              step: { type: 'number' },
              note: { type: 'string', maxLength: 2000 },
            },
            ['run'],
          ),
        },
        version: { type: 'integer', minimum: 0 },
        source,
        dryRun,
        by: author,
      },
      ['project', 'id'],
    ),
  },
  {
    name: 'finding_delete',
    description: 'Delete a finding; its versions are kept.',
    agent: false,
    parameters: schema({ project: string, id: ledgerId, by: author }, ['project', 'id']),
  },
  {
    name: 'recipe_get',
    description: "Read a project's current best recipe (a run, since when, why) and its history.",
    agent: false,
    parameters: schema({ project: string }, ['project']),
  },
  {
    name: 'recipe_set',
    description:
      "Promote a run to the project's current best recipe, with the reason and since (seconds or an ISO date; now by default). The history keeps every promotion; repeating the current one changes nothing.",
    agent: false,
    parameters: schema(
      {
        project: string,
        run: string,
        reason: { type: 'string', minLength: 1, maxLength: 5000 },
        since: when,
        source,
        dryRun,
        by: author,
      },
      ['project', 'run', 'reason'],
    ),
  },
  {
    name: 'plans_list',
    description:
      "List a project's planned runs (name, parent and update, hypothesis, change, config, baseline, stop or decision rule, host, slot, queue position, status, and the run that carried it out, if any) and its running runs with the host and slot their lineage.compute names.",
    agent: false,
    parameters: schema({ project: string }, ['project']),
  },
  {
    name: 'project_occupancy',
    description:
      "GPU occupancy over time for the Plans page: each host's GPU rows (indices 0 to the highest a run or plan named, then rows for runs whose GPU indices were not logged) and bars for finished segments of runs' lineage.compute, running runs up to now and on to their estimated end (progress, budget and rate from the lineage settings' progressKey, budgetKey and startKey), and open plans at their estimated start and end on their gpus (else the GPUs their slot last used). unplaced lists running runs that log no compute block.",
    agent: false,
    parameters: schema({ project: string }, ['project']),
  },
  {
    name: 'plan_save',
    description:
      'Create or update a planned run by its id. It turns into its run once a run logs lineage.plan equal to this id (or has this name, unless the plan has a resume_run: those bind only through lineage.plan). Callers set status planned or cancelled (planned also releases a claim waiting for its run); the server sets started, done and stopped from the claim and the run. config_yaml is the exact config file text, returned verbatim by plan_claim; resume_run names a run the plan continues in its own directory. gpus names the GPU indices it will use on its host (else those its slot last used); estimated_hours is how long it is expected to run, in hours, which the projection and the GPU timeline use before anything they infer; otherwise updates (how far it will train, else its config budget less its start) at the recent pace on its host. Omitted fields keep their value; status cancelled keeps it for the record.',
    agent: false,
    parameters: schema(
      {
        project: string,
        id: ledgerId,
        ...planFields,
        status: { type: 'string', enum: ['planned', 'cancelled'] },
        source,
        dryRun,
        by: author,
      },
      ['project', 'id'],
    ),
  },
  {
    name: 'plan_queue',
    description:
      "The project's waiting plans in the order host agents take them, one queue for every host: queue position, then the after chain, then creation. Each plan carries its position and resources (its GPU request). Returns {project, plans}.",
    agent: false,
    parameters: schema({ project: string }, ['project']),
  },
  {
    name: 'plan_claim',
    description:
      "A host agent's request for work: given the host and the GPU ids (PCI order) it sees free, randl picks the first waiting plan in queue order whose GPU request fits those GPUs (count, minimum memory, model, hosts from gpus_save's inventory; reserved GPUs never), allocates specific GPUs and marks the plan started. A later plan may take GPUs the head cannot use yet, unless the head has waited over six hours and this host could run it (status 'held'). Returns {status: 'claimed', plan: {id, name, config_yaml, config, resume_run, updates, estimated_hours, parent, parentUpdate, resources, host, gpu_ids}, gpu_ids, host, allocation: {host, gpus, at, by}, claim}, {status: 'empty', plan: null, waiting, free_gpus} or {status: 'held', plan: null, head, free_gpus}. Launch with those GPUs and log lineage.plan = plan.id; the GPUs are released when the run ends, when the claim lapses after 30 minutes without the run logging, or when plan_save sets the plan back to planned. The same agent asking again while its claim waits for its run, with those GPUs still free, gets the same claim (repeat: true).",
    agent: false,
    parameters: schema(
      {
        project: string,
        host: { type: 'string', minLength: 1, maxLength: 200 },
        free_gpus: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 1023 },
          maxItems: 64,
          uniqueItems: true,
        },
        by: author,
        dryRun,
      },
      ['project', 'host', 'free_gpus', 'by'],
    ),
  },
  {
    name: 'plan_move',
    description:
      'Move a waiting plan in the queue: before or after another waiting plan, else to its end; the queue is renumbered 1, 2, …',
    agent: false,
    parameters: schema(
      { project: string, id: ledgerId, before: ledgerId, after: ledgerId, by: author, dryRun },
      ['project', 'id'],
    ),
  },
  {
    name: 'gpus_list',
    description:
      "The project's GPU inventory by host: each GPU's id (PCI order), model, memory_gb, allowed (false: kept out of allocation) and note, with its holder now (the plan claimed for it, and its run once running).",
    agent: false,
    parameters: schema({ project: string }, ['project']),
  },
  {
    name: 'gpus_save',
    description:
      "Add or update GPUs of one host in the project's inventory: gpus lists their ids (PCI order) and the rest applies to each. allowed false keeps them out of allocation (listed, but never given to a plan). With replace, the host's other GPUs are removed. Omitted fields keep their value.",
    agent: false,
    parameters: schema(
      {
        project: string,
        host: { type: 'string', minLength: 1, maxLength: 200 },
        gpus: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 1023 },
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
        },
        model: { type: 'string', maxLength: 200 },
        memory_gb: orNull({ type: 'number', minimum: 0 }),
        allowed: { type: 'boolean' },
        note: { type: 'string', maxLength: 500 },
        replace: { type: 'boolean' },
        by: author,
        dryRun,
      },
      ['project', 'host', 'gpus'],
    ),
  },
  {
    name: 'gpus_delete',
    description: "Remove GPUs of a host from the inventory (all of the host's when gpus is omitted).",
    agent: false,
    parameters: schema(
      {
        project: string,
        host: { type: 'string', minLength: 1, maxLength: 200 },
        gpus: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1023 }, maxItems: 64 },
        by: author,
      },
      ['project', 'host'],
    ),
  },
  {
    name: 'idea_list',
    description:
      "A project's ideas, the backlog of experiments not yet planned: open first, then by priority (high, medium, low), then latest changed. Each has title, hypothesis, evidence (why it is worth running), prerequisites (in words), waits_on (runs, plans and findings it waits on), priority, status (open, promoted, dropped), plan (the plan made from it) and draft (plan fields kept for its plan). status narrows the list.",
    agent: false,
    parameters: schema(
      { project: string, status: { type: 'string', enum: ['open', 'promoted', 'dropped'] } },
      ['project'],
    ),
  },
  {
    name: 'idea_save',
    description:
      'Create or update an idea by its id. Callers set status open or dropped; idea_promote makes it promoted. draft holds plan fields to use when it is promoted. Omitted fields keep their value.',
    agent: false,
    parameters: schema(
      {
        project: string,
        id: ledgerId,
        title: { type: 'string', minLength: 1, maxLength: 500 },
        hypothesis: { type: 'string', maxLength: 20000 },
        evidence: { type: 'string', maxLength: 20000 },
        prerequisites: { type: 'string', maxLength: 5000 },
        waits_on: ideaLinks,
        priority: ideaPriority,
        status: { type: 'string', enum: ['open', 'dropped'] },
        draft: orNull({ type: 'object' }),
        source,
        dryRun,
        by: author,
      },
      ['project', 'id'],
    ),
  },
  {
    name: 'idea_delete',
    description: 'Delete an idea.',
    agent: false,
    parameters: schema({ project: string, id: ledgerId, by: author }, ['project', 'id']),
  },
  {
    name: 'idea_promote',
    description:
      "Make a planned run from an idea: its draft's plan fields, then its hypothesis and source, then the plan fields given here (host, slot or pool, queue, name, change, rule, config_yaml, …). plan is the new plan's id (default: the plan the idea was made from, else the idea's id). The plan links to the idea (plan.idea) and the idea becomes promoted with plan set. Promoting again to the same plan changes nothing; IDEA_PLAN_EXISTS when that plan id is taken.",
    agent: false,
    parameters: schema(
      { project: string, id: ledgerId, plan: ledgerId, ...planFields, dryRun, by: author },
      ['project', 'id'],
    ),
  },
  {
    name: 'idea_from_plan',
    description:
      "Turn a waiting or cancelled plan into an idea and remove the plan, in one step. The idea (id, default the plan's id) takes the plan's name as title (or title), its hypothesis and source, what it was queued after as waits_on, and keeps the plan's fields as draft, so idea_promote restores them. A cancelled plan becomes a dropped idea. Plans queued after it are queued after what it was queued after. Repeating it after the plan is gone changes nothing.",
    agent: false,
    parameters: schema(
      {
        project: string,
        plan: ledgerId,
        id: ledgerId,
        title: { type: 'string', minLength: 1, maxLength: 500 },
        evidence: { type: 'string', maxLength: 20000 },
        prerequisites: { type: 'string', maxLength: 5000 },
        waits_on: ideaLinks,
        priority: ideaPriority,
        dryRun,
        by: author,
      },
      ['project', 'plan'],
    ),
  },
  {
    name: 'plan_delete',
    description: 'Delete a planned run.',
    agent: false,
    parameters: schema({ project: string, id: ledgerId, by: author }, ['project', 'id']),
  },
  {
    name: 'evidence_save',
    description:
      "Import an evaluation, diagnostic or calibration as a finished run of its own, dated created (seconds or ISO), with the runs it examines (full run ids), summary numbers, config, notes, source, and its files: those marked upload are sent afterwards with PUT /upload/<entity>/<project>/<id>/<name>; the rest are kept as references to a host and path. The id is the run's id within the project; the same request again changes nothing. dryRun only reports created, updated or unchanged.",
    agent: false,
    parameters: schema(
      {
        project: string,
        id: ledgerId,
        name: { type: 'string', maxLength: 256 },
        job_type: { type: 'string', enum: ['evaluation', 'diagnostic', 'calibration'] },
        created: when,
        examines: { ...strings, maxItems: 500 },
        summary: { type: 'object', maxProperties: 1000 },
        config: { type: 'object', propertyNames: { pattern: '^[^_]' }, maxProperties: 500 },
        notes: { type: 'string', maxLength: 100000 },
        source,
        files: {
          type: 'array',
          maxItems: 10000,
          items: schema(
            {
              name: { type: 'string', minLength: 1, maxLength: 1024 },
              path: { type: 'string', maxLength: 4096 },
              host: { type: 'string', maxLength: 200 },
              bytes: { type: 'integer', minimum: 0 },
              upload: { type: 'boolean' },
            },
            ['name'],
          ),
        },
        dryRun,
        by: author,
      },
      ['project', 'id', 'job_type', 'created'],
    ),
  },
  {
    name: 'journal_list',
    description: "List a run's journal entries, or every entry in a project, oldest first.",
    agent: false,
    parameters: schema({ run: string, project: string }),
  },
  {
    name: 'journal_add',
    description:
      "Append a dated entry to a run's journal, optionally tied to an update or step; separate from the run's notes. Entries are never changed: key (or, without one, the run, update, step and text) makes repeating an addition a no-op.",
    agent: false,
    parameters: schema(
      {
        run: string,
        text: { type: 'string', minLength: 1, maxLength: 20000 },
        time: when,
        update: { type: 'number' },
        step: { type: 'number' },
        key: ledgerId,
        source,
        dryRun,
        by: author,
      },
      ['run', 'text'],
    ),
  },
  {
    name: 'runs_compare',
    description:
      "Compare runs with a baseline run on one metric at matched points: where both logged the same value of x (a logged field such as update, the default, or _step). Returns each run's matched count, mean and last difference, and up to 200 matched points.",
    parameters: schema(
      {
        baseline: string,
        runs: { ...strings, minItems: 1, maxItems: 100 },
        metric: string,
        x: string,
      },
      ['baseline', 'runs', 'metric'],
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
      case 'run_state_set':
        result = await this.db.call('runStateSet', a);
        // A dry run or a repeat changes nothing, so it is not audited.
        if (a.dryRun || result.status === 'unchanged') return result;
        break;
      case 'run_metadata_update': {
        const { by: _, ...changes } = a;
        result = await this.db.call('runMetadataUpdate', changes);
        break;
      }
      case 'run_metrics_rename':
        result = await this.db.call('metricsRename', a);
        if (a.dryRun) return result;
        break;
      case 'run_metrics_rename_undo':
        result = await this.db.call('metricsRenameUndo', a);
        break;
      case 'run_history_write':
        result = await this.db.call('historyWrite', a);
        if (a.dryRun) return result;
        break;
      case 'findings_list':
        await this.db.call('projectGet', a.project);
        return { findings: await this.db.call('findings', a) };
      case 'finding_get':
        return this.db.call('findingGet', a);
      case 'recipe_get':
        await this.db.call('projectGet', a.project);
        return this.db.call('recipe', a);
      case 'plans_list':
        await this.db.call('projectGet', a.project);
        return this.db.call('plans', a);
      case 'plan_queue':
        await this.db.call('projectGet', a.project);
        return this.db.call('planQueue', a);
      case 'gpus_list':
      case 'idea_list':
        await this.db.call('projectGet', a.project);
        return this.db.call(name === 'gpus_list' ? 'gpusList' : 'ideaList', a);
      case 'gpus_save':
      case 'gpus_delete':
      case 'idea_save':
      case 'idea_delete':
      case 'idea_promote':
      case 'idea_from_plan':
        await this.db.call('projectGet', a.project);
        result = await this.db.call(
          {
            gpus_save: 'gpusSave',
            gpus_delete: 'gpusDelete',
            idea_save: 'ideaSave',
            idea_delete: 'ideaDelete',
            idea_promote: 'ideaPromote',
            idea_from_plan: 'ideaFromPlan',
          }[name]!,
          a,
        );
        // A dry run or a repeat changes nothing, so it is not audited.
        if (a.dryRun || result.status === 'unchanged') return result;
        break;
      case 'plan_claim':
      case 'plan_move':
        await this.db.call('projectGet', a.project);
        result = await this.db.call(name === 'plan_claim' ? 'planClaim' : 'planMove', a);
        // A dry run, an empty queue, a hold or a repeated claim changes nothing.
        if (a.dryRun || ['empty', 'held'].includes(result.status) || result.repeat) return result;
        break;
      case 'project_occupancy':
        await this.db.call('projectGet', a.project);
        return this.db.call('occupancy', a.project, await lineageSettings(this.db, a.project));
      case 'journal_list':
        if (!a.run && !a.project)
          throw managementError('RUN_NOT_FOUND', 'Name a run or a project.', {}, 400);
        return { entries: await this.db.call('journal', a) };
      case 'finding_save':
      case 'finding_delete':
      case 'recipe_set':
      case 'plan_save':
      case 'plan_delete':
      case 'evidence_save':
        await this.db.call('projectGet', a.project);
        result = await this.db.call(
          {
            finding_save: 'findingSave',
            finding_delete: 'findingDelete',
            recipe_set: 'recipeSet',
            plan_save: 'planSave',
            plan_delete: 'planDelete',
            evidence_save: 'evidenceSave',
          }[name]!,
          a,
        );
        // A dry run changes nothing, so it is not audited.
        if (a.dryRun) return result;
        break;
      case 'journal_add':
        result = { ...(await this.db.call('journalAdd', a)), id: a.run };
        if (a.dryRun) return result;
        break;
      case 'runs_compare':
        return this.db.call('runsCompare', { x: 'update', ...a });
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
              'journal_add',
              'evidence_save',
            ].includes(name)
          ? [result.id]
          : removedRuns,
    );
    return result;
  }
}
