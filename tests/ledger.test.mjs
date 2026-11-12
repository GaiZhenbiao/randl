import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../backend/dist/server.js';

// The experiment ledger with synthetic records: findings, recipe, planned runs and journals.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer(directory);
  t.after(() => server.app.close());
  for (const name of ['base', 'arm'])
    await server.db.call('upsert', {
      entity: 'e',
      project: 'p',
      name,
      displayName: name,
      state: 'finished',
    });
  const call = async (name, payload, status = 200) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tools/' + name,
      payload,
    });
    assert.equal(response.statusCode, status, name + ': ' + response.body);
    return response.json();
  };
  return { server, call };
}

test('findings save by id, keep versions, refuse stale saves and list by cited run', async (t) => {
  const { server, call } = await fixture(t);
  const finding = {
    project: 'e/p',
    id: 'rate-limit',
    topic: 'Control',
    title: 'Rate limits help',
    body: 'Limiting the command rate **holds** more boxes.',
    citations: [{ run: 'e/p/arm', update: 500, note: 'arm beats base' }],
    by: 'tester',
  };
  assert.equal((await call('finding_save', finding)).status, 'created');
  assert.equal((await call('finding_save', finding)).status, 'unchanged');
  const updated = await call('finding_save', {
    project: 'e/p',
    id: 'rate-limit',
    status: 'ruled_out',
    version: 1,
  });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.finding.version, 2);
  assert.equal(updated.finding.body, finding.body, 'omitted fields keep their value');
  const stale = await call(
    'finding_save',
    { project: 'e/p', id: 'rate-limit', title: 'x', version: 1 },
    409,
  );
  assert.equal(stale.code, 'FINDING_CONFLICT');
  const { versions } = await call('finding_get', { project: 'e/p', id: 'rate-limit' });
  assert.deepEqual(
    versions.map((item) => [item.version, item.record.status]),
    [
      [2, 'ruled_out'],
      [1, 'finding'],
    ],
  );
  assert.equal(
    (await call('findings_list', { project: 'e/p', run: 'e/p/arm' })).findings.length,
    1,
  );
  assert.equal(
    (await call('findings_list', { project: 'e/p', run: 'e/p/base' })).findings.length,
    0,
  );
  await call('finding_delete', { project: 'e/p', id: 'rate-limit' });
  assert.equal((await call('findings_list', { project: 'e/p' })).findings.length, 0);
  // Saving the id again continues its versions.
  assert.equal((await call('finding_save', finding)).finding.version, 3);
  assert.equal(
    (await call('finding_get', { project: 'e/p', id: 'nope' }, 404)).code,
    'LEDGER_NOT_FOUND',
  );
  const audit = await server.db.call('auditList');
  assert.ok(
    audit.some((entry) => entry.tool === 'finding_save' && entry.arguments.includes('tester')),
  );
});

