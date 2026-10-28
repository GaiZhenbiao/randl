// Regenerates the README screenshots in .github/assets/readme/ from illustrative data only.
//
//   npm run build
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome \
//     node scripts/readme-screenshots.mjs --data-dir /tmp/randl-readme [--port 8980]
//
// The data directory must be new or one this script created. The script starts randl on
// it, logs the experiments of scripts/readme-demo.py with the real W&B SDK (--python,
// default .venv-sdk/bin/python), keeps one run logging while it captures, and writes WebP
// files with ffmpeg. --only hero,grid captures some scenes; --serve keeps the server up
// afterwards for inspection. The Assistant and CLI scenes use a local stand-in model that
// calls randl's real management tools; no model provider is contacted. The CLI scene runs
// a real shell session (bash, jq and column) and renders its output as a terminal window.
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHTTPServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createServer } from '../backend/dist/server.js';
import { launchBrowser } from '../tests/helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: options } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string', default: '8980' },
    python: {
      type: 'string',
      default: process.env.RANDL_SDK_PYTHON || join(root, '.venv-sdk/bin/python'),
    },
    out: { type: 'string', default: join(root, '.github/assets/readme') },
    only: { type: 'string' },
    serve: { type: 'boolean', default: false },
  },
});
if (!options['data-dir']) throw Error('Choose a separate scratch directory with --data-dir');
const dataDir = resolve(options['data-dir']),
  workDir = join(dataDir, 'readme-work'),
  out = resolve(options.out),
  base = `http://127.0.0.1:${options.port}`,
  project = 'demo/cartpole-ppo';
if (existsSync(dataDir) && readdirSync(dataDir).length && !existsSync(workDir))
  throw Error(`${dataDir} is not empty and was not created by this script`);
