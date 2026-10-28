/**
 * The byte range a `Range` header asks for in a file of `size` bytes: `{start, end}`
 * (inclusive), `null` when it cannot be satisfied, or `undefined` to send the whole file
 * (no header, another unit, or several ranges).
 */
export function byteRange(header: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2])),
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size || (!match[1] && Number(match[2]) === 0)) return null;
  return { start, end };
}
