// Run lineage: which run each run started from, derived from stored configs (README "Lineage").
// The training code may log an explicit `lineage` config block; runs without one are matched
// by the checkpoint path in one of the project's parent keys.

/** A project's lineage settings, stored as the server setting `lineage:<project>`. */
export type LineageSettings = {
  /** History metric shown on each node ('' shows none). */
  metric: string;
  /** Multiplier for display, such as an episode count for a success rate; null shows the value. */
  scale: number | null;
  /** Whether higher or lower values of the metric are better. */
  goal: 'max' | 'min';
  /** Config keys whose value is the checkpoint path a run started from, tried in order. */
  parentKeys: string[];
  /** Config keys that name a run's own checkpoint folder or name, matched against parent paths. */
  identityKeys: string[];
  /** Config keys left out of diffs; `*` matches any characters. */
  ignoreKeys: string[];
};
export const lineageDefaults: LineageSettings = {
  metric: '',
  scale: null,
  goal: 'max',
  parentKeys: ['rl.checkpoint.initialize_from', 'rl.checkpoint.resume'],
  identityKeys: ['rl.checkpoint.save_dir', 'rl.checkpoint.run_name'],
  ignoreKeys: ['*save_dir', '*run_name', '*runs_root', '*_path', '*_dir', '*.name', '*.resume'],
};
/** At most this many changed keys travel on each edge; the side panel requests the full diff. */
export const edgeChangeLimit = 12;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ConfigChange = { key: string; from: Json | undefined; to: Json | undefined };
/** The fields a run contributes to the graph, read without parsing its whole config. */
export type LineageRun = {
  id: string;
  /** The SDK's run ID (the last part of `id`). */
  name: string;
  display_name: string;
  state: string;
  group: string;
  tags: string[];
  created: number;
  /** The stored `lineage` config block, if any. */
  lineage: Record<string, Json> | null;
  /** Values of the parent keys, in the order of the settings. */
  parents: (string | null)[];
  /** Values of the identity keys. */
  identities: (string | null)[];
};
export type LineageNode = {
  id: string;
  name: string;
  display_name: string;
  state: string;
  group: string;
  tags: string[];
  created: number;
  verdict: 'adopted' | 'rejected' | 'running' | null;
  hypothesis: string | null;
  /** What the run changed from its parent, in a sentence (`lineage.change`). */
  change: string | null;
  /** How the run turned out (`lineage.result`). */
  result: string | null;
  /** Why the verdict was given (`lineage.verdict.reason`). */
  verdictReason: string | null;
  recipe: Json | null;
  latest: number | null;
  best: number | null;
  /** A parent named by the run that matched no run in the project. */
  unresolved: Unresolved | null;
  /** The config bases the run's `lineage.extends` lists; `id` is the matching run, if any. */
  bases: { kind: string; reference: string; id: string | null }[];
  /** Where the run trained: `lineage.compute` as logged (host, gpu_count, segments). */
  compute: Compute | null;
};
export type ComputeSegment = {
  from_update: number | null;
  to_update: number | null;
  host: string | null;
  gpu_count: number | null;
  gpu_ids: number[] | null;
  gpu_model: string | null;
  slot: string | null;
};
export type Compute = {
  host: string | null;
  gpu_count: number | null;
  segments: ComputeSegment[];
};
export type LineageEdge = {
  source: string;
  target: string;
  /** The kind of link: initialize_from, resume, extend, or a parent key's last part. */
  relation: string;
  /** Further relations the run logged, such as grown_head or extends_config. */
  traits: string[];
  update: number | null;
  /** Whether the run's `lineage` block named the parent, rather than a matched path. */
  explicit: boolean;
  /** Whether several runs matched the parent path; the latest created before the child is used. */
  ambiguous: boolean;
  /** The first changed config keys; `runs_config_diff` gives every key with its values. */
  changedKeys: string[];
  changeCount: number;
  /** Whether the changes come from `lineage.changes` or a diff of the stored configs. */
  changeSource: 'lineage' | 'diff';
};

