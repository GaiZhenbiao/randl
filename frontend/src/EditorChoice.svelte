<script lang="ts">
  import { flushSync, onMount, tick } from 'svelte';
  import { ComboBox } from 'carbon-components-svelte';
  import { t } from './i18n';
  import { filterChoice, resultCount } from './ui';
  import type { ComponentProps } from 'svelte';
  type Props = ComponentProps<InstanceType<typeof ComboBox>> & {
    onRequestClose?: () => void;
    canOpenOnFocus?: () => boolean;
    clearSelectionId?: string;
  };
  let {
    items = [],
    selectedId = $bindable(),
    value = $bindable(''),
    open = $bindable(false),
    ref = $bindable<HTMLInputElement | null>(null),
    listRef = $bindable<HTMLDivElement | null>(null),
    virtualize,
    autoHighlight = 'first-match',
    clearSelectionId,
    onRequestClose = () => {},
    canOpenOnFocus = () => true,
    ...attributes
  }: Props = $props();
  let coarsePointer = $state(false);
  onMount(() => {
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => (coarsePointer = media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  });
  let host: HTMLDivElement;
  let focusingFromCaret = false;
  let resettingSelection = false;
  let keyboardNavigation = $state(false);
  function retainInputFocus(element: HTMLDivElement) {
    const click = async (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.bx--list-box__menu-icon') ||
        attributes.disabled ||
        attributes.readonly
      )
        return;
      await tick();
      focusingFromCaret = true;
      ref?.focus();
      focusingFromCaret = false;
    };
    let pointer: { x: number; y: number } | undefined;
    const move = (event: PointerEvent) => {
      const moved = !pointer || pointer.x !== event.clientX || pointer.y !== event.clientY;
      pointer = { x: event.clientX, y: event.clientY };
      if (!moved || event.pointerType === 'touch' || !keyboardNavigation) return;
      keyboardNavigation = false;
      const option =
        event.target instanceof Element ? event.target.closest('[role="option"]') : null;
      if (option && listRef?.contains(option)) option.dispatchEvent(new MouseEvent('mouseenter'));
    };
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof Node) || !listRef?.contains(event.target)) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!keyboardNavigation) return;
      keyboardNavigation = false;
      const option =
        event.target instanceof Element ? event.target.closest('[role="option"]') : null;
      if (option) option.dispatchEvent(new MouseEvent('mouseenter'));
    };
    const hover = (event: MouseEvent) => {
      if (keyboardNavigation && event.target instanceof Node && listRef?.contains(event.target))
        event.stopImmediatePropagation();
    };
    element.addEventListener('click', click, true);
    element.addEventListener('mouseenter', hover, true);
    element.addEventListener('mouseleave', hover, true);
    element.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('pointermove', move, true);
    return {
      destroy: () => {
        element.removeEventListener('click', click, true);
        element.removeEventListener('mouseenter', hover, true);
        element.removeEventListener('mouseleave', hover, true);
        element.removeEventListener('wheel', wheel, true);
        window.removeEventListener('pointermove', move, true);
      },
    };
  }
  let direction = $state<'top' | 'bottom'>('bottom'),
    menuHeight = $state(240),
    resetHighlight = $state(false);
  let restoringHighlight: Promise<void> | undefined;
  function activeOption() {
    const active = document.getElementById(ref?.getAttribute('aria-activedescendant') || '');
    if (!active || !listRef?.contains(active) || active.getAttribute('aria-disabled') === 'true')
      return null;
    const bounds = active.getBoundingClientRect();
    const menu = listRef.getBoundingClientRect();
    return bounds.bottom > menu.top && bounds.top < menu.bottom ? active : null;
  }
  function restoreAutomaticHighlight() {
    if (restoringHighlight) return restoringHighlight;
    if (!open || !value || autoHighlight !== 'first-match') return Promise.resolve();
    restoringHighlight = (async () => {
      resetHighlight = true;
      await tick();
      resetHighlight = false;
      await tick();
    })().finally(() => {
      restoringHighlight = undefined;
    });
    return restoringHighlight;
  }
  $effect(() => {
    if (!listRef) return;
    const list = listRef;
    const leave = async () => {
      await tick();
      // Filtering can shrink the list away from a stationary pointer.
      if (document.activeElement === ref && !activeOption()) await restoreAutomaticHighlight();
    };
    list.addEventListener('mouseleave', leave);
    return () => list.removeEventListener('mouseleave', leave);
  });
  function measure() {
    if (!ref || !host) return;
    const anchor = ref.closest<HTMLElement>('.bx--list-box')!;
    const bounds = anchor.getBoundingClientRect();
    const field =
      ref
        .closest<HTMLElement>('.metric-picker-field, .chip-choice-field')
        ?.getBoundingClientRect() || bounds;
    let top = 8,
      bottom = innerHeight - 8;
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) {
        const box = parent.getBoundingClientRect();
        top = Math.max(top, box.top + 4);
        bottom = Math.min(bottom, box.bottom - 4);
      }
      if (parent.matches(':popover-open')) break;
    }
    const above = Math.max(0, field.top - top - 4),
      below = Math.max(0, bottom - field.bottom - 4);
    direction = below >= 160 || below >= above ? 'bottom' : 'top';
    menuHeight = Math.max(1, Math.min(240, direction === 'top' ? above : below));
    host.style.setProperty(
      '--editor-menu-top',
      direction === 'bottom' ? field.bottom - bounds.top + 'px' : 'auto',
    );
    host.style.setProperty(
      '--editor-menu-bottom',
      direction === 'top' ? bounds.bottom - field.top + 'px' : 'auto',
    );
    host.style.setProperty('--editor-menu-width', field.width + 'px');
    host.style.setProperty('--editor-menu-left', field.left - bounds.left + 'px');
  }
  $effect(() => {
    if (!ref) return;
    const input = ref;
    const typing = async () => {
      keyboardNavigation = true;
      await tick();
      if (open && listRef) listRef.scrollTop = 0;
    };
    const beforeInput = () => {
      if (!open && attributes.clearFilterOnOpen && !attributes.readonly && !attributes.disabled)
        flushSync(() => {
          open = true;
        });
    };
    const keydown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) keyboardNavigation = true;
      if (event.isComposing || event.keyCode === 229) {
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === 'Enter' && open && !attributes.readonly) {
        const highlighted = document.getElementById(
          input.getAttribute('aria-activedescendant') || '',
        );
        if (
          highlighted &&
          listRef?.contains(highlighted) &&
          highlighted.getAttribute('aria-disabled') === 'true'
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const active = activeOption();
        if (active) {
          event.preventDefault();
          event.stopImmediatePropagation();
          active.click();
          return;
        }
        if (value && autoHighlight === 'first-match' && listRef?.querySelector('[role="option"]')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void restoreAutomaticHighlight().then(() => {
            if (open) activeOption()?.click();
          });
          return;
        }
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (open) {
        open = false;
        const selected = items.find((item) => item.id === selectedId);
        value = selected ? String(selected.text ?? selected.id) : '';
      } else onRequestClose();
    };
    input.addEventListener('keydown', keydown, true);
    input.addEventListener('input', typing, true);
    input.addEventListener('beforeinput', beforeInput, true);
    return () => {
      input.removeEventListener('keydown', keydown, true);
      input.removeEventListener('input', typing, true);
      input.removeEventListener('beforeinput', beforeInput, true);
    };
  });
  $effect(() => {
    if (!open || !ref) return;
    const reposition = () => {
      if (document.activeElement === ref)
        ref?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      measure();
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(host);
    const field = ref.closest('.metric-picker-field, .chip-choice-field');
    if (field) observer.observe(field);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', measure, true);
    };
  });
