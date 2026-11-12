import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { createServer } from '../backend/dist/server.js';
import {
  queueOrder,
  moveWithin,
  statusFromRun,
  choose,
  pick,
  project,
} from '../backend/dist/plan-queue.js';
import { listen } from './helpers.mjs';

// Planned runs as the queue supervisors take work from, with synthetic runs and plans.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-plan-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  await server.db.call('upsert', { entity: 'e', project: 'p', name: 'seed', state: 'finished' });
  const call = async (name, payload, status = 200) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tools/' + name,
      payload,
    });
    assert.equal(response.statusCode, status, name + ': ' + response.body);
    return response.json();
  };
  // A run that logs lineage.plan, as a supervisor's launch does.
  const launch = (name, plan) =>
    server.db.call('upsert', {
      entity: 'e',
      project: 'p',
      name,
      config: { lineage: { value: { plan } } },
    });
  const end = (id) =>
    server.db.call('ingest', id, {
      files: {
        'wandb-history.jsonl': { offset: 0, content: [JSON.stringify({ _step: 0, x: 1 })] },
      },
      complete: true,
    });
  const plan = async (id) =>
    (await call('plans_list', { project: 'e/p' })).plans.find((item) => item.id === id);
  // Host h: four 24 GB GPUs; host k: four 48 GB GPUs; host r: one reserved for others.
  await call('gpus_save', {
    project: 'e/p',
    host: 'h',
    gpus: [0, 1, 2, 3],
    model: 'RTX 4090',
    memory_gb: 24,
  });
  await call('gpus_save', {
    project: 'e/p',
    host: 'k',
    gpus: [4, 5, 6, 7],
    model: 'RTX 4090',
    memory_gb: 48,
  });
  await call('gpus_save', {
    project: 'e/p',
    host: 'r',
    gpus: [0],
    model: 'H100',
    memory_gb: 80,
    allowed: false,
  });
  return { server, directory, call, launch, end, plan };
}

test('queue order, moves and run states map as the supervisors expect', () => {
  const plan = (id, queue, after = null, created = 0) => ({ id, queue, after, created });
  assert.deepEqual(
    queueOrder([
      plan('c', null, null, 3),
      plan('b', 2),
      plan('a', 1),
      plan('d', null, 'plan:a', 4),
    ]).map((item) => item.id),
    ['a', 'd', 'b', 'c'],
  );
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(
    moveWithin(list, { id: 'c' }, { before: 'a' }).map((item) => item.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    moveWithin(list, { id: 'a' }, { after: 'b' }).map((item) => item.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    moveWithin(list, { id: 'x' }, {}).map((item) => item.id),
    ['a', 'b', 'c', 'x'],
  );
  assert.deepEqual(['running', 'finished', 'killed', 'crashed', 'failed'].map(statusFromRun), [
    'started',
    'done',
    'stopped',
    'stopped',
    'stopped',
  ]);
});

test('a plan is started, done or stopped as its run goes; existing plans are brought up to date', async (t) => {
  const { server, directory, call, launch, end, plan } = await fixture(t);
  // An older plan, saved before statuses were kept, whose run finished: done on first read.
  const legacy = await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'legacy-run',
    config: { lineage: { value: { plan: 'legacy' } } },
  });
  await end(legacy.id);
  const raw = new Database(join(directory, 'randl.sqlite3'));
  raw
    .prepare('INSERT INTO planned_runs(project,id,record,created,updated,by) VALUES(?,?,?,?,?,?)')
    .run(
      'e/p',
      'legacy',
      JSON.stringify({
        name: 'legacy',
        host: 'h',
        slot: 'a',
        queue: null,
        after: null,
        status: 'planned',
        source: null,
      }),
      1,
      1,
      '',
    );
  raw.close();
  const migrated = await plan('legacy');
  assert.deepEqual([migrated.status, migrated.run], ['done', legacy.id]);
  assert.equal(migrated.events.at(-1).status, 'done');

  await call('plan_save', { project: 'e/p', id: 'p1', host: 'h', slot: 'a' });
  await call('plan_save', { project: 'e/p', id: 'p2', host: 'h', slot: 'a' });
  assert.equal((await plan('p1')).status, 'planned');
  const one = await launch('r1', 'p1');
  assert.deepEqual([(await plan('p1')).status, (await plan('p1')).run], ['started', one.id]);
  await end(one.id);
  assert.equal((await plan('p1')).status, 'done');
  // A run set to stopped, or one that crashes, leaves its plan stopped.
  const two = await launch('r2', 'p2');
  await end(two.id);
  await call('run_state_set', { id: two.id, state: 'stopped', reason: 'Fell behind' });
  assert.equal((await plan('p2')).status, 'stopped');
  // Cancelled stays cancelled while no run carries it out.
  await call('plan_save', { project: 'e/p', id: 'p3', host: 'h', slot: 'a', status: 'cancelled' });
  assert.equal((await plan('p3')).status, 'cancelled');
  assert.deepEqual(
    (await plan('p3')).events.map((event) => event.status),
    ['cancelled'],
  );
});

