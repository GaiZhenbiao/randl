<script lang="ts">
  // The ledger beside a run in the Lineage panel: its plan (for a planned run), whether it is
  // the current best recipe, the chosen runs compared with it at matched updates, its journal
  // and the findings citing it (RunLedger), and the evidence about it.
  import { Button, InlineNotification, TextArea } from 'carbon-components-svelte';
  import JsonValue from './JsonValue.svelte';
  import RunLedger from './RunLedger.svelte';
  import { tool, apiMessage } from './api';
  import { t, number, date, type Message } from './i18n';
  import { formatMetric, type LineageGraph, type LineageNode } from './lineage-graph';
  let {
    node,
    graph,
    picked,
    onSelect,
    onPage,
    onChanged,
  }: {
    node: LineageNode;
    graph: LineageGraph;
    /** The chosen runs, compared with this one. */
    picked: string[];
    onSelect: (id: string) => void;
    onPage: (page: string, params?: Record<string, string>) => void;
    /** Reloads the graph after a change it shows (the recipe). */
    onChanged: () => void;
  } = $props();
  type Compared = {
    run: string;
    matched: number;
    meanDiff: number | null;
    last: { x: number; diff: number } | null;
  };
  let compared = $state<Compared[] | null>(null),
    error = $state<Message>(''),
    reason = $state(''),
    promoting = $state(false),
    busy = $state(false);
  const nameOf = (id: string) => graph.nodes.find((other) => other.id === id)?.display_name ?? id;
  const shortOf = (id: string) => nameOf(id).split('_')[0];

  // Chosen runs at matched updates of the lineage metric.
  let comparedKey = '';
  $effect(() => {
    const runs = picked.filter((id) => id !== node.id),
      metric = graph.settings.metric,
      key = JSON.stringify([node.id, runs, metric]);
    if (key === comparedKey) return;
    comparedKey = key;
    compared = null;
    if (node.planned || !runs.length || !metric) return;
    tool('runs_compare', { baseline: node.id, runs, metric }).then(
      (result) => {
        if (comparedKey === key) compared = result.runs;
      },
      (reason) => {
        if (comparedKey === key) error = apiMessage(reason);
      },
    );
  });

  async function promote() {
    busy = true;
    error = '';
    try {
      await tool('recipe_set', { project: graph.project, run: node.id, reason: reason.trim() });
      promoting = false;
      reason = '';
      onChanged();
    } catch (reason) {
      error = apiMessage(reason);
    } finally {
      busy = false;
    }
  }
  let evidence = $derived(graph.nodes.filter((other) => other.examines.includes(node.id)));
  const signed = (value: number) =>
    (value > 0 ? '+' : '') + formatMetric(value, graph.settings.scale, $number);
</script>

{#if error}<InlineNotification
    lowContrast
    kind="error"
    title={$t('lineage.ledger.errors.failed')}
    subtitle={$t(error)}
    closeButtonDescription={$t('common.notification.close')}
    on:close={() => (error = '')}
  />{/if}

{#if node.planned}{@const plan = node.planned}<section class="lineage-story">
    <h3>{$t('lineage.plan.title')}</h3>
    <dl class="lineage-facts">
      {#if plan.parent}<div>
          <dt>{$t('lineage.plan.parent')}</dt>
          <dd>
            <button type="button" class="lineage-link" onclick={() => onSelect(plan.parent!)}
              >{nameOf(plan.parent)}</button
            >{plan.parentUpdate === null ? '' : ' @' + $number(plan.parentUpdate)}
          </dd>
        </div>{/if}
      {#if plan.baseline}<div>
          <dt>{$t('lineage.plan.baseline')}</dt>
          <dd>
            <button type="button" class="lineage-link" onclick={() => onSelect(plan.baseline!)}
              >{nameOf(plan.baseline)}</button
            >
          </dd>
        </div>{/if}
      {#if plan.rule}<div>
          <dt>{$t('lineage.plan.rule')}</dt>
          <dd class="lineage-hypothesis">{plan.rule}</dd>
        </div>{/if}
      {#if plan.host || plan.slot || plan.queue !== null}<div>
          <dt>{$t('lineage.plan.where')}</dt>
          <dd>
            {[plan.host, plan.slot, plan.queue === null ? '' : $t('lineage.plan.queue', { position: plan.queue })]
              .filter(Boolean)
              .join(' · ')}
          </dd>
        </div>{/if}
    </dl>
    {#if plan.config !== null}<h3>{$t('lineage.plan.config')}</h3>
      <JsonValue value={plan.config} />{/if}
  </section>
{:else}
  <section>
    <h3>{$t('lineage.recipe.title')}</h3>
    {#if graph.recipe?.run === node.id}<p>
        {$t('lineage.recipe.since', { date: $date(graph.recipe.since, true) })}
      </p>
      <p class="lineage-hypothesis">{graph.recipe.reason}</p>
    {:else if promoting}<div class="form-stack">
        <TextArea
          labelText={$t('lineage.recipe.reason')}
          rows={2}
          bind:value={reason}
        />
        <div class="lineage-actions">
          <Button size="small" disabled={busy || !reason.trim()} on:click={promote}
            >{$t('lineage.recipe.promote')}</Button
          ><Button kind="ghost" size="small" on:click={() => (promoting = false)}
            >{$t('common.action.cancel')}</Button
          >
        </div>
      </div>
    {:else}<p class="lineage-muted">
        {graph.recipe
          ? $t('lineage.recipe.elsewhere', { run: shortOf(graph.recipe.run) })
          : $t('lineage.recipe.none')}
      </p>
      <Button kind="tertiary" size="small" on:click={() => (promoting = true)}
        >{$t('lineage.recipe.promote')}</Button
      >{/if}
  </section>

  {#if compared?.length}<section>
      <h3>{$t('lineage.compare.title')}</h3>
      <p class="lineage-muted">{$t('lineage.compare.help', { metric: graph.settings.metric })}</p>
      <table class="lineage-compare">
        <thead
          ><tr
            ><th>{$t('lineage.compare.run')}</th><th>{$t('lineage.compare.matched')}</th><th
              >{$t('lineage.compare.mean')}</th
            ><th>{$t('lineage.compare.last')}</th></tr
          ></thead
        >
        <tbody>
          {#each compared as row (row.run)}<tr>
              <td
                ><button type="button" class="lineage-link" onclick={() => onSelect(row.run)}
                  >{shortOf(row.run)}</button
                ></td
              >
              <td>{$number(row.matched)}</td>
              <td>{row.meanDiff === null ? '–' : signed(row.meanDiff)}</td>
              <td
                >{row.last
                  ? signed(row.last.diff) + ' @' + $number(row.last.x, { notation: 'compact' })
                  : '–'}</td
              >
            </tr>{/each}
        </tbody>
      </table>
    </section>{/if}

  <RunLedger
    run={node.id}
    project={graph.project}
    onFinding={(id) => onPage('findings', { finding: id })}
  />

  {#if evidence.length || node.examines.length}<section>
      <h3>{$t('lineage.evidence.title')}</h3>
      <ul class="lineage-children">
        {#each evidence as item (item.id)}<li>
            <button type="button" class="lineage-link" onclick={() => onSelect(item.id)}
              >{item.display_name}</button
            >{#if item.jobType}<span class="lineage-muted"> · {item.jobType}</span>{/if}
          </li>{/each}
        {#each node.examines as id (id)}<li>
            {$t('lineage.evidence.examines')}
            <button type="button" class="lineage-link" onclick={() => onSelect(id)}
              >{nameOf(id)}</button
            >
          </li>{/each}
      </ul>
    </section>{/if}
{/if}
