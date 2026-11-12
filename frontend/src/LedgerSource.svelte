<script lang="ts">
  // Where a ledger record came from: a document and its lines, with the quote on hover.
  import { t } from './i18n';
  import type { Source } from './lineage-graph';
  let { source }: { source: Source | null } = $props();
</script>

{#if source}<span class="ledger-source" title={source.quote ?? undefined}
    >{source.lines
      ? $t('ledger.source.lines', {
          document: source.document,
          first: source.lines[0],
          last: source.lines[1],
        })
      : $t('ledger.source.document', { document: source.document })}</span
  >{/if}
