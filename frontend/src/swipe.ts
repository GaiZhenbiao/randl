// Horizontal swiping between items, shared by Coverflow and section pages: a touch drag or a
// touchpad scroll moves the items continuously (`show` with a position between two items);
// past the first or last item they stretch like a rubber band, as on iOS; on release a spring
// carries them on from the release speed to the item they settle on, in one motion, and a new
// gesture takes them up from wherever they are. Mouse and pen drags are left to the content,
// such as a chart's range selection, and a swipe region nested in another keeps its gestures.
import { WheelGestures, type WheelEventState } from 'wheel-gestures';

/** Spring stiffness per millisecond: critically damped, it settles within about 250 ms. */
const springRate = 0.028;
/**
 * A release at least `flickSpeed` pixels per ms is a flick, which moves on at least to the next
 * item its way and carries on at its speed, at most `flingSpeed` items per ms, for `flingTime`.
 */
const flickSpeed = 0.3,
  flingTime = 200,
  flingSpeed = 0.02;
/** Movement that tells a touch's direction, and its least angle from vertical to be a swipe. */
const touchSlop = 10,
  swipeAngle = Math.PI / 6;

/**
 * Where a drag to `position` shows among `count` items: past the first or last item it
 * stretches like a rubber band, as on iOS, moving ever less the farther it goes but never
 * stopping. `distance` pixels past the end show as (1 - 1 / (0.55 distance / width + 1)) width,
 * for a drag that moves one item per `unit` pixels in a `width` region.
 */
export function rubberBand(position: number, count: number, unit: number, width: number) {
  const last = Math.max(0, count - 1),
    past = position < 0 ? position : position > last ? position - last : 0;
  if (!past) return position;
  const distance = Math.abs(past) * unit,
    stretch = (1 - 1 / ((distance * 0.55) / width + 1)) * width;
  return (past < 0 ? 0 : last) + (Math.sign(past) * stretch) / unit;
}
/** The drag position that `rubberBand` shows at `shown`, so a new drag takes up from there. */
export function unstretch(shown: number, count: number, unit: number, width: number) {
  const last = Math.max(0, count - 1),
    past = shown < 0 ? shown : shown > last ? shown - last : 0;
  if (!past) return shown;
  const stretch = Math.min(Math.abs(past) * unit, width * 0.999),
    distance = (width / 0.55) * (1 / (1 - stretch / width) - 1);
  return (past < 0 ? 0 : last) + (Math.sign(past) * distance) / unit;
}
/**
 * The item of `count` that a drag released at `position` settles on, moving `speed` items per
 * millisecond forward with `unit` pixels to an item: the nearest, so a drag that moves too
 * little stays, unless it is a flick, which moves on to the next item its way at least and
 * farther the faster it is.
 */
export function swipeTarget(position: number, count: number, speed = 0, unit = 1) {
  let target = Math.round(position);
  if (Math.abs(speed) * unit >= flickSpeed) {
    const fling = Math.max(-flingSpeed, Math.min(flingSpeed, speed)) * flingTime,
      projected = Math.round(position + fling);
    target =
      speed > 0
        ? Math.max(projected, Math.floor(position) + 1)
        : Math.min(projected, Math.ceil(position) - 1);
  }
  return Math.max(0, Math.min(count - 1, target));
}
/**
 * A critically damped spring `dt` milliseconds on: its offset from rest `x` and velocity `v`
 * (per millisecond) then. It starts at the release speed and comes to rest without bouncing,
 * unless it starts fast toward its rest, as a fling into an end does.
 */
export function springStep(x: number, v: number, dt: number, rate = springRate) {
  const decay = Math.exp(-rate * dt),
    b = v + rate * x;
  return { x: (x + b * dt) * decay, v: (v - rate * dt * b) * decay };
}

export type SwipeOptions = {
  /** How many items there are; swiping needs two. */
  count: () => number;
  /** The current item. */
  index: () => number;
  /** Pixels of drag that move the items by one. */
  unit: () => number;
  /** Shows the items at a position between two (or past the ends); undefined is at rest. */
  show: (position: number | undefined) => void;
  /** A gesture settles on `index`, which becomes current as the items move there. */
  choose: (index: number) => void;
};
type Trail = { x: number; time: number }[];

/**
 * Swiping on `element`, which is marked `data-swipe`: horizontal touch drags and touchpad
 * scrolls. While a gesture shows the items, `element` has the class `swiping`; after a touch
 * or touchpad gesture it has `swipe-gesture` until a mouse moves, for controls that show only
 * to a mouse.
 */
