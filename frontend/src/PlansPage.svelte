<script lang="ts">
  // A project's current state (README "Experiment ledger"): the best recipe and how it got
  // there, the GPUs of each host over time (the `gpu-occupancy` panel), and one lane per host
  // slot with the run occupying it and the planned runs queued behind it.
  import { onMount } from 'svelte';
  import {
    Button,
    InlineNotification,
    Modal,
    ProgressBar,
    Tag,
    TextArea,
    TextInput,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import StarFilled from 'carbon-icons-svelte/lib/StarFilled.svelte';
  import Choice from './Choice.svelte';
  import LedgerSource from './LedgerSource.svelte';
  import PanelCard from './Panel.svelte';

  import { tool, apiMessage } from './api';
  import { t, number, date, locale, type Message } from './i18n';
  import { filterChoice, interceptLink, resultCount, runURL } from './ui';
  import type { OpenTarget, Plugin, Run } from './types';
  import type { Plan, RecipeEvent } from './lineage-graph';
  import type { OccupancyData } from './plugins/occupancy';

  let {
    project,
    runs,
    plugins,
    dark,
    onRun,
    onPage,
  }: {
    project: string;
    runs: Run[];
    plugins: Plugin[];
    dark: boolean;
    onRun: (run: Run, tab?: string) => void;
    onPage: (page: string, params?: Record<string, string>) => void;
  } = $props();
  type Occupancy = OccupancyData & { metric: string; scale: number | null };
  type Bar = Occupancy['bars'][number];
  let plans = $state<Plan[] | null>(null),
    recipe = $state<{ current: RecipeEvent | null; history: RecipeEvent[] } | null>(null),
    occupants = $state<{ id: string; host: string; slot: string; name: string }[]>([]),
    occupancy = $state<Occupancy | null>(null),
    error = $state<Message>(''),
    // Reloads the timeline panel after a change here.
    refresh = $state(0);
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));

  async function load() {
    try {
      const [planned, best, timeline] = await Promise.all([
        tool('plans_list', { project }),
        tool('recipe_get', { project }),
        tool('project_occupancy', { project }),
      ]);
      // Plans a run has carried out leave the queues.
      plans = planned.plans.filter((plan: Plan) => !plan.run);
      recipe = best;
      occupants = planned.running;
      occupancy = timeline;
      error = '';
    } catch (reason) {
      error = apiMessage(reason);
    }
  }
  async function changed() {
    await load();
    refresh++;
  }
  // Progress and estimates move while runs train.
  onMount(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => clearInterval(timer);
  });

  // The timeline panel: hosts' GPU rows, at least 280 px and at most 640 px tall.
  let occupancyPlugin = $derived(plugins.find((plugin) => plugin.id === 'gpu-occupancy'));
  let timelineHeight = $derived.by(() => {
    const rows = occupancy?.hosts.reduce((sum, host) => sum + host.rows.length, 0) ?? 8,
      hosts = occupancy?.hosts.length ?? 3;
    return Math.min(640, Math.max(280, 34 + hosts * 30 + rows * 26 + 140));
  });
  function open(target: OpenTarget) {
    if ('run' in target) {
      const run = runById.get(target.run);
      if (run) onRun(run);
      return;
    }
    const plan = plans?.find((item) => item.id === target.plan);
    if (!plan) return;
    document.getElementById('plan-' + plan.id)?.scrollIntoView({ block: 'center' });
    edit(plan);
  }

  // Lanes: host, then slot; the run occupying it, then its planned runs by queue position.
  type Running = { id: string; name: string; bar: Bar | null; estimate: Bar | null };
  type Lane = {
    host: string;
    slot: string;
    gpus: number[] | null;
    model: string;
    running: Running[];
    planned: Plan[];
  };
  const laneKey = (host: string, slot: string) => host + '\u0000' + slot;
  let lanes = $derived.by(() => {
    const groups = new Map<string, Lane>();
    const group = (host: string, slot: string) => {
      const key = laneKey(host, slot);
      let entry = groups.get(key);
      if (!entry)
        groups.set(
          key,
          (entry = {
            host,
            slot,
            gpus: null,
            model: occupancy?.hosts.find((item) => item.host === host)?.model ?? '',
            running: [],
            planned: [],
          }),
        );
      return entry;
    };
    // Running runs where the timeline puts them (their compute block, else their plan's slot).
    const bars = occupancy?.bars ?? [];
    if (occupancy)
      for (const bar of bars.filter((item) => item.kind === 'running' && item.run)) {
        const lane = group(bar.host, bar.slot);
        lane.running.push({
          id: bar.run!,
          name: bar.name,
          bar,
          estimate: bars.find((item) => item.run === bar.run && item.kind === 'remaining') ?? null,
        });
        lane.gpus ??= bar.gpus;
      }
    else
      for (const run of occupants)
        group(run.host, run.slot).running.push({ ...run, bar: null, estimate: null });
    // Running runs that log no compute block share a lane of their own.
    for (const run of occupancy?.unplaced ?? [])
      group('', '').running.push({ id: run.id, name: run.name, bar: null, estimate: null });
    for (const plan of plans ?? [])
      if (plan.status === 'planned') {
        const lane = group(plan.host, plan.slot);
        lane.planned.push(plan);
        lane.gpus ??= scheduled.get(plan.id)?.gpus ?? null;
      }
    // A plan's place: its queue position, else just behind what it is queued after (a running
    // run, or another plan); plans placed neither way go last.
    const byId = new Map((plans ?? []).map((plan) => [plan.id, plan]));
    const rank = (plan: Plan, seen = new Set<string>()): number => {
      if (plan.queue !== null) return plan.queue;
      if (!plan.after || seen.has(plan.id)) return Infinity;
      seen.add(plan.id);
      const before = byId.get(plan.after.replace(/^plan:/, ''));
      return before ? rank(before, seen) + 0.5 : 0.5;
    };
    for (const entry of groups.values())
      entry.planned.sort((a, b) => rank(a) - rank(b) || a.created - b.created);
    // Lanes without a host go last.
    return [...groups.values()].sort(
      (a, b) =>
        Number(!a.host) - Number(!b.host) ||
        a.host.localeCompare(b.host, undefined, { sensitivity: 'base', numeric: true }) ||
        a.slot.localeCompare(b.slot, undefined, { numeric: true }),
    );
  });
  /** Each open plan's estimated time on the timeline. */
  let scheduled = $derived(
    new Map(
      (occupancy?.bars ?? [])
        .filter((bar) => bar.kind === 'planned' && bar.plan)
        .map((bar) => [bar.plan!, bar]),
    ),
  );
  let cancelled = $derived((plans ?? []).filter((plan) => plan.status === 'cancelled'));
  let now = $derived(occupancy?.now ?? Date.now() / 1000);
  const audit = (value: number) =>
    $number(value * (occupancy?.scale ?? 1), { maximumFractionDigits: 3 });
  const when = (seconds: number) =>
    new Intl.DateTimeFormat($locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(seconds * 1000));
  /** A wait or length in its two largest units, such as 1d 4h or 3h 20min. */
  const span = (seconds: number) => {
    const minutes = Math.max(1, Math.round(seconds / 60)),
      parts: [number, string][] = [
        [Math.floor(minutes / 1440), 'day'],
        [Math.floor(minutes / 60) % 24, 'hour'],
        [minutes % 60, 'minute'],
      ],
      first = parts.findIndex(([value]) => value > 0);
    return new Intl.ListFormat($locale, { style: 'narrow', type: 'unit' }).format(
      parts
        .slice(first, first + 2)
        .filter(([value]) => value > 0)
        .map(([value, unit]) => $number(value, { style: 'unit', unit, unitDisplay: 'narrow' })),
    );
  };

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
      await changed();
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
    gpus: string;
    updates: string;
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
          gpus: plan.gpus?.join(', ') ?? '',
          updates: plan.updates == null ? '' : String(plan.updates),
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
          gpus: '',
          updates: '',
          config: '',
          status: 'planned',
          created: false,
        };
  }
  const numberOrNull = (text: string) => (text.trim() ? Number(text) : null);
  /** GPU indices typed as a list such as `3, 4`. */
  const gpuList = (text: string) =>
    text
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
  let gpusValid = $derived(
    !draft?.gpus.trim() ||
      gpuList(draft.gpus).every((gpu) => Number.isInteger(gpu) && gpu >= 0 && gpu <= 1023),
  );
  let updatesValid = $derived(
    !draft?.updates.trim() || (Number.isFinite(Number(draft.updates)) && Number(draft.updates) > 0),
  );
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
      [draft.parentUpdate, draft.queue].every(
        (text) => !text.trim() || Number.isFinite(Number(text)),
      ) &&
      gpusValid &&
      updatesValid,
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
        gpus: draft.gpus.trim() ? [...new Set(gpuList(draft.gpus))] : null,
        updates: numberOrNull(draft.updates),
        config: draft.config.trim() ? JSON.parse(draft.config) : null,
        status: status ?? draft.status,
      });
      draft = null;
      await changed();
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
      await changed();
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

