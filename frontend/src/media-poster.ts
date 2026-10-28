// First frames of videos for tiles that are not playing. The server makes a small JPEG with
// ffmpeg (GET /api/run-file-poster); when it has no ffmpeg (501), the browser loads the video's
// metadata, seeks to its start and draws that frame as a data URL, then releases the video.
// Loads run a few at a time, only for tiles in view, and stop when their tile leaves; the
// newest posters' URLs and sizes stay in memory.
export type Poster = { url: string; width: number; height: number };
/** A file whose poster failed is tried again after `retryMs`. */
const limits = { server: 4, browser: 2, cached: 200, failed: 1000, retryMs: 60000 };
const cache = new Map<string, Poster>(),
  failed = new Map<string, number>();
/** Whether the server makes posters; unknown until it answers. */
let server: boolean | undefined;
type Job = {
  key: string;
  poster: string;
  file: string;
  signal: AbortSignal;
  resolve: (poster: Poster | undefined) => void;
};
const queue: Job[] = [];
let running = 0;
/** A cached poster, which becomes the most recently used. */
export function cachedPoster(key: string) {
  const poster = cache.get(key);
  if (poster) {
    cache.delete(key);
    cache.set(key, poster);
  }
  return poster;
}
function remember(key: string, poster: Poster) {
  cache.set(key, poster);
  while (cache.size > limits.cached) cache.delete(cache.keys().next().value!);
}
/** Loads of one file shared by the tiles that show it; the last tile to leave stops it. */
const shared = new Map<
  string,
  { promise: Promise<Poster | undefined>; controller: AbortController; waiters: number }
>();
/**
 * The poster of the video at `file` (`poster` is its server URL), or undefined when it has
 * none or `signal` aborts first. `key` names the file's content.
 */
export function loadPoster(key: string, poster: string, file: string, signal: AbortSignal) {
  const known = cachedPoster(key);
  if (known) return Promise.resolve(known);
  if ((failed.get(key) ?? -Infinity) > Date.now() - limits.retryMs || signal.aborted)
    return Promise.resolve(undefined);
  let load = shared.get(key);
  if (!load || load.controller.signal.aborted) {
    const controller = new AbortController(),
      started = { controller, waiters: 0, promise: queued(key, poster, file, controller.signal) };
    shared.set(key, started);
    void started.promise.then(() => {
      if (shared.get(key) === started) shared.delete(key);
    });
    load = started;
  }
  const current = load;
  current.waiters++;
  return new Promise<Poster | undefined>((resolve) => {
    const leave = () => {
      resolve(undefined);
      if (--current.waiters === 0) current.controller.abort();
    };
    signal.addEventListener('abort', leave, { once: true });
    void current.promise.then((result) => {
      signal.removeEventListener('abort', leave);
      resolve(signal.aborted ? undefined : result);
    });
  });
}
function queued(key: string, poster: string, file: string, signal: AbortSignal) {
  return new Promise<Poster | undefined>((resolve) => {
    const job: Job = { key, poster, file, signal, resolve };
    queue.push(job);
    signal.addEventListener(
      'abort',
      () => {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        resolve(undefined);
      },
      { once: true },
    );
    next();
  });
}
function next() {
  const limit = server === false ? limits.browser : limits.server;
  while (running < limit && queue.length) {
    const job = queue.shift()!;
    running++;
    void make(job)
      .then(
        (poster) => {
          if (poster) remember(job.key, poster);
          return poster;
        },
        () => {
          if (!job.signal.aborted) {
            failed.delete(job.key);
            failed.set(job.key, Date.now());
            if (failed.size > limits.failed) failed.delete(failed.keys().next().value!);
          }
          return undefined;
        },
      )
      .then((poster) => {
        running--;
        job.resolve(job.signal.aborted ? undefined : poster);
        next();
      });
  }
}
async function make(job: Job): Promise<Poster | undefined> {
  if (server !== false)
    try {
      const poster = await decoded(job.poster, job.signal);
      server = true;
      return poster;
    } catch (error) {
      if (job.signal.aborted) throw error;
      // An image error does not say why; the status does.
      const response = await fetch(job.poster, { method: 'HEAD', signal: job.signal });
      if (response.status !== 501) throw error;
      server = false;
    }
  return drawn(job);
}
// The server's poster URL is the image's source, so the HTTP cache keeps it. An abort rejects
// at once: Chromium never settles `decode()` for an image whose source was removed, which
// would hold the load's place in the queue for good.
async function decoded(url: string, signal: AbortSignal) {
  const image = new Image();
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      image.removeAttribute('src');
      reject(Error('Poster aborted'));
    };
  });
  signal.addEventListener('abort', stop, { once: true });
  image.src = url;
  try {
    await Promise.race([image.decode(), aborted]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
  return { url, width: image.naturalWidth, height: image.naturalHeight };
}
/** Most pixels across a poster the browser draws. */
const drawnWidth = 640;
// The browser reads the metadata and the first frames, not the whole file; releasing the
// video stops its download.
async function drawn({ file, signal }: Job) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  const release = () => {
    video.removeAttribute('src');
    video.load();
  };
  signal.addEventListener('abort', release, { once: true });
  // Resolves on `event`; an error or an abort rejects.
  const wait = (event: 'loadedmetadata' | 'seeked', start: () => void) =>
    new Promise<void>((resolve, reject) => {
      const stop = () => reject(Error('Poster aborted'));
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      video.addEventListener(event, () => resolve(), { once: true });
      video.onerror = () => reject(Error(video.error?.message || 'Video cannot be decoded'));
      start();
    });
  try {
    await wait('loadedmetadata', () => (video.src = file));
    await wait('seeked', () => (video.currentTime = Math.min(0.001, video.duration || 0)));
    if (signal.aborted || !video.videoWidth) return undefined;
    const scale = Math.min(1, drawnWidth / video.videoWidth),
      canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
      url: canvas.toDataURL('image/jpeg', 0.8),
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    signal.removeEventListener('abort', release);
    release();
  }
}
