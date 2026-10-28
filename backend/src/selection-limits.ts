import limits from './selection-limits.json' with { type: 'json' };

type Field = 'visible' | 'solo';

export function selectionLimitError(field: Field, count: number) {
  const action = field === 'visible' ? 'show' : 'solo';
  const format = (value: number) => value.toLocaleString('en-US');
  return Object.assign(
    Error(
      `A view can ${action} up to ${format(limits.maxSelectedRuns)} runs; this request has ${format(count)}.`,
    ),
    { statusCode: 400, code: field === 'visible' ? 'VISIBLE_RUN_LIMIT' : 'SOLO_RUN_LIMIT' },
  );
}

export function duplicateRunError(field: Field, id: unknown) {
  return Object.assign(
    Error(`Each run ID can appear once in ${field}; ${String(id)} appears more than once.`),
    { statusCode: 400, code: 'DUPLICATE_RUN_IDS' },
  );
}

/** Finds the first selection problem in a visibility/solo pair, or returns undefined. */
export function selectionError(value: { visible?: unknown; solo?: unknown } | undefined) {
  for (const field of ['visible', 'solo'] as const) {
    const ids = value?.[field];
    if (!Array.isArray(ids)) continue;
    if (ids.length > limits.maxSelectedRuns) return selectionLimitError(field, ids.length);
    const seen = new Set<unknown>();
    for (const id of ids) {
      if (seen.has(id)) return duplicateRunError(field, id);
      seen.add(id);
    }
  }
}

export function checkSelectionLimits(value: { visible?: unknown; solo?: unknown } | undefined) {
  const error = selectionError(value);
  if (error) throw error;
}