export class Swipe {
  /** Where the items show while a gesture moves them; undefined at rest. */
  position: number | undefined;
  private drag: { from: number; unit: number; moved: number; trail: Trail } | undefined;
  private touch: { x: number; y: number; id: number; moving: boolean } | undefined;
  private velocity = 0;
  private frame = 0;
  private animation = 0;
  private dragged = -Infinity;
  /** Touchpad gestures: where the fingers go down, move, lift, and the glide after. */
  private gestures = WheelGestures({ preventWheelAction: false, reverseSign: false });
  private offGesture: () => void;
  /** The axis the current touchpad gesture scrolls along, set by its first movement. */
  private axis: 'x' | 'y' | undefined;
  /** Whether the current touchpad gesture drags the items. */
  private scrolling = false;
  private scrolled = 0;
  constructor(
    private element: HTMLElement,
    private options: SwipeOptions,
  ) {
    element.dataset.swipe = '';
    element.addEventListener('pointerdown', this.pointerdown);
    element.addEventListener('pointermove', this.pointermove);
    element.addEventListener('pointerup', this.pointerup);
    element.addEventListener('pointercancel', this.pointercancel);
    element.addEventListener('click', this.click, true);
    // Before the content, such as a chart that keeps its wheel to itself.
    element.addEventListener('wheel', this.wheel, { capture: true, passive: false });
    element.addEventListener('pointermove', this.mouse, { passive: true });
    this.offGesture = this.gestures.on('wheel', this.gesture);
  }
  /** Whether a gesture moves the items or they settle after one. */
  get active() {
    return this.position !== undefined;
  }
  /** Ends a gesture where it is without settling, as when a key moves the items. */
  stop() {
    if (!this.active && !this.touch) return;
    this.halt();
    this.touch = undefined;
    this.scrolling = false;
    this.position = undefined;
    this.element.classList.remove('swiping');
  }
  /**
   * Moves the items to `target` as a button does: it becomes current and the spring carries the
   * items there from where they show, at once under reduced motion.
   */
  slide(target: number) {
    const index = this.options.index();
    target = Math.max(0, Math.min(this.options.count() - 1, target));
    if (target === index && !this.active) return;
    const from = this.position ?? index;
    this.stop();
    if (target !== index) this.options.choose(target);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.options.show(undefined);
      return;
    }
    this.position = from;
    this.velocity = 0;
    this.element.classList.add('swiping');
    this.settle(target, this.options.unit());
  }
  destroy() {
    this.halt();
    const element = this.element;
    delete element.dataset.swipe;
    element.classList.remove('swiping', 'swipe-gesture');
    element.removeEventListener('pointerdown', this.pointerdown);
    element.removeEventListener('pointermove', this.pointermove);
    element.removeEventListener('pointerup', this.pointerup);
    element.removeEventListener('pointercancel', this.pointercancel);
    element.removeEventListener('click', this.click, true);
    element.removeEventListener('wheel', this.wheel, true);
    element.removeEventListener('pointermove', this.mouse);
    this.offGesture();
  }
  private halt() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.animation);
    this.frame = this.animation = 0;
    this.drag = undefined;
  }
  /** An event this region handles: not one for a swipe region nested in it. */
  private mine(event: Event) {
    return (
      this.options.count() > 1 &&
      (event.target as Element | null)?.closest?.('[data-swipe]') === this.element
    );
  }
  private mouse = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && (event.movementX || event.movementY))
      this.element.classList.remove('swipe-gesture');
  };
  // A second finger ends the drag, which settles where it is.
  private pointerdown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || event.defaultPrevented || !this.mine(event)) return;
    this.element.classList.add('swipe-gesture');
    if (this.touch) {
      this.touch = undefined;
      if (this.drag) this.release(0);
      return;
    }
    this.scrolling = false;
    this.dragged = -Infinity;
    this.touch = { x: event.clientX, y: event.clientY, id: event.pointerId, moving: false };
  };
  // A drag within 30° of horizontal moves the items with the finger; a vertical one is left to
  // the page, which scrolls (`touch-action: pan-y`) and cancels it.
  private pointermove = (event: PointerEvent) => {
    const touch = this.touch;
    if (!touch || touch.id !== event.pointerId) return;
    if (!touch.moving) {
      const dx = event.clientX - touch.x,
        dy = event.clientY - touch.y;
      if (Math.hypot(dx, dy) < touchSlop) return;
      if (Math.abs(dy) > Math.abs(dx) * Math.tan(swipeAngle)) {
        this.touch = undefined;
        return;
      }
      touch.moving = true;
      // The items take up the drag from where the finger is now, without a jump.
      touch.x = event.clientX;
      this.begin(event.timeStamp);
    }
    this.move(event.clientX - touch.x, event.timeStamp);
  };
  // On release the items carry on at the finger's speed and settle on the nearest item, or on
  // past it after a flick.
  private pointerup = (event: PointerEvent) => {
    const touch = this.touch;
    if (!touch || touch.id !== event.pointerId) return;
    this.touch = undefined;
    if (!touch.moving) return;
    this.move(event.clientX - touch.x, event.timeStamp);
    this.dragged = event.timeStamp;
    this.release(this.speed(event.timeStamp));
  };
  private pointercancel = (event: PointerEvent) => {
    if (this.touch?.id !== event.pointerId) return;
    this.touch = undefined;
    if (this.drag) this.release(0);
  };
  // The click that ends a drag does not choose what it ends over.
  private click = (event: MouseEvent) => {
    if (event.timeStamp - this.dragged > 500) return;
    this.dragged = -Infinity;
    event.stopPropagation();
    event.preventDefault();
  };
  // Touchpad gestures go to `wheel-gestures`, which tells when the fingers go down and lift and
  // which scrolls are the glide after; a wheel that scrolls by lines or pages steps an item.
  // Vertical scrolls and pinches (Ctrl) are left alone, and the page does not take horizontal
  // ones as back or forward.
  private wheel = (event: WheelEvent) => {
    if (event.ctrlKey || this.touch || !this.mine(event)) return;
    if (event.deltaMode === 0) return this.gestures.feedWheel(event);
    const dx = event.deltaX,
      dy = event.deltaY;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    event.preventDefault();
    this.element.classList.add('swipe-gesture');
    this.scrolling = false;
    this.begin(event.timeStamp);
    this.move(-Math.sign(dx) * this.drag!.unit, event.timeStamp);
    this.release(0);
  };
  // A touchpad gesture whose first movement is mostly horizontal moves the items as a drag does,
  // all of it, even where it turns; one that starts vertical is left to the page. When the
  // fingers lift, the items take over from the glide at its speed and the rest of it is
  // ignored; when they lift still, the items settle on the nearest item.
  private gesture = (state: WheelEventState) => {
    if (state.isEnding) {
      if (this.scrolling && this.drag) this.release(0);
      this.scrolling = false;
      this.axis = undefined;
      return;
    }
    const [dx, dy] = state.axisDelta,
      event = state.event as WheelEvent;
    if (state.isStart) {
      this.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      this.scrolling = this.axis === 'x';
      if (this.scrolling) {
        this.begin(event.timeStamp);
        this.scrolled = 0;
      }
    }
    if (this.axis !== 'x') return;
    event.preventDefault();
    this.element.classList.add('swipe-gesture');
    if (!this.scrolling || !this.drag) return;
    if (state.isMomentum) {
      this.scrolling = false;
      this.release(state.axisVelocity[0] / this.drag.unit);
      return;
    }
    this.scrolled -= dx;
    this.move(this.scrolled, event.timeStamp);
  };
  /** Starts a drag where the items show, settling or at rest. */
  private begin(time: number) {
    const count = this.options.count(),
      unit = this.options.unit(),
      width = this.element.clientWidth;
    cancelAnimationFrame(this.animation);
    this.animation = 0;
    const from =
      this.position === undefined
        ? this.options.index()
        : unstretch(this.position, count, unit, width);
    this.drag = { from, unit, moved: 0, trail: [{ x: 0, time }] };
    this.position = rubberBand(from, count, unit, width);
    this.element.classList.add('swiping');
  }
  /** Moves a drag to `dx` pixels from where it started; the items follow on the next frame. */
  private move(dx: number, time: number) {
    const drag = this.drag;
    if (!drag) return;
    drag.moved = -dx / drag.unit;
    drag.trail.push({ x: dx, time });
    while (drag.trail.length > 2 && time - drag.trail[0].time > 100) drag.trail.shift();
    this.position = rubberBand(
      drag.from + drag.moved,
      this.options.count(),
      drag.unit,
      this.element.clientWidth,
    );
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.drag) this.options.show(this.position);
      });
  }
  /** The drag's speed over its last 100 ms, at least a frame of it, in items per ms forward. */
  private speed(time: number) {
    const drag = this.drag;
    if (!drag) return 0;
    const first = drag.trail[0],
      last = drag.trail[drag.trail.length - 1],
      elapsed = time - first.time;
    return elapsed >= 16 && elapsed <= 150 ? -(last.x - first.x) / elapsed / drag.unit : 0;
  }
  /**
   * Ends a drag: the item it settles on (`swipeTarget`) becomes current, and a spring moves
   * the items there from where they show, starting at `speed` items per millisecond.
   */
  private release(speed: number) {
    const drag = this.drag;
    if (!drag) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.drag = undefined;
    const count = this.options.count(),
      target = swipeTarget(drag.from + drag.moved, count, speed, drag.unit);
    if (target !== this.options.index()) this.options.choose(target);
    this.velocity = Math.max(-flingSpeed, Math.min(flingSpeed, speed));
    this.settle(target, drag.unit);
  }
  private settle(target: number, unit: number) {
    let last = performance.now();
    const step = (now: number) => {
      const next = springStep(this.position! - target, this.velocity, Math.min(48, now - last));
      last = now;
      this.velocity = next.v;
      // At rest once under half a pixel away and moving under 10 px a second.
      if (Math.abs(next.x) * unit < 0.5 && Math.abs(next.v) * unit < 0.01) {
        this.animation = 0;
        this.position = undefined;
        this.element.classList.remove('swiping');
        this.options.show(undefined);
        return;
      }
      this.position = target + next.x;
      this.options.show(this.position);
      this.animation = requestAnimationFrame(step);
    };
    this.options.show(this.position);
    this.animation = requestAnimationFrame(step);
  }
}
