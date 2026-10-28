<script lang="ts">
  import { Button, DataTable, Search, OverflowMenu, OverflowMenuItem } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import ProjectDeleteModal from './ProjectDeleteModal.svelte';
  import { pageURL } from './routes';
  import { interceptLink, formatBytes } from './ui';
  import { t, number, date } from './i18n';
  import type { ProjectSummary } from './types';
  let {
    projects,
    onProject,
    onCreate,
    onArchive,
    onDeleted,
  }: {
    projects: ProjectSummary[];
    onProject: (id: string, page?: string) => void;
    onCreate: () => void;
    onArchive: (project: ProjectSummary, archived: boolean) => void;
    onDeleted: (result: any) => void;
  } = $props();
  let search = $state(''),
    archivedOpen = $state(false),
    deleting = $state(''),
    deleteOpen = $state(false);
  const matches = (p: ProjectSummary) => {
    const query = search.trim().toLocaleLowerCase();
    return !query || [p.name, p.id, p.description].some((text) => text.toLocaleLowerCase().includes(query));
  };
  let active = $derived(projects.filter((p) => !p.archived && matches(p)));
  let archived = $derived(projects.filter((p) => p.archived && matches(p)));
  let archivedTotal = $derived(projects.filter((p) => p.archived).length);
  let headers = $derived([
    { key: 'name', value: $t('projects.list.columns.name') },
    { key: 'namespace', value: $t('projects.list.columns.namespace') },
    { key: 'runs', value: $t('projects.list.columns.runs') },
    { key: 'lastActivity', value: $t('projects.lastActivity') },
    { key: 'storage', value: $t('projects.storage.title') },
    { key: 'actions', empty: true as const, sort: false as const },
  ] as const);
  const rows = (list: ProjectSummary[]) =>
    list.map((p) => ({ ...p, namespace: p.id.split('/')[0], lastActivity: p.lastActivity || 0, actions: '' }));
</script>

<div class="page-toolbar project-list-toolbar">
  <Search
    closeButtonLabelText={$t('common.search.clear')}
    size="sm"
    labelText={$t('projects.list.search')}
    placeholder={$t('projects.list.search')}
    bind:value={search}
  /><Button size="small" icon={Add} on:click={onCreate}>{$t('projects.create.action')}</Button>
