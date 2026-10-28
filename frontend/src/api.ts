import type { Message, MessageKey, Values } from './i18n';
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly params?: Values,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
/** An error whose interface message is a catalog message. */
export class MessageError extends Error {
  constructor(readonly content: Exclude<Message, ''>) {
    super(typeof content === 'string' ? content : 'key' in content ? content.key : content.text);
  }
}
/** Interface messages for the server's structured error codes. */
const apiMessages: Record<string, MessageKey> = {
  EXPRESSION_EMPTY: 'charts.expressions.errors.empty',
  EXPRESSION_TOO_LONG: 'charts.expressions.errors.tooLong',
  EXPRESSION_TOO_COMPLEX: 'charts.expressions.errors.tooComplex',
  EXPRESSION_UNEXPECTED: 'charts.expressions.errors.unexpected',
  EXPRESSION_INCOMPLETE: 'charts.expressions.errors.incomplete',
  EXPRESSION_UNKNOWN_NAME: 'charts.expressions.errors.unknownName',
  EXPRESSION_UNKNOWN_MATH: 'charts.expressions.errors.unknownMath',
  EXPRESSION_ARGUMENTS: 'charts.expressions.errors.arguments',
  EXPRESSION_UNTERMINATED_REFERENCE: 'charts.expressions.errors.unterminatedReference',
  EXPRESSION_EMPTY_REFERENCE: 'charts.expressions.errors.emptyReference',
  EXPRESSION_NO_METRIC: 'charts.expressions.errors.noMetric',
  COMPUTED_METRIC_LIMIT: 'charts.expressions.errors.metricLimit',
  COMPUTED_METRIC_NAME: 'charts.expressions.errors.metricName',
  COMPUTED_METRIC_DUPLICATE: 'charts.expressions.errors.metricDuplicate',
  PLUGIN_OPTION_INVALID: 'plugins.errors.optionInvalid',
  CHART_TRANSFORM_SOURCE_RECORD_LIMIT: 'charts.transforms.errors.sourceRecordLimit',
  CHART_TRANSFORM_SOURCE_BYTES_LIMIT: 'charts.transforms.errors.sourceBytesLimit',
  CHART_TRANSFORM_RECORD_BYTES_LIMIT: 'charts.transforms.errors.recordBytesLimit',
  CHART_TRANSFORM_HISTORY_REQUIRED: 'charts.transforms.errors.historyRequired',
  CHART_TRANSFORM_INVALID: 'charts.transforms.errors.invalid',
  CHART_TRANSFORM_METRIC_LIMIT: 'charts.transforms.errors.metricLimit',
  CHART_TRANSFORM_ONE_STREAM: 'charts.transforms.errors.oneStream',
  CHART_TRANSFORM_INPUT_LIMIT: 'charts.transforms.errors.inputLimit',
  CHART_TRANSFORM_NEGATIVE: 'charts.transforms.errors.negative',
  CHART_TRANSFORM_REQUEST_SOURCE_LIMIT: 'charts.transforms.errors.requestSourceLimit',
  CHART_TRANSFORM_NON_FINITE: 'charts.transforms.errors.nonFinite',
  VIEW_CONFLICT: 'views.errors.conflict',
  VIEW_DELETED: 'views.errors.deleted',
  VIEW_NOT_FOUND: 'views.errors.notFound',
  RUN_NOT_FOUND: 'runs.errors.notFound',
  ARTIFACT_NOT_FOUND: 'artifacts.errors.notFound',
  RUN_NAME_REQUIRED: 'runs.errors.nameRequired',
  RUN_SNAPSHOT_STOP_UNAVAILABLE: 'runs.snapshot.stopUnavailable',
  VIEW_NAME_REQUIRED: 'views.errors.nameRequired',
  VIEW_NAME_IN_USE: 'views.errors.nameInUse',
  VIEW_HIDE_PATTERN_INVALID: 'views.errors.hidePatternInvalid',
  AUTH_INVALID_KEY: 'auth.errors.invalidKey',
  CONVERSATION_NOT_FOUND: 'assistant.errors.conversationNotFound',
  AGENT_SETTINGS_UNAVAILABLE: 'assistant.errors.settingsUnavailable',
  AGENT_BUSY: 'assistant.errors.busySettings',
  AGENT_CONVERSATION_BUSY: 'assistant.errors.busyConversation',
  AGENT_MODEL_UNAVAILABLE: 'assistant.errors.modelUnavailable',
  AGENT_MODEL_REQUIRED: 'assistant.errors.modelRequired',
  AGENT_PROVIDER_REQUIRED: 'assistant.errors.providerRequired',
  AGENT_PROVIDER_UNKNOWN: 'assistant.errors.unknownProvider',
  AGENT_API_KEY_REQUIRED: 'assistant.errors.apiKeyRequired',
  AGENT_PROVIDER_SERVER_SETTINGS: 'assistant.errors.providerNeedsServerSettings',
  AGENT_PROVIDER_BROWSER_SIGN_IN: 'assistant.errors.providerBrowserSignIn',
  AGENT_PROVIDER_PI_SETTINGS: 'assistant.errors.providerNeedsPiSettings',
  AGENT_TEST_INCOMPLETE: 'assistant.errors.testIncomplete',
  AGENT_RETRY_UNAVAILABLE: 'assistant.errors.retryUnavailable',
  AGENT_CONTEXT_UNAVAILABLE: 'assistant.errors.contextUnavailable',
  AGENT_OAUTH_REFRESH: 'assistant.errors.oauthRefresh',
  AGENT_REQUEST_STOPPED: 'assistant.errors.requestStopped',
  AGENT_REQUEST_TIMEOUT: 'assistant.errors.requestTimedOut',
  'projects.errors.invalidId': 'projects.errors.invalidId',
  'projects.errors.nameRequired': 'projects.errors.nameRequired',
  'projects.errors.nameTooLong': 'projects.errors.nameTooLong',
  'projects.errors.descriptionTooLong': 'projects.errors.descriptionTooLong',
  'projects.errors.alreadyExists': 'projects.errors.alreadyExists',
  'projects.errors.notFound': 'projects.errors.notFound',
  'projects.errors.emptyUpdate': 'projects.errors.emptyUpdate',
  'projects.errors.confirmName': 'projects.errors.confirmName',
  'projects.errors.runningRuns': 'projects.errors.runningRuns',
  'projects.errors.changed': 'projects.errors.changed',
  'projects.confirmation.expired': 'projects.confirmation.expired',
  'projects.confirmation.ownerOnly': 'projects.confirmation.ownerOnly',
  'projects.confirmation.invalidDecision': 'projects.confirmation.invalidDecision',
  'projects.confirmation.noRequest': 'projects.confirmation.noRequest',
};
/** The interface message for a structured error code, or `fallback` text when it has none. */
export function codedMessage(code: string, params: Values = {}, fallback = code): Message {
  return Object.hasOwn(apiMessages, code)
    ? { key: apiMessages[code], values: params }
    : { text: fallback };
}
/** The interface message for an error's structured code, if the interface explains it. */
export function knownMessage(error: unknown): Message | undefined {
  return error instanceof ApiError && error.code && Object.hasOwn(apiMessages, error.code)
    ? { key: apiMessages[error.code], values: error.params || {} }
    : undefined;
}
/** An error as an interface message: its code's message, otherwise its own text. */
export function apiMessage(error: unknown): Message {
  if (error instanceof MessageError) return error.content;
  const text = error instanceof Error ? error.message : String(error);
  return error instanceof ApiError && error.code
    ? codedMessage(error.code, error.params, text)
    : { text };
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await r.json();
  if (r.status === 401 && path !== '/api/auth/login')
    window.dispatchEvent(new Event('randl-auth-required'));
  if (!r.ok)
    throw new ApiError(
      data.error || data.message || 'Request failed',
      r.status,
      data.code,
      data.params,
    );
  return data;
}
export const tool = (name: string, args: unknown) => api('/api/tools/' + name, args);
/**
 * Posts a request that may be answered with newline-delimited JSON. Each line goes to
 * `onLine` as it arrives and the result is undefined; a plain JSON answer is returned.
 */
