// Dragging across a plot selects an X range: a full-height band follows the pointer and
// releasing zooms the panel to it. A click without a drag resets a zoomed panel. Touch
// starts a selection with a long press, so a swipe still scrolls the page.
type Chart = {
  containPixel: (finder: { gridIndex: number }, point: number[]) => boolean;
  convertFromPixel: (finder: { xAxisIndex: number }, value: number) => unknown;
  getModel: () => any;
};
export type ZoomBrushOptions = {
  /** Whether this chart has a numeric X axis that can be zoomed now. */
  enabled: () => boolean;
  onZoom: (range: { xMin: number; xMax: number } | null) => void;
  /** Called when a drag begins, so hover popups and cursors can be hidden. */
  onStart: () => void;
};
/** Movement in CSS pixels below which a press and release is a click. */
export const minimumDrag = 5;
const longPress = 450,
  touchSlop = 8;
export function zoomBrush(
  element: HTMLElement,
  canvas: HTMLElement,
  chart: Chart,
  options: ZoomBrushOptions,
) {
  const band = document.createElement('div');
  band.className = 'chart-zoom-band';
  band.hidden = true;
  element.append(band);
  let start:
      | { pointerId: number; clientX: number; clientY: number; x: number; touch: boolean }
      | undefined,
    dragging = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const local = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const grid = (): { x: number; y: number; width: number; height: number } | undefined =>
    chart.getModel()?.getComponent('grid', 0)?.coordinateSystem?.getRect();
  function draw(x: number) {
    const rect = grid();
    if (!rect || !start) return;
    const offset = canvas.offsetTop,
      left = Math.max(rect.x, Math.min(start.x, x)),
      right = Math.min(rect.x + rect.width, Math.max(start.x, x));
    band.style.left = canvas.offsetLeft + left + 'px';
    band.style.width = Math.max(0, right - left) + 'px';
    band.style.top = offset + rect.y + 'px';
    band.style.height = rect.height + 'px';
    band.hidden = false;
  }
  function begin() {
    dragging = true;
    options.onStart();
    // Keep receiving the drag outside the plot; a pointer that already ended has none.
    try {
      if (start) canvas.setPointerCapture(start.pointerId);
    } catch {
      /* The selection still follows moves over the plot. */
    }
  }
  function reset() {
    clearTimeout(timer);
    timer = undefined;
    if (start && canvas.hasPointerCapture?.(start.pointerId))
      canvas.releasePointerCapture(start.pointerId);
    start = undefined;
    dragging = false;
    band.hidden = true;
  }
  function down(event: PointerEvent) {
    reset();
    if (!canvas.contains(event.target as Node)) return;
    if (!options.enabled() || event.button !== 0 || event.ctrlKey || event.metaKey) return;
    const point = local(event);
    if (!chart.containPixel({ gridIndex: 0 }, point)) return;
    const touch = event.pointerType === 'touch';
    start = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: point[0],
      touch,
    };
    if (touch)
      timer = setTimeout(() => {
        timer = undefined;
        begin();
        draw(start!.x);
      }, longPress);
  }
  function move(event: PointerEvent) {
    if (!start || event.pointerId !== start.pointerId) return;
    const dx = event.clientX - start.clientX,
      dy = event.clientY - start.clientY;
    if (start.touch && !dragging) {
      // Moving before the long press completes is a scroll or a tap, not a selection.
      if (Math.hypot(dx, dy) > touchSlop) reset();
      return;
    }
    if (!dragging && Math.abs(dx) >= minimumDrag) begin();
    if (!dragging) return;
    // Hover inspection and ECharts pause while a range is selected.
    event.preventDefault();
    event.stopPropagation();
    draw(local(event)[0]);
  }
  function up(event: PointerEvent) {
    if (!start || event.pointerId !== start.pointerId) return;
    const from = start.x,
      touch = start.touch,
      to = local(event)[0],
      wasDragging = dragging;
    reset();
    if (wasDragging) event.stopPropagation();
    if (!wasDragging) {
      // A tap shows values on touch; only a mouse or pen click resets the zoom.
      if (!touch) options.onZoom(null);
      return;
    }
    const rect = grid();
    if (!rect || Math.abs(to - from) < minimumDrag) return;
    const clamp = (x: number) => Math.max(rect.x, Math.min(rect.x + rect.width, x)),
      a = chart.convertFromPixel({ xAxisIndex: 0 }, clamp(Math.min(from, to))),
      b = chart.convertFromPixel({ xAxisIndex: 0 }, clamp(Math.max(from, to)));
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && b > a)
      options.onZoom({ xMin: a, xMax: b });
  }
  // A long press would otherwise open the browser's context menu.
  function menu(event: Event) {
    if (start?.touch) event.preventDefault();
  }
  function key(event: KeyboardEvent) {
    if (event.key === 'Escape' && dragging) {
      event.stopPropagation();
      reset();
    }
  }
  // Listening on the panel element in the capture phase runs before the canvas's own
  // listeners, so a drag in progress can withhold moves from them.
  element.addEventListener('pointerdown', down, { capture: true });
  element.addEventListener('pointermove', move, { capture: true });
  element.addEventListener('pointerup', up, { capture: true });
  element.addEventListener('pointercancel', reset, { capture: true });
  element.addEventListener('contextmenu', menu);
  window.addEventListener('keydown', key, { capture: true });
  return {
    get dragging() {
      return dragging;
    },
    destroy() {
      reset();
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', up, true);
      element.removeEventListener('pointercancel', reset, true);
      element.removeEventListener('contextmenu', menu);
      window.removeEventListener('keydown', key, true);
      band.remove();
    },
  };
}
