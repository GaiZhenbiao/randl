// GPU occupancy (README "Plans and GPU occupancy"): which runs held which GPUs of each host,
// which hold them now and until when, and when the planned runs queued on them should start.
// Built from runs' `lineage.compute` segments and the ledger's planned runs.
import type { Compute, ComputeSegment } from './lineage.js';
import type { GpuRequest, Plan } from './ledger.js';
import { project, type Busy, type Gpu } from './plan-queue.js';

/** A run as the occupancy timeline reads it. Times are seconds since the epoch. */
export type OccupancyRun = {
  id: string;
  name: string;
  state: string;
  verdict: string | null;
  start: number;
  /** When the run ended, or its last heartbeat; ignored while it runs. */
  end: number;
  compute: Compute | null;
  /** The progress value it logged last (the summary's progress key, such as `update`). */
  progress: number | null;
  /** The progress it is configured to stop at (the config's budget key). */
  budget: number | null;
  /** The progress it started from (the config's start key). */
  from: number | null;
  /** The ledger plan it carries out (`lineage.plan`). */
  plan: string | null;
  /** The latest value of the project's lineage metric. */
  audit: number | null;
  /** When the run reached each segment boundary, where its history told. */
  reached?: Record<number, number>;
  /** Where the ledger plan it carries out put it, for a run that logs no compute block. */
  placement?: { host: string; slot: string; gpus: number[] | null } | null;
};
export type OccupancyPlan = Pick<
  Plan,
  'id' | 'name' | 'host' | 'slot' | 'queue' | 'after' | 'created' | 'parentUpdate' | 'config'
> & {
  gpus?: number[] | null;
  updates?: number | null;
  /** The GPUs it asks for. */
  request: GpuRequest;
  /** Since when it has waited, for the head's hold. */
  since: number;
  /** Claimed: the GPUs a host agent was given for it, its run not logged yet. */
  allocation?: { host: string; gpus: number[] } | null;
  /** Its place in the queue, from 1; claimed plans have none. */
  position?: number;
};
/** A timeline row: one GPU, or a host's GPUs that were not logged. */
export type OccupancyRow = { key: string; gpu: number | null };
export type OccupancyHost = {
  host: string;
  model: string;
  rows: OccupancyRow[];
  /** GPUs listed in the inventory but kept out of allocation. */
  reserved?: number[];
};
export type OccupancyBar = {
  /** Unique within the response: the run and segment, or `plan:` and the plan's id. */
  id: string;
  run: string | null;
  plan: string | null;
  name: string;
  host: string;
  slot: string;
  gpus: number[] | null;
  count: number | null;
  start: number;
  end: number;
  /** A projected plan: the runs (by id) or plans (`plan:` id) whose GPUs it takes next. */
  follows?: string[];
  /** A plan claimed for these GPUs, its run not started yet. */
  claimed?: boolean;
  /**
   * past: a finished segment; running: up to now; remaining: from now to the estimated end;
   * planned: a queued plan at its estimated time.
   */
  kind: 'past' | 'running' | 'remaining' | 'planned';
  state: string;
  verdict: string | null;
  /** The end (and for plans the start) is an estimate. */
  estimated: boolean;
  /** No budget or rate was known: the length is a placeholder. */
  unknownLength: boolean;
  /** The run logs no compute block: its host and GPUs are those of the plan it carries out. */
  inferred?: boolean;
  /** The timeline rows it covers. */
  rows: string[];
  /** Its lane within those rows, when bars overlap in time, of `lanes` sharing them. */
  lane?: number;
  lanes?: number;
  progress?: number | null;
  budget?: number | null;
  from?: number | null;
  audit?: number | null;
  /** Seconds per unit of progress. */
  rate?: number | null;
};
export type Occupancy = {
  now: number;
  hosts: OccupancyHost[];
  bars: OccupancyBar[];
  /** Running runs that log no compute block, so their GPUs are unknown. */
  unplaced: { id: string; name: string }[];
  /** Waiting plans no host can run now or later, and why (plan-queue.ts `unfitReason`). */
  unfit: { id: string; name: string; reason: string }[];
};

