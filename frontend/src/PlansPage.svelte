<script lang="ts">
  // A project's current state (README "Experiment ledger"): the best recipe and how it got
  // there, the GPUs of each host over time (the `gpu-occupancy` panel), and one lane per host
  // slot with the run occupying it and the planned runs queued behind it.
  import RunName from './RunName.svelte';
  import { onMount, tick } from 'svelte';
  import {
    Button,
    InlineNotification,
    Modal,
    ProgressBar,
    Search,
    Select,
    SelectItem,
    Tag,
    TextArea,
    TextInput,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import ArrowLeft from 'carbon-icons-svelte/lib/ArrowLeft.svelte';
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte';
  import StarFilled from 'carbon-icons-svelte/lib/StarFilled.svelte';
  import RecentlyViewed from 'carbon-icons-svelte/lib/RecentlyViewed.svelte';
  import Choice from './Choice.svelte';
  import LedgerSource from './LedgerSource.svelte';
  import PanelCard from './Panel.svelte';
  import PageRail from './PageRail.svelte';
  import { runColors } from './run-name';

  import { tool, apiMessage } from './api';
  import { t, number, date, locale, type Message, type MessageKey } from './i18n';
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
    rail,
    narrow = false,
  }: {
    /** A phone-width window: buttons show as icons. */
    narrow?: boolean;
    /** The header rail for the page's controls (PageRail.svelte), on wide screens. */
    rail?: HTMLElement;
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
      plans = planned.plans;
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
    if (past.includes(plan)) {
      showHistory(plan.id);
      return;
    }
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
    /** Claimed by a supervisor, its run not logged yet. */
    claimed: Plan[];
    /** Waiting, in queue order. */
    planned: Plan[];
  };
  const laneKey = (host: string, slot: string) => host + '\u0000' + slot;
  // The lanes, and the plans that are over (done, stopped, cancelled, and started plans whose
  // run is not running in a lane), which the history shows.
  let board = $derived.by(() => {
    const groups = new Map<string, Lane>(),
      past: Plan[] = [];
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
            claimed: [],
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
    for (const plan of plans ?? []) {
      const open = plan.status === 'planned' || (plan.status === 'started' && !plan.run);
      // A slot keeps its lane while only its past plans name it, so plans can move to it.
      const lane =
        open || plan.host
          ? group(plan.host, plan.slot)
          : (groups.get(laneKey('', '')) ?? group('', ''));
      if (plan.status === 'planned') {
        lane.planned.push(plan);
        lane.gpus ??= scheduled.get(plan.id)?.gpus ?? null;
      } else if (plan.status === 'started' && !plan.run) lane.claimed.push(plan);
      else if (!(plan.status === 'started' && lane.running.some((run) => run.id === plan.run)))
        past.push(plan);
    }
    past.sort((a, b) => ended(b) - ended(a));
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
    // Lanes with work first, then lanes without a host last.
    const busy = (lane: Lane) => lane.running.length + lane.claimed.length + lane.planned.length;
    const lanes = [...groups.values()]
      .filter((lane) => lane.host || lane.slot || busy(lane))
      .sort(
        (a, b) =>
          Number(!busy(a)) - Number(!busy(b)) ||
          Number(!a.host) - Number(!b.host) ||
          a.host.localeCompare(b.host, undefined, { sensitivity: 'base', numeric: true }) ||
          a.slot.localeCompare(b.slot, undefined, { numeric: true }),
      );
    return { lanes, past };
  });
  let lanes = $derived(board.lanes),
    past = $derived(board.past);
  /** When a plan ended: when its run last reported, else its last change of status. */
  const ended = (plan: Plan) => {
    const run = plan.run ? runById.get(plan.run) : undefined;
    return (
      run?.finished ??
      run?.heartbeat ??
      [...(plan.events ?? [])].reverse().find((event) => event.status === plan.status)?.at ??
      plan.updated
    );
  };

  // History: the plans that are over, searched and filtered, in a list beside the one read.
  type PastStatus = 'all' | 'done' | 'stopped' | 'cancelled' | 'started';
  let historyOpen = $state(false),
    historyStatus = $state<PastStatus>('all'),
    historyLane = $state(''),
    historySearch = $state(''),
    historyPick = $state(''),
    historyLimit = $state(100),
    // Editing a plan from the history comes back to it.
    reopenHistory = $state(false);
  function showHistory(id = '') {
    historyStatus = 'all';
    historyLane = '';
    historySearch = '';
    historyLimit = 100;
    historyPick = id;
    historyOpen = true;
    if (id) {
      const at = past.findIndex((plan) => plan.id === id);
      historyLimit = Math.max(100, at + 1);
    }
  }
  $effect(() => {
    if (!draft && reopenHistory) {
      reopenHistory = false;
      historyOpen = true;
    }
  });
  const pastLanes = $derived.by(() => {
    const counts = new Map<string, { host: string; slot: string; count: number }>();
    for (const plan of past) {
      const key = laneKey(plan.host, plan.slot),
        entry = counts.get(key) ?? { host: plan.host, slot: plan.slot, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    return [...counts.entries()]
      .map(([key, entry]) => ({ key, ...entry }))
      .sort(
        (a, b) =>
          a.host.localeCompare(b.host, undefined, { numeric: true }) ||
          a.slot.localeCompare(b.slot, undefined, { numeric: true }),
      );
  });
  /** The past plans the search and slot match, before the status filter. */
  const pastMatches = $derived.by(() => {
    const words = historySearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return past.filter((plan) => {
      if (historyLane && laneKey(plan.host, plan.slot) !== historyLane) return false;
      if (!words.length) return true;
      const text = [
        plan.id,
        plan.name,
        plan.change,
        plan.hypothesis,
        plan.rule,
        plan.host,
        plan.slot,
        plan.run ? (runById.get(plan.run)?.display_name ?? plan.run) : '',
      ]
        .join(' ')
        .toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });
  const pastStatuses = ['done', 'stopped', 'cancelled', 'started'] as const;
  const pastCounts = $derived(
    Object.fromEntries(
      pastStatuses.map((status) => [
        status,
        pastMatches.filter((plan) => plan.status === status).length,
      ]),
    ) as Record<(typeof pastStatuses)[number], number>,
  );
  const pastShown = $derived(
    historyStatus === 'all'
      ? pastMatches
      : pastMatches.filter((plan) => plan.status === historyStatus),
  );
  /** The shown plans by month of their end, latest first. */
  const pastMonths = $derived.by(() => {
    const format = new Intl.DateTimeFormat($locale, { month: 'long', year: 'numeric' }),
      months: { label: string; plans: Plan[] }[] = [];
    for (const plan of pastShown.slice(0, historyLimit)) {
      const label = format.format(new Date(ended(plan) * 1000));
      if (months.at(-1)?.label !== label) months.push({ label, plans: [] });
      months.at(-1)!.plans.push(plan);
    }
    return months;
  });
  // On wide screens the first plan shown is read until another is chosen.
  const picked = $derived(
    pastShown.find((plan) => plan.id === historyPick) ?? (narrow ? null : (pastShown[0] ?? null)),
  );
  // Keyboard: arrows move through the list, Home and End to its ends.
  function historyKey(event: KeyboardEvent) {
    const list = pastShown.slice(0, historyLimit),
      at = list.findIndex((plan) => plan.id === picked?.id);
    let next = -1;
    if (event.key === 'ArrowDown') next = Math.min(list.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else return;
    event.preventDefault();
    if (next < 0) return;
    historyPick = list[next].id;
    void tick().then(() =>
      document
        .querySelector<HTMLElement>(`.plan-history-row[data-plan="${CSS.escape(historyPick)}"]`)
        ?.focus(),
    );
  }
  /** What a plan's timeline calls each of its events. */
  const eventLabels: Record<string, MessageKey> = {
    planned: 'plans.status.planned',
    started: 'plans.status.started',
    done: 'plans.status.done',
    stopped: 'plans.status.stopped',
    cancelled: 'plans.status.cancelled',
    claimed: 'plans.status.claimed',
    claim_expired: 'plans.history.event.claimExpired',
    moved: 'plans.history.event.moved',
  };
  /** Each open plan's estimated time on the timeline. */
  let scheduled = $derived(
    new Map(
      (occupancy?.bars ?? [])
        .filter((bar) => bar.kind === 'planned' && bar.plan)
        .map((bar) => [bar.plan!, bar]),
    ),
  );
  const planStatusLabels = {
    planned: 'plans.status.planned',
    started: 'plans.status.started',
    done: 'plans.status.done',
    stopped: 'plans.status.stopped',
    cancelled: 'plans.status.cancelled',
  } as const;
  const statusTag = (plan: Plan) =>
    plan.status === 'started'
      ? plan.run
        ? 'blue'
        : 'purple'
      : plan.status === 'done'
        ? 'green'
        : plan.status === 'stopped'
          ? 'magenta'
          : 'gray';
  // Reordering: drag a waiting plan before or after another, or to the end of a lane; the
  // Earlier and Later buttons do the same from the keyboard.
  let dragging = $state(''),
    dropAt = $state<{ id: string; side: 'before' | 'after' } | { lane: string } | null>(null);
  async function move(id: string, lane: Lane, place: { before?: string; after?: string } = {}) {
    try {
      await tool('plan_move', { project, id, slot: lane.slot, host: lane.host, ...place });
      await changed();
    } catch (reason) {
      error = apiMessage(reason);
    }
  }
  function dragOver(event: DragEvent, lane: Lane, target?: Plan) {
    if (!dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (!target) {
      dropAt = { lane: laneKey(lane.host, lane.slot) };
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = { id: target.id, side: event.clientX < box.left + box.width / 2 ? 'before' : 'after' };
  }
  function drop(event: DragEvent, lane: Lane) {
    event.preventDefault();
    const id = dragging,
      at = dropAt;
    dragging = '';
    dropAt = null;
    if (!id || !at) return;
    if ('id' in at) {
      if (at.id !== id) void move(id, lane, { [at.side]: at.id });
    } else void move(id, lane);
  }
  const shift = (lane: Lane, plan: Plan, step: number) => {
    const at = lane.planned.indexOf(plan),
      other = lane.planned[at + step];
    if (other) void move(plan.id, lane, step < 0 ? { before: other.id } : { after: other.id });
  };
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
    config_yaml: string;
    resume_run: string;
    config: string;
    status: Plan['status'];
    /** Claimed by a supervisor, its run not logged yet. */
    claimed: boolean;
    created: boolean;
  };
  let draft = $state<Draft | null>(null),
    editError = $state<Message>(''),
    saving = $state(false);
  function edit(plan?: Plan) {
    editError = '';
    if (historyOpen) {
      historyOpen = false;
      reopenHistory = true;
    }
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
          config_yaml: plan.config_yaml ?? '',
          resume_run: plan.resume_run ?? '',
          config: plan.config === null ? '' : JSON.stringify(plan.config, null, 2),
          status: plan.status,
          claimed: !!plan.claim && !plan.run,
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
          config_yaml: '',
          resume_run: '',
          config: '',
          status: 'planned',
          claimed: false,
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
        // Sent as typed: the supervisor writes it byte for byte.
        config_yaml: draft.config_yaml ? draft.config_yaml : null,
        resume_run: draft.resume_run || null,
        config: draft.config.trim() ? JSON.parse(draft.config) : null,
        // Callers set planned or cancelled; the server keeps started, done and stopped.
        ...(status
          ? { status }
          : draft.status === 'planned' || draft.status === 'cancelled'
            ? { status: draft.status }
            : {}),
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

{#snippet runLink(id: string)}{@const run = runById.get(id)}{#if run}<RunName
      id={run.id}
      name={run.display_name}
      href={runURL(run)}
      onclick={(event) => interceptLink(event, () => onRun(run))}
    />{:else}<RunName {id} name={id} />{/if}{/snippet}

{#snippet planCard(plan: Plan, position: number | null, lane?: Lane)}{@const at = scheduled.get(
    plan.id,
  )}{@const movable = !!lane && plan.status === 'planned'}
  <li
    class="plan-card status-{plan.status}"
    class:dragging={dragging === plan.id}
    class:drop-before={dropAt &&
      'id' in dropAt &&
      dropAt.id === plan.id &&
      dropAt.side === 'before'}
    class:drop-after={dropAt && 'id' in dropAt && dropAt.id === plan.id && dropAt.side === 'after'}
    id={'plan-' + plan.id}
    draggable={movable ? 'true' : undefined}
    ondragstart={movable
      ? (event) => {
          dragging = plan.id;
          event.dataTransfer?.setData('text/plain', plan.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        }
      : undefined}
    ondragend={() => {
      dragging = '';
      dropAt = null;
    }}
    ondragover={lane && plan.status === 'planned'
      ? (event) => dragOver(event, lane, plan)
      : undefined}
    ondrop={lane ? (event) => drop(event, lane) : undefined}
  >
    <header class="plan-card-header">
      {#if position !== null}<span
          class="plan-position"
          title={$t('plans.lane.position', { position })}>{position}</span
        >{/if}
      <h4>{plan.name}</h4>
      {#if plan.status !== 'planned'}<Tag size="sm" type={statusTag(plan)}
          >{$t(
            plan.status === 'started' && !plan.run
              ? 'plans.status.claimed'
              : planStatusLabels[plan.status],
          )}</Tag
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
    {#if plan.claim && !plan.run}<p class="plan-when">
        {$t('plans.lane.claimedBy', {
          by: plan.claim.by || '–',
          host: plan.claim.host || '–',
          when: when(plan.claim.at),
        })}
      </p>{/if}
    {#if plan.run && plan.status !== 'planned'}<p class="plan-when">
        {@render runLink(plan.run)}
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
      {#if plan.resume_run}<div>
          <dt>{$t('plans.edit.resumeRun')}</dt>
          <dd>{@render runLink(plan.resume_run)}</dd>
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
      {#if movable && lane}<span class="plan-move"
          ><Button
            kind="ghost"
            size="small"
            icon={ArrowLeft}
            iconDescription={$t('plans.move.earlier')}
            tooltipPosition="top"
            disabled={lane.planned[0] === plan}
            on:click={() => shift(lane, plan, -1)}
          /><Button
            kind="ghost"
            size="small"
            icon={ArrowRight}
            iconDescription={$t('plans.move.later')}
            tooltipPosition="top"
            disabled={lane.planned.at(-1) === plan}
            on:click={() => shift(lane, plan, 1)}
          /></span
        >{/if}
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

<PageRail target={rail} label={$t('plans.controls')}>
  <span class="page-rail-end"
    >{#if narrow}<Button
        kind="ghost"
        size="small"
        icon={RecentlyViewed}
        iconDescription={$t('plans.history.openCount', { count: past.length })}
        tooltipPosition="bottom"
        aria-haspopup="dialog"
        on:click={() => showHistory()}
      />{:else}<Button
        kind="ghost"
        size="small"
        icon={RecentlyViewed}
        aria-haspopup="dialog"
        on:click={() => showHistory()}
        >{$t('plans.history.open')}<span class="plan-history-count">{$number(past.length)}</span
        ></Button
      >{/if}{#if narrow}<Button
        size="small"
        icon={Add}
        iconDescription={$t('plans.edit.new')}
        tooltipPosition="bottom"
        tooltipAlignment="end"
        on:click={() => edit()}
      />{:else}<Button size="small" icon={Add} on:click={() => edit()}
        >{$t('plans.edit.new')}</Button
      >{/if}</span
  >
</PageRail>
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
          colors={$runColors}
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
            <ol
              class="plan-lane-cards"
              class:drop-end={dropAt &&
                'lane' in dropAt &&
                dropAt.lane === laneKey(lane.host, lane.slot)}
              ondragover={(event) => {
                if ((event.target as Element).closest('.plan-card.status-planned')) return;
                dragOver(event, lane);
              }}
              ondrop={(event) => drop(event, lane)}
            >
              {#each lane.running as item (item.id)}{@render runningCard(item)}{/each}
              {#each lane.claimed as plan (plan.id)}{@render planCard(plan, null, lane)}{/each}
              {#if !lane.running.length && !lane.claimed.length}<li class="plan-card plan-idle">
                  <p class="lineage-muted">{$t('plans.lane.idle')}</p>
                </li>{/if}
              {#each lane.planned as plan, index (plan.id)}{@render planCard(
                  plan,
                  index + 1,
                  lane,
                )}{/each}
              {#if !lane.planned.length}<li class="plan-card plan-idle">
                  <p class="lineage-muted">{$t('plans.queues.nothingQueued')}</p>
                </li>{/if}
            </ol>
          </section>{/each}
      </div>{/if}
  </section>
</div>

{#if historyOpen}<Modal
    open
    passiveModal
    size="lg"
    class="plan-history-modal"
    iconDescription={$t('common.action.close')}
    modalHeading={$t('plans.history.title')}
    on:close={() => (historyOpen = false)}
  >
    <div class="plan-history-toolbar">
      <Search
        size="sm"
        labelText={$t('plans.history.search')}
        placeholder={$t('plans.history.search')}
        closeButtonLabelText={$t('common.search.clear')}
        bind:value={historySearch}
      />
      {#if pastLanes.length > 1}<Select
          size="sm"
          inline
          hideLabel
          labelText={$t('plans.history.slot')}
          selected={historyLane}
          on:change={(event) => (historyLane = (event.target as HTMLSelectElement).value)}
          ><SelectItem
            value=""
            text={$t('plans.history.allSlots')}
          />{#each pastLanes as lane (lane.key)}<SelectItem
              value={lane.key}
              text={[lane.host || $t('plans.queues.unassigned'), lane.slot]
                .filter(Boolean)
                .join(' · ') +
                ' (' +
                $number(lane.count) +
                ')'}
            />{/each}</Select
        >{/if}
    </div>
    <div class="plan-history-filter" role="group" aria-label={$t('plans.history.status')}>
      {#each ['all', ...pastStatuses] as status (status)}{@const count =
          status === 'all' ? pastMatches.length : pastCounts[status as keyof typeof pastCounts]}
        {#if status === 'all' || count}<button
            type="button"
            class="plan-history-chip status-{status}"
            aria-pressed={historyStatus === status}
            onclick={() => (historyStatus = status as PastStatus)}
            >{#if status !== 'all'}<span class="plan-history-dot status-{status}"></span>{/if}{$t(
              status === 'all'
                ? 'plans.history.all'
                : planStatusLabels[status as keyof typeof planStatusLabels],
            )}<span class="plan-history-chip-count">{$number(count)}</span></button
          >{/if}{/each}
    </div>
    {#if !past.length}<p class="empty-table">{$t('plans.history.empty')}</p>
    {:else if !pastShown.length}<p class="empty-table">{$t('plans.history.noMatches')}</p>
    {:else}<div class="plan-history-layout" class:reading={!!picked}>
        {#if !narrow || !picked}<div
            class="plan-history-list"
            role="listbox"
            tabindex="-1"
            aria-label={$t('plans.history.list')}
            onkeydown={historyKey}
          >
            {#each pastMonths as month (month.label)}<div role="presentation">
                <p class="plan-history-month" role="presentation">{month.label}</p>
                {#each month.plans as plan (plan.id)}<button
                    type="button"
                    role="option"
                    class="plan-history-row"
                    data-plan={plan.id}
                    aria-selected={plan.id === picked?.id}
                    tabindex={plan.id === (picked ?? pastShown[0]).id ? 0 : -1}
                    onclick={() => (historyPick = plan.id)}
                  >
                    <span
                      class="plan-history-dot status-{plan.status}"
                      title={$t(planStatusLabels[plan.status])}
                    ></span>
                    <span class="plan-history-name">{plan.name}</span>
                    <span class="plan-history-meta"
                      >{$t(planStatusLabels[plan.status])} · {[plan.host, plan.slot]
                        .filter(Boolean)
                        .join(' · ') || $t('plans.queues.unassigned')} · {$date(
                        ended(plan),
                        true,
                      )}</span
                    >
                    {#if plan.change}<span class="plan-history-change">{plan.change}</span>{/if}
                  </button>{/each}
              </div>{/each}
            {#if pastShown.length > historyLimit}<Button
                kind="ghost"
                size="small"
                on:click={() => (historyLimit += 100)}
                >{$t('plans.history.showMore', {
                  count: Math.min(100, pastShown.length - historyLimit),
                  total: pastShown.length - historyLimit,
                })}</Button
              >{/if}
          </div>{/if}
        {#if picked}<div class="plan-history-reader">
            {#if narrow}<button
                type="button"
                class="lineage-link plan-history-back"
                onclick={() => (historyPick = '')}
                ><ArrowLeft size={16} />{$t('plans.history.back')}</button
              >{/if}
            <ul class="plan-history-card">{@render planCard(picked, null)}</ul>
            {#if picked.events?.length}<section class="plan-history-events">
                <h4>{$t('plans.history.timeline')}</h4>
                <ol>
                  {#each [...picked.events].reverse() as event, index (index)}<li>
                      <span class="plan-history-dot status-{event.status}"></span>
                      <span class="plan-history-event-what"
                        >{$t(eventLabels[event.status] ?? 'plans.history.event.changed')}{event.note
                          ? ' · ' + event.note
                          : ''}</span
                      >
                      <span class="lineage-muted"
                        >{$date(event.at)}{event.by ? ' · ' + event.by : ''}</span
                      >
                      {#if event.run}<span class="plan-history-event-run"
                          >{@render runLink(event.run)}</span
                        >{/if}
                    </li>{/each}
                </ol>
              </section>{/if}
          </div>{:else if !narrow}<p class="plan-history-reader lineage-muted">
            {$t('plans.history.pick')}
          </p>{/if}
      </div>{/if}
  </Modal>{/if}

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
      <TextArea
        labelText={$t('plans.edit.configYaml')}
        helperText={$t('plans.edit.configYamlHelp')}
        rows={8}
        class="plan-config-yaml"
        bind:value={draft.config_yaml}
      />
      <Choice
        {...choice}
        labelText={$t('plans.edit.resumeRun')}
        helperText={$t('plans.edit.resumeRunHelp')}
        selectionClearedText={$t('common.combobox.selectionCleared')}
        filterResultsText={(count) => resultCount(count, $t)}
        translateWithId={(id) =>
          $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
        items={runItems}
        selectedId={draft.resume_run || undefined}
        on:select={(event) => (draft!.resume_run = String(event.detail.selectedId))}
        on:clear={() => (draft!.resume_run = '')}
      />
      {#if draft.created}<div class="lineage-actions">
          {#if draft.status === 'planned'}<Button
              kind="ghost"
              size="small"
              on:click={() => save('cancelled')}>{$t('plans.edit.cancelPlan')}</Button
            >{:else if draft.status === 'cancelled'}<Button
              kind="ghost"
              size="small"
              on:click={() => save('planned')}>{$t('plans.edit.restorePlan')}</Button
            >{:else if draft.status === 'started' && draft.claimed}<Button
              kind="ghost"
              size="small"
              on:click={() => save('planned')}>{$t('plans.edit.releaseClaim')}</Button
            >{/if}
          <Button kind="danger-ghost" size="small" on:click={remove}
            >{$t('plans.edit.delete')}</Button
          >
        </div>{/if}
    </div>
  </Modal>{/if}