/** Unwraps W&B's `{key: {value, desc}}` config layout and drops `_wandb`. */
export function configValues(config: Record<string, any>): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const [key, value] of Object.entries(config))
    if (!key.startsWith('_'))
      result[key] = value && typeof value === 'object' && 'value' in value ? value.value : value;
  return result;
}
/** Dotted keys to leaf values; arrays are leaves. */
export function flattenConfig(values: Record<string, Json>): Map<string, Json> {
  const flat = new Map<string, Json>();
  const visit = (prefix: string, value: Json) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (!entries.length) flat.set(prefix, value);
      for (const [key, child] of entries) visit(prefix ? prefix + '.' + key : key, child);
    } else flat.set(prefix, value);
  };
  for (const [key, value] of Object.entries(values)) visit(key, value);
  return flat;
}
/** The SQLite JSON path of a dotted key inside W&B's config layout. */
export function configPath(key: string) {
  const [head, ...rest] = key.split('.');
  return ['$', quote(head), 'value', ...rest.map(quote)].join('.');
}
const quote = (segment: string) => '"' + segment.replace(/"/g, '""') + '"';

/** Whether a dotted key is one the patterns leave out of diffs (`lineage.*` always is). */
export function ignoredKey(patterns: string[]) {
  const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    '^(?:' +
      ['lineage', 'lineage.*', ...patterns]
        .map((item) => item.split('*').map(escape).join('.*'))
        .join('|') +
      ')$',
  );
  return (key: string) => pattern.test(key);
}
/** Keys whose values differ, sorted, leaving out the ignored keys. */
export function diffConfigs(
  from: Map<string, Json>,
  to: Map<string, Json>,
  ignore: string[],
): ConfigChange[] {
  const skip = ignoredKey(ignore),
    changes: ConfigChange[] = [];
  for (const key of new Set([...from.keys(), ...to.keys()])) {
    if (skip(key)) continue;
    const a = from.get(key),
      b = to.get(key);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ key, from: a, to: b });
  }
  return changes.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

const updateSegment = /^update_(\d+)$/,
  sourceLabel = /^(.+)_u(?:pdate_)?(\d+)$/;
/** Path segments that hold checkpoints rather than name a run. */
const containers = new Set(['checkpoints', 'checkpoint']);
/** The segments of a path, without empty ones. */
const segments = (path: string) => path.split(/[\\/]+/).filter(Boolean);
/** A run folder's own name: the last segment that is not a checkpoint container. */
export function folderName(path: string) {
  const parts = segments(path);
  while (parts.length && containers.has(parts.at(-1)!)) parts.pop();
  return parts.at(-1) ?? '';
}
/**
 * The update index a checkpoint path names: `update_00543000`, or a warm-source label such as
 * `<run>_u00543000` or `<run>_update_00543000`.
 */
export function pathUpdate(path: string): number | null {
  for (const part of segments(path).reverse()) {
    const match = updateSegment.exec(part) ?? sourceLabel.exec(part);
    if (match) return Number(match[match.length - 1]);
  }
  return null;
}

/** A run that a name or path may refer to, with its folders' segments (checkpoint folders dropped). */
type Candidate = { id: string; created: number; name: string; folders: string[][] };
/** Finds the run a parent checkpoint path or name refers to. */
export class RunMatcher {
  private tokens = new Map<string, Candidate[]>();
  private byName = new Map<string, Candidate[]>();
  private byId = new Map<string, Candidate>();
  constructor(runs: LineageRun[]) {
    const add = (map: Map<string, Candidate[]>, key: string, run: Candidate) => {
      if (!key || containers.has(key)) return;
      const list = map.get(key);
      if (!list) map.set(key, [run]);
      else if (!list.includes(run)) list.push(run);
    };
    for (const run of runs) {
      const candidate = {
        id: run.id,
        created: run.created,
        name: run.display_name,
        folders: run.identities
          .filter((identity): identity is string => !!identity)
          .map(folderPath),
      };
      this.byId.set(run.id, candidate);
      this.byId.set(run.name, candidate);
      add(this.byName, run.display_name, candidate);
      add(this.tokens, run.display_name, candidate);
      for (const identity of run.identities)
        if (identity) add(this.tokens, folderName(identity), candidate);
    }
  }
  /** The latest candidate created before the child, else the earliest; null for none. */
  private pick(list: Candidate[] | undefined, child: LineageRun) {
    const others = (list ?? []).filter((run) => run.id !== child.id);
    if (!others.length) return null;
    const before = others.filter((run) => run.created <= child.created),
      pool = before.length ? before : others;
    const chosen = pool.reduce((a, b) =>
      before.length ? (b.created > a.created ? b : a) : b.created < a.created ? b : a,
    );
    return { id: chosen.id, ambiguous: others.length > 1 };
  }
  /** A run named by SDK ID, full ID or display name (an explicit `lineage.parent`). */
  named(child: LineageRun, ids: string[], name: string | null) {
    const exact = ids.map((id) => this.byId.get(id)).find(Boolean);
    if (exact) return exact.id === child.id ? 'self' : { id: exact.id, ambiguous: false };
    if (!name) return null;
    const named = this.byName.get(name);
    return this.pick(named, child) ?? (named?.some((run) => run.id === child.id) ? 'self' : null);
  }
  /**
   * A run whose folder name or display name is a segment of the path, read from its end. A
   * `<label>_u<update>` or `<label>_update_<update>` segment (a copied warm source) also
   * matches runs named `<label>_…`.
   * 'self' when the nearest named segment is only the child's own folder or name.
   */
  path(child: LineageRun, path: string) {
    const parts = segments(path).filter((part) => !updateSegment.test(part));
    const own = (list: Candidate[] | undefined) => !!list?.some((run) => run.id === child.id);
    for (let index = parts.length - 1; index >= 0; index--) {
      const named = closest(this.tokens.get(parts[index]), parts.slice(0, index + 1), child),
        exact = this.pick(named, child);
      if (exact) return exact;
      if (own(named)) return 'self';
      const label = sourceLabel.exec(parts[index]);
      if (!label) continue;
      const labelled = this.tokens.get(label[1]),
        exactLabel = this.pick(labelled, child);
      if (exactLabel) return exactLabel;
      if (own(labelled)) return 'self';
      // A version label such as `v621` stands for the one run named `v621_…`; a prefix shared
      // by runs of different names (`forest_unbounded_…`) names none of them.
      const prefix = label[1] + '_',
        prefixed = new Set<Candidate>();
      for (const [token, list] of this.tokens)
        if (token.startsWith(prefix)) for (const run of list) prefixed.add(run);
      if (new Set([...prefixed].map((run) => run.name)).size !== 1) continue;
      const match = this.pick([...prefixed], child);
      if (match) return match;
    }
    return null;
  }
}

