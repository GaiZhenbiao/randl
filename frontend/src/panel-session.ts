import { writable } from 'svelte/store';

// Choices that belong to this browser tab and are never saved: the media step a section's
// media panels show together (W&B's synchronized step slider), each panel's own run for
// "Steps of one run" and its Coverflow item. They survive navigation within the tab and are
// lost on reload.
const limit = 500;
function bounded<T>() {
  const store = writable(new Map<string, T>());
  return {
    subscribe: store.subscribe,
    /** Sets `key`, or removes it when `value` is undefined; the least recently set go first. */
    set(key: string, value: T | undefined) {
      store.update((current) => {
        const next = new Map(current);
        next.delete(key);
        if (value !== undefined) next.set(key, value);
        while (next.size > limit) next.delete(next.keys().next().value!);
        return next;
      });
    },
  };
}
/** Media steps by section key; absent means the latest step, following new data. */
export const mediaSteps = bounded<number>();
/** The run shown by "Steps of one run", by panel key. */
export const mediaRuns = bounded<string>();
/** Coverflow's current item (a run, group or media file key), by panel key. */
export const coverflowItems = bounded<string>();