test('the recipe keeps its history; plans and journal entries are idempotent', async (t) => {
  const { call } = await fixture(t);
  await call('recipe_set', {
    project: 'e/p',
    run: 'e/p/base',
    reason: 'first',
    since: '2026-10-01',
  });
  const set = await call('recipe_set', {
    project: 'e/p',
    run: 'e/p/arm',
    reason: 'more holds',
    since: 1793000000,
  });
  assert.equal(set.current.run, 'e/p/arm');
  assert.equal(
    (await call('recipe_set', { project: 'e/p', run: 'e/p/arm', reason: 'more holds' })).status,
    'unchanged',
  );
  assert.deepEqual(
    (await call('recipe_get', { project: 'e/p' })).history.map((event) => event.run),
    ['e/p/arm', 'e/p/base'],
  );

  const plan = {
    project: 'e/p',
    id: 'next',
    name: 'v700_next',
    parent: 'e/p/arm',
    parentUpdate: 500,
    host: 'hostA',
    slot: 'a1',
    queue: 2,
  };
  assert.equal((await call('plan_save', plan)).status, 'created');
  assert.equal((await call('plan_save', plan)).status, 'unchanged');
  const moved = await call('plan_save', { project: 'e/p', id: 'next', queue: 1 });
  assert.deepEqual([moved.status, moved.plan.queue, moved.plan.host], ['updated', 1, 'hostA']);
  assert.equal((await call('plans_list', { project: 'e/p' })).plans.length, 1);

  const entry = {
    run: 'e/p/arm',
    text: 'Collisions dropped after u400.',
    update: 400,
    time: '2026-11-02T10:00:00Z',
  };
  assert.equal((await call('journal_add', entry)).status, 'added');
  assert.equal((await call('journal_add', entry)).status, 'unchanged');
  await call('journal_add', { run: 'e/p/arm', text: 'Stopped.', key: 'stop-1' });
  assert.equal(
    (await call('journal_add', { run: 'e/p/arm', text: 'Other', key: 'stop-1' }, 409)).code,
    'JOURNAL_KEY_IN_USE',
  );
  assert.equal(
    (await call('journal_add', { run: 'e/p/none', text: 'x' }, 404)).code,
    'RUN_NOT_FOUND',
  );
  const { entries } = await call('journal_list', { run: 'e/p/arm' });
  assert.deepEqual(
    entries.map((item) => [item.text, item.update]),
    [
      ['Collisions dropped after u400.', 400],
      ['Stopped.', null],
    ],
  );
  assert.equal((await call('journal_list', { project: 'e/p' })).entries.length, 2);
  const run = await call('run_get', { id: 'e/p/arm' });
  assert.equal(run.run.notes, '', 'the journal leaves notes alone');
});

test('deleting a project deletes its ledger', async (t) => {
  const { server, call } = await fixture(t);
  await call('finding_save', { project: 'e/p', id: 'f', title: 'F' });
  await call('recipe_set', { project: 'e/p', run: 'e/p/base', reason: 'r' });
  await call('plan_save', { project: 'e/p', id: 'p' });
  await call('journal_add', { run: 'e/p/base', text: 't' });
  const project = await server.db.call('projectGet', 'e/p');
  await server.db.call('projectDelete', {
    id: 'e/p',
    confirm: project.name,
    expected: project.counts,
  });
  // A new project with the same id starts with an empty ledger.
  await server.db.call('upsert', { entity: 'e', project: 'p', name: 'base' });
  assert.deepEqual((await call('findings_list', { project: 'e/p' })).findings, []);
  assert.deepEqual((await call('recipe_get', { project: 'e/p' })).history, []);
  assert.deepEqual((await call('plans_list', { project: 'e/p' })).plans, []);
  assert.deepEqual((await call('journal_list', { project: 'e/p' })).entries, []);
});

test('the CLI saves findings, sets the recipe, plans runs and adds journal entries', async (t) => {
  const { server } = await fixture(t);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const url = 'http://127.0.0.1:' + server.app.server.address().port;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
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
    'findings',
    'save',
    '--project',
    'e/p',
    '--id',
    'f1',
    '--title',
    'Wide heads help',
    '--topic',
    'Model',
    '--body',
    'Text',
    '--cite',
    'e/p/arm@500,e/p/base',
    '--by',
    'cli',
  );
  assert.deepEqual(saved.finding.citations, [{ run: 'e/p/arm', update: 500 }, { run: 'e/p/base' }]);
  assert.equal(
    (await cli('recipe', 'set', '--project', 'e/p', '--run', 'e/p/arm', '--reason', 'best')).current
      .run,
    'e/p/arm',
  );
  const plan = await cli(
    'plans',
    'save',
    '--project',
    'e/p',
    '--id',
    'p1',
    '--name',
    'v1',
    '--json',
    '{"host":"h","queue":1}',
  );
  assert.deepEqual([plan.plan.host, plan.plan.queue], ['h', 1]);
  assert.equal(
    (await cli('journal', 'add', '--run', 'e/p/arm', '--text', 'note', '--update', '500')).entry
      .update,
    500,
  );
  assert.equal((await cli('journal', 'list', '--run', 'e/p/arm')).entries.length, 1);
  assert.equal(
    (await cli('findings', 'list', '--project', 'e/p', '--run', 'e/p/arm')).findings.length,
    1,
  );
});

