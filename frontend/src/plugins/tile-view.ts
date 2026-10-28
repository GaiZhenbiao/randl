// Virtualized, reflowing grids of tiles: chart cells in the host, media tiles in the media
// plugin. Item size fixes the tile width; the column count follows the available width, as
// in Finder's icon view. Only rows that intersect the viewport, plus one row above and below,
// are mounted; the rest are space of their computed height, so the scrollbar stays accurate.

export const tileGap = 8;

/** Columns that fit `size`-wide tiles, and the tile width that fills the row. */
export function gridGeometry(contentWidth: number, size: number, gap = tileGap) {
  const columns = Math.max(1, Math.floor((contentWidth + gap) / (size + gap)));
  return { columns, width: Math.max(1, (contentWidth - (columns - 1) * gap) / columns) };
}
export type TileRow = {
  top: number;
  height: number;
  /** Tiles `start` to `end - 1`; a header row has none. */
  start: number;
  end: number;
  /** A header row introducing the tiles of a group. */
  header?: string;
};
/**
 * Rows of up to `columns` tiles. A tile row is as tall as its tallest tile. When `group`
 * names groups, each group starts a new row after a header row of `headerHeight`.
 */
export function layoutRows(
  count: number,
  columns: number,
  height: (index: number) => number,
  group?: (index: number) => string,
  headerHeight = 0,
  gap = tileGap,
) {
  const rows: TileRow[] = [];
  let top = 0;
  const push = (row: Omit<TileRow, 'top'>) => {
    rows.push({ ...row, top });
    top += row.height + gap;
  };
  for (let start = 0; start < count;) {
    const name = group?.(start);
    if (group && (start === 0 || group(start - 1) !== name))
      push({ start, end: start, height: headerHeight, header: name });
    let end = start + 1;
    while (end < count && end - start < columns && (!group || group(end) === name)) end++;
    let tallest = 0;
    for (let index = start; index < end; index++) tallest = Math.max(tallest, height(index));
    push({ start, end, height: tallest });
    start = end;
  }
  return { rows, total: Math.max(0, top - gap) };
}
/** The rows to mount for a viewport: those it intersects, plus `overscan` on each side. */
export function windowRows(rows: TileRow[], scrollTop: number, viewport: number, overscan = 1) {
  let low = 0,
    high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].top + rows[middle].height <= scrollTop) low = middle + 1;
    else high = middle;
  }
  let last = low;
  while (last < rows.length && rows[last].top < scrollTop + viewport) last++;
  return [Math.max(0, low - overscan), Math.min(rows.length, last + overscan)] as const;
}
/**
 * The tile width to use so that a viewport's rows, with overscan, mount at most `cap` tiles:
 * small sizes on wide panels grow until they fit. `height` gives a tile's height for a width.
 */
export function fitSize(
  contentWidth: number,
  viewport: number,
  size: number,
  cap: number,
  height: (width: number) => number,
  gap = tileGap,
) {
  for (let next = size; ; next += 8) {
    const { columns, width } = gridGeometry(contentWidth, next, gap);
    const rows = Math.ceil(viewport / (height(width) + gap)) + 1 + 2;
    if (rows * columns <= cap || columns === 1) return next;
  }
}
/** The tile a navigation key moves to, or undefined when the key does not navigate. */
export function moveIndex(
  index: number,
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>,
  rows: TileRow[],
  pageRows: number,
) {
  const tiles = rows.filter((row) => row.end > row.start),
    current = Math.max(
      0,
      tiles.findIndex((row) => index >= row.start && index < row.end),
    ),
    row = tiles[current];
  if (!row) return;
  const column = index - row.start,
    count = tiles.at(-1)!.end,
    ctrl = event.ctrlKey || event.metaKey,
    at = (target: number) => {
      const next = tiles[Math.max(0, Math.min(tiles.length - 1, target))];
      return Math.min(next.start + column, next.end - 1);
    };
  switch (event.key) {
    case 'ArrowLeft':
      return Math.max(row.start, index - 1);
    case 'ArrowRight':
      return Math.min(row.end - 1, index + 1);
    case 'ArrowUp':
      return at(current - 1);
    case 'ArrowDown':
      return at(current + 1);
    case 'Home':
      return ctrl ? 0 : row.start;
    case 'End':
      return ctrl ? count - 1 : row.end - 1;
    case 'PageUp':
      return at(current - Math.max(1, pageRows));
    case 'PageDown':
      return at(current + Math.max(1, pageRows));
  }
}

