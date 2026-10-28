<script lang="ts">
  import { t, number } from './i18n';
  import { formatBytes } from './ui';
  import type { ProjectDetails } from './types';
  let { details, id }: { details: ProjectDetails; id?: string } = $props();
  let counts = $derived(details.counts);
  let bytes = (value: number) => formatBytes(value, $number);
  let empty = $derived(!counts.runs && !counts.artifactVersions && !counts.views);
</script>

<div class="delete-summary" {id}>
  {#if empty}<p>{$t('projects.delete.empty')}</p>{:else}
    <p>{$t('projects.delete.intro')}</p>
    <dl>
      {#if counts.runs}<dt>{$t('projects.delete.runs')}</dt>
        <dd>
          {counts.deletedRuns
            ? $t('projects.delete.runsWithDeleted', {
                count: $number(counts.runs),
                deleted: $number(counts.deletedRuns),
              })
            : $number(counts.runs)}
        </dd>
        <dt>{$t('projects.storage.runData')}</dt>
        <dd>{bytes(details.storage.history + details.storage.files)}</dd>{/if}
      {#if counts.artifactVersions}<dt>{$t('projects.delete.artifactVersions')}</dt>
        <dd>
          {$t('projects.delete.artifactsDetail', {
            count: $number(counts.artifactVersions),
            collections: $number(details.artifactCollections),
            size: bytes(details.storage.artifacts),
          })}
        </dd>{/if}
      {#if details.crossProjectUsers}<dt>{$t('projects.delete.otherProjects')}</dt>
        <dd>{$t('projects.delete.otherProjectsDetail', { count: $number(details.crossProjectUsers) })}</dd>{/if}
      {#if counts.views}<dt>{$t('projects.delete.views')}</dt>
        <dd>{$number(counts.views)}</dd>{/if}
    </dl>
  {/if}
  <p>{$t('projects.delete.irreversible')}</p>
</div>

<style>
  .delete-summary {
    overflow-wrap: anywhere;
  }
  .delete-summary p {
    margin-bottom: 0.75rem;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(8rem, max-content) 1fr;
    gap: 0.25rem 1rem;
    margin-bottom: 0.75rem;
  }
  dt {
    color: var(--cds-text-secondary);
  }
  @media (max-width: 480px) {
    dl {
      grid-template-columns: 1fr;
      gap: 0;
    }
    dd {
      margin-bottom: 0.5rem;
    }
  }
</style>
