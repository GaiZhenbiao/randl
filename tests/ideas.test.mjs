import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createServer } from '../backend/dist/server.js';
import { listen } from './helpers.mjs';

// Ideas: the backlog of experiments, promoted to plans or made from them; synthetic data.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-ideas-'));
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
  const ideas = async () => (await call('idea_list', { project: 'e/p' })).ideas;
  const plans = async () => (await call('plans_list', { project: 'e/p' })).plans;
  return { server, call, ideas, plans };
}

test('ideas are listed open first by priority, and promoting one makes its plan', async (t) => {
  const { server, call, ideas, plans } = await fixture(t);
  await call('idea_save', { project: 'e/p', id: 'low', title: 'Low one', priority: 'low' });
  await call('idea_save', {
    project: 'e/p',
    id: 'wider',
    title: 'A wider exploration floor',
    hypothesis: 'A wider floor lets the policy find joint heading.',
    evidence: 'The log-std sits on the floor in every recent run.',
    prerequisites: 'After the current comparison ends.',
    waits_on: [
      { kind: 'run', id: 'e/p/seed' },
      { kind: 'finding', id: 'floor-pinned' },
    ],
    priority: 'high',
  });
  await call('idea_save', { project: 'e/p', id: 'gone', title: 'Set aside', status: 'dropped' });
  assert.deepEqual(
    (await ideas()).map((idea) => idea.id),
    ['wider', 'low', 'gone'],
  );
  // Only idea_promote makes an idea promoted.
  await call('idea_save', { project: 'e/p', id: 'low', status: 'promoted' }, 400);
  // The same save again changes nothing and is not audited.
  assert.equal(
    (await call('idea_save', { project: 'e/p', id: 'low', title: 'Low one' })).status,
    'unchanged',
  );

  const promoted = await call('idea_promote', {
    project: 'e/p',
    id: 'wider',
    plan: 'v12',
    name: 'v12_wider_floor',
    resources: { gpus: 2, min_memory_gb: 48 },
    queue: 1,
    change: 'Log-std floor -3.0 instead of -3.5.',
  });
  assert.equal(promoted.status, 'promoted');
  assert.deepEqual([promoted.idea.status, promoted.idea.plan], ['promoted', 'v12']);
  const made = (await plans()).find((plan) => plan.id === 'v12');
  assert.deepEqual(
    [made.name, made.status, made.resources.gpus, made.idea, made.hypothesis],
    ['v12_wider_floor', 'planned', 2, 'wider', 'A wider floor lets the policy find joint heading.'],
  );
  // Editing the plan keeps its link to the idea.
  await call('plan_save', { project: 'e/p', id: 'v12', rule: 'Compare at matched updates.' });
  assert.equal((await plans()).find((plan) => plan.id === 'v12').idea, 'wider');
  // Promoting again to that plan changes nothing; to another is refused.
  assert.equal(
    (await call('idea_promote', { project: 'e/p', id: 'wider', plan: 'v12' })).status,
    'unchanged',
  );
  assert.equal(
    (await call('idea_promote', { project: 'e/p', id: 'wider', plan: 'v13' }, 409)).code,
    'IDEA_PROMOTED',
  );
  // A plan id already in use is refused.
  assert.equal(
    (await call('idea_promote', { project: 'e/p', id: 'low', plan: 'v12' }, 409)).code,
    'IDEA_PLAN_EXISTS',
  );
  const audited = (await server.db.call('auditList')).map((entry) => entry.tool);
  assert.deepEqual(
    audited.filter((tool) => tool.startsWith('idea_')),
    ['idea_promote', 'idea_save', 'idea_save', 'idea_save'],
  );
});