</script>

<div
  class="editor-choice"
  class:keyboard-navigation={keyboardNavigation}
  bind:this={host}
  use:retainInputFocus
>
  <ComboBox
    selectionClearedText={$t('common.combobox.selectionCleared')}
    filterResultsText={(count) => resultCount(count, $t)}
    shouldFilterItem={filterChoice}
    wrapOptions
    translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
    translateWithIdSelection={() => $t('common.combobox.clear')}
    {...attributes}
    size={coarsePointer ? 'lg' : attributes.size}
    {items}
    autoHighlight={resetHighlight ? 'none' : autoHighlight}
    bind:selectedId
    bind:value
    bind:open
    bind:ref
    bind:listRef
    {direction}
    portalMenu={false}
    virtualize={{
      ...(typeof virtualize === 'object' ? virtualize : {}),
      containerHeight: menuHeight,
    }}
    on:focus={() => {
      measure();
      if (
        !attributes.disabled &&
        !attributes.readonly &&
        !focusingFromCaret &&
        !resettingSelection &&
        canOpenOnFocus()
      )
        open = true;
    }}
    on:blur={(event) => {
      const next = event.relatedTarget as Node | null;
      if (!ref?.closest('.bx--list-box')?.contains(next) && !listRef?.contains(next)) open = false;
    }}
    on:select
    on:clear={async () => {
      if (clearSelectionId === undefined) return;
      resettingSelection = true;
      await tick();
      selectedId = clearSelectionId;
      open = false;
      await tick();
      const selected = items.find((item) => item.id === clearSelectionId);
      value = selected ? String(selected.text ?? selected.id) : '';
      resettingSelection = false;
    }}
    on:clear
    on:focus
    on:blur
    on:keydown
  />
</div>
