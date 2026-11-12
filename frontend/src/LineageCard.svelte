<script lang="ts">
  // One run on the Lineage page: its colour, verdict, short name, state, hardware and metric.
  import CheckmarkFilled from 'carbon-icons-svelte/lib/CheckmarkFilled.svelte';
  import CloseFilled from 'carbon-icons-svelte/lib/CloseFilled.svelte';
  import InProgress from 'carbon-icons-svelte/lib/InProgress.svelte';
  import CheckboxCheckedFilled from 'carbon-icons-svelte/lib/CheckboxCheckedFilled.svelte';
  import StarFilled from 'carbon-icons-svelte/lib/StarFilled.svelte';
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
    recipe,
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
    /** Whether the run is the project's current best recipe. */
    recipe: boolean;
    onPath: boolean;
    context: boolean;
    collapsed: number;
    onclick: (event: MouseEvent) => void;
    onkeydown: (event: KeyboardEvent) => void;
  } = $props();
  const icons = { adopted: CheckmarkFilled, rejected: CloseFilled, running: InProgress };
  let head = $derived(node.display_name.split('_')[0]);
  let verdict = $derived(node.verdict ? $t(verdictLabels[node.verdict]) : '');
  let hardware = $derived(
    node.planned
      ? [
          node.planned.host,
          node.planned.slot,
          node.planned.queue === null
            ? ''
            : $t('lineage.plan.queue', { position: node.planned.queue }),
        ]
          .filter(Boolean)
          .join(' · ')
      : computeLabel(node.compute),
  );
</script>

<button
  type="button"
  class="lineage-card verdict-{node.verdict ?? 'none'}"
  class:running={node.state === 'running'}
  class:planned={!!node.planned}
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
    {#if recipe}<StarFilled
        size={16}
        class="lineage-recipe-icon"
        aria-label={$t('lineage.recipe.current')}
        title={$t('lineage.recipe.current')}
      />{/if}
    {#if picked}<CheckboxCheckedFilled
        size={16}
        class="lineage-picked-icon"
        aria-label={$t('lineage.selection.picked')}
      />{/if}
    <span class="lineage-card-state state-{node.state}"
      >{#if node.state === 'killed' && !node.planned}<span
          class="run-state"
          data-state="killed"
          aria-hidden="true"
        ></span>{/if}{node.planned ? $t('lineage.plan.state') : statusLabel(node.state, $t)}</span
    >
  </span>
  <span class="lineage-card-delta">{delta || node.display_name}</span>
  {#if hardware}<span class="lineage-card-compute">{hardware}</span>{/if}
  <span class="lineage-card-metric">
    {#if settings.metric && !node.planned}{#if node.latest !== null || node.best !== null}{formatMetric(
          node.latest,
          settings.scale,
          $number,
        )}<span class="lineage-card-best"
          >{$t('lineage.node.best', {
            value: formatMetric(node.best, settings.scale, $number),
          })}</span
        >{#if node.recent !== null}<span class="lineage-card-best"
            >{$t('lineage.node.recent', {
              count: settings.window,
              value: formatMetric(node.recent, settings.scale, $number),
            })}</span
          >{/if}{:else}<span class="lineage-card-best">{$t('lineage.node.noValue')}</span>{/if}{/if}
    {#if collapsed}<span class="lineage-card-collapsed"
        >{$t('lineage.node.collapsed', { count: collapsed })}</span
      >{/if}
  </span>
</button>
