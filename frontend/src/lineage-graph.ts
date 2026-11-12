// The Lineage page's graph model: which runs to show, the path to a run, and node positions.
// The server derives nodes and edges (`project_lineage`); this module only arranges them.
import type { Message, MessageKey } from './i18n';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Verdict = 'adopted' | 'rejected' | 'running';
export type LineageNode = {
  id: string;
  name: string;
  display_name: string;
  state: string;
  group: string;
  tags: string[];
  created: number;
  verdict: Verdict | null;
  hypothesis: string | null;
  change: string | null;
  result: string | null;
  verdictReason: string | null;
  /** Why the run was stopped on purpose, when it was marked so. */
  stateReason?: string;
  recipe: Json | null;
  jobType: string;
  latest: number | null;
  best: number | null;
  recent: number | null;
  plan: string | null;
  examines: string[];
  files: EvidenceFile[];
  /** Set on the stand-in node of a planned run that has not started. */
  planned?: Plan;
  unresolved: { source: string; update: number | null } | null;
  bases: { kind: string; reference: string; id: string | null }[];
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
export type Compute = { host: string | null; gpu_count: number | null; segments: ComputeSegment[] };
export type ConfigChange = { key: string; from?: Json; to?: Json; ignored?: boolean };
export type LineageEdge = {
  source: string;
  target: string;
  relation: string;
  traits: string[];
  update: number | null;
  explicit: boolean;
  ambiguous: boolean;
  changedKeys: string[];
  changeCount: number;
  changeSource: 'lineage' | 'diff';
};
export type LineageSettings = {
  metric: string;
  scale: number | null;
  goal: 'max' | 'min';
  parentKeys: string[];
  identityKeys: string[];
  ignoreKeys: string[];
  window: number;
};
export type Source = { document: string; lines?: [number, number]; quote?: string };
export type EvidenceFile = {
  name: string;
  path?: string;
  host?: string;
  bytes?: number;
  upload?: boolean;
};
export type Plan = {
  id: string;
  name: string;
  parent: string | null;
  parentUpdate: number | null;
  hypothesis: string;
  change: string;
  config: Json | null;
  baseline: string | null;
  rule: string;
  host: string;
  slot: string;
  queue: number | null;
  /** The run or plan this one is queued after. */
  after: string | null;
  /** GPU indices on its host; else those its slot last used. */
  gpus?: number[] | null;
  /** How far it will train (updates), for its estimated length. */
  updates?: number | null;
  source: Source | null;
  /** planned → started (claimed or running) → done | stopped; or cancelled. */
  status: 'planned' | 'started' | 'done' | 'stopped' | 'cancelled';
  /** The exact config file text. */
  config_yaml?: string | null;
  /** The run this plan continues. */
  resume_run?: string | null;
  /**
   * The supervisor that took it from its slot's queue, while its run has not appeared, and
   * the slot it claimed from (for a pool's plan, the member it runs on).
   */
  claim?: { by: string; host: string; at: number; slot?: string } | null;
  /** The idea it was promoted from. */
  idea?: string | null;
  /** The GPUs it asks for. */
  resources?: GpuRequest | null;
  /** The host and GPUs given to it by a claim, until its run ends. */
  allocation?: { host: string; gpus: number[]; at: number; by: string; released?: number | null } | null;
  events?: { at: number; status: string; by?: string; run?: string; note?: string }[];
  /** The run that carried the plan out, if any. */
  run: string | null;
  created: number;
  updated: number;
  by: string;
};
export type RecipeEvent = {
  id: number;
  run: string;
  since: number;
  reason: string;
  source: Source | null;
  by: string;
};
export type LineageGraph = {
  project: string;
  settings: LineageSettings;
  nodes: LineageNode[];
  edges: LineageEdge[];
  plans: Plan[];
  recipe: RecipeEvent | null;
  counts: { runs: number; explicit: number; matched: number; unresolved: number };
};
export type Axis = 'depth' | 'update' | 'time';
export type Filters = {
  search: string;
  group: string;
  tag: string;
  host: string;
  collapseRejected: boolean;
  showIsolated: boolean;
};

export type GraphIndex = {
  nodes: Map<string, LineageNode>;
  /** Each child's incoming edge. */
  parent: Map<string, LineageEdge>;
  children: Map<string, LineageEdge[]>;
};
export function indexGraph(graph: LineageGraph): GraphIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node])),
    parent = new Map<string, LineageEdge>(),
    children = new Map<string, LineageEdge[]>();
  for (const edge of graph.edges) {
    parent.set(edge.target, edge);
    const list = children.get(edge.source);
    if (list) list.push(edge);
    else children.set(edge.source, [edge]);
  }
  return { nodes, parent, children };
}
/** The runs from the root of a run's lineage to the run itself. */
export function pathToRoot(id: string, index: GraphIndex): string[] {
  const path = [id];
  for (let edge = index.parent.get(id); edge; edge = index.parent.get(edge.source))
    path.unshift(edge.source);
  return path;
}
/** Every run below a run, through any number of links. */
export function descendants(id: string, index: GraphIndex, into = new Set<string>()) {
  const pending = [id];
  while (pending.length)
    for (const edge of index.children.get(pending.pop()!) ?? [])
      if (!into.has(edge.target)) {
        into.add(edge.target);
        pending.push(edge.target);
      }
  return into;
}
export type Visible = {
  /** Runs drawn, in the server's order (creation). */
  shown: string[];
  /** Shown runs that only connect matching runs to their roots. */
  context: Set<string>;
  /** Hidden runs below each collapsed rejected run. */
  collapsed: Map<string, number>;
  /** Runs that match the filters but have no parent or child, while those are hidden. */
  isolatedHidden: number;
  /** Runs that match the filters. */
  matches: number;
};
/**
 * The runs to draw: those matching the filters and the ancestors that connect them to their
 * roots, without the runs below a rejected run while those are collapsed. Runs with no parent
 * and no child are drawn only on request.
 */