const rowKey = (row: TileRow | undefined) =>
  row ? [row.top, row.height, row.start, row.end, row.header].join(':') : '';
export type TileLayout = {
  count: number;
  /** Requested tile width in CSS pixels. */
  size: number;
  /** Narrowest tile width; a smaller size uses it. */
  minSize?: number;
  /** Most tiles mounted at once; small sizes grow to stay within it. */
  cap: number;
  /** Tile height for a tile width. */
  height: (index: number, width: number) => number;
  group?: (index: number) => string;
  headerHeight?: number;
};
export type TileHooks = {
  /** Fills a gridcell for tile `index`. */
  mount: (index: number, cell: HTMLElement, width: number) => void;
  /** Releases what `mount` created; the cell element is then removed. */
  unmount: (index: number, cell: HTMLElement) => void;
  /** Fills a header row. */
  header?: (row: TileRow, element: HTMLElement) => void;
  /** After each pass that mounted or unmounted tiles. */
  settled?: () => void;
  /** Keys other than navigation while a tile has focus; return true when handled. */
  key?: (event: KeyboardEvent, index: number) => boolean;
  /** The tile with keyboard focus changed. */
  focus?: (index: number) => void;
  /** A tile to keep in view when the column count or tile width changes. */
  anchor?: () => number | undefined;
};
/**
 * A virtualized ARIA grid inside `host`. The tile with keyboard focus (a roving tabindex)
 * stays mounted while focus is inside it, even when scrolled out of view.
 */
