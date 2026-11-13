import { promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { DB } from './db.js';
import { runFolder } from './project-store.js';

// The media limit per run (docs/contributing/storage.md). When the files of a run's logged
// media exceed the limit, entries are removed until they fit again. Removal thins the run
// instead of dropping its oldest media: each key gives up the entry whose neighbors are
// closest on the project's thinning axis, so what remains is spread over the whole run.

/** The server setting that holds the limit: whether it is on, and its size in mebibytes. */
export const mediaCapSetting = 'media-limit';
export type MediaLimit = { enabled: boolean; megabytes: number };
export const mediaCapDefault: MediaLimit = { enabled: true, megabytes: 500 };
export const mediaCapMax = 1024 * 1024;
/** Thinning stops at this share of the limit, so the next upload does not thin again. */
const targetShare = 0.9;

/** The limit as set, or the default. */
export async function mediaLimit(db: DB): Promise<MediaLimit> {
  const value = await db.call('settingGet', mediaCapSetting);
  return value && typeof value.enabled === 'boolean' && value.megabytes >= 1
    ? { enabled: value.enabled, megabytes: value.megabytes }
    : mediaCapDefault;
}
/** The server setting that holds one project's own limit and thinning axis. */
export const projectLimitSetting = (project: string) => 'media-limit:' + project;
/**
 * A project's media limit: the server's while `inherit`, otherwise its own `enabled` and
 * `megabytes`; and the axis its runs' media are spaced on when thinned.
 */
export type ProjectMediaLimit = MediaLimit & { inherit: boolean; axis: string };
/** A project's settings as saved (its own limit starts from the server's), and the limit in effect. */
export async function projectMediaLimit(db: DB, project: string) {
  const server = await mediaLimit(db),
    saved = await db.call('settingGet', projectLimitSetting(project)),
    own = saved && typeof saved === 'object' ? saved : {},
    limit: ProjectMediaLimit = {
      inherit: own.inherit !== false,
      enabled: typeof own.enabled === 'boolean' ? own.enabled : server.enabled,
      megabytes: own.megabytes >= 1 ? own.megabytes : server.megabytes,
      axis: typeof own.axis === 'string' && own.axis ? own.axis : '_step',
    };
  return {
    ...limit,
    effective: limit.inherit ? server : { enabled: limit.enabled, megabytes: limit.megabytes },
  };
}
const projectOf = (run: string) => run.split('/').slice(0, 2).join('/');
/** The limit in bytes that applies to each project's runs, or 0 while it is off; read once per project. */
function projectCaps(db: DB) {
  const caps = new Map<string, Promise<number>>();
  return (run: string) => {
    const project = projectOf(run);
    if (!caps.has(project))
      caps.set(
        project,
        projectMediaLimit(db, project).then(({ effective }) =>
          effective.enabled ? effective.megabytes * megabyte : 0,
        ),
      );
    return caps.get(project)!;
  };
}
/** One logged media value: its key, step and files. */
export type CapEntry = {
  metric: number;
  step: number;
  /** The entry's place on the axis that spacing is measured on; its step when absent. */
  x?: number;
  files: { path: string; bytes: number }[];
  /** False while some file has not been uploaded; such entries are never removed. */
  complete: boolean;
};
type Node = {
  entry: CapEntry;
  previous?: Node;
  next?: Node;
  removed?: boolean;
};
type Candidate = { node: Node; first: boolean; span: number };
const place = (entry: CapEntry) => entry.x ?? entry.step;
const before = (a: Candidate, b: Candidate) =>
  a.first !== b.first
    ? !a.first
    : a.span !== b.span
      ? a.span < b.span
      : place(a.node.entry) !== place(b.node.entry)
        ? place(a.node.entry) < place(b.node.entry)
        : a.node.entry.step < b.node.entry.step;
class Heap {
  private items: Candidate[] = [];
  push(item: Candidate) {
    const items = this.items;
    let at = items.push(item) - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!before(items[at], items[parent])) break;
      [items[at], items[parent]] = [items[parent], items[at]];
      at = parent;
    }
  }
  peek() {
    return this.items[0];
  }
  pop() {
    const items = this.items,
      top = items[0],
      last = items.pop()!;
    if (items.length) {
      items[0] = last;
      for (let at = 0; ; ) {
        const left = at * 2 + 1,
          right = left + 1;
        let least = at;
        if (left < items.length && before(items[left], items[least])) least = left;
        if (right < items.length && before(items[right], items[least])) least = right;
        if (least === at) break;
        [items[at], items[least]] = [items[least], items[at]];
        at = least;
      }
    }
    return top;
  }
}
/**
 * What a removal would leave between its neighbors. A key's newest entry is never a
 * candidate; its first entry is one only after every key has run out of entries in between.
 */