test("a plan resuming an earlier plan's run binds to it, and the earlier plan keeps how it ended", async (t) => {
  const { server, call, launch, end, plan } = await fixture(t);
  await call('plan_save', { project: 'e/p', id: 'first', host: 'h', slot: 'a' });
  const run = await launch('long-run', 'first');
  await end(run.id);
  assert.equal((await plan('first')).status, 'done');
  await call('plan_save', {
    project: 'e/p',
    id: 'second',
    host: 'h',
    slot: 'a',
    resume_run: run.id,
  });
  const claimed = await call('plan_claim', {
    project: 'e/p',
    host: 'h',
    free_gpus: [0, 1, 2, 3],
    by: 's',
  });
  assert.deepEqual([claimed.plan.id, claimed.plan.resume_run], ['second', run.id]);
  // The supervisor resumes the run, which logs the new plan's id and runs again.
  await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'long-run',
    state: 'running',
    config: { lineage: { value: { plan: 'second' } } },
  });
  assert.deepEqual(
    [(await plan('second')).status, (await plan('second')).run],
    ['started', run.id],
  );
  const first = await plan('first');
  assert.deepEqual([first.status, first.run], ['done', run.id]);
  assert.deepEqual(
    first.events.map((event) => event.status),
    ['done'],
  );
});

test("a plan resuming a stopped run waits for its claim instead of taking the run's state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'randl-plan-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let server = await createServer(directory);
  // A run that stopped, logging no plan, and a plan to resume it under its own name.
  const run = await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'paused-run',
    state: 'killed',
  });
  const save = (payload) =>
    server.app.inject({ method: 'POST', url: '/api/tools/plan_save', payload });
  assert.equal(
    (
      await save({
        project: 'e/p',
        id: 'paused-run-resume',
        name: 'paused-run',
        host: 'h',
        slot: 'a',
        queue: 1,
        resume_run: run.id,
      })
    ).statusCode,
    200,
  );
  const read = async () =>
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/tools/plans_list',
        payload: { project: 'e/p' },
      })
    )
      .json()
      .plans.find((plan) => plan.id === 'paused-run-resume');
  assert.deepEqual([(await read()).status, (await read()).run], ['planned', null]);
  // One saved before this rule, bound to the run by name and stopped with it, is waiting again
  // once the server starts.
  await server.app.close();
  const raw = new Database(join(directory, 'randl.sqlite3'));
  const row = raw.prepare("SELECT record FROM planned_runs WHERE id='paused-run-resume'").get(),
    record = JSON.parse(row.record);
  Object.assign(record, {
    status: 'stopped',
    run: run.id,
    events: [
      { at: 1, status: 'planned' },
      { at: 2, status: 'stopped', run: run.id },
    ],
  });
  raw
    .prepare("UPDATE planned_runs SET record=? WHERE id='paused-run-resume'")
    .run(JSON.stringify(record));
  raw.close();
  server = await createServer(directory);
  t.after(() => server.app.close());
  await server.app.inject({
    method: 'POST',
    url: '/api/tools/gpus_save',
    payload: { project: 'e/p', host: 'h', gpus: [0], memory_gb: 24 },
  });
  const check = new Database(join(directory, 'randl.sqlite3'), { readonly: true });
  const started = JSON.parse(
    check.prepare("SELECT record FROM planned_runs WHERE id='paused-run-resume'").get().record,
  );
  check.close();
  assert.deepEqual([started.status, started.run], ['planned', undefined]);
  const queue = await server.app.inject({
    method: 'POST',
    url: '/api/tools/plan_queue',
    payload: { project: 'e/p' },
  });
  assert.deepEqual(
    queue.json().plans.map((plan) => plan.id),
    ['paused-run-resume'],
  );
  // Claimed, then the resumed run logs the plan's id: started, then done with it.
  const claim = await server.app.inject({
    method: 'POST',
    url: '/api/tools/plan_claim',
    payload: { project: 'e/p', host: 'h', free_gpus: [0], by: 's' },
  });
  assert.equal(claim.json().plan.resume_run, run.id);
  assert.deepEqual([(await read()).status, (await read()).run], ['started', null]);
  await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'paused-run',
    state: 'running',
    config: { lineage: { value: { plan: 'paused-run-resume' } } },
  });
  assert.deepEqual([(await read()).status, (await read()).run], ['started', run.id]);
  await server.db.call('ingest', run.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content: [JSON.stringify({ _step: 0, x: 1 })] } },
    complete: true,
  });
  assert.equal((await read()).status, 'done');
});

