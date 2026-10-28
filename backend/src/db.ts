import { Worker } from 'node:worker_threads';
export class DB {
  worker: Worker;
  counter = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  failed?: Error;
  /** Receives each call's duration (ms), the queue depth at its start and whether it failed. */
  observe?: (ms: number, queue: number, failed: boolean) => void;
  constructor(directory: string) {
    this.worker = new Worker(new URL('./db-worker.js', import.meta.url), {
      workerData: { directory },
    });
    this.worker.on('message', ({ id, value, error }) => {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error)
        p?.reject(
          Object.assign(Error(error.message), {
            code: error.code,
            statusCode: error.statusCode,
            params: error.params,
          }),
        );
      else p?.resolve(value);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.failed) this.fail(Error('Database worker stopped (exit ' + code + ')'));
    });
  }
  fail(error: Error) {
    this.failed = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
  call(method: string, ...args: any[]): Promise<any> {
    return this.send(method, args);
  }
  /**
   * Like call, for methods the worker may advance in slices (grouped charts). Aborting
   * rejects at once and stops the work at its next slice.
   */
  job(signal: AbortSignal, method: string, ...args: any[]): Promise<any> {
    return this.send(method, args, signal);
  }
  private send(method: string, args: any[], signal?: AbortSignal): Promise<any> {
    if (this.failed) return Promise.reject(this.failed);
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (this.pending.size >= 64)
      return Promise.reject(
        Object.assign(Error('Database busy; retry shortly'), { statusCode: 503 }),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.counter,
        started = performance.now(),
        queue = this.pending.size,
        done = (failed: boolean) => this.observe?.(performance.now() - started, queue, failed);
      const abort = () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ cancel: id });
        done(true);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          done(false);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          done(true);
          reject(error);
        },
      });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }
  async close() {
    if (this.failed) return;
    this.fail(Error('Database closed'));
    await new Promise<void>((resolve) => {
      this.worker.once('exit', () => resolve());
      this.worker.postMessage({ method: 'close' });
    });
  }
}
