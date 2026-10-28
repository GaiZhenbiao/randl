import catalog from './run-fields.json' with {type:'json'};
export const runFieldCatalog=catalog as Record<string,{label:string;type:'string'|'number'|'date'|'tags';column?:string;path?:string}>;
export const liveRuntimeSQL="CASE WHEN (state<>'running' OR snapshot_at IS NOT NULL) AND runtime_reported=0 AND runtime=0 THEN NULL ELSE runtime + CASE WHEN state='running' AND snapshot_at IS NULL THEN max(0,unixepoch('subsec')-coalesce(runtime_at,unixepoch('subsec'))) ELSE 0 END END";
const stateOrder = ['running', 'finished', 'failed', 'crashed', 'killed'];
/**
 * Groups runs by a chart `groupBy` field (`all` makes one group). Groups follow the runs'
 * order, except that state groupings put running first, as the run list does.
 */
export function groupRuns(ids: string[], field: string, value: (id: string) => unknown) {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const key = field === 'all' ? 'All runs' : JSON.stringify(value(id) ?? null),
      members = groups.get(key);
    if (members) members.push(id);
    else groups.set(key, [id]);
  }
  const entries = [...groups];
  if (field !== 'state' && field !== 'running') return entries;
  const rank = (key: string) => {
    const state = JSON.parse(key);
    if (field === 'running') return state ? 0 : 1;
    const index = stateOrder.indexOf(state);
    return index < 0 ? stateOrder.length : index;
  };
  return entries.sort((a, b) => rank(a[0]) - rank(b[0]));
}
/** A grouped series' identity: `running` groups have the value true or false. */
export function groupSeries(field: string, key: string) {
  const value = key === 'All runs' ? null : JSON.parse(key);
  return {
    id: 'group:' + key,
    name:
      key === 'All runs'
        ? key
        : field === 'running'
          ? value
            ? 'Running'
            : 'Not running'
          : String(value ?? 'None'),
    group: { field, value },
  };
}
