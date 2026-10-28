<script lang="ts">
  import { t } from './i18n';

  import Draggable from 'carbon-icons-svelte/lib/Draggable.svelte';
  import Settings from 'carbon-icons-svelte/lib/Settings.svelte';
  import { tick, untrack, type Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import {
    Button,
    OverflowMenu,
    OverflowMenuItem,
    TextInput,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import ChevronLeft from 'carbon-icons-svelte/lib/ChevronLeft.svelte';
  import PanelCard from './Panel.svelte';
  import PanelTools from './PanelTools.svelte';
  import { columnLimit, columnsFor, cardWidth } from './section-layout';
  import type { Run, View, Panel, Plugin, PlotSettings, SectionLayout, Section } from './types';
  import { resolvePlotSettings } from './plot-settings';
  let {
    view,
    canvasWidth,
    colors = {},
    focusPanel = '',
    noMatchingRuns = false,
    hasRuns,
    runs,
    plugins,
    dark,
    onAdd,
    onEdit,
    onPanelSettings,
    onRemove,
    onDuplicate,
    onResize,
    onSection,
    onReorder,
    onLayout,
    onDefaults,
    onConnect,
    leading,
    below,
    search = $bindable(''),
    tools = true,
  }: {
    leading?: Snippet;
    below?: Snippet;
    search?: string;
    tools?: boolean;
    view: View | null;
    canvasWidth: number;
    colors?: Record<string, string>;
    focusPanel?: string;
    noMatchingRuns?: boolean;
    hasRuns: boolean;
    runs: Run[];
    plugins: Plugin[];
    dark: boolean;
    onAdd: (section?: string) => void;
    onEdit: (p: Panel) => void;
    /** Saves settings changed in a panel itself, at the panel layer. */
    onPanelSettings: (id: string, settings: PlotSettings) => void;
    onRemove: (id: string) => void;
    onDuplicate: (p: Panel) => void;
    onResize: (section: string, layout: SectionLayout) => void;
    onSection: (action: string, id: string, value?: string) => string | void;
    onReorder: (source: string, target: string, section?: string) => void;
    onLayout: (panels: Panel[], sections: Section[], original: string) => void;
    onDefaults: (section?: string) => void;
    onConnect: () => void;
  } = $props();
  let pageBySection = $state<Record<string, number>>({}),
    widths = $state<Record<string, number>>({}),
    renaming = $state(''),
    sectionName = $state('');
  let uiOwner = '';
  $effect.pre(() => {
    const id = view?.id || '';
    if (id === uiOwner) return;
    untrack(() => {
      uiOwner = id;
      const saved = sessionStorage.getItem('randl.workspace-ui:' + id);
      const state = saved ? JSON.parse(saved) : {};
      search = state.search || '';
      pageBySection = state.pages || {};
    });
  });
  $effect(() => {
    if (view?.id)
      sessionStorage.setItem(
        'randl.workspace-ui:' + view.id,
        JSON.stringify({ search, pages: pageBySection }),
      );
  });
  async function renameSection(section: { id: string; name: string }) {
    renaming = section.id;
    sectionName = section.name;
    await tick();
    const input = document.querySelector<HTMLInputElement>(
      '[data-section-id="' + CSS.escape(section.id) + '"] input',
    );
    input?.focus();
    input?.select();
  }
  async function addSection(after: string) {
    const id = onSection('add', after);
    if (id) {
      await tick();
      const section = (view?.body.sections || []).find((section) => section.id === id);
      if (section) await renameSection(section);
    }
  }
  let lastFocus = '';
  $effect(() => {
    if (!focusPanel || focusPanel === lastFocus) return;
    lastFocus = focusPanel;
    untrack(() => {
      const panel = view?.body.panels.find((p) => p.id === focusPanel);
      if (!panel) return;
      search = '';
      const id = panelSection(panel),
        g = geometry(id),
        items = view!.body.panels.filter((p) => panelSection(p) === id);
      pageBySection = {
        ...pageBySection,
        [id]: Math.floor(items.findIndex((p) => p.id === focusPanel) / (g.columns * g.rows)),
      };
      const section = view!.body.sections?.find((s) => s.id === id);
      if (section?.collapsed) onSection('collapse', id);
      void tick().then(() => {
        const element = document.querySelector<HTMLElement>(
          '[data-panel-id="' + CSS.escape(focusPanel) + '"] .chart-settings',
        );
        element?.scrollIntoView({ block: 'nearest' });
        element?.focus({ preventScroll: true });
      });
    });
  });
  const panelSection = (p: Panel) =>
    p.section || (p.metric.includes('/') ? p.metric.split('/')[0] : 'Metrics');
  let hiddenPattern = $derived.by(() => {
    if (!view?.body.hidePattern) return null;
    return new RegExp(view.body.hidePattern, 'i');
  });
  let previewPanels = $state<Panel[] | null>(null),
    previewSections = $state<Section[] | null>(null);
  let panels = $derived(
    (previewPanels || view?.body.panels || []).filter(
      (p) =>
        (p.title || p.metric).toLowerCase().includes(search.toLowerCase()) &&
        !hiddenPattern?.test(p.title || p.metric),
    ),
  );
  let allSections = $derived.by(() => {
    const list: Section[] = [...(previewSections || view?.body.sections || [])];
    for (const p of view?.body.panels || []) {
      const id = panelSection(p);
      if (!list.some((s) => s.id === id)) list.push({ id, name: id });
    }
    return list;
  });
  let sections = $derived(
    allSections.filter(
      (section) =>
        (!search && !hiddenPattern) || panels.some((panel) => panelSection(panel) === section.id),
    ),
  );
  function measure(node: HTMLElement, id: string) {
    const observer = new ResizeObserver(() => {
      const next = Math.round(node.clientWidth);
      if (widths[id] !== next) widths = { ...widths, [id]: next };
    });
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }
  function geometry(id: string) {
    const width = widths[id] || 900,
      layout = view?.body.sectionLayouts?.[id] || {};
    const count = panels.filter((p) => panelSection(p) === id).length;
    const columns = columnsFor(width, layout.width || 360, count);
    return {
      width,
      count,
      columns,
      height: layout.height || 300,
      rows: layout.rows || 2,
      cardWidth: cardWidth(width, columns),
    };
  }
  let drag = $state<{
    id: string;
    pointerId: number;
    moved: boolean;
    absoluteIndex: number;
    grid: HTMLElement;
    kind: 'panel' | 'section';
    x: number;
    y: number;
    left: number;
    top: number;
    startWidth: number;
    startHeight: number;
    startRows: number;
    width: number;
    height: number;
    rows: number;
    columns: number;
    startColumns: number;
  } | null>(null);
  function startResize(event: PointerEvent, id: string, kind: 'panel' | 'section') {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement,
      host = handle.closest(kind === 'panel' ? '.chart' : '.section-grid') as HTMLElement,
      grid = handle.closest('.section-grid') as HTMLElement,
      rect = grid.getBoundingClientRect(),
      g = geometry(id);
    handle.setPointerCapture(event.pointerId);
    drag = {
      id,
      pointerId: event.pointerId,
      moved: false,
      absoluteIndex:
        Math.min(
          pageBySection[id] || 0,
          Math.max(0, Math.ceil(g.count / (g.columns * g.rows)) - 1),
        ) *
          g.columns *
          g.rows +
        Math.max(0, [...grid.querySelectorAll('.chart')].indexOf(host)),
      grid,
      kind,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      startWidth: g.cardWidth,
      startHeight: g.height,
      startRows: Math.max(1, Math.ceil(grid.querySelectorAll('.chart').length / g.columns)),
      width: g.cardWidth,
      height: g.height,
      rows: g.rows,
      columns: g.columns,
      startColumns: g.columns,
    };
  }
  function moveResize(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.moved ||= Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 4;
    if (!drag.moved) return;
    const g = geometry(drag.id);
    if (drag.kind === 'panel') {
      drag.height = Math.max(220, Math.min(800, drag.startHeight + event.clientY - drag.y));
      const desired = Math.max(240, drag.startWidth + event.clientX - drag.x);
      drag.columns = columnsFor(g.width, desired, g.count);
      drag.width = cardWidth(g.width, drag.columns);
    } else
      drag.rows = Math.max(
        1,
        Math.min(
          20,
          Math.round((drag.startRows * (g.height + 16) + event.clientY - drag.y) / (g.height + 16)),
        ),
      );
  }
  function endResize(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag;
    drag = null;
    if (!current.moved) return;
    const old = view?.body.sectionLayouts?.[current.id] || {};
    pageBySection = {
      ...pageBySection,
      [current.id]: Math.floor(current.absoluteIndex / (current.columns * current.rows)),
    };
    onResize(
      current.id,
      current.kind === 'panel'
        ? {
            ...old,
            ...(current.columns !== current.startColumns
              ? { width: Math.max(240, current.width) }
              : {}),
            height: Math.round(current.height),
          }
        : { ...old, rows: current.rows },
    );
  }
  function keyResize(event: KeyboardEvent, id: string, kind: 'panel' | 'section') {
    if (
      !(
        kind === 'section'
          ? ['ArrowUp', 'ArrowDown']
          : ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
      ).includes(event.key)
    )
      return;
    event.preventDefault();
    const g = geometry(id),
      old = view?.body.sectionLayouts?.[id] || {};
    if (kind === 'section') {
      onResize(id, {
        ...old,
        rows: Math.max(1, Math.min(20, g.rows + (event.key === 'ArrowUp' ? -1 : 1))),
      });
      return;
    }
    const columns = Math.max(
      1,
      Math.min(
        columnLimit(g.width, g.count),
        g.columns + (event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0),
      ),
    );
    const handle = event.currentTarget as HTMLElement,
      chart = handle.closest<HTMLElement>('.chart');
    const grid = handle.closest('.section-grid');
    const index = grid && chart ? [...grid.querySelectorAll('.chart')].indexOf(chart) : 0;
    const absolute =
      Math.min(pageBySection[id] || 0, Math.max(0, Math.ceil(g.count / (g.columns * g.rows)) - 1)) *
        g.columns *
        g.rows +
      index;
    pageBySection = { ...pageBySection, [id]: Math.floor(absolute / (columns * g.rows)) };
    const panelId = chart?.dataset.panelId;
    if (panelId)
      void tick().then(() =>
        document
          .querySelector<HTMLElement>('[data-panel-id="' + CSS.escape(panelId) + '"] .panel-corner')
          ?.focus(),
      );
    onResize(id, {
      ...old,
      ...(event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        ? { width: Math.max(240, cardWidth(g.width, columns)) }
        : {}),
      height: Math.max(
        220,
        Math.min(
          800,
          g.height + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0),
        ),
      ),
    });
  }
  function scrollResize() {
    if (!drag) return;
    const rect = drag.grid.getBoundingClientRect();
    drag.left = rect.left;
    drag.top = rect.top;
  }
  $effect(() => {
    if (!drag) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = drag.kind === 'panel' ? 'se-resize' : 'row-resize';
    const selection = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previous;
      document.body.style.userSelect = selection;
    };
  });
  let reorder = $state<{
    kind: 'panel' | 'section';
    id: string;
    label: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
    active: boolean;
    original: string;
    initial: string;
    viewId: string;
    sectionY: number;
    sectionDirection: number;
  } | null>(null);
  let reorderAnnouncement = $state('');
  function announceReorder(text: string) {
    reorderAnnouncement = '';
    void tick().then(() => (reorderAnnouncement = text));
  }
  function focusReorder(selector: string) {
    void tick().then(() => {
      const control = document.querySelector<HTMLElement>(selector);
      if (!control) return;
      control.focus({ preventScroll: true });
      const r = control.getBoundingClientRect(),
        main = document.querySelector('main')!.getBoundingClientRect();
      if (r.top < main.top + topHeight || r.bottom > main.bottom)
        control.scrollIntoView({ block: 'nearest' });
    });
  }
  function startReorder(
    event: PointerEvent,
    kind: 'panel' | 'section',
    id: string,
    label: string,
  ) {
    if (event.button !== 0 || !view) return;
    const pressed = (event.currentTarget as HTMLElement).classList.contains(
      kind === 'panel' ? 'panel-drag-handle' : 'section-drag-handle',
    )
      ? 'grip'
      : 'title';
    if (event.pointerType === 'touch' && pressed === 'title') return;
    event.stopPropagation();
    previewPanels = JSON.parse(JSON.stringify(view.body.panels));
    previewSections = JSON.parse(JSON.stringify(allSections));
    reorder = {
      kind,
      id,
      label,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      sectionDirection: 0,
      sectionY: event.clientY + (document.querySelector('main')?.scrollTop || 0),
      initial: JSON.stringify([
        previewPanels!.map((p) => [p.id, panelSection(p)]),
        previewSections,
      ]),
      original: JSON.stringify([view.body.panels, view.body.sections || []]),
      viewId: view.id,
    };
  }
  function previewReorder() {
    if (!reorder?.active || !previewPanels || !previewSections) return;
    const hit = document.elementFromPoint(reorder.x, reorder.y) as HTMLElement | null;
    const section = hit?.closest<HTMLElement>('[data-section-id]');
    if (!section) return;
    if (reorder.kind === 'section') {
      const target = section.dataset.sectionId!;
      if (target === reorder.id) return;
      const index = sections.findIndex((s) => s.id === target),
        from = sections.findIndex((s) => s.id === reorder!.id),
        moving = sections[from];
      const y = reorder.y + (document.querySelector('main')?.scrollTop || 0);
      // A short section can move below a taller neighbour while the pointer is
      // still over that neighbour. Only reverse the order when the pointer reverses.
      if ((index > from && y <= reorder.sectionY) || (index < from && y >= reorder.sectionY))
        return;
      const direction = index > from ? 1 : -1;
      if (
        reorder.sectionDirection &&
        direction !== reorder.sectionDirection &&
        Math.abs(y - reorder.sectionY) < 24
      )
        return;
      const next = sections.filter((s) => s.id !== reorder!.id);
      next.splice(index, 0, moving);
      reorder.sectionY = y;
      reorder.sectionDirection = direction;
      const visibleIds = new Set(sections.map((section) => section.id));
      let cursor = 0;
      previewSections = previewSections.map((section) =>
        visibleIds.has(section.id) ? next[cursor++] : section,
      );
      return;
    }
    const destination = section.dataset.sectionId!,
      moving = previewPanels.find((p) => p.id === reorder!.id)!;
    const grid = section.querySelector<HTMLElement>('.charts'),
      g = geometry(destination);
    let slot = 0;
    if (grid) {
      const rect = grid.getBoundingClientRect(),
        style = getComputedStyle(grid),
        gapX = parseFloat(style.columnGap) || 0,
        gapY = parseFloat(style.rowGap) || 0;
      const width = (rect.width - gapX * (g.columns - 1)) / g.columns;
      const column = Math.max(
        0,
        Math.min(g.columns - 1, Math.floor((reorder.x - rect.left) / (width + gapX))),
      );
      const row = Math.max(
        0,
        Math.min(g.rows - 1, Math.floor((reorder.y - rect.top) / (g.height + gapY))),
      );
      slot = (pageBySection[destination] || 0) * g.columns * g.rows + row * g.columns + column;
    }
    const local = panels.filter((p) => panelSection(p) === destination && p.id !== reorder!.id),
      next = previewPanels.filter((p) => p.id !== reorder!.id);
    const target = local[slot];
    let index = target
      ? next.findIndex((p) => p.id === target.id)
      : local.length
        ? next.findIndex((p) => p.id === local.at(-1)!.id) + 1
        : next.length;
    next.splice(index, 0, { ...moving, section: destination });
    if (
      JSON.stringify(next.map((p) => [p.id, panelSection(p)])) !==
      JSON.stringify(previewPanels.map((p) => [p.id, panelSection(p)]))
    )
      previewPanels = next;
    if (previewSections.find((s) => s.id === destination)?.collapsed)
      previewSections = previewSections.map((s) =>
        s.id === destination ? { ...s, collapsed: false } : s,
      );
  }
  function moveReorder(event: PointerEvent) {
    if (!reorder) return;
    reorder.x = event.clientX;
    reorder.y = event.clientY;
    if (Math.hypot(reorder.x - reorder.startX, reorder.y - reorder.startY) >= 4)
      reorder.active = true;
    previewReorder();
  }
  function resetReorder() {
    reorder = null;
    previewPanels = null;
    previewSections = null;
  }
  function cancelReorder() {
    resetReorder();
  }
  function moveSection(id: string, delta: number, keyboard = true) {
    const index = sections.findIndex((section) => section.id === id),
      section = sections[index];
    if (index < 0) return;
    const target = index + delta,
      valid = target >= 0 && target < sections.length;
    announceReorder(
      $t('workspace.announce.section', {
        name: section.name,
        position: (valid ? target : index) + 1,
        total: sections.length,
      }),
    );
    if (!valid) return;
    if (!view) return;
    const next = [...sections];
    next.splice(target, 0, ...next.splice(index, 1));
    const visibleIds = new Set(sections.map((section) => section.id));
    let cursor = 0;
    const updated = allSections.map((section) =>
      visibleIds.has(section.id) ? next[cursor++] : section,
    );
    onLayout(
      view.body.panels,
      updated,
      JSON.stringify([view.body.panels, view.body.sections || []]),
    );
    focusReorder(
      '[data-section-id="' +
        CSS.escape(id) +
        '"] .' +
        (keyboard ? 'section-drag-handle' : 'section-title'),
    );
  }
  function finishReorder() {
    if (!reorder) return;
    const state = reorder,
      panels = previewPanels!,
      sections = previewSections!;
    if (
      state.active &&
      state.viewId === view?.id &&
      JSON.stringify([panels.map((p) => [p.id, panelSection(p)]), sections]) !== state.initial
    )
      onLayout(panels, sections, state.original);
    resetReorder();
    if (state.active)
      void tick().then(() =>
        document
          .querySelector<HTMLElement>(
            state.kind === 'panel'
              ? '[data-panel-id="' + CSS.escape(state.id) + '"] .chart-title'
              : '[data-section-id="' + CSS.escape(state.id) + '"] .section-title',
          )
          ?.focus({ preventScroll: true }),
      );
  }
  function moveWithinSection(panel: Panel, delta: number, keyboard = true) {
    const sectionId = panelSection(panel),
      items = panels.filter((p) => panelSection(p) === sectionId),
      index = items.findIndex((p) => p.id === panel.id),
      target = index + delta,
      valid = target >= 0 && target < items.length;
    announceReorder(
      $t('workspace.announce.panel', {
        name: panel.title || panel.metric,
        position: (valid ? target : index) + 1,
        total: items.length,
        section: sections.find((s) => s.id === sectionId)?.name || sectionId,
      }),
    );
    if (!valid) return;
    onReorder(panel.id, delta < 0 ? items[target].id : items[target + 1]?.id || '', sectionId);
    const g = geometry(sectionId);
    pageBySection = { ...pageBySection, [sectionId]: Math.floor(target / (g.columns * g.rows)) };
    focusReorder(
      '[data-panel-id="' +
        CSS.escape(panel.id) +
        '"] .' +
        (keyboard ? 'panel-drag-handle' : 'chart-title'),
    );
  }
  // The toolbar stays at the top of the scroller; scrolling and visibility checks
  // treat the area beneath it as the visible panel area.
  // In short windows the toolbar scrolls away so panels keep usable height.
  const shortWindow = new MediaQuery('max-height: 480px');
  let toolbarHeight = $state(0);
  let topHeight = $derived(shortWindow.current ? 0 : toolbarHeight);
  $effect(() => {
    const main = document.querySelector<HTMLElement>('main');
    if (!main) return;
    main.style.scrollPaddingTop = topHeight + 'px';
    return () => {
      main.style.scrollPaddingTop = '';
    };
  });
  $effect(() => {
    if (!reorder?.active) return;
    const scroller = document.querySelector('main')!;
    let frame: number;
    const step = () => {
      if (!reorder) return;
      const rect = scroller.getBoundingClientRect(),
        top = rect.top + topHeight,
        speed =
          reorder.y < top + 48
            ? -Math.ceil((top + 48 - reorder.y) / 3)
            : reorder.y > rect.bottom - 48
              ? Math.ceil((reorder.y - rect.bottom + 48) / 3)
              : 0;
      if (speed) {
        scroller.scrollTop += Math.max(-24, Math.min(24, speed));
        previewReorder();
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.classList.add('workspace-reordering');
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.userSelect = previous;
      document.body.classList.remove('workspace-reordering');
    };
  });
  $effect(() => {
    if (reorder && view?.id !== reorder.viewId) cancelReorder();
  });
  function placeReorderPreview(node: HTMLElement, position: { x: number; y: number }) {
    const place = () => {
      node.style.left =
        Math.max(8, Math.min(position.x + 16, innerWidth - node.offsetWidth - 8)) + 'px';
      node.style.top =
        Math.max(8, Math.min(position.y + 16, innerHeight - node.offsetHeight - 8)) + 'px';
    };
    place();
    window.addEventListener('resize', place);
    return {
      update(next: { x: number; y: number }) {
        position = next;
        place();
      },
      destroy() {
        window.removeEventListener('resize', place);
      },
    };
  }
  // Deleting the focused control's object moves focus to its neighbor.
  function focusFirst(...selectors: string[]) {
    void tick().then(() => {
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element) return element.focus({ preventScroll: true });
      }
    });
  }
  function deleteSection(id: string) {
    const index = sections.findIndex((section) => section.id === id),
      neighbor = sections[index + 1]?.id ?? sections[index - 1]?.id;
    onSection('delete', id);
    focusFirst(
      ...(neighbor ? ['[data-section-id="' + CSS.escape(neighbor) + '"] .section-toggle'] : []),
      '.add-section button',
    );
  }
  function removePanel(panel: Panel) {
    const id = panelSection(panel),
      items = panels.filter((item) => panelSection(item) === id),
      index = items.findIndex((item) => item.id === panel.id),
      neighbor = items[index + 1]?.id ?? items[index - 1]?.id,
      section = '[data-section-id="' + CSS.escape(id) + '"] ';
    onRemove(panel.id);
    focusFirst(
      ...(neighbor ? ['[data-panel-id="' + CSS.escape(neighbor) + '"] .chart-settings'] : []),
      section + '.empty-section',
      section + '.section-toggle',
    );
  }
  function focusSection(id: string, control: 'toggle' | 'menu') {
    void tick().then(() =>
      document
        .querySelector<HTMLElement>(
          '[data-section-id="' +
            CSS.escape(id) +
            '"] ' +
            (control === 'toggle' ? '.section-toggle' : '.section-actions .bx--overflow-menu'),
        )
        ?.focus({ preventScroll: true }),
    );
  }
  // Blur also commits; a keyboard commit or cancel keeps focus in the section heading.
  function rename(keyboard = false) {
    const id = renaming;
    if (id && sectionName.trim()) onSection('rename', id, sectionName.trim());
    renaming = '';
    if (id && keyboard) focusSection(id, 'toggle');
  }
  function cancelRename() {
    const id = renaming;
    renaming = '';
    if (id) focusSection(id, 'menu');
  }
