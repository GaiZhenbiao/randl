import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import dagre from '@dagrejs/dagre';
const source = await readFile(new URL('../frontend/src/lineage-graph.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  formatMetric,
  indexGraph,
  layoutGraph,
  nameDelta,
  nodeHeight,
  nodeWidth,
  pathToRoot,
  visibleRuns,
  wordDiff,
  structuredDiff,
  entryOf,
  linkStatus,
} = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const node = (id, extra = {}) => ({
  id,
  name: id,
  display_name: id,
  state: 'finished',
  group: '',
  tags: [],
  created: 0,
  verdict: null,
  hypothesis: null,
  recipe: null,
  latest: null,
  best: null,
  unresolved: null,
  ...extra,
});
const edge = (source, target, update = null) => ({
  source,
  target,
  relation: 'initialize_from',
  update,
  explicit: false,
  ambiguous: false,
  changedKeys: [],
  changeCount: 0,
  changeSource: 'diff',
});
// root → a → a1, a → a2 (rejected) → a2x; root → b; lone has no links.
const graph = {
  nodes: [
    node('root'),
    node('a', { group: 'g1' }),
    node('a1', { tags: ['seed'] }),
    node('a2', { verdict: 'rejected' }),
    node('a2x'),
    node('b'),
    node('lone', { group: 'g1' }),
  ],
  edges: [
    edge('root', 'a'),
    edge('a', 'a1'),
    edge('a', 'a2'),
    edge('a2', 'a2x'),
    edge('root', 'b'),
  ],
};
const index = indexGraph(graph);
const filters = { search: '', group: '', tag: '', collapseRejected: false, showIsolated: false };

test('the path to a run starts at its root', () => {
  assert.deepEqual(pathToRoot('a2x', index), ['root', 'a', 'a2', 'a2x']);
  assert.deepEqual(pathToRoot('lone', index), ['lone']);
});

test('filters keep the ancestors that connect matching runs, as context', () => {
  const tagged = visibleRuns(graph, index, { ...filters, tag: 'seed' });
  assert.deepEqual(tagged.shown, ['root', 'a', 'a1']);
  assert.deepEqual([...tagged.context].sort(), ['a', 'root']);
  assert.equal(tagged.matches, 1);
  const named = visibleRuns(graph, index, { ...filters, search: 'A2' });
  assert.deepEqual(named.shown, ['root', 'a', 'a2', 'a2x']);
  // A matching run without links stays hidden until runs without lineage are shown.
  const grouped = visibleRuns(graph, index, { ...filters, group: 'g1' });
  assert.deepEqual(grouped.shown, ['root', 'a']);
  assert.equal(grouped.isolatedHidden, 1);
  assert.deepEqual(
    visibleRuns(graph, index, { ...filters, group: 'g1', showIsolated: true }).shown,
    ['root', 'a', 'lone'],
  );
});

test('collapsing rejected branches hides the runs below them and counts them', () => {
  const result = visibleRuns(graph, index, { ...filters, collapseRejected: true });
  assert.deepEqual(result.shown, ['root', 'a', 'a1', 'a2', 'b']);
  assert.deepEqual([...result.collapsed], [['a2', 1]]);
});

test('card names keep the parts the parent lacks', () => {
  assert.equal(
    nameDelta('v651_latched_const2e7_nocritclip_head1024x2_w2', 'v621_latched_cos1e6_w2'),
    'const2e7 nocritclip head1024x2',
  );
  assert.equal(nameDelta('v621_latched_w2', undefined), 'latched w2');
});

test('metric values show as counts when a scale is set', () => {
  const format = (value, options) => new Intl.NumberFormat('en', options).format(value);
  assert.equal(formatMetric(0.7128, 512, format), '365/512');
  assert.equal(formatMetric(0.712890625, null, format), '0.7129');
  assert.equal(formatMetric(null, 512, format), '–');
});

const overlaps = (positions) => {
  const boxes = [...positions.values()];
  return boxes.some((a, i) =>
    boxes
      .slice(i + 1)
      .some((b) => Math.abs(a.x - b.x) < nodeWidth && Math.abs(a.y - b.y) < nodeHeight),
  );
};

test('layout places linked runs left to right and unlinked runs in a grid below', () => {
  const ids = graph.nodes.map((item) => item.id);
  const layout = layoutGraph(dagre, ids, graph.edges, 'depth', () => null);
  const at = (id) => layout.positions.get(id);
  assert.ok(at('root').x < at('a').x && at('a').x < at('a2').x && at('a2').x < at('a2x').x);
  assert.ok(
    at('lone').y > Math.max(...['root', 'a', 'a1', 'a2', 'a2x', 'b'].map((id) => at(id).y)),
  );
  assert.ok(!overlaps(layout.positions));
  assert.ok(layout.width >= at('a2x').x + nodeWidth && layout.height >= at('lone').y + nodeHeight);
});

test('an update axis orders columns by start update without overlapping cards', () => {
  // Siblings that start at the same update share a column; later starts sit further right.
  const edges = [
    edge('root', 'a', 100),
    edge('root', 'b', 100),
    edge('a', 'c', 500),
    edge('b', 'd', 500),
  ];
  const ids = ['root', 'a', 'b', 'c', 'd'];
  const start = (id) => edges.find((item) => item.target === id)?.update ?? null;
  const layout = layoutGraph(dagre, ids, edges, 'update', start);
  const at = (id) => layout.positions.get(id);
  assert.equal(at('a').x, at('b').x);
  assert.equal(at('c').x, at('d').x);
  assert.ok(at('root').x < at('a').x && at('a').x < at('c').x);
  assert.ok(!overlaps(layout.positions));
});

test('a time axis with a distinct start per run stays a bounded number of columns wide', () => {
  const ids = ['root', ...Array.from({ length: 200 }, (_, index) => 'c' + index)];
  const edges = ids.slice(1).map((id) => edge('root', id));
  // The root starts well before its children, which start 37 s apart.
  const created = new Map(ids.map((id, index) => [id, index ? 1e9 + index * 37 : 1e9 - 7400]));
  const layout = layoutGraph(dagre, ids, edges, 'time', (id) => created.get(id));
  const columns = new Set([...layout.positions.values()].map((position) => position.x));
  // Proportional to time: the root's lead takes half the width; the children share the rest.
  assert.equal(columns.size, 21);
  assert.ok(layout.width < 40 * (nodeWidth + 85) + nodeWidth);
  const at = (id) => layout.positions.get(id);
  assert.ok(at('root').x < at('c0').x && at('c0').x <= at('c100').x && at('c100').x < at('c199').x);
  assert.ok(!overlaps(layout.positions));
});

test('planned runs are drawn even without a parent in the graph', () => {
  const planned = { ...graph, nodes: [...graph.nodes, node('plan:p', { planned: { id: 'p' } })] };
  const result = visibleRuns(planned, indexGraph(planned), filters);
  assert.ok(result.shown.includes('plan:p'));
  assert.ok(!result.shown.includes('lone'));
});

test('config values diff word by word', () => {
  const show = (parts) =>
    parts
      .map(({ text, kind }) =>
        kind === 'same' ? text : kind === 'added' ? `{+${text}+}` : `[-${text}-]`,
      )
      .join('');
  // A path changes in one folder; numbers change whole, with their sign and exponent.
  assert.equal(
    show(wordDiff('"/warm/v621_u00543000/update_0"', '"/warm/v647_u00568000/update_0"')),
    '"/warm/[-v621_u00543000-]{+v647_u00568000+}/update_0"',
  );
  assert.equal(
    show(wordDiff('[-1.6,-1.6,-1.8]', '[-1.6,-1.2,-1.8]')),
    '[-1.6,[--1.6-]{+-1.2+},-1.8]',
  );
  assert.equal(show(wordDiff('1e-6', '3e-6')), '[-1e-6-]{+3e-6+}');
  assert.equal(
    show(wordDiff('"latched box"', '"latched box frustum"')),
    '"latched box{+ frustum+}"',
  );
  // Nothing but punctuation in common: one removal and one addition.
  assert.equal(show(wordDiff('"a"', '"b"')), '[-"a"-]{+"b"+}');
  assert.equal(show(wordDiff('', '5')), '{+5+}');
  assert.equal(show(wordDiff('x '.repeat(500), 'y '.repeat(500), 100)).length, 2000 + 8);
});

test('lists of objects diff by identity, down to the changed fields', () => {
  const scene = (layers, extra = {}) => [
    { name: 'forest', seed: 1, layers, assets: [{ name: 'trees', size: 512 }], ...extra },
  ];
  const before = scene([
      { label: 'canopy', density: [0.3, 0.8], templates: [{ asset: 'oak', scale: 1 }] },
      { label: 'shrub', density: [0.1, 0.2] },
      { label: 'rocks', density: [0, 1] },
    ]),
    // Reordered, one layer changed in a nested list, one removed, one added.
    after = scene(
      [
        { label: 'shrub', density: [0.1, 0.2] },
        { label: 'canopy', density: [0.3, 0.9], templates: [{ asset: 'oak', scale: 2 }] },
        { label: 'logs', density: [0.2, 0.4] },
      ],
      { seed: 2 },
    );
  const changes = structuredDiff(before, after);
  assert.deepEqual(
    changes.map(({ path, kind }) => [path, kind]),
    [
      ['[forest].seed', 'changed'],
      ['[forest].layers[canopy].density', 'changed'],
      ['[forest].layers[canopy].templates[oak].scale', 'changed'],
      ['[forest].layers[rocks]', 'removed'],
      ['[forest].layers[logs]', 'added'],
    ],
  );
  assert.equal(entryOf(changes[1].path), '[forest]');
  // Lists of numbers and lists without an identity of a different length are leaves.
  assert.deepEqual(structuredDiff([1, 2], [1, 3]), [
    { path: '', kind: 'changed', from: [1, 2], to: [1, 3] },
  ]);
  assert.deepEqual(structuredDiff([{ a: 1 }], [{ a: 2 }]), [
    { path: '[0].a', kind: 'changed', from: 1, to: 2 },
  ]);
  assert.deepEqual(structuredDiff({ a: 1 }, { a: 1 }), []);
  // Key order is not a change.
  assert.deepEqual(structuredDiff([{ name: 'x', a: 1, b: 2 }], [{ b: 2, a: 1, name: 'x' }]), []);
});

test('links take the colour of the first chosen status of the run they lead to', () => {
  const run = (verdict, state) => ({ verdict, state });
  assert.equal(linkStatus(run('adopted', 'finished'), ['adopted']), 'adopted');
  assert.equal(linkStatus(run('rejected', 'finished'), ['adopted']), null);
  // Verdicts come before states; pending is a running verdict; failed counts as crashed.
  assert.equal(linkStatus(run('adopted', 'killed'), ['stopped', 'adopted']), 'adopted');
  assert.equal(linkStatus(run(null, 'killed'), ['stopped', 'adopted']), 'stopped');
  assert.equal(linkStatus(run('running', 'running'), ['pending']), 'pending');
  assert.equal(linkStatus(run(null, 'failed'), ['crashed']), 'crashed');
  assert.equal(linkStatus(run(null, 'finished'), ['none']), 'none');
  assert.equal(linkStatus(undefined, ['adopted']), null);
});
