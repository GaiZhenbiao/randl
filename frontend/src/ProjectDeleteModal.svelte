<script lang="ts">
  import { tick } from 'svelte';
  import { Modal, TextInput, InlineNotification, InlineLoading } from 'carbon-components-svelte';
  import ProjectDeleteSummary from './ProjectDeleteSummary.svelte';
  import { t, type Message } from './i18n';
  import { tool, apiMessage } from './api';
  import type { ProjectDetails } from './types';
  let {
    open = $bindable(false),
    project,
    onDeleted,
  }: {
    open: boolean;
    project: string;
    onDeleted: (result: any) => void;
  } = $props();
  let details = $state<ProjectDetails | null>(null),
    typed = $state(''),
    deleting = $state(false),
    error = $state<Message>('');
  $effect(() => {
    if (!open) return;
    typed = '';
    error = '';
    details = null;
    let current = true;
    void tool('project_get', { id: project })
      .then((value) => {
        if (current) details = value;
      })
      .catch((reason) => {
        if (current) error = apiMessage(reason);
      });
    return () => {
      current = false;
    };
  });
  $effect(() => {
    if (open && details) void tick().then(() => document.getElementById('delete-project-name')?.focus());
  });
  let matches = $derived(!!details && typed === details.name);
  async function remove() {
    if (!details || !matches || deleting) return;
    deleting = true;
    error = '';
    try {
      const result = await tool('project_delete', {
        id: project,
        confirm: typed,
        expected: details.counts,
      });
      open = false;
      onDeleted(result);
    } catch (reason) {
      error = apiMessage(reason);
    } finally {
      deleting = false;
    }
  }
</script>

<Modal
  bind:open
  danger
  size="sm"
  iconDescription={$t('common.action.close')}
  modalHeading={details ? $t('projects.delete.title', { name: details.name }) : $t('projects.delete.action')}
  primaryButtonText={$t(deleting ? 'projects.confirmation.deleting' : 'projects.delete.action')}
  primaryButtonDisabled={!matches || deleting}
  secondaryButtonText={$t('common.action.cancel')}
  selectorPrimaryFocus="#delete-project-name"
  on:close={(event) => {
    if (deleting) event.preventDefault();
  }}
  on:click:button--secondary={() => {
    if (!deleting) open = false;
  }}
  on:submit={remove}
>
  {#if details}
    <ProjectDeleteSummary {details} id="delete-project-summary" />
    <TextInput
      id="delete-project-name"
      labelText={$t('projects.confirmation.typeName', { name: details.name })}
      aria-describedby="delete-project-summary"
      autocomplete="off"
      spellcheck="false"
      disabled={deleting}
      bind:value={typed}
    />
  {:else if !error}<InlineLoading description={$t('common.status.loading')} />{/if}
  {#if error}<InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={$t(error)}
    />{/if}
</Modal>
