<script lang="ts">
  import { t, number, message, type Message } from './i18n';

  import ColorPicker from './ColorPicker.svelte';
  import {
    runURL,
    interceptLink,
    groupFieldLabel,
    groupTitle,
    groupValueLabel,
    orderGroups,
    statusLabel,
  } from './ui';
  import { OverflowMenu, OverflowMenuItem } from 'carbon-components-svelte';
  import { hoveredRuns, runFocus, setHoveredRuns } from './hover';
  import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import Pin from 'carbon-icons-svelte/lib/Pin.svelte';
  import PinFilled from 'carbon-icons-svelte/lib/PinFilled.svelte';
  import ViewIcon from 'carbon-icons-svelte/lib/View.svelte';
  import ViewFilled from 'carbon-icons-svelte/lib/ViewFilled.svelte';
  import ViewOff from 'carbon-icons-svelte/lib/ViewOff.svelte';
  import PlayFilled from 'carbon-icons-svelte/lib/PlayFilled.svelte';
  import PlayOutline from 'carbon-icons-svelte/lib/PlayOutline.svelte';
  import { onMount, tick, untrack } from 'svelte';
  import { color, resolvePaletteColor } from './run-colors';
  import type { Run } from './types';
  let {
    dark,
    runs,
    visible,
    solo,
    onchange,
    ondetails,
    comparison = true,
    activeId = '',
    colors = {},
    pinned = [],
    onaction,
    oncolor,
    groupBy = '',
    fieldValue = (run: Run, field: string) => (run as any)[field],
  }: {
    groupBy?: string;
    fieldValue?: (run: Run, field: string) => any;
    comparison?: boolean;
    activeId?: string;
    dark: boolean;
    colors?: Record<string, string>;
    pinned?: string[];
    onaction: (run: Run, action: string) => void;
    oncolor: (id: string, color: string | null) => void;
    runs: Run[];
    visible: string[];
    solo: string[];
    onchange: (visible: string[], solo: string[], feedback?: Message) => boolean;
    ondetails: (run: Run) => void;
  } = $props();
  // A hovered group can name tens of thousands of runs.
  let hovered = $derived(new Set($hoveredRuns));
  let list: HTMLDivElement;
  let colorRun = $state<Run | null>(null),
    colorAnchor = $state<HTMLElement | null>(null);
  function openColor(run: Run) {
    const anchor = list.querySelector<HTMLElement>('[data-color-id="' + CSS.escape(run.id) + '"]');
    if (anchor) {
      colorAnchor = anchor;
      colorRun = run;
    }
  }
  let viewportWidth = $state(1200);
  let hoverNone = $state(matchMedia('(hover: none)').matches);
  let openMenu = $state('');
  let menuMaxHeight = $state(320);
  function updateMenuHeight() {
    const button = list?.querySelector<HTMLElement>(
      '[data-run-id="' + CSS.escape(openMenu) + '"] [data-control="menu"]',
    );
    if (button) {
      const rect = button.getBoundingClientRect();
      menuMaxHeight = Math.max(rect.top, innerHeight - rect.bottom) - 8;
    }
  }
  function setMenu(run: string, open: boolean) {
    if (open) {
      openMenu = run;
      updateMenuHeight();
    } else if (openMenu === run) openMenu = '';
  }
  /** A finger, or the momentum scrolling it started, is moving the list. */
  let touchHeld = false,
    touchRelease = 0;
  let coarse = $state(matchMedia('(pointer: coarse)').matches);
  let rowHeight = $derived(viewportWidth <= 760 || coarse ? 48 : 36);
  let scroll = $state(0),
    height = $state(600),
    drag = $state<{
      kind: 'visible' | 'solo';
      value: boolean;
      seen: Set<string>;
      x: number;
      y: number;
    } | null>(null);
  // Raw: these arrays are replaced on every change, and deep proxies would track each entry.
  let localVisible = $state.raw<string[]>([]),
    localSolo = $state.raw<string[]>([]);
  $effect(() => {
    if (!drag) {
      const nextVisible = visible,
        nextSolo = solo;
      untrack(() => {
        localVisible = [...nextVisible];
        localSolo = [...nextSolo];
      });
    }
  });
  const visibleIds = $derived(new Set(localVisible));
  const soloIds = $derived(new Set(localSolo));
  function commitSelection(nextVisible: string[], nextSolo: string[], feedback?: Message) {
    if (!onchange(nextVisible, nextSolo, feedback)) {
      localVisible = [...visible];
      localSolo = [...solo];
    }
  }
  let collapsedGroups = $state<string[]>([]);
  type Entry =
    | { kind: 'run'; key: string; run: Run; index: number; lastPinned: boolean }
    | { kind: 'group'; key: string; label: string; name: string; ids: string[] };
  let entries = $derived.by(() => {
    if (!groupBy)
      return runs.map(
        (run, index) =>
          ({
            kind: 'run',
            key: run.id,
            run,
            index,
            lastPinned: pinned.includes(run.id) && !pinned.includes(runs[index + 1]?.id),
          }) as Entry,
      );
    const groups = new Map<
      string,
      { label: string; name: string; items: { run: Run; index: number }[] }
    >();
    runs.forEach((run, index) => {
      const value = fieldValue(run, groupBy),
        key = JSON.stringify(value ?? null);
      if (!groups.has(key))
        groups.set(key, {
          label: groupValueLabel(groupBy, value, $t),
          name: groupTitle(groupBy, value, $t),
          items: [],
        });
      groups.get(key)!.items.push({ run, index });
    });
    const result: Entry[] = [];
    for (const [key, group] of orderGroups(groupBy, [...groups])) {
      result.push({
        kind: 'group',
        key: 'group:' + key,
        label: group.label,
        name: group.name,
        ids: group.items.map((item) => item.run.id),
      });
      if (!collapsedGroups.includes(key)) {
        const items = [...group.items].sort(
          (a, b) => Number(pinned.includes(b.run.id)) - Number(pinned.includes(a.run.id)),
        );
        items.forEach((item, index) =>
          result.push({
            kind: 'run',
            key: item.run.id,
            ...item,
            lastPinned: pinned.includes(item.run.id) && !pinned.includes(items[index + 1]?.run.id),
          }),
        );
      }
    }
    return result;
  });
  async function pinRun(run: Run, control: string, keyboard: boolean) {
    if (keyboard) keyboardMove = true;
    const previousScroll = list.scrollTop;
    const previousIndex = entries.findIndex((entry) => entry.key === run.id);
    const blockedPin = !pinned.includes(run.id) && pinned.length >= 20;
    onaction(run, 'pin');
    await tick();
    if (keyboard || blockedPin) {
      focusedKey = run.id;
      focusedControl = keyboard ? control : 'name';
      const index = entries.findIndex((entry) => entry.key === run.id);
      if (
        index >= 0 &&
        (index * rowHeight < list.scrollTop ||
          (index + 1) * rowHeight > list.scrollTop + list.clientHeight)
      ) {
        scroll = Math.max(
          0,
          index * rowHeight - Math.min(rowHeight, Math.max(0, list.clientHeight - rowHeight)),
        );
        list.scrollTop = scroll;
        await tick();
      }
      if (keyboard) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      focusedKey = run.id;
      focusedControl = keyboard ? control : 'name';
      focusEntry(run.id, focusedControl);
      list
        .querySelector<HTMLElement>('[data-run-id="' + CSS.escape(run.id) + '"]')
        ?.scrollIntoView({ block: 'nearest' });
      if (keyboard) keyboardMove = false;
    } else {
      scroll = previousScroll;
      list.scrollTop = previousScroll;
      await tick();
      const index = entries.findIndex((entry) => entry.key === run.id);
      const first = Math.ceil(previousScroll / rowHeight);
      const last = Math.min(
        entries.length - 1,
        Math.floor((previousScroll + list.clientHeight) / rowHeight) - 1,
      );
      const target =
        index >= first && index <= last
          ? run.id
          : entries[Math.max(first, Math.min(last, previousIndex))]?.key;
      if (first <= last && target) focusEntry(target, 'name');
      else {
        focusedKey = entries[Math.floor(list.scrollTop / rowHeight)]?.key || '';
        focusedControl = 'name';
        list.focus({ preventScroll: true });
      }
    }
  }
  function toggleGroup(ids: string[], name: string) {
    const target = new Set(localVisible),
      on = !ids.every((id) => target.has(id));
    for (const id of ids) on ? target.add(id) : target.delete(id);
    localVisible = [...target];
    commitSelection(
      localVisible,
      localSolo,
      message(on ? 'runs.list.group.shown' : 'runs.list.group.hidden', { name }),
    );
  }

  let start = $derived(Math.max(0, Math.floor(scroll / rowHeight) - 5));
  let shown = $derived(entries.slice(start, start + Math.ceil(height / rowHeight) + 10));
  $effect(() => {
    if (
      $runFocus?.source === 'run-list' &&
      !$runFocus.ids.some((id) => shown.some((entry) => entry.key === id))
    )
      setHoveredRuns('run-list', []);
  });
  onMount(() => () => setHoveredRuns('run-list', []));
  onMount(() => {
    // Touch end events go to the touched node even after a re-render or virtualization removes
    // it, so they may never bubble to the window. Listen on that node, and treat any new
    // primary pointer as proof that earlier touches ended.
    let settling = false;
    const releaseTouch = (event: TouchEvent) => {
      if (!touchHeld || settling || event.touches.length) return;
      settling = true;
      const release = touchRelease;
      const native = 'onscrollend' in list;
      let moving = false,
        quiet: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        clearTimeout(quiet);
        list.removeEventListener('scroll', move);
        list.removeEventListener('scrollend', settle);
        if (release !== touchRelease) return;
        settling = false;
        touchHeld = false;
      };
      // Momentum scrolling after the finger lifts is part of the same gesture. It ends at
      // scrollend, or where that event is unsupported, once scrolling has paused.
      const move = () => {
        moving = true;
        if (native) return;
        clearTimeout(quiet);
        quiet = setTimeout(settle, 150);
      };
      list.addEventListener('scroll', move, { passive: true });
      if (native) list.addEventListener('scrollend', settle);
      requestAnimationFrame(() => requestAnimationFrame(() => !moving && settle()));
    };
    const pressPointer = (event: PointerEvent) => {
      touchRelease++;
      settling = false;
      if (event.pointerType !== 'touch') {
        touchHeld = false;
        return;
      }
      const inside = list.contains(event.target as Node);
      if (event.isPrimary) touchHeld = inside;
      else if (inside) touchHeld = true;
      if (!touchHeld) return;
      for (const type of ['touchend', 'touchcancel'])
        event.target?.addEventListener(type, releaseTouch as EventListener, {
          once: true,
          passive: true,
        });
    };
    window.addEventListener('pointerdown', pressPointer, { capture: true });
    window.addEventListener('touchend', releaseTouch, { passive: true });
    window.addEventListener('touchcancel', releaseTouch, { passive: true });
    const hoverQuery = matchMedia('(hover: none)');
    const updateHover = () => (hoverNone = hoverQuery.matches);
    hoverQuery.addEventListener('change', updateHover);
    let observedRowHeight = rowHeight;
    const resize = new ResizeObserver(() => {
      const nextHeight = list.clientHeight;
      if (nextHeight === height && observedRowHeight === rowHeight) return;
      const focused = document.activeElement;
      const owned = list.contains(focused);
      const containerFocused = focused === list;
      const key = focusedKey,
        control = focusedControl;
      observedRowHeight = rowHeight;
      height = nextHeight;
      scroll = list.scrollTop;
      if (!owned || keyboardMove) {
        if (openMenu) void tick().then(scrolled);
        return;
      }
      layoutMove = true;
      const stillOwned = () =>
        document.activeElement === focused ||
        document.activeElement === list ||
        (!focused?.isConnected && document.activeElement === document.body);
      void tick()
        .then(async () => {
          if (!stillOwned() || keyboardMove) return;
          if (containerFocused || height < rowHeight || touchHeld || drag) {
            if (!focused?.isConnected && document.activeElement === document.body)
              list.focus({ preventScroll: true });
            layoutMove = false;
            scrolled();
            if (!touchHeld && !drag) requestAnimationFrame(revealFocusedRowInDrawer);
            return;
          }
          const index = entries.findIndex((entry) => entry.key === key);
          if (index < 0) return;
          list.scrollTop = Math.max(
            0,
            Math.min(
              index * rowHeight,
              Math.max(list.scrollTop, (index + 1) * rowHeight - list.clientHeight),
            ),
          );
          scroll = list.scrollTop;
          await tick();
          if (!stillOwned() || keyboardMove) return;
          focusedKey = key;
          focusedControl = control;
          focusEntry(key, control);
          revealFocusedRowInDrawer();
        })
        .finally(() => {
          layoutMove = false;
        });
    });
    resize.observe(list);
    return () => {
      resize.disconnect();
      cancelPendingTouch();
      hoverQuery.removeEventListener('change', updateHover);
      window.removeEventListener('pointerdown', pressPointer, { capture: true });
      window.removeEventListener('touchend', releaseTouch);
      window.removeEventListener('touchcancel', releaseTouch);
      drag = null;
    };
  });
  function toggle(kind: 'visible' | 'solo', id: string, value?: boolean) {
    const set = new Set(kind === 'visible' ? localVisible : localSolo);
    const on = value ?? !set.has(id);
    if (on) set.add(id);
    else set.delete(id);
    if (kind === 'visible') localVisible = [...set];
    else localSolo = [...set];
  }
  function paint(target: Element | null) {
    const button = target?.closest<HTMLButtonElement>('[data-toggle]');
    if (!drag || !button || button.dataset.toggle !== drag.kind) return;
    const id = button.dataset.id!;
    if (drag.seen.has(id)) return;
    drag.seen.add(id);
    toggle(drag.kind, id, drag.value);
  }
  function frame() {
    if (!drag) return;
    const rect = list.getBoundingClientRect();
    if (drag.y < rect.top + 25) list.scrollTop -= 8;
    else if (drag.y > rect.bottom - 25) list.scrollTop += 8;
    paint(document.elementFromPoint(drag.x, drag.y));
    requestAnimationFrame(frame);
  }
  /**
   * A finger on a toggle either taps it or scrolls the list. The toggle has `touch-action: pan-y`,
   * so the browser takes any finger movement as a scroll (measured in Chromium: it cancels the
   * pointer and sends no cancelable touchmove), and a finger cannot paint across rows. Toggle
   * on release, and only when the finger has not moved.
   */
  let pendingTouch: { kind: 'visible' | 'solo'; id: string; x: number; y: number } | null = null;
  const touchSlop = 8;
  // A tap's synthesized click can report detail 0, like a keyboard click; ignore it.
  let touchToggledAt = 0;
  function cancelPendingTouch() {
    pendingTouch = null;
  }
  function begin(event: PointerEvent, kind: 'visible' | 'solo', id: string) {
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') {
      pendingTouch = { kind, id, x: event.clientX, y: event.clientY };
      return;
    }
    event.preventDefault();
    startDrag(kind, id, event.clientX, event.clientY, event.target as Element);
  }
  function startDrag(kind: 'visible' | 'solo', id: string, x: number, y: number, target: Element) {
    drag = {
      kind,
      value: !(kind === 'visible' ? visibleIds : soloIds).has(id),
      seen: new Set(),
      x,
      y,
    };
    paint(target.isConnected ? target : document.elementFromPoint(x, y));
    requestAnimationFrame(frame);
  }
  function end(event?: PointerEvent) {
    if (pendingTouch) {
      const pending = pendingTouch;
      cancelPendingTouch();
      // A tap: lifted before the hold time without moving.
      if (event?.type === 'pointerup') {
        touchToggledAt = performance.now();
        toggle(pending.kind, pending.id);
        commitSelection(localVisible, localSolo);
      }
      return;
    }
    if (!drag) return;
    const v = [...localVisible],
      s = [...localSolo];
    drag = null;
    commitSelection(v, s);
  }
  let focusedControl = $state('name');
  let focusOwned = $state(false);
  $effect(() => {
    if (hoverNone && viewportWidth <= 390 && focusedControl === 'pin') {
      focusedControl = 'name';
      if (focusOwned) void tick().then(() => focusEntry(focusedKey, 'name'));
    }
  });
  const tabControl = (key: string, control: string, group = false) => {
    const unavailable =
      (!comparison && ['visible', 'solo'].includes(focusedControl)) ||
      (group && focusedControl !== 'visible') ||
      (focusedControl === 'pin' &&
        ((!pinned.includes(key) && pinned.length >= 20) || (hoverNone && viewportWidth <= 390)));
    return key === tabKey && control === (unavailable ? 'name' : focusedControl) ? 0 : -1;
  };
  function focusEntry(key: string, control = focusedControl) {
    const row = list.querySelector<HTMLElement>('[data-entry-key="' + CSS.escape(key) + '"]');
    const target =
      row?.querySelector<HTMLElement>('[data-control="' + control + '"]') ||
      row?.querySelector<HTMLElement>('[data-control="name"]');
    if (target && getComputedStyle(target).visibility === 'hidden')
      row?.querySelector<HTMLElement>('[data-control="name"]')?.focus({ preventScroll: true });
    target?.focus({ preventScroll: true });
  }
  function revealFocusedRowInDrawer() {
    if (
      touchHeld ||
      drag ||
      keyboardMove ||
      viewportWidth > 760 ||
      !list.contains(document.activeElement)
    )
      return;
    const row =
      document.activeElement === list
        ? list
        : document.activeElement?.closest<HTMLElement>('[data-entry-key]');
    const sidebar = list.closest<HTMLElement>('.run-sidebar');
    if (!row || !sidebar) return;
    const r = row.getBoundingClientRect(),
      l = list.getBoundingClientRect(),
      s = sidebar.getBoundingClientRect();
    const top = Math.max(r.top, l.top),
      bottom = Math.min(r.bottom, l.bottom);
    const heading = sidebar.querySelector<HTMLElement>('.runs-heading')?.offsetHeight || 0;
    if (bottom <= top) return;
    if (bottom > s.bottom) sidebar.scrollTop += bottom - s.bottom;
    else if (top < s.top + heading) sidebar.scrollTop -= s.top + heading - top;
  }
  let focusedKey = $state(''),
    keyboardMove = false,
    layoutMove = false;
  let tabKey = $derived(
    shown.some((entry) => entry.key === focusedKey) ? focusedKey : shown[0]?.key,
  );
  function keyboard(event: KeyboardEvent) {
    if (
      ![
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageDown',
        'PageUp',
      ].includes(event.key)
    )
      return;
    const row =
      (event.target as HTMLElement).closest<HTMLElement>('[data-entry-key]') ||
      (event.target === list
        ? list.querySelector<HTMLElement>('[data-entry-key="' + CSS.escape(focusedKey) + '"]')
        : null);
    if (!row) return;
    const controls = [...row.querySelectorAll<HTMLElement>('button,a[href]')].filter(
        (control) => control.getClientRects().length && !control.hasAttribute('disabled'),
      ),
      column = controls.findIndex((control) =>
        event.target === list
          ? control.dataset.control === focusedControl
          : control === event.target,
      );
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      controls[
        Math.max(0, Math.min(controls.length - 1, column + (event.key === 'ArrowRight' ? 1 : -1)))
      ]?.focus();
      row.scrollIntoView({ block: 'nearest' });
      return;
    }
    const current = entries.findIndex(
      (entry) => entry.key === (keyboardMove ? focusedKey : row.dataset.entryKey),
    );
    const jump = Math.max(1, Math.floor(height / rowHeight) - 1);
    const next = Math.max(
      0,
      Math.min(
        entries.length - 1,
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? entries.length - 1
            : current +
              (event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowUp'
                  ? -1
                  : event.key === 'PageDown'
                    ? jump
                    : -jump),
      ),
    );
    if (next === current) return;
    event.preventDefault();
    event.stopPropagation();
    keyboardMove = true;
    focusedKey = entries[next].key;
    if (event.shiftKey && (event.target as HTMLElement).dataset.toggle) {
      const kind = (event.target as HTMLElement).dataset.toggle as 'visible' | 'solo';
      const entry = entries[current];
      if (entry?.kind === 'run') {
        const value = (kind === 'visible' ? visibleIds : soloIds).has(entry.run.id);
        for (let i = Math.min(current, next); i <= Math.max(current, next); i++) {
          const nextEntry = entries[i];
          if (nextEntry.kind === 'run') toggle(kind, nextEntry.run.id, value);
        }
        commitSelection(localVisible, localSolo);
      }
    }
    list.scrollTop = Math.max(0, next * rowHeight - Math.max(0, (height - rowHeight) / 2));
    requestAnimationFrame(() => {
      focusEntry(focusedKey);
      list
        .querySelector<HTMLElement>('[data-entry-key="' + CSS.escape(focusedKey) + '"]')
        ?.scrollIntoView({ block: 'nearest' });
      keyboardMove = false;
    });
  }
  function scrolled() {
    // ResizeObserver updates offset and height together to keep the last row focused.
    if (list.clientHeight !== height) {
      updateMenuHeight();
      return;
    }
    const focused = document.activeElement as HTMLElement,
      own = list.contains(focused),
      row = focused.closest<HTMLElement>('[data-entry-key]');
    scroll = list.scrollTop;
    if (openMenu && !shown.some((entry) => entry.key === openMenu)) {
      openMenu = '';
      const first = Math.ceil(scroll / rowHeight);
      const fits = (first + 1) * rowHeight <= scroll + height;
      focusedKey = entries[fits ? first : Math.floor(scroll / rowHeight)]?.key || '';
      focusedControl = 'name';
      tick().then(() => {
        if (fits) focusEntry(focusedKey, 'name');
        else list.focus({ preventScroll: true });
      });
      return;
    }
    updateMenuHeight();
    if (
      own &&
      !keyboardMove &&
      !layoutMove &&
      list.clientHeight === height &&
      (row || focused === list)
    ) {
      const index = entries.findIndex(
        (entry) => entry.key === (row?.dataset.entryKey || focusedKey),
      );
      const first = Math.ceil(scroll / rowHeight);
      const last = Math.min(entries.length - 1, Math.floor((scroll + height) / rowHeight) - 1);
      if (
        (focused === list && first <= last) ||
        (index + 1) * rowHeight <= scroll ||
        index * rowHeight >= scroll + height
      ) {
        focusedKey =
          entries[
            first <= last ? Math.max(first, Math.min(last, index)) : Math.floor(scroll / rowHeight)
          ]?.key || '';
        requestAnimationFrame(() => {
          if (first <= last) focusEntry(focusedKey);
          else list.focus({ preventScroll: true });
        });
      }
    }
  }
