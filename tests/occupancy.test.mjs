import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../backend/dist/server.js';
import { occupancy, placeholderLength } from '../backend/dist/occupancy.js';

// GPU occupancy for the Plans page, with synthetic hosts, runs and plans.
const hour = 3600,
  now = 100 * hour;
const segment = (host, slot, gpus, from = 0, to = null, model = 'GPU 24GB') => ({
  from_update: from,
  to_update: to,
  host,
  gpu_count: gpus?.length ?? 2,
  gpu_ids: gpus,
  gpu_model: model,
  slot,
});
const run = (id, fields) => ({
  id,
  name: id,
  state: 'finished',
  verdict: null,
  start: 0,
  end: 0,
  compute: null,
  progress: null,
  budget: null,
  from: null,
  plan: null,
  audit: null,
  ...fields,
});
const plan = (id, fields) => ({
  id,
  name: id,
  host: '',
  slot: '',
  queue: null,
  after: null,
  created: 0,
  parentUpdate: null,
  config: null,
  since: 0,
  request: { gpus: 1, ...fields.request },
  ...fields,
});
// The GPUs a host has, in the inventory.
const gpus = (host, ids, memory = 24, allowed = true) =>
  ids.map((gpu) => ({ host, gpu, model: 'GPU', memory_gb: memory, allowed }));

test('finished, running and planned bars sit on the GPUs they use', () => {
  const runs = [
    // Two finished runs on slot a (GPUs 1 and 2): 1000 updates in 10 hours each.
    run('old1', {
      start: 70 * hour,
      end: 80 * hour,
      progress: 1000,
      budget: 1000,
      from: 0,
      verdict: 'rejected',
      compute: { host: 'alpha', gpu_count: 2, segments: [segment('alpha', 'a', [1, 2])] },
    }),
    run('old2', {
      start: 80 * hour,
      end: 90 * hour,
      progress: 1000,
      budget: 1000,
      from: 0,
      compute: { host: 'alpha', gpu_count: 2, segments: [segment('alpha', 'a', [1, 2])] },
    }),
    // Running on slot a since hour 95: 500 of 1000 updates done, so 5 more hours.
    run('live', {
      state: 'running',
      start: 95 * hour,
      progress: 500,
      budget: 1000,
      from: 0,
      audit: 0.4,
      compute: { host: 'alpha', gpu_count: 2, segments: [segment('alpha', 'a', [1, 2])] },
    }),
    // A running run with no compute block cannot be placed.
    run('lost', { state: 'running', start: 99 * hour }),
  ];
  const plans = [
    plan('next', { request: { gpus: 2, hosts: ['alpha'] }, queue: 1, updates: 200 }),
    plan('then', { request: { gpus: 2 }, queue: 2 }),
    plan('wide', { request: { gpus: 3 }, queue: 3, updates: 100 }),
  ];
  const result = occupancy(runs, plans, now, undefined, gpus('alpha', [0, 1, 2]));
  assert.deepEqual(
    result.hosts.map((host) => [host.host, host.model, host.rows.map((row) => row.gpu)]),
    [['alpha', 'GPU 24GB', [0, 1, 2]]],
  );
  assert.deepEqual(result.unplaced, [{ id: 'lost', name: 'lost' }]);
  const bar = (id) => result.bars.find((item) => item.id === id);
  assert.deepEqual(bar('old1#0').rows, ['alpha/1', 'alpha/2']);
  assert.equal(bar('old1#0').verdict, 'rejected');
  assert.equal(bar('live#0').kind, 'running');
  assert.equal(bar('live#0').end, now);
  const remaining = bar('live#0:remaining');
  assert.equal(remaining.kind, 'remaining');
  assert.ok(remaining.estimated);
  assert.equal(remaining.end, now + 5 * hour);
  assert.equal(remaining.rate, 36);
  // Two GPUs come free when the running run ends; next takes them and runs 200 updates at
  // the 36 s per update two GPUs on alpha have run at, after the run it follows.
  assert.deepEqual(bar('plan:next').gpus, [0, 1]);
  assert.equal(bar('plan:next').start, now + 5 * hour);
  assert.equal(bar('plan:next').end, now + 5 * hour + 200 * 36);
  assert.deepEqual(bar('plan:next').follows, ['live']);
  // No stated length: as long as two-GPU runs here usually go (1000 updates).
  assert.equal(bar('plan:then').start, bar('plan:next').end);
  assert.equal(bar('plan:then').end - bar('plan:then').start, 1000 * 36);
  assert.equal(bar('plan:then').unknownLength, false);
  assert.deepEqual(bar('plan:then').follows, ['plan:next']);
  // Three GPUs only once all of alpha is free.
  assert.equal(bar('plan:wide').start, bar('plan:then').end);
  assert.deepEqual(bar('plan:wide').rows, ['alpha/0', 'alpha/1', 'alpha/2']);
  assert.deepEqual(result.unfit, []);
});

