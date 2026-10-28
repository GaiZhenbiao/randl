// Deterministic reader regression fixture; expected outputs were captured from format 1.
import { createHash } from 'node:crypto';
export function populate(store) {
  const ids = [];
  for (let r = 0; r < 4; r++) {
    const { id } = store.upsert({
      entity: 'golden',
      project: 'storage',
      name: 'run' + r,
      config: { group: r % 2 },
      summaryMetrics: { _step: 4000 },
    });
    ids.push(id);
    const rows = Array.from({ length: r === 0 ? 2100 : 37 }, (_, i) => ({
      _step: r === 2 ? i % 10 : i * 2,
      _timestamp: 1700000000 + i / 3,
      _runtime: i / 3,
      epoch: i % 11,
      a: i / 7 + r,
      b: (i % 5) + 1,
      ...(i % 13 === 0 ? { sparse: i } : {}),
      text: '你好',
      nullable: null,
      flag: true,
    }));
    if (r === 1) rows.push({ _step: 1, a: 5, b: 2, epoch: 0 });
    if (r === 3)
      rows.push({
        _step: 100,
        a: 2,
        b: 4,
        image: { _type: 'image-file', path: 'media/test.png' },
        text: 'x'.repeat(1048600),
      });
    store.ingest(id, {
      files: {
        'wandb-history.jsonl': { offset: 0, content: rows.map(JSON.stringify) },
        'wandb-events.jsonl': {
          offset: 0,
          content: Array.from({ length: 270 }, (_, i) =>
            JSON.stringify({
              _timestamp: 1700000000 + i / 7,
              'system.cpu': i / 3,
              'system.gpu': i / 5,
            }),
          ),
        },
        'output.log': { offset: 5, content: ['hello', '多字节', ''] },
        'wandb-summary.json': { offset: 0, content: ['{"_step":4000,"a":4}'] },
      },
      complete: true,
    });
    store.ingest(id, {
      files: {
        'wandb-events.jsonl': {
          offset: 1,
          content: ['{"_timestamp":1700000000.142857,"system.cpu":99}'],
        },
      },
      complete: true,
    });
  }
  store.db
    .prepare(
      'UPDATE runs SET created=1,started=1,updated=2,heartbeat=2,finished=2,runtime=1,runtime_at=2',
    )
    .run();
  return ids;
}
export function capture(store, ids) {
  store.derived.clear();
  store.derivedBytes = 0;
  const out = {};
  const clean = (v) =>
    JSON.parse(JSON.stringify(v, (k, v) => (['queryMs', 'revision'].includes(k) ? undefined : v)));
  const hash = (v) =>
    createHash('sha256')
      .update(JSON.stringify(clean(v)))
      .digest('hex');
  for (const axis of ['_step', '_timestamp', '_relative_wall', 'epoch'])
    for (const resolution of ['low', 'full'])
      for (const bounds of [{}, { xMin: 1, xMax: 12 }])
        for (const group of [{}, { groupBy: 'all', aggregation: 'mean', spread: 'stddev' }]) {
          const settings = { xAxis: axis, resolution, ...bounds, ...group };
          for (const transform of [
            null,
            { kind: 'compute', expressions: [{ name: 'ratio', expression: '${a} / ${b}' }] },
            { kind: 'align', normalization: 'none' },
          ]) {
            const request = {
              runs: ids,
              metrics: transform?.kind === 'compute' ? ['ratio'] : ['a', 'b'],
              pixels: 128,
              settings,
              ...(transform ? { recordTransform: transform } : {}),
            };
            out[JSON.stringify(request)] = hash(store.chart(request));
          }
        }
  out.system = clean(
    store.chart({
      runs: ids,
      metrics: ['system/cpu'],
      settings: { resolution: 'full', xAxis: '_relative_wall' },
    }),
  );
  out.snapshot = clean(
    store.chart({ runs: ids, metrics: ['a', 'config.group', 'summary.a'], mode: 'snapshot' }),
  );
  out.readers = ids.map((id) => {
    const lines = [];
    let cursor = -1;
    for (;;) {
      const page = store.exportHistory(id, undefined, cursor);
      if (!page.length) break;
      lines.push(...page);
      cursor = page.at(-1).offset;
    }
    return {
      keys: store.historyKeys(id),
      tail: hash(store.historyTail(id)),
      events: store.tail(id, 'wandb-events.jsonl'),
      count: store.streamCount(id, 'wandb-history.jsonl'),
      logs: store.logs(id),
      exportHash: createHash('sha256').update(JSON.stringify(lines)).digest('hex'),
      media: store.media({ runs: [id], metric: 'image' }),
      bytes: store.run(id).stream_bytes,
    };
  });
  out.keys = store.keys(ids);
  out.types = store.metricTypes(ids);
  out.settings = store.metricSettings(ids);
  out.storage = store.storageTotals();
  return clean(out);
}