export class TileGrid {
  readonly scroller = document.createElement('div');
  readonly grid = document.createElement('div');
  private rows: TileRow[] = [];
  private mounted = new Map<number, HTMLElement>();
  private layoutState: TileLayout | undefined;
  private width = 0;
  private columns = 1;
  private frame = 0;
  private observer: ResizeObserver;
  /** A layout pass waits while an element of the grid is full screen. */
  private deferred: boolean | undefined;
  private thaw = 0;
  /** The grid's content width at the last layout. */
  private content = 0;
  focusIndex = 0;
  /** The tile width in use, after `minSize` and the mount cap. */
  effectiveSize = 0;
  constructor(
    host: HTMLElement,
    private hooks: TileHooks,
    label: string,
  ) {
    this.scroller.className = 'tile-scroller';
    this.grid.className = 'tile-grid';
    this.grid.setAttribute('role', 'grid');
    this.grid.setAttribute('aria-label', label);
    this.scroller.append(this.grid);
    host.append(this.scroller);
    this.scroller.addEventListener('scroll', this.schedule, { passive: true });
    this.grid.addEventListener('keydown', this.keydown);
    this.grid.addEventListener('focusin', this.focusin);
    this.observer = new ResizeObserver(() => this.relayout());
    // The grid's width excludes its margins and the scrollbar.
    this.observer.observe(this.grid);
    this.observer.observe(this.scroller);
    document.addEventListener('fullscreenchange', this.fullscreen);
  }
  // A full-screen video resizes the window, which would reflow the grid and remove the tile
  // that holds it, ending full screen. The grid keeps its layout until full screen ends and
  // the window has its earlier size again, so the tiles stay. The resize usually follows the
  // end of full screen, through the resize observer; a timer catches a resize that never comes.
  private get frozen() {
    const element = document.fullscreenElement;
    return !!element && this.grid.contains(element);
  }
  private fullscreen = () => {
    if (this.deferred === undefined || this.frozen) return;
    clearTimeout(this.thaw);
    this.thaw = window.setTimeout(
      () => {
        if (this.deferred !== undefined) this.relayout();
      },
      this.grid.clientWidth === this.content ? 0 : 1000,
    );
  };
  get tileWidth() {
    return this.width;
  }
  get columnCount() {
    return this.columns;
  }
  set label(value: string) {
    this.grid.setAttribute('aria-label', value);
  }
  /** Mounted tile cells by index. */
  get cells(): ReadonlyMap<number, HTMLElement> {
    return this.mounted;
  }
  /** Lays the tiles out; `rebuild` remounts the tiles in view, as when their content changed. */
  layout(next: TileLayout, rebuild = false) {
    this.layoutState = next;
    this.relayout(rebuild);
  }
  private relayout(rebuild = false) {
    const state = this.layoutState;
    if (!state) return;
    if (this.frozen) {
      this.deferred = rebuild || !!this.deferred;
      return;
    }
    if (this.deferred !== undefined) {
      rebuild ||= this.deferred;
      this.deferred = undefined;
      clearTimeout(this.thaw);
    }
    const content = this.grid.clientWidth,
      viewport = this.scroller.clientHeight;
    if (!content) return;
    this.content = content;
    const size = fitSize(
      content,
      viewport,
      Math.max(state.size, state.minSize ?? 0),
      state.cap,
      (w) => state.height(0, w),
    );
    const { columns, width } = gridGeometry(content, size);
    const changed = columns !== this.columns || Math.abs(width - this.width) > 0.5;
    this.effectiveSize = size;
    this.columns = columns;
    this.width = width;
    const { rows, total } = layoutRows(
      state.count,
      columns,
      (index) => state.height(index, width),
      state.group,
      state.headerHeight,
    );
    const anchor = changed ? this.hooks.anchor?.() : undefined;
    this.rows = rows;
    this.grid.style.height = total + 'px';
    if (anchor !== undefined) this.reveal(anchor);
    this.grid.setAttribute('aria-rowcount', String(rows.length));
    this.grid.setAttribute('aria-colcount', String(columns));
    this.focusIndex = Math.min(this.focusIndex, Math.max(0, state.count - 1));
    // A new column count or width rebuilds the mounted rows.
    this.render(rebuild || changed || this.mounted.size === 0);
  }
  private schedule = () => {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render(false));
  };
  /** Mounts the rows in the window, and the focused tile's row while focus is inside it. */
  render(rebuild: boolean) {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.frozen) {
      this.deferred = rebuild || !!this.deferred;
      return;
    }
    const [first, last] = windowRows(
      this.rows,
      this.scroller.scrollTop,
      this.scroller.clientHeight,
    );
    const wanted = new Set<number>();
    for (let index = first; index < last; index++) wanted.add(index);
    const focusRow = this.rows.findIndex(
        (row) => this.focusIndex >= row.start && this.focusIndex < row.end,
      ),
      focused = this.grid.contains(document.activeElement);
    if (focusRow >= 0 && focused) wanted.add(focusRow);
    let changed = false;
    for (const element of [...this.grid.children] as HTMLElement[]) {
      const index = Number(element.dataset.row);
      if (!rebuild && wanted.has(index) && element.dataset.key === rowKey(this.rows[index])) {
        wanted.delete(index);
        continue;
      }
      this.removeRow(element);
      changed = true;
    }
    for (const index of [...wanted].sort((a, b) => a - b)) {
      this.addRow(index);
      changed = true;
    }
    // A rebuilt tile takes back the keyboard focus its predecessor had.
    if (focused && !this.grid.contains(document.activeElement))
      this.mounted.get(this.focusIndex)?.focus({ preventScroll: true });
    if (changed) this.hooks.settled?.();
  }
  private addRow(index: number) {
    const row = this.rows[index],
      element = document.createElement('div');
    element.className = row.header === undefined ? 'tile-row' : 'tile-row tile-header';
    element.setAttribute('role', 'row');
    element.setAttribute('aria-rowindex', String(index + 1));
    element.dataset.row = String(index);
    element.dataset.key = rowKey(row);
    element.style.cssText = `top:${row.top}px;height:${row.height}px`;
    // Tiles mount into the document, so renderers can measure themselves.
    this.grid.append(element);
    if (row.header !== undefined) {
      const cell = document.createElement('div');
      cell.setAttribute('role', 'rowheader');
      cell.setAttribute('aria-colspan', String(this.columns));
      element.append(cell);
      this.hooks.header?.(row, cell);
    } else
      for (let tile = row.start; tile < row.end; tile++) {
        const cell = document.createElement('div');
        cell.className = 'tile-cell';
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-colindex', String(tile - row.start + 1));
        cell.tabIndex = tile === this.focusIndex ? 0 : -1;
        cell.dataset.index = String(tile);
        cell.style.width = this.width + 'px';
        element.append(cell);
        this.mounted.set(tile, cell);
        this.hooks.mount(tile, cell, this.width);
      }
  }
  private removeRow(element: HTMLElement) {
    for (const cell of element.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      const index = Number(cell.dataset.index);
      this.hooks.unmount(index, cell);
      this.mounted.delete(index);
    }
    element.remove();
  }
  /** Moves keyboard focus to tile `index`, mounting and scrolling it into view first. */
  focusTile(index: number) {
    const state = this.layoutState;
    if (!state || index < 0 || index >= state.count) return;
    this.focusIndex = index;
    for (const [tile, cell] of this.mounted) cell.tabIndex = tile === index ? 0 : -1;
    this.reveal(index);
    this.render(false);
    this.mounted.get(index)?.focus({ preventScroll: true });
    this.hooks.focus?.(index);
  }
  /** Scrolls the least that brings tile `index`'s row into view. */
  private reveal(index: number) {
    const row = this.rows.find((item) => index >= item.start && index < item.end);
    if (!row) return;
    const top = this.scroller.scrollTop,
      bottom = top + this.scroller.clientHeight;
    if (row.top < top) this.scroller.scrollTop = row.top;
    else if (row.top + row.height > bottom)
      this.scroller.scrollTop = row.top + row.height - this.scroller.clientHeight;
  }
  private focusin = (event: FocusEvent) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[role="gridcell"]');
    if (!cell || Number(cell.dataset.index) === this.focusIndex) return;
    this.focusIndex = Number(cell.dataset.index);
    for (const [tile, item] of this.mounted) item.tabIndex = tile === this.focusIndex ? 0 : -1;
    this.hooks.focus?.(this.focusIndex);
  };
  private keydown = (event: KeyboardEvent) => {
    const cell = event.target as HTMLElement;
    if (cell.getAttribute('role') !== 'gridcell') return;
    const index = Number(cell.dataset.index);
    if (this.hooks.key?.(event, index)) {
      event.preventDefault();
      return;
    }
    const tileRows = this.rows.filter((row) => row.end > row.start),
      pageRows = Math.max(
        1,
        Math.floor(this.scroller.clientHeight / ((tileRows[0]?.height ?? 1) + tileGap)),
      ),
      next = moveIndex(index, event, this.rows, pageRows);
    if (next === undefined) return;
    event.preventDefault();
    this.focusTile(next);
  };
  destroy() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.thaw);
    this.observer.disconnect();
    document.removeEventListener('fullscreenchange', this.fullscreen);
    this.scroller.removeEventListener('scroll', this.schedule);
    for (const element of [...this.grid.children] as HTMLElement[]) this.removeRow(element);
    this.scroller.remove();
  }
}

