import { mount, unmount, type Component } from 'svelte';
import ChevronLeft from 'carbon-icons-svelte/lib/ChevronLeft.svelte';
import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
import Play from 'carbon-icons-svelte/lib/Play.svelte';
import VolumeMute from 'carbon-icons-svelte/lib/VolumeMute.svelte';

// Carbon icons inside DOM built outside Svelte components; each returns its disposer.
function icon(component: Component<{ size?: number }>, target: HTMLElement) {
  const instance = mount(component, { target, props: { size: 20 } });
  return () => void unmount(instance);
}
export const chevronIcon = (target: HTMLElement, next: boolean) =>
  icon((next ? ChevronRight : ChevronLeft) as unknown as Component<{ size?: number }>, target);
export const playIcon = (target: HTMLElement) =>
  icon(Play as unknown as Component<{ size?: number }>, target);
export const mutedIcon = (target: HTMLElement) =>
  icon(VolumeMute as unknown as Component<{ size?: number }>, target);
