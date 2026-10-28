<script lang="ts">
  import { Modal, CodeSnippet } from 'carbon-components-svelte';
  import { t } from './i18n';
  let {
    open = $bindable(false),
    project,
    authRequired,
    serverURL,
  }: { open: boolean; project: string; authRequired: boolean; serverURL: string } = $props();
  const placeholderKey = '0000000000000000000000000000000000000000';
  const shell = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);
  let key = $derived(authRequired ? 'YOUR_RANDL_API_KEY' : placeholderKey);
  let environment = $derived(
    `export WANDB_BASE_URL=${shell(serverURL)}\nexport WANDB_API_KEY=${key}`,
  );
  let login = $derived(`wandb login --relogin --host ${shell(serverURL)} ${key}`);
  let script = $derived.by(() => {
    const [entity, name] = project.split('/');
    return `import wandb\n\nwith wandb.init(entity=${JSON.stringify(entity)}, project=${JSON.stringify(name)}) as run:\n    run.log({"loss": 0.5})`;
  });
  const snippet = {
    wrapText: true,
    showMoreLess: false,
    minCollapsedNumberOfRows: 0,
    tooltipAlignment: 'end' as const,
    tooltipPosition: 'bottom' as const,
  };
</script>

<Modal
  bind:open
  passiveModal
  iconDescription={$t('common.action.close')}
  modalHeading={$t('connect.title')}
  class="connect-sdk"
>
  <p>{$t('connect.intro')}</p>
  <h3>{$t('connect.server.title')}</h3>
  <p>{$t('connect.server.environment')}</p>
  <CodeSnippet
    type="multi"
    code={environment}
    {...snippet}
    codeLabel={$t('connect.server.environmentLabel')}
    copyButtonDescription={$t('connect.copy')}
    feedback={$t('common.status.copied')}
    errorFeedback={$t('connect.copyFailed')}
  />
  <p>{$t('connect.server.login')}</p>
  <CodeSnippet
    type="multi"
    code={login}
    {...snippet}
    codeLabel={$t('connect.server.loginLabel')}
    copyButtonDescription={$t('connect.copy')}
    feedback={$t('common.status.copied')}
    errorFeedback={$t('connect.copyFailed')}
  />
  <p class="help-note">
    {authRequired
      ? $t('connect.key.required', { placeholder: 'YOUR_RANDL_API_KEY', variable: 'RANDL_API_KEY' })
      : $t('connect.key.local')}
  </p>
  <h3>{$t('connect.project.title')}</h3>
  <CodeSnippet
    type="multi"
    code={script}
    {...snippet}
    codeLabel={$t('connect.project.label')}
    copyButtonDescription={$t('connect.copy')}
    feedback={$t('common.status.copied')}
    errorFeedback={$t('connect.copyFailed')}
  />
  <h3>{$t('connect.offline.title')}</h3>
  <p>{$t('connect.offline.text', { mode: 'WANDB_MODE=offline' })}</p>
  <CodeSnippet
    type="multi"
    code="wandb sync wandb/offline-run-*"
    {...snippet}
    codeLabel={$t('connect.offline.label')}
    copyButtonDescription={$t('connect.copy')}
    feedback={$t('common.status.copied')}
    errorFeedback={$t('connect.copyFailed')}
  />
</Modal>

<style>
  :global(.connect-sdk) h3 {
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.125rem;
    margin: 1.5rem 0 0.5rem;
  }
  :global(.connect-sdk .bx--snippet) {
    width: 100%;
    max-width: 100%;
    margin-bottom: 0.75rem;
    background: var(--cds-ui-background);
  }
  :global(.connect-sdk .bx--snippet .bx--copy-btn) {
    background: var(--cds-ui-background);
  }
  :global(.connect-sdk) p {
    margin-bottom: 0.5rem;
  }
  :global(.connect-sdk) .help-note {
    margin-top: 0.5rem;
  }
</style>