export type CarouselHooks = {
  /** Fills the current item. */
  stage: (index: number, element: HTMLElement) => void;
  /** Releases what `stage` created before the element shows a preview or is removed. */
  release: (index: number, element: HTMLElement) => void;
  /** Fills a neighbor's preview; previews are decorative duplicates of the current item. */
  peek: (index: number, element: HTMLElement) => void;
  /** Releases what `peek` created before the element is emptied or removed. */
  unpeek?: (index: number, element: HTMLElement) => void;
  /** An item's name, for the current item's accessible name. */
  name: (index: number) => string;
  /** The current item changed. */
  change?: (index: number) => void;
  /** Width over height of an item's content; without one, the item fills the stage height. */
  aspect?: (index: number) => number | undefined;
  /**
   * The tabs of the strip below the stage. Without them the strip lists the items, with an
   * "N of M" count; either way it shows only with two or more tabs.
   */
  tabs?: CarouselTabs;
  /** Fills an item's tab when the strip lists the items. */
  chip?: (index: number, element: HTMLElement) => void;
};
/** Tabs that choose what the carousel's items are, such as the run whose files it shows. */
export type CarouselTabs = {
  count: () => number;
  selected: () => number;
  fill: (index: number, element: HTMLElement) => void;
  name: (index: number) => string;
  select: (index: number) => void;
};
export type CarouselText = {
  label: string;
  carousel: string;
  slide: string;
  previous: string;
  next: string;
  /** "{index} of {count}" for an item. */
  position: (index: number, count: number) => string;
};
/** Chips around the current one that the strip mounts; the rest are spacing. */
const chipWindow = 30;
let carouselIds = 0;
/**
 * An item's box and place in the stage, in CSS pixels and degrees. The box (`left`, `top`,
 * `width`, `height`) is the size the item has when current, standing on the floor. The item
 * is then moved by `x` and `z` and turned by `rotate` about its vertical axis, seen from
 * `perspective` pixels in front of the vanishing point, which is the stage's horizontal
 * middle on the floor, `originY` below the box's top.
 */