/**
 * How well a run matches a search, best first: 0 when its short name (v636) starts with the
 * query, 1 when its name or ID does, 2 when any of them contains it; null for no match.
 */
export function searchRank(node: Pick<LineageNode, 'id' | 'name' | 'display_name'>, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = node.display_name.toLowerCase(),
    short = name.split('_')[0],
    ids = [node.name.toLowerCase(), node.id.toLowerCase()];
  if (short.startsWith(q)) return 0;
  if (name.startsWith(q) || ids.some((id) => id.startsWith(q))) return 1;
  if (name.includes(q) || ids.some((id) => id.includes(q))) return 2;
  return null;
}
/** The runs a search suggests, best matches first, then in name order (v630 before v631). */
export function searchRuns(nodes: LineageNode[], query: string, limit = 8) {
  if (!query.trim()) return [];
  return nodes
    .map((node) => ({ node, rank: searchRank(node, query) }))
    .filter((item): item is { node: LineageNode; rank: number } => item.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.node.display_name.localeCompare(b.node.display_name, undefined, { numeric: true }),
    )
    .slice(0, limit)
    .map((item) => item.node);
}
export function visibleRuns(graph: LineageGraph, index: GraphIndex, filters: Filters): Visible {
  const query = filters.search.trim().toLowerCase();
  const matching = new Set(
    graph.nodes
      .filter(
        (node) =>
          (!query || searchRank(node, query) !== null) &&
          (!filters.group || node.group === filters.group) &&
          (!filters.tag || node.tags.includes(filters.tag)) &&
          (!filters.host || node.compute?.host === filters.host),
      )
      .map((node) => node.id),
  );
  const hidden = new Set<string>(),
    collapsed = new Map<string, number>();
  if (filters.collapseRejected)
    for (const node of graph.nodes)
      if (node.verdict === 'rejected' && !hidden.has(node.id)) {
        const below = descendants(node.id, index, new Set());
        if (below.size) collapsed.set(node.id, below.size);
        for (const id of below) hidden.add(id);
      }
  // A rejected run inside another collapsed branch is hidden with it.
  for (const id of collapsed.keys()) if (hidden.has(id)) collapsed.delete(id);
  // Planned runs are drawn even before they have a parent in the graph.
  const isolated = (id: string) =>
    !index.parent.has(id) && !index.children.has(id) && !index.nodes.get(id)?.planned;
  let isolatedHidden = 0;
  const shown = new Set<string>(),
    context = new Set<string>();
  for (const id of matching) {
    // A searched-for run shows even inside a collapsed branch or without links.
    if (hidden.has(id) && !query) continue;
    if (!filters.showIsolated && isolated(id) && !query) {
      isolatedHidden++;
      continue;
    }
    shown.add(id);
    for (let edge = index.parent.get(id); edge; edge = index.parent.get(edge.source)) {
      // Every shown run already has its ancestors shown.
      if (shown.has(edge.source)) break;
      shown.add(edge.source);
      if (!matching.has(edge.source)) context.add(edge.source);
    }
  }
  return {
    shown: graph.nodes.filter((node) => shown.has(node.id)).map((node) => node.id),
    context,
    collapsed,
    isolatedHidden,
    matches: matching.size,
  };
}

