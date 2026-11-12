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
  status: 'planned' | 'cancelled';
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
export function visibleRuns(graph: LineageGraph, index: GraphIndex, filters: Filters): Visible {
  const query = filters.search.trim().toLowerCase();
  const matching = new Set(
    graph.nodes
      .filter(
        (node) =>
          (!query ||
            node.display_name.toLowerCase().includes(query) ||
            node.name.toLowerCase().includes(query)) &&
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
    if (hidden.has(id)) continue;
    if (!filters.showIsolated && isolated(id)) {
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
  const nodes = graph.plans.map(
    (plan): LineageNode => ({
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
    }),
  );
  const edges = graph.plans
    .filter((plan) => plan.parent && ids.has(plan.parent))
    .map(
      (plan): LineageEdge => ({
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
      }),
    );
  return { ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] };
}