export type FlowItem = {
  left: number;
  top: number;
  width: number;
  height: number;
  originY: number;
  x: number;
  z: number;
  rotate: number;
  scale: number;
  /** Stacking: 0 for the current item, one less for each step outward. */
  order: number;
  perspective: number;
  /** Placed beyond the shown neighbors, so moving slides it in or out. */
  hidden: boolean;
};
/**
 * The neighbors' turn toward the current item; the gap between the current item and its
 * first neighbors and the step between later neighbors, as shares of the current item's
 * height; the viewer's distance as a multiple of the stage width, far enough that turned
 * items narrow more than they shrink, as in Apple's Cover Flow; the neighbors' size in the
 * flat (reduced-motion) layout; and the least width of a neighbor that shows, in pixels, which
 * is also the least step between neighbors, so a short stage does not stack them ever closer.
 */
const flowAngle = 70,
  flowGap = 0.08,
  flowStep = 0.16,
  flowDistance = 3,
  flatScale = 0.84,
  flowSliver = 12;
/** The moving transition's length; style.css uses the same. */
const flowDuration = 420;
/**
 * The most items `flowLayout` places on each side of the current one in a `width` stage: its
 * neighbors step outward by at least `flowSliver` from the current item's edge and stop at
 * the stage's edge, plus the hidden one beyond them. A 3200 px stage places at most 135.
 */
export const flowBound = (width: number) => Math.ceil(width / 2 / flowSliver) + 1;
/**
 * Cover Flow geometry for the items around `index` in a `width` × `height` stage, as in
 * Apple's Cover Flow: every item's box is the size it has when current, the largest that fits
 * the stage above `footer` at its aspect (the whole stage without one), and all stand on one
 * floor. The current item faces the viewer. Its neighbors keep their size, are turned toward
 * it and pushed back so their outer edges stay in its plane, and stack outward tightly, each
 * mostly hidden by the one nearer the middle, after a gap beside the current item. As many
 * neighbors show on each side as the width the current item leaves holds, possibly none, plus
 * one hidden beyond them so moving slides it in or out; the rest are not placed. With `flat`
 * (reduced motion) the neighbors stand smaller, side by side. Each neighbor moves the next at
 * least `flowSliver` outward (16 px flat), so a side never places more than `flowBound(width)`.
 */
export function flowLayout(
  width: number,
  height: number,
  index: number,
  count: number,
  aspect: (index: number) => number | undefined,
  footer = 0,
  flat = false,
) {
  const room = Math.max(1, height - footer),
    box = (item: number) => {
      const ratio = aspect(item),
        widest = Math.max(1, width);
      if (!ratio) return { width: widest, height: room };
      const fitted = Math.min(widest, room * ratio);
      return { width: fitted, height: fitted / ratio };
    },
    items = new Map<number, FlowItem>(),
    center = box(index),
    perspective = Math.round(flowDistance * width),
    half = width / 2,
    turn = (flowAngle * Math.PI) / 180,
    place = (own: { width: number; height: number }, rest: Partial<FlowItem>): FlowItem => ({
      ...own,
      left: half - own.width / 2,
      top: 0,
      originY: own.height,
      x: 0,
      z: 0,
      rotate: 0,
      scale: 1,
      order: 0,
      perspective,
      hidden: false,
      ...rest,
    });
  items.set(index, place(center, {}));
  for (const direction of [-1, 1]) {
    // The projected distance of the next neighbor's inner edge from the middle.
    let inner = center.width / 2 + Math.max(8, center.height * flowGap),
      hidden = false;
    for (let step = 1; ; step++) {
      const item = index + direction * step;
      if (item < 0 || item >= count) break;
      const own = box(item),
        order = -step;
      // A neighbor shows when some of it is inside the stage and not behind a nearer one;
      // the first that does not is placed hidden, and the rest are not placed.
      hidden ||= inner > half - flowSliver;
      if (flat) {
        const shown = own.width * flatScale;
        items.set(
          item,
          place(own, { x: direction * (inner + shown / 2), scale: flatScale, order, hidden }),
        );
        if (hidden) break;
        inner += shown + 16;
        continue;
      }
      // Turned about its middle and pushed back by half its depth, the outer edge stays in
      // the current item's plane and the inner edge recedes by `depth`.
      const reach = own.width / 2,
        depth = 2 * reach * Math.sin(turn),
        x = reach * Math.cos(turn) + (inner * (perspective + depth)) / perspective;
      items.set(
        item,
        place(own, {
          x: direction * x,
          z: -depth / 2,
          rotate: -direction * flowAngle,
          order,
          hidden,
        }),
      );
      if (hidden) break;
      // Neighbors behind one whose outer edge reaches the stage's edge are not shown.
      hidden = x + reach * Math.cos(turn) >= half;
      inner += Math.max(flowSliver, center.height * flowStep);
    }
  }
  // The floor centers the tallest shown item in the room. The vanishing point is on the
  // floor, so every bottom edge stays on it at any depth.
  let tallest = 0;
  for (const item of items.values()) if (!item.hidden) tallest = Math.max(tallest, item.height);
  const floor = (room + tallest) / 2;
  for (const item of items.values()) item.top = floor - item.height;
  return items;
}
/**
 * A Cover Flow carousel of one item at a time (WAI-ARIA carousel): the current item large in
 * the middle, its neighbors turned in 3D and partly hidden on each side, previous and next
 * buttons, and below a tab list of the items or of `tabs` that choose the items. Items keep
 * their element while they are shown, so moving animates them into place with transforms
 * only. It never rotates by itself. Left and Right on the current item move one item, Home and
 * End to the ends, a click on a neighbor shows it, and a horizontal swipe on the stage moves
 * one item; on the tab list the same keys move between tabs.
 */
