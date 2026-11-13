<script lang="ts">
  // A project's current state (docs/guides/planning.md): the best recipe and how it
  // got there, the GPUs of each host over time with the queue's projected future (the
  // `gpu-occupancy` panel), the queue every host takes plans from, and the ideas not yet
  // planned (PlanIdeas.svelte).
  import RunName from './RunName.svelte';
  import { onMount, tick } from 'svelte';
  import {
    Button,
    Checkbox,
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
  import ArrowUp from 'carbon-icons-svelte/lib/ArrowUp.svelte';
  import ArrowDown from 'carbon-icons-svelte/lib/ArrowDown.svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import PlanIdeas from './PlanIdeas.svelte';
  import SideDrawer from './SideDrawer.svelte';
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
  import type { GpuRequest, Idea, InventoryGpu, Plan, RecipeEvent } from './lineage-graph';
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
    inventory = $state<{ host: string; gpus: InventoryGpu[] }[]>([]),
    ideas = $state<Idea[] | null>(null),
    findings = $state<{ id: string; title: string; status: string }[]>([]),
    error = $state<Message>(''),
    // Reloads the timeline panel after a change here.
    refresh = $state(0);
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));

  async function load() {
    try {
      const [planned, best, timeline, backlog, notes, gpus] = await Promise.all([
        tool('plans_list', { project }),
        tool('recipe_get', { project }),
        tool('project_occupancy', { project }),
        tool('idea_list', { project }),
        tool('findings_list', { project }),
        tool('gpus_list', { project }),
      ]);
      plans = planned.plans;
      inventory = gpus.hosts;
      ideas = backlog.ideas;
      findings = notes.findings.map((finding: { id: string; title: string; status: string }) => ({
        id: finding.id,
        title: finding.title,
        status: finding.status,
      }));
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

  // The timeline panel is as tall as its rows (every host's GPUs, overlap lanes and rows for
  // runs that logged no GPUs), at least 280 px: the page scrolls, the panel only sideways.
  // An estimate first, then the panel grows by whatever its drawn rows still overflow.
  let occupancyPlugin = $derived(plugins.find((plugin) => plugin.id === 'gpu-occupancy'));
  let occupancyBox = $state<HTMLElement>(),
    fittedHeight = $state<number | null>(null);
  let timelineHeight = $derived.by(() => {
    if (fittedHeight !== null) return fittedHeight;
    const rows = occupancy?.hosts.reduce((sum, host) => sum + host.rows.length, 0) ?? 8,
      hosts = occupancy?.hosts.length ?? 3;
    return Math.max(280, 34 + hosts * 30 + rows * 26 + 140);
  });
  $effect(() => {
    const box = occupancyBox;
    if (!box) return;
    let watched: Element | null = null;
    const fit = () => {
      const panel = box.querySelector<HTMLElement>('[data-panel-id="plans-occupancy"]'),
        scroller = box.querySelector<HTMLElement>('.occupancy-scroll'),
        content = box.querySelector<HTMLElement>('.occupancy-content');
      if (!panel || !scroller || !content) return;
      const next = Math.max(
        280,
        Math.ceil(panel.offsetHeight + content.offsetHeight - scroller.clientHeight),
      );
      if (Math.abs(next - panel.offsetHeight) > 1) fittedHeight = next;
    };
    const sizes = new ResizeObserver(fit),
      changes = new MutationObserver(() => {
        const content = box.querySelector('.occupancy-content');
        if (content && content !== watched) {
          watched = content;
          sizes.observe(content);
        }
        fit();
      });
    changes.observe(box, { childList: true, subtree: true });
    return () => {
      sizes.disconnect();
      changes.disconnect();
    };
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

  // The queue: one for every host. The runs training now, the plans host agents have claimed
  // GPUs for, then the waiting plans in the order the allocator takes them, each with its GPU
  // request and where and when the projection (the timeline's future) starts it.
  type Running = { id: string; name: string; bar: Bar | null; estimate: Bar | null };
  const laneKey = (host: string, slot: string) => host + '\u0000' + slot;
  // The queue, and the plans that are over (done, stopped, cancelled, and started plans whose
  // run is not running), which the history shows.
  let board = $derived.by(() => {
    const running: Running[] = [],
      claimed: Plan[] = [],
      waiting: Plan[] = [],
      past: Plan[] = [];
    const bars = occupancy?.bars ?? [];
    if (occupancy)
      for (const bar of bars.filter((item) => item.kind === 'running' && item.run))
        running.push({
          id: bar.run!,
          name: bar.name,
          bar,
          estimate: bars.find((item) => item.run === bar.run && item.kind === 'remaining') ?? null,
        });
    else for (const run of occupants) running.push({ ...run, bar: null, estimate: null });
    // Running runs that log no compute block, so their GPUs are unknown.
    for (const run of occupancy?.unplaced ?? [])
      running.push({ id: run.id, name: run.name, bar: null, estimate: null });
    const live = new Set(running.map((run) => run.id));
    for (const plan of plans ?? []) {
      if (plan.status === 'planned') waiting.push(plan);
      else if (plan.status === 'started' && !plan.run) claimed.push(plan);
      else if (!(plan.status === 'started' && plan.run && live.has(plan.run))) past.push(plan);
    }
    past.sort((a, b) => ended(b) - ended(a));
    // A plan's place: its queue position, else just behind what it is queued after; plans
    // placed neither way go last. This is the order host agents claim them in.
    const byId = new Map((plans ?? []).map((plan) => [plan.id, plan]));
    const rank = (plan: Plan, seen = new Set<string>()): number => {
      if (plan.queue !== null) return plan.queue;
      if (!plan.after || seen.has(plan.id)) return Infinity;
      seen.add(plan.id);
      const before = byId.get(plan.after.replace(/^plan:/, ''));
      return before ? rank(before, seen) + 0.5 : 0.5;
    };
    waiting.sort((a, b) => rank(a) - rank(b) || a.created - b.created || a.id.localeCompare(b.id));
    running.sort((a, b) => (a.estimate?.end ?? Infinity) - (b.estimate?.end ?? Infinity));
    return { running, claimed, waiting, past };
  });
  /** The plan a running run carries out. */
  const planOfRun = (id: string) => plans?.find((plan) => plan.run === id) ?? null;
  // Rows open to their details.
  let expanded = $state<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    expanded = next;
  };
  let queue = $derived(board),
    past = $derived(board.past);
  /** Each GPU of each host now: free, held by a running run or a claimed plan, or reserved. */
  let inventoryNow = $derived.by(() => {
    const holders = new Map<string, { kind: 'running' | 'claimed'; name: string }>(),
      next = new Map<string, { name: string; start: number }>();
    for (const bar of occupancy?.bars ?? []) {
      if (bar.kind === 'running')
        for (const gpu of bar.gpus ?? [])
          holders.set(bar.host + '/' + gpu, { kind: 'running', name: bar.name });
      if (bar.kind === 'planned' && bar.claimed)
        for (const gpu of bar.gpus ?? [])
          holders.set(bar.host + '/' + gpu, { kind: 'claimed', name: bar.name });
      if (bar.kind === 'planned' && !bar.claimed)
        for (const gpu of bar.gpus ?? []) {
          const key = bar.host + '/' + gpu;
          if (!next.has(key) || next.get(key)!.start > bar.start)
            next.set(key, { name: bar.name, start: bar.start });
        }
    }
    return [...inventory]
      .sort(
        (a, b) =>
          Number(!a.gpus.some((gpu) => gpu.allowed)) - Number(!b.gpus.some((gpu) => gpu.allowed)),
      )
      .map((host) => {
        const gpus = host.gpus.map((gpu) => {
          const key = host.host + '/' + gpu.gpu,
            holder = holders.get(key);
          return {
            ...gpu,
            state: !gpu.allowed ? 'reserved' : (holder?.kind ?? 'free'),
            holder: holder?.name ?? null,
            next: next.get(key) ?? null,
          };
        });
        const models = [...new Set(host.gpus.map((gpu) => gpu.model).filter(Boolean))],
          memory = [...new Set(host.gpus.map((gpu) => gpu.memory_gb).filter((value) => value))];
        return {
          host: host.host,
          gpus,
          summary: [models.join(', '), memory.map((value) => $number(value!) + ' GB').join(', ')]
            .filter(Boolean)
            .join(' · '),
          free: gpus.filter((gpu) => gpu.state === 'free').length,
          reserved: gpus.every((gpu) => gpu.state === 'reserved'),
        };
      });
  });
  const gpuStateLabels: Record<string, MessageKey> = {
    free: 'plans.gpus.state.free',
    running: 'plans.gpus.state.running',
    claimed: 'plans.gpus.state.claimed',
    reserved: 'plans.gpus.state.reserved',
  };
  /** Why a plan fits no host (plan-queue.ts `unfitReason`). */
  const unfitLabels: Record<string, MessageKey> = {
    'no-inventory': 'plans.gpus.unfit.noInventory',
    'no-host': 'plans.gpus.unfit.noHost',
    'too-few': 'plans.gpus.unfit.tooFew',
    waits: 'plans.gpus.unfit.waits',
  };
  /** Plans no host can run, and why. */
  let unfit = $derived(new Map((occupancy?.unfit ?? []).map((item) => [item.id, item.reason])));
  /** What else is running or projected to run while a plan starts: its company. */
  const alongside = (bar: Bar) =>
    (occupancy?.bars ?? [])
      .filter(
        (other) =>
          other !== bar &&
          (other.kind === 'remaining' || other.kind === 'planned') &&
          other.start <= bar.start + 60 &&
          other.end > bar.start + 60 &&
          (other.run ?? other.plan) !== bar.plan,
      )
      .map((other) => other.name);
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
  // Reordering: drag a waiting plan above or below another, or to the end of the queue; the
  // Earlier and Later buttons do the same from the keyboard.
  let dragging = $state(''),
    dropAt = $state<{ id: string; side: 'before' | 'after' } | 'end' | null>(null);
  async function move(id: string, place: { before?: string; after?: string } = {}) {
    try {
      await tool('plan_move', { project, id, ...place });
      await changed();
    } catch (reason) {
      error = apiMessage(reason);
    }
  }
  function dragOver(event: DragEvent, target?: Plan) {
    if (!dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (!target) {
      dropAt = 'end';
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = { id: target.id, side: event.clientY < box.top + box.height / 2 ? 'before' : 'after' };
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    const id = dragging,
      at = dropAt;
    dragging = '';
    dropAt = null;
    if (!id || !at) return;
    if (at !== 'end') {
      if (at.id !== id) void move(id, { [at.side]: at.id });
    } else void move(id);
  }
  const shift = (plan: Plan, step: number) => {
    const list = queue.waiting,
      at = list.indexOf(plan),
      other = list[at + step];
    if (other) void move(plan.id, step < 0 ? { before: other.id } : { after: other.id });
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
  /** A time in a queue row: weekday and clock within the week, else the date too. */
  const clock = (seconds: number) =>
    new Intl.DateTimeFormat($locale, {
      weekday: 'short',
      ...(Math.abs(seconds - now) > 6 * 86400 ? { month: 'short', day: 'numeric' } : {}),
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
  let promotionsOpen = $state(false),
    promoting = $state(false),
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

  // Editing one plan, or a new one, or one promoted from an idea.
  type Draft = {
    id: string;
    name: string;
    parent: string;
    parentUpdate: string;
    hypothesis: string;
    change: string;
    baseline: string;
    rule: string;
    /** The GPU request: how many, at least how much memory, which model, on which hosts. */
    gpuCount: string;
    minMemory: string;
    model: string;
    hosts: string[];
    queue: string;
    updates: string;
    estimatedHours: string;
    config_yaml: string;
    /** The config file as loaded: sent again only when edited, so its bytes stay as they are. */
    configYamlLoaded: string;
    resume_run: string;
    config: string;
    status: Plan['status'];
    /** Claimed by a host agent, its run not logged yet. */
    claimed: boolean;
    created: boolean;
    /** Promoting this idea: saving makes the plan from it. */
    fromIdea: string | null;
  };
  let draft = $state<Draft | null>(null),
    editError = $state<Message>(''),
    saving = $state(false);
  /** The hosts and GPU models the inventory lists, for the request's choices. */
  let inventoryHosts = $derived(
    inventory.filter((host) => host.gpus.some((gpu) => gpu.allowed)).map((host) => host.host),
  );
  let inventoryModels = $derived([
    ...new Set(inventory.flatMap((host) => host.gpus.map((gpu) => gpu.model)).filter(Boolean)),
  ]);
  const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
  /** A draft from a plan, or from the plan fields an idea keeps. */
  function draftOf(plan: Partial<Plan> & Record<string, unknown>, created: boolean): Draft {
    const yaml = text(plan.config_yaml),
      request = (plan.resources as GpuRequest | null | undefined) ?? null;
    return {
      id: text(plan.id),
      name: text(plan.name),
      parent: text(plan.parent),
      parentUpdate: text(plan.parentUpdate),
      hypothesis: text(plan.hypothesis),
      change: text(plan.change),
      baseline: text(plan.baseline),
      rule: text(plan.rule),
      gpuCount: text(request?.gpus ?? 1),
      minMemory: text(request?.min_memory_gb),
      model: text(request?.model),
      hosts: [...(request?.hosts ?? [])],
      queue: text(plan.queue),
      updates: text(plan.updates),
      estimatedHours: text(plan.estimated_hours),
      config_yaml: yaml,
      configYamlLoaded: created ? yaml : '',
      resume_run: text(plan.resume_run),
      config: plan.config ? JSON.stringify(plan.config, null, 2) : '',
      status: plan.status ?? 'planned',
      claimed: !!plan.claim && !plan.run,
      created,
      fromIdea: null,
    };
  }
  function edit(plan?: Plan) {
    editError = '';
    if (historyOpen) {
      historyOpen = false;
      reopenHistory = true;
    }
    draft = draftOf(plan ?? {}, !!plan);
  }
  /** Opens the editor on a plan made from an idea; saving promotes the idea. */
  function promote(idea: Idea) {
    editError = '';
    const kept = idea.draft ?? {};
    draft = {
      ...draftOf(
        {
          ...kept,
          id: text(kept.from_plan) || idea.id,
          name: text(kept.name) || idea.id,
          hypothesis: text(kept.hypothesis) || idea.hypothesis,
        } as Partial<Plan> & Record<string, unknown>,
        false,
      ),
      fromIdea: idea.id,
    };
  }
  const numberOrNull = (text: string) => (text.trim() ? Number(text) : null);
  let countValid = $derived(
    !!draft &&
      Number.isInteger(Number(draft.gpuCount)) &&
      Number(draft.gpuCount) >= 1 &&
      Number(draft.gpuCount) <= 64,
  );
  let memoryValid = $derived(
    !draft?.minMemory.trim() ||
      (Number.isFinite(Number(draft.minMemory)) && Number(draft.minMemory) >= 0),
  );
  const positive = (text: string | undefined) =>
    !text?.trim() || (Number.isFinite(Number(text)) && Number(text) > 0);
  let updatesValid = $derived(positive(draft?.updates));
  let hoursValid = $derived(positive(draft?.estimatedHours) && Number(draft?.estimatedHours || 0) <= 100000);
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
      countValid &&
      memoryValid &&
      updatesValid &&
      hoursValid,
  );
  /** Where a run or plan is: a host and its GPUs, such as gpu-a · GPUs 3, 4. */
  const gpuText = (host: string, gpus: number[] | null | undefined) =>
    gpus?.length ? $t('plans.gpus.on', { host, gpus: gpus.join(', ') }) : host;
  /** The request as the editor shows it: the GPUs a plan needs, such as 2 × ≥ 48 GB. */
  function requestText(request: GpuRequest | null | undefined) {
    const value = request ?? { gpus: 1 };
    return $t(value.min_memory_gb ? 'plans.gpus.requestMemory' : 'plans.gpus.request', {
      count: value.gpus,
      memory: $number(value.min_memory_gb ?? 0),
      model: value.model ?? '',
    });
  }
  async function save(status?: Plan['status']) {
    if (!draft) return;
    saving = true;
    editError = '';
    const id = draft.id.trim() || draft.name.trim(),
      fields = {
        name: draft.name.trim() || draft.id.trim(),
        parent: draft.parent || null,
        parentUpdate: numberOrNull(draft.parentUpdate),
        hypothesis: draft.hypothesis,
        change: draft.change,
        baseline: draft.baseline || null,
        rule: draft.rule,
        resources: {
          gpus: Number(draft.gpuCount),
          ...(draft.minMemory.trim() ? { min_memory_gb: Number(draft.minMemory) } : {}),
          ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
          ...(draft.hosts.length ? { hosts: draft.hosts } : {}),
        },
        queue: numberOrNull(draft.queue),
        updates: numberOrNull(draft.updates),
        estimated_hours: numberOrNull(draft.estimatedHours),
        // Sent only when edited, as typed: the supervisor writes it byte for byte.
        ...(draft.config_yaml !== draft.configYamlLoaded
          ? { config_yaml: draft.config_yaml ? draft.config_yaml : null }
          : {}),
        resume_run: draft.resume_run || null,
        config: draft.config.trim() ? JSON.parse(draft.config) : null,
      };
    try {
      if (draft.fromIdea)
        await tool('idea_promote', { project, id: draft.fromIdea, plan: id, ...fields });
      else
        await tool('plan_save', {
          project,
          id,
          ...fields,
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

{#snippet planCard(plan: Plan)}
  <li class="plan-card status-{plan.status}" id={'plan-' + plan.id}>
    <header class="plan-card-header">
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
      <button
        type="button"
        class="lineage-link"
        onclick={() => onPage('lineage', { run: 'plan:' + plan.id })}
        >{$t('plans.showInLineage')}</button
      >
    </footer>
  </li>
{/snippet}

{#snippet planDetails(plan: Plan)}<div class="queue-details">
    <dl class="queue-facts">
      {#if plan.change}<div>
          <dt>{$t('plans.edit.change')}</dt>
          <dd>{plan.change}</dd>
        </div>{/if}
      {#if plan.hypothesis}<div>
          <dt>{$t('lineage.panel.hypothesis')}</dt>
          <dd>{plan.hypothesis}</dd>
        </div>{/if}
      {#if plan.rule}<div>
          <dt>{$t('lineage.plan.rule')}</dt>
          <dd>{plan.rule}</dd>
        </div>{/if}
      {#if plan.baseline}<div>
          <dt>{$t('lineage.plan.baseline')}</dt>
          <dd>{@render runLink(plan.baseline)}</dd>
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
              ? (plans?.find((item) => item.id === plan.after!.slice(5))?.name ??
                plan.after.slice(5))
              : ''}{#if !plan.after.startsWith('plan:')}{@render runLink(plan.after)}{/if}
          </dd>
        </div>{/if}
      {#if plan.claim && !plan.run}<div>
          <dt>{$t('plans.status.claimed')}</dt>
          <dd>
            {$t('plans.lane.claimedBy', {
              by: plan.claim.by || '–',
              host: [plan.claim.host, plan.claim.slot].filter(Boolean).join(' · ') || '–',
              when: when(plan.claim.at),
            })}
          </dd>
        </div>{/if}
      {#if plan.idea}<div>
          <dt>{$t('plans.lane.idea')}</dt>
          <dd>{ideas?.find((idea) => idea.id === plan.idea)?.title ?? plan.idea}</dd>
        </div>{/if}
      <div>
        <dt>{$t('plans.lane.configFile')}</dt>
        <dd>
          {plan.config_yaml
            ? $t('plans.lane.configLines', { count: plan.config_yaml.split('\n').length })
            : $t('plans.lane.configNone')}
        </dd>
      </div>
    </dl>
    <footer class="queue-details-footer">
      <LedgerSource source={plan.source} />
      <button
        type="button"
        class="lineage-link"
        onclick={() => onPage('lineage', { run: 'plan:' + plan.id })}
        >{$t('plans.showInLineage')}</button
      >
    </footer>
  </div>{/snippet}

{#snippet runningRow(item: Running)}{@const bar = item.bar}{@const estimate =
    item.estimate}{@const total =
    bar?.budget != null && bar.progress != null
      ? Math.max(1, bar.budget - (bar.from ?? 0))
      : null}{@const plan = planOfRun(item.id)}
  <tr class="queue-row queue-running" data-run={item.id}>
    <td class="queue-col-pos"><span class="plan-live" aria-hidden="true"></span></td>
    <td class="queue-col-run">
      <span class="queue-run-name">{@render runLink(item.id)}</span>
      {#if bar && total !== null}<span class="queue-progress"
          ><ProgressBar
            size="sm"
            hideLabel
            labelText={$t('plans.lane.progress')}
            value={Math.min(total, Math.max(0, bar.progress! - (bar.from ?? 0)))}
            max={total}
          /></span
        ><span class="queue-sub"
          >{$t('plans.lane.progressOf', {
            progress: $number(bar.progress!),
            budget: $number(bar.budget!),
            percent: Math.round((100 * (bar.progress! - (bar.from ?? 0))) / total),
          })}</span
        >{:else if bar?.progress != null}<span class="queue-sub"
          >{$t('plans.lane.progressOnly', { progress: $number(bar.progress) })}</span
        >{/if}
    </td>
    <td class="queue-col-purpose">
      {#if plan?.change}<span class="queue-purpose">{plan.change}</span>{/if}
      {#if bar?.audit != null && occupancy?.metric}<span class="queue-sub" title={occupancy.metric}
          >{$t('plans.lane.audit')}: <strong>{audit(bar.audit)}</strong></span
        >{/if}
    </td>
    <td class="queue-col-gpus">
      {#if bar}<span class="queue-gpus">{gpuText(bar.host, bar.gpus)}</span>{:else}<span
          class="queue-sub">{$t('plans.lane.noCompute')}</span
        >{/if}
      {#if plan?.resources}<span class="queue-sub">{requestText(plan.resources)}</span>{/if}
    </td>
    <td class="queue-col-when">
      {#if bar}<span>{clock(bar.start)} → {estimate ? clock(estimate.end) : '?'}</span>
        <span class="queue-sub"
          >{estimate
            ? $t(estimate.basis === 'estimate' ? 'plans.lane.endsInEstimated' : 'plans.lane.endsIn', {
                wait: span(estimate.end - now),
              })
            : $t('plans.lane.noEstimate')}</span
        >{/if}
      {#if bar?.inferred}<span class="queue-sub">{$t('plans.lane.fromPlan')}</span>{/if}
    </td>
    <td class="queue-col-state"><Tag size="sm" type="blue">{$t('plans.lane.running')}</Tag></td>
    <td class="queue-col-actions">
      {#if plan}<Button
          kind="ghost"
          size="small"
          icon={Edit}
          iconDescription={$t('plans.edit.open')}
          tooltipAlignment="end"
          on:click={() => edit(plan)}
        />{/if}
    </td>
  </tr>
{/snippet}

{#snippet planRow(plan: Plan, position: number | null)}{@const at = scheduled.get(
    plan.id,
  )}{@const movable = plan.status === 'planned'}{@const open = expanded.has(plan.id)}
  <tr
    id={'plan-' + plan.id}
    class="queue-row plan-row status-{plan.status}"
    class:open
    class:dragging={dragging === plan.id}
    class:drop-before={typeof dropAt === 'object' &&
      dropAt?.id === plan.id &&
      dropAt.side === 'before'}
    class:drop-after={typeof dropAt === 'object' &&
      dropAt?.id === plan.id &&
      dropAt.side === 'after'}
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
    ondragover={movable ? (event) => dragOver(event, plan) : undefined}
    ondrop={(event) => drop(event)}
  >
    <td class="queue-col-pos">
      {#if position !== null}<span
          class="plan-position"
          title={$t('plans.lane.position', { position })}>{position}</span
        >{/if}
    </td>
    <td class="queue-col-run">
      <button
        type="button"
        class="queue-name"
        aria-expanded={open}
        aria-controls={'plan-details-' + plan.id}
        onclick={() => toggle(plan.id)}
        ><ChevronRight size={16} class="queue-chevron" /><span>{plan.name}</span></button
      >
    </td>
    <td class="queue-col-purpose">
      <span class="queue-purpose">{plan.change || plan.hypothesis}</span>
    </td>
    <td class="queue-col-gpus">
      {#if plan.allocation && !plan.allocation.released}<span class="queue-gpus"
          >{gpuText(plan.allocation.host, plan.allocation.gpus)}</span
        >{:else if at}<span class="queue-gpus">{gpuText(at.host, at.gpus)}</span>{/if}
      <span class={plan.allocation || at ? 'queue-sub' : 'queue-gpus'}
        >{requestText(plan.resources)}{plan.resources?.hosts?.length
          ? ' · ' + plan.resources.hosts.join(', ')
          : ''}</span
      >
    </td>
    <td class="queue-col-when">
      {#if plan.status === 'started' && plan.claim}<span
          >{$t('plans.lane.claimedAt', { when: clock(plan.claim.at) })}</span
        >
        <span class="queue-sub"
          >{$t('plans.lane.claimedByShort', {
            by: plan.claim.by || '–',
            host: plan.claim.host || '–',
          })}</span
        >{:else if unfit.has(plan.id)}<span class="queue-unfit"
          >{$t(unfitLabels[unfit.get(plan.id)!] ?? 'plans.gpus.unfit.tooFew')}</span
        >{:else if at}<span
          >{at.start <= now + 60 ? $t('plans.lane.now') : '~' + clock(at.start)} → {at.unknownLength
            ? '?'
            : clock(at.end)}</span
        >
        <span class="queue-sub"
          >{at.start <= now + 60
            ? $t('plans.lane.startsNow')
            : $t('plans.lane.inWait', { wait: span(at.start - now) })} · {at.unknownLength
            ? $t('plans.lane.lengthUnknown')
            : $t(at.basis === 'estimate' ? 'plans.lane.lengthEstimated' : 'plans.lane.length', {
                length: span(at.end - at.start),
              })}</span
        >
        {#if alongside(at).length}<span class="queue-sub queue-alongside"
            >{$t('plans.gpus.alongside', {
              names: alongside(at)
                .map((name) => name.split('_')[0])
                .join(', '),
            })}</span
          >{/if}{/if}
    </td>
    <td class="queue-col-state">
      <Tag size="sm" type={plan.status === 'planned' ? 'cool-gray' : statusTag(plan)}
        >{$t(
          plan.status === 'started' && !plan.run
            ? 'plans.status.claimed'
            : planStatusLabels[plan.status],
        )}</Tag
      >
    </td>
    <td class="queue-col-actions">
      {#if movable}<Button
          kind="ghost"
          size="small"
          icon={ArrowUp}
          iconDescription={$t('plans.move.earlier')}
          tooltipAlignment="end"
          disabled={queue.waiting[0] === plan}
          on:click={() => shift(plan, -1)}
        /><Button
          kind="ghost"
          size="small"
          icon={ArrowDown}
          iconDescription={$t('plans.move.later')}
          tooltipAlignment="end"
          disabled={queue.waiting.at(-1) === plan}
          on:click={() => shift(plan, 1)}
        />{/if}<Button
        kind="ghost"
        size="small"
        icon={Edit}
        iconDescription={$t('plans.edit.open')}
        tooltipAlignment="end"
        on:click={() => edit(plan)}
      />
    </td>
  </tr>
  {#if open}<tr class="queue-details-row" id={'plan-details-' + plan.id}>
      <td class="queue-col-pos"></td>
      <td colspan="6">{@render planDetails(plan)}</td>
    </tr>{/if}
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
      <span class="plans-heading-actions">
        {#if recipe?.history.length}<Button
            kind="ghost"
            size="small"
            icon={RecentlyViewed}
            on:click={() => (promotionsOpen = true)}
            >{$t('plans.recipe.history', { count: recipe.history.length })}</Button
          >{/if}
        {#if recipe && !promoting}<Button
            kind="tertiary"
            size="small"
            on:click={() => (promoting = true)}>{$t('plans.recipe.change')}</Button
          >{/if}
      </span>
    </div>
    {#if recipe === null}<p class="lineage-muted">{$t('common.status.loading')}</p>
    {:else}
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
      </div>{/if}
  </section>
  {#if promotionsOpen && recipe}<SideDrawer
      id="recipe-history"
      title={$t('plans.recipe.historyTitle')}
      onClose={() => (promotionsOpen = false)}
      ><ol class="recipe-timeline">
        {#each recipe.history as event, index (event.id)}<li
            aria-current={index === 0 && recipe.current?.id === event.id ? 'true' : undefined}
          >
            <span class="recipe-timeline-date"
              >{$date(event.since, true)}{event.by ? ' · ' + event.by : ''}</span
            >
            <span class="recipe-timeline-run">{@render runLink(event.run)}</span>
            <span class="recipe-timeline-reason">{event.reason}</span>
            <LedgerSource source={event.source} />
          </li>{/each}
      </ol></SideDrawer
    >{/if}

  <section class="plans-section" aria-label={$t('charts.types.gpuOccupancy')}>
    {#if occupancyPlugin}<div class="plans-occupancy" bind:this={occupancyBox}>
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
    {:else}
      {#if inventoryNow.length}<ul class="gpu-strip" aria-label={$t('plans.gpus.inventory')}>
          {#each inventoryNow as host (host.host)}<li
              class="gpu-host"
              class:reserved={host.reserved}
            >
              <div class="gpu-host-head">
                <strong>{host.host}</strong>
                <span class="gpu-host-meta"
                  >{host.reserved
                    ? $t('plans.gpus.notForPlans')
                    : $t('plans.gpus.free', { count: host.free, total: host.gpus.length })}</span
                >
              </div>
              <span class="gpu-host-model">{host.summary}</span>
              <ol class="gpu-cells">
                {#each host.gpus as gpu (gpu.gpu)}<li
                    class="gpu-cell state-{gpu.state}"
                    title={[
                      $t('occupancy.gpu', { index: gpu.gpu }),
                      $t(gpuStateLabels[gpu.state]),
                      gpu.holder ?? '',
                      gpu.next
                        ? $t('plans.gpus.next', {
                            name: gpu.next.name,
                            when: clock(gpu.next.start),
                          })
                        : '',
                      gpu.note,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    <span class="gpu-cell-id">{gpu.gpu}</span>
                    <span class="visually-hidden">{$t(gpuStateLabels[gpu.state])}</span>
                  </li>{/each}
              </ol>
            </li>{/each}
        </ul>{/if}
      {#if !queue.running.length && !queue.claimed.length && !queue.waiting.length}<p
          class="empty-table"
        >
          {$t('plans.empty')}
        </p>{:else}<table class="queue-table plan-queue" aria-label={$t('plans.queues.title')}>
          <colgroup>
            <col class="queue-col-pos" />
            <col class="queue-col-run" />
            <col class="queue-col-purpose" />
            <col class="queue-col-gpus" />
            <col class="queue-col-when" />
            <col class="queue-col-state" />
            <col class="queue-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" class="queue-col-pos"
                ><span class="visually-hidden">{$t('plans.lane.column.position')}</span></th
              >
              <th scope="col">{$t('plans.lane.column.run')}</th>
              <th scope="col">{$t('plans.lane.column.purpose')}</th>
              <th scope="col">{$t('plans.lane.column.gpus')}</th>
              <th scope="col">{$t('plans.lane.column.when')}</th>
              <th scope="col">{$t('plans.lane.column.state')}</th>
              <th scope="col"
                ><span class="visually-hidden">{$t('plans.lane.column.actions')}</span></th
              >
            </tr>
          </thead>
          {#if queue.running.length}<tbody
              class="queue-group"
              aria-label={$t('plans.queues.running')}
            >
              <tr class="queue-group-head">
                <th colspan="7" scope="rowgroup">
                  {$t('plans.queues.runningCount', { count: queue.running.length })}
                </th>
              </tr>
              {#each queue.running as item (item.id)}{@render runningRow(item)}{/each}
            </tbody>{/if}
          {#if queue.claimed.length}<tbody
              class="queue-group"
              aria-label={$t('plans.queues.claimed')}
            >
              <tr class="queue-group-head">
                <th colspan="7" scope="rowgroup">
                  {$t('plans.queues.claimedCount', { count: queue.claimed.length })}
                </th>
              </tr>
              {#each queue.claimed as plan (plan.id)}{@render planRow(plan, null)}{/each}
            </tbody>{/if}
          <tbody
            class="queue-group queue-waiting"
            aria-label={$t('plans.queues.waiting')}
            class:drop-end={dropAt === 'end'}
            ondragover={(event) => {
              if ((event.target as Element).closest('.plan-row.status-planned')) return;
              dragOver(event);
            }}
            ondrop={(event) => drop(event)}
          >
            <tr class="queue-group-head">
              <th colspan="7" scope="rowgroup">
                {$t('plans.queues.waitingCount', { count: queue.waiting.length })}
              </th>
            </tr>
            {#each queue.waiting as plan, index (plan.id)}{@render planRow(plan, index + 1)}{/each}
            {#if !queue.waiting.length}<tr class="queue-empty-row">
                <td></td>
                <td colspan="6" class="lineage-muted">{$t('plans.queues.nothingWaiting')}</td>
              </tr>{/if}
          </tbody>
        </table>{/if}
    {/if}
  </section>

  <PlanIdeas
    {project}
    {ideas}
    plans={plans ?? []}
    {runs}
    {findings}
    {narrow}
    onchanged={changed}
    onpromote={promote}
    onplan={(id) => {
      const plan = plans?.find((item) => item.id === id);
      if (plan) open({ plan: plan.id });
    }}
    {onRun}
  />
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
            <ul class="plan-history-card">{@render planCard(picked)}</ul>
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
    class="plan-editor"
    modalHeading={draft.fromIdea
      ? $t('plans.edit.promoteTitle')
      : draft.created
        ? $t('plans.edit.title')
        : $t('plans.edit.new')}
    primaryButtonText={saving
      ? $t('common.status.saving')
      : draft.fromIdea
        ? $t('plans.edit.promote')
        : $t('plans.edit.save')}
    primaryButtonDisabled={saving || !validDraft}
    secondaryButtonText={$t('common.action.cancel')}
    on:click:button--secondary={() => (draft = null)}
    on:close={() => (draft = null)}
    on:submit={() => save()}
  >
    <div class="plan-form">
      {#if editError}<InlineNotification
          lowContrast
          hideCloseButton
          kind="error"
          title={$t('plans.errors.failed')}
          subtitle={$t(editError)}
        />{/if}
      {#if draft.fromIdea}<p class="plan-form-note">
          {$t('plans.edit.fromIdea', {
            idea: ideas?.find((idea) => idea.id === draft!.fromIdea)?.title ?? draft.fromIdea,
          })}
        </p>{/if}
      <fieldset class="plan-form-section">
        <legend>{$t('plans.edit.section.run')}</legend>
        <div class="plan-form-grid">
          <div class="span-8">
            <TextInput labelText={$t('plans.edit.name')} bind:value={draft.name} />
          </div>
          {#if !draft.created}<div class="span-4">
              <TextInput
                labelText={$t('plans.edit.id')}
                helperText={$t('plans.edit.idHelp')}
                bind:value={draft.id}
              />
            </div>{:else}<div class="span-4 plan-form-status">
              <span class="bx--label">{$t('plans.edit.status')}</span>
              <span
                ><Tag size="sm" type={draft.status === 'planned' ? 'cool-gray' : 'gray'}
                  >{$t(
                    draft.status === 'started' && draft.claimed
                      ? 'plans.status.claimed'
                      : planStatusLabels[draft.status],
                  )}</Tag
                ><code class="plan-form-id">{draft.id}</code></span
              >
            </div>{/if}
        </div>
      </fieldset>
      <fieldset class="plan-form-section">
        <legend>{$t('plans.edit.section.gpus')}</legend>
        <div class="plan-form-grid">
          <div class="span-3">
            <TextInput
              labelText={$t('plans.edit.gpuCount')}
              inputmode="numeric"
              invalid={!countValid}
              invalidText={$t('plans.edit.gpuCountInvalid')}
              bind:value={draft.gpuCount}
            />
          </div>
          <div class="span-3">
            <TextInput
              labelText={$t('plans.edit.minMemory')}
              inputmode="decimal"
              placeholder={$t('plans.edit.any')}
              invalid={!memoryValid}
              bind:value={draft.minMemory}
            />
          </div>
          <div class="span-3">
            <Select labelText={$t('plans.edit.model')} bind:selected={draft.model}
              ><SelectItem
                value=""
                text={$t('plans.edit.anyModel')}
              />{#each inventoryModels as model (model)}<SelectItem
                  value={model}
                  text={model}
                />{/each}{#if draft.model && !inventoryModels.includes(draft.model)}<SelectItem
                  value={draft.model}
                  text={draft.model}
                />{/if}</Select
            >
          </div>
          <div class="span-3">
            <TextInput
              labelText={$t('plans.edit.queue')}
              inputmode="numeric"
              bind:value={draft.queue}
            />
          </div>
          <fieldset class="span-12 plan-form-hosts">
            <legend class="bx--label">{$t('plans.edit.hosts')}</legend>
            <div class="plan-form-checks">
              {#each [...new Set([...inventoryHosts, ...draft.hosts])] as host (host)}<Checkbox
                  labelText={host}
                  checked={draft.hosts.includes(host)}
                  on:check={(event) =>
                    (draft!.hosts = event.detail
                      ? [...draft!.hosts, host]
                      : draft!.hosts.filter((item) => item !== host))}
                />{/each}
            </div>
            <p class="plan-form-help">{$t('plans.edit.hostsHelp')}</p>
          </fieldset>
          <div class="span-4">
            <TextInput
              labelText={$t('plans.edit.estimatedHours')}
              inputmode="decimal"
              invalid={!hoursValid}
              bind:value={draft.estimatedHours}
            />
          </div>
          <p class="span-8 plan-form-help plan-form-help-beside">
            {$t('plans.edit.estimatedHoursHelp')}
          </p>
          <div class="span-4">
            <TextInput
              labelText={$t('plans.edit.updates')}
              inputmode="numeric"
              invalid={!updatesValid}
              bind:value={draft.updates}
            />
          </div>
          <p class="span-8 plan-form-help plan-form-help-beside">{$t('plans.edit.updatesHelp')}</p>
        </div>
      </fieldset>
      <fieldset class="plan-form-section">
        <legend>{$t('plans.edit.section.test')}</legend>
        <div class="plan-form-grid">
          <div class="span-12">
            <TextInput labelText={$t('plans.edit.change')} bind:value={draft.change} />
          </div>
          <div class="span-12">
            <TextArea
              labelText={$t('lineage.panel.hypothesis')}
              rows={3}
              bind:value={draft.hypothesis}
            />
          </div>
          <div class="span-6">
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
          </div>
          <div class="span-6">
            <TextArea labelText={$t('lineage.plan.rule')} rows={2} bind:value={draft.rule} />
          </div>
        </div>
      </fieldset>
      <fieldset class="plan-form-section">
        <legend>{$t('plans.edit.section.start')}</legend>
        <div class="plan-form-grid">
          <div class="span-8">
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
          </div>
          <div class="span-4">
            <TextInput
              labelText={$t('plans.edit.parentUpdate')}
              inputmode="numeric"
              bind:value={draft.parentUpdate}
            />
          </div>
          <div class="span-12">
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
          </div>
        </div>
      </fieldset>
      <fieldset class="plan-form-section">
        <legend>{$t('plans.edit.section.config')}</legend>
        <div class="plan-form-grid">
          <div class="span-12">
            <TextArea
              labelText={$t('plans.edit.configYaml')}
              helperText={$t('plans.edit.configYamlHelp')}
              rows={8}
              class="plan-config-yaml"
              bind:value={draft.config_yaml}
            />
          </div>
          <div class="span-12">
            <TextArea
              labelText={$t('lineage.plan.config')}
              helperText={$t('plans.edit.configHelp')}
              rows={4}
              invalid={configError}
              invalidText={$t('plans.edit.configInvalid')}
              bind:value={draft.config}
            />
          </div>
        </div>
      </fieldset>
      {#if draft.created}<div class="plan-form-actions">
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