test('the allocator takes the head first, backfills, and holds a host for a head that has waited too long', () => {
  const gpu = (host, id, memory) => ({
    host,
    gpu: id,
    model: 'RTX 4090',
    memory_gb: memory,
    allowed: true,
  });
  const inventory = [0, 1, 2, 3]
    .map((id) => gpu('h', id, 24))
    .concat([4, 5, 6, 7].map((id) => gpu('k', id, 48)));
  const waiting = (id, request, since = 1000) => ({ id, request, since });
  const queue = [waiting('big', { gpus: 4, min_memory_gb: 48 }), waiting('small', { gpus: 1 })];
  const free = (host, ids) =>
    inventory.filter((item) => item.host === host && ids.includes(item.gpu));
  // On h the head can never run, so the small plan backfills.
  assert.deepEqual(choose(queue, 'h', free('h', [0, 1]), inventory, 2000), {
    plan: queue[1],
    gpus: [0],
  });
  // On k, with two of its four free: backfill while the head is fresh, held once it waited 6 h.
  assert.equal(choose(queue, 'k', free('k', [4, 5]), inventory, 2000).plan.id, 'small');
  assert.equal(choose(queue, 'k', free('k', [4, 5]), inventory, 1000 + 7 * 3600).held.id, 'big');
  assert.deepEqual(choose(queue, 'k', free('k', [4, 5, 6, 7]), inventory, 2000).gpus, [4, 5, 6, 7]);
  assert.deepEqual(pick({ gpus: 2, model: 'h100' }, 'k', inventory), null);

  // The projection: k is busy until t=100 on GPUs 4 and 5; plans start as GPUs come free.
  const result = project({
    now: 0,
    inventory,
    busy: [
      { host: 'k', gpu: 4, until: 100, by: 'run-a' },
      { host: 'k', gpu: 5, until: 100, by: 'run-a' },
    ],
    queue: [
      waiting('wide', { gpus: 4, min_memory_gb: 48 }, 0),
      waiting('pair', { gpus: 2, min_memory_gb: 48 }, 0),
      waiting('one', { gpus: 1 }, 0),
      waiting('huge', { gpus: 8 }, 0),
    ],
    readyAt: () => 0,
    length: () => 50,
    placeholder: 10,
  });
  const at = Object.fromEntries(result.placed.map((item) => [item.id, item]));
  // pair backfills k's two free GPUs now; one takes the 24 GB host; wide waits for all of k.
  assert.deepEqual([at.pair.host, at.pair.gpus, at.pair.start], ['k', [6, 7], 0]);
  assert.deepEqual([at.one.host, at.one.gpus, at.one.start], ['h', [0], 0]);
  assert.deepEqual([at.wide.host, at.wide.start, at.wide.end], ['k', 100, 150]);
  assert.deepEqual(at.wide.after.sort(), ['plan:pair', 'run-a']);
  assert.deepEqual(result.unfit, [{ id: 'huge', reason: 'too-few' }]);
});

