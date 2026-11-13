<script lang="ts">
  import { t } from './i18n';

  import { onMount, tick, untrack, type Snippet } from 'svelte';
  import { Button } from 'carbon-components-svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import SidebarResize from './SidebarResize.svelte';
  import { loadWidth } from './sidebar-width';
  let {
    id,
    title,
    onClose,
    children,
    footer,
  }: {
    /** Which drawer, for the width it is given (SidebarResize). */
    id: string;
    title: string;
    onClose: () => void;
    children: Snippet;
    footer?: Snippet;
  } = $props();
  let host: HTMLElement;
  let width = $state(1200);
  // The width it was dragged to, on the page so the shell beside it makes room (style.css).
  let drawerWidth = $state(untrack(() => loadWidth('drawer.' + id)));
  $effect(() => {
    const root = document.documentElement.style;
    if (drawerWidth) root.setProperty('--side-drawer-width', drawerWidth + 'px');
    return () => root.removeProperty('--side-drawer-width');
  });
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
      // Focus returns to what opened the drawer; when that is gone or hidden again (an item
      // of the phone's navigation menu), to App settings or the menu's button.
      void tick().then(() => {
        const shown = (element: HTMLElement | null) =>
          element?.isConnected &&
          element.checkVisibility({ visibilityProperty: true }) &&
          element.getBoundingClientRect().right > 0 &&
          !element.closest('[inert]')
            ? element
            : null;
        (
          shown(previous) ||
          shown(document.getElementById('app-settings')) ||
          document.querySelector<HTMLElement>('.bx--header__menu-trigger')
        )?.focus();
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
  {#if width > 760}<SidebarResize
      id={'drawer.' + id}
      label={$t('common.sidebar.resize')}
      min={320}
      width={() => host?.getBoundingClientRect().width ?? 400}
      max={() => Math.min(960, width - 480)}
      onresize={(next) => (drawerWidth = next)}
    />{/if}
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