/** The name parts of a run that its parent's name lacks; the first part always stays. */
export function nameDelta(name: string, parentName: string | undefined) {
  const parts = name.split('_');
  if (!parentName) return parts.slice(1).join(' ');
  const inherited = new Set(parentName.split('_'));
  return parts
    .slice(1)
    .filter((part) => !inherited.has(part))
    .join(' ');
}

export const nodeWidth = 260,
  nodeHeight = 112;
const gap = { rank: 170, node: 24 };
export type Position = { x: number; y: number };
export type Layout = { positions: Map<string, Position>; width: number; height: number };
type Dagre = typeof import('@dagrejs/dagre');
/**
 * Positions of node cards (top-left corners). Connected runs are laid out left to right by
 * dagre; along a time or update axis, their columns follow the run's start instead, moved down
 * where cards would overlap. Runs without a drawn edge fill a grid below.
 */
export function layoutGraph(
  dagre: Dagre,
  ids: string[],
  edges: LineageEdge[],
  axis: Axis,
  start: (id: string) => number | null,
): Layout {
  const linked = new Set<string>();
  for (const edge of edges) linked.add(edge.source).add(edge.target);
  const positions = new Map<string, Position>();
  let width = 0,
    height = 0;
  if (linked.size) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', ranksep: gap.rank, nodesep: gap.node, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of ids)
      if (linked.has(id)) g.setNode(id, { width: nodeWidth, height: nodeHeight });
    for (const edge of edges) g.setEdge(edge.source, edge.target);
    dagre.layout(g);
    for (const id of linked) {
      const node = g.node(id);
      positions.set(id, { x: node.x - nodeWidth / 2, y: node.y - nodeHeight / 2 });
    }
    if (axis !== 'depth') placeOnAxis(positions, start);
    for (const position of positions.values()) {
      width = Math.max(width, position.x + nodeWidth);
      height = Math.max(height, position.y + nodeHeight);
    }
  }
  const loose = ids.filter((id) => !linked.has(id));
  if (loose.length) {
    const columns = Math.max(
        1,
        Math.min(
          loose.length,
          Math.floor((Math.max(width, 1200) + gap.node) / (nodeWidth + gap.node)),
        ),
      ),
      top = linked.size ? height + gap.rank / 2 : 0;
    loose.forEach((id, index) =>
      positions.set(id, {
        x: (index % columns) * (nodeWidth + gap.node),
        y: top + Math.floor(index / columns) * (nodeHeight + gap.node),
      }),
    );
    width = Math.max(width, columns * (nodeWidth + gap.node) - gap.node);
    height = top + Math.ceil(loose.length / columns) * (nodeHeight + gap.node) - gap.node;
  }
  return { positions, width, height };
}
/** At most this many columns along a start axis, so a time axis stays a few screens wide. */
const axisColumns = 40;
/**
 * Moves each card to the column of its start on a shared axis: starts map proportionally onto
 * at most `axisColumns` columns, runs with no known start (roots) take a column before them,
 * and cards that share a column stack downward in their layout order.
 */
