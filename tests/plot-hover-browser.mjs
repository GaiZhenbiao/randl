import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect, request } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';
const panelSettings = (page, title) =>
  page
    .getByRole('article', { name: title, exact: true })
    .getByRole('button', { name: 'Panel settings', exact: true });
async function openPanelSettings(page, title) {
  await page.getByRole('article', { name: title, exact: true }).hover();
  await panelSettings(page, title).click();
}

const expect = playwrightExpect.configure({ timeout: 10000 }),
  dir = await mkdtemp(join(tmpdir(), 'randl-hover-'));
let server, browser, api;
const checks = [];
try {
  server = await createServer(dir);
  const baseURL = await listen(server);
  api = await request.newContext({ baseURL });
  async function call(path, body, method = body ? 'POST' : 'GET') {
    const r = await api.fetch(path, { method, data: body });
    assert.ok(r.ok(), await r.text());
    return r.json();
  }
  const scope = 'test/hover',
    ids = [];
  for (let i = 0; i < 12; i++) {
    ids.push(scope + '/r' + i);
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: {
        entity: 'test',
        project: 'hover',
        name: 'r' + i,
        displayName:
          'experiment-with-a-long-descriptive-training-configuration-and-distinct-checkpoint-evaluation-suffix-seed-' +
          String(i).padStart(2, '0'),
      },
    });
    await call('/files/' + ids[i] + '/file_stream', {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: 60 }, (_, j) =>
            JSON.stringify({
              _step: j * 10 + i * 0.25,
              value: 12345678.9 + i * 100 + j,
              tokens: j * 100 + i,
              reverse: -(12345678.9 + i * 100 + j),
            }),
          ),
        },
      },
      complete: true,
      exitcode: 0,
    });
  }
  let view = await call('/api/tools/view_create', { project: scope, name: 'Hover inspection' });
  view.body = {
    ...view.body,
    generation: 'manual',
    visible: ids,
    panels: Array.from({ length: 8 }, (_, i) => ({
      id: 'hover' + i,
      section: i < 2 ? 's0' : 's' + i,
      plugin: 'line',
      metric: 'value',
      settings: {
        maxRuns: 20,
        smoothingMethod: 'ema',
        smoothingValue: 0.6,
        showOriginal: true,
        tooltipLimit: 4,
      },
    })),
    sections: Array.from({ length: 8 }, (_, i) => ({ id: 's' + i, name: 'Section ' + i })),
    sectionLayouts: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => ['s' + i, { width: 500, height: 300, rows: 1 }]),
    ),
  };
  view = await call(
    '/api/views/' + view.id,
    { name: view.name, project: scope, version: view.version, body: view.body },
    'PUT',
  );
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
  const panel = page.locator('[data-panel-id="hover0"]');
  await expect(panel.locator('canvas').first()).toBeVisible();
  async function geometry() {
    return panel.locator('[_echarts_instance_]').evaluate(async (host) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
      const mod = await import(url);
      const ec = Object.values(mod).find((v) => v?.getInstanceByDom),
        chart = ec.getInstanceByDom(host),
        rect = host.getBoundingClientRect();
      const a = chart.convertToPixel({ gridIndex: 0 }, [20, 12345900]),
        b = chart.convertToPixel({ gridIndex: 0 }, [570, 12345900]);
      return {
        a: { x: rect.left + a[0], y: rect.top + a[1] },
        b: { x: rect.left + b[0], y: rect.top + b[1] },
        colors: chart
          .getOption()
          .series.filter((s) => s.randlKey)
          .map((s) => s.itemStyle.color),
      };
    });
  }
  const g = await geometry();
  assert.equal(new Set(g.colors).size, 12, 'Selected runs have distinct chart colors');
  const hoveredPositions = new Set();
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(g.a.x + ((g.b.x - g.a.x) * i) / 39, g.a.y + (i % 3) * 5, { steps: 3 });
    const tip = page.locator('.plot-inspector[data-local="true"]:visible');
    await expect(tip).toBeVisible();
    assert.equal(
      (await tip.locator('.plot-inspector-row').count()) +
        Number(await tip.locator('.plot-inspector-more').getAttribute('data-remaining')),
      12,
    );
    await expect(tip.locator('.plot-inspector-heading')).toContainText('Step');
    hoveredPositions.add(await tip.locator('.plot-inspector-heading').textContent());
  }
  assert.ok(hoveredPositions.size >= 30, 'Cursor must keep moving when crossing the popup');
  checks.push('40 positions retain all 12 independently sampled runs with explicit overflow count');
  const tip = page.locator('.plot-inspector[data-local="true"]:visible');
  await expect(tip).toContainText('Original');
  await expect(tip).toContainText('Smoothed');
  assert.equal(await tip.evaluate((e) => e.scrollHeight <= e.clientHeight), true);
  assert.ok((await tip.locator('.plot-inspector-value').first().textContent()).includes('12,34'));
  assert.equal(await tip.locator('[data-nearest="true"]').count(), 1);
  checks.push('smoothed and original values, named X axis, large numeric values');
  await expect(page.locator('.plot-inspector[data-local="false"]:visible').first()).toBeVisible();
  checks.push('companion values appear by default without an explicit display preference');
  {
    // Runs here have offset sample positions, yet X appears only once per popup.
    const layout = await page.evaluate(() =>
      [...document.querySelectorAll('.plot-inspector:not([hidden])')].map((node) => {
        const rows = [...node.querySelectorAll('.plot-inspector-row')];
        const edges = (selector) =>
          rows.map((row) => row.querySelector(selector)?.getBoundingClientRect());
        const values = edges('.plot-inspector-value > span:first-child'),
          originals = edges('.plot-inspector-value > span + span'),
          labels = edges('.plot-inspector-label');
        const same = (boxes, side) =>
          boxes.every((box) => box && Math.abs(box[side] - boxes[0][side]) < 0.5);
        const panel = node.closest('[data-panel-id]')?.getBoundingClientRect();
        return {
          local: node.dataset.local,
          // A companion panel cut off by the viewport fits fewer rows by design.
          whole: !panel || (panel.top >= 0 && panel.bottom <= innerHeight),
          width: node.getBoundingClientRect().width,
          headings: node.querySelectorAll('.plot-inspector-heading').length,
          heading: node.querySelector('.plot-inspector-heading')?.textContent,
          rowX: node.querySelectorAll('.plot-inspector-row small').length,
          rows: rows.length,
          valuesAligned: same(values, 'right'),
          originalsAligned: node.dataset.local === 'false' || same(originals, 'right'),
          labelsAligned: same(labels, 'left') && same(labels, 'right'),
          columnsAligned:
            node.dataset.local === 'false' ||
            Math.abs(
              node.querySelector('.plot-inspector-columns > span').getBoundingClientRect().right -
                values[0].right,
            ) < 0.5,
        };
      }),
    );
    assert.ok(layout.length >= 2, JSON.stringify(layout));
    for (const popup of layout) {
      assert.equal(popup.headings, 1, JSON.stringify(popup));
      assert.match(popup.heading, /^Step /);
      assert.equal(popup.rowX, 0, JSON.stringify(popup));
      if (popup.whole) assert.ok(popup.rows > 1, JSON.stringify(popup));
      assert.ok(popup.width <= (popup.local === 'true' ? 300 : 220) + 0.5, JSON.stringify(popup));
      assert.ok(
        popup.valuesAligned &&
          popup.originalsAligned &&
          popup.labelsAligned &&
          popup.columnsAligned,
        JSON.stringify(popup),
      );
    }
    // The focused run's value is marked on the hovered chart and on linked charts.
    const dots = await page.evaluate(() =>
      [...document.querySelectorAll('.plot-inspector-point:not([hidden])')].map((dot) => {
        const host = dot.closest('[data-panel-id]');
        const tip = [...host.querySelectorAll('.plot-inspector'), ...document.body.children]
          .filter((n) => n.classList?.contains('plot-inspector') && !n.hidden)
          .find((n) => host.contains(n) || n.dataset.local === 'true');
        const box = dot.getBoundingClientRect();
        return {
          panel: host.dataset.panelId,
          color: getComputedStyle(dot).backgroundColor,
          size: box.width,
          nearest: tip?.querySelector('[data-nearest="true"] .plot-inspector-marker')?.style
            .background,
        };
      }),
    );
    assert.ok(dots.length >= 2, JSON.stringify(dots));
    for (const dot of dots) assert.equal(dot.color, dot.nearest, JSON.stringify(dot));
    const primaryDot = await panel.evaluate((host) => {
      const point = host.querySelector('.plot-inspector-point').getBoundingClientRect(),
        line = host.querySelector('.plot-inspector-cursor').getBoundingClientRect();
      return {
        dx: Math.abs(point.left + point.width / 2 - line.left),
        inside: point.top >= line.top - 4 && point.bottom <= line.bottom + 4,
      };
    });
    assert.ok(primaryDot.dx <= 6 && primaryDot.inside, JSON.stringify(primaryDot));
    // Repeated hovers reuse one marker per chart, and leaving hides every marker.
    const markersBefore = await page.locator('.plot-inspector-point').count();
    for (let i = 0; i < 20; i++)
      await page.mouse.move(g.a.x + ((g.b.x - g.a.x) * i) / 19, g.a.y, { steps: 1 });
    assert.equal(await page.locator('.plot-inspector-point').count(), markersBefore);
    await page.mouse.move(1, 1);
    await expect(page.locator('.plot-inspector-point:visible')).toHaveCount(0);
    await page.mouse.move(g.b.x, g.b.y, { steps: 3 });
  }
  checks.push(
    'one X heading per popup, aligned name/value/original columns, narrow widths and a focused-run dot that is reused and cleared',
  );
  const host = panel.locator('[_echarts_instance_]');
  await host.focus();
  await page.keyboard.press('Home');
  await expect(tip).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('Step');
  await expect(tip.locator('.plot-inspector-heading')).toHaveText('Step 0');
  await page.keyboard.press('End');
  await expect(tip.locator('.plot-inspector-heading')).toHaveText('Step 592.75');
  await page.keyboard.press('Escape');
  await expect(page.locator('.plot-inspector:visible')).toHaveCount(0);
  checks.push('keyboard point inspection and Escape');
  await page.mouse.move(g.a.x, g.a.y);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.locator('main').evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('.plot-inspector:visible')).toHaveCount(0);
  checks.push('plain wheel scrolls main content and dismisses hover');
  await panel.scrollIntoViewIfNeeded();
  const legend = panel.locator('.chart-legend');
  await legend.getByRole('button').first().focus();
  await page.keyboard.press('End');
  const last = legend.getByRole('button').last();
  await expect(last).toBeFocused();
  await page.keyboard.press('Space');
  await expect(last).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(panel.locator('canvas').first()).toBeVisible();
  await legend.getByRole('button').first().focus();
  await page.keyboard.press('End');
  await expect(legend.getByRole('button').last()).toHaveAttribute('aria-pressed', 'false');
  assert.equal(await legend.locator('[tabindex="0"]').count(), 1);
  checks.push(
    'legend last item reachable, single Tab stop, hidden selection persists after reload',
  );
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await mobile.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
  const mobilePanel = mobile.locator('[data-panel-id="hover0"]');
  await expect(mobilePanel.locator('canvas').first()).toBeVisible();
  const box = await mobilePanel.locator('[_echarts_instance_]').boundingBox();
  await mobile.touchscreen.tap(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await mobile.waitForTimeout(1100);
  await expect(mobile.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
  // Dismiss from the page gutter; the entire panel title is an active control.
  await mobile.touchscreen.tap(2, box.y + box.height * 0.5);
  await expect(mobile.getByRole('dialog', { name: 'Panel settings', exact: true })).toHaveCount(0);
  const cdp = await mobile.context().newCDPSession(mobile),
    touchX = box.x + box.width * 0.3,
    touchY = box.y + box.height * 0.5;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: touchX, y: touchY }],
  });
  const touchHeaders = new Set();
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: touchX + i * 20, y: touchY }],
    });
    await mobile.waitForTimeout(40);
    touchHeaders.add(
      await mobile.locator('.plot-inspector:visible .plot-inspector-heading').textContent(),
    );
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(touchHeaders.size >= 3, 'Horizontal touch movement scrubs values');
  await mobile.waitForTimeout(1100);
  await expect(mobile.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
  await mobile.locator('main').evaluate((e) => (e.scrollTop += 200));
  await expect(mobile.locator('.plot-inspector:visible')).toHaveCount(0);
  const bounds = await mobile.evaluate(() => ({
    w: innerWidth,
    body: document.documentElement.scrollWidth,
  }));
  assert.ok(bounds.body <= bounds.w);
  checks.push('touch tap, scroll dismissal and 390px viewport bounds');
  // Popup geometry is checked with both pointer types; narrow desktop windows
  // must remain readable without relying on a touch-only layout.
  view = await call('/api/views/' + view.id);
  for (const item of view.body.panels) {
    item.settings.tooltipLimit = 12;
  }
  view.body.panels[1].metric = 'reverse';
  view.body.sectionLayouts.s0.width = 360;
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: scope, version: view.version, body: view.body },
    'PUT',
  );
  for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']) {
    for (const [width, height, touch] of [
      [320, 568, false],
      [390, 844, false],
      [1280, 420, false],
      [1440, 900, false],
      [320, 568, true],
    ]) {
      const probe = await browser.newPage({
        viewport: { width, height },
        hasTouch: touch,
        isMobile: touch,
      });
      probe.on('pageerror', (e) => errors.push(e.message));
      await probe.addInitScript(
        (language) => localStorage.setItem('randl.language', language),
        lang,
      );
      await probe.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
      const target = probe.locator('[data-panel-id="hover0"]');
      await expect(target.locator('canvas').first()).toBeVisible();
      const canvas = target.locator('[_echarts_instance_]');
      const rect = await canvas.evaluate(async (host) => {
        const url = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
        const mod = await import(url),
          ec = Object.values(mod).find((v) => v?.getInstanceByDom);
        const grid = ec
          .getInstanceByDom(host)
          .getModel()
          .getComponent('grid')
          .coordinateSystem.getRect();
        const box = host.getBoundingClientRect();
        return { x: box.x + grid.x, y: box.y + grid.y, width: grid.width, height: grid.height };
      });
      const bottom = Math.min(height - 16, rect.y + rect.height - 4);
      const top = rect.y + 4;
      assert.ok(bottom > top, `${width}x${height}: plot visible`);
      for (let step = 0; step < 7; step++) {
        const x = rect.x + 4 + ((rect.width - 8) * step) / 6;
        const y = top + ((bottom - top) * ((step % 3) + 1)) / 4;
        if (touch) {
          await probe.touchscreen.tap(2, y);
          await probe.touchscreen.tap(x, y);
        } else await probe.mouse.move(x, y, { steps: 3 });
        const active = probe.locator('.plot-inspector[data-local="true"]:visible');
        if ((await active.count()) !== 1)
          console.error(
            'Missing inspection',
            { lang, width, height, step, x, y, rect },
            await probe.locator('.plot-inspector').evaluateAll((nodes) =>
              nodes.map((n) => ({
                hidden: n.hidden,
                local: n.dataset.local,
                style: n.getAttribute('style'),
                text: n.textContent,
                box: n.getBoundingClientRect().toJSON(),
              })),
            ),
          );
        await expect(active, `${lang} ${width}x${height} step${step}`).toHaveCount(1);
        const measured = await active.evaluate(
          (node, point) => {
            const box = node.getBoundingClientRect();
            const values = [...node.querySelectorAll('.plot-inspector-value > span')].map(
              (value) => {
                const range = document.createRange();
                range.selectNodeContents(value);
                const text = range.getBoundingClientRect();
                return { left: text.left, right: text.right, top: text.top, bottom: text.bottom };
              },
            );
            return {
              box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
              values,
              overflow: node.scrollHeight > node.clientHeight,
              covers:
                point.x >= box.left &&
                point.x <= box.right &&
                point.y >= box.top &&
                point.y <= box.bottom,
              gap: Math.max(box.left - point.x, point.x - box.right, 0),
              nearest: node.querySelectorAll('[data-nearest="true"]').length,
              count:
                node.querySelectorAll('.plot-inspector-row').length +
                Number(node.querySelector('.plot-inspector-more').dataset.remaining),
              coversHeading: [
                ...document.querySelectorAll(
                  '[data-panel-id="hover0"] .chart-header, [data-panel-id="hover0"] .chart-legend',
                ),
              ].some((element) => {
                const r = element.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  r.height > 0 &&
                  box.left < r.right &&
                  box.right > r.left &&
                  box.top < r.bottom &&
                  box.bottom > r.top
                );
              }),
            };
          },
          { x, y },
        );
        assert.ok(!measured.covers, JSON.stringify({ lang, width, height, step, measured }));
        assert.ok(!measured.overflow);
        assert.equal(measured.nearest, 1);
        assert.equal(measured.count, 12);
        if (width <= 390) assert.ok(measured.count >= 4);
        const actualRows = await active.locator('.plot-inspector-row').count();
        if (width <= 390)
          assert.ok(
            actualRows >= 4,
            JSON.stringify({ lang, width, height, step, actualRows, measured }),
          );
        const area = await probe.locator('main').boundingBox();
        assert.ok(
          measured.box.left >= Math.max(0, area.x) &&
            measured.box.right <= Math.min(width, area.x + area.width),
        );
        assert.ok(
          measured.box.top >= Math.max(0, area.y) &&
            measured.box.bottom <= Math.min(height, area.y + area.height),
        );
        assert.ok(measured.gap <= 24);
        assert.ok(
          measured.box.left >= 0 &&
            measured.box.right <= width &&
            measured.box.top >= 0 &&
            measured.box.bottom <= height,
        );
        for (const value of measured.values)
          assert.ok(
            value.left >= measured.box.left &&
              value.right <= measured.box.right &&
              value.top >= measured.box.top &&
              value.bottom <= measured.box.bottom,
            JSON.stringify({ lang, width, height, step, measured }),
          );
      }
      await probe.close();
    }
  }
  checks.push(
    'five-language mouse/touch popup geometry: values visible, nearest row retained, pointer clear, bounded overflow and horizontal distance',
  );

  for (const originalValues of [false, true]) {
    let fitting = await call('/api/tools/view_create', {
      project: scope,
      name: `Row fitting ${originalValues}`,
    });
    fitting.body = structuredClone(view.body);
    fitting.body.panels = [fitting.body.panels[0]];
    fitting.body.panels[0].settings = {
      ...fitting.body.panels[0].settings,
      tooltipLimit: 12,
      showOriginal: originalValues,
      smoothingMethod: originalValues ? 'ema' : 'none',
    };
    fitting = await call(
      '/api/views/' + fitting.id,
      { name: fitting.name, project: scope, version: fitting.version, body: fitting.body },
      'PUT',
    );
    for (const touch of [false, true]) {
      const probe = await browser.newPage({
        viewport: { width: 320, height: 568 },
        hasTouch: touch,
        isMobile: touch,
      });
      probe.on('pageerror', (e) => errors.push(e.message));
      await probe.goto(baseURL + '/' + scope + '/workspace?view=' + fitting.id);
      const target = probe.locator('[data-panel-id="hover0"]');
      await expect(target.locator('canvas').first()).toBeVisible();
      for (const offset of [0, 80, 120, 160]) {
        await probe.locator('main').evaluate((node, y) => {
          node.scrollTop = y;
        }, offset);
        await probe.waitForTimeout(60);
        const rect = await plotBounds(target),
          visibleTop = await probe.evaluate(visiblePanelTop);
        const top = Math.max(rect.top, visibleTop + 8),
          bottom = Math.min(rect.bottom, 560);
        if (bottom - top < 8) continue;
        for (let step = 0; step < 9; step++) {
          const x = rect.left + (rect.right - rect.left) * 0.5;
          const y = top + (bottom - top) * (0.05 + (0.9 * step) / 8);
          if (touch) {
            await probe.touchscreen.tap(2, y);
            await probe.touchscreen.tap(x, y);
          } else await probe.mouse.move(x, y);
          await assertInspection(
            probe,
            `row fit raw${originalValues} touch${touch} offset${offset} step${step}`,
            { y, gap: touch ? 28 : 12 },
          );
        }
        if (!touch) {
          await target.locator('[_echarts_instance_]').focus();
          for (const key of ['Home', 'ArrowRight', 'End']) {
            await probe.keyboard.press(key);
            const host = await target.locator('[_echarts_instance_]').boundingBox();
            await assertInspection(
              probe,
              `row fit keyboard raw${originalValues} offset${offset} ${key}`,
              { y: host.y + host.height / 2 },
            );
          }
        }
      }
      await probe.close();
    }
  }
  checks.push(
    'row fitting reserves omission-count space when every available row is within the tooltip limit',
  );
  const overlapCounts = [];
  for (const [companionWidth, companionHeight] of [
    [1440, 900],
    [1280, 420],
    [1024, 768],
  ]) {
    const companionPage = await browser.newPage({
      viewport: { width: companionWidth, height: companionHeight },
    });
    companionPage.on('pageerror', (e) => errors.push(e.message));
    await companionPage.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
    const companionPanel = companionPage.locator('[data-panel-id="hover0"]');
    await expect(companionPanel.locator('canvas').first()).toBeVisible();
    await expect(companionPage.locator('[data-panel-id="hover1"] canvas').first()).toBeVisible();
    const beforeScroll = await plotBounds(companionPanel);
    await companionPage.locator('main').evaluate((node, top) => {
      // Align the plot just below the sticky workspace toolbar.
      const visibleTop = Math.max(
        node.getBoundingClientRect().top,
        node.querySelector('.workspace-top').getBoundingClientRect().bottom,
      );
      node.scrollTop += Math.max(0, top - visibleTop - 8);
    }, beforeScroll.top);
    await companionPage.waitForTimeout(80);
    const firstPlot = await plotBounds(companionPanel);
    let overlapCases = 0;
    for (let i = 0; i < 9; i++) {
      await companionPage.mouse.move(
        firstPlot.left + (firstPlot.right - firstPlot.left) * (0.1 + (0.8 * i) / 8),
        firstPlot.top + (firstPlot.bottom - firstPlot.top) * [0.2, 0.5, 0.8][i % 3],
        { steps: 3 },
      );
      const active = companionPage.locator('.plot-inspector[data-local="true"]:visible');
      await expect(active).toHaveCount(1);
      await expect(
        companionPage.locator('.plot-inspector[data-local="false"]:visible').first(),
      ).toBeVisible();
      // Linked emphasis can land on a following frame; inspect the matching state.
      await expect
        .poll(() =>
          companionPage.evaluate(() => {
            const label = '.plot-inspector-label > span';
            const nearest = '[data-nearest="true"] ' + label;
            const source = document.querySelector(
              '.plot-inspector[data-local="true"]:not([hidden])',
            );
            const name = source?.querySelector(nearest)?.title;
            const linked = [
              ...document.querySelectorAll('.plot-inspector[data-local="false"]:not([hidden])'),
            ];
            return (
              !!name &&
              linked.length > 0 &&
              linked.every((node) => node.querySelector(nearest)?.title === name)
            );
          }),
        )
        .toBe(true);
      const state = await companionPage.evaluate(async () => {
        const url = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
        const mod = await import(url),
          ec = Object.values(mod).find((v) => v?.getInstanceByDom);
        const active = document.querySelector('.plot-inspector[data-local="true"]:not([hidden])');
        const r = active.getBoundingClientRect(),
          z = Number(getComputedStyle(active).zIndex);
        const primaryNames = [...active.querySelectorAll('.plot-inspector-label > span')].map(
          (n) => n.title,
        );
        const highlighted = active.querySelector(
          '[data-nearest="true"] .plot-inspector-label > span',
        )?.title;
        return [
          ...document.querySelectorAll('.plot-inspector[data-local="false"]:not([hidden])'),
        ].map((node) => {
          const box = node.getBoundingClientRect();
          const hint = node.id.replace('plot-values-', 'plot-hint-');
          const host = document.querySelector(`[aria-describedby="${hint}"]`);
          const canvas = host.getBoundingClientRect();
          const grid = ec
            .getInstanceByDom(host)
            .getModel()
            .getComponent('grid')
            .coordinateSystem.getRect();
          const plot = {
            left: canvas.left + grid.x,
            right: canvas.left + grid.x + grid.width,
            top: canvas.top + grid.y,
            bottom: canvas.top + grid.y + grid.height,
          };
          const cursor = host.parentElement
            .querySelector('.plot-inspector-cursor')
            .getBoundingClientRect();
          const main = document.querySelector('main').getBoundingClientRect();
          const names = [...node.querySelectorAll('.plot-inspector-label > span')].map(
            (n) => n.title,
          );
          const bold = node.querySelector(
            '[data-nearest="true"] .plot-inspector-label > span',
          )?.title;
          const source = host.closest('[data-panel-id]').dataset.panelId;
          return {
            inside:
              box.left >= plot.left &&
              box.right <= plot.right &&
              box.top >= plot.top &&
              box.bottom <= plot.bottom,
            below: Number(getComputedStyle(node).zIndex) < z,
            clearsCursor: box.right <= cursor.left || box.left >= cursor.right,
            inScroller:
              box.top >= main.top &&
              box.bottom <= main.bottom &&
              box.left >= main.left &&
              box.right <= main.right,
            plotCoverage: (box.width * box.height) / (grid.width * grid.height),
            source,
            readableNames: [...node.querySelectorAll('.series-label-cropped')].every((name) => {
              if (!name.getBoundingClientRect().width) return true;
              const label = name.getBoundingClientRect();
              const head = name.firstElementChild.getBoundingClientRect();
              const tail = name.lastElementChild.getBoundingClientRect();
              const value = name
                .closest('.plot-inspector-row')
                .querySelector('.plot-inspector-value > span')
                .getBoundingClientRect();
              return (
                head.width >= 12 && tail.right <= label.right + 0.5 && label.right < value.left
              );
            }),
            names,
            bold,
            highlighted,
            expected: [highlighted, ...primaryNames.filter((n) => n !== highlighted)].slice(
              0,
              names.length,
            ),
            overlap:
              box.left < r.right && box.right > r.left && box.top < r.bottom && box.bottom > r.top,
          };
        });
      });
      for (const item of state) {
        assert.ok(item.inside);
        assert.ok(item.readableNames, JSON.stringify({ companionWidth, companionHeight, item }));
        assert.ok(item.below);
        assert.ok(item.clearsCursor, JSON.stringify(item));
        assert.ok(item.inScroller, JSON.stringify(item));
        assert.ok(item.plotCoverage <= 0.4 + 0.005, JSON.stringify(item));
        assert.equal(item.bold, item.highlighted, JSON.stringify(item));
        if (item.source === 'hover1') assert.deepEqual(item.names, item.expected);
        overlapCases += Number(item.overlap);
      }
    }
    // Narrow popups rarely overlap; when they do, `below` keeps the primary on top.
    overlapCounts.push(companionWidth + 'x' + companionHeight + ':' + overlapCases);
    await companionPage.close();
    checks.push(
      'companion popups stay within their chart; overlapping originating values have higher stacking order',
    );
  }
  // Panels scroll beneath the workspace toolbar while it is pinned.
  function visiblePanelTop() {
    return Math.max(
      document.querySelector('main').getBoundingClientRect().top,
      document.querySelector('.workspace-top').getBoundingClientRect().bottom,
    );
  }
  async function plotBounds(target) {
    let result;
    await expect
      .poll(async () => {
        result = await target.locator('[_echarts_instance_]').evaluate(async (host) => {
          const url = performance
            .getEntriesByType('resource')
            .map((e) => e.name)
            .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
          const mod = await import(url),
            ec = Object.values(mod).find((v) => v?.getInstanceByDom);
          const grid = ec
            .getInstanceByDom(host)
            ?.getModel()
            .getComponent('grid')
            ?.coordinateSystem?.getRect();
          if (!grid) return null;
          const box = host.getBoundingClientRect();
          return {
            left: box.left + grid.x,
            right: box.left + grid.x + grid.width,
            top: box.top + grid.y,
            bottom: box.top + grid.y + grid.height,
          };
        });
        return result !== null;
      })
      .toBe(true);
    return result;
  }
  async function assertInspection(probe, label, pointer) {
    const popup = probe.locator('.plot-inspector[data-local="true"]:visible');
    await expect(popup, label).toHaveCount(1);
    const result = await popup.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const fullscreen = document.querySelector('.chart.fullscreen'),
        area = (fullscreen || document.querySelector('main')).getBoundingClientRect(),
        // A pinned workspace toolbar covers the top of the panel area.
        pinned = fullscreen ? null : document.querySelector('.workspace-top.pinned'),
        top = Math.max(0, area.top, pinned?.getBoundingClientRect().bottom ?? 0);
      return {
        extent: { top: top + 8, bottom: Math.min(innerHeight, area.bottom) - 8 },
        height: r.height,
        total:
          node.querySelectorAll('.plot-inspector-row').length +
          Number(node.querySelector('.plot-inspector-more').dataset.remaining),
        inside:
          r.left >= Math.max(0, area.left) &&
          r.right <= Math.min(innerWidth, area.right) &&
          r.top >= top &&
          r.bottom <= Math.min(innerHeight, area.bottom),
        noOverflow: node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth,
        nearest: node.querySelectorAll('[data-nearest="true"]').length,
        rows: [...node.querySelectorAll('.plot-inspector-row')].map((row) => {
          const name = row.querySelector('.plot-inspector-label > span');
          return {
            height: row.getBoundingClientRect().height,
            lines:
              name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight),
          };
        }),
        valuesFit: [...node.querySelectorAll('.plot-inspector-value > span')]
          .filter((v) => v.getClientRects().length)
          .every((v) => {
            const range = document.createRange();
            range.selectNodeContents(v);
            const t = range.getBoundingClientRect();
            return t.left >= r.left && t.right <= r.right && t.top >= r.top && t.bottom <= r.bottom;
          }),
      };
    });
    assert.ok(
      result.inside && result.noOverflow && result.valuesFit,
      JSON.stringify({ label, result }),
    );
    assert.equal(result.nearest, 1, label);
    if (pointer && result.extent.bottom - result.extent.top >= 200) {
      const required = Math.min(4, result.total);
      const rowHeight = Math.max(...result.rows.map((row) => row.height));
      const needed = result.height + Math.max(0, required - result.rows.length) * rowHeight;
      const available =
        Math.max(pointer.y - result.extent.top, result.extent.bottom - pointer.y) -
        (pointer.gap ?? 12) -
        40;
      if (available >= needed)
        assert.ok(
          result.rows.length >= required,
          JSON.stringify({ label, result, available, needed }),
        );
    }
    return result;
  }
  for (const [width, height] of [
    [1440, 300],
    [1280, 420],
    [720, 450],
    [320, 568],
  ]) {
    const probe = await browser.newPage({ viewport: { width, height } });
    probe.on('pageerror', (e) => errors.push(e.message));
    await probe.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
    const target = probe.locator('[data-panel-id="hover0"]');
    await expect(target.locator('canvas').first()).toBeVisible();
    const original = await plotBounds(target);
    const visibleTop = await probe.evaluate(visiblePanelTop);
    // Exercise partly hidden upper and lower plot edges without scrollIntoView changing them.
    for (const plotTop of [visibleTop + 8, visibleTop - 60, height - 70]) {
      await probe.locator('main').evaluate(
        (node, offset) => {
          node.scrollTop = offset;
        },
        Math.max(0, original.top - plotTop),
      );
      await probe.waitForTimeout(80);
      const rect = await plotBounds(target),
        top = Math.max(rect.top, visibleTop + 8),
        bottom = Math.min(rect.bottom, height - 8);
      if (bottom - top < 8) continue;
      for (const fraction of [0.1, 0.5, 0.9]) {
        await probe.mouse.move(
          rect.left + (rect.right - rect.left) * fraction,
          top + (bottom - top) * 0.5,
        );
        await assertInspection(probe, `partial ${width}x${height} top${plotTop} x${fraction}`, {
          y: top + (bottom - top) * 0.5,
        });
      }
    }
    // Fullscreen owns the inspection bounds even with a very short viewport.
    await target.getByRole('button', { name: 'Expand panel', exact: true }).click();
    await expect(target).toHaveClass(/fullscreen/);
    const rect = await plotBounds(target);
    for (const fraction of [0.1, 0.5, 0.9]) {
      await probe.mouse.move(
        rect.left + (rect.right - rect.left) * fraction,
        (rect.top + rect.bottom) / 2,
      );
      await assertInspection(probe, `fullscreen ${width}x${height} x${fraction}`, {
        y: (rect.top + rect.bottom) / 2,
      });
    }
    await target.locator('[_echarts_instance_]').focus();
    for (const key of ['Home', 'ArrowRight', 'End', 'ArrowLeft']) {
      await probe.keyboard.press(key);
      await assertInspection(probe, `keyboard fullscreen ${width}x${height} ${key}`);
    }
    await probe.keyboard.press('Escape');
    await expect(probe.locator('.plot-inspector:visible')).toHaveCount(0);
    await probe.close();
  }
  checks.push(
    'partly scrolled plots and short/fullscreen windows retain bounded values with mouse and keyboard',
  );
  for (const [width, height] of [
    [1440, 170],
    [600, 210],
    [390, 260],
  ]) {
    const probe = await browser.newPage({ viewport: { width, height } });
    await probe.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
    const target = probe.locator('[data-panel-id="hover0"]');
    await expect(target.locator('canvas').first()).toBeVisible();
    let rect = await plotBounds(target);
    await probe
      .locator('main')
      .evaluate(
        (node, mid) =>
          (node.scrollTop += mid - (node.getBoundingClientRect().top + innerHeight) / 2),
        (rect.top + rect.bottom) / 2,
      );
    rect = await plotBounds(target);
    const main = await probe.locator('main').boundingBox(),
      top = Math.max(rect.top, main.y) + 8,
      bottom = Math.min(rect.bottom, height) - 8;
    for (const fraction of [0.1, 0.5, 0.9]) {
      const x = (rect.left + rect.right) / 2,
        y = top + (bottom - top) * fraction;
      await probe.mouse.move(x, y, { steps: 3 });
      await assertInspection(probe, `tiny ${width}x${height} y${fraction}`);
      await expect(target.locator('.plot-inspector-cursor')).toBeVisible();
    }
    await probe.close();
  }
  checks.push(
    'One-row fallback still shows values in 170–210 px windows after dropping the optional count',
  );
  {
    const probe = await browser.newPage({ viewport: { width: 1440, height: 170 } });
    await probe.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
    const target = probe.locator('[data-panel-id="hover0"]');
    await expect(target.locator('canvas').first()).toBeVisible();
    // 72 px leaves a 24 px scroller below the 48 px header: too short to inspect.
    for (const height of [170, 72]) {
      await probe.setViewportSize({ width: 1440, height });
      let rect = await plotBounds(target);
      await probe
        .locator('main')
        .evaluate(
          (node, mid) =>
            (node.scrollTop += mid - (node.getBoundingClientRect().top + innerHeight) / 2),
          (rect.top + rect.bottom) / 2,
        );
      rect = await plotBounds(target);
      const main = await probe.locator('main').boundingBox();
      await probe.mouse.move(
        (rect.left + rect.right) / 2,
        (Math.max(rect.top, main.y) + Math.min(rect.bottom, height)) / 2,
        { steps: 3 },
      );
      if (height === 170) {
        await expect(probe.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
        await expect.poll(() => probe.locator('.run-row.highlighted').count()).toBeGreaterThan(0);
      } else {
        await expect(probe.locator('.plot-inspector:visible')).toHaveCount(0);
        await expect(target.locator('.plot-inspector-cursor')).not.toBeVisible();
        await expect(probe.locator('.run-row.highlighted')).toHaveCount(0);
      }
    }
    await probe.close();
  }
  checks.push('When even a one-row popup cannot fit, cursor and run emphasis clear together');

  view = await call('/api/views/' + view.id);
  view.body.panels[0].settings.tooltipFullNames = true;
  view.body.panels[0].settings.legendPosition = 'bottom';
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: scope, version: view.version, body: view.body },
    'PUT',
  );
  for (const [width, height] of [
    [1440, 900],
    [1280, 420],
    [320, 568],
  ]) {
    const probe = await browser.newPage({ viewport: { width, height } });
    probe.on('pageerror', (e) => errors.push(e.message));
    await probe.goto(baseURL + '/' + scope + '/workspace?view=' + view.id);
    const target = probe.locator('[data-panel-id="hover0"]');
    await expect(target.locator('canvas').first()).toBeVisible();
    const rect = await plotBounds(target);
    for (const fraction of [0.1, 0.5, 0.9]) {
      await probe.mouse.move(
        rect.left + (rect.right - rect.left) * fraction,
        (rect.top + rect.bottom) / 2,
      );
      const result = await assertInspection(probe, `full names ${width}x${height} x${fraction}`);
      for (const row of result.rows)
        assert.ok(row.height <= 64 && row.lines <= 3, JSON.stringify({ width, height, row }));
      if (width === 1280) assert.ok(result.rows.length >= 3, JSON.stringify(result));
    }
    await probe.close();
  }
  checks.push('full run names remain readable with paired values and a bottom legend');
  let linked = await call('/api/tools/view_create', {
    project: scope,
    name: 'Linked values defaults',
  });
  linked.body = {
    ...structuredClone(view.body),
    panels: view.body.panels.slice(0, 3).map((item, index) => ({
      ...item,
      section: 'linked',
      title: 'Linked ' + index,
      settings: { ...item.settings },
    })),
    sections: [{ id: 'linked', name: 'Linked inspection' }],
    sectionLayouts: { linked: { width: 300, height: 260, rows: 1 } },
  };
  linked = await call(
    '/api/views/' + linked.id,
    { name: linked.name, project: scope, version: linked.version, body: linked.body },
    'PUT',
  );
  const linkedPage = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await linkedPage.goto(baseURL + '/' + scope + '/workspace?view=' + linked.id);
  const linkedPanels = [0, 1, 2].map((i) => linkedPage.locator('[data-panel-id="hover' + i + '"]'));
  for (const target of linkedPanels) await expect(target.locator('canvas').first()).toBeVisible();
  const linkedPlot = await plotBounds(linkedPanels[0]);
  await linkedPage.mouse.move(
    (linkedPlot.left + linkedPlot.right) / 2,
    (linkedPlot.top + linkedPlot.bottom) / 2,
  );
  await expect(linkedPage.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
  await expect(linkedPage.locator('.plot-inspector[data-local="false"]:visible')).toHaveCount(2);
  for (const target of linkedPanels.slice(1))
    await expect(target.locator('.plot-inspector-cursor')).toBeVisible();
  async function linkedOrigin(p, targets, origin) {
    const hint = await targets[origin]
      .locator('[_echarts_instance_]')
      .getAttribute('aria-describedby');
    const primary = p.locator('.plot-inspector[data-local="true"]:visible');
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveAttribute('id', hint.replace('plot-hint-', 'plot-values-'));
    await expect(p.locator('.plot-inspector[data-local="false"]:visible')).toHaveCount(
      targets.length - 1,
    );
    for (const [i, target] of targets.entries())
      if (i !== origin)
        await expect(target.locator('.plot-inspector[data-local="false"]')).toBeVisible();
  }
  await linkedPage.mouse.down();
  await linkedPage.mouse.up();
  await linkedOrigin(linkedPage, linkedPanels, 0);
  const secondPlot = await plotBounds(linkedPanels[1]),
    secondX = (secondPlot.left + secondPlot.right) / 2,
    secondY = (secondPlot.top + secondPlot.bottom) / 2;
  await linkedPage.mouse.move(secondX, secondY, { steps: 3 });
  await linkedPage.mouse.down();
  await linkedPage.mouse.up();
  await linkedOrigin(linkedPage, linkedPanels, 1);
  await linkedPage.mouse.move(1, 1);
  await linkedPanels[0].locator('[_echarts_instance_]').focus();
  await linkedPage.keyboard.press('ArrowRight');
  await linkedOrigin(linkedPage, linkedPanels, 0);
  await linkedPage.mouse.move(secondX, 50, { steps: 3 });
  await linkedPage.mouse.move(secondX, secondY, { steps: 3 });
  await linkedOrigin(linkedPage, linkedPanels, 1);
  await linkedPage.mouse.move(secondX, 50, { steps: 3 });
  await linkedOrigin(linkedPage, linkedPanels, 0);
  await linkedPage.mouse.move(
    (linkedPlot.left + linkedPlot.right) / 2,
    (linkedPlot.top + linkedPlot.bottom) / 2,
    { steps: 3 },
  );
  await linkedPanels[1].locator('[_echarts_instance_]').focus();
  await linkedPage.keyboard.press('ArrowRight');
  await linkedOrigin(linkedPage, linkedPanels, 1);
  await linkedPage.keyboard.press('Escape');
  await expect(linkedPage.locator('.plot-inspector:visible')).toHaveCount(0);
  const touchBody = {
    ...structuredClone(linked.body),
    panels: linked.body.panels.slice(0, 2),
    sectionLayouts: { linked: { width: 300, height: 220, rows: 2 } },
  };
  const touchView = await call('/api/tools/view_create', {
    project: scope,
    name: 'Touch origins',
    body: touchBody,
  });
  for (const width of [390, 1024]) {
    const p = await browser.newPage({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await p.goto(baseURL + '/' + scope + '/workspace?view=' + touchView.id);
    const targets = [0, 1].map((i) => p.locator('[data-panel-id="hover' + i + '"]'));
    for (const target of targets) await expect(target.locator('canvas').first()).toBeVisible();
    for (const origin of [0, 1, 0]) {
      const rect = await plotBounds(targets[origin]),
        main = await p.locator('main').boundingBox();
      const y = (Math.max(rect.top, main.y) + Math.min(rect.bottom, 844)) / 2;
      await p.touchscreen.tap((rect.left + rect.right) / 2, y);
      await linkedOrigin(p, targets, origin);
    }
    await p.close();
  }
  {
    // A narrow companion shows only the highlighted run. When that run is hidden in
    // the companion's legend, only its cursor remains.
    const sparse = await call('/api/tools/view_create', {
      project: scope,
      name: 'Narrow companion without the highlighted run',
      body: {
        ...structuredClone(linked.body),
        panels: linked.body.panels.slice(0, 2),
        sectionLayouts: { linked: { width: 300, height: 220, rows: 2 } },
      },
    });
    // At 320 px each plot is narrow enough for value-only companions.
    const p = await browser.newPage({ viewport: { width: 320, height: 1000 } });
    const errors = [];
    p.on('pageerror', (error) => errors.push(error.message));
    await p.goto(baseURL + '/' + scope + '/workspace?view=' + sparse.id);
    const targets = [0, 1].map((i) => p.locator('[data-panel-id="hover' + i + '"]'));
    for (const target of targets) await expect(target.locator('canvas').first()).toBeVisible();
    await targets[1].locator('.chart-legend-item').first().click();
    await p.waitForTimeout(300);
    const origin = await plotBounds(targets[0]);
    let cursorOnly = 0;
    for (let i = 0; i <= 20; i++)
      for (const fraction of [0.15, 0.5, 0.85]) {
        await p.mouse.move(
          origin.left + (origin.right - origin.left) * (0.02 + (0.96 * i) / 20),
          origin.top + (origin.bottom - origin.top) * fraction,
          { steps: 2 },
        );
        await p.waitForTimeout(40);
        for (const target of targets) {
          assert.equal(await target.locator('.chart-status').count(), 0);
          await expect(target.locator('canvas').first()).toBeVisible();
        }
        if (
          (await targets[1].locator('.plot-inspector-cursor').isVisible()) &&
          !(await targets[1].locator('.plot-inspector[data-local="false"]').isVisible())
        )
          cursorOnly++;
      }
    await p.mouse.move(1, 1);
    await p.waitForTimeout(300);
    for (const target of targets) await expect(target.locator('.chart-status')).toHaveCount(0);
    assert.ok(cursorOnly > 0, 'No position exercised a companion without the highlighted run');
    assert.deepEqual(errors, []);
    await p.close();
  }
  checks.push(
    'A narrow companion without the highlighted run keeps only its cursor and no renderer error',
  );
  checks.push(
    'Click/tap origin switches preserve companions; mixed keyboard/pointer yields one origin and restores focused keyboard inspection',
  );
  // Linked panels always show the cursor line, values and the dot; there is no setting.
  await linkedPage.mouse.move(1, 1);
  await openPanelSettings(linkedPage, 'Linked 1');
  const edit = linkedPage.getByRole('dialog', { name: 'Panel settings', exact: true });
  await edit.getByRole('tab', { name: 'Display', exact: true }).click();
  await expect(edit.getByText('When another panel is hovered')).toHaveCount(0);
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(edit).toBeHidden();
  const refused = structuredClone(linked.body);
  refused.panels[1].settings.companionTooltip = 'cursor';
  const latest = await call('/api/views/' + linked.id);
  const response = await api.fetch('/api/views/' + linked.id, {
    method: 'PUT',
    data: { name: latest.name, project: scope, version: latest.version, body: refused },
  });
  assert.equal(response.status(), 400, 'the removed companionTooltip setting is refused');
  await linkedPage.reload();
  for (const target of linkedPanels) await expect(target.locator('canvas').first()).toBeVisible();
  const nextPlot = await plotBounds(linkedPanels[0]);
  await linkedPage.mouse.move(
    (nextPlot.left + nextPlot.right) / 2,
    (nextPlot.top + nextPlot.bottom) / 2,
  );
  await expect(linkedPage.locator('.plot-inspector[data-local="false"]:visible')).toHaveCount(2);
  for (const target of linkedPanels.slice(1)) {
    await expect(target.locator('.plot-inspector-cursor')).toBeVisible();
    await expect(target.locator('.plot-inspector[data-local="false"]')).toBeVisible();
    await expect(target.locator('.plot-inspector-point')).toBeVisible();
  }
  await linkedPage.close();
  checks.push(
    'linked panels always show the cursor line, values and dot; the removed companion setting is refused',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, overlapCounts, errors }, null, 2));
} catch (error) {
  console.error({ checks });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await api?.dispose();
  await server?.app.close();
  await rm(dir, { recursive: true, force: true });
}
