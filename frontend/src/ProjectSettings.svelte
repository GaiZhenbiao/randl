<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Button, TextInput, TextArea, InlineNotification, CodeSnippet } from 'carbon-components-svelte';
  import ProjectDeleteModal from './ProjectDeleteModal.svelte';
  import ProjectDeleteSummary from './ProjectDeleteSummary.svelte';
  import ProjectMediaLimit from './ProjectMediaLimit.svelte';
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

<!-- Carbon's settings pattern: each section a row, its title and description beside its
     controls, rows divided by a rule; on narrow screens the description stands above. -->
<div class="project-settings">
  {#if error}<InlineNotification kind="error" lowContrast hideCloseButton title={$t(error)} />{/if}
  <section class="settings-section" aria-labelledby="settings-general">
    <div class="settings-intro">
      <h2 id="settings-general">{$t('projects.general')}</h2>
    </div>
    <form
      class="settings-body"
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
  </section>
  <section class="settings-section" aria-labelledby="settings-id">
    <div class="settings-intro">
      <h2 id="settings-id">{$t('projects.settings.id')}</h2>
      <p>{$t('projects.idHelp')}</p>
    </div>
    <div class="settings-body">
      <CodeSnippet
        type="inline"
        code={project}
        copyLabel={$t('projects.copyId')}
        feedback={$t('common.status.copied')}
      />
      <div class="settings-actions">
        <Button kind="tertiary" size="small" on:click={onConnect}>{$t('connect.title')}</Button>
      </div>
    </div>
  </section>
  <section class="settings-section" aria-labelledby="settings-media-limit">
    <div class="settings-intro">
      <h2 id="settings-media-limit">{$t('projects.mediaLimit.title')}</h2>
      <p>{$t('projects.mediaLimit.help')}</p>
    </div>
    <div class="settings-body"><ProjectMediaLimit {project} {runs} /></div>
  </section>
  <section class="settings-section" aria-labelledby="settings-deleted-runs">
    <div class="settings-intro">
      <h2 id="settings-deleted-runs">{$t('projects.settings.deletedRuns')}</h2>
    </div>
    <div class="settings-body">
      {#if details}<p>
          {details.counts.deletedRuns
            ? $t('projects.deletedRunsCount', { count: $number(details.counts.deletedRuns) })
            : $t('projects.noDeletedRuns')}
        </p>
        <div class="settings-actions">
          <Button kind="tertiary" size="small" on:click={onTrash}>{$t('projects.viewDeletedRuns')}</Button>
        </div>{/if}
    </div>
  </section>
  <section class="settings-section" aria-labelledby="settings-archive">
    <div class="settings-intro">
      <h2 id="settings-archive">{$t(summary?.archived ? 'projects.restore.action' : 'projects.archive.action')}</h2>
      <p>{$t(summary?.archived ? 'projects.restoreHelp' : 'projects.archiveHelp')}</p>
    </div>
    <div class="settings-body">
      <div class="settings-actions">
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
    </div>
  </section>
  <section class="settings-section" aria-labelledby="settings-delete">
    <div class="settings-intro">
      <h2 id="settings-delete">{$t('projects.delete.action')}</h2>
    </div>
    <div class="settings-body">
      {#if details}<ProjectDeleteSummary {details} />
        {#if details.runningRuns}<p class="settings-warning">
            {$t('projects.errors.runningRuns', { count: details.runningRuns })}
          </p>{/if}
        <div class="settings-actions">
          <Button
            kind="danger"
            size="small"
            disabled={!!details.runningRuns}
            on:click={() => (deleteOpen = true)}>{$t('projects.delete.open')}</Button
          >
        </div>{/if}
    </div>
  </section>
</div>
<ProjectDeleteModal bind:open={deleteOpen} {project} {onDeleted} />

<style>
  /* Carbon spacing: 32 px (spacing-07) inside a section, 16 px between its fields. */
  .project-settings {
    max-width: 64rem;
  }
  .settings-section {
    display: grid;
    grid-template-columns: minmax(0, 16rem) minmax(0, 1fr);
    gap: 1rem 2rem;
    padding: 2rem 0;
    border-top: 1px solid var(--cds-border-subtle-01, var(--cds-ui-03));
  }
  .settings-section:first-of-type {
    border-top: 0;
    padding-top: 1rem;
  }
  /* productive-heading-02 and body-short-01 */
  .settings-intro h2 {
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.375;
    letter-spacing: 0;
    color: var(--cds-text-primary, var(--cds-text-01));
  }
  .settings-intro p {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.29;
    letter-spacing: 0.16px;
    color: var(--cds-text-secondary, var(--cds-text-02));
  }
  .settings-body {
    display: grid;
    align-content: start;
    justify-items: stretch;
    gap: 1rem;
    min-width: 0;
    max-width: 40rem;
  }
  .settings-body > :global(.bx--snippet) {
    justify-self: start;
  }
  .settings-body > :global(.delete-summary) {
    font-size: 0.875rem;
    line-height: 1.29;
    letter-spacing: 0.16px;
  }
  .settings-body > p {
    font-size: 0.875rem;
    line-height: 1.29;
    letter-spacing: 0.16px;
  }
  .settings-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }
  .settings-status {
    font-size: 0.875rem;
    color: var(--cds-text-secondary);
  }
  .settings-warning {
    color: var(--cds-text-error);
  }
  @media (max-width: 671px) {
    .settings-section {
      grid-template-columns: minmax(0, 1fr);
      padding: 1.5rem 0;
    }
  }
</style>
