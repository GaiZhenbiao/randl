<script lang="ts">
  // A page's controls (search, filters, view menus, actions, the info button) in the header
  // rail: the design pattern described in CONTRIBUTING.md, "Page controls". App gives pages
  // that use it a `rail` element while the window is at least 1056 px wide; the controls move
  // into it and sit after the page title. Narrower, they form one row under the header, which
  // scrolls sideways rather than wrapping. Pages keep the row short by putting secondary
  // choices in popovers (Filters, View, Info) and mark trailing actions with `page-rail-end`.
  import type { Snippet } from 'svelte';
  let {
    target,
    label,
    children,
  }: {
    /** The header rail, when the page's controls belong there. */
    target?: HTMLElement;
    /** Names the group of controls for assistive technology, when the controls do not. */
    label?: string;
    children: Snippet;
  } = $props();
  /** Moves the controls into the rail for as long as they are shown. */
  function portal(node: HTMLElement, rail: HTMLElement) {
    rail.append(node);
    return {
      update: (next: HTMLElement) => next.append(node),
      destroy: () => node.remove(),
    };
  }
</script>

{#if target}<div class="page-rail-controls" role={label ? 'group' : undefined} aria-label={label} use:portal={target}>
    {@render children()}
  </div>{:else}<div class="page-rail-row" role={label ? 'group' : undefined} aria-label={label}>
    {@render children()}
  </div>{/if}
