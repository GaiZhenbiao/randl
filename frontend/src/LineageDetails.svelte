<script lang="ts">
  // The Lineage page's side panel for one run: its parent link, hypothesis, metric history
  // along its lineage, and config diffs against its parent and a run the reader picks.
  import { Button, InlineNotification, Tag, Toggle } from 'carbon-components-svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import WarningAlt from 'carbon-icons-svelte/lib/WarningAlt.svelte';
  import Choice from './Choice.svelte';
  import JsonValue from './JsonValue.svelte';
  import PanelCard from './Panel.svelte';
  import LineageLedger from './LineageLedger.svelte';
  import { tool, apiMessage } from './api';
  import { t, number, type Message } from './i18n';
  import { filterChoice, interceptLink, resultCount, runURL, statusLabel } from './ui';
  import type { Plugin, Run } from './types';
  import {
    formatMetric,
    relationLabel,
    verdictLabels,
    type ConfigChange,
    type GraphIndex,
    type Json,
    type LineageGraph,
    type LineageNode,
  } from './lineage-graph';
  let {
    node,
    index,
    graph,
    run,
    pathRuns,
    plugins,
    colors,
    dark,
    onClose,
    onSelect,
    onRun,
    onPage,
    picked,
    onChanged,
  }: {
    node: LineageNode;
    index: GraphIndex;
    graph: LineageGraph;
    run: Run | undefined;
    pathRuns: Run[];
    plugins: Plugin[];
    colors: Record<string, string>;
    dark: boolean;
    onClose: () => void;
    onSelect: (id: string) => void;
    onRun: (run: Run) => void;
    onPage: (page: string, params?: Record<string, string>) => void;
    picked: string[];
    onChanged: () => void;
  } = $props();
  let parentEdge = $derived(index.parent.get(node.id));
  let parent = $derived(parentEdge ? index.nodes.get(parentEdge.source) : undefined);
  let children = $derived(
    (index.children.get(node.id) ?? []).map((edge) => index.nodes.get(edge.target)!),
  );
  let compareWith = $state(''),
    showIgnored = $state(false);

  type Diff = { changes: (ConfigChange & { ignored: boolean })[] } | { error: Message } | null;
  /** Loads the full diff from one run to another; stale answers are dropped. */
  function diffLoader() {
    let value = $state<Diff>(null),
      wanted = '';
    return {
      get value() {
        return value;
      },
      load(from: string | undefined, to: string) {
        const key = from ? from + '>' + to : '';
        if (key === wanted) return;
        wanted = key;
        value = null;
        if (!from) return;
        tool('runs_config_diff', { from, to }).then(
          (result) => {
            if (wanted === key) value = result;
          },
          (reason) => {
            if (wanted === key) value = { error: apiMessage(reason) };
          },
        );
      },
    };
  }
  const parentDiff = diffLoader(),
    pickedDiff = diffLoader();
  $effect(() => parentDiff.load(node.planned ? undefined : parentEdge?.source, node.id));
  $effect(() => pickedDiff.load(compareWith || undefined, node.id));

  let compareItems = $derived(
    graph.nodes
      .filter((other) => other.id !== node.id)
      .map((other) => ({ id: other.id, text: other.display_name })),
  );
  let lineChart = $derived(plugins.find((plugin) => plugin.id === 'line'));
  const shortName = (other: LineageNode | undefined) => other?.display_name.split('_')[0] ?? '';
  const show = (value: Json | undefined) =>
    value === undefined ? $t('lineage.diff.missing') : JSON.stringify(value);
</script>

