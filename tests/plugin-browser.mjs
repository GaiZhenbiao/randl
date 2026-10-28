import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { launchBrowser } from './helpers.mjs';

// Exercises the actual Panel.svelte and registry. Only the chart HTTP response
// and external plugin modules are fixtures; no running randl server is needed.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome node tests/plugin-browser.mjs
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'randl-plugin-browser-'));
let server;
let browser;
let passed = 0;
const fixture = (body) => `
  export async function create({ element, onCursor }) {
    const mode = ${JSON.stringify(body.mode)};
    window.pluginCalls.push('create:' + mode);
    window.pluginEmitters[element.closest('[data-panel-id]').dataset.panelId] = onCursor;
    element.dataset.fixture = mode;
    ${body.create || ''}
    return {
      update() { window.pluginCalls.push('update:' + mode); ${body.update || "element.textContent = mode + '-ready';"} },
      resize() { window.pluginCalls.push('resize:' + mode); ${body.resize || ''} },
      destroy() { window.pluginCalls.push('destroy:' + mode); ${body.destroy || 'element.replaceChildren();'} },
      ${body.cursor ? `showCursor(cursor) { window.pluginCalls.push('cursor:' + mode); ${body.cursor} }` : ''}
    };
  }
`;
const modules = new Map([
  ['healthy', fixture({ mode: 'healthy' })],
  [
    'shared-pairs',
    `export function create({element,echarts}) {
    const chart=echarts.init(element);
    window.sharedChart=chart;
    return {
      update({data}) {
        const points=data.series[0].values.loss;
        window.sharedPoints=points;
        chart.setOption({animation:false,xAxis:{type:'value'},yAxis:{type:'value'},
          dataZoom:[{type:'inside',filterMode:'filter'}],
          series:[0,1].map(i=>({type:'line',name:'s'+i,data:points,stack:'a',stackStrategy:'all',showSymbol:true,emphasis:{focus:'series'}}))},true);
        for(const point of points)Object.freeze(point);
        Object.freeze(points);
        window.sharedCanvas=element.querySelector('canvas');
      },
      resize(){chart.resize();},
      destroy(){chart.dispose();}
    };
  }`,
  ],
  [
    'create-failure',
    fixture({
      mode: 'create-failure',
      create: "element.textContent = 'partial create'; throw Error('create fixture failure');",
    }),
  ],
  [
    'update-failure',
    fixture({ mode: 'update-failure', update: "throw Error('update fixture failure');" }),
  ],
  [
    'resize-failure',
    fixture({ mode: 'resize-failure', resize: "throw Error('resize fixture failure');" }),
  ],
  [
    'destroy-failure',
    fixture({ mode: 'destroy-failure', destroy: "throw Error('destroy fixture failure');" }),
  ],
  [
    'cursor-failure',
    fixture({
      mode: 'cursor-failure',
      cursor: "if (cursor) throw Error('cursor fixture failure');",
    }),
  ],
  [
    'delayed-create',
    fixture({
      mode: 'delayed-create',
      create: 'await new Promise(resolve => window.releaseCreate = resolve);',
    }),
  ],
  [
    'delayed-create-failure',
    fixture({
      mode: 'delayed-create-failure',
      create:
        'await new Promise((_resolve, reject) => window.rejectCreate = () => reject(Error("late create fixture failure")));',
    }),
  ],
  [
    'delayed-update-failure',
    fixture({
      mode: 'delayed-update-failure',
      update:
        'return new Promise((_resolve, reject) => window.rejectUpdate = () => reject(Error("late update fixture failure")));',
    }),
  ],
  [
    'invalid-lifecycle',
    'export function create({element}) { element.textContent="partial renderer"; return { update() {} }; }',
  ],
]);

