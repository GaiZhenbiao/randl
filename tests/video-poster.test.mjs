import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoPosters } from '../backend/dist/video-poster.js';
import { videoSize } from '../backend/dist/video-size.js';

// The first frame of a logged video as a JPEG image, made by ffmpeg and cached on disk, and a
// video's size from its header.
let ffmpeg = true;
try {
  execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = false;
}
test(
  'posters are the first frame at its size, cached, and refuse other inputs',
  { skip: !ffmpeg && 'ffmpeg is not installed' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'randl-poster-'));
    try {
      const video = join(directory, 'clip.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=96x54:r=10:d=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        video,
      ]);
      const posters = new VideoPosters(directory);
      assert.equal(await posters.enabled(), true);
      const image = await posters.poster(video, 1, 1);
      // A JPEG of the video's size: SOI marker, then the frame's dimensions.
      assert.deepEqual([...image.subarray(0, 2)], [0xff, 0xd8]);
      const sof = image.indexOf(Buffer.from([0xff, 0xc0]));
      assert.deepEqual([image.readUInt16BE(sof + 7), image.readUInt16BE(sof + 5)], [96, 54]);
      assert.equal((await readdir(join(directory, 'cache', 'posters'))).length, 1);
      assert.deepEqual(await posters.poster(video, 1, 1), image, 'served from the cache');
      // The extension chooses the demuxer: a playlist named .mp4 is not read as a playlist.
      const playlist = join(directory, 'list.mp4');
      await writeFile(playlist, '#EXTM3U\n#EXTINF:1,\n' + video + '\n');
      await assert.rejects(posters.poster(playlist, 1, 1), { statusCode: 422 });
      await assert.rejects(posters.poster(join(directory, 'a.txt'), 1, 1), /no poster/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test('without ffmpeg posters are off', async () => {
  assert.equal(await new VideoPosters(tmpdir(), 'off').enabled(), false);
  assert.equal(await new VideoPosters(tmpdir(), '/nonexistent/ffmpeg').enabled(), false);
});
test(
  "video sizes come from MP4, WebM and GIF headers, wherever the MP4's header is",
  { skip: !ffmpeg && 'ffmpeg is not installed' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'randl-video-size-'));
    const make = (name, size, ...options) => {
      const path = join(directory, name);
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=s=${size}:r=10:d=1`,
        ...options,
        '-y',
        path,
      ]);
      return path;
    };
    try {
      // The header leads (faststart) or follows the media data.
      const first = make('first.mp4', '128x54', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
      const last = make('last.mp4', '54x96', '-pix_fmt', 'yuv420p');
      assert.deepEqual(await videoSize(first), { width: 128, height: 54 });
      assert.deepEqual(await videoSize(last), { width: 54, height: 96 });
      // A quarter-turn matrix shows the frame turned, as browsers and the poster do.
      const turned = join(directory, 'turned.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        first,
        '-c',
        'copy',
        '-metadata:s:v:0',
        'rotate=90',
        '-y',
        turned,
      ]);
      assert.deepEqual(await videoSize(turned), { width: 54, height: 128 });
      assert.deepEqual(await videoSize(make('clip.webm', '80x60', '-c:v', 'libvpx')), {
        width: 80,
        height: 60,
      });
      assert.deepEqual(await videoSize(make('loop.gif', '40x30')), { width: 40, height: 30 });
      // Other bytes, a missing file and other types have no size.
      const noise = join(directory, 'noise.mp4');
      await writeFile(noise, Buffer.alloc(4096, 7));
      assert.equal(await videoSize(noise), undefined);
      assert.equal(await videoSize(join(directory, 'missing.mp4')), undefined);
      assert.equal(await videoSize(join(directory, 'clip.ogv')), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