test("a plan's estimated hours set its length; running runs keep their measured end", () => {
  const compute = (gpus) => ({
    host: 'alpha',
    gpu_count: gpus.length,
    segments: [segment('alpha', 'a', gpus)],
  });
  const runs = [
    // Measured: 500 of 1000 updates in 5 hours, so 5 more, whatever its plan estimated.
    run('measured', {
      state: 'running',
      start: 95 * hour,
      progress: 500,
      budget: 1000,
      from: 0,
      compute: compute([0]),
      estimate: { seconds: 2 * hour, from: 95 * hour },
    }),
    // No budget to measure against: its plan's 8 hours from when the plan started.
    run('estimated', {
      state: 'running',
      start: 90 * hour,
      progress: 100,
      compute: compute([1]),
      estimate: { seconds: 8 * hour, from: 96 * hour },
    }),
  ];
  const plans = [
    // Stated updates would take 200 × 36 s; the estimate wins.
    plan('stated', { request: { gpus: 1 }, queue: 1, updates: 200, estimated_hours: 3 }),
    plan('inferred', { request: { gpus: 1 }, queue: 2, updates: 100 }),
  ];
  const result = occupancy(runs, plans, now, undefined, gpus('alpha', [0, 1]));
  const bar = (id) => result.bars.find((item) => item.id === id);
  assert.equal(bar('measured#0:remaining').end, now + 5 * hour);
  assert.equal(bar('measured#0:remaining').basis, 'progress');
  assert.equal(bar('estimated#0:remaining').end, 104 * hour);
  assert.equal(bar('estimated#0:remaining').basis, 'estimate');
  assert.equal(bar('plan:stated').end - bar('plan:stated').start, 3 * hour);
  assert.equal(bar('plan:stated').basis, 'estimate');
  // 100 updates at the median pace of alpha's single-GPU runs: 36 and 360 s per update.
  assert.equal(bar('plan:inferred').end - bar('plan:inferred').start, 100 * 198);
  assert.equal(bar('plan:inferred').basis, 'pace');
});

test('plans queued after a run or a later plan wait for it; unknown lengths are placeholders', () => {
  const runs = [
    run('live', {
      state: 'running',
      start: 98 * hour,
      progress: 100,
      budget: 400,
      from: 0,
      compute: { host: 'beta', gpu_count: 1, segments: [segment('beta', 's0', [0])] },
    }),
  ];
  const plans = [
    // Queued after a plan listed later, which is queued after the running run.
    plan('second', { request: { gpus: 1, hosts: ['gamma'] }, after: 'plan:first', queue: 1 }),
    plan('first', { request: { gpus: 1, hosts: ['gamma'] }, after: 'live', queue: 2 }),
  ];
  const result = occupancy(runs, plans, now, undefined, [
    ...gpus('beta', [0]),
    ...gpus('gamma', [3, 4]),
  ]);
  const bar = (id) => result.bars.find((item) => item.id === id);
  const liveEnd = now + 300 * ((2 * hour) / 100);
  assert.equal(bar('live#0:remaining').end, liveEnd);
  assert.equal(bar('plan:first').start, liveEnd);
  // Nothing has run on gamma, so its length is a placeholder.
  assert.ok(bar('plan:first').unknownLength);
  assert.equal(bar('plan:first').basis, 'placeholder');
  assert.equal(bar('plan:first').end, liveEnd + placeholderLength);
  assert.equal(bar('plan:second').start, bar('plan:first').end);
  assert.deepEqual(
    result.hosts.map((host) => [host.host, host.rows.length]),
    [
      ['beta', 1],
      // Its two GPUs in the inventory, not indices 0 to 4.
      ['gamma', 2],
    ],
  );
});