function placeOnAxis(positions: Map<string, Position>, start: (id: string) => number | null) {
  const starts = new Map([...positions.keys()].map((id) => [id, start(id)]));
  const values = [...starts.values()].filter((v): v is number => v !== null),
    low = Math.min(...values),
    span = values.length ? Math.max(...values) - low : 0,
    columns = Math.min(new Set(values).size, axisColumns),
    first = [...starts.values()].includes(null) ? 1 : 0,
    step = nodeWidth + gap.rank / 2;
  const column = (value: number | null) =>
    value === null ? 0 : first + (span ? Math.round(((value - low) / span) * (columns - 1)) : 0);
  // Lowest free top in each column; cards are placed in their layout's top-to-bottom order.
  const free = new Map<number, number>();
  for (const [id, position] of [...positions].sort((a, b) => a[1].y - b[1].y)) {
    const index = column(starts.get(id)!);
    position.x = index * step;
    position.y = Math.max(position.y, free.get(index) ?? -Infinity);
    free.set(index, position.y + nodeHeight + gap.node);
  }
}
/** A cubic path from a parent card's right edge to a child card's left edge. */
export function edgePath(from: Position, to: Position) {
  const x1 = from.x + nodeWidth,
    y1 = from.y + nodeHeight / 2,
    x2 = to.x,
    y2 = to.y + nodeHeight / 2,
    bend = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
/** The last part of a dotted config key, which is usually enough to recognise it on an edge. */
export const shortKey = (key: string) => key.split('.').at(-1)!;

export const verdictLabels: Record<Verdict, MessageKey> = {
  adopted: 'lineage.verdict.adopted',
  rejected: 'lineage.verdict.rejected',
  running: 'lineage.verdict.running',
};
const relationLabels: Record<string, MessageKey> = {
  initialize_from: 'lineage.relation.initializeFrom',
  resume: 'lineage.relation.resume',
  extend: 'lineage.relation.extend',
  grown_head: 'lineage.relation.grownHead',
  grown_gru: 'lineage.relation.grownGru',
  added_inputs: 'lineage.relation.addedInputs',
  added_frames: 'lineage.relation.addedFrames',
  extends_config: 'lineage.relation.extendsConfig',
};
/** A relation's name; one the training code invented is shown as logged. */
export const relationLabel = (relation: string): Message =>
  Object.hasOwn(relationLabels, relation) ? relationLabels[relation] : { text: relation };
/**
 * A metric value, or with a scale the rounded count it stands for: 0.75 with scale 512 is
 * "384/512". Unscaled values keep four significant digits.
 */
export function formatMetric(
  value: number | null,
  scale: number | null,
  format: (value: number, options?: Intl.NumberFormatOptions) => string,
) {
  if (value === null) return '–';
  if (scale) return format(Math.round(value * scale)) + '/' + format(scale);
  return format(value, { maximumSignificantDigits: 4 });
}

/** The hardware a run last trained on, such as "Sirius · 2× RTX 4090 48GB". */
export function computeLabel(compute: Compute | null) {
  if (!compute?.host && !compute?.gpu_count) return '';
  const model = compute.segments.at(-1)?.gpu_model,
    gpus = compute.gpu_count ? compute.gpu_count + '× ' + (model ?? 'GPU') : model;
  return [compute.host, gpus].filter(Boolean).join(' · ');
}
/** Cards whose box meets a rectangle in canvas coordinates (a lasso). */
export function cardsIn(
  positions: Map<string, Position>,
  box: { x1: number; y1: number; x2: number; y2: number },
) {
  const left = Math.min(box.x1, box.x2),
    right = Math.max(box.x1, box.x2),
    top = Math.min(box.y1, box.y2),
    bottom = Math.max(box.y1, box.y2);
  return [...positions]
    .filter(
      ([, p]) => p.x < right && p.x + nodeWidth > left && p.y < bottom && p.y + nodeHeight > top,
    )
    .map(([id]) => id);
}
/** The smallest box around some cards, in canvas coordinates. */
export function boundsOf(positions: Map<string, Position>, ids: string[]) {
  const boxes = ids.map((id) => positions.get(id)).filter((p): p is Position => !!p);
  if (!boxes.length) return null;
  return {
    x: Math.min(...boxes.map((p) => p.x)),
    y: Math.min(...boxes.map((p) => p.y)),
    right: Math.max(...boxes.map((p) => p.x + nodeWidth)),
    bottom: Math.max(...boxes.map((p) => p.y + nodeHeight)),
  };
}

/** Planned runs as stand-in nodes (`plan:<id>`), linked from their parent when it is drawn. */
export function withPlans(graph: LineageGraph): LineageGraph {
  if (!graph.plans.length) return graph;
  const ids = new Set(graph.nodes.map((node) => node.id));
  const nodes = graph.plans.map((plan): LineageNode => ({
    id: 'plan:' + plan.id,
    name: plan.id,
    display_name: plan.name,
    state: 'planned',
    group: '',
    tags: [],
    created: plan.created,
    verdict: null,
    hypothesis: plan.hypothesis || null,
    change: plan.change || null,
    result: null,
    verdictReason: null,
    recipe: null,
    jobType: '',
    latest: null,
    best: null,
    recent: null,
    plan: plan.id,
    examines: [],
    files: [],
    unresolved: null,
    bases: [],
    compute: plan.host ? { host: plan.host, gpu_count: null, segments: [] } : null,
    planned: plan,
  }));
  const edges = graph.plans
    .filter((plan) => plan.parent && ids.has(plan.parent))
    .map((plan): LineageEdge => ({
      source: plan.parent!,
      target: 'plan:' + plan.id,
      relation: 'planned',
      traits: [],
      update: plan.parentUpdate,
      explicit: true,
      ambiguous: false,
      changedKeys: [],
      changeCount: 0,
      changeSource: 'lineage',
    }));
  return { ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] };
}

