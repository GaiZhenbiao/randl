// HTTP response compression: Brotli when the client accepts it, otherwise gzip. JSON and other
// text compresses about tenfold; media is already compressed and is sent as it is.
import { promisify } from 'node:util';
import {
  brotliCompress,
  constants,
  createBrotliCompress,
  createGzip,
  gzip,
  type BrotliCompress,
  type Gzip,
} from 'node:zlib';

export type Encoding = 'br' | 'gzip';

/** Responses smaller than this are sent as they are: compression would save too little. */
export const minimumBytes = 1024;
const compressible =
  /^(application\/(json|x-ndjson|javascript|xml)|text\/[\w.+-]+|image\/svg\+xml)\s*(;|$)/i;

/** Whether a response of this Content-Type is worth compressing. */
export function compressibleType(type: unknown) {
  return typeof type === 'string' && compressible.test(type);
}

/** Whether an Accept-Encoding header allows `encoding`. */
export function accepts(header: string | string[] | undefined, encoding: Encoding) {
  const accepted = new Map<string, number>();
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    accepted.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  return (accepted.get(encoding) ?? accepted.get('*') ?? 0) > 0;
}

/** The best encoding an Accept-Encoding header allows, Brotli first; none for identity. */
export function negotiate(header: string | string[] | undefined): Encoding | undefined {
  return accepts(header, 'br') ? 'br' : accepts(header, 'gzip') ? 'gzip' : undefined;
}

const brotli = promisify(brotliCompress),
  gzipped = promisify(gzip);
// Brotli quality 4 compresses about as well as gzip level 6 for JSON, in less time: these
// are compressed per response, not ahead of time like the static assets.
const brotliParams = (size?: number) => ({
  [constants.BROTLI_PARAM_QUALITY]: 4,
  [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
  ...(size ? { [constants.BROTLI_PARAM_SIZE_HINT]: size } : {}),
});

/** A whole response body, compressed off the event loop. */
export function compressBody(body: Buffer, encoding: Encoding): Promise<Buffer> {
  return encoding === 'br'
    ? brotli(body, { params: brotliParams(body.length) })
    : gzipped(body, { level: 6 });
}

/**
 * A compressing stream for a response written in parts, such as newline-delimited JSON:
 * `flush` sends what has been written so far, so the client can use each part as it comes.
 */
export function compressStream(encoding: Encoding): (BrotliCompress | Gzip) & {
  send(): void;
} {
  const stream =
    encoding === 'br'
      ? createBrotliCompress({ params: brotliParams() })
      : createGzip({ level: 6 });
  return Object.assign(stream, {
    send() {
      stream.flush(
        encoding === 'br' ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH,
      );
    },
  });
}
