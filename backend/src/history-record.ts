/** Numeric ingestion rules for history and system events. */
export function historyStep(row: Record<string, unknown>, offset: number, system: boolean): number {
  const step = system ? (row._timestamp ?? offset) : (row._step ?? offset);
  if (typeof step !== 'number' || !Number.isFinite(step)) throw Error('Invalid history step');
  return step;
}
export function* numericFields(
  row: Record<string, unknown>,
  system: boolean,
): Iterable<{ metric: string; value: number; catalog: boolean }> {
  for (const [key, value] of Object.entries(row))
    if (typeof value === 'number' && Number.isFinite(value))
      yield {
        metric: system ? 'system/' + key.replace(/^system\./, '') : key,
        value,
        catalog: !system || !key.startsWith('_'),
      };
}
