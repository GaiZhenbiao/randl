<script lang="ts">
  // The Lineage page's side panel for one run: its parent link, hypothesis, metric history
  // along its lineage, and config diffs against its parent and a run the reader picks.
  import RunName from './RunName.svelte';
  import { Button, InlineNotification, Tag, Toggle } from 'carbon-components-svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import Launch from 'carbon-icons-svelte/lib/Launch.svelte';
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
    wordDiff,
    structuredDiff,
    entryOf,
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
      .filter((other) => other.id !== node.id && !other.planned)
      .map((other) => ({ id: other.id, text: other.display_name })),
  );
  let lineChart = $derived(plugins.find((plugin) => plugin.id === 'line'));
  const shortName = (other: LineageNode | undefined) => other?.display_name.split('_')[0] ?? '';
  const text = (value: Json | undefined) => (value === undefined ? '' : JSON.stringify(value));
  /** A dotted key split into its path (shown muted) and its last part. */
  const keyParts = (key: string) => {
    const at = key.lastIndexOf('.');
    return at < 0 ? ['', key] : [key.slice(0, at + 1), key.slice(at + 1)];
  };
  /** Lists and objects on both sides diff field by field, folded under a count. */
  const nested = (change: ConfigChange) =>
    [change.from, change.to].every((value) => !!value && typeof value === 'object') &&
    structuredDiff(change.from, change.to).some((part) => part.path !== '');
  const verdictTag = (verdict: string) =>
    verdict === 'adopted' ? 'green' : verdict === 'rejected' ? 'red' : 'blue';
</script>