{#snippet diffTable(diff: Diff, fromName: string)}
  {#if !diff}<p class="lineage-muted">{$t('common.status.loading')}</p>
  {:else if 'error' in diff}<InlineNotification
      lowContrast
      hideCloseButton
      kind="error"
      title={$t('lineage.diff.errors.loadFailed')}
      subtitle={$t(diff.error)}
    />
  {:else}{@const ignored = diff.changes.filter((change) => change.ignored).length}{@const rows =
      diff.changes.filter((change) => showIgnored || !change.ignored)}
    <p class="lineage-muted">
      {$t('lineage.diff.count', { count: diff.changes.length - ignored })}
    </p>
    {#if rows.length}<dl class="lineage-diff">
        {#each rows as change (change.key)}<div class="lineage-diff-row">
            <dt class:lineage-ignored={change.ignored}>{change.key}</dt>
            <dd>
              <span class="lineage-diff-run">{fromName}</span>
              <code class="lineage-value">{show(change.from)}</code>
            </dd>
            <dd>
              <span class="lineage-diff-run">{shortName(node)}</span>
              <code class="lineage-value">{show(change.to)}</code>
            </dd>
          </div>{/each}
      </dl>{/if}
    {#if ignored}<Toggle
        size="sm"
        labelText={$t('lineage.diff.showIgnored', { count: ignored })}
        labelA={$t('common.state.off')}
        labelB={$t('common.state.on')}
        bind:toggled={showIgnored}
      />{/if}
  {/if}
{/snippet}

<aside class="lineage-details" aria-labelledby="lineage-details-title">
  <header class="lineage-details-header">
    <h2 id="lineage-details-title">{node.display_name}</h2>
    <Button
      kind="ghost"
      size="small"
      icon={Close}
      iconDescription={$t('lineage.panel.close')}
      tooltipPosition="left"
      on:click={onClose}
    />
  </header>
  <p class="lineage-details-meta">
    <span>{statusLabel(node.state, $t)}</span>
    {#if node.verdict}<Tag
        size="sm"
        type={node.verdict === 'adopted' ? 'green' : node.verdict === 'rejected' ? 'red' : 'blue'}
        >{$t(verdictLabels[node.verdict])}</Tag
      >{/if}
    {#if node.group}<span>{$t('lineage.panel.group', { group: node.group })}</span>{/if}
    {#each node.tags.filter((tag) => !tag.startsWith('verdict:')) as tag (tag)}<Tag size="sm"
        >{tag}</Tag
      >{/each}
  </p>
  {#if run}<p>
      <a
        class="bx--link"
        href={runURL(run)}
        onclick={(event) => interceptLink(event, () => onRun(run))}>{$t('lineage.panel.openRun')}</a
      >
    </p>{/if}

  {#if !node.planned}<section>
    <h3>{$t('lineage.panel.parent')}</h3>
    {#if parentEdge && parent}<p>
        <button type="button" class="lineage-link" onclick={() => onSelect(parent.id)}
          >{parent.display_name}</button
        >
      </p>
      <p class="lineage-muted">
        {parentEdge.update === null
          ? $t(relationLabel(parentEdge.relation))
          : $t('lineage.panel.relationAt', {
              relation: $t(relationLabel(parentEdge.relation)),
              update: $number(parentEdge.update),
            })}
        · {parentEdge.explicit ? $t('lineage.panel.explicit') : $t('lineage.panel.matched')}
      </p>
      {#if parentEdge.traits.length}<p class="lineage-traits">
          {#each parentEdge.traits as trait (trait)}<Tag size="sm" type="outline">{trait}</Tag
            >{/each}
        </p>{/if}
      {#if parentEdge.ambiguous}<p class="lineage-warning">
          <WarningAlt size={16} />{$t('lineage.panel.ambiguous')}
        </p>{/if}
    {:else if node.unresolved}<p class="lineage-warning">
        <WarningAlt size={16} />{$t('lineage.panel.unresolved', {
          source: node.unresolved.source,
        })}
      </p>
    {:else}<p class="lineage-muted">{$t('lineage.panel.noParent')}</p>{/if}
    {#if node.bases.length}<h3>{$t('lineage.panel.bases')}</h3>
      <ul class="lineage-children">
        {#each node.bases as base (base.kind + base.reference)}<li>
            {#if base.id}<button
                type="button"
                class="lineage-link"
                onclick={() => onSelect(base.id!)}>{base.reference}</button
              >{:else}<code>{base.reference}</code>{/if}
          </li>{/each}
      </ul>{/if}
  </section>{/if}

  {#if node.compute?.segments.length}<section>
      <h3>{$t('lineage.compute.title')}</h3>
      <dl class="lineage-diff">
        {#each node.compute.segments as segment, position (position)}<div class="lineage-diff-row">
            <dt>
              {segment.to_update === null
                ? $t('lineage.compute.open', {
                    from: segment.from_update === null ? '–' : $number(segment.from_update),
                  })
                : $t('lineage.compute.range', {
                    from: segment.from_update === null ? '–' : $number(segment.from_update),
                    to: $number(segment.to_update),
                  })}
            </dt>
            <dd>
              <span class="lineage-diff-run">{$t('lineage.compute.host')}</span>
              <span>{[segment.host, segment.slot].filter(Boolean).join(' · ') || '–'}</span>
            </dd>
            <dd>
              <span class="lineage-diff-run">{$t('lineage.compute.gpus')}</span>
              <span
                >{[
                  segment.gpu_count === null ? '' : segment.gpu_count + '×',
                  segment.gpu_model,
                  segment.gpu_ids?.length ? '(' + segment.gpu_ids.join(', ') + ')' : '',
                ]
                  .filter(Boolean)
                  .join(' ') || '–'}</span
              >
            </dd>
          </div>{/each}
      </dl>
    </section>{/if}

  {#if node.change || node.hypothesis || node.result || node.verdict || node.recipe !== null}<section
      class="lineage-story"
    >
      {#if node.change}<h3>{$t('lineage.panel.change')}</h3>
        <p class="lineage-hypothesis">{node.change}</p>{/if}
      {#if node.hypothesis}<h3>{$t('lineage.panel.hypothesis')}</h3>
        <p class="lineage-hypothesis">{node.hypothesis}</p>{/if}
      {#if node.result}<h3>{$t('lineage.panel.result')}</h3>
        <p class="lineage-hypothesis">{node.result}</p>{/if}
      {#if node.verdict}<h3>{$t('lineage.panel.verdict')}</h3>
        <p>
          <Tag
            size="sm"
            type={node.verdict === 'adopted'
              ? 'green'
              : node.verdict === 'rejected'
                ? 'red'
                : 'blue'}>{$t(verdictLabels[node.verdict])}</Tag
          >{#if node.verdictReason}<span class="lineage-hypothesis">{node.verdictReason}</span>{/if}
        </p>{/if}
      {#if node.recipe !== null}<h3>{$t('lineage.panel.recipe')}</h3>
        <JsonValue value={node.recipe} />{/if}
    </section>{/if}

  <LineageLedger {node} {graph} {picked} {onSelect} {onPage} {onChanged} />

  {#if !node.planned}<section>
    <h3>{graph.settings.metric || $t('lineage.panel.metric')}</h3>
    {#if graph.settings.metric}<p>
        {$t('lineage.panel.values', {
          latest: formatMetric(node.latest, graph.settings.scale, $number),
          best: formatMetric(node.best, graph.settings.scale, $number),
        })}
      </p>
      {#if pathRuns.length && lineChart}<div class="lineage-chart">
          <PanelCard
            height={220}
            panel={{
              id: 'lineage-' + node.id,
              plugin: 'line',
              metric: graph.settings.metric,
              metrics: [graph.settings.metric],
              title: $t('lineage.panel.chartTitle'),
            }}
            runs={pathRuns}
            {dark}
            {colors}
            plugin={lineChart}
            readonly
            onedit={() => {}}
            onremove={() => {}}
            onduplicate={() => {}}
            onmove={() => {}}
          />
        </div>{/if}
    {:else}<p class="lineage-muted">{$t('lineage.panel.noMetric')}</p>{/if}
  </section>

  {#if parentEdge && parent}<section>
      <h3>{$t('lineage.diff.parent.title')}</h3>
      {#if parentEdge.changeSource === 'lineage'}<p class="lineage-muted">
          {$t('lineage.diff.logged', { count: parentEdge.changeCount })}
        </p>{/if}
      {@render diffTable(parentDiff.value, shortName(parent))}
    </section>{/if}

  <section>
    <h3>{$t('lineage.diff.compare.title')}</h3>
    <Choice
      id="lineage-compare"
      labelText={$t('lineage.diff.compare.label')}
      placeholder={$t('lineage.diff.compare.placeholder')}
      selectionClearedText={$t('common.combobox.selectionCleared')}
      filterResultsText={(count) => resultCount(count, $t)}
      translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
      translateWithIdSelection={() => $t('common.combobox.clear')}
      shouldFilterItem={filterChoice}
      items={compareItems}
      selectedId={compareWith || undefined}
      on:select={(event) => (compareWith = String(event.detail.selectedId))}
      on:clear={() => (compareWith = '')}
    />
    {#if compareWith}{@render diffTable(
        pickedDiff.value,
        shortName(index.nodes.get(compareWith)),
      )}{/if}
  </section>{/if}

  {#if children.length}<section>
      <h3>{$t('lineage.panel.children', { count: children.length })}</h3>
      <ul class="lineage-children">
        {#each children as child (child.id)}<li>
            <button type="button" class="lineage-link" onclick={() => onSelect(child.id)}
              >{child.display_name}</button
            >
          </li>{/each}
      </ul>
    </section>{/if}
</aside>
