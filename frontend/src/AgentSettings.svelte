<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    Accordion,
    AccordionItem,
    Button,
    CodeSnippet,
    TextInput,
    InlineNotification,
    Tag,
    Modal,
    Portal,
  } from 'carbon-components-svelte';
  import { api, apiMessage } from './api';
  import EditorChoice from './EditorChoice.svelte';
  let { onRequestClose }: { onRequestClose: () => void } = $props();
  import { filterChoice, resultCount } from './ui';
  import { t, type Message, type MessageKey } from './i18n';
  type Provider = {
    id: string;
    name: string;
    apiKey: boolean;
    oauth: boolean;
    configured: boolean;
    stored: boolean;
    serverSetup?: boolean;
    credentialType?: string;
    credentialSource?: string;
    models: { id: string; name: string }[];
  };
  type Result = {
    kind: 'success' | 'error' | 'info';
    title: MessageKey;
    detail?: Message;
    values?: Record<string, string>;
    focus?: 'sign-out';
  } | null;
  type ModelChoice = { provider: string; id: string; name: string };
  let availableModels = $state<ModelChoice[]>([]),
    resolvedAutomatic = $state<ModelChoice | null>(null);
  let providerInput = $state<HTMLInputElement | null>(null),
    modelInput = $state<HTMLInputElement | null>(null),
    providerOpen = $state(false),
    modelOpen = $state(false);
  let providers = $state<Provider[]>([]),
    provider = $state(''),
    model = $state(''),
    key = $state(''),
    providerQuery = $state(''),
    modelQuery = $state('');
  let busy = $state(false),
    operation = $state(''),
    loading = $state(true),
    loadError = $state<Message>(''),
    overrideKey = $state(false),
    setupOpen = $state(false),
    confirmRemove = $state(false),
    confirmation = $state<'remove-key' | 'sign-out'>('remove-key');
  let keyResult = $state<Result>(null),
    modelResult = $state<Result>(null),
    refreshResult = $state<Result>(null);
  let savedModel = $state<{ provider: string; id: string } | null>(null),
    configuration = $state<{ directory: string; shared: boolean; setupCommand: string } | null>(
      null,
    );
  let host: HTMLDivElement;
  const automatic = '__automatic__';
  const selected = $derived(providers.find((p) => p.id === provider));
  const setupFirst = $derived(!!selected && !selected.configured && !selected.apiKey);
  const signedIn = $derived(selected?.credentialType === 'oauth');
  const external = $derived(!!selected?.configured && !selected?.stored);
  const providerItems = $derived(providers.map((p) => ({ id: p.id, text: p.name })));
  const providerNoMatch = $derived(
    !!providerQuery.trim() && !providerItems.some((item) => filterChoice(item, providerQuery)),
  );
  const unavailableSaved = $derived(
    savedModel &&
      !availableModels.some((m) => m.provider === savedModel?.provider && m.id === savedModel?.id)
      ? {
          id: savedModel.provider + '/' + savedModel.id,
          text: $t('assistant.model.unavailable', {
            model:
              (providers.find((p) => p.id === savedModel?.provider)?.name || savedModel.provider) +
              ' / ' +
              (providers
                .find((p) => p.id === savedModel?.provider)
                ?.models.find((m) => m.id === savedModel?.id)?.name || savedModel.id),
          }),
          disabled: true,
        }
      : null,
  );
  const modelItems = $derived([
    ...(unavailableSaved ? [unavailableSaved] : []),
    { id: automatic, text: $t('assistant.model.automatic') },
    ...availableModels.map((m) => ({
      id: m.provider + '/' + m.id,
      text: (providers.find((p) => p.id === m.provider)?.name || m.provider) + ' / ' + m.name,
    })),
  ]);
  const modelNoMatch = $derived(
    !!modelQuery.trim() && !modelItems.some((item) => filterChoice(item, modelQuery)),
  );
  const modelChanged = $derived(
    !!model &&
      (model === automatic ? !!savedModel : model !== savedModel?.provider + '/' + savedModel?.id),
  );
  const chosenModel = $derived(availableModels.find((m) => m.provider + '/' + m.id === model));
  const testedModel = $derived(model === automatic ? resolvedAutomatic : chosenModel);
  $effect(() => {
    if (selected && !selected.configured && !selected.apiKey) setupOpen = true;
  });
  function message(error: unknown): Message {
    return error instanceof TypeError ? 'app.errors.unreachable' : apiMessage(error);
  }
  function focusKey() {
    (
      host?.querySelector<HTMLElement>('input[type="password"],.key-override') || providerInput
    )?.focus();
  }
  function focusSignOutResult() {
    if (signedIn) host.querySelector<HTMLElement>('.provider-sign-out')?.focus();
    else focusKey();
  }
  function requestRemoval(kind: 'remove-key' | 'sign-out') {
    confirmation = kind;
    if (configuration?.shared) confirmRemove = true;
    else void action(kind);
  }
  function cancelOverride() {
    key = '';
    overrideKey = false;
    void tick().then(focusKey);
  }
  async function load() {
    const [catalog, settings] = await Promise.all([
      api('/api/agent/providers'),
      api('/api/agent/models'),
    ]);
    const initial = !providers.length;
    providers = catalog.providers;
    configuration = catalog.configuration;
    savedModel = settings.selected;
    availableModels = settings.models;
    resolvedAutomatic = settings.automatic;
    if (!provider) provider = savedModel?.provider || providers.find((p) => p.configured)?.id || '';
    if (initial) model = savedModel ? savedModel.provider + '/' + savedModel.id : automatic;
    providerQuery = providers.find((p) => p.id === provider)?.name || '';
  }
  onMount(() => {
    void load()
      .catch((e) => (loadError = message(e)))
      .finally(() => (loading = false));
    const escape = (event: KeyboardEvent) => {
      if (
        !event.isComposing &&
        event.keyCode !== 229 &&
        event.key === 'Escape' &&
        document.activeElement instanceof Element &&
        document.activeElement.closest('[data-escape-scope]') &&
        host?.contains(document.activeElement)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (overrideKey) cancelOverride();
        else {
          key = '';
          void tick().then(focusKey);
        }
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  });
  async function retry() {
    loading = true;
    loadError = '';
    try {
      await load();
    } catch (e) {
      loadError = message(e);
    } finally {
      loading = false;
      await tick();
      providerInput?.focus();
    }
  }
  async function dismissResult(group: 'key' | 'model' | 'refresh') {
    const signOutResult = group === 'key' && keyResult?.focus === 'sign-out';
    if (group === 'key') keyResult = null;
    else if (group === 'model') modelResult = null;
    else refreshResult = null;
    await tick();
    if (signOutResult) focusSignOutResult();
    else if (group === 'key') focusKey();
    else if (group === 'model') (modelInput || providerInput)?.focus();
    else if (selected?.configured) modelInput?.focus();
    else host.querySelector<HTMLElement>('.provider-refresh')?.focus();
  }
  async function refresh() {
    busy = true;
    operation = 'refresh';
    refreshResult = null;
    keyResult = null;
    modelResult = null;
    let configured = false;
    try {
      await load();
      const current = providers.find((p) => p.id === provider);
      configured = !!current?.configured;
      refreshResult = {
        kind: configured ? 'success' : 'info',
        title: configured ? 'assistant.settings.provider.refreshConfigured' : 'assistant.settings.provider.refreshNotConfigured',
        values: { provider: current?.name || provider },
      };
      if (configured) setupOpen = false;
    } catch (e) {
      refreshResult = {
        kind: 'error',
        title: 'assistant.settings.providers.refreshFailed',
        detail: message(e),
      };
    } finally {
      busy = false;
      operation = '';
      await tick();
      if (configured) {
        modelInput?.focus();
        modelInput?.scrollIntoView({ block: 'nearest' });
      } else host.querySelector<HTMLElement>('.provider-refresh')?.focus();
    }
  }
  async function action(kind: 'save-key' | 'remove-key' | 'sign-out' | 'model' | 'test') {
    const trigger = document.activeElement as HTMLElement;
    const providerName = selected?.name || provider;
    busy = true;
    operation = kind;
    if (kind === 'save-key' || kind === 'remove-key' || kind === 'sign-out') {
      keyResult = null;
      refreshResult = null;
      modelResult = null;
    } else modelResult = null;
    try {
      if (kind === 'save-key') {
        await api('/api/agent/credential', { provider, key });
        key = '';
        overrideKey = false;
        keyResult = { kind: 'success', title: 'assistant.settings.apiKey.saved' };
      } else if (kind === 'remove-key' || kind === 'sign-out') {
        await api('/api/agent/credential/' + encodeURIComponent(provider), undefined, 'DELETE');
        keyResult = {
          kind: 'success',
          title: kind === 'sign-out' ? 'assistant.settings.signOut.done' : 'assistant.settings.apiKey.removed',
          values: { provider: providerName },
          focus: kind === 'sign-out' ? 'sign-out' : undefined,
        };
      } else if (kind === 'model') {
        await api(
          '/api/agent/model',
          model === automatic
            ? { provider: '', id: '' }
            : { provider: chosenModel!.provider, id: chosenModel!.id },
        );
        modelResult = { kind: 'success', title: 'assistant.settings.model.saved' };
      } else {
        await api('/api/agent/test', { provider: testedModel!.provider, id: testedModel!.id });
        modelResult = { kind: 'success', title: 'assistant.settings.model.testPassed' };
      }
      await load();
    } catch (e) {
      const result: Result = {
        kind: 'error',
        title:
          kind === 'save-key'
            ? 'assistant.settings.apiKey.saveFailed'
            : kind === 'sign-out'
              ? 'assistant.settings.signOut.failed'
              : kind === 'remove-key'
                ? 'assistant.settings.apiKey.removeFailed'
                : kind === 'model'
                  ? 'assistant.settings.model.saveFailed'
                  : 'assistant.settings.model.testFailed',
        detail: message(e),
        values: { provider: providerName },
        focus: kind === 'sign-out' ? 'sign-out' : undefined,
      };
      if (kind === 'save-key' || kind === 'remove-key' || kind === 'sign-out') keyResult = result;
      else modelResult = result;
    } finally {
      busy = false;
      operation = '';
      await tick();
      if (kind === 'sign-out') focusSignOutResult();
      else if (kind === 'save-key' || kind === 'remove-key') focusKey();
      else if (trigger.isConnected && !trigger.hasAttribute('disabled')) trigger.focus();
      else (modelInput || providerInput)?.focus();
    }
  }
  function chooseProvider(id: string) {
    provider = id;
    key = '';
    overrideKey = false;
    keyResult = null;
    modelResult = null;
    refreshResult = null;
  }
</script>

{#snippet piSetup()}
  {#if selected && !providerNoMatch}
    {#if configuration}
      <div class="pi-setup">
        <Accordion
          ><AccordionItem title={$t('assistant.settings.setup.title')} bind:open={setupOpen}>
            <ol class="setup-steps">
              <li>
                <p>{$t('assistant.settings.setup.runCommand')}</p>
                <CodeSnippet
                  light
                  type="multi"
                  code={configuration.setupCommand}
                  wrapText
                  showMoreLess={false}
                  minCollapsedNumberOfRows={0}
                  copyButtonDescription={$t('assistant.settings.setup.copyCommand')}
                  tooltipAlignment="end"
                  tooltipPosition="bottom"
                  codeLabel={$t('assistant.settings.setup.commandLabel')}
                  feedback={$t('common.status.copied')}
                  errorFeedback={$t('assistant.settings.setup.copyFailed')}
                />
              </li>
              <li>
                <p>{$t('assistant.settings.setup.login')}</p>
              </li>
              <li>
                <p>{$t('assistant.settings.setup.refreshHint')}</p>
                <Button
                  class="provider-refresh"
                  kind="tertiary"
                  size="small"
                  disabled={busy}
                  on:click={refresh}
                  >{$t(operation === 'refresh' ? 'assistant.settings.providers.refreshing' : 'assistant.settings.providers.refresh')}</Button
                >
              </li>
            </ol>
            {#if refreshResult && !selected.configured}<InlineNotification
                closeButtonDescription={$t('common.notification.close')}
                kind={refreshResult.kind}
                title={$t(refreshResult.title, refreshResult.values)}
                subtitle={refreshResult.detail ? $t(refreshResult.detail) : undefined}
                on:close={() => dismissResult('refresh')}
              />{/if}
            <div class="storage-note">
              <p>
                {$t(
                  configuration.shared
                    ? 'assistant.settings.profile.shared'
                    : 'assistant.settings.profile.own',
                  { path: configuration.directory },
                )}
              </p>
              {#if !configuration.shared}<p>
                  {$t('assistant.settings.profile.backupWarning')}
                </p>{/if}
            </div>
          </AccordionItem></Accordion
        >
      </div>
    {/if}
  {/if}
{/snippet}

<div class="agent-settings" bind:this={host}>
  {#if loading}<p role="status">{$t('assistant.settings.providers.loading')}</p>
  {:else if loadError}
    <InlineNotification
      closeButtonDescription={$t('common.notification.close')}
      kind="error"
      title={$t('assistant.errors.settingsUnavailable')}
      subtitle={$t(loadError)}
      hideCloseButton
    />
    <Button class="retry-providers" kind="tertiary" size="small" on:click={retry}
      >{$t('common.action.retry')}</Button
    >
  {:else}
    <div class="settings-group provider-group">
      <EditorChoice
        canOpenOnFocus={() => false}
        {onRequestClose}
        labelText={$t('assistant.settings.provider.label')}
        placeholder={$t('assistant.settings.provider.placeholder')}
        items={providerItems}
        bind:ref={providerInput}
        bind:open={providerOpen}
        selectedId={provider}
        bind:value={providerQuery}
        disabled={busy}
        clearFilterOnOpen
        filterResultsText={(count) => resultCount(count, $t, 'common.combobox.noMatches')}
        on:select={(event) => chooseProvider(String(event.detail.selectedId || ''))}
        on:clear={() => chooseProvider('')}
      />
      {#if providerNoMatch}<p role="status">{$t('common.combobox.noMatches')}</p>{:else if selected}<Tag
          type={selected.configured ? 'green' : 'gray'}
          >{$t(selected.configured ? 'assistant.settings.provider.configured' : 'assistant.settings.provider.notConfigured')}</Tag
        >{/if}
    </div>
    {#if selected && !providerNoMatch}
      {#if selected.apiKey || external || keyResult}<div class="settings-group key-group">
          {#if external}<p class="help-note">
              {$t(
                selected.credentialType === 'oauth'
                  ? 'assistant.settings.credentials.piSignIn'
                  : selected.credentialSource === 'environment'
                    ? "assistant.settings.credentials.environment"
                    : ['models_json_key', 'models_json_command'].includes(
                          selected.credentialSource || '',
                        )
                      ? "assistant.settings.credentials.modelsFile"
                      : 'assistant.settings.credentials.external',
              )}
            </p>{/if}
          {#if signedIn}<Button
              class="provider-sign-out"
              kind="danger-ghost"
              size="small"
              disabled={busy}
              on:click={() => requestRemoval('sign-out')}
              >{$t(operation === 'sign-out' ? 'assistant.settings.signOut.pending' : 'assistant.settings.signOut.action')}</Button
            >{/if}
          {#if selected.apiKey && external && !overrideKey}<Button
              class="key-override"
              kind="ghost"
              size="small"
              disabled={busy}
              on:click={() => {
                overrideKey = true;
                void tick().then(focusKey);
              }}>{$t(signedIn ? 'assistant.settings.apiKey.useInstead' : 'assistant.settings.apiKey.useDifferent')}</Button
            >{/if}
          {#if selected.apiKey && (!external || overrideKey)}
            <form
              data-escape-scope={overrideKey || key ? 'key-draft' : undefined}
              class="settings-group"
              onsubmit={(event) => {
                event.preventDefault();
                void action('save-key');
              }}
            >
              {#if configuration?.shared}<p class="help-note">
                  {$t('assistant.settings.apiKey.sharedProfile', {
                    path: configuration.directory,
                  })}
                </p>{/if}
              {#if signedIn}<p class="help-note">
                  {$t(
                    'assistant.settings.apiKey.replacesSignIn',
                  )}
                </p>{/if}
              <TextInput
                type="password"
                labelText={$t('assistant.settings.apiKey.label')}
                autocomplete="off"
                bind:value={key}
                on:input={() => (keyResult = null)}
                disabled={busy}
              />
              <p class="help-note">
                {$t(
                  'assistant.settings.apiKey.storageWarning',
                )}
              </p>
              <div class="inline-form-actions">
                <Button type="submit" size="small" disabled={busy || !key.trim()}
                  >{$t(
                    operation === 'save-key'
                      ? 'common.status.saving'
                      : selected.stored
                        ? 'assistant.settings.apiKey.replace'
                        : 'assistant.settings.apiKey.save',
                  )}</Button
                >
                {#if selected.stored}<Button
                    kind="danger-ghost"
                    size="small"
                    disabled={busy}
                    on:click={() => requestRemoval('remove-key')}
                    >{$t(operation === 'remove-key' ? 'assistant.settings.apiKey.removing' : 'assistant.settings.apiKey.remove')}</Button
                  >{/if}
                {#if external && overrideKey}<Button
                    kind="ghost"
                    size="small"
                    disabled={busy}
                    on:click={cancelOverride}>{$t('common.action.cancel')}</Button
                  >{/if}
              </div>
            </form>
          {/if}
          {#if selected.stored}<p class="help-note">
              {$t('assistant.settings.apiKey.removeHint')}
            </p>{/if}
          {#if keyResult}<InlineNotification
              closeButtonDescription={$t('common.notification.close')}
              kind={keyResult.kind}
              title={$t(keyResult.title, keyResult.values)}
              subtitle={keyResult.detail ? $t(keyResult.detail) : undefined}
              on:close={() => dismissResult('key')}
            />{/if}
          {#if selected.oauth && selected.apiKey && selected.credentialType !== 'oauth'}<Button
              kind="ghost"
              size="small"
              class="sign-in-link"
              disabled={busy}
              on:click={() => {
                setupOpen = true;
                void tick().then(() =>
                  host.querySelector<HTMLElement>('.pi-setup .bx--accordion__heading')?.focus(),
                );
              }}>{$t('assistant.settings.setup.useSignIn')}</Button
            >{/if}
        </div>{/if}
    {/if}
    {#if refreshResult && selected?.configured}<InlineNotification
        closeButtonDescription={$t('common.notification.close')}
        kind={refreshResult.kind}
        title={$t(refreshResult.title, refreshResult.values)}
        subtitle={refreshResult.detail ? $t(refreshResult.detail) : undefined}
        on:close={() => dismissResult('refresh')}
      />{/if}
    {#if setupFirst}{@render piSetup()}{/if}
    {#if availableModels.length || savedModel}
      <div class="settings-group model-group">
        <EditorChoice
          canOpenOnFocus={() => false}
          {onRequestClose}
          labelText={$t('assistant.settings.model.label')}
          placeholder={$t('assistant.settings.model.placeholder')}
          items={modelItems}
          bind:ref={modelInput}
          bind:open={modelOpen}
          selectedId={model}
          bind:value={modelQuery}
          disabled={busy}
          clearFilterOnOpen
          filterResultsText={(count) => resultCount(count, $t, 'common.combobox.noMatches')}
          on:select={(event) => {
            model = String(event.detail.selectedId || '');
            modelResult = null;
          }}
          on:blur={() => {
            if (!model && !modelQuery.trim()) {
              model = savedModel ? savedModel.provider + '/' + savedModel.id : automatic;
              modelQuery = modelItems.find((item) => item.id === model)?.text || '';
            }
          }}
        />
        {#if unavailableSaved?.id === model}<p class="help-note">
            {$t('assistant.settings.model.unconfigured')}
          </p>{/if}
        {#if model === automatic && resolvedAutomatic}<p class="help-note">
            {$t('assistant.settings.model.automaticUses', {
              provider:
                providers.find((p) => p.id === resolvedAutomatic!.provider)?.name ||
                resolvedAutomatic.provider,
              model: resolvedAutomatic.name,
            })}
          </p>{/if}
        {#if modelNoMatch}<p role="status">{$t('common.combobox.noMatches')}</p>{/if}
        <div class="inline-form-actions">
          <Button
            size="small"
            disabled={busy ||
              !modelChanged ||
              modelNoMatch ||
              (model !== automatic && !chosenModel)}
            on:click={() => action('model')}
            >{$t(operation === 'model' ? 'common.status.saving' : 'assistant.settings.model.save')}</Button
          >{#if testedModel && !modelNoMatch}<Button
              kind="tertiary"
              size="small"
              disabled={busy}
              on:click={() => action('test')}
              >{$t(operation === 'test' ? 'assistant.settings.model.testing' : 'assistant.settings.model.test')}</Button
            >{/if}
        </div>
        {#if modelResult}<InlineNotification
            closeButtonDescription={$t('common.notification.close')}
            kind={modelResult.kind}
            title={$t(modelResult.title)}
            subtitle={modelResult.detail ? $t(modelResult.detail) : undefined}
            on:close={() => dismissResult('model')}
          />{/if}
        {#if testedModel}<p class="help-note">
            {$t(
              'assistant.settings.model.testNotice',
            )}
          </p>{/if}
        <p class="help-note">
          {$t("assistant.settings.model.privacyNotice")}
        </p>
      </div>
    {:else if modelResult}<InlineNotification
        closeButtonDescription={$t('common.notification.close')}
        kind={modelResult.kind}
        title={$t(modelResult.title)}
        subtitle={modelResult.detail ? $t(modelResult.detail) : undefined}
        on:close={() => dismissResult('model')}
      />
    {/if}
    {#if !setupFirst}{@render piSetup()}{/if}
  {/if}
</div>
<Portal
  ><Modal
    open={confirmRemove}
    size="xs"
    danger
    modalHeading={$t(
      confirmation === 'sign-out' ? 'assistant.settings.signOut.confirmTitle' : 'assistant.settings.apiKey.removeConfirmTitle',
      { provider: selected?.name || '' },
    )}
    primaryButtonText={$t(confirmation === 'sign-out' ? 'assistant.settings.signOut.action' : 'assistant.settings.apiKey.remove')}
    secondaryButtonText={$t('common.action.cancel')}
    iconDescription={$t('common.action.close')}
    selectorPrimaryFocus=".bx--btn--secondary"
    on:close={() => (confirmRemove = false)}
    on:click:button--secondary={() => (confirmRemove = false)}
    on:submit={() => {
      confirmRemove = false;
      void action(confirmation);
    }}
  >
    <p>
      {$t(
        confirmation === 'sign-out'
          ? 'assistant.settings.signOut.confirmBody'
          : 'assistant.settings.apiKey.removeConfirmBody',
        { provider: selected?.name || '', path: configuration?.directory || '' },
      )}
    </p>
  </Modal></Portal
>

<style>
  .agent-settings {
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-width: 0;
  }
  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .agent-settings :global(.help-note),
  .agent-settings p {
    margin: 0;
  }
  .agent-settings :global(.bx--tag),
  .agent-settings :global(.provider-sign-out),
  .agent-settings :global(.key-override),
  .agent-settings :global(.retry-providers),
  .agent-settings :global(.sign-in-link) {
    align-self: flex-start;
  }
  /* Paired actions share one two-column grid across groups. */
  .agent-settings :global(.inline-form-actions) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .agent-settings :global(.inline-form-actions > .bx--btn) {
    max-width: none;
  }
  .agent-settings :global(.bx--inline-notification) {
    max-width: 100%;
    margin: 0;
  }
  .setup-steps {
    list-style: decimal;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .setup-steps li {
    padding-left: 4px;
  }
  .setup-steps p {
    font-size: 14px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    margin-bottom: 8px;
  }
  .pi-setup :global(.bx--snippet) {
    width: 100%;
    max-width: 100%;
  }
  .pi-setup :global(.bx--snippet-container pre) {
    padding: 0 40px 0 0;
    margin: 0;
    background: transparent;
  }
  .pi-setup :global(.bx--accordion__content) {
    padding-right: 0;
  }
  .storage-note p {
    font-size: 12px;
    line-height: 1.5;
  }
  .pi-setup :global(.bx--inline-notification) {
    margin-top: 8px;
  }
  .storage-note {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
    color: var(--cds-text-secondary);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  @media (pointer: coarse) {
    .agent-settings :global(.bx--btn),
    .agent-settings :global(.bx--accordion__heading),
    .agent-settings :global(.bx--copy-btn) {
      min-height: 44px;
    }
    .agent-settings :global(.bx--copy-btn) {
      min-width: 44px;
    }
  }
</style>
