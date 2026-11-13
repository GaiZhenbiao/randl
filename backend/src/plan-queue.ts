// Planned runs as the queue host agents take work from (docs/guides/planning.md,
// "The queue"): each plan's status follows the run carrying it out, and the waiting plans are
// ordered by queue position, then by the `after` chain, then by creation.
import type { GpuRequest, Plan, PlanStatus } from './ledger.js';

/** The status a plan takes from the state of the run carrying it out. */
export function statusFromRun(state: string): PlanStatus {
  if (state === 'finished') return 'done';
  if (['killed', 'crashed', 'failed'].includes(state)) return 'stopped';
  return 'started';
}

type Queued = Pick<Plan, 'id' | 'queue' | 'after' | 'created'>;
/**
 * Waiting plans in queue order: an explicit queue position first; else just behind the plan
 * they are queued after (a run they wait for counts as the front); else last, by creation.
 */
export function queueOrder<T extends Queued>(plans: T[]): T[] {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const rank = (plan: T, seen = new Set<string>()): number => {
    if (plan.queue !== null && plan.queue !== undefined) return plan.queue;
    if (!plan.after || seen.has(plan.id)) return Infinity;
    seen.add(plan.id);
    const before = byId.get(plan.after.replace(/^plan:/, ''));
    return before ? rank(before, seen) + 0.5 : 0.5;
  };
  return [...plans].sort(
    (a, b) => rank(a) - rank(b) || a.created - b.created || a.id.localeCompare(b.id),
  );
}

/** Where a moved plan goes among the others: before or after one of them, else last. */
export function moveWithin<T extends { id: string }>(
  others: T[],
  moved: T,
  place: { before?: string; after?: string },
) {
  const list = others.filter((plan) => plan.id !== moved.id),
    anchor = place.before ?? place.after,
    at = anchor === undefined ? -1 : list.findIndex((plan) => plan.id === anchor);
  if (at < 0) return [...list, moved];
  list.splice(place.before !== undefined ? at : at + 1, 0, moved);
  return list;
}

// GPU requests (docs/guides/planning.md): a plan asks for a number of GPUs with
// a minimum memory and model on one host; the allocator gives it specific GPUs when a host
// agent reports them free, head of the queue first, and a projection runs the same rules
// forward in time for the Plans page.
/** A GPU as the allocator sees it. */
export type Gpu = {
  host: string;
  gpu: number;
  model: string;
  memory_gb: number | null;
  allowed: boolean;
};
/** How long the head of the queue may wait before hosts that can run it hold GPUs for it. */
export const headHold = 6 * 3600;

/** The GPUs among `gpus` on `host` a request can use, by index. */
export function usable(request: GpuRequest, host: string, gpus: Gpu[]) {
  if (request.hosts?.length && !request.hosts.includes(host)) return [];
  const model = request.model?.trim().toLowerCase();
  return gpus
    .filter(
      (gpu) =>
        gpu.host === host &&
        gpu.allowed &&
        (request.min_memory_gb == null || (gpu.memory_gb ?? 0) >= request.min_memory_gb) &&
        (!model || gpu.model.toLowerCase().includes(model)),
    )
    .sort((a, b) => a.gpu - b.gpu);
}
/** The GPU ids a request takes on a host, lowest first, or null when too few are free. */
export function pick(request: GpuRequest, host: string, free: Gpu[]) {
  const found = usable(request, host, free);
  return found.length >= Math.max(1, request.gpus)
    ? found.slice(0, Math.max(1, request.gpus)).map((gpu) => gpu.gpu)
    : null;
}
/** Hosts whose GPUs could ever run the request, with all of them free. */
export function runnableHosts(request: GpuRequest, inventory: Gpu[]) {
  return [...new Set(inventory.map((gpu) => gpu.host))].filter(
    (host) => usable(request, host, inventory).length >= Math.max(1, request.gpus),
  );
}
/** Why no host can run a request, for the queue's "can't fit" mark. */
export function unfitReason(request: GpuRequest, inventory: Gpu[]) {
  const allowed = inventory.filter((gpu) => gpu.allowed);
  if (!allowed.length) return 'no-inventory';
  if (request.hosts?.length && !allowed.some((gpu) => request.hosts!.includes(gpu.host)))
    return 'no-host';
  return 'too-few';
}

type Waiting = { id: string; request: GpuRequest; since: number };
/**
 * The allocator on one host: the first waiting plan in queue order that fits the host's free
 * GPUs. A later plan may take GPUs the head cannot use yet (backfill), unless the head has
 * waited longer than `hold` and this host could run it: then the host holds them for it.
 * `ready` leaves out plans still waiting for the run or plan they are queued after.
 */
