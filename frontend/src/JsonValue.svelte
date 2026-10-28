<script lang="ts">
  import JsonValue from './JsonValue.svelte';
  import { t, number, type MessageKey } from './i18n';
  let { value, runId }: { value: any; runId?: string } = $props();
  const mediaNames: Record<string, MessageKey> = {
    'image-file': 'media.types.image',
    'images/separated': 'media.types.images',
    'audio-file': 'media.types.audio',
    'video-file': 'media.types.video',
    videos: 'media.types.videos',
    audio: 'media.types.audio',
    'table-file': 'media.types.table',
    histogram: 'media.types.histogram',
  };
</script>

{#if value === null}<code>null</code>
{:else if typeof value === 'object' && value?._type}
  <div class="metadata-media">
    <span>{$t(mediaNames[value._type] || 'media.types.generic')}</span>
    {#if value.path && runId}<a
        href={'/api/run-files?run=' +
          encodeURIComponent(runId) +
          '&path=' +
          encodeURIComponent(value.path)}
        download>{value.path}</a
      >{/if}
    {#if value.caption}<span>{value.caption}</span>{/if}
    {#if value.width && value.height}<span>{value.width} × {value.height}</span>{/if}
    <details>
      <summary>{$t('json.details')}</summary><JsonValue
        value={Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_type'))}
      />
    </details>
  </div>
{:else if typeof value === 'object'}
  <details class="metadata-tree">
    <summary
      >{$t(Array.isArray(value) ? 'json.items' : 'json.fields', {
        count: Object.keys(value).length,
      })}</summary
    >
    <dl>
      {#each Object.entries(value) as [key, child]}<div>
          <dt>{key}</dt>
          <dd><JsonValue value={child} {runId} /></dd>
        </div>{/each}
    </dl>
  </details>
{:else}<span class="metadata-scalar" title={String(value)}
    >{typeof value === 'number'
      ? $number(value, { maximumSignificantDigits: 15, useGrouping: false })
      : String(value)}</span
  >{/if}
