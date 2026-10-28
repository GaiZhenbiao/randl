<script lang="ts">
  import { t, locale, type Message, type MessageKey } from './i18n';

  import { onMount, tick, untrack } from 'svelte';
  import { Button, OverflowMenu, OverflowMenuItem } from 'carbon-components-svelte';
  import Draggable from 'carbon-icons-svelte/lib/Draggable.svelte';
  import Reset from 'carbon-icons-svelte/lib/Reset.svelte';
  import Maximize from 'carbon-icons-svelte/lib/Maximize.svelte';
  import Minimize from 'carbon-icons-svelte/lib/Minimize.svelte';
  import Settings from 'carbon-icons-svelte/lib/Settings.svelte';
  import {
    loadChart,
    storedChart,
    finishInCache,
    chartDataSettings,
    retainHiddenRenderer,
    releaseHiddenRenderer,
    rendererCost,
    chartSelection,
  } from './chart-loader';
  import panelLimits from '../../backend/src/panel-limits.json';
  import { mountPlugin } from './plugins/registry';
  import { runFocus, setHoveredRuns, plotCursor, type RunFocus } from './hover';
  import { scheduleLinked, cancelLinked } from './linked-frame';
  import { schedulePanel, cancelPanel } from './panel-frame';
  import { focusedRun, focusedSeries, supportsFocusedRun } from './focused-run';
  import { groupValueLabel } from './ui';
  import { apiMessage } from './api';
  import { pluginLocalizer, type Localize } from './plugins/catalogs';
  import { resolveOptions } from '../../backend/src/plugin-options';
  import type {
    Panel,
    Run,
    Plugin,
    ChartData,
    Renderer,
    PanelContext,
    RecordTransform,
    PlotSettings,
  } from './types';
  import { CellGrid, cellWidth } from './cell-grid';
  import { pluginExtent } from './plugins/registry';
  import { Select, SelectItem, Slider } from 'carbon-components-svelte';
  import ChevronLeft from 'carbon-icons-svelte/lib/ChevronLeft.svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import { coverflowItems, mediaRuns, mediaSteps } from './panel-session';
  import ZoomIn from 'carbon-icons-svelte/lib/ZoomIn.svelte';
  import ZoomOut from 'carbon-icons-svelte/lib/ZoomOut.svelte';
  import { mediaCount as fileCount } from '../../backend/src/media-items';
  let {
    panel,
    emptySelectionText = 'panel.empty.noVisibleRuns',
    colors = {},
    pinned = [],
    runs,
    plugin,
    dark,
    onedit,
    onremove,
    onduplicate,
    onmove,
    onresizestart,
    onresizekey,
    resizeLabel = 'workspace.section.resizePanels',
    onreorderstart,
    reordering = false,
    columns = 1,
    position = 0,
    count = 1,
    readonly = false,
    height = 300,
    onsettings,
    session,
  }: {
    panel: Panel;
    emptySelectionText?: MessageKey;
    colors?: Record<string, string>;
    pinned?: string[];
    runs: Run[];
    plugin: Plugin | undefined;
    dark: boolean;
    onedit: () => void;
    onremove: () => void;
    onduplicate: () => void;
    onmove: (direction: number, keyboard?: boolean) => void;
    onresizestart?: (event: PointerEvent) => void;
    resizeLabel?: Message;
    onresizekey?: (event: KeyboardEvent) => void;
    onreorderstart?: (event: PointerEvent) => void;
    reordering?: boolean;
    columns?: number;
    position?: number;
    count?: number;
    readonly?: boolean;
    height?: number;
    /** Saves settings changed in the panel itself, such as the grid's item size. */
    onsettings?: (settings: PlotSettings) => void;
    /** Keys of this tab's unsaved choices: the section's media step and the panel's own. */
    session?: { section: string; panel: string };
  } = $props();
  let container: HTMLElement, plot: HTMLDivElement;
  let visible = $state(false),
    loading = $state(false),
    status = $state<Message>(''),
    renderError = $state<Message>(''),
    focusWithin = $state(false),
    expanded = $state(false),
    data = $state.raw<ChartData | null>(null),
    renderer = $state.raw<Renderer | undefined>(),
    range = $state.raw<{ xMin: number; xMax: number } | null>(null);
  // Full screen puts the panel in the top layer over the whole viewport and makes
  // everything else inert, so focus stays in the panel until it is restored.
  $effect(() => {
    if (!expanded) return;
    const node = container,
      inert: HTMLElement[] = [];
    node.setAttribute('popover', 'manual');
    node.showPopover();
    for (let child: HTMLElement | null = node; child?.parentElement; child = child.parentElement)
      for (const sibling of child.parentElement.children)
        if (sibling !== child && sibling instanceof HTMLElement && !sibling.inert) {
          sibling.inert = true;
          inert.push(sibling);
        }
    node.querySelector<HTMLElement>('.chart-expand')?.focus({ preventScroll: true });
    return () => {
      for (const element of inert) element.inert = false;
      if (node.matches(':popover-open')) node.hidePopover();
      node.removeAttribute('popover');
      void tick().then(() =>
        node.querySelector<HTMLElement>('.chart-expand')?.focus({ preventScroll: true }),
      );
    };
  });
  function startTitleDrag(event: PointerEvent) {
    if (
      event.pointerType === 'touch' &&
      !(event.currentTarget as HTMLElement).classList.contains('panel-drag-handle')
    )
      return;
    onreorderstart?.(event);
  }
  let computed = $derived(plugin?.settings.common.includes('expressions') ? panel.expressions || [] : []);
  let metrics = $derived(
    panel.metrics?.length ? panel.metrics : computed.length ? [] : [panel.metric],
  );
  // Computed metrics and multi-metric stacks are evaluated per record before sampling. With
  // computed metrics, plain metrics travel as ${name} so every series comes from one request.
  let recordTransform = $derived<RecordTransform | undefined>(
    computed.length
      ? {
          kind: 'compute',
          expressions: [
            ...metrics.map((name) => ({ name, expression: '${' + name + '}' })),
            ...computed,
          ],
          ...(plugin?.recordTransform && metrics.length + computed.length > 1
            ? { align: plugin.recordTransform.normalization }
            : {}),
        }
      : plugin?.recordTransform && metrics.length > 1
        ? plugin.recordTransform
        : undefined,
  );
  let requestMetrics = $derived(
    recordTransform?.kind === 'compute'
      ? recordTransform.expressions.map((item) => item.name)
      : metrics,
  );
  let plotSettings = $derived({
    ...panel.settings,
    ...(plugin?.metricSelection === 'xy' && metrics.length > 1 ? { xAxis: metrics[1] } : {}),
    ...range,
  });
  // Every compared run is plotted unless the panel, section, or workspace sets a run limit.
  let runLimit = $derived(
    typeof plotSettings.maxRuns === 'number' ? plotSettings.maxRuns : undefined,
  );
  let grouped = $derived(
    plugin?.dataKind !== 'media' && !!plotSettings.groupBy && plotSettings.groupBy !== 'none',
  );
  let requestedRuns = $derived(
    grouped
      ? runs
      : [
          ...runs.filter((run) => pinned.includes(run.id)),
          ...runs
            .filter((run) => !pinned.includes(run.id))
            .slice(
              0,
              runLimit === undefined
                ? undefined
                : Math.min(
                    runLimit,
                    panelLimits.chartRuns - runs.filter((run) => pinned.includes(run.id)).length,
                  ),
            ),
        ],
  );
  // Grouped charts aggregate every selected run on the server; others plot a bounded set.
  let overRequestLimit = $derived(!grouped && requestedRuns.length > panelLimits.chartRuns);
  let focused = $derived(
    plotSettings.maxRuns === 'focused' && supportsFocusedRun(plugin, requestMetrics.length),
  );
  // Load only the displayed run. Previously every candidate consumed the same
  // transform input budget before any output could be sampled.
  let demandRun = $derived(
    focused && !grouped
      ? focusedRun(requestedRuns, readonly ? null : $runFocus, panel.id)
      : undefined,
  );
  // Grid and Coverflow: a cell per run or group for plugins that declare cellLayout. Focused
  // run takes precedence, and a single run draws as one chart.
  let cellMode = $derived(
    plugin?.settings.common.includes('cellLayout') &&
      (plotSettings.layout === 'grid' || plotSettings.layout === 'coverflow') &&
      !focused &&
      (grouped || requestedRuns.length > 1)
      ? plotSettings.layout
      : undefined,
  );
  let cells = $derived(cellMode === 'grid');
  const toolbarHeight = 32;
  // The slider's size while it moves; releasing it saves the size to the panel.
  let draggedSize = $state<number | undefined>();
  let itemSize = $derived(draggedSize ?? plotSettings.itemSize ?? panelLimits.itemSize.chart);
  $effect(() => {
    plotSettings.itemSize;
    draggedSize = undefined;
  });
  let gridState = $state({ count: 0, size: 0, mounted: 0, exportable: false });
  // Export PNG applies when the plugin's renderers export images; a grid composes its cells'.
  let exportable = $derived(
    renderer instanceof CellGrid ? gridState.exportable : !!renderer?.exportImage,
  );
  let cellToolbar = $derived(cells && gridState.count > 1 && !readonly);
  // The size the toolbar shows: a grid's effective size, or a media panel's own.
  let sizeShown = $derived(cells ? gridState.size : itemSize);
  function commitSize(size: number) {
    const next = Math.max(
      panelLimits.itemSize.min,
      Math.min(panelLimits.itemSize.max, Math.round(size / panelLimits.itemSize.step) * panelLimits.itemSize.step),
    );
    draggedSize = next;
    onsettings?.({ itemSize: next });
  }
  let fetchRuns = $derived(
    demandRun ? requestedRuns.filter((run) => run.id === demandRun.id) : requestedRuns,
  );
  // Media: the step shown across runs is shared by a section's media panels in this tab
  // (absent: the latest step, following new data). Steps of one run show the run chosen
  // here, by default the newest.
  let mediaPanel = $derived(plugin?.dataKind === 'media');
  let tiled = $derived(!!plugin?.settings.common.includes('itemLayout'));
  let mediaAcross = $derived(tiled && plotSettings.mediaAcross === 'steps' ? 'steps' : 'runs');
  let sessionKeys = $derived(session ?? { section: panel.id, panel: panel.id });
  let mediaStep = $derived($mediaSteps.get(sessionKeys.section));
  let mediaRun = $derived(
    mediaAcross === 'steps'
      ? (fetchRuns.find((run) => run.id === $mediaRuns.get(sessionKeys.panel)) ??
          focusedRun(fetchRuns, null, panel.id))
      : undefined,
  );
  let draggedStep = $state<number | undefined>();
  function chooseStep(index: number) {
    const steps = data?.steps || [];
    draggedStep = undefined;
    // Choosing the last step follows the latest again.
    mediaSteps.set(
      sessionKeys.section,
      index >= steps.length - 1 ? undefined : steps[Math.max(0, index)],
    );
  }
  let stepIndex = $derived.by(() => {
    const steps = data?.steps || [],
      step = data?.step;
    if (step == null) return steps.length - 1;
    let index = steps.length - 1;
    while (index > 0 && steps[index] > step) index--;
    return index;
  });
  let mediaCount = $derived.by(() => {
    let shown = 0,
      total = 0;
    for (const entry of data?.entries || [])
      if (entry.value) {
        const files = fileCount(entry.value);
        shown += files;
        total += entry.files ?? files;
      }
    return { shown, total };
  });
  let mediaToolbar = $derived(mediaPanel && !readonly && !!data?.entries);
  // Step and layout changes are announced once they settle, never on hover.
  let announcement = $state('');
  $effect(() => {
    const text =
      mediaPanel && data?.step != null
        ? $t('media.toolbar.stepAnnounce', { step: data.step, count: mediaCount.shown })
        : '';
    const timer = setTimeout(() => (announcement = text), 500);
    return () => clearTimeout(timer);
  });
  // Keys on a grid tile or Coverflow: [ and ] step through logged media steps; + and - resize
  // grid items.
  function plotKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('[role="gridcell"], .carousel-slide, .carousel-chip')) return;
    if ((event.key === '[' || event.key === ']') && mediaPanel && mediaAcross === 'runs') {
      event.preventDefault();
      chooseStep(stepIndex + (event.key === ']' ? 1 : -1));
    } else if (['+', '=', '-'].includes(event.key) && target.closest('[role="gridcell"]')) {
      event.preventDefault();
      commitSize(sizeShown + (event.key === '-' ? -40 : 40));
    }
  }
  let displayedSeries = $derived(
    focused && data
      ? focusedSeries(data.series, requestedRuns, readonly ? null : $runFocus, panel.id)
      : undefined,
  );
  let displayedData = $derived(
    focused && data ? { ...data, series: displayedSeries ? [displayedSeries] : [] } : data,
  );
  let displayedName = $derived(
    displayedSeries?.group?.field === 'all'
      ? $t('charts.groups.allRuns')
      : displayedSeries?.group
        ? groupValueLabel(displayedSeries.group.field, displayedSeries.group.value, $t)
        : displayedSeries?.name,
  );
  let focusedEmpty = $derived(
    focused &&
      displayedSeries &&
      !loading &&
      !Object.values(displayedSeries.values).some((points) => points.length),
  );
  // A compact count stays readable when the note shrinks; the sentence describes it.
  let limitCounts = $derived(
    runLimit === undefined || overRequestLimit
      ? null
      : grouped
        ? data?.groupCount && data.series.length < data.groupCount
          ? { groups: true, shown: data.series.length, total: data.groupCount }
          : null
        : requestedRuns.length < runs.length
          ? { groups: false, shown: requestedRuns.length, total: runs.length }
          : null,
  );
  let limitNote = $derived(
    limitCounts
      ? $t(limitCounts.groups ? 'panel.limit.groups' : 'panel.limit.runs', {
          shown: limitCounts.shown,
          total: limitCounts.total,
        })
      : '',
  );
  let limitText = $derived(
    limitCounts
      ? $t(limitCounts.groups ? 'panel.limit.groupsTitle' : 'panel.limit.runsTitle', {
          shown: limitCounts.shown,
          total: limitCounts.total,
        })
      : '',
  );
  // Without downsampling, a panel stops at its point limit and says so.
  let pointCounts = $derived(
    data?.pointLimit && data.resolution === 'full'
      ? {
          shown: data.series.reduce(
            (sum, series) =>
              sum +
              Object.values(series.values).reduce((count, points) => count + points.length, 0),
            0,
          ),
          total: data.pointLimit.total,
          limit: data.pointLimit.limit,
        }
      : null,
  );
  // CSS pixels across the plot, rounded up to a power of two so resizing within a
  // step reuses the loaded points.
  // Grid cells request at their own plot width; the server splits the panel's point budget.
  let plotWidth = $state(0),
    plotHeight = $state(0),
    laidOut = $derived(plotWidth > 0),
    pixels = $derived(
      Math.min(
        panelLimits.chartPixels,
        2 **
          Math.ceil(
            Math.log2(
              Math.max(
                16,
                cells ? cellWidth(plotWidth - 16, plotHeight - toolbarHeight, itemSize) : plotWidth,
              ),
            ),
          ),
      ),
    );
  // Grouped requests name the shared run selection instead of listing up to 100,000 IDs.
  let selection = $derived(
    grouped && plugin?.dataKind !== 'media' ? chartSelection(fetchRuns) : undefined,
  );
  let requestKey = $derived(
    JSON.stringify({
      endpoint: plugin?.dataKind === 'media' ? '/api/media' : '/api/chart',
      count: fetchRuns.length,
      request: {
        ...(selection ? { selection: selection.token } : { runs: fetchRuns.map((r) => r.id) }),
        ...(plugin?.dataKind === 'media'
          ? {
              metric: panel.metric,
              files: plotSettings.mediaFiles ?? panelLimits.media.files.default,
              ...(mediaAcross === 'steps'
                ? { across: 'steps', run: mediaRun?.id }
                : mediaStep === undefined
                  ? {}
                  : { step: mediaStep }),
            }
          : {
              metrics: requestMetrics,
              mode: plugin?.dataKind === 'snapshot' ? 'snapshot' : 'history',
              ...(plugin?.dataKind === 'snapshot' ? {} : { pixels }),
              ...(recordTransform ? { recordTransform } : {}),
              settings: chartDataSettings({
                ...plotSettings,
                maxRuns: grouped ? runLimit : undefined,
                ...(!plugin?.settings.common.includes('axes')
                  ? { xAxis: undefined, xMin: undefined, xMax: undefined }
                  : {}),
                ...(!plugin?.settings.common.includes('spread') ? { spread: undefined } : {}),
              }),
            }),
      },
      versions:
        selection?.versions ??
        JSON.stringify(
          fetchRuns
            .map((r) => [r.id, r.revision])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ),
    }),
  );
  let axisKey = $derived(
    JSON.stringify([panel.settings?.xAxis, panel.settings?.xMin, panel.settings?.xMax, panel.id]),
  );
  $effect(() => {
    axisKey;
    range = null;
  });
  // `retained` keeps a hidden panel's renderer and data until the shared limit evicts it.
  let showing = $derived(visible || expanded || focusWithin),
    retained = $state(false),
    active = $derived(showing || retained);
  const owner = {};
  $effect(() => {
    if (showing) {
      retained = true;
      releaseHiddenRenderer(owner);
    } else if (untrack(() => retained)) {
      const bytes = untrack(() => {
        const data = displayedData;
        const original =
          plugin?.settings.common.includes('original') &&
          plotSettings.showOriginal &&
          plotSettings.smoothingMethod !== 'none';
        const series =
          data?.series.reduce(
            (count, item) =>
              count +
              data!.metrics.length * (original ? 2 : 1) +
              (plotSettings.spread && plotSettings.spread !== 'none'
                ? Object.keys(item.bands || {}).length * 2
                : 0),
            0,
          ) || 0;
        return rendererCost(plot, data, series);
      });
      retainHiddenRenderer(
        owner,
        () => (retained = false),
        bytes,
        untrack(() => (cells ? Math.max(1, gridState.mounted) : 1)),
      );
    }
  });
  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting), {
      root: readonly ? null : document.querySelector('main'),
      rootMargin: '100px',
    });
    observer.observe(container);
    plotWidth = plot.clientWidth;
    plotHeight = plot.clientHeight;
    const resize = new ResizeObserver(([entry]) => {
      plotWidth = entry.contentRect.width;
      plotHeight = entry.contentRect.height;
      renderer?.resize();
    });
    resize.observe(plot);
    return () => {
      observer.disconnect();
      resize.disconnect();
      releaseHiddenRenderer(owner);
      cancelLinked(owner);
      cancelPanel(owner);
    };
  });
  $effect(() => {
    const current = plugin;
    if (!active) return;
    if (!current?.enabled) {
      renderError = 'panel.errors.pluginUnavailable';
      return;
    }
    renderError = '';
    if (cellMode) {
      const grid = new CellGrid(
        plot,
        {
          plugin: current,
          // Panels are keyed by ID; the panel object itself is new on every parent update.
          panelId: untrack(() => panel.id),
          onRange: (next) => (range = next),
          onHover: (ids) => {
            if (!readonly) setHoveredRuns(panel.id, ids);
          },
          onCursor: (key, cursor) => {
            if (readonly) return;
            const source = panel.id + '#' + key;
            if (cursor) plotCursor.set({ ...cursor, source });
            else if (untrack(() => $plotCursor)?.source === source) plotCursor.set(null);
          },
          onError: (error) => (renderError = apiMessage(error)),
          onState: (state) => (gridState = state),
          current: () => $coverflowItems.get(sessionKeys.panel),
          onCurrent: (key) => coverflowItems.set(sessionKeys.panel, key),
        },
        untrack(() => itemSize),
        cellMode,
      );
      renderer = grid;
      return () => {
        grid.destroy();
        if (!readonly) setHoveredRuns(panel.id, []);
        if (renderer === grid) renderer = undefined;
      };
    }
    let stopped = false,
      owned: Renderer | undefined;
    void mountPlugin(
      current,
      plot,
      (next) => (range = next),
      (ids) => {
        if (!readonly) setHoveredRuns(panel.id, ids);
      },
      (error) => {
        if (!stopped) renderError = apiMessage(error);
      },
      (cursor) => {
        if (readonly) return;
        if (cursor) plotCursor.set({ ...cursor, source: panel.id });
        else if ($plotCursor?.source === panel.id) plotCursor.set(null);
      },
    )
      .then((value) => {
        owned = value;
        if (stopped) value.destroy();
        else renderer = value;
      })
      .catch((error) => {
        if (!stopped) renderError = apiMessage(error);
      });
    return () => {
      stopped = true;
      owned?.destroy();
      if (!readonly) setHoveredRuns(panel.id, []);
      if (renderer === owned) renderer = undefined;
    };
  });
  // Identifies the response in `data`, so a stored copy is not shown again.
  let shown = '';
  $effect(() => {
    if (!plugin?.enabled || !active) {
      data = null;
      shown = '';
      return;
    }
    if (!showing) return;
    const { endpoint, request, versions, count } = JSON.parse(requestKey);
    if (!laidOut) return;
    if (!count) {
      data = null;
      shown = '';
      status = emptySelectionText;
      return;
    }
    if (overRequestLimit) {
      data = null;
      shown = '';
      status = {
        key: 'panel.limit.visibleRuns',
        values: { limit: panelLimits.chartRuns, count: requestedRuns.length },
      };
      return;
    }
    const show = (result: ChartData, id: string, partial = false) => {
      shown = id;
      // An unchanged media response keeps the mounted tiles and any playback.
      if (
        !result.entries ||
        JSON.stringify([result.entries, result.steps]) !==
          JSON.stringify(untrack(() => [data?.entries, data?.steps]))
      )
        data = result;
      const empty = !(
        result.entries?.some((entry) => entry.value) ||
        result.series.some(
          (s) =>
            Object.values(s.values).some((v) => v.length) ||
            Object.values(s.attributes || {}).some((value) => value != null),
        )
      );
      if (partial) {
        if (!empty) status = '';
        return;
      }
      status = empty ? 'panel.empty.noData' : '';
    };
    // A panel returning to view, shrinking or lowering its resolution draws stored
    // points at once. Otherwise the closest stored points stay in view until the
    // missing ones arrive.
    const stored = storedChart(endpoint, request, versions);
    if (stored && shown !== stored.id + '|' + stored.versions)
      show(stored.read(), stored.id + '|' + stored.versions);
    if (stored?.current) return;
    const controller = new AbortController(),
      id = JSON.stringify([endpoint, request]) + '|' + versions;
    if (!untrack(() => data)) status = 'common.status.loading';
    loading = true;
    void loadChart(endpoint, request, versions, controller.signal, (partial) => {
      if (controller.signal.aborted) return;
      // Runs that have not arrived yet are named from the run list for the legend.
      const names = new Map(untrack(() => runs).map((run) => [run.id, run.display_name]));
      show(
        {
          ...partial,
          series: partial.series.map((s) => (s.name ? s : { ...s, name: names.get(s.id) || s.id })),
        },
        id,
        true,
      );
    })
      .then((result) => {
        if (!controller.signal.aborted) show(result, id);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') status = apiMessage(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    return () => {
      loading = false;
      // Finish started focus loads into the shared cache. They keep their scheduler
      // slot until completion, so rapid hovering cannot flood the database worker.
      controller.abort(untrack(() => showing && !focused) ? undefined : finishInCache);
    };
  });
  // The live item size and the plugin's extent export reach the grid.
  $effect(() => {
    if (renderer instanceof CellGrid) renderer.setSize(itemSize);
  });
  $effect(() => {
    const grid = renderer;
    if (!(grid instanceof CellGrid) || !plotSettings.sharedY || !plugin) return;
    let stale = false;
    void pluginExtent(plugin).then((extent) => {
      if (!stale) grid.setExtent(extent);
    });
    return () => {
      stale = true;
      grid.setExtent(undefined);
    };
  });
  // Plugin options reach the renderer resolved and defaulted, not inside `panel.settings`.
  let options = $derived(
    plugin ? resolveOptions(plugin.settings.options, plotSettings.options?.[plugin.id]).values : {},
  );
  let localize = $state.raw<Localize | undefined>();
  $effect(() => {
    const current = plugin,
      language = $locale;
    if (!current) return;
    let stale = false;
    localize = undefined;
    void pluginLocalizer(current, language).then((next) => {
      if (!stale) localize = next;
    });
    return () => {
      stale = true;
    };
  });
  // A hidden retained renderer defers changes (colors, theme, smoothing) until it
  // returns; returning without changes redraws nothing.
  let pending: { renderer: Renderer; context: PanelContext } | null = null,
    updateToken = {};
  function applyPending() {
    if (!pending) return;
    schedulePanel(owner, () => {
      const { renderer: current, context } = pending!,
        token = {};
      pending = null;
      updateToken = token;
      try {
        renderError = '';
        // A queued linked highlight must not lag the new data it describes.
        if (!readonly)
          current.highlightRuns?.($runFocus?.ids || [], $runFocus?.source === panel.id);
        const update = current.update(context);
        if (update instanceof Promise)
          update.catch((error) => {
            if (updateToken === token) renderError = { text: error.message };
          });
      } catch (error) {
        renderError = { text: (error as Error).message };
      }
    });
  }
  $effect(() => {
    const current = renderer,
      values = displayedData,
      messages = localize,
      { options: _, ...settings } = plotSettings,
      context = {
        locale: $locale,
        translate: $t,
        localize: messages!,
        options,
        colors,
        data: values!,
        panel: {
          ...panel,
          // With computed metrics, a renderer plots every requested series as a metric.
          ...(values?.recordTransform?.kind === 'compute'
            ? { metric: values.metrics[0], metrics: values.metrics }
            : {}),
          settings: {
            ...(values?.xAxis ? { xAxis: values.xAxis } : {}),
            ...settings,
            // Media tiles follow the size slider while it moves.
            ...(tiled ? { itemSize } : {}),
          },
        },
        dark,
      };
    if (!current || !values || !messages) {
      pending = null;
      cancelPanel(owner);
      return;
    }
    pending = { renderer: current, context };
    if (untrack(() => showing)) applyPending();
    return () => {
      updateToken = {};
    };
  });
  $effect(() => {
    if (showing) applyPending();
    else cancelPanel(owner);
  });
  let wasOrigin = false,
    lastLocal = false;
  let lastFocus: RunFocus | null | undefined;
  let lastRenderer: Renderer | undefined;
  $effect(() => {
    const current = renderer,
      focus = $runFocus,
      cursor = $plotCursor;
    if (!current || readonly || !showing) {
      cancelLinked(owner);
      wasOrigin = false;
      lastRenderer = undefined;
      return;
    }
    if (current !== lastRenderer) cancelLinked(owner);
    const local = focus?.source === panel.id;
    // A grid cell's cursor is this panel's own; its sibling cells follow it at once.
    const origin =
      local || cursor?.source === panel.id || !!cursor?.source.startsWith(panel.id + '#');
    const immediate = origin || wasOrigin;
    const job = {
      ...(current.highlightRuns &&
      (immediate || current !== lastRenderer || focus !== lastFocus || local !== lastLocal)
        ? { highlight: () => current.highlightRuns!(focus?.ids || [], local) }
        : {}),
      cursor:
        current.showCursor && cursor?.source !== panel.id
          ? () => current.showCursor!(cursor)
          : undefined,
    };
    if (immediate) {
      cancelLinked(owner);
      job.highlight?.();
      job.cursor?.();
    } else if (job.highlight || job.cursor)
      scheduleLinked(owner, job, focused ? -Infinity : container.offsetTop);
    wasOrigin = origin;
    lastRenderer = current;
    lastFocus = focus;
    lastLocal = local;
  });

  function exportCSV() {
    const data = displayedData;
    if (!data) return;
    const cell = (value: unknown) => '"' + String(value).replaceAll('"', '""') + '"';
    let csv = data.snapshot ? 'series,metric,value\n' : 'series,metric,x,value\n';
    for (const series of data.series) {
      if (data.snapshot)
        for (const [metric, value] of Object.entries(series.attributes || {}))
          csv += `${cell(series.name)},${cell(metric)},${cell(value ?? '')}\n`;
      else
        for (const [metric, points] of Object.entries(series.values))
          for (const [x, y] of points) csv += `${cell(series.name)},${cell(metric)},${x},${y}\n`;
    }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      a = document.createElement('a');
    a.href = url;
    a.download = (panel.title || panel.metric).replace(/[^a-z0-9_-]/gi, '_') + '-chart.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      event.key === 'Escape' &&
      expanded &&
      ![...document.querySelectorAll(':popover-open')].some((open) => open !== container)
    )
      expanded = false;
  }}
