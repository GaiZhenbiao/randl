<script lang="ts">
  import { onMount } from 'svelte';
  import { Select, SelectItem } from 'carbon-components-svelte';
  import OverviewChart from './OverviewChart.svelte';
  import { minuteChart, shareBar, chartColors } from './overview-charts';
  import { t, number, duration, locale } from './i18n';
  import { api } from './api';
  import { formatBytes } from './ui';
  let { dark }: { dark: boolean } = $props();
  type Summary = {
    count: number;
    errors: number;
    clientErrors: number;
    requestBytes: number;
    responseBytes: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
  type Bucket = { t: number; groups: Record<string, Summary>; db: Summary & { maxQueue: number } };
  const groups = [
    ['sdk', 'server.group.sdk'],
    ['api', 'server.group.api'],
    ['agent', 'server.group.agent'],
    ['ui', 'server.group.ui'],
  ] as const;
  const WINDOW = 60;
  let buckets = $state<Bucket[]>([]),
    info = $state<any>(null),
    now = $state(Date.now()),
    error = $state(''),
    latencyGroup = $state('api');
  async function load() {
    const since = buckets.at(-1)?.t ?? 0;
    try {
      const next = await api('/api/server/metrics' + (since ? '?since=' + since : ''));
      // The newest bucket is still filling; replace it and append the rest.
      const kept = buckets.filter((bucket) => bucket.t < (next.buckets[0]?.t ?? Infinity));
      buckets = [...kept, ...next.buckets].slice(-180);
      info = next;
      now = next.now;
      error = '';
    } catch (reason) {
      error = (reason as Error).message;
    }
  }
  onMount(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    return () => clearInterval(timer);
  });
  let times = $derived.by(() => {
    const step = info?.bucketMs || 60_000,
      last = Math.floor(now / step) * step;
    return Array.from({ length: WINDOW }, (_, index) => last - (WINDOW - 1 - index) * step);
  });
  let byTime = $derived(new Map(buckets.map((bucket) => [bucket.t, bucket])));
  const total = (bucket: Bucket | undefined, field: keyof Summary) =>
    bucket ? groups.reduce((sum, [id]) => sum + Number(bucket.groups[id]?.[field] || 0), 0) : 0;
  let colors = $derived(chartColors(dark));
  let bytes = (value: number) => formatBytes(value, $number);
  let milliseconds = (value: number) =>
    value >= 1000 ? $number(value / 1000, { maximumFractionDigits: 1 }) + ' s' : $number(value, { maximumFractionDigits: value < 10 ? 1 : 0 }) + ' ms';
  let requests = $derived(
    minuteChart(
      times,
      groups.map(([id, label], index) => ({
        name: $t(label),
        color: colors.categorical[index],
        values: times.map((time) => byTime.get(time)?.groups[id]?.count ?? 0),
      })),
      dark,
      { stacked: true, format: (value) => $number(value), locale: $locale },
    ),
  );
  let latency = $derived(
    minuteChart(
      times,
      (['p50', 'p95', 'p99'] as const).map((field, index) => ({
        name: field,
        color: colors.categorical[index],
        dashed: field === 'p99',
        values: times.map((time) => byTime.get(time)?.groups[latencyGroup]?.[field] ?? null),
      })),
      dark,
      { format: milliseconds, locale: $locale },
    ),
  );
  let transfer = $derived(
    minuteChart(
      times,
      [
        { name: $t('server.received'), field: 'requestBytes' as const },
        { name: $t('server.sent'), field: 'responseBytes' as const },
      ].map((item, index) => ({
        name: item.name,
        color: colors.categorical[index + 1],
        values: times.map((time) => total(byTime.get(time), item.field)),
      })),
      dark,
      { format: bytes, locale: $locale },
    ),
  );
  let errors = $derived(
    minuteChart(
      times,
      [
        { name: $t('server.serverErrors'), field: 'errors' as const, color: '#da1e28' },
        { name: $t('server.clientErrors'), field: 'clientErrors' as const, color: '#ff832b' },
      ].map((item) => ({
        name: item.name,
        color: item.color,
        values: times.map((time) => {
          const bucket = byTime.get(time),
            count = total(bucket, 'count');
          return count ? (100 * total(bucket, item.field)) / count : null;
        }),
      })),
      dark,
      { format: (value) => $number(value, { maximumFractionDigits: 1 }) + '%', locale: $locale },
    ),
  );
  let hour = $derived(times.map((time) => byTime.get(time)));
  let hourRequests = $derived(hour.reduce((sum, bucket) => sum + total(bucket, 'count'), 0));
  let hourErrors = $derived(hour.reduce((sum, bucket) => sum + total(bucket, 'errors'), 0));
  let latestDatabase = $derived([...buckets].reverse().find((bucket) => bucket.db.count)?.db);
  let disk = $derived(
    info
      ? [
          { name: $t('server.databaseFile'), value: info.storage.database, color: colors.categorical[0] },
          { name: $t('server.wal'), value: info.storage.wal, color: colors.categorical[1] },
        ]
      : [],
  );
  let logical = $derived(
    info
      ? [
          { name: $t('projects.storage.history'), value: info.storage.history, color: colors.categorical[2] },
          { name: $t('projects.storage.files'), value: info.storage.files, color: colors.categorical[3] },
          { name: $t('projects.storage.artifacts'), value: info.storage.artifacts, color: colors.categorical[4] },
        ]
      : [],
  );
