// Shared harness for the browser and performance scripts.
import { chromium } from '@playwright/test';

/** Launches headless Chromium, using PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when it is set. */
export function launchBrowser(options = {}) {
  return chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    ...options,
  });
}

/** Listens on a free loopback port and returns the server's base URL. */
export async function listen(server) {
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  return 'http://127.0.0.1:' + server.app.server.address().port;
}

/** The seeded demo server named by RANDL_URL; there is no default, so tests never reach another server. */
export function demoURL() {
  const url = process.env.RANDL_URL;
  if (!url) throw Error('Set RANDL_URL to the seeded demo server, for example http://127.0.0.1:8744.');
  return url;
}
