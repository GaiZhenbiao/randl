<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Button, TextInput, TextArea, InlineNotification, CodeSnippet } from 'carbon-components-svelte';
  import ProjectDeleteModal from './ProjectDeleteModal.svelte';
  import ProjectDeleteSummary from './ProjectDeleteSummary.svelte';
  import { t, number, type Message } from './i18n';
  import { tool, apiMessage } from './api';
  import { imeKeys } from './ime';
  import type { ProjectDetails, ProjectSummary, Run } from './types';
  let {
    project,
    summary,
    revision,
    runs,
    onTrash,
    onConnect,
    onArchive,
    onChanged,
    onDeleted,
  }: {
    project: string;
    summary: ProjectSummary | undefined;
    revision: number;
    runs: Run[];
    onTrash: () => void;
    onConnect: () => void;
    onArchive: (project: ProjectSummary, archived: boolean) => Promise<void>;
    onChanged: () => void;
    onDeleted: (result: any) => void;
  } = $props();
  let details = $state<ProjectDetails | null>(null),
    error = $state<Message>('');
  async function load(id: string) {
    try {
      const value = await tool('project_get', { id });
      if (id === project) details = value;
    } catch (reason) {
      if (id === project) error = apiMessage(reason);
    }
  }
  let previous = '',
    throttle: ReturnType<typeof setTimeout> | undefined;
  // Completion changes a run's state without a new revision, so include both.
  let runSignature = $derived(runs.map((run) => run.state + run.revision).join());
  $effect(() => {
    const id = project;
    revision;
    runSignature;
    summary?.archived;
    if (id !== previous) {
      previous = id;
      void load(id);
      return;
    }
    // Reload the counts that gate deletion at most once a second while runs log.
    throttle ??= setTimeout(() => {
      throttle = undefined;
      void load(project);
    }, 1000);
  });
  onMount(() => () => clearTimeout(throttle));
  // Saved values; the form keeps its own draft until it is saved or reset.
  let savedName = $derived(summary?.name ?? ''),
    savedDescription = $derived(summary?.description ?? '');
  let name = $state(''),
    description = $state(''),
    edited = $state(false),
    saving = $state(false),
    status = $state<Message>(''),
    formError = $state<Message>(''),
    otherSession = $state(false),
    baseline = { project: '', name: '', description: '' };
  $effect(() => {
    const next = { project, name: savedName, description: savedDescription };
    if (next.project !== baseline.project || !untrack(() => edited)) {
      name = next.name;
      description = next.description;
      edited = false;
      otherSession = false;
    } else if (next.name !== baseline.name || next.description !== baseline.description)
      otherSession = true;
    baseline = next;
  });
  let changed = $derived(name.trim() !== savedName || description !== savedDescription);
  let nameInvalid = $derived(edited && !name.trim());
  function reset() {
    name = savedName;
    description = savedDescription;
    edited = false;
    otherSession = false;
    formError = '';
  }
  async function save() {
    if (!changed || !name.trim() || saving) return;
    saving = true;
    formError = '';
    try {
      await tool('project_update', {
        id: project,
        ...(name.trim() !== savedName ? { name: name.trim() } : {}),
        ...(description !== savedDescription ? { description } : {}),
      });
      edited = false;
      otherSession = false;
      status = 'projects.saved';
      onChanged();
    } catch (reason) {
      formError = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
  let archiving = $state(false),
    deleteOpen = $state(false);
</script>

<div class="project-settings">
  {#if error}<InlineNotification kind="error" lowContrast hideCloseButton title={$t(error)} />{/if}
  <section aria-labelledby="settings-general">
    <h2 id="settings-general">{$t('projects.general')}</h2>
    <form
      class="settings-form"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      oninput={() => {
        edited = true;
        status = '';
      }}
      use:imeKeys={{ escape: (event) => (event.target as HTMLElement).closest('input') && reset() }}
    >
      <TextInput
        labelText={$t('projects.settings.name')}
        bind:value={name}
        maxlength={200}
        invalid={nameInvalid}
        invalidText={$t('projects.errors.nameRequired')}
        disabled={saving}
      />
      <TextArea
        labelText={$t('projects.description.label')}
        bind:value={description}
        rows={3}
        maxCount={5000}
        disabled={saving}
      />
      {#if otherSession}<InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={$t('projects.changedElsewhere')}
          ><Button slot="actions" kind="ghost" size="small" on:click={reset}
            >{$t('projects.useSaved')}</Button
          ></InlineNotification
        >{/if}
      {#if formError}<InlineNotification kind="error" lowContrast hideCloseButton title={$t(formError)} />{/if}
      <div class="settings-actions">
        <Button size="small" type="submit" disabled={!changed || !name.trim() || saving}
          >{$t('projects.settings.save')}</Button
        >{#if changed}<Button kind="ghost" size="small" disabled={saving} on:click={reset}
            >{$t('common.action.cancel')}</Button
          >{/if}<span class="settings-status" role="status">{$t(status)}</span>
      </div>
    </form>
    <div class="project-id">
      <span class="bx--label">{$t('projects.settings.id')}</span>
      <CodeSnippet
        type="inline"
        code={project}
        copyLabel={$t('projects.copyId')}
        feedback={$t('common.status.copied')}
      />
      <p class="help-note">{$t('projects.idHelp')}</p>
      <Button kind="tertiary" size="small" on:click={onConnect}>{$t('connect.title')}</Button>
    </div>
  </section>
  <section aria-labelledby="settings-deleted-runs">
    <h2 id="settings-deleted-runs">{$t('projects.settings.deletedRuns')}</h2>
    {#if details}<div class="settings-row">
        <p>
          {details.counts.deletedRuns
            ? $t('projects.deletedRunsCount', { count: $number(details.counts.deletedRuns) })
            : $t('projects.noDeletedRuns')}
        </p>
        <Button kind="tertiary" size="small" on:click={onTrash}>{$t('projects.viewDeletedRuns')}</Button>
      </div>{/if}
  </section>
  <section aria-labelledby="settings-archive">
    <h2 id="settings-archive">{$t(summary?.archived ? 'projects.restore.action' : 'projects.archive.action')}</h2>
    <div class="settings-row">
      <p>{$t(summary?.archived ? 'projects.restoreHelp' : 'projects.archiveHelp')}</p>
      <Button
        kind="tertiary"
        size="small"
        disabled={archiving || !summary}
        on:click={async () => {
          if (!summary) return;
          archiving = true;
          try {
            await onArchive(summary, !summary.archived);
          } finally {
            archiving = false;
          }
        }}>{$t(summary?.archived ? 'projects.restore.action' : 'projects.archive.action')}</Button
      >
    </div>
  </section>
  <section aria-labelledby="settings-delete">
    <h2 id="settings-delete">{$t('projects.delete.action')}</h2>
    {#if details}<ProjectDeleteSummary {details} />
      {#if details.runningRuns}<p class="settings-warning">
          {$t('projects.errors.runningRuns', { count: details.runningRuns })}
        </p>{/if}
      <Button
        kind="danger-tertiary"
        size="small"
        disabled={!!details.runningRuns}
        on:click={() => (deleteOpen = true)}>{$t('projects.delete.open')}</Button
      >{/if}
  </section>
</div>
<ProjectDeleteModal bind:open={deleteOpen} {project} {onDeleted} />

<style>
  .project-settings {
    max-width: 48rem;
  }
  section {
    padding-bottom: 2rem;
    margin-bottom: 2rem;
    border-bottom: 1px solid var(--cds-border-subtle-01);
  }
  section:last-child {
    border-bottom: 0;
  }
  h2 {
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.5;
    margin-bottom: 1rem;
  }
  .settings-form {
    display: grid;
    gap: 1rem;
  }
  .settings-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }
  .settings-row {
    display: grid;
    justify-items: start;
    gap: 0.75rem;
  }
  .settings-status {
    font-size: 0.875rem;
    color: var(--cds-text-secondary);
  }
  .project-id {
    margin-top: 1.5rem;
    display: grid;
    justify-items: start;
    gap: 0.5rem;
  }
  .settings-warning {
    margin-bottom: 1rem;
    color: var(--cds-text-error);
  }
</style>
