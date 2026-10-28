import { matchScore } from './search';
import catalog from '../../backend/src/run-fields.json';
import type { MessageKey, Translator } from './i18n';
const runFields = catalog as Record<string, { label: MessageKey; type: string }>;
export const fieldType = (field: string) => runFields[field]?.type;
const pluginNames: Record<string, MessageKey> = {
  line: 'charts.types.line',
  area: 'charts.types.area',
  'stacked-area': 'charts.types.stackedArea',
  'percent-area': 'charts.types.percentArea',
  bar: 'charts.types.bar',
  scatter: 'charts.types.scatter',
  'scatter-history': 'charts.types.scatterHistory',
  parallel: 'charts.types.parallel',
  image: 'charts.types.image',
  audio: 'charts.types.audio',
  video: 'charts.types.video',
  table: 'charts.types.table',
  histogram: 'charts.types.histogram',
};
/** A panel plugin's name: built-in names in the interface language, others as installed. */
export function pluginName(plugin: { id: string; name: string; builtin?: boolean }, t: Translator) {
  return plugin.builtin && Object.hasOwn(pluginNames, plugin.id)
    ? t(pluginNames[plugin.id])
    : plugin.name;
}
export function fieldLabel(field: string, t: Translator) {
  if (field === 'running') return t('runs.fields.running');
  if (Object.hasOwn(runFields, field)) return t(runFields[field].label);
  if (field.startsWith('config.')) return t('runs.fields.config', { field: field.slice(7) });
  if (field.startsWith('summary.')) return t('runs.fields.summary', { field: field.slice(8) });
  return field;
}
export function resultCount(
  count: number,
  t: Translator,
  empty: MessageKey = 'common.combobox.noResults',
) {
  return t(count ? 'common.combobox.results' : empty, { count });
}
export function filterChoice(item: { text?: string; id?: string }, value: string) {
  return [item.text, item.id].some((text) => matchScore(value, text ?? '', false) >= 0);
}
export function statusLabel(value: string, t: Translator) {
  const names: Record<string, MessageKey> = {
    running: 'runs.state.running',
    finished: 'runs.state.finished',
    failed: 'runs.state.failed',
    crashed: 'runs.state.crashed',
    killed: 'runs.state.killed',
    PENDING: 'artifacts.state.pending',
    COMMITTED: 'artifacts.state.committed',
  };
  return Object.hasOwn(names, value) ? t(names[value]) : value;
}
/**
 * The part of a run search to match. A pasted run URL or `entity/project/name` path matches by its
 * run name; any other text matches run names, display names and full IDs.
 */
export function runSearchQuery(value: string) {
  let query = value.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) query = decodeURIComponent(new URL(query).pathname);
  } catch {
    // Not a URL; search the text as typed.
  }
  const parts = query.split('/').filter(Boolean);
  const runs = parts.indexOf('runs');
  if (runs >= 0 && parts[runs + 1]) return parts[runs + 1].toLowerCase();
  return (query.includes('/') ? parts.join('/') : query).toLowerCase();
}
export function runURL(run: { entity: string; project: string; name: string }, tab = 'metrics') {
  return (
    '/' +
    [run.entity, run.project, 'runs', run.name, ...(tab === 'metrics' ? [] : [tab])]
      .map(encodeURIComponent)
      .join('/')
  );
}
export function interceptLink(event: MouseEvent, action: () => void) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  action();
}

/** The run-list group field, or '' (no grouping) for stored sentinels and unknown values. */
export function runGroupField(value: string | undefined) {
  return value &&
    /^(?:state|running|group_name|job_type|tags|host|program|git_commit|username|os|python|gpu|(?:config|summary)\.(?!_).+)$/.test(
      value,
    )
    ? value
    : '';
}
/**
 * A group field's short label for group rows: the key itself for config and summary fields.
 * Running / not running groups read as states.
 */
export function groupFieldLabel(field: string, t: Translator) {
  return field === 'running'
    ? t('runs.fields.state')
    : field.startsWith('config.')
      ? field.slice(7)
      : field.startsWith('summary.')
        ? field.slice(8)
        : fieldLabel(field, t);
}
/** A group's value as its row and legend show it. */
export function groupValueLabel(field: string, value: unknown, t: Translator) {
  if (value == null) return t('runs.group.noValue');
  if (field === 'running') return t(value ? 'runs.group.running' : 'runs.group.notRunning');
  if (field === 'state') return statusLabel(String(value), t);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
/** A group's full name, such as "Config · seed: 15" or "State: Running". */
export function groupTitle(field: string, value: unknown, t: Translator) {
  return t('runs.group.fieldValue', {
    field: field === 'running' ? t('runs.fields.state') : fieldLabel(field, t),
    value: groupValueLabel(field, value, t),
  });
}
const stateOrder = ['running', 'finished', 'failed', 'crashed', 'killed'];
/**
 * Orders groups: running first for state groupings, otherwise as the runs first appear.
 * `entries` are [JSON group value, group] pairs.
 */
export function orderGroups<T>(field: string, entries: [string, T][]) {
  if (field !== 'state' && field !== 'running') return entries;
  const rank = (key: string) => {
    const value = JSON.parse(key);
    if (field === 'running') return value ? 0 : 1;
    const index = stateOrder.indexOf(value);
    return index < 0 ? stateOrder.length : index;
  };
  return [...entries].sort((a, b) => rank(a[0]) - rank(b[0]));
}
/** Group choices among run fields; Running / not running follows State. */
export function groupFields(fields: string[]) {
  return fields
    .flatMap((field) => (field === 'state' ? [field, 'running'] : [field]))
    .filter(
      (field) =>
        [
          'state',
          'running',
          'group_name',
          'job_type',
          'tags',
          'host',
          'program',
          'git_commit',
          'username',
          'os',
          'python',
          'gpu',
        ].includes(field) ||
        field.startsWith('config.') ||
        field.startsWith('summary.'),
    )
    .filter((field) => !field.startsWith('config._') && !field.startsWith('summary._'));
}

export function artifactURL(project: string, id: string, tab = 'files') {
  return (
    '/' +
    project.split('/').map(encodeURIComponent).join('/') +
    '/artifacts?artifact=' +
    encodeURIComponent(id) +
    (tab === 'files' ? '' : '&tab=' + encodeURIComponent(tab))
  );
}
/** Formats a byte count with binary (IEC) units, e.g. 1.5 MiB. */
export function formatBytes(
  bytes: number,
  format: (value: number, options?: Intl.NumberFormatOptions) => string,
) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes),
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return format(value, { maximumFractionDigits: unit ? 1 : 0 }) + ' ' + units[unit];
}