mkdirSync(workDir, { recursive: true });
mkdirSync(out, { recursive: true });
const sdkEnv = {
  ...process.env,
  WANDB_BASE_URL: base,
  WANDB_API_KEY: '0'.repeat(40),
  WANDB_DIR: workDir,
  WANDB_CONFIG_DIR: join(workDir, 'config'),
  WANDB_CACHE_DIR: join(workDir, 'cache'),
  WANDB_DATA_DIR: join(workDir, 'data'),
  WANDB_SILENT: 'true',
};
const python = (args, wait = true) => {
  const child = spawn(options.python, [join(root, 'scripts/readme-demo.py'), ...args], {
    env: sdkEnv,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!wait) return child;
  return new Promise((done, fail) =>
    child.on('exit', (code) => (code ? fail(Error('readme-demo.py exited with ' + code)) : done())),
  );
};

// A stand-in OpenAI-compatible model that drives one scripted Assistant turn: it calls the
// real tools in order and reports what their results say.
const assistantPrompt = 'Make a view that compares the three lr=3e-4 seeds on episodic return.';
// The CLI scene's shell session; `randl` is a function that runs backend/dist/cli.js.
const cliSession = [
  `randl projects list | jq -r '.projects[] | select(.archived == 0) | [.id, .runs] | @tsv' | column -t`,
  `VIEW=$(randl views create --project ${project} --name "Best learning rate" | jq -r .id)`,
  `randl panels add --view $VIEW --metric charts/episodic_return | jq -c '.body.panels[].title'`,
  [
    `randl runs --project ${project} \\`,
    `  | jq '[.[] | select(.group_name == "lr=0.0003") | .id]' \\`,
    `  | randl select --view $VIEW --solo-file - | jq -c .body.solo`,
  ].join('\n'),
  `randl agent '${assistantPrompt}'`,
];
const provider = createHTTPServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const { messages } = JSON.parse(body);
  const results = messages
    .filter((message) => message.role === 'tool')
    .map((message) => {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.text || '').join('');
      try {
        return JSON.parse(text);
      } catch {
        return { error: text };
      }
    });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: 'readme',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'readme-stand-in',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  const call = (text, name, args) => {
    send({ role: 'assistant', content: text });
    send({
      tool_calls: [
        {
          index: 0,
          id: 'call-' + results.length,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    send({}, 'tool_calls');
  };
  const seeds = (results[0] || [])
    .filter((run) => run.group_name === 'lr=0.0003')
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const view = results[1];
  if (results.length === 0) call('Listing the runs in cartpole-ppo.', 'runs_list', { project });
  else if (results.length === 1)
    call(`Found ${seeds.length} runs in the lr=0.0003 group. Creating the view.`, 'view_create', {
      project,
      name: 'lr=3e-4 seeds',
      body: { generation: 'manual', panels: [], visible: [], solo: [] },
    });
  else if (results.length === 2)
    call('', 'panel_add', {
      view: view.id,
      plugin: 'line',
      metric: 'charts/episodic_return',
      title: 'Episodic return',
      settings: { smoothingMethod: 'ema', smoothingValue: 0.8 },
    });
  else if (results.length === 3)
    call('', 'runs_select', { view: view.id, visible: seeds.map((run) => run.id), solo: [] });
  else {
    send({
      role: 'assistant',
      content:
        `Created the view **${view.name}** with an *Episodic return* line panel ` +
        `(EMA smoothing 0.8) and made ${seeds.map((run) => '`' + run.display_name + '`').join(', ')} ` +
        'visible. Open it from the view menu in the workspace header.',
    });
    send({}, 'stop');
  }
  response.end('data: [DONE]\n\n');
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
const runtime = await ModelRuntime.create({
  authPath: join(workDir, 'auth.json'),
  modelsPath: null,
  modelsStorePath: join(workDir, 'models-cache.json'),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
runtime.registerProvider('readme', {
  name: 'Local',
  baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
  api: 'openai-completions',
  apiKey: 'local',
  models: [
    {
      id: 'readme-stand-in',
      name: 'Scripted stand-in',
      reasoning: false,
      input: ['text'],
      contextWindow: 32768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
});

const server = await createServer(dataDir, { entity: 'demo' });
server.agent.runtimeFactory = async () => runtime;
await server.app.listen({ host: '127.0.0.1', port: Number(options.port) });
const tool = (name, args) => server.tools.execute(name, args);
let live;
process.on('exit', () => live?.kill('SIGKILL'));
try {
  const projects = (await tool('workspace_snapshot', {})).projects;
  if (!projects.some((item) => item.id === project)) {
    console.log('Logging illustrative runs with the W&B SDK…');
    await python(['--work-dir', workDir]);
    const names = {
      'demo/cartpole-ppo': [
        'CartPole PPO',
        'Learning-rate sweep of PPO on CartPole-v1, three seeds each.',
      ],
      'demo/sprite-diffusion': [
        'Sprite diffusion',
        'Small UNet diffusion models on 96 px pixel-art sprites.',
      ],
      'demo/lunar-lander-dqn': ['Lunar Lander DQN', 'DQN variants on LunarLander-v3.'],
      'demo/sentiment-distilbert': ['Sentiment DistilBERT', 'DistilBERT fine-tuning on SST-2.'],
      'demo/mnist-mlp': ['MNIST MLP', 'Hidden-size baseline.'],
    };
    for (const [id, [name, description]] of Object.entries(names))
      await tool('project_update', { id, name, description });
    await tool('project_update', { id: 'demo/mnist-mlp', archived: true });
  }
  // One run keeps logging while the scenes are captured.
  live = python(['--work-dir', workDir, '--live', '900'], false);
  const views = await createViews();
  await new Promise((done) => setTimeout(done, 8000));
  await capture(views);
  if (options.serve) {
    console.log(`Serving ${base}; press Ctrl+C to stop.`);
    await new Promise(() => {});
  }
} finally {
  live?.kill();
  await server.close?.();
  await server.app.close();
  provider.close();
}

async function runsOf(id) {
  return (await tool('runs_list', { project: id })).sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  );
}

/** Creates the views the scenes show; each scene starts from its own view. */
async function createViews() {
  const cartpole = await runsOf(project),
    sprites = await runsOf('demo/sprite-diffusion'),
    ids = cartpole.map((run) => run.id),
    fallRate = { name: 'Fall rate', expression: '${rollout/pole_falls} / ${rollout/episodes}' };
  const line = (id, metric, title, settings = {}, extra = {}) => ({
    id,
    section: 'training',
    plugin: 'line',
    metric,
    metrics: [metric],
    title,
    settings,
    ...extra,
  });
  const smooth = { smoothingMethod: 'ema', smoothingValue: 0.8 };
  const existing = (await tool('workspace_snapshot', {})).views;
  // The Assistant scene creates this view; remove it so the scene can run again.
  for (const view of existing)
    if (view.name === 'lr=3e-4 seeds') await tool('view_delete', { id: view.id });
  const create = async (name, projectId, body) => {
    for (const view of existing)
      if (view.name === name && view.project === projectId)
        await tool('view_delete', { id: view.id });
    return (await tool('view_create', { name, project: projectId, body })).id;
  };
  return {
    hero: await create('Sweep overview', project, {
      generation: 'manual',
      sections: [
        { id: 'training', name: 'Training' },
        { id: 'rollouts', name: 'Rollouts' },
      ],
      sectionLayouts: { training: { rows: 2 } },
      panels: [
        line('return', 'charts/episodic_return', 'Episodic return', smooth),
        line('value', 'losses/value_loss', 'Value loss', smooth),
        line('entropy', 'losses/entropy', 'Policy entropy'),
        line('kl', 'losses/approx_kl', 'Approx. KL', { ...smooth, excludeOutliers: true }),
        line('falls', 'Fall rate', 'Fall rate', smooth, { metrics: [], expressions: [fallRate] }),
        line('sps', 'charts/SPS', 'Steps per second', smooth),
        {
          id: 'video',
          section: 'rollouts',
          plugin: 'video',
          metric: 'rollout/video',
          title: 'Rollouts',
        },
      ],
      visible: ids,
      solo: [],
      runQuery: { sort: 'display_name' },
    }),
    grouped: await create('By learning rate', project, {
      generation: 'manual',
      sections: [{ id: 'training', name: 'Grouped by learning rate' }],
      plotSettings: { groupBy: 'config.learning_rate', aggregation: 'mean', spread: 'minmax' },
      panels: [
        line('return', 'charts/episodic_return', 'Episodic return', smooth),
        line('entropy', 'losses/entropy', 'Policy entropy'),
        line('falls', 'Fall rate', 'Fall rate', smooth, { metrics: [], expressions: [fallRate] }),
      ],
      visible: ids,
      solo: [],
      runQuery: { sort: 'display_name', group: 'config.learning_rate' },
    }),
    grid: await create('Per-run grid', project, {
      generation: 'manual',
      sections: [{ id: 'training', name: 'Each run' }],
      sectionLayouts: { training: { height: 650 } },
      panels: [
        line('return', 'charts/episodic_return', 'Episodic return', {
          ...smooth,
          layout: 'grid',
          itemSize: 240,
          sharedY: true,
        }),
      ],
      visible: ids,
      solo: [],
      runQuery: { sort: 'display_name' },
    }),
    coverflow: await create('Sample flow', 'demo/sprite-diffusion', {
      generation: 'manual',
      sections: [{ id: 'samples', name: 'Samples' }],
      sectionLayouts: { samples: { height: 470 } },
      panels: [
        {
          id: 'samples',
          section: 'samples',
          plugin: 'image',
          metric: 'samples',
          title: 'samples',
          settings: { layout: 'coverflow' },
        },
      ],
      visible: sprites.map((run) => run.id),
      solo: [],
      runQuery: { sort: 'display_name' },
    }),
    table: await create('Runs table', project, {
      generation: 'manual',
      panels: [],
      visible: ids,
      solo: [],
      runQuery: {
        sort: 'display_name',
        group: 'config.learning_rate',
        columns: [
          'state',
          'config.learning_rate',
          'config.seed',
          'summary.best_return',
          'runtime',
          'history_count',
        ],
      },
    }),
    sprites: await create('Samples', 'demo/sprite-diffusion', {
      generation: 'manual',
      sections: [
        { id: 'samples', name: 'Samples' },
        { id: 'training', name: 'Training' },
      ],
      sectionLayouts: { samples: { height: 640 } },
      panels: [
        {
          id: 'samples',
          section: 'samples',
          plugin: 'image',
          metric: 'samples',
          title: 'samples',
          settings: { itemSize: 112, mediaAcross: 'steps' },
        },
        line('fid', 'eval/fid', 'FID', { showPoints: true }),
        line('loss', 'train/loss', 'Training loss', smooth),
      ],
      visible: sprites.map((run) => run.id),
      solo: [],
      runQuery: { sort: 'display_name' },
    }),
  };
}

async function capture(views) {
  const scenes = options.only?.split(',');
  const browser = await launchBrowser();
  const serverErrors = [];
  // Pages render at device scale 2; WebP files keep `scale` pixels per CSS pixel.
  const shoot = async (name, settings, act) => {
    const { theme = 'g10', width = 1440, height = 900, mobile = false, scale = 1.25 } = settings;
    if (scenes && !scenes.includes(name)) return;
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: theme === 'g10' ? 'light' : 'dark',
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    await context.addInitScript((value) => localStorage.setItem('randl.theme', value), theme);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('response', (response) => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });
    const png = join(workDir, name + '.png');
    const clip = await act(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: png, ...(clip ? { clip } : {}) });
    await context.close();
    const webp = join(out, name + '.webp');
    const pixels = Math.round((clip?.width || width) * scale);
    execFileSync('ffmpeg', [
      ...['-loglevel', 'error', '-y', '-i', png, '-vf', `scale=${pixels}:-1:flags=lanczos`],
      ...['-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', webp],
    ]);
    console.log(`${name}.webp ${(statSync(webp).size / 1024).toFixed(0)} KiB`);
  };
  const workspace = (view) => `${base}/${project}/workspace?view=${view}`;
  const settle = async (page) => {
    await page.locator('canvas').first().waitFor();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2500);
  };
  // The bounding box of a locator, padded and limited to the viewport.
  const around = async (locator, pad = 12, extra = {}) => {
    const box = await locator.boundingBox(),
      size = locator.page().viewportSize(),
      x = Math.max(0, box.x - pad),
      y = Math.max(0, box.y - pad);
    return {
      x,
      y,
      width: Math.min(size.width - x, box.width + 2 * pad + (extra.width || 0)),
      height: Math.min(size.height - y, box.height + 2 * pad + (extra.height || 0)),
    };
  };
  const hoverChart = async (page, panel, fx, fy) => {
    const box = await page
      .locator(`article[data-panel-id="${panel}"] canvas`)
      .first()
      .boundingBox();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 4 });
    await page.waitForTimeout(800);
  };

  await shoot('hero', {}, async (page) => {
    await page.goto(workspace(views.hero));
    await settle(page);
  });
  await shoot('grouped', {}, async (page) => {
    await page.goto(workspace(views.grouped));
    await settle(page);
    await hoverChart(page, 'return', 0.42, 0.5);
    return { x: 0, y: 0, width: 1440, height: 600 };
  });
  await shoot('grid', {}, async (page) => {
    await page.goto(workspace(views.grid));
    await settle(page);
    await hoverChart(page, 'return', 0.6, 0.5);
    return around(page.locator('article[data-panel-id="return"]'));
  });
  await shoot('coverflow', { theme: 'g100' }, async (page) => {
    await page.goto(`${base}/demo/sprite-diffusion/workspace?view=${views.coverflow}`);
    await page.locator('img').first().waitFor();
    await page.getByRole('tab', { name: 'ddpm-cosine-ema' }).click();
    for (let step = 0; step < 3; step++) {
      await page.getByRole('button', { name: 'Next item' }).click();
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(4000);
    return around(page.locator('article[data-panel-id="samples"]'));
  });
  await shoot('media', {}, async (page) => {
    await page.goto(`${base}/demo/sprite-diffusion/workspace?view=${views.sprites}`);
    await page.locator('img').first().waitFor();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);
    return around(page.locator('article[data-panel-id="samples"]'));
  });
  await shoot('computed', {}, async (page) => {
    await page.goto(workspace(views.hero));
    await settle(page);
    const panel = page.locator('article[data-panel-id="falls"]');
    await panel.hover();
    await panel.getByRole('button', { name: 'Panel settings' }).click();
    const dialog = page.locator('.bx--modal.is-visible .bx--modal-container');
    await dialog.waitFor();
    await page.waitForTimeout(2500);
    return around(dialog, 0);
  });
  await shoot('table', {}, async (page) => {
    await page.goto(`${base}/${project}/runs?view=${views.table}`);
    await page.getByRole('link', { name: 'ppo-lr3e-4-s3' }).waitFor();
    for (const name of ['ppo-lr3e-3-s1', 'ppo-lr3e-3-s2', 'ppo-lr3e-3-s3'])
      await page
        .getByRole('row')
        .filter({ hasText: name })
        .getByRole('checkbox')
        .check({ force: true });
    await page.waitForTimeout(1500);
    return { x: 0, y: 0, width: 1440, height: 780 };
  });
  await shoot('assistant', { height: 1000 }, async (page) => {
    await page.goto(workspace(views.hero));
    await settle(page);
    await page.evaluate(() =>
      fetch('/api/agent/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'readme', id: 'readme-stand-in' }),
      }),
    );
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Assistant', exact: true });
    await drawer.getByRole('textbox', { name: 'Message' }).fill(assistantPrompt);
    await drawer.getByRole('button', { name: 'Send', exact: true }).click();
    await drawer.getByText('Open it from the view menu').waitFor();
    await page.waitForTimeout(1500);
  });
  await shoot('cli', { width: 1040, height: 1000 }, async (page) => {
    for (const view of (await tool('workspace_snapshot', {})).views)
      if (['Best learning rate', 'lr=3e-4 seeds'].includes(view.name))
        await tool('view_delete', { id: view.id });
    await fetch(`${base}/api/conversations/cli`, { method: 'DELETE' });
    await fetch(`${base}/api/agent/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'readme', id: 'readme-stand-in' }),
    });
    // One shell runs every command so $VIEW carries over; a separator marks each output.
    const script = [
      `randl() { node ${JSON.stringify(join(root, 'backend/dist/cli.js'))} "$@"; }`,
      ...cliSession.flatMap((command) => [`printf '\\036\\n'`, command]),
    ].join('\n');
    // Asynchronous, because this process also serves the commands' requests.
    const shell = spawn('bash', ['-e', '-o', 'pipefail', '-c', `{\n${script}\n} 2>&1`], {
      env: { ...process.env, RANDL_URL: base },
    });
    let text = '';
    shell.stdout.on('data', (chunk) => (text += chunk));
    const status = await new Promise((done) => shell.on('exit', done));
    if (status) throw Error('CLI session failed:\n' + text);
    const outputs = text.split('\x1e\n').slice(1);
    const escape = (text) =>
      text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const lines = cliSession.flatMap((command, i) => [
      ...command
        .split('\n')
        .map((line, j) => `<span class="prompt">${j ? '&gt;' : '$'}</span> ${escape(line)}`),
      ...outputs[i]
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd()
        .split('\n')
        .filter((line, j, all) => line || (j && all[j - 1]))
        .map((line) =>
          /^\[[a-z_]+\]$/.test(line) ? `<span class="tool">${escape(line)}</span>` : escape(line),
        ),
    ]);
    await page.route(`${base}/readme-terminal`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>
          @font-face { font-family: 'IBM Plex Mono'; src: url('/fonts/IBMPlexMono-Regular-Latin1.woff2'); }
          body { margin: 0; background: #161616; }
          .window { background: #161616; }
          .bar { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
            background: #262626; }
          .bar i { width: 12px; height: 12px; border-radius: 50%; background: #525252; }
          pre { margin: 0; padding: 18px 22px 22px; color: #f4f4f4; white-space: pre-wrap;
            font: 15px/1.6 'IBM Plex Mono', monospace; }
          .prompt { color: #42be65; } .tool { color: #8d8d8d; }
        </style><div class="window"><div class="bar"><i></i><i></i><i></i></div>
        <pre>${lines.join('\n')}</pre></div>`,
      }),
    );
    await page.goto(`${base}/readme-terminal`);
    await page.evaluate(() => document.fonts.ready);
    return around(page.locator('.window'), 0);
  });
  await shoot('overview', {}, async (page) => {
    await page.goto(`${base}/demo/lunar-lander-dqn/overview`);
    await page.getByText('Recent runs').waitFor();
    await page.waitForTimeout(2000);
  });
  await shoot('mobile', { width: 390, height: 844, mobile: true, scale: 1.5 }, async (page) => {
    await page.goto(workspace(views.hero));
    await settle(page);
  });
  await browser.close();
  if (serverErrors.length) console.log('Server errors:\n' + [...new Set(serverErrors)].join('\n'));
}
