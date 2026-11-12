// GPU occupancy (README "Plans and GPU occupancy"): which runs held which GPUs of each host,
// which hold them now and until when, and when the planned runs queued on them should start.
// Built from runs' `lineage.compute` segments and the ledger's planned runs.
import type { Compute, ComputeSegment } from './lineage.js';
import type { Plan } from './ledger.js';

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
> & { gpus?: number[] | null; updates?: number | null };
export type OccupancyRow = { key: string; gpu: number | null };
export type OccupancyHost = { host: string; model: string; rows: OccupancyRow[] };
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
 * Lays out the timeline: one row per GPU index (0 to the highest seen) of each host, then
 * rows for segments whose GPU indices were not logged, packed so their bars do not overlap.
 * Planned runs start once every GPU they need is free (after the running run's estimated end
 * and the plans ahead of them) and after the run or plan they are queued after.
 */
export function occupancy(
  runs: OccupancyRun[],
  plans: OccupancyPlan[],
  now = Date.now() / 1000,
  keys: { budget: string; start: string } = { budget: '', start: '' },
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
      if (rate !== null) {
        note(rates, host + '\u0000' + slot, { rate, at: segment.end });
        note(rates, host, { rate, at: segment.end });
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
    if (run.budget !== null && run.from !== null && run.budget > run.from && host)
      note(lengths, host + '\u0000' + (last.slot ?? ''), {
        length: run.budget - run.from,
        at: run.start,
      });
  }

  // When each GPU (host and index) and each slot is next free.
  const free = new Map<string, number>(),
    freeAt = (key: string) => free.get(key) ?? now,
    hold = (key: string, until: number) => free.set(key, Math.max(freeAt(key), until));
  for (const bar of bars)
    if (bar.kind === 'running' || bar.kind === 'remaining') {
      for (const gpu of bar.gpus ?? []) hold(bar.host + '/' + gpu, bar.end);
      hold(bar.host + '\u0000' + bar.slot, bar.end);
    }
  const recent = <T extends { at: number }>(list: T[] | undefined, count = 5) =>
    (list ?? []).sort((a, b) => b.at - a.at).slice(0, count);
  const order = [...plans].sort(
    (a, b) =>
      (a.queue ?? Infinity) - (b.queue ?? Infinity) ||
      a.created - b.created ||
      a.id.localeCompare(b.id),
  );
  const planIds = new Set(order.map((plan) => plan.id)),
    planEnds = new Map<string, number>();
  const afterEnd = (after: string | null) => {
    if (!after) return { ready: true, at: now };
    const id = after.replace(/^plan:/, '');
    if (after.startsWith('plan:') || (planIds.has(id) && !runEnds.has(after)))
      return planEnds.has(id)
        ? { ready: true, at: planEnds.get(id)! }
        : { ready: !planIds.has(id), at: now };
    return { ready: true, at: runEnds.get(after) ?? now };
  };
  let waiting = order;
  // Plans queued after a later plan wait for it; a cycle is placed as it stands.
  for (let pass = 0; waiting.length && pass <= order.length; pass++) {
    const next: OccupancyPlan[] = [];
    for (const plan of waiting) {
      const after = afterEnd(plan.after);
      if (!after.ready && pass < order.length) {
        next.push(plan);
        continue;
      }
      const host = plan.host,
        slotKey = host + '\u0000' + plan.slot,
        gpus = plan.gpus?.length ? plan.gpus : (slotGpus.get(slotKey)?.gpus ?? null);
      if (host) remember(host, null, gpus, now);
      const start = Math.max(
          now,
          after.at,
          freeAt(slotKey),
          ...(gpus ?? []).map((gpu) => freeAt(host + '/' + gpu)),
        ),
        // A stated length, else the plan's config budget less where it starts.
        budget = finite(configValue(plan.config, keys.budget)),
        from = finite(configValue(plan.config, keys.start)) ?? plan.parentUpdate,
        stated =
          plan.updates ??
          (budget !== null && from !== null && budget > from ? budget - from : null),
        updates =
          stated ??
          median(recent(lengths.get(slotKey)).map((entry) => entry.length)) ??
          median(recent(lengths.get(host)).map((entry) => entry.length)),
        rate =
          median(recent(rates.get(slotKey)).map((entry) => entry.rate)) ??
          median(recent(rates.get(host)).map((entry) => entry.rate)),
        length = updates !== null && rate !== null ? updates * rate : null,
        end = start + (length ?? placeholderLength);
      planEnds.set(plan.id, end);
      if (host) {
        for (const gpu of gpus ?? []) hold(host + '/' + gpu, end);
        hold(slotKey, end);
      }
      bars.push({
        id: 'plan:' + plan.id,
        run: null,
        plan: plan.id,
        name: plan.name,
        host,
        slot: plan.slot,
        gpus,
        count: gpus?.length ?? null,
        start,
        end,
        kind: 'planned',
        state: 'planned',
        verdict: null,
        estimated: true,
        unknownLength: length === null,
        rows: [],
        budget: updates,
        rate,
      });
    }
    waiting = next;
  }

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
        highest = ids.length ? Math.max(...ids) : -1;
      return {
        host,
        model: models.get(host)?.model ?? '',
        rows: Array.from({ length: highest + 1 }, (_, gpu) => ({ key: host + '/' + gpu, gpu })),
      };
    });
  const byHost = new Map(hosts.map((host) => [host.host, host]));
  for (const bar of bars)
    if (bar.gpus?.length) bar.rows = bar.gpus.map((gpu) => bar.host + '/' + gpu);
  const loose = bars
    .filter((bar) => !bar.gpus?.length && byHost.has(bar.host))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  // A running run's two parts share a row.
  const placed = new Map<string, string>(),
    rowEnds = new Map<string, number[]>();
  for (const bar of loose) {
    const host = byHost.get(bar.host)!,
      owner = bar.run ?? bar.id,
      kept = bar.kind === 'remaining' ? placed.get(owner) : undefined;
    if (kept) {
      bar.rows = [kept];
      continue;
    }
    const ends = rowEnds.get(bar.host) ?? [];
    let index = ends.findIndex((end) => end <= bar.start);
    if (index < 0) {
      index = ends.length;
      ends.push(0);
      host.rows.push({ key: bar.host + '/?' + index, gpu: null });
    }
    // The whole run (with its estimate) keeps the row.
    const until = bar.kind === 'running' ? (runEnds.get(bar.run!) ?? bar.end) : bar.end;
    ends[index] = until;
    rowEnds.set(bar.host, ends);
    bar.rows = [bar.host + '/?' + index];
    placed.set(owner, bar.rows[0]);
  }
  return { now, hosts, bars, unplaced };
}
