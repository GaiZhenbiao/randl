export type MetricDefinition = {
  name: string;
  glob: boolean;
  stepMetric?: string;
  hidden: boolean;
  summary: string[];
  goal?: 'minimize' | 'maximize';
};
// W&B SDK 0.30 encodes MetricRecord with numeric protobuf field keys;
// nested boolean messages become arrays of enabled field numbers.
export function metricDefinitions(config: Record<string, any>): MetricDefinition[] {
  const internal = config._wandb?.value ?? config._wandb;
  const records = internal?.m;
  if (!Array.isArray(records)) return [];
  const summaries = ['min', 'max', 'mean', 'best', 'last', 'none', 'copy', 'first'];
  return records
    .filter(record => record && typeof (record['1'] || record['2']) === 'string')
    .map(record => ({
      name: record['1'] || record['2'],
      glob: !record['1'],
      ...(record['4'] || records[Number(record['5']) - 1]?.['1']
        ? { stepMetric: record['4'] || records[Number(record['5']) - 1]['1'] } : {}),
      hidden: Array.isArray(record['6']) && record['6'].includes(2),
      summary: Array.isArray(record['7']) ? record['7'].map((value: number) => summaries[value - 1]).filter(Boolean).sort() : [],
      ...(record['8'] === 1 ? { goal: 'minimize' as const } : record['8'] === 2 ? { goal: 'maximize' as const } : {}),
    }))
    .sort((a,b) => a.name.localeCompare(b.name));
}
export function definitionFor(definitions: MetricDefinition[], name: string) {
  return definitions.find(item => !item.glob && item.name === name) || definitions.find(item => item.glob && new RegExp('^' + item.name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name));
}
export function environmentMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, any>;
  const started = Date.parse(data.startedAt);
  return {
    metadata: JSON.stringify(data),
    host: typeof data.host === 'string' ? data.host : '',
    program: typeof data.program === 'string' ? data.program : typeof data.codePath === 'string' ? data.codePath : '',
    git_remote: typeof data.git?.remote === 'string' ? data.git.remote : '',
    git_commit: typeof data.git?.commit === 'string' ? data.git.commit : '',
    started: Number.isFinite(started) ? started / 1000 : undefined,
  };
}