function candidate(node: Node): Candidate | undefined {
  if (node.removed || !node.next || !node.entry.complete) return;
  return node.previous
    ? { node, first: false, span: place(node.next.entry) - place(node.previous.entry) }
    : { node, first: true, span: place(node.next.entry) - place(node.entry) };
}
/**
 * The entries to remove so that a run's media fit `target` bytes, when they exceed `cap`.
 * Each removal comes from the key that holds the most bytes and takes the entry whose
 * neighbors are closest on the axis (the earliest among equals), so every key keeps an even
 * spread along it, its first entry for as long as others remain, and always its newest. A file that
 * several entries name is freed with the last of them.
 */
export function planMediaThinning(
  entries: CapEntry[],
  cap: number,
  target = cap * targetShare,
) {
  const references = new Map<string, { bytes: number; count: number }>();
  let total = 0;
  for (const entry of entries)
    for (const file of entry.files) {
      const known = references.get(file.path);
      if (known) known.count++;
      else {
        references.set(file.path, { bytes: file.bytes, count: 1 });
        total += file.bytes;
      }
    }
  const result = { total, freed: 0, remove: [] as CapEntry[], paths: [] as string[] };
  if (!(cap > 0) || total <= cap) return result;
  const keys = new Map<number, { bytes: number; heap: Heap }>();
  const byKey = new Map<number, CapEntry[]>();
  for (const entry of entries)
    if (entry.files.length) {
      if (!byKey.has(entry.metric)) byKey.set(entry.metric, []);
      byKey.get(entry.metric)!.push(entry);
    }
  const size = (entry: CapEntry) => entry.files.reduce((sum, file) => sum + file.bytes, 0);
  for (const [metric, list] of byKey) {
    list.sort((a, b) => place(a) - place(b) || a.step - b.step);
    const key = { bytes: 0, heap: new Heap() },
      nodes: Node[] = list.map((entry) => ({ entry }));
    for (const [index, node] of nodes.entries()) {
      node.previous = nodes[index - 1];
      node.next = nodes[index + 1];
      key.bytes += size(node.entry);
    }
    for (const node of nodes) {
      const item = candidate(node);
      if (item) key.heap.push(item);
    }
    keys.set(metric, key);
  }
  /** A key's best current candidate; entries queued before a neighbor changed are dropped. */
  const best = (heap: Heap) => {
    for (;;) {
      const top = heap.peek();
      if (!top) return;
      const current = candidate(top.node);
      if (current && current.first === top.first && current.span === top.span) return top;
      heap.pop();
    }
  };
  while (total - result.freed > target) {
    let chosen: { bytes: number; heap: Heap } | undefined, pick: Candidate | undefined;
    for (const key of keys.values()) {
      const top = best(key.heap);
      if (!top) continue;
      if (
        !pick ||
        (pick.first && !top.first) ||
        (pick.first === top.first && key.bytes > chosen!.bytes)
      ) {
        chosen = key;
        pick = top;
      }
    }
    if (!pick || !chosen) break;
    chosen.heap.pop();
    const { node } = pick,
      { previous, next } = node;
    node.removed = true;
    if (previous) previous.next = next;
    if (next) next.previous = previous;
    for (const neighbor of [previous, next]) {
      const item = neighbor && candidate(neighbor);
      if (item) chosen.heap.push(item);
    }
    chosen.bytes -= size(node.entry);
    result.remove.push(node.entry);
    for (const file of node.entry.files) {
      const known = references.get(file.path)!;
      if (--known.count) continue;
      result.freed += known.bytes;
      result.paths.push(file.path);
    }
  }
  return result;
}

const megabyte = 1024 * 1024;
/** Runs whose media totals are remembered between uploads. */
const rememberedRuns = 256;
/** Runs measured per pass; the rest wait for the next one. */
const runsPerPass = 4;
/** Passes follow an upload after `uploadDelay` ms, and one another after `sweepDelay`. */
const uploadDelay = 2000,
  sweepDelay = 100;
/**
 * Applies each project's limit to its runs. All runs with media are measured when the server
 * starts and when a limit changes; after that a run is measured when it first uploads a media
 * file and again once its uploads since could have passed the limit. The files are read
 * from the run's folder, outside the database worker.
 */
