import { derived, writable } from 'svelte/store';
import type { ChartCursor } from './types';
export type RunFocus = { source: string; ids: string[] };
export const runFocus = writable<RunFocus | null>(null);
export const hoveredRuns = derived(runFocus, (focus) => focus?.ids || []);
export type PlotCursor = ChartCursor & { source: string };
export const plotCursor = writable<PlotCursor | null>(null);

let hoverOwner = '';
let hoverIds: string[] = [];
let clearFrame = 0;
/**
 * The runs `owner` hovers, or none. A clear waits for the next frame: moving from one run to
 * the next leaves the first before entering the second, and the brief empty hover between
 * them would otherwise reach every panel.
 */
export function setHoveredRuns(owner: string, ids: string[]) {
  if (ids.length) {
    cancelAnimationFrame(clearFrame);
    clearFrame = 0;
    if (
      owner === hoverOwner &&
      ids.length === hoverIds.length &&
      ids.every((id, i) => id === hoverIds[i])
    )
      return;
    hoverIds = ids.slice();
    hoverOwner = owner;
    runFocus.set({ source: owner, ids });
  } else if (hoverOwner === owner && !clearFrame)
    clearFrame = requestAnimationFrame(() => {
      clearFrame = 0;
      if (hoverOwner !== owner) return;
      hoverOwner = '';
      hoverIds = [];
      runFocus.set(null);
    });
}

/**
 * The hovered runs for panels that redraw for them (focus on hover). Hovering a run applies at
 * once when no other run was hovered in the last `focusSettle` ms; during a sweep across runs
 * the change waits until the pointer rests that long, so these panels redraw once at the end
 * instead of for every run crossed, and never hold up the cheap highlights elsewhere.
 */
const focusSettle = 150;
export const settledFocus = writable<RunFocus | null>(null);
let settleTimer: ReturnType<typeof setTimeout> | undefined,
  lastHover = -Infinity;
runFocus.subscribe((focus) => {
  const now = performance.now(),
    resting = now - lastHover > focusSettle;
  if (focus) lastHover = now;
  clearTimeout(settleTimer);
  if (resting) settledFocus.set(focus);
  else settleTimer = setTimeout(() => settledFocus.set(focus), focusSettle);
});
