import { createServer } from '../backend/dist/server.js';
import { Store } from '../backend/dist/database.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const python = process.env.RANDL_SDK_PYTHON || resolve('.venv-sdk/bin/python');
function prepareSnapshot(directory, entity, project) {
  // An imported snapshot captured while running, prepared the way local imports store it:
  // 200 sampled records of a 20,000-step history, then sparse records appended with earlier
  // steps, sampled system events, and the source summary at its last step.
  const store = new Store(directory),
    snapshot = store.upsert({
      entity,
      project,
      name: 'captured',
      displayName: 'Imported capture',
      config: { lr: { value: 0.01 } },
    }),
    sampled = Array.from({ length: 200 }, (_, i) => {
      const step = Math.round((i * 19999) / 199);
      return {
        _step: step,
        _runtime: step / 40,
        _timestamp: 1700000000 + step / 40,
        loss: 2 - step / 20000,
      };
    });
  store.ingest(snapshot.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: [...sampled, { _step: 150, rare: 1 }, { _step: 250, rare: 2 }].map((row) =>
          JSON.stringify(row),
        ),
      },
      'wandb-events.jsonl': {
        offset: 0,
        content: Array.from({ length: 10 }, (_, i) =>
          JSON.stringify({ _timestamp: 1700000000 + i * 50, 'system.cpu': 10 + i }),
        ),
      },
    },
  });
  store.upsert({
    entity,
    project,
    name: 'captured',
    summaryMetrics: { _step: 19999, _runtime: 500, loss: 1.0001 },
  });
  store.db
    .prepare(
      "UPDATE runs SET state='running',snapshot_at=?,snapshot_source=?,runtime_at=?,heartbeat=? WHERE id=?",
    )
    .run(1700000500, 'Synthetic source', 1700000500, 1700000500, snapshot.id);
  store.storageMaintain(10000);
  store.db.close();
}
for (const authenticated of [false, true]) {
  const directory = await mkdtemp(join(tmpdir(), 'randl-sdk-gate-'));
  const key = authenticated ? randomBytes(24).toString('hex') : '';
  prepareSnapshot(directory, 'local', 'sdk-snapshots');
  const { app } = await createServer(directory, { apiKey: key });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = 'http://127.0.0.1:' + app.server.address().port;
    for (const script of [
      'sdk_smoke.py',
      'sdk_storage_smoke.py',
      'artifact_sdk_smoke.py',
      'sdk_stop_smoke.py',
      'sdk_environment_smoke.py',
      'sdk_snapshot_smoke.py',
      'sdk_record_transform_smoke.py',
      'sdk_connect_smoke.py',
    ].filter(
      // RANDL_SDK_SCRIPTS=sdk_snapshot_smoke.py,... runs a subset.
      (script) =>
        !process.env.RANDL_SDK_SCRIPTS || process.env.RANDL_SDK_SCRIPTS.split(',').includes(script),
    )) {
      const { stdout } = await exec(python, ['tests/' + script], {
        env: {
          ...process.env,
          RANDL_URL: base,
          RANDL_API_KEY: key,
          RANDL_SNAPSHOT_RUN: 'captured',
        },
        timeout: 300000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const result = JSON.parse(stdout.trim().split('\n').at(-1));
      console.log(JSON.stringify({ authenticated, script, result }));
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
  // A server whose default entity is not "local": jobs that name no entity resume its runs.
  if (
    process.env.RANDL_SDK_SCRIPTS &&
    !process.env.RANDL_SDK_SCRIPTS.split(',').includes('sdk_public_api_smoke.py')
  )
    continue;
  const named = await mkdtemp(join(tmpdir(), 'randl-sdk-gate-entity-'));
  prepareSnapshot(named, 'demo', 'cartpole-ppo');
  const entityServer = await createServer(named, { apiKey: key, entity: 'demo' });
  try {
    await entityServer.app.listen({ host: '127.0.0.1', port: 0 });
    const { stdout } = await exec(python, ['tests/sdk_public_api_smoke.py'], {
      env: {
        ...process.env,
        RANDL_URL: 'http://127.0.0.1:' + entityServer.app.server.address().port,
        RANDL_API_KEY: key,
      },
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    console.log(JSON.stringify({ authenticated, script: 'sdk_public_api_smoke.py', result }));
  } finally {
    await entityServer.app.close();
    await rm(named, { recursive: true, force: true });
  }
}
if(!process.env.RANDL_SDK_SCRIPTS||process.env.RANDL_SDK_SCRIPTS.split(',').includes('sdk_storage_restart.py')){
 const {storageRestart}=await import('./storage-restart.mjs');
 console.log(JSON.stringify({script:'sdk_storage_restart.py',result:await storageRestart(python)}));
}
