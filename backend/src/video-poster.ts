import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';

// The first frame of a logged video as a small JPEG image, so media panels show it without
// downloading the video. A system ffmpeg makes it: the one on PATH, or RANDL_FFMPEG (a path,
// or "off"). Without ffmpeg the endpoint answers 501 and the browser draws the frame itself.
// Images are cached in the data directory by file, size and modification time.

/** The demuxer for each video type; forcing it keeps playlists and other inputs out. */
const demuxers: Record<string, string> = { '.mp4': 'mp4', '.webm': 'webm', '.gif': 'gif' };
export const posterTypes = new Set(Object.keys(demuxers));
const limits = {
  /** ffmpeg processes at once. */
  concurrency: 2,
  timeoutMs: 20000,
  /** Widest poster in pixels; narrower videos keep their width. */
  width: 800,
  outputBytes: 4 * 1024 * 1024,
  /** Cached posters kept; pruning removes the oldest down to `keep`. */
  cached: 4000,
  keep: 3000,
};
export class VideoPosters {
  private available: Promise<boolean> | undefined;
  private running = 0;
  private waiting: (() => void)[] = [];
  private pending = new Map<string, Promise<Buffer>>();
  private writes = 0;
  private folder: string;
  constructor(
    directory: string,
    private command = process.env.RANDL_FFMPEG || 'ffmpeg',
  ) {
    this.folder = join(directory, 'cache', 'posters');
  }
  /** Whether ffmpeg runs; checked once. */
  enabled() {
    if (this.command === 'off') return Promise.resolve(false);
    return (this.available ??= new Promise((resolve) => {
      const child = spawn(this.command, ['-hide_banner', '-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    }));
  }
  /** The poster of the video at `file`, from the cache or made now. */
  async poster(file: string, size: number, modified: number) {
    const key = createHash('sha256')
        .update([file, size, Math.floor(modified)].join('\0'))
        .digest('hex'),
      path = join(this.folder, key + '.jpg');
    try {
      return await fs.readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let job = this.pending.get(key);
    if (!job) {
      job = this.queued(() => this.make(file))
        .then(async (data) => {
          await this.store(path, data);
          return data;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    return job;
  }
  private async queued<T>(work: () => Promise<T>) {
    while (this.running >= limits.concurrency)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
  private make(file: string) {
    const demuxer = demuxers[extname(file).toLowerCase()];
    if (!demuxer) return Promise.reject(Error('This file type has no poster'));
    // Arguments go to ffmpeg directly, without a shell; the input path is absolute.
    const child = spawn(
      this.command,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file',
        '-f',
        demuxer,
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${limits.width},iw)':-2`,
        '-q:v',
        '6',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), limits.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limits.outputBytes) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && bytes > 0 && bytes <= limits.outputBytes) resolve(Buffer.concat(chunks));
        else reject(Object.assign(Error('This video has no frame to show'), { statusCode: 422 }));
      });
    });
  }
  private async store(path: string, data: Buffer) {
    await fs.mkdir(this.folder, { recursive: true });
    const partial = path + '.' + process.pid + '.part';
    await fs.writeFile(partial, data);
    await fs.rename(partial, path);
    if (++this.writes % 100 === 0) await this.prune();
  }
  private async prune() {
    const names = (await fs.readdir(this.folder)).filter((name) => name.endsWith('.jpg'));
    if (names.length <= limits.cached) return;
    const dated = await Promise.all(
      names.map(async (name) => {
        const stat = await fs.stat(join(this.folder, name)).catch(() => undefined);
        return { name, time: stat?.mtimeMs ?? 0 };
      }),
    );
    dated.sort((a, b) => a.time - b.time);
    for (const { name } of dated.slice(0, dated.length - limits.keep))
      await fs.rm(join(this.folder, name), { force: true });
  }
}
