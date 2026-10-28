import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect as baseExpect, request } from '@playwright/test';
import { demoURL, launchBrowser } from './helpers.mjs';
const panelSettings = (page, title) =>
  page
    .getByRole('article', { name: title, exact: true })
    .getByRole('button', { name: 'Panel settings', exact: true });
async function openPanelSettings(page, title) {
  await page.getByRole('article', { name: title, exact: true }).hover();
  await panelSettings(page, title).click();
}

async function pressSectionButton(scope, name) {
  const button = scope.getByRole('button', { name, exact: true });
  await button.locator('xpath=ancestor::div[contains(@class,"section-heading")]').hover();
  await button.click();
}

// Run against a separately seeded demo server; temporary views and labeled run fixtures are isolated.
// RANDL_URL=http://127.0.0.1:8744 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:browser
const baseURL = demoURL();
const expect = baseExpect.configure({ timeout: 10_000 });
const api = await request.newContext({ baseURL });
let browser;
let failures = 0;
let checked = 0;
const ownedViews = new Set();

async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await api.fetch(path, { method, data: body });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

async function createView(project) {
  const view = await call('/api/tools/view_create', {
    name: `Browser verification ${randomUUID()}`,
    project,
  });
  ownedViews.add(view.id);
  return view;
}

async function persisted(viewId) {
  return call(`/api/views/${encodeURIComponent(viewId)}`);
}

const sorted = (values) => [...values].sort();

async function selectionSaved(viewId, visible, solo) {
  await expect
    .poll(async () => {
      const view = await persisted(viewId);
      return { visible: sorted(view.body.visible), solo: sorted(view.body.solo) };
    })
    .toEqual({ visible: sorted(visible), solo: sorted(solo) });
}

async function workspace(page) {
  const savedView = page.locator('.view-controls');
  if (!(await savedView.isVisible())) {
    {
      const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
      if (await menu.isVisible()) {
        await menu.click();
        await page
          .getByRole('navigation', { name: 'Navigation', exact: true })
          .getByRole('link', { name: 'Workspace', exact: true })
          .click();
      } else {
        await page
          .getByRole('navigation', { name: 'Project pages', exact: true })
          .getByRole('button', { name: 'Workspace', exact: true })
          .click();
      }
    }
  }
  await expect(savedView).toBeVisible();
  return savedView.locator('select');
}