export async function streamed<T = any>(
  path: string,
  body: unknown,
  signal: AbortSignal,
  onLine: (value: any) => void,
): Promise<T | undefined> {
  const r = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson, application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data = await r.json();
    if (r.status === 401) window.dispatchEvent(new Event('randl-auth-required'));
    if (!r.ok)
      throw new ApiError(
        data.error || data.message || 'Request failed',
        r.status,
        data.code,
        data.params,
      );
    return data;
  }
  const reader = r.body!.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) onLine(JSON.parse(line));
    }
    if (done) return;
  }
}
// The serialized response store is the compact source of truth; the bounded decoded
// hot cache shares read-only responses with plugins.
// V8 stores Latin-1 text with one byte per character and other text with two.
export type CacheEntry = {
  json: string;
  versions: string;
  revision?: string;
  order: number;
  meta?: any;
};
const cache = new Map<string, CacheEntry & { bytes: number }>();
let bytes = 0;
const cacheLimit = 64 * 1024 * 1024;
const textBytes = (text: string) => text.length * (/[^\0-\xff]/.test(text) ? 2 : 1);
export function cached(key: string): CacheEntry | undefined {
  const item = cache.get(key);
  if (item) {
    cache.delete(key);
    cache.set(key, item);
  }
  return item;
}
/** Reads an entry without making it more recent. */
export const peek = (key: string): CacheEntry | undefined => cache.get(key);
const removed = new Set<(key: string, entry: CacheEntry) => void>();
/** Calls `listener` whenever an entry leaves the cache, so indexes of it stay bounded. */
export const onForget = (listener: (key: string, entry: CacheEntry) => void) =>
  void removed.add(listener);
export function forget(key: string) {
  const old = cache.get(key);
  if (!old) return;
  bytes -= old.bytes;
  cache.delete(key);
  for (const listener of removed) listener(key, old);
}
export function remember(key: string, entry: CacheEntry) {
  const size = textBytes(entry.json) + textBytes(key) + textBytes(entry.versions) + 256;
  forget(key);
  if (size > cacheLimit) return;
  cache.set(key, { ...entry, bytes: size });
  bytes += size;
  while (bytes > cacheLimit) forget(cache.keys().next().value!);
}
export function clearCache() {
  for (const key of [...cache.keys()]) forget(key);
}
const queue: {
  task: () => Promise<any>;
  signal: AbortSignal;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  detach: () => void;
}[] = [];
let active = 0;
export function scheduled<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const job = {
      task,
      signal,
      resolve,
      reject,
      detach: () => signal.removeEventListener('abort', abort),
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    queue.push(job);
    pump();
  });
}
function pump() {
  while (active < 4 && queue.length) {
    const job = queue.shift()!;
    job.detach();
    if (job.signal.aborted) {
      job.reject(new DOMException('Aborted', 'AbortError'));
      continue;
    }
    active++;
    job
      .task()
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}
