// GPU occupancy timeline (README "Plans and GPU occupancy"): one row per GPU, grouped by
// host, with bars for the runs that held each GPU, the running ones up to now and on to their
// estimated end, and the planned runs queued after them. The timeline scrolls horizontally;
// Ctrl+wheel, a pinch or the zoom buttons change its scale, and a bar opens its run or plan.
import type { OpenTarget, PanelContext, Renderer } from '../types';

type Bar = {
  id: string;
  run: string | null;
  plan: string | null;
  name: string;
  host: string;
  slot: string;
  gpus: number[] | null;
  count: number | null;
  start: number;
  end: number;
  kind: 'past' | 'running' | 'remaining' | 'planned';
  state: string;
  verdict: string | null;
  estimated: boolean;
  unknownLength: boolean;
  inferred?: boolean;
  rows: string[];
  progress?: number | null;
  budget?: number | null;
  from?: number | null;
  audit?: number | null;
  rate?: number | null;
};
type Host = { host: string; model: string; rows: { key: string; gpu: number | null }[] };
export type OccupancyData = {
  now: number;
  hosts: Host[];
  bars: Bar[];
  unplaced: { id: string; name: string }[];
};

const rowHeight = 26,
  hostHeight = 30,
  labelWidth = 148,
  hour = 3600,
  /** Tick spacings, in hours. */
  steps = [1, 2, 3, 6, 12, 24, 48, 168],
  minScale = 0.5,
  maxScale = 600;

/** Rows from top to bottom: each host's header, then its GPU rows. */
export function layout(hosts: Host[]) {
  const rows = new Map<string, number>(),
    headers: { host: Host; top: number }[] = [];
  let top = 0;
  for (const host of hosts) {
    headers.push({ host, top });
    top += hostHeight;
    for (const row of host.rows) {
      rows.set(row.key, top);
      top += rowHeight;
    }
  }
  return { rows, headers, height: top };
}
/** A bar's pieces: one block per run of adjacent rows it covers. */
export function pieces(bar: Bar, rows: Map<string, number>) {
  const tops = bar.rows
    .map((key) => rows.get(key))
    .filter((top): top is number => top !== undefined)
    .sort((a, b) => a - b);
  const blocks: { top: number; height: number }[] = [];
  for (const top of tops) {
    const last = blocks.at(-1);
    if (last && last.top + last.height === top) last.height += rowHeight;
    else blocks.push({ top, height: rowHeight });
  }
  return blocks;
}
/** The time span shown: from the first bar (or a day before now) to a day past the last. */
export function span(data: OccupancyData) {
  const starts = data.bars.map((bar) => bar.start),
    ends = data.bars.map((bar) => bar.end);
  return {
    from: Math.min(data.now - 24 * hour, ...starts),
    to: Math.max(data.now + 24 * hour, ...ends) + 6 * hour,
  };
}
/** The name, or its part before the first `_` when the whole would not fit `width` px. */
export function shortName(name: string, width: number) {
  const fits = Math.floor(width / 6.5),
    head = name.split(/[_\s]/)[0];
  return name.length <= fits || head.length >= name.length ? name : head;
}
/** The tick spacing (hours) that keeps labels at least 72 px apart at `scale` px per hour. */
export function tickStep(scale: number) {
  return steps.find((step) => step * scale >= 72) ?? steps.at(-1)!;
}