test('host agents claim GPUs for the first plan that fits; claims are atomic, repeatable and released', async (t) => {
  const { server, directory, call, launch, end, plan } = await fixture(t);
  const yaml = '# exact file\nrl:\n  lr: 3.0e-6   # trailing comment  \n  name: "v700 — ü"\n\n';
  await call('plan_save', {
    project: 'e/p',
    id: 'wide',
    queue: 1,
    resources: { gpus: 2, min_memory_gb: 48 },
    config_yaml: yaml,
  });
  await call('plan_save', { project: 'e/p', id: 'one', queue: 2, resources: { gpus: 1 } });
  await call('plan_save', {
    project: 'e/p',
    id: 'two',
    queue: 3,
    resources: { gpus: 1, hosts: ['h'] },
    resume_run: 'e/p/seed',
  });
  assert.deepEqual(
    (await call('plan_queue', { project: 'e/p' })).plans.map((item) => [item.id, item.position]),
    [
      ['wide', 1],
      ['one', 2],
      ['two', 3],
    ],
  );
  // Five agents on k at once, each reporting all four GPUs free: wide takes two, one takes
  // a third, two (h only) is not for k, so the rest find nothing; no GPU is given twice.
  const attempts = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      server.app.inject({
        method: 'POST',
        url: '/api/tools/plan_claim',
        payload: { project: 'e/p', host: 'k', free_gpus: [4, 5, 6, 7], by: 'agent' + n },
      }),
    ),
  );
  const results = attempts.map((response) => response.json());
  const claimed = results.filter((result) => result.status === 'claimed');
  assert.deepEqual(claimed.map((result) => result.plan.id).sort(), ['one', 'wide']);
  const given = claimed.flatMap((result) => result.gpu_ids);
  assert.equal(new Set(given).size, given.length);
  assert.deepEqual(claimed.find((result) => result.plan.id === 'wide').gpu_ids, [4, 5]);
  assert.equal(claimed.find((result) => result.plan.id === 'wide').plan.config_yaml, yaml);
  assert.ok(results.filter((result) => result.status === 'empty').length === 3);
  // The agent that took wide, asking again with its GPUs still free, gets the same claim.
  const wideBy = claimed.find((result) => result.plan.id === 'wide').claim.by;
  const again = await call('plan_claim', {
    project: 'e/p',
    host: 'k',
    free_gpus: [4, 5, 7],
    by: wideBy,
  });
  assert.deepEqual([again.plan.id, again.repeat, again.gpu_ids], ['wide', true, [4, 5]]);
  // A host with no inventory is refused; reserved GPUs are never given.
  assert.equal(
    (await call('plan_claim', { project: 'e/p', host: 'nowhere', free_gpus: [0], by: 'x' }, 409))
      .code,
    'PLAN_HOST_UNKNOWN',
  );
  assert.equal(
    (await call('plan_claim', { project: 'e/p', host: 'r', free_gpus: [0], by: 'x' })).status,
    'empty',
  );
  const listed = await call('gpus_list', { project: 'e/p' });
  const k = listed.hosts.find((host) => host.host === 'k');
  assert.deepEqual(
    k.gpus.map((item) => item.holder?.plan ?? null),
    [
      'wide',
      'wide',
      ...(claimed.find((result) => result.plan.id === 'one').gpu_ids[0] === 6
        ? ['one', null]
        : [null, 'one']),
    ],
  );
  // wide's run starts and ends: its GPUs are released.
  const run = await launch('r-wide', 'wide');
  assert.deepEqual(
    [(await plan('wide')).status, (await plan('wide')).allocation.released],
    ['started', undefined],
  );
  await end(run.id);
  const done = await plan('wide');
  assert.equal(done.status, 'done');
  assert.ok(done.allocation.released > 0);
  // one's run never logs: after 30 minutes the claim lapses, its GPU is released, and the
  // plan waits again.
  const raw = new Database(join(directory, 'randl.sqlite3'));
  const record = JSON.parse(
    raw.prepare("SELECT record FROM planned_runs WHERE id='one'").get().record,
  );
  record.claim.at -= 31 * 60;
  raw.prepare("UPDATE planned_runs SET record=? WHERE id='one'").run(JSON.stringify(record));
  raw.close();
  const lapsed = await plan('one');
  assert.deepEqual([lapsed.status, lapsed.events.at(-1).status], ['planned', 'claim_expired']);
  assert.ok(lapsed.allocation.released > 0);
  // Claims are audited; empty answers and repeats are not.
  const audited = (await server.db.call('auditList')).filter(
    (entry) => entry.tool === 'plan_claim',
  );
  assert.equal(audited.length, 2);
  // On h, the resume plan (h only) is taken with its run to resume.
  const resume = await call('plan_claim', {
    project: 'e/p',
    host: 'h',
    free_gpus: [3],
    by: 'agent-h',
  });
  assert.deepEqual([resume.plan.id, resume.gpu_ids, resume.plan.resume_run], ['one', [3], null]);
});

