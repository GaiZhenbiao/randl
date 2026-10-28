<script lang="ts">
  import { t, type Message } from './i18n';

  import { Button, Search, InlineNotification } from 'carbon-components-svelte';
  import SideDrawer from './SideDrawer.svelte';
  import { api, tool, apiMessage } from './api';
  let { project, revision, onClose }: { project: string; revision: number; onClose: () => void } =
    $props();
  let runs = $state<any[]>([]),
    search = $state(''),
    loading = $state(true),
    busy = $state(''),
    error = $state<Message>('');
  $effect(() => {
    project;
    revision;
    void load();
  });
  async function load() {
    try {
      runs = (await api('/api/runs/trash?project=' + encodeURIComponent(project))).runs;
      error = '';
    } catch (e) {
      error = apiMessage(e);
    } finally {
      loading = false;
    }
  }
  async function restore(id: string) {
    busy = id;
    try {
      await tool('runs_update', { action: 'restore', ids: [id] });
      await load();
    } catch (e) {
      error = apiMessage(e);
    } finally {
      busy = '';
    }
  }
</script>

<SideDrawer title={$t('runs.trash.title')} {onClose}
  ><Search
    closeButtonLabelText={$t('common.search.clear')}
    size="sm"
    labelText={$t('runs.trash.search')}
    placeholder={$t('runs.trash.search')}
    bind:value={search}
  />{#if error}<InlineNotification kind="error" title={$t(error)} />{/if}{#if loading}<p
      class="empty-note"
      role="status"
    >
      {$t('runs.trash.loading')}
    </p>{:else if !runs.length}<p class="empty-note">{$t('runs.trash.empty')}</p>{:else}<ul
      class="trash-list"
    >
      {#each runs.filter((run) => (run.display_name + ' ' + run.name)
          .toLowerCase()
          .includes(search.toLowerCase())) as run (run.id)}<li>
          <div>
            <strong title={run.display_name}>{run.display_name}</strong><span>{run.name}</span>
          </div>
          <Button kind="ghost" size="small" disabled={!!busy} on:click={() => restore(run.id)}
            >{busy === run.id ? $t('runs.trash.restoring') : $t('runs.trash.restore')}</Button
          >
        </li>{/each}
    </ul>{/if}</SideDrawer
>
