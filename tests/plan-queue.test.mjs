import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { createServer } from '../backend/dist/server.js';
import { queueOrder, moveWithin, statusFromRun } from '../backend/dist/plan-queue.js';
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
  const claimed = await call('plan_claim', { project: 'e/p', slot: 'a', by: 's', host: 'h' });
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

test('supervisors claim the head of a slot one at a time; stale claims return to the queue', async (t) => {
  const { server, directory, call, launch, plan } = await fixture(t);
  const yaml = '# exact file\nrl:\n  lr: 3.0e-6   # trailing comment  \n  name: "v700 — ü"\n\n';
  await call('plan_save', {
    project: 'e/p',
    id: 'q1',
    host: 'h',
    slot: 'a',
    queue: 1,
    config_yaml: yaml,
    updates: 25000,
  });
  await call('plan_save', {
    project: 'e/p',
    id: 'q2',
    host: 'h',
    slot: 'a',
    queue: 2,
    resume_run: 'e/p/seed',
  });
  await call('plan_save', { project: 'e/p', id: 'other', host: 'h', slot: 'b', queue: 1 });
  assert.deepEqual(
    (await call('plan_queue', { project: 'e/p', slot: 'a' })).plans.map((item) => item.id),
    ['q1', 'q2'],
  );

  // Five supervisors at once: one takes q1, the others are refused while its run is pending.
  const attempts = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      server.app.inject({
        method: 'POST',
        url: '/api/tools/plan_claim',
        payload: { project: 'e/p', slot: 'a', by: 'sup' + n, host: 'h' },
      }),
    ),
  );
  const claimed = attempts.filter((response) => response.statusCode === 200);
  assert.equal(claimed.length, 1);
  assert.ok(
    attempts
      .filter((response) => response.statusCode === 409)
      .every((response) => response.json().code === 'PLAN_CLAIM_PENDING'),
  );
  const taken = claimed[0].json();
  assert.equal(taken.plan.id, 'q1');
  // The config text comes back byte for byte.
  assert.equal(taken.plan.config_yaml, yaml);
  assert.equal(taken.plan.updates, 25000);
  const by = taken.claim.by;
  // The same supervisor asking again gets the same plan.
  const again = await call('plan_claim', { project: 'e/p', slot: 'a', by, host: 'h' });
  assert.deepEqual([again.plan.id, again.repeat], ['q1', true]);
  assert.equal((await plan('q1')).status, 'started');
  assert.deepEqual(
    (await call('plan_queue', { project: 'e/p', slot: 'a' })).plans.map((item) => item.id),
    ['q2'],
  );

  // Its run never logs: after 30 minutes the plan is back in the queue, and says so.
  const raw = new Database(join(directory, 'randl.sqlite3'));
  const row = raw.prepare("SELECT record FROM planned_runs WHERE id='q1'").get(),
    record = JSON.parse(row.record);
  record.claim.at -= 31 * 60;
  raw.prepare("UPDATE planned_runs SET record=? WHERE id='q1'").run(JSON.stringify(record));
  raw.close();
  const expired = await plan('q1');
  assert.equal(expired.status, 'planned');
  assert.equal(expired.claim, undefined);
  assert.equal(expired.events.at(-1).status, 'claim_expired');

  // Claimed again, and this time its run logs the plan: started, bound to the run.
  const retaken = await call('plan_claim', { project: 'e/p', slot: 'a', by: 'sup9', host: 'h' });
  assert.equal(retaken.plan.id, 'q1');
  const run = await launch('r-q1', 'q1');
  assert.deepEqual([(await plan('q1')).status, (await plan('q1')).run], ['started', run.id]);
  // With q1 running, the next claim takes q2, a resume of an existing run.
  const next = await call('plan_claim', { project: 'e/p', slot: 'a', by: 'sup9', host: 'h' });
  assert.deepEqual([next.plan.id, next.plan.resume_run], ['q2', 'e/p/seed']);
  await launch('r-q2', 'q2');
  assert.deepEqual(await call('plan_claim', { project: 'e/p', slot: 'a', by: 'sup9', host: 'h' }), {
    status: 'empty',
    plan: null,
  });
  // Claims are audited; dry runs and empty queues are not.
  const audited = (await server.db.call('auditList')).filter(
    (entry) => entry.tool === 'plan_claim',
  );
  assert.equal(audited.length, 3);
});