test('a waiting plan becomes an idea and back without losing its fields', async (t) => {
  const { call, ideas, plans } = await fixture(t);
  const yaml = 'rl:\n  lr: 1.0e-6  # exact\n';
  await call('plan_save', { project: 'e/p', id: 'head', host: 'h', slot: 'a', queue: 1 });
  await call('plan_save', {
    project: 'e/p',
    id: 'later',
    name: 'v20_later',
    host: 'h',
    slot: 'a',
    after: 'plan:head',
    change: 'Twice the batch.',
    hypothesis: 'More samples per update steady the critic.',
    rule: 'Stop if holds fall.',
    baseline: 'e/p/seed',
    config_yaml: yaml,
    updates: 5000,
    source: { document: 'notes', lines: [3, 4] },
  });
  await call('plan_save', {
    project: 'e/p',
    id: 'tail',
    host: 'h',
    slot: 'a',
    after: 'plan:later',
  });
  await call('plan_save', { project: 'e/p', id: 'old', host: 'h', slot: 'a', status: 'cancelled' });
  const dry = await call('idea_from_plan', { project: 'e/p', plan: 'later', dryRun: true });
  assert.deepEqual([dry.idea, dry.requeued], ['later', ['tail']]);
  assert.ok((await plans()).some((plan) => plan.id === 'later'));

  const converted = await call('idea_from_plan', {
    project: 'e/p',
    plan: 'later',
    priority: 'high',
    evidence: 'The critic loss is noisy.',
  });
  assert.equal(converted.status, 'converted');
  const idea = converted.idea;
  assert.deepEqual(
    [idea.title, idea.status, idea.priority, idea.hypothesis],
    ['v20_later', 'open', 'high', 'More samples per update steady the critic.'],
  );
  assert.deepEqual(idea.waits_on, [{ kind: 'plan', id: 'head' }]);
  assert.deepEqual(idea.source, { document: 'notes', lines: [3, 4] });
  // The plan is gone, and the one queued after it now follows what it followed.
  const list = await plans();
  assert.ok(!list.some((plan) => plan.id === 'later'));
  assert.equal(list.find((plan) => plan.id === 'tail').after, 'plan:head');
  // Again changes nothing.
  assert.equal(
    (await call('idea_from_plan', { project: 'e/p', plan: 'later' })).status,
    'unchanged',
  );
  // A cancelled plan becomes a dropped idea; a plan under way stays a plan.
  assert.equal(
    (await call('idea_from_plan', { project: 'e/p', plan: 'old' })).idea.status,
    'dropped',
  );
  await call('gpus_save', { project: 'e/p', host: 'h', gpus: [0], memory_gb: 24 });
  await call('plan_claim', { project: 'e/p', host: 'h', free_gpus: [0], by: 's' });
  assert.equal(
    (await call('idea_from_plan', { project: 'e/p', plan: 'head' }, 409)).code,
    'PLAN_NOT_WAITING',
  );

  // Promoted again, the plan comes back with its id and fields, config byte for byte.
  await call('idea_promote', { project: 'e/p', id: 'later', queue: 2 });
  const back = (await plans()).find((plan) => plan.id === 'later');
  assert.deepEqual(
    [back.name, back.change, back.rule, back.baseline, back.after, back.updates, back.queue],
    ['v20_later', 'Twice the batch.', 'Stop if holds fall.', 'e/p/seed', 'plan:head', 5000, 2],
  );
  assert.equal(back.config_yaml, yaml);
  assert.equal(back.idea, 'later');
  assert.equal((await ideas()).find((item) => item.id === 'later').status, 'promoted');
});

test('randl ideas from the command line', async (t) => {
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
  await cli(
    'ideas',
    'save',
    '--project',
    'e/p',
    '--id',
    'i1',
    '--title',
    'An idea',
    '--priority',
    'high',
  );
  const promoted = await cli(
    'ideas',
    'promote',
    '--project',
    'e/p',
    '--id',
    'i1',
    '--json',
    JSON.stringify({ resources: { gpus: 2, min_memory_gb: 48 } }),
  );
  assert.deepEqual(promoted.plan.resources, { gpus: 2, min_memory_gb: 48 });
  assert.equal((await call('plan_queue', { project: 'e/p' })).plans[0].id, 'i1');
  assert.equal((await cli('ideas', 'list', '--project', 'e/p')).ideas[0].status, 'promoted');
});
