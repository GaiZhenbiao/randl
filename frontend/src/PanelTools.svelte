<script lang="ts">
  import { Button, Search } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Settings from 'carbon-icons-svelte/lib/Settings.svelte';
  import { t } from './i18n';
  // Panel search, workspace settings and Add panel, shared by the workspace toolbar and run tabs.
  let {
    search = $bindable(''),
    canvasWidth,
    onDefaults,
    onAdd,
  }: {
    search?: string;
    canvasWidth: number;
    onDefaults: () => void;
    onAdd: () => void;
  } = $props();
</script>

<div class="panel-group">
  <div class="panel-search">
    <Search
      closeButtonLabelText={$t('common.search.clear')}
      size="sm"
      labelText={$t('workspace.search')}
      placeholder={$t('workspace.search')}
      bind:value={search}
    />
  </div>
  <div class="chart-actions">
    <Button
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
    />{#if canvasWidth < 480}<Button
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