test('a running run without a compute block sits where its plan put it, or still holds back its queue', () => {
  const runs = [
    run('slot-history', {
      start: 50 * hour,
      end: 60 * hour,
      compute: { host: 'h', gpu_count: 2, segments: [segment('h', 's34', [3, 4])] },
    }),
    // Carries a plan for h, slot s34: placed on that slot's GPUs.
    run('placed', {
      state: 'running',
      start: 98 * hour,
      progress: 200,
      budget: 1200,
      from: 0,
      placement: { host: 'h', slot: 's34', gpus: null },
    }),
    // No compute and no plan: unplaced, but it ends in 2 h (100 of 200 updates in 2 h).
    run('loose', { state: 'running', start: 98 * hour, progress: 100, budget: 200, from: 0 }),
  ];
  const result = occupancy(
    runs,
    [plan('behind', { request: { gpus: 1, hosts: ['k'] }, after: 'loose' })],
    now,
    undefined,
    gpus('k', [0]),
  );
  const bar = (id) => result.bars.find((item) => item.id === id);
  assert.deepEqual(bar('placed#0').rows, ['h/3', 'h/4']);
  assert.ok(bar('placed#0').inferred);
  assert.equal(bar('placed#0:remaining').end, now + 1000 * 36);
  assert.deepEqual(result.unplaced, [{ id: 'loose', name: 'loose' }]);
  assert.equal(bar('plan:behind').start, now + 2 * hour);
});

test('segments without GPU indices share one row per host in lanes; moves between hosts split a run', () => {
  const runs = [
    run('a', {
      start: 10 * hour,
      end: 20 * hour,
      compute: { host: 'h', gpu_count: 2, segments: [segment('h', null, null)] },
    }),
    run('b', {
      start: 15 * hour,
      end: 25 * hour,
      compute: { host: 'h', gpu_count: 2, segments: [segment('h', null, null)] },
    }),
    run('c', {
      start: 21 * hour,
      end: 30 * hour,
      compute: { host: 'h', gpu_count: 2, segments: [segment('h', null, null)] },
    }),
    // Moved from h to k at update 500 (reached at hour 44, from history), back at 800
    // (interpolated: 80% of the way from hour 40 to 50); a launch that did nothing is dropped.
    run('moved', {
      start: 40 * hour,
      end: 50 * hour,
      progress: 1000,
      from: 0,
      reached: { 500: 44 * hour },
      compute: {
        host: 'h',
        gpu_count: 1,
        segments: [
          segment('h', 's', [0], 0, 0),
          segment('h', 's', [0], 0, 500),
          segment('k', 't', [1], 500, 800),
          segment('h', 's', [0], 800, null),
        ],
      },
    }),
  ];
  const result = occupancy(runs, [], now);
  const placed = (id) => {
    const bar = result.bars.find((item) => item.id === id);
    return [bar.rows, bar.lane, bar.lanes];
  };
  // a and b overlap, so they split the row; c starts after a ends and reuses its lane.
  assert.deepEqual(placed('a#0'), [['h/?'], 0, 2]);
  assert.deepEqual(placed('b#0'), [['h/?'], 1, 2]);
  assert.deepEqual(placed('c#0'), [['h/?'], 0, 2]);
  const moved = result.bars.filter((bar) => bar.run === 'moved');
  assert.deepEqual(
    moved.map((bar) => [bar.host, bar.start / hour, bar.end / hour]),
    [
      ['h', 40, 44],
      ['k', 44, 48],
      ['h', 48, 50],
    ],
  );
  assert.deepEqual(
    result.hosts.map((host) => host.rows.map((row) => row.key)),
    [
      ['h/0', 'h/?'],
      ['k/0', 'k/1'],
    ],
  );
  // The moved run overlaps nothing, so it keeps whole rows.
  assert.deepEqual(
    moved.map((bar) => bar.lanes),
    [1, 1, 1],
  );
});