{#snippet planCard(plan: Plan, position: number | null)}{@const at = scheduled.get(plan.id)}
  <li class="plan-card" id={'plan-' + plan.id}>
    <header class="plan-card-header">
      {#if position !== null}<span
          class="plan-position"
          title={$t('plans.lane.position', { position })}>{position}</span
        >{/if}
      <h4>{plan.name}</h4>
      {#if plan.status === 'cancelled'}<Tag size="sm" type="gray"
          >{$t('plans.status.cancelled')}</Tag
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
    {#if at && plan.status === 'planned'}<p class="plan-when">
        {at.start <= now + 60
          ? $t('plans.lane.startsNow')
          : $t('plans.lane.starts', { when: when(at.start), wait: span(at.start - now) })}
        <span class="lineage-muted"
          >· {at.unknownLength
            ? $t('plans.lane.lengthUnknown')
            : $t('plans.lane.length', { length: span(at.end - at.start) })}</span
        >
      </p>{/if}
    {#if plan.change}<p class="plan-change">{plan.change}</p>{/if}
    <dl class="plan-facts">
      {#if plan.hypothesis}<div>
          <dt>{$t('lineage.panel.hypothesis')}</dt>
          <dd class="lineage-hypothesis">{plan.hypothesis}</dd>
        </div>{/if}
      {#if plan.baseline}<div>
          <dt>{$t('lineage.plan.baseline')}</dt>
          <dd>{@render runLink(plan.baseline)}</dd>
        </div>{/if}
      {#if plan.rule}<div>
          <dt>{$t('lineage.plan.rule')}</dt>
          <dd class="lineage-hypothesis">{plan.rule}</dd>
        </div>{/if}
      {#if plan.parent}<div>
          <dt>{$t('lineage.plan.parent')}</dt>
          <dd>
            {@render runLink(plan.parent)}{plan.parentUpdate === null
              ? ''
              : ' @' + $number(plan.parentUpdate)}
          </dd>
        </div>{/if}
      {#if plan.after}<div>
          <dt>{$t('lineage.plan.after')}</dt>
          <dd>
            {plan.after.startsWith('plan:')
              ? plan.after.slice(5)
              : ''}{#if !plan.after.startsWith('plan:')}{@render runLink(plan.after)}{/if}
          </dd>
        </div>{/if}
    </dl>
    <footer class="plan-card-footer">
      <LedgerSource source={plan.source} />
      <button
        type="button"
        class="lineage-link"
        onclick={() => onPage('lineage', { run: 'plan:' + plan.id })}
        >{$t('plans.showInLineage')}</button
      >
    </footer>
  </li>
{/snippet}

{#snippet runningCard(item: Running)}{@const bar = item.bar}{@const estimate =
    item.estimate}{@const total =
    bar?.budget != null && bar.progress != null ? Math.max(1, bar.budget - (bar.from ?? 0)) : null}
  <li class="plan-card plan-running-card">
    <header class="plan-card-header">
      <span class="plan-live" aria-hidden="true"></span>
      <Tag size="sm" type="blue">{$t('plans.lane.running')}</Tag>
    </header>
    <h4 class="plan-run-name">{@render runLink(item.id)}</h4>
    {#if bar && total !== null}<ProgressBar
        size="sm"
        labelText={$t('plans.lane.progress')}
        value={Math.min(total, Math.max(0, bar.progress! - (bar.from ?? 0)))}
        max={total}
        helperText={$t('plans.lane.progressOf', {
          progress: $number(bar.progress!),
          budget: $number(bar.budget!),
          percent: Math.round((100 * (bar.progress! - (bar.from ?? 0))) / total),
        })}
      />{:else if bar?.progress != null}<p class="lineage-muted">
        {$t('plans.lane.progressOnly', { progress: $number(bar.progress) })}
      </p>{/if}
    <dl class="plan-facts">
      {#if estimate}<div>
          <dt>{$t('plans.lane.eta')}</dt>
          <dd>
            {$t('plans.lane.endsAt', { when: when(estimate.end), wait: span(estimate.end - now) })}
          </dd>
        </div>{:else if bar}<div>
          <dt>{$t('plans.lane.eta')}</dt>
          <dd class="lineage-muted">{$t('plans.lane.noEstimate')}</dd>
        </div>{/if}
      {#if bar?.audit != null && occupancy?.metric}<div>
          <dt>{$t('plans.lane.audit')}</dt>
          <dd>
            <strong>{audit(bar.audit)}</strong>
            <span class="plan-metric" title={occupancy.metric}>{occupancy.metric}</span>
          </dd>
        </div>{/if}
      {#if bar}<div>
          <dt>{$t('plans.lane.started')}</dt>
          <dd>{when(bar.start)}</dd>
        </div>{/if}
      {#if !bar || bar.inferred}<div>
          <dt>{$t('plans.lane.gpus')}</dt>
          <dd class="lineage-muted">
            {bar ? $t('plans.lane.fromPlan') : $t('plans.lane.noCompute')}
          </dd>
        </div>{/if}
    </dl>
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

  <section class="plans-section" aria-labelledby="plans-recipe-title">
    <div class="plans-heading">
      <h2 id="plans-recipe-title">
        <StarFilled size={20} class="lineage-recipe-icon" />
        {$t('lineage.recipe.title')}
      </h2>
      {#if recipe && !promoting}<Button
          kind="tertiary"
          size="small"
          on:click={() => (promoting = true)}>{$t('plans.recipe.change')}</Button
        >{/if}
    </div>
    {#if recipe === null}<p class="lineage-muted">{$t('common.status.loading')}</p>
    {:else}<div class="recipe-layout">
        <div class="recipe-tile">
          {#if recipe.current}<p class="recipe-run">{@render runLink(recipe.current.run)}</p>
            <p class="lineage-muted">
              {$t('lineage.recipe.since', { date: $date(recipe.current.since, true) })}{recipe
                .current.by
                ? ' · ' + recipe.current.by
                : ''}
            </p>
            <p class="recipe-reason">{recipe.current.reason}</p>
            <LedgerSource source={recipe.current.source} />
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
              <TextArea
                labelText={$t('lineage.recipe.reason')}
                rows={2}
                bind:value={recipeReason}
              />
              <div class="lineage-actions">
                <Button
                  size="small"
                  disabled={busy || !recipeRun || !recipeReason.trim()}
                  on:click={setRecipe}>{$t('plans.recipe.set')}</Button
                ><Button kind="ghost" size="small" on:click={() => (promoting = false)}
                  >{$t('common.action.cancel')}</Button
                >
              </div>
            </div>{/if}
        </div>
        {#if recipe.history.length}<div class="recipe-timeline">
            <h3>{$t('plans.recipe.history', { count: recipe.history.length })}</h3>
            <ol>
              {#each recipe.history as event, index (event.id)}<li
                  aria-current={index === 0 && recipe.current?.id === event.id ? 'true' : undefined}
                >
                  <span class="recipe-timeline-date">{$date(event.since, true)}</span>
                  <span class="recipe-timeline-run">{@render runLink(event.run)}</span>
                  <span class="recipe-timeline-reason"
                    >{event.reason}{event.by ? ' · ' + event.by : ''}</span
                  >
                </li>{/each}
            </ol>
          </div>{/if}
      </div>{/if}
  </section>

  <section class="plans-section" aria-label={$t('charts.types.gpuOccupancy')}>
    {#if occupancyPlugin}<div class="plans-occupancy">
        <PanelCard
          height={timelineHeight}
          panel={{
            id: 'plans-occupancy',
            plugin: 'gpu-occupancy',
            metric: '',
            metrics: [],
            title: $t('charts.types.gpuOccupancy'),
          }}
          {runs}
          {project}
          {dark}
          {refresh}
          plugin={occupancyPlugin}
          readonly
          onopen={open}
          onedit={() => {}}
          onremove={() => {}}
          onduplicate={() => {}}
          onmove={() => {}}
        />
        <p class="plans-occupancy-help">{$t('plans.occupancy.help')}</p>
      </div>{/if}
  </section>

  <section class="plans-section" aria-labelledby="plans-queues-title">
    <div class="plans-heading">
      <h2 id="plans-queues-title">{$t('plans.queues.title')}</h2>
      <Button size="small" icon={Add} on:click={() => edit()}>{$t('plans.edit.new')}</Button>
    </div>
    {#if plans === null}<p class="lineage-muted">{$t('common.status.loading')}</p>
    {:else if !lanes.length}<p class="empty-table">{$t('plans.empty')}</p>
    {:else}<div class="plan-lanes">
        {#each lanes as lane (laneKey(lane.host, lane.slot))}<section
            class="plan-lane"
            aria-label={lane.host
              ? [lane.host, lane.slot].filter(Boolean).join(' · ')
              : $t('plans.queues.unassigned')}
          >
            <header class="plan-lane-head">
              <h3>{lane.host || $t('plans.queues.unassigned')}</h3>
              {#if lane.slot}<p class="plan-lane-slot">{lane.slot}</p>{/if}
              <p class="lineage-muted">
                {[
                  lane.gpus?.length ? $t('plans.lane.gpuList', { gpus: lane.gpus.join(', ') }) : '',
                  lane.model,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p class="lineage-muted">
                {$t('plans.lane.summary', {
                  running: lane.running.length,
                  queued: lane.planned.length,
                })}
              </p>
            </header>
            <ol class="plan-lane-cards">
              {#each lane.running as item (item.id)}{@render runningCard(item)}{/each}
              {#if !lane.running.length}<li class="plan-card plan-idle">
                  <p class="lineage-muted">{$t('plans.lane.idle')}</p>
                </li>{/if}
              {#each lane.planned as plan, index (plan.id)}{@render planCard(
                  plan,
                  index + 1,
                )}{/each}
              {#if !lane.planned.length}<li class="plan-card plan-idle">
                  <p class="lineage-muted">{$t('plans.queues.nothingQueued')}</p>
                </li>{/if}
            </ol>
          </section>{/each}
      </div>{/if}
    {#if cancelled.length}<details class="recipe-history">
        <summary>{$t('plans.cancelled', { count: cancelled.length })}</summary>
        <ol class="plan-list">
          {#each cancelled as plan (plan.id)}{@render planCard(plan, null)}{/each}
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
          translateWithId={(id) =>
            $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
          items={runItems}
          selectedId={draft.parent || undefined}
          on:select={(event) => (draft!.parent = String(event.detail.selectedId))}
          on:clear={() => (draft!.parent = '')}
        />
        <TextInput
          labelText={$t('plans.edit.parentUpdate')}
          inputmode="numeric"
          bind:value={draft.parentUpdate}
        />
      </div>
      <TextInput labelText={$t('plans.edit.change')} bind:value={draft.change} />
      <TextArea labelText={$t('lineage.panel.hypothesis')} rows={3} bind:value={draft.hypothesis} />
      <Choice
        {...choice}
        labelText={$t('lineage.plan.baseline')}
        selectionClearedText={$t('common.combobox.selectionCleared')}
        filterResultsText={(count) => resultCount(count, $t)}
        translateWithId={(id) =>
          $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
        items={runItems}
        selectedId={draft.baseline || undefined}
        on:select={(event) => (draft!.baseline = String(event.detail.selectedId))}
        on:clear={() => (draft!.baseline = '')}
      />
      <TextArea labelText={$t('lineage.plan.rule')} rows={2} bind:value={draft.rule} />
      <div class="plan-form-row">
        <TextInput labelText={$t('plans.edit.host')} bind:value={draft.host} />
        <TextInput labelText={$t('plans.edit.slot')} bind:value={draft.slot} />
        <TextInput
          labelText={$t('plans.edit.queue')}
          inputmode="numeric"
          bind:value={draft.queue}
        />
      </div>
      <div class="plan-form-row">
        <TextInput
          labelText={$t('plans.edit.gpus')}
          helperText={$t('plans.edit.gpusHelp')}
          invalid={!gpusValid}
          invalidText={$t('plans.edit.gpusInvalid')}
          bind:value={draft.gpus}
        />
        <TextInput
          labelText={$t('plans.edit.updates')}
          helperText={$t('plans.edit.updatesHelp')}
          inputmode="numeric"
          invalid={!updatesValid}
          bind:value={draft.updates}
        />
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
          {#if draft.status === 'planned'}<Button
              kind="ghost"
              size="small"
              on:click={() => save('cancelled')}>{$t('plans.edit.cancelPlan')}</Button
            >{:else}<Button kind="ghost" size="small" on:click={() => save('planned')}
              >{$t('plans.edit.restorePlan')}</Button
            >{/if}
          <Button kind="danger-ghost" size="small" on:click={remove}
            >{$t('plans.edit.delete')}</Button
          >
        </div>{/if}
    </div>
  </Modal>{/if}
