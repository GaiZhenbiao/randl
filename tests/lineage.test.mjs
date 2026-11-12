import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../backend/dist/server.js';
import {
  RunMatcher,
  acyclic,
  diffConfigs,
  flattenConfig,
  folderName,
  lineageDefaults,
  pathUpdate,
  resolveParent,
} from '../backend/dist/lineage.js';

// Runs as the database worker reads them, with save_dir and run_name as identity keys.
let clock = 0;
const run = (display_name, { saveDir = '', parents = [], lineage = null, id } = {}) => ({
  id: 'e/p/' + (id ?? display_name.slice(0, 8)),
  name: id ?? display_name.slice(0, 8),
  display_name,
  state: 'finished',
  group: '',
  tags: [],
  created: ++clock,
  lineage,
  parents: [parents[0] ?? null, parents[1] ?? null],
  identities: [saveDir || null, null],
});
const parentOf = (runs, child) => resolveParent(child, new RunMatcher(runs), lineageDefaults);

test('checkpoint paths name their run folder and update', () => {
  assert.equal(folderName('/a/runs/N5_fresh/checkpoints/'), 'N5_fresh');
  assert.equal(folderName('/a/checkpoints/v611_x'), 'v611_x');
  assert.equal(pathUpdate('/a/checkpoints/v611_x/update_00518000'), 518000);
  assert.equal(pathUpdate('/a/warm_sources/v621_u00543000/'), 543000);
  assert.equal(pathUpdate('/a/warm_sources/v311_update_00121250/update_00121250'), 121250);
  assert.equal(pathUpdate('/a/checkpoints/v611_x'), null);
});

test('parent paths match runs across hosts and checkpoint layouts', () => {
  const v611 = run('v611_latched_cos3e6_w3', {
      saveDir: '/home/u/AeroSeeker/tmp/navigation_forest/checkpoints/v611_latched_cos3e6_w3',
    }),
    v621 = run('v621_latched_cos1e6_w2', {
      saveDir: '/data/u/AeroSeeker/tmp/navigation_forest/checkpoints/v621_latched_cos1e6_w2',
    }),
    n5 = run('N5_h1_velocity_nose100_fresh', {
      saveDir: '/root/tmp/navigation_alignment/N5_h1_velocity_nose100_fresh/checkpoints',
    });
  // The full checkpoint folder, logged on another host.
  const v622 = run('v622_child', {
    parents: [
      '/data/u/AeroSeeker/tmp/navigation_forest/checkpoints/v611_latched_cos3e6_w3/update_00518000',
    ],
  });
  // A copied warm source named by its version prefix and update.
  const v640 = run('v640_child', {
    parents: [
      '/data/u/AeroSeeker/tmp/navigation_forest/warm_sources/v621_u00543000/update_00543000',
    ],
  });
  // A run folder holding a checkpoints folder, with and without a trailing slash.
  const n8 = run('N8_child', {
    parents: ['tmp/navigation_alignment/N5_h1_velocity_nose100_fresh/checkpoints/'],
  });
  // The other warm-source label style.
  const v314 = run('v314_child', {
    parents: ['tmp/navigation_forest/warm_sources/v621_update_00121250/update_00121250'],
  });
  const n9 = run('N9_child', {
    parents: ['tmp/navigation_alignment/N5_h1_velocity_nose100_fresh/checkpoints'],
  });
  const runs = [v611, v621, n5, v622, v640, n8, n9, v314];
  assert.equal(parentOf(runs, v314).id, v621.id);
  assert.deepEqual(parentOf(runs, v622), {
    id: v611.id,
    ambiguous: false,
    relation: 'initialize_from',
    update: 518000,
    explicit: false,
  });
  assert.equal(parentOf(runs, v640).id, v621.id);
  assert.equal(parentOf(runs, v640).update, 543000);
  assert.equal(parentOf(runs, n8).id, n5.id);
  assert.equal(parentOf(runs, n9).id, n5.id);
  assert.equal(parentOf(runs, n9).update, null);
});