test('plans know the run that carried them out; the graph carries evidence and recent means', async (t) => {
  const { server, call } = await fixture(t);
  const log = (id, rows) =>
    server.db.call('ingest', id, {
      files: {
        'wandb-history.jsonl': { offset: 0, content: rows.map((row) => JSON.stringify(row)) },
      },
    });
  const audit = 'audit/x';
  // Audits at updates 100..500: base at 0.1..0.5, arm 0.05 above where both audited.
  await log(
    'e/p/base',
    [1, 2, 3, 4, 5].map((i) => ({ _step: i * 10, update: i * 100, [audit]: i / 10 })),
  );
  await log(
    'e/p/arm',
    [2, 3, 4, 6].map((i) => ({ _step: i * 7, update: i * 100, [audit]: i / 10 + 0.05 })),
  );
  await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'carried',
    displayName: 'v2',
    config: { lineage: { value: { plan: 'p-carried', parent: null } } },
  });
  await server.db.call('upsert', {
    entity: 'e',
    project: 'p',
    name: 'eval',
    displayName: 'eval of arm',
    config: { lineage: { value: { examines: ['arm'] } } },
  });
  await call('project_lineage_settings_update', { id: 'e/p', metric: audit, window: 2 });
  await call('recipe_set', { project: 'e/p', run: 'e/p/arm', reason: 'best' });
  await call('plan_save', { project: 'e/p', id: 'p-open', name: 'v3', parent: 'e/p/arm' });
  await call('plan_save', { project: 'e/p', id: 'p-carried', name: 'v2-planned' });
  await call('plan_save', { project: 'e/p', id: 'p-named', name: 'base' });
  const graph = await call('project_lineage', { id: 'e/p' });
  // The graph, which the Assistant can read, carries no ledger records.
  assert.equal(graph.recipe, undefined);
  assert.equal(graph.plans, undefined);
  const { plans } = await call('plans_list', { project: 'e/p' });
  assert.deepEqual(
    plans.map((plan) => [plan.id, plan.run]),
    [
      ['p-open', null],
      ['p-carried', 'e/p/carried'],
      ['p-named', 'e/p/base'],
    ],
    'a plan is carried out by the run logging its id, else the run with its name',
  );
  const node = (id) => graph.nodes.find((item) => item.id === id);
  assert.ok(Math.abs(node('e/p/base').recent - 0.45) < 1e-9, 'mean of the last 2 audits');
  assert.deepEqual(node('e/p/eval').examines, ['e/p/arm']);
  assert.equal(node('e/p/carried').plan, 'p-carried');

  const compared = await call('runs_compare', {
    baseline: 'e/p/base',
    runs: ['e/p/arm'],
    metric: audit,
  });
  const [arm] = compared.runs;
  assert.equal(arm.matched, 3);
  assert.ok(Math.abs(arm.meanDiff - 0.05) < 1e-9);
  assert.deepEqual(
    arm.points.map((point) => point.x),
    [200, 300, 400],
  );
  const bySteps = await call('runs_compare', {
    baseline: 'e/p/base',
    runs: ['e/p/arm'],
    metric: audit,
    x: '_step',
  });
  assert.equal(bySteps.runs[0].matched, 0, 'steps differ between the runs');
});

