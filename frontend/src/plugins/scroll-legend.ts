import { seriesLabel } from './series-label';
import type { PanelContext } from '../types';
type Item = { name: string; color: string; runIds: string[]; title?: string };
export function scrollLegend(
  element: HTMLElement,
  toggle: (name: string) => void,
  hover: (ids: string[]) => void,
) {
  const viewport = document.createElement('div'),
    track = document.createElement('div');
  viewport.className = 'chart-legend';
  viewport.setAttribute('role', 'group');
  track.className = 'chart-legend-track';
  viewport.append(track);
  element.append(viewport);
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.canvas.width = measure.canvas.height = 0;
  measure.font = '12px IBM Plex Sans';
  let items: Item[] = [],
    selected: Record<string, boolean> = {},
    vertical = false,
    ownsHover = false,
    focusIndex = 0,
    hoverIndex = 0,
    positions: number[] = [0],
    drag: { x: number; scroll: number; id: number } | undefined,
    dragged = false;
  const nodes = new Map<number, HTMLButtonElement>();
  const touch = matchMedia('(pointer: coarse)');
  const height = () => (touch.matches ? 44 : 28);
  function layout() {
    positions = [0];
    for (const item of items)
      positions.push(
        positions.at(-1)! +
          (vertical
            ? height()
            : Math.max(
                64,
                Math.min(
                  Math.max(180, viewport.clientWidth * 0.6),
                  Math.ceil(measure.measureText(item.name).width) + 38,
                ),
              )),
      );
  }
  function at(offset: number) {
    let lo = 0,
      hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (positions[mid + 1] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(items.length - 1, lo);
  }
  function render() {
    const offset = vertical ? viewport.scrollTop : viewport.scrollLeft,
      available = vertical ? viewport.clientHeight : viewport.clientWidth;
    const first = Math.max(0, at(offset) - 1),
      last = Math.min(items.length, at(offset + available) + 2);
    viewport.dataset.before = String(offset > 2);
    viewport.dataset.after = String(offset + available < positions.at(-1)! - 2);
    track.style.width = vertical ? '100%' : positions.at(-1) + 'px';
    track.style.height = vertical ? positions.at(-1) + 'px' : height() + 'px';
    let restoreFocus = false;
    for (const [index, node] of nodes)
      if (index < first || index >= last) {
        restoreFocus ||= document.activeElement === node;
        node.remove();
        nodes.delete(index);
      }
    if (focusIndex < first || focusIndex >= last) focusIndex = Math.max(0, at(offset));
    for (let index = first; index < last; index++) {
      let button = nodes.get(index);
      const item = items[index];
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'chart-legend-item';
        const marker = document.createElement('span'),
          label = document.createElement('span');
        marker.className = 'chart-legend-marker';
        label.className = 'chart-legend-label';
        button.append(marker, label);
        button.onclick = (event) => {
          if (dragged) {
            event.preventDefault();
            return;
          }
          toggle(items[index].name);
        };
        const highlight = () => {
          ownsHover = true;
          hoverIndex = index;
          hover(selected[items[index].name] === false ? [] : items[index].runIds);
        };
        button.onpointerenter = highlight;
        button.onpointerleave = () => {
          ownsHover = false;
          hover([]);
        };
        button.onfocus = () => {
          focusIndex = index;
          for (const [i, node] of nodes) node.tabIndex = i === index ? 0 : -1;
          highlight();
        };
        button.onblur = () => {
          ownsHover = false;
          hover([]);
        };
        button.onkeydown = (event) => {
          if (
            !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
          )
            return;
          event.preventDefault();
          focusIndex = Math.max(
            0,
            Math.min(
              items.length - 1,
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1),
            ),
          );
          const start = positions[focusIndex],
            end = positions[focusIndex + 1],
            offset = vertical ? viewport.scrollTop : viewport.scrollLeft,
            available = vertical ? viewport.clientHeight : viewport.clientWidth;
          if (start < offset || end > offset + available) {
            const next = start < offset ? start : end - available;
            if (vertical) viewport.scrollTop = next;
            else viewport.scrollLeft = next;
          }
          const next = focusIndex;
          render();
          nodes.get(next)?.focus({ preventScroll: true });
        };
        const nextNode = [...nodes.entries()]
          .filter(([i]) => i > index)
          .sort(([a], [b]) => a - b)[0]?.[1];
        nodes.set(index, button);
        track.insertBefore(button, nextNode || null);
      }
      button.tabIndex = index === focusIndex ? 0 : -1;
      button.style.left = vertical ? '0' : positions[index] + 'px';
      button.style.top = vertical ? positions[index] + 'px' : '0';
      button.style.width = vertical ? '100%' : positions[index + 1] - positions[index] + 'px';
      button.title = item.title || item.name;
      button.setAttribute('aria-label', item.name);
      button.setAttribute('aria-pressed', String(selected[item.name] !== false));
      button.children[0].setAttribute('style', 'background:' + item.color);
      seriesLabel(button.children[1] as HTMLElement, item.name);
      if (item.title) (button.children[1] as HTMLElement).title = item.title;
    }
    if (restoreFocus) nodes.get(Math.max(0, at(offset)))?.focus({ preventScroll: true });
  }
  viewport.onscroll = render;
  viewport.onpointerdown = (event) => {
    dragged = false;
    if (!vertical && event.pointerType === 'mouse' && event.button === 0)
      drag = { x: event.clientX, scroll: viewport.scrollLeft, id: event.pointerId };
  };
  viewport.onpointermove = (event) => {
    if (!drag) return;
    if (Math.abs(event.clientX - drag.x) > 4) {
      dragged = true;
      viewport.setPointerCapture(drag.id);
      viewport.scrollLeft = drag.scroll - (event.clientX - drag.x);
    }
  };
  viewport.onpointerup = () => {
    drag = undefined;
    setTimeout(() => (dragged = false), 0);
  };
  viewport.onpointercancel = () => {
    drag = undefined;
  };
  viewport.onpointerleave = () => {
    if (!dragged) drag = undefined;
  };
  return {
    update(ctx: PanelContext, next: Item[], selection: Record<string, boolean>) {
      items = next;
      selected = selection;
      const position = ctx.panel.settings?.legendPosition || 'top';
      vertical = ['left', 'right'].includes(position);
      viewport.dataset.position = position;
      if (['top', 'left'].includes(position)) {
        if (element.firstChild !== viewport) element.prepend(viewport);
      } else if (element.lastChild !== viewport) element.append(viewport);
      viewport.hidden = ctx.panel.settings?.legend === false || !items.length;
      viewport.setAttribute('aria-label', ctx.translate('charts.legend.label'));
      layout();
      render();
    },
    selection(value: Record<string, boolean>) {
      selected = value;
      if (ownsHover && items[hoverIndex])
        hover(selected[items[hoverIndex].name] === false ? [] : items[hoverIndex].runIds);
      render();
    },
    resize() {
      layout();
      render();
    },
    shownNames() {
      const offset = vertical ? viewport.scrollTop : viewport.scrollLeft,
        available = vertical ? viewport.clientHeight : viewport.clientWidth;
      return items
        .slice(Math.max(0, at(offset)), at(offset + available) + 1)
        .map((item) => item.name);
    },
    destroy() {
      measure.canvas.width = measure.canvas.height = 0;
      if (ownsHover) hover([]);
      nodes.clear();
      viewport.remove();
    },
  };
}