export function choose<T extends Waiting>(
  queue: T[],
  host: string,
  free: Gpu[],
  inventory: Gpu[],
  now: number,
  ready: (plan: T) => boolean = () => true,
  hold = headHold,
): { plan: T; gpus: number[] } | { held: T } | null {
  const candidates = queue.filter(ready);
  const head = candidates[0];
  for (const [index, plan] of candidates.entries()) {
    const gpus = pick(plan.request, host, free);
    if (gpus) return { plan, gpus };
    if (
      index === 0 &&
      now - plan.since > hold &&
      usable(plan.request, host, inventory).length >= Math.max(1, plan.request.gpus)
    )
      return { held: head };
  }
  return null;
}

export type Busy = { host: string; gpu: number; until: number; by: string };
export type Projected = {
  id: string;
  host: string;
  gpus: number[];
  start: number;
  end: number;
  /** What it waits for on its GPUs: the runs or plans holding them just before it starts. */
  after: string[];
  /** No length was known: the end is a placeholder. */
  unknownLength: boolean;
};
/**
 * The queue run forward: GPUs come free as runs and projected plans end, and at each such
 * time the waiting plans start head first, a plan taking the free host where it leaves the
 * fewest usable GPUs unused, with backfill and the head's hold as `choose` has them.
 * Plans no host can run, or that wait on something that never ends, are left unplaced.
 */
export function project<T extends Waiting>(input: {
  now: number;
  inventory: Gpu[];
  busy: Busy[];
  queue: T[];
  /** When a plan may start at the earliest (what it is queued after), or null when never. */
  readyAt: (plan: T, ends: Map<string, number>) => number | null;
  /** How long a plan runs on a host, or null when unknown. */
  length: (plan: T, host: string) => number | null;
  placeholder: number;
  hold?: number;
}) {
  const { now, inventory, queue, placeholder } = input,
    hold = input.hold ?? headHold,
    allowed = inventory.filter((gpu) => gpu.allowed),
    key = (host: string, gpu: number) => host + '/' + gpu,
    until = new Map<string, number>(),
    holder = new Map<string, { id: string; end: number }>(),
    ends = new Map<string, number>();
  for (const item of input.busy) {
    const at = key(item.host, item.gpu);
    if ((until.get(at) ?? -Infinity) < item.until) {
      until.set(at, item.until);
      holder.set(at, { id: item.by, end: item.until });
    }
    ends.set(item.by, Math.max(ends.get(item.by) ?? -Infinity, item.until));
  }
  const placed: Projected[] = [],
    unfit: { id: string; reason: string }[] = [];
  let waiting = queue.filter((plan) => {
    if (runnableHosts(plan.request, allowed).length) return true;
    unfit.push({ id: plan.id, reason: unfitReason(plan.request, inventory) });
    return false;
  });
  const hosts = [...new Set(allowed.map((gpu) => gpu.host))];
  let t = now;
  for (let step = 0; waiting.length && step < 10000; step++) {
    const freeAt = (time: number) =>
      allowed.filter((gpu) => (until.get(key(gpu.host, gpu.gpu)) ?? now) <= time);
    const isReady = (plan: T) => {
      const at = input.readyAt(plan, ends);
      return at !== null && at <= t;
    };
    const held = new Set<string>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      const free = freeAt(t),
        ready = waiting.filter(isReady),
        head = ready[0];
      for (const plan of ready) {
        const options = hosts
          .filter((host) => !held.has(host))
          .map((host) => ({ host, gpus: pick(plan.request, host, free) }))
          .filter((option): option is { host: string; gpus: number[] } => !!option.gpus)
          .map((option) => ({
            ...option,
            spare: usable(plan.request, option.host, free).length - option.gpus.length,
          }))
          .sort((a, b) => a.spare - b.spare);
        if (!options.length) {
          // A head that has waited too long holds the hosts that could run it.
          if (plan === head && t - plan.since > hold)
            for (const host of runnableHosts(plan.request, allowed)) held.add(host);
          continue;
        }
        const { host, gpus } = options[0],
          stated = input.length(plan, host),
          end = t + (stated ?? placeholder),
          after = [
            ...new Set(
              gpus
                .map((gpu) => holder.get(key(host, gpu)))
                .filter((item): item is { id: string; end: number } => !!item && item.end > now - 1)
                .map((item) => item.id),
            ),
          ];
        for (const gpu of gpus) {
          until.set(key(host, gpu), end);
          holder.set(key(host, gpu), { id: 'plan:' + plan.id, end });
        }
        ends.set('plan:' + plan.id, end);
        ends.set(plan.id, end);
        placed.push({
          id: plan.id,
          host,
          gpus,
          start: t,
          end,
          after,
          unknownLength: stated === null,
        });
        waiting = waiting.filter((item) => item !== plan);
        progressed = true;
        break;
      }
    }
    if (!waiting.length) break;
    // The next time something changes: a GPU comes free, or a plan's wait ends.
    const times = [
      ...[...until.values()].filter((time) => time > t),
      ...waiting
        .map((plan) => input.readyAt(plan, ends))
        .filter((time): time is number => time !== null && time > t),
    ];
    if (!times.length) break;
    t = Math.min(...times);
  }
  for (const plan of waiting) unfit.push({ id: plan.id, reason: 'waits' });
  return { placed, unfit };
}
