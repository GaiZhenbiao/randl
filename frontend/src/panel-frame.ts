// Independent rAF callbacks still run in one browser task. Admit one panel update
// per frame so cached rebuilds leave room for layout, canvas paint and commit. Grid
// cells are small renderers: consecutive cell updates share a frame within a budget.
const pending = new Map<object, { update: () => void; cell: boolean }>();
let frame = 0,
  flushing = false;
/** Milliseconds of consecutive cell updates admitted in one frame, after the first. */
export const cellFrameBudget = 8;
function flush() {
  frame = 0;
  flushing = true;
  const start = performance.now();
  try {
    while (pending.size) {
      const [owner, job] = pending.entries().next().value!;
      pending.delete(owner);
      job.update();
      if (
        !pending.size ||
        !pending.values().next().value!.cell ||
        performance.now() - start >= cellFrameBudget
      )
        break;
    }
  } finally {
    // Work queued by these updates waits for the next frame.
    flushing = false;
    if (pending.size) frame = requestAnimationFrame(flush);
  }
}
/** Latest data wins without moving a waiting panel behind newer work. */
export function schedulePanel(owner: object, update: () => void, cell = false) {
  pending.set(owner, { update, cell });
  if (!frame && !flushing) frame = requestAnimationFrame(flush);
}
export function cancelPanel(owner: object) {
  pending.delete(owner);
  if (!pending.size && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}
