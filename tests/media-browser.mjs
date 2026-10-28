import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';
import { demoURL, launchBrowser, listen } from './helpers.mjs';

// Media panels in a seeded server: the SDK run from sdk_smoke.py (image, audio, video, table,
// histogram, and image lists, video and audio at steps 0, 4 and 8), the synthetic
// demo/media-demo project from scripts/seed-media.mjs when present (six runs × six images at
// eight steps), and a project of the test's own for live steps, which it removes.
// RANDL_URL=http://127.0.0.1:8744 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:media
const expect = baseExpect.configure({ timeout: 10000 });
const baseURL = demoURL();
const api = await request.newContext({ baseURL });
async function call(path, body, method = body ? 'POST' : 'GET') {
  const r = await api.fetch(path, { method, data: body });
  assert.ok(r.ok(), await r.text());
  return r.json();
}
const all = (await call('/api/runs')).runs;
const run =
  all.find((r) => r.id === process.env.RANDL_MEDIA_RUN) ||
  all.find((r) => r.project === 'sdk-tests' && r.state === 'finished' && r.history_count === 13);
assert.ok(run, 'Run sdk_smoke.py first');
const views = [],
  projects = [];
// Videos autoplay by default; views here turn it off in workspace settings, so the viewer
// starts playback, unless `body.plotSettings` says otherwise.
const manualPlayback = { options: { video: { autoplay: false } } };
async function createView(project, panels, body = {}) {
  const view = await call('/api/tools/view_create', {
    project,
    name: 'Browser media ' + Date.now(),
  });
  views.push(view.id);
  Object.assign(view.body, { panels, plotSettings: manualPlayback, ...body });
  await call(
    '/api/views/' + view.id,
    { name: view.name, project: view.project, version: view.version, body: view.body },
    'PUT',
  );
  return view;
}
const checks = [];
let browser;
try {
  browser = await launchBrowser({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [],
    previews = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('/api/run-file-preview')) previews.push(new URL(r.url()));
  });
  const open = (view) =>
    page.goto(
      `${baseURL}/${view.project.split('/').map(encodeURIComponent).join('/')}/workspace?view=${view.id}`,
    );
  const panel = (id) => page.locator(`[data-panel-id="${id}"]`);

  // Every kind of logged media renders; audio and video load only when played.
  const sdk = await createView(
    run.entity + '/' + run.project,
    [
      ['image', 'image'],
      ['audio', 'audio'],
      ['video', 'video'],
      ['table', 'examples'],
      ['histogram', 'distribution'],
    ].map(([plugin, metric]) => ({ id: plugin, plugin, metric, title: plugin, section: 'kinds' })),
    {
      visible: [run.id],
      sections: [
        { id: 'kinds', name: 'kinds' },
        { id: 'steps', name: 'steps' },
      ],
    },
  );
  await open(sdk);
  const image = panel('image').locator('img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el) => [el.naturalWidth, el.naturalHeight]))
    .toEqual([4, 3]);
  await expect(panel('image').getByRole('gridcell')).toHaveAttribute(
    'aria-label',
    /Tiny image fixture, step 0, item 1 of 1/,
  );
  for (const type of ['audio', 'video']) {
    await panel(type).scrollIntoViewIfNeeded();
    assert.equal(await panel(type).locator(type).count(), 0, 'nothing loads before playing');
    await panel(type)
      .getByRole('button', { name: /^Play / })
      .click();
    const media = panel(type).locator(type);
    await expect(media).toBeVisible();
    await expect.poll(() => media.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(1);
    const result = await media.evaluate(async (el) => {
      el.muted = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { duration: el.duration, currentTime: el.currentTime, error: el.error?.message };
    });
    assert.ok(result.duration > 0);
    assert.ok(result.currentTime > 0);
    assert.equal(result.error, undefined);
  }
  const table = panel('table');
  await table.scrollIntoViewIfNeeded();
  await expect(table.locator('table')).toBeVisible();
  assert.match(await table.innerText(), /score|text|label/i);
  const histogram = panel('histogram');
  await histogram.scrollIntoViewIfNeeded();
  await expect(histogram.locator('canvas')).toBeVisible();
  checks.push('image, audio, video, table and histogram render');

  // Image lists across runs at one step, steps of one run, and the section's shared step.
  const steps = await createView(
    run.entity + '/' + run.project,
    [
      { id: 'gallery', plugin: 'image', metric: 'gallery', title: 'gallery', section: 'steps' },
      { id: 'clips', plugin: 'video', metric: 'clips', title: 'clips', section: 'steps' },
      { id: 'tones', plugin: 'audio', metric: 'tones', title: 'tones', section: 'steps' },
    ],
    {
      visible: [run.id],
      sections: [{ id: 'steps', name: 'steps' }],
      sectionLayouts: { steps: { width: 320, height: 420, rows: 2 } },
    },
  );
  await open(steps);
  const gallery = panel('gallery');
  await expect(gallery.getByRole('gridcell')).toHaveCount(3);
  await expect(gallery.locator('.media-step-label')).toHaveText('Step 8');
  await expect(gallery.locator('.cell-count')).toHaveText('3 items');
  await expect(gallery.locator('.media-caption').first()).toHaveText('Gallery 8 · 0');
  await gallery.getByRole('button', { name: 'Previous step', exact: true }).click();
  await expect(gallery.locator('.media-step-label')).toHaveText('Step 4');
  await expect(gallery.locator('.media-caption').first()).toHaveText('Gallery 4 · 0');
  // The other media panels of the section follow the step.
  await expect(panel('clips').locator('.media-step-label')).toHaveText('Step 4');
  await panel('tones').scrollIntoViewIfNeeded();
  await expect(panel('tones').locator('.media-step-label')).toHaveText('Step 4');
  await gallery.scrollIntoViewIfNeeded();
  // [ and ] step from a focused tile; Latest follows the newest step again.
  await gallery.getByRole('gridcell').first().focus();
  await page.keyboard.press('[');
  await expect(gallery.locator('.media-step-label')).toHaveText('Step 0');
  await page.keyboard.press(']');
  await expect(gallery.locator('.media-step-label')).toHaveText('Step 4');
  await gallery.getByRole('button', { name: 'Latest', exact: true }).click();
  await expect(gallery.locator('.media-step-label')).toHaveText('Step 8');
  await expect(gallery.getByRole('button', { name: 'Latest', exact: true })).toHaveCount(0);
  // Videos: at most one plays; starting another pauses the first.
  const clips = panel('clips');
  await clips.scrollIntoViewIfNeeded();
  await clips
    .getByRole('button', { name: /^Play / })
    .first()
    .click();
  await expect(clips.locator('video')).toHaveCount(1);
  // A video whose tile is replaced, here by another step's, stops and releases its element.
  await clips.locator('video').evaluate((el) => el.play());
  await expect.poll(() => clips.locator('video').evaluate((el) => el.paused)).toBe(false);
  await clips.getByRole('button', { name: 'Previous step', exact: true }).click();
  await expect(clips.locator('.media-step-label')).toHaveText('Step 4');
  await expect(clips.locator('video')).toHaveCount(0);
  await expect(clips.getByRole('button', { name: /^Play / })).toHaveCount(1);
  // Steps of one run: one tile per logged file at every step.
  const current = await call('/api/views/' + steps.id);
  current.body.panels[0].settings = { mediaAcross: 'steps' };
  await call(
    '/api/views/' + steps.id,
    { name: current.name, project: current.project, version: current.version, body: current.body },
    'PUT',
  );
  await open(steps);
  await expect(gallery.locator('.cell-count')).toHaveText('9 items');
  await expect(gallery.locator('.media-caption').first()).toHaveText('Gallery 0 · 0');
  await expect(gallery.getByRole('gridcell').first()).toHaveAttribute(
    'aria-label',
    'Gallery 0 · 0, step 0, item 1 of 3',
  );
  await expect(gallery.getByRole('combobox', { name: 'Run', exact: true })).toHaveValue(run.id);
  checks.push('steps, section step sync, keys, Latest and steps of one run');

  // A logged list of videos is one tile per file, with its caption, in the grid and Coverflow.
  const ranged = [];
  page.on('requestfinished', async (r) => {
    if (!r.url().includes('reel') && !r.url().includes('videos%2Freels')) return;
    const response = await r.response();
    ranged.push({ range: (await r.allHeaders()).range, status: response?.status() });
  });
  const reelPanels = await createView(
    run.entity + '/' + run.project,
    [{ id: 'reels', plugin: 'video', metric: 'reels', title: 'reels', section: 'reels' }],
    {
      visible: [run.id],
      sections: [{ id: 'reels', name: 'reels' }],
      sectionLayouts: { reels: { width: 1200, height: 420, rows: 1 } },
    },
  );
  previews.length = 0;
  await open(reelPanels);
  const reels = panel('reels');
  await expect(reels.getByRole('gridcell')).toHaveCount(3);
  await expect(reels.locator('.media-caption')).toHaveText([
    'Reel 8 · 0',
    'Reel 8 · 1',
    'Reel 8 · 2',
  ]);
  await expect(reels.locator('.cell-count')).toHaveText('3 items');
  assert.equal(await reels.locator('video').count(), 0, 'no video loads before playing');
  assert.equal(previews.length, 0, 'no video file is requested before playing');
  // Played, the file streams by byte range: the whole clip is seekable at once.
  await reels.getByRole('button', { name: 'Play Reel 8 · 1' }).click();
  const reel = reels.locator('video');
  await expect(reel).toHaveCount(1);
  await expect(reel).toHaveAttribute('preload', 'metadata');
  await expect.poll(() => reel.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(1);
  const seek = await reel.evaluate(async (el) => {
    el.muted = true;
    el.pause();
    const seekable = el.seekable.length ? el.seekable.end(0) : 0;
    el.currentTime = 6;
    await new Promise((resolve) => el.addEventListener('seeked', resolve, { once: true }));
    return { seekable, duration: el.duration, currentTime: el.currentTime };
  });
  assert.ok(seek.duration > 7 && seek.seekable >= seek.duration - 0.1, JSON.stringify(seek));
  assert.ok(Math.abs(seek.currentTime - 6) < 0.5, JSON.stringify(seek));
  await expect.poll(() => ranged.some((item) => item.status === 206 && item.range)).toBe(true);
  // Steps of the slider move the whole list; the files-per-step limit applies to the list.
  await reels.getByRole('button', { name: 'Previous step', exact: true }).click();
  await expect(reels.locator('.media-caption').first()).toHaveText('Reel 4 · 0');
  const reelView = await call('/api/views/' + reelPanels.id);
  reelView.body.panels[0].settings = { mediaFiles: 2, layout: 'coverflow' };
  await call(
    '/api/views/' + reelPanels.id,
    {
      name: reelView.name,
      project: reelView.project,
      version: reelView.version,
      body: reelView.body,
    },
    'PUT',
  );
  await open(reelPanels);
  await expect(reels.locator('.cell-count')).toHaveText('2 of 3 items');
  // Coverflow's items are the run's files; one run needs no run tabs.
  const reelSlide = reels.locator('.carousel-slide');
  await expect(reelSlide).toHaveAttribute(
    'aria-label',
    /^1 of 2: SDK compatibility test · Reel 8 · 0, step 8/,
  );
  await expect(reelSlide.locator('.media-caption')).toHaveText('Reel 8 · 0');
  await expect(reels.getByRole('tab')).toHaveCount(0);
  await reels.getByRole('button', { name: 'Next item', exact: true }).click();
  await expect(reelSlide).toHaveAttribute(
    'aria-label',
    /^2 of 2: SDK compatibility test · Reel 8 · 1, step 8/,
  );
  assert.equal(await reels.locator('video').count(), 0);
  // Steps of one run: the items are the run's files at every step, without tabs.
  const stepsView = await call('/api/views/' + reelPanels.id);
  stepsView.body.panels[0].settings = { mediaFiles: 2, layout: 'coverflow', mediaAcross: 'steps' };
  await call(
    '/api/views/' + reelPanels.id,
    {
      name: stepsView.name,
      project: stepsView.project,
      version: stepsView.version,
      body: stepsView.body,
    },
    'PUT',
  );
  await open(reelPanels);
  const stepFiles = (
    await call('/api/media', {
      runs: [run.id],
      metric: 'reels',
      files: 2,
      across: 'steps',
      run: run.id,
    })
  ).entries.reduce((sum, entry) => sum + entry.value.videos.length, 0);
  assert.ok(stepFiles > 2, String(stepFiles));
  await expect(reelSlide).toHaveAttribute('aria-label', new RegExp(`^1 of ${stepFiles}: `));
  await expect(reels.getByRole('tab')).toHaveCount(0);
  const firstStep = await reelSlide.locator('.media-caption').textContent();
  await reelSlide.focus();
  await page.keyboard.press('End');
  await expect(reelSlide).toHaveAttribute(
    'aria-label',
    new RegExp(`^${stepFiles} of ${stepFiles}: `),
  );
  assert.notEqual(await reelSlide.locator('.media-caption').textContent(), firstStep);
  checks.push(
    'video lists: a tile per file with captions, Coverflow, files per step, Range seeking',
  );

  // Autoplay: muted while on screen, at most six per panel, stopped when scrolled away.
  const autoplayView = await createView(
    run.entity + '/' + run.project,
    [
      {
        id: 'auto',
        plugin: 'video',
        metric: 'reels',
        title: 'auto',
        section: 'auto',
        settings: { mediaAcross: 'steps', itemSize: 160 },
      },
      ...['image', 'audio', 'video'].map((metric) => ({
        id: 'filler-' + metric,
        plugin: metric,
        metric,
        title: metric,
        section: 'filler',
      })),
    ],
    {
      // Autoplay and Loop are on by default.
      plotSettings: {},
      visible: [run.id],
      sections: [
        { id: 'auto', name: 'auto' },
        { id: 'filler', name: 'filler' },
      ],
      sectionLayouts: {
        auto: { width: 1200, height: 560, rows: 1 },
        filler: { width: 1200, height: 800, rows: 3 },
      },
    },
  );
  await open(autoplayView);
  const auto = panel('auto');
  await expect(auto.getByRole('gridcell')).toHaveCount(9);
  const playing = () =>
    auto.locator('video').evaluateAll((all) => all.filter((el) => !el.paused && el.muted).length);
  await expect.poll(playing).toBe(6);
  assert.ok((await auto.locator('video').count()) <= 6, 'at most six videos per panel');
  await expect(auto.locator('.media-unmute')).toHaveCount(6);
  assert.ok(
    await auto
      .locator('video')
      .first()
      .evaluate((el) => el.loop),
  );
  // Unmuting gives a video sound; the others keep playing muted.
  await auto.locator('.media-unmute').first().click();
  await expect(auto.locator('.media-unmute')).toHaveCount(5);
  await expect
    .poll(() => auto.locator('video').evaluateAll((all) => all.filter((el) => !el.muted).length))
    .toBe(1);
  await expect.poll(playing).toBe(5);
  await panel('filler-video').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      auto.locator('video:not([muted])').evaluateAll((all) => all.filter((el) => el.muted).length),
    )
    .toBe(0);
  await expect
    .poll(() => auto.locator('video').evaluateAll((all) => all.filter((el) => !el.paused).length))
    .toBe(0);
  await auto.scrollIntoViewIfNeeded();
  await expect.poll(playing).toBeGreaterThanOrEqual(5);
  // Reduced motion turns autoplay off.
  const calm = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await calm.goto(page.url());
  await expect(calm.locator('[data-panel-id="auto"]').getByRole('gridcell')).toHaveCount(9);
  await calm.waitForTimeout(1000);
  assert.equal(await calm.locator('[data-panel-id="auto"] video').count(), 0);
  await calm.close();
  checks.push('autoplay: muted on screen, six per panel, unmute, stops off screen, reduced motion');

  // Media options show in the Display tab in every layout and at every settings level, on by
  // default, and toggling them saves the layer that was edited.
  const optionsView = await createView(
    run.entity + '/' + run.project,
    [
      { id: 'grid-video', plugin: 'video', metric: 'video', title: 'grid video', section: 'opts' },
      {
        id: 'flow-video',
        plugin: 'video',
        metric: 'video',
        title: 'flow video',
        section: 'opts',
        settings: { layout: 'coverflow' },
      },
      { id: 'grid-image', plugin: 'image', metric: 'image', title: 'grid image', section: 'opts' },
      {
        id: 'flow-image',
        plugin: 'image',
        metric: 'image',
        title: 'flow image',
        section: 'opts',
        settings: { layout: 'coverflow' },
      },
    ],
    { plotSettings: {}, visible: [run.id], sections: [{ id: 'opts', name: 'opts' }] },
  );
  const storedOptions = async () => (await call('/api/views/' + optionsView.id)).body;
  await open(optionsView);
  const videoOptions = ['Loop videos', 'Autoplay videos'],
    imageOptions = ['Image fit', 'Smooth scaled images'];
  async function displayTab(dialog, labels, checked) {
    await dialog.getByRole('tab', { name: 'Display', exact: true }).click();
    for (const label of labels)
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    for (const label of checked)
      await expect(dialog.getByRole('checkbox', { name: label, exact: true })).toBeChecked();
  }
  const editor = page.getByRole('dialog', { name: 'Panel settings', exact: true });
  async function openEditor(id) {
    await panel(id).hover();
    await panel(id).getByRole('button', { name: 'Panel settings', exact: true }).click();
  }
  for (const id of ['grid-video', 'flow-video', 'grid-image', 'flow-image']) {
    await openEditor(id);
    const video = id.endsWith('video');
    await displayTab(
      editor,
      video ? videoOptions : imageOptions,
      video ? videoOptions : ['Smooth scaled images'],
    );
    await expect(editor.getByRole('slider', { name: 'Item size' })).toHaveCount(
      id.startsWith('grid') ? 1 : 0,
    );
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  // Switching the layout in the editor keeps them.
  await openEditor('grid-video');
  await editor.getByRole('tab', { name: 'Coverflow', exact: true }).click();
  await displayTab(editor, videoOptions, videoOptions);
  await editor.getByText('Loop videos', { exact: true }).click();
  await editor.getByRole('button', { name: 'Save panel', exact: true }).click();
  await expect
    .poll(async () => (await storedOptions()).panels.find((p) => p.id === 'grid-video').settings)
    .toEqual({ layout: 'coverflow', options: { video: { loop: false } } });
  await expect(panel('grid-video').locator('video')).toHaveCount(1);
  await expect
    .poll(() =>
      panel('grid-video')
        .locator('video')
        .evaluate((el) => el.loop),
    )
    .toBe(false);
  await expect
    .poll(() =>
      panel('flow-video')
        .locator('video')
        .evaluate((el) => el.loop),
    )
    .toBe(true);
  await openEditor('grid-video');
  await displayTab(editor, videoOptions, ['Autoplay videos']);
  await expect(
    editor.getByRole('checkbox', { name: 'Loop videos', exact: true }),
  ).not.toBeChecked();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Section and workspace settings list both plugins' options.
  for (const [name, layer] of [
    ['opts section settings', 'section'],
    ['Workspace settings', 'workspace'],
  ]) {
    if (layer === 'section') await page.locator('.section-heading').first().hover();
    await page.getByRole('button', { name, exact: true }).click();
    const drawer = page.getByRole('dialog', { name, exact: true });
    await displayTab(drawer, [...videoOptions, ...imageOptions], videoOptions);
    await drawer
      .getByText(layer === 'section' ? 'Autoplay videos' : 'Loop videos', { exact: true })
      .click();
    await drawer.getByRole('button', { name: 'Apply settings', exact: true }).click();
    await expect(drawer).not.toBeVisible();
  }
  await expect
    .poll(async () => {
      const body = await storedOptions();
      return [body.sectionSettings?.opts?.options, body.plotSettings?.options];
    })
    .toEqual([{ video: { autoplay: false } }, { video: { loop: false } }]);
  checks.push(
    'media options in Grid and Coverflow, in panel, section and workspace settings; on by default; saved',
  );

  // Synthetic project: lazy loading and the files-per-step limit.
  const demo = all.filter((item) => item.project === 'media-demo');
  if (demo.length >= 6) {
    const lazy = await createView(
      'demo/media-demo',
      [
        {
          id: 'samples',
          plugin: 'image',
          metric: 'samples',
          title: 'samples',
          section: 'lazy',
          settings: { itemSize: 320 },
        },
      ],
      {
        visible: demo.map((item) => item.id),
        sections: [{ id: 'lazy', name: 'lazy' }],
        sectionLayouts: { lazy: { width: 3000, height: 360, rows: 1 } },
      },
    );
    previews.length = 0;
    await open(lazy);
    const samples = panel('samples');
    await expect(samples.locator('.media-tile').first()).toBeVisible();
    // Every run's latest images (earlier runs of this suite may have logged a later step).
    const files = (
      await call('/api/media', {
        runs: demo.map((item) => item.id),
        metric: 'samples',
        files: 1000,
      })
    ).entries.reduce((sum, entry) => sum + entry.value.filenames.length, 0);
    await expect(samples.locator('.cell-count')).toHaveText(files + ' items');
    const mounted = await samples.getByRole('gridcell').count();
    assert.ok(mounted < files, `${mounted} tiles mounted of ${files}`);
    await expect.poll(() => previews.length).toBe(mounted);
    // Scrolling loads only the tiles that enter the window, and leaving one stops its load.
    await samples
      .locator('.tile-scroller')
      .evaluate((node) => (node.scrollTop = node.scrollHeight));
    await expect.poll(() => samples.locator('img[src]').count()).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const ever = new Set(
      previews.map((url) => url.searchParams.get('path') + url.searchParams.get('run')),
    );
    assert.ok(
      ever.size <= files && previews.length <= ever.size,
      JSON.stringify([previews.length, ever.size]),
    );
    assert.ok((await samples.locator('img').count()) <= 200, 'At most 200 tiles mount per panel');
    // Enter opens a tile's run in full-screen Coverflow at that file; Escape returns to the
    // file last shown.
    await samples.locator('.tile-scroller').evaluate((node) => (node.scrollTop = 0));
    const perRun = Number(
      (await samples.locator('[role="gridcell"][data-index="0"]').getAttribute('aria-label')).match(
        /of (\d+)$/,
      )[1],
    );
    await samples.locator('[role="gridcell"][data-index="1"]').focus();
    await page.keyboard.press('Enter');
    const look = page.locator('dialog.media-quicklook');
    await expect(look).toBeVisible();
    const lookSlide = look.locator('.carousel-slide');
    await expect(lookSlide).toBeFocused();
    // Quick Look's items are the run's files, and the run tabs keep the position.
    await expect(lookSlide).toHaveAttribute('aria-label', /^2 of \d+: .*, item 2 of \d+$/);
    await expect(lookSlide.locator('img')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(lookSlide).toHaveAttribute('aria-label', /^3 of \d+: .*, item 3 of \d+$/);
    const lookTabs = look.getByRole('tab');
    await expect(lookTabs.first()).toHaveAttribute('aria-selected', 'true');
    await lookTabs.nth(1).click();
    await expect(lookSlide).toHaveAttribute('aria-label', /^3 of \d+: .*, item 3 of \d+$/);
    await expect(lookTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await lookSlide.focus();
    await page.keyboard.press('Escape');
    await expect(look).toHaveCount(0);
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.index),
      String(perRun + 2),
      'focus returns to the file last shown',
    );
    // Coverflow shows one run's files, with image neighbors and run tabs.
    const flow = await call('/api/views/' + lazy.id);
    flow.body.panels[0].settings = { layout: 'coverflow' };
    await call(
      '/api/views/' + lazy.id,
      { name: flow.name, project: flow.project, version: flow.version, body: flow.body },
      'PUT',
    );
    await open(lazy);
    const flowSlide = samples.locator('.carousel-slide');
    await expect(flowSlide.locator('img')).toBeVisible();
    await expect(flowSlide).toHaveAttribute('aria-label', new RegExp(`^1 of ${perRun}: `));
    // The panel is wide enough for all of the run's other files beside the first.
    await expect(samples.locator('.carousel-peek img')).toHaveCount(perRun - 1);
    await expect(samples.getByRole('tab')).toHaveCount(
      (await call('/api/media', { runs: demo.map((item) => item.id), metric: 'samples' })).entries
        .length,
    );
    await samples.getByRole('button', { name: 'Next item', exact: true }).click();
    await expect(flowSlide).toHaveAttribute('aria-label', new RegExp(`^2 of ${perRun}: `));
    await expect(samples.locator('.carousel-peek img')).toHaveCount(perRun - 1);
    checks.push("Quick Look and Coverflow show a run's files, with run tabs");
    // Files per step are shared among the runs.
    const limited = await call('/api/views/' + lazy.id);
    limited.body.panels[0].settings = { itemSize: 320, mediaFiles: 12 };
    limited.body.panels[0].settings.layout = 'grid';
    await call(
      '/api/views/' + lazy.id,
      {
        name: limited.name,
        project: limited.project,
        version: limited.version,
        body: limited.body,
      },
      'PUT',
    );
    await open(lazy);
    await expect(samples.locator('.cell-count')).toHaveText(`12 of ${files} items`);
    checks.push('images load only for tiles in view; files per step are shared among runs');
  }

  // Latest follows newly logged steps, in a project of this test's own that it removes.
  const entity = 'browser-media',
    live = { project: entity + '/live-' + Date.now(), run: '' };
  live.run = live.project + '/run';
  await call('/graphql', {
    query: 'mutation UpsertBucket { upsertBucket }',
    variables: { entity, project: live.project.split('/')[1], name: 'run' },
  });
  projects.push(live.project);
  const log = (offset, step, complete = false) =>
    call(`/files/${live.run}/file_stream`, {
      files: {
        'wandb-history.jsonl': {
          offset,
          content: [
            JSON.stringify({
              _step: step,
              frames: { _type: 'image-file', path: 'media/images/frame.png', width: 4, height: 3 },
            }),
          ],
        },
      },
      ...(complete ? { complete: true, exitcode: 0 } : {}),
    });
  await log(0, 0);
  await log(1, 10);
  const following = await createView(
    live.project,
    [{ id: 'live', plugin: 'image', metric: 'frames', title: 'frames', section: 'live' }],
    { visible: [live.run], sections: [{ id: 'live', name: 'live' }] },
  );
  await open(following);
  const label = panel('live').locator('.media-step-label');
  await expect(label).toHaveText('Step 10');
  // The file was never uploaded, which the tile states.
  await expect(panel('live').locator('.media-missing')).toHaveText('Preview unavailable');
  await log(2, 20, true);
  await expect(label).toHaveText('Step 20');
  checks.push('Latest follows newly logged steps; a missing file says so');

  // Automatic panels: logged lists of videos and audio get video and audio panels, and an
  // audio list is a tile per clip with its caption.
  const lists = { project: entity + '/lists-' + Date.now(), run: '' };
  lists.run = lists.project + '/run';
  await call('/graphql', {
    query: 'mutation UpsertBucket { upsertBucket }',
    variables: { entity, project: lists.project.split('/')[1], name: 'run' },
  });
  projects.push(lists.project);
  const sdkMedia = (metric) => call('/api/media', { runs: [run.id], metric });
  const [tone, clip] = [
    (await sdkMedia('audio')).entries[0].value,
    (await sdkMedia('video')).entries[0].value,
  ];
  const copy = async (from, to) => {
    const bytes = await (
      await api.fetch('/api/run-files?' + new URLSearchParams({ run: run.id, path: from.path }))
    ).body();
    const put = await api.fetch(`/upload/${lists.run}/${to}`, { method: 'PUT', data: bytes });
    assert.ok(put.ok(), await put.text());
    return { ...from, path: to };
  };
  const voices = [
    await copy(tone, 'media/audio/voice_0.wav'),
    await copy(tone, 'media/audio/voice_1.wav'),
  ];
  const episodes = [await copy(clip, 'media/videos/episode_0.mp4')];
  await call(`/files/${lists.run}/file_stream`, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [
          JSON.stringify({
            _step: 0,
            voices: {
              _type: 'audio',
              count: 2,
              audio: voices,
              captions: ['Voice A', 'Voice B'],
              sampleRates: [8000, 8000],
              durations: [0.1, 0.1],
            },
            episodes: { _type: 'videos', count: 1, videos: episodes, captions: false },
          }),
        ],
      },
    },
    complete: true,
    exitcode: 0,
  });
  const generated = await createView(lists.project, [], {
    visible: [lists.run],
    generation: 'automatic',
  });
  await open(generated);
  await expect
    .poll(async () =>
      Object.fromEntries(
        (await call('/api/views/' + generated.id)).body.panels.map((item) => [
          item.metric,
          item.plugin,
        ]),
      ),
    )
    .toEqual({ episodes: 'video', voices: 'audio' });
  const generatedPanels = (await call('/api/views/' + generated.id)).body.panels;
  const voicesPanel = panel(generatedPanels.find((item) => item.metric === 'voices').id);
  await expect(voicesPanel.getByRole('gridcell')).toHaveCount(2);
  await expect(voicesPanel.locator('.media-caption')).toHaveText(['Voice A', 'Voice B']);
  await voicesPanel.getByRole('button', { name: 'Play Voice B' }).click();
  await expect
    .poll(() => voicesPanel.locator('audio').evaluate((el) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  checks.push('automatic panels for video and audio lists; audio lists tile per clip');

  // Videos of several runs: first-frame posters, playback while partly visible, full screen
  // in the grid and Coverflow, and Coverflow's run strip. The runs log SDK media descriptors
  // for clips made here with ffmpeg: wide (64:27), tall (9:16) and the SDK's 4:3 reel.
  const clipsDir = await mkdtemp(join(tmpdir(), 'randl-media-clips-'));
  const encode = (name, source, seconds) => {
    const path = join(clipsDir, name);
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      source,
      '-t',
      String(seconds),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-movflags',
      '+faststart',
      '-y',
      path,
    ]);
    return readFile(path);
  };
  const flowFiles = {
    wide: await encode('wide.mp4', 'testsrc2=s=640x270:r=30', 6),
    tall: await encode('tall.mp4', 'testsrc2=s=180x320:r=30', 6),
    reel: await (
      await api.fetch(
        '/api/run-files?' +
          new URLSearchParams({
            run: run.id,
            path: (await call('/api/media', { runs: [run.id], metric: 'reels' })).entries[0].value
              .videos[0].path,
          }),
      )
    ).body(),
  };
  const flowProject = entity + '/flow-' + Date.now(),
    flowRuns = [
      ['wide', 'Wide run', ['wide', 'reel', 'tall']],
      ['tall', 'Tall run', ['tall']],
      ['reel', 'Reel run', ['reel']],
    ];
  projects.push(flowProject);
  for (const [name, display, list] of flowRuns) {
    const id = flowProject + '/' + name;
    await call('/graphql', {
      query: 'mutation UpsertBucket { upsertBucket }',
      variables: { entity, project: flowProject.split('/')[1], name, displayName: display },
    });
    const descriptor = async (file, index) => {
      const path = `media/videos/${name}_${index}_${file}.mp4`,
        put = await api.fetch(`/upload/${id}/${path}`, { method: 'PUT', data: flowFiles[file] });
      assert.ok(put.ok(), await put.text());
      return { _type: 'video-file', path, size: flowFiles[file].length };
    };
    await call(`/files/${id}/file_stream`, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: [
            JSON.stringify({
              _step: 0,
              clip: {
                ...(await descriptor(name === 'reel' ? 'reel' : name, 'clip')),
                caption: display + ' clip',
              },
              episodes: {
                _type: 'videos',
                count: list.length,
                videos: await Promise.all(list.map((file, index) => descriptor(file, index))),
                captions: list,
              },
            }),
          ],
        },
      },
      complete: true,
      exitcode: 0,
    });
  }
  const flowIds = (await call('/api/runs')).runs
    .filter((item) => item.project === flowProject.split('/')[1] && item.entity === entity)
    .map((item) => item.id);
  assert.equal(flowIds.length, 3);
  const flowView = (panels, layouts) =>
    createView(flowProject, panels, {
      visible: flowIds,
      sections: Object.keys(layouts).map((id) => ({ id, name: id })),
      sectionLayouts: layouts,
    });
  // Posters: the first frame of every video shows before playing, from the poster endpoint;
  // no video file is requested.
  previews.length = 0;
  const posterBytes = [];
  const recordPoster = async (r) => {
    if (!r.url().includes('/api/run-file-poster')) return;
    posterBytes.push(
      (await r.response())?.headers()['content-length'] ?? (await r.sizes()).responseBodySize,
    );
  };
  page.on('requestfinished', recordPoster);
  const gridView = await flowView(
    [
      { id: 'clips', plugin: 'video', metric: 'clip', title: 'clips', section: 'videos' },
      { id: 'below', plugin: 'video', metric: 'episodes', title: 'below', section: 'below' },
    ],
    {
      videos: { width: 1200, height: 520, rows: 1 },
      below: { width: 1200, height: 800, rows: 1 },
    },
  );
  await open(gridView);
  const clipsPanel = panel('clips');
  await expect(clipsPanel.getByRole('gridcell')).toHaveCount(3);
  await expect
    .poll(() =>
      clipsPanel
        .locator('.media-poster')
        .evaluateAll((all) => all.filter((img) => img.naturalWidth > 0).length),
    )
    .toBe(3);
  assert.equal(previews.length, 0, 'posters load no video file');
  // The posters are the videos' first frames at their sizes.
  const posterSizes = await clipsPanel
    .locator('.media-poster')
    .evaluateAll((all) => all.map((img) => [img.naturalWidth, img.naturalHeight]));
  assert.deepEqual(new Set(posterSizes.map(String)), new Set(['640,270', '180,320', '320,240']));
  checks.push(`posters: first frames without video requests (${posterBytes.join(', ')} bytes)`);
  // Tiles have their videos' shapes from the first paint, before any poster arrives (the
  // server reads each file's size from its header; the SDK logs none for files), on the
  // panel's background with no band; and posters whose loads a new layout cut off load again.
  const heldPage = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    heldPosters = [];
  let holdPosters = true;
  await heldPage.route('**/api/run-file-poster*', (route) =>
    holdPosters ? heldPosters.push(route) : route.continue(),
  );
  await heldPage.goto(page.url());
  const heldPanel = heldPage.locator('[data-panel-id="clips"]');
  await expect.poll(() => heldPosters.length).toBeGreaterThanOrEqual(3);
  const fileAspects = { Wide: 640 / 270, Tall: 180 / 320, Reel: 320 / 240 };
  const shapes = await heldPanel.locator('.media-tile').evaluateAll((cells) =>
    cells.map((cell) => {
      const frame = cell.querySelector('.media-frame'),
        box = frame.getBoundingClientRect();
      let panel = frame.parentElement;
      while (getComputedStyle(panel).backgroundColor === 'rgba(0, 0, 0, 0)')
        panel = panel.parentElement;
      return {
        run: cell.querySelector('.media-caption').textContent.split(' ')[0],
        aspect: box.width / box.height,
        poster: frame.querySelector('.media-poster').naturalWidth,
        background: getComputedStyle(frame).backgroundColor,
        panel: getComputedStyle(panel).backgroundColor,
      };
    }),
  );
  assert.equal(shapes.length, 3);
  for (const shape of shapes) {
    assert.equal(shape.poster, 0, 'before the poster');
    assert.ok(Math.abs(shape.aspect / fileAspects[shape.run] - 1) < 0.02, JSON.stringify(shape));
    assert.equal(shape.background, shape.panel, 'no band: ' + JSON.stringify(shape));
  }
  // Expanding and collapsing the panel twice lays the tiles out anew and cuts off their
  // poster loads, more than the four that run at once; the new tiles' posters still load.
  for (let i = 0; i < 4; i++) {
    await heldPanel.locator('.chart-header').hover();
    await heldPanel.locator('.chart-expand').click();
    await heldPage.waitForTimeout(150);
  }
  holdPosters = false;
  for (const route of heldPosters.splice(0)) await route.continue().catch(() => {});
  await expect
    .poll(() =>
      heldPanel
        .locator('.media-poster')
        .evaluateAll((all) => all.filter((img) => img.naturalWidth > 0).length),
    )
    .toBe(3);
  await heldPage.close();
  checks.push(
    "video tiles at their files' shapes before posters, no bands; posters survive re-layouts",
  );
  // Quick Look of one video per run: the items are the runs, without tabs.
  await clipsPanel.locator('[role="gridcell"][data-index="1"]').focus();
  await page.keyboard.press('Enter');
  const singleLook = page.locator('dialog.media-quicklook');
  await expect(singleLook.locator('.carousel-slide')).toHaveAttribute('aria-label', /^2 of 3: /);
  await expect(singleLook.getByRole('tab')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(singleLook.locator('.carousel-slide')).toHaveAttribute('aria-label', /^3 of 3: /);
  await page.keyboard.press('Escape');
  await expect(singleLook).toHaveCount(0);
  await expect(clipsPanel.locator('[role="gridcell"][data-index="2"]')).toBeFocused();

  // A playing video keeps playing while any part of its tile is on screen, and pauses when
  // the tile has left entirely.
  const scroller = page.locator('main');
  const tile = clipsPanel.locator('[role="gridcell"][data-index="0"]');
  await tile.getByRole('button', { name: /^Play / }).click();
  const playingVideo = tile.locator('video');
  await playingVideo.evaluate((el) => (el.muted = false));
  await expect.poll(() => playingVideo.evaluate((el) => !el.paused)).toBe(true);
  // Scrolls until `visiblePixels` of the video's frame remain below the workspace's top.
  const scrollTileTo = async (visiblePixels) => {
    const [box, top] = await Promise.all([
      tile.locator('.media-frame').boundingBox(),
      scroller.evaluate((el) => el.getBoundingClientRect().top),
    ]);
    await scroller.evaluate(
      (el, by) => el.scrollBy(0, by),
      box.y + box.height - visiblePixels - top,
    );
  };
  await scrollTileTo(12);
  await page.waitForTimeout(400);
  assert.equal(
    await playingVideo.evaluate((el) => el.paused),
    false,
    'a partly visible video plays',
  );
  await scrollTileTo(-40);
  await expect.poll(() => playingVideo.evaluate((el) => el.paused)).toBe(true);
  await scroller.evaluate((el) => (el.scrollTop = 0));
  checks.push('a video plays while partly visible and pauses once fully off screen');

  // Videos the viewer starts play together: starting one never pauses another. Each fills its
  // frame at its own aspect, with no band. Expanding and collapsing the panel keeps both
  // playing in the same elements, from where they were.
  await playingVideo.evaluate((el) => el.play());
  await clipsPanel
    .locator('[role="gridcell"][data-index="2"]')
    .getByRole('button', { name: /^Play / })
    .click();
  const players = clipsPanel.locator('video');
  const playback = () =>
    players.evaluateAll((all) =>
      all.map((el) => ({ mark: el.dataset.mark, playing: !el.paused, time: el.currentTime })),
    );
  await expect
    .poll(async () => (await playback()).map((item) => item.playing && item.time > 0))
    .toEqual([true, true]);
  const bands = await players.evaluateAll((all) =>
    all.map((el) => [
      el.getBoundingClientRect().width / el.getBoundingClientRect().height,
      el.videoWidth / el.videoHeight,
      getComputedStyle(el).backgroundColor,
    ]),
  );
  for (const [box, file, background] of bands) {
    assert.ok(Math.abs(box / file - 1) < 0.02, JSON.stringify(bands));
    assert.equal(background, 'rgba(0, 0, 0, 0)');
  }
  await players.evaluateAll((all) => all.forEach((el, i) => (el.dataset.mark = 'player' + i)));
  let times = (await playback()).map((item) => item.time);
  for (const step of ['expanded', 'collapsed']) {
    await clipsPanel.locator('.chart-header').hover();
    await clipsPanel.locator('.chart-expand').click();
    await page.waitForTimeout(400);
    const now = await playback();
    assert.deepEqual(
      now.map((item) => [item.mark, item.playing]),
      [
        ['player0', true],
        ['player1', true],
      ],
      step,
    );
    now.forEach((item, i) => assert.ok(item.time > times[i], step + ' keeps the position'));
    times = now.map((item) => item.time);
  }
  await players.evaluateAll((all) => all.forEach((el) => el.pause()));
  checks.push('started videos play together and keep playing as the panel expands and collapses');

  // Full screen from a grid tile: the window resizes, the tile and its playback stay, and
  // leaving full screen returns to the same tile, still playing.
  // The window takes its earlier size as full screen ends, before or after the event.
  const fullscreenCheck = async (target, layout, resizeFirst = true) => {
    const video = target.locator('video');
    await expect.poll(() => video.evaluate((el) => !el.paused)).toBe(true);
    const before = await video.evaluate((el) => {
      el.dataset.mark = 'fullscreen';
      return el.closest('[data-index]').dataset.index;
    });
    await video.evaluate((el) => el.requestFullscreen());
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(500);
    const inside = await page.evaluate(() => ({
      element: document.fullscreenElement?.dataset.mark,
      paused: document.querySelector('[data-mark="fullscreen"]')?.paused,
    }));
    assert.deepEqual(inside, { element: 'fullscreen', paused: false }, layout + ' full screen');
    if (resizeFirst) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => document.exitFullscreen());
    } else {
      await page.evaluate(() => document.exitFullscreen());
      await page.waitForTimeout(200);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const el = document.querySelector('[data-mark="fullscreen"]');
      return {
        full: !!document.fullscreenElement,
        connected: !!el?.isConnected,
        paused: el?.paused,
        index: el?.closest('[data-index]')?.dataset.index,
      };
    });
    assert.deepEqual(after, { full: false, connected: true, paused: false, index: before }, layout);
    await video.evaluate((el) => el.pause());
  };
  await tile.locator('video').evaluate((el) => el.play());
  await fullscreenCheck(tile, 'grid');
  await tile.locator('video').evaluate((el) => el.play());
  await fullscreenCheck(tile, 'grid, resized after', false);
  checks.push('full screen from a grid tile keeps the tile and its playback, in and out');

  // Coverflow: when a run logged several videos, the items are one run's videos and run tabs
  // choose the run, keeping the position (or the run's last video). When every run logged
  // one, the items are the runs and there are no tabs. There is no file control.
  const flow = await flowView(
    [
      {
        id: 'episodes',
        plugin: 'video',
        metric: 'episodes',
        title: 'episodes',
        section: 'videos',
        settings: { layout: 'coverflow' },
      },
      {
        id: 'single',
        plugin: 'video',
        metric: 'clip',
        title: 'single',
        section: 'videos',
        settings: { layout: 'coverflow' },
      },
    ],
    { videos: { width: 1400, height: 520, rows: 2 } },
  );
  await open(flow);
  const flowPanel = panel('episodes'),
    flowSlide = flowPanel.locator('.carousel-slide'),
    flowTabs = flowPanel.getByRole('tab');
  // Newest run first.
  await expect(flowTabs).toHaveText(['Reel run', 'Tall run', 'Wide run']);
  await expect(flowPanel.getByRole('tablist')).toHaveCount(1);
  await expect(flowSlide).toHaveAttribute('aria-label', /^1 of 1: Reel run · reel, /);
  await flowPanel.getByRole('tab', { name: 'Wide run' }).click();
  await expect(flowSlide).toHaveAttribute(
    'aria-label',
    '1 of 3: Wide run · wide, step 0, item 1 of 3',
  );
  await expect(flowPanel.locator('.carousel-item')).toHaveCount(3);
  await flowPanel.getByRole('button', { name: 'Next item', exact: true }).click();
  await expect(flowSlide).toHaveAttribute('aria-label', /^2 of 3: Wide run · reel, /);
  await expect(flowSlide.locator('.media-caption')).toHaveText('reel');
  // A click on a neighbor shows it; Left and Right move, Up and Down do nothing.
  await flowPanel.locator('.carousel-peek[data-index="2"]').click();
  await expect(flowSlide).toHaveAttribute('aria-label', /^3 of 3: Wide run · tall, /);
  await flowSlide.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(flowSlide).toHaveAttribute('aria-label', /^2 of 3: /);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(flowSlide).toHaveAttribute('aria-label', /^2 of 3: /);
  await page.keyboard.press('End');
  await expect(flowSlide).toHaveAttribute('aria-label', /^3 of 3: /);
  // No secondary control under the current video, in any run.
  for (const name of ['Next file', 'Previous file'])
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(flowPanel.locator('.media-footer button, .media-footer [role="group"]')).toHaveCount(
    0,
  );
  // Another run shows its third video, or its last when it has fewer; the position stays.
  await flowPanel.getByRole('tab', { name: 'Tall run' }).click();
  await expect(flowSlide).toHaveAttribute('aria-label', /^1 of 1: Tall run · tall, /);
  await flowPanel.getByRole('tab', { name: 'Wide run' }).click();
  await expect(flowSlide).toHaveAttribute('aria-label', /^3 of 3: Wide run · tall, /);
  await flowPanel.getByRole('button', { name: 'Previous item', exact: true }).click();
  await expect(flowSlide).toHaveAttribute('aria-label', /^2 of 3: Wide run · reel, /);
  // The tabs are a tab list: arrows, Home and End choose the run and keep focus on its tab.
  const wideTab = flowPanel.getByRole('tab', { name: 'Wide run' });
  await expect(wideTab).toHaveAttribute('aria-selected', 'true');
  await expect(wideTab).toHaveAttribute('tabindex', '0');
  const stageId = await flowPanel.locator('.carousel-stage').getAttribute('id');
  await expect(wideTab).toHaveAttribute('aria-controls', stageId);
  await expect(flowPanel.locator('.carousel-stage')).toHaveAttribute('role', 'tabpanel');
  await wideTab.focus();
  await page.keyboard.press('ArrowLeft');
  const tallTab = flowPanel.getByRole('tab', { name: 'Tall run' });
  await expect(tallTab).toBeFocused();
  await expect(tallTab).toHaveAttribute('aria-selected', 'true');
  await expect(flowSlide).toHaveAttribute('aria-label', /^1 of 1: Tall run · /);
  await page.keyboard.press('Home');
  await expect(flowPanel.getByRole('tab', { name: 'Reel run' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(wideTab).toBeFocused();
  await expect(flowSlide).toHaveAttribute('aria-label', /^2 of 3: Wide run · reel, /);
  checks.push("Coverflow: a run's videos with run tabs that keep the position (or clamp)");
  // One video per run: the items are the runs, the caption names the run, and no tabs.
  const single = panel('single'),
    singleSlide = single.locator('.carousel-slide');
  await expect(single.getByRole('tab')).toHaveCount(0);
  await expect(single.locator('.carousel-strip')).toBeHidden();
  await expect(singleSlide).toHaveAttribute('aria-label', /^1 of 3: Reel run · Reel run clip, /);
  await expect(singleSlide.locator('.media-caption')).toHaveText('Reel run · Reel run clip');
  await single.getByRole('button', { name: 'Next item', exact: true }).click();
  await expect(singleSlide).toHaveAttribute('aria-label', /^2 of 3: Tall run · Tall run clip, /);
  checks.push('Coverflow: one video per run makes the runs the items, without tabs');
  // Neighbors have clean edges: their box is the poster's, with no shading, shadow or filter.
  for (const target of [flowPanel, single]) {
    await expect
      .poll(() =>
        target
          .locator('.carousel-peek .media-poster')
          .evaluateAll((all) => all.length > 0 && all.every((img) => img.naturalWidth > 0)),
      )
      .toBe(true);
    // A box moves to its poster's aspect (420 ms).
    await page.waitForTimeout(500);
    const edges = await target.locator('.carousel-peek').evaluateAll((all) =>
      all.map((peek) => {
        const frame = peek.querySelector('.media-frame'),
          poster = peek.querySelector('.media-poster'),
          styles = [peek, frame].flatMap((el) => [
            getComputedStyle(el),
            getComputedStyle(el, '::before'),
            getComputedStyle(el, '::after'),
          ]);
        return {
          decoration: styles
            .flatMap((style) => [style.boxShadow, style.filter, style.backgroundImage])
            .filter((value) => value !== 'none'),
          pseudo: styles
            .filter((_, index) => index % 3)
            .map((style) => style.content)
            .filter((value) => value !== 'none' && value !== 'normal'),
          heights: [peek.offsetHeight, frame.offsetHeight],
          aspects: [
            frame.offsetWidth / frame.offsetHeight,
            poster.naturalWidth / poster.naturalHeight,
          ],
        };
      }),
    );
    assert.ok(edges.length >= 2, JSON.stringify(edges));
    for (const edge of edges) {
      assert.deepEqual(edge.decoration, [], JSON.stringify(edge));
      assert.deepEqual(edge.pseudo, [], JSON.stringify(edge));
      assert.equal(edge.heights[0], edge.heights[1], JSON.stringify(edge));
      assert.ok(Math.abs(edge.aspects[0] - edge.aspects[1]) < 0.03, JSON.stringify(edge));
    }
  }
  checks.push("Coverflow neighbors: the poster's own box, no shading, shadow or filter");
  await flowPanel.getByRole('tab', { name: 'Wide run' }).click();
  await flowSlide.focus();
  await page.keyboard.press('Home');
  await expect(flowSlide).toHaveAttribute('aria-label', /^1 of 3: Wide run · wide, /);
  await expect.poll(() => flowSlide.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

  // The current item's video is edge to edge at the file's aspect (64:27), with no padding.
  await expect
    .poll(() => flowSlide.locator('.media-poster').evaluate((img) => img.naturalWidth))
    .toBe(640);
  const geometry = await flowSlide.evaluate((slide) => {
    const frame = slide.querySelector('.media-frame').getBoundingClientRect(),
      box = slide.getBoundingClientRect(),
      style = getComputedStyle(slide);
    return {
      aspect: frame.width / frame.height,
      inset: [frame.left - box.left, box.right - frame.right, frame.top - box.top],
      padding: style.padding,
      border: style.borderWidth,
      transform: style.transform,
    };
  });
  assert.ok(Math.abs(geometry.aspect - 640 / 270) < 0.02, JSON.stringify(geometry));
  assert.deepEqual(geometry.inset.map(Math.round), [0, 0, 0], JSON.stringify(geometry));
  assert.equal(geometry.padding, '0px');
  assert.equal(geometry.transform, 'none');
  const neighbors = await flowPanel
    .locator('.carousel-peek')
    .evaluateAll((all) =>
      all.map((el) => [el.style.transform, getComputedStyle(el).transitionDuration]),
    );
  assert.ok(neighbors.length >= 2, JSON.stringify(neighbors));
  for (const [transform, duration] of neighbors) {
    assert.match(transform, /perspective\(\d+px\) translate3d\(.*rotateY\(-?70deg\) scale\(1\)/);
    assert.notEqual(duration, '0s');
  }
  // The current item is the largest that fits the stage above its caption, at its aspect: the
  // wide file the stage's height here, the tall one too.
  const fit = () =>
    flowPanel.evaluate((panel) => {
      const stage = panel.querySelector('.carousel-stage'),
        slide = panel.querySelector('.carousel-slide');
      return {
        width: slide.offsetWidth,
        height: slide.offsetHeight,
        stage: [
          stage.clientWidth,
          stage.clientHeight - slide.querySelector('.media-footer').offsetHeight,
        ],
      };
    });
  for (const [key, aspect, label] of [
    ['End', 180 / 320, /^3 of 3: /],
    ['Home', 640 / 270, /^1 of 3: /],
  ]) {
    await page.keyboard.press(key);
    await expect(flowSlide).toHaveAttribute('aria-label', label);
    // Focus follows, also to an item that was hidden beyond the stage's edge.
    await expect(flowSlide).toBeFocused();
    await page.waitForTimeout(600);
    const size = await fit(),
      [width, room] = size.stage;
    assert.ok(Math.abs(size.width / size.height - aspect) < 0.02, JSON.stringify(size));
    assert.ok(size.width <= width + 0.5 && size.height <= room + 0.5, JSON.stringify(size));
    assert.ok(
      Math.abs(size.width - width) <= 1 || Math.abs(size.height - room) <= 1,
      JSON.stringify(size),
    );
  }
  // The stage follows the theme: the panel's background, with no stage color of its own, a box
  // of the next layer while a file loads, and the caption in secondary text, light and dark.
  const flowColors = () =>
    flowPanel.evaluate((panel) => {
      const probe = document.createElement('div'),
        token = (name) => {
          probe.style.backgroundColor = `var(${name})`;
          probe.style.color = `var(${name})`;
          return getComputedStyle(probe);
        };
      panel.append(probe);
      const tokens = {
        panel: token('--cds-ui-01').backgroundColor,
        stage: 'rgba(0, 0, 0, 0)',
        frame: token('--cds-ui-02').backgroundColor,
        caption: token('--cds-text-secondary').color,
      };
      probe.remove();
      const style = (selector) => getComputedStyle(panel.querySelector(selector));
      return {
        tokens,
        drawn: {
          panel: getComputedStyle(panel).backgroundColor,
          stage: style('.carousel-stage').backgroundColor,
          frame: style('.carousel-slide .media-frame').backgroundColor,
          caption: style('.carousel-slide .media-caption').color,
        },
      };
    });
  const themes = {};
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('theme', theme === 'dark' ? 'g100' : 'g10');
    const colors = await flowColors();
    assert.deepEqual(colors.drawn, colors.tokens, theme);
    themes[theme] = colors.drawn;
  }
  for (const key of ['panel', 'frame', 'caption'])
    assert.notEqual(themes.dark[key], themes.light[key], key);
  // As in Apple's Cover Flow, the items stand on one floor (the vanishing point is on it, so
  // every drawn bottom edge is on one line); a clear gap separates the current item from its
  // neighbors, which stack outward in small steps; the current item and its neighbors have no
  // padding, border, shadow or filter.
  await page.waitForTimeout(600);
  const drawn = await flowPanel.locator('.carousel-item').evaluateAll((all) =>
    all
      .filter((el) => getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const box = el.getBoundingClientRect(),
          style = getComputedStyle(el);
        return {
          index: Number(el.dataset.index),
          current: el.classList.contains('carousel-slide'),
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          height: el.offsetHeight,
          decoration: [style.padding, style.borderWidth, style.boxShadow, style.filter],
        };
      }),
  );
  const slideBox = drawn.find((item) => item.current);
  assert.ok(drawn.length >= 2, JSON.stringify(drawn));
  for (const item of drawn) {
    assert.ok(Math.abs(item.bottom - slideBox.bottom) <= 1, JSON.stringify(item));
    assert.deepEqual(item.decoration, ['0px', '0px', 'none', 'none'], JSON.stringify(item));
  }
  for (const direction of [-1, 1]) {
    const side = drawn
      .filter((item) => Math.sign(item.index - slideBox.index) === direction)
      .sort((a, b) => direction * (a.index - b.index));
    if (!side.length) continue;
    const edge = (item) =>
        direction > 0 ? item.left - slideBox.right : slideBox.left - item.right,
      inner = (item) => (direction > 0 ? item.left : -item.right);
    assert.ok(edge(side[0]) >= 8 && edge(side[0]) <= slideBox.height * 0.12, JSON.stringify(side));
    for (let step = 1; step < side.length; step++)
      assert.ok(
        inner(side[step]) - inner(side[step - 1]) <= slideBox.height * 0.2,
        JSON.stringify(side),
      );
  }
  // Neighbors show their first frames too.
  await expect
    .poll(() =>
      flowPanel
        .locator('.carousel-peek .media-poster')
        .evaluateAll((all) => all.some((img) => img.naturalWidth > 0)),
    )
    .toBe(true);
  // Full screen from Coverflow's current video.
  await flowPanel.getByRole('tab', { name: 'Reel run' }).click();
  await flowSlide.getByRole('button', { name: /^Play / }).click();
  await flowSlide.locator('video').evaluate((el) => (el.muted = true));
  await fullscreenCheck(flowSlide, 'coverflow');
  await flowSlide.locator('video').evaluate((el) => el.play());
  await fullscreenCheck(flowSlide, 'coverflow, resized after', false);
  // Reduced motion: neighbors stand flat beside the current item, without animation.
  const calmFlow = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await calmFlow.goto(page.url());
  const calmPeeks = calmFlow.locator('[data-panel-id="single"] .carousel-peek');
  await expect(calmPeeks.first()).toBeAttached();
  const flat = await calmPeeks.evaluateAll((all) =>
    all.map((el) => [el.style.transform, getComputedStyle(el).transitionDuration]),
  );
  for (const [transform, duration] of flat) {
    assert.match(transform, /rotateY\(0deg\)/);
    assert.equal(duration, '0s');
  }
  await calmFlow.close();
  // Moving animates every item even while posters arrive and give the files their aspects:
  // posters are held until the move has started, then the frames are sampled. The files'
  // sizes are removed from the media response, as for a file whose header has none.
  const slowFlow = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    held = [];
  let holding = true;
  await slowFlow.route('**/api/media', async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    for (const { value } of json.entries)
      for (const file of value?.videos ?? [value]) {
        delete file?.width;
        delete file?.height;
      }
    await route.fulfill({ response, json });
  });
  await slowFlow.route('**/api/run-file-poster*', (route) =>
    holding ? held.push(route) : route.continue(),
  );
  await slowFlow.goto(page.url());
  const slowSingle = slowFlow.locator('[data-panel-id="single"]');
  await expect(slowSingle.locator('.carousel-peek')).not.toHaveCount(0);
  await expect.poll(() => held.length).toBeGreaterThan(1);
  const sampling = slowSingle.evaluate(
    (panel) =>
      new Promise((resolve) => {
        const start = performance.now(),
          frames = [];
        let loaded;
        panel.addEventListener('load', () => (loaded ??= performance.now() - start), true);
        panel.querySelector('.carousel-next').click();
        const matrix = (index) => {
          const el = panel.querySelector(`.carousel-item[data-index="${index}"]`);
          return [new DOMMatrix(getComputedStyle(el).transform).m11, el.offsetWidth];
        };
        const tick = () => {
          const time = performance.now() - start;
          frames.push({ time, incoming: matrix(1), outgoing: matrix(0) });
          if (time < 700) requestAnimationFrame(tick);
          else resolve({ frames, loaded });
        };
        requestAnimationFrame(tick);
      }),
  );
  await slowFlow.waitForTimeout(60);
  holding = false;
  for (const route of held.splice(0)) await route.continue();
  const { frames: moved, loaded } = await sampling;
  const trace = JSON.stringify({
    loaded,
    moved: moved.map((f) =>
      [f.time, ...f.incoming, f.outgoing[0]].map((value) => Math.round(value * 100) / 100),
    ),
  });
  assert.ok(loaded !== undefined && loaded < 380, 'a poster arrives while moving: ' + trace);
  const between = (value, a, b) => value > Math.min(a, b) + 0.01 && value < Math.max(a, b) - 0.01,
    first = moved[0],
    last = moved.at(-1);
  for (const key of ['incoming', 'outgoing']) {
    const values = moved.map((frame) => frame[key][0]);
    assert.ok(
      values.filter((value) => between(value, first[key][0], last[key][0])).length >= 6,
      key + ' ' + trace,
    );
    for (let i = 1; i < values.length; i++)
      assert.ok(Math.abs(values[i] - values[i - 1]) < 0.3, key + ' jumps ' + trace);
  }
  // The first frame after the poster has arrived is still on its way.
  const after = moved.find((frame) => frame.time > loaded);
  assert.ok(after.time > 380 || between(after.incoming[0], first.incoming[0], 1), trace);
  // Run tabs animate too: the current item's box moves to the next run's file's aspect.
  await slowFlow.waitForTimeout(600);
  const slowTabs = slowFlow.locator('[data-panel-id="episodes"]');
  await slowTabs.getByRole('tab', { name: 'Wide run' }).click();
  await slowFlow.waitForTimeout(800);
  const widths = await slowTabs.evaluate(
    (panel) =>
      new Promise((resolve) => {
        const slide = () => panel.querySelector('.carousel-slide'),
          start = performance.now(),
          values = [];
        panel.querySelector('[role="tab"][aria-selected="false"]').click();
        const tick = () => {
          values.push(slide().offsetWidth);
          if (performance.now() - start < 600) requestAnimationFrame(tick);
          else resolve(values);
        };
        requestAnimationFrame(tick);
      }),
  );
  assert.ok(
    widths.filter((value) => between(value, widths[0], widths.at(-1))).length >= 4,
    JSON.stringify(widths),
  );
  await slowFlow.close();
  checks.push(
    'Coverflow: edge-to-edge current video at its aspect, 3D neighbors on one floor, reduced motion flat',
    'Coverflow animates moves and run tabs while posters arrive late',
  );

  // At 390 px the wide video takes the stage's whole width and no neighbor shows; the next one
  // waits hidden beyond the edge and slides in when moving, as the current one slides out.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(flow);
  await flowPanel.getByRole('tab', { name: 'Wide run' }).click();
  await expect(flowSlide).toHaveAttribute('aria-label', /^1 of 3: Wide run · wide, /);
  await page.waitForTimeout(600);
  const narrow = await flowPanel.evaluate((panel) => ({
    width: panel.querySelector('.carousel-slide').offsetWidth,
    stage: panel.querySelector('.carousel-stage').clientWidth,
    peeks: [...panel.querySelectorAll('.carousel-peek')].map((el) => [
      Number(el.dataset.index),
      getComputedStyle(el).visibility,
    ]),
  }));
  assert.equal(narrow.width, narrow.stage, JSON.stringify(narrow));
  assert.deepEqual(narrow.peeks, [[1, 'hidden']], JSON.stringify(narrow));
  const slid = await flowPanel.evaluate(
    (panel) =>
      new Promise((resolve) => {
        const stage = panel.querySelector('.carousel-stage').getBoundingClientRect(),
          start = performance.now(),
          frames = [];
        panel.querySelector('.carousel-next').click();
        const place = (index) => {
          const el = panel.querySelector(`.carousel-item[data-index="${index}"]`),
            box = el.getBoundingClientRect();
          return [box.left - stage.left, getComputedStyle(el).visibility, box.width];
        };
        const tick = () => {
          const time = performance.now() - start;
          frames.push({ time, incoming: place(1), outgoing: place(0) });
          if (time < 600) requestAnimationFrame(tick);
          else resolve({ width: stage.width, frames });
        };
        requestAnimationFrame(tick);
      }),
  );
  const slideTrace = JSON.stringify(slid);
  assert.ok(slid.frames[0].incoming[0] >= slid.width - 1, slideTrace);
  const middle = slid.frames.filter(
    (frame) => frame.incoming[0] > 1 && frame.incoming[0] < slid.width - 1,
  );
  assert.ok(middle.length >= 6, slideTrace);
  for (const frame of middle) {
    assert.deepEqual([frame.incoming[1], frame.outgoing[1]], ['visible', 'visible'], slideTrace);
    assert.ok(frame.outgoing[0] <= 0, slideTrace);
  }
  const end = slid.frames.at(-1);
  assert.ok(end.outgoing[0] + end.outgoing[2] <= 0, slideTrace);
  for (let i = 1; i < slid.frames.length; i++)
    assert.ok(slid.frames[i].incoming[0] <= slid.frames[i - 1].incoming[0] + 0.5, slideTrace);
  assert.ok(Math.abs(end.incoming[0] - (slid.width - end.incoming[2]) / 2) <= 1, slideTrace);
  await expect(flowSlide).toHaveAttribute('aria-label', /^2 of 3: Wide run · reel, /);
  // Keys move to the hidden neighbors and keep focus on the current item.
  await flowSlide.focus();
  for (const [key, label] of [
    ['ArrowLeft', /^1 of 3: /],
    ['ArrowRight', /^2 of 3: /],
  ]) {
    await page.keyboard.press(key);
    await expect(flowSlide).toHaveAttribute('aria-label', label);
    await expect(flowSlide).toBeFocused();
  }
  // The focus ring is drawn inside the item, so the stage's edges do not clip it.
  const ring = await flowSlide.evaluate((el) => {
    const style = getComputedStyle(el, '::after');
    return [style.position, style.inset, style.borderTopWidth, style.borderTopStyle];
  });
  assert.deepEqual(ring, ['absolute', '0px', '2px', 'solid']);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 900 });
  page.off('requestfinished', recordPoster);

  // A very wide panel shows as many neighbors as its width holds, far more than three on each
  // side, while only the shown ones, and one hidden beyond each edge, have elements and
  // request posters, a few at a time. One run logs many small videos at distinct paths.
  const manyCount = 120,
    manyClip = await encode('small.mp4', 'testsrc2=s=160x90:r=10', 1),
    manyProject = entity + '/wide-' + Date.now(),
    manyId = manyProject + '/many';
  projects.push(manyProject);
  await call('/graphql', {
    query: 'mutation UpsertBucket { upsertBucket }',
    variables: { entity, project: manyProject.split('/')[1], name: 'many', displayName: 'Many' },
  });
  const manyVideos = [];
  for (let index = 0; index < manyCount; index++) {
    const path = `media/videos/many_${index}.mp4`,
      put = await api.fetch(`/upload/${manyId}/${path}`, { method: 'PUT', data: manyClip });
    assert.ok(put.ok(), await put.text());
    manyVideos.push({ _type: 'video-file', path, size: manyClip.length, width: 160, height: 90 });
  }
  await call(`/files/${manyId}/file_stream`, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [
          JSON.stringify({
            _step: 0,
            many: { _type: 'videos', count: manyCount, videos: manyVideos },
          }),
        ],
      },
    },
    complete: true,
    exitcode: 0,
  });
  const manyRun = (await call('/api/runs')).runs.find(
    (item) => item.entity === entity && item.project === manyProject.split('/')[1],
  );
  const manyView = await createView(
    manyProject,
    [
      {
        id: 'many',
        plugin: 'video',
        metric: 'many',
        title: 'many',
        section: 'many',
        settings: { layout: 'coverflow', mediaFiles: manyCount },
      },
    ],
    {
      visible: [manyRun.id],
      sections: [{ id: 'many', name: 'many' }],
      sectionLayouts: { many: { width: 3000, height: 560, rows: 1 } },
    },
  );
  const widePage = await browser.newPage({ viewport: { width: 3200, height: 1000 } }),
    posterRequests = [];
  let posterActive = 0,
    posterMost = 0;
  widePage.on('request', (r) => {
    if (!r.url().includes('/api/run-file-poster')) return;
    posterRequests.push(new URL(r.url()).searchParams.get('path'));
    posterMost = Math.max(posterMost, ++posterActive);
  });
  for (const event of ['requestfinished', 'requestfailed'])
    widePage.on(event, (r) => {
      if (r.url().includes('/api/run-file-poster')) posterActive--;
    });
  await widePage.goto(
    `${baseURL}/${manyProject.split('/').map(encodeURIComponent).join('/')}/workspace?view=${manyView.id}`,
  );
  const widePanel = widePage.locator('[data-panel-id="many"]'),
    wideSlide = widePanel.locator('.carousel-slide');
  await expect(wideSlide).toHaveAttribute('aria-label', new RegExp(`^1 of ${manyCount}: `));
  // The first window's posters load at most four at a time. (Moving on aborts loads, and an
  // aborted image's request may still finish, so this is measured before moving.)
  await expect
    .poll(() => widePanel.locator('.carousel-peek .media-poster[src]').count())
    .toBe(await widePanel.locator('.carousel-peek').count());
  assert.ok(posterMost <= 4, String(posterMost));
  // Walk to the middle of the list, one item at a time.
  await wideSlide.focus();
  for (let step = 0; step < 50; step++) await widePage.keyboard.press('ArrowRight');
  await expect(wideSlide).toHaveAttribute('aria-label', new RegExp(`^51 of ${manyCount}: `));
  await widePage.waitForTimeout(700);
  await expect.poll(() => posterActive).toBe(0);
  const wide = await widePanel.evaluate((panel) => {
    const items = [...panel.querySelectorAll('.carousel-item')],
      shown = items.filter(
        (el) =>
          el.classList.contains('carousel-peek') && getComputedStyle(el).visibility !== 'hidden',
      );
    return {
      stage: panel.querySelector('.carousel-stage').clientWidth,
      items: items.length,
      left: shown.filter((el) => el.dataset.side === 'left').length,
      right: shown.filter((el) => el.dataset.side === 'right').length,
      hidden: items.length - shown.length - 1,
      frames: panel.querySelectorAll('.media-frame').length,
      videos: panel.querySelectorAll('video').length,
      posters: panel.querySelectorAll('.carousel-peek .media-poster[src]').length,
    };
  });
  const wideTrace = JSON.stringify({ ...wide, requests: posterRequests.length, posterMost });
  assert.ok(wide.stage > 2400, wideTrace);
  assert.ok(wide.left > 3 && wide.right > 3, wideTrace);
  // Elements: the current item, the shown neighbors and one hidden beyond each edge.
  assert.equal(wide.items, 1 + wide.left + wide.right + 2, wideTrace);
  assert.ok(wide.items < manyCount, wideTrace);
  assert.equal(wide.frames, wide.items, wideTrace);
  assert.ok(wide.videos <= 1, wideTrace);
  assert.equal(wide.posters, wide.items - 1, wideTrace);
  // Posters: at most once per file that got an element on the walk, never the whole list.
  assert.equal(new Set(posterRequests).size, posterRequests.length, wideTrace);
  assert.ok(posterRequests.length <= 51 + wide.right + 1, wideTrace);
  if (process.env.RANDL_SCREENSHOTS)
    await widePanel.screenshot({
      path: join(process.env.RANDL_SCREENSHOTS, 'media-coverflow-3200.png'),
    });
  await widePage.close();
  checks.push(
    'Coverflow at 3200 px: many neighbors per side, elements and posters bounded to those shown',
  );
  await rm(clipsDir, { recursive: true, force: true });
  checks.push('Coverflow at 390 px: the width-filling video, neighbors slide in and out');

  // Leaving the workspace releases every canvas and media element.
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  assert.equal(await page.locator('canvas,audio,video').count(), 0);
  // Without ffmpeg the browser draws the first frame itself, from the video's metadata and
  // first frames, without downloading the file: a server of this test's own, with ffmpeg off.
  const fallbackDir = await mkdtemp(join(tmpdir(), 'randl-media-fallback-'));
  process.env.RANDL_FFMPEG = 'off';
  const fallback = await createServer(fallbackDir);
  delete process.env.RANDL_FFMPEG;
  try {
    const origin = await listen(fallback),
      local = await request.newContext({ baseURL: origin }),
      big = join(fallbackDir, 'big.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1280x720:r=30',
      '-t',
      '20',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-b:v',
      '4M',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '60',
      '-movflags',
      '+faststart',
      '-y',
      big,
    ]);
    const bytes = await readFile(big),
      id = 'local/fallback/run';
    await local.post('/graphql', {
      data: {
        query: 'mutation UpsertBucket { upsertBucket }',
        variables: { entity: 'local', project: 'fallback', name: 'run' },
      },
    });
    const path = 'media/videos/big_0.mp4';
    assert.ok((await local.put(`/upload/${id}/${path}`, { data: bytes })).ok());
    await local.post(`/files/${id}/file_stream`, {
      data: {
        files: {
          'wandb-history.jsonl': {
            offset: 0,
            content: [
              JSON.stringify({ _step: 0, big: { _type: 'video-file', path, size: bytes.length } }),
            ],
          },
        },
        complete: true,
        exitcode: 0,
      },
    });
    const view = await (
      await local.post('/api/tools/view_create', {
        data: { project: 'local/fallback', name: 'fallback' },
      })
    ).json();
    view.body.panels = [
      { id: 'big', plugin: 'video', metric: 'big', title: 'big', section: 'big' },
    ];
    view.body.sections = [{ id: 'big', name: 'big' }];
    view.body.visible = [id];
    view.body.plotSettings = manualPlayback;
    assert.ok(
      (
        await local.put('/api/views/' + view.id, {
          data: { name: view.name, project: view.project, version: view.version, body: view.body },
        })
      ).ok(),
    );
    const viewer = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
      cdp = await viewer.context().newCDPSession(viewer),
      received = new Map();
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (event) => {
      if (event.request.url.includes('/api/run-file-preview')) received.set(event.requestId, 0);
    });
    cdp.on('Network.dataReceived', (event) => {
      if (received.has(event.requestId))
        received.set(event.requestId, received.get(event.requestId) + event.dataLength);
    });
    await viewer.goto(`${origin}/local/fallback/workspace?view=${view.id}`);
    const poster = viewer.locator('[data-panel-id="big"] .media-poster');
    await expect
      .poll(() => poster.evaluate((img) => img.naturalWidth), { timeout: 20000 })
      .toBe(640);
    assert.equal(await viewer.locator('[data-panel-id="big"] video').count(), 0);
    await viewer.waitForTimeout(1500);
    const fetched = [...received.values()].reduce((sum, value) => sum + value, 0);
    assert.ok(fetched < bytes.length * 0.4, `${fetched} of ${bytes.length} bytes`);
    await viewer.close();
    await local.dispose();
    checks.push(`posters without ffmpeg: ${fetched} of ${bytes.length} bytes fetched`);
  } finally {
    await fallback.app.close();
    await rm(fallbackDir, { recursive: true, force: true });
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  for (const id of views) await call('/api/views/' + id, undefined, 'DELETE');
  for (const id of projects) {
    const { name } = await call('/api/tools/project_get', { id });
    await call('/api/tools/project_delete', { id, confirm: name });
  }
  await api.dispose();
}