/>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Focus tracking retains the active chart during viewport scrolling.) -->
<article
  class="chart"
  class:fullscreen={expanded}
  class:reordering
  bind:this={container}
  onfocusin={() => (focusWithin = true)}
  onfocusout={(event) => (focusWithin = container.contains(event.relatedTarget as Node))}
  data-panel-id={panel.id}
  aria-busy={loading}
  style:height={expanded ? undefined : height + 'px'}
  aria-label={panel.title || panel.metric}
>
  <div class="chart-header">
    <!-- svelte-ignore a11y_no_static_element_interactions (Blank space after the title keeps the title's pointer drag; the reorder button is the keyboard equivalent.) -->
    <div
      class="panel-title-drag-region"
      onpointerdown={readonly || expanded
        ? undefined
        : (event) => event.target === event.currentTarget && startTitleDrag(event)}
    >
      {#if !readonly && !expanded}<button
          type="button"
          class="panel-drag-handle"
          title={$t('panel.reorder', { name: panel.title || panel.metric })}
          aria-label={$t('panel.reorder', { name: panel.title || panel.metric })}
          aria-describedby="panel-reorder-help"
          onpointerdown={startTitleDrag}
          onkeydown={(event) => {
            if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
              event.preventDefault();
              onmove(
                event.key === 'ArrowUp'
                  ? -columns
                  : event.key === 'ArrowDown'
                    ? columns
                    : event.key === 'ArrowLeft'
                      ? -1
                      : 1,
              );
            }
          }}><Draggable size={16} /></button
        >{/if}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (The title is a pointer drag surface; the reorder button and menu provide keyboard equivalents.) -->
      <h3
        class="chart-title"
        tabindex="-1"
        title={panel.title || panel.metric}
        aria-describedby={[
          displayedSeries && 'focused-' + panel.id,
          limitNote && 'limit-' + panel.id,
          pointCounts && 'point-limit-' + panel.id,
        ]
          .filter(Boolean)
          .join(' ') || undefined}
        onpointerdown={readonly || expanded ? undefined : startTitleDrag}
      >
        {panel.title || panel.metric}
      </h3>
      {#if displayedSeries}<span
          class="chart-limit chart-focused-run"
          id={'focused-' + panel.id}
          title={$t('panel.focusedRun', { name: displayedName! })}>{displayedName}</span
        >{/if}{#if limitNote}<span class="chart-limit" title={limitText}
          ><span aria-hidden="true">{limitNote}</span><span
            class="bx--visually-hidden"
            id={'limit-' + panel.id}>{limitText}</span
          ></span
        >{/if}{#if pointCounts}<span
          class="chart-limit"
          title={$t('panel.limit.pointsTitle', pointCounts)}
          ><span aria-hidden="true">{$t('panel.limit.points', pointCounts)}</span><span
            class="bx--visually-hidden"
            id={'point-limit-' + panel.id}
            >{$t(
              'panel.limit.pointsTitle',
              pointCounts,
            )}</span
          ></span
        >{/if}
    </div>
    {#if !readonly}<div
        class="chart-tools"
        role="presentation"
        onkeydowncapture={(event) => {
          // A key held from saving the editor must not reopen it from the settings button.
          if (event.key === 'Enter' && event.repeat) event.preventDefault();
        }}
      >
        {#if range}<Button
            class="chart-reset"
            kind="ghost"
            size="small"
            icon={Reset}
            aria-pressed={undefined}
            hideTooltip
            title={$t('panel.toolbar.resetZoom')}
            iconDescription={$t('panel.toolbar.resetZoom')}
            portalTooltip
            on:click={() => {
              range = null;
              container
                .querySelector<HTMLButtonElement>('.chart-expand')
                ?.focus({ preventScroll: true });
            }}
          />{/if}
        <Button
          kind="ghost"
          size="small"
          class="chart-expand"
          icon={expanded ? Minimize : Maximize}
          aria-pressed={undefined}
          hideTooltip
          title={expanded ? $t('panel.toolbar.exitFullScreen') : $t('panel.toolbar.expand')}
          iconDescription={expanded ? $t('panel.toolbar.exitFullScreen') : $t('panel.toolbar.expand')}
          on:click={() => (expanded = !expanded)}
        /><Button
          kind="ghost"
          size="small"
          class="chart-settings"
          icon={Settings}
          aria-pressed={undefined}
          hideTooltip
          title={$t('panel.toolbar.settings')}
          iconDescription={$t('panel.toolbar.settings')}
          on:click={onedit}
        /><OverflowMenu
          size="sm"
          flipped
          menuOptionsClass="panel-actions-menu"
          title={$t('panel.menu.label')}
          aria-label={$t('panel.menu.label')}
          iconDescription={$t('panel.menu.label')}
          ><OverflowMenuItem text={$t('panel.menu.duplicate')} on:click={onduplicate} /><OverflowMenuItem
            text={$t('panel.menu.moveToFirst')}
            disabled={position === 0}
            on:click={(event) => onmove(-position, event.detail.detail === 0)}
          /><OverflowMenuItem
            text={$t('panel.menu.moveEarlier')}
            disabled={position === 0}
            on:click={(event) => onmove(-1, event.detail.detail === 0)}
          /><OverflowMenuItem
            text={$t('panel.menu.moveLater')}
            disabled={position === count - 1}
            on:click={(event) => onmove(1, event.detail.detail === 0)}
          /><OverflowMenuItem
            text={$t('panel.menu.moveToLast')}
            disabled={position === count - 1}
            on:click={(event) => onmove(count - 1 - position, event.detail.detail === 0)}
          />{#if exportable}<OverflowMenuItem
              hasDivider
              disabled={cells && gridState.count > panelLimits.cells.export}
              text={cells && gridState.count > panelLimits.cells.export
                ? $t('panel.menu.exportPngLimit', { limit: panelLimits.cells.export })
                : $t('panel.menu.exportPng')}
              on:click={async () => {
                const url = await renderer?.exportImage?.();
                if (url) {
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = (panel.title || panel.metric).replaceAll('/', '_') + '.png';
                  a.click();
                }
              }}
            />{/if}{#if plugin?.dataKind !== 'media'}<OverflowMenuItem
              hasDivider={!exportable}
              text={$t('panel.menu.exportCsv')}
              disabled={!data}
              on:click={exportCSV}
            />{/if}<OverflowMenuItem
            hasDivider
            text={$t('panel.menu.delete')}
            danger
            on:click={onremove}
          /></OverflowMenu
        >
      </div>{/if}
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions (Keys from the grid's tiles bubble here; each tile is the focusable control.) -->
  <div
    class="plot"
    class:has-cell-toolbar={cellToolbar || mediaToolbar}
    onkeydown={plotKey}
  >
    <div class="chart-canvas" bind:this={plot}></div>
    {#if cellToolbar || mediaToolbar}<div class="cell-toolbar">
        <span class="cell-count"
          >{cellToolbar
            ? $t(grouped ? 'panel.cell.countGrouped' : 'panel.cell.count', {
                count: gridState.count,
              })
            : mediaCount.shown < mediaCount.total
              ? $t('media.toolbar.countTruncated', mediaCount)
              : $t('media.toolbar.count', { count: mediaCount.shown })}</span
        >
        {#if mediaToolbar && mediaAcross === 'runs' && data?.steps?.length}<div class="media-step">
            <Button
              kind="ghost"
              size="small"
              icon={ChevronLeft}
              hideTooltip
              title={$t('media.toolbar.previousStep')}
              iconDescription={$t('media.toolbar.previousStep')}
              disabled={stepIndex <= 0}
              on:click={() => chooseStep(stepIndex - 1)}
            />{#if plotWidth >= 560}<Slider
                labelText={$t('media.toolbar.stepSlider')}
                hideLabel
                hideTextInput
                min={0}
                max={Math.max(1, data.steps.length - 1)}
                step={1}
                disabled={data.steps.length < 2}
                formatValue={(index: number) => String(data?.steps?.[index] ?? '')}
                value={draggedStep ?? stepIndex}
                on:input={(event) => (draggedStep = Number(event.detail))}
                on:change={(event) => chooseStep(Number(event.detail))}
              />{/if}<Button
              kind="ghost"
              size="small"
              icon={ChevronRight}
              hideTooltip
              title={$t('media.toolbar.nextStep')}
              iconDescription={$t('media.toolbar.nextStep')}
              disabled={stepIndex >= data.steps.length - 1}
              on:click={() => chooseStep(stepIndex + 1)}
            /><span class="media-step-label"
              >{$t('media.toolbar.step', {
                step: data.steps[draggedStep ?? stepIndex] ?? data.step ?? 0,
              })}</span
            >{#if mediaStep !== undefined}<Button
                kind="ghost"
                size="small"
                on:click={() => mediaSteps.set(sessionKeys.section, undefined)}
                >{$t('media.toolbar.latest')}</Button
              >{/if}
          </div>{:else if mediaToolbar && mediaAcross === 'steps' && fetchRuns.length}<div
            class="media-run"
          >
            <Select
              size="sm"
              hideLabel
              labelText={$t('media.toolbar.run')}
              selected={mediaRun?.id}
              on:change={(event) =>
                mediaRuns.set(sessionKeys.panel, (event.target as HTMLSelectElement).value)}
              >{#each fetchRuns as run (run.id)}<SelectItem
                  value={run.id}
                  text={run.display_name}
                />{/each}</Select
            >
          </div>{/if}
        <!-- Narrow panels keep the size in panel settings; media panels need room for steps. -->
        {#if (cellToolbar || (tiled && plotSettings.layout !== 'coverflow')) && plotWidth >= (mediaToolbar ? 800 : 480)}<div
            class="cell-size"
          >
            <Button
              kind="ghost"
              size="small"
              icon={ZoomOut}
              hideTooltip
              title={$t('panel.cell.smaller')}
              iconDescription={$t('panel.cell.smaller')}
              disabled={sizeShown <= panelLimits.itemSize.min}
              on:click={() => commitSize(sizeShown - 40)}
            /><Slider
              labelText={$t('panelSettings.display.itemSize.label')}
              hideLabel
              hideTextInput
              min={panelLimits.itemSize.min}
              max={panelLimits.itemSize.max}
              step={panelLimits.itemSize.step}
              value={draggedSize ?? sizeShown}
              on:input={(event) => (draggedSize = Number(event.detail))}
              on:change={(event) => commitSize(Number(event.detail))}
            /><Button
              kind="ghost"
              size="small"
              icon={ZoomIn}
              hideTooltip
              title={$t('panel.cell.larger')}
              iconDescription={$t('panel.cell.larger')}
              disabled={sizeShown >= panelLimits.itemSize.max}
              on:click={() => commitSize(sizeShown + 40)}
            />
          </div>{/if}
        <span class="bx--visually-hidden" aria-live="polite">{announcement}</span>
      </div>{/if}
    {#if renderError || status || focusedEmpty}<div class="chart-status" role="status">
        {$t(renderError || status || 'panel.empty.noData')}
      </div>{/if}
  </div>
  {#if !expanded && !readonly && onresizestart}<button
      class="panel-corner"
      aria-label={$t(resizeLabel)}
      aria-describedby="panel-resize-help"
      title={$t('panel.resize')}
      onpointerdown={onresizestart}
      onkeydown={onresizekey}
    ></button>{/if}
</article>
