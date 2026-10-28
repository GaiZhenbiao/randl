import { createServer } from '../backend/dist/server.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
export async function storageRestart(python) {
  await mkdir('tmp/storage-tests', { recursive: true });
  const directory = await mkdtemp('tmp/storage-tests/restart-');
  let server = await createServer(directory),
    child;
  try {
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const port = server.app.server.address().port;
    child = spawn(python, ['tests/sdk_storage_restart.py'], {
      env: {
        ...process.env,
        RANDL_URL: 'http://127.0.0.1:' + port,
        RANDL_API_KEY: '',
        WANDB_DIR: resolve(directory),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      error = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (error += b));
    const exited = new Promise((res, rej) => {
      child.on('error', rej);
      child.on('exit', (code) => (code === 0 ? res() : rej(Error('SDK restart failed: ' + error))));
    });
    exited.catch(() => {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) {
      await wait(200);
      const run = await server.db.call('run', 'synthetic/storage-restart/logging');
      if (run?.history_count >= 20) break;
      if (i === 99) throw Error('SDK did not begin logging');
    }
    await server.app.close();
    await wait(90000);
    server = await createServer(directory);
    await server.app.listen({ host: '127.0.0.1', port });
    await exited;
    return JSON.parse(output.trim().split('\n').at(-1));
  } finally {
    if (child?.exitCode === null) child.kill();
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
