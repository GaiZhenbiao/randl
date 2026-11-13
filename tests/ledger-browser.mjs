import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// The experiment ledger in the interface, with synthetic records: findings with versions, the
// best recipe, planned runs and queues, journals, and runs compared at matched updates.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-ledger-browser-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const origin = await listen(server);
  const audit = 'audit/x';
  const seed = async (name, lineage, values) => {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'ledger',
      name,
      displayName: name,
      config: { lineage: { value: lineage } },
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: values.map((value, index) =>
            JSON.stringify({ _step: index * 10, update: (index + 1) * 100, [audit]: value }),
          ),
        },
      },
      complete: true,
    });
    return run.id;
  };
  const base = await seed('v1_base', { parent: null }, [0.4, 0.5, 0.6]);
  const arm = await seed(
    'v2_arm',
    { parent: { run_id: 'v1_base', update: 100 }, change: 'Wider head' },
    [0.5, 0.6, 0.8],
  );
  const call = (name, payload) => server.tools.execute(name, payload);
  await call('project_lineage_settings_update', { id: 'test/ledger', metric: audit, window: 2 });
  await call('finding_save', {
    project: 'test/ledger',
    id: 'wide-heads',
    topic: 'Model',
    title: 'Wider heads hold more boxes',
    body: 'The wide head adds **0.2** at update 300.',
    citations: [{ run: arm, update: 300, note: 'against v1' }],
    source: { document: 'handbook', lines: [1, 3], quote: 'Wide heads hold more.' },
  });
  // An imported evaluation of v2, with one uploaded file and one kept on its host.
  await call('evidence_save', {
    project: 'test/ledger',
    id: 'eval-v2',
    name: 'Evaluation of v2',
    job_type: 'evaluation',
    created: '2026-10-05T12:00:00Z',
    examines: [arm],
    files: [
      { name: 'report.json', upload: true },
      { name: 'episode.mp4', host: 'hostA', path: '/evals/v2/episode.mp4', bytes: 2048 },
    ],
  });
  // Queued after a plan that is first on the slot.
  await call('plan_save', {
    project: 'test/ledger',
    id: 'v4-later',
    name: 'v4_later',
    host: 'hostA',
    slot: 'a1',
    after: 'plan:v3_next',
  });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  // Findings: a list by topic and status; the reading pane renders Markdown and links the
  // cited runs; edits keep versions.
  await page.goto(`${origin}/test/ledger/findings`);
  const row = (title) => page.locator('.findings-table tbody tr', { hasText: title });
  await expect(row('Wider heads hold more boxes')).toContainText('Model');
  await row('Wider heads hold more boxes').click();
  await expect(page).toHaveURL(/finding=wide-heads/);
  const finding = page.locator('.findings-reader .finding');
  await expect(finding.locator('strong')).toHaveText('0.2');
  await expect(finding.getByRole('link', { name: 'v2_arm' })).toBeVisible();
  await expect(finding.locator('.ledger-source')).toHaveText('From handbook, lines 1–3');
  await finding.getByRole('button', { name: 'Edit finding' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit finding' });
  await editor.getByLabel('Text').fill('The wide head adds **0.2**, confirmed twice.');
  await editor.getByRole('button', { name: 'Save finding' }).click();
  await expect(finding).toContainText('confirmed twice');
  await expect(finding).toContainText('Version 2');
  await finding.getByRole('button', { name: 'Earlier versions' }).click();
  const history = page.getByRole('dialog', { name: /Versions of/ });
  await history.getByRole('button', { name: /Version 1,/ }).click();
  await expect(history.locator('.finding-body')).toContainText('at update 300');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New finding' }).click();
  const create = page.getByRole('dialog', { name: 'New finding' });
  await create.getByLabel('Title').fill('Cosine schedules stall');
  await create.getByLabel('Topic').fill('Optimizer');
  await create.getByText('Ruled out', { exact: true }).click();
  await create.getByRole('button', { name: 'Save finding' }).click();
  await expect(row('Cosine schedules stall')).toContainText('Ruled out');
  await expect(finding.locator('h2')).toHaveText('Cosine schedules stall');
  assert.equal(
    (await call('finding_get', { project: 'test/ledger', id: 'cosine-schedules-stall' })).finding
      .status,
    'ruled_out',
  );
  checks.push(
    'Findings list by topic and status; the reader shows Markdown and cited runs; edits keep versions',
  );

  // Plans: set the best recipe and plan a run on a slot's queue.
  await page.goto(`${origin}/test/ledger/plans`);
  await page.getByRole('button', { name: 'Change the best recipe' }).click();
  await page.getByRole('combobox', { name: 'Run' }).fill('v2');
  await page.getByRole('option', { name: 'v2_arm' }).click();
  await page.getByLabel('Why it is the best recipe').fill('Highest audit mean');
  await page.getByRole('button', { name: 'Set best recipe' }).click();
  await expect(page.locator('.recipe-tile')).toContainText('v2_arm');
  // Its promotions open in a drawer beside the page.
  await page.getByRole('button', { name: '1 promotion' }).click();
  const promotions = page.getByRole('dialog', { name: 'Best recipe promotions' });
  await expect(promotions.locator('.recipe-timeline li')).toHaveCount(1);
  await expect(promotions).toContainText('Highest audit mean');
  // Every sidebar resizes the same way (SidebarResize): drag its edge, or the arrow keys on
  // it, and it keeps the width the next time it opens.
  const edge = promotions.getByRole('separator', { name: 'Resize panel' }),
    drawerWidth = async () => Math.round((await promotions.boundingBox()).width),
    before = await drawerWidth(),
    grip = await edge.boundingBox();
  await page.mouse.move(grip.x + 4, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x - 116, grip.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(drawerWidth).toBe(before + 120);
  await edge.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(drawerWidth).toBe(before + 136);
  await expect(edge).toHaveAttribute('aria-valuenow', String(before + 136));
  await promotions.getByRole('button', { name: 'Close' }).click();
  await expect(promotions).toHaveCount(0);
  await page.getByRole('button', { name: '1 promotion' }).click();
  await expect.poll(drawerWidth).toBe(before + 136);
  await promotions.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Plan a run' }).click();
  const plan = page.getByRole('dialog', { name: 'Plan a run' });
  await plan.getByLabel('Run name').fill('v3_next');
  await plan.getByRole('combobox', { name: 'Starts from' }).fill('v2');
  await page.getByRole('option', { name: 'v2_arm' }).click();
  await plan.getByLabel('What it changes').fill('Constant LR');
  // It asks for two GPUs of at least 24 GB, first in the queue.
  await plan.getByLabel('GPUs', { exact: true }).fill('2');
  await plan.getByLabel('Minimum memory (GB)').fill('24');
  await plan.getByLabel('Queue position').fill('1');
  await plan.getByRole('button', { name: 'Save plan' }).click();
  const queue = page.locator('.plan-queue');
  await expect(queue.locator('.plan-row .queue-name')).toHaveText(['v3_next', 'v4_later']);
  await expect(queue.locator('.plan-row', { hasText: 'v3_next' })).toContainText('2 GPUs ≥ 24 GB');
  checks.push('The Plans page sets the best recipe and queues planned runs with GPU requests');

  // Lineage: the recipe star, the dashed planned node, its plan, a journal entry and a comparison.
  await page.goto(`${origin}/test/ledger/lineage`);
  const card = (name) => page.locator('.lineage-card', { hasText: name });
  await expect(card('v2').locator('.lineage-recipe-icon')).toHaveCount(1);
  await expect(card('v3')).toHaveClass(/planned/);
  await expect(page.locator('.lineage-edges .lineage-edge.planned')).toHaveCount(1);
  await expect(card('v2')).toContainText('last 2: 0.7');
  await card('v3').click();
  const details = page.locator('.lineage-details');
  await expect(details).toContainText('Starts from');
  await expect(details).toContainText('2 GPUs ≥ 24 GB · #1');
  await card('v2').click();
  await expect(details).toContainText('Best recipe since');
  await expect(details.getByRole('button', { name: 'Wider heads hold more boxes' })).toBeVisible();
  await details.getByLabel('New journal entry').fill('Collisions fell after u200.');
  await details.getByLabel('At update (optional)').fill('200');
  await details.getByRole('button', { name: 'Add entry' }).click();
  await expect(details.locator('.lineage-journal')).toContainText('Collisions fell after u200.');
  await page.getByRole('button', { name: 'Fit all' }).click();
  await card('v1').click({ modifiers: ['Shift'] });
  const evidence = details.locator('section', { hasText: 'Evidence' });
  await expect(evidence.getByRole('button', { name: 'Evaluation of v2' })).toBeVisible();
  const compare = details.locator('.lineage-compare');
  await expect(compare.locator('tbody tr')).toHaveCount(1);
  await expect(compare.locator('tbody td').nth(1)).toHaveText('3');
  await expect(compare.locator('tbody td').nth(2)).toHaveText('-0.1333');
  await evidence.getByRole('button', { name: 'Evaluation of v2' }).click();
  const files = details.locator('section', { hasText: 'Files' });
  await expect(files.getByRole('link', { name: 'report.json' })).toBeVisible();
  await expect(files).toContainText('episode.mp4 · hostA:/evals/v2/episode.mp4 · 2 KiB');
  checks.push(
    'Lineage shows the recipe, planned runs, journals, findings, evidence files and matched comparisons',
  );

  // The run page shows the journal; its finding opens the Findings page at that finding.
  await page.goto(`${origin}/test/ledger/runs/v2_arm/overview`);
  await expect(page.locator('.lineage-journal')).toContainText('Collisions fell after u200.');
  await page.getByRole('button', { name: 'Wider heads hold more boxes' }).click();
  await expect(page).toHaveURL(/\/test\/ledger\/findings\?finding=wide-heads/);
  await expect(page.locator('.findings-reader .finding')).toContainText('Wider heads');
  checks.push('The run page shows its journal and links to the findings citing it');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