</script>

<section class="server-overview" aria-label={$t('server.title')}>
  {#if error}<p class="overview-note">{error}</p>{/if}
  {#if info}
    <dl class="overview-tiles">
      <div><dt>{$t('server.uptime')}</dt><dd>{$duration((now - info.process.started) / 1000)}</dd></div>
      <div><dt>{$t('server.requestsHour')}</dt><dd>{$number(hourRequests)}</dd></div>
      <div>
        <dt>{$t('server.errorsHour')}</dt>
        <dd>{$number(hourErrors)}</dd>
      </div>
      <div><dt>{$t('server.memory')}</dt><dd>{bytes(info.process.rss)}</dd></div>
      <div>
        <dt>{$t('server.databaseCalls')}</dt>
        <dd>
          {latestDatabase?.p95 != null ? 'p95 ' + milliseconds(latestDatabase.p95) : '—'}<span
            >{$t('server.queue', { count: $number(info.process.databaseQueue) })}</span
          >
        </dd>
      </div>
    </dl>
    <div class="overview-charts">
      <figure>
        <figcaption>{$t('server.requests')}</figcaption>
        <OverviewChart option={requests} label={$t('server.requests')} />
      </figure>
      <figure>
        <figcaption>
          {$t('server.latency')}
          <Select size="sm" inline hideLabel labelText={$t('server.latencyGroup')} bind:selected={latencyGroup}
            >{#each groups as [id, label]}<SelectItem value={id} text={$t(label)} />{/each}</Select
          >
        </figcaption>
        <OverviewChart option={latency} label={$t('server.latency')} />
      </figure>
      <figure>
        <figcaption>{$t('server.transfer')}</figcaption>
        <OverviewChart option={transfer} label={$t('server.transfer')} />
      </figure>
      <figure>
        <figcaption>{$t('server.errorRate')}</figcaption>
        <OverviewChart option={errors} label={$t('server.errorRate')} />
      </figure>
    </div>
    <div class="overview-storage">
      <div>
        <h3>{$t('server.disk')}<span>{bytes(info.storage.database + info.storage.wal)}</span></h3>
        <OverviewChart option={shareBar(disk, dark, bytes)} height={16} label={$t('server.disk')} />
        <ul class="overview-legend">
          {#each disk as part}<li><i style:background={part.color}></i>{part.name}<b>{bytes(part.value)}</b></li>{/each}
        </ul>
      </div>
      <div>
        <h3>
          {$t('server.logical')}<span
            >{bytes(info.storage.history + info.storage.files + info.storage.artifacts)}</span
          >
        </h3>
        <OverviewChart option={shareBar(logical, dark, bytes)} height={16} label={$t('server.logical')} />
        <ul class="overview-legend">
          {#each logical as part}<li><i style:background={part.color}></i>{part.name}<b>{bytes(part.value)}</b></li>{/each}
        </ul>
      </div>
    </div>
  {/if}
</section>