try {
  await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><html><head><title>Plugin lifecycle fixture</title></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>',
  );
  await writeFile(
    join(directory, 'entry.js'),
    `import { mount } from 'svelte'; import Harness from './Harness.svelte'; mount(Harness, {target: document.querySelector('#app')});`,
  );
  await writeFile(
    join(directory, 'Harness.svelte'),
    `
    <script>
      import Panel from ${JSON.stringify(join(repository, 'frontend/src/Panel.svelte'))};
      let mode = $state('healthy');
      const info = id => ({id, name:id, entry:'panel.js', revision:'fixture', builtin:false, enabled:true, renderer:id==='shared-pairs'?'echarts':'dom', settings:{common:[], options:[]}});
      const runs = [{id:'fixture/run',name:'fixture',display_name:'Fixture run',revision:1}];
      const noop = () => {};
      window.pluginCalls = [];
      window.pluginEmitters = {};
      window.pluginHarness = {setMode(next) { mode = next; }};
    </script>
    <main>
      <Panel panel={{id:'under-test',plugin:mode,metric:'loss',title:'Under test'}} plugin={info(mode)} {runs}
        dark={false} onedit={noop} onremove={noop} onduplicate={noop} onmove={noop}/>
      <Panel panel={{id:'unaffected',plugin:'healthy',metric:'loss',title:'Unaffected'}} plugin={info('healthy')} {runs}
        dark={false} onedit={noop} onremove={noop} onduplicate={noop} onmove={noop}/>
    </main>
    <style>
      :global(body) { margin: 0; }
      main { width: 800px; max-width: 90vw; }
      :global(.chart) { box-sizing:border-box; width:100%; position:relative; }
      :global(.plot) { height:220px; }
      :global(.chart-canvas) { width:100%; height:100%; }
    </style>
  `,
  );
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: join(directory, 'vite-cache'),
    logLevel: 'error',
    plugins: [
      svelte(),
      {
        name: 'local-lifecycle-fixtures',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            const requestPath = new URL(request.url || '/', 'http://localhost').pathname;
            const match = requestPath.match(
              /^\/api\/plugins\/([^/]+)\/revisions\/fixture\/source\/panel\.js$/,
            );
            if (match && modules.has(match[1])) {
              response.setHeader('Content-Type', 'application/javascript');
              response.end(modules.get(match[1]));
            } else if (requestPath === '/api/chart') {
              request.resume();
              response.setHeader('Content-Type', 'application/json');
              response.end(
                JSON.stringify({
                  sampled: false,
                  metrics: ['loss'],
                  series: [
                    {
                      id: 'fixture/run',
                      name: 'Fixture run',
                      values: {
                        loss: [
                          [0, 2],
                          [1, 1],
                        ],
                      },
                    },
                  ],
                }),
              );
            } else next();
          });
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [directory, repository] } },
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser();

  async function check(name, callback) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(url);
      const target = page.locator('[data-panel-id="under-test"]');
      const control = page.locator('[data-panel-id="unaffected"]');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await expect(control.locator('.chart-canvas')).toHaveText('healthy-ready');
      const mode = async (value) =>
        page.evaluate((next) => window.pluginHarness.setMode(next), value);
      const settled = async () => page.evaluate(() => new Promise(requestAnimationFrame));
      await callback({ page, target, control, mode, settled });
      await expect(control.locator('.chart-canvas')).toHaveText('healthy-ready');
      assert.deepEqual(errors, [], 'Lifecycle failures must not become unhandled browser errors');
      passed++;
      console.log('PASS ' + name);
    } catch (error) {
      console.error(
        JSON.stringify({
          check: name,
          status: await page.locator('.chart-status').allTextContents(),
          calls: await page.evaluate(() => window.pluginCalls),
          browserErrors: errors,
        }),
      );
      throw error;
    } finally {
      await page.close();
    }
  }

  await check(
    'external ECharts plugins share immutable pairs without changing stack or tooltip values',
    async ({ page, target, mode }) => {
      await mode('shared-pairs');
      await expect(target.locator('canvas')).toBeVisible();
      await expect.poll(() => page.evaluate(() => !!window.sharedPoints)).toBe(true);
      const result = await page.evaluate(() => {
        const chart = window.sharedChart,
          points = window.sharedPoints;
        const model = chart.getModel();
        const identity =
          model.getSeriesByIndex(0).option.data === points &&
          model._optionManager._optionBackup.baseOption.series[0].data === points;
        chart.dispatchAction({ type: 'highlight', seriesIndex: 0 });
        chart.dispatchAction({ type: 'dataZoom', startValue: 0, endValue: 1 });
        const series = chart.getModel().getSeriesByIndex(1),
          data = series.getData();
        const stack = data.get(data.getCalculationInfo('stackResultDimension'), data.count() - 1);
        chart.setOption({ series: [{ data: points }, { data: points }] });
        const tooltip = series.getDataParams(data.count() - 1).value;
        chart.setOption(
          {
            animation: false,
            xAxis: { type: 'value', min: 0, max: 2 },
            yAxis: { type: 'value', min: 0, max: 3 },
            series: [{ type: 'scatter', data: points }],
          },
          true,
        );
        chart.appendData({ seriesIndex: 0, data: [[2, 0.5]] });
        const appended = chart.getModel().getSeriesByIndex(0);
        const append = {
          count: appended.getRawData().count(),
          point: appended.getRawData().getRawDataItem(2),
          sourceLength: points.length,
          optionLength: appended.option.data.length,
        };
        const frozen = Object.freeze(points.map((point) => Object.freeze([...point])));
        chart.setOption({ series: [{ type: 'scatter', data: frozen }] });
        return {
          append,
          identity,
          stack,
          tooltip,
          png: chart.getDataURL().startsWith('data:image/png'),
          points,
        };
      });
      assert.deepEqual(result.append, {
        count: 3,
        point: [2, 0.5],
        sourceLength: 2,
        optionLength: 3,
      });
      assert.equal(result.identity, true);
      assert.equal(result.stack, 2);
      assert.deepEqual(result.tooltip, [1, 1]);
      assert.equal(result.png, true);
      assert.deepEqual(result.points, [
        [0, 2],
        [1, 1],
      ]);
      await mode('healthy');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      assert.equal(
        await page.evaluate(() => window.sharedCanvas.width + window.sharedCanvas.height),
        0,
        'host releases installed-plugin canvas backing',
      );
    },
  );

  for (const [id, message] of [
    ['create-failure', 'create fixture failure'],
    ['invalid-lifecycle', 'required rendering methods are missing'],
  ]) {
    await check(id + ' is contained and cleans partial DOM', async ({ target, mode }) => {
      await mode(id);
      await expect(target.locator('.chart-status')).toContainText(message);
      await expect(target.locator('.chart-canvas > *')).toHaveCount(0);
      await mode('healthy');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await expect(target.locator('.chart-status')).toHaveCount(0);
    });
  }
  await check('update exception is local and replacement recovers', async ({ target, mode }) => {
    await mode('update-failure');
    await expect(target.locator('.chart-status')).toContainText('update fixture failure');
    await mode('healthy');
    await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
    await expect(target.locator('.chart-status')).toHaveCount(0);
  });
  await check('resize exception is caught through ResizeObserver', async ({ target, mode }) => {
    await mode('resize-failure');
    await expect(target.locator('.chart-canvas')).toHaveText('resize-failure-ready');
    await target.locator('.chart-canvas').evaluate((element) => (element.style.width = '75%'));
    await expect(target.locator('.chart-status')).toContainText('resize fixture failure');
  });
  await check(
    'throwing destroy removes its own DOM without breaking replacement',
    async ({ page, target, mode }) => {
      await mode('destroy-failure');
      await expect(target.locator('.chart-canvas')).toHaveText('destroy-failure-ready');
      await mode('healthy');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await expect
        .poll(() => page.evaluate(() => window.pluginCalls.includes('destroy:destroy-failure')))
        .toBe(true);
      await expect(target.locator('.chart-canvas > *')).toHaveCount(1);
      await expect(target.locator('.chart-status')).toHaveCount(0);
    },
  );
  await check(
    'showCursor exception stays local when another panel publishes a cursor',
    async ({ page, target, mode }) => {
      await mode('cursor-failure');
      await expect(target.locator('.chart-canvas')).toHaveText('cursor-failure-ready');
      await expect(target.locator('.chart-status')).toHaveCount(0);
      await page.evaluate(() => window.pluginEmitters.unaffected({ axis: '_step', value: 1 }));
      await expect(target.locator('.chart-status')).toContainText('cursor fixture failure');
      await expect
        .poll(() => page.evaluate(() => window.pluginCalls.includes('cursor:cursor-failure')))
        .toBe(true);
      await mode('healthy');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await expect(target.locator('.chart-status')).toHaveCount(0);
    },
  );
  await check(
    'superseded async create cannot destroy a newer renderer',
    async ({ page, target, mode, settled }) => {
      await mode('delayed-create');
      await expect.poll(() => page.evaluate(() => typeof window.releaseCreate)).toBe('function');
      await mode('healthy');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await page.evaluate(() => window.releaseCreate());
      await settled();
      await expect
        .poll(() => page.evaluate(() => window.pluginCalls.includes('destroy:delayed-create')))
        .toBe(true);
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await expect(target.locator('.chart-status')).toHaveCount(0);
    },
  );
  await check(
    'delayed create rejection cannot overwrite a newer panel state',
    async ({ page, target, mode, settled }) => {
      await mode('delayed-create-failure');
      await expect.poll(() => page.evaluate(() => typeof window.rejectCreate)).toBe('function');
      await mode('healthy');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await page.evaluate(() => window.rejectCreate());
      await settled();
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await expect(target.locator('.chart-status')).toHaveCount(0);
    },
  );
  await check(
    'delayed update rejection cannot overwrite a newer panel state',
    async ({ page, target, mode, settled }) => {
      await mode('delayed-update-failure');
      await expect.poll(() => page.evaluate(() => typeof window.rejectUpdate)).toBe('function');
      await mode('healthy');
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await page.evaluate(() => window.rejectUpdate());
      await settled();
      await expect(target.locator('.chart-canvas')).toHaveText('healthy-ready');
      await expect(target.locator('.chart-status')).toHaveCount(0);
    },
  );
  console.log(
    JSON.stringify({ pluginLifecycleChecks: passed, actualPanel: true, actualRegistry: true }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
