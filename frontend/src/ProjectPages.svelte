<script lang="ts">
  import { artifactURL, runURL, interceptLink, statusLabel } from './ui';
  import JsonValue from './JsonValue.svelte';
  import { t, date, type Message } from './i18n';

  import {
    Button,
    DataTable,
    Search,
    Modal,
    TextInput,
    Select,
    SelectItem,
    InlineNotification,
    Tabs,
    Tab,
    TabContent,
    Tag,
  } from 'carbon-components-svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import { api, apiMessage, MessageError } from './api';
  import type { Run, ProjectSummary } from './types';
  import ProjectList from './ProjectList.svelte';
  import ProjectOverview from './ProjectOverview.svelte';
  import ProjectSettings from './ProjectSettings.svelte';
  let {
    page,
    revision,
    project,
    runs,
    onRun,
    artifactId,
    activeArtifactTab = 'files',
    onArtifactTab,
    onArtifact,
    projects,
    onProject,
    onTrash,
    onCreate,
    onConnect,
    onArchive,
    onChanged,
    onDeleted,
    dark,
  }: {
    page: string;
    revision: number;
    project: string;
    runs: Run[];
    onRun: (run: Run, tab?: string) => void;
    artifactId: string;
    activeArtifactTab?: string;
    onArtifactTab: (tab: string) => void;
    onArtifact: (id: string) => void;
    projects: ProjectSummary[];
    onProject: (id: string, page?: string) => void;
    onTrash: () => void;
    onCreate: () => void;
    onConnect: () => void;
    onArchive: (project: ProjectSummary, archived: boolean) => Promise<void>;
    onChanged: () => void;
    onDeleted: (result: any) => void;
    dark: boolean;
  } = $props();
  let summary = $derived(projects.find((p) => p.id === project));
  let search = $state(''),
    artifacts = $state<any[]>([]),
    artifactsLoaded = $state(false),
    detail = $state<any>(null),
    createOpen = $state(false),
    artifactName = $state(''),
    artifactType = $state('dataset'),
    description = $state(''),
    selectedFiles = $state<File[]>([]),
    uploading = $state(false),
    error = $state<Message>(''),
    alias = $state(''),
    feedback = $state<Message>(''),
    removedAlias = $state(''),
    fileSearch = $state('');
  const artifactTabs = ['files', 'metadata', 'usage'];
  let artifactTab = $derived(Math.max(0, artifactTabs.indexOf(activeArtifactTab)));
  $effect(() => {
    revision;
    if (page === 'artifacts') void refreshArtifacts();
  });
  $effect(() => {
    revision;
    const id = artifactId;
    let current = true;
    if (id)
      void api('/api/artifacts/' + id)
        .then((r) => {
          if (current) detail = r;
        })
        .catch((e) => {
          if (current) error = apiMessage(e);
        });
    else detail = null;
    return () => {
      current = false;
    };
  });
  let collections = $derived.by(() => {
    const unique = new Map<string, any>();
    for (const artifact of artifacts) {
      if (project && artifact.entity + '/' + artifact.project !== project) continue;
      if (!(artifact.name + ' ' + artifact.type).toLowerCase().includes(search.toLowerCase()))
        continue;
      const key = artifact.entity + '/' + artifact.project + '/' + artifact.name;
      const existing = unique.get(key);
      if (!existing) unique.set(key, { ...artifact, versionCount: 1 });
      else {
        const count = existing.versionCount + 1;
        unique.set(key, {
          ...(artifact.version > existing.version ? artifact : existing),
          versionCount: count,
        });
      }
    }
    return [...unique.values()];
  });
  async function removeAlias(value: string) {
    try {
      await api(
        '/api/artifacts/' + artifactId + '/aliases/' + encodeURIComponent(value),
        undefined,
        'DELETE',
      );
      removedAlias = value;
      feedback = 'artifacts.aliases.removed';
      detail = await api('/api/artifacts/' + artifactId);
      await refreshArtifacts();
    } catch (e) {
      error = apiMessage(e);
    }
  }
  async function refreshArtifacts() {
    try {
      artifacts = (await api('/api/artifacts')).artifacts;
      artifactsLoaded = true;
    } catch (e) {
      error = apiMessage(e);
    }
  }
  async function upload() {
    uploading = true;
    error = '';
    try {
      if (!project) throw new MessageError('artifacts.create.noProject');
      if (!selectedFiles.length) throw new MessageError('artifacts.create.noFiles');
      const [entity, p] = project.split('/');
      const a = await api('/api/artifacts', {
        entity,
        project: p,
        name: artifactName,
        type: artifactType,
        description,
      });
      for (const file of selectedFiles) {
        const response = await fetch(
          `/storage/artifacts/${a.id}/files/${encodeURIComponent(file.name)}`,
          { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file },
        );
        if (!response.ok) throw Error((await response.json()).error);
      }
      await api('/api/artifacts/' + a.id + '/commit', {});
      createOpen = false;
      await refreshArtifacts();
      onArtifact(a.id);
    } catch (e) {
      error = apiMessage(e);
    } finally {
      uploading = false;
    }
  }
  async function addAlias() {
    try {
      await api('/api/artifacts/' + artifactId + '/aliases', {
        aliases: alias
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      alias = '';
      detail = await api('/api/artifacts/' + artifactId);
      await refreshArtifacts();
    } catch (e) {
      error = apiMessage(e);
    }
  }
</script>

<div class="project-page-content">
  {#if feedback}<div class="action-feedback" role="status">
      <span>{$t(feedback)}</span>{#if removedAlias}<Button
          kind="ghost"
          size="small"
          on:click={async () => {
            await api('/api/artifacts/' + artifactId + '/aliases', { aliases: [removedAlias] });
            removedAlias = '';
            feedback = 'artifacts.aliases.restored';
            detail = await api('/api/artifacts/' + artifactId);
            await refreshArtifacts();
          }}>{$t('common.action.undo')}</Button
        >{/if}
    </div>{/if}
  {#if error}<InlineNotification
      kind="error"
      title={$t('artifacts.errors.actionFailed')}
      subtitle={$t(error)}
      on:close={() => (error = '')}
    />{/if}
  {#if page === 'overview' && !project}<ProjectList
      {projects}
      {onProject}
      {onCreate}
      onArchive={(item, archived) => void onArchive(item, archived)}
      {onDeleted}
    />
  {:else if page === 'overview'}<ProjectOverview
      {project}
      {summary}
      {runs}
      {revision}
      {dark}
      {onRun}
      {onArtifact}
      {onTrash}
      {onConnect}
      onArchive={(item, archived) => void onArchive(item, archived)}
    />
  {:else if page === 'artifacts'}
    {#if detail?.artifact}<div class="artifact-heading">
        <Button kind="ghost" size="small" on:click={() => onArtifact('')}
          >{$t('artifacts.detail.all')}</Button
        >
        <h2>{detail.artifact.name}:v{detail.artifact.version}</h2>
        <span>{detail.artifact.type} · {statusLabel(detail.artifact.state, $t)}</span>
      </div>
      <div class="artifact-version-bar">
        <Select
          labelText={$t('artifacts.detail.version')}
          selected={artifactId}
          on:change={(event) => onArtifact((event.target as HTMLSelectElement).value)}
          >{#each detail.versions as version}<SelectItem
              value={version.id}
              text={'v' + version.version + ' · ' + $date(Date.parse(version.created) / 1000)}
            />{/each}</Select
        >
        <div class="artifact-aliases">
          {#each detail.artifact.aliases as label}<span class="artifact-alias"
              ><Tag type="gray">{label}</Tag><button
                class="toggle"
                aria-label={$t('artifacts.aliases.remove', { name: label })}
                onclick={() => removeAlias(label)}><Close size={16} /></button
              ></span
            >{/each}
        </div>
      </div>
      {#if detail.artifact.description}<p>{detail.artifact.description}</p>{/if}
      <Tabs
        selected={artifactTab}
        on:change={(event) => {
          if (artifactTabs[event.detail] !== activeArtifactTab)
            onArtifactTab(artifactTabs[event.detail]);
        }}
        autoWidth
        ><Tab label={$t('artifacts.detail.tabs.files')} /><Tab label={$t('artifacts.detail.tabs.metadata')} /><Tab
          label={$t('artifacts.detail.tabs.usage')}
        /><svelte:fragment slot="content">
          <TabContent
            ><Search
              closeButtonLabelText={$t('common.search.clear')}
              size="sm"
              labelText={$t('artifacts.files.searchLabel')}
              placeholder={$t('artifacts.files.searchPlaceholder')}
              bind:value={fileSearch}
            />
            <DataTable
              tableHeaderTranslateWithId={(id) =>
                $t(id === 'columnSortAscending' ? 'common.table.sortAscending' : 'common.table.sortDescending')}
              rows={detail.files
                .filter((f: any) => f.name.toLowerCase().includes(fileSearch.toLowerCase()))
                .map((f: any) => ({
                  ...f,
                  id: f.name,
                  size: $t('common.units.bytes', { count: f.size }),
                }))}
              headers={[
                { key: 'name', value: $t('artifacts.files.columns.name') },
                { key: 'size', value: $t('artifacts.files.columns.size') },
                { key: 'digest', value: $t('artifacts.files.columns.digest') },
              ]}
              size="compact"
              ><svelte:fragment slot="cell" let:cell
                >{#if cell.key === 'name'}<a
                    href={'/storage/artifacts/' +
                      artifactId +
                      '/files/' +
                      encodeURIComponent(String(cell.value))}
                    download>{cell.value}</a
                  >{:else}{cell.value}{/if}</svelte:fragment
              ></DataTable
            >
          </TabContent>
          <TabContent><JsonValue value={JSON.parse(detail.artifact.metadata || '{}')} /></TabContent
          >
          <TabContent
            ><h3 class="table-heading">{$t('artifacts.detail.download')}</h3>
            <pre>{'import wandb\n\napi = wandb.Api(overrides={"base_url": ' +
                JSON.stringify(location.origin) +
                '})\nartifact = api.artifact(' +
                JSON.stringify(
                  detail.artifact.entity +
                    '/' +
                    detail.artifact.project +
                    '/' +
                    detail.artifact.name +
                    ':v' +
                    detail.artifact.version,
                ) +
                ')\npath = artifact.download()'}</pre>
            <h3 class="table-heading">{$t('artifacts.usage.producedBy')}</h3>
            {#if detail.producer}<div class="artifact-run-row">
                <a
                  class="table-link"
                  href={runURL(detail.producer)}
                  onclick={(event) => interceptLink(event, () => onRun(detail.producer))}
                  >{detail.producer.display_name}</a
                ><span>{statusLabel(detail.producer.state, $t)}</span>
              </div>{:else}<p>{$t('artifacts.usage.uploaded')}</p>{/if}
            <h3 class="table-heading">{$t('artifacts.usage.usedBy')}</h3>
            {#if detail.consumers.length}<DataTable
                tableHeaderTranslateWithId={(id) =>
                  $t(id === 'columnSortAscending' ? 'common.table.sortAscending' : 'common.table.sortDescending')}
                rows={detail.consumers.map((run: any) => ({
                  ...run,
                  state: statusLabel(run.state, $t),
                }))}
                headers={[
                  { key: 'display_name', value: $t('runs.columns.run') },
                  { key: 'state', value: $t('runs.fields.state') },
                ]}
                size="compact"
                ><svelte:fragment slot="cell" let:row let:cell
                  >{#if cell.key === 'display_name'}<a
                      class="table-link"
                      href={runURL(detail.consumers.find((run: any) => run.id === row.id))}
                      onclick={(event) =>
                        interceptLink(event, () =>
                          onRun(detail.consumers.find((run: any) => run.id === row.id)),
                        )}>{cell.value}</a
                    >{:else}{cell.value}{/if}</svelte:fragment
                ></DataTable
              >{:else}<p>{$t('artifacts.usage.unused')}</p>{/if}
          </TabContent>
        </svelte:fragment></Tabs
      >
      <div class="alias-editor">
        <TextInput labelText={$t('artifacts.aliases.new')} placeholder="production" bind:value={alias} /><Button
          size="small"
          disabled={!alias.trim()}
          on:click={addAlias}>{$t('artifacts.aliases.add')}</Button
        >
      </div>
    {:else}<div class="page-toolbar">
        <Search
          closeButtonLabelText={$t('common.search.clear')}
          labelText={$t('artifacts.list.search')}
          placeholder={$t('artifacts.list.search')}
          bind:value={search}
          size="sm"
        /><Button
          size="small"
          icon={Add}
          disabled={!project}
          on:click={() => {
            artifactName = '';
            selectedFiles = [];
            createOpen = true;
          }}>{$t('artifacts.create.title')}</Button
        >
      </div>
      {#if !artifactsLoaded}{#if !error}<div class="empty-table">
            <p role="status">{$t('common.status.loading')}</p>
          </div>{/if}{:else if !collections.length}<div class="empty-table">
          <p>{$t(search ? 'artifacts.list.noMatches' : 'artifacts.list.empty')}</p>
        </div>{:else}<DataTable
        tableHeaderTranslateWithId={(id) =>
          $t(id === 'columnSortAscending' ? 'common.table.sortAscending' : 'common.table.sortDescending')}
        rows={collections.map((a) => ({
          ...a,
          state: statusLabel(a.state, $t),
          label: a.name,
          aliases: a.aliases.join(', '),
          size: $t('common.units.bytes', { count: a.size }),
          latest: 'v' + a.version,
        }))}
        headers={[
          { key: 'label', value: $t('artifacts.list.columns.name') },
          { key: 'type', value: $t('artifacts.list.columns.type') },
          { key: 'latest', value: $t('artifacts.list.columns.latest') },
          { key: 'versionCount', value: $t('artifacts.list.columns.versions') },
          { key: 'aliases', value: $t('artifacts.list.columns.aliases') },
          { key: 'size', value: $t('artifacts.list.columns.size') },
          { key: 'state', value: $t('artifacts.list.columns.state') },
        ]}
        size="compact"
        sortable
        ><svelte:fragment slot="cell" let:row let:cell
          >{#if cell.key === 'label'}<a
              class="table-link"
              href={artifactURL(project, String(row.id))}
              onclick={(event) => interceptLink(event, () => onArtifact(String(row.id)))}
              >{cell.value}</a
            >{:else}{cell.value}{/if}</svelte:fragment
        ></DataTable
      >{/if}{/if}
  {:else if page === 'settings' && project}<ProjectSettings
      {project}
      {summary}
      {revision}
      {runs}
      {onTrash}
      {onConnect}
      {onArchive}
      {onChanged}
      {onDeleted}
    />
  {/if}
  <Modal
    bind:open={createOpen}
    iconDescription={$t('common.action.close')}
    modalHeading={$t('artifacts.create.title')}
    primaryButtonText={uploading ? $t('artifacts.create.uploading') : $t('artifacts.create.title')}
    primaryButtonDisabled={uploading || !artifactName || !selectedFiles.length}
    secondaryButtonText={$t('common.action.cancel')}
    on:submit={upload}
    on:click:button--secondary={() => (createOpen = false)}
    ><div class="form-stack">
      <TextInput labelText={$t('artifacts.create.name')} bind:value={artifactName} /><TextInput
        labelText={$t('artifacts.create.type')}
        bind:value={artifactType}
      /><TextInput labelText={$t('artifacts.create.description')} bind:value={description} /><label
        class="file-picker"
        >{$t('artifacts.create.files')}<input
          type="file"
          multiple
          onchange={(event) => (selectedFiles = Array.from(event.currentTarget.files || []))}
        /></label
      >{#if error}<p role="alert">{error}</p>{/if}
    </div></Modal
  >
</div>
