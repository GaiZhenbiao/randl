<script lang="ts">
  // A project's current state (README "Experiment ledger"): the best recipe and how it got
  // there, and the planned runs queued on each host slot beside the runs occupying them.
  import { onMount } from 'svelte';
  import {
    Button,
    InlineNotification,
    Modal,
    Tag,
    TextArea,
    TextInput,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import StarFilled from 'carbon-icons-svelte/lib/StarFilled.svelte';
  import Choice from './Choice.svelte';
  import { tool, apiMessage } from './api';
  import { t, number, date, type Message } from './i18n';
  import { filterChoice, interceptLink, resultCount, runURL, statusLabel } from './ui';
  import type { Run } from './types';
  import type { Plan, RecipeEvent } from './lineage-graph';

  let {
    project,
    runs,
    onRun,
    onPage,
  }: {
    project: string;
    runs: Run[];
    onRun: (run: Run, tab?: string) => void;
    onPage: (page: string, params?: Record<string, string>) => void;
  } = $props();
  let plans = $state<Plan[] | null>(null),
    recipe = $state<{ current: RecipeEvent | null; history: RecipeEvent[] } | null>(null),
    occupants = $state<{ id: string; host: string; slot: string; name: string }[]>([]),
    error = $state<Message>('');
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));

  async function load() {
    try {
      const [planned, best] = await Promise.all([
        tool('plans_list', { project }),
        tool('recipe_get', { project }),
      ]);
      // Plans a run has carried out leave the queues.
      plans = planned.plans.filter((plan: Plan) => !plan.run);
      recipe = best;
      occupants = planned.running;
      error = '';
    } catch (reason) {
      error = apiMessage(reason);
    }
  }
  onMount(() => void load());

  // Queues: host, then slot; running runs first, then planned runs by queue position.
  let queues = $derived.by(() => {
    const groups = new Map<string, { host: string; slot: string; running: typeof occupants; planned: Plan[] }>();
    const group = (host: string, slot: string) => {
      const key = host + '\u0000' + slot;
      let entry = groups.get(key);
      if (!entry) groups.set(key, (entry = { host, slot, running: [], planned: [] }));
      return entry;
    };
    for (const run of occupants) group(run.host, run.slot).running.push(run);
    for (const plan of plans ?? [])
      if (plan.status === 'planned') group(plan.host, plan.slot).planned.push(plan);
    for (const entry of groups.values())
      entry.planned.sort((a, b) => (a.queue ?? Infinity) - (b.queue ?? Infinity) || a.created - b.created);
    return [...groups.values()].sort(
      (a, b) => a.host.localeCompare(b.host) || a.slot.localeCompare(b.slot),
    );
  });
  let cancelled = $derived((plans ?? []).filter((plan) => plan.status === 'cancelled'));

  // The best recipe.
  let promoting = $state(false),
    recipeRun = $state(''),
    recipeReason = $state(''),
    busy = $state(false);
  async function setRecipe() {
    busy = true;
    try {
      await tool('recipe_set', { project, run: recipeRun, reason: recipeReason.trim() });
      promoting = false;
      recipeRun = recipeReason = '';
      await load();
    } catch (reason) {
      error = apiMessage(reason);
    } finally {
      busy = false;
    }
  }
  let runItems = $derived(runs.map((run) => ({ id: run.id, text: run.display_name })));
  const choice = {
    selectionClearedText: '',
    translateWithIdSelection: () => $t('common.combobox.clear'),
    shouldFilterItem: filterChoice,
  };

  // Editing one plan.
  type Draft = {
    id: string;
    name: string;
    parent: string;
    parentUpdate: string;
    hypothesis: string;
    change: string;
    baseline: string;
    rule: string;
    host: string;
    slot: string;
    queue: string;
    config: string;
    status: Plan['status'];
    created: boolean;
  };
  let draft = $state<Draft | null>(null),
    editError = $state<Message>(''),
    saving = $state(false);
  function edit(plan?: Plan) {
    editError = '';
    draft = plan
      ? {
          id: plan.id,
          name: plan.name,
          parent: plan.parent ?? '',
          parentUpdate: plan.parentUpdate === null ? '' : String(plan.parentUpdate),
          hypothesis: plan.hypothesis,
          change: plan.change,
          baseline: plan.baseline ?? '',
          rule: plan.rule,
          host: plan.host,
          slot: plan.slot,
          queue: plan.queue === null ? '' : String(plan.queue),
          config: plan.config === null ? '' : JSON.stringify(plan.config, null, 2),
          status: plan.status,
          created: true,
        }
      : {
          id: '',
          name: '',
          parent: '',
          parentUpdate: '',
          hypothesis: '',
          change: '',
          baseline: '',
          rule: '',
          host: '',
          slot: '',
          queue: '',
          config: '',
          status: 'planned',
          created: false,
        };
  }
  const numberOrNull = (text: string) => (text.trim() ? Number(text) : null);
  let configError = $derived.by(() => {
    if (!draft?.config.trim()) return false;
    try {
      const value = JSON.parse(draft.config);
      return !value || typeof value !== 'object' || Array.isArray(value);
    } catch {
      return true;
    }
  });
  let validDraft = $derived(
    !!draft &&
      !!(draft.id.trim() || draft.name.trim()) &&
      !configError &&
      [draft.parentUpdate, draft.queue].every((text) => !text.trim() || Number.isFinite(Number(text))),
  );
  async function save(status?: Plan['status']) {
    if (!draft) return;
    saving = true;
    editError = '';
    try {
      await tool('plan_save', {
        project,
        id: draft.id.trim() || draft.name.trim(),
        name: draft.name.trim() || draft.id.trim(),
        parent: draft.parent || null,
        parentUpdate: numberOrNull(draft.parentUpdate),
        hypothesis: draft.hypothesis,
        change: draft.change,
        baseline: draft.baseline || null,
        rule: draft.rule,
        host: draft.host.trim(),
        slot: draft.slot.trim(),
        queue: numberOrNull(draft.queue),
        config: draft.config.trim() ? JSON.parse(draft.config) : null,
        status: status ?? draft.status,
      });
      draft = null;
      await load();
    } catch (reason) {
      editError = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
  async function remove() {
    if (!draft) return;
    saving = true;
    try {
      await tool('plan_delete', { project, id: draft.id });
      draft = null;
      await load();
    } catch (reason) {
      editError = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
</script>

{#snippet runLink(id: string)}{@const run = runById.get(id)}{#if run}<a
      class="bx--link"
      href={runURL(run)}
      onclick={(event) => interceptLink(event, () => onRun(run))}>{run.display_name}</a
    >{:else}<span>{id}</span>{/if}{/snippet}

{#snippet planCard(plan: Plan)}
  <li class="plan-card">
    <header class="finding-header">
      <h4>{plan.name}</h4>
      {#if plan.queue !== null}<Tag size="sm">{$t('lineage.plan.queue', { position: plan.queue })}</Tag
        >{/if}
      {#if plan.status === 'cancelled'}<Tag size="sm" type="gray">{$t('plans.status.cancelled')}</Tag
        >{/if}
      <span class="finding-actions"
        ><Button
          kind="ghost"
          size="small"
          icon={Edit}
          iconDescription={$t('plans.edit.open')}
          tooltipAlignment="end"
          on:click={() => edit(plan)}
        /></span
      >
    </header>
    {#if plan.change}<p>{plan.change}</p>{/if}
    {#if plan.hypothesis}<p class="lineage-muted">{plan.hypothesis}</p>{/if}
    <dl class="lineage-facts">
      {#if plan.parent}<div>
          <dt>{$t('lineage.plan.parent')}</dt>
          <dd>
            {@render runLink(plan.parent)}{plan.parentUpdate === null ? '' : ' @' + $number(plan.parentUpdate)}
          </dd>
        </div>{/if}
      {#if plan.baseline}<div>
          <dt>{$t('lineage.plan.baseline')}</dt>
          <dd>{@render runLink(plan.baseline)}</dd>
        </div>{/if}
      {#if plan.rule}<div>
          <dt>{$t('lineage.plan.rule')}</dt>
          <dd class="lineage-hypothesis">{plan.rule}</dd>
        </div>{/if}
    </dl>
    <p class="lineage-muted">
      <button
        type="button"
        class="lineage-link"
        onclick={() => onPage('lineage', { run: 'plan:' + plan.id })}>{$t('plans.showInLineage')}</button
      >
    </p>
  </li>
{/snippet}

<div class="project-page-content plans-page">
  {#if error}<InlineNotification
      lowContrast
      kind="error"
      title={$t('plans.errors.failed')}
      subtitle={$t(error)}
      closeButtonDescription={$t('common.notification.close')}
      on:close={() => (error = '')}
    />{/if}

  <section class="plans-section">
    <h2><StarFilled size={20} class="lineage-recipe-icon" /> {$t('lineage.recipe.title')}</h2>
    {#if recipe === null}<p class="lineage-muted">{$t('common.status.loading')}</p>
    {:else}
      {#if recipe.current}<p class="recipe-current">
          {@render runLink(recipe.current.run)}
          <span class="lineage-muted">{$t('lineage.recipe.since', { date: $date(recipe.current.since, true) })}</span>
        </p>
        <p class="lineage-hypothesis">{recipe.current.reason}</p>
      {:else}<p class="lineage-muted">{$t('lineage.recipe.none')}</p>{/if}
      {#if promoting}<div class="form-stack recipe-form">
          <Choice
            {...choice}
            labelText={$t('plans.recipe.run')}
            selectionClearedText={$t('common.combobox.selectionCleared')}
            filterResultsText={(count) => resultCount(count, $t)}
            translateWithId={(id) =>
              $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
            items={runItems}
            selectedId={recipeRun || undefined}
            on:select={(event) => (recipeRun = String(event.detail.selectedId))}
          />
          <TextArea labelText={$t('lineage.recipe.reason')} rows={2} bind:value={recipeReason} />
          <div class="lineage-actions">
            <Button
              size="small"
              disabled={busy || !recipeRun || !recipeReason.trim()}
              on:click={setRecipe}>{$t('plans.recipe.set')}</Button
            ><Button kind="ghost" size="small" on:click={() => (promoting = false)}
              >{$t('common.action.cancel')}</Button
            >
          </div>
        </div>{:else}<Button kind="tertiary" size="small" on:click={() => (promoting = true)}
          >{$t('plans.recipe.change')}</Button
        >{/if}
      {#if recipe.history.length > 1}<details class="recipe-history">
          <summary>{$t('plans.recipe.history', { count: recipe.history.length })}</summary>
          <ol>
            {#each recipe.history as event (event.id)}<li>
                <span class="lineage-muted">{$date(event.since, true)}</span>
                {@render runLink(event.run)} — {event.reason}{event.by ? ' (' + event.by + ')' : ''}
              </li>{/each}
          </ol>
        </details>{/if}
    {/if}
  </section>

  <section class="plans-section">
    <div class="plans-heading">
      <h2>{$t('plans.queues.title')}</h2>
      <Button size="small" icon={Add} on:click={() => edit()}>{$t('plans.edit.new')}</Button>
    </div>
    {#if plans === null}<p class="lineage-muted">{$t('common.status.loading')}</p>
    {:else if !queues.length}<p class="empty-table">{$t('plans.empty')}</p>
    {:else}<div class="plan-queues">
        {#each queues as queue (queue.host + '/' + queue.slot)}<section class="plan-queue">
            <h3>{[queue.host, queue.slot].filter(Boolean).join(' · ') || $t('plans.queues.unassigned')}</h3>
            {#if queue.running.length}<ul class="plan-running">
                {#each queue.running as run (run.id)}<li>
                    <span class="plan-running-state">{statusLabel('running', $t)}</span>
                    {@render runLink(run.id)}
                  </li>{/each}
              </ul>{/if}
            {#if queue.planned.length}<ol class="plan-list">
                {#each queue.planned as plan (plan.id)}{@render planCard(plan)}{/each}
              </ol>{:else}<p class="lineage-muted">{$t('plans.queues.nothingQueued')}</p>{/if}
          </section>{/each}
      </div>{/if}
    {#if cancelled.length}<details class="recipe-history">
        <summary>{$t('plans.cancelled', { count: cancelled.length })}</summary>
        <ol class="plan-list">
          {#each cancelled as plan (plan.id)}{@render planCard(plan)}{/each}
        </ol>
      </details>{/if}
  </section>
</div>

{#if draft}<Modal
    open
    size="lg"
    hasScrollingContent
    iconDescription={$t('common.action.close')}
    modalHeading={draft.created ? $t('plans.edit.title') : $t('plans.edit.new')}
    primaryButtonText={saving ? $t('common.status.saving') : $t('plans.edit.save')}
    primaryButtonDisabled={saving || !validDraft}
    secondaryButtonText={$t('common.action.cancel')}
    on:click:button--secondary={() => (draft = null)}
    on:close={() => (draft = null)}
    on:submit={() => save()}
  >
    <div class="form-stack plan-form">
      {#if editError}<InlineNotification
          lowContrast
          hideCloseButton
          kind="error"
          title={$t('plans.errors.failed')}
          subtitle={$t(editError)}
        />{/if}
      <TextInput labelText={$t('plans.edit.name')} bind:value={draft.name} />
      {#if !draft.created}<TextInput
          labelText={$t('plans.edit.id')}
          helperText={$t('plans.edit.idHelp')}
          bind:value={draft.id}
        />{/if}
      <div class="plan-form-row">
        <Choice
          {...choice}
          labelText={$t('lineage.plan.parent')}
          selectionClearedText={$t('common.combobox.selectionCleared')}
          filterResultsText={(count) => resultCount(count, $t)}
          translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
          items={runItems}
          selectedId={draft.parent || undefined}
          on:select={(event) => (draft!.parent = String(event.detail.selectedId))}
          on:clear={() => (draft!.parent = '')}
        />
        <TextInput labelText={$t('plans.edit.parentUpdate')} inputmode="numeric" bind:value={draft.parentUpdate} />
      </div>
      <TextInput labelText={$t('plans.edit.change')} bind:value={draft.change} />
      <TextArea labelText={$t('lineage.panel.hypothesis')} rows={3} bind:value={draft.hypothesis} />
      <Choice
        {...choice}
        labelText={$t('lineage.plan.baseline')}
        selectionClearedText={$t('common.combobox.selectionCleared')}
        filterResultsText={(count) => resultCount(count, $t)}
        translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
        items={runItems}
        selectedId={draft.baseline || undefined}
        on:select={(event) => (draft!.baseline = String(event.detail.selectedId))}
        on:clear={() => (draft!.baseline = '')}
      />
      <TextArea labelText={$t('lineage.plan.rule')} rows={2} bind:value={draft.rule} />
      <div class="plan-form-row">
        <TextInput labelText={$t('plans.edit.host')} bind:value={draft.host} />
        <TextInput labelText={$t('plans.edit.slot')} bind:value={draft.slot} />
        <TextInput labelText={$t('plans.edit.queue')} inputmode="numeric" bind:value={draft.queue} />
      </div>
      <TextArea
        labelText={$t('lineage.plan.config')}
        helperText={$t('plans.edit.configHelp')}
        rows={6}
        invalid={configError}
        invalidText={$t('plans.edit.configInvalid')}
        bind:value={draft.config}
      />
      {#if draft.created}<div class="lineage-actions">
          {#if draft.status === 'planned'}<Button kind="ghost" size="small" on:click={() => save('cancelled')}
              >{$t('plans.edit.cancelPlan')}</Button
            >{:else}<Button kind="ghost" size="small" on:click={() => save('planned')}
              >{$t('plans.edit.restorePlan')}</Button
            >{/if}
          <Button kind="danger-ghost" size="small" on:click={remove}>{$t('plans.edit.delete')}</Button>
        </div>{/if}
    </div>
  </Modal>{/if}