</script>

<svelte:window
  bind:innerWidth={viewportWidth}
  onresize={() =>
    requestAnimationFrame(() => {
      updateMenuHeight();
      revealFocusedRowInDrawer();
    })}
  onfocusin={(event) => {
    if (!list?.contains(event.target as Node)) focusOwned = false;
  }}
  onpointerdown={(event) => {
    if (!list?.contains(event.target as Node)) focusOwned = false;
  }}
  onpointermove={(event) => {
    if (
      pendingTouch &&
      Math.hypot(event.clientX - pendingTouch.x, event.clientY - pendingTouch.y) > touchSlop
    )
      cancelPendingTouch();
    if (drag) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      paint(document.elementFromPoint(drag.x, drag.y));
    }
  }}
  onpointerup={end}
  onpointercancel={end}
  onblur={() => {
    end();
    focusOwned = false;
  }}
/>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Roving keyboard navigation delegates to native row controls.) -->
<div
  id="run-list"
  tabindex="-1"
  bind:this={list}
  onscroll={scrolled}
  onkeydown={keyboard}
  onfocusin={(event) => {
    focusOwned = true;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-key]');
    if (row) {
      focusedKey = row.dataset.entryKey!;
      if (!keyboardMove) focusedControl = (event.target as HTMLElement).dataset.control || 'name';
    }
  }}
  role="list"
  aria-label={$t('runs.list.label')}
