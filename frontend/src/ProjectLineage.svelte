<script lang="ts">
  // The Lineage page (README "Lineage"): runs as cards, linked from the run whose checkpoint
  // each started from. The server derives the graph; this page filters, lays out and explains
  // it, and hands chosen runs to the workspace for comparison.
  import { onMount, tick, untrack } from 'svelte';
  import {
    Button,
    Checkbox,
    InlineNotification,
    Search,
    Select,
    SelectItem,
  } from 'carbon-components-svelte';
  import Filter from 'carbon-icons-svelte/lib/Filter.svelte';
  import View from 'carbon-icons-svelte/lib/View.svelte';
  import Information from 'carbon-icons-svelte/lib/Information.svelte';
  import TreeViewAlt from 'carbon-icons-svelte/lib/TreeViewAlt.svelte';
  import Branch from 'carbon-icons-svelte/lib/Branch.svelte';
  import Erase from 'carbon-icons-svelte/lib/Erase.svelte';
  import ContextPopover from './ContextPopover.svelte';
  import ZoomIn from 'carbon-icons-svelte/lib/ZoomIn.svelte';
  import ZoomOut from 'carbon-icons-svelte/lib/ZoomOut.svelte';
  import FitToScreen from 'carbon-icons-svelte/lib/FitToScreen.svelte';
  import InProgress from 'carbon-icons-svelte/lib/InProgress.svelte';
  import SettingsAdjust from 'carbon-icons-svelte/lib/SettingsAdjust.svelte';
  import ChartLine from 'carbon-icons-svelte/lib/ChartLine.svelte';
  import { tool, apiMessage } from './api';
  import { t, number, type Message } from './i18n';
  import { runPalette } from './run-colors';
  import type { Plugin, Run } from './types';
  import LineageDetails from './LineageDetails.svelte';
  import LineageSettingsModal from './LineageSettings.svelte';
  import LineageCard from './LineageCard.svelte';
  import {
    boundsOf,
    cardsIn,
    descendants,
    edgePath,
    indexGraph,
    layoutGraph,
    nameDelta,
    nodeHeight,
    nodeWidth,
    pathToRoot,
    shortKey,
    visibleRuns,
    type Axis,
    type Filters,
    type LineageEdge,
    type LineageGraph,
    type Layout,
  } from './lineage-graph';

  let {
    project,
    runs,
    revision,
    plugins,
    colors,
    dark,
    onRun,
    onCompare,
  }: {
    project: string;
    runs: Run[];
    revision: number;
    plugins: Plugin[];
    colors: Record<string, string>;
    dark: boolean;
    onRun: (run: Run) => void;
    /** Opens the workspace with exactly these runs shown. */
    onCompare: (ids: string[]) => void;
  } = $props();

  // The page's choices for a project, kept in this browser.
  type ColorBy = 'run' | 'host';
  const prefsKey = untrack(() => 'randl.lineage:' + project);
  function readPrefs(): { axis?: Axis; colorBy?: ColorBy; filters?: Partial<Filters> } {
    try {
      return JSON.parse(localStorage.getItem(prefsKey) || '{}');
    } catch {
      return {};
    }
  }
  const prefs = readPrefs();
  const params = new URL(location.href).searchParams,
    prefix = untrack(() => project + '/');
  let graph = $state.raw<LineageGraph | null>(null),
    error = $state<Message>(''),
    filters = $state<Filters>({
      search: '',
      group: '',
      tag: '',
      host: '',
      collapseRejected: prefs.filters?.collapseRejected ?? false,
      showIsolated: prefs.filters?.showIsolated ?? false,
    }),
    axis = $state<Axis>(prefs.axis ?? 'depth'),
    colorBy = $state<ColorBy>(prefs.colorBy ?? 'run'),
    // The run whose details are open (`?run=`), and the runs chosen to compare (`?select=`).
    selected = $state(params.get('run') || ''),
    picked = $state(
      new Set(
        (params.get('select') || '')
          .split(',')
          .filter(Boolean)
          .map((name) => prefix + name),
      ),
    ),
    settingsOpen = $state(false);
  $effect(() => {
    const value = {
      axis,
      colorBy,
      filters: { collapseRejected: filters.collapseRejected, showIsolated: filters.showIsolated },
    };
    try {
      localStorage.setItem(prefsKey, JSON.stringify(value));
    } catch {
      // Private windows may refuse storage; the page works without it.
    }
  });

  // Live run updates refresh the graph at most every ten seconds.
  const refreshInterval = 10_000;
  let loadedFor = '',
    lastLoad = 0,
    pending: ReturnType<typeof setTimeout> | undefined;
  async function load() {
    const id = project;
    lastLoad = Date.now();
    try {
      const result: LineageGraph = await tool('project_lineage', { id });
      if (id !== project) return;
      graph = result;
      error = '';
    } catch (reason) {
      if (id === project) error = apiMessage(reason);
    }
  }
  $effect(() => {
    void revision;
    const id = project;
    untrack(() => {
      if (id !== loadedFor) {
        loadedFor = id;
        graph = null;
        clearTimeout(pending);
        pending = undefined;
        void load();
      } else if (!pending)
        pending = setTimeout(
          () => {
            pending = undefined;
            void load();
          },
          Math.max(0, lastLoad + refreshInterval - Date.now()),
        );
    });
  });
  onMount(() => () => clearTimeout(pending));

  let index = $derived(graph ? indexGraph(graph) : null);
  let visible = $derived(graph && index ? visibleRuns(graph, index, filters) : null);
  let shownSet = $derived(new Set(visible?.shown));
  let shownEdges = $derived(
    graph?.edges.filter((edge) => shownSet.has(edge.source) && shownSet.has(edge.target)) ?? [],
  );
  // Config-base references (`lineage.extends`) between drawn runs: weaker links, not laid out.
  let baseEdges = $derived(
    graph?.nodes.flatMap((node) =>
      shownSet.has(node.id)
        ? node.bases
            .filter((base) => base.id && base.id !== index?.parent.get(node.id)?.source)
            .filter((base) => shownSet.has(base.id!))
            .map((base) => ({ source: base.id!, target: node.id }))
        : [],
    ) ?? [],
  );
  const distinct = (values: (string | null | undefined)[]) =>
    [...new Set(values.filter((value): value is string => !!value))].sort();
  let groups = $derived(distinct(graph?.nodes.map((node) => node.group) ?? []));
  let tags = $derived(distinct(graph?.nodes.flatMap((node) => node.tags) ?? []));
  let hosts = $derived(distinct(graph?.nodes.map((node) => node.compute?.host) ?? []));
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));
  // Hosts take the run palette in name order, so a host keeps its colour between visits.
  function swatch(id: string) {
    if (colorBy === 'run') return colors[id];
    const host = index?.nodes.get(id)?.compute?.host;
    if (!host) return undefined;
    return runPalette[hosts.indexOf(host) % runPalette.length][dark ? 'dark' : 'light'];
  }

  // Layout runs only when the drawn runs, their links or the axis change, not on live values.
  let layout = $state.raw<Layout | null>(null);
  let layoutKey = '';
  let dagre: typeof import('@dagrejs/dagre') | undefined;
  $effect(() => {
    const ids = visible?.shown ?? [],
      edges = shownEdges,
      along = axis,
      key = JSON.stringify([along, ids, edges.map((edge) => edge.source + '>' + edge.target)]);
    if (key === layoutKey || !index) return;
    layoutKey = key;
    const parent = index.parent,
      nodes = index.nodes;
    const start = (id: string) =>
      along === 'time' ? nodes.get(id)!.created : (parent.get(id)?.update ?? null);
    void (async () => {
      dagre ??= (await import('@dagrejs/dagre')).default;
      if (key !== layoutKey) return;
      const first = !layout;
      layout = layoutGraph(dagre, ids, edges, along, start);
      if (first) {
        await tick();
        if (selected && layout.positions.has(selected)) centre(selected, 1);
        else if (!focusRunning()) {
          // Without running runs, the newest linked run.
          const children = new Set(edges.map((edge) => edge.target)),
            newest = ids.filter((id) => children.has(id)).at(-1) ?? ids.at(-1);
          if (newest) centre(newest, 1);
        }
      }
    })();
  });

  // Pan and zoom: the canvas is translated and scaled inside a clipped viewport. The page
  // opens at 100%, where card text is the interface's normal size.
  let viewport = $state<HTMLDivElement>(),
    scale = $state(1),
    tx = $state(16),
    ty = $state(16);
  const minScale = 0.1,
    maxScale = 2.5;
  function zoomAt(factor: number, cx: number, cy: number) {
    const next = Math.min(maxScale, Math.max(minScale, scale * factor));
    tx = cx - ((cx - tx) * next) / scale;
    ty = cy - ((cy - ty) * next) / scale;
    scale = next;
  }
  function zoom(factor: number) {
    if (viewport) zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }
  /** Shows a canvas box centred, at a scale if given, else the largest up to 100% that fits. */
  function frame(box: { x: number; y: number; right: number; bottom: number }, at?: number) {
    if (!viewport) return;
    const margin = 32,
      width = viewport.clientWidth - margin * 2,
      height = viewport.clientHeight - margin * 2;
    scale =
      at ??
      Math.min(
        1,
        Math.max(minScale, Math.min(width / (box.right - box.x), height / (box.bottom - box.y))),
      );
    tx = viewport.clientWidth / 2 - ((box.x + box.right) / 2) * scale;
    ty = viewport.clientHeight / 2 - ((box.y + box.bottom) / 2) * scale;
  }
  function fit() {
    if (layout) frame({ x: 0, y: 0, right: layout.width, bottom: layout.height });
  }
  function centre(id: string, at: number) {
    const box = layout && boundsOf(layout.positions, [id]);
    if (box) frame(box, at);
  }
  let runningIds = $derived(
    (visible?.shown ?? []).filter((id) => index?.nodes.get(id)?.state === 'running'),
  );
  /**
   * Shows the running runs at 100%: all of them when they fit, else the one that most recently
   * reported. Returns whether any is drawn.
   */
  function focusRunning() {
    if (!layout || !viewport || !runningIds.length) return false;
    const box = boundsOf(layout.positions, runningIds)!;
    if (
      box.right - box.x <= viewport.clientWidth - 64 &&
      box.bottom - box.y <= viewport.clientHeight - 64
    )
      frame(box, 1);
    else {
      const latest = (id: string) => runById.get(id)?.heartbeat ?? runById.get(id)?.updated ?? 0;
      centre(
        runningIds.reduce((a, b) => (latest(b) > latest(a) ? b : a)),
        1,
      );
    }
    return true;
  }
  /** Pans so a run's card is in view. */
  function reveal(id: string) {
    const position = layout?.positions.get(id);
    if (!position || !viewport) return;
    const x = position.x * scale + tx,
      y = position.y * scale + ty,
      w = nodeWidth * scale,
      h = nodeHeight * scale;
    if (x < 0 || y < 0 || x + w > viewport.clientWidth || y + h > viewport.clientHeight)
      centre(id, scale);
  }

  // Gestures. Two-finger touchpad scrolling pans; a pinch (which browsers send as wheel events
  // with ctrlKey, or as Safari gesture events) zooms around the fingers; a mouse wheel pans and
  // Ctrl+wheel zooms. On touch screens one finger pans and two pinch. Shift+drag with a mouse
  // draws a lasso that adds cards to the selection.
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = false,
    lasso = $state<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const local = (event: { clientX: number; clientY: number }) => {
    const box = viewport!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  function pointerDown(event: PointerEvent) {
    // Only a drag that starts with this press suppresses its click.
    if (!pointers.size) moved = false;
    const onControl = !!(event.target as Element).closest('button, a');
    if (event.pointerType === 'mouse' && (event.button !== 0 || onControl)) return;
    const at = local(event);
    if (event.pointerType === 'mouse' && event.shiftKey) {
      lasso = { x1: at.x, y1: at.y, x2: at.x, y2: at.y };
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      return;
    }
    pointers.set(event.pointerId, at);
    // A touch that starts on a card still pans; it becomes a tap if it does not move.
    if (!onControl) (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent) {
    const at = local(event);
    if (lasso) {
      lasso = { ...lasso, x2: at.x, y2: at.y };
      return;
    }
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    if (pointers.size === 2) {
      const [other] = [...pointers].filter(([id]) => id !== event.pointerId).map(([, p]) => p);
      const before = Math.hypot(previous.x - other.x, previous.y - other.y),
        after = Math.hypot(at.x - other.x, at.y - other.y);
      // Zoom around the midpoint, and follow it as the fingers move together.
      tx += (at.x - previous.x) / 2;
      ty += (at.y - previous.y) / 2;
      if (before > 0) zoomAt(after / before, (at.x + other.x) / 2, (at.y + other.y) / 2);
      moved = true;
    } else if (pointers.size === 1) {
      if (!moved && Math.hypot(at.x - previous.x, at.y - previous.y) < 4) return;
      tx += at.x - previous.x;
      ty += at.y - previous.y;
      moved = true;
    }
    pointers.set(event.pointerId, at);
  }
  function pointerUp(event: PointerEvent) {
    if (lasso && layout) {
      const box = lasso,
        toCanvas = (x: number, y: number) => ({ x: (x - tx) / scale, y: (y - ty) / scale }),
        a = toCanvas(box.x1, box.y1),
        b = toCanvas(box.x2, box.y2);
      lasso = null;
      if (Math.abs(box.x2 - box.x1) > 4 || Math.abs(box.y2 - box.y1) > 4)
        pick([...picked, ...cardsIn(layout.positions, { x1: a.x, y1: a.y, x2: b.x, y2: b.y })]);
      return;
    }
    pointers.delete(event.pointerId);
  }
  // A drag that ends over a card is not a click on it.
  function clickCapture(event: MouseEvent) {
    if (!moved) return;
    moved = false;
    event.stopPropagation();
    event.preventDefault();
  }
  // Wheel and gesture events need preventDefault, so their listeners are not passive.
  $effect(() => {
    const element = viewport;
    if (!element) return;
    let gestureScale = 1;
    const gestureStart = (event: any) => {
      event.preventDefault();
      gestureScale = 1;
    };
    const gestureChange = (event: any) => {
      event.preventDefault();
      const at = local(event);
      zoomAt(event.scale / gestureScale, at.x, at.y);
      gestureScale = event.scale;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('gesturestart', gestureStart);
    element.addEventListener('gesturechange', gestureChange);
    return () => {
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('gesturestart', gestureStart);
      element.removeEventListener('gesturechange', gestureChange);
    };
  });
  function wheel(event: WheelEvent) {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport!.clientHeight : 1;
    const at = local(event);
    if (event.ctrlKey || event.metaKey) {
      // Pinch deltas are small and frequent; a mouse wheel's notch is capped so it steps gently.
      const delta = Math.max(-50, Math.min(50, event.deltaY * unit));
      zoomAt(Math.exp(-delta / 100), at.x, at.y);
    } else {
      tx -= event.deltaX * unit;
      ty -= event.deltaY * unit;
    }
  }

  // Selection lives in the URL (`?run=` for the details, `?select=` for the chosen runs by
  // SDK ID), so a reload or a shared link opens the same comparison.
  function syncURL() {
    const url = new URL(location.href);
    if (selected) url.searchParams.set('run', selected);
    else url.searchParams.delete('run');
    const chosen = [...picked]
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length));
    if (chosen.length) url.searchParams.set('select', chosen.join(','));
    else url.searchParams.delete('select');
    history.replaceState(history.state, '', url);
  }
  function select(id: string, focus = false) {
    selected = id;
    syncURL();
    if (id) {
      reveal(id);
      if (focus) void tick().then(() => cardButton(id)?.focus());
    }
  }
  function pick(ids: Iterable<string>) {
    picked = new Set(ids);
    syncURL();
  }
  /** A click opens a run's details; Shift, Ctrl or Cmd adds it to or removes it from the selection. */
  function cardClick(event: MouseEvent, id: string) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      const next = new Set(picked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      pick(next);
      return;
    }
    if (selected === id && picked.size <= 1) {
      selected = '';
      pick([]);
    } else {
      selected = id;
      pick([id]);
    }
  }
  const cardButton = (id: string) =>
    viewport?.querySelector<HTMLButtonElement>(`[data-run="${CSS.escape(id)}"]`);
  function closeDetails() {
    const id = selected;
    select('');
    if (id) void tick().then(() => cardButton(id)?.focus());
  }
  let path = $derived(selected && index?.nodes.has(selected) ? pathToRoot(selected, index) : []);
  let pathSet = $derived(new Set(path));
  /** The chosen runs in the graph's order (creation). */
  let pickedRuns = $derived(
    graph?.nodes.filter((node) => picked.has(node.id)).map((node) => node.id) ?? [],
  );

  // Arrow keys move along links: left to the parent, right to the first child, up and down
  // between siblings (or neighbouring cards in the grid of unlinked runs).
  function cardKey(event: KeyboardEvent, id: string) {
    if (!index || !layout) return;
    let next: string | undefined;
    const parent = index.parent.get(id);
    const siblings = parent
      ? (index.children.get(parent.source) ?? [])
          .map((edge) => edge.target)
          .filter((other) => shownSet.has(other))
      : [];
    if (event.key === 'ArrowLeft' && parent && shownSet.has(parent.source)) next = parent.source;
    else if (event.key === 'ArrowRight')
      next = (index.children.get(id) ?? []).find((edge) => shownSet.has(edge.target))?.target;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const list = siblings.length > 1 ? siblings : (visible?.shown ?? []);
      const at = list.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1);
      next = list[at];
    } else if (event.key === 'Escape' && selected) {
      event.preventDefault();
      closeDetails();
      return;
    } else return;
    event.preventDefault();
    if (next) {
      reveal(next);
      cardButton(next)?.focus();
    }
  }

  const edgeKey = (edge: { source: string; target: string }) => edge.source + '>' + edge.target;
  /** Resume and extension links continue a run; other links start a new one. */
  const continues = (edge: LineageEdge) => edge.relation === 'resume' || edge.relation === 'extend';
  /** Links read as the child's logged `change` sentence, else its relations and changed keys. */
  function edgeLabel(edge: LineageEdge) {
    const parts: string[] = [];
    if (edge.update !== null)
      parts.push(
        $t('lineage.edge.update', { update: $number(edge.update, { notation: 'compact' }) }),
      );
    const change = index?.nodes.get(edge.target)?.change;
    if (change) return [...parts, change].join(' · ');
    const traits = edge.traits.filter((trait) => trait !== 'extends_config');
    if (traits.length) parts.push(traits.map((trait) => '+' + trait.replace(/_/g, ' ')).join(' '));
    const keys = edge.changedKeys.slice(0, 2).map(shortKey);
    if (keys.length) parts.push(keys.join(', '));
    if (edge.changeCount > keys.length)
      parts.push($t('lineage.edge.more', { count: edge.changeCount - keys.length }));
    return parts.join(' · ');
  }
  const axisItems = $derived([
    { id: 'depth', text: $t('lineage.axis.depth') },
    { id: 'update', text: $t('lineage.axis.update') },
    { id: 'time', text: $t('lineage.axis.time') },
  ]);
  // The toolbar's collapsed menus: filters, view options and the counts.
  let menu = $state<'' | 'filters' | 'view' | 'info'>(''),
    menuAnchor = $state<HTMLElement | null>(null);
  function openMenu(next: 'filters' | 'view' | 'info', event: MouseEvent) {
    if (menu === next) return closeMenu();
    menuAnchor = (event.currentTarget as HTMLElement).closest('button');
    menu = next;
  }
  function closeMenu() {
    const anchor = menuAnchor;
    menu = '';
    void tick().then(() => anchor?.focus());
  }
  const valueOf = (event: Event) => (event.target as HTMLSelectElement).value;
  let activeFilters = $derived(
    [
      filters.group,
      filters.tag,
      filters.host,
      filters.collapseRejected,
      filters.showIsolated,
    ].filter(Boolean).length,
  );
  let showLabels = $derived(scale >= 0.55);