test('a resume of the run itself adds no parent; unknown paths stay unresolved', () => {
  const own = '/data/checkpoints/v620_w4';
  const v620 = run('v620_w4', { saveDir: own, parents: [null, own] });
  const restarted = run('forest_box_overlap_v1', {
    saveDir: '/root/runs/forest_box_overlap_v1',
    parents: ['/root/runs/forest_box_overlap_v1/update_00000400'],
  });
  const orphan = run('k1_child', {
    parents: ['/root/runs/k1_missing/checkpoints/update_00004000'],
  });
  const runs = [v620, restarted, orphan];
  assert.equal(parentOf(runs, v620), null);
  assert.equal(parentOf(runs, restarted), null);
  assert.deepEqual(parentOf(runs, orphan), {
    unresolved: { source: '/root/runs/k1_missing/checkpoints/update_00004000', update: 4000 },
  });
});

test('several runs with one name pick the latest created before the child', () => {
  const first = run('baseline', { id: 'first', saveDir: '/x/baseline' }),
    second = run('baseline', { id: 'second', saveDir: '/y/baseline' }),
    child = run('child', { parents: ['/z/baseline/update_00000100'] }),
    later = run('baseline', { id: 'later', saveDir: '/w/baseline' });
  const parent = parentOf([first, second, child, later], child);
  assert.equal(parent.id, second.id);
  assert.equal(parent.ambiguous, true);
});

test('an explicit lineage block wins over the parent path', () => {
  const parent = run('v621_parent', { id: 'abc123' }),
    decoy = run('v611_decoy', { saveDir: '/c/v611_decoy' });
  const child = run('v647_child', {
    parents: ['/c/v611_decoy/update_00000001'],
    lineage: {
      parent: { run_id: 'abc123', run_name: 'v621_parent', update: 543000 },
      relation: 'grown_head',
      changes: { 'model.command_head_dim': [512, 1024] },
      hypothesis: 'A wider head holds more boxes',
    },
  });
  assert.deepEqual(parentOf([parent, decoy, child], child), {
    id: parent.id,
    ambiguous: false,
    relation: 'grown_head',
    update: 543000,
    explicit: true,
  });
  // A named parent that is not in the project is reported, not replaced by the path.
  const lost = run('v700', {
    parents: ['/c/v611_decoy/update_1'],
    lineage: { parent: { run_name: 'gone', update: '7' } },
  });
  assert.deepEqual(parentOf([decoy, lost], lost), { unresolved: { source: 'gone', update: 7 } });
});

test('a logged block that names no parent or the run itself adds no link', () => {
  const source = run('v611_src', { saveDir: '/c/v611_src' });
  const cold = run('v800_cold', {
    parents: ['/c/v611_src/update_00000001'],
    lineage: { parent: null, relation: 'initialize_from', hypothesis: 'fresh' },
  });
  const empty = run('v801_empty', { lineage: { parent: {} } });
  const extended = run('v802_extended', {
    id: 'ext802',
    lineage: { parent: { run_id: 'ext802', update: 900 }, relation: 'extend' },
  });
  const renamed = run('v803_named', { lineage: { parent: { run_name: 'v803_named' } } });
  const runs = [source, cold, empty, extended, renamed];
  for (const child of [cold, empty, extended, renamed]) assert.equal(parentOf(runs, child), null);
});

test('config diffs skip ignored keys and compare nested values', () => {
  const a = flattenConfig({
      rl: { checkpoint: { save_dir: '/a', keep_last: 3 }, algorithm: { lr: 1e-6, dims: [512] } },
      lineage: { hypothesis: 'x' },
    }),
    b = flattenConfig({
      rl: {
        checkpoint: { save_dir: '/b', keep_last: 3 },
        algorithm: { lr: 2e-7, dims: [1024], new: true },
      },
    });
  assert.deepEqual(diffConfigs(a, b, lineageDefaults.ignoreKeys), [
    { key: 'rl.algorithm.dims', from: [512], to: [1024] },
    { key: 'rl.algorithm.lr', from: 1e-6, to: 2e-7 },
    { key: 'rl.algorithm.new', from: undefined, to: true },
  ]);
});

test('edges that would close a cycle are dropped', () => {
  const edge = (source, target) => ({ source, target });
  const created = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  assert.deepEqual(acyclic([edge('c', 'a'), edge('a', 'b'), edge('b', 'c')], created), [
    edge('c', 'a'),
    edge('a', 'b'),
  ]);
});

