<script lang="ts">
  import { Select, SelectItem, InlineNotification } from 'carbon-components-svelte';
  import {
    t,
    languages,
    languagePreference,
    browserLocale,
    setLanguage,
    type LanguagePreference,
    type Message,
  } from './i18n';
  let { compact = false }: { compact?: boolean } = $props();
  let busy = $state(false),
    error = $state<Message>('');
  const browser = browserLocale(navigator.languages);
  async function choose(event: Event) {
    busy = true;
    error = '';
    try {
      await setLanguage((event.target as HTMLSelectElement).value as LanguagePreference);
    } catch {
      error = 'app.settings.language.loadFailed';
    } finally {
      busy = false;
    }
  }
</script>

<Select
  labelText={$t('app.settings.language.label')}
  size={compact ? 'sm' : undefined}
  selected={$languagePreference}
  disabled={busy}
  on:change={choose}
>
  <SelectItem
    value="auto"
    text={$t('app.settings.language.browser', {
      language: languages.find((item) => item.id === browser)!.name,
    })}
  />
  {#each languages as language}<SelectItem value={language.id} text={language.name} />{/each}
</Select>
{#if error}<InlineNotification kind="error" title={$t(error)} on:close={() => (error = '')} />{/if}
