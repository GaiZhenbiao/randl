<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, InlineNotification, NumberInput, Toggle } from 'carbon-components-svelte';
  import { api, apiMessage } from './api';
  import { t, type Message } from './i18n';

  // Server settings, shared by every browser: whether runs are limited in logged media and
  // to how much (docs/storage.md#media-limit).
  type Limit = { enabled: boolean; megabytes: number };
  const max = 1024 * 1024;
  let saved = $state<Limit | undefined>(),
    enabled = $state(true),
    megabytes = $state<number | null>(null),
    busy = $state(false),
    done = $state(false),
    error = $state<Message>('');
  let valid = $derived(
    megabytes !== null && Number.isInteger(megabytes) && megabytes >= 1 && megabytes <= max,
  );
  let changed = $derived(
    !!saved && (enabled !== saved.enabled || (enabled && megabytes !== saved.megabytes)),
  );
  function show(limit: Limit) {
    saved = limit;
    enabled = limit.enabled;
    megabytes = limit.megabytes;
  }
  onMount(async () => {
    try {
      show((await api('/api/tools/settings_get', {})).mediaLimit);
    } catch {
      error = 'app.settings.mediaLimit.loadFailed';
    }
  });
  async function save() {
    busy = true;
    done = false;
    error = '';
    try {
      show(
        (
          await api('/api/tools/settings_update', {
            mediaLimit: enabled ? { enabled, megabytes } : { enabled },
          })
        ).mediaLimit,
      );
      done = true;
    } catch (failure) {
      error = apiMessage(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="form-stack storage-settings">
  <Toggle
    id="media-limit-enabled"
    labelText={$t('app.settings.mediaLimit.toggle')}
    labelA={$t('common.state.off')}
    labelB={$t('common.state.on')}
    disabled={!saved}
    bind:toggled={enabled}
    on:toggle={() => (done = false)}
  />
  <p class="bx--form__helper-text">{$t('app.settings.mediaLimit.help')}</p>
  {#if enabled}<NumberInput
      id="media-limit"
      labelText={$t('app.settings.mediaLimit.label')}
      min={1}
      {max}
      step={50}
      allowEmpty
      hideSteppers
      disabled={!saved}
      invalid={!!saved && !valid}
      invalidText={$t('app.settings.mediaLimit.invalid', { max })}
      bind:value={megabytes}
      on:input={() => (done = false)}
    />{/if}
  <div>
    <Button size="small" disabled={busy || !changed || (enabled && !valid)} on:click={save}
      >{$t('app.settings.mediaLimit.save')}</Button
    >
  </div>
  {#if done}<InlineNotification
      kind="success"
      lowContrast
      hideCloseButton
      title={$t(
        saved?.enabled ? 'app.settings.mediaLimit.saved' : 'app.settings.mediaLimit.savedOff',
      )}
    />{/if}{#if error}<InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={$t(error)}
    />{/if}
</div>