</div>
{#snippet table(list: ProjectSummary[])}
  <DataTable
    class="project-table"
    tableHeaderTranslateWithId={(id) =>
      $t(id === 'columnSortAscending' ? 'common.table.sortAscending' : 'common.table.sortDescending')}
    rows={rows(list)}
    {headers}
    size="compact"
    sortable
    sortKey="lastActivity"
    sortDirection="descending"
    ><svelte:fragment slot="cell" let:row let:cell
      >{#if cell.key === 'name'}<a
          class="table-link"
          href={pageURL(String(row.id), 'workspace')}
          onclick={(event) => interceptLink(event, () => onProject(String(row.id), 'workspace'))}
          >{cell.value}</a
        >{#if row.description}<span class="project-description">{row.description}</span>{/if}{:else if cell.key === 'runs'}{$number(cell.value)}{:else if cell.key === 'lastActivity'}{cell.value
          ? $date(cell.value)
          : '—'}{:else if cell.key === 'storage'}{formatBytes(cell.value, $number)}{:else if cell.key === 'actions'}<div
          class="row-actions"
        >
          <OverflowMenu
            size="sm"
            flipped
            portalMenu
            aria-label={$t('projects.actions', { name: row.name })}
            iconDescription={$t('projects.actions', { name: row.name })}
            ><OverflowMenuItem
              text={$t('projects.list.actions.settings')}
              on:click={() => onProject(String(row.id), 'settings')}
            /><OverflowMenuItem
              text={$t(row.archived ? 'projects.restore.action' : 'projects.archive.action')}
              on:click={() => onArchive(row as unknown as ProjectSummary, !row.archived)}
            /><OverflowMenuItem
              danger
              text={$t('projects.delete.open')}
              on:click={() => {
                deleting = String(row.id);
                deleteOpen = true;
              }}
            /></OverflowMenu
          >
        </div>{:else}{cell.value}{/if}</svelte:fragment
    ></DataTable
  >
{/snippet}
{#if !projects.length}<section class="empty project-list-empty">
    <h2>{$t('projects.none')}</h2>
    <p>{$t('projects.noneText')}</p>
  </section>{:else}
  {#if active.length}<div id="active-projects">{@render table(active)}</div>{:else}<p class="project-list-note">
      {$t(search.trim() ? 'projects.list.noMatches' : 'projects.noActive')}
    </p>{/if}
  {#if archivedTotal}<section class="archived-projects" aria-labelledby="archived-projects-heading">
      <h2 id="archived-projects-heading">
        <button
          type="button"
          class="archived-toggle"
          aria-expanded={archivedOpen || !!search.trim()}
          aria-controls="archived-projects"
          onclick={() => (archivedOpen = !archivedOpen)}
          >{#if archivedOpen || search.trim()}<ChevronDown size={16} />{:else}<ChevronRight
              size={16}
            />{/if}{$t('projects.list.archived')}<span class="count">{$number(archivedTotal)}</span></button
        >
      </h2>
      <div id="archived-projects" hidden={!(archivedOpen || search.trim())}>
        {#if archived.length}{@render table(archived)}{:else}<p
            class="project-list-note"
          >
            {$t('projects.list.noMatches')}
          </p>{/if}
      </div>
    </section>{/if}
{/if}
{#if deleting}<ProjectDeleteModal
    bind:open={deleteOpen}
    project={deleting}
    onDeleted={(result) => {
      deleting = '';
      onDeleted(result);
    }}
  />{/if}

<style>
  .project-list-toolbar :global(.bx--search) {
    max-width: 24rem;
  }
  .project-list-toolbar {
    justify-content: space-between;
  }
  :global(.project-table table) {
    table-layout: fixed;
  }
  :global(.project-table th:nth-child(1)) {
    width: 36%;
  }
  :global(.project-table th:nth-child(2)) {
    width: 14%;
  }
  :global(.project-table th:nth-child(3)) {
    width: 8%;
  }
  :global(.project-table th:nth-child(4)) {
    width: 22%;
  }
  :global(.project-table th:nth-child(5)) {
    width: 12%;
  }
  :global(.project-table th:nth-child(6)) {
    width: 3rem;
  }
  :global(.project-table td) {
    overflow-wrap: anywhere;
  }
  /* Phones keep the name, run count, storage and actions. */
  @media (max-width: 600px) {
    :global(.project-table th:nth-child(2)),
    :global(.project-table td:nth-child(2)),
    :global(.project-table th:nth-child(4)),
    :global(.project-table td:nth-child(4)) {
      display: none;
    }
    :global(.project-table th:nth-child(1)) {
      width: auto;
    }
    :global(.project-table th:nth-child(3)) {
      width: 3.5rem;
    }
    :global(.project-table th:nth-child(5)) {
      width: 5.5rem;
    }
  }
  .project-description {
    display: block;
    color: var(--cds-text-secondary);
    font-size: 0.75rem;
    max-width: 32rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-actions {
    display: flex;
    justify-content: flex-end;
  }
  .row-actions :global(.bx--overflow-menu:not(.bx--overflow-menu--open)) {
    opacity: 0;
  }
  :global(.project-table tr:hover) .row-actions :global(.bx--overflow-menu),
  :global(.project-table tr:focus-within) .row-actions :global(.bx--overflow-menu) {
    opacity: 1;
  }
  @media (hover: none) {
    .row-actions :global(.bx--overflow-menu:not(.bx--overflow-menu--open)) {
      opacity: 1;
    }
  }
  .archived-projects {
    margin-top: 2rem;
  }
  .archived-projects h2 {
    margin-bottom: 0.5rem;
  }
  .archived-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2rem;
    padding: 0 0.5rem 0 0.25rem;
    border: 0;
    background: none;
    color: var(--cds-text-primary);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }
  .archived-toggle:hover {
    background: var(--cds-layer-hover);
  }
  .archived-toggle:focus-visible {
    outline: 2px solid var(--cds-focus);
    outline-offset: -2px;
  }
  .count {
    color: var(--cds-text-secondary);
    font-weight: 400;
  }
  .project-list-note {
    padding: 1rem 0;
    color: var(--cds-text-secondary);
  }
  .project-list-empty p {
    color: var(--cds-text-secondary);
  }
</style>
