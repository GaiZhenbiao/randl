import { derived, writable } from 'svelte/store';
import type { ChartCursor } from './types';
export type RunFocus = { source: string; ids: string[] };
export const runFocus = writable<RunFocus | null>(null);
export const hoveredRuns = derived(runFocus, (focus) => focus?.ids || []);
export type PlotCursor = ChartCursor & { source: string };
export const plotCursor = writable<PlotCursor | null>(null);

let hoverOwner = '';
let hoverIds: string[] = [];
export function setHoveredRuns(owner: string, ids: string[]) {
  if (
    owner === hoverOwner &&
    ids.length === hoverIds.length &&
    ids.every((id, i) => id === hoverIds[i])
  )
    return;
  if (ids.length) {
    hoverIds = ids.slice();
    hoverOwner = owner;
    runFocus.set({ source: owner, ids });
  } else if (hoverOwner === owner) {
    hoverOwner = '';
    hoverIds = [];
    runFocus.set(null);
  }
}