export function create({
  element,
  onOpen,
}: {
  element: HTMLElement;
  onOpen?: (target: OpenTarget) => void;
}): Renderer {
  element.classList.add('occupancy');
  element.innerHTML = '';
  const toolbar = document.createElement('div'),
    legend = document.createElement('div'),
    controls = document.createElement('div'),
    scroller = document.createElement('div'),
    content = document.createElement('div'),
    header = document.createElement('div'),
    corner = document.createElement('div'),
    axis = document.createElement('div'),
    body = document.createElement('div'),
    labels = document.createElement('div'),
    track = document.createElement('div'),
    tooltip = document.createElement('div'),
    note = document.createElement('p');
  toolbar.className = 'occupancy-toolbar';
  legend.className = 'occupancy-legend';
  controls.className = 'occupancy-controls';
  scroller.className = 'occupancy-scroll';
  scroller.tabIndex = 0;
  content.className = 'occupancy-content';
  header.className = 'occupancy-header';
  corner.className = 'occupancy-corner';
  axis.className = 'occupancy-axis';
  body.className = 'occupancy-body';
  labels.className = 'occupancy-labels';
  track.className = 'occupancy-track';
  tooltip.className = 'occupancy-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  note.className = 'occupancy-note';
  note.hidden = true;
  header.append(corner, axis);
  body.append(labels, track);
  content.append(header, body);
  scroller.append(content);
  toolbar.append(legend, controls);
  element.append(toolbar, note, scroller, tooltip);

  let ctx: PanelContext | null = null,
    data: OccupancyData | null = null,
    scale = 0,
    from = 0,
    to = 0,
    placed = false,
    frame = 0;
  const t = (key: string, values?: Record<string, unknown>) =>
    ctx ? ctx.translate(key as any, values as any) : key;
  const x = (time: number) => ((time - from) / hour) * scale;
  const button = (label: string, title: string, action: () => void) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'occupancy-button';
    item.textContent = label;
    item.title = title;
    item.setAttribute('aria-label', title);
    item.addEventListener('click', action);
    return item;
  };
  const zoomOut = button('−', '', () => zoom(1 / 1.5)),
    zoomIn = button('+', '', () => zoom(1.5)),
    toNow = button('', '', () => showNow());
  controls.append(zoomOut, zoomIn, toNow);

  /** Changes the scale around a point of the view (its middle by default). */
  function zoom(factor: number, at = scroller.clientWidth / 2) {
    if (!data) return;
    const offset = Math.max(0, at - labelWidth),
      time = from + ((scroller.scrollLeft + offset) / scale) * hour;
    scale = Math.min(maxScale, Math.max(minScale, scale * factor));
    draw();
    scroller.scrollLeft = x(time) - offset;
  }
  function showNow() {
    if (!data) return;
    const visible = Math.max(0, scroller.clientWidth - labelWidth);
    scroller.scrollLeft = x(data.now) - visible * 0.6;
  }
  /** Fits two days before now and the queue after it, within limits. */
  function fit() {
    if (!data) return;
    const visible = Math.max(200, scroller.clientWidth - labelWidth),
      ahead = Math.max(
        12 * hour,
        ...data.bars.filter((bar) => bar.end > data!.now).map((bar) => bar.end - data!.now),
      ),
      window = 48 * hour + Math.min(ahead, 7 * 24 * hour) + 2 * hour;
    scale = Math.min(maxScale, Math.max(minScale, visible / (window / hour)));
  }

  const dayFormat = () =>
      new Intl.DateTimeFormat(ctx?.locale, { month: 'short', day: 'numeric', weekday: 'short' }),
    timeFormat = () => new Intl.DateTimeFormat(ctx?.locale, { hour: '2-digit', minute: '2-digit' }),
    fullFormat = () =>
      new Intl.DateTimeFormat(ctx?.locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    numberFormat = () => new Intl.NumberFormat(ctx?.locale);
  /** A length in its two largest units, such as 1d 4h or 3h 20min. */
  const duration = (seconds: number) => {
    const style = 'narrow' as const,
      units = ['day', 'hour', 'minute'],
      value = Math.max(60, Math.round(seconds / 60) * 60),
      parts = [
        Math.floor(value / 86400),
        Math.floor(value / 3600) % 24,
        Math.floor(value / 60) % 60,
      ],
      first = parts.findIndex((part) => part > 0);
    return new Intl.ListFormat(ctx?.locale, { style, type: 'unit' }).format(
      parts
        .map((part, index) => ({ part, index }))
        .filter(({ part, index }) => index >= first && index < first + 2 && part > 0)
        .map(({ part, index }) =>
          new Intl.NumberFormat(ctx?.locale, {
            style: 'unit',
            unit: units[index],
            unitDisplay: style,
          }).format(part),
        ),
    );
  };

  /** Ticks for the part of the axis in view; redrawn as it scrolls. */
  function drawAxis() {
    frame = 0;
    if (!data) return;
    const step = tickStep(scale) * hour,
      left = from + (scroller.scrollLeft / scale) * hour - step,
      right = left + ((scroller.clientWidth + 2 * labelWidth) / scale) * hour + 2 * step,
      days = dayFormat(),
      times = timeFormat();
    const ticks: HTMLElement[] = [];
    // Ticks fall on local hours: step multiples counted from local midnight.
    const start = new Date(left * 1000);
    start.setMinutes(0, 0, 0);
    if (step >= 24 * hour) start.setHours(0);
    else start.setHours(Math.floor(start.getHours() / (step / hour)) * (step / hour));
    for (let at = start.getTime() / 1000; at <= right;) {
      const date = new Date(at * 1000),
        midnight = date.getHours() === 0,
        tick = document.createElement('span');
      tick.className = 'occupancy-tick' + (midnight ? ' day' : '');
      tick.style.left = x(at) + 'px';
      tick.textContent = midnight || step >= 24 * hour ? days.format(date) : times.format(date);
      ticks.push(tick);
      // Whole days are added on the calendar, so daylight saving changes keep midnight.
      if (step >= 24 * hour) date.setDate(date.getDate() + step / (24 * hour));
      else date.setTime(date.getTime() + step * 1000);
      at = date.getTime() / 1000;
    }
    const now = document.createElement('span');
    now.className = 'occupancy-now-label';
    now.style.left = x(data.now) + 'px';
    now.textContent = t('occupancy.now');
    axis.replaceChildren(...ticks, now);
  }

  function describe(bar: Bar) {
    const hosts = data?.hosts.find((host) => host.host === bar.host),
      gpus = bar.gpus?.length
        ? t('occupancy.tooltip.gpus', { host: bar.host, gpus: bar.gpus.join(', ') })
        : t('occupancy.tooltip.gpuCount', {
            host: bar.host,
            count: bar.count ?? 0,
          }),
      times = fullFormat(),
      numbers = numberFormat(),
      lines = [
        bar.name,
        [gpus, hosts?.model, bar.slot].filter(Boolean).join(' · '),
        t(
          bar.kind === 'planned'
            ? bar.unknownLength
              ? 'occupancy.tooltip.plannedUnknown'
              : 'occupancy.tooltip.planned'
            : bar.kind === 'remaining'
              ? 'occupancy.tooltip.remaining'
              : bar.kind === 'running'
                ? 'occupancy.tooltip.running'
                : 'occupancy.tooltip.past',
          {
            start: times.format(new Date(bar.start * 1000)),
            end: times.format(new Date(bar.end * 1000)),
            duration: duration(bar.end - bar.start),
          },
        ),
      ];
    if (bar.progress != null && bar.budget != null)
      lines.push(
        t('occupancy.tooltip.progress', {
          progress: numbers.format(bar.progress),
          budget: numbers.format(bar.budget),
          percent: Math.round(
            (100 * ((bar.progress ?? 0) - (bar.from ?? 0))) /
              Math.max(1, bar.budget - (bar.from ?? 0)),
          ),
        }),
      );
    else if (bar.kind === 'planned' && bar.budget != null)
      lines.push(t('occupancy.tooltip.updates', { updates: numbers.format(bar.budget) }));
    if (bar.inferred) lines.push(t('occupancy.tooltip.inferred'));
    if (bar.audit != null)
      lines.push(t('occupancy.tooltip.audit', { value: numbers.format(bar.audit) }));
    if (bar.verdict && bar.verdict !== 'running')
      lines.push(
        t(bar.verdict === 'adopted' ? 'occupancy.verdict.adopted' : 'occupancy.verdict.rejected'),
      );
    return lines;
  }
  function showTip(bar: Bar, anchor: DOMRect) {
    tooltip.replaceChildren(
      ...describe(bar).map((line, index) => {
        const item = document.createElement(index ? 'span' : 'strong');
        item.textContent = line;
        return item;
      }),
    );
    tooltip.hidden = false;
    // Fixed, so the panel's scrolling edges do not clip it. An ancestor with layout containment
    // (the panel) holds fixed elements, so place it from where 0, 0 lands.
    tooltip.style.left = tooltip.style.top = '0px';
    const origin = tooltip.getBoundingClientRect(),
      width = tooltip.offsetWidth,
      height = tooltip.offsetHeight,
      left = Math.max(4, Math.min(anchor.left, innerWidth - width - 4)),
      below = anchor.bottom + 6,
      top = below + height > innerHeight ? Math.max(4, anchor.top - height - 6) : below;
    tooltip.style.left = left - origin.left + 'px';
    tooltip.style.top = top - origin.top + 'px';
  }
  const hideTip = () => (tooltip.hidden = true);

  function draw() {
    if (!data || !ctx) return;
    hideTip();
    const { rows, headers, height } = layout(data.hosts),
      width = Math.max(0, x(to));
    content.style.width = labelWidth + width + 'px';
    axis.style.width = track.style.width = width + 'px';
    track.style.height = labels.style.height = height + 'px';
    const labelItems: HTMLElement[] = [],
      trackItems: HTMLElement[] = [];
    for (const { host, top } of headers) {
      const label = document.createElement('div');
      label.className = 'occupancy-host';
      label.style.top = top + 'px';
      label.style.height = hostHeight + 'px';
      const name = document.createElement('strong');
      name.textContent = host.host;
      const detail = document.createElement('span');
      const known = host.rows.filter((row) => row.gpu !== null).length;
      detail.textContent = [host.model, known ? t('occupancy.gpus', { count: known }) : '']
        .filter(Boolean)
        .join(' · ');
      label.title = [host.host, detail.textContent].filter(Boolean).join(' · ');
      label.append(name, detail);
      labelItems.push(label);
      const band = document.createElement('div');
      band.className = 'occupancy-band';
      band.style.top = top + 'px';
      band.style.height = hostHeight + 'px';
      trackItems.push(band);
      for (const row of host.rows) {
        const rowTop = rows.get(row.key)!,
          item = document.createElement('div');
        item.className = 'occupancy-row-label' + (row.gpu === null ? ' unlogged' : '');
        item.style.top = rowTop + 'px';
        item.textContent =
          row.gpu === null ? t('occupancy.unlogged') : t('occupancy.gpu', { index: row.gpu });
        if (row.gpu === null) item.title = t('occupancy.unloggedHelp');
        labelItems.push(item);
        const line = document.createElement('div');
        line.className = 'occupancy-row' + (row.gpu === null ? ' unlogged' : '');
        line.style.top = rowTop + 'px';
        trackItems.push(line);
      }
    }
    // Day boundaries as faint lines across the rows.
    const day = new Date(from * 1000);
    day.setHours(0, 0, 0, 0);
    for (
      day.setDate(day.getDate() + 1);
      day.getTime() / 1000 < to;
      day.setDate(day.getDate() + 1)
    ) {
      const line = document.createElement('div');
      line.className = 'occupancy-day';
      line.style.left = x(day.getTime() / 1000) + 'px';
      trackItems.push(line);
    }
    for (const bar of data.bars)
      for (const block of pieces(bar, rows)) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = [
          'occupancy-bar',
          'kind-' + bar.kind,
          bar.verdict ? 'verdict-' + bar.verdict : '',
          bar.unknownLength ? 'unknown-length' : '',
          bar.kind === 'past' && bar.state !== 'finished' ? 'ended-' + bar.state : '',
        ]
          .filter(Boolean)
          .join(' ');
        const left = x(bar.start),
          right = x(bar.end);
        item.style.left = left + 'px';
        item.style.width = Math.max(3, right - left - 1) + 'px';
        item.style.top = block.top + 2 + 'px';
        item.style.height = block.height - 4 + 'px';
        item.dataset.id = bar.id;
        // A running run's estimate continues its bar, so only the first part is named; a short
        // bar shows the name's first part (such as v657) when the whole name does not fit.
        const label = bar.kind === 'remaining' ? '' : shortName(bar.name, right - left - 12);
        if (label && right - left > 28) {
          const text = document.createElement('span');
          text.textContent = label;
          item.append(text);
        }
        item.setAttribute('aria-label', describe(bar).join(', '));
        item.addEventListener('pointerenter', () => showTip(bar, item.getBoundingClientRect()));
        item.addEventListener('pointerleave', hideTip);
        item.addEventListener('focus', () => showTip(bar, item.getBoundingClientRect()));
        item.addEventListener('blur', hideTip);
        item.addEventListener('click', () => {
          if (bar.run) onOpen?.({ run: bar.run });
          else if (bar.plan) onOpen?.({ plan: bar.plan });
        });
        trackItems.push(item);
      }
    const now = document.createElement('div');
    now.className = 'occupancy-now';
    now.style.left = x(data.now) + 'px';
    trackItems.push(now);
    labels.replaceChildren(...labelItems);
    track.replaceChildren(...trackItems);
    drawAxis();
  }
  function drawLegend() {
    const entries: [string, string][] = [
      ['kind-past', 'occupancy.legend.past'],
      ['kind-running', 'occupancy.legend.running'],
      ['kind-remaining', 'occupancy.legend.remaining'],
      ['kind-planned', 'occupancy.legend.planned'],
    ];
    legend.replaceChildren(
      ...entries.map(([kind, key]) => {
        const item = document.createElement('span'),
          swatch = document.createElement('span');
        swatch.className = 'occupancy-swatch occupancy-bar ' + kind;
        item.append(swatch, document.createTextNode(t(key)));
        return item;
      }),
    );
    zoomOut.title = t('occupancy.zoomOut');
    zoomOut.setAttribute('aria-label', zoomOut.title);
    zoomIn.title = t('occupancy.zoomIn');
    zoomIn.setAttribute('aria-label', zoomIn.title);
    toNow.textContent = t('occupancy.showNow');
    toNow.title = t('occupancy.showNow');
    scroller.setAttribute('aria-label', t('occupancy.label'));
    if (data?.unplaced.length) {
      note.hidden = false;
      note.textContent = t('occupancy.unplaced', {
        count: data.unplaced.length,
        names: data.unplaced.map((run) => run.name).join(', '),
      });
    } else note.hidden = true;
  }

  const onScroll = () => {
    hideTip();
    if (!frame) frame = requestAnimationFrame(drawAxis);
  };
  // Ctrl+wheel (and touchpad pinches, which arrive as Ctrl+wheel) zoom around the pointer.
  const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const box = scroller.getBoundingClientRect();
    zoom(Math.exp(-event.deltaY / 200), event.clientX - box.left);
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('wheel', onWheel, { passive: false });

  return {
    update(next) {
      ctx = next;
      const incoming = next.data as unknown as OccupancyData;
      if (!incoming?.hosts) return;
      data = incoming;
      ({ from, to } = span(data));
      element.classList.toggle('dark', next.dark);
      drawLegend();
      if (!placed && scroller.clientWidth) fit();
      if (!scale) scale = 4;
      draw();
      if (!placed && scroller.clientWidth) {
        placed = true;
        showNow();
      }
    },
    resize() {
      if (!data) return;
      if (!placed && scroller.clientWidth) {
        fit();
        draw();
        placed = true;
        showNow();
      } else drawAxis();
    },
    destroy() {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      element.replaceChildren();
    },
  };
}
