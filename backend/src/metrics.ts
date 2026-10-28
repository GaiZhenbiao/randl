/**
 * In-memory server request metrics in fixed one-minute buckets. Memory is constant:
 * a ring of BUCKETS minutes, each holding a latency histogram and counters per route
 * group plus one for database worker calls.
 */
export const BUCKET_MS = 60_000;
export const BUCKETS = 180;
export const GROUPS = ['sdk', 'api', 'agent', 'ui'] as const;
export type Group = (typeof GROUPS)[number];
// Latency bins grow by 25% from 0.25 ms to about 3.5 minutes; the last bin is open-ended.
const FIRST = 0.25,
  RATIO = 1.25,
  BINS = 62;
const LOG_RATIO = Math.log(RATIO);
function bin(ms: number) {
  if (!(ms > FIRST)) return 0;
  return Math.min(BINS - 1, Math.ceil(Math.log(ms / FIRST) / LOG_RATIO));
}
const upper = (index: number) => FIRST * RATIO ** index;
type Counters = {
  count: number;
  errors: number;
  clientErrors: number;
  requestBytes: number;
  responseBytes: number;
  totalMs: number;
  histogram: Uint32Array;
};
const empty = (): Counters => ({
  count: 0,
  errors: 0,
  clientErrors: 0,
  requestBytes: 0,
  responseBytes: 0,
  totalMs: 0,
  histogram: new Uint32Array(BINS),
});
type Bucket = { t: number; groups: Record<Group, Counters>; db: Counters; queue: number };
export function routeGroup(url: string): Group | undefined {
  const path = url.split('?', 1)[0];
  if (path === '/api/events') return undefined;
  if (/^\/(graphql|files|upload|storage|sdk)(\/|$)/.test(path)) return 'sdk';
  if (/^\/api\/(agent|conversations)(\/|$)/.test(path)) return 'agent';
  if (path.startsWith('/api/')) return 'api';
  return 'ui';
}
function percentile(histogram: Uint32Array, count: number, fraction: number) {
  if (!count) return null;
  let target = Math.ceil(count * fraction),
    seen = 0;
  for (let index = 0; index < BINS; index++) {
    seen += histogram[index];
    // Report the geometric middle of the bin that contains the percentile.
    if (seen >= target) return index ? Math.sqrt(upper(index - 1) * upper(index)) : FIRST;
  }
  return upper(BINS - 1);
}
function summary(counters: Counters) {
  const { histogram, count, totalMs, ...rest } = counters;
  return {
    ...rest,
    count,
    meanMs: count ? totalMs / count : null,
    p50: percentile(histogram, count, 0.5),
    p95: percentile(histogram, count, 0.95),
    p99: percentile(histogram, count, 0.99),
  };
}
export class ServerMetrics {
  readonly started = Date.now();
  private ring: (Bucket | undefined)[] = new Array(BUCKETS);
  private bucket(now: number) {
    const t = Math.floor(now / BUCKET_MS) * BUCKET_MS,
      index = (t / BUCKET_MS) % BUCKETS;
    let current = this.ring[index];
    if (!current || current.t !== t) {
      current = {
        t,
        groups: Object.fromEntries(GROUPS.map((group) => [group, empty()])) as Record<Group, Counters>,
        db: empty(),
        queue: 0,
      };
      this.ring[index] = current;
    }
    return current;
  }
  request(group: Group, ms: number, status: number, requestBytes: number, responseBytes: number, now = Date.now()) {
    const counters = this.bucket(now).groups[group];
    counters.count++;
    if (status >= 500) counters.errors++;
    else if (status >= 400) counters.clientErrors++;
    counters.requestBytes += requestBytes;
    counters.responseBytes += responseBytes;
    counters.totalMs += ms;
    counters.histogram[bin(ms)]++;
  }
  databaseCall(ms: number, queue: number, failed: boolean, now = Date.now()) {
    const current = this.bucket(now),
      counters = current.db;
    counters.count++;
    if (failed) counters.errors++;
    counters.totalMs += ms;
    counters.histogram[bin(ms)]++;
    current.queue = Math.max(current.queue, queue);
  }
  /** Buckets that start at or after `since`, oldest first; the newest one is still filling. */
  buckets(since = 0, now = Date.now()) {
    const oldest = Math.floor(now / BUCKET_MS) * BUCKET_MS - (BUCKETS - 1) * BUCKET_MS;
    return this.ring
      .filter((item): item is Bucket => !!item && item.t >= Math.max(since, oldest))
      .sort((a, b) => a.t - b.t)
      .map((item) => ({
        t: item.t,
        groups: Object.fromEntries(GROUPS.map((group) => [group, summary(item.groups[group])])),
        db: { ...summary(item.db), maxQueue: item.queue },
      }));
  }
}