export class MediaCap {
  private totals = new Map<string, number>();
  private waiting = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  constructor(
    private db: DB,
    private directory: string,
    private changed: (run: string) => void,
  ) {}
  private schedule(delay: number) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pass();
    }, delay);
    this.timer.unref();
  }
  /** Queues every run with media to be measured, finished runs included. */
  async sweep() {
    if (this.closed) return;
    for (const run of (await this.db.call('runsWithMedia')) as string[]) {
      this.totals.delete(run);
      this.waiting.add(run);
    }
    if (this.waiting.size) this.schedule(sweepDelay);
  }
  /** Notes an uploaded run file; media files may start a pass. */
  uploaded(run: string, path: string, delta: number) {
    if (this.closed || !path.startsWith('media/')) return;
    const known = this.totals.get(run);
    if (known !== undefined) this.totals.set(run, known + delta);
    this.waiting.add(run);
    this.schedule(uploadDelay);
  }
  /** Measures the waiting runs and thins those over the limit. */
  pass(): Promise<void> {
    return (this.running ??= this.work().finally(() => {
      this.running = undefined;
      if (this.waiting.size) this.schedule(sweepDelay);
    }));
  }
  private async work() {
    const capOf = projectCaps(this.db);
    let measured = 0;
    for (const run of [...this.waiting]) {
      const known = this.totals.get(run),
        cap = await capOf(run);
      if (!cap || (known !== undefined && known <= cap)) {
        this.waiting.delete(run);
        continue;
      }
      if (measured++ >= runsPerPass) break;
      this.waiting.delete(run);
      try {
        await this.apply(run, cap);
      } catch {
        // A run deleted meanwhile has nothing left to thin; another upload measures it again.
        this.totals.delete(run);
      }
    }
  }
  /** A run's media entries with the sizes of their uploaded files. */
  async measure(run: string): Promise<CapEntry[]> {
    const rows: { metric: number; step: number; x: number; paths: string[] }[] = await this.db.call(
        'runMediaFiles',
        run,
      ),
      folder = runFolder(this.directory, run),
      sizes = new Map<string, number | null>();
    for (const row of rows) for (const path of row.paths) sizes.set(path, null);
    const paths = [...sizes.keys()];
    for (let start = 0; start < paths.length; start += 32)
      await Promise.all(
        paths.slice(start, start + 32).map(async (path) => {
          const file = resolve(folder, path);
          if (!file.startsWith(folder + sep)) return;
          const stat = await fs.stat(file).catch(() => null);
          if (stat?.isFile()) sizes.set(path, stat.size);
        }),
      );
    return rows.map((row) => ({
      metric: row.metric,
      step: row.step,
      x: row.x,
      complete: row.paths.every((path) => sizes.get(path) != null),
      files: row.paths.flatMap((path) => {
        const bytes = sizes.get(path);
        return bytes == null ? [] : [{ path, bytes }];
      }),
    }));
  }
  /**
   * Applies the limit to every run with media now, or with `dryRun` only reports what that
   * would remove.
   */
  async applyAll(dryRun: boolean) {
    const capOf = projectCaps(this.db),
      runs: string[] = await this.db.call('runsWithMedia'),
      result = { dryRun, runs: runs.length, runsOver: 0, entries: 0, files: 0, bytes: 0 };
    for (const run of runs) {
      const cap = await capOf(run);
      if (!cap) continue;
      const removed = await this.apply(run, cap, dryRun);
      if (!removed.entries) continue;
      result.runsOver++;
      result.entries += removed.entries;
      result.files += removed.files;
      result.bytes += removed.bytes;
    }
    return result;
  }
  /** Thins one run to the limit and returns what was removed. */
  async apply(run: string, cap: number, dryRun = false) {
    const plan = planMediaThinning(await this.measure(run), cap);
    if (dryRun)
      return { entries: plan.remove.length, files: plan.paths.length, bytes: plan.freed };
    if (plan.remove.length) {
      // Rows go first, so no panel is offered an entry whose files are being removed.
      await this.db.call(
        'runMediaDelete',
        run,
        plan.remove.map((entry) => [entry.metric, entry.step]),
      );
      const folder = runFolder(this.directory, run);
      let freed = 0;
      for (const path of plan.paths) {
        const file = resolve(folder, path),
          size = await fs.stat(file).then(
            (stat) => stat.size,
            () => 0,
          );
        await fs.rm(file, { force: true });
        freed += size;
      }
      plan.freed = freed;
      await this.db.call('runFileWritten', run, -freed);
      this.changed(run);
    }
    this.totals.delete(run);
    this.totals.set(run, plan.total - plan.freed);
    if (this.totals.size > rememberedRuns) this.totals.delete(this.totals.keys().next().value!);
    return { entries: plan.remove.length, files: plan.paths.length, bytes: plan.freed };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