/** How long a plan with no known budget or rate is drawn. */
export const placeholderLength = 6 * 3600;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
/** A config value by dotted key, flat or nested. */
export function configValue(config: Record<string, any> | null | undefined, key: string): unknown {
  if (!config || !key) return undefined;
  if (key in config) return config[key];
  let value: any = config;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = 'value' in value && !(part in value) ? value.value?.[part] : value[part];
  }
  return value;
}
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

type Segment = ComputeSegment & { start: number; end: number; last: boolean };

/** The time span of each segment: history times where known, else interpolated by progress. */
function segmentTimes(run: OccupancyRun, now: number): Segment[] {
  const live = run.state === 'running',
    end = live ? now : Math.max(run.start, run.end),
    segments = run.compute?.segments ?? [];
  if (!segments.length) return [];
  const first = segments[0].from_update ?? run.from,
    last = run.progress;
  const at = (update: number | null, fallback: number) => {
    if (update === null) return fallback;
    const known = run.reached?.[update];
    if (known !== undefined) return Math.min(Math.max(known, run.start), end);
    if (first === null || last === null || last <= first) return fallback;
    const share = Math.min(Math.max((update - first) / (last - first), 0), 1);
    return run.start + share * (end - run.start);
  };
  return segments
    .map((segment, index) => ({
      ...segment,
      start: index === 0 ? run.start : at(segment.from_update, run.start),
      end: index === segments.length - 1 ? end : at(segment.to_update, end),
      last: index === segments.length - 1,
    }))
    .filter((segment, index, all) => {
      // A segment that covers no updates (a launch that failed at once) took no time.
      if (
        segment.from_update !== null &&
        segment.to_update !== null &&
        segment.to_update <= segment.from_update &&
        all.length > 1
      )
        return false;
      return index === all.length - 1 || segment.end > segment.start;
    });
}

/**
 * Lays out the timeline: one row per GPU index (0 to the highest seen) of each host, then one
 * row for segments whose GPU indices were not logged; bars that overlap in time on a row
 * (two runs on one GPU, an evaluation beside training) share it in lanes.
 * Planned runs start once every GPU they need is free (after the running run's estimated end
 * and the plans ahead of them) and after the run or plan they are queued after.
 */