test("a claim or move with a host keeps to that host's plans in a slot name two hosts share", async (t) => {
  const { call } = await fixture(t);
  await call('plan_save', { project: 'e/p', id: 'k1', host: 'k', slot: '0', queue: 1 });
  await call('plan_save', { project: 'e/p', id: 'h1', host: 'h', slot: '0', queue: 2 });
  await call('plan_save', { project: 'e/p', id: 'h2', host: 'h', slot: '0', queue: 3 });
  // Moving h2 ahead of h1 renumbers h's queue only.
  await call('plan_move', { project: 'e/p', id: 'h2', before: 'h1' });
  const order = async (host) =>
    (await call('plan_queue', { project: 'e/p', slot: '0', host })).plans.map((item) => [
      item.id,
      item.queue,
    ]);
  assert.deepEqual(await order('h'), [
    ['h2', 1],
    ['h1', 2],
  ]);
  assert.deepEqual(await order('k'), [['k1', 1]]);
  await call('plan_move', { project: 'e/p', id: 'h1', before: 'h2' });
  const taken = await call('plan_claim', { project: 'e/p', slot: '0', by: 's', host: 'h' });
  assert.equal(taken.plan.id, 'h1');
  // h's pending claim does not hold up k's supervisor.
  const other = await call('plan_claim', { project: 'e/p', slot: '0', by: 't', host: 'k' });
  assert.equal(other.plan.id, 'k1');
});

test('plans move within a slot and between slots, renumbering both queues', async (t) => {
  const { call, launch } = await fixture(t);
  for (const [id, slot, queue] of [
    ['a1', 'a', 1],
    ['a2', 'a', 2],
    ['a3', 'a', 3],
    ['b1', 'b', 1],
  ])
    await call('plan_save', { project: 'e/p', id, host: slot === 'a' ? 'h' : 'k', slot, queue });
  const ids = async (slot) =>
    (await call('plan_queue', { project: 'e/p', slot })).plans.map((item) => [item.id, item.queue]);
  await call('plan_move', { project: 'e/p', id: 'a3', before: 'a1', by: 'me' });
  assert.deepEqual(await ids('a'), [
    ['a3', 1],
    ['a1', 2],
    ['a2', 3],
  ]);
  await call('plan_move', { project: 'e/p', id: 'a1', slot: 'b', after: 'b1', by: 'me' });
  assert.deepEqual(await ids('a'), [
    ['a3', 1],
    ['a2', 2],
  ]);
  assert.deepEqual(await ids('b'), [
    ['b1', 1],
    ['a1', 2],
  ]);
  const moved = (await call('plans_list', { project: 'e/p' })).plans.find(
    (item) => item.id === 'a1',
  );
  assert.deepEqual([moved.slot, moved.host, moved.events.at(-1).status], ['b', 'k', 'moved']);
  // A plan already under way does not move.
  await launch('r-a3', 'a3');
  const refused = await call('plan_move', { project: 'e/p', id: 'a3', after: 'a2' }, 409);
  assert.equal(refused.code, 'PLAN_NOT_WAITING');
});

test('randl plans claim prints the plan to launch', async (t) => {
  const { server, call } = await fixture(t);
  const url = await listen(server);
  await call('plan_save', {
    project: 'e/p',
    id: 'c1',
    host: 'h',
    slot: 'a',
    config_yaml: 'a: 1\n',
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      'backend/dist/cli.js',
      'plans',
      'claim',
      '--url',
      url,
      '--project',
      'e/p',
      '--slot',
      'a',
      '--by',
      'sup',
      '--host',
      'h',
    ],
    { env: { ...process.env, RANDL_API_KEY: '' } },
  );
  const result = JSON.parse(stdout);
  assert.deepEqual([result.plan.id, result.plan.config_yaml], ['c1', 'a: 1\n']);
});
