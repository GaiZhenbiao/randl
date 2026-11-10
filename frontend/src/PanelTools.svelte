<script lang="ts">
  import { Button, Search } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Settings from 'carbon-icons-svelte/lib/Settings.svelte';
  import { t } from './i18n';
  // Panel search, workspace settings and Add panel, shared by the header and run tabs.
  // In the header the search folds to an icon while it is empty.
  let {
    search = $bindable(''),
    header = false,
    compact,
    settings = true,
    add = true,
    onDefaults,
    onAdd,
  }: {
    search?: string;
    header?: boolean;
    /** Add panel shows only its icon. */
    compact: boolean;
    /** Whether workspace settings and Add panel show here; a crowded header moves them to its menu. */
    settings?: boolean;
    add?: boolean;
    onDefaults: () => void;
    onAdd: () => void;
  } = $props();
  let expanded = $state(false);
  $effect(() => {
    if (header && search) expanded = true;
  });
</script>

{#snippet searchField()}
  <div class="panel-search">
    <Search
      closeButtonLabelText={$t('common.search.clear')}
      size="sm"
      labelText={$t('workspace.search')}
      placeholder={$t('workspace.search')}
      expandable={header}
      bind:expanded
      bind:value={search}
    />
  </div>
{/snippet}

<div class="panel-group" class:header>
  {@render searchField()}
  <div class="chart-actions">
    {#if settings}<Button
      kind="ghost"
      size="small"
      icon={Settings}
      aria-pressed={undefined}
      hideTooltip
      title={$t('workspace.settings')}
      iconDescription={$t('workspace.settings')}
      portalTooltip
      tooltipAlignment="end"
      on:click={() => onDefaults()}
    />{/if}{#if !add}<!-- In the header's menu. -->{:else if compact}<Button
        size="small"
        icon={Add}
        aria-pressed={undefined}
        hideTooltip
        title={$t('workspace.addPanel')}
        iconDescription={$t('workspace.addPanel')}
        on:click={() => onAdd()}
      />{:else}<Button size="small" icon={Add} on:click={() => onAdd()}>{$t('workspace.addPanel')}</Button
      >{/if}
  </div>
</div>
