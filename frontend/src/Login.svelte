<script lang="ts">
  import { t, type Message } from './i18n';

  import { Button, PasswordInput, InlineNotification } from 'carbon-components-svelte';
  import { api, apiMessage } from './api';
  import LanguagePicker from './LanguagePicker.svelte';
  let { onSuccess }: { onSuccess: () => void } = $props();
  let key = $state(''),
    error = $state<Message>(''),
    busy = $state(false);
  async function login() {
    busy = true;
    error = '';
    try {
      await api('/api/auth/login', { key });
      key = '';
      onSuccess();
    } catch (e) {
      error = apiMessage(e);
    } finally {
      busy = false;
    }
  }
</script>

<main class="login-page">
  <form
    class="login-form"
    onsubmit={(event) => {
      event.preventDefault();
      void login();
    }}
  >
    <div class="login-brand">randl</div>
    <LanguagePicker compact />
    <h1>{$t('auth.signIn.title')}</h1>
    <p>{$t('auth.signIn.intro')}</p>
    <PasswordInput
      labelText={$t('auth.apiKey')}
      tooltipAlignment="end"
      hidePasswordLabel={$t('auth.hideKey')}
      showPasswordLabel={$t('auth.showKey')}
      bind:value={key}
      autocomplete="current-password"
      disabled={busy}
    />{#if error}<InlineNotification
        kind="error"
        title={$t('auth.signIn.failed')}
        subtitle={$t(error)}
        hideCloseButton
      />{/if}<Button type="submit" disabled={busy || !key}
      >{busy ? $t('auth.signIn.pending') : $t('auth.signIn.action')}</Button
    >
  </form>
</main>
