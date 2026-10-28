import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const js = ts.transpileModule(
  await readFile(new URL('../frontend/src/media-playback.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const listeners = {};
globalThis.document = {
  hidden: false,
  addEventListener: (type, listener) => (listeners[type] = listener),
};
const { attachPlayer, detachPlayers, pausePlayers, playbackLimits } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);
// A media element stand-in: play events, pause, and its source.
function element(tagName) {
  const handlers = new Set();
  return {
    tagName,
    paused: true,
    src: 'file',
    play() {
      this.paused = false;
      for (const handler of handlers) handler.call(this);
    },
    pause() {
      this.paused = true;
    },
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    load() {},
    addEventListener: (_, handler) => handlers.add(handler),
    removeEventListener: (_, handler) => handlers.delete(handler),
  };
}

test('videos play together, audio one at a time, and the least recently used paused videos are released', () => {
  const panel = {},
    other = {},
    released = [];
  const videos = Array.from({ length: playbackLimits.videoPerPanel + 2 }, () => element('VIDEO'));
  videos.forEach((video, i) => attachPlayer(panel, video, () => released.push(i)));
  // The two oldest of eight are released: six per panel.
  assert.deepEqual(released, [0, 1]);
  assert.equal(videos[0].src, '');
  // Starting a video with sound never pauses another.
  videos[2].play();
  videos[3].play();
  assert.deepEqual(
    videos.map((video) => video.paused),
    [true, true, false, false, true, true, true, true],
  );
  // Across panels at most twelve videos are kept; a playing one is never released.
  const more = Array.from({ length: 8 }, () => element('VIDEO'));
  more.forEach((video, i) => attachPlayer(other, video, () => released.push('other ' + i)));
  assert.equal(released.length, 4);
  assert.ok(!released.includes(2) && !released.includes(3));
  // Audio has its own per-panel bound, and audio with sound pauses other audio, not videos.
  const audio = Array.from({ length: playbackLimits.audioPerPanel + 1 }, () => element('AUDIO'));
  audio.forEach((item, i) => attachPlayer(panel, item, () => released.push('audio ' + i)));
  assert.equal(released.at(-1), 'audio 0');
  audio[1].play();
  audio[2].play();
  assert.deepEqual([audio[1].paused, audio[2].paused, videos[3].paused], [true, false, false]);
  // A hidden page pauses everything; a panel leaving view pauses its own media.
  globalThis.document.hidden = true;
  listeners.visibilitychange();
  assert.equal(videos[3].paused, true);
  more[7].play();
  pausePlayers(other);
  assert.equal(more[7].paused, true);
  detachPlayers(panel);
  detachPlayers(other);
  assert.ok([...videos, ...more, ...audio].every((item) => item.src === ''));
});

test('muted autoplay yields to the newest; videos started by hand play on past the limits', () => {
  globalThis.document.hidden = false;
  const panel = {},
    released = [];
  const autoplay = Array.from({ length: playbackLimits.videoPerPanel + 1 }, (_, i) => {
    const video = Object.assign(element('VIDEO'), { muted: true });
    attachPlayer(panel, video, () => released.push(i), true);
    video.play();
    return video;
  });
  // Six play muted at once; the seventh replaced the oldest although it was playing.
  assert.deepEqual(released, [0]);
  assert.equal(autoplay.slice(1).filter((video) => !video.paused).length, 6);
  // Unmuting an autoplaying video keeps it: it is no longer released while it plays.
  autoplay[6].muted = false;
  // Videos the viewer starts take the places of muted autoplay, then exceed the limits rather
  // than stop one another.
  const manual = Array.from({ length: playbackLimits.video + 1 }, () => element('VIDEO'));
  for (const video of manual) {
    attachPlayer(panel, video, () => released.push('manual'));
    video.play();
  }
  assert.ok(manual.every((video) => !video.paused));
  assert.ok(!released.includes('manual'));
  assert.deepEqual(released, [0, 1, 2, 3, 4, 5]);
  assert.equal(autoplay[6].paused, false);
  detachPlayers(panel);
});
