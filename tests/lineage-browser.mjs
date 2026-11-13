import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
// The Lineage page: runs linked by a logged lineage block and by checkpoint paths, the details
// panel and its diffs, filters, collapsing rejected branches, keyboard movement, gestures,
// settings, and the hand-off to and from the workspace.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-lineage-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(directory);
  const origin = await listen(server);
  const metric = 'audit/primary/value';
  const config = (name, init, extra = {}, lr = 1e-6) =>
    Object.fromEntries(
      Object.entries({
        rl: {
          checkpoint: { save_dir: '/ckpt/' + name, initialize_from: init },
          algorithm: { lr },
        },
        ...extra,
      }).map(([key, value]) => [key, { value }]),
    );
  const seed = async (name, cfg, tags, values, running = false) => {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'lineage',
      name,
      displayName: name,
      config: cfg,
      tags,
      state: 'finished',
      summaryMetrics: { [metric]: values.at(-1) },
    });
    await server.db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: values.map((value, step) => JSON.stringify({ _step: step, [metric]: value })),
        },
      },
      ...(running ? {} : { complete: true }),
    });
    return run.id;
  };
  // Scenes: a list of objects with nested lists, logged in another key order by v102.
  const scenes = (canopy, extra = []) => [
    {
      name: 'forest',
      seed: 7,
      layers: [
        { label: 'canopy', cover: canopy, templates: [{ asset: 'oak', scale: [0.9, 1.3] }] },
        { label: 'shrub', cover: 0.2 },
        ...extra,
      ],
    },
  ];
  await seed(
    'v100_root',
    config('v100_root', null, { data: { scenes: scenes(0.7) } }),
    ['verdict:adopted'],
    [0.5, 0.75],
  );
  // v101 starts from a copied warm source of v100 and changes the learning rate.
  await seed(
    'v101_lr',
    config('v101_lr', '/other/host/warm_sources/v100_u00001000/update_00001000', {}, 2e-6),
    [],
    [0.6],
  );
  await seed(
    'v102_head',
    config('v102_head', null, {
      data: {
        scenes: scenes(0.6, [{ label: 'logs', cover: 0.1 }]).map(({ layers, seed, name }) => ({
          layers: layers.map(({ templates, ...layer }) =>
            templates
              ? { ...layer, templates: [{ scale: [0.9, 1.1], asset: 'oak' }] }
              : { ...layer },
          ),
          seed,
          name,
        })),
      },
      model: { head: 1024 },
      lineage: {
        parent: { run_id: 'v100_root', update: 2000 },
        relation: ['initialize_from', 'grown_head'],
        changes: { 'model.head': [512, 1024] },
        hypothesis: 'A wider head holds more boxes',
        change: 'Command head widened from 512 to 1024 units',
        result: 'Best 205/512, below its parent',
        verdict: { status: 'rejected', reason: 'Fewer holds than v100' },
        compute: {
          host: 'gpu-a',
          gpu_count: 2,
          segments: [
            {
              from_update: 2000,
              to_update: 2500,
              host: 'gpu-b',
              gpu_count: 1,
              gpu_ids: [3],
              gpu_model: 'RTX 4090 24GB',
              slot: 'gpu-b_012',
            },
            {
              from_update: 2500,
              to_update: null,
              host: 'gpu-a',
              gpu_count: 2,
              gpu_ids: null,
              gpu_model: 'RTX 4090 48GB',
              slot: null,
            },
          ],
        },
      },
    }),
    ['verdict:rejected'],
    [0.4],
  );
  // The one running run.
  await seed(
    'v103_below',
    config('v103_below', '/ckpt/v102_head/update_00003000'),
    [],
    [0.45],
    true,
  );
  await seed('lonely', config('lonely', null), [], [0.1]);
  await server.tools.execute('project_lineage_settings_update', {
    id: 'test/lineage',
    metric,
    scale: 512,
  });

  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${origin}/test/lineage/lineage`);
  const cards = page.locator('.lineage-card');
  const card = (name) => cards.filter({ hasText: name });
  await expect(cards).toHaveCount(4);
  // The toolbar is one row; its menus, counts and options open on demand.
  const toolbar = page.locator('.lineage-toolbar');
  // The controls sit in the header at every width, the search at its right end (an icon until
  // opened); on phones the buttons are icons and the header stays one row.
  const searchbox = page.getByRole('searchbox', { name: 'Filter runs by name' });
  // The header search is an icon until opened, as a reader opens it.
  const findRuns = async (text) => {
    if (!(await searchbox.isVisible()))
      await page.locator('.page-rail-search .bx--search-magnifier').click();
    await searchbox.click();
    await searchbox.fill(text);
  };
  const rightOf = async () => {
    const field = await page.locator('.page-rail-search').boundingBox(),
      filters = await toolbar.getByRole('button', { name: 'Filters' }).boundingBox();
    return field.x > filters.x + filters.width;
  };
  assert.equal(await toolbar.evaluate((item) => !!item.closest('header')), true);
  assert.equal(await rightOf(), true);
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => toolbar.evaluate((item) => !!item.closest('header'))).toBe(true);
    const header = await page.locator('header').first().boundingBox();
    assert.ok(header.height <= 56, `one header row at ${width}px: ${header.height}`);
  }
  await expect(toolbar.getByRole('button', { name: 'Filters' })).toHaveClass(/bx--btn--icon-only/);
  await page.locator('.page-rail-search button').first().click();
  await expect(searchbox).toBeFocused();
  // On phones the open search covers the bar.
  const open = await page.locator('.page-rail-search').boundingBox(),
    filtersButton = await toolbar.getByRole('button', { name: 'Filters' }).boundingBox();
  assert.ok(open.x <= filtersButton.x && open.width > 200, 'the open search covers the bar');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(toolbar.getByRole('button', { name: 'Filters' })).not.toHaveClass(
    /bx--btn--icon-only/,
  );
  const menu = async (name) => {
    await toolbar.getByRole('button', { name }).click();
    return page.getByRole('dialog');
  };
  const closeMenu = () => page.keyboard.press('Escape');
  await expect((await menu('Counts and help')).locator('li')).toContainText([
    '4 runs shown',
    '1 run without lineage hidden',
  ]);
  await closeMenu();
  await expect(card('v100')).toContainText('384/512');
  await expect(card('v100')).toContainText('best 384/512');
  await expect(card('v100').locator('[aria-label="Adopted"]')).toHaveCount(1);
  await expect(page.locator('.lineage-edges .lineage-edge')).toHaveCount(3);
  await expect(page.locator('.lineage-edges .lineage-edge.matched')).toHaveCount(2);
  // A logged change sentence labels its link, and is its whole tooltip; other links list
  // their changed keys. Neither shows the start update, which the details panel gives.
  await expect(page.locator('.lineage-edge-label', { hasText: 'lr' })).toHaveText(['lr, scenes']);
  const sentence = page.locator('.lineage-edge-label', {
    hasText: 'Command head widened from 512 to 1024 units',
  });
  await expect(sentence).toHaveText('Command head widened from 512 to 1024 units');
  await expect(sentence).toHaveAttribute('title', 'Command head widened from 512 to 1024 units');
  await expect(page.locator('.lineage-edge-label', { hasText: '@' })).toHaveCount(0);
  await expect(card('v102')).toContainText('gpu-a · 2× RTX 4090 48GB');
  checks.push(
    'Controls in the header (one row when narrow); cards show verdicts, hardware and metrics; links read as the logged change',
  );

  // The page opens at 100% on the running run, which has a rippling accent ring.
  const transform = async () =>
    (await page.locator('.lineage-canvas').getAttribute('style'))
      .match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)
      .slice(1)
      .map(Number);
  assert.equal((await transform())[2], 1);
  const running = card('v103');
  await expect(running).toHaveClass(/running/);
  await expect(running).toBeInViewport({ ratio: 1 });
  const animation = () =>
    running.evaluate((item) => getComputedStyle(item, '::after').animationName);
  assert.equal(await animation(), 'lineage-ripple');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await animation(), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push('The page opens at 100% on the running run; its ripple respects reduced motion');

  // Zoom controls float at the canvas's bottom-left, clear of the framed cards; the percentage
  // shows only away from 100% and takes the view back there.
  const zoomControls = page.getByRole('group', { name: 'Zoom' });
  const canvasBox = await page.locator('.lineage-viewport').boundingBox(),
    zoomBox = await zoomControls.boundingBox();
  assert.ok(zoomBox.x - canvasBox.x < 24 && canvasBox.y + canvasBox.height - zoomBox.y < 64);
  const level = zoomControls.getByRole('button', { name: /back to 100%/ });
  await expect(level).toHaveCount(0);
  await zoomControls.getByRole('button', { name: 'Fit all' }).click();
  const overlaps = await page.evaluate(() => {
    const controls = document.querySelector('.lineage-zoom-controls').getBoundingClientRect();
    return [...document.querySelectorAll('.lineage-card')].filter((card) => {
      const box = card.getBoundingClientRect();
      return (
        box.left < controls.right &&
        box.right > controls.left &&
        box.top < controls.bottom &&
        box.bottom > controls.top
      );
    }).length;
  });
  assert.equal(overlaps, 0, 'fitted cards stay clear of the zoom controls');
  await zoomControls.getByRole('button', { name: 'Zoom in' }).click();
  await expect(level).toHaveCount(1);
  await level.click();
  await expect.poll(async () => (await transform())[2]).toBeCloseTo(1, 5);
  await expect(level).toHaveCount(0);
  // The legend is in the Info popup, not on the canvas.
  await expect(page.locator('.lineage-viewport .lineage-legend')).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'Counts and help' }).click();
  const legend = page.getByRole('dialog').locator('.lineage-legend');
  for (const text of [
    'Logged link',
    'Matched by checkpoint path',
    'Adopted',
    'Planned run',
    'Best recipe',
  ])
    await expect(legend).toContainText(text);
  await page.keyboard.press('Escape');
  checks.push(
    'Zoom controls sit at the bottom-left (100% shown only away from it); the legend is in Info',
  );

  // Links are coloured by the status of the run they lead to: adopted by default, so the link
  // into the rejected v102 stays neutral; View chooses the statuses, saved for the project.
  const linkStatuses = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.lineage-edges .lineage-edge:not(.base)')].map((edge) =>
        edge.getAttribute('data-status'),
      ),
    );
  assert.ok(!(await linkStatuses()).includes('rejected'), 'rejected links are neutral by default');
  const view = await menu('View');
  await view.getByRole('button', { name: 'None' }).click();
  await view.getByText('Rejected', { exact: true }).click();
  await closeMenu();
  await expect.poll(linkStatuses).toContain('rejected');
  await page.reload();
  await expect(cards.first()).toBeVisible();
  await expect.poll(linkStatuses).toContain('rejected');
  await toolbar.getByRole('button', { name: 'Counts and help' }).click();
  await expect(page.getByRole('dialog').locator('.lineage-legend')).toContainText(
    'Link into a run: Rejected',
  );
  await page.keyboard.press('Escape');
  const viewAgain = await menu('View');
  await viewAgain.getByRole('button', { name: 'None' }).click();
  await viewAgain.getByText('Adopted', { exact: true }).click();
  await closeMenu();
  checks.push('Links take the colour of their run’s status, adopted by default, chosen under View');

  // Cards carry each run's workspace colour.
  const swatch = (name) =>
    card(name)
      .locator('.lineage-swatch')
      .evaluate((item) => getComputedStyle(item).backgroundColor);
  const lineageColors = { v100: await swatch('v100'), v101: await swatch('v101') };
  assert.notEqual(lineageColors.v100, lineageColors.v101);

  // Ctrl+wheel (and a touchpad pinch, which browsers send the same way) zooms at the
  // pointer; a plain wheel or two-finger scroll pans; two fingers on a touch screen pinch.
  const [, , zoomBefore] = await transform();
  await page.mouse.move(200, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await transform())[2]).toBeGreaterThan(zoomBefore);
  const [, yBefore] = await transform();
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await transform())[1]).toBeCloseTo(yBefore - 120);
  const touch = await context.newCDPSession(page);
  const fingers = (spread) => [
    { x: 600 - spread, y: 500, id: 1 },
    { x: 600 + spread, y: 500, id: 2 },
  ];
  const [, , pinchBefore] = await transform();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(100) });
  for (const spread of [80, 60, 40])
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: fingers(spread),
    });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await transform())[2]).toBeCloseTo(pinchBefore * 0.4, 1);
  checks.push('Wheel and touchpad scrolling pan; Ctrl+wheel and touch pinches zoom');

  // Arranged by start update, cards sit left to right in the order their runs started.
  const left = async (name) => parseFloat(await card(name).evaluate((item) => item.style.left));
  await (await menu('View')).getByLabel('Arrange by').selectOption('update');
  await closeMenu();
  await expect.poll(async () => (await left('v101')) < (await left('v102'))).toBe(true);
  assert.ok((await left('v100')) < (await left('v101')));
  assert.ok((await left('v102')) < (await left('v103')));
  await (await menu('View')).getByLabel('Arrange by').selectOption('depth');
  await closeMenu();
  await expect.poll(async () => (await left('v101')) === (await left('v102'))).toBe(true);
  checks.push('Cards can be arranged by start update and back by lineage depth');

  await card('v102').click();
  const details = page.locator('.lineage-details');
  const parentDiff = details.locator('section', { hasText: 'Config changes from parent' });
  await expect(details.locator('h2')).toHaveText('v102_head');
  await expect(details.locator('.lineage-story dt')).toHaveText([
    'What changed',
    'Hypothesis',
    'Result',
    'Verdict',
  ]);
  for (const text of [
    'Command head widened from 512 to 1024 units',
    'A wider head holds more boxes',
    'Best 205/512, below its parent',
    'Fewer holds than v100',
  ])
    await expect(details.locator('.lineage-story')).toContainText(text);
  await expect(details).toContainText('Initialized from update 2,000 · logged by the run');
  await expect(details.locator('.lineage-traits')).toHaveText('grown_head');
  await expect(details).toContainText('Updates 2,000–2,500');
  await expect(details).toContainText('gpu-b · gpu-b_012');
  await expect(details).toContainText('1× RTX 4090 24GB (3)');
  // Config changes read as word diffs under their key, its path muted.
  const diffKeys = parentDiff.locator('.config-diff-key');
  await expect(diffKeys).toHaveText(['data.scenes', 'model.head']);
  await expect(diffKeys.nth(1).locator('.config-diff-path')).toHaveText('model.');
  await expect(parentDiff.locator('.config-diff-row').nth(1)).toContainText('Not set');
  // A list of objects folds under a count; opened, only the changed fields show, matched by
  // name or label whatever their order, each with its word diff.
  const sceneDiff = parentDiff.locator('.config-diff-row', { hasText: 'scenes' });
  await expect(sceneDiff.locator('summary')).toHaveText('1 entry changed · 3 fields');
  await sceneDiff.locator('summary').click();
  await expect(sceneDiff.locator('.config-diff-subpath')).toHaveText([
    '[forest].layers[canopy].cover',
    '[forest].layers[canopy].templates[oak].scale',
    '[forest].layers[logs]',
  ]);
  await expect(sceneDiff.locator('.config-diff-nested .diff-removed').first()).toHaveText('0.7');
  await parentDiff.getByText('Show 1 ignored key').click();
  await expect(diffKeys).toHaveText(['data.scenes', 'model.head', 'rl.checkpoint.save_dir']);
  const pathRow = parentDiff.locator('.config-diff-row', { hasText: 'save_dir' });
  await expect(pathRow.locator('.diff-removed')).toHaveText(['v100_root']);
  await expect(pathRow.locator('.diff-added')).toHaveText(['v102_head']);
  await expect(pathRow.locator('.diff-same').first()).toContainText('/ckpt/');
  // The header stays in view while the panel scrolls.
  const header = details.locator('.lineage-details-header');
  const top = (await header.boundingBox()).y;
  await details.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect.poll(async () => (await header.boundingBox()).y).toBe(top);
  await expect(details.getByRole('link', { name: 'Open run' })).toBeInViewport();
  await details.evaluate((element) => element.scrollTo(0, 0));
  assert.match(page.url(), /\?run=test%2Flineage%2Fv102_head&select=v102_head$/);
  checks.push(
    'The details panel shows change, hypothesis, result, verdict, relation and a word-level parent diff under a pinned header',
  );

  // Keyboard: Left moves to the parent card, Escape closes the panel and keeps focus.
  await card('v102').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(card('v100')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(page.locator('.lineage-card:focus')).toHaveCount(1);
  checks.push('Arrow keys follow links and Escape closes the details panel');

  await (await menu('Filters')).getByText('Collapse rejected branches').click();
  await closeMenu();
  await expect(cards).toHaveCount(3);
  await expect(card('v102')).toContainText('1 run collapsed');
  await expect(toolbar.getByRole('button', { name: 'Filters (1)' })).toBeVisible();
  await (await menu('Filters (1)')).getByText('Collapse rejected branches').click();
  await closeMenu();
  await findRuns('v103');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.lineage-card.context')).toHaveCount(2);
  // A partial name suggests runs, best matches first; a searched-for run shows even inside a
  // collapsed rejected branch, and choosing a suggestion opens it.
  await (await menu('Filters')).getByText('Collapse rejected branches').click();
  await closeMenu();
  await findRuns('v10');
  const suggestions = page.getByRole('listbox', { name: 'Matching runs' }).getByRole('option');
  await expect(suggestions).toHaveCount(4);
  await findRuns('v103');
  await expect(suggestions).toHaveText([/v103_below/]);
  await expect(card('v103')).toBeVisible();
  await searchbox.press('Enter');
  await expect(page.locator('.lineage-details h2')).toHaveText('v103_below');
  await findRuns('below');
  await expect(suggestions).toHaveText([/v103_below/]);
  await findRuns('zzz');
  await expect(page.getByRole('listbox', { name: 'Matching runs' })).toContainText(
    'No run matches.',
  );
  await findRuns('');
  await (await menu('Filters (1)')).getByText('Collapse rejected branches').click();
  await closeMenu();
  await page.keyboard.press('Escape');
  await (await menu('Filters')).getByText('Show runs without lineage').click();
  await closeMenu();
  await expect(cards).toHaveCount(5);
  checks.push('Filters keep connecting ancestors; rejected branches and unlinked runs toggle');

  // A reload keeps the selected run; Open run reaches the run page and Back returns.
  await card('v101').click();
  await page.reload();
  await expect(details.locator('h2')).toHaveText('v101_lr');
  await expect(details).toContainText('Initialized from update 1,000 · matched by checkpoint path');
  await details.getByRole('link', { name: 'Open run' }).click();
  await expect(page).toHaveURL(/\/test\/lineage\/runs\/v101_lr/);
  await page.getByRole('button', { name: 'Back to lineage' }).click();
  await expect(details.locator('h2')).toHaveText('v101_lr');
  checks.push('Selection survives reload and the run page returns to the lineage');

  // Shift-click picks runs; the root-to-run path joins them; the workspace shows exactly them.
  await card('v102').click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: 'Compare 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Select path from root' }).click();
  await expect(page.getByRole('button', { name: 'Compare 3' })).toBeVisible();
  await expect(page.locator('.lineage-card.picked')).toHaveCount(3);
  assert.deepEqual(new URL(page.url()).searchParams.get('select').split(',').sort(), [
    'v100_root',
    'v101_lr',
    'v102_head',
  ]);
  await page.getByRole('button', { name: 'Compare 3' }).click();
  await expect(page).toHaveURL(/\/test\/lineage\/workspace/);
  await expect(page.getByText('Showing 3 runs from the lineage')).toBeVisible();
  const viewId = new URL(page.url()).searchParams.get('view');
  await expect
    .poll(async () => (await server.db.call('view', viewId))?.body.solo.slice().sort())
    .toEqual(['test/lineage/v100_root', 'test/lineage/v101_lr', 'test/lineage/v102_head']);
  // The same colour in the workspace's run list as on the lineage card.
  const listColor = (id) =>
    page
      .locator(`[data-color-id="${id}"] .run-color`)
      .evaluate((item) => getComputedStyle(item).backgroundColor);
  assert.equal(await listColor('test/lineage/v100_root'), lineageColors.v100);
  assert.equal(await listColor('test/lineage/v101_lr'), lineageColors.v101);
  checks.push('Chosen runs (clicks, path) open soloed in the workspace with the same colours');

  // A panel's title and legend sit as far in from its edge on the Lineage page as the legend
  // does in the workspace: the inset belongs to the panel, not to the page around it. (Touch
  // screens show the workspace's reorder grip in front of its titles, so titles are compared
  // with legends.)
  const inset = (chart) =>
    chart.evaluate((element) => {
      const box = element.getBoundingClientRect(),
        range = document.createRange();
      range.selectNodeContents(element.querySelector('.chart-title'));
      const legend = element.querySelector('.chart-legend-item').getBoundingClientRect();
      return {
        title: Math.round(range.getBoundingClientRect().left - box.left),
        legend: Math.round(legend.left - box.left),
      };
    });
  const panel = page.locator('.chart', { has: page.locator('.chart-legend-item') }).first();
  await expect(panel).toBeVisible();
  const inWorkspace = await inset(panel);
  assert.ok(inWorkspace.legend >= 8, 'legend inset in the workspace: ' + inWorkspace.legend);
  await page.goBack();
  await expect(details.locator('.chart .chart-legend-item').first()).toBeVisible();
  assert.deepEqual(await inset(details.locator('.chart').first()), {
    title: inWorkspace.legend,
    legend: inWorkspace.legend,
  });
  await page.goForward();
  await expect(page).toHaveURL(/\/test\/lineage\/workspace/);
  checks.push('Panels keep the title and legend inset of the workspace on the Lineage page');

  // Back from the workspace: the runs table and a run page each open the lineage on runs.
  await page.goto(`${origin}/test/lineage/runs`);
  for (const name of ['v101_lr', 'v103_below'])
    await page
      .getByRole('row', { name: new RegExp(name) })
      .getByRole('checkbox')
      .check({ force: true });
  await page.getByRole('button', { name: 'Show in lineage' }).click();
  await expect(page).toHaveURL(/\/test\/lineage\/lineage\?run=/);
  await expect(page.locator('.lineage-card.picked')).toHaveCount(2);
  await expect(details.locator('h2')).toHaveText(/v101_lr|v103_below/);
  await page.goto(`${origin}/test/lineage/runs/v102_head`);
  await page.getByRole('link', { name: 'Show in lineage' }).click();
  await expect(details.locator('h2')).toHaveText('v102_head');
  checks.push('Show in lineage from the runs table and a run page selects those runs');

  // A drag on empty canvas draws a selection box; Ctrl adds to the selection; Shift pans.
  await page.getByRole('button', { name: 'Clear selection' }).click();
  const box = async (name) => card(name).boundingBox();
  const drag = async (from, to, modifier) => {
    await page.mouse.move(from.x, from.y);
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    if (modifier) await page.keyboard.up(modifier);
  };
  const around = async (names) => {
    const boxes = await Promise.all(names.map(box)),
      frame = await page.locator('.lineage-viewport').boundingBox(),
      clamp = (point) => ({
        x: Math.min(Math.max(point.x, frame.x + 4), frame.x + frame.width - 4),
        y: Math.min(Math.max(point.y, frame.y + 4), frame.y + frame.height - 4),
      });
    return [
      {
        x: Math.min(...boxes.map((b) => b.x)) - 10,
        y: Math.min(...boxes.map((b) => b.y)) - 10,
      },
      {
        x: Math.max(...boxes.map((b) => b.x + b.width)) + 10,
        y: Math.max(...boxes.map((b) => b.y + b.height)) + 10,
      },
    ].map(clamp);
  };
  await drag(...(await around(['v101', 'v102'])));
  await expect(page.locator('.lineage-card.picked')).toHaveCount(2);
  // Dragging across cards selects them, not their text.
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
  await drag(...(await around(['v100'])), 'Control');
  await expect(page.locator('.lineage-card.picked')).toHaveCount(3);
  // Without Ctrl a new box replaces the selection.
  await drag(...(await around(['v100'])));
  await expect(page.locator('.lineage-card.picked')).toHaveCount(1);
  // While the box is dragged, covered cards show as chosen and leave when it no longer covers
  // them; nothing is committed until release, and Ctrl keeps the existing selection.
  const [from, to] = await around(['v101', 'v102']),
    [, justV101] = await around(['v101']);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await expect(page.locator('.lineage-card.picked')).toHaveCount(2);
  await expect(card('v100')).not.toHaveClass(/picked/);
  await page.mouse.move(justV101.x, justV101.y, { steps: 5 });
  await expect(page.locator('.lineage-card.picked')).toHaveCount(1);
  await expect(card('v101')).toHaveClass(/picked/);
  assert.equal(new URL(page.url()).searchParams.get('select'), 'v100_root');
  await page.mouse.up();
  await expect(page).toHaveURL(/select=v101_lr/);
  await page.keyboard.down('Control');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await expect(page.locator('.lineage-card.picked')).toHaveCount(2);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await drag(...(await around(['v100'])));
  await expect(page.locator('.lineage-card.picked')).toHaveCount(1);
  // Holding Shift shows a grab cursor, and Shift+drag pans without selecting.
  const viewport = page.locator('.lineage-viewport');
  await page.keyboard.down('Shift');
  await expect(viewport).toHaveClass(/pan-ready/);
  await page.keyboard.up('Shift');
  await expect(viewport).not.toHaveClass(/pan-ready/);
  const [startX, startY] = await transform();
  const empty = await around(['v100']);
  await drag(empty[0], { x: empty[0].x + 60, y: empty[0].y + 40 }, 'Shift');
  await expect
    .poll(async () => (await transform()).slice(0, 2))
    .toEqual([startX + 60, startY + 40]);
  await expect(page.locator('.lineage-card.picked')).toHaveCount(1);
  checks.push(
    'Dragging draws a selection box that selects live (Ctrl adds); Shift+drag pans with a grab cursor',
  );

  // A plain click on empty canvas closes the run panel and clears the selection; a Shift click
  // (the start of a pan) does not.
  await card('v100').click();
  await expect(details.locator('h2')).toHaveText('v100_root');
  await drag(...(await around(['v101'])), 'Control');
  await expect(page.locator('.lineage-card.picked')).toHaveCount(2);
  const blank = (await around(['v100']))[0];
  await page.keyboard.down('Shift');
  await page.mouse.click(blank.x, blank.y);
  await page.keyboard.up('Shift');
  await expect(details.locator('h2')).toHaveText('v100_root');
  await page.mouse.click(blank.x, blank.y);
  await expect(details).toBeHidden();
  await expect(page.locator('.lineage-card.picked')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&](run|select)=/);
  checks.push('A click on empty canvas deselects and closes the run panel');

  // Hosts: filter to one (its ancestors stay as context) and colour cards by host.
  await (await menu('Filters')).getByLabel('Host').selectOption('gpu-a');
  await closeMenu();
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.lineage-card.context')).toHaveCount(1);
  await (await menu('View')).getByLabel('Color by').selectOption('host');
  await closeMenu();
  await expect(card('v102').locator('.lineage-swatch')).toHaveCount(1);
  await expect(card('v100').locator('.lineage-swatch')).toHaveCount(0);
  await (await menu('Filters (2)')).getByLabel('Host').selectOption('');
  await closeMenu();
  await (await menu('View')).getByLabel('Color by').selectOption('run');
  await closeMenu();
  checks.push('Runs can be filtered and coloured by the host they trained on');

  await page.getByRole('button', { name: 'Lineage settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lineage settings' });
  await dialog.getByLabel('Display scale').fill('');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(card('v100')).toContainText('0.75');
  const stored = await server.tools.execute('project_lineage_settings_get', { id: 'test/lineage' });
  assert.equal(stored.scale, null);
  checks.push('Lineage settings save and redraw the cards');

  // On phones the run panel takes the page (the run list's drawer styles leave it alone).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/test/lineage/lineage?run=test%2Flineage%2Fv102_head`);
  await expect(page.locator('.lineage-details h2')).toBeInViewport();
  await expect(page.locator('.lineage-details h2')).toHaveText('v102_head');
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('On phones the run panel fills the page');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
