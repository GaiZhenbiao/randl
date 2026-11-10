<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, InlineNotification, NumberInput } from 'carbon-components-svelte';
  import { api, apiMessage } from './api';
  import { t, type Message } from './i18n';

  // Server settings, shared by every browser: the most media a run keeps
  // (docs/storage.md#media-limit).
  const max = 1024 * 1024;
  let saved = $state<number | undefined>(),
    value = $state<number | null>(null),
    busy = $state(false),
    done = $state(false),
    error = $state<Message>('');
  let valid = $derived(value !== null && Number.isInteger(value) && value >= 0 && value <= max);
  onMount(async () => {
    try {
      saved = value = (await api('/api/tools/settings_get', {})).mediaLimitMB;
    } catch {
      error = 'app.settings.mediaLimit.loadFailed';
    }
  });
  async function save() {
    busy = true;
    done = false;
    error = '';
    try {
      saved = (await api('/api/tools/settings_update', { mediaLimitMB: value })).mediaLimitMB;
      done = true;
    } catch (failure) {
      error = apiMessage(failure);
    } finally {
      busy = false;
    }
  }
</script>

<div class="form-stack storage-settings">
  <NumberInput
    id="media-limit"
    labelText={$t('app.settings.mediaLimit.label')}
    helperText={$t('app.settings.mediaLimit.help')}
    min={0}
    {max}
    step={50}
    allowEmpty
    hideSteppers
    disabled={saved === undefined}
    invalid={saved !== undefined && !valid}
    invalidText={$t('app.settings.mediaLimit.invalid', { max })}
    bind:value
    on:input={() => (done = false)}
  />
  <div>
    <Button
      size="small"
      disabled={busy || !valid || value === saved}
      on:click={save}>{$t('app.settings.mediaLimit.save')}</Button
    >
  </div>
  {#if done}<InlineNotification
      kind="success"
      lowContrast
      hideCloseButton
      title={$t('app.settings.mediaLimit.saved')}
    />{/if}{#if error}<InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={$t(error)}
    />{/if}
</div>
