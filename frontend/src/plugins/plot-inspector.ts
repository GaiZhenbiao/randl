import { seriesLabel } from './series-label';
import { runTextColor } from '../run-colors';
import type { ChartCursor, PanelContext } from '../types';
import type { MessageKey } from '../i18n';
export type InspectSeries = {
  name: string;
  /** Name shown in the popup when it differs from the legend name. */
  label?: string;
  /** Optional formula description supplied by the chart host. */
  title?: string;
  key: string;
  /** Option series index and stack ID of a stacked series. */
  index?: number;
  stack?: string;
  /** Values are percentages. */
  percent?: boolean;
  color: string;
  runIds: string[];
  points: number[][];
  original?: number[][];
  /** Grouped series: bands rows [x, lower, upper, runs], giving the runs aggregated per X. */
  members?: number[][];
};
let inspectorId = 0;
export function nearestPoint(points: number[][], x: number) {
  let lo = 0,
    hi = points.length;
  if (!hi) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid][0] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  if (lo === points.length) return lo - 1;
  return Math.abs(points[lo][0] - x) < Math.abs(points[lo - 1][0] - x) ? lo : lo - 1;
}
function nearestStep(steps: Float64Array, x: number) {
  let lo = 0,
    hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (steps[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (!lo) return 0;
  if (lo === steps.length) return lo - 1;
  return Math.abs(steps[lo] - x) < Math.abs(steps[lo - 1] - x) ? lo : lo - 1;
}
export function inspectNumber(value: number, locale: string) {
  const absolute = Math.abs(value),
    digits = absolute >= 1 ? Math.floor(Math.log10(absolute)) + 1 : 0;
  return new Intl.NumberFormat(
    locale,
    absolute !== 0 && (absolute < 1e-6 || absolute > 1e15)
      ? { notation: 'scientific', maximumFractionDigits: 5 }
      : { maximumFractionDigits: Math.max(1, Math.min(6, 7 - digits)) },
  ).format(value);
}
// The number of runs aggregated at a grouped point, from the band row with the same X.
function runsAt(members: number[][] | undefined, x: number) {
  if (!members?.length) return undefined;
  const row = members[nearestPoint(members, x)];
  return row[0] === x && Number.isFinite(row[3]) ? row[3] : undefined;
}
// "Mean of 12 runs": what a grouped value describes.
const aggregates: Record<string, MessageKey> = {
  mean: 'charts.tooltip.aggregate.mean',
  median: 'charts.tooltip.aggregate.median',
  min: 'charts.tooltip.aggregate.min',
  max: 'charts.tooltip.aggregate.max',
};
export function inspectorRows(
  series: InspectSeries[],
  x: number,
  hidden: Set<string>,
  tolerance = 0,
) {
  return series
    .filter((item) => !hidden.has(item.name) && item.points.length)
    .flatMap((item) => {
      const points = item.points,
        first = points[0][0],
        last = points.at(-1)![0];
      const before = points.length > 1 ? (points[1][0] - first) / 2 : tolerance,
        after = points.length > 1 ? (last - points.at(-2)![0]) / 2 : tolerance;
      if (x < first - before || x > last + after) return [];
      const index = nearestPoint(points, x),
        point = points[index];
      return Number.isFinite(point[0]) && Number.isFinite(point[1])
        ? [
            {
              ...item,
              x: point[0],
              value: point[1],
              dataIndex: index,
              originalValue: item.original?.[index]?.[1],
              runs: runsAt(item.members, point[0]),
            },
          ]
        : [];
    });
}
type InspectRow = ReturnType<typeof inspectorRows>[number];
export function plotInspector(
  host: HTMLElement,
  canvas: HTMLElement,
  chart: any,
  onCursor: (cursor: ChartCursor | null) => void,
  onHover: (ids: string[]) => void,
  onFocus: (key: string | null) => void = () => {},
) {
  let context: PanelContext | undefined,
    series: InspectSeries[] = [],
    hidden = new Set<string>(),
    enabled = false,
    ready = false,
    local = false,
    touch = false,
    lastX: number | undefined,
    keyboardX: number | undefined,
    steps: Float64Array | undefined;
  let publishedKey: string | undefined;
  let publishedIds: string[] = [];
  let stackedSide: 'above' | 'below' | undefined;
  let pointerPosition: { clientX: number; clientY: number } | undefined;
  let layoutOrientation = '';
  let highlightedRuns = new Set<string>();
  let linkedHover = false;
  let primaryRunOrder: string[] = [];
  let popup: HTMLDivElement | undefined,
    pendingCursor: ChartCursor | null = null;
  const id = ++inspectorId,
    cursor = document.createElement('div'),
    dot = document.createElement('div'),
    live = document.createElement('span'),
    hint = document.createElement('span');
  cursor.className = 'plot-inspector-cursor';
  cursor.hidden = true;
  dot.className = 'plot-inspector-point';
  dot.hidden = true;
  live.className = hint.className = 'bx--visually-hidden';
  live.setAttribute('role', 'status');
  hint.id = 'plot-hint-' + id;
  host.append(cursor, dot, live, hint);
  const axis = () =>
    context?.panel.settings?.xAxis ||
    (context?.panel.metric.startsWith('system/') ? '_timestamp' : '_step');
  const axisName = () => {
    const key = axis(),
      names: Record<string, MessageKey> = {
        _step: 'charts.xAxis.step',
        _runtime: 'charts.xAxis.runtime',
        _relative_wall: 'charts.xAxis.relativeWall',
        _timestamp: 'charts.xAxis.wallTime',
      };
    return names[key] ? context!.translate(names[key]) : key;
  };
  const xText = (value: number) =>
    axis() === '_timestamp'
      ? new Intl.DateTimeFormat(context!.locale, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(value))
      : inspectNumber(value, context!.locale);
  const axisText = (value: number) =>
    context!.translate('charts.tooltip.axisValue', { axis: axisName(), value: xText(value) });
  // A full-screen panel sits in the top layer, so its popup must be inside it.
  const layer = () => host.closest<HTMLElement>(':popover-open') || document.body;
  const formatValue = (value: number, row: { percent?: boolean }) =>
    row.percent
      ? new Intl.NumberFormat(context!.locale, { maximumFractionDigits: 2 }).format(value) + '%'
      : inspectNumber(value, context!.locale);
  // The plotted Y of a row: a stacked series is drawn at its cumulative value.
  function plotted(row: InspectRow) {
    if (row.stack === undefined || row.index === undefined) return row.value;
    const data = chart.getModel().getSeriesByIndex(row.index)?.getData();
    const dimension = data?.getCalculationInfo('stackResultDimension');
    const top = dimension ? data.get(dimension, row.dataIndex) : NaN;
    return typeof top === 'number' && Number.isFinite(top) ? top : row.value;
  }
  function popupNode() {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.className = 'plot-inspector';
    popup.setAttribute('role', 'tooltip');
    popup.id = 'plot-values-' + id;
    layer().append(popup);
    return popup;
  }
  function hide() {
    if (popup) popup.hidden = true;
    cursor.hidden = true;
    dot.hidden = true;
    local = false;
    pointerPosition = undefined;
    stackedSide = undefined;
    onCursor(null);
    publishedKey = undefined;
    onHover([]);
    onFocus(null);
    live.textContent = '';
  }
  function scrollBounds() {
    const fullscreen = host.closest<HTMLElement>('.chart.fullscreen');
    let container: HTMLElement | null = fullscreen;
    if (!container) {
      for (let parent = host.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
          container = parent;
          break;
        }
      }
    }
    const box = container?.getBoundingClientRect(),
      // Panels scroll beneath a pinned workspace toolbar, which covers the scroller's top.
      pinned = fullscreen ? null : container?.querySelector('.workspace-top.pinned');
    return {
      left: Math.max(0, box?.left ?? 0) + 8,
      right: Math.min(innerWidth, box?.right ?? innerWidth) - 8,
      top: Math.max(0, box?.top ?? 0, pinned?.getBoundingClientRect().bottom ?? 0) + 8,
      bottom: Math.min(innerHeight, box?.bottom ?? innerHeight) - 8,
    };
  }
  function plotRect() {
    const rect = chart.getModel().getComponent('grid', 0).coordinateSystem.getRect();
    const box = canvas.getBoundingClientRect();
    return {
      left: box.left + rect.x,
      right: box.left + rect.x + rect.width,
      top: box.top + rect.y,
      bottom: box.top + rect.y + rect.height,
    };
  }
  function popupLayout(
    node: HTMLElement,
    clientX: number,
    clientY: number,
    nearestPixel?: number[],
  ) {
    const box = canvas.getBoundingClientRect();
    const bounds = scrollBounds();
    const plot = plotRect();
    node.dataset.local = String(local);
    const gap = touch ? 28 : 12;
    // The popup is as wide as its content, up to maximumWidth; either side must fit it.
    const maximumWidth = node.dataset.fullNames === 'true' ? 420 : 300;
    const beside = bounds.right - bounds.left >= 2 * (maximumWidth + 12);
    const orientation = beside ? 'beside' : 'stacked';
    if (orientation !== layoutOrientation) stackedSide = undefined;
    layoutOrientation = orientation;
    node.dataset.orientation = orientation;
    const roomRight = bounds.right - clientX - 12;
    const rightSide = roomRight >= maximumWidth;
    const width = beside
      ? Math.min(maximumWidth, rightSide ? roomRight : clientX - bounds.left - 12)
      : Math.min(maximumWidth, bounds.right - bounds.left);
    node.style.width = '';
    node.style.maxWidth = Math.max(0, width) + 'px';
    let pointTop = clientY,
      pointBottom = clientY;
    if (nearestPixel) {
      const pointX = box.left + nearestPixel[0],
        pointY = box.top + nearestPixel[1];
      const distance = Math.hypot(pointX - clientX, pointY - clientY);
      const weight = Math.max(0, Math.min(1, (80 - distance) / 40));
      const protectedY = clientY + (pointY - clientY) * weight;
      pointTop = Math.min(pointTop, protectedY);
      pointBottom = Math.max(pointBottom, protectedY);
    }
    return {
      bounds,
      choose: (minimumHeight: number) => {
        if (beside)
          return {
            maxHeight: bounds.bottom - bounds.top,
            place: () => {
              const height = node.getBoundingClientRect().height;
              const preferredTop =
                context?.panel.settings?.legendPosition === 'bottom'
                  ? plot.bottom - height
                  : plot.top;
              const actual = node.getBoundingClientRect().width;
              node.style.left = (rightSide ? clientX + 12 : clientX - actual - 12) + 'px';
              node.style.top =
                Math.max(bounds.top, Math.min(bounds.bottom - height, preferredTop)) + 'px';
            },
          };
        const above = pointTop - gap - bounds.top;
        const below = bounds.bottom - pointBottom - gap;
        const room = { above, below };
        if (!stackedSide || room[stackedSide] < minimumHeight) {
          const preferred =
            touch || context?.panel.settings?.legendPosition === 'bottom' ? 'above' : 'below';
          stackedSide =
            room[preferred] >= minimumHeight ? preferred : above >= below ? 'above' : 'below';
        }
        const side = stackedSide;
        return {
          maxHeight: Math.max(0, room[side]),
          place: () => {
            const { height, width: actual } = node.getBoundingClientRect();
            node.style.left =
              Math.max(bounds.left, Math.min(bounds.right - actual, clientX - actual / 2)) + 'px';
            node.style.top =
              (side === 'above' ? pointTop - gap - height : pointBottom + gap) + 'px';
          },
        };
      },
    };
  }
  function drawDot(row?: InspectRow) {
    const pixel = row && chart.convertToPixel({ gridIndex: 0 }, [row.x, plotted(row)]);
    const plot = plotRect(),
      box = canvas.getBoundingClientRect();
    if (
      !row ||
      !Array.isArray(pixel) ||
      !pixel.every(Number.isFinite) ||
      pixel[0] < plot.left - box.left ||
      pixel[0] > plot.right - box.left ||
      pixel[1] < plot.top - box.top ||
      pixel[1] > plot.bottom - box.top
    ) {
      dot.hidden = true;
      return;
    }
    dot.hidden = false;
    dot.style.left = pixel[0] + 'px';
    dot.style.top = pixel[1] + 'px';
    dot.style.background = row.color;
  }
  function valueTable(raw: boolean) {
    const table = document.createElement('div');
    table.className = 'plot-inspector-table';
    table.dataset.original = String(raw);
    const columns = document.createElement('div');
    columns.className = 'plot-inspector-columns';
    columns.hidden = !raw;
    if (raw) {
      const smooth = document.createElement('span'),
        original = document.createElement('span');
      smooth.textContent = context!.translate('charts.tooltip.smoothed');
      original.textContent = context!.translate('charts.tooltip.original');
      columns.append(smooth, original);
    }
    const body = document.createElement('div');
    body.className = 'plot-inspector-rows';
    table.append(columns, body);
    return { table, columns, body };
  }
  function drawCursor(x: number) {
    const pixel = chart.convertToPixel({ xAxisIndex: 0 }, x);
    const plot = plotRect(),
      box = canvas.getBoundingClientRect();
    if (
      typeof pixel !== 'number' ||
      !Number.isFinite(pixel) ||
      pixel < plot.left - box.left ||
      pixel > plot.right - box.left
    ) {
      cursor.hidden = true;
      return;
    }
    cursor.hidden = false;
    cursor.style.left = pixel + 'px';
    cursor.style.top = plot.top - box.top + 'px';
    cursor.style.height = Math.max(0, plot.bottom - plot.top) + 'px';
  }
  function pointSteps() {
    const extent = chart.getModel().getComponent('xAxis', 0)?.axis.scale.getExtent() || [
      -Infinity,
      Infinity,
    ];
    if (steps) return steps;
    const items = series.filter((item) => !hidden.has(item.name));
    const values = new Float64Array(items.reduce((sum, item) => sum + item.points.length, 0));
    let count = 0;
    for (const item of items)
      for (const [x] of item.points) if (x >= extent[0] && x <= extent[1]) values[count++] = x;
    const sorted = values.subarray(0, count).sort();
    let unique = 0;
    for (const x of sorted) if (!unique || x !== sorted[unique - 1]) sorted[unique++] = x;
    return (steps = sorted.slice(0, unique));
  }

  function showCompanion(rows: ReturnType<typeof inspectorRows>, x: number) {
    const bounds = scrollBounds(),
      box = canvas.getBoundingClientRect();
    const actualPlot = plotRect();
    const plot = {
      left: Math.max(bounds.left, actualPlot.left),
      right: Math.min(bounds.right, actualPlot.right),
      top: Math.max(bounds.top, actualPlot.top),
      bottom: Math.min(bounds.bottom, actualPlot.bottom),
    };
    const cursorX = box.left + chart.convertToPixel({ xAxisIndex: 0 }, x);
    if (cursor.hidden || cursorX < plot.left || cursorX > plot.right) {
      if (popup) popup.hidden = true;
      dot.hidden = true;
      return;
    }
    // For a run with several stacked components, mark the top of its stack.
    const highlightedRows = rows.filter((row) => row.runIds.some((id) => highlightedRuns.has(id)));
    // For a run with several stacked components, mark the top of its stack.
    const hovered = highlightedRows.reduce<InspectRow | undefined>(
      (best, row) => (!best || plotted(row) > plotted(best) ? row : best),
      undefined,
    );
    drawDot(hovered);
    const order = new Map((pendingCursor?.runOrder || []).map((id, index) => [id, index]));
    const rank = (row: (typeof rows)[number]) =>
      Math.min(...row.runIds.map((id) => order.get(id) ?? Infinity));
    rows.sort(
      (a, b) => rank(a) - rank(b) || plotted(b) - plotted(a) || (b.index ?? 0) - (a.index ?? 0),
    );
    // A single highlighted series is emphasized and listed first. The components of a
    // highlighted run keep their stack order, and none of them is emphasized.
    const emphasized = highlightedRows.length === 1 ? hovered : undefined;
    if (emphasized) rows = [emphasized, ...rows.filter((row) => row !== emphasized)];
    if (context!.panel.settings?.tooltipOnlyHighlighted)
      rows = rows.filter((row) => highlightedRows.includes(row));
    const total = rows.length;
    const plotWidth = plot.right - plot.left,
      plotHeight = plot.bottom - plot.top;
    const rightRoom = plot.right - cursorX - 8,
      leftRoom = cursorX - plot.left - 8;
    const cap = Math.min(220, plotWidth * 0.45, Math.max(rightRoom, leftRoom));
    // A narrow companion shows only the highlighted run; without it, only the cursor remains.
    if (cap < 120) rows = hovered ? [hovered] : [];
    if (cap <= 0 || plotHeight <= 0 || !rows.length) {
      if (popup) popup.hidden = true;
      return;
    }
    const node = popupNode();
    host.append(node);
    node.style.position = 'absolute';
    node.hidden = false;
    node.dataset.local = 'false';
    node.dataset.fullNames = 'false';
    node.dataset.minimal = 'false';
    node.dataset.valueOnly = String(cap < 120);
    node.replaceChildren();
    node.style.width = '';
    node.style.maxWidth = cap + 'px';
    // Rows use each run's nearest point; the shared X appears once, as the heading.
    const heading = document.createElement('div');
    heading.className = 'plot-inspector-heading';
    heading.textContent = axisText(x);
    const { table, body } = valueTable(false);
    node.append(heading, table);
    for (const row of rows.slice(0, context!.panel.settings?.tooltipLimit || 10)) {
      const line = document.createElement('div');
      line.className = 'plot-inspector-row';
      line.dataset.seriesKey = row.key;
      line.dataset.nearest = String(row === emphasized);
      const marker = document.createElement('span');
      marker.className = 'plot-inspector-marker';
      marker.style.background = row.color;
      const label = document.createElement('div');
      label.className = 'plot-inspector-label';
      const name = document.createElement('span');
      seriesLabel(name, row.label || row.name, false);
      if (row.title) label.title = name.title = row.title;
      label.append(name);
      const value = document.createElement('div');
      value.className = 'plot-inspector-value';
      const number = document.createElement('span');
      number.textContent = formatValue(row.value, row);
      value.append(number);
      line.append(marker, label, value);
      body.append(line);
    }
    // A cropped name is unreadable when too little of its head remains beside the suffix.
    const unreadableName = [...body.querySelectorAll('.series-label-cropped')].some((name) => {
      const head = name.firstElementChild as HTMLElement,
        tail = name.lastElementChild!.getBoundingClientRect().width;
      return (
        head.scrollWidth > head.clientWidth + 0.5 &&
        name.getBoundingClientRect().width < Math.max(48, tail + 12)
      );
    });
    if (unreadableName) {
      node.dataset.valueOnly = 'true';
      for (const row of [...body.children]) {
        if ((row as HTMLElement).dataset.seriesKey !== hovered?.key) row.remove();
      }
    }
    const more = document.createElement('div');
    more.className = 'plot-inspector-more';
    node.append(more);
    const count = () => {
      const remaining = total - body.children.length;
      more.hidden = !remaining;
      more.dataset.remaining = String(remaining);
      more.textContent = context!.translate('charts.tooltip.more', { count: remaining });
    };
    count();
    const maxHeight = Math.min(plotHeight, (plotWidth * plotHeight * 0.4) / cap);
    while (node.getBoundingClientRect().height > maxHeight && body.children.length > 1) {
      body.lastElementChild!.remove();
      count();
    }
    if (node.getBoundingClientRect().height > maxHeight) more.hidden = true;
    const rect = node.getBoundingClientRect();
    const fits =
      body.children.length > 0 && rect.height <= maxHeight && node.scrollWidth <= node.clientWidth;
    const rightSide = rightRoom >= rect.width;
    const hostBox = host.getBoundingClientRect();
    node.style.left = (rightSide ? cursorX + 8 : cursorX - rect.width - 8) - hostBox.left + 'px';
    node.style.top = plot.top - hostBox.top + 'px';
    node.hidden = !fits;
  }
  function show(x: number, y: number, clientX: number, clientY: number, announce = false) {
    if (!enabled || !ready || !context) return;
    const pixel = chart.convertToPixel({ xAxisIndex: 0 }, x),
      next = chart.convertFromPixel({ xAxisIndex: 0 }, pixel + 4);
    let rows = inspectorRows(series, x, hidden, Math.abs(next - x));
    if (!rows.length) {
      hide();
      return;
    }
    if (!local) {
      drawCursor(x);
      showCompanion(rows, x);
      return;
    }
    // A stacked series is focused when the pointer is inside its band; otherwise the
    // series whose plotted point is nearest the pointer is focused.
    const tops = new Map(rows.map((row) => [row, plotted(row)]));
    const pixelY = (value: number) => {
      const point = chart.convertToPixel({ yAxisIndex: 0 }, value);
      return typeof point === 'number' ? point : NaN;
    };
    const band = rows
      .filter((row) => row.stack !== undefined)
      .map((row) => {
        const top = pixelY(tops.get(row)!),
          bottom = pixelY(tops.get(row)! - row.value);
        return { row, top: Math.min(top, bottom), bottom: Math.max(top, bottom) };
      })
      .filter((item) => y >= item.top && y <= item.bottom)
      .sort((a, b) => a.bottom - a.top - (b.bottom - b.top))[0]?.row;
    const nearestByPoint = rows.reduce(
      (best, row) => {
        const distance = Math.abs(pixelY(tops.get(row)!) - y);
        return distance < best.distance ? { row, distance } : best;
      },
      { row: rows[0], distance: Infinity },
    ).row;
    const focused = band || nearestByPoint,
      nearest = { key: focused.key, ids: focused.runIds };
    if (local) {
      onFocus(nearest.key);
      if (
        publishedKey !== nearest.key ||
        nearest.ids.length !== publishedIds.length ||
        nearest.ids.some((id, i) => id !== publishedIds[i])
      ) {
        publishedKey = nearest.key;
        publishedIds = nearest.ids.slice();
        onHover(nearest.ids);
      }
    }
    // Rows follow the plot from top to bottom: stacked series by their plotted position.
    // Equal stacked positions keep the stack order: a later series is drawn above.
    rows.sort(
      (a, b) =>
        tops.get(b)! - tops.get(a)! ||
        (a.stack !== undefined && a.stack === b.stack
          ? (b.index ?? 0) - (a.index ?? 0)
          : b.value - a.value),
    );
    primaryRunOrder = [...new Set(rows.flatMap((row) => row.runIds))];
    if (context.panel.settings?.tooltipOnlyHighlighted)
      rows = rows.filter((row) => row.key === nearest.key);
    const nearestRow = rows.find((row) => row.key === nearest.key)!,
      limit = context.panel.settings?.tooltipLimit || 10;
    let shown = rows.slice(0, limit);
    if (!shown.includes(nearestRow)) {
      shown = [nearestRow, ...shown.slice(0, limit - 1)];
    }
    const node = popupNode();
    layer().append(node);
    node.style.position = 'fixed';
    node.dataset.valueOnly = 'false';
    node.hidden = false;
    node.dataset.fullNames = String(local && Boolean(context.panel.settings?.tooltipFullNames));
    node.dataset.minimal = 'false';
    node.replaceChildren();
    const nearestPixel = chart.convertToPixel({ gridIndex: 0 }, [
      nearestRow.x,
      plotted(nearestRow),
    ]);
    const placement = popupLayout(
      node,
      clientX,
      clientY,
      Array.isArray(nearestPixel) ? nearestPixel : undefined,
    );
    // Rows use each run's nearest point; the inspected X appears once, as the heading.
    const heading = document.createElement('div');
    heading.className = 'plot-inspector-heading';
    heading.textContent = axisText(x);
    const raw = shown.some((row) => row.originalValue !== undefined);
    const { table, columns, body } = valueTable(raw);
    node.append(heading, table);
    for (const row of shown) {
      const line = document.createElement('div');
      line.className = 'plot-inspector-row';
      line.dataset.seriesKey = row.key;
      line.dataset.nearest = String(row.key === nearest.key);
      const marker = document.createElement('span');
      marker.className = 'plot-inspector-marker';
      marker.style.background = row.color;
      const label = document.createElement('div');
      label.className = 'plot-inspector-label';
      const name = document.createElement('span');
      seriesLabel(name, row.label || row.name, context.panel.settings?.tooltipFullNames);
      if (context.panel.settings?.tooltipColoredNames)
        name.style.color = runTextColor(row.color, context.dark);
      if (row.title) label.title = name.title = row.title;
      label.append(name);
      if (row.runs !== undefined) {
        const key = aggregates[context.panel.settings?.aggregation || 'mean'] || aggregates.mean,
          members = document.createElement('span');
        members.className = 'plot-inspector-members';
        members.textContent = context.translate(key, { count: row.runs });
        label.append(members);
      }
      const values = document.createElement('div');
      values.className = 'plot-inspector-value';
      const value = document.createElement('span');
      value.textContent = formatValue(row.value, row);
      value.dataset.label = context.translate('charts.tooltip.smoothed');
      values.append(value);
      if (raw) {
        const original = document.createElement('span');
        original.dataset.label = context.translate('charts.tooltip.original');
        original.textContent =
          row.originalValue === undefined ? '—' : formatValue(row.originalValue, row);
        values.append(original);
      }
      line.append(marker, label, values);
      body.append(line);
    }
    // One stack without percent normalization: its total is the top of the stack.
    const stacks = new Set(rows.map((row) => row.stack));
    if (stacks.size === 1 && rows[0].stack !== undefined && !rows[0].percent && rows.length > 1) {
      const total = document.createElement('div');
      total.className = 'plot-inspector-row plot-inspector-total';
      const label = document.createElement('div');
      label.className = 'plot-inspector-label';
      label.textContent = context.translate('charts.tooltip.total');
      const values = document.createElement('div');
      values.className = 'plot-inspector-value';
      const sum = (pick: (row: InspectRow) => number | undefined) =>
        rows.reduce((value, row) => value + (pick(row) ?? NaN), 0);
      const smoothed = document.createElement('span');
      smoothed.textContent = formatValue(
        sum((row) => row.value),
        rows[0],
      );
      values.append(smoothed);
      if (raw) {
        const original = document.createElement('span'),
          value = sum((row) => row.originalValue);
        original.textContent = Number.isFinite(value) ? formatValue(value, rows[0]) : '—';
        values.append(original);
      }
      total.append(document.createElement('span'), label, values);
      table.append(total);
    }
    const more = document.createElement('div');
    more.className = 'plot-inspector-more';
    node.append(more);
    const updateCount = () => {
      const remaining = rows.length - body.children.length;
      more.hidden = !remaining;
      more.dataset.remaining = String(remaining);
      more.textContent = context!.translate('charts.tooltip.more', { count: remaining });
    };
    updateCount();
    const minimumRows = Math.min(context.panel.settings?.tooltipFullNames ? 3 : 4, shown.length);
    const nearestElement = body.querySelector('[data-nearest="true"]')!;
    const minimum = [
      nearestElement,
      ...[...body.children].filter((row) => row !== nearestElement).slice(0, minimumRows - 1),
    ];
    more.hidden = rows.length <= minimumRows;
    more.textContent = context.translate('charts.tooltip.more', { count: rows.length - minimumRows });
    const chromeHeight = node.getBoundingClientRect().height - body.getBoundingClientRect().height;
    const minimumHeight =
      chromeHeight + minimum.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    updateCount();
    const layout = placement.choose(minimumHeight);
    while (node.getBoundingClientRect().height > layout.maxHeight && body.children.length > 1) {
      const candidates = [...body.children].filter(
        (row) => (row as HTMLElement).dataset.nearest !== 'true',
      );
      candidates.at(-1)?.remove();
      updateCount();
    }
    drawCursor(x);
    if (local && node.getBoundingClientRect().height > layout.maxHeight) {
      // One line: the heading's X moves into the row, so it still appears once.
      node.dataset.minimal = 'true';
      heading.hidden = true;
      columns.hidden = true;
      table.querySelector<HTMLElement>('.plot-inspector-total')?.toggleAttribute('hidden', true);
      const point = document.createElement('small');
      point.textContent = axisText(x);
      body.querySelector('.plot-inspector-label')!.append(point);
    }
    if (local && node.getBoundingClientRect().height > layout.maxHeight) more.hidden = true;
    const fits = node.getBoundingClientRect().height <= layout.maxHeight;
    layout.place();
    node.hidden = !fits;
    if (fits) drawDot(nearestRow);
    else {
      cursor.hidden = true;
      dot.hidden = true;
      publishedKey = undefined;
      onHover([]);
    }
    if (announce && fits)
      live.textContent =
        heading.textContent +
        '; ' +
        (nearestRow.label || nearestRow.name).slice(0, 80) +
        ': ' +
        formatValue(nearestRow.value, nearestRow);
  }
  function pointer(event: PointerEvent) {
    if (!enabled || !ready || !context || (event.buttons > 0 && event.pointerType !== 'touch'))
      return;
    if (
      event.type === 'pointerdown' &&
      event.pointerType === 'touch' &&
      local &&
      popup &&
      !popup.hidden
    ) {
      hide();
      return;
    }
    touch = event.pointerType === 'touch';
    inspectPointer(event.clientX, event.clientY);
  }
  function inspectPointer(clientX: number, clientY: number) {
    const box = canvas.getBoundingClientRect(),
      point = [clientX - box.left, clientY - box.top];
    if (!chart.containPixel({ gridIndex: 0 }, point)) {
      if (local) hide();
      return;
    }
    const rawX = chart.convertFromPixel({ xAxisIndex: 0 }, point[0]);
    if (typeof rawX !== 'number' || !Number.isFinite(rawX)) return;
    const candidates = series
      .filter((item) => !hidden.has(item.name) && item.points.length)
      .map((item) => item.points[nearestPoint(item.points, rawX)][0]);
    if (!candidates.length) return;
    const value = candidates.reduce((best, x) =>
      Math.abs(x - rawX) < Math.abs(best - rawX) ? x : best,
    );
    local = true;
    pendingCursor = null;
    pointerPosition = { clientX, clientY };
    lastX = value;
    show(value, point[1], clientX, clientY);
    onCursor(cursor.hidden ? null : { axis: axis(), value, runOrder: primaryRunOrder });
  }
  function leave(event: PointerEvent) {
    if (event.pointerType !== 'touch' && local) hide();
  }
  function dismiss() {
    keyboardX = undefined;
    hide();
  }
  function outside(event: PointerEvent) {
    if (!canvas.contains(event.target as Node)) {
      keyboardX = undefined;
      if (local) hide();
    }
  }
  function keyboardPoint(x: number, announce = true) {
    const box = canvas.getBoundingClientRect(),
      pixel = chart.convertToPixel({ xAxisIndex: 0 }, x),
      y = canvas.clientHeight / 2;
    local = true;
    pointerPosition = undefined;
    pendingCursor = null;
    keyboardX = x;
    touch = false;
    lastX = x;
    show(x, y, box.left + pixel, box.top + y, announce);
    onCursor(cursor.hidden ? null : { axis: axis(), value: x, runOrder: primaryRunOrder });
  }
  function focus() {
    if (!enabled || !ready) return;
    const steps = pointSteps();
    if (!steps.length || (local && popup && !popup.hidden)) return;
    keyboardPoint(lastX ?? steps[Math.floor(steps.length / 2)]);
  }
  function key(event: KeyboardEvent) {
    if (!enabled || !ready) return;
    if (event.key === 'Escape') {
      if (popup && !popup.hidden) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const steps = pointSteps();
    if (!steps.length) return;
    event.preventDefault();
    event.stopPropagation();
    const current = lastX === undefined ? 0 : nearestStep(steps, lastX),
      next = Math.max(
        0,
        Math.min(
          steps.length - 1,
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? steps.length - 1
              : current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1),
        ),
      );
    keyboardPoint(steps[next]);
  }
  canvas.addEventListener('pointermove', pointer, { capture: true });
  canvas.addEventListener('pointerdown', pointer, { capture: true });
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('pointercancel', dismiss);
  canvas.addEventListener('keydown', key);
  canvas.addEventListener('focus', focus);
  function blur() {
    keyboardX = undefined;
    if (local) hide();
  }
  canvas.addEventListener('blur', blur);
  window.addEventListener('scroll', dismiss, { capture: true, passive: true });
  document.addEventListener('pointerdown', outside, { capture: true });
  function showCursor(value: ChartCursor | null) {
    pendingCursor = value;
    if (!ready || !enabled) return;
    if (value) {
      publishedKey = undefined;
      local = false;
      pointerPosition = undefined;
      stackedSide = undefined;
      live.textContent = '';
    } else if (local) return;
    if (!value && !linkedHover && keyboardX !== undefined && document.activeElement === canvas) {
      keyboardPoint(keyboardX);
      return;
    }
    if (!value || value.axis !== axis()) {
      cursor.hidden = true;
      dot.hidden = true;
      if (popup) popup.hidden = true;
      return;
    }
    // Linked panels can receive the new focus before their corresponding stream
    // chunk. Keep the last inspection until that run arrives instead of hiding
    // its dot (and, in narrow panels, its popup) between the two updates.
    if (
      popup &&
      !popup.hidden &&
      popup.dataset.local === 'false' &&
      context!.data.series.some((item) => item.pending && highlightedRuns.has(item.id))
    )
      return;
    drawCursor(value.value);
    const box = canvas.getBoundingClientRect(),
      pixel = chart.convertToPixel({ xAxisIndex: 0 }, value.value);
    show(value.value, canvas.clientHeight / 2, box.left + pixel, box.top + canvas.clientHeight / 2);
  }
  function refresh() {
    if (!enabled || !ready) return;
    if (!local) showCursor(pendingCursor);
    else if (pointerPosition) inspectPointer(pointerPosition.clientX, pointerPosition.clientY);
    else if (keyboardX !== undefined) keyboardPoint(keyboardX, false);
  }
  return {
    update(
      ctx: PanelContext,
      items: InspectSeries[],
      selection: Record<string, boolean>,
      active: boolean,
    ) {
      context = ctx;
      series = items;
      enabled = active;
      ready = true;
      hidden = new Set(Object.keys(selection).filter((name) => selection[name] === false));
      canvas.tabIndex = active ? 0 : -1;
      canvas.setAttribute('role', active ? 'application' : 'img');
      canvas.setAttribute(
        'aria-label',
        ctx.translate('charts.inspector.label', { name: ctx.panel.title || ctx.panel.metric }),
      );
      canvas.setAttribute('aria-describedby', hint.id);
      hint.textContent = ctx.translate(
        'charts.inspector.instructions',
      );
      canvas.style.touchAction = active ? 'pan-y' : '';
      steps = undefined;
      if (active) {
        refresh();
      } else dismiss();
    },
    selection(selection: Record<string, boolean>) {
      hidden = new Set(Object.keys(selection).filter((name) => selection[name] === false));
      steps = undefined;
      refresh();
    },
    refresh,
    showCursor,
    refreshCursor(value: ChartCursor | null) {
      if (!local) showCursor(value);
    },
    highlightRuns(ids: string[], originLocal: boolean) {
      highlightedRuns = new Set(ids);
      const wasLinked = linkedHover;
      linkedHover = !originLocal && ids.length > 0;
      if (linkedHover && local) {
        publishedKey = undefined;
        // A sidebar hover has no cursor to suspend the local keyboard inspector.
        // Pause it before a focused-run update can republish the previous run.
        local = false;
        pointerPosition = undefined;
        stackedSide = undefined;
        live.textContent = '';
        onFocus(null);
        onCursor(null);
        showCursor(null);
      } else if (wasLinked && !linkedHover && !local) {
        refresh();
      }
    },
    hide: dismiss,
    destroy() {
      ready = false;
      dismiss();
      canvas.removeEventListener('pointermove', pointer, true);
      canvas.removeEventListener('pointerdown', pointer, true);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointercancel', dismiss);
      canvas.removeEventListener('keydown', key);
      canvas.removeEventListener('focus', focus);
      canvas.removeEventListener('blur', blur);
      window.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('pointerdown', outside, true);
      popup?.remove();
      cursor.remove();
      dot.remove();
      live.remove();
      hint.remove();
      context = undefined;
      series = [];
      steps = undefined;
    },
  };
}
