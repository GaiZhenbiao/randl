<script lang="ts">
  // The edge of a sidebar that people drag (or move with the arrow keys) to resize it
  // (docs/contributing/design-system.md "Sidebars"). The sidebar's width is the parent's: this
  // reports each new width through `onresize` and remembers it per sidebar (sidebar-width.ts).
  import { onMount } from 'svelte';
  import { saveWidth } from './sidebar-width';

  let {
    id,
    label,
    width,
    min,
    max,
    side = 'end',
    onresize,
  }: {
    /** Which sidebar: its remembered width is stored under this name. */
    id: string;
    label: string;
    /** The sidebar's width now, in CSS pixels; read when a drag or key press starts. */
    width: () => number;
    min: number;
    /** The widest it may be now (it may depend on the window). */
    max: () => number;
    /** start: the sidebar is on the left and this is its right edge; end: the reverse. */
    side?: 'start' | 'end';
    onresize: (width: number) => void;
  } = $props();

  let drag = $state<{ x: number; width: number } | null>(null),
    now = $state(0);
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(Math.max(min, max()), value)));
  // The parent binds its sidebar after this mounts, so the width is first read a frame later.
  onMount(() => {
    const frame = requestAnimationFrame(() => (now = Math.round(width())));
    return () => cancelAnimationFrame(frame);
  });
  function set(value: number, save: boolean) {
    now = clamp(value);
    onresize(now);
    if (save) saveWidth(id, now);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (A focusable splitter, resized with the arrow keys.) -->
<div
  class="sidebar-resize"
  class:end={side === 'end'}
  class:dragging={!!drag}
  role="separator"
  aria-label={label}
  aria-orientation="vertical"
  aria-valuemin={min}
  aria-valuemax={Math.round(max())}
  aria-valuenow={now || undefined}
  tabindex="0"
  onpointerdown={(event) => {
    drag = { x: event.clientX, width: width() };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }}
  onpointermove={(event) => {
    if (!drag) return;
    const moved = event.clientX - drag.x;
    set(drag.width + (side === 'start' ? moved : -moved), false);
  }}
  onpointerup={() => {
    if (drag) saveWidth(id, now || drag.width);
    drag = null;
  }}
  onpointercancel={() => {
    if (drag) saveWidth(id, now || drag.width);
    drag = null;
  }}
  onkeydown={(event) => {
    const step = event.shiftKey ? 64 : 16,
      grow = side === 'start' ? 'ArrowRight' : 'ArrowLeft',
      shrink = side === 'start' ? 'ArrowLeft' : 'ArrowRight';
    const next =
      event.key === grow
        ? width() + step
        : event.key === shrink
          ? width() - step
          : event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max()
              : null;
    if (next === null) return;
    event.preventDefault();
    set(next, true);
  }}
></div>