test('older plans with a slot become GPU requests; the queue moves as one', async (t) => {
  const { server, call, plan } = await fixture(t);
  // A slot that last ran on two GPUs: its plans ask for two on that host.
  await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'slot-run',
    state: 'finished',
    config: {
      lineage: {
        value: {
          compute: {
            host: 'k',
            gpu_count: 2,
            segments: [
              {
                host: 'k',
                slot: 'k_45',
                gpu_ids: [4, 5],
                gpu_count: 2,
                from_update: 0,
                to_update: null,
              },
            ],
          },
        },
      },
    },
  });
  await call('plan_save', { project: 'e/p', id: 'a1', host: 'k', slot: 'k_45', queue: 1 });
  await call('plan_save', { project: 'e/p', id: 'a2', host: 'h', slot: 'h_0', queue: 2 });
  await call('plan_save', { project: 'e/p', id: 'a3', queue: 3, resources: { gpus: 1 } });
  assert.deepEqual((await plan('a1')).resources, { gpus: 2, hosts: ['k'], same_host: true });
  assert.deepEqual((await plan('a2')).resources, { gpus: 1, hosts: ['h'], same_host: true });
  const order = async () =>
    (await call('plan_queue', { project: 'e/p' })).plans.map((item) => [item.id, item.queue]);
  await call('plan_move', { project: 'e/p', id: 'a3', before: 'a1', by: 'me' });
  assert.deepEqual(await order(), [
    ['a3', 1],
    ['a1', 2],
    ['a2', 3],
  ]);
  await call('plan_move', { project: 'e/p', id: 'a3' });
  assert.deepEqual(
    (await order()).map(([id]) => id),
    ['a1', 'a2', 'a3'],
  );
  // A plan under way does not move.
  await call('plan_claim', { project: 'e/p', host: 'k', free_gpus: [4, 5], by: 'agent' });
  assert.equal(
    (await call('plan_move', { project: 'e/p', id: 'a1', after: 'a2' }, 409)).code,
    'PLAN_NOT_WAITING',
  );
  // The timeline places what waits on the GPUs it would get, and marks what can never fit.
  await call('plan_save', { project: 'e/p', id: 'huge', resources: { gpus: 16 } });
  const timeline = await call('project_occupancy', { project: 'e/p' });
  const bars = Object.fromEntries(
    timeline.bars.filter((bar) => bar.plan).map((bar) => [bar.plan, bar]),
  );
  assert.deepEqual([bars.a1.claimed, bars.a1.gpus], [true, [4, 5]]);
  assert.equal(bars.a2.host, 'h');
  assert.deepEqual(
    timeline.unfit.map((item) => [item.id, item.reason]),
    [['huge', 'too-few']],
  );
  assert.deepEqual(timeline.hosts.find((host) => host.host === 'r').reserved, [0]);
});

test('randl gpus and plans claim from the command line', async (t) => {
  const { server, call } = await fixture(t);
  const url = await listen(server);
  const cli = async (...args) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ['backend/dist/cli.js', ...args, '--url', url],
          {
            env: { ...process.env, RANDL_API_KEY: '' },
          },
        )
      ).stdout,
    );
  const saved = await cli(
    'gpus',
    'save',
    '--project',
    'e/p',
    '--host',
    'z',
    '--gpus',
    '0,1',
    '--model',
    'RTX 4090',
    '--memory-gb',
    '24',
  );
  assert.deepEqual(
    saved.gpus.map((gpu) => [gpu.gpu, gpu.memory_gb, gpu.allowed]),
    [
      [0, 24, true],
      [1, 24, true],
    ],
  );
  await cli('gpus', 'save', '--project', 'e/p', '--host', 'z', '--gpus', '1', '--reserved');
  await call('plan_save', {
    project: 'e/p',
    id: 'c1',
    resources: { gpus: 1, hosts: ['z'] },
    config_yaml: 'a: 1\n',
  });
  const result = await cli(
    'plans',
    'claim',
    '--project',
    'e/p',
    '--host',
    'z',
    '--free-gpus',
    '0,1',
    '--by',
    'agent',
  );
  assert.deepEqual(
    [result.plan.id, result.gpu_ids, result.plan.config_yaml],
    ['c1', [0], 'a: 1\n'],
  );
});
