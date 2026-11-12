import {projectErrors} from './project-errors.js';
import { expressionErrorCodes, computedMetricErrorCodes } from './expressions.js';
import { recordTransformErrors, recordTransformCode } from './record-chart-errors.js';
/** Assistant failures the interface explains in the user's language. */
export const agentErrorCodes = [
  'AGENT_SETTINGS_UNAVAILABLE',
  'AGENT_BUSY',
  'AGENT_CONVERSATION_BUSY',
  'AGENT_MODEL_UNAVAILABLE',
  'AGENT_MODEL_REQUIRED',
  'AGENT_PROVIDER_REQUIRED',
  'AGENT_PROVIDER_UNKNOWN',
  'AGENT_API_KEY_REQUIRED',
  'AGENT_PROVIDER_SERVER_SETTINGS',
  'AGENT_PROVIDER_BROWSER_SIGN_IN',
  'AGENT_PROVIDER_PI_SETTINGS',
  'AGENT_TEST_INCOMPLETE',
  'AGENT_RETRY_UNAVAILABLE',
  'AGENT_CONTEXT_UNAVAILABLE',
  'AGENT_OAUTH_REFRESH',
  'AGENT_REQUEST_STOPPED',
  'AGENT_REQUEST_TIMEOUT',
] as const;
const codes = new Set([
  ...Object.keys(projectErrors),
  ...expressionErrorCodes,
  ...computedMetricErrorCodes,
  ...Object.keys(recordTransformErrors).map(recordTransformCode),
  'VIEW_CONFLICT',
  'VIEW_DELETED',
  'VIEW_NOT_FOUND',
  'RUN_NOT_FOUND',
  'RUN_STATE_RUNNING',
  'ARTIFACT_NOT_FOUND',
  'RUN_NAME_REQUIRED',
  'VISIBLE_RUN_LIMIT',
  'SOLO_RUN_LIMIT',
  'RUN_SNAPSHOT_STOP_UNAVAILABLE',
  'DUPLICATE_RUN_IDS',
  'CHART_SELECTION_UNKNOWN',
  'VIEW_NAME_REQUIRED',
  'VIEW_NAME_IN_USE',
  'VIEW_HIDE_PATTERN_INVALID',
  'AUTH_INVALID_KEY',
  'CONVERSATION_NOT_FOUND',
  'PLUGIN_OPTION_INVALID',
  // Run history edits (run_metrics_rename, run_history_write): scripts branch on these.
  'METRIC_RENAMES_REFUSED',
  'METRIC_RENAME_NOT_FOUND',
  'METRIC_RENAME_CHANGED',
  'HISTORY_ROWS_REFUSED',
  // The experiment ledger (ledger.ts).
  'LEDGER_NOT_FOUND',
  'LEDGER_TIME_INVALID',
  'FINDING_CONFLICT',
  'JOURNAL_KEY_IN_USE',
  ...agentErrorCodes,
]);
export type ErrorFields = Error & {
  code?: string;
  statusCode?: number;
  params?: Record<string, string | number>;
};
export const isManagementCode = (code: unknown): code is string =>
  typeof code === 'string' && codes.has(code);
/**
 * Whether an error is transient database contention that a later retry can pass: SQLite lock
 * codes, or better-sqlite3 refusing a statement while another query on the connection runs.
 */
export const isDatabaseContention = (error: ErrorFields) =>
  /^SQLITE_(BUSY|LOCKED)/.test(error.code ?? '') ||
  /^This (database connection|statement) is busy executing a query$/.test(error.message);
export function errorFields(error: ErrorFields) {
  const known = isManagementCode(error.code);
  return {
    message: error.message,
    // Contention is the server's condition, not a bad request: 503 tells clients to retry.
    statusCode: error.statusCode ?? (isDatabaseContention(error) ? 503 : undefined),
    ...(known ? { code: error.code, params: error.params } : {}),
  };
}
export function managementError(
  code: string,
  message: string,
  params: Record<string, string | number> = {},
  statusCode = 400,
) {
  return Object.assign(Error(message), { code, params, statusCode });
}