>
  <div style:height={`${entries.length * rowHeight}px`}></div>
  <div id="run-rows" style:transform={`translateY(${start * rowHeight}px)`}>
    {#each shown as entry, i (entry.key)}{#if entry.kind === 'group'}{@const key =
          entry.key.slice(6)}
        <div
          class="run-group"
          class:browse={!comparison}
          data-entry-key={entry.key}
          style:height={rowHeight + 'px'}
          role="listitem"
        >
          {#if comparison}{@const shownCount = entry.ids.filter((id) =>
              visibleIds.has(id),
            ).length}<button
              class="toggle"
              class:solo-overridden={localSolo.length > 0}
              tabindex={tabControl(entry.key, 'visible', true)}
              data-control="visible"
              aria-label={$t('runs.list.group.visibility', { name: entry.name })}
              aria-pressed={shownCount === entry.ids.length ? true : shownCount ? 'mixed' : false}
              onclick={() => toggleGroup(entry.ids, entry.name)}
              >{#if shownCount === entry.ids.length}<ViewFilled
                  size={16}
                />{:else if shownCount}<ViewIcon size={16} />{:else}<ViewOff
                  size={16}
                />{/if}</button
            ><span class="solo-spacer"></span>{/if}
          <button
            class="group-collapse"
            tabindex={tabControl(entry.key, 'name', true)}
            data-control="name"
            aria-label={$t(
              collapsedGroups.includes(key) ? 'runs.list.group.expand' : 'runs.list.group.collapse',
              { name: entry.name },
            )}
            aria-expanded={!collapsedGroups.includes(key)}
            onclick={() =>
              (collapsedGroups = collapsedGroups.includes(key)
                ? collapsedGroups.filter((k) => k !== key)
                : [...collapsedGroups, key])}
            >{#if collapsedGroups.includes(key)}<ChevronRight size={16} />{:else}<ChevronDown
                size={16}
              />{/if}</button
          ><span class="group-label" title={entry.name} data-value={entry.label}
            ><span class="group-field">{groupFieldLabel(groupBy, $t)}</span><span
              class="group-value">{entry.label}</span
            ></span
          ><span class="group-count">{$number(entry.ids.length)}</span>
        </div>{:else}{@const run = entry.run}
        <div
          class="run-row"
          data-entry-key={entry.key}
          data-run-id={run.id}
          class:browse={!comparison}
          class:last-pinned={entry.lastPinned}
          class:highlighted={hovered.has(run.id) || activeId === run.id}
          onmouseenter={() => setHoveredRuns('run-list', [run.id])}
          onmouseleave={() => setHoveredRuns('run-list', [])}
          style:height={rowHeight + 'px'}
          class:dim={comparison &&
            (localSolo.length ? !soloIds.has(run.id) : !visibleIds.has(run.id))}
          role="listitem"
          aria-posinset={start + i + 1}
          aria-setsize={entries.length}
        >
          {#if comparison}{#each ['visible', 'solo'] as kind}<button
                type="button"
                class={'toggle' +
                  (kind === 'solo' ? ' solo' : '') +
                  (kind === 'visible' && localSolo.length ? ' solo-overridden' : '')}
                tabindex={tabControl(entry.key, kind)}
                data-control={kind}
                data-toggle={kind}
                data-id={run.id}
                data-index={entry.index}
                aria-label={$t(kind === 'solo' ? 'runs.list.soloFor' : 'runs.list.visibilityFor', {
                  name: run.display_name,
                })}
                aria-pressed={(kind === 'solo' ? soloIds : visibleIds).has(run.id)}
                title={$t(kind === 'solo' ? 'runs.list.solo' : 'runs.list.visibility')}
                onpointerdown={(event) => begin(event, kind as 'visible' | 'solo', run.id)}
                onclick={(event) => {
                  if (event.detail === 0 && performance.now() - touchToggledAt > 600) {
                    toggle(kind as 'visible' | 'solo', run.id);
                    commitSelection(localVisible, localSolo);
                  }
                }}
                >{#if kind === 'solo'}{#if soloIds.has(run.id)}<PlayFilled
                      size={16}
                    />{:else}<PlayOutline
                      size={16}
                    />{/if}{:else if visibleIds.has(run.id)}<ViewFilled size={16} />{:else}<ViewOff
                    size={16}
                  />{/if}</button
              >{/each}{/if}

          <button
            class="run-color-button"
            tabindex={tabControl(entry.key, 'color')}
            data-control="color"
            data-color-id={run.id}
            aria-label={$t('runs.color.changeFor', { name: run.display_name })}
            title={$t('runs.color.change')}
            onclick={() => openColor(run)}
            ><span
              class="run-color"
              style:background={resolvePaletteColor(color(run.id, colors), dark)}
            ></span></button
          ><a
            tabindex={tabControl(entry.key, 'name')}
            data-control="name"
            aria-current={activeId === run.id ? 'page' : undefined}
            class="run-name"
            href={runURL(run)}
            title={run.display_name + ' · ' + statusLabel(run.state, $t)}
            onclick={(event) => interceptLink(event, () => ondetails(run))}
            ><strong
              >{#if pinned.includes(run.id)}<span
                  class="run-pinned-indicator"
                  role="img"
                  aria-label={$t('runs.pin.pinned')}
                  title={$t('runs.pin.pinned')}><PinFilled size={12} /></span
                >{/if}<span class="run-display-name">{run.display_name}</span
              >{#if run.state === 'running'}<span class="running-name-dot" aria-hidden="true"
                ></span>{/if}</strong
            ><small>{statusLabel(run.state, $t)} · {run.name}</small></a
          >
          <div class="run-menu">
            <OverflowMenu
              tabindex={tabControl(entry.key, 'menu')}
              data-control="menu"
              size="sm"
              flipped
              portalMenu
              menuOptionsClass="run-actions-menu"
              maxHeight={menuMaxHeight}
              bind:open={() => openMenu === run.id, (open) => setMenu(run.id, open)}
              aria-label={$t('runs.list.runActions', { name: run.display_name })}
              iconDescription={$t('runs.list.runActions', { name: run.display_name })}
              ><OverflowMenuItem
                text={$t('runs.actions.open')}
                on:click={() => ondetails(run)}
              /><OverflowMenuItem
                text={$t('runs.actions.showInCharts')}
                on:click={() => onaction(run, 'compare')}
              /><OverflowMenuItem
                text={pinned.includes(run.id) ? $t('runs.pin.unpin') : $t('runs.pin.pin')}
                on:click={(event) => pinRun(run, 'menu', event.detail.detail === 0)}
              /><OverflowMenuItem
                text={$t('runs.actions.changeColor')}
                on:click={() => openColor(run)}
              /><OverflowMenuItem
                text={$t('runs.actions.rename')}
                on:click={() => onaction(run, 'rename')}
              />{#if run.state === 'running'}<OverflowMenuItem
                  text={run.snapshot_at != null
                    ? $t('runs.snapshot.cannotStop')
                    : run.stop_requested
                      ? $t('runs.stop.requested')
                      : $t('runs.actions.stop')}
                  disabled={run.snapshot_at != null || !!run.stop_requested}
                  on:click={() => onaction(run, 'stop')}
                />{/if}<OverflowMenuItem
                text={$t('runs.actions.copyId')}
                on:click={() => onaction(run, 'copy-id')}
              /><OverflowMenuItem
                text={$t('runs.actions.copyLink')}
                on:click={() => onaction(run, 'copy-link')}
              /><OverflowMenuItem
                text={$t('runs.actions.delete')}
                danger
                hasDivider
                on:click={() => onaction(run, 'delete')}
              /></OverflowMenu
            >
          </div>
          <button
            type="button"
            class="run-pin"
            class:pinned={pinned.includes(run.id)}
            data-control="pin"
            tabindex={tabControl(entry.key, 'pin')}
            aria-label={$t('runs.pin.pinName', { name: run.display_name })}
            title={$t(
              !pinned.includes(run.id) && pinned.length >= 20
                ? 'runs.pin.limit'
                : pinned.includes(run.id)
                  ? 'runs.pin.unpin'
                  : 'runs.pin.pin',
            )}
            aria-pressed={pinned.includes(run.id)}
            disabled={!pinned.includes(run.id) && pinned.length >= 20}
            onclick={(event) => pinRun(run, 'pin', event.detail === 0)}
            >{#if pinned.includes(run.id)}<PinFilled size={16} />{:else}<Pin
                size={16}
              />{/if}</button
          >
        </div>{/if}{/each}
  </div>
</div>

{#if colorRun && colorAnchor}<ColorPicker
    {dark}
    anchor={colorAnchor}
    value={color(colorRun.id, colors)}
    name={colorRun.display_name}
    onChange={(value) => oncolor(colorRun!.id, value)}
    onClose={() => {
      colorRun = null;
      colorAnchor = null;
    }}
  />{/if}

<style>
</style>
