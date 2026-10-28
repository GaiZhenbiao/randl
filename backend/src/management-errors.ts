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
  ...agentErrorCodes,
]);
export type ErrorFields = Error & {
  code?: string;
  statusCode?: number;
  params?: Record<string, string | number>;
};
export const isManagementCode = (code: unknown): code is string =>
  typeof code === 'string' && codes.has(code);
export function errorFields(error: ErrorFields) {
  const known = isManagementCode(error.code);
  return {
    message: error.message,
    statusCode: error.statusCode,
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
