<script lang="ts">
  // The Lineage page (README "Lineage"): runs as cards, linked from the run whose checkpoint
  // each started from. The server derives the graph; this page filters, lays out and explains it.
  import { onMount, tick, untrack } from 'svelte';
  import { Button, Dropdown, InlineNotification, Search, Checkbox } from 'carbon-components-svelte';
  import ZoomIn from 'carbon-icons-svelte/lib/ZoomIn.svelte';
  import ZoomOut from 'carbon-icons-svelte/lib/ZoomOut.svelte';
  import CenterToFit from 'carbon-icons-svelte/lib/CenterToFit.svelte';
  import SettingsAdjust from 'carbon-icons-svelte/lib/SettingsAdjust.svelte';
  import { tool, apiMessage } from './api';
  import { t, number, type Message } from './i18n';
  import type { Plugin, Run } from './types';
  import LineageDetails from './LineageDetails.svelte';
  import LineageSettingsModal from './LineageSettings.svelte';
  import LineageCard from './LineageCard.svelte';
  import {
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
  }: {
    project: string;
    runs: Run[];
    revision: number;
    plugins: Plugin[];
    colors: Record<string, string>;
    dark: boolean;
    onRun: (run: Run) => void;
  } = $props();

  let graph = $state.raw<LineageGraph | null>(null),
    error = $state<Message>(''),
    filters = $state<Filters>({
      search: '',
      group: '',
      tag: '',
      collapseRejected: false,
      showIsolated: false,
    }),
    axis = $state<Axis>('depth'),
    selected = $state(new URL(location.href).searchParams.get('run') || ''),
    settingsOpen = $state(false);

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
  let groups = $derived(
    [...new Set(graph?.nodes.map((node) => node.group).filter(Boolean))].sort(),
  );
  let tags = $derived([...new Set(graph?.nodes.flatMap((node) => node.tags))].sort());
  const runById = $derived(new Map(runs.map((run) => [run.id, run])));

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
        // Open on the selected run, else the newest linked run, at a readable size.
        const children = new Set(edges.map((edge) => edge.target)),
          newest = ids.filter((id) => children.has(id)).at(-1);
        const focus = selected && layout.positions.has(selected) ? selected : newest;
        if (focus) centre(focus, 0.8);
        else fit();
      }
    })();
  });

  // Pan and zoom: the canvas is translated and scaled inside a clipped viewport.
  let viewport = $state<HTMLDivElement>(),
    scale = $state(1),
    tx = $state(16),
    ty = $state(16);
  const minScale = 0.15,
    maxScale = 2;
  function zoomAt(factor: number, cx: number, cy: number) {
    const next = Math.min(maxScale, Math.max(minScale, scale * factor));
    tx = cx - ((cx - tx) * next) / scale;
    ty = cy - ((cy - ty) * next) / scale;
    scale = next;
  }
  function zoom(factor: number) {
    if (viewport) zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
  }
  function fit() {
    if (!layout || !viewport) return;
    const margin = 32,
      width = viewport.clientWidth - margin * 2,
      height = viewport.clientHeight - margin * 2;
    scale = Math.min(1, Math.max(minScale, Math.min(width / layout.width, height / layout.height)));
    tx = margin + Math.max(0, (width - layout.width * scale) / 2);
    ty = margin;
  }
  function centre(id: string, at: number) {
    const position = layout?.positions.get(id);
    if (!position || !viewport) return;
    scale = at;
    tx = viewport.clientWidth / 2 - (position.x + nodeWidth / 2) * scale;
    ty = viewport.clientHeight / 2 - (position.y + nodeHeight / 2) * scale;
  }
  /** Pans so a run's card is in view, at the given scale if any. */
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
  let drag: { x: number; y: number; tx: number; ty: number; id: number } | null = null;
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || (event.target as Element).closest('button, a')) return;
    drag = { x: event.clientX, y: event.clientY, tx, ty, id: event.pointerId };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return;
    tx = drag.tx + event.clientX - drag.x;
    ty = drag.ty + event.clientY - drag.y;
  }
  // Wheel zoom needs preventDefault, so the listener is not passive.
  $effect(() => {
    const element = viewport;
    if (!element) return;
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });
  function wheel(event: WheelEvent) {
    event.preventDefault();
    const box = viewport!.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey)
      zoomAt(Math.exp(-event.deltaY / 300), event.clientX - box.left, event.clientY - box.top);
    else {
      tx -= event.deltaX;
      ty -= event.deltaY;
    }
  }

  // Selection lives in the URL (`?run=`), so a reload or shared link opens the same run.
  function select(id: string, focus = false) {
    selected = id;
    const url = new URL(location.href);
    if (id) url.searchParams.set('run', id);
    else url.searchParams.delete('run');
    history.replaceState(history.state, '', url);
    if (id) {
      reveal(id);
      if (focus) void tick().then(() => cardButton(id)?.focus());
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

  const edgeKey = (edge: LineageEdge) => edge.source + '>' + edge.target;
  function edgeLabel(edge: LineageEdge) {
    const parts: string[] = [];
    if (edge.update !== null)
      parts.push(
        $t('lineage.edge.update', { update: $number(edge.update, { notation: 'compact' }) }),
      );
    const keys = edge.changedKeys.slice(0, 2).map(shortKey);
    if (keys.length) parts.push(keys.join(', '));
    if (edge.changeCount > keys.length)
      parts.push($t('lineage.edge.more', { count: edge.changeCount - keys.length }));
    return parts.join(' · ');
  }
  function edgeTitle(edge: LineageEdge) {
    return edge.changedKeys.join('\n');
  }
  const axisItems = $derived([
    { id: 'depth', text: $t('lineage.axis.depth') },
    { id: 'update', text: $t('lineage.axis.update') },
    { id: 'time', text: $t('lineage.axis.time') },
  ]);
  const menuLabel = (id: string) =>
    $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close');
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
    <Dropdown
      size="lg"
      type="inline"
      translateWithId={menuLabel}
      labelText={$t('lineage.filter.group.label')}
      selectedId={filters.group}
      items={[
        { id: '', text: $t('lineage.filter.group.all') },
        ...groups.map((group) => ({ id: group, text: group })),
      ]}
      on:select={(event) => (filters.group = String(event.detail.selectedId))}
    />
    <Dropdown
      size="lg"
      type="inline"
      translateWithId={menuLabel}
      labelText={$t('lineage.filter.tag.label')}
      selectedId={filters.tag}
      items={[
        { id: '', text: $t('lineage.filter.tag.all') },
        ...tags.map((tag) => ({ id: tag, text: tag })),
      ]}
      on:select={(event) => (filters.tag = String(event.detail.selectedId))}
    />
    <Dropdown
      size="lg"
      type="inline"
      translateWithId={menuLabel}
      labelText={$t('lineage.axis.label')}
      selectedId={axis}
      items={axisItems}
      on:select={(event) => (axis = event.detail.selectedId as Axis)}
    />
    <fieldset class="lineage-options">
      <Checkbox
        labelText={$t('lineage.filter.collapseRejected')}
        bind:checked={filters.collapseRejected}
      />
      <Checkbox labelText={$t('lineage.filter.showIsolated')} bind:checked={filters.showIsolated} />
    </fieldset>
    <span class="lineage-toolbar-actions">
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
        icon={CenterToFit}
        iconDescription={$t('lineage.zoom.fit')}
        tooltipPosition="bottom"
        on:click={fit}
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
  {#if graph && visible}<p class="lineage-summary" role="status">
      {[
        $t('lineage.summary.shown', { count: visible.shown.length }),
        visible.isolatedHidden
          ? $t('lineage.summary.isolated', { count: visible.isolatedHidden })
          : '',
        graph.counts.unresolved
          ? $t('lineage.summary.unresolved', { count: graph.counts.unresolved })
          : '',
      ]
        .filter(Boolean)
        .join(' · ')}
    </p>{/if}
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
      onpointerup={() => (drag = null)}
      onpointercancel={() => (drag = null)}
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
            {#each shownEdges as edge (edgeKey(edge))}{@const from = layout.positions.get(
                edge.source,
              )}{@const to = layout.positions.get(edge.target)}{#if from && to}<path
                  class="lineage-edge"
                  class:on-path={pathSet.has(edge.target) && pathSet.has(edge.source)}
                  class:matched={!edge.explicit}
                  d={edgePath(from, to)}
                />{/if}{/each}
          </svg>
          {#if showLabels}{#each shownEdges as edge (edgeKey(edge))}{@const to =
                layout.positions.get(edge.target)}{#if to}{@const label =
                  edgeLabel(edge)}{#if label}<span
                    class="lineage-edge-label"
                    class:on-path={pathSet.has(edge.target)}
                    title={edgeTitle(edge)}
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
                x={position.x}
                y={position.y}
                selected={selected === id}
                onPath={pathSet.has(id)}
                context={visible.context.has(id)}
                collapsed={visible.collapsed.get(id) ?? 0}
                onselect={() => select(selected === id ? '' : id)}
                onkeydown={(event) => cardKey(event, id)}
              />{/if}{/each}
        </div>{/if}
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
