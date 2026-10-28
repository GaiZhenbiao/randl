<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Button, TextInput, InlineNotification } from 'carbon-components-svelte';
  import ProjectDeleteSummary from './ProjectDeleteSummary.svelte';
  import { t } from './i18n';
  import { api, apiMessage } from './api';
  import { imeKeys } from './ime';
  import { pendingProjectConfirmation } from './agent-confirmation';
  let { action, session }: { action: any; session: string } = $props();
  let field = $state<HTMLInputElement | null>(null);
  let pending = $derived(
    $pendingProjectConfirmation?.id === action.id && $pendingProjectConfirmation?.session === session
      ? $pendingProjectConfirmation
      : null,
  );
  let summary = $derived(pending?.summary || action.result?.summary);
  let project = $derived(pending?.project || action.result?.project);
  onMount(() => {
    void tick().then(() => field?.focus());
  });
  async function decide(decision: 'confirm' | 'decline') {
    if (!pending || pending.submitting) return;
    if (decision === 'confirm' && pending.entered !== pending.project.name) return;
    const current = pending;
    pendingProjectConfirmation.set({ ...current, submitting: decision, error: '' });
    try {
      await api('/api/agent/confirm', {
        session,
        call: current.id,
        token: current.token,
        decision,
        ...(decision === 'confirm' ? { name: current.entered } : {}),
      });
    } catch (error) {
      pendingProjectConfirmation.update((value) =>
        value?.id === current.id ? { ...value, submitting: '', error: apiMessage(error) } : value,
      );
    }
  }
</script>

{#if project && summary}
  <section class="project-confirmation" data-escape-scope aria-labelledby={'delete-title-' + action.id}>
    <h3 id={'delete-title-' + action.id}>{$t('projects.delete.title', { name: project.name })}</h3>
    <code>{project.id}</code>
    <ProjectDeleteSummary details={summary} id={'delete-effects-' + action.id} />
    {#if pending}
      <p class="bx--visually-hidden" role="status">
        {$t('projects.confirmation.announcement', { name: project.name })}
      </p>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void decide('confirm');
        }}
        use:imeKeys={{ escape: () => void decide('decline') }}
      >
        <TextInput
          labelText={$t('projects.confirmation.typeName', { name: project.name })}
          aria-describedby={'delete-effects-' + action.id}
          autocomplete="off"
          spellcheck="false"
          value={pending.entered}
          bind:ref={field}
          disabled={!!pending.submitting}
          on:input={(event) =>
            pendingProjectConfirmation.update((value) =>
              value ? { ...value, entered: String(event.detail ?? '') } : value,
            )}
        />
        {#if pending.error}<InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={$t(pending.error)}
          />{/if}
        <div class="confirmation-actions">
          <Button kind="secondary" disabled={!!pending.submitting} on:click={() => decide('decline')}
            >{$t(pending.submitting === 'decline' ? 'projects.confirmation.cancelling' : 'common.action.cancel')}</Button
          >
          <Button
            kind="danger"
            type="submit"
            disabled={!!pending.submitting || pending.entered !== project.name}
            >{$t(
              pending.submitting === 'confirm' ? 'projects.confirmation.deleting' : 'projects.delete.action',
            )}</Button
          >
        </div>
      </form>
    {:else}<p>{$t('projects.confirmation.otherTab')}</p>{/if}
  </section>
{/if}

<style>
  .project-confirmation {
    padding: 1rem;
    background: var(--cds-layer-01);
    border: 1px solid var(--cds-border-subtle-01);
    overflow-wrap: anywhere;
  }
  .project-confirmation h3 {
    font-size: 1rem;
    line-height: 1.5;
    margin-bottom: 0.25rem;
  }
  .project-confirmation code {
    display: block;
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
    color: var(--cds-text-secondary);
  }
  .confirmation-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  @media (max-width: 600px), (max-height: 400px) {
    .confirmation-actions {
      flex-direction: column;
    }
    .confirmation-actions :global(button) {
      width: 100%;
      max-width: none;
      min-height: 48px;
    }
  }
</style>