test('runs sharing GPUs at the same time stack in lanes, one lane across all their GPUs', () => {
  const on = (gpus) => ({ host: 'g', gpu_count: gpus.length, segments: [segment('g', 's', gpus)] });
  const runs = [
    run('train', { start: 10 * hour, end: 20 * hour, compute: on([0, 1]) }),
    // An audit on GPU 1 while training runs, and one on GPUs 0-1 while both do.
    run('audit', { start: 12 * hour, end: 18 * hour, compute: on([1]) }),
    run('probe', { start: 13 * hour, end: 14 * hour, compute: on([0, 1]) }),
    // The next run on the same GPUs, after the first ends.
    run('next', { start: 20 * hour, end: 30 * hour, compute: on([0, 1]) }),
  ];
  const result = occupancy(runs, [], now);
  const lane = (id) => {
    const bar = result.bars.find((item) => item.run === id);
    return [bar.lane, bar.lanes];
  };
  assert.deepEqual(['train', 'audit', 'probe', 'next'].map(lane), [
    [0, 3],
    [1, 3],
    [2, 3],
    // After the others end it overlaps nothing, so it takes whole rows again.
    [0, 1],
  ]);
  // A run nobody overlaps keeps whole rows, even after a hand-over of a few minutes.
  const alone = occupancy(
    [
      run('a', { start: 0, end: 10 * hour, compute: on([0]) }),
      run('b', { start: 10 * hour - 300, end: 20 * hour, compute: on([0]) }),
    ],
    [],
    now,
  );
  assert.deepEqual(
    alone.bars.map((bar) => [bar.lane, bar.lanes]),
    [
      [0, 1],
      [0, 1],
    ],
  );
});

test('project_occupancy reads compute blocks, settings, history times and open plans', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-occupancy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  const call = async (name, payload, status = 200) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tools/' + name,
      payload,
    });
    assert.equal(response.statusCode, status, name + ': ' + response.body);
    return response.json();
  };
  const compute = (segments) => ({ host: segments.at(-1).host, gpu_count: 2, segments });
  // Still running: it moved from h to k at update 50.
  await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'moved',
    displayName: 'v1',
    config: {
      lineage: {
        value: {
          verdict: 'adopted',
          compute: compute([segment('h', 's', [0, 1], 0, 50), segment('k', 't', [2, 3], 50)]),
        },
      },
      train: { value: { budget: 1000, start: 0 } },
    },
  });
  // Updates 0..100 logged since the run started; update 50 is reached 50 ms in.
  const { started } = await server.db.call('run', 'e/p/moved');
  await server.db.call('ingest', 'e/p/moved', {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: Array.from({ length: 11 }, (_, i) =>
          JSON.stringify({ _step: i, _timestamp: started + i / 100, update: i * 10 }),
        ),
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'carried',
    displayName: 'v2',
    state: 'finished',
    config: { lineage: { value: { plan: 'p-done' } } },
  });
  await call('gpus_save', { project: 'e/p', host: 'k', gpus: [2, 3], memory_gb: 24 });
  await call('plan_save', { project: 'e/p', id: 'p-open', name: 'v3', host: 'k', slot: 't' });
  await call('plan_save', { project: 'e/p', id: 'p-done', name: 'v2-plan', host: 'k', slot: 't' });
  await call('plan_save', { project: 'e/p', id: 'p-off', host: 'k', status: 'cancelled' });
  // Fields a plan never had stay out of its record, so saving it again changes nothing.
  assert.equal(
    (await call('plan_save', { project: 'e/p', id: 'p-open', name: 'v3' })).status,
    'unchanged',
  );
  assert.equal(
    (await call('plan_save', { project: 'e/p', id: 'p-open', gpus: [2, 3], updates: 40 })).status,
    'updated',
  );
  await call('project_lineage_settings_update', {
    id: 'e/p',
    budgetKey: 'train.budget',
    startKey: 'train.start',
  });
  const result = await call('project_occupancy', { project: 'e/p' });
  const moved = result.bars.filter((bar) => bar.run === 'e/p/moved');
  assert.deepEqual(
    moved.map((bar) => [bar.kind, bar.host, bar.rows, bar.verdict]),
    [
      ['past', 'h', ['h/0', 'h/1'], 'adopted'],
      ['running', 'k', ['k/2', 'k/3'], 'adopted'],
      ['remaining', 'k', ['k/2', 'k/3'], 'adopted'],
    ],
  );
  assert.ok(Math.abs(moved[1].start - (started + 0.05)) < 1e-6);
  // 100 of 1000 updates done.
  assert.equal(moved[2].progress, 100);
  assert.equal(moved[2].budget, 1000);
  // Only the open plan is queued; the carried-out and cancelled ones are not.
  const planned = result.bars.filter((bar) => bar.kind === 'planned');
  assert.deepEqual(
    planned.map((bar) => [bar.plan, bar.gpus, bar.budget]),
    [['p-open', [2, 3], 40]],
  );
  assert.deepEqual(result.unplaced, []);
  // The tool is not offered to the Assistant: it carries plan records.
  const { tools } = await import('../backend/dist/tools.js').then((module) => ({
    tools: module.toolCatalog,
  }));
  assert.equal(tools.find((tool) => tool.name === 'project_occupancy').agent, false);
});
