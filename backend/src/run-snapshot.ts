import { managementError } from './management-errors.js';
export function snapshotStopError() {
  return managementError(
    'RUN_SNAPSHOT_STOP_UNAVAILABLE',
    'Imported snapshots cannot receive stop requests',
  );
}
