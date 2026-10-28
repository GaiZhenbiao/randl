import { promises as fs } from 'node:fs';
import { extname } from 'node:path';

// The display size of a logged video, read from its container header, so media panels lay
// out a video's tile at its shape before any frame loads. The W&B SDK logs `width` and
// `height` only for videos it encodes from arrays; files logged by path have none. MP4 gives
// the video track's `tkhd` size (turned by a quarter-turn matrix), WebM the track's display
// or pixel size, GIF its logical screen. A few small reads per file; sizes are kept in
// memory by path, byte size and modification time.

export type VideoSize = { width: number; height: number };
type Read = (position: number, length: number) => Promise<Buffer>;
/** Most boxes or elements read at one level, against malformed files. */
const maxChildren = 256;
const cached = new Map<string, VideoSize | null>(),
  maxCached = 20000;

/** The video's size, or undefined when the file is missing or its header has none. */
export async function videoSize(path: string): Promise<VideoSize | undefined> {
  const reader = readers[extname(path).toLowerCase()];
  if (!reader) return;
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const key = [path, stat.size, Math.floor(stat.mtimeMs)].join('\0'),
    known = cached.get(key);
  if (known !== undefined) return known ?? undefined;
  const handle = await fs.open(path, 'r');
  try {
    const read: Read = async (position, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, stat.size - position)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    };
    const size = await reader(read, stat.size).catch(() => undefined),
      result = size && size.width > 0 && size.height > 0 ? size : undefined;
    cached.set(key, result ?? null);
    if (cached.size > maxCached) cached.delete(cached.keys().next().value!);
    return result;
  } finally {
    await handle.close();
  }
}
const readers: Record<string, (read: Read, end: number) => Promise<VideoSize | undefined>> = {
  '.mp4': mp4,
  '.webm': webm,
  '.gif': async (read) => {
    const head = await read(0, 10);
    if (head.length < 10 || !/^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return;
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  },
};

// ISO base media: moov > trak > tkhd. The first track with a size is the video; audio tracks
// have none. The header may follow the media data, so boxes are walked by their sizes.
async function* boxes(read: Read, start: number, end: number) {
  for (let at = start, count = 0; at + 8 <= end && count < maxChildren; count++) {
    const head = await read(at, 16);
    if (head.length < 8) return;
    let size = head.readUInt32BE(0),
      header = 8;
    if (size === 1) {
      if (head.length < 16) return;
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header) return;
    yield {
      type: head.toString('latin1', 4, 8),
      start: at + header,
      end: Math.min(end, at + size),
    };
    at += size;
  }
}
async function mp4(read: Read, end: number) {
  for await (const moov of boxes(read, 0, end)) {
    if (moov.type !== 'moov') continue;
    for await (const trak of boxes(read, moov.start, moov.end)) {
      if (trak.type !== 'trak') continue;
      for await (const tkhd of boxes(read, trak.start, trak.end)) {
        if (tkhd.type !== 'tkhd') continue;
        const box = await read(tkhd.start, tkhd.end - tkhd.start),
          // Version 1 has 64-bit times: 12 more bytes before the matrix.
          matrix = box[0] === 1 ? 52 : 40;
        if (box.length < matrix + 44) break;
        const width = box.readUInt32BE(matrix + 36) / 65536,
          height = box.readUInt32BE(matrix + 40) / 65536;
        if (!width || !height) break;
        // A quarter turn has a zero diagonal: a = d = 0.
        const turned = box.readInt32BE(matrix) === 0 && box.readInt32BE(matrix + 16) === 0;
        return turned ? { width: height, height: width } : { width, height };
      }
    }
    return;
  }
}

// Matroska (EBML): Segment > Tracks > TrackEntry > Video > PixelWidth/PixelHeight, or the
// DisplayWidth/DisplayHeight that override them. Tracks precede the clusters.
const ebml = {
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  entry: 0xae,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  displayWidth: 0x54b0,
  displayHeight: 0x54ba,
};
/** A variable-length integer at `at`: its value (without the length marker for sizes) and length. */
function vint(buffer: Buffer, at: number, keepMarker: boolean) {
  const first = buffer[at];
  if (first === undefined || first === 0) return;
  const length = Math.clz32(first) - 23;
  if (at + length > buffer.length) return;
  let value = keepMarker ? first : first & (0xff >> length),
    unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buffer[at + i];
    if (buffer[at + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !keepMarker && unknown };
}
async function* elements(read: Read, start: number, end: number) {
  for (let at = start, count = 0; at < end && count < maxChildren; count++) {
    const head = await read(at, 12),
      id = vint(head, 0, true),
      size = id && vint(head, id.length, false);
    if (!id || !size) return;
    const body = at + id.length + size.length,
      // An unknown size (a live recording's Segment) runs to the end of its parent.
      stop = size.unknown ? end : Math.min(end, body + size.value);
    yield { id: id.value, start: body, end: stop };
    at = stop;
  }
}
async function unsigned(read: Read, element: { start: number; end: number }) {
  const bytes = await read(element.start, Math.min(8, element.end - element.start));
  return bytes.reduce((value, byte) => value * 256 + byte, 0);
}
async function webm(read: Read, end: number) {
  for await (const segment of elements(read, 0, end)) {
    if (segment.id !== ebml.segment) continue;
    for await (const tracks of elements(read, segment.start, segment.end)) {
      if (tracks.id !== ebml.tracks) continue;
      for await (const entry of elements(read, tracks.start, tracks.end)) {
        if (entry.id !== ebml.entry) continue;
        for await (const video of elements(read, entry.start, entry.end)) {
          if (video.id !== ebml.video) continue;
          const found: Record<number, number> = {};
          for await (const field of elements(read, video.start, video.end))
            found[field.id] = await unsigned(read, field);
          const display = found[ebml.displayWidth] && found[ebml.displayHeight];
          return {
            width: display ? found[ebml.displayWidth] : found[ebml.pixelWidth],
            height: display ? found[ebml.displayHeight] : found[ebml.pixelHeight],
          };
        }
      }
      return;
    }
    return;
  }
}
