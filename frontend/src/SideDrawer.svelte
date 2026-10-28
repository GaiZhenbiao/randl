<script lang="ts">
  import { t } from './i18n';

  import { onMount, tick, type Snippet } from 'svelte';
  import { Button } from 'carbon-components-svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  let {
    title,
    onClose,
    children,
    footer,
  }: { title: string; onClose: () => void; children: Snippet; footer?: Snippet } = $props();
  let host: HTMLElement;
  let width = $state(1200);
  const available = (element: HTMLElement) =>
    element.offsetParent !== null &&
    getComputedStyle(element).visibility === 'visible' &&
    !element.hasAttribute('disabled');
  onMount(() => {
    const previous = document.activeElement as HTMLElement;
    (
      [
        ...host.querySelectorAll<HTMLElement>(
          '.side-drawer-content input,.side-drawer-content select,.side-drawer-content textarea',
        ),
      ].find(available) || host.querySelector<HTMLElement>('h2')
    )?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.key !== 'Escape' ||
        document.querySelector(':popover-open') ||
        document.querySelector('.bx--modal.is-visible') ||
        (event.target instanceof Element && event.target.closest('[data-escape-scope]')) ||
        host.querySelector('[role="combobox"][aria-expanded="true"], .cds--list-box--expanded')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      void tick().then(() => {
        if (previous?.isConnected) previous.focus();
        else document.getElementById('app-settings')?.focus();
      });
    };
  });
</script>

<svelte:window
  bind:innerWidth={width}
  onkeydown={(event) => {
    if (width <= 760 && event.key === 'Tab' && !document.querySelector('.bx--modal.is-visible')) {
      const items = [
          ...host.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex="0"]'),
        ]
          .filter(available)
          .filter(
            (element, _, visible) =>
              !(element instanceof HTMLInputElement) ||
              element.type !== 'radio' ||
              !element.name ||
              element.checked ||
              !visible.some(
                (other) =>
                  other instanceof HTMLInputElement &&
                  other.type === 'radio' &&
                  other.name === element.name &&
                  other.form === element.form &&
                  other.checked,
              ),
          ),
        first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }}
/>
<div
  class="side-drawer"
  bind:this={host}
  role="dialog"
  aria-label={title}
  aria-modal={width <= 760 ? true : undefined}
>
  <header class="side-drawer-heading">
    <h2 tabindex="-1">{title}</h2>
    <Button
      kind="ghost"
      size="small"
      icon={Close}
      hideTooltip
      title={$t('common.action.close')}
      iconDescription={$t('common.action.close')}
      tooltipAlignment="end"
      tooltipPosition="left"
      portalTooltip
      on:click={onClose}
    />
  </header>
  <div class="side-drawer-content">{@render children()}</div>
  {#if footer}<footer class="side-drawer-footer">{@render footer()}</footer>{/if}
</div>