{#snippet valueDiff(from: Json | undefined, to: Json | undefined)}<code class="config-diff-value"
    >{#if from === undefined}<span class="config-diff-missing">{$t('lineage.diff.missing')} →</span
      >{/if}{#each wordDiff(text(from), text(to)) as part, position (position)}<span
        class="diff-{part.kind}">{part.text}</span
      >{/each}{#if to === undefined}<span class="config-diff-missing"
        >→ {$t('lineage.diff.missing')}</span
      >{/if}</code
  >{/snippet}

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
    <p class="lineage-muted config-diff-summary">
      {$t('lineage.diff.count', { count: diff.changes.length - ignored })} ·
      <span class="config-diff-legend removed">{fromName}</span> →
      <span class="config-diff-legend added">{shortName(node)}</span>
    </p>
    {#if rows.length}<ul class="config-diff">
        {#each rows as change (change.key)}{@const [path, leaf] = keyParts(change.key)}
          <li class="config-diff-row" class:ignored={change.ignored}>
            <span class="config-diff-key" title={change.key}
              ><span class="config-diff-path">{path}</span><strong>{leaf}</strong></span
            >
            {#if nested(change)}{@const parts = structuredDiff(
                change.from,
                change.to,
              )}{@const entries = new Set(parts.map((part) => entryOf(part.path))).size}
              <details class="config-diff-nested">
                <summary
                  >{entries > 1 || parts.some((part) => entryOf(part.path))
                    ? $t('lineage.diff.entries', { count: entries })
                    : ''}{entries > 1 || parts.some((part) => entryOf(part.path)) ? ' · ' : ''}{$t(
                    'lineage.diff.fields',
                    { count: parts.length },
                  )}</summary
                >
                <ul>
                  {#each parts as part (part.path)}<li>
                      <span class="config-diff-subpath" title={part.path}>{part.path || leaf}</span>
                      {@render valueDiff(part.from, part.to)}
                    </li>{/each}
                </ul>
              </details>{:else}{@render valueDiff(change.from, change.to)}{/if}
          </li>{/each}
      </ul>{/if}
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
  <!-- The header stays in place while the rest of the panel scrolls. -->
  <header class="lineage-details-header">
    <div class="lineage-details-heading">
      <h2 id="lineage-details-title"><RunName id={node.id} name={node.display_name} strong /></h2>
      <p class="lineage-details-meta">
        <span class="lineage-state state-{node.state}">{statusLabel(node.state, $t)}</span>
        {#if node.verdict}<Tag size="sm" type={verdictTag(node.verdict)}
            >{$t(verdictLabels[node.verdict])}</Tag
          >{/if}
        {#if node.group}<span>{$t('lineage.panel.group', { group: node.group })}</span>{/if}
        {#each node.tags.filter((tag) => !tag.startsWith('verdict:')) as tag (tag)}<Tag
            size="sm"
            type="outline">{tag}</Tag
          >{/each}
      </p>
    </div>
    <div class="lineage-details-actions">
      {#if run}<a
          class="bx--btn bx--btn--ghost bx--btn--sm lineage-open-run"
          href={runURL(run)}
          onclick={(event) => interceptLink(event, () => onRun(run))}
          >{$t('lineage.panel.openRun')}<Launch size={16} class="bx--btn__icon" /></a
        >{/if}
      <Button
        kind="ghost"
        size="small"
        icon={Close}
        iconDescription={$t('lineage.panel.close')}
        tooltipPosition="left"
        on:click={onClose}
      />
    </div>
  </header>

  <div class="lineage-details-body">
    {#if node.change || node.hypothesis || node.result || node.verdict || node.recipe !== null || (node.state === 'killed' && node.stateReason)}<section
        class="lineage-story"
      >
        <dl class="lineage-fields">
          {#if node.change}<div>
              <dt>{$t('lineage.panel.change')}</dt>
              <dd class="lineage-lead">{node.change}</dd>
            </div>{/if}
          {#if node.hypothesis}<div>
              <dt>{$t('lineage.panel.hypothesis')}</dt>
              <dd class="lineage-hypothesis">{node.hypothesis}</dd>
            </div>{/if}
          {#if node.result}<div>
              <dt>{$t('lineage.panel.result')}</dt>
              <dd class="lineage-hypothesis">{node.result}</dd>
            </div>{/if}
          {#if node.state === 'killed' && node.stateReason}<div>
              <dt>{$t('runs.stopped.reason')}</dt>
              <dd class="lineage-hypothesis">{node.stateReason}</dd>
            </div>{/if}
          {#if node.verdict}<div>
              <dt>{$t('lineage.panel.verdict')}</dt>
              <dd>
                <Tag size="sm" type={verdictTag(node.verdict)}
                  >{$t(verdictLabels[node.verdict])}</Tag
                >{#if node.verdictReason}<span class="lineage-hypothesis">{node.verdictReason}</span
                  >{/if}
              </dd>
            </div>{/if}
          {#if node.recipe !== null}<div>
              <dt>{$t('lineage.panel.recipe')}</dt>
              <dd><JsonValue value={node.recipe} /></dd>
            </div>{/if}
        </dl>
      </section>{/if}

    {#if !node.planned}<section>
        <h3>{$t('lineage.panel.parent')}</h3>
        {#if parentEdge && parent}<p>
            <RunName
              id={parent.id}
              name={parent.display_name}
              onclick={() => onSelect(parent.id)}
            />
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
        {#if node.bases.length}<h4>{$t('lineage.panel.bases')}</h4>
          <ul class="lineage-children">
            {#each node.bases as base (base.kind + base.reference)}<li>
                {#if base.id}<button
                    type="button"
                    class="lineage-link"
                    onclick={() => onSelect(base.id!)}>{base.reference}</button
                  >{:else}<code>{base.reference}</code>{/if}
              </li>{/each}
          </ul>{/if}
        {#if children.length}<h4>{$t('lineage.panel.children', { count: children.length })}</h4>
          <ul class="lineage-children">
            {#each children as child (child.id)}<li>
                <RunName
                  id={child.id}
                  name={child.display_name}
                  onclick={() => onSelect(child.id)}
                />
              </li>{/each}
          </ul>{/if}
      </section>

      <section>
        <h3>{graph.settings.metric || $t('lineage.panel.metric')}</h3>
        {#if graph.settings.metric}<p class="lineage-values">
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
      </section>{/if}

    <LineageLedger {node} {graph} {picked} {onSelect} {onPage} {onChanged} />

    {#if !node.planned}{#if parentEdge && parent}<section>
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
          translateWithId={(id) =>
            $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
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

    {#if node.compute?.segments.length}<section>
        <h3>{$t('lineage.compute.title')}</h3>
        <table class="lineage-compute">
          <thead>
            <tr>
              <th scope="col">{$t('lineage.compute.updates')}</th>
              <th scope="col">{$t('lineage.compute.host')}</th>
              <th scope="col">{$t('lineage.compute.gpus')}</th>
            </tr>
          </thead>
          <tbody>
            {#each node.compute.segments as segment, position (position)}<tr>
                <td>
                  {segment.to_update === null
                    ? $t('lineage.compute.open', {
                        from: segment.from_update === null ? '–' : $number(segment.from_update),
                      })
                    : $t('lineage.compute.range', {
                        from: segment.from_update === null ? '–' : $number(segment.from_update),
                        to: $number(segment.to_update),
                      })}
                </td>
                <td>{[segment.host, segment.slot].filter(Boolean).join(' · ') || '–'}</td>
                <td>
                  {[
                    segment.gpu_count === null ? '' : segment.gpu_count + '×',
                    segment.gpu_model,
                    segment.gpu_ids?.length ? '(' + segment.gpu_ids.join(', ') + ')' : '',
                  ]
                    .filter(Boolean)
                    .join(' ') || '–'}
                </td>
              </tr>{/each}
          </tbody>
        </table>
      </section>{/if}
  </div>
</aside>
