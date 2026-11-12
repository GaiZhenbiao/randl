// Planned runs as the queue training supervisors take work from (README "Plans and GPU
// occupancy"): each plan's status follows the run carrying it out, and each slot's waiting
// plans are ordered by queue position, then by the `after` chain, then by creation.
import type { Plan, PlanStatus } from './ledger.js';

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
