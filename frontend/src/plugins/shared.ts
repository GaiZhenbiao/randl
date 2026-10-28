import { zoomBrush } from './zoom-brush';
import { plotInspector, inspectNumber } from './plot-inspector';
import { scrollLegend } from './scroll-legend';
import { groupTitle } from '../ui';
import { color, runTextColor } from '../run-colors';
import {
  stackEdges,
  outlierRange,
  type OutlierOptions,
  smooth,
  smoothingAmount,
  smoothingSpacing,
  type Point,
  type Smoothing,
} from '../chart-math';
import type { ChartCursor, PanelContext, PlotSettings, Renderer } from '../types';
export type Host = {
  element: HTMLElement;
  echarts: typeof import('echarts/core');
  apiVersion: number;
  onHover?: (ids: string[]) => void;
  onCursor?: (cursor: ChartCursor | null) => void;
  onRange?: (range: { xMin: number; xMax: number } | null) => void;
};
export function legendName(
  ctx: PanelContext,
  series: { id: string; name: string; group?: { field: string; value: unknown } },
  metric: string,
  multiple = false,
) {
  const label = (ctx.panel.settings?.legendTemplate || (multiple ? '{metric} · {run}' : '{run}'))
    .replaceAll(
      '{run}',
      series.group
        ? series.group.field === 'all'
          ? ctx.translate('charts.groups.allRuns')
          : groupTitle(series.group.field, series.group.value, ctx.translate)
        : series.name,
    )
    .replaceAll('{id}', series.id.split('/').at(-1)!)
    .replaceAll('{metric}', metric);
  return !series.group &&
    !ctx.panel.settings?.legendTemplate?.includes('{id}') &&
    ctx.data.series.filter((item) => item.name === series.name).length > 1
    ? label + ' · ' + series.id.split('/').at(-1)
    : label;
}
// Fit automatic X bounds to the data instead of zero. A lone X value is centered.
function fitBound(type: string, min: number, max: number, side: -1 | 1) {
  const value = side < 0 ? min : max;
  if (min !== max) return value;
  if (type === 'log') return side < 0 ? value / 2 : value * 2;
  return value + side * (type === 'time' ? 60000 : Math.abs(value) / 10 || 1);
}
function fitX(type: string, bound: number | null | undefined, side: -1 | 1) {
  return bound ?? (({ min, max }: { min: number; max: number }) => fitBound(type, min, max, side));
}
// The X range the axis will show, used to choose tick labels before rendering.
function xRange(ctx: PanelContext, settings: PlotSettings, type: string) {
  let lo = Infinity,
    hi = -Infinity;
  for (const series of ctx.data.series)
    for (const points of Object.values(series.values))
      for (const [x] of points) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
  return [settings.xMin ?? fitBound(type, lo, hi, -1), settings.xMax ?? fitBound(type, lo, hi, 1)];
}
export function base(ctx: PanelContext): any {
  const settings = ctx.panel.settings || {},
    text = ctx.dark ? '#c6c6c6' : '#525252',
    grid = ctx.dark ? '#525252' : '#c6c6c6',
    showLegend =
      settings.legend ??
      (ctx.data.series.filter((s) => Object.values(s.values).some((v) => v.length)).length > 1 ||
        (ctx.panel.metrics?.length || 1) > 1),
    axis = settings.xAxis || (ctx.panel.metric.startsWith('system/') ? '_timestamp' : '_step'),
    xType = settings.xScale === 'log' ? 'log' : axis === '_timestamp' ? 'time' : 'value',
    // Counters and seconds use whole-number ticks. Linear axes hide their bound labels
    // unless no whole number falls between the bounds.
    wholeTicks = xType === 'value' && ['_step', '_runtime', '_relative_wall'].includes(axis),
    [xLo, xHi] = xRange(ctx, settings, xType),
    boundLabels = xType === 'log' || (wholeTicks && !(Math.floor(xLo) + 1 < xHi)),
    // Narrow grid cells leave out axis names and tighten the padding.
    compact = !!ctx.cell?.compact;
  return {
    animation: false,
    textStyle: { fontFamily: 'IBM Plex Sans,system-ui,sans-serif', fontSize: 12, color: text },
    backgroundColor: 'transparent',
    grid: {
      left: showLegend && settings.legendPosition === 'left' ? 150 : compact ? 44 : 56,
      right: showLegend && settings.legendPosition === 'right' ? 150 : compact ? 12 : 24,
      top: showLegend && (settings.legendPosition || 'top') === 'top' ? 54 : compact ? 12 : 24,
      bottom: showLegend && settings.legendPosition === 'bottom' ? 68 : compact ? 24 : 48,
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: ctx.dark ? '#393939' : '#ffffff',
      borderColor: grid,
      textStyle: { color: ctx.dark ? '#f4f4f4' : '#161616', fontSize: 12 },
    },
    legend: {
      show: showLegend,
      type: 'plain',
      ...(settings.legendPosition === 'bottom'
        ? { bottom: 0 }
        : settings.legendPosition === 'left'
          ? { left: 0, top: 24, orient: 'vertical', width: 130 }
          : settings.legendPosition === 'right'
            ? { right: 0, top: 24, orient: 'vertical', width: 130 }
            : { top: 4 }),
      textStyle: { color: text, fontSize: 11, overflow: 'truncate', width: 180 },
      pageTextStyle: { color: text },
    },
    xAxis: {
      type: xType,
      name: compact
        ? ''
        : axis === '_step'
          ? ctx.translate('charts.xAxis.step')
          : axis === '_runtime'
            ? ctx.translate('charts.xAxis.runtime')
            : axis === '_relative_wall'
              ? ctx.translate('charts.xAxis.relativeWall')
              : axis === '_timestamp'
                ? ctx.translate('charts.xAxis.wallTime')
                : axis,
      nameLocation: 'middle',
      nameGap: 26,
      minInterval: wholeTicks ? 1 : undefined,
      min: fitX(xType, settings.xMin, -1),
      max: fitX(xType, settings.xMax, 1),
      axisLabel: {
        color: text,
        fontSize: 11,
        hideOverlap: true,
        // Label the bounds on log axes and when no whole-number tick lies between them.
        showMinLabel: boundLabels ? undefined : false,
        showMaxLabel: boundLabels ? undefined : false,
        formatter:
          xType === 'log'
            ? (value: number) =>
                new Intl.NumberFormat(ctx.locale, { maximumSignificantDigits: 4 }).format(value)
            : undefined,
      },
      nameTextStyle: { color: text, fontSize: 11 },
      axisLine: { lineStyle: { color: grid } },
      splitLine: { show: false },
    },
    yAxis: {
      type: settings.yScale === 'log' ? 'log' : 'value',
      scale: true,
      min: settings.yMin,
      max: settings.yMax,
      axisLabel: { color: text, fontSize: 11, hideOverlap: true },
      axisLine: { onZero: false },
      splitLine: { lineStyle: { color: grid } },
    },
    dataZoom: [
      {
        type: 'inside',
        // Points outside the X range are left out, so the Y axis fits the visible data.
        filterMode: 'filter',
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: 'ctrl',
        preventDefaultMouseMove: false,
      },
    ],
  };
}
// Settings arrive resolved through the workspace, section and panel cascade. The point
// spacing for the X-aware methods comes from every series the panel plots.
export function smoothingFor(ctx: PanelContext) {
  const settings = ctx.panel.settings || {},
    method = (settings.smoothingMethod || 'none') as Smoothing,
    metrics = ctx.data.metrics?.length
      ? ctx.data.metrics
      : ctx.panel.metrics?.length
        ? ctx.panel.metrics
        : [ctx.panel.metric];
  return {
    method,
    amount: smoothingAmount(method, settings.smoothingValue),
    spacing: smoothingSpacing(
      ctx.data.series.flatMap((series) =>
        metrics.map((metric) => (series.values[metric] || []) as Point[]),
      ),
    ),
  };
}
export function lines(ctx: PanelContext, area = false): any[] {
  const settings = ctx.panel.settings || {},
    { method, amount, spacing } = smoothingFor(ctx),
    metrics = ctx.panel.metrics?.length ? ctx.panel.metrics : [ctx.panel.metric];
  const result: any[] = [];
  for (const series of ctx.data.series)
    for (const [metric, index] of metrics.map((m, i) => [m, i] as const)) {
      const raw = series.values[metric] || [],
        points = smooth(raw as Point[], method, amount, spacing),
        name = legendName(ctx, series, metric, metrics.length > 1);
      if (settings.showOriginal && method !== 'none')
        result.push({
          name,
          randlRunIds: series.runIds || [series.id],
          type: 'line',
          data: raw,
          showSymbol: false,
          lineStyle: { color: color(series.id, ctx.colors, ctx.dark), width: 1, opacity: 0.25 },
          silent: true,
        });
      const band = (series as any).bands?.[metric] as number[][] | undefined;
      if (band && settings.spread && settings.spread !== 'none') {
        const stack = 'band:' + series.id + ':' + metric;
        result.push(
          {
            randlRunIds: series.runIds || [series.id],
            name,
            type: 'line',
            data: band.map((p) => [p[0], p[1]]),
            stack,
            stackStrategy: 'all',
            showSymbol: false,
            lineStyle: { opacity: 0 },
            areaStyle: { opacity: 0 },
            silent: true,
            tooltip: { show: false },
          },
          {
            randlRunIds: series.runIds || [series.id],
            name,
            type: 'line',
            data: band.map((p) => [p[0], p[2] - p[1]]),
            stack,
            stackStrategy: 'all',
            showSymbol: false,
            lineStyle: { opacity: 0 },
            areaStyle: {
              color: color(series.id, ctx.colors, ctx.dark),
              opacity: ctx.dark ? 0.32 : 0.22,
            },
            silent: true,
            tooltip: { show: false },
          },
        );
      }
      result.push({
        name,
        randlOriginal: method !== 'none' ? raw : undefined,
        randlMembers: band,
        randlKey: series.id + ':' + metric,
        randlMetric: metric,
        randlRunIds: series.runIds || [series.id],
        type: 'line',
        data: points,
        showSymbol: settings.showPoints || points.length === 1,
        ...(points.length === 1 && !settings.showPoints
          ? { symbol: 'circle', symbolSize: 6 }
          : { symbolSize: 4 }),
        lineStyle: { width: settings.lineWidth || 1.5, type: index ? 'dashed' : 'solid' },
        itemStyle: { color: color(series.id, ctx.colors, ctx.dark) },
        // A group's spread is its fill; filling to zero would obscure the lower bound.
        areaStyle:
          area && !(band && settings.spread && settings.spread !== 'none')
            ? { opacity: ctx.dark ? 0.4 : 0.3 }
            : undefined,
        emphasis: { focus: 'series' },
      });
    }
  return result;
}
// Excluding outliers fits only the automatic Y bounds to the bulk of the given values;
// the data stay intact, so clipped marks leave the plot edge and hovering reports their
// values. An explicit Y bound replaces its automatic bound. `bounds: false` is for
// charts without Y bounds of their own.
export function fitOutliers(
  yAxis: any,
  settings: PlotSettings,
  values: Point[][],
  options: OutlierOptions & { bounds?: boolean } = {},
) {
  const { bounds = true, ...rest } = options,
    yMin = bounds ? settings.yMin : null,
    yMax = bounds ? settings.yMax : null;
  if (!settings.excludeOutliers || (yMin != null && yMax != null)) return;
  const range = outlierRange(values, {
    xMin: settings.xMin,
    xMax: settings.xMax,
    log: settings.yScale === 'log',
    lower: settings.outlierLower,
    upper: settings.outlierUpper,
    ...rest,
  });
  if (!range) return;
  const [lo, hi] = range;
  if (yMin == null && (yMax == null || lo < yMax)) yAxis.min = lo;
  if (yMax == null && (yMin == null || hi > yMin)) yAxis.max = hi;
}
// The Y range a built option shows: its explicit or fitted bounds, otherwise the extent of
// its values inside the X range, with stacked series summed and stacks including zero. Grid
// cells with a shared Y range use the union of their charts' extents.
export function optionExtent(option: any, settings: PlotSettings): [number, number] | null {
  const yAxis = option.yAxis,
    log = yAxis.type === 'log';
  if (yAxis.type === 'category') return null;
  let lo = Infinity,
    hi = -Infinity;
  const add = (points: Point[]) => {
    for (const [x, y] of points)
      if (
        Number.isFinite(y) &&
        (!log || y > 0) &&
        (settings.xMin == null || x >= settings.xMin) &&
        (settings.xMax == null || x <= settings.xMax)
      ) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
  };
  const stacks = new Map<string, { all: boolean; series: Point[][] }>();
  for (const series of option.series || []) {
    const points = (series.data || []).filter(
      (point: unknown) => Array.isArray(point) && typeof point[1] === 'number',
    ) as Point[];
    if (series.stack === undefined) add(points);
    else {
      const stack = stacks.get(series.stack) || {
        all: series.stackStrategy === 'all',
        series: [],
      };
      stack.series.push(points);
      stacks.set(series.stack, stack);
    }
  }
  for (const { all, series } of stacks.values())
    if (all) {
      // Spread bands: each boundary is the running sum of the stacked values.
      const sums = new Map<number, number>();
      for (const points of series)
        add(
          points.map(([x, y]) => {
            const sum = (sums.get(x) || 0) + y;
            sums.set(x, sum);
            return [x, sum] as Point;
          }),
        );
    } else for (const edges of stackEdges([series])) add(edges);
  if (yAxis.scale === false && !log) [lo, hi] = [Math.min(lo, 0), Math.max(hi, 0)];
  if (typeof yAxis.min === 'number') lo = yAxis.min;
  if (typeof yAxis.max === 'number') hi = yAxis.max;
  return Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi ? [lo, hi] : null;
}
// A line or area chart. Excluding outliers fits the plotted traces (smoothed, plus
// originals when shown); spread bands neither widen nor narrow the range.
export function lineChart(ctx: PanelContext, area = false) {
  const option = base(ctx),
    series = lines(ctx, area);
  fitOutliers(
    option.yAxis,
    ctx.panel.settings || {},
    series.filter((item) => !String(item.stack ?? '').startsWith('band:')).map((item) => item.data),
  );
  return { ...option, series };
}
export function renderer(
  host: Host,
  build: (ctx: PanelContext) => any,
  highlightLinkedComponents = true,
): Renderer {
  const canvas = document.createElement('div');
  canvas.style.cssText = 'width:100%;height:100%';
  host.element.style.position = 'relative';
  host.element.append(canvas);
  const chart = host.echarts.init(canvas, undefined, {
    renderer: 'canvas',
    devicePixelRatio: Math.min(devicePixelRatio, 2),
  });
  const legend = scrollLegend(
    host.element,
    (name) => chart.dispatchAction({ type: 'legendToggleSelect', name }),
    (ids) => host.onHover?.(ids),
  );
  const selectionKey =
    'randl:legend:' +
    location.pathname +
    location.search +
    ':' +
    (host.element.closest('[data-panel-id]')?.getAttribute('data-panel-id') || 'preview');
  let selectedLegend: Record<string, boolean> = JSON.parse(
      sessionStorage.getItem(selectionKey) || '{}',
    ),
    ready = false,
    inspectHistory = false;
  const inspector = plotInspector(
    host.element,
    canvas,
    chart,
    (cursor) => host.onCursor?.(cursor),
    (ids) => host.onHover?.(ids),
    (key) => {
      const next = key === null ? -1 : seriesKeys.indexOf(key);
      if (next === focusedSeries) return;
      focusedSeries = next;
      if (ready && highlighted.length) applyHighlights(highlighted);
    },
  );
  // History charts with a numeric X axis zoom to a dragged range.
  let zoomable = false;
  const brush = zoomBrush(host.element, canvas, chart as any, {
    enabled: () => ready && zoomable && !!host.onRange,
    onZoom: (range) => host.onRange?.(range),
    onStart: () => inspector.hide(),
  });
  function wheel(event: WheelEvent) {
    if (!event.ctrlKey) event.stopPropagation();
  }
  canvas.addEventListener('wheel', wheel, { capture: true, passive: true });
  chart.on('legendselectchanged', (event: any) => {
    selectedLegend = { ...event.selected };
    legend.selection(selectedLegend);
    inspector.selection(selectedLegend);
    sessionStorage.setItem(selectionKey, JSON.stringify(selectedLegend));
    const keys = Object.keys(sessionStorage).filter((key) => key.startsWith('randl:legend:'));
    for (const key of keys.slice(0, Math.max(0, keys.length - 100)))
      if (key !== selectionKey) sessionStorage.removeItem(key);
  });
  let context: PanelContext | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  // The series the local inspector focuses; it alone is emphasized among its run's series.
  let focusedSeries = -1,
    seriesKeys: string[] = [];
  let seriesRuns: string[][] = [],
    seriesDatumRuns: string[][][] = [],
    seriesTypes: string[] = [],
    highlighted: string[] = [],
    silentSeries: boolean[] = [];
  let localHighlight = false;
  let highlightSignature = '';
  let structureKey: string | undefined;
  const seenFocus = new WeakSet<object>();
  let legendShown = false;
  let legendNames: string[] = [];
  let pendingCursor: ChartCursor | null = null;
  function cursorAxis() {
    return context?.data.snapshot
      ? null
      : context?.panel.settings?.xAxis ||
          (context?.panel.metric.startsWith('system/') ? '_timestamp' : '_step');
  }
  function tooltip(params: any) {
    const prefs = context?.panel.settings || {};
    const root = document.createElement('div'),
      highlightedIds = new Set(highlighted);
    const values = (Array.isArray(params) ? params : [params]).filter(
      (p: any) =>
        !silentSeries[p.seriesIndex] &&
        (!prefs.tooltipOnlyHighlighted ||
          !highlighted.length ||
          (seriesDatumRuns[p.seriesIndex]?.[p.dataIndex] || seriesRuns[p.seriesIndex])?.some((id) =>
            highlightedIds.has(id),
          )),
    );
    const header = document.createElement('div');
    header.textContent =
      cursorAxis() === '_step' && typeof values[0]?.axisValue === 'number'
        ? new Intl.NumberFormat(context?.locale, { maximumFractionDigits: 0 }).format(
            values[0].axisValue,
          )
        : String(values[0]?.axisValueLabel ?? '');
    header.style.marginBottom = '4px';
    root.append(header);
    for (const p of values.slice(0, prefs.tooltipLimit || 10)) {
      const row = document.createElement('div'),
        label = document.createElement('span'),
        value = document.createElement('span');
      row.style.cssText = 'display:flex;gap:16px;justify-content:space-between;max-width:320px';
      label.textContent = String(p.seriesName || p.name || '');
      if (!prefs.tooltipFullNames)
        label.style.cssText =
          'max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      else label.style.cssText = 'max-width:230px;white-space:normal;overflow-wrap:anywhere';
      if (prefs.tooltipColoredNames && typeof p.color === 'string')
        label.style.color = runTextColor(p.color, context!.dark);
      const raw =
        seriesTypes[p.seriesIndex] === 'scatter' && Array.isArray(p.value)
          ? '(' +
            p.value
              .map((value: any) =>
                typeof value === 'number' ? inspectNumber(value, context!.locale) : String(value),
              )
              .join(', ') +
            ')'
          : Array.isArray(p.value)
            ? p.value.at(-1)
            : p.value;
      value.textContent =
        typeof raw === 'number' ? inspectNumber(raw, context!.locale) : String(raw ?? '—');
      value.style.fontVariantNumeric = 'tabular-nums';
      const marker = document.createElement('span');
      marker.style.cssText = 'width:8px;height:8px;flex:0 0 8px;border-radius:50%;margin-top:5px';
      marker.style.background = typeof p.color === 'string' ? p.color : '#8d8d8d';
      row.prepend(marker);
      row.append(label, value);
      root.append(row);
    }
    if (values.length > (prefs.tooltipLimit || 10)) {
      const remaining = document.createElement('div');
      remaining.textContent =
        context?.translate('charts.tooltip.more', {
          count: values.length - (prefs.tooltipLimit || 10),
        }) || '';
      root.append(remaining);
    }
    return root;
  }
  chart.on('mouseover', (event: any) => {
    if (inspectHistory || event.componentType !== 'series') return;
    host.onHover?.(
      seriesDatumRuns[event.seriesIndex]?.[event.dataIndex] || seriesRuns[event.seriesIndex] || [],
    );
  });
  chart.getZr().on('globalout', () => {
    if (inspectHistory) return;
    host.onHover?.([]);
    host.onCursor?.(null);
  });
  chart.on('datazoom', (event: any) => {
    if (!host.onRange || !context) return;
    const e = event.batch?.[0] || event;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (e.start === 0 && e.end === 100) {
        host.onRange?.(null);
        return;
      }
      const [xMin, xMax] =
        (chart as any).getModel().getComponent('xAxis', 0)?.axis.scale.getExtent() || [];
      if (Number.isFinite(xMin) && Number.isFinite(xMax) && xMin < xMax)
        host.onRange?.({ xMin, xMax });
    }, 250);
  });
  function applyHighlights(list: string[]) {
    // Groups can list tens of thousands of runs, so membership uses a set.
    const ids = new Set(list),
      suppressed =
        !localHighlight && !highlightLinkedComponents && context!.data.metrics.length > 1;
    const datum = suppressed
      ? []
      : seriesDatumRuns.flatMap((data, seriesIndex) =>
          data.flatMap((runs, dataIndex) =>
            runs.some((id) => ids.has(id)) ? [{ seriesIndex, dataIndex }] : [],
          ),
        );
    const seriesIndex = suppressed
      ? []
      : localHighlight && focusedSeries >= 0 && seriesRuns[focusedSeries]?.some((id) => ids.has(id))
        ? [focusedSeries]
        : seriesRuns.flatMap((runs, index) => (runs.some((id) => ids.has(id)) ? [index] : []));
    const signature =
      datum.length || seriesIndex.length ? JSON.stringify([datum, seriesIndex]) : '';
    if (signature === highlightSignature) return;
    if (highlightSignature) chart.dispatchAction({ type: 'downplay' });
    highlightSignature = signature;
    for (const item of datum) chart.dispatchAction({ type: 'highlight', ...item });
    if (seriesIndex.length) chart.dispatchAction({ type: 'highlight', seriesIndex });
  }

  return {
    update: (ctx) => {
      context = ctx;
      ready = false;
      const option = build(ctx);
      const transform = ctx.data.recordTransform;
      const focusedComposition =
        ctx.panel.settings?.maxRuns === 'focused' &&
        ctx.data.series.length === 1 &&
        ctx.data.metrics.length > 1 &&
        (transform?.kind === 'align' || (transform?.kind === 'compute' && !!transform.align));
      const cachedFocus = focusedComposition && seenFocus.has(ctx.data.series[0]);
      // Stable slots let an unchanged composition reuse its models when run names
      // change. Explicit builder IDs still take precedence.
      if (focusedComposition)
        for (const [index, series] of (option.series || []).entries())
          series.id ??= 'randl-series:' + index;
      zoomable =
        !ctx.data.snapshot &&
        !ctx.data.entries &&
        ['value', 'time', 'log'].includes(option.xAxis?.type);
      inspectHistory =
        !ctx.data.snapshot &&
        !ctx.data.entries &&
        (option.series || []).some((s: any) => s.type === 'line') &&
        (option.series || []).every((s: any) => s.type === 'line');
      if (option.tooltip) {
        option.tooltip.formatter = tooltip;
        if (inspectHistory) option.tooltip.show = false;
      }
      silentSeries = (option.series || []).map((item: any) => !!item.silent);
      seriesDatumRuns = (option.series || []).map((item: any) => item.randlDatumRunIds || []);
      seriesTypes = (option.series || []).map((item: any) => item.type);
      const focusedKey = seriesKeys[focusedSeries];
      seriesKeys = (option.series || []).map((item: any) =>
        item.silent ? '' : item.randlKey || item.name,
      );
      focusedSeries = focusedKey === undefined ? -1 : seriesKeys.indexOf(focusedKey);
      if (option.legend)
        option.legend.data = (option.series || [])
          .filter((series: any) => !series.silent)
          .map((series: any) => series.name);
      seriesRuns = (option.series || []).map(
        (item: any) =>
          item.randlRunIds ||
          ctx.data.series
            .filter(
              (s) =>
                item.name === s.name ||
                item.name?.startsWith(s.name + ' · ') ||
                item.name?.startsWith(s.name + ' ('),
            )
            .flatMap((s) => (s as any).runIds || [s.id]),
      );
      // Runs still streaming in keep their legend entry, so the legend does not grow.
      const pending = new Set(ctx.data.series.filter((s) => s.pending).map((s) => s.name));
      const entries = (option.series || [])
        .map((series: any, index: number) => ({ series, index }))
        .filter(
          ({ series }: any) => !series.silent && (series.data?.length || pending.has(series.name)),
        );
      const formulas = new Map(
        (ctx.panel.expressions || []).map((item) => [
          item.name,
          ctx.translate('charts.expressions.tooltipFormula', {
            name: item.name,
            expression: item.expression,
          }),
        ]),
      );
      const unique = new Map<
        string,
        { name: string; color: string; runIds: string[]; title?: string }
      >();
      for (const { series, index } of entries)
        if (!unique.has(series.name))
          unique.set(series.name, {
            name: series.name,
            title: formulas.get(series.randlMetric),
            color:
              series.itemStyle?.color ||
              series.lineStyle?.color ||
              color(seriesRuns[index]?.[0] || series.name, ctx.colors, ctx.dark),
            runIds: seriesRuns[index] || [],
          });
      selectedLegend = Object.fromEntries(
        [...unique.keys()].map((name) => [name, selectedLegend[name] !== false]),
      );
      const legendEnabled = option.legend?.show !== false;
      legendShown = !!option.legend && legendEnabled;
      legendNames = option.legend?.data || [];
      if (option.legend) {
        option.legend.show = false;
        option.legend.type = 'plain';
        option.legend.selected = selectedLegend;
      }
      // The inspector chooses the focused series, so the series ignore the pointer:
      // ECharts would otherwise emphasize whichever line or area lies under it.
      if (inspectHistory) for (const series of option.series) series.silent = true;
      // Replace options atomically, keeping matching chart views and their emphasis.
      // Clearing first paints an empty chart and discards those views on every chunk.
      // Inspector metadata belongs to the application, not ECharts' cloned options.
      const originals = (option.series || []).map((series: any) => {
          const original = series.randlOriginal;
          delete series.randlOriginal;
          return original;
        }),
        members = (option.series || []).map((series: any) => {
          const rows = series.randlMembers;
          delete series.randlMembers;
          return rows;
        });
      let nextStructure: string | undefined;
      if (focusedComposition) {
        const stacks = new Map<string, number>();
        const { series: plotted, legend: optionLegend, ...layout } = option;
        nextStructure = JSON.stringify({
          ...layout,
          legend: optionLegend && { ...optionLegend, data: undefined, selected: undefined },
          series: (plotted || []).map((series: any) => {
            if (series.stack !== undefined && !stacks.has(series.stack))
              stacks.set(series.stack, stacks.size);
            return {
              ...series,
              data: undefined,
              name: undefined,
              randlKey: undefined,
              randlRunIds: undefined,
              randlDatumRunIds: undefined,
              randlLabel: undefined,
              stack: series.stack === undefined ? undefined : stacks.get(series.stack),
            };
          }),
        });
      }
      // Merge mode retains its first option. Only reuse cached focused inputs:
      // a new revision must replace the model so obsolete histories can be collected.
      // Replace legend and zoom models too: old run names must not accumulate in
      // legend selection, and a clipped server range must not be zoomed a second time.
      chart.setOption(
        option,
        cachedFocus && nextStructure === structureKey
          ? { replaceMerge: ['series', 'legend', 'dataZoom'], lazyUpdate: false }
          : { notMerge: true, lazyUpdate: false },
      );
      structureKey = nextStructure;
      if (focusedComposition) seenFocus.add(ctx.data.series[0]);
      if (highlightSignature) chart.dispatchAction({ type: 'downplay' });
      highlightSignature = '';
      legend.update(
        {
          ...ctx,
          panel: { ...ctx.panel, settings: { ...ctx.panel.settings, legend: legendEnabled } },
        },
        option.legend ? [...unique.values()] : [],
        selectedLegend,
      );
      inspector.update(
        ctx,
        entries.map(({ series, index }: any) => ({
          name: series.name,
          label: series.randlLabel,
          title: formulas.get(series.randlMetric),
          key: series.randlKey || series.name,
          index,
          stack: series.stack,
          percent: series.randlPercent,
          color: unique.get(series.name)!.color,
          runIds: seriesRuns[index],
          points: series.data,
          original: originals[index],
          members: members[index],
        })),
        selectedLegend,
        inspectHistory,
      );
      inspector.refreshCursor(pendingCursor);
      ready = true;
      if (highlighted.length) applyHighlights(highlighted);
    },
    highlightRuns: (ids, local) => {
      highlighted = ids;
      localHighlight = local;
      inspector.highlightRuns(ids, local);
      if (ready) applyHighlights(ids);
    },
    showCursor: (cursor) => {
      pendingCursor = cursor;
      if (inspectHistory) {
        inspector.showCursor(cursor);
        return;
      }
      if (!ready) return;
      if (!cursor || cursor.axis !== cursorAxis()) chart.dispatchAction({ type: 'hideTip' });
      else {
        const pixel = chart.convertToPixel({ xAxisIndex: 0 }, cursor.value);
        if (typeof pixel === 'number' && pixel >= 0 && pixel <= chart.getWidth())
          chart.dispatchAction({ type: 'showTip', x: pixel, y: chart.getHeight() / 2 });
      }
    },
    resize: () => {
      chart.resize();
      legend.resize();
      inspector.refresh();
    },
    destroy: () => {
      clearTimeout(timer);
      host.onCursor?.(null);
      ready = false;
      inspector.destroy();
      brush.destroy();
      canvas.removeEventListener('wheel', wheel, true);
      const discarded = [...canvas.querySelectorAll('canvas')];
      chart.dispose();
      for (const node of discarded) node.width = node.height = 0;
      legend.destroy();
      canvas.remove();
      context = undefined;
    },
    exportImage: () => {
      if (legendShown)
        chart.setOption({ legend: { show: true, data: legend.shownNames() } }, { silent: true });
      const image = chart.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: context?.dark ? '#262626' : '#ffffff',
      });
      if (legendShown)
        chart.setOption({ legend: { show: false, data: legendNames } }, { silent: true });
      return image;
    },
  };
}