test('project_lineage returns nodes, edges, metric values and config diffs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-lineage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const config = (saveDir, init, extra = {}, lr = 1e-6) =>
    Object.fromEntries(
      Object.entries({
        rl: { checkpoint: { save_dir: saveDir, initialize_from: init }, algorithm: { lr } },
        ...extra,
      }).map(([key, value]) => [key, { value }]),
    );
  const metric = 'audit/primary/value';
  const seed = async (name, displayName, cfg, tags, values) => {
    const created = await server.db.call('upsert', {
      entity: 'e',
      project: 'p',
      name,
      displayName,
      config: cfg,
      tags,
      summaryMetrics: { [metric]: values.at(-1) },
    });
    await server.db.call('ingest', created.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: values.map((value, step) => JSON.stringify({ _step: step, [metric]: value })),
        },
      },
    });
    return created.id;
  };
  const root = await seed(
    'root1',
    'v621_root',
    config('/d/checkpoints/v621_root', null),
    ['verdict:adopted'],
    [0.5, 0.7],
  );
  const child = await seed(
    'child1',
    'v640_child',
    config('/d/checkpoints/v640_child', '/d/warm_sources/v621_u00543000/update_00543000', {
      model: { head: 1024 },
    }),
    ['verdict:rejected'],
    [0.6, 0.55],
  );
  // Also widens the head, but its rarer change, the learning rate, labels its link first.
  const sibling = await seed(
    'child3',
    'v641_lr',
    config(
      '/d/checkpoints/v641_lr',
      '/d/checkpoints/v621_root/update_00543000',
      { model: { head: 1024 } },
      2e-6,
    ),
    [],
    [0.5],
  );
  const explicit = await seed(
    'child2',
    'v647_explicit',
    config('/d/checkpoints/v647_explicit', null, {
      lineage: {
        parent: { run_id: 'root1', update: 543000 },
        relation: 'grown_head',
        changes: { 'model.head': [512, 1024] },
        hypothesis: 'Wider head',
      },
    }),
    [],
    [0.4],
  );
  const call = async (name, payload) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tools/' + name,
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  await call('project_lineage_settings_update', { id: 'e/p', metric, scale: 512 });
  const graph = await call('project_lineage', { id: 'e/p' });
  assert.deepEqual(graph.counts, { runs: 4, explicit: 1, matched: 2, unresolved: 0 });
  const node = (id) => graph.nodes.find((item) => item.id === id);
  assert.equal(node(root).verdict, 'adopted');
  assert.equal(node(child).verdict, 'rejected');
  assert.deepEqual([node(root).latest, node(root).best], [0.7, 0.7]);
  assert.deepEqual([node(child).latest, node(child).best], [0.55, 0.6]);
  assert.equal(node(explicit).hypothesis, 'Wider head');
  const edge = (target) => graph.edges.find((item) => item.target === target);
  assert.deepEqual(edge(child), {
    source: root,
    target: child,
    relation: 'initialize_from',
    update: 543000,
    explicit: false,
    ambiguous: false,
    changedKeys: ['model.head'],
    changeCount: 1,
    changeSource: 'diff',
  });
  assert.deepEqual(edge(sibling).changedKeys, ['rl.algorithm.lr', 'model.head']);
  assert.equal(edge(explicit).relation, 'grown_head');
  assert.equal(edge(explicit).changeSource, 'lineage');
  assert.deepEqual(edge(explicit).changedKeys, ['model.head']);
  // The full diff marks the keys the settings ignore.
  const diff = await call('runs_config_diff', { from: root, to: child });
  assert.deepEqual(
    diff.changes.map((change) => [change.key, change.ignored]),
    [
      ['model.head', false],
      ['rl.checkpoint.initialize_from', true],
      ['rl.checkpoint.save_dir', true],
    ],
  );
  const minimum = await call('project_lineage_settings_update', { id: 'e/p', goal: 'min' });
  assert.equal(minimum.scale, 512);
  assert.equal(node(child).best, 0.6);
  assert.equal(
    (await call('project_lineage', { id: 'e/p' })).nodes.find((item) => item.id === child).best,
    0.55,
  );
});

test('lineage settings changes are audited like other project settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-lineage-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  await server.db.call('upsert', { entity: 'e', project: 'p', name: 'r' });
  await server.tools.execute('project_lineage_settings_update', { id: 'e/p', goal: 'min' });
  const entries = await server.db.call('auditList');
  assert.ok(
    JSON.stringify(entries).includes('project_lineage_settings_update'),
    JSON.stringify(entries).slice(0, 300),
  );
});