export class Carousel {
  readonly region = document.createElement('div');
  private stage = document.createElement('div');
  private items = new Map<number, HTMLElement>();
  private strip = document.createElement('div');
  private chipScroller = document.createElement('div');
  private chips = document.createElement('div');
  private counter = document.createElement('span');
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private count = 0;
  private stageShows = -1;
  private observer: ResizeObserver;
  private swipe: { x: number; y: number; id: number } | undefined;
  private icons: (() => void)[] = [];
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private frame = 0;
  /** Drops the current item's transform once it has turned to face the viewer. */
  private settle = 0;
  index = 0;
  constructor(
    host: HTMLElement,
    private hooks: CarouselHooks,
    private text: CarouselText,
    private options: {
      chipWidth: number;
      /** Height below the current item's content, for its caption. */
      footer?: number;
      /** Draws the previous or next icon into a button; returns its disposer. */
      icon: (button: HTMLElement, next: boolean) => () => void;
    },
  ) {
    this.region.className = 'carousel';
    this.region.setAttribute('role', 'region');
    this.region.setAttribute('aria-roledescription', text.carousel);
    this.region.setAttribute('aria-label', text.label);
    this.stage.className = 'carousel-stage carousel-instant';
    this.previous = this.button(false);
    this.next = this.button(true);
    this.stage.append(this.previous, this.next);
    this.strip.className = 'carousel-strip';
    this.chipScroller.className = 'carousel-chip-scroller';
    this.chipScroller.append(this.chips);
    this.chips.className = 'carousel-chips';
    this.chips.setAttribute('role', 'tablist');
    this.chips.setAttribute('aria-label', text.label);
    this.stage.id = 'carousel-' + ++carouselIds;
    this.counter.className = 'carousel-counter';
    this.strip.append(this.chipScroller, this.counter);
    this.region.append(this.stage, this.strip);
    host.append(this.region);
    this.region.addEventListener('keydown', this.keydown);
    this.stage.addEventListener('pointerdown', this.pointerdown);
    this.stage.addEventListener('pointerup', this.pointerup);
    this.stage.addEventListener('pointercancel', () => (this.swipe = undefined));
    // A new stage size places the items without animating them.
    this.observer = new ResizeObserver(() => this.render(false, true));
    this.observer.observe(this.stage);
    this.reduced.addEventListener('change', this.motion);
  }
  private motion = () => this.render(false, true);
  private button(next: boolean) {
    const button = document.createElement('button'),
      label = next ? this.text.next : this.text.previous;
    button.type = 'button';
    button.className = 'carousel-move bx--btn bx--btn--ghost bx--btn--icon-only';
    button.classList.add(next ? 'carousel-next' : 'carousel-previous');
    button.setAttribute('aria-label', label);
    button.title = label;
    this.icons.push(this.options.icon(button, next));
    button.onclick = () => this.go(this.index + (next ? 1 : -1));
    return button;
  }
  /** Shows `count` items at `index`; `refresh` redraws the current item's content. */
  set(count: number, index: number, refresh = false) {
    this.count = count;
    this.index = Math.max(0, Math.min(count - 1, index));
    this.render(refresh);
  }
  go(index: number) {
    const next = Math.max(0, Math.min(this.count - 1, index));
    if (next === this.index) return;
    this.index = next;
    this.render(false);
    this.hooks.change?.(next);
  }
  /** Places the items again, as when an item's aspect became known; they move there. */
  layout() {
    this.render(false);
  }
  private item(index: number) {
    let element = this.items.get(index);
    if (!element) {
      element = document.createElement('div');
      element.className = 'carousel-item';
      element.dataset.index = String(index);
      element.onclick = () => {
        if (index !== this.index) this.go(index);
      };
      this.items.set(index, element);
      this.previous.before(element);
    }
    return element;
  }
  private render(refresh: boolean, instant = false) {
    const width = this.stage.clientWidth,
      height = this.stage.clientHeight,
      flat = this.reduced.matches,
      focused =
        this.stageShows >= 0 && this.items.get(this.stageShows)?.contains(document.activeElement);
    this.previous.disabled = this.index <= 0;
    this.next.disabled = this.index >= this.count - 1;
    const layout = this.count
      ? flowLayout(
          width,
          height,
          this.index,
          this.count,
          (index) => this.hooks.aspect?.(index),
          this.options.footer,
          flat,
        )
      : new Map<number, FlowItem>();
    // A new stage size or motion preference places the items without animating them. Other
    // renders, including those for an aspect learned while the items move, retarget the
    // running transitions, so moving always animates.
    if (instant) {
      this.stage.classList.add('carousel-instant');
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() =>
        requestAnimationFrame(() => this.stage.classList.remove('carousel-instant')),
      );
    }
    // Items moving out of the window are removed; the current item's content moves aside as
    // a preview, and the new current item gets its live content.
    for (const [index, element] of this.items)
      if (!layout.has(index)) {
        if (index === this.stageShows) {
          this.hooks.release(index, element);
          this.stageShows = -1;
        } else this.hooks.unpeek?.(index, element);
        element.remove();
        this.items.delete(index);
      }
    if (this.stageShows !== this.index || refresh) {
      const old = this.items.get(this.stageShows);
      if (old) {
        this.hooks.release(this.stageShows, old);
        old.replaceChildren();
      }
      this.stageShows = -1;
    }
    const fresh: HTMLElement[] = [],
      still = instant || flat;
    for (const [index, place] of layout) {
      const added = !this.items.has(index),
        element = this.item(index),
        current = index === this.index;
      if (current && this.stageShows !== index) {
        if (element.firstChild) this.hooks.unpeek?.(index, element);
        element.replaceChildren();
        this.stageShows = index;
        this.hooks.stage(index, element);
      } else if (!current && (added || refresh || !element.firstChild)) {
        // New neighbors, the item that was current, and every neighbor after new data.
        if (element.firstChild) this.hooks.unpeek?.(index, element);
        element.replaceChildren();
        this.hooks.peek(index, element);
      }
      element.classList.toggle('carousel-slide', current);
      element.classList.toggle('carousel-peek', !current);
      element.dataset.side = place.x < 0 ? 'left' : place.x > 0 ? 'right' : '';
      if (current) {
        element.setAttribute('role', 'group');
        element.setAttribute('aria-roledescription', this.text.slide);
        element.setAttribute(
          'aria-label',
          this.text.position(index + 1, this.count) + ': ' + this.hooks.name(index),
        );
        element.removeAttribute('aria-hidden');
        element.tabIndex = 0;
      } else {
        for (const name of ['role', 'aria-roledescription', 'aria-label', 'tabindex'])
          element.removeAttribute(name);
        element.setAttribute('aria-hidden', 'true');
      }
      // The box is the item's content alone; the current item's footer hangs below it.
      element.style.width = place.width + 'px';
      element.style.height = place.height + 'px';
      element.style.left = place.left + 'px';
      element.style.top = place.top + 'px';
      element.style.transformOrigin = `50% ${place.originY}px`;
      element.style.zIndex = String(place.order);
      element.style.visibility = place.hidden ? 'hidden' : '';
      // The current item ends without a transform, so its content (a chart's popups, a
      // video's full screen) behaves as it would outside the carousel. While it turns to face
      // the viewer it keeps the neighbors' kind of transform, so the two interpolate alike.
      const settled = current && (still || added || element.style.transform === 'none');
      element.style.transform = settled
        ? 'none'
        : `perspective(${place.perspective}px) translate3d(${place.x}px, 0px, ${place.z}px) rotateY(${place.rotate}deg) scale(${place.scale})`;
      // A new neighbor fades in where it stands rather than flying in from the middle.
      if (added && !current && !still) {
        element.style.opacity = '0';
        fresh.push(element);
      }
    }
    if (fresh.length) {
      // The new neighbors' first style is transparent; then they fade in.
      void getComputedStyle(fresh[0]).opacity;
      for (const element of fresh) element.style.removeProperty('opacity');
    }
    clearTimeout(this.settle);
    const shown = this.items.get(this.index);
    if (shown && shown.style.transform !== 'none')
      this.settle = window.setTimeout(() => {
        if (this.items.get(this.index) !== shown) return;
        shown.style.transition = 'none';
        shown.style.transform = 'none';
        void getComputedStyle(shown).transform;
        shown.style.removeProperty('transition');
      }, flowDuration + 40);
    if (focused) this.items.get(this.index)?.focus({ preventScroll: true });
    this.renderStrip();
  }
  // The strip: the tabs, or the items with their count; hidden with fewer than two.
  private renderStrip() {
    const tabs = this.hooks.tabs,
      count = tabs ? tabs.count() : this.hooks.chip ? this.count : 0,
      selected = tabs ? tabs.selected() : this.index,
      first = Math.max(0, selected - chipWindow),
      last = Math.min(count, selected + chipWindow + 1),
      width = this.options.chipWidth;
    this.strip.hidden = count < 2;
    if (this.strip.hidden) this.stage.removeAttribute('role');
    else this.stage.setAttribute('role', 'tabpanel');
    this.chips.replaceChildren();
    this.chips.style.paddingLeft = first * width + 'px';
    this.chips.style.paddingRight = (count - last) * width + 'px';
    for (let index = first; index < last && count > 1; index++) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'carousel-chip';
      chip.id = this.stage.id + '-tab-' + index;
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(index === selected));
      chip.setAttribute('aria-controls', this.stage.id);
      chip.setAttribute('aria-label', (tabs?.name ?? this.hooks.name)(index));
      chip.tabIndex = index === selected ? 0 : -1;
      chip.style.width = width + 'px';
      chip.dataset.index = String(index);
      chip.onclick = () => this.choose(index);
      (tabs?.fill ?? this.hooks.chip)!(index, chip);
      this.chips.append(chip);
    }
    this.counter.hidden = !!tabs;
    this.counter.textContent =
      !tabs && count > 1 ? this.text.position(this.index + 1, this.count) : '';
    const current = this.chips.querySelector<HTMLElement>('[aria-selected="true"]');
    if (current) {
      this.stage.setAttribute('aria-labelledby', current.id);
      this.chipScroller.scrollLeft = Math.max(
        0,
        current.offsetLeft - this.chipScroller.clientWidth / 2 + width / 2,
      );
    } else this.stage.removeAttribute('aria-labelledby');
  }
  // A chosen tab keeps focus when the strip is drawn again.
  private choose(index: number) {
    const tabs = this.hooks.tabs,
      focused = this.chips.contains(document.activeElement);
    if (!tabs) this.go(index);
    else {
      const next = Math.max(0, Math.min(tabs.count() - 1, index));
      if (next !== tabs.selected()) tabs.select(next);
    }
    if (focused) this.chips.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }
  private keydown = (event: KeyboardEvent) => {
    // Content inside the current item, such as a chart's keyboard inspection, keeps its keys.
    const fromChip = (event.target as HTMLElement).getAttribute('role') === 'tab';
    if (!fromChip && event.target !== this.current) return;
    const tabs = fromChip ? this.hooks.tabs : undefined,
      at = tabs ? tabs.selected() : this.index,
      last = (tabs ? tabs.count() : this.count) - 1,
      next =
        event.key === 'ArrowLeft'
          ? at - 1
          : event.key === 'ArrowRight'
            ? at + 1
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? last
                : undefined;
    if (next === undefined) return;
    event.preventDefault();
    if (fromChip) this.choose(next);
    else this.go(next);
  };
  private pointerdown = (event: PointerEvent) => {
    if (event.pointerType === 'touch')
      this.swipe = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  // A horizontal swipe of more than 40 px, within 30° of horizontal, moves one item.
  private pointerup = (event: PointerEvent) => {
    const start = this.swipe;
    this.swipe = undefined;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (Math.abs(dx) > 40 && Math.abs(dy) <= Math.abs(dx) * Math.tan(Math.PI / 6))
      this.go(this.index + (dx < 0 ? 1 : -1));
  };
  /** The element showing the current item. */
  get current() {
    return this.items.get(this.index) ?? this.stage;
  }
  destroy() {
    this.observer.disconnect();
    this.reduced.removeEventListener('change', this.motion);
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settle);
    for (const [index, element] of this.items)
      if (index === this.stageShows) this.hooks.release(index, element);
      else this.hooks.unpeek?.(index, element);
    for (const dispose of this.icons) dispose();
    this.region.remove();
  }
}
