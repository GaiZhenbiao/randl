import { streamedTransform } from './record-chart.js';
import {managementError,errorFields} from './management-errors.js';
import { selectionError } from './selection-limits.js';
import panelLimits from './panel-limits.json' with { type: 'json' };
import { LiveUpdates } from './live.js';
import { chartDiff, chartSampled, clipChart, diffSeries, type Series } from './chart-diff.js';
import { ChartSelections } from './chart-selection.js';
import selectionLimits from './selection-limits.json' with { type: 'json' };
import { configureAuth, type Hosting } from './auth.js';
import { KeyedLocks } from './locks.js';
import { writeUpload } from './upload.js';
import { byteRange } from './byte-range.js';
import { VideoPosters, posterTypes } from './video-poster.js';
import { videoSize } from './video-size.js';
import { Readable } from 'node:stream';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { promises as fs, createReadStream } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { DB } from './db.js';
import { runFolder } from './project-store.js';
import { ServerMetrics, routeGroup, BUCKET_MS } from './metrics.js';
import { artifactQuery, artifactFolder, artifactFile } from './artifact-api.js';
import { sdkQuery } from './sdk.js';
import { Plugins, contained } from './plugins.js';
import {
  Tools,
  toolCatalog,
  viewBodySchema,
  settingsSchema,
  runGroupRule,
  chartGroupRule,
} from './tools.js';
import { Agent } from './agent.js';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export class Cache {
  entries = new Map<string, Buffer>();
  size = 0;
  constructor(readonly limit = 16 * 1024 * 1024) {}
  get(k: string) {
    const v = this.entries.get(k);
    if (v) {
      this.entries.delete(k);
      this.entries.set(k, v);
    }
    return v;
  }
  put(k: string, v: Buffer) {
    const old = this.entries.get(k);
    if (old) {
      this.size -= old.length;
      this.entries.delete(k);
    }
    if (v.length > this.limit) return;
    this.entries.set(k, v);
    this.size += v.length;
    while (this.size > this.limit) {
      const key = this.entries.keys().next().value!;
      this.size -= this.entries.get(key)!.length;
      this.entries.delete(key);
    }
  }
}
// Runs per chunk of a streamed chart response: small first so panels draw early, then
// doubling so a panel is redrawn only a few times.
const chartChunks = { first: 4, largest: 64 };
const str = { type: 'string', maxLength: 4096 },
  ids = { type: 'array', items: str, maxItems: 1000 };