export function occupancy(
  runs: OccupancyRun[],
  plans: OccupancyPlan[],
  now = Date.now() / 1000,
  keys: { budget: string; start: string } = { budget: '', start: '' },
  inventory: Gpu[] = [],
): Occupancy {
  const bars: OccupancyBar[] = [],
    unplaced: Occupancy['unplaced'] = [],
    models = new Map<string, { model: string; at: number }>(),
    gpuSets = new Map<string, Set<number>>(),
    slotGpus = new Map<string, { gpus: number[]; at: number }>(),
    rates = new Map<string, { rate: number; at: number }[]>(),
    lengths = new Map<string, { length: number; at: number }[]>(),
    runEnds = new Map<string, number>();
  const note = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };
  const remember = (host: string, model: string | null, gpus: number[] | null, at: number) => {
    if (model && (models.get(host)?.at ?? -Infinity) <= at) models.set(host, { model, at });
    const set = gpuSets.get(host) ?? new Set<number>();
    for (const gpu of gpus ?? []) set.add(gpu);
    gpuSets.set(host, set);
  };
  for (const run of runs) {
    const live = run.state === 'running',
      placement = !run.compute?.segments.length && run.placement?.host ? run.placement : null,
      gpus = placement
        ? placement.gpus?.length
          ? placement.gpus
          : (slotGpus.get(placement.host + '\u0000' + placement.slot)?.gpus ?? null)
        : null;
    // A run without a compute block sits where the plan it carries out put it.
    const segments = segmentTimes(
      placement
        ? {
            ...run,
            compute: {
              host: placement.host,
              gpu_count: gpus?.length ?? null,
              segments: [
                {
                  from_update: run.from,
                  to_update: null,
                  host: placement.host,
                  gpu_count: gpus?.length ?? null,
                  gpu_ids: gpus,
                  gpu_model: null,
                  slot: placement.slot || null,
                },
              ],
            },
          }
        : run,
      now,
    );
    if (!segments.length) {
      if (!live) continue;
      unplaced.push({ id: run.id, name: run.name });
      // Its estimated end still holds back plans queued after it.
      const rate =
        run.progress !== null && run.from !== null && run.progress > run.from && now > run.start
          ? (now - run.start) / (run.progress - run.from)
          : null;
      const end =
        rate !== null && run.budget !== null && run.progress !== null && run.budget > run.progress
          ? now + (run.budget - run.progress) * rate
          : now;
      runEnds.set(run.id, end);
      runEnds.set(run.name, end);
      continue;
    }
    let finish = live ? now : segments.at(-1)!.end;
    for (const [index, segment] of segments.entries()) {
      const host = segment.host ?? run.compute?.host ?? '';
      if (!host) continue;
      remember(host, segment.gpu_model, segment.gpu_ids, segment.start);
      const slot = segment.slot ?? '';
      if (slot && segment.gpu_ids?.length) {
        const key = host + '\u0000' + slot;
        if ((slotGpus.get(key)?.at ?? -Infinity) <= segment.start)
          slotGpus.set(key, { gpus: segment.gpu_ids, at: segment.start });
      }
      // Seconds per update on this host and slot, from the segment's own progress.
      const from = segment.from_update ?? (index === 0 ? run.from : null),
        to = segment.last ? run.progress : segment.to_update,
        rate =
          from !== null && to !== null && to > from && segment.end > segment.start
            ? (segment.end - segment.start) / (to - from)
            : null;
      const count = segment.gpu_ids?.length || segment.gpu_count || 0;
      if (rate !== null) {
        note(rates, host + '#' + count, { rate, at: segment.end });
        note(rates, host, { rate, at: segment.end });
        note(rates, '', { rate, at: segment.end });
      }
      const base = {
        run: run.id,
        plan: null,
        name: run.name,
        host,
        slot,
        gpus: segment.gpu_ids,
        count: segment.gpu_count ?? segment.gpu_ids?.length ?? null,
        state: run.state,
        verdict: run.verdict,
        unknownLength: false,
        rows: [],
        ...(placement ? { inferred: true } : {}),
      };
      if (!(live && segment.last)) {
        bars.push({
          ...base,
          id: run.id + '#' + index,
          start: segment.start,
          end: segment.end,
          kind: 'past',
          estimated: false,
        });
        continue;
      }
      const remaining =
        rate !== null && run.budget !== null && run.progress !== null && run.budget > run.progress
          ? (run.budget - run.progress) * rate
          : null;
      const facts = {
        progress: run.progress,
        budget: run.budget,
        from,
        audit: run.audit,
        rate,
      };
      bars.push({
        ...base,
        ...facts,
        id: run.id + '#' + index,
        start: segment.start,
        end: now,
        kind: 'running',
        estimated: false,
      });
      if (remaining !== null) {
        finish = now + remaining;
        bars.push({
          ...base,
          ...facts,
          id: run.id + '#' + index + ':remaining',
          start: now,
          end: finish,
          kind: 'remaining',
          estimated: true,
        });
      }
    }
    runEnds.set(run.id, finish);
    runEnds.set(run.name, finish);
    // How far runs here usually go, for plans that state no budget.
    const last = segments.at(-1)!,
      host = last.host ?? run.compute?.host ?? '';
    if (run.budget !== null && run.from !== null && run.budget > run.from && host) {
      const count = last.gpu_ids?.length || last.gpu_count || 0;
      note(lengths, host + '#' + count, { length: run.budget - run.from, at: run.start });
      note(lengths, host, { length: run.budget - run.from, at: run.start });
    }
  }

  // The queue run forward (plan-queue.ts `project`): GPUs held by running runs to their
  // estimated end and by claimed plans, then each waiting plan where the allocator would put
  // it, with the runs or plans whose GPUs it takes next.
  const recent = <T extends { at: number }>(list: T[] | undefined, count = 5) =>
    (list ?? []).sort((a, b) => b.at - a.at).slice(0, count);
  const lengthOn = (plan: OccupancyPlan, host: string) => {
    const count = Math.max(1, plan.request.gpus),
      budget = finite(configValue(plan.config, keys.budget)),
      from = finite(configValue(plan.config, keys.start)) ?? plan.parentUpdate,
      stated =
        plan.updates ?? (budget !== null && from !== null && budget > from ? budget - from : null),
      updates =
        stated ??
        median(recent(lengths.get(host + '#' + count)).map((entry) => entry.length)) ??
        median(recent(lengths.get(host)).map((entry) => entry.length)),
      rate =
        median(recent(rates.get(host + '#' + count)).map((entry) => entry.rate)) ??
        median(recent(rates.get(host)).map((entry) => entry.rate)) ??
        median(recent(rates.get(''), 10).map((entry) => entry.rate));
    return { updates, rate, length: updates !== null && rate !== null ? updates * rate : null };
  };
  for (const gpu of inventory) remember(gpu.host, gpu.model || null, [gpu.gpu], -Infinity);
  const busy: Busy[] = [];
  for (const bar of bars)
    if (bar.kind === 'running' || bar.kind === 'remaining')
      for (const gpu of bar.gpus ?? [])
        busy.push({
          host: bar.host,
          gpu,
          until: bar.kind === 'running' ? (runEnds.get(bar.run!) ?? bar.end) : bar.end,
          by: bar.run!,
        });
  const planBar = (
    plan: OccupancyPlan,
    host: string,
    gpus: number[],
    start: number,
    end: number,
    extra: Partial<OccupancyBar>,
  ): OccupancyBar => {
    const { updates, rate } = lengthOn(plan, host);
    return {
      id: 'plan:' + plan.id,
      run: null,
      plan: plan.id,
      name: plan.name,
      host,
      slot: '',
      gpus,
      count: gpus.length,
      start,
      end,
      kind: 'planned',
      state: 'planned',
      verdict: null,
      estimated: true,
      unknownLength: false,
      rows: [],
      budget: updates,
      rate,
      ...extra,
    };
  };
  // Claimed plans hold their allocated GPUs from now for their length.
  for (const plan of plans.filter((item) => item.allocation)) {
    const { host, gpus } = plan.allocation!,
      { length } = lengthOn(plan, host),
      end = now + (length ?? placeholderLength);
    remember(host, null, gpus, now);
    bars.push(
      planBar(plan, host, gpus, now, end, { claimed: true, unknownLength: length === null }),
    );
    for (const gpu of gpus) busy.push({ host, gpu, until: end, by: 'plan:' + plan.id });
  }
  const waitingPlans = plans.filter((item) => !item.allocation),
    planIds = new Set(plans.map((plan) => plan.id)),
    waitingIds = new Set(waitingPlans.map((plan) => plan.id));
  const readyAt = (plan: OccupancyPlan, ends: Map<string, number>) => {
    if (!plan.after) return now;
    const id = plan.after.replace(/^plan:/, '');
    if (plan.after.startsWith('plan:') || (planIds.has(id) && !runEnds.has(plan.after))) {
      if (ends.has('plan:' + id)) return ends.get('plan:' + id)!;
      return waitingIds.has(id) ? null : now;
    }
    return runEnds.get(plan.after) ?? now;
  };
  const order = [...waitingPlans].sort(
    (a, b) =>
      (a.position ?? Infinity) - (b.position ?? Infinity) ||
      (a.queue ?? Infinity) - (b.queue ?? Infinity) ||
      a.created - b.created ||
      a.id.localeCompare(b.id),
  );
  const projection = project({
    now,
    inventory,
    busy,
    queue: order,
    readyAt,
    length: (plan, host) => lengthOn(plan, host).length,
    placeholder: placeholderLength,
  });
  const byPlan = new Map(order.map((plan) => [plan.id, plan]));
  for (const placed of projection.placed) {
    const plan = byPlan.get(placed.id)!;
    remember(placed.host, null, placed.gpus, now);
    bars.push(
      planBar(plan, placed.host, placed.gpus, placed.start, placed.end, {
        follows: placed.after,
        unknownLength: placed.unknownLength,
      }),
    );
  }
  const unfit = projection.unfit.map((item) => ({
    ...item,
    name: byPlan.get(item.id)?.name ?? item.id,
  }));

  // Rows: GPU indices first, then packed rows for bars whose GPUs were not logged.
  const latest = new Map<string, number>();
  for (const bar of bars)
    latest.set(bar.host, Math.max(latest.get(bar.host) ?? -Infinity, Math.min(bar.end, now)));
  const hosts: OccupancyHost[] = [...new Set([...gpuSets.keys(), ...bars.map((bar) => bar.host)])]
    .filter(Boolean)
    // Hosts in use now or queued come first, then the rest by when they were last used.
    .sort(
      (a, b) =>
        (latest.get(b) ?? -Infinity) - (latest.get(a) ?? -Infinity) ||
        a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
    )
    .map((host) => {
      const ids = [...(gpuSets.get(host) ?? [])],
        highest = ids.length ? Math.max(...ids) : -1,
        // A host in the inventory shows the GPUs it has (and any a run logged beside them);
        // others show indices 0 to the highest seen.
        listed = inventory.some((gpu) => gpu.host === host)
          ? [...new Set(ids)].sort((a, b) => a - b)
          : Array.from({ length: highest + 1 }, (_, gpu) => gpu);
      const reserved = inventory
        .filter((gpu) => gpu.host === host && !gpu.allowed)
        .map((gpu) => gpu.gpu);
      return {
        host,
        model: models.get(host)?.model ?? '',
        rows: listed.map((gpu) => ({ key: host + '/' + gpu, gpu })),
        ...(reserved.length ? { reserved } : {}),
      };
    });
  const byHost = new Map(hosts.map((host) => [host.host, host]));
  // Bars whose GPUs were not logged share one row per host.
  for (const bar of bars) {
    if (!byHost.has(bar.host)) continue;
    bar.rows = bar.gpus?.length ? bar.gpus.map((gpu) => bar.host + '/' + gpu) : [bar.host + '/?'];
  }
  for (const host of hosts)
    if (bars.some((bar) => bar.host === host.host && bar.rows[0] === host.host + '/?'))
      host.rows.push({ key: host.host + '/?', gpu: null });
  // Bars that overlap in time on a row share it in lanes: each bar takes the first lane free
  // on every row it covers, so a run on several GPUs keeps one lane across them, and a running
  // run's estimate stays in its run's lane. Overlaps under ten minutes (one run's last
  // heartbeat after the next one's start) are not overlaps.
  const slack = 600,
    until = (bar: OccupancyBar) =>
      bar.kind === 'running' ? (runEnds.get(bar.run!) ?? bar.end) : bar.end,
    owner = (bar: OccupancyBar) => bar.run ?? bar.id;
  const lanesEnd = new Map<string, { end: number; owner: string }[]>(),
    laneOf = new Map<string, number>(),
    // Owners whose bars overlap, joined into groups that split their rows alike.
    group = new Map<string, string>();
  const root = (key: string): string => {
    const parent = group.get(key) ?? key;
    if (parent === key) return key;
    const top = root(parent);
    group.set(key, top);
    return top;
  };
  const placedBars = [...bars]
    .filter((item) => item.rows.length)
    .sort((a, b) => a.start - b.start || until(b) - until(a));
  for (const bar of placedBars) {
    const kept = bar.kind === 'remaining' ? laneOf.get(owner(bar)) : undefined;
    if (kept !== undefined) {
      bar.lane = kept;
      continue;
    }
    let lane = 0;
    while (
      bar.rows.some((row) => (lanesEnd.get(row)?.[lane]?.end ?? -Infinity) > bar.start + slack)
    )
      lane++;
    for (const row of bar.rows) {
      const ends = lanesEnd.get(row) ?? [];
      // Every bar still running on this row overlaps this one.
      for (const other of ends)
        if (other && other.end > bar.start + slack) group.set(root(owner(bar)), root(other.owner));
      ends[lane] = { end: until(bar), owner: owner(bar) };
      lanesEnd.set(row, ends);
    }
    bar.lane = lane;
    laneOf.set(owner(bar), lane);
  }
  // Each bar takes 1/lanes of its rows' height, where lanes is its group's lane count; bars
  // that overlap nothing keep the whole row.
  const groupLanes = new Map<string, number>();
  for (const bar of placedBars) {
    const key = root(owner(bar));
    groupLanes.set(key, Math.max(groupLanes.get(key) ?? 1, (bar.lane ?? 0) + 1));
  }
  for (const bar of placedBars) bar.lanes = groupLanes.get(root(owner(bar))) ?? 1;
  return { now, hosts, bars, unplaced, unfit };
}