/** A folder path's segments without trailing checkpoint folders. */
function folderPath(path: string) {
  const parts = segments(path);
  while (parts.length && containers.has(parts.at(-1)!)) parts.pop();
  return parts;
}
/**
 * Of several runs whose folder has the matched name, those whose folder path shares the most
 * trailing segments with the parent path (`runtime_interior_u1/baseline` beats `baseline`).
 */
function closest(list: Candidate[] | undefined, path: string[], child: LineageRun) {
  const others = list?.filter((run) => run.id !== child.id);
  if (!list || !others || others.length < 2) return list;
  const shared = (run: Candidate) =>
    Math.max(
      0,
      ...run.folders.map((folder) => {
        let count = 0;
        while (
          count < folder.length &&
          count < path.length &&
          folder[folder.length - 1 - count] === path[path.length - 1 - count]
        )
          count++;
        return count;
      }),
    );
  const best = Math.max(...others.map(shared));
  return list.filter((run) => run.id === child.id || shared(run) === best);
}

const verdicts = ['adopted', 'rejected', 'running'] as const;
const text = (value: Json | undefined) =>
  typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
const integer = (value: Json | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : null;
const object = (value: Json | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null;
/** The keys `lineage.changes` names, sorted, or null when the block lists none. */
export function loggedChanges(lineage: Record<string, Json> | null): string[] | null {
  const changes = object(lineage?.changes);
  return changes ? Object.keys(changes).sort() : null;
}
type Unresolved = { source: string; update: number | null };
export type ParentMatch =
  | {
      id: string;
      ambiguous: boolean;
      relation: string;
      traits: string[];
      update: number | null;
      explicit: boolean;
    }
  | { unresolved: Unresolved };
/** A run's parent: its `lineage` block, else the first parent key whose path matches a run. */
export function resolveParent(
  run: LineageRun,
  matcher: RunMatcher,
  settings: LineageSettings,
): ParentMatch | null {
  // A logged block is authoritative: no named parent (a cold start) or the run itself (an
  // in-place resume or extension) means no link, even when a parent key holds a path.
  if (run.lineage) {
    const parent = object(run.lineage.parent),
      ids = [text(parent?.run_id), text(parent?.run_path)].filter((id): id is string => !!id),
      name = text(parent?.run_name),
      checkpoint = text(parent?.checkpoint);
    if (!ids.length && !name && !checkpoint) return null;
    // `relation` is a list, link kind first (a plain string is that kind alone).
    const logged = run.lineage.relation,
      relations = (Array.isArray(logged) ? logged : [logged]).filter(
        (item): item is string => typeof item === 'string' && !!item,
      ),
      [relation = 'initialize_from', ...traits] = relations,
      update = integer(parent!.update) ?? (checkpoint ? pathUpdate(checkpoint) : null);
    // The checkpoint path finds the parent when this host could not read its run ID.
    const match =
      matcher.named(run, ids, name) ?? (checkpoint ? matcher.path(run, checkpoint) : null);
    if (match === 'self') return null;
    if (match) return { ...match, relation, traits, update, explicit: true };
    return { unresolved: { source: name ?? ids[0] ?? checkpoint!, update } };
  }
  let unresolved: Unresolved | null = null;
  for (const [index, path] of run.parents.entries()) {
    if (!path) continue;
    const match = matcher.path(run, path),
      relation = settings.parentKeys[index].split('.').at(-1)!;
    // A resume or restart from the run's own folder keeps it one node.
    if (match === 'self') continue;
    if (match) return { ...match, relation, traits: [], update: pathUpdate(path), explicit: false };
    unresolved ??= { source: path, update: pathUpdate(path) };
  }
  return unresolved ? { unresolved } : null;
}
const numberOrNull = (value: Json | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
/** `lineage.compute` with the fields the page shows, or null when the run logged none. */
export function computeOf(lineage: Record<string, Json> | null): Compute | null {
  const compute = object(lineage?.compute);
  if (!compute) return null;
  const segments = (Array.isArray(compute.segments) ? compute.segments : [])
    .map(object)
    .filter((segment) => !!segment)
    .map((segment) => ({
      from_update: numberOrNull(segment.from_update),
      to_update: numberOrNull(segment.to_update),
      host: text(segment.host),
      gpu_count: numberOrNull(segment.gpu_count),
      gpu_ids: Array.isArray(segment.gpu_ids)
        ? segment.gpu_ids.filter((id): id is number => typeof id === 'number')
        : null,
      gpu_model: text(segment.gpu_model),
      slot: text(segment.slot),
    }));
  const last = segments.at(-1);
  return {
    host: text(compute.host) ?? last?.host ?? null,
    gpu_count: numberOrNull(compute.gpu_count) ?? last?.gpu_count ?? null,
    segments,
  };
}
/** The runs a `lineage.extends` list names, matched by run name. */
export function basesOf(run: LineageRun, matcher: RunMatcher) {
  const list = Array.isArray(run.lineage?.extends) ? run.lineage.extends : [];
  return list
    .map(object)
    .filter((item) => !!item && !!text(item.reference))
    .map((item) => {
      const kind = text(item!.kind) ?? 'file',
        reference = text(item!.reference)!,
        match = kind === 'run' ? matcher.named(run, [], reference) : null;
      return { kind, reference, id: match && match !== 'self' ? match.id : null };
    });
}
export function lineageNode(
  run: LineageRun,
  values: { latest: number | null; best: number | null },
  matcher: RunMatcher,
): LineageNode {
  const tags = new Set(run.tags.map((tag) => tag.toLowerCase()));
  return {
    id: run.id,
    name: run.name,
    display_name: run.display_name,
    state: run.state,
    group: run.group,
    tags: run.tags,
    created: run.created,
    // The verdict tag decides; the block's verdict applies to runs without one.
    verdict:
      verdicts.find((verdict) => tags.has('verdict:' + verdict)) ??
      // `verdict` is the status itself, or {status, reason}.
      verdicts.find(
        (verdict) =>
          verdict === (text(run.lineage?.verdict) ?? text(object(run.lineage?.verdict)?.status)),
      ) ??
      null,
    hypothesis: text(run.lineage?.hypothesis),
    change: text(run.lineage?.change),
    result: text(run.lineage?.result),
    verdictReason: text(object(run.lineage?.verdict)?.reason),
    recipe: run.lineage?.recipe ?? null,
    ...values,
    unresolved: null,
    bases: basesOf(run, matcher),
    compute: computeOf(run.lineage),
  };
}
/** Drops edges that would close a cycle, keeping the earlier-created child's parent. */
export function acyclic(edges: LineageEdge[], created: Map<string, number>) {
  const parent = new Map<string, string>();
  const kept: LineageEdge[] = [];
  for (const edge of [...edges].sort((a, b) => created.get(a.target)! - created.get(b.target)!)) {
    let cursor: string | undefined = edge.source,
      cycle = false;
    while (cursor !== undefined) {
      if (cursor === edge.target) {
        cycle = true;
        break;
      }
      cursor = parent.get(cursor);
    }
    if (cycle) continue;
    parent.set(edge.target, edge.source);
    kept.push(edge);
  }
  return kept;
}
