type Job = { highlight?: () => void; cursor?: () => void };
const pending = new Map<object, { job: Job; priority: number; generation: number }>();
let frame = 0,
  generation = 0;
function flush() {
  frame = 0;
  generation++;
  const start = performance.now();
  let highlighted = false;
  for (const [owner, entry] of [...pending].sort(
    (a, b) => a[1].generation - b[1].generation || a[1].priority - b[1].priority,
  )) {
    // A callback can supersede or cancel another owner's queued state.
    if (pending.get(owner) !== entry) continue;
    if (highlighted && entry.job.highlight) continue;
    pending.delete(owner);
    entry.job.highlight?.();
    entry.job.cursor?.();
    // Highlight painting is deferred by ECharts, so admit one per frame. Cursor-only
    // DOM updates can share the frame's script budget without repainting canvases.
    highlighted ||= !!entry.job.highlight;
    if (performance.now() - start >= 8) break;
  }
  if (pending.size && !frame) frame = requestAnimationFrame(flush);
}
/** Latest linked state wins per panel; emphasis always precedes its cursor. */
export function scheduleLinked(owner: object, job: Job, priority: number) {
  const previous = pending.get(owner);
  pending.set(owner, {
    job: { ...previous?.job, ...job },
    priority,
    generation: previous?.generation ?? generation,
  });
  if (!frame) frame = requestAnimationFrame(flush);
}
export function cancelLinked(owner: object) {
  pending.delete(owner);
  if (!pending.size) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}