test('ledger writes carry their source, plans queue after a run, and dry runs write nothing', async (t) => {
  const { server, call } = await fixture(t);
  const source = { document: 'handbook', lines: [120, 135], quote: 'Wide heads won.' };
  const finding = { project: 'e/p', id: 'f', title: 'F', source };
  assert.deepEqual(await call('finding_save', { ...finding, dryRun: true }), {
    status: 'created',
    dryRun: true,
  });
  assert.equal((await call('findings_list', { project: 'e/p' })).findings.length, 0);
  assert.deepEqual((await call('finding_save', finding)).finding.source, source);
  assert.equal((await call('finding_save', { ...finding, dryRun: true })).status, 'unchanged');
  assert.equal(
    (await call('finding_save', { ...finding, title: 'G', dryRun: true })).status,
    'updated',
  );
  assert.equal(
    (
      await call('recipe_set', {
        project: 'e/p',
        run: 'e/p/arm',
        reason: 'r',
        source,
        dryRun: true,
      })
    ).status,
    'set',
  );
  assert.equal((await call('recipe_get', { project: 'e/p' })).current, null);
  assert.deepEqual(
    (await call('recipe_set', { project: 'e/p', run: 'e/p/arm', reason: 'r', source })).current
      .source,
    source,
  );
  const plan = await call('plan_save', {
    project: 'e/p',
    id: 'v657',
    after: 'e/p/arm',
    host: 'Sirius',
    slot: 'sirius_34',
    source,
  });
  assert.deepEqual([plan.plan.after, plan.plan.queue, plan.plan.source], ['e/p/arm', null, source]);
  const entry = { run: 'e/p/arm', text: 'From the handbook.', source };
  assert.equal((await call('journal_add', { ...entry, dryRun: true })).status, 'added');
  assert.equal((await call('journal_list', { run: 'e/p/arm' })).entries.length, 0);
  assert.deepEqual((await call('journal_add', entry)).entry.source, source);
  const audit = await server.db.call('auditList');
  assert.ok(
    !audit.some((item) => item.arguments.includes('"dryRun":true')),
    'dry runs are not audited',
  );
});

test('evidence imports as a dated run with examined runs, file references and uploads', async (t) => {
  const { server, call } = await fixture(t);
  const evidence = {
    project: 'e/p',
    id: 'eval-arm-box40',
    name: 'Evaluation of arm on box40',
    job_type: 'evaluation',
    created: '2026-10-05T12:00:00Z',
    examines: ['e/p/arm'],
    summary: { holds: 361, episodes: 512 },
    config: { audit: { label: 'box40' } },
    notes: 'Imported from the evaluations folder.',
    source: { document: 'handbook', lines: [10, 12] },
    files: [
      { name: 'report.json', upload: true },
      {
        name: 'episode_0.mp4',
        host: 'Sirius',
        path: '/data/evals/arm/episode_0.mp4',
        bytes: 52428800,
      },
    ],
  };
  assert.deepEqual(await call('evidence_save', { ...evidence, dryRun: true }), {
    id: 'e/p/eval-arm-box40',
    status: 'created',
    dryRun: true,
  });
  assert.equal(await server.db.call('run', 'e/p/eval-arm-box40'), undefined);
  assert.equal((await call('evidence_save', evidence)).status, 'created');
  assert.equal((await call('evidence_save', evidence)).status, 'unchanged');
  const { run } = await call('run_get', { id: 'e/p/eval-arm-box40' });
  assert.deepEqual(
    [run.state, run.job_type, run.created],
    ['finished', 'evaluation', Date.parse('2026-10-05T12:00:00Z') / 1000],
  );
  assert.deepEqual(JSON.parse(run.config).evidence.value.files[1].host, 'Sirius');
  assert.deepEqual(JSON.parse(run.summary), { holds: 361, episodes: 512 });
  // Uploaded files go with the run through the usual upload route.
  const upload = await server.app.inject({
    method: 'PUT',
    url: '/upload/e/p/eval-arm-box40/report.json',
    payload: '{"holds": 361}',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const graph = await call('project_lineage', { id: 'e/p' });
  const node = graph.nodes.find((item) => item.id === 'e/p/eval-arm-box40');
  assert.deepEqual([node.jobType, node.examines], ['evaluation', ['e/p/arm']]);
  assert.equal(
    (await call('evidence_save', { ...evidence, notes: 'Rechecked.' })).status,
    'updated',
  );
});
