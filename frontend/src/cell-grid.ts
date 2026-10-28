import { mountPlugin, type Extent } from './plugins/registry';
import { Carousel, TileGrid, fitSize, gridGeometry } from './plugins/tile-view';
import { chevronIcon } from './plugins/icons';
import { schedulePanel, cancelPanel } from './panel-frame';
import { color } from './run-colors';
import { groupTitle } from './ui';
import { niceRange } from './chart-math';
import panelLimits from '../../backend/src/panel-limits.json';
import type { PlotCursor } from './hover';
import type { ChartCursor, ChartData, PanelContext, PlotSettings, Plugin, Renderer } from './types';

// Grid layout for cellLayout panels: one cell per run or group, each an ordinary renderer
// instance of the panel's plugin with the unchanged lifecycle. The host splits the panel's
// one response into per-cell data that share the read-only arrays, gives every cell the
// same X range (and optionally Y range), and routes hover and cursors between cells.

const captionHeight = 24;
/** Chart cells are never narrower than this, whatever item size they inherit. */
export const chartMinimum = panelLimits.itemSize.chartMin;
/** A cell's height for its width: the plot at a fixed aspect, plus its caption. */
export function cellHeight(width: number, viewport: number) {
  return Math.max(140, Math.min(Math.round(width * 0.62) + captionHeight, Math.max(140, viewport)));
}
/** The cell width a grid uses for a requested size in a plot area, after the mount cap. */
export function cellWidth(contentWidth: number, viewport: number, size: number) {
  const fitted = fitSize(
    contentWidth,
    viewport,
    Math.max(size, chartMinimum),
    panelLimits.cells.renderers,
    (width) => cellHeight(width, viewport),
  );
  return gridGeometry(contentWidth, fitted).width;
}
type Cell = {
  key: string;
  name: string;
  color: string;
  runIds: string[];
  /** Member runs of a group. */
  members?: number;
  data: ChartData;
};
type Mounted = { renderer: Renderer; element: HTMLElement; holder: { key: string } };
type Slot = {
  index: number;
  cell: HTMLElement;
  plot: HTMLElement;
  owner: object;
  mounted?: Mounted;
  /** Keyboard focus is inside the cell's chart. */
  entered: boolean;
};
export type CellGridHost = {
  plugin: Plugin;
  panelId: string;
  onRange: (range: { xMin: number; xMax: number } | null) => void;
  onHover: (ids: string[]) => void;
  onCursor: (key: string, cursor: ChartCursor | null) => void;
  onError: (error: Error) => void;
  /** Cell count, the tile width in use, the mounted renderers and whether the plugin's
   * renderers export images, after each layout. */
  onState: (state: { count: number; size: number; mounted: number; exportable: boolean }) => void;
  /** Coverflow: the current cell's key, kept per browser tab. */
  current?: () => string | undefined;
  onCurrent?: (key: string) => void;
};
const focusable = '[tabindex]:not([tabindex="-1"]),button,a[href],input,select,textarea';
/** Most points in a coverflow neighbor's sparkline. */
const sparklinePoints = 64;
export class CellGrid implements Renderer {
  private grid: TileGrid | undefined;
  private carousel: Carousel | undefined;
  private root: HTMLElement;
  private slots = new Map<number, Slot>();
  private pool: Mounted[] = [];
  private cells: Cell[] = [];
  private context: PanelContext | undefined;
  private settings: PlotSettings = {};
  private highlight: { ids: string[]; local: boolean } = { ids: [], local: false };
  private cursor: PlotCursor | null = null;
  private extent: Extent | undefined;
  private destroyed = false;
  /** Fewer than two cells draw as one chart, without cell captions. */
  private single = false;
  constructor(
    root: HTMLElement,
    private host: CellGridHost,
    private size: number,
    private mode: 'grid' | 'coverflow',
  ) {
    const element = document.createElement('div');
    element.className = 'cell-grid';
    root.replaceChildren(element);
    this.root = element;
    if (mode === 'grid') {
      this.grid = new TileGrid(
        element,
        {
          mount: (index, cell) => this.mount(index, cell),
          unmount: (index) => this.unmount(index),
          settled: () => this.settled(),
          key: (event, index) => this.key(event, index),
        },
        '',
      );
      element.addEventListener('keydown', this.escape);
      element.addEventListener('focusout', this.leave);
    }
  }
  // Coverflow: one live renderer for the current cell; neighbors are sparklines.
  private createCarousel(ctx: PanelContext) {
    this.carousel = new Carousel(
      this.root,
      {
        stage: (index, element) => this.mount(index, element),
        release: (index) => this.unmount(index),
        peek: (index, element) => this.peek(index, element),
        chip: (index, element) => this.chip(index, element),
        name: (index) => this.cells[index].name,
        // Charts have no shape of their own; a fixed 4:3 keeps room for neighbours on wide panels.
        aspect: () => 4 / 3,
        change: (index) => {
          this.host.onCurrent?.(this.cells[index].key);
          this.markChips();
          this.report();
        },
      },
      {
        label: ctx.panel.title || ctx.panel.metric,
        carousel: ctx.translate('panel.coverflow.role'),
        slide: ctx.translate('panel.coverflow.slide'),
        previous: ctx.translate('panel.coverflow.previous'),
        next: ctx.translate('panel.coverflow.next'),
        position: (index, count) => ctx.translate('panel.coverflow.position', { index, count }),
      },
      { chipWidth: 160, icon: chevronIcon },
    );
  }
  /** The live item size, while the size slider moves. */
  setSize(size: number) {
    this.size = size;
    this.layout();
  }
  /** Sets the plugin's `extent` export; a shared Y range needs it. */
  setExtent(extent: Extent | undefined) {
    this.extent = extent;
    if (this.context) this.update(this.context);
  }
  update(ctx: PanelContext) {
    this.context = ctx;
    const { translate } = ctx;
    this.cells = ctx.data.series.slice(0, panelLimits.chartRuns).map((series) => ({
      key: series.id,
      name: series.group
        ? series.group.field === 'all'
          ? translate('charts.groups.allRuns')
          : groupTitle(series.group.field, series.group.value, translate)
        : series.name,
      color: color(series.id, ctx.colors, ctx.dark),
      runIds: series.runIds || [series.id],
      members: series.runIds?.length,
      data: { ...ctx.data, series: [series] },
    }));
    const settings = ctx.panel.settings || {};
    this.single = this.cells.length < 2;
    this.root.classList.toggle('cell-single', this.single);
    this.settings = this.single
      ? settings
      : {
          ...settings,
          // The caption names the run; several metrics keep their legend.
          ...(ctx.data.metrics.length <= 1 ? { legend: false } : {}),
          ...this.sharedX(ctx),
        };
    if (settings.sharedY && this.extent && !this.single && this.grid)
      this.settings = { ...this.settings, ...this.sharedY() };
    if (this.grid) {
      this.grid.label = ctx.panel.title || ctx.panel.metric;
      this.layout();
      for (const slot of this.slots.values()) {
        this.caption(slot);
        this.schedule(slot);
      }
      return;
    }
    if (!this.carousel) this.createCarousel(ctx);
    // The current item is kept by key: sorting, pins and new runs leave it in place, and
    // when it disappears the item at its position is shown.
    const key = this.host.current?.(),
      index = this.cells.findIndex((cell) => cell.key === key);
    this.carousel!.set(this.cells.length, index >= 0 ? index : this.carousel!.index, true);
    this.markChips();
    this.report();
  }
  // Every cell shows the X range of all cells, so runs of different lengths compare.
  private sharedX(ctx: PanelContext) {
    const settings = ctx.panel.settings || {};
    if (settings.xMin != null && settings.xMax != null) return {};
    let lo = Infinity,
      hi = -Infinity;
    for (const series of ctx.data.series)
      for (const points of Object.values(series.values))
        for (const [x] of points) {
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
    if (!(lo < hi)) return {};
    return { xMin: settings.xMin ?? lo, xMax: settings.xMax ?? hi };
  }
  // With a shared Y range, every cell shows the union of the ranges its chart would fit.
  private sharedY() {
    const settings = this.settings;
    if (settings.yMin != null && settings.yMax != null) return {};
    let lo = Infinity,
      hi = -Infinity;
    for (const index of this.cells.keys()) {
      let range: [number, number] | null = null;
      try {
        range = this.extent!(this.cellContext(index));
      } catch {
        // A cell whose chart cannot be drawn shows its own error and adds no range.
      }
      if (range) [lo, hi] = [Math.min(lo, range[0]), Math.max(hi, range[1])];
    }
    if (!(lo <= hi)) return {};
    const [min, max] = niceRange(lo, hi, { log: settings.yScale === 'log' });
    return { yMin: settings.yMin ?? min, yMax: settings.yMax ?? max };
  }
  private cellContext(index: number): PanelContext {
    const ctx = this.context!;
    return {
      ...ctx,
      data: this.cells[index].data,
      panel: { ...ctx.panel, settings: this.settings },
      ...(this.single
        ? {}
        : {
            cell: {
              index,
              count: this.cells.length,
              compact: (this.grid?.tileWidth ?? this.carousel!.current.clientWidth) < 280,
            },
          }),
    };
  }
  private layout() {
    if (!this.grid) return;
    const grid = this.grid,
      viewport = () => grid.scroller.clientHeight;
    grid.layout({
      count: this.cells.length,
      // One cell fills the plot.
      size: this.single ? Number.MAX_SAFE_INTEGER : this.size,
      minSize: chartMinimum,
      cap: panelLimits.cells.renderers,
      height: (_, width) => (this.single ? viewport() : cellHeight(width, viewport())),
    });
    this.report();
  }
  private exportable = false;
  private report() {
    this.host.onState({
      count: this.cells.length,
      size: this.grid?.effectiveSize ?? 0,
      mounted: this.slots.size,
      exportable: this.exportable,
    });
  }
  private mount(index: number, cell: HTMLElement) {
    const caption = document.createElement('div'),
      plot = document.createElement('div');
    caption.className = 'cell-caption';
    caption.setAttribute('aria-hidden', 'true');
    plot.className = 'cell-plot';
    cell.append(caption, plot);
    // Coverflow's slide is no grid tile: its chart stays in the tab order.
    const slot: Slot = { index, cell, plot, owner: {}, entered: this.mode === 'coverflow' };
    this.slots.set(index, slot);
    this.caption(slot);
    const reused = this.pool.pop();
    if (reused) this.attach(slot, reused);
    else {
      const holder = { key: this.cells[index].key };
      void mountPlugin(
        this.host.plugin,
        plot,
        this.host.onRange,
        this.host.onHover,
        this.host.onError,
        (cursor) => this.host.onCursor(holder.key, cursor),
      )
        .then((renderer) => {
          const mounted = { renderer, element: plot.firstElementChild as HTMLElement, holder };
          if (this.slots.get(index) === slot && !this.destroyed) this.attach(slot, mounted);
          else this.release(mounted);
        })
        .catch((error) => this.host.onError(error));
    }
  }
  private attach(slot: Slot, mounted: Mounted) {
    slot.mounted = mounted;
    if (!this.exportable && mounted.renderer.exportImage) {
      this.exportable = true;
      this.report();
    }
    mounted.holder.key = this.cells[slot.index].key;
    if (mounted.element.parentElement !== slot.plot) slot.plot.replaceChildren(mounted.element);
    mounted.renderer.resize();
    this.schedule(slot);
  }
  private unmount(index: number) {
    const slot = this.slots.get(index)!;
    this.slots.delete(index);
    cancelPanel(slot.owner);
    if (slot.mounted) {
      slot.mounted.element.remove();
      this.pool.push(slot.mounted);
    }
  }
  // Renderers leaving the window are reused by the cells entering it; a few are kept.
  private settled() {
    while (this.pool.length > 2 * this.grid!.columnCount) this.pool.pop()!.renderer.destroy();
    this.report();
  }
  private release(mounted: Mounted) {
    if (this.destroyed || this.pool.length >= panelLimits.cells.renderers) {
      mounted.renderer.destroy();
      return;
    }
    mounted.element.remove();
    this.pool.push(mounted);
  }
  private caption(slot: Slot) {
    const cell = this.cells[slot.index],
      ctx = this.context!;
    if (!cell) return;
    const swatch = document.createElement('span'),
      name = document.createElement('span');
    swatch.className = 'cell-swatch';
    swatch.style.background = cell.color;
    name.className = 'cell-name';
    name.textContent = cell.name;
    name.title = cell.name;
    const parts: HTMLElement[] = [swatch, name];
    if (cell.members !== undefined) {
      const members = document.createElement('span');
      members.className = 'cell-members';
      members.textContent = ctx.translate('panel.cell.groupRuns', { count: cell.members });
      parts.push(members);
    }
    slot.cell.querySelector('.cell-caption')!.replaceChildren(...parts);
    if (this.grid)
      slot.cell.setAttribute(
        'aria-label',
        ctx.translate('panel.cell.name', {
          name: cell.name,
          position: slot.index + 1,
          count: this.cells.length,
        }),
      );
    slot.cell.dataset.key = cell.key;
  }
  private schedule(slot: Slot) {
    schedulePanel(
      slot.owner,
      () => {
        const mounted = slot.mounted;
        if (!mounted || !this.context || !this.cells[slot.index]) return;
        mounted.holder.key = this.cells[slot.index].key;
        this.route(slot);
        try {
          const result = mounted.renderer.update(this.cellContext(slot.index));
          if (result instanceof Promise)
            result.then(
              () => this.detab(slot),
              (error) => this.host.onError(error),
            );
          else this.detab(slot);
        } catch (error) {
          this.host.onError(error as Error);
        }
      },
      true,
    );
  }
  // Only the grid's roving tile is a tab stop; Enter moves focus into a cell's chart.
  private detab(slot: Slot) {
    if (slot.entered) return;
    for (const element of slot.plot.querySelectorAll<HTMLElement>(focusable)) element.tabIndex = -1;
  }
  private key(event: KeyboardEvent, index: number) {
    if (event.key !== 'Enter') return false;
    // The chart itself (built-in charts' keyboard inspection), else its first visible control.
    const slot = this.slots.get(index),
      target =
        slot?.plot.querySelector<HTMLElement>('[role="application"]') ||
        [...(slot?.plot.querySelectorAll<HTMLElement>(focusable + ',[tabindex]') || [])].find(
          (element) => element.getClientRects().length > 0,
        );
    if (!slot || !target) return false;
    slot.entered = true;
    target.focus();
    return true;
  }
  private escape = (event: KeyboardEvent) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[role="gridcell"]');
    if (event.key !== 'Escape' || !cell || cell === event.target) return;
    event.preventDefault();
    cell.focus();
  };
  private leave = (event: FocusEvent) => {
    for (const slot of this.slots.values())
      if (slot.entered && !slot.cell.contains(event.relatedTarget as Node)) {
        slot.entered = false;
        this.detab(slot);
      }
  };
  // Linked hover reaches only the cells of the hovered runs; another panel's or the run
  // list's hover outlines them. Other cells are never dimmed for lacking the run.
  private route(slot: Slot) {
    const { ids, local } = this.highlight,
      key = this.cells[slot.index]?.key,
      set = new Set(ids),
      match = ids.length > 0 && this.cells[slot.index].runIds.some((id) => set.has(id));
    slot.cell.classList.toggle('cell-linked', match && !local);
    slot.mounted?.renderer.highlightRuns?.(match ? ids : [], match && local);
    if (this.cursor?.source !== this.host.panelId + '#' + key)
      slot.mounted?.renderer.showCursor?.(this.cursor);
  }
  highlightRuns(ids: string[], local: boolean) {
    this.highlight = { ids, local };
    for (const slot of this.slots.values()) this.route(slot);
    this.markChips();
  }
  // Coverflow does not follow hover; a hovered neighbor's chip gets the outline.
  private markChips() {
    if (!this.carousel) return;
    const { ids, local } = this.highlight,
      set = new Set(ids);
    for (const chip of this.root.querySelectorAll<HTMLElement>('.carousel-chip'))
      chip.classList.toggle(
        'cell-linked',
        !local && this.cells[Number(chip.dataset.index)].runIds.some((id) => set.has(id)),
      );
  }
  private chip(index: number, element: HTMLElement) {
    const cell = this.cells[index],
      swatch = document.createElement('span'),
      name = document.createElement('span');
    swatch.className = 'cell-swatch';
    swatch.style.background = cell.color;
    name.className = 'cell-name';
    name.textContent = cell.name;
    element.append(swatch, name);
  }
  // A neighbor shows its caption and a sparkline of its first metric, without a renderer.
  private peek(index: number, element: HTMLElement) {
    const cell = this.cells[index],
      caption = document.createElement('div'),
      metric = cell.data.metrics[0],
      points = cell.data.series[0].values[metric] || [];
    caption.className = 'cell-caption';
    this.chip(index, caption);
    element.append(caption);
    if (points.length < 2) return;
    const step = Math.max(1, Math.ceil(points.length / sparklinePoints)),
      sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, y] of sampled) {
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('cell-sparkline');
    line.setAttribute(
      'points',
      sampled
        .map(
          ([x, y]) =>
            ((x - x0) / (x1 - x0 || 1)) * 100 + ',' + (100 - ((y - y0) / (y1 - y0 || 1)) * 100),
        )
        .join(' '),
    );
    line.setAttribute('stroke', cell.color);
    line.setAttribute('fill', 'none');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
    element.append(svg);
  }
  /** Shows a cursor in every cell except the one it came from. */
  showCursor(cursor: ChartCursor | null) {
    this.cursor = cursor as PlotCursor | null;
    for (const slot of this.slots.values())
      if (
        cursor === null ||
        this.cursor!.source !== this.host.panelId + '#' + this.cells[slot.index]?.key
      )
        slot.mounted?.renderer.showCursor?.(cursor);
  }
  /**
   * One PNG of the grid: up to 64 cells in the grid's columns, each drawn by one off-screen
   * renderer in turn, with its caption. Coverflow exports the current cell.
   */
  async exportImage() {
    const ctx = this.context!;
    if (this.carousel) {
      const slot = [...this.slots.values()][0];
      return (await slot?.mounted?.renderer.exportImage?.()) ?? '';
    }
    const grid = this.grid!,
      count = Math.min(this.cells.length, panelLimits.cells.export),
      columns = grid.columnCount,
      width = Math.round(grid.tileWidth),
      height = cellHeight(width, grid.scroller.clientHeight) - captionHeight,
      scale = 2,
      gap = 8,
      canvas = document.createElement('canvas'),
      draw = canvas.getContext('2d')!,
      style = getComputedStyle(this.root);
    canvas.width = (columns * (width + gap) - gap) * scale;
    canvas.height = Math.ceil(count / columns) * (height + captionHeight + gap) * scale;
    draw.fillStyle = ctx.dark ? '#262626' : '#ffffff';
    draw.fillRect(0, 0, canvas.width, canvas.height);
    const stage = document.createElement('div');
    stage.style.cssText = `position:fixed;left:-${width * 2}px;top:0;width:${width}px;height:${height}px`;
    document.body.append(stage);
    try {
      const renderer = await mountPlugin(this.host.plugin, stage);
      try {
        for (let index = 0; index < count; index++) {
          await renderer.update(this.cellContext(index));
          const image = new Image();
          image.src = await renderer.exportImage!();
          await image.decode();
          const x = (index % columns) * (width + gap),
            y = Math.floor(index / columns) * (height + captionHeight + gap),
            cell = this.cells[index];
          draw.fillStyle = cell.color;
          draw.beginPath();
          draw.arc((x + 12) * scale, (y + 12) * scale, 4 * scale, 0, 2 * Math.PI);
          draw.fill();
          draw.fillStyle = style.getPropertyValue('--cds-text-primary') || '#161616';
          draw.font = `${12 * scale}px ${style.fontFamily}`;
          draw.textBaseline = 'middle';
          draw.fillText(cell.name, (x + 22) * scale, (y + 12) * scale, (width - 30) * scale);
          draw.drawImage(
            image,
            x * scale,
            (y + captionHeight) * scale,
            width * scale,
            height * scale,
          );
        }
      } finally {
        renderer.destroy();
      }
    } finally {
      stage.remove();
    }
    return canvas.toDataURL('image/png');
  }
  get mountedCount() {
    return this.slots.size;
  }
  resize() {
    for (const slot of this.slots.values()) slot.mounted?.renderer.resize();
  }
  destroy() {
    this.destroyed = true;
    for (const slot of this.slots.values()) cancelPanel(slot.owner);
    this.grid?.destroy();
    this.carousel?.destroy();
    for (const mounted of this.pool) mounted.renderer.destroy();
    this.pool = [];
  }
}