export type DiffPart = { text: string; kind: 'same' | 'removed' | 'added' };
/** Words, numbers (with their exponent and sign), separators and spaces of a value's text. */
export function diffTokens(text: string) {
  return text.match(/[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_][\w]*|\s+|[^\w\s]/gi) ?? [];
}
/**
 * A word-level diff of two values' text, as GitHub's word diff: unchanged words once, removed
 * and added words where they differ. Values too long to compare word by word are one removal
 * and one addition.
 */
export function wordDiff(before: string, after: string, limit = 400): DiffPart[] {
  const a = diffTokens(before),
    b = diffTokens(after);
  if (a.length * b.length > limit * limit)
    return [
      { text: before, kind: 'removed' },
      { text: after, kind: 'added' },
    ].filter((part) => part.text) as DiffPart[];
  // The longest common subsequence of tokens, walked back to front.
  const width = b.length + 1,
    lengths = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
  const parts: DiffPart[] = [],
    push = (text: string, kind: DiffPart['kind']) => {
      const last = parts.at(-1);
      if (last?.kind === kind) last.text += text;
      else parts.push({ text, kind });
    };
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(a[i++], 'same');
      j++;
      // Removals come before additions where either keeps the common words.
    } else if (
      i < a.length &&
      (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    )
      push(a[i++], 'removed');
    else push(b[j++], 'added');
  }
  // A change that leaves only spaces or punctuation in common reads better whole.
  const kept = parts
    .filter((part) => part.kind === 'same')
    .map((part) => part.text)
    .join('');
  if (!/[A-Za-z0-9]/.test(kept) && parts.some((part) => part.kind !== 'same'))
    return [
      { text: before, kind: 'removed' },
      { text: after, kind: 'added' },
    ].filter((part) => part.text) as DiffPart[];
  return parts;
}

export type StructuredChange = {
  /** Where in the value, such as `[subtropical_forest].layers[canopy].density_response.gap`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  from?: Json;
  to?: Json;
};
const identityFields = ['name', 'id', 'label', 'asset', 'key', 'path'];
/** JSON with object keys sorted, so values that differ only in key order compare equal. */
export function canonical(value: Json | undefined): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, Json>)[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'undefined';
}
const isRecord = (value: unknown): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** The field naming each item of a list of objects, when one does so uniquely in both lists. */
export function identityOf(...lists: Json[][]) {
  const items = lists.flat();
  if (!items.length || !items.every(isRecord)) return null;
  return (
    identityFields.find((field) =>
      lists.every((list) => {
        const names = list.map((item) => (item as Record<string, Json>)[field]);
        return (
          names.every((name) => typeof name === 'string' || typeof name === 'number') &&
          new Set(names).size === names.length
        );
      }),
    ) ?? null
  );
}
/**
 * The differences between two values, down to their changed leaves: objects by key, lists of
 * objects by an identity field (name, id, label, asset, key or path) or else by position when
 * they are as long, so a reordered or extended list shows only the entries that changed.
 */
