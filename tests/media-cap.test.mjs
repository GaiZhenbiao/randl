import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/dist/server.js';
import { planMediaThinning } from '../backend/dist/media-cap.js';
import { mediaPaths } from '../backend/dist/media-items.js';
import { runFolder } from '../backend/dist/project-store.js';

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
  assert.deepEqual(await tools.execute('settings_get', {}), { mediaLimitMB: 500 });
  assert.deepEqual(await tools.execute('settings_update', { mediaLimitMB: 1 }), { mediaLimitMB: 1 });
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
  await tools.execute('settings_update', { mediaLimitMB: 0 });
  const unlimited = await log('c', 8);
  await mediaCap.pass();
  assert.equal((await shown(unlimited)).length, 8);
  // Applying to all runs reports first, then removes; entries still uploading stay.
  await tools.execute('settings_update', { mediaLimitMB: 1 });
  const pending = await log('d', 8, false);
  const preview = await tools.execute('media_limit_apply', { dryRun: true });
  assert.deepEqual(
    [preview.dryRun, preview.runs, preview.runsOver, preview.entries, preview.bytes],
    [true, 4, 1, 5, 1.25 * megabyte],
  );
  assert.equal((await shown(unlimited)).length, 8);
  const applied = await tools.execute('media_limit_apply', {});
  assert.deepEqual([applied.runsOver, applied.entries, applied.files], [1, 5, 5]);
  assert.deepEqual(await shown(unlimited), [0, 40, 70]);
  assert.equal((await shown(pending)).length, 8);
  assert.equal((await tools.execute('media_limit_apply', {})).entries, 0);
  assert.equal(
    (await app.inject({ url: '/api/tools/settings_update', method: 'POST', payload: { mediaLimitMB: -1 } }))
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
