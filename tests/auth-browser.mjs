import { createServer } from '../backend/dist/server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { launchBrowser } from './helpers.mjs';
const directory = await mkdtemp(join(tmpdir(), 'randl-auth-browser-')),
  key = randomBytes(24).toString('hex');
const { app } = await createServer(directory, { apiKey: key });
await app.listen({ host: '127.0.0.1', port: 0 });
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + app.server.address().port);
  await page.getByLabel('API key', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Invalid API key', { exact: true })).toBeVisible();
  await page.getByLabel('API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Project pages', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  console.log('PASS authenticated browser invalid key, successful login, and logout');
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
