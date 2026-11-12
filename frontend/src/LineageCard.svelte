<script lang="ts">
  // One run on the Lineage page: its verdict, short name, state and metric values.
  import CheckmarkFilled from 'carbon-icons-svelte/lib/CheckmarkFilled.svelte';
  import CloseFilled from 'carbon-icons-svelte/lib/CloseFilled.svelte';
  import InProgress from 'carbon-icons-svelte/lib/InProgress.svelte';
  import { t, number } from './i18n';
  import { statusLabel } from './ui';
  import {
    formatMetric,
    verdictLabels,
    type LineageNode,
    type LineageSettings,
  } from './lineage-graph';
  let {
    node,
    delta,
    settings,
    x,
    y,
    selected,
    onPath,
    context,
    collapsed,
    onselect,
    onkeydown,
  }: {
    node: LineageNode;
    delta: string;
    settings: LineageSettings;
    x: number;
    y: number;
    selected: boolean;
    onPath: boolean;
    context: boolean;
    collapsed: number;
    onselect: () => void;
    onkeydown: (event: KeyboardEvent) => void;
  } = $props();
  const icons = { adopted: CheckmarkFilled, rejected: CloseFilled, running: InProgress };
  let head = $derived(node.display_name.split('_')[0]);
  let verdict = $derived(node.verdict ? $t(verdictLabels[node.verdict]) : '');
</script>

<button
  type="button"
  class="lineage-card verdict-{node.verdict ?? 'none'}"
  class:selected
  class:on-path={onPath}
  class:context
  data-run={node.id}
  aria-pressed={selected}
  title={node.display_name}
  style:left={x + 'px'}
  style:top={y + 'px'}
  onclick={onselect}
  {onkeydown}
>
  <span class="lineage-card-head">
    {#if node.verdict}{@const Icon = icons[node.verdict]}<Icon
        size={16}
        class="lineage-verdict-icon"
        aria-label={verdict}
        title={verdict}
      />{/if}
    <span class="lineage-card-name">{head}</span>
    <span class="lineage-card-state state-{node.state}">{statusLabel(node.state, $t)}</span>
  </span>
  <span class="lineage-card-delta">{delta || node.display_name}</span>
  <span class="lineage-card-metric">
    {#if settings.metric}{#if node.latest !== null || node.best !== null}{formatMetric(
          node.latest,
          settings.scale,
          $number,
        )}<span class="lineage-card-best"
          >{$t('lineage.node.best', {
            value: formatMetric(node.best, settings.scale, $number),
          })}</span
        >{:else}<span class="lineage-card-best">{$t('lineage.node.noValue')}</span>{/if}{/if}
    {#if collapsed}<span class="lineage-card-collapsed"
        >{$t('lineage.node.collapsed', { count: collapsed })}</span
      >{/if}
  </span>
</button>
