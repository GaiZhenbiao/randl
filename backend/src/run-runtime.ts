/**
 * A run's runtime is its active time, accumulated like W&B's `_runtime`: it continues
 * across resumes and excludes the time a run was paused. The SDK reports a cumulative
 * `_runtime` with each history record and in the summary; randl folds each report into
 * the stored runtime as an increment over the previous report.
 *
 * Reported values are not always trustworthy. W&B SDK 0.30.0 inflates resumed runs'
 * `_runtime` (wandb/wandb#12999), and imported histories contain jumps of billions of
 * seconds. An increment is accepted only when it is non-negative and no longer than the
 * wall time between the two reports; otherwise the reports are discontinuous, and the
 * wall time between them counts only when it is short enough not to be a pause.
 */
export const RUNTIME_TOLERANCE = 60;
export const PAUSE_GAP = 600;
export type RuntimeState = {
  /** Accumulated active seconds. */
  runtime: number;
  /** The last reported cumulative value and when it was reported (seconds). */
  raw: number | null;
  rawAt: number | null;
  /** When the run started; bounds the first report. */
  started: number;
};
export function advanceRuntime(state: RuntimeState, raw: unknown, at: number): RuntimeState {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isFinite(at)) return state;
  let runtime = state.runtime;
  if (state.raw === null || state.rawAt === null) {
    // The first report counts from the run's start.
    if (raw >= 0 && raw <= Math.max(0, at - state.started) + RUNTIME_TOLERANCE)
      runtime = Math.max(runtime, raw);
  } else {
    const delta = raw - state.raw,
      wall = Math.max(0, at - state.rawAt);
    if (delta >= 0 && delta <= wall + RUNTIME_TOLERANCE) runtime += delta;
    else if (wall <= PAUSE_GAP) runtime += wall;
  }
  return { ...state, runtime, raw, rawAt: at };
}
/** Whether a stored runtime fits in the run's wall-clock span. */
export function plausibleRuntime(runtime: number, started: number, last: number) {
  return runtime >= 0 && runtime <= Math.max(0, last - started) + RUNTIME_TOLERANCE;
}
