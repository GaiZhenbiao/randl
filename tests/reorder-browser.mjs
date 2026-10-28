import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
async function pressSectionButton(scope, name) {
  const button = scope.getByRole('button', { name, exact: true });
  await button.locator('xpath=ancestor::div[contains(@class,"section-heading")]').hover();
  await button.click();
}

const expect = baseExpect.configure({ timeout: 10000 }),
  directory = await mkdtemp(join(tmpdir(), 'randl-reorder-'));
let server, browser;
const checks = [];
try {
  server = await createServer(directory);
  const url = await listen(server);
  const run = await server.db.call('upsert', {
    entity: 'test',
    project: 'reorder',
    name: 'fixture',
    displayName: 'Fixture',
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [JSON.stringify({ _step: 0, loss: 1 }), JSON.stringify({ _step: 1, loss: 2 })],
      },
    },
    complete: true,
    exitcode: 0,
  });
  const sections = Array.from({ length: 3 }, (_, i) => ({ id: 's' + i, name: 'Section ' + i }));
  const panels = Array.from({ length: 9 }, (_, i) => ({
    id: 'p' + i,
    plugin: 'line',
    metric: 'loss',
    title: 'Panel ' + i,
    section: 's' + Math.floor(i / 3),
  }));
  let view = await server.tools.execute('view_create', {
    project: 'test/reorder',
    name: 'Reorder fixture',
    body: {
      generation: 'manual',
      panels,
      sections,
      sectionLayouts: Object.fromEntries(
        sections.map((s) => [s.id, { width: 360, height: 220, rows: 1 }]),
      ),
      visible: [run.id],
      solo: [],
    },
  });
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url + '/test/reorder/workspace?view=' + view.id);
  await expect(page.locator('canvas').first()).toBeVisible();
  assert.ok(
    await page
      .locator('.chart-title')
      .first()
      .evaluate((n) => {
        const range = document.createRange();
        range.selectNodeContents(n);
        return (
          range.getBoundingClientRect().left -
            n.closest('.chart-header').getBoundingClientRect().left >=
          8
        );
      }),
    'Resting panel title has readable inset inside the draggable area',
  );
  for (const [header, grip] of [
    ['.chart-header', '.panel-drag-handle'],
    ['.section-heading', '.section-toggle'],
  ]) {
    await page.locator(header).first().locator(grip).locator('..').hover();
    const headerBox = await page.locator(header).first().boundingBox();
    const gripBox = await page.locator(header).first().locator(grip).boundingBox();
    assert.equal(gripBox.x, headerBox.x, 'No blank inset before the drag grip');
  }
  const sectionOrder = () =>
    page.locator('[data-section-id]').evaluateAll((nodes) => nodes.map((n) => n.dataset.sectionId));
  const panelOrder = (id) =>
    page
      .locator('[data-section-id="' + id + '"] .chart')
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.panelId));
  const saved = () => server.db.call('view', view.id);
  const geometry = () =>
    page.locator('.chart').evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return [node.dataset.panelId, r.x, r.y, r.width, r.height];
      }),
    );
  async function start(selector) {
    const handle = page.locator(selector);
    await handle.locator('..').hover();
    await expect.poll(async () => (await handle.boundingBox())?.width || 0).toBeGreaterThan(20);
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
  async function move(selector, rx = 0.8, ry = 0.7) {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + box.width * rx, box.y + box.height * ry, { steps: 12 });
    await page.waitForTimeout(150);
  }
  for (const delay of [0, 35, 350]) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(120);
    const b = await page.locator('[data-panel-id="p0"] .chart-title').boundingBox();
    await page.mouse.move(b.x + 12, b.y + b.height / 2);
    if (delay) await page.waitForTimeout(delay);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);
    await expect(page.locator('.panel-editor-modal.is-visible')).toHaveCount(0);
    await page.evaluate(() => document.activeElement?.blur());
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(120);
  const toggle = page.locator('[data-section-id="s0"] .section-toggle');
  const chevron = await toggle.boundingBox();
  await page.mouse.move(chevron.x + 8, chevron.y + chevron.height / 2);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.up();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-section-id="s0"] .section-title').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => document.activeElement?.blur());
  checks.push('titles are not actions; the collapse chevron still works during the grip reveal');
  const panel = page.locator('[data-panel-id="p0"]'),
    grip = panel.locator('.panel-drag-handle'),
    title = panel.locator('.chart-title');
  await page.mouse.move(0, 0);
  await expect.poll(() => grip.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  const restingTitle = await title.boundingBox();
  await panel.locator('canvas').hover();
  await expect.poll(() => grip.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  await panel.locator('.chart-tools button').first().hover();
  await expect.poll(() => grip.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  await title.hover();
  await expect.poll(() => grip.evaluate((el) => el.getBoundingClientRect().width)).toBe(24);
  const gripBox = await grip.boundingBox(),
    titleBox = await title.boundingBox();
  assert.equal(titleBox.x - restingTitle.x, 24, 'Grip reveal shifts the title');
  assert.ok(
    Math.abs(gripBox.x + gripBox.width - titleBox.x) < 1,
    'No gap between grip and draggable title',
  );
  assert.ok(Math.abs(gripBox.y + gripBox.height / 2 - titleBox.y - titleBox.height / 2) < 1);
  await page.mouse.move(0, 0);
  await expect.poll(() => grip.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  checks.push('panel grip reveals only over its title, shifts the title and leaves no drag gap');
  const section = page.locator('[data-section-id="s0"]'),
    sectionGrip = section.locator('.section-drag-handle'),
    sectionTitle = section.locator('.section-title');
  await sectionTitle.hover();
  await expect.poll(() => sectionGrip.evaluate((el) => el.getBoundingClientRect().width)).toBe(24);
  const sg = await sectionGrip.boundingBox(),
    st = await sectionTitle.boundingBox();
  assert.ok(
    Math.abs(sg.y + sg.height / 2 - st.y - st.height / 2) < 1,
    'Section grip stays on the title line',
  );
  const sc = await section.locator('.section-toggle').boundingBox();
  assert.ok(Math.abs(sc.x + sc.width - sg.x) < 1, 'No gap between chevron and section grip');
  assert.ok(Math.abs(sg.x + sg.width - st.x) < 1, 'No gap between section grip and title');
  checks.push('section grip shares the title line and continuous drag surface');
  await sectionGrip.focus();
  for (const [key, order] of [
    ['ArrowDown', ['s1', 's0', 's2']],
    ['ArrowDown', ['s1', 's2', 's0']],
    ['ArrowUp', ['s1', 's0', 's2']],
    ['ArrowUp', ['s0', 's1', 's2']],
  ]) {
    await page.keyboard.press(key);
    await expect.poll(sectionOrder).toEqual(order);
    await expect(sectionGrip).toBeFocused();
  }
  await sectionGrip.evaluate((el) => el.blur());
  checks.push('section keyboard reordering retains focus for repeated movement');
  for (const selector of [
    '[data-panel-id="p0"] .chart-title',
    '[data-section-id="s0"] .section-title',
  ]) {
    await start(selector);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.panel-editor-modal.is-visible')).toHaveCount(0);
    await expect(section.locator('.section-toggle')).toHaveAttribute('aria-expanded', 'true');
  }
  checks.push('Escape before crossing the drag threshold cancels the title click');

  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await grip.focus();
  await expect.poll(() => grip.evaluate((el) => el.getBoundingClientRect().width)).toBe(24);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await saved()).body.panels.slice(0, 2).map((p) => p.id))
    .toEqual(['p1', 'p0']);
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await saved()).body.panels.slice(0, 2).map((p) => p.id))
    .toEqual(['p0', 'p1']);
  await grip.evaluate((el) => el.blur());
  checks.push('keyboard focus reveals the grip and arrow keys reorder');
  await start('[data-panel-id="p0"] .panel-drag-handle');
  await move('[data-panel-id="p1"]');
  const previewGeometry = await geometry(),
    preview = await panelOrder('s0');
  assert.deepEqual(preview.slice(0, 2), ['p1', 'p0']);
  assert.deepEqual(
    (await saved()).body.panels.map((p) => p.id),
    panels.map((p) => p.id),
    'Preview must not save before drop',
  );
  await page.mouse.up();
  assert.deepEqual(
    await geometry(),
    previewGeometry,
    'Drop preserves live panel positions and dimensions',
  );
  await expect
    .poll(async () => (await saved()).body.panels.slice(0, 2).map((p) => p.id))
    .toEqual(['p1', 'p0']);
  assert.deepEqual(await panelOrder('s0'), preview);
  checks.push('panel drop saves the exact live order');
  const before = await saved();
  await start('[data-panel-id="p1"] .panel-drag-handle');
  await move('[data-panel-id="p0"]');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await panelOrder('s0'), preview);
  assert.equal((await saved()).version, before.version);
  checks.push('Escape restores the starting order without a write');
  await start('[data-section-id="s0"] .section-title');
  const target = await page.locator('[data-section-id="s1"]').boundingBox();
  await page.mouse.move(target.x + 60, target.y + 90, { steps: 15 });
  await page.waitForTimeout(150);
  const sectionPreview = await sectionOrder();
  assert.deepEqual(sectionPreview, ['s1', 's0', 's2']);
  assert.deepEqual(
    (await saved()).body.sections.map((s) => s.id),
    ['s0', 's1', 's2'],
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await saved()).body.sections.map((s) => s.id))
    .toEqual(sectionPreview);
  checks.push('section drop saves the exact live order');
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible();
  assert.deepEqual(await sectionOrder(), sectionPreview);
  assert.deepEqual(
    (await saved()).body.panels.slice(0, 2).map((p) => p.id),
    ['p1', 'p0'],
  );
  checks.push('panel and section order survive reload');
  await start('[data-panel-id="p1"] .chart-title');
  await move('[data-panel-id="p3"]');
  const crossPreview = await panelOrder('s1');
  assert.ok(crossPreview.includes('p1'));
  await page.mouse.up();
  await expect
    .poll(async () => (await saved()).body.panels.find((p) => p.id === 'p1').section)
    .toBe('s1');
  assert.deepEqual(await panelOrder('s1'), crossPreview);
  checks.push('cross-section drop preserves preview membership and order');
  const collapsed = await saved();
  collapsed.body.sections.find((s) => s.id === 's0').collapsed = true;
  const update = await fetch(url + '/api/views/' + view.id, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: collapsed.name,
      project: collapsed.project,
      body: collapsed.body,
      version: collapsed.version,
    }),
  });
  assert.ok(update.ok);
  await page.reload();
  await expect(page.locator('[data-section-id="s0"] .section-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await start('[data-section-id="s0"] .section-title');
  const shortBox = await page.locator('[data-section-id="s0"]').boundingBox(),
    tallBox = await page.locator('[data-section-id="s2"]').boundingBox();
  let lastIndex = (await sectionOrder()).indexOf('s0');
  for (let y = shortBox.y + 12; y < tallBox.y + tallBox.height - 20; y += 5) {
    await page.mouse.move(shortBox.x + 70, y);
    const nextIndex = (await sectionOrder()).indexOf('s0');
    assert.ok(
      nextIndex >= lastIndex,
      'A downward drag must not oscillate backwards across unequal section heights',
    );
    lastIndex = nextIndex;
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  checks.push('collapsed section drag remains stable across taller neighbours');
  const touch = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await touch.goto(url + '/test/reorder/workspace?view=' + view.id);
  await expect(touch.locator('.panel-drag-handle').first()).toBeVisible();
  for (const selector of ['.panel-drag-handle', '.section-drag-handle']) {
    await expect
      .poll(async () => {
        const bounds = await touch.locator(selector).first().boundingBox();
        return { width: Math.round(bounds.width), height: Math.round(bounds.height) };
      })
      .toEqual({ width: 40, height: 40 });
  }
  const touchGrip = await touch.locator('.section-drag-handle').first().boundingBox(),
    touchTitle = await touch.locator('.section-title').first().boundingBox();
  assert.ok(
    Math.abs(touchGrip.y + touchGrip.height / 2 - touchTitle.y - touchTitle.height / 2) < 1,
    'Mobile section grip stays beside its title',
  );

  const cdp = await touch.context().newCDPSession(touch);
  async function swipe(selector) {
    await touch.locator('main').evaluate((node) => (node.scrollTop = 0));
    const b = await touch.locator(selector).first().boundingBox(),
      x = b.x + b.width / 2,
      y = b.y + b.height / 2;
    const version = (await saved()).version;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - i * 12, id: 1 }],
      });
      await touch.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect
      .poll(() => touch.locator('main').evaluate((node) => node.scrollTop))
      .toBeGreaterThan(50);
    assert.equal(
      (await saved()).version,
      version,
      'Swiping a title scrolls without saving a reorder',
    );
    await expect(touch.locator('.reorder-preview')).toHaveCount(0);
  }
  await swipe('.chart-title');
  await swipe('.section-title');
  await touch.locator('main').evaluate((node) => (node.scrollTop = 0));
  const movingTouchId = await touch.locator('.chart').first().getAttribute('data-panel-id');
  const g = await touch.locator('.panel-drag-handle').first().boundingBox(),
    targetCard = await touch.locator('.chart').nth(1).boundingBox();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: g.x + 20, y: g.y + 20, id: 1 }],
  });
  for (let i = 1; i <= 20; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: g.x + 20 + ((targetCard.x + 150 - g.x - 20) * i) / 20,
          y: g.y + 20 + ((targetCard.y + 120 - g.y - 20) * i) / 20,
          id: 1,
        },
      ],
    });
    await touch.waitForTimeout(16);
  }
  await expect(touch.locator('.reorder-preview')).toBeVisible();
  await expect(touch.locator('.plot-inspector:visible')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.waitForTimeout(1100);
  await expect(touch.locator('.plot-inspector:visible')).toHaveCount(0);
  checks.push('touch titles scroll without edits; grip drags suppress chart inspection');
  const movedTouchPanel = touch.locator('[data-panel-id="' + movingTouchId + '"]');
  await movedTouchPanel.getByRole('button', { name: 'Panel settings', exact: true }).tap();
  const touchEditor = touch.getByRole('dialog', { name: 'Panel settings', exact: true });
  await expect(touchEditor).toBeVisible();
  await touchEditor.getByRole('button', { name: 'Cancel', exact: true }).tap();
  assert.equal((await movedTouchPanel.locator('.panel-drag-handle').boundingBox()).width, 40);
  await touch.locator('main').evaluate((node) => (node.scrollTop = 0));
  const movingSection = touch.locator('[data-section-id]').first(),
    movingSectionId = await movingSection.getAttribute('data-section-id');
  const sgTouch = await movingSection.locator('.section-drag-handle').boundingBox(),
    targetSection = await touch.locator('[data-section-id]').nth(1).boundingBox();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: sgTouch.x + 20, y: sgTouch.y + 20, id: 1 }],
  });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: sgTouch.x + 20,
          y: sgTouch.y + 20 + ((targetSection.y + 25 - sgTouch.y - 20) * i) / 12,
          id: 1,
        },
      ],
    });
    await touch.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(touch.locator('.reorder-preview')).toHaveCount(0);
  await touch.waitForTimeout(500);
  const movedSectionTitle = touch.locator(
      '[data-section-id="' + movingSectionId + '"] .section-toggle',
    ),
    expandedBeforeTap = await movedSectionTitle.getAttribute('aria-expanded');
  await movedSectionTitle.tap();
  await expect(movedSectionTitle).toHaveAttribute(
    'aria-expanded',
    expandedBeforeTap === 'true' ? 'false' : 'true',
  );
  checks.push('first tap after touch reorder works and focused grips keep their touch size');

  await touch.close();
  checks.push('touch grips stay visible and section titles remain inline');
  const keyboardView = await saved();
  keyboardView.body.sections.find((section) => section.id === 's0').collapsed = false;
  keyboardView.body.sectionLayouts.s0.rows = 2;
  for (let i = 0; i < 6; i++)
    keyboardView.body.panels.push({
      id: 'keyboard' + i,
      plugin: 'line',
      metric: 'loss',
      title: 'Keyboard ' + i,
      section: 's0',
    });
  const keyboardUpdate = await fetch(url + '/api/views/' + view.id, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: keyboardView.name,
      project: keyboardView.project,
      body: keyboardView.body,
      version: keyboardView.version,
    }),
  });
  assert.ok(keyboardUpdate.ok);
  await page.reload();
  const keyboardSection = page.locator('[data-section-id="s0"]');
  await expect(keyboardSection.locator('.panel-drag-handle').first()).toBeAttached();
  const firstId = await keyboardSection.locator('.chart').first().getAttribute('data-panel-id');
  const firstGrip = page.locator('[data-panel-id="' + firstId + '"] .panel-drag-handle');
  const columns = await keyboardSection
    .locator('.charts')
    .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  assert.ok(columns > 1);
  await firstGrip.focus();
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () =>
      (await saved()).body.panels
        .filter((p) => p.section === 's0')
        .findIndex((p) => p.id === firstId),
    )
    .toBe(columns);
  await expect(firstGrip).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () =>
      (await saved()).body.panels
        .filter((p) => p.section === 's0')
        .findIndex((p) => p.id === firstId),
    )
    .toBe(0);
  const boundaryVersion = (await saved()).version;
  await page.keyboard.press('ArrowUp');
  assert.equal((await saved()).version, boundaryVersion);
  await expect(page.getByRole('status').filter({ hasText: /position 1 of/ })).toContainText(
    'Section 0',
  );
  checks.push('vertical panel keys follow grid rows; boundaries announce position without saving');
  const s0Order = async () =>
    (await saved()).body.panels.filter((p) => p.section === 's0').map((p) => p.id);
  const s0Before = await s0Order();
  const firstPanel = page.locator('[data-panel-id="' + firstId + '"]');
  await firstPanel.getByRole('button', { name: 'Panel actions', exact: true }).click();
  const panelItem = (name) => page.getByRole('menuitem', { name, exact: true });
  await expect(panelItem('Move to first')).toBeDisabled();
  await expect(panelItem('Move earlier')).toBeDisabled();
  await expect(panelItem('Move later')).toBeEnabled();
  await expect(panelItem('Move to last')).toBeEnabled();
  await panelItem('Move to last').press('Enter');
  await expect.poll(s0Order).toEqual([...s0Before.slice(1), firstId]);
  await expect(firstGrip).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: 'position ' + s0Before.length + ' of' }),
  ).toContainText('Section 0');
  await firstPanel.getByRole('button', { name: 'Panel actions', exact: true }).click();
  await expect(panelItem('Move to first')).toBeEnabled();
  await expect(panelItem('Move later')).toBeDisabled();
  await expect(panelItem('Move to last')).toBeDisabled();
  await panelItem('Move to first').click();
  await expect.poll(s0Order).toEqual(s0Before);
  await expect(firstPanel.locator('.chart-title')).toBeFocused();
  checks.push(
    'panel menu moves to first and last, disables boundary moves and keeps focus on the panel',
  );
  const fullPanel = page.locator('[data-panel-id="' + firstId + '"]');
  await fullPanel.getByRole('button', { name: 'Expand panel', exact: true }).click();
  await expect(fullPanel.locator('.panel-drag-handle')).toHaveCount(0);
  await fullPanel.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  checks.push('full-screen panels omit reorder controls');
  const filteredView = await saved();
  filteredView.body.panels = panels.map((panel, index) => ({
    ...panel,
    title: ([0, 2, 6, 8].includes(index) ? 'alpha ' : 'beta ') + index,
  }));
  filteredView.body.sections = sections.map((section) =>
    section.id === 's1' ? { ...section, name: 'Hidden section', collapsed: true } : section,
  );
  const retainedSections = structuredClone(filteredView.body.sections);
  const filteredUpdate = await fetch(url + '/api/views/' + view.id, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: filteredView.name,
      project: filteredView.project,
      body: filteredView.body,
      version: filteredView.version,
    }),
  });
  assert.ok(filteredUpdate.ok);
  await page.reload();
  const search = page.getByRole('searchbox', { name: 'Search panels', exact: true });
  await search.fill('alpha');
  await expect.poll(sectionOrder).toEqual(['s0', 's2']);
  await start('[data-panel-id="p0"] .chart-title');
  await move('[data-panel-id="p2"]');
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await saved()).body.panels
        .filter((panel) => panel.section === 's0' && panel.title.startsWith('alpha'))
        .map((panel) => panel.id),
    )
    .toEqual(['p2', 'p0']);
  assert.deepEqual((await saved()).body.sections, retainedSections);
  await start('[data-section-id="s0"] .section-title');
  await move('[data-section-id="s2"]', 0.4, 0.4);
  await page.mouse.up();
  await expect.poll(sectionOrder).toEqual(['s2', 's0']);
  await expect
    .poll(async () => (await saved()).body.sections.map((section) => section.id))
    .toEqual(['s2', 's1', 's0']);
  assert.deepEqual(
    (await saved()).body.sections.find((section) => section.id === 's1'),
    retainedSections[1],
  );
  await page.locator('[data-section-id="s2"] .section-drag-handle').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(sectionOrder).toEqual(['s0', 's2']);
  await expect
    .poll(async () => (await saved()).body.sections.map((section) => section.id))
    .toEqual(['s0', 's1', 's2']);
  await pressSectionButton(page.locator('[data-section-id="s0"]'), 'Section 0 section actions');
  await page.getByRole('menuitem', { name: 'Move section down', exact: true }).click();
  await expect.poll(sectionOrder).toEqual(['s2', 's0']);
  await expect(page.locator('[data-section-id="s0"] .section-title')).toBeFocused();
  await page.mouse.move(0, 0);
  await expect
    .poll(() =>
      page
        .locator('[data-section-id="s0"] .section-drag-handle')
        .evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(0);
  const pointerMenuVersion = (await saved()).version;
  await page.keyboard.press('ArrowLeft');
  assert.equal((await saved()).version, pointerMenuVersion);
  await search.fill('');
  await expect(page.locator('[data-section-id="s1"] .section-title')).toContainText(
    'Hidden section',
  );
  assert.deepEqual(
    (await saved()).body.sections.find((section) => section.id === 's1'),
    retainedSections[1],
  );
  checks.push(
    'filtered pointer, keyboard and menu reorder preserve hidden sections and restore useful focus',
  );
  const scrollView = await saved();
  scrollView.body.sections = Array.from({ length: 6 }, (_, i) => ({
    id: 's' + i,
    name: 'Section ' + i,
  }));
  scrollView.body.panels = Array.from({ length: 18 }, (_, i) => ({
    id: 'scroll' + i,
    plugin: 'line',
    metric: 'loss',
    title: 'Scroll ' + i,
    section: 's' + Math.floor(i / 3),
  }));
  scrollView.body.sectionLayouts = Object.fromEntries(
    scrollView.body.sections.map((section) => [section.id, { width: 360, height: 220, rows: 1 }]),
  );
  const scrollUpdate = await fetch(url + '/api/views/' + view.id, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: scrollView.name,
      project: scrollView.project,
      body: scrollView.body,
      version: scrollView.version,
    }),
  });
  assert.ok(scrollUpdate.ok);
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.reload();
  await expect(page.locator('[data-section-id="s5"]')).toBeAttached();
  await page.locator('main').evaluate((node) => (node.scrollTop = node.scrollHeight));
  await start('[data-section-id="s5"] .section-title');
  const lastTitle = await page.locator('[data-section-id="s5"] .section-title').boundingBox(),
    scrollBefore = await page.locator('main').evaluate((node) => node.scrollTop);
  await page.mouse.move(
    lastTitle.x + lastTitle.width / 2,
    lastTitle.y + lastTitle.height / 2 - 60,
    { steps: 15 },
  );
  await page.waitForTimeout(150);
  assert.deepEqual(await sectionOrder(), ['s0', 's1', 's2', 's3', 's5', 's4']);
  assert.ok(
    Math.abs((await page.locator('main').evaluate((node) => node.scrollTop)) - scrollBefore) < 2,
    'A short drag away from scroll edges must not move the viewport',
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await saved()).body.sections.map((section) => section.id))
    .toEqual(['s0', 's1', 's2', 's3', 's5', 's4']);
  await expect(page.locator('[data-section-id="s5"] .section-title')).toBeFocused();
  await page.mouse.move(0, 0);
  await expect
    .poll(() =>
      page
        .locator('[data-section-id="s5"] .section-drag-handle')
        .evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(0);
  const afterDropVersion = (await saved()).version;
  await page.keyboard.press('ArrowLeft');
  assert.equal((await saved()).version, afterDropVersion);
  checks.push(
    'short section drag on a scrolled page moves one position without scroll anchoring or hidden keyboard reorders',
  );
  const savedSections = async () => (await saved()).body.sections.map((section) => section.id);
  const s5 = page.locator('[data-section-id="s5"]');
  await pressSectionButton(s5, 'Section 5 section actions');
  const sectionItem = (name) => page.getByRole('menuitem', { name, exact: true });
  await expect(sectionItem('Move section to top')).toBeEnabled();
  await expect(sectionItem('Move section to bottom')).toBeEnabled();
  await sectionItem('Move section to top').click();
  await expect.poll(savedSections).toEqual(['s5', 's0', 's1', 's2', 's3', 's4']);
  await expect(s5.locator('.section-title')).toBeFocused();
  await pressSectionButton(s5, 'Section 5 section actions');
  await expect(sectionItem('Move section to top')).toBeDisabled();
  await expect(sectionItem('Move section up')).toBeDisabled();
  await sectionItem('Move section to bottom').press('Enter');
  await expect.poll(savedSections).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
  await expect(s5.locator('.section-drag-handle')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Section 5, section' })).toHaveText(
    'Section 5, section 6 of 6.',
  );
  await pressSectionButton(s5, 'Section 5 section actions');
  await expect(sectionItem('Move section down')).toBeDisabled();
  await expect(sectionItem('Move section to bottom')).toBeDisabled();
  await page.keyboard.press('Escape');
  checks.push('section menu moves to top and bottom with boundary states, focus and announcements');
  const jitterView = await saved();
  jitterView.body.sectionLayouts.s1.rows = 2;
  const jitterUpdate = await fetch(url + '/api/views/' + view.id, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: jitterView.name,
      project: jitterView.project,
      body: jitterView.body,
      version: jitterView.version,
    }),
  });
  assert.ok(jitterUpdate.ok);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload();
  await page.locator('main').evaluate((node) => (node.scrollTop = 0));
  await start('[data-section-id="s0"] .section-title');
  const startBox = await page.locator('[data-section-id="s0"] .section-title').boundingBox();
  let crossing = startBox.y;
  for (let y = startBox.y + 20; y < 900; y += 4) {
    await page.mouse.move(startBox.x + 60, y);
    if ((await sectionOrder())[0] !== 's0') {
      crossing = y;
      break;
    }
  }
  const stableOrder = await sectionOrder();
  assert.notEqual(stableOrder[0], 's0');
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(startBox.x + 60, crossing + (i % 2 ? 3 : -3));
    assert.deepEqual(
      await sectionOrder(),
      stableOrder,
      'Small reversals must not undo a section swap',
    );
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  checks.push('unequal section reordering resists small pointer reversals');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (e) {
  console.error({ checks });
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