const object = (properties: any, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export async function createServer(
  directory = resolve('.data'),
  options: Hosting & {
    // A deployed copy of frontend/dist, so rebuilding the checkout does not change the running app.
    frontend?: string;
    port?: number;
    runTimeoutSeconds?: number;
    piAgentDir?: string;
    // The W&B entity reported as the SDK viewer's default; runs logged without an entity use it.
    entity?: string;
  } = {},
) {
  const entity = options.entity || process.env.RANDL_ENTITY || 'local';
  if (!/^[^/\s]{1,256}$/.test(entity)) throw Error('Entity must be a name without slashes or spaces');
  const runTimeout=options.runTimeoutSeconds??600;
  if(!Number.isFinite(runTimeout)||runTimeout<60)throw Error('Run timeout must be at least 60 seconds');
  const app = Fastify({
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
      logger: false,
      bodyLimit: 32 * 1024 * 1024,
      requestTimeout: 120000,
    }),
    db = new DB(directory),
    plugins = new Plugins(db, directory),
    live = new LiveUpdates(db),
    artifactLocks = new KeyedLocks(),
    tools = new Tools(db, plugins, (ids) => {
      for (const id of ids || []) live.changedRun(id);
      live.changedWorkspace();
    }, async (removed) => {
      let failures=0;
      for(const id of removed.runIds) {
        const folder=runFolder(directory,id);
        try { await fs.rm(folder,{recursive:true,force:true}); }
        catch { failures++; app.log.error({folder},'Project file cleanup failed'); }
      }
      for(const id of removed.artifactIds) await artifactLocks.run(id,async()=>{
        const folder=artifactFolder(directory,id);
        try { await fs.rm(folder,{recursive:true,force:true}); }
        catch { failures++; app.log.error({folder},'Project artifact cleanup failed'); }
      });
      return failures;
    }),
    agent = new Agent(tools,directory,options.piAgentDir||process.env.RANDL_PI_AGENT_DIR),
    cache = new Cache(),
    selections = new ChartSelections(),
    posters = new VideoPosters(directory);
  const assets = options.frontend ? resolve(options.frontend) : resolve(root, 'frontend/dist');
  const metrics = new ServerMetrics(),
    requestStarts = new WeakMap<object, number>(),
    socketTotals = new WeakMap<object, { read: number; written: number }>();
  db.observe = (ms, queue, failed) => metrics.databaseCall(ms, queue, failed);
  // Registered before authentication so refused requests are measured too.
  app.addHook('onRequest', async (req) => {
    requestStarts.set(req, performance.now());
  });
  app.addHook('onResponse', async (req, reply) => {
    const group = routeGroup(req.url),
      started = requestStarts.get(req);
    if (!group || started === undefined) return;
    // Socket byte counters include headers; the difference since the previous
    // response on this keep-alive connection belongs to this request.
    const socket = req.raw.socket,
      previous = socketTotals.get(socket) || { read: 0, written: 0 },
      current = { read: socket.bytesRead, written: socket.bytesWritten };
    socketTotals.set(socket, current);
    metrics.request(
      group,
      performance.now() - started,
      reply.statusCode,
      current.read - previous.read,
      current.written - previous.written,
    );
  });
  let hosting;
  try {
    hosting = await configureAuth(app, db, options);
  } catch (error) {
    live.close();
    await db.close();
    throw error;
  }
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) return;
    const route = req.routeOptions.url || '';
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      /^\/api\/(views|plugins|artifacts)/.test(route)
    )
      live.changedWorkspace();
  });
  let staleCheckPending = false;
  const staleTimer = setInterval(async () => {
    if (staleCheckPending) return;
    staleCheckPending = true;
    try {
      for (const id of await db.call('staleRuns', Date.now() / 1000, runTimeout)) live.changedRun(id);
      // Check for idle work after staleRuns completes. Two timers at the same interval
      // would always see the preceding staleRuns call in the queue and skip maintenance.
      if (!db.pending.size) {
        const started = performance.now();
        // Yield back to the request queue between blocks. Spend at most 200 ms
        // admitting maintenance per tick; one indivisible block may finish later.
        let more: boolean;
        do {
          more = await db.call('storageMaintain', 50, 1);
        } while (more && !db.pending.size && performance.now() - started < 200);
      }
    } catch { /* The next interval retries after a busy worker. */ }
    finally { staleCheckPending = false; }
  }, 10000);
  staleTimer.unref();
  app.addHook('preClose', async () => { clearInterval(staleTimer); live.close(); });
  app.get('/api/runs/trash', async (req) => ({
    runs: await db.call('deletedRuns', String((req.query as any).project || '')),
  }));
  app.post(
    '/api/run-values',
    {
      schema: {
        body: object(
          {
            runs: { type: 'array', items: str, maxItems: 10000 },
            fields: { type: 'array', items: str, maxItems: 64 },
          },
          ['runs', 'fields'],
        ),
      },
    },
    async (req) => ({
      runs: await db.call('runValues', (req.body as any).runs, (req.body as any).fields),
    }),
  );
  app.get('/api/run-fields', async (req) => ({
    fields: await db.call('runFields', String((req.query as any).project || '')),
  }));
  app.get('/api/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    live.add(reply.raw, () => hosting.authenticated(req));
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
    return payload;
  });
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (req.headers['content-encoding'] !== 'gzip') return payload;
    const stream = createGunzip() as ReturnType<typeof createGunzip> & {
      receivedEncodedLength: number;
    };
    stream.receivedEncodedLength = 0;
    payload.on('data', (chunk: Buffer) => {
      stream.receivedEncodedLength += chunk.length;
    });
    return payload.pipe(stream);
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );
  app.setErrorHandler((error, req, reply) => {
    let e = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: { keyword: string; instancePath: string }[];
    };
    const selection = e.validation?.find(
      (item) =>
        ['maxItems', 'uniqueItems'].includes(item.keyword) &&
        /\/(visible|solo)$/.test(item.instancePath),
    );
    const group = e.validation?.find(
      (item) => item.keyword === 'pattern' && /\/(runQuery\/group|groupBy)$/.test(item.instancePath),
    );
    if (group) {
      const field = group.instancePath
        .replace(/^\/body\//, '')
        .replace(/\/(\d+)/g, '[$1]')
        .replaceAll('/', '.');
      e = Object.assign(
        Error(`${field} ${field.endsWith('runQuery.group') ? runGroupRule : chartGroupRule}.`),
        { statusCode: 400 },
      );
    }
    if (selection) {
      let parent: any = req.body;
      for (const key of selection.instancePath.split('/').slice(1, -1)) parent = parent?.[key];
      e = selectionError(parent) || e;
    }
    const fields = errorFields(e);
    reply.code(fields.statusCode || 400).send({
      error: fields.message,
      ...(fields.code ? { code: fields.code, params: fields.params } : {}),
    });
  });
  app.get(
    '/api/server/metrics',
    { schema: { querystring: object({ since: { type: 'string', pattern: '^[0-9]{1,15}$' } }) } },
    async (req) => {
      const since = Number((req.query as any).since || 0),
        size = (path: string) => fs.stat(path).then((stat) => stat.size, () => 0),
        database = join(directory, 'randl.sqlite3'),
        memory = process.memoryUsage();
      return {
        now: Date.now(),
        bucketMs: BUCKET_MS,
        buckets: metrics.buckets(since),
        process: {
          started: metrics.started,
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          databaseQueue: db.pending.size,
        },
        storage: {
          database: await size(database),
          wal: await size(database + '-wal'),
          ...(await db.call('storageTotals')),
        },
      };
    },
  );
  app.get('/api/health', async () => ({
    ok: true,
    engine: 'node-fastify-sqlite-worker',
    cacheBytes: cache.size,
  }));
  app.get('/api/runs', async () => ({ runs: await db.call('runs') }));
  app.post(
    '/api/runs/query',
    {
      schema: {
        body: object(
          {
            mode: str,
            filters: {
              type: 'array',
              maxItems: 20,
              items: object({ field: str, operator: str, value: str }, [
                'field',
                'operator',
                'value',
              ]),
            },
          },
          ['filters'],
        ),
      },
    },
    async (req) => ({ ids: await db.call('queryRuns', req.body) }),
  );
  app.get('/api/run',{schema:{querystring:object({id:str},['id'])}},async req=>tools.execute('run_get',{id:(req.query as any).id}));
  app.patch(
    '/api/run',
    {
      schema: {
        body: object(
          {
            id: str,
            displayName: str,
            notes: str,
            tags: { type: 'array', items: str, maxItems: 100 },
          },
          ['id'],
        ),
      },
    },
    async (req) => {
      const a = req.body as any,
        r = await db.call('run', a.id);
      if (!r) throw managementError('RUN_NOT_FOUND', 'Run not found');
      const result = await db.call('runEdit', a);
      live.changedRun(a.id);
      return result;
    },
  );
  app.post('/api/metrics', { schema: { body: object({ runs: ids }, ['runs']) } }, async (req) => ({
    metrics: await db.call('keys', (req.body as any).runs),
    kinds: await db.call('metricTypes', (req.body as any).runs),
    definitions:await db.call('metricSettings',(req.body as any).runs),
  }));
  app.post(
    '/api/media',
    {
      schema: {
        body: object(
          {
            runs: { ...ids, maxItems: panelLimits.chartRuns },
            metric: str,
            across: { type: 'string', enum: ['runs', 'steps'] },
            step: { type: ['number', 'null'] },
            run: str,
            files: { type: 'integer', minimum: 1, maximum: panelLimits.media.files.max },
          },
          ['runs', 'metric'],
        ),
      },
    },
    async (req) => {
      const media = await db.call('media', req.body);
      await sizeVideos(media.entries);
      return media;
    },
  );
  // Video descriptors without a logged size get the file's size from its header (video-size.ts),
  // so tiles have their shape before any frame loads.
  async function sizeVideos(entries: { run: string; value: any }[]) {
    const unsized = entries.flatMap(({ run, value }) =>
      (value?._type === 'videos' && Array.isArray(value.videos)
        ? value.videos
        : value?._type === 'video-file'
          ? [value]
          : []
      ).flatMap((file: any) =>
        file && typeof file.path === 'string' && !(file.width > 0 && file.height > 0)
          ? [{ run, file }]
          : [],
      ),
    );
    for (let start = 0; start < unsized.length; start += 16)
      await Promise.all(
        unsized.slice(start, start + 16).map(async ({ run, file }) => {
          const folder = runFolder(directory, run),
            path = resolve(folder, file.path);
          if (!contained(folder, path)) return;
          const size = await videoSize(path).catch(() => undefined);
          if (size) Object.assign(file, size);
        }),
      );
  }
  // Grouped panels register their run selection once and name it in every chart request.
  app.post(
    '/api/chart-selections',
    {
      schema: {
        body: object(
          { runs: { ...ids, minItems: 1, maxItems: selectionLimits.maxSelectedRuns } },
          ['runs'],
        ),
      },
    },
    async (req) => ({ selection: selections.put((req.body as any).runs) }),
  );
  app.post(
    '/api/chart',
    {
      schema: {
        body: object(
          {
            // Grouped charts aggregate up to the selection limit; others plot up to chartRuns.
            runs: { ...ids, maxItems: selectionLimits.maxSelectedRuns },
            selection: str,
            metrics: { type: 'array', items: str, minItems: 1, maxItems: panelLimits.maxMetrics },
            pixels: { type: 'integer', minimum: 16, maximum: panelLimits.chartPixels },
            mode: { type: 'string', enum: ['history', 'snapshot'] },
            baseRevision: str,
            baseVersions: {
              type: 'array',
              items: { type: ['integer', 'null'] },
              maxItems: panelLimits.chartRuns,
            },
            baseWidth: { type: ['number', 'null'] },
            settings: settingsSchema,
            recordTransform:{oneOf:[
              object(
                {
                  kind: { type: 'string', enum: ['compute'] },
                  expressions: {
                    type: 'array',
                    minItems: 1,
                    maxItems: panelLimits.maxMetrics,
                    items: object({ name: str, expression: str }, ['name', 'expression']),
                  },
                  align: { type: 'string', enum: ['none', 'percent'] },
                },
                ['kind', 'expressions'],
              ),
              object({kind:{type:'string',enum:['align']},normalization:{type:'string',enum:['none','percent']}},['kind','normalization'])
            ]},
          },
          ['metrics'],
        ),
      },
    },
    async (req, reply) => {
      const { baseRevision, baseVersions, baseWidth, ...body } = req.body as any;
      const grouped = !!body.settings?.groupBy && body.settings.groupBy !== 'none';
      if ((body.runs === undefined) === (body.selection === undefined))
        throw Object.assign(Error('Send either runs or a selection.'), { statusCode: 400 });
      const runIds: string[] = body.runs ?? selections.get(body.selection);
      if (!runIds)
        throw Object.assign(Error('The chart selection is no longer registered.'), {
          statusCode: 409,
          code: 'CHART_SELECTION_UNKNOWN',
        });
      if (!grouped && runIds.length > panelLimits.chartRuns)
        throw Object.assign(
          Error(`Ungrouped charts compare at most ${panelLimits.chartRuns} runs.`),
          { statusCode: 400 },
        );
      const runs = await db.call('runRevisions', runIds),
        versions = new Map(runs.map((r: any) => [r.id, r.revision]));
      const key = createHash('sha256')
        .update(JSON.stringify([body, runIds.map((id: string) => versions.get(id))]))
        .digest('hex');
      body.runs = runIds;
      delete body.selection;
      if (key === baseRevision) return { unchanged: true, revision: key };
      // The client's copy is either a cached response (diffed point by point) or, when the
      // server no longer holds it, this request's earlier revisions: series of runs whose
      // revision has not changed are then omitted.
      const cached = baseRevision ? cache.get(baseRevision) : undefined,
        previous = cached && clipChart(JSON.parse(cached.toString()), body.settings),
        base: Map<string, Series> | undefined =
          previous && new Map(previous.series.map((s: Series) => [s.id, s])),
        earlier =
          !base &&
          !grouped &&
          Array.isArray(baseVersions) &&
          baseVersions.length === body.runs.length
            ? new Map<string, number>(
                body.runs.map((id: string, i: number) => [id, baseVersions[i]]),
              )
            : undefined;
      const change = (series: Series, width: number | null | undefined) => {
        if (earlier && (width ?? null) === (baseWidth ?? null)) {
          if (earlier.get(series.id) === versions.get(series.id)) return null;
          return { replace: series };
        }
        const patch = diffSeries(base?.get(series.id), series);
        return patch &&
          !('replace' in patch) &&
          JSON.stringify(patch).length > JSON.stringify(series).length
          ? { replace: series }
          : patch;
      };
      const known = base || (earlier && new Map([...earlier.keys()].map((id) => [id, null]))),
        removed = (ids: Set<string>) => [...(known?.keys() || [])].filter((id) => !ids.has(id));
      // Long charts run as worker jobs, which stop when their request is abandoned.
      const abandoned = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) abandoned.abort();
      });
      let result = cache.get(key);
      if (
        result ||
        grouped ||
        body.mode === 'snapshot' ||
        (body.recordTransform && !streamedTransform(body)) ||
        !String(req.headers.accept).includes('application/x-ndjson')
      ) {
        if (!result) {
          const start = performance.now(),
            data = await db.job(abandoned.signal, 'chartJob', body);
          data.queryMs = performance.now() - start;
          data.revision = key;
          result = Buffer.from(JSON.stringify(data));
          cache.put(key, result);
        }
        if (!known) return reply.type('application/json').send(result);
        const next = JSON.parse(result.toString()),
          { series, ...metadata } = next,
          delta = Buffer.from(
            JSON.stringify(
              previous
                ? chartDiff(previous, next)
                : {
                    delta: true,
                    metadata,
                    changed: series
                      .map((s: Series) => change(s, metadata.bucketWidth))
                      .filter(Boolean),
                    removed: removed(new Set(series.map((s: Series) => s.id))),
                  },
            ),
          );
        return reply
          .type('application/json')
          .send(delta.length < result.length * 0.9 ? delta : result);
      }
      // Series are computed and sent in chunks so panels can draw runs as they arrive.
      const start = performance.now(),
        plan = await db.job(abandoned.signal, 'chartPlan', body),
        { result: metadata } = plan;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const emit = (value: unknown) => {
        if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(value) + '\n');
      };
      try {
        // The run order is sent only when it differs from the request's.
        emit({
          metadata,
          ...(JSON.stringify(plan.ids) === JSON.stringify(body.runs) ? {} : { order: plan.ids }),
        });
        const all: Series[] = [];
        for (
          let i = 0, size = chartChunks.first;
          i < plan.ids.length;
          i += size, size = Math.min(chartChunks.largest, size * 2)
        ) {
          const ids: string[] = plan.ids.slice(i, i + size),
            pick = (values: Record<string, unknown>) =>
              Object.fromEntries(ids.map((id) => [id, values[id]]));
          const series: Series[] = await db.job(
            abandoned.signal,
            'chartSeries',
            {
              metrics: plan.metrics,
              settings: plan.settings,
              width: plan.width,
              names: pick(plan.names),
              revisions: pick(plan.revisions),
              counts: pick(plan.counts),
              ...(plan.recordTransform ? { recordTransform: plan.recordTransform } : {}),
            },
            ids,
          );
          all.push(...series);
          const changed = series.map((s) =>
            known ? change(s, metadata.bucketWidth) : { replace: s },
          );
          emit({ changed: changed.filter(Boolean) });
        }
        const data = {
          ...metadata,
          sampled: chartSampled(plan, all),
          series: all,
          queryMs: performance.now() - start,
          revision: key,
        };
        cache.put(key, Buffer.from(JSON.stringify(data)));
        emit({
          done: true,
          sampled: data.sampled,
          revision: key,
          removed: removed(new Set(plan.ids)),
        });
      } catch (error) {
        const fields = errorFields(error as Error);
        emit({
          error: fields.message,
          ...(fields.code ? { code: fields.code, params: fields.params } : {}),
        });
      } finally {
        reply.raw.end();
      }
    },
  );
  app.get(
    '/api/run-logs',
    { schema: { querystring: object({ run: str }, ['run']) } },
    async (req) => ({ lines: await db.call('logs', (req.query as any).run) }),
  );
  app.get(
    '/api/run-export',
    { schema: { querystring: object({ run: str, file: str, format: str }, ['run']) } },
    async (req, reply) => {
      const a = req.query as any,
        file = a.file || 'wandb-history.jsonl';
      if (!['wandb-history.jsonl', 'wandb-events.jsonl', 'output.log'].includes(file))
        throw Error('Unsupported export');
      const csv = a.format === 'csv' && file !== 'output.log';
      const keys = csv
        ? ['_step', '_timestamp', '_runtime', ...(await db.call('keys', [a.run]))]
        : [];
      const cell = (value: any) =>
        '"' +
        String(
          value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value,
        ).replaceAll('"', '""') +
        '"';
      const end = await db.call('streamCount', a.run, file);
      async function* rows() {
        if (csv) yield keys.map(cell).join(',') + '\n';
        let cursor = -1;
        while (cursor < end - 1) {
          const page = await db.call('exportHistory', a.run, file, cursor);
          if (!page.length) break;
          for (const row of page) {
            if (row.offset >= end) return;
            const value = csv ? JSON.parse(row.content) : null;
            yield (csv
              ? keys
                  .map((key: string) =>
                    cell(
                      file === 'wandb-events.jsonl' && key.startsWith('system/')
                        ? (value['system.' + key.slice(7)] ?? value[key.slice(7)])
                        : value[key],
                    ),
                  )
                  .join(',')
              : row.content) + '\n';
            cursor = row.offset;
          }
        }
      }
      return reply
        .type(csv ? 'text/csv' : file === 'output.log' ? 'text/plain' : 'application/x-ndjson')
        .header('Content-Disposition', `attachment; filename="${file}${csv ? '.csv' : ''}"`)
        .send(Readable.from(rows()));
    },
  );
  // Files are sent whole or as one requested byte range, so players seek and stream large
  // videos without downloading them first. A stale `If-Range` validator gets the whole file.
  function sendFile(
    req: FastifyRequest,
    reply: FastifyReply,
    path: string,
    size: number,
    etag?: string,
  ) {
    reply.header('Accept-Ranges', 'bytes');
    const condition = req.headers['if-range'],
      range = !condition || condition === etag ? byteRange(req.headers.range, size) : undefined;
    if (range === null)
      return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    if (!range) return reply.header('Content-Length', size).send(createReadStream(path));
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .header('Content-Length', range.end - range.start + 1)
      .send(createReadStream(path, range));
  }
  app.get(
    '/api/run-files',
    { schema: { querystring: object({ run: str, path: str }, ['run']) } },
    async (req, reply) => {
      const args = req.query as any,
        folder = join(directory, 'files', createHash('sha256').update(args.run).digest('hex'));
      if (args.path) {
        const file = resolve(folder, args.path);
        if (!contained(folder, file)) throw Error('Invalid file path');
        reply
          .type('application/octet-stream')
          .header(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(args.path.split('/').at(-1))}`,
          );
        return sendFile(req, reply, file, (await fs.stat(file)).size);
      }
      const files: any[] = [];
      const walk = async (path: string, prefix = '') => {
        for (const entry of await fs.readdir(path, { withFileTypes: true })) {
          const name = prefix + entry.name;
          if (entry.isDirectory()) await walk(join(path, entry.name), name + '/');
          else if (entry.isFile()) {
            const stat = await fs.stat(join(path, entry.name));
            files.push({ name, size: stat.size, updated: stat.mtime.toISOString() });
          }
        }
      };
      try {
        await walk(folder);
      } catch (e) {
        if ((e as any).code !== 'ENOENT') throw e;
      }
      return { files };
    },
  );
  app.get(
    '/api/run-file-preview',
    { schema: { querystring: object({ run: str, path: str, digest: str }, ['run', 'path']) } },
    async (req, reply) => {
      const a = req.query as any,
        folder = join(directory, 'files', createHash('sha256').update(a.run).digest('hex')),
        path = resolve(folder, a.path);
      if (!contained(folder, path)) throw Error('Invalid file path');
      const types: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
      };
      const type = types[extname(path).toLowerCase()];
      if (!type && !path.endsWith('.table.json'))
        throw Error('This file type has no inline preview');
      // Media panels recreate their elements when they scroll back into view. A URL
      // with the logged digest names fixed content; others are revalidated.
      const stat = await fs.stat(path),
        etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      reply
        .header(
          'Cache-Control',
          a.digest ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        )
        .header('ETag', etag);
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      if (type) return sendFile(req, reply.type(type), path, stat.size, etag);
      if (stat.size > 8 * 1024 * 1024)
        throw Error('Table preview exceeds 8 MiB; download it from Files');
      const data = JSON.parse(await fs.readFile(path, 'utf8'));
      return {
        columns: data.columns,
        data: data.data.slice(0, 200),
        truncated: data.data.length > 200,
      };
    },
  );
  // A video's first frame as a JPEG image, for tiles that are not playing (video-poster.ts).
  app.get(
    '/api/run-file-poster',
    { schema: { querystring: object({ run: str, path: str, digest: str }, ['run', 'path']) } },
    async (req, reply) => {
      const a = req.query as any,
        folder = join(directory, 'files', createHash('sha256').update(a.run).digest('hex')),
        path = resolve(folder, a.path);
      if (!contained(folder, path)) throw Error('Invalid file path');
      if (!posterTypes.has(extname(path).toLowerCase())) throw Error('This file type has no poster');
      if (!(await posters.enabled()))
        return reply
          .code(501)
          .send({ error: 'Video posters need ffmpeg on the server', code: 'poster_unavailable' });
      const stat = await fs.stat(path),
        etag = `"p${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      reply
        .header(
          'Cache-Control',
          a.digest ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        )
        .header('ETag', etag);
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.type('image/jpeg').send(await posters.poster(path, stat.size, stat.mtimeMs));
    },
  );
  app.get('/api/artifacts', async () => ({ artifacts: await db.call('artifact', 'list', {}) }));
  app.get('/api/artifacts/:id', async (req) =>
    db.call('artifact', 'detail', { id: (req.params as any).id }),
  );
  app.delete('/api/artifacts/:id/aliases/:alias', async (req) => {
    const result = await db.call('artifact', 'remove-alias', req.params);
    live.changedWorkspace();
    return result;
  });
  app.get(
    '/api/run-artifacts',
    { schema: { querystring: object({ run: str }, ['run']) } },
    async (req) => db.call('artifact', 'relations', { run: (req.query as any).run }),
  );
  app.post(
    '/api/artifacts',
    {
      schema: {
        body: object({ entity: str, project: str, name: str, type: str, description: str }, [
          'entity',
          'project',
          'name',
          'type',
        ]),
      },
    },
    async (req) => {
      const a = req.body as any;
      return db.call('artifact', 'create', {
        entityName: a.entity,
        projectName: a.project,
        artifactCollectionName: a.name,
        artifactTypeName: a.type,
        description: a.description,
        aliases: ['latest'],
      });
    },
  );
  app.post(
    '/api/artifacts/:id/aliases',
    {
      schema: {
        body: object({ aliases: { type: 'array', items: str, maxItems: 100 } }, ['aliases']),
      },
    },
    async (req) =>
      db.call('artifact', 'alias', {
        id: (req.params as any).id,
        aliases: (req.body as any).aliases,
      }),
  );
  app.post('/api/artifacts/:id/commit', async (req) => {
    const id = (req.params as any).id;
    return artifactLocks.run(id, async () => {
      const artifact = await db.call('artifact', 'get', { id });
      if (!artifact) throw managementError('ARTIFACT_NOT_FOUND', 'Artifact not found');
      if (artifact.state === 'COMMITTED') return artifact;
      const files = await db.call('artifact', 'files', { id });
      const contents = Object.fromEntries(
        files.map((f: any) => [f.name, { digest: f.digest, size: f.size }]),
      );
      const manifest = {
        version: 1,
        storagePolicy: 'wandb-storage-policy-v1',
        storagePolicyConfig: { storageLayout: 'V2' },
        contents,
      };
      const hash = createHash('md5');
      hash.update('wandb-artifact-manifest-v1\n');
      for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name)))
        hash.update(f.name + ':' + f.digest + '\n');
      const digest = hash.digest('hex');
      await fs.mkdir(artifactFolder(directory, id), { recursive: true });
      await fs.writeFile(
        join(artifactFolder(directory, id), 'manifest.json'),
        JSON.stringify(manifest),
      );
      await db.call('artifact', 'manifest', { id, logicalDigest: digest });
      await db.call('artifact', 'commit', {
        id,
        size: files.reduce((n: number, f: any) => n + f.size, 0),
        count: files.length,
      });
      return db.call('artifact', 'get', { id });
    });
  });
  app.get('/storage/artifacts/:id/manifest', async (req, reply) =>
    reply
      .type('application/json')
      .send(
        createReadStream(join(artifactFolder(directory, (req.params as any).id), 'manifest.json')),
      ),
  );
  app.get('/storage/artifacts/:id/files/:name', async (req, reply) => {
    const p = req.params as any;
    return reply
      .type('application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(p.name.split('/').at(-1))}`,
      )
      .send(createReadStream(artifactFile(directory, p.id, p.name)));
  });
  app.get('/api/projects', async () => ({ projects: await db.call('projects') }));
  app.get('/api/views', async () => ({ views: await db.call('views') }));
  app.get('/api/views/:id', async (req) => {
    const id = (req.params as any).id,
      view = await db.call('view', id);
    if (!view) throw managementError('VIEW_NOT_FOUND', 'View not found', { view: id }, 404);
    return view;
  });
  app.put(
    '/api/views/:id',
    {
      schema: {
        body: object(
          {
            name: str,
            project: str,
            body: viewBodySchema,
            version: { type: 'integer', minimum: 1 },
          },
          ['name', 'project', 'body', 'version'],
        ),
      },
    },
    async (req) => tools.execute('view_save', { ...(req.body as any), id: (req.params as any).id }),
  );
  app.delete('/api/views/:id', async (req) =>
    tools.execute('view_delete', { id: (req.params as any).id }),
  );
  app.get('/api/tools', async () => ({ tools: toolCatalog }));
  for (const tool of toolCatalog)
    app.post('/api/tools/' + tool.name, { schema: { body: tool.parameters } }, async (req) =>
      tools.execute(tool.name, req.body as any),
    );
  app.get('/api/plugins', async () => ({ plugins: await plugins.list() }));
  app.post(
    '/api/plugins/install',
    { schema: { body: object({ source: str }, ['source']) } },
    async (req) => plugins.install((req.body as any).source),
  );
  app.post('/api/plugins/:id/:action', async (req) => {
    const p = req.params as any;
    return plugins.change(p.id, p.action);
  });
  app.get('/api/plugins/:id/revisions/:revision/source/*', async (req, reply) => {
    const p = req.params as any,
      plugin = (await plugins.list()).find(
        (p2) => p2.id === p.id && p2.revision === p.revision && !p2.builtin && p2.enabled,
      );
    if (!plugin) return reply.code(404).send({ error: 'Plugin is disabled or missing' });
    const folder = join(plugins.root, p.id),
      path = resolve(folder, p['*']);
    if (!contained(folder, path)) throw Error('Invalid source path');
    const real = await fs.realpath(path);
    if (!contained(folder, real)) throw Error('Invalid source path');
    return reply
      .type(
        extname(path) === '.js'
          ? 'application/javascript'
          : extname(path) === '.css'
            ? 'text/css'
            : extname(path) === '.json'
              ? 'application/json'
              : 'application/octet-stream',
      )
      .send(createReadStream(path));
  });
  app.get('/api/conversations',{schema:{querystring:object({search:str,offset:{type:'string',pattern:'^[0-9]+$'}})}},async req=>{
    const query=req.query as any;return {conversations:await db.call('chatList',{search:query.search||'',offset:Number(query.offset||0)})};
  });
  app.get('/api/conversations/:id',{schema:{querystring:object({before:{type:'string',pattern:'^[0-9]+$'},since:{type:'string',pattern:'^[0-9]+$'}})}},async req=>{
    const query=req.query as any;return db.call('chatGet',{id:(req.params as any).id,...(query.before===undefined?{}:{before:Number(query.before)}),...(query.since===undefined?{}:{since:Number(query.since)})});
  });
  app.patch('/api/conversations/:id',{schema:{body:object({title:{type:'string',minLength:1,maxLength:200}},['title'])}},async req=>db.call('chatRename',{id:(req.params as any).id,title:(req.body as any).title}));
  app.delete('/api/conversations/:id',async req=>agent.removeConversation((req.params as any).id));
  app.get('/api/agent/providers', async () => agent.providers());
  app.post(
    '/api/agent/credential',
    {
      schema: {
        body: object({ provider: str, key: { type: 'string', minLength: 1, maxLength: 4096 } }, [
          'provider',
          'key',
        ]),
      },
    },
    async (req) => {
      const { provider, key } = req.body as any;
      return agent.credential(provider, key);
    },
  );
  app.delete('/api/agent/credential/:provider', async (req) =>
    agent.credential((req.params as any).provider),
  );
  app.post(
    '/api/agent/test',
    { schema: { body: object({ provider: str, id: str }, ['provider', 'id']) } },
    async (req) => {
      const { provider, id } = req.body as any;
      return agent.testConnection(provider, id);
    },
  );
  app.get('/api/agent/models', async () => agent.models());
  app.post(
    '/api/agent/model',
    { schema: { body: object({ provider: str, id: str }, ['provider', 'id']) } },
    async (req) => agent.select(req.body as any),
  );
  app.get('/api/agent/status', async () => ({
    busy: agent.busy,
    conversation:agent.activeId||null,
  }));
  app.post(
    '/api/agent/chat',
    {
      schema: {
        body: object(
          {
            session: { type: 'string', pattern: '^[a-zA-Z0-9-]{1,64}$' },
            message: { type: 'string', minLength: 1, maxLength: 12000 },
            project:str,view:str,replaceTurn:str,retryTurn:str,
          },
          ['session', 'message'],
        ),
      },
    },
    async (req, reply) => {
      if (agent.busy) return reply.code(409).send({ error: 'Agent is busy' });
      const body = req.body as any;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const emit = (event: any) => {
        if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(event) + '\n');
      };
      const cancel = () => {
        if (!reply.raw.writableEnded) void agent.cancel(body.session);
      };
      reply.raw.on('close', cancel);
      try {
        await agent.chat(body.session, body.message, emit,{project:body.project,view:body.view,replaceTurn:body.replaceTurn,retryTurn:body.retryTurn});
      } catch (error) {
        const details = errorFields(error as Error);
        emit({ type: 'error', text: details.message, code: details.code, params: details.params });
      } finally {
        reply.raw.off('close', cancel);
        reply.raw.end();
      }
    },
  );
  app.post('/api/agent/confirm',{schema:{body:object({session:str,call:str,token:str,decision:{type:'string',enum:['confirm','decline']},name:str,reason:{type:'string',enum:['cli-not-allowed']}},['session','call','token','decision'])}},async(req)=>agent.confirmations.decide(req.body as any));
  app.post(
    '/api/agent/cancel',
    { schema: { body: object({ session: str }, ['session']) } },
    async (req) => agent.cancel((req.body as any).session),
  );
  app.post('/graphql', async (req) => {
    try {
      const origin =
        hosting.publicUrl ||
        `http://127.0.0.1:${(app.server.address() as any)?.port || options.port || 8742}`;
      const body = req.body as any;
      const artifactID = body.variables?.artifactID || body.variables?.input?.artifactID;
      const query = () => artifactQuery(db, body, origin, directory, hosting.signUrl);
      const artifactIDs = [
        artifactID,
        ...(body.variables?.input?.artifactFiles || []).map((file: any) => file.artifactID),
      ].filter((id: any) => typeof id === 'string');
      const result = artifactIDs.length
        ? await artifactLocks.runMany(artifactIDs, query)
        : await query();
      const data =
        result === undefined ? await sdkQuery(db, req.body, origin, hosting.signUrl, entity) : result;
      if (data?.upsertBucket?.bucket?.id) live.changedRun(data.upsertBucket.bucket.id);
      if(data?.notifyScriptableRunAlert?.success){const v=body.variables;live.changedRun([v.entityName||v.entity,v.projectName||v.project,v.runName||v.name].join('/'));}
      if (result !== undefined && /\bmutation\b/.test(body.query || '')) live.changedWorkspace();
      return { data };
    } catch (error) {
      const details=errorFields(error as Error);
      return {errors:[{message:details.message,...(details.code?{extensions:{code:details.code,params:details.params}}:{})}]};
    }
  });
  app.post('/files/:entity/:project/:run/file_stream', async (req) => {
    const p = req.params as any;
    const id = `${p.entity}/${p.project}/${p.run}`;
    const result = await db.call('ingest', id, req.body);
    live.changedRun(id);
    return result;
  });
  await app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser('*', (_req, body, done) => done(null, body));
    upload.put('/upload/:entity/:project/:run/*', async (req,reply) => {
      const p = req.params as any,
        id = `${p.entity}/${p.project}/${p.run}`;
      const uploadingRun=await db.call('run',id);
      if(!uploadingRun)throw Error('Unknown run');
      const folder = join(directory, 'files', createHash('sha256').update(id).digest('hex')),
        path = resolve(folder, p['*']);
      if (!contained(folder, path)) throw Error('Invalid upload path');
      const previous = await fs.stat(path).then((stat) => stat.size, () => 0);
      let size: number | undefined;
      try {
        size = (await writeUpload(path, req.body as Readable)).size;
      } catch (error) {
        // Project deletion may remove the run folder while the body is streaming.
        if (await db.call('run', id)) throw error;
      }
      if (size === undefined || !(await db.call('runFileWritten', id, size - previous))) {
        await fs.rm(path, { force: true });
        for (let parent = dirname(path); parent.startsWith(folder); parent = dirname(parent))
          if (!(await fs.rmdir(parent).then(() => true, () => false))) break;
        return reply.code(404).send({ error: 'Run not found', code: 'RUN_NOT_FOUND' });
      }
      if(p['*']==='wandb-metadata.json'&&size<=1024*1024){
        let metadata;try{metadata=JSON.parse(await fs.readFile(path,'utf8'));}catch{/* Keep malformed uploaded bytes available as a file. */}
        if(metadata)await db.call('runMetadata',id,metadata);
      }
      live.changedRun(id);
      return {};
    });
    upload.put('/storage/artifacts/:id/manifest', async (req) => {
      const id = (req.params as any).id;
      return artifactLocks.run(id, async () => {
        const folder = artifactFolder(directory, id);
        const artifact = await db.call('artifact', 'get', { id });
        if (!artifact || artifact.state !== 'PENDING') throw Error('Artifact is not pending');
        await writeUpload(join(folder, 'manifest.json'), req.body as Readable, 32 * 1024 * 1024);
        return {};
      });
    });
    upload.put('/storage/artifacts/:id/files/:name', async (req) => {
      const p = req.params as any;
      return artifactLocks.run(p.id, async () => {
        const artifact = await db.call('artifact', 'get', { id: p.id });
        if (!artifact || artifact.state !== 'PENDING') throw Error('Artifact is not pending');
        const file = artifactFile(directory, p.id, p.name),
          result = await writeUpload(file, req.body as Readable);
        try { await db.call('artifact', 'file', { id: p.id, name: p.name, ...result }); }
        catch(error) { await fs.rm(file,{force:true}); throw error; }
        return {};
      });
    });
    upload.post('/sdk/otel/*', async (_req, reply) => reply.code(204).send());
  });
  app.get('/*', async (req, reply) => {
    const route = req.url.split('?')[0];
    if (route.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    let path = resolve(assets, '.' + decodeURIComponent(route));
    if (!contained(assets, path)) path = join(assets, 'index.html');
    try {
      if (!(await fs.stat(path)).isFile()) path = join(assets, 'index.html');
    } catch {
      if (extname(route)) return reply.code(404).send({ error: 'Asset not found' });
      path = join(assets, 'index.html');
    }
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    if (route.startsWith('/assets/') || route.startsWith('/fonts/')) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
    reply.type(types[extname(path)] || 'application/octet-stream');
    if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
      try {
        await fs.access(path + '.gz');
        return reply
          .header('Content-Encoding', 'gzip')
          .header('Vary', 'Accept-Encoding')
          .send(createReadStream(path + '.gz'));
      } catch {
        /* Serve the uncompressed representation when none was built. */
      }
    }
    return reply.send(createReadStream(path));
  });
  app.addHook('onClose', async () => {
    agent.close();
    await db.close();
  });
  await app.ready();
  return { app, db, tools, plugins, agent, live };
}