export function structuredDiff(
  from: Json | undefined,
  to: Json | undefined,
  path = '',
): StructuredChange[] {
  if (canonical(from) === canonical(to)) return [];
  if (from === undefined) return [{ path, kind: 'added', to }];
  if (to === undefined) return [{ path, kind: 'removed', from }];
  if (isRecord(from) && isRecord(to))
    return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap((key) =>
      structuredDiff(from[key], to[key], path ? path + '.' + key : key),
    );
  if (Array.isArray(from) && Array.isArray(to)) {
    const field = identityOf(from, to);
    if (field) {
      const byName = (list: Json[]) =>
        new Map(list.map((item) => [String((item as Record<string, Json>)[field]), item]));
      const before = byName(from),
        after = byName(to);
      return [...new Set([...before.keys(), ...after.keys()])].flatMap((name) =>
        structuredDiff(before.get(name), after.get(name), `${path}[${name}]`),
      );
    }
    if (
      from.length === to.length &&
      [...from, ...to].some((item) => typeof item === 'object' && item)
    )
      return from.flatMap((item, position) =>
        structuredDiff(item, to[position], `${path}[${position}]`),
      );
  }
  return [{ path, kind: 'changed', from, to }];
}
/** The entry of a list a change belongs to (`[canopy]` of `[canopy].templates[0]`), if any. */
export function entryOf(path: string) {
  return /^\[[^\]]*\]/.exec(path)?.[0] ?? '';
}

/** The statuses links can be coloured by: verdicts first, then run states. */
export const linkStatuses = [
  'adopted',
  'rejected',
  'pending',
  'none',
  'running',
  'finished',
  'crashed',
  'stopped',
] as const;
export type LinkStatus = (typeof linkStatuses)[number];
/** Whether a run has a status: its verdict (pending is `running`), or its state. */
export function hasStatus(node: Pick<LineageNode, 'verdict' | 'state'>, status: LinkStatus) {
  switch (status) {
    case 'adopted':
    case 'rejected':
      return node.verdict === status;
    case 'pending':
      return node.verdict === 'running';
    case 'none':
      return !node.verdict;
    case 'crashed':
      return node.state === 'crashed' || node.state === 'failed';
    case 'stopped':
      return node.state === 'killed';
    default:
      return node.state === status;
  }
}
/** The colour a link into a run takes: its first chosen status, in `linkStatuses` order. */
export function linkStatus(
  node: Pick<LineageNode, 'verdict' | 'state'> | undefined,
  chosen: readonly string[],
): LinkStatus | null {
  if (!node) return null;
  return linkStatuses.find((status) => chosen.includes(status) && hasStatus(node, status)) ?? null;
}

/** What a plan needs: GPUs on one host, with at least some memory, of a model, on hosts. */
export type GpuRequest = {
  gpus: number;
  min_memory_gb?: number | null;
  model?: string | null;
  hosts?: string[] | null;
  same_host?: boolean;
};
/** One GPU of the project's inventory (gpus_list); `allowed` false keeps it out of plans. */
export type InventoryGpu = {
  host: string;
  gpu: number;
  model: string;
  memory_gb: number | null;
  allowed: boolean;
  note: string;
};
/** What an idea waits on before it can be planned. */
export type IdeaLink = { kind: 'run' | 'plan' | 'finding'; id: string };
/** A backlog entry: an experiment worth running once what it waits on is in. */
export type Idea = {
  id: string;
  title: string;
  hypothesis: string;
  evidence: string;
  prerequisites: string;
  waits_on: IdeaLink[];
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'promoted' | 'dropped';
  plan: string | null;
  draft: Record<string, Json> | null;
  source: Source | null;
  created: number;
  updated: number;
  by: string;
};
