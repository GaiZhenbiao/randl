import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';
import { planMediaThinning } from '../backend/dist/media-cap.js';
import { mediaPaths } from '../backend/dist/media-items.js';
import { runFolder } from '../backend/dist/project-store.js';

async function expectEventually(check, timeout = 5000) {
  for (const until = Date.now() + timeout; ; ) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
const entry = (metric, step, bytes = 10, complete = true) => ({
  metric,
  step,
  complete,
  files: bytes ? [{ path: `media/${metric}_${step}`, bytes }] : [],
});
const steps = (plan, entries, metric) =>
  entries
    .filter((item) => item.metric === metric && !plan.remove.includes(item))
    .map((item) => item.step);

test('media limit thinning keeps an even spread, the first and the newest entry', () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(1, i * 100));
  // Under the limit nothing is removed.
  assert.deepEqual(planMediaThinning(entries, 100).remove, []);
  // Removing half takes every other entry rather than the oldest half.
  const half = planMediaThinning(entries, 99, 60);
  assert.deepEqual(steps(half, entries, 1), [0, 200, 400, 600, 800, 900]);
  assert.equal(half.total, 100);
  assert.equal(half.freed, 40);
  assert.deepEqual(half.paths, ['media/1_100', 'media/1_300', 'media/1_500', 'media/1_700']);
  // Further removals keep widening the spacing; the first and the newest stay to the end.
  assert.deepEqual(steps(planMediaThinning(entries, 99, 30), entries, 1), [0, 400, 900]);
  assert.deepEqual(steps(planMediaThinning(entries, 99, 20), entries, 1), [0, 900]);
  // The first goes only when nothing lies between; the newest always stays, so one entry
  // over the limit ends the plan.
  assert.deepEqual(steps(planMediaThinning(entries, 5, 5), entries, 1), [900]);
  // The same input gives the same plan.
  assert.deepEqual(planMediaThinning(entries, 99, 60), half);
});
test('media limit thinning fills in denser stretches first', () => {
  // An older stretch already thinned to every 400 steps, then new entries every 100.
  const entries = [0, 400, 800, 900, 1000, 1100, 1200].map((step) => entry(1, step));
  assert.deepEqual(steps(planMediaThinning(entries, 69, 50), entries, 1), [0, 400, 800, 1000, 1200]);
});
test('media limit thinning takes from the heaviest key and leaves unfinished entries', () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, i) => entry(1, i, 100)),
    ...Array.from({ length: 6 }, (_, i) => entry(2, i, 1)),
    // A histogram has no files, and an entry still uploading is not removed.
    entry(3, 0, 0),
    entry(3, 1, 0),
    entry(3, 2, 0),
  ];
  entries[2].complete = false;
  const plan = planMediaThinning(entries, 600, 400);
  assert.deepEqual(steps(plan, entries, 1), [0, 2, 5]);
  assert.deepEqual(steps(plan, entries, 2), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(steps(plan, entries, 3), [0, 1, 2]);
  // A key's first entry goes only once no key has entries between its first and newest.
  const tight = planMediaThinning(entries, 600, 150);
  assert.deepEqual(steps(tight, entries, 1), [2, 5]);
  assert.deepEqual(steps(tight, entries, 2), [5]);
});
test('media limit thinning frees a shared file with its last entry', () => {
  const shared = { path: 'media/shared', bytes: 50 };
  const entries = [0, 1, 2, 3].map((step) => ({ metric: 1, step, complete: true, files: [shared] }));
  const plan = planMediaThinning(entries, 40, 10);
  assert.equal(plan.total, 50);
  assert.equal(plan.freed, 0);
  assert.deepEqual(plan.paths, []);
  assert.deepEqual(steps(plan, entries, 1), [3]);
});
test('media paths include nested files', () => {
  assert.deepEqual(
    [
      ...mediaPaths({
        _type: 'image-file',
        path: 'media/images/a.png',
        masks: { truth: { _type: 'mask', path: 'media/images/mask/a.mask.png' } },
        boxes: { predictions: { path: 'media/metadata/boxes2D/a.json' } },
      }),
    ],
    ['media/images/a.png', 'media/images/mask/a.mask.png', 'media/metadata/boxes2D/a.json'],
  );
  assert.deepEqual(
    [...mediaPaths({ _type: 'images/separated', filenames: ['a', 'b'] })],
    ['a', 'b'],
  );
  assert.deepEqual([...mediaPaths({ _type: 'histogram', values: [1], bins: [0, 1] })], []);
});
test('the media limit thins a run when uploads pass it, and applies to all runs on request', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'randl-cap-'));
  const { app, db, tools, mediaCap } = await createServer(dir);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const limit = (enabled, megabytes) =>
    tools.execute('settings_update', { mediaLimit: { enabled, megabytes } });
  assert.deepEqual(await tools.execute('settings_get', {}), {
    mediaLimit: { enabled: true, megabytes: 500 },
  });
  assert.deepEqual(await limit(true, 1), { mediaLimit: { enabled: true, megabytes: 1 } });
  const megabyte = 1024 * 1024,
    clip = Buffer.alloc(megabyte / 4, 7);
  const log = async (name, count, upload = true) => {
    const run = await db.call('upsert', { entity: 'e', project: 'cap', name });
    await db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: count }, (_, i) =>
            JSON.stringify({
              _step: i * 10,
              loss: i,
              clip: { _type: 'video-file', path: `media/videos/clip_${i * 10}.mp4` },
              hist: { _type: 'histogram', values: [1], bins: [0, 1] },
            }),
          ),
        },
      },
    });
    for (let i = 0; upload && i < count; i++)
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/upload/e/cap/${name}/media/videos/clip_${i * 10}.mp4`,
            payload: clip,
          })
        ).statusCode,
        200,
      );
    return run.id;
  };
  const shown = async (id, metric = 'clip') =>
    (
      await app.inject({ url: '/api/media', method: 'POST', payload: { runs: [id], metric } })
    ).json().xValues;
  const exists = (id, step) =>
    stat(join(runFolder(dir, id), `media/videos/clip_${step}.mp4`)).then(
      () => true,
      () => false,
    );
  // Eight quarter-megabyte clips pass the one-megabyte limit; thinning stops at 90% of it.
  const id = await log('a', 8);
  assert.equal((await db.call('run', id)).file_bytes, 2 * megabyte);
  await mediaCap.pass();
  assert.deepEqual(await shown(id), [0, 40, 70]);
  assert.deepEqual(
    await Promise.all([0, 10, 20, 30, 40, 50, 60, 70].map((step) => exists(id, step))),
    [true, false, false, false, true, false, false, true],
  );
  assert.equal((await db.call('run', id)).file_bytes, 0.75 * megabyte);
  // Values without files and scalar history are untouched.
  assert.equal((await shown(id, 'hist')).length, 8);
  assert.equal((await db.call('chart', { runs: [id], metrics: ['loss'], width: null })).series[0].values.loss.length, 8);
  // A run under the limit keeps everything, and so does one whose limit is off.
  const small = await log('b', 3);
  await mediaCap.pass();
  assert.deepEqual(await shown(small), [0, 10, 20]);
  // Turning the limit off keeps its size.
  assert.deepEqual(await limit(false), { mediaLimit: { enabled: false, megabytes: 1 } });
  const unlimited = await log('c', 8);
  await mediaCap.pass();
  assert.equal((await shown(unlimited)).length, 8);
  // A dry run reports what the limit would remove from every run.
  await db.call('settingSet', 'media-limit', { enabled: true, megabytes: 1 });
  const pending = await log('d', 8, false);
  const preview = await tools.execute('media_limit_apply', { dryRun: true });
  assert.deepEqual(
    [preview.dryRun, preview.runs, preview.runsOver, preview.entries, preview.bytes],
    [true, 4, 1, 5, 1.25 * megabyte],
  );
  assert.equal((await shown(unlimited)).length, 8);
  // Turning the limit on thins the runs already over it, with no further upload; entries
  // still uploading stay.
  await limit(true, 1);
  await expectEventually(async () => assert.deepEqual(await shown(unlimited), [0, 40, 70]));
  assert.equal((await shown(pending)).length, 8);
  assert.equal((await tools.execute('media_limit_apply', { dryRun: false })).entries, 0);
  // Removing needs an explicit choice.
  assert.equal(
    (await app.inject({ url: '/api/tools/media_limit_apply', method: 'POST', payload: {} })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ url: '/api/tools/settings_update', method: 'POST', payload: { mediaLimit: { enabled: true, megabytes: 0 } } }))
      .statusCode,
    400,
  );
});
test('media by another X axis: values of the axis metric, carried forward', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'randl-axis-'));
  const { app, db } = await createServer(dir);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const image = (step) => ({ _type: 'image-file', path: `media/images/s_${step}.png` });
  const ids = [];
  for (const [name, rows] of [
    [
      'a',
      [
        { _step: 0, _timestamp: 1000, epoch: 1, sample: image(0) },
        { _step: 1, _timestamp: 1010, epoch: 1 },
        { _step: 2, _timestamp: 1020, epoch: 2, sample: image(2) },
        // Logged without the axis metric: takes its last value.
        { _step: 3, _timestamp: 1030, sample: image(3) },
        { _step: 4, _timestamp: 1040, epoch: 4, sample: image(4) },
      ],
    ],
    [
      'b',
      [
        // Before the axis metric has any value: not on the axis.
        { _step: 0, _timestamp: 2000, sample: image(0) },
        { _step: 5, _timestamp: 2050, epoch: 3, sample: image(5) },
      ],
    ],
    ['c', [{ _step: 0, _timestamp: 3000, sample: image(0) }]],
  ]) {
    const run = await db.call('upsert', { entity: 'e', project: 'x', name, displayName: name });
    await db.call('ingest', run.id, {
      files: { 'wandb-history.jsonl': { offset: 0, content: rows.map((row) => JSON.stringify(row)) } },
    });
    ids.push(run.id);
  }
  const media = async (body) =>
    (
      await app.inject({
        url: '/api/media',
        method: 'POST',
        payload: { runs: ids, metric: 'sample', ...body },
      })
    ).json();
  const rows = (result) => result.entries.map((item) => [item.runName, item.step, item.x]);
  const epoch = await media({ xAxis: 'epoch' });
  assert.equal(epoch.xAxis, 'epoch');
  assert.deepEqual(epoch.xValues, [1, 2, 3, 4]);
  assert.equal(epoch.x, 4);
  // Among entries at one X value the later step shows; a run without the axis keeps its place.
  assert.deepEqual(rows(epoch), [
    ['a', 4, 4],
    ['b', 5, 3],
    ['c', null, null],
  ]);
  assert.deepEqual(rows(await media({ xAxis: 'epoch', x: 2 })), [
    ['a', 3, 2],
    ['b', null, null],
    ['c', null, null],
  ]);
  const elapsed = await media({ xAxis: '_relative_wall' });
  assert.deepEqual(elapsed.xValues, [0, 20, 30, 40, 50]);
  assert.deepEqual(rows(await media({ xAxis: '_relative_wall', x: 25 })), [
    ['a', 2, 20],
    ['b', 0, 0],
    ['c', 0, 0],
  ]);
  assert.deepEqual((await media({ xAxis: '_timestamp' })).xValues.slice(0, 2), [1000000, 1020000]);
  assert.deepEqual((await media({ xAxis: 'missing' })).xValues, []);
  assert.deepEqual((await media({})).xValues, [0, 2, 3, 4, 5]);
});
test('a server thins runs already over the media limit when it starts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'randl-cap-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let server = await createServer(dir);
  await server.tools.execute('settings_update', { mediaLimit: { enabled: false } });
  const run = await server.db.call('upsert', { entity: 'e', project: 'cap', name: 'old' });
  await server.db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: Array.from({ length: 8 }, (_, i) =>
          JSON.stringify({ _step: i, clip: { _type: 'video-file', path: `media/videos/c_${i}.mp4` } }),
        ),
      },
    },
  });
  for (let i = 0; i < 8; i++)
    await server.app.inject({
      method: 'PUT',
      url: `/upload/e/cap/old/media/videos/c_${i}.mp4`,
      payload: Buffer.alloc(1024 * 1024, 1),
    });
  await server.db.call('settingSet', 'media-limit', { enabled: true, megabytes: 4 });
  await server.app.close();
  server = await createServer(dir);
  t.after(() => server.app.close());
  await expectEventually(async () =>
    assert.deepEqual(
      (
        await server.app.inject({
          url: '/api/media',
          method: 'POST',
          payload: { runs: [run.id], metric: 'clip' },
        })
      ).json().xValues,
      [0, 4, 7],
    ),
  );
});
test('media limit thinning spaces entries on the axis they are placed on', () => {
  // Evenly spaced steps whose places on the axis bunch up at the end: the bunch thins first.
  const entries = [0, 10, 20, 30, 40, 50].map((step, index) => ({
    ...entry(1, step),
    x: [0, 100, 200, 300, 310, 320][index],
  }));
  assert.deepEqual(steps(planMediaThinning(entries, 59, 40), entries, 1), [0, 10, 20, 50]);
  // Without places the same steps lose every other entry.
  const plain = [0, 10, 20, 30, 40, 50].map((step) => entry(1, step));
  assert.deepEqual(steps(planMediaThinning(plain, 59, 40), plain, 1), [0, 20, 40, 50]);
});
test('the media limit places entries on the thinning axis of the project', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'randl-cap-axis-'));
  const { app, db, tools, mediaCap } = await createServer(dir);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const run = await db.call('upsert', { entity: 'e', project: 'axis', name: 'r' });
  const updates = [0, 100, 200, 300, 310, 320];
  await db.call('ingest', run.id, {
    files: {
      'wandb-history.jsonl': {
        offset: 0,
        content: updates.map((update, i) =>
          JSON.stringify({
            _step: i * 10,
            update,
            clip: { _type: 'video-file', path: `media/videos/c_${i}.mp4` },
          }),
        ),
      },
    },
  });
  const places = async () => (await db.call('runMediaFiles', run.id)).map((row) => row.x);
  assert.deepEqual(await places(), [0, 10, 20, 30, 40, 50]);
  // A view's X axis does not place them; the project's thinning axis does.
  const view = await tools.execute('view_create', { project: 'e/axis', name: 'Workspace' });
  view.body.plotSettings = { xAxis: 'update' };
  await tools.execute('view_save', { id: view.id, name: view.name, project: view.project, version: view.version, body: view.body });
  assert.deepEqual(await places(), [0, 10, 20, 30, 40, 50]);
  assert.equal(
    (await tools.execute('project_media_limit_update', { id: 'e/axis', axis: 'update' })).axis,
    'update',
  );
  assert.deepEqual(await places(), updates);
  await tools.execute('settings_update', { mediaLimit: { enabled: false } });
  for (let i = 0; i < 6; i++)
    await app.inject({
      method: 'PUT',
      url: `/upload/e/axis/r/media/videos/c_${i}.mp4`,
      payload: Buffer.alloc(1024 * 1024, 1),
    });
  await db.call('settingSet', 'media-limit', { enabled: true, megabytes: 5 });
  assert.equal((await mediaCap.apply(run.id, 5 * 1024 * 1024)).entries, 2);
  const media = async (body) =>
    (
      await app.inject({
        url: '/api/media',
        method: 'POST',
        payload: { runs: [run.id], metric: 'clip', ...body },
      })
    ).json();
  assert.deepEqual((await media({ xAxis: 'update' })).xValues, [0, 100, 200, 320]);
});
test('media: the catalog of one run, with Latest still the newest of all runs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'randl-catalog-'));
  const { app, db } = await createServer(dir);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ids = [];
  for (const [name, steps] of [
    ['a', [0, 10, 20]],
    ['b', [5, 40]],
  ]) {
    const run = await db.call('upsert', { entity: 'e', project: 'c', name, displayName: name });
    await db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: steps.map((step) =>
            JSON.stringify({
              _step: step,
              epoch: step / 5,
              s: { _type: 'image-file', path: `media/images/${step}.png` },
            }),
          ),
        },
      },
    });
    ids.push(run.id);
  }
  const media = async (body) =>
    (
      await app.inject({
        url: '/api/media',
        method: 'POST',
        payload: { runs: ids, metric: 's', ...body },
      })
    ).json();
  for (const [axis, scale] of [
    [undefined, 1],
    ['epoch', 1 / 5],
  ]) {
    const all = await media({ xAxis: axis }),
      own = await media({ xAxis: axis, xRun: ids[0] });
    assert.deepEqual(all.xValues, [0, 5, 10, 20, 40].map((step) => step * scale));
    assert.deepEqual(own.xValues, [0, 10, 20].map((step) => step * scale));
    // Latest is the newest of all runs, so the other runs still show their newest media.
    assert.equal(own.x, 40 * scale);
    assert.deepEqual(own.entries.map((item) => item.step), [20, 40]);
  }
  assert.deepEqual((await media({ xRun: 'e/c/missing' })).xValues, [0, 5, 10, 20, 40]);
});
test('a project uses the server media limit until it sets its own', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'randl-cap-project-'));
  const { app, db, tools, mediaCap } = await createServer(dir);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const megabyte = 1024 * 1024;
  const log = async (project, count) => {
    const run = await db.call('upsert', { entity: 'e', project, name: 'r' });
    await db.call('ingest', run.id, {
      files: {
        'wandb-history.jsonl': {
          offset: 0,
          content: Array.from({ length: count }, (_, i) =>
            JSON.stringify({ _step: i, clip: { _type: 'video-file', path: `media/videos/c_${i}.mp4` } }),
          ),
        },
      },
    });
    for (let i = 0; i < count; i++)
      await app.inject({
        method: 'PUT',
        url: `/upload/e/${project}/r/media/videos/c_${i}.mp4`,
        payload: Buffer.alloc(megabyte, 1),
      });
    return run.id;
  };
  const kept = async (id) =>
    (
      await app.inject({ url: '/api/media', method: 'POST', payload: { runs: [id], metric: 'clip' } })
    ).json().xValues.length;
  await tools.execute('settings_update', { mediaLimit: { enabled: true, megabytes: 4 } });
  // By default a project inherits the server's limit, and its own values start from it.
  const inherits = await log('inherits', 8),
    own = await log('own', 8),
    off = await log('off', 8);
  assert.deepEqual(await tools.execute('project_media_limit_get', { id: 'e/own' }), {
    inherit: true,
    enabled: true,
    megabytes: 4,
    axis: '_step',
    effective: { enabled: true, megabytes: 4 },
  });
  assert.deepEqual(
    (await tools.execute('project_media_limit_update', { id: 'e/own', inherit: false, megabytes: 6 }))
      .effective,
    { enabled: true, megabytes: 6 },
  );
  assert.deepEqual(
    (await tools.execute('project_media_limit_update', { id: 'e/off', inherit: false, enabled: false }))
      .effective,
    { enabled: false, megabytes: 4 },
  );
  for (let i = 0; i < 3; i++) await mediaCap.pass();
  await expectEventually(async () => assert.deepEqual(await Promise.all([inherits, own, off].map(kept)), [3, 5, 8]));
  // Inheriting again applies the server's limit; the project's own values are kept for later.
  const back = await tools.execute('project_media_limit_update', { id: 'e/off', inherit: true });
  assert.deepEqual([back.inherit, back.enabled, back.effective], [true, false, { enabled: true, megabytes: 4 }]);
  await expectEventually(async () => assert.equal(await kept(off), 3));
  // Unknown projects and invalid sizes are refused.
  await assert.rejects(tools.execute('project_media_limit_get', { id: 'e/missing' }));
  assert.equal(
    (
      await app.inject({
        url: '/api/tools/project_media_limit_update',
        method: 'POST',
        payload: { id: 'e/own', megabytes: 0 },
      })
    ).statusCode,
    400,
  );
});