</script>

<div class="lineage-page">
  <div class="lineage-toolbar" role="toolbar" aria-label={$t('lineage.toolbar.label')}>
    <div class="lineage-search">
      <Search
        size="lg"
        labelText={$t('lineage.filter.search')}
        placeholder={$t('lineage.filter.search')}
        closeButtonLabelText={$t('common.search.clear')}
        bind:value={filters.search}
      />
    </div>
    <Button
      kind="ghost"
      size="field"
      icon={Filter}
      aria-haspopup="dialog"
      aria-expanded={menu === 'filters'}
      on:click={(event) => openMenu('filters', event)}
      >{activeFilters
        ? $t('lineage.toolbar.filtersActive', { count: activeFilters })
        : $t('lineage.toolbar.filters')}</Button
    >
    <Button
      kind="ghost"
      size="field"
      icon={View}
      aria-haspopup="dialog"
      aria-expanded={menu === 'view'}
      on:click={(event) => openMenu('view', event)}>{$t('lineage.toolbar.view')}</Button
    >
    {#if pickedRuns.length || (selected && index?.nodes.has(selected))}<span
        class="lineage-selection"
        role="group"
        aria-label={$t('lineage.selection.label')}
      >
        {#if selected && index?.nodes.has(selected)}<Button
            kind="ghost"
            size="field"
            icon={TreeViewAlt}
            iconDescription={$t('lineage.selection.addPath')}
            tooltipPosition="bottom"
            on:click={() => pick([...picked, ...path])}
          /><Button
            kind="ghost"
            size="field"
            icon={Branch}
            iconDescription={$t('lineage.selection.addBranch')}
            tooltipPosition="bottom"
            on:click={() => pick([...picked, selected, ...descendants(selected, index!)])}
          />{/if}
        {#if pickedRuns.length}<Button
            kind="ghost"
            size="field"
            icon={Erase}
            iconDescription={$t('lineage.selection.clear')}
            tooltipPosition="bottom"
            on:click={() => pick([])}
          /><Button
            kind="primary"
            size="field"
            icon={ChartLine}
            on:click={() => onCompare(pickedRuns)}
            >{$t('lineage.selection.compareCount', { count: pickedRuns.length })}</Button
          >{/if}
      </span>{/if}
    <span class="lineage-toolbar-actions">
      <Button
        kind="ghost"
        size="field"
        icon={Information}
        iconDescription={$t('lineage.toolbar.info')}
        tooltipPosition="bottom"
        aria-haspopup="dialog"
        aria-expanded={menu === 'info'}
        on:click={(event) => openMenu('info', event)}
      />
      <Button
        kind="ghost"
        size="field"
        icon={ZoomOut}
        iconDescription={$t('lineage.zoom.out')}
        tooltipPosition="bottom"
        on:click={() => zoom(1 / 1.25)}
      />
      <Button
        kind="ghost"
        size="field"
        icon={ZoomIn}
        iconDescription={$t('lineage.zoom.in')}
        tooltipPosition="bottom"
        on:click={() => zoom(1.25)}
      />
      <Button
        kind="ghost"
        size="field"
        icon={FitToScreen}
        iconDescription={$t('lineage.zoom.fit')}
        tooltipPosition="bottom"
        on:click={fit}
      />
      <Button
        kind="ghost"
        size="field"
        icon={InProgress}
        iconDescription={$t('lineage.zoom.running')}
        tooltipPosition="bottom"
        disabled={!runningIds.length}
        on:click={focusRunning}
      />
      <Button
        kind="ghost"
        size="field"
        icon={SettingsAdjust}
        iconDescription={$t('lineage.settings.open')}
        tooltipPosition="bottom"
        tooltipAlignment="end"
        on:click={() => (settingsOpen = true)}
      />
    </span>
  </div>
  {#if menu && menuAnchor}<ContextPopover
      anchor={menuAnchor}
      title={menu === 'filters'
        ? $t('lineage.toolbar.filters')
        : menu === 'view'
          ? $t('lineage.toolbar.view')
          : $t('lineage.toolbar.info')}
      onClose={closeMenu}
      width={320}
    >
      {#if menu === 'filters'}<div class="form-stack lineage-menu">
          <Select
            labelText={$t('lineage.filter.group.label')}
            selected={filters.group}
            on:change={(event) => (filters.group = valueOf(event))}
            ><SelectItem
              value=""
              text={$t('lineage.filter.group.all')}
            />{#each groups as group (group)}<SelectItem
                value={group}
                text={group}
              />{/each}</Select
          >
          <Select
            labelText={$t('lineage.filter.tag.label')}
            selected={filters.tag}
            on:change={(event) => (filters.tag = valueOf(event))}
            ><SelectItem
              value=""
              text={$t('lineage.filter.tag.all')}
            />{#each tags as tag (tag)}<SelectItem value={tag} text={tag} />{/each}</Select
          >
          {#if hosts.length}<Select
              labelText={$t('lineage.filter.host.label')}
              selected={filters.host}
              on:change={(event) => (filters.host = valueOf(event))}
              ><SelectItem
                value=""
                text={$t('lineage.filter.host.all')}
              />{#each hosts as host (host)}<SelectItem value={host} text={host} />{/each}</Select
            >{/if}
          <fieldset class="lineage-options">
            <Checkbox
              labelText={$t('lineage.filter.collapseRejected')}
              bind:checked={filters.collapseRejected}
            />
            <Checkbox
              labelText={$t('lineage.filter.showIsolated')}
              bind:checked={filters.showIsolated}
            />
          </fieldset>
        </div>{:else if menu === 'view'}<div class="form-stack lineage-menu">
          <Select
            labelText={$t('lineage.axis.label')}
            selected={axis}
            on:change={(event) => (axis = valueOf(event) as Axis)}
            >{#each axisItems as item (item.id)}<SelectItem
                value={item.id}
                text={item.text}
              />{/each}</Select
          >
          <Select
            labelText={$t('lineage.colorBy.label')}
            selected={colorBy}
            on:change={(event) => (colorBy = valueOf(event) as ColorBy)}
            ><SelectItem value="run" text={$t('lineage.colorBy.run')} /><SelectItem
              value="host"
              text={$t('lineage.colorBy.host')}
            /></Select
          >
        </div>{:else if graph && visible}<ul class="lineage-info">
          <li>{$t('lineage.summary.shown', { count: visible.shown.length })}</li>
          {#if visible.isolatedHidden}<li>
              {$t('lineage.summary.isolated', { count: visible.isolatedHidden })}
            </li>{/if}
          {#if graph.counts.unresolved}<li>
              {$t('lineage.summary.unresolved', { count: graph.counts.unresolved })}
            </li>{/if}
          {#if pickedRuns.length}<li>
              {$t('lineage.selection.count', { count: pickedRuns.length })}
            </li>{/if}
          <li class="lineage-muted">{$t('lineage.selection.hint')}</li>
        </ul>{/if}
    </ContextPopover>{/if}
  {#if error}<InlineNotification
      lowContrast
      kind="error"
      title={$t('lineage.errors.loadFailed')}
      subtitle={$t(error)}
      closeButtonDescription={$t('common.notification.close')}
      on:close={() => (error = '')}
    />{/if}
  <div class="lineage-body" class:with-details={!!selected && !!index?.nodes.has(selected)}>
    <div
      class="lineage-viewport"
      bind:this={viewport}
      role="presentation"
      onpointerdown={pointerDown}
      onpointermove={pointerMove}
      onpointerup={pointerUp}
      onpointercancel={pointerUp}
      onclickcapture={clickCapture}
    >
      {#if !graph}{#if !error}<p class="lineage-empty">{$t('common.status.loading')}</p>{/if}
      {:else if !graph.nodes.length}<p class="lineage-empty">{$t('lineage.empty.noRuns')}</p>
      {:else if !visible?.shown.length}<p class="lineage-empty">
          {visible?.matches && visible.isolatedHidden === visible.matches && !graph.edges.length
            ? $t('lineage.empty.noLinks')
            : $t('lineage.empty.noMatches')}
        </p>
      {:else if layout && index}<div
          class="lineage-canvas"
          style:width={layout.width + 'px'}
          style:height={layout.height + 'px'}
          style:transform={`translate(${tx}px, ${ty}px) scale(${scale})`}
        >
          <svg class="lineage-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {#each baseEdges as edge (edgeKey(edge))}{@const from = layout.positions.get(
                edge.source,
              )}{@const to = layout.positions.get(edge.target)}{#if from && to}<path
                  class="lineage-edge base"
                  d={edgePath(from, to)}
                />{/if}{/each}
            {#each shownEdges as edge (edgeKey(edge))}{@const from = layout.positions.get(
                edge.source,
              )}{@const to = layout.positions.get(edge.target)}{#if from && to}<path
                  class="lineage-edge"
                  class:on-path={pathSet.has(edge.target) && pathSet.has(edge.source)}
                  class:matched={!edge.explicit && !continues(edge)}
                  class:continues={continues(edge)}
                  class:rejected={index.nodes.get(edge.target)?.verdict === 'rejected'}
                  d={edgePath(from, to)}
                />{/if}{/each}
          </svg>
          {#if showLabels}{#each shownEdges as edge (edgeKey(edge))}{@const to =
                layout.positions.get(edge.target)}{#if to}{@const label =
                  edgeLabel(edge)}{#if label}<span
                    class="lineage-edge-label"
                    class:on-path={pathSet.has(edge.target)}
                    title={[index.nodes.get(edge.target)?.change, ...edge.changedKeys]
                      .filter(Boolean)
                      .join('\n')}
                    style:left={to.x - 8 + 'px'}
                    style:top={to.y + nodeHeight / 2 + 'px'}>{label}</span
                  >{/if}{/if}{/each}{/if}
          {#each visible.shown as id (id)}{@const node = index.nodes.get(id)!}{@const position =
              layout.positions.get(id)}{#if position}<LineageCard
                {node}
                delta={nameDelta(
                  node.display_name,
                  index.nodes.get(index.parent.get(id)?.source ?? '')?.display_name,
                )}
                settings={graph.settings}
                color={swatch(id)}
                x={position.x}
                y={position.y}
                selected={selected === id}
                picked={picked.has(id)}
                onPath={pathSet.has(id)}
                context={visible.context.has(id)}
                collapsed={visible.collapsed.get(id) ?? 0}
                onclick={(event) => cardClick(event, id)}
                onkeydown={(event) => cardKey(event, id)}
              />{/if}{/each}
        </div>{/if}
      {#if lasso}<div
          class="lineage-lasso"
          style:left={Math.min(lasso.x1, lasso.x2) + 'px'}
          style:top={Math.min(lasso.y1, lasso.y2) + 'px'}
          style:width={Math.abs(lasso.x2 - lasso.x1) + 'px'}
          style:height={Math.abs(lasso.y2 - lasso.y1) + 'px'}
        ></div>{/if}
      {#if layout && visible?.shown.length}<dl class="lineage-legend">
          <div>
            <dt>
              <svg width="28" height="8" aria-hidden="true"
                ><path class="lineage-edge" d="M0,4 H28" /></svg
              >
            </dt>
            <dd>{$t('lineage.legend.logged')}</dd>
          </div>
          <div>
            <dt>
              <svg width="28" height="8" aria-hidden="true"
                ><path class="lineage-edge matched" d="M0,4 H28" /></svg
              >
            </dt>
            <dd>{$t('lineage.legend.matched')}</dd>
          </div>
          <div>
            <dt>
              <svg width="28" height="8" aria-hidden="true"
                ><path class="lineage-edge continues" d="M0,4 H28" /></svg
              >
            </dt>
            <dd>{$t('lineage.legend.continues')}</dd>
          </div>
          <div>
            <dt>
              <svg width="28" height="8" aria-hidden="true"
                ><path class="lineage-edge base" d="M0,4 H28" /></svg
              >
            </dt>
            <dd>{$t('lineage.legend.base')}</dd>
          </div>
          <div>
            <dt><span class="lineage-legend-running"></span></dt>
            <dd>{$t('lineage.legend.running')}</dd>
          </div>
        </dl>{/if}
    </div>
    {#if selected && index?.nodes.has(selected) && graph}<LineageDetails
        node={index.nodes.get(selected)!}
        {index}
        {graph}
        run={runById.get(selected)}
        pathRuns={path.map((id) => runById.get(id)).filter((run): run is Run => !!run)}
        {plugins}
        {colors}
        {dark}
        onClose={closeDetails}
        onSelect={(id) => select(id, true)}
        {onRun}
      />{/if}
  </div>
</div>
{#if settingsOpen && graph}<LineageSettingsModal
    {project}
    {runs}
    settings={graph.settings}
    onClose={() => (settingsOpen = false)}
    onSaved={() => {
      settingsOpen = false;
      void load();
    }}
  />{/if}
