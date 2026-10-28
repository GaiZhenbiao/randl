<script lang="ts">
  import { t } from './i18n';

  import { onMount, tick, type Snippet } from 'svelte';
  import { Button } from 'carbon-components-svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  let {
    anchor,
    title,
    onClose,
    children,
    width = 360,
  }: {
    anchor: HTMLElement;
    title: string;
    onClose: () => void;
    children: Snippet;
    width?: number;
  } = $props();
  let host: HTMLDivElement;
  onMount(() => {
    const place = () => {
      if (!anchor.isConnected) {
        onClose();
        return;
      }
      const rect = anchor.getBoundingClientRect(),
        size = Math.min(width, innerWidth - 24);
      host.style.width = size + 'px';
      host.style.left = Math.max(12, Math.min(innerWidth - size - 12, rect.left)) + 'px';
      host.style.top =
        Math.max(12, Math.min(innerHeight - host.offsetHeight - 12, rect.bottom + 4)) + 'px';
    };
    host.showPopover();
    place();
    (
      host.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea') ||
      host.querySelector<HTMLElement>('h3')
    )?.focus();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      if (
        anchor.isConnected &&
        (host.contains(document.activeElement) || document.activeElement === document.body)
      )
        anchor.focus();
    };
  });
</script>

<div
  class="context-popover"
  popover="auto"
  bind:this={host}
  role="dialog"
  aria-label={title}
  onfocusout={(event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !host.contains(next))
      void tick().then(() => {
        if (!host.contains(document.activeElement)) onClose();
      });
  }}
  ontoggle={(event) => {
    if ((event as ToggleEvent).newState === 'closed') onClose();
  }}
>
  <div class="popover-heading">
    <h3 tabindex="-1">{title}</h3>
    <Button
      kind="ghost"
      size="small"
      icon={Close}
      hideTooltip title={$t('common.action.close')} iconDescription={$t('common.action.close')}
      tooltipAlignment="end"
      tooltipPosition="left"
      portalTooltip
      on:click={onClose}
    />
  </div>
  {@render children()}
</div>
