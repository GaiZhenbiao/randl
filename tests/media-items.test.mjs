import test from 'node:test';
import assert from 'node:assert/strict';
import { limitMedia, mediaCount, mediaItems } from '../backend/dist/media-items.js';
import { byteRange } from '../backend/dist/byte-range.js';

// Values in the shapes the W&B SDK logs (wandb/sdk/data_types/*.py `to_json`/`seq_to_json`).
const video = (i, caption) => ({
  _type: 'video-file',
  sha256: 'v' + i,
  size: 1000 + i,
  path: `media/videos/rollout/video_${i}.mp4`,
  ...(caption ? { caption } : {}),
  width: 792,
  height: 476,
});
test('single files are one item with their caption, digest and size', () => {
  assert.deepEqual(mediaItems(video(1, 'one')), [
    {
      path: 'media/videos/rollout/video_1.mp4',
      caption: 'one',
      sha256: 'v1',
      width: 792,
      height: 476,
    },
  ]);
  assert.deepEqual(mediaItems({ _type: 'image-file', path: 'media/images/a.png', format: 'png' }), [
    { path: 'media/images/a.png' },
  ]);
  assert.deepEqual(mediaItems({ _type: 'histogram', values: [1], bins: [0, 1] }), []);
  assert.equal(mediaCount({ _type: 'histogram', values: [1], bins: [0, 1] }), 1);
  assert.equal(mediaCount(null), 0);
});
test('video lists keep each file and caption; top-level captions win, false is ignored', () => {
  const logged = {
    _type: 'videos',
    count: 3,
    videos: [video(0, 'episode 0'), video(1, 'episode 1'), video(2)],
    captions: false,
  };
  assert.deepEqual(
    mediaItems(logged).map((item) => [item.path, item.caption, item.sha256, item.width]),
    [
      ['media/videos/rollout/video_0.mp4', 'episode 0', 'v0', 792],
      ['media/videos/rollout/video_1.mp4', 'episode 1', 'v1', 792],
      ['media/videos/rollout/video_2.mp4', undefined, 'v2', 792],
    ],
  );
  assert.deepEqual(
    mediaItems({ ...logged, captions: ['a', 'b', 'c'] }).map((item) => item.caption),
    ['a', 'b', 'c'],
  );
  assert.equal(mediaCount(logged), 3);
  const limited = limitMedia({ ...logged, captions: ['a', 'b', 'c'] }, 2);
  assert.deepEqual(limited.videos, logged.videos.slice(0, 2));
  assert.deepEqual(limited.captions, ['a', 'b']);
  assert.equal(limited.count, 3, 'the logged count is kept');
  assert.equal(limitMedia(logged, 3), logged);
});
test('audio lists slice captions, durations and sample rates together', () => {
  const clip = (i) => ({
    _type: 'audio-file',
    path: `media/audio/a_${i}.wav`,
    sha256: 'a' + i,
    size: 10,
  });
  const logged = {
    _type: 'audio',
    count: 3,
    audio: [clip(0), clip(1), clip(2)],
    sampleRates: [8000, 8000, 16000],
    durations: [0.1, 0.2, 0.3],
    captions: ['x', '', 'z'],
  };
  assert.deepEqual(
    mediaItems(logged).map((item) => [item.path, item.caption]),
    [
      ['media/audio/a_0.wav', 'x'],
      ['media/audio/a_1.wav', undefined],
      ['media/audio/a_2.wav', 'z'],
    ],
  );
  const limited = limitMedia(logged, 1);
  assert.deepEqual(
    [limited.audio.length, limited.sampleRates, limited.durations, limited.captions],
    [1, [8000], [0.1], ['x']],
  );
});
test('image lists use filenames with the collection size; masks and boxes follow the slice', () => {
  const logged = {
    _type: 'images/separated',
    width: 4,
    height: 3,
    format: 'png',
    count: 2,
    filenames: ['media/images/g_0.png', 'media/images/g_1.png'],
    captions: ['first', 'second'],
    all_boxes: [{ p: 1 }, { p: 2 }],
  };
  assert.deepEqual(mediaItems(logged), [
    { path: 'media/images/g_0.png', caption: 'first', width: 4, height: 3 },
    { path: 'media/images/g_1.png', caption: 'second', width: 4, height: 3 },
  ]);
  assert.deepEqual(limitMedia(logged, 1).all_boxes, [{ p: 1 }]);
});
test('html and 3D lists list their file descriptors, not the relative object filenames', () => {
  assert.deepEqual(
    mediaItems({
      _type: 'html',
      count: 1,
      html: [{ _type: 'html-file', path: 'media/html/a.html' }],
    }),
    [{ path: 'media/html/a.html' }],
  );
  assert.deepEqual(
    mediaItems({
      _type: 'object3D',
      count: 1,
      filenames: ['a.pts.json'],
      objects: [{ _type: 'object3D-file', path: 'media/object3D/a.pts.json' }],
    }),
    [{ path: 'media/object3D/a.pts.json' }],
  );
});
test('byte ranges: first, open, suffix, clamped, unsatisfiable and ignored forms', () => {
  assert.deepEqual(byteRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(byteRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(byteRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.equal(byteRange('bytes=1000-', 1000), null);
  assert.equal(byteRange('bytes=5-1', 1000), null);
  assert.equal(byteRange('bytes=-0', 1000), null);
  assert.equal(byteRange(undefined, 1000), undefined);
  assert.equal(byteRange('bytes=0-1,5-6', 1000), undefined);
  assert.equal(byteRange('items=0-1', 1000), undefined);
});
