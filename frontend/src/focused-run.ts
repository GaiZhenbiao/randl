import type { ChartData, Plugin, Run } from './types';
import type { RunFocus } from './hover';

// Alignment declares per-run components in the shared plugin contract.
export function supportsFocusedRun(plugin: Plugin | undefined, metricCount: number) {
  return !!plugin?.recordTransform && metricCount > 1;
}

export function focusedRun(
  runs: Pick<Run, 'id' | 'created'>[],
  focus: RunFocus | null,
  owner: string,
) {
  if (focus && focus.source !== owner)
    for (const id of focus.ids) {
      const run = runs.find((run) => run.id === id);
      if (run) return run;
    }
  return runs.reduce<Pick<Run, 'id' | 'created'> | undefined>(
    (latest, run) =>
      !latest ||
      run.created > latest.created ||
      (run.created === latest.created && run.id > latest.id)
        ? run
        : latest,
    undefined,
  );
}

// Only response candidates can be selected. Group membership is supplied by the
// server, so aggregate values still include every visible member.
export function focusedSeries(
  series: ChartData['series'],
  runs: Pick<Run, 'id' | 'created'>[],
  focus: RunFocus | null,
  owner: string,
) {
  const candidates = new Set(runs.map((run) => run.id));
  const byRun = new Map<string, ChartData['series'][number]>();
  for (const item of series)
    for (const id of item.runIds || [item.id]) if (candidates.has(id)) byRun.set(id, item);
  const run = focusedRun(
    runs.filter((run) => byRun.has(run.id)),
    focus,
    owner,
  );
  return run ? byRun.get(run.id) : undefined;
}
