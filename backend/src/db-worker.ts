import { errorFields } from './management-errors.js';
import { parentPort, workerData, Worker } from 'node:worker_threads';
import { Store, isJob, type Row } from './database.js';
const store = new Store(workerData.directory);
store.db.pragma('wal_autocheckpoint=0');
const checkpoint = new Worker(new URL('./db-checkpoint.js', import.meta.url), {
  workerData: { directory: workerData.directory },
});
checkpoint.on('error', (error) => {
  throw error;
});
const allowed = new Set([
  'chatList',
  'chatGet',
  'chatEnsure',
  'chatRename',
  'chatEntries',
  'chatCheckpoint',
  'chatAppend',
  'chatUpdate',
  'chatReplace',
  'chatDelete',
  'settingGet',
  'settingSet',
  'authConfigure',
  'sessionCreate',
  'sessionGet',
  'sessionDelete',
  'runMetas',
  'runRevisions',
  'runMetadata',
  'staleRuns',
  'storageMaintain',
  'alert',
  'alerts',
  'runEdit',
  'runFields',
  'runValues',
  'deletedRuns',
  'runManage',
  'queryRuns',
  'media',
  'artifact',
  'logs',
  'exportHistory',
  'run',
  'runs',
  'upsert',
  'ingest',
  'tail',
  'historyTail',
  'historyKeys',
  'streamCount',
  'keys',
  'metricTypes',
  'metricSettings',
  'chart',
  'chartJob',
  'chartPlan',
  'chartSeries',
  'projects',
  'rebuildRuntimes',
  'projectCreate',
  'projectUpdate',
  'projectGet',
  'projectDelete',
  'runFileWritten',
  'storageTotals',
  'views',
  'view',
  'viewSave',
  'viewDelete',
  'plugins',
  'pluginSave',
  'pluginDelete',
  'audit',
  'auditList',
]);
type Request = { id: number; method: string; args: any[] };
const queue: Request[] = [];
// Jobs (grouped charts) run in slices of this length; other requests are served in between.
const slice = 20;
const jobs = new Map<
  number,
  { job: Generator<void, Row>; serviceMs: number; sliceMs: number; cancelled: boolean }
>();
// Requests cancelled while still queued.
const cancelled = new Set<number>();
let paused = false,
  scheduled = false,
  closing = false;
let pauseTimer: ReturnType<typeof setTimeout>;
function schedule() {
  if (paused || scheduled || closing || !queue.length) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    if (paused || closing) return;
    dispatch(queue.shift()!);
    schedule();
  });
}
function resume() {
  clearTimeout(pauseTimer);
  paused = false;
  schedule();
}
checkpoint.on('message', (message) => {
  if (closing) return;
  if (message === 'checkpoint') {
    // Let PASSIVE catch up even under continuous writes. Never wait for slow
    // filesystem work: resume request admission after at most 20 ms.
    paused = true;
    pauseTimer = setTimeout(() => {
      resume();
      // A transaction admitted after this window can commit after PASSIVE's
      // final snapshot. Ask for another catch-up window even if it reported done.
      checkpoint.postMessage('retry');
    }, 20);
    checkpoint.postMessage('checkpoint');
  } else resume();
});
parentPort!.on('message', (request: Request | { cancel: number }) => {
  if ('cancel' in request) {
    const entry = jobs.get(request.cancel);
    if (entry) entry.cancelled = true;
    else if (queue.some((item) => item.id === request.cancel)) cancelled.add(request.cancel);
    return;
  }
  queue.push(request);
  schedule();
});
// Advances a job for one slice, then queues its continuation behind waiting requests.
function advance(id: number, started: number) {
  const entry = jobs.get(id)!;
  try {
    if (entry.cancelled) {
      jobs.delete(id);
      entry.job.return(undefined as any);
      return;
    }
    for (;;) {
      const step = entry.job.next();
      if (step.done) {
        const elapsed = performance.now() - started;
        jobs.delete(id);
        parentPort!.postMessage({
          id,
          value: step.value,
          serviceMs: entry.serviceMs + elapsed,
          // The longest slice, for measuring how long the job held the worker at once.
          sliceMs: Math.max(entry.sliceMs, elapsed),
        });
        return;
      }
      if (performance.now() - started >= slice) break;
    }
    const elapsed = performance.now() - started;
    entry.serviceMs += elapsed;
    entry.sliceMs = Math.max(entry.sliceMs, elapsed);
    queue.push({ id, method: '', args: [] });
  } catch (error) {
    const elapsed = performance.now() - started;
    jobs.delete(id);
    parentPort!.postMessage({
      id,
      error: errorFields(error as Error),
      serviceMs: entry.serviceMs + elapsed,
      sliceMs: Math.max(entry.sliceMs, elapsed),
    });
  }
}
function dispatch({ id, method, args }: Request) {
  if (method === 'close') {
    closing = true;
    clearTimeout(pauseTimer);
    checkpoint.once('exit', () => {
      store.db.close();
      parentPort!.close();
    });
    checkpoint.postMessage('close');
    return;
  }
  const started = performance.now();
  if (jobs.has(id)) return advance(id, started);
  if (cancelled.delete(id)) return;
  try {
    if (!allowed.has(method)) throw Error('Unknown database operation');
    const value = (store[method as keyof Store] as (...a: any[]) => any).apply(store, args);
    if (isJob(value)) {
      jobs.set(id, { job: value, serviceMs: 0, sliceMs: 0, cancelled: false });
      return advance(id, started);
    }
    parentPort!.postMessage({ id, value, serviceMs: performance.now() - started });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: errorFields(error as Error),
      serviceMs: performance.now() - started,
    });
  }
}