</script>

<span class="bx--visually-hidden" role="status" aria-live="polite">{reorderAnnouncement}</span>
<span id="section-reorder-help" class="bx--visually-hidden"
  >{$t('workspace.instructions.sections')}</span
>
<span id="panel-reorder-help" class="bx--visually-hidden"
  >{$t('workspace.instructions.panels')}</span
>
{#if reorder?.active}<div
    class="reorder-preview"
    use:placeReorderPreview={{ x: reorder.x, y: reorder.y }}
  >
    <Draggable size={16} /><span>{reorder.label}</span>
  </div>{/if}
<span id="row-resize-help" class="bx--visually-hidden"
  >{$t('workspace.instructions.rows')}</span
>
<span id="panel-resize-help" class="bx--visually-hidden"
  >{$t('workspace.instructions.resize')}</span
>

<svelte:window
  onscrollcapture={scrollResize}
  onblur={() => {
    drag = null;
    cancelReorder();
  }}
  onpointermove={(event) => {
    moveResize(event);
    moveReorder(event);
  }}
  onpointerup={(event) => {
    endResize(event);
    finishReorder();
  }}
  onpointercancel={() => {
    drag = null;
    cancelReorder();
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      drag = null;
      cancelReorder();
    }
  }}
/>
<div class="workspace-top" class:pinned={!shortWindow.current} bind:clientHeight={toolbarHeight}>
  {#if leading || (tools && (view?.body.panels.length || sections.length))}<div
      class="workspace-toolbar"
    >
      {@render leading?.()}
      {#if tools && (view?.body.panels.length || sections.length)}<PanelTools
          bind:search
          {canvasWidth}
          onDefaults={() => onDefaults()}
          onAdd={() => onAdd()}
        />{/if}
    </div>{/if}
  {@render below?.()}
</div>
{#if !sections.length}<section class="empty">
    <h2>
      {search || hiddenPattern
        ? $t('workspace.empty.noMatches')
        : hasRuns
          ? $t('workspace.empty.none')
          : $t('runs.empty.none')}
    </h2>
    {#if search}<Button kind="tertiary" size="small" on:click={() => (search = '')}
        >{$t('common.search.clear')}</Button
      >{:else if hiddenPattern}<Button kind="tertiary" size="small" on:click={() => onDefaults()}
        >{$t('workspace.empty.editFilter')}</Button
      >{:else if hasRuns}<Button size="small" on:click={() => onAdd()}>{$t('workspace.addPanel')}</Button
      >{:else}<p>{$t('projects.emptyText')}</p>
      <Button size="small" on:click={onConnect}>{$t('connect.title')}</Button>{/if}
  </section>{/if}
{#each sections as section, sectionIndex (section.id)}{@const content = panels.filter(
    (p) => panelSection(p) === section.id,
  )}{@const g = geometry(section.id)}{@const size = g.columns * g.rows}{@const page = Math.min(
    pageBySection[section.id] || 0,
    Math.max(0, Math.ceil(content.length / size) - 1),
  )}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Section drop has panel editor and menu alternatives.) -->
  <section
    class="metric-section"
    aria-label={section.name}
    data-section-id={section.id}
    class:reordering-section={reorder?.kind === 'section' &&
      reorder.id === section.id &&
      reorder.active}
  >
    <div class="section-heading">
      <div class="section-identity">
        <button
          type="button"
          class="section-toggle"
          aria-expanded={!section.collapsed}
          title={$t(section.collapsed ? 'workspace.section.expand' : 'workspace.section.collapse', {
            name: section.name,
          })}
          aria-label={$t(section.collapsed ? 'workspace.section.expand' : 'workspace.section.collapse', {
            name: section.name,
          })}
          onclick={() => onSection('collapse', section.id)}
          >{#if section.collapsed}<ChevronRight size={16} />{:else}<ChevronDown
              size={16}
            />{/if}</button
        >
        <button
          type="button"
          class="section-drag-handle"
          aria-describedby="section-reorder-help"
          title={$t('workspace.section.reorder', { name: section.name })}
          aria-label={$t('workspace.section.reorder', { name: section.name })}
          onpointerdown={(event) => startReorder(event, 'section', section.id, section.name)}
          onkeydown={(event) => {
            if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault();
              moveSection(section.id, event.key === 'ArrowUp' ? -1 : 1);
            }
          }}><Draggable size={16} /></button
        >
        {#if renaming === section.id}<TextInput
            size="sm"
            labelText={$t('workspace.section.name')}
            hideLabel
            bind:value={sectionName}
            on:blur={() => rename()}
            on:keydown={(event) => {
              // Prevent the key from also activating the control that receives focus.
              if (event.key === 'Enter') {
                event.preventDefault();
                rename(true);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              }
            }}
          />{:else}<!-- svelte-ignore a11y_no_noninteractive_element_interactions (The title is a pointer drag surface; the reorder button and menu provide keyboard equivalents.) -->
          <h2
            class="section-title"
            tabindex="-1"
            title={section.name}
            onpointerdown={(event) => startReorder(event, 'section', section.id, section.name)}
          >
            <span>{section.name}</span>{#if content.length}<span class="section-count"
                >{content.length}</span
              >{/if}
          </h2>{/if}
      </div>
      <div class="section-actions">
        {#if content.length > size && !section.collapsed}<span class="section-page"
            >{$t('workspace.section.pageRange', {
              start: page * size + 1,
              end: Math.min(content.length, (page + 1) * size),
            })}</span
          ><Button
            kind="ghost"
            size="small"
            icon={ChevronLeft}
            hideTooltip
            title={$t('workspace.section.previousPage', { name: section.name })}
            iconDescription={$t('workspace.section.previousPage', { name: section.name })}
            portalTooltip
            disabled={page === 0}
            on:click={() => (pageBySection = { ...pageBySection, [section.id]: page - 1 })}
          /><Button
            kind="ghost"
            size="small"
            icon={ChevronRight}
            hideTooltip
            title={$t('workspace.section.nextPage', { name: section.name })}
            iconDescription={$t('workspace.section.nextPage', { name: section.name })}
            portalTooltip
            disabled={(page + 1) * size >= content.length}
            on:click={() => (pageBySection = { ...pageBySection, [section.id]: page + 1 })}
          />{/if}<span class="section-heading-actions"
          >{#if content.length}<Button
              kind="ghost"
              size="small"
              icon={Add}
              class="section-add"
              hideTooltip
              title={$t('workspace.section.addPanel', { name: section.name })}
              iconDescription={$t('workspace.section.addPanel', { name: section.name })}
              portalTooltip
              on:click={() => onAdd(section.id)}
            />{/if}<Button
            kind="ghost"
            size="small"
            icon={Settings}
            class="section-settings"
            hideTooltip
            title={$t('workspace.section.settings', { name: section.name })}
            iconDescription={$t('workspace.section.settings', { name: section.name })}
            portalTooltip
            on:click={() => onDefaults(section.id)}
          /><OverflowMenu
            size="sm"
            flipped
            portalMenu
            title={$t('workspace.section.actions', { name: section.name })}
            aria-label={$t('workspace.section.actions', { name: section.name })}
            iconDescription={$t('workspace.section.actions', { name: section.name })}
            ><OverflowMenuItem
              text={$t('workspace.section.rename')}
              on:click={() => {
                void renameSection(section);
              }}
            /><OverflowMenuItem
              text={$t('workspace.section.sortPanels')}
              on:click={() => onSection('sort', section.id)}
            /><OverflowMenuItem
              text={$t('workspace.section.moveToTop')}
              disabled={sectionIndex === 0}
              on:click={(event) =>
                moveSection(section.id, -sectionIndex, event.detail.detail === 0)}
            /><OverflowMenuItem
              text={$t('workspace.section.moveUp')}
              disabled={sectionIndex === 0}
              on:click={(event) => moveSection(section.id, -1, event.detail.detail === 0)}
            /><OverflowMenuItem
              text={$t('workspace.section.moveDown')}
              disabled={sectionIndex === sections.length - 1}
              on:click={(event) => moveSection(section.id, 1, event.detail.detail === 0)}
            /><OverflowMenuItem
              text={$t('workspace.section.moveToBottom')}
              disabled={sectionIndex === sections.length - 1}
              on:click={(event) =>
                moveSection(
                  section.id,
                  sections.length - 1 - sectionIndex,
                  event.detail.detail === 0,
                )}
            /><OverflowMenuItem
              text={$t('workspace.section.addBelow')}
              on:click={() => addSection(section.id)}
            /><OverflowMenuItem
              text={$t('workspace.section.delete')}
              danger
              hasDivider
              on:click={() => deleteSection(section.id)}
            /></OverflowMenu
          ></span
        >
      </div>
    </div>
    {#if !section.collapsed}<div class="section-grid" use:measure={section.id}>
        <div
          class="charts"
          style:grid-template-columns={'repeat(' + g.columns + ', minmax(0,1fr))'}
        >
          {#each content.slice(page * size, (page + 1) * size) as panel (panel.id)}<div
              class="panel-slot"
            >
              <PanelCard
                panel={{
                  ...panel,
                  settings: resolvePlotSettings(
                    [
                      { scope: 'workspace', settings: view?.body.plotSettings },
                      { scope: 'section', settings: view?.body.sectionSettings?.[section.id] },
                      { scope: 'panel', settings: panel.settings },
                    ],
                    plugins.filter((p) => p.id === panel.plugin),
                    plugins.find((p) => p.id === panel.plugin)?.settings.defaults,
                  ).settings,
                }}
                resizeLabel={{
                  key: 'workspace.section.resizeLabel',
                  values: { name: section.name, count: g.columns, height: g.height },
                }}
                emptySelectionText={noMatchingRuns
                  ? 'runs.empty.noMatches'
                  : 'panel.empty.noVisibleRuns'}
                height={g.height}
                {runs}
                {colors}
                pinned={view?.body.pinned || []}
                plugin={plugins.find((p) => p.id === panel.plugin)}
                {dark}
                onedit={() => onEdit(panel)}
                onsettings={(settings) => onPanelSettings(panel.id, settings)}
                session={{
                  section: view!.id + ':' + section.id,
                  panel: view!.id + ':' + panel.id,
                }}
                onremove={() => removePanel(panel)}
                onduplicate={() => onDuplicate(panel)}
                columns={g.columns}
                position={content.indexOf(panel)}
                count={content.length}
                onmove={(direction, keyboard) => moveWithinSection(panel, direction, keyboard)}
                onresizestart={(event) => startResize(event, section.id, 'panel')}
                onresizekey={(event) => keyResize(event, section.id, 'panel')}
                onreorderstart={(event) =>
                  startReorder(event, 'panel', panel.id, panel.title || panel.metric)}
                reordering={reorder?.kind === 'panel' && reorder.id === panel.id && reorder.active}
              />
            </div>{/each}
        </div>
        {#if !content.length}<button class="empty-section" onclick={() => onAdd(section.id)}
            >{$t('workspace.addPanel')}</button
          >{:else}<button
            class="section-row-resize"
            aria-label={$t('workspace.section.rowsLabel', { name: section.name, count: g.rows })}
            aria-describedby="row-resize-help"
            title={$t('workspace.section.resizeRows')}
            onpointerdown={(event) => startResize(event, section.id, 'section')}
            onkeydown={(event) => keyResize(event, section.id, 'section')}
          ></button>{/if}
      </div>{/if}
  </section>{/each}
{#if hasRuns}<div class="add-section">
    <Button kind="ghost" size="small" icon={Add} on:click={() => addSection('')}
      >{$t('workspace.addSection')}</Button
    >
  </div>{/if}
{#if drag?.moved}{@const g = geometry(drag.id)}
  {@const index = drag.absoluteIndex % (drag.columns * drag.rows)}
  <div
    class="resize-preview"
    style:left={drag.left +
      (drag.kind === 'panel' ? (index % drag.columns) * (drag.width + 16) : 0) +
      'px'}
    style:top={drag.top +
      (drag.kind === 'panel' ? Math.floor(index / drag.columns) * (drag.height + 16) : 0) +
      'px'}
    style:width={(drag.kind === 'panel' ? drag.width : g.width) + 'px'}
    style:height={(drag.kind === 'panel' ? drag.height : drag.rows * (g.height + 16) - 16) + 'px'}
  >
    <span
      >{drag.kind === 'panel'
        ? $t('workspace.resize.columns', { count: drag.columns, height: Math.round(drag.height) })
        : $t('workspace.resize.rows', { count: drag.rows })}</span
    >
  </div>{/if}
