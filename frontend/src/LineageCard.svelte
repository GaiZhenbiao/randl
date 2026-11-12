<script lang="ts">
  // One run on the Lineage page: its colour, verdict, short name, state, hardware and metric.
  import CheckmarkFilled from 'carbon-icons-svelte/lib/CheckmarkFilled.svelte';
  import CloseFilled from 'carbon-icons-svelte/lib/CloseFilled.svelte';
  import InProgress from 'carbon-icons-svelte/lib/InProgress.svelte';
  import CheckboxCheckedFilled from 'carbon-icons-svelte/lib/CheckboxCheckedFilled.svelte';
  import { t, number } from './i18n';
  import { statusLabel } from './ui';
  import {
    computeLabel,
    formatMetric,
    verdictLabels,
    type LineageNode,
    type LineageSettings,
  } from './lineage-graph';
  let {
    node,
    delta,
    settings,
    color,
    x,
    y,
    selected,
    picked,
    onPath,
    context,
    collapsed,
    onclick,
    onkeydown,
  }: {
    node: LineageNode;
    delta: string;
    settings: LineageSettings;
    /** The run's colour in workspace charts, or its host's colour. */
    color: string | undefined;
    x: number;
    y: number;
    selected: boolean;
    picked: boolean;
    onPath: boolean;
    context: boolean;
    collapsed: number;
    onclick: (event: MouseEvent) => void;
    onkeydown: (event: KeyboardEvent) => void;
  } = $props();
  const icons = { adopted: CheckmarkFilled, rejected: CloseFilled, running: InProgress };
  let head = $derived(node.display_name.split('_')[0]);
  let verdict = $derived(node.verdict ? $t(verdictLabels[node.verdict]) : '');
  let hardware = $derived(computeLabel(node.compute));
</script>

<button
  type="button"
  class="lineage-card verdict-{node.verdict ?? 'none'}"
  class:running={node.state === 'running'}
  class:selected
  class:picked
  class:on-path={onPath}
  class:context
  data-run={node.id}
  aria-pressed={picked}
  aria-current={selected ? 'true' : undefined}
  title={node.display_name}
  style:left={x + 'px'}
  style:top={y + 'px'}
  {onclick}
  {onkeydown}
>
  <span class="lineage-card-head">
    {#if color}<span class="lineage-swatch" style:background={color}></span>{/if}
    {#if node.verdict}{@const Icon = icons[node.verdict]}<Icon
        size={16}
        class="lineage-verdict-icon"
        aria-label={verdict}
        title={verdict}
      />{/if}
    <span class="lineage-card-name">{head}</span>
    {#if picked}<CheckboxCheckedFilled
        size={16}
        class="lineage-picked-icon"
        aria-label={$t('lineage.selection.picked')}
      />{/if}
    <span class="lineage-card-state state-{node.state}">{statusLabel(node.state, $t)}</span>
  </span>
  <span class="lineage-card-delta">{delta || node.display_name}</span>
  {#if hardware}<span class="lineage-card-compute">{hardware}</span>{/if}
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