async function editorTab(editor, label) {
  const picker = editor.getByRole('combobox', { name: 'Panel settings', exact: true });
  await expect
    .poll(
      async () =>
        (await picker.isVisible()) ||
        (await editor.getByRole('tab', { name: label, exact: true }).isVisible()),
    )
    .toBe(true);
  if (await picker.isVisible()) {
    await picker.selectOption({ label });
    await expect(picker.locator('option:checked')).toHaveText(label);
  } else {
    const tab = editor.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
}

async function withView(fixture, run) {
  const view = await createView(fixture.project);
  const sibling = await createView(fixture.project);
  await call('/api/tools/runs_select', {
    view: view.id,
    visible: fixture.runs.slice(0, 3).map((r) => r.id),
    solo: [],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
  });
  const errors = [];
  await context.addInitScript(() => {
    // Deliver deterministic server-event fixtures without editing seeded runs.
    const NativeEventSource = window.EventSource;
    window.__randlBrowserEventSources = [];
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        window.__randlBrowserEventSources.push(this);
      }
    };
    if (!sessionStorage.getItem('randl.browser-test-initialized')) {
      localStorage.setItem('randl.language', 'en');
      localStorage.setItem('randl.theme', 'g100');
      localStorage.setItem('randl.accent', '#0f62fe');
      sessionStorage.setItem('randl.browser-test-initialized', 'true');
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(
      `${baseURL}/${fixture.project.split('/').map(encodeURIComponent).join('/')}/workspace?view=${encodeURIComponent(view.id)}`,
    );
    await workspace(page);
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue(
      fixture.project,
    );
    const selector = await workspace(page);
    await selector.selectOption(view.id);
    await expect(selector).toHaveValue(view.id);
    await expect(page.locator('#run-list [role="listitem"]').first()).toBeVisible();
    await run({ page, viewId: view.id, siblingId: sibling.id, context, fixture });
    assert.deepEqual(errors, [], 'Uncaught browser errors');
  } catch (error) {
    console.error(
      'Browser diagnostics:',
      JSON.stringify({
        url: page.url(),
        notifications: await page.locator('.bx--inline-notification:visible').allTextContents(),
        dialogs: await page.locator('[role="dialog"]:visible').allTextContents(),
        errors,
      }),
    );
    throw error;
  } finally {
    await context.close();
    for (const id of [view.id, sibling.id]) {
      await call(`/api/views/${encodeURIComponent(id)}`, undefined, 'DELETE');
      ownedViews.delete(id);
    }
  }
}

async function check(name, fixture, run) {
  if (process.env.RANDL_BROWSER_FILTER && !name.includes(process.env.RANDL_BROWSER_FILTER)) return;
  checked++;
  try {
    await withView(fixture, run);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n${error.stack || error}`);
  }
}

function toggle(page, kind, index) {
  return page.locator(`[data-toggle="${kind}"][data-index="${index}"]`);
}

async function top(page) {
  await page.locator('#run-list').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(toggle(page, 'visible', 0)).toBeVisible();
}

async function rowIds(page, count) {
  await top(page);
  return Promise.all(
    Array.from({ length: count }, (_, i) => toggle(page, 'visible', i).getAttribute('data-id')),
  );
}

async function hideListed(page) {
  const show = page.getByRole('button', { name: 'Show listed runs', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('button', { name: 'Hide listed runs', exact: true }).click();
}

async function assertNestedBounds(page) {
  const overflow = await page
    .locator(
      'main,.project-bar,.workspace-heading,.workspace-toolbar,.panel-editor-layout,.panel-editor-fields,.panel-editor-preview,.side-drawer-content,.context-popover,.color-popover,.filter-rule',
    )
    .evaluateAll((elements) =>
      elements
        .filter(
          (e) =>
            e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
            e.clientWidth &&
            e.getBoundingClientRect().width &&
            e.scrollWidth > e.clientWidth + 1,
        )
        .map((e) => ({
          region: e.className || e.tagName,
          client: e.clientWidth,
          scroll: e.scrollWidth,
        })),
    );
  assert.deepEqual(
    overflow,
    [],
    'Nested workspace/editor content requires horizontal scrolling or is clipped',
  );
}

async function displayedXAxis(page, title) {
  return page
    .locator('main')
    .getByRole('article', { name: title, exact: true })
    .locator('.chart-canvas')
    .evaluate(async (element) => {
      const moduleURL = performance
        .getEntriesByType('resource')
        .map((item) => item.name)
        .find((url) => /\/engine-[^/]+\.js$/.test(url));
      if (!moduleURL) throw Error('Chart engine was not loaded');
      const module = await import(moduleURL);
      const engine = Object.values(module).find((value) => value?.getInstanceByDom);
      const host = element.hasAttribute('_echarts_instance_')
        ? element
        : element.querySelector('[_echarts_instance_]');
      return host ? engine?.getInstanceByDom(host)?.getOption().xAxis?.[0]?.name : undefined;
    });
}

async function paint(page, kind, from, to) {
  const first = await toggle(page, kind, from).boundingBox();
  const last = await toggle(page, kind, to).boundingBox();
  assert.ok(first && last, 'Drag endpoints must be rendered');
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, {
    steps: Math.abs(to - from) * 12,
  });
  // Re-entering an already painted row must not reverse its state.
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, {
    steps: Math.abs(to - from) * 12,
  });
  await page.mouse.up();
}

async function deliverRunRevision(page, run) {
  const refreshed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/run' && url.searchParams.get('id') === run.id;
  });
  await page.evaluate((metadata) => {
    const stream = window.__randlBrowserEventSources.at(-1);
    if (!stream) throw Error('The live update stream is not connected');
    stream.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ runs: [metadata], removed: [], workspace: false }),
      }),
    );
  }, run);
  await refreshed;
}

async function addLinePanel(page, metric, title) {
  await page.getByRole('button', { name: 'Add panel', exact: true }).first().click();
  const dialog = page.locator('[role="dialog"]:visible');
  await dialog.getByRole('combobox', { name: 'Panel type', exact: true }).selectOption('line');
  if (!(await dialog.getByRole('button', { name: 'Remove ' + metric, exact: true }).count())) {
    await dialog.getByRole('combobox', { name: 'Y metrics', exact: true }).fill(metric);
    await page.getByRole('option', { name: metric, exact: true }).click();
  }
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await dialog.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: title, exact: true }).locator('canvas'),
  ).toHaveCount(1);
}

async function resizeFixture(page, viewId, metric) {
  const view = await persisted(viewId);
  const sections = [
    { id: 'dense', name: 'Dense' },
    { id: 'sparse', name: 'Sparse' },
    { id: 'pair', name: 'Pair' },
  ];
  await call(
    `/api/views/${viewId}`,
    {
      name: view.name,
      project: view.project,
      version: view.version,
      body: {
        ...view.body,
        sections,
        sectionLayouts: {},
        panels: sections.flatMap((section, index) =>
          Array.from({ length: [13, 1, 2][index] }, (_, i) => ({
            id: `${section.id}-${i}`,
            plugin: 'line',
            metric,
            metrics: [metric],
            title: `${section.name} ${i}`,
            section: section.id,
            settings: {},
          })),
        ),
      },
    },
    'PUT',
  );
  await page.reload();
  await workspace(page);
  await expect(page.locator('[data-panel-id="dense-0"]')).toBeVisible();
}

async function beginResize(page, handle, dx, dy) {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  assert.ok(box, 'Resize handle has no geometry');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
}

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 2, `${message}: ${actual} versus ${expected}`);
}

async function primaryContrast(button) {
  return button.evaluate((element) => {
    const parse = (value) => {
      const values = value.match(/[\d.]+/g)?.map(Number);
      if (!values || values.length < 3) throw Error(`Unsupported computed color: ${value}`);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const composite = (front, back) =>
      front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3]));
    let background = [255, 255, 255];
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.push(node);
    for (const node of ancestors.reverse())
      background = composite(parse(getComputedStyle(node).backgroundColor), background);
    const foreground = composite(parse(getComputedStyle(element).color), background);
    const luminance = (rgb) =>
      rgb
        .map((v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(foreground),
      b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

try {
  const { runs } = await call('/api/runs');
  const groups = new Map();
  for (const run of runs) {
    if (run.entity !== 'demo') continue;
    const project = `${run.entity}/${run.project}`;
    groups.set(project, [...(groups.get(project) || []), run]);
  }
  const candidate = [...groups].sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(
    candidate && candidate[1].length >= 64,
    'Browser tests require a demo project with at least 64 seeded runs. Build, run node scripts/seed-demo.mjs --data-dir /tmp/randl-browser-demo --runs 100, then serve that data directory on RANDL_URL.',
  );
  const fixture = { project: candidate[0], runs: candidate[1] };
  fixture.projectName = (await call('/api/projects')).projects.find(
    (project) => project.id === fixture.project,
  ).name;
  const { metrics } = await call('/api/metrics', {
    runs: fixture.runs.slice(0, 3).map((r) => r.id),
  });
  assert.ok(metrics.length, 'Demo runs need numeric history metrics; use scripts/seed-demo.mjs.');
  fixture.metric = metrics[0];
  browser = await launchBrowser();

  await check('continuous virtualized runs and filtering', fixture, async ({ page }) => {
    const rows = page.locator('#run-list [role="listitem"]');
    assert.ok((await rows.count()) < fixture.runs.length / 2, 'Run list mounts too many rows');
    await page.locator('#run-list').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(rows.last()).toHaveAttribute('aria-posinset', String(fixture.runs.length));
    await expect(rows.last()).toBeVisible();
    const lastId = await rows.last().locator('[data-toggle="visible"]').getAttribute('data-id');
    assert.ok(fixture.runs.some((run) => run.id === lastId));
    assert.ok(
      (await rows.count()) < fixture.runs.length / 2,
      'Bottom of list stopped virtualizing',
    );
    const target = fixture.runs[0];
    await page
      .getByRole('searchbox', { name: 'Search runs by name or ID', exact: true })
      .fill(target.name);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().locator('[data-toggle="visible"]')).toHaveAttribute(
      'data-id',
      target.id,
    );
    await page
      .getByRole('searchbox', { name: 'Search runs by name or ID', exact: true })
      .fill('no-run-matches-this-browser-fixture');
    await expect(rows).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search runs by name or ID', exact: true }).fill('');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toHaveAttribute('aria-setsize', String(fixture.runs.length));
  });

  await check(
    'visibility and multi-solo preserve independent state',
    fixture,
    async ({ page, viewId }) => {
      const chartRequests = [];
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/api/chart' && req.method() === 'POST') {
          chartRequests.push(sorted(req.postDataJSON().runs));
        }
      });
      await addLinePanel(page, fixture.metric, 'Selection verification');
      const ids = await rowIds(page, 5);
      await hideListed(page);
      await selectionSaved(viewId, [], []);
      await toggle(page, 'visible', 0).click();
      await toggle(page, 'visible', 2).click();
      await toggle(page, 'solo', 1).click();
      await toggle(page, 'solo', 3).click();
      await toggle(page, 'visible', 4).click();
      await selectionSaved(viewId, [ids[0], ids[2], ids[4]], [ids[1], ids[3]]);
      await expect(page.locator('.side-footer')).toContainText('2 soloed');
      await expect.poll(() => chartRequests.at(-1)).toEqual(sorted([ids[1], ids[3]]));
      await page.getByRole('button', { name: 'Clear solo', exact: true }).click();
      await selectionSaved(viewId, [ids[0], ids[2], ids[4]], []);
      await expect(page.locator('.side-footer')).toContainText('3 visible');
      await expect.poll(() => chartRequests.at(-1)).toEqual(sorted([ids[0], ids[2], ids[4]]));
      for (const kind of ['visible', 'solo']) {
        await toggle(page, kind, 0).focus();
        await page.keyboard.press('Space');
        await expect(toggle(page, kind, 0)).toHaveAttribute(
          'aria-pressed',
          kind === 'visible' ? 'false' : 'true',
        );
        await page.keyboard.press('Enter');
        await expect(toggle(page, kind, 0)).toHaveAttribute(
          'aria-pressed',
          kind === 'visible' ? 'true' : 'false',
        );
      }
      await selectionSaved(viewId, [ids[0], ids[2], ids[4]], []);
      for (const kind of ['visible', 'solo']) {
        await top(page);
        await toggle(page, kind, 0).focus();
        for (let i = 1; i <= 32; i++) {
          await page.keyboard.press('ArrowDown');
          await expect(toggle(page, kind, i)).toBeFocused();
        }
      }
    },
  );

  await check(
    'both drag controls paint once across rows and virtualization',
    fixture,
    async ({ page, viewId }) => {
      const ids = await rowIds(page, 4);
      await hideListed(page);
      await selectionSaved(viewId, [], []);
      await paint(page, 'visible', 0, 3);
      await selectionSaved(viewId, ids, []);
      await paint(page, 'solo', 0, 3);
      await selectionSaved(viewId, ids, ids);
      await paint(page, 'solo', 0, 3);
      await selectionSaved(viewId, ids, []);
      await paint(page, 'visible', 0, 3);
      await selectionSaved(viewId, [], []);
      for (const kind of ['visible', 'solo']) {
        await top(page);
        const first = await toggle(page, kind, 0).boundingBox();
        const bounds = await page.locator('#run-list').boundingBox();
        await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
        await page.mouse.down();
        await page.mouse.move(first.x + first.width / 2, bounds.y + bounds.height - 8, {
          steps: 60,
        });
        try {
          await expect
            .poll(() => page.locator('#run-list').evaluate((e) => e.scrollTop))
            .toBeGreaterThan(450);
        } finally {
          await page.mouse.up();
        }
        await expect
          .poll(async () => (await persisted(viewId)).body[kind].length)
          .toBeGreaterThan(15);
      }
      const painted = await persisted(viewId);
      await page.getByRole('button', { name: 'Clear solo', exact: true }).click();
      await selectionSaved(viewId, painted.body.visible, []);
    },
  );

  await check(
    'empty views persist and panels save edits',
    fixture,
    async ({ page, viewId, siblingId }) => {
      await expect(page.getByRole('heading', { name: 'No panels in this view' })).toBeVisible();
      await page.reload();
      const selector = await workspace(page);
      // Project navigation may start on the all-projects page; select our own view explicitly.
      if (
        (await page.getByRole('combobox', { name: 'Project', exact: true }).inputValue()) !==
        fixture.project
      ) {
        await page
          .getByRole('combobox', { name: 'Project', exact: true })
          .selectOption(fixture.project);
      }
      await selector.selectOption(viewId);
      await expect(page.getByRole('heading', { name: 'No panels in this view' })).toBeVisible();
      assert.deepEqual((await persisted(viewId)).body.panels, []);
      await addLinePanel(page, fixture.metric, 'Browser fixture chart');
      await expect.poll(async () => (await persisted(viewId)).body.panels.length).toBe(1);
      await expect(
        page.getByRole('article', { name: 'Browser fixture chart', exact: true }).locator('canvas'),
      ).toHaveCount(1);
      await openPanelSettings(page, 'Browser fixture chart');
      let dialog = page.locator('[role="dialog"]:visible');
      await dialog
        .getByRole('textbox', { name: 'Title', exact: true })
        .fill('Cancelled chart title');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true });
      await expect(discard).toBeVisible();
      await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0);
      await expect(panelSettings(page, 'Browser fixture chart')).toBeVisible();
      await openPanelSettings(page, 'Browser fixture chart');
      dialog = page.locator('[role="dialog"]:visible');
      await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
        'Browser fixture chart',
      );
      await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Saved chart title');
      await dialog.getByRole('button', { name: 'Save panel', exact: true }).click();
      await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0);
      await expect
        .poll(async () => (await persisted(viewId)).body.panels[0]?.title)
        .toBe('Saved chart title');
      await selector.selectOption(siblingId);
      await selector.selectOption(viewId);
      await expect(
        page.getByRole('article', { name: 'Saved chart title', exact: true }),
      ).toBeVisible();
      await page.reload();
      await workspace(page);
      await page
        .getByRole('combobox', { name: 'Project', exact: true })
        .selectOption(fixture.project);
      await selector.selectOption(viewId);
      await expect(
        page.getByRole('article', { name: 'Saved chart title', exact: true }).locator('canvas'),
      ).toHaveCount(1);
    },
  );

  await check(
    'advanced panel settings persist and change chart queries',
    fixture,
    async ({ page, viewId }) => {
      const queries = [];
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/api/chart' && req.method() === 'POST')
          queries.push(req.postDataJSON());
      });
      await addLinePanel(page, fixture.metric, 'Advanced settings fixture');
      await openPanelSettings(page, 'Advanced settings fixture');
      const dialog = page.locator('[role="dialog"]:visible');
      await editorTab(dialog, 'Smoothing');
      await dialog
        .getByRole('combobox', { name: 'Smoothing method', exact: true })
        .selectOption('ema');
      await dialog.getByRole('spinbutton', { name: 'Weight', exact: true }).fill('0.8');
      await dialog.getByRole('spinbutton', { name: 'Weight', exact: true }).press('Tab');
      const original = dialog.getByRole('checkbox', { name: 'Show original trace', exact: true });
      await original.focus();
      await page.keyboard.press('Space');
      await expect(original).toBeChecked();
      await editorTab(dialog, 'Data');
      await dialog.getByRole('combobox', { name: 'X axis', exact: true }).fill(fixture.metric);
      await page.getByRole('option', { name: fixture.metric, exact: true }).click();
      await editorTab(dialog, 'Axes');
      await dialog.getByRole('combobox', { name: 'Y scale', exact: true }).selectOption('log');
      await dialog.getByLabel('Y minimum', { exact: true }).fill('0.0001');
      await editorTab(dialog, 'Grouping');
      await dialog
        .getByRole('combobox', { name: 'Group runs', exact: true })
        .fill('All runs as one group');
      await page.getByRole('option', { name: 'All runs as one group', exact: true }).click();
      await dialog
        .getByRole('combobox', { name: 'Aggregation', exact: true })
        .selectOption('median');
      await dialog.getByRole('combobox', { name: 'Spread', exact: true }).selectOption('stddev');
      await editorTab(dialog, 'Display');
      const legend = dialog.getByRole('checkbox', { name: 'Show legend', exact: true });
      await legend.focus();
      await page.keyboard.press('Space');
      await expect(legend).not.toBeChecked();
      await dialog.getByRole('spinbutton', { name: 'Line width', exact: true }).fill('3');
      await dialog.getByRole('spinbutton', { name: 'Line width', exact: true }).press('Tab');
      await dialog.getByRole('button', { name: 'Save panel', exact: true }).click();
      await expect(
        page.getByRole('dialog', { name: 'Panel settings', exact: true }),
      ).not.toBeVisible();
      const expected = {
        smoothingMethod: 'ema',
        smoothingValue: 0.8,
        showOriginal: true,
        xAxis: fixture.metric,
        yScale: 'log',
        yMin: 0.0001,
        groupBy: 'all',
        aggregation: 'median',
        spread: 'stddev',
        legend: false,
        lineWidth: 3,
      };
      await expect
        .poll(async () => (await persisted(viewId)).body.panels[0].settings)
        .toEqual(expected);
      await expect
        .poll(() => queries.at(-1)?.settings)
        .toEqual({
          xAxis: fixture.metric,
          groupBy: 'all',
          aggregation: 'median',
          spread: 'stddev',
        });
      await openPanelSettings(page, 'Advanced settings fixture');
      await assertNestedBounds(page);
      await editorTab(dialog, 'Smoothing');
      await expect(dialog.getByRole('spinbutton', { name: 'Weight', exact: true })).toHaveValue(
        '0.8',
      );
      await expect(original).toBeChecked();
      await editorTab(dialog, 'Display');
      await expect(legend).not.toBeChecked();
      await expect(dialog.getByRole('spinbutton', { name: 'Line width', exact: true })).toHaveValue(
        '3',
      );
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await openPanelSettings(page, 'Advanced settings fixture');
      await dialog
        .getByRole('button', { name: 'Reset all to inherited values', exact: true })
        .click();
      await dialog.getByRole('button', { name: 'Save panel', exact: true }).click();
      await expect.poll(async () => (await persisted(viewId)).body.panels[0].settings).toEqual({});
    },
  );

  await check(
    'run pages deep-link, reload and preserve comparison context',
    fixture,
    async ({ page, viewId, siblingId }) => {
      await addLinePanel(page, fixture.metric, 'Project comparison fixture');
      const savedProjectView = await persisted(viewId);
      await call('/api/tools/view_rename', {
        id: siblingId,
        name: 'Different recently edited comparison',
      });
      await expect(page.getByRole('combobox', { name: 'Saved view', exact: true })).toContainText(
        'Different recently edited comparison',
      );
      await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', viewId);
      const before = new Set((await call('/api/views')).views.map((v) => v.id));
      const runId = await toggle(page, 'visible', 0).getAttribute('data-id');
      await page.locator('#run-list .run-name').first().click();
      await expect(page.getByRole('tab', { name: 'Metrics', exact: true })).toBeVisible();
      await page.waitForURL((url) => url.pathname.includes('/runs/'));
      const runURL = page.url();
      assert.ok(new URL(runURL).pathname.includes('/runs/'));
      const liveRun = (await call('/api/runs')).runs.find((run) => run.id === runId);
      await page.getByRole('tab', { name: 'Config', exact: true }).click();
      await deliverRunRevision(page, { ...liveRun, revision: liveRun.revision + 1 });
      await expect(page.getByRole('tab', { name: 'Config', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      for (const label of [
        'Overview',
        'Config',
        'Summary',
        'Logs',
        'Files',
        'Artifacts',
        'Metrics',
      ]) {
        await page.getByRole('tab', { name: label, exact: true }).click();
        await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      }
      await page.getByRole('tab', { name: 'Overview', exact: true }).click();
      await page.getByRole('button', { name: 'Edit run details', exact: true }).click();
      const tags = page.getByRole('textbox', { name: 'Tags', exact: true });
      const originalTags = await tags.inputValue();
      const cancelledTag = `discarded-browser-tag-${randomUUID()}`;
      await tags.fill(cancelledTag);
      await deliverRunRevision(page, { ...liveRun, revision: liveRun.revision + 2 });
      await expect(tags).toHaveValue(cancelledTag);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByText(cancelledTag, { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Edit run details', exact: true }).click();
      await expect(tags).toHaveValue(originalTags);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      for (const view of (await call('/api/views')).views) {
        if (!before.has(view.id) && view.run === runId) ownedViews.add(view.id);
      }
      const activeRunURL = page.url();
      assert.equal(new URL(activeRunURL).pathname, new URL(runURL).pathname + '/overview');
      await page.reload();
      await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      assert.equal(page.url(), activeRunURL);
      assert.deepEqual(
        (await persisted(viewId)).body,
        savedProjectView.body,
        'Run page changed project view',
      );
      await workspace(page);
      await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', viewId);
      await expect(
        page.getByRole('article', { name: 'Project comparison fixture', exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('tab', { name: 'Metrics', exact: true })).toBeVisible();
      await page.goForward();
      await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', viewId);
    },
  );

  await check(
    'SDK project links and project switching leave the old run',
    fixture,
    async ({ page }) => {
      await page.goto(`${baseURL}/${fixture.project.split('/').map(encodeURIComponent).join('/')}`);
      await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue(
        fixture.project,
      );
      await expect(page.locator('#run-list [role="listitem"]').first()).toBeVisible();
      await page.locator('#run-list .run-name').first().click();
      await page.waitForURL((url) => url.pathname.includes('/runs/'));
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('');
      await expect(page.getByRole('tab', { name: 'Metrics', exact: true })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('');
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      await expect.poll(() => new URL(page.url()).pathname.includes('/runs/')).toBe(false);
    },
  );

  await check(
    'live updates preserve unsaved choices after a view conflict',
    fixture,
    async ({ page, viewId }) => {
      const ids = await rowIds(page, 5);
      await hideListed(page);
      await toggle(page, 'visible', 0).click();
      await toggle(page, 'visible', 1).click();
      await toggle(page, 'visible', 2).click();
      await selectionSaved(viewId, ids.slice(0, 3), []);
      await expect(page.getByRole('checkbox', { name: 'Auto-refresh', exact: true })).toHaveCount(
        0,
      );
      let concurrentEdit = true;
      await page.route(`**/api/views/${viewId}`, async (route) => {
        if (route.request().method() === 'PUT' && concurrentEdit) {
          concurrentEdit = false;
          // Commit another writer after this browser constructed its stale request.
          await call('/api/tools/runs_select', { view: viewId, visible: [ids[4]], solo: [] });
        }
        await route.continue();
      });
      await toggle(page, 'visible', 0).click();
      await expect(page.locator('.save-status .current')).toHaveText('Not saved');
      await expect(page.locator('.side-footer')).toContainText('2 visible');
      // Allow SSE invalidation/reconnection and the fallback update interval to run.
      await page.waitForTimeout(11_000);
      await expect(page.locator('.side-footer')).toContainText('2 visible');
      await expect(toggle(page, 'visible', 1)).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle(page, 'visible', 2)).toHaveAttribute('aria-pressed', 'true');
      await selectionSaved(viewId, [ids[4]], []);
      await page.getByRole('button', { name: 'Save as new view', exact: true }).click();
      const selector = page.getByRole('combobox', { name: 'Saved view', exact: true });
      await expect(selector).not.toHaveValue(viewId);
      await expect(selector).toHaveValue(/^[a-f0-9-]{36}$/);
      const recoveredId = await selector.inputValue();
      ownedViews.add(recoveredId);
      await selectionSaved(recoveredId, [ids[1], ids[2]], []);
      await selectionSaved(viewId, [ids[4]], []);
      await expect(page.locator('.save-status .current')).toHaveText('Saved');
    },
  );

  await check(
    'mobile drawer focus, inert content, touch toggles and overflow',
    fixture,
    async ({ page, viewId }) => {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await assertNestedBounds(page);
        await expect(page.locator('aside')).toHaveAttribute('inert', '');
        const opener = page.getByRole('button', { name: 'Show runs', exact: true });
        await expect(opener).toHaveAttribute('id', 'open-runs');
        await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
        await opener.click();
        await expect(page.locator('.runs-heading h2')).toBeFocused();
        await expect(page.locator('main')).toHaveAttribute('inert', '');
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        const closeRuns = page
          .locator('aside')
          .getByRole('button', { name: 'Close runs', exact: true });
        await closeRuns.focus();
        await page.keyboard.press('Shift+Tab');
        assert.ok(
          await page.evaluate(() => !!document.activeElement.closest('aside')),
          'Focus escaped the runs drawer',
        );
        await top(page);
        const colorButton = page.locator('#run-list .run-color-button').first();
        await colorButton.tap();
        await expect(page.getByRole('dialog', { name: /^Color for / })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: /^Color for / })).toHaveCount(0);
        await expect(colorButton).toBeFocused();
        assert.ok(
          !(await page.locator('aside').evaluate((e) => e.inert)),
          'Escape dismissed the parent drawer with its color picker',
        );
        const button = toggle(page, 'solo', 0);
        const runId = await button.getAttribute('data-id');
        const before = await persisted(viewId);
        await button.tap();
        await expect
          .poll(async () => (await persisted(viewId)).body.solo.includes(runId))
          .toBe(!before.body.solo.includes(runId));
        await page.keyboard.press('Escape');
        await expect(opener).toBeFocused();
        await expect(page.locator('aside')).toHaveAttribute('inert', '');
        await opener.click();
        await closeRuns.click();
        await expect(opener).toBeFocused();
        await opener.click();
        const runsBounds = await page.locator('aside').boundingBox();
        if (runsBounds.x + runsBounds.width < width - 4) {
          await page.locator('.drawer-shade').click({ position: { x: width - 2, y: 500 } });
        } else {
          await closeRuns.click();
        }
        await expect(opener).toBeFocused();
        assert.ok(!(await page.locator('main').evaluate((e) => e.inert)));

        // The navigation menu is separate from the runs drawer and traps its own focus.
        const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
        await menu.click();
        const navigation = page.getByRole('navigation', { name: 'Navigation', exact: true });
        await expect(navigation.getByRole('link', { name: 'Workspace', exact: true })).toBeFocused();
        await expect(navigation.getByRole('link', { name: 'Workspace', exact: true })).toHaveAttribute(
          'aria-current',
          'page',
        );
        await navigation.getByRole('link', { name: 'Projects', exact: true }).focus();
        await page.keyboard.press('Shift+Tab');
        assert.ok(
          await page.evaluate(() => !!document.activeElement.closest('.phone-navigation')),
          'Focus escaped the navigation menu',
        );
        await page.keyboard.press('Escape');
        await expect(navigation).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
        await menu.click();
        await navigation.getByRole('link', { name: 'Settings', exact: true }).click();
        await expect(navigation).toHaveCount(0);
        await expect(page.locator('.project-rail')).toHaveAttribute('inert', '');
        assert.ok(
          !(await page.locator('main').evaluate((e) => e.inert)),
          'Navigation left the requested page inert',
        );
        await menu.click();
        await expect(navigation.getByRole('link', { name: 'Settings', exact: true })).toBeFocused();
        await navigation.getByRole('link', { name: 'Workspace', exact: true }).click();
        await expect(page.locator('aside')).toHaveAttribute('inert', '');

        // Narrow run details use the native picker while retaining deep-link routing.
        const knownViews = new Set((await call('/api/views')).views.map((view) => view.id));
        await opener.click();
        await page.locator('#run-list .run-name').first().click();
        const picker = page.getByRole('combobox', { name: 'Run details', exact: true });
        await expect(picker).toBeVisible();
        await picker.selectOption('config');
        await expect(picker).toHaveValue('config');
        await page.waitForURL((url) => url.pathname.endsWith('/config'));
        await page.reload();
        await expect(picker).toHaveValue('config');
        for (const created of (await call('/api/views')).views) {
          if (!knownViews.has(created.id) && created.run === runId) ownedViews.add(created.id);
        }
        await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
        await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', viewId);
      }
    },
  );

  await check(
    'section resize previews, equal geometry, pagination, undo and color persistence',
    fixture,
    async ({ page, viewId }) => {
      await addLinePanel(page, fixture.metric, 'Section layout fixture');
      const original = await persisted(viewId);
      const sectionId = fixture.metric.includes('/') ? fixture.metric.split('/')[0] : 'Metrics';
      // More than one page is necessary to verify section geometry and panel access.
      await call(
        `/api/views/${viewId}`,
        {
          name: original.name,
          project: original.project,
          version: original.version,
          body: {
            ...original.body,
            panels: Array.from({ length: 9 }, (_, i) => ({
              ...original.body.panels[0],
              id: `layout-${i}`,
              title: `Layout panel ${i}`,
            })),
          },
        },
        'PUT',
      );
      await page.reload();
      await workspace(page);
      const section = page.locator(`[data-section-id="${sectionId}"]`);
      const card = section.getByRole('article').first();
      await expect(card.locator('canvas')).toHaveCount(1);
      const initialHeight = Math.round((await card.boundingBox()).height);
      const corner = card.getByRole('button', {
        name: /^Resize (?:.* panels, |panels in section$)/,
      });
      await card.hover();
      const handle = await corner.boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + handle.height / 2 + 60, {
        steps: 12,
      });
      await expect(page.locator('.resize-preview')).toBeVisible();
      assert.equal(
        Math.round((await card.boundingBox()).height),
        initialHeight,
        'Chart resized before preview commit',
      );
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(page.locator('.resize-preview')).toHaveCount(0);
      assert.equal(
        (await persisted(viewId)).body.sectionLayouts?.[sectionId],
        undefined,
        'Escape committed a resize',
      );
      await corner.focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts?.[sectionId]?.height)
        .toBe(initialHeight + 20);
      const heights = await section
        .getByRole('article')
        .evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().height)));
      assert.ok(
        heights.length > 1 && heights.every((h) => h === initialHeight + 20),
        'Section cards have unequal heights',
      );
      await page.getByRole('button', { name: 'Undo view change', exact: true }).click();
      await expect
        .poll(() => card.evaluate((e) => Math.round(e.getBoundingClientRect().height)))
        .toBe(initialHeight);
      await page.getByRole('button', { name: 'Redo view change', exact: true }).click();
      await expect
        .poll(() => card.evaluate((e) => Math.round(e.getBoundingClientRect().height)))
        .toBe(initialHeight + 20);
      const rowsHandle = section.getByRole('button', {
        name: new RegExp(`^Resize visible rows in ${sectionId}(?:,|$)`),
      });
      await rowsHandle.focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts[sectionId].rows)
        .toBe(3);
      assert.equal(
        Math.round((await card.boundingBox()).height),
        initialHeight + 20,
        'Changing rows changed card height',
      );
      await rowsHandle.focus();
      await page.keyboard.press('ArrowUp');
      await section
        .getByRole('button', { name: `Next panels in ${sectionId}`, exact: true })
        .click();
      await expect(
        section.getByRole('article', { name: 'Layout panel 8', exact: true }),
      ).toBeVisible();
      await top(page);
      const colorButton = page.locator('#run-list .run-color-button').first();
      const runId = await toggle(page, 'visible', 0).getAttribute('data-id');
      await colorButton.click();
      const picker = page.getByRole('dialog', { name: /^Color for / });
      await expect(
        picker.getByRole('slider', { name: 'Saturation and brightness', exact: true }),
      ).toBeVisible();
      await picker.getByRole('textbox', { name: 'Hex color', exact: true }).fill('#227744');
      await expect
        .poll(async () => (await persisted(viewId)).body.runColors[runId])
        .toBe('#227744');
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
      await expect(colorButton).toBeFocused();
      await page.reload();
      await workspace(page);
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts[sectionId].height)
        .toBe(initialHeight + 20);
      await colorButton.click();
      await expect(picker.getByRole('textbox', { name: 'Hex color', exact: true })).toHaveValue(
        '#227744',
      );
      await picker.getByRole('button', { name: 'Reset to automatic', exact: true }).click();
      await expect
        .poll(async () => (await persisted(viewId)).body.runColors?.[runId])
        .toBeUndefined();
      await assertNestedBounds(page);
      await section
        .getByRole('button', { name: `${sectionId} section actions`, exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Rename section', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Section name', exact: true })
        .fill('Comparison metrics');
      await page.getByRole('textbox', { name: 'Section name', exact: true }).press('Enter');
      await expect
        .poll(
          async () =>
            (await persisted(viewId)).body.sections?.find((s) => s.id === sectionId)?.name,
        )
        .toBe('Comparison metrics');
      await section.locator('.section-toggle').click();
      await expect(section.getByRole('article')).toHaveCount(0);
      await section.locator('.section-toggle').click();
      await expect(section.getByRole('article').first()).toBeVisible();
      await pressSectionButton(section, 'Comparison metrics section actions');
      await page.getByRole('menuitem', { name: 'Add section below', exact: true }).click();
      await expect.poll(async () => (await persisted(viewId)).body.sections.length).toBe(2);
      const otherId = (await persisted(viewId)).body.sections.find((s) => s.id !== sectionId).id;
      const otherSection = page.locator(`[data-section-id="${otherId}"]`);
      await pressSectionButton(otherSection, 'New section section actions');
      await page.getByRole('menuitem', { name: 'Rename section', exact: true }).click();
      await page.getByRole('textbox', { name: 'Section name', exact: true }).fill('Other metrics');
      await page.getByRole('textbox', { name: 'Section name', exact: true }).press('Enter');
      await pressSectionButton(otherSection, 'Other metrics section actions');
      await page.getByRole('menuitem', { name: 'Move section up', exact: true }).click();
      await expect.poll(async () => (await persisted(viewId)).body.sections[0].id).toBe(otherId);
      await section
        .getByRole('button', { name: 'Previous panels in Comparison metrics', exact: true })
        .click();
      await openPanelSettings(page.locator('main'), 'Layout panel 0');
      const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
      await editor.getByRole('combobox', { name: 'Section', exact: true }).selectOption(otherId);
      await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
      await expect(editor).not.toBeVisible();
      await expect(
        otherSection.getByRole('article', { name: 'Layout panel 0', exact: true }),
      ).toBeVisible();
      await pressSectionButton(otherSection, 'Other metrics section actions');
      await page.getByRole('menuitem', { name: 'Delete section', exact: true }).click();
      await expect.poll(async () => (await persisted(viewId)).body.panels.length).toBe(8);
      await expect(otherSection).toHaveCount(0);
      await page.getByRole('button', { name: 'Undo view change', exact: true }).click();
      await expect.poll(async () => (await persisted(viewId)).body.panels.length).toBe(9);
      await expect(
        otherSection.getByRole('article', { name: 'Layout panel 0', exact: true }),
      ).toBeVisible();
    },
  );

  await check(
    'resize every section from non-first corners; preview geometry, sparse counts and responsive restore',
    fixture,
    async ({ page, viewId }) => {
      await resizeFixture(page, viewId, fixture.metric);
      for (const id of ['dense', 'sparse', 'pair']) {
        const section = page.locator(`[data-section-id="${id}"]`);
        const cards = section.getByRole('article');
        const first = await cards.first().boundingBox();
        const sameRow = await cards.evaluateAll((es) => {
          const top = es[0].getBoundingClientRect().top;
          return es.filter((e) => Math.abs(e.getBoundingClientRect().top - top) < 2).length;
        });
        const target = cards.nth(id === 'dense' ? (await cards.count()) - 1 : sameRow - 1);
        const targetId = await target.getAttribute('data-panel-id');
        const handle = target.getByRole('button', {
          name: /^Resize (?:.* panels, |panels in section$)/,
        });
        await handle.scrollIntoViewIfNeeded();
        await expect(target.locator('canvas')).toHaveCount(1);
        const renderer = await target.locator('canvas').elementHandle();
        // Widen the rightmost card enough to reduce columns; sparse sections still have one.
        await beginResize(page, handle, first.width * (id === 'dense' ? 0.65 : -0.5), 45);
        const preview = page.locator('.resize-preview');
        await expect(preview).toBeVisible();
        const ghost = await preview.boundingBox();
        const grid = await section.locator('.section-grid').boundingBox();
        assert.ok(
          ghost.x >= grid.x - 1 && ghost.x + ghost.width <= grid.x + grid.width + 1,
          `${id}: preview escaped section horizontally: ghost=${JSON.stringify(ghost)}, grid=${JSON.stringify(grid)}`,
        );
        const original = await target.boundingBox();
        near(original.height, first.height, `${id}: drag changed chart before release`);
        assert.ok(
          await renderer.evaluate((canvas) => canvas.isConnected),
          `${id}: preview rebuilt the chart renderer`,
        );
        await renderer.dispose();
        await page.mouse.up();
        await expect(preview).toHaveCount(0);
        await expect
          .poll(async () => (await persisted(viewId)).body.sectionLayouts?.[id]?.height)
          .toBe(345);
        const committed = await page.locator(`[data-panel-id="${targetId}"]`).boundingBox();
        near(committed.width, ghost.width, `${id}: committed width differs from preview`);
        near(committed.height, ghost.height, `${id}: committed height differs from preview`);
        near(committed.x, ghost.x, `${id}: committed horizontal position differs from preview`);
        // Browser scrolling may move the whole section when its height changes. Compare relative positions.
        const afterGrid = await section.locator('.section-grid').boundingBox();
        near(
          committed.y - afterGrid.y,
          ghost.y - grid.y,
          `${id}: committed row differs from preview`,
        );
        const sizes = await cards.evaluateAll((es) =>
          es.map((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]),
        );
        assert.ok(
          sizes.every(
            ([w, h]) => Math.abs(w - committed.width) < 2 && Math.abs(h - committed.height) < 2,
          ),
          `${id}: cards no longer share section geometry`,
        );
      }
      const saved = structuredClone((await persisted(viewId)).body.sectionLayouts);
      const dense = page.locator('[data-section-id="dense"]');
      const desktopWidth = (await dense.getByRole('article').first().boundingBox()).width;
      await page.setViewportSize({ width: 320, height: 850 });
      await assertNestedBounds(page);
      await expect
        .poll(async () =>
          dense
            .locator('.charts')
            .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length),
        )
        .toBe(1);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect
        .poll(async () =>
          Math.round((await dense.getByRole('article').first().boundingBox())?.width || 0),
        )
        .toBe(Math.round(desktopWidth));
      assert.deepEqual(
        (await persisted(viewId)).body.sectionLayouts,
        saved,
        'Responsive reflow overwrote stored geometry',
      );
      // Changing only height in a one-column mobile layout must retain the desktop width preference.
      await page.setViewportSize({ width: 320, height: 850 });
      const mobileCorner = dense
        .getByRole('article')
        .first()
        .getByRole('button', { name: /^Resize (?:.* panels, |panels in section$)/ });
      await mobileCorner.focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts?.dense?.height)
        .toBe(365);
      assert.equal(
        (await persisted(viewId)).body.sectionLayouts.dense.width,
        saved.dense.width,
        'Height-only mobile keyboard resize changed desktop width preference',
      );
      await beginResize(page, mobileCorner, 0, 25);
      await page.mouse.up();
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts?.dense?.height)
        .toBe(390);
      assert.equal(
        (await persisted(viewId)).body.sectionLayouts.dense.width,
        saved.dense.width,
        'Height-only mobile pointer resize changed desktop width preference',
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect
        .poll(async () =>
          Math.round((await dense.getByRole('article').first().boundingBox())?.width || 0),
        )
        .toBe(Math.round(desktopWidth));
      saved.dense.height = 390;
      await page.reload();
      await workspace(page);
      assert.deepEqual(
        (await persisted(viewId)).body.sectionLayouts,
        saved,
        'Section dimensions did not survive reload',
      );
    },
  );

  await check(
    'resize cancellation, no-op clicks and scroll coordinates preserve layout',
    fixture,
    async ({ page, viewId }) => {
      await resizeFixture(page, viewId, fixture.metric);
      const section = page.locator('[data-section-id="pair"]');
      const handle = section
        .getByRole('article')
        .last()
        .getByRole('button', { name: /^Resize (?:.* panels, |panels in section$)/ });
      const baseline = await persisted(viewId);
      await handle.click();
      await page.waitForTimeout(700);
      assert.equal(
        (await persisted(viewId)).version,
        baseline.version,
        'No-op corner click saved a view change',
      );
      for (const cancel of ['Escape', 'pointercancel']) {
        await beginResize(page, handle, -100, 65);
        await expect(page.locator('.resize-preview')).toBeVisible();
        if (cancel === 'Escape') await page.keyboard.press('Escape');
        else await handle.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
        await page.mouse.up();
        await expect(page.locator('.resize-preview')).toHaveCount(0);
        await page.waitForTimeout(700);
        assert.equal(
          (await persisted(viewId)).version,
          baseline.version,
          `${cancel} saved a cancelled drag`,
        );
      }
      await beginResize(page, handle, 0, 35);
      const preview = page.locator('.resize-preview');
      const before = await preview.boundingBox();
      const beforeGrid = await section.locator('.section-grid').boundingBox();
      // Scroll during the gesture as well as starting from a section below the fold.
      const beforeScroll = await page.locator('main').evaluate((e) => e.scrollTop);
      assert.ok(beforeScroll > 120, 'Fixture must exercise a section below the fold');
      await page.locator('main').evaluate((e) => {
        e.scrollTop -= 120;
      });
      await expect
        .poll(() => page.locator('main').evaluate((e) => e.scrollTop))
        .toBeLessThan(beforeScroll);
      await expect
        .poll(async () => {
          const ghost = await preview.boundingBox();
          const grid = await section.locator('.section-grid').boundingBox();
          return Math.abs(ghost.y - grid.y - (before.y - beforeGrid.y));
        })
        .toBeLessThan(2);
      const current = await preview.boundingBox();
      await page.mouse.up();
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts?.pair?.height)
        .toBe(335);
      const committed = await section.getByRole('article').last().boundingBox();
      near(committed.width, current.width, 'Scrolled resize width mismatch');
      near(committed.height, current.height, 'Scrolled resize height mismatch');
      // The workspace has no horizontal scroller: global horizontal scroll must stay zero.
      await page.evaluate(() => window.scrollTo(200, window.scrollY));
      assert.equal(
        await page.evaluate(() => window.scrollX),
        0,
        'Workspace unexpectedly scrolls horizontally',
      );
      await page.setViewportSize({ width: 390, height: 850 });
      await handle.scrollIntoViewIfNeeded();
      const touchBox = await handle.boundingBox();
      const x = touchBox.x + touchBox.width / 2,
        y = touchBox.y + touchBox.height / 2;
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y + 30 }],
        });
        await expect(page.locator('.resize-preview')).toBeVisible();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect
          .poll(async () => (await persisted(viewId)).body.sectionLayouts?.pair?.height)
          .toBe(365);
        await expect(page.locator('.resize-preview')).toHaveCount(0);
      } finally {
        await cdp.detach();
      }
    },
  );

  await check(
    'partial last page row resize preserves card height and supports cancellation',
    fixture,
    async ({ page, viewId }) => {
      await resizeFixture(page, viewId, fixture.metric);
      const section = page.locator('[data-section-id="dense"]');
      const next = section.getByRole('button', { name: 'Next panels in Dense', exact: true });
      while (await next.isEnabled()) await next.click();
      const cards = section.getByRole('article');
      const initialHeight = (await cards.first().boundingBox()).height;
      const handle = section.getByRole('button', { name: /^Resize visible rows in Dense(?:,|$)/ });
      const version = (await persisted(viewId)).version;
      await handle.click();
      await page.waitForTimeout(700);
      assert.equal(
        (await persisted(viewId)).version,
        version,
        'No-op row-handle click saved a view change',
      );
      await beginResize(page, handle, 0, 30);
      await expect(page.locator('.resize-preview')).toContainText('1 row');
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(page.locator('.resize-preview')).toHaveCount(0);
      assert.equal(
        (await persisted(viewId)).version,
        version,
        'Cancelled last-page row drag saved',
      );
      await handle.focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(700);
      assert.equal((await persisted(viewId)).version, version, 'Left arrow changed row count');
      await page.keyboard.press('ArrowUp');
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts?.dense?.rows)
        .toBe(1);
      near(
        (await cards.first().boundingBox()).height,
        initialHeight,
        'Changing row capacity resized charts',
      );
      await expect(handle).toHaveAccessibleName('Resize visible rows in Dense, 1 row');
      await handle.focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(async () => (await persisted(viewId)).body.sectionLayouts?.dense?.rows)
        .toBe(2);
      await expect(handle).toHaveAccessibleName('Resize visible rows in Dense, 2 rows');
    },
  );

  await check(
    'automatic panel creation, removed metrics and hide patterns persist with recoverable validation',
    fixture,
    async ({ page, viewId }) => {
      await addLinePanel(page, fixture.metric, 'Generation fixture');
      const settings = async () => {
        await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
        const drawer = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
        await editorTab(drawer, 'Panel list');
        return drawer;
      };
      let drawer = await settings();
      await expect(drawer.getByRole('combobox', { name: 'New metrics', exact: true })).toHaveValue(
        'manual',
      );
      await drawer
        .getByRole('combobox', { name: 'New metrics', exact: true })
        .selectOption('automatic');
      await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
      await expect
        .poll(async () => (await persisted(viewId)).body.panels.length)
        .toBeGreaterThan(1);
      await expect.poll(async () => (await persisted(viewId)).body.generation).toBe('automatic');
      const card = page.getByRole('article', { name: 'Generation fixture', exact: true });
      await card.getByRole('button', { name: 'Panel actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete panel', exact: true }).click();
      await expect
        .poll(async () => (await persisted(viewId)).body.hiddenMetrics)
        .toContain(fixture.metric);
      await expect(card).toHaveCount(0);
      await page.reload();
      await workspace(page);
      assert.ok(
        !(await persisted(viewId)).body.panels.some((panel) => panel.metric === fixture.metric),
        'Automatic generation recreated a deliberately removed metric',
      );
      drawer = await settings();
      await drawer.getByRole('button', { name: 'Restore 1 removed metric', exact: true }).click();
      await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
      await expect
        .poll(async () =>
          (await persisted(viewId)).body.panels.some((panel) => panel.metric === fixture.metric),
        )
        .toBe(true);
      const beforePattern = await persisted(viewId);
      drawer = await settings();
      await drawer.getByRole('textbox', { name: 'Hide panels matching', exact: true }).fill('[');
      await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
      await expect(
        drawer.getByText('Enter a valid regular expression.', { exact: true }),
      ).toBeVisible();
      await expect(
        drawer.getByRole('textbox', { name: 'Hide panels matching', exact: true }),
      ).toHaveValue('[');
      assert.equal(
        (await persisted(viewId)).version,
        beforePattern.version,
        'Invalid pattern changed persisted settings',
      );
      await drawer.getByRole('textbox', { name: 'Hide panels matching', exact: true }).fill('.*');
      await drawer
        .getByRole('combobox', { name: 'New metrics', exact: true })
        .selectOption('manual');
      await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
      await expect.poll(async () => (await persisted(viewId)).body.hidePattern).toBe('.*');
      await expect(page.locator('main').getByRole('article')).toHaveCount(0);
      assert.equal(
        (await persisted(viewId)).body.panels.length,
        beforePattern.body.panels.length,
        'Hide pattern deleted stored panels',
      );
      await page.reload();
      await workspace(page);
      drawer = await settings();
      await expect(drawer.getByRole('combobox', { name: 'New metrics', exact: true })).toHaveValue(
        'manual',
      );
      await expect(
        drawer.getByRole('textbox', { name: 'Hide panels matching', exact: true }),
      ).toHaveValue('.*');
      await drawer.getByRole('textbox', { name: 'Hide panels matching', exact: true }).fill('');
      await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
      await expect(page.locator('main').getByRole('article').first()).toBeVisible();
    },
  );

  await check(
    'bulk run tags, stop, delete and undo preserve independent comparison selection',
    fixture,
    async ({ page }) => {
      const entity = 'browser-verification',
        projectName = `bulk-${randomUUID()}`;
      const project = `${entity}/${projectName}`;
      const ids = ['first', 'second'].map((name) => `${project}/${name}`);
      const ownView = await createView(project);
      try {
        for (const [index, id] of ids.entries()) {
          await call('/graphql', {
            query: 'mutation UpsertBucket { upsertBucket }',
            variables: {
              entity,
              project: projectName,
              name: id.split('/').at(-1),
              displayName: `Bulk fixture ${index + 1}`,
            },
          });
          await call(`/files/${id}/file_stream`, {
            files: {
              'wandb-history.jsonl': {
                offset: 0,
                content: [JSON.stringify({ _step: 0, loss: index + 1 })],
              },
            },
          });
        }
        await call('/api/tools/runs_select', { view: ownView.id, visible: [ids[0]], solo: [] });
        await page.goto(`${baseURL}/${project}/workspace?view=${ownView.id}`);
        await workspace(page);
        await page
          .getByRole('navigation', { name: 'Project pages', exact: true })
          .getByRole('button', { name: 'Runs', exact: true })
          .click();
        const batch = page.getByRole('region', { name: 'Selected run actions', exact: true });
        const selectAll = page.getByRole('checkbox', { name: 'Select listed runs', exact: true });
        const firstRun = page.getByRole('checkbox', { name: 'Select Bulk fixture 1', exact: true });
        const secondRun = page.getByRole('checkbox', {
          name: 'Select Bulk fixture 2',
          exact: true,
        });
        await firstRun.focus();
        await firstRun.press('Space');
        await expect(firstRun).toBeChecked();
        await secondRun.focus();
        await secondRun.press('Space');
        await expect(secondRun).toBeChecked();
        await expect(firstRun).toBeChecked();
        await expect(selectAll).toBeChecked();
        await expect(batch).toContainText('2 selected');
        await selectionSaved(ownView.id, [ids[0]], []);
        await batch.getByRole('button', { name: 'Tags', exact: true }).click();
        let tags = page.getByRole('dialog', { name: 'Edit tags', exact: true });
        await tags.getByRole('combobox', { name: 'Tag', exact: true }).fill('browser-tag');
        await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
        await expect
          .poll(async () =>
            Promise.all(
              ids.map(async (id) =>
                JSON.parse((await call(`/api/run?id=${encodeURIComponent(id)}`)).run.tags),
              ),
            ),
          )
          .toEqual([['browser-tag'], ['browser-tag']]);
        await expect(batch).toContainText('2 selected');
        await expect(selectAll).toBeChecked();
        await batch.getByRole('button', { name: 'Tags', exact: true }).click();
        tags = page.getByRole('dialog', { name: 'Edit tags', exact: true });
        await tags.getByRole('combobox', { name: 'Tag', exact: true }).fill('browser-tag');
        await page.getByRole('option', { name: 'browser-tag', exact: true }).click();
        await tags.getByRole('button', { name: 'Remove tag', exact: true }).click();
        await expect
          .poll(async () =>
            Promise.all(
              ids.map(async (id) =>
                JSON.parse((await call(`/api/run?id=${encodeURIComponent(id)}`)).run.tags),
              ),
            ),
          )
          .toEqual([[], []]);
        await expect(batch).toContainText('2 selected');
        await expect(selectAll).toBeChecked();
        await batch.getByRole('button', { name: 'Stop', exact: true }).click();
        // Stopping asks for confirmation first.
        const stopDialog = page.getByRole('dialog', { name: 'Stop 2 runs?', exact: true });
        await stopDialog.getByRole('button', { name: 'Stop runs', exact: true }).click();
        await expect(stopDialog).toBeHidden();
        await expect
          .poll(async () =>
            Promise.all(
              ids.map(
                async (id) =>
                  (await call(`/api/run?id=${encodeURIComponent(id)}`)).run.stop_requested,
              ),
            ),
          )
          .toEqual([1, 1]);
        await expect(batch).toContainText('2 selected');
        await expect(selectAll).toBeChecked();
        await batch.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect
          .poll(
            async () => (await call('/api/runs')).runs.filter((run) => ids.includes(run.id)).length,
          )
          .toBe(0);
        const undo = page
          .locator('.operation-toast')
          .getByRole('button', { name: 'Undo', exact: true });
        await expect(undo).toBeVisible();
        await undo.click();
        await expect
          .poll(
            async () => (await call('/api/runs')).runs.filter((run) => ids.includes(run.id)).length,
          )
          .toBe(2);
        await expect(selectAll).toBeVisible();
        await selectionSaved(ownView.id, [ids[0]], []);
        for (const id of ids)
          assert.equal(
            (await call(`/api/run?id=${encodeURIComponent(id)}`)).run.history_count,
            1,
            'Delete/undo lost run history',
          );
      } finally {
        await call('/api/tools/runs_update', { ids, action: 'delete' });
        await call('/api/tools/project_update', { id: project, name: projectName, archived: true });
        await call(`/api/views/${ownView.id}`, undefined, 'DELETE');
        ownedViews.delete(ownView.id);
      }
    },
  );

  await check(
    'all accent presets maintain rendered button contrast in both themes',
    fixture,
    async ({ page }) => {
      await page.getByRole('button', { name: 'App settings', exact: true }).click();
      let dialog = page.locator('[role="dialog"]:visible');
      const names = await dialog
        .getByRole('radio')
        .evaluateAll((elements) => elements.map((e) => e.closest('label').textContent.trim()));
      assert.ok(names.length >= 2, 'Accent palette is missing');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      for (const dark of [true, false]) {
        for (const name of names) {
          await page.getByRole('button', { name: 'App settings', exact: true }).click();
          dialog = page.locator('[role="dialog"]:visible');
          const appearance = dialog.getByRole('combobox', { name: 'Theme', exact: true });
          await expect(appearance.locator('option')).toHaveText(['System', 'Light', 'Dark']);
          await appearance.selectOption(dark ? 'g100' : 'g10');
          await expect(appearance).toHaveValue(dark ? 'g100' : 'g10');
          await dialog.getByRole('radio', { name, exact: true }).check();
          await dialog.getByRole('button', { name: 'Close', exact: true }).click();
          await expect(page.locator('html')).toHaveAttribute('theme', dark ? 'g100' : 'g10');
          const button = page.getByRole('button', { name: 'Add panel', exact: true }).first();
          await page.mouse.move(0, 0);
          await expect
            .poll(() => primaryContrast(button), {
              message: `${name} ${dark ? 'dark' : 'light'} normal text contrast`,
            })
            .toBeGreaterThanOrEqual(4.5);
          await button.hover();
          await expect
            .poll(() => primaryContrast(button), {
              message: `${name} ${dark ? 'dark' : 'light'} hover text contrast`,
            })
            .toBeGreaterThanOrEqual(4.5);
          await page.mouse.down();
          try {
            await expect
              .poll(() => primaryContrast(button), {
                message: `${name} ${dark ? 'dark' : 'light'} pressed text contrast`,
              })
              .toBeGreaterThanOrEqual(4.5);
          } finally {
            // Release outside the button so this state check cannot open its dialog.
            await page.mouse.move(0, 0);
            await page.mouse.up();
          }
          const selectedVisibility = page
            .locator('[data-toggle="visible"][aria-pressed="true"]')
            .first();
          await expect
            .poll(() => primaryContrast(selectedVisibility), {
              message: `${name} ${dark ? 'dark' : 'light'} selected icon contrast`,
            })
            .toBeGreaterThanOrEqual(3);
        }
      }
      const before = await page.evaluate(() => ({
        theme: localStorage.getItem('randl.theme'),
        accent: localStorage.getItem('randl.accent'),
      }));
      await page.reload();
      await workspace(page);
      await expect(page.locator('html')).toHaveAttribute('theme', before.theme);
      assert.equal(await page.evaluate(() => localStorage.getItem('randl.accent')), before.accent);
    },
  );

  await check(
    'Runs table shares the query and columns while workspace controls comparison',
    fixture,
    async ({ page, viewId }) => {
      await addLinePanel(page, fixture.metric, 'Shared selection chart');
      const ids = await rowIds(page, 3);
      const target = fixture.runs.find((run) => run.id === ids[0]);
      const before = await persisted(viewId);
      await page
        .getByRole('searchbox', { name: 'Search runs by name or ID', exact: true })
        .fill(target.name);
      await expect(page.locator('.side-footer')).toContainText('1 visible');
      // Searching is per-tab state: it saves nothing to the view.
      await page.waitForTimeout(400);
      assert.equal((await persisted(viewId)).version, before.version);
      assert.equal((await persisted(viewId)).body.runQuery?.search, undefined);
      const remaining = before.body.visible.filter((id) => id !== target.id);
      const sidebarRow = page.locator('[data-run-id="' + target.id + '"]');
      await sidebarRow.locator('[data-toggle="visible"]').focus();
      await page.keyboard.press('Space');
      await selectionSaved(viewId, remaining, []);
      await sidebarRow.locator('[data-toggle="solo"]').click();
      await selectionSaved(viewId, remaining, [target.id]);
      await page
        .getByRole('navigation', { name: 'Project pages', exact: true })
        .getByRole('button', { name: 'Runs', exact: true })
        .click();
      const table = page.locator('.runs-table-region');
      await expect(
        page.getByRole('searchbox', { name: 'Search runs by name or ID', exact: true }),
      ).toHaveValue(target.name);
      await expect(table.locator('[data-table-toggle]')).toHaveCount(0);
      await expect(
        table.getByRole('button', { name: /Toggle (visibility|solo) for listed runs/ }),
      ).toHaveCount(0);
      const selectRun = table.getByRole('checkbox', {
        name: 'Select ' + target.display_name,
        exact: true,
      });
      await table.locator('label[for="' + (await selectRun.getAttribute('id')) + '"]').click();
      await expect(selectRun).toBeChecked();
      await expect(page.getByRole('region', { name: 'Selected run actions' })).toContainText(
        '1 selected',
      );
      await selectionSaved(viewId, remaining, [target.id]);
      await page
        .getByRole('region', { name: 'Selected run actions' })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      await page.getByRole('button', { name: 'Columns', exact: true }).click();
      await page
        .getByRole('combobox', { name: 'Visible columns', exact: true })
        .fill('config.seed');
      const seed = page.getByRole('option', { name: 'Config · seed', exact: true });
      await expect(seed).toBeVisible();
      if ((await seed.getAttribute('aria-selected')) !== 'true') await seed.click();
      await page
        .getByRole('dialog', { name: 'Run columns', exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect
        .poll(async () => (await persisted(viewId)).body.runQuery?.columns)
        .toContain('config.seed');
      await expect(table.getByRole('button', { name: 'Config · seed', exact: true })).toBeVisible();
      await page
        .getByRole('searchbox', { name: 'Search runs by name or ID', exact: true })
        .fill('');
      await page
        .locator('.runs-table-toolbar')
        .getByRole('button', { name: 'Group', exact: true })
        .click();
      await page.getByRole('combobox', { name: 'Group by', exact: true }).fill('learning_rate');
      await page.getByRole('option', { name: 'Config · learning_rate', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Group runs', exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect
        .poll(async () => (await persisted(viewId)).body.runQuery?.group)
        .toBe('config.learning_rate');
      // Run list grouping organizes the list; charts keep their own grouping.
      assert.notEqual((await persisted(viewId)).body.plotSettings?.groupBy, 'config.learning_rate');
      await expect(table.locator('.table-group')).toHaveCount(1);
      await expect(table.getByRole('button', { name: /^Visibility for group / })).toHaveCount(0);
      await expect(table.getByRole('button', { name: /^Solo group / })).toHaveCount(0);
      const groupCheckbox = table.getByRole('checkbox', { name: /^Select group / });
      await table.locator('label[for="' + (await groupCheckbox.getAttribute('id')) + '"]').click();
      await expect(groupCheckbox).toBeChecked();
      await expect(page.getByRole('region', { name: 'Selected run actions' })).toContainText(
        `${fixture.runs.length} selected`,
      );
      await selectionSaved(viewId, remaining, [target.id]);
      await page
        .getByRole('region', { name: 'Selected run actions' })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      const values = (
        await call('/api/run-values', {
          runs: fixture.runs.map((run) => run.id),
          fields: ['config.seed'],
        })
      ).runs;
      const targetSeed = values.find((run) => run.id === target.id).values['config.seed'];
      const expectedMatches = values.filter(
        (run) => run.values['config.seed'] === targetSeed,
      ).length;
      await page
        .locator('.runs-table-toolbar')
        .getByRole('button', { name: 'Filter', exact: true })
        .click();
      const filter = page.getByRole('dialog', { name: 'Filter runs', exact: true });
      await expect(filter.locator('.filter-rule')).toHaveCount(1);
      const field = filter.getByRole('combobox', { name: 'Field', exact: true });
      const condition = filter.getByRole('combobox', { name: 'Condition', exact: true });
      const selectField = async (name) => {
        const labels = {
          state: 'State',
          created: 'Created',
          tags: 'Tags',
          display_name: 'Run name',
          'config.seed': 'Config · seed',
        };
        await field.fill(name);
        await page.getByRole('option', { name: labels[name], exact: true }).click();
      };
      await selectField('state');
      assert.deepEqual(
        await condition.locator('option').evaluateAll((es) => es.map((e) => e.value)),
        ['eq', 'ne', 'exists'],
      );
      await filter.getByRole('combobox', { name: 'Value', exact: true }).selectOption('finished');
      await condition.selectOption('exists');
      await expect(filter.getByRole('combobox', { name: 'Value', exact: true })).toBeDisabled();
      await condition.selectOption('ne');
      await selectField('created');
      await expect(filter.getByLabel('Date and time', { exact: true })).toHaveValue('');
      await selectField('tags');
      assert.deepEqual(
        await condition.locator('option').evaluateAll((es) => es.map((e) => e.value)),
        ['contains', 'exists'],
      );
      await expect(condition).toHaveValue('contains');
      await selectField('display_name');
      assert.deepEqual(
        await condition.locator('option').evaluateAll((es) => es.map((e) => e.value)),
        ['eq', 'ne', 'contains', 'exists'],
      );
      await selectField('config.seed');
      assert.deepEqual(
        await condition.locator('option').evaluateAll((es) => es.map((e) => e.value)),
        ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'],
      );
      await condition.selectOption('eq');
      for (const width of [600, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() =>
            filter
              .locator('.filter-rule')
              .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length),
          )
          .toBe(2);
        await assertNestedBounds(page);
        const fieldBox = await field.boundingBox(),
          conditionBox = await condition.boundingBox();
        const valueBox = await filter
          .getByRole('combobox', { name: 'Value', exact: true })
          .boundingBox();
        assert.ok(
          fieldBox.y + fieldBox.height <= conditionBox.y + 1 &&
            conditionBox.y + conditionBox.height <= valueBox.y + 1,
          `${width}px filter fields are not in readable vertical order`,
        );
        const popover = await filter.boundingBox();
        assert.ok(
          popover.x >= 0 && popover.x + popover.width <= width + 1,
          `${width}px filter popover escapes viewport`,
        );
        await expect(
          filter.getByRole('button', { name: 'Apply filters', exact: true }),
        ).toBeVisible();
        const removeCondition = filter.getByRole('button', {
          name: 'Remove condition',
          exact: true,
        });
        await removeCondition.hover();
        await expect(removeCondition).toHaveAttribute('title', 'Remove condition');
        await expect(page.locator('.bx--tooltip-portal__content')).toHaveCount(0);
        await assertNestedBounds(page);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await field.fill('config.seed');
      await page.getByRole('option', { name: 'Config · seed', exact: true }).click();
      await filter.getByRole('combobox', { name: 'Value', exact: true }).fill(String(targetSeed));
      await page.getByRole('option', { name: String(targetSeed), exact: true }).click();
      await filter.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await expect
        .poll(async () => (await persisted(viewId)).body.filters)
        .toEqual([{ field: 'config.seed', operator: 'eq', value: String(targetSeed) }]);
      await page
        .getByRole('navigation', { name: 'Project pages', exact: true })
        .getByRole('button', { name: 'Workspace', exact: true })
        .click();
      await expect(
        page.getByRole('searchbox', { name: 'Search runs by name or ID', exact: true }),
      ).toHaveValue('');
      await expect(page.locator('.run-group')).toHaveCount(1);
      await expect(page.locator('.side-footer')).toContainText(
        `${expectedMatches} of ${fixture.runs.length} runs`,
      );
      await expect(page.locator('.side-footer')).toContainText('1 soloed');
      await page.getByRole('button', { name: 'Clear solo', exact: true }).click();
      await selectionSaved(viewId, remaining, []);
      await expect(page.locator('.side-footer')).toContainText('0 visible');
      await page
        .locator('aside')
        .getByRole('button', { name: /^Filter/ })
        .click();
      await page
        .getByRole('dialog', { name: 'Filter runs', exact: true })
        .getByRole('button', { name: 'Clear filters', exact: true })
        .click();
      await expect(page.locator('.side-footer')).toContainText(`${remaining.length} visible`);
      await page.reload();
      await workspace(page);
      await expect(page.locator('.run-group')).toHaveCount(1);
      await page
        .getByRole('navigation', { name: 'Project pages', exact: true })
        .getByRole('button', { name: 'Runs', exact: true })
        .click();
      await expect(table.getByRole('button', { name: 'Config · seed', exact: true })).toBeVisible();
      await assertNestedBounds(page);
      await page
        .getByRole('navigation', { name: 'Project pages', exact: true })
        .getByRole('button', { name: 'Workspace', exact: true })
        .click();
      await page.locator('aside').getByRole('button', { name: 'Group', exact: true }).click();
      await page.getByRole('combobox', { name: 'Group by', exact: true }).fill('config.seed');
      await page.getByRole('option', { name: 'Config · seed', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Group runs', exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect
        .poll(async () => (await persisted(viewId)).body.runQuery?.group)
        .toBe('config.seed');
      // Run list grouping organizes the list; charts keep their own grouping.
      assert.notEqual((await persisted(viewId)).body.plotSettings?.groupBy, 'config.seed');
      await expect(page.locator('.run-group').first()).not.toContainText('None');
      for (const kind of ['visible', 'solo']) {
        await page.locator('#run-list').evaluate((e) => {
          e.scrollTop = 0;
        });
        const buttons = page.locator(`[data-toggle="${kind}"]`);
        const nextIndex = await buttons.nth(1).getAttribute('data-index');
        await buttons.first().focus();
        await page.keyboard.press('ArrowDown');
        await expect(
          page.locator(`[data-toggle="${kind}"][data-index="${nextIndex}"]`),
        ).toBeFocused();
      }
    },
  );
  await check(
    'layered navigation, breadcrumbs and contextual settings preserve the workspace',
    fixture,
    async ({ page, viewId }) => {
      await addLinePanel(page, fixture.metric, 'Context comparison');
      const rail = page.getByRole('navigation', { name: 'Project pages', exact: true });
      const initialRailWidth = (await rail.boundingBox()).width;
      const initialRunsWidth = (await page.locator('aside').boundingBox()).width;
      await page.getByRole('button', { name: 'Expand project navigation', exact: true }).click();
      assert.ok((await rail.boundingBox()).width > initialRailWidth);
      assert.equal(
        (await page.locator('aside').boundingBox()).width,
        initialRunsWidth,
        'Navigation expansion changed the selected sidebar width',
      );
      await page.getByRole('button', { name: 'Hide runs', exact: true }).click();
      await expect(page.locator('aside')).toHaveAttribute('inert', '');
      assert.ok(
        (await rail.boundingBox()).width > initialRailWidth,
        'Hiding runs collapsed project navigation',
      );
      await page.getByRole('button', { name: 'Show runs', exact: true }).click();
      await page.setViewportSize({ width: 761, height: 900 });
      await expect(page.locator('aside')).toBeHidden();
      await page.getByRole('button', { name: 'Show runs', exact: true }).click();
      await expect(page.locator('aside')).toBeVisible();
      await expect
        .poll(async () => Math.round((await rail.boundingBox()).width))
        .toBe(Math.round(initialRailWidth));
      await assertNestedBounds(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      const breadcrumbs = page.getByRole('navigation', { name: 'Breadcrumb', exact: true });
      await breadcrumbs.getByRole('link', { name: fixture.projectName, exact: true }).click();
      await page.waitForURL((url) => url.pathname.endsWith('/overview'));
      await expect(page.getByRole('combobox', { name: 'Saved view', exact: true })).toHaveCount(0);
      await page.goBack();
      await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', viewId);
      await breadcrumbs.getByRole('link', { name: 'Projects', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      await page.goBack();
      await expect(page.locator('.view-controls')).toHaveAttribute('data-view-id', viewId);
      const before = (await persisted(viewId)).body;
      await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Workspace settings', exact: true });
      await expect(drawer).toBeVisible();
      assert.ok(
        !(await page.locator('main').evaluate((e) => e.inert)),
        'Desktop settings prevent inspecting charts',
      );
      const bounds = await drawer.boundingBox(),
        main = await page.locator('main').boundingBox();
      assert.ok(
        main.x + main.width <= bounds.x + 1,
        'Settings drawer covers rather than accompanies charts',
      );
      await editorTab(drawer, 'Axes');
      await drawer.getByRole('combobox', { name: 'X axis', exact: true }).fill(fixture.metric);
      await page.getByRole('option', { name: fixture.metric, exact: true }).click();
      await expect.poll(() => displayedXAxis(page, 'Context comparison')).toBe(fixture.metric);
      assert.deepEqual((await persisted(viewId)).body, before, 'Preview was saved before Apply');
      await assertNestedBounds(page);
      await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(drawer).toHaveCount(0);
      await expect.poll(() => displayedXAxis(page, 'Context comparison')).toBe('Step');
      await openPanelSettings(page, 'Context comparison');
      for (const width of [1440, 900, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await assertNestedBounds(page);
        const dialog = page.getByRole('dialog', { name: 'Panel settings', exact: true });
        await expect(dialog.getByRole('button', { name: 'Save panel', exact: true })).toBeVisible();
      }
      await page
        .getByRole('dialog', { name: 'Panel settings', exact: true })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'App settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Panel plugins', exact: true }).click();
      const pluginDrawer = page.getByRole('dialog', { name: 'App settings', exact: true });
      const builtins = (await call('/api/plugins')).plugins.filter((plugin) => plugin.builtin);
      assert.ok(builtins.length > 0, 'Built-in plugin catalog is empty');
      for (const plugin of builtins) {
        const row = pluginDrawer
          .locator('.plugin-row')
          .filter({ has: page.getByText(plugin.name, { exact: true }) });
        await expect(
          row.getByRole('button', { name: plugin.enabled ? 'Disable' : 'Enable', exact: true }),
        ).toBeEnabled();
        await expect(row.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
        await expect(row.getByRole('button', { name: 'Uninstall', exact: true })).toHaveCount(0);
      }
      await pluginDrawer.getByRole('button', { name: 'Close', exact: true }).click();
    },
  );
} catch (error) {
  failures++;
  console.error(error.stack || error);
} finally {
  await browser?.close();
  for (const id of ownedViews) {
    try {
      await call(`/api/views/${encodeURIComponent(id)}`, undefined, 'DELETE');
    } catch (error) {
      failures++;
      console.error(`Cleanup failed for browser fixture ${id}: ${error.message}`);
    }
  }
  await api.dispose();
}
if (!checked && !failures) {
  failures++;
  console.error('No browser checks matched RANDL_BROWSER_FILTER.');
}
if (failures) process.exitCode = 1;
console.log(`Browser verification finished: ${checked} check(s), ${failures} failed.`);
