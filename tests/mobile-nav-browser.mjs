import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { createServer } from '../backend/dist/server.js';

// Phone navigation: the header menu button opens Carbon's overlay side navigation.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'randl-mobile-nav-'));
let server, browser;
const checks = [],
  errors = [];
try {
  server = await createServer(
    directory,
    process.env.RANDL_FRONTEND_DIR ? { frontend: resolve(process.env.RANDL_FRONTEND_DIR) } : {},
  );
  const run = await server.db.call('upsert', {
    entity: 'phone',
    project: 'nav',
    name: 'run-1',
    displayName: 'Phone run',
  });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: Array.from({ length: 20 }, (_, step) =>
          JSON.stringify({ _step: step, loss: 1 / (step + 1) }),
        ),
      },
    },
    complete: true,
    exitcode: 0,
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = 'http://127.0.0.1:' + server.app.server.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  phone.on('pageerror', (error) => errors.push(error.message));
  const open = phone.getByRole('button', { name: 'Open navigation', exact: true });
  const navigation = phone.getByRole('navigation', { name: 'Navigation', exact: true });
  const link = (name) => navigation.getByRole('link', { name, exact: true });
  const current = () =>
    navigation
      .locator('[aria-current="page"]')
      .evaluateAll((items) => items.map((item) => item.textContent.trim()));

  await phone.goto(origin + '/phone/nav/workspace');
  await expect(phone.locator('.chart').first()).toBeVisible();
  // The menu button leads the header; the side navigation stays closed until opened.
  const header = await phone
    .locator('.bx--header')
    .evaluate((node) =>
      [...node.querySelectorAll('button, a')]
        .filter((element) => element.getBoundingClientRect().width)
        .map((element) => element.getAttribute('aria-label') || element.textContent.trim()),
    );
  assert.equal(header[0], 'Open navigation', JSON.stringify(header));
  await expect(navigation).toHaveCount(0);
  await open.click();
  await expect(navigation).toBeVisible();
  await expect(link('Workspace')).toBeFocused();
  assert.deepEqual(await current(), ['Workspace']);
  const targets = await navigation
    .locator('.bx--side-nav__link')
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
  assert.ok(
    targets.every((height) => height >= 48),
    'navigation targets are 48 px: ' + targets,
  );
  for (const name of [
    'Projects',
    'Server',
    'Overview',
    'Workspace',
    'Runs',
    'Artifacts',
    'Settings',
  ])
    await expect(link(name)).toBeVisible();
  await expect(navigation.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue(
    'phone/nav',
  );
  await expect(navigation.getByRole('button', { name: 'Connect SDK', exact: true })).toBeVisible();
  checks.push('menu button opens the side navigation at the current page with 48 px targets');

  // Focus stays in the navigation; Escape returns it to the menu button.
  await link('Projects').focus();
  await phone.keyboard.press('Shift+Tab');
  assert.ok(
    await phone.evaluate(() => !!document.activeElement.closest('.phone-navigation')),
    'focus left the navigation',
  );
  await phone.keyboard.press('Escape');
  await expect(navigation).toHaveCount(0);
  await expect(phone.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
  checks.push('Tab stays in the navigation; Escape closes it and focuses the menu button');

  // Choosing a page navigates and closes; the overlay also closes the navigation.
  await open.click();
  await link('Runs').click();
  await expect(phone).toHaveURL(/\/phone\/nav\/runs/);
  await expect(navigation).toHaveCount(0);
  await open.click();
  assert.deepEqual(await current(), ['Runs']);
  await phone.locator('.bx--side-nav__overlay-active').click({ position: { x: 370, y: 600 } });
  await expect(navigation).toHaveCount(0);
  checks.push('a page link navigates and closes; the overlay closes the navigation');

  // A run page marks its workspace; the breadcrumb parent remains the way back.
  await phone.goto(origin + '/phone/nav/runs/run-1');
  await expect(phone.getByRole('combobox', { name: 'Run details', exact: true })).toBeVisible();
  await open.click();
  assert.deepEqual(await current(), ['Workspace']);
  await phone.keyboard.press('Escape');
  await expect(
    phone.locator('.project-bar').getByRole('link', { name: 'Workspace', exact: true }),
  ).toBeVisible();
  checks.push('a run page marks Workspace and keeps the breadcrumb parent link');

  // Global pages: Projects and Server, from inside a project.
  await open.click();
  await link('Server').click();
  await expect(phone).toHaveURL(/page=server/);
  await open.click();
  assert.deepEqual(await current(), ['Server']);
  await expect(link('Workspace')).toHaveCount(0);
  await link('Projects').click();
  await expect(phone).toHaveURL(/page=overview/);
  await open.click();
  assert.deepEqual(await current(), ['Projects']);
  await phone.keyboard.press('Escape');
  checks.push('Projects and Server are reachable from a project and marked when current');

  // The runs drawer opens from a labeled button on the workspace.
  await phone.goto(origin + '/phone/nav/workspace');
  const runs = phone.getByRole('button', { name: 'Show runs', exact: true });
  await expect(runs).toHaveText('Runs');
  await expect(runs).toHaveAttribute('aria-expanded', 'false');
  await runs.click();
  await expect(phone.getByRole('button', { name: 'Hide runs', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await phone.keyboard.press('Escape');
  checks.push('the runs drawer has a labeled toggle');
  await phone.close();

  // A landscape phone scrolls the navigation to its last item.
  const landscape = await browser.newPage({
    viewport: { width: 568, height: 320 },
    hasTouch: true,
    isMobile: true,
  });
  landscape.on('pageerror', (error) => errors.push(error.message));
  await landscape.addInitScript(() => localStorage.setItem('randl.language', 'ja'));
  await landscape.goto(origin + '/phone/nav/overview');
  await landscape.getByRole('button', { name: 'ナビゲーションを開く', exact: true }).click();
  const last = landscape
    .getByRole('navigation', { name: 'ナビゲーション', exact: true })
    .getByRole('button', { name: 'プロジェクトを作成', exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await last.click();
  await expect(landscape.getByRole('dialog', { name: 'プロジェクトを作成' })).toBeVisible();
  await landscape.close();
  checks.push('landscape phones scroll the localized navigation to its last action');

  // Tablets and desktops keep the project rail and have no menu button.
  for (const width of [900, 1440]) {
    const wide = await browser.newPage({ viewport: { width, height: 800 } });
    await wide.goto(origin + '/phone/nav/workspace');
    await expect(
      wide.getByRole('navigation', { name: 'Project pages', exact: true }),
    ).toBeVisible();
    await expect(wide.getByRole('button', { name: 'Open navigation', exact: true })).toHaveCount(0);
    await wide.close();
  }
  checks.push('tablet and desktop widths keep the project rail without a menu button');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await server?.app.close();
  await rm(directory, { recursive: true, force: true });
}
