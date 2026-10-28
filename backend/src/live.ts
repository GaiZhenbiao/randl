import type { ServerResponse } from 'node:http';
import type { DB } from './db.js';

export class LiveUpdates {
  clients = new Map<ServerResponse, () => Promise<boolean>>();
  pending = new Set<string>();
  workspace = false;
  timer?: ReturnType<typeof setTimeout>;
  sequence = 0;
  heartbeat: ReturnType<typeof setInterval>;
  constructor(readonly db: DB) {
    this.heartbeat = setInterval(() => void this.send(': heartbeat\n\n'), 25000);
    this.heartbeat.unref();
  }
  add(response: ServerResponse, authorized: () => Promise<boolean>) {
    this.clients.set(response, authorized);
    response.write('event: ready\ndata: {}\n\n');
    response.on('close', () => this.clients.delete(response));
  }
  changedRun(id: string) {
    this.pending.add(id);
    this.schedule();
  }
  changedWorkspace() {
    this.workspace = true;
    this.schedule();
  }
  schedule() {
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 120);
  }
  async send(message: string) {
    for (const [response, authorized] of this.clients) {
      try {
        if (!(await authorized())) {
          response.end();
          this.clients.delete(response);
        } else if (response.writableLength > 65536) response.destroy();
        else response.write(message);
      } catch {
        response.destroy();
      }
    }
  }
  async flush() {
    this.timer = undefined;
    const ids = [...this.pending],
      workspace = this.workspace;
    this.pending.clear();
    this.workspace = false;
    try {
      const runs = ids.length ? await this.db.call('runMetas', ids) : [],
        found = new Set(runs.map((r: any) => r.id));
      await this.send(
        `id: ${++this.sequence}\ndata: ${JSON.stringify({ runs, removed: ids.filter((id) => !found.has(id)), workspace })}\n\n`,
      );
    } catch {
      await this.send('event: reset\ndata: {}\n\n');
    }
  }
  close() {
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    for (const response of this.clients.keys()) response.end();
    this.clients.clear();
  }
}
