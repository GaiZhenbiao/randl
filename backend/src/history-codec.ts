import { deflateSync, inflateSync } from 'node:zlib';
export const N_POINTS = 1024,
  N_LINES = 256,
  LINE_BYTES = 4 * 1024 ** 2;
export type Point = { step: number; value: number };
export type Line = { offset: number; content: string };
export type PointBlock = {
  first: number;
  last: number;
  n: number;
  min_value: number;
  max_value: number;
  last_value: number;
  codec: number;
  steps: Buffer;
  vals: Buffer;
};
export type LineBlock = {
  first: number;
  last: number;
  n: number;
  bytes: number;
  largest: number;
  step_hi: number | null;
  step_hi_offset: number | null;
  body: Buffer;
};
const corrupt = () => Error('Corrupt history block');
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function floatValues(raw: Buffer, n: number): Float64Array {
  if (littleEndian && raw.byteOffset % 8 === 0)
    return new Float64Array(raw.buffer, raw.byteOffset, n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = raw.readDoubleLE(i * 8);
  return values;
}

export function uvarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw corrupt();
  const bytes: number[] = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    bytes.push(low + (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
function readVarint(buffer: Buffer, cursor: { at: number }): number {
  let value = 0,
    scale = 1;
  for (let i = 0; i < 8; i++) {
    if (cursor.at >= buffer.length) throw corrupt();
    const byte = buffer[cursor.at++];
    value += (byte % 128) * scale;
    if (!Number.isSafeInteger(value)) throw corrupt();
    if (byte < 128) return value;
    scale *= 128;
  }
  throw corrupt();
}
const zip = (b: Buffer) => deflateSync(b, { level: 6 });
export function encodePoints(rows: readonly Point[]): PointBlock {
  if (!rows.length) throw corrupt();
  const ints = rows.every((p) => Number.isSafeInteger(p.step) && p.step >= 0);
  let cursor = 0;
  const raw = Buffer.allocUnsafe(rows.length * 8),
    vals = Buffer.allocUnsafe(rows.length * 8);
  let min = Infinity,
    max = -Infinity,
    previous = 0;
  rows.forEach((p, i) => {
    if (!Number.isFinite(p.step) || !Number.isFinite(p.value) || (i && p.step <= previous))
      throw corrupt();
    if (ints) {
      let delta = i ? p.step - previous : p.step;
      do {
        const low = delta % 128;
        delta = Math.floor(delta / 128);
        raw[cursor++] = low + (delta ? 128 : 0);
      } while (delta);
    } else raw.writeDoubleLE(p.step || 0, i * 8);
    vals.writeDoubleLE(p.value || 0, i * 8);
    min = Math.min(min, p.value);
    max = Math.max(max, p.value);
    previous = p.step;
  });
  return {
    first: rows[0].step || 0,
    last: previous || 0,
    n: rows.length,
    min_value: min || 0,
    max_value: max || 0,
    last_value: rows.at(-1)!.value || 0,
    codec: ints ? 1 : 0,
    steps: zip(ints ? raw.subarray(0, cursor) : raw),
    vals: zip(vals),
  };
}
export function decodePointSteps(
  block: Pick<PointBlock, 'n' | 'codec' | 'steps' | 'first' | 'last'>,
): Float64Array {
  try {
    if (
      !Number.isSafeInteger(block.n) ||
      block.n < 1 ||
      block.n > 2048 ||
      ![0, 1].includes(block.codec)
    )
      throw corrupt();
    const raw = inflateSync(block.steps, { maxOutputLength: block.n * 8 });
    if (!block.codec && raw.length !== block.n * 8) throw corrupt();
    const steps = new Float64Array(block.n),
      cursor = { at: 0 };
    for (let i = 0; i < block.n; i++) {
      steps[i] = block.codec
        ? (i ? steps[i - 1] : 0) + readVarint(raw, cursor)
        : raw.readDoubleLE(i * 8);
      if (
        !Number.isFinite(steps[i]) ||
        (i && steps[i] <= steps[i - 1]) ||
        (block.codec && !Number.isSafeInteger(steps[i]))
      )
        throw corrupt();
    }
    if (
      (block.codec && cursor.at !== raw.length) ||
      steps[0] !== block.first ||
      steps.at(-1) !== block.last
    )
      throw corrupt();
    return steps;
  } catch {
    throw corrupt();
  }
}
export function decodePoints(block: PointBlock): { steps: Float64Array; values: Float64Array } {
  try {
    const steps = decodePointSteps(block),
      raw = inflateSync(block.vals, { maxOutputLength: block.n * 8 });
    if (raw.length !== block.n * 8) throw corrupt();
    const values = floatValues(raw, block.n);
    if (!values.every(Number.isFinite) || values.at(-1) !== block.last_value) throw corrupt();
    return { steps, values };
  } catch {
    throw corrupt();
  }
}
export function encodeLines(rows: readonly Line[], history: boolean): LineBlock {
  if (!rows.length) throw corrupt();
  let previous = rows[0].offset,
    bytes = 0,
    largest = 0,
    step_hi: number | null = null,
    step_hi_offset: number | null = null;
  const chunks: Buffer[] = [];
  rows.forEach((row, i) => {
    if (!Number.isSafeInteger(row.offset) || row.offset < 0 || (i && row.offset <= previous))
      throw corrupt();
    const data = Buffer.from(row.content);
    chunks.push(uvarint(row.offset - previous), uvarint(data.length), data);
    bytes += data.length;
    largest = Math.max(largest, data.length);
    previous = row.offset;
    if (history) {
      const step = JSON.parse(row.content)._step;
      if (
        typeof step === 'number' &&
        Number.isFinite(step) &&
        (step_hi === null || step > step_hi)
      ) {
        step_hi = step;
        step_hi_offset = row.offset;
      }
    }
  });
  return {
    first: rows[0].offset,
    last: previous,
    n: rows.length,
    bytes,
    largest,
    step_hi,
    step_hi_offset,
    body: zip(Buffer.concat(chunks)),
  };
}
export function decodeLines(block: LineBlock): Line[] {
  try {
    if (
      !Number.isSafeInteger(block.n) ||
      block.n < 1 ||
      !Number.isSafeInteger(block.bytes) ||
      block.bytes < 0
    )
      throw corrupt();
    const raw = inflateSync(block.body, {
        maxOutputLength: Math.max(1, block.bytes + block.n * 16),
      }),
      cursor = { at: 0 },
      rows: Line[] = [];
    let offset = block.first,
      bytes = 0,
      largest = 0;
    for (let i = 0; i < block.n; i++) {
      const delta = readVarint(raw, cursor);
      if ((!i && delta !== 0) || (i && delta === 0)) throw corrupt();
      offset += delta;
      const length = readVarint(raw, cursor);
      if (cursor.at + length > raw.length || !Number.isSafeInteger(offset)) throw corrupt();
      const data = raw.subarray(cursor.at, cursor.at + length),
        content = data.toString('utf8');
      if (!Buffer.from(content).equals(data)) throw corrupt();
      cursor.at += length;
      bytes += length;
      largest = Math.max(largest, length);
      rows.push({ offset, content });
    }
    if (
      cursor.at !== raw.length ||
      offset !== block.last ||
      bytes !== block.bytes ||
      largest !== block.largest
    )
      throw corrupt();
    return rows;
  } catch {
    throw corrupt();
  }
}
