// Run colours for RunName.svelte, set by App from the project's resolved run colours (those of
// the Runs tab and charts, theme applied), so a run's swatch is the same on every page.
import { writable } from 'svelte/store';
import { color } from './run-colors';

export const runColors = writable<Record<string, string>>({});
/** A run's swatch colour: the project's colour for it, else W&B's hash colour of its ID. */
export function swatch(id: string, colors: Record<string, string>) {
  return colors[id] ?? color(id);
}
