import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect as playwrightExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser, listen } from './helpers.mjs';

// Hover inspection on area, stacked area and percent area panels: component values,
// percentages, totals, the focused band, the dot on the rendered stacked point, series
// emphasis, linked popups to and from line charts, legend toggles and cleanup.
// npm run build && PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/area-hover-browser.mjs
const expect = playwrightExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-area-hover-'));
const checks = [];
let server, browser;
try {
  server = await createServer(directory);
  const runs = [];
  // Runs log at different iteration positions. Run 2 omits cost/b in every seventh record,
  // so multi-metric stacks omit those records.
  const logged = (i, j) => ({
    'cost/a': 1 + i + (j % 3),
    'cost/b': 2 + (j % 5),
    'cost/c': 0.5 * i + 1,
  });
  for (let i = 0; i < 3; i++) {
    const run = await server.db.call('upsert', {
      entity: 'test',
      project: 'area',
      name: 'r' + i,
      displayName: 'area-run-' + i,
      config: { model: { value: i < 2 ? 'small' : 'large' } },
    });
    runs.push(run);
    const content = Array.from({ length: 41 }, (_, j) => {
      const values = logged(i, j);
      if (i === 2 && j % 7 === 0) delete values['cost/b'];
      return JSON.stringify({ _step: j, iteration: j * 10 + (i === 1 ? 5 : 0), ...values });
    });
    await server.db.call('ingest', run.id, {
      files: { 'wandb-history.jsonl': { offset: 0, content } },
      complete: true,
    });
  }
  const panel = (id, plugin, metrics, settings = {}) => ({
    id,
    plugin,
    metric: metrics[0],
    metrics,
    title: id,
    section: 's',
    settings,
  });
  const layout = {
    sections: [{ id: 's', name: 'Area' }],
    sectionLayouts: { s: { width: 640, height: 320, rows: 4 } },
  };
  const runsView = await server.tools.execute('view_create', {
    project: 'test/area',
    name: 'Runs stacked',
    body: {
      generation: 'manual',
      panels: [
        panel('line', 'line', ['cost/a']),
        panel('area', 'area', ['cost/a']),
        panel('spread', 'area', ['cost/a'], {
          groupBy: 'all',
          aggregation: 'mean',
          spread: 'minmax',
        }),
        panel('stack', 'stacked-area', ['cost/a']),
        panel('percent', 'percent-area', ['cost/a']),
        panel('grouped', 'stacked-area', ['cost/a'], {
          groupBy: 'config.model',
          aggregation: 'mean',
        }),
      ],
      ...layout,
      visible: runs.map((run) => run.id),
      solo: [],
      plotSettings: { xAxis: 'iteration' },
    },
  });
  const componentsView = await server.tools.execute('view_create', {
    project: 'test/area',
    name: 'Components',
    body: {
      generation: 'manual',
      panels: [
        panel('line', 'line', ['cost/a']),
        panel('stack', 'stacked-area', ['cost/a', 'cost/b', 'cost/c']),
        panel('percent', 'percent-area', ['cost/a', 'cost/b', 'cost/c']),
        {
          ...panel('computed', 'stacked-area', []),
          expressions: [
            { name: 'A', expression: '${cost/a} * 2' },
            { name: 'B', expression: '${cost/b} + 1' },
          ],
        },
        panel('smooth', 'stacked-area', ['cost/a', 'cost/b', 'cost/c'], {
          smoothingMethod: 'ema',
          smoothingValue: 0.5,
        }),
      ],
      ...layout,
      visible: [runs[2].id],
      solo: [],
      plotSettings: { xAxis: 'iteration' },
    },
  });
  const overlappingView = await server.tools.execute('view_create', {
    project: 'test/area',
    name: 'Overlapping compositions',
    body: {
      generation: 'manual',
      panels: [
        panel('line', 'line', ['cost/a']),
        panel('area', 'area', ['cost/a', 'cost/b', 'cost/c']),
        panel('stack', 'stacked-area', ['cost/a', 'cost/b', 'cost/c']),
        panel('percent', 'percent-area', ['cost/a', 'cost/b', 'cost/c']),
      ],
      ...layout,
      visible: runs.map((run) => run.id),
      solo: [],
      plotSettings: { xAxis: 'iteration' },
    },
  });
  const base = await listen(server);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, locale: 'en-US' }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // Chart geometry and series data, read from the rendered ECharts instance.
  async function chart(id) {
    return page.locator(`[data-panel-id="${id}"] [_echarts_instance_]`).evaluate(async (host) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
      const mod = await import(url),
        instance = Object.values(mod)
          .find((v) => v?.getInstanceByDom)
          .getInstanceByDom(host);
      const box = host.getBoundingClientRect(),
        grid = instance.getModel().getComponent('grid').coordinateSystem.getRect();
      return {
        box: { left: box.left, top: box.top },
        grid: { x: grid.x, y: grid.y, width: grid.width, height: grid.height },
        series: instance.getOption().series.map((s) => ({
          name: s.name,
          stack: s.stack,
          data: s.data,
          key: s.randlKey,
          color: s.itemStyle?.color,
          line: s.lineStyle,
          area: s.areaStyle,
        })),
      };
    });
  }
  async function pixel(id, x, y) {
    return page.locator(`[data-panel-id="${id}"] [_echarts_instance_]`).evaluate(
      async (host, [x, y]) => {
        const url = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
        const mod = await import(url),
          instance = Object.values(mod)
            .find((v) => v?.getInstanceByDom)
            .getInstanceByDom(host);
        const box = host.getBoundingClientRect(),
          point = instance.convertToPixel({ gridIndex: 0 }, [x, y]);
        return { x: box.left + point[0], y: box.top + point[1] };
      },
      [x, y],
    );
  }
  async function seriesStates(id) {
    return page.locator(`[data-panel-id="${id}"] [_echarts_instance_]`).evaluate(async (host) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
      const mod = await import(url),
        instance = Object.values(mod)
          .find((v) => v?.getInstanceByDom)
          .getInstanceByDom(host);
      const result = [];
      instance.getModel().eachSeries((model) => {
        const states = new Set();
        instance.getViewOfSeriesModel(model).group.traverse((el) => {
          for (const state of el.currentStates || []) states.add(state);
        });
        result.push({ runIds: model.option.randlRunIds, states: [...states].sort() });
      });
      return result;
    });
  }
  // Number of series drawn in the blurred state, i.e. not emphasized.
  async function blurred(id) {
    return (await seriesStates(id)).filter((series) => series.states.includes('blur')).length;
  }
  // Read the rendered paths, not getOption(): ECharts applies blur opacity at draw time.
  async function areaOpacity(id) {
    return page.locator(`[data-panel-id="${id}"] [_echarts_instance_]`).evaluate(async (host) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /\/assets\/engine-[^/]+\.js/.test(n));
      const mod = await import(url),
        instance = Object.values(mod)
          .find((v) => v?.getInstanceByDom)
          .getInstanceByDom(host);
      const result = [];
      instance.getModel().eachSeries((model) => {
        const paths = [];
        instance.getViewOfSeriesModel(model).group.traverse((el) => {
          if (el.type === 'ec-polygon') paths.push(el.style.opacity);
        });
        result.push(paths);
      });
      return result;
    });
  }
  async function calmCompanions(ids, runIndex) {
    await leave();
    const baseline = await Promise.all(ids.map(areaOpacity));
    assert.ok(baseline.every((series) => series.some((paths) => paths.length)));
    const unchanged = async () => {
      for (const [i, id] of ids.entries()) {
        await expect.poll(() => blurred(id), { message: id + ' must not blur' }).toBe(0);
        await expect
          .poll(() => areaOpacity(id), { message: id + ' rendered fill opacity' })
          .toEqual(baseline[i]);
      }
    };
    await hover('line', 200, logged(runIndex, 20)['cost/a']);
    await unchanged();
    assert.ok(await dot(ids[0]), 'linked inspection keeps its dot');
    await leave();
    await page.locator(`[data-entry-key="${runs[runIndex].id}"]`).hover();
    if ((await chart('line')).series.length > 1)
      await expect.poll(() => blurred('line')).toBe((await chart('line')).series.length - 1);
    await unchanged();
    await leave();
    checks.push('external panel/sidebar hover preserves rendered area opacity: ' + ids.join(', '));
  }
  async function highlightedRunBands(ids, runIndex) {
    await leave();
    const baseline = await Promise.all(ids.map(areaOpacity));
    const highlighted = async () => {
      for (const [i, id] of [...ids, 'line'].entries()) {
        const series = await seriesStates(id),
          matches = series.map((s) => s.runIds.includes(runs[runIndex].id));
        assert.ok(matches.some(Boolean), id + ' contains the hovered run/group');
        await expect
          .poll(() => seriesStates(id), { message: id + ' run emphasis' })
          .toEqual(
            series.map((s, index) => ({
              runIds: s.runIds,
              states: [matches[index] ? 'emphasis' : 'blur'],
            })),
          );
        if (id !== 'line') {
          const opacity = await areaOpacity(id);
          for (const [index, paths] of opacity.entries())
            for (const [path, value] of paths.entries())
              if (matches[index]) assert.equal(value, baseline[i][index][path], id);
              else assert.ok(value < baseline[i][index][path], id + ' dims other runs/groups');
        }
      }
    };
    await hover('line', 120, logged(runIndex, 12)['cost/a']);
    await highlighted();
    assert.ok(await dot(ids[0]), 'linked inspection keeps its dot');
    await leave();
    await page.locator(`[data-entry-key="${runs[runIndex].id}"]`).hover();
    await highlighted();
    await leave();
    for (const [i, id] of ids.entries())
      await expect.poll(() => areaOpacity(id)).toEqual(baseline[i]);
    checks.push('external panel/sidebar hover highlights run/group bands: ' + ids.join(', '));
  }
  async function popup(selector = '.plot-inspector[data-local="true"]') {
    return page.locator(selector + ':not([hidden])').evaluate((node) => ({
      heading: node.querySelector('.plot-inspector-heading')?.textContent,
      headings: node.querySelectorAll('.plot-inspector-heading').length,
      rowX: node.querySelectorAll('.plot-inspector-row small').length,
      rows: [...node.querySelectorAll('.plot-inspector-rows > .plot-inspector-row')].map((row) => ({
        label: row.querySelector('.plot-inspector-label > span')?.title,
        values: [...row.querySelectorAll('.plot-inspector-value > span')].map((v) => v.textContent),
        bold: row.dataset.nearest === 'true',
        color: getComputedStyle(row.querySelector('.plot-inspector-marker')).backgroundColor,
        right: row.querySelector('.plot-inspector-value > span').getBoundingClientRect().right,
      })),
      total: [
        ...(node
          .querySelector('.plot-inspector-total')
          ?.querySelectorAll('.plot-inspector-value > span') || []),
      ].map((v) => v.textContent),
    }));
  }
  async function dot(id) {
    return page.locator(`[data-panel-id="${id}"] .plot-inspector-point`).evaluate((node) => {
      const box = node.getBoundingClientRect();
      return node.hidden
        ? null
        : {
            color: getComputedStyle(node).backgroundColor,
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
          };
    });
  }
  const number = (text) => Number(text.replace(/[,%]/g, ''));
  const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
  // Cumulative bounds of each stacked series at data index i, in series order.
  function stackBounds(series, i) {
    const tops = new Map();
    return series.map((s) => {
      const below = tops.get(s.stack) || 0,
        top = below + s.data[i][1];
      tops.set(s.stack, top);
      return { name: s.name, below, top };
    });
  }
  async function hover(id, x, y) {
    const point = await pixel(id, x, y);
    await page.mouse.move(point.x, point.y, { steps: 3 });
    try {
      await expect(page.locator('.plot-inspector[data-local="true"]:visible')).toHaveCount(1);
    } catch (error) {
      if (process.env.RANDL_DEBUG_SHOT)
        await page.screenshot({ path: process.env.RANDL_DEBUG_SHOT });
      throw Error(`No popup when hovering ${id} at ${JSON.stringify({ x, y, point })}`, {
        cause: error,
      });
    }
    return point;
  }
  async function leave() {
    await page.mouse.move(1, 1);
    await expect(page.locator('.plot-inspector:visible')).toHaveCount(0);
    await expect(page.locator('.plot-inspector-point:visible')).toHaveCount(0);
  }

  // Multi-metric stacked area: component values, band focus, total, dot and emphasis.
  await page.goto(base + '/test/area/workspace?view=' + componentsView.id);
  for (const id of ['line', 'stack', 'percent', 'smooth', 'computed'])
    await expect(page.locator(`[data-panel-id="${id}"] canvas`).first()).toBeVisible();
  const palette = {
    light: ['#538ae5', '#f0434f', '#479a5f'],
    dark: ['#6499f0', '#ff8b96', '#5aaa71'],
  };
  const rgb = (hex) =>
    'rgb(' + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ') + ')';
  async function themeColors(components) {
    let previousGroupColor;
    await leave();
    await page.waitForLoadState('networkidle');
    for (const dark of [true, false]) {
      const requests = [];
      const record = (request) => {
        if (new URL(request.url()).pathname === '/api/chart') requests.push(request.url());
      };
      page.on('request', record);
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await expect(page.locator('html')).toHaveAttribute('theme', dark ? 'g100' : 'g10');
      const colors = palette[dark ? 'dark' : 'light'];
      await expect
        .poll(async () => (await chart('stack')).series[0].color)
        .toBe(colors[components ? 0 : 2]);
      for (const id of components
        ? ['stack', 'percent', 'smooth', 'computed']
        : ['stack', 'percent', 'area']) {
        const { series } = await chart(id);
        assert.deepEqual(
          series.filter((s) => s.key).map((s) => s.color),
          components
            ? colors.slice(0, series.length)
            : series.map((s) => colors[runs.findIndex((run) => s.key.startsWith(run.id + ':'))]),
          id,
        );
        for (const s of series) {
          assert.equal(s.area.opacity, id === 'area' ? (dark ? 0.4 : 0.3) : 0.85);
          assert.equal(s.line.color, undefined, 'no added band separator');
          await expect(
            page
              .locator(`[data-panel-id="${id}"]`)
              .getByRole('button', { name: s.name, exact: true })
              .locator('.chart-legend-marker'),
          ).toHaveCSS('background-color', rgb(s.color));
        }
        const i = 12,
          bounds = stackBounds(series, i),
          band = 1;
        await hover(
          id,
          series[band].data[i][0],
          id === 'area' ? series[band].data[i][1] : (bounds[band].below + bounds[band].top) / 2,
        );
        assert.equal((await dot(id)).color, rgb(series[band].color), id + ' dot');
        const result = await popup();
        assert.equal(
          result.rows.find((row) => row.bold).color,
          rgb(series[band].color),
          id + ' popup',
        );
        await leave();
      }
      if (!components) {
        const spread = (await chart('spread')).series;
        assert.equal(spread.length, 3);
        assert.notEqual(spread[2].color, previousGroupColor, 'group color follows the theme');
        previousGroupColor = spread[2].color;
        assert.equal(spread[0].line.opacity, 0, 'no lower spread border');
        assert.equal(spread[1].line.opacity, 0, 'no upper spread border');
        assert.equal(spread[1].area.color, spread[2].color);
        assert.equal(spread[1].area.opacity, dark ? 0.32 : 0.22);
        assert.ok(!spread[2].area, 'spread replaces the mean fill to zero');
        assert.ok(
          spread[1].data.some((p) => p[1] > 0),
          'spread has visible width',
        );
      }
      if (components) {
        const panel = page.locator('[data-panel-id="stack"]');
        await panel.hover();
        await panel.getByRole('button', { name: 'Panel actions', exact: true }).click();
        const downloaded = page.waitForEvent('download');
        await page.getByRole('menuitem', { name: 'Export PNG', exact: true }).click();
        const download = await downloaded;
        const png = await readFile(await download.path());
        const found = await page.evaluate(
          async ({ data, colors, background }) => {
            const img = new Image();
            img.src = data;
            await img.decode();
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            return colors.map((hex) => {
              const expected = [1, 3, 5].map((i) =>
                Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.85 + background * 0.15),
              );
              let count = 0;
              for (let i = 0; i < pixels.length; i += 4)
                if (
                  expected.every((c, j) => Math.abs(pixels[i + j] - c) <= 2) &&
                  pixels[i + 3] === 255
                )
                  count++;
              return count;
            });
          },
          {
            data: 'data:image/png;base64,' + png.toString('base64'),
            colors,
            background: dark ? 38 : 255,
          },
        );
        assert.ok(
          found.every((n) => n > 100),
          'PNG contains every blended component fill',
        );
        await mkdir('tmp/area-colors', { recursive: true });
        await download.saveAs(`tmp/area-colors/stack-${dark ? 'dark' : 'light'}.png`);
      }
      await leave();
      await page.screenshot({
        path: `tmp/area-colors/${components ? 'components' : 'runs'}-${dark ? 'dark' : 'light'}.png`,
        fullPage: true,
      });
      page.off('request', record);
      assert.deepEqual(requests, [], 'theme recolors cached data without requests');
    }
    checks.push(
      (components ? 'components, computed metrics and PNG' : 'per-run areas and spread') +
        ': theme palette, fills, legend, hover dot and popup; no refetch',
    );
  }
  await themeColors(true);
  await calmCompanions(['stack', 'percent', 'smooth', 'computed'], 2);
  {
    const { series } = await chart('stack');
    assert.deepEqual(
      series.map((s) => s.stack),
      Array(3).fill(series[0].stack),
    );
    const i = 12,
      x = series[0].data[i][0],
      j = x / 10,
      bounds = stackBounds(series, i);
    for (const [band, focus] of [
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]) {
      await hover('stack', x, (bounds[band].below + bounds[band].top) / 2);
      const result = await popup();
      assert.equal(result.headings, 1);
      assert.equal(result.heading, 'iteration ' + new Intl.NumberFormat('en-US').format(x));
      assert.equal(result.rowX, 0);
      // Rows follow the stack from top to bottom and name components without the shared prefix.
      assert.deepEqual(
        result.rows.map((row) => row.label),
        ['c', 'b', 'a'],
      );
      const expected = logged(2, j);
      for (const row of result.rows)
        assert.ok(close(number(row.values[0]), expected['cost/' + row.label]), JSON.stringify(row));
      assert.deepEqual(
        result.rows.filter((row) => row.bold).map((row) => row.label),
        [focus],
      );
      assert.ok(
        close(
          number(result.total[0]),
          expected['cost/a'] + expected['cost/b'] + expected['cost/c'],
        ),
      );
      assert.ok(result.rows.every((row) => Math.abs(row.right - result.rows[0].right) < 0.5));
      // The dot sits on the focused component's rendered (cumulative) point.
      const marker = await dot('stack'),
        expectedPoint = await pixel('stack', x, bounds[band].top);
      assert.ok(
        Math.hypot(marker.x - expectedPoint.x, marker.y - expectedPoint.y) < 1.5,
        JSON.stringify({ marker, expectedPoint }),
      );
      await expect.poll(() => blurred('stack')).toBe(2);
    }
    await leave();
    await expect.poll(() => blurred('stack')).toBe(0);
    checks.push(
      'multi-metric stacked area: component values in stack order, focused band, total, dot on the stacked point and series emphasis',
    );

    // Linked popups: line chart to stacked area and back.
    await hover('line', x, logged(2, j)['cost/a']);
    const companion = await popup('[data-panel-id="stack"] .plot-inspector[data-local="false"]');
    assert.equal(companion.headings, 1);
    assert.equal(companion.rows.length, 3);
    assert.ok(companion.rows.every((row) => !row.bold));
    const stackDot = await dot('stack'),
      top = await pixel('stack', x, bounds[2].top);
    assert.ok(Math.hypot(stackDot.x - top.x, stackDot.y - top.y) < 1.5);
    await leave();
    await hover('stack', x, bounds[0].top / 2);
    const linePopup = await popup('[data-panel-id="line"] .plot-inspector[data-local="false"]');
    assert.equal(linePopup.rows.length, 1);
    assert.ok(close(number(linePopup.rows[0].values[0]), logged(2, j)['cost/a']));
    assert.ok(await dot('line'));
    await leave();
    checks.push('linked popups and dots between a line chart and a multi-metric stacked area');

    // Hiding a component in the legend removes it from the rows, the total and the stack.
    await page.locator('[data-panel-id="stack"] .chart-legend-item').nth(1).click();
    await page.waitForTimeout(200);
    const visibleSeries = (await chart('stack')).series;
    await hover('stack', x, ((expected) => expected['cost/a'] / 2)(logged(2, j)));
    const hidden = await popup();
    assert.deepEqual(
      hidden.rows.map((row) => row.label),
      ['c', 'a'],
    );
    assert.ok(close(number(hidden.total[0]), logged(2, j)['cost/a'] + logged(2, j)['cost/c']));
    await page.mouse.move(
      (await pixel('stack', x, logged(2, j)['cost/a'] + logged(2, j)['cost/c'] / 2)).x,
      (await pixel('stack', x, logged(2, j)['cost/a'] + logged(2, j)['cost/c'] / 2)).y,
    );
    const hiddenTop = await pixel('stack', x, logged(2, j)['cost/a'] + logged(2, j)['cost/c']),
      hiddenDot = await dot('stack');
    assert.ok(
      Math.hypot(hiddenDot.x - hiddenTop.x, hiddenDot.y - hiddenTop.y) < 1.5,
      JSON.stringify({ hiddenDot, hiddenTop, n: visibleSeries.length }),
    );
    await leave();
    await page.locator('[data-panel-id="stack"] .chart-legend-item').nth(1).click();
    checks.push('legend-hidden components leave the rows, the total and the stacked position');
  }
  {
    // Records missing a component are omitted from every component of that run.
    const { series } = await chart('stack');
    const xs = series[0].data.map((point) => point[0]);
    assert.ok(xs.every((x) => (x / 10) % 7 !== 0));
    assert.ok(series.every((s) => s.data.length === xs.length));
    checks.push('records missing a component are omitted from the aligned stack');
  }
  {
    // Percent area: shares with a % sign that add up to 100, focused band and dot.
    const { series } = await chart('percent');
    const i = 5,
      x = series[0].data[i][0],
      j = x / 10,
      bounds = stackBounds(series, i);
    await hover('percent', x, (bounds[1].below + bounds[1].top) / 2);
    const result = await popup();
    assert.ok(result.rows.every((row) => row.values[0].endsWith('%')));
    const values = logged(2, j),
      sum = values['cost/a'] + values['cost/b'] + values['cost/c'];
    for (const row of result.rows)
      assert.ok(
        Math.abs(number(row.values[0]) - (100 * values['cost/' + row.label]) / sum) < 0.006,
        JSON.stringify(row),
      );
    assert.deepEqual(result.total, []);
    assert.deepEqual(
      result.rows.filter((row) => row.bold).map((row) => row.label),
      ['b'],
    );
    const marker = await dot('percent'),
      expectedPoint = await pixel('percent', x, bounds[1].top);
    assert.ok(Math.hypot(marker.x - expectedPoint.x, marker.y - expectedPoint.y) < 1.5);
    await leave();
    checks.push('percent area: percentages that add up to 100, focused band and dot');
  }
  {
    // Smoothed stacks show smoothed and original component values in aligned columns.
    const { series } = await chart('smooth');
    const i = 9,
      x = series[0].data[i][0],
      j = x / 10;
    await hover('smooth', x, stackBounds(series, i)[0].top / 2);
    const result = await popup();
    for (const row of result.rows) {
      assert.equal(row.values.length, 2);
      assert.ok(
        close(number(row.values[1]), logged(2, j)['cost/' + row.label]),
        JSON.stringify(row),
      );
    }
    assert.equal(result.total.length, 2);
    await leave();
    checks.push('smoothed stacked area shows smoothed and original values and totals');
  }

  // Runs stacked on one metric: logged X positions, run values, total and percentages.
  await page.goto(base + '/test/area/workspace?view=' + runsView.id);
  for (const id of ['line', 'area', 'stack', 'percent', 'grouped', 'spread'])
    await expect(page.locator(`[data-panel-id="${id}"] canvas`).first()).toBeVisible();
  await themeColors(false);
  await highlightedRunBands(['area', 'stack', 'percent', 'grouped', 'spread'], 0);
  await highlightedRunBands(['area', 'stack', 'percent', 'grouped', 'spread'], 2);
  {
    const { series } = await chart('stack');
    const positions = series[0].data.map((point) => point[0]);
    const loggedX = new Set(
      [0, 1, 2].flatMap((i) => Array.from({ length: 41 }, (_, j) => j * 10 + (i === 1 ? 5 : 0))),
    );
    assert.ok(
      positions.every((x) => loggedX.has(x)),
      'stacked runs use logged X positions',
    );
    const i = positions.findIndex((x) => x === 200),
      bounds = stackBounds(series, i),
      band = series.findIndex((s) => s.name.startsWith('area-run-0'));
    await hover('stack', 200, (bounds[band].below + bounds[band].top) / 2);
    const result = await popup();
    assert.equal(result.heading, 'iteration 200');
    assert.equal(result.rowX, 0);
    // Run 0 logs at iteration 200; its value is the logged one.
    const run0 = result.rows.find((row) => row.label.startsWith('area-run-0'));
    assert.ok(close(number(run0.values[0]), logged(0, 20)['cost/a']));
    assert.ok(run0.bold);
    assert.ok(
      close(
        number(result.total[0]),
        result.rows.reduce((total, row) => total + number(row.values[0]), 0),
        1e-4,
      ),
    );
    const marker = await dot('stack'),
      expectedPoint = await pixel('stack', 200, bounds[band].top);
    assert.ok(Math.hypot(marker.x - expectedPoint.x, marker.y - expectedPoint.y) < 1.5);
    // Linked area, percent and grouped panels show values for the same X.
    for (const id of ['line', 'area', 'percent', 'grouped']) {
      const linked = await popup(`[data-panel-id="${id}"] .plot-inspector[data-local="false"]`);
      assert.equal(linked.headings, 1, id);
      assert.ok(linked.rows.length >= 1, id);
      assert.ok(
        linked.rows.every((row) => row.values.every((v) => Number.isFinite(number(v)))),
        id,
      );
    }
    const percent = await popup('[data-panel-id="percent"] .plot-inspector[data-local="false"]');
    assert.ok(percent.rows.every((row) => row.values[0].endsWith('%')));
    await leave();
    checks.push(
      'runs stacked on one metric: logged X headers, run values, total, dot and linked area, percent and grouped popups',
    );
  }
  {
    // A non-stacked area chart behaves like a line chart: the dot is at the run's own value.
    const { series } = await chart('area');
    const visible = series.filter((s) => s.key);
    // A point whose value differs from every other run's value at the nearest position.
    const nearestValue = (s, x) =>
      s.data.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best))[1];
    let target = visible[0],
      point = visible[0].data[0];
    for (const s of visible)
      for (const p of s.data)
        if (
          visible.every((other) => other === s || Math.abs(nearestValue(other, p[0]) - p[1]) >= 1)
        ) {
          target = s;
          point = p;
        }
    await hover('area', point[0], point[1]);
    const result = await popup();
    assert.equal(result.rows.find((row) => row.bold).label, target.name);
    const marker = await dot('area'),
      expectedPoint = await pixel('area', point[0], point[1]);
    assert.ok(Math.hypot(marker.x - expectedPoint.x, marker.y - expectedPoint.y) < 1.5);
    assert.equal(result.total.length, 0);
    await expect.poll(() => blurred('area')).toBe(visible.length - 1);
    await leave();
    // ECharts' own tooltip never appears beside the inspector.
    const echartsTips = await page.evaluate(
      () =>
        [...document.querySelectorAll('div')].filter(
          (node) =>
            node.style.zIndex === '9999999' &&
            getComputedStyle(node).display !== 'none' &&
            node.offsetParent,
        ).length,
    );
    assert.equal(echartsTips, 0);
    checks.push('area chart dot at the run value; no ECharts tooltip or stale popup after leaving');
  }
  await page.goto(base + '/test/area/workspace?view=' + overlappingView.id);
  for (const id of ['line', 'area', 'stack', 'percent'])
    await expect(page.locator(`[data-panel-id="${id}"] canvas`).first()).toBeVisible();
  await calmCompanions(['stack', 'percent', 'area'], 0);

  // Runs table replaces the workspace, so there are no companion bands on that page.
  // Exercise its real hover and SPA return to ensure it cannot leave a stale highlight.
  const navigation = page.getByRole('navigation', { name: 'Project pages', exact: true });
  await navigation.getByRole('button', { name: 'Runs', exact: true }).click();
  await page
    .locator('.runs-table-region')
    .getByRole('link', { name: 'area-run-0', exact: true })
    .hover();
  await navigation.getByRole('button', { name: 'Workspace', exact: true }).click();
  for (const id of ['stack', 'percent']) {
    await expect(page.locator(`[data-panel-id="${id}"] canvas`).first()).toBeVisible();
    await expect.poll(() => blurred(id)).toBe(0);
    await expect.poll(() => areaOpacity(id)).toEqual(Array.from({ length: 9 }, () => [0.85]));
  }
  checks.push('Runs table hover clears when returning to workspace');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  console.error({ checks });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
