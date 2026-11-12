<script lang="ts">
  // A page's controls in the header rail, the design pattern described in CONTRIBUTING.md,
  // "Page controls". They sit after the page's name at every width, as the workspace's do:
  // filters, view menus and actions first, then the page's main search at the right end,
  // folded to an icon until it is opened or holds text. On phones the open search covers the
  // bar until it closes, and pages show their buttons as icons (`narrow`). App gives pages
  // that use it the `rail` element; without one the controls form a row of their own.
  import type { Snippet } from 'svelte';
  import { Search } from 'carbon-components-svelte';
  import { t } from './i18n';
  let {
    target,
    label,
    search = $bindable(),
    searchLabel,
    onsearchkey,
    suggestions,
    children,
  }: {
    /** The header rail. */
    target?: HTMLElement;
    /** Names the group of controls for assistive technology, when the controls do not. */
    label?: string;
    /** The page's main search, when it has one. */
    search?: string;
    searchLabel?: string;
    /** Keys pressed in the search field, such as arrows into `suggestions`. */
    onsearchkey?: (event: KeyboardEvent) => void;
    /** A list shown under the open search, such as matching items to jump to. */
    suggestions?: Snippet;
    children?: Snippet;
  } = $props();
  let expanded = $state(false),
    focused = $state(false);
  $effect(() => {
    if (search) expanded = true;
  });
  /** Moves the controls into the rail for as long as they are shown. */
  function portal(node: HTMLElement, rail: HTMLElement | undefined) {
    if (rail) rail.append(node);
    return {
      update: (next: HTMLElement | undefined) => next?.append(node),
      destroy: () => {
        if (rail) node.remove();
      },
    };
  }
</script>

<div
  class={target ? 'page-rail-controls' : 'page-rail-row'}
  role={label ? 'group' : undefined}
  aria-label={label}
  use:portal={target}
>
  {@render children?.()}
  {#if searchLabel !== undefined}<div
      class="page-rail-search"
      class:open={expanded}
      role="presentation"
      onkeydown={onsearchkey}
      onfocusin={() => (focused = true)}
      onfocusout={(event) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node))
          focused = false;
      }}
    >
      <Search
        size="sm"
        expandable
        bind:expanded
        bind:value={search}
        labelText={searchLabel}
        placeholder={searchLabel}
        closeButtonLabelText={$t('common.search.clear')}
      />
      {#if focused && search && suggestions}{@render suggestions()}{/if}
    </div>{/if}
</div>
