import { Store } from '../backend/dist/database.js';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
// Synthetic media for demo/media-demo: six runs logging six images per step (an image list)
// and one preview image at eight steps. Use a separate demo database.
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
if (!values['data-dir']) throw Error('Choose a separate demo database with --data-dir');
const directory = resolve(values['data-dir']),
  store = new Store(directory);
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes) {
  let x = 0xffffffff;
  for (const byte of bytes) x = table[(x ^ byte) & 255] ^ (x >>> 8);
  return (x ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4),
    body = Buffer.concat([Buffer.from(type), data]),
    check = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
}
/** An RGB PNG whose pixels `color(x, y)` gives. */
function png(width, height, color) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(color(x, y), y * (width * 3 + 1) + 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (let i = 0; i < 6; i++) {
  const run = store.upsert({
    entity: 'demo',
    project: 'media-demo',
    name: `media-${i}`,
    displayName: `vision-run-${i + 1} · seed ${i}`,
    config: { seed: { value: i } },
  });
  if (run.history_count) continue;
  const folder = join(directory, 'files', createHash('sha256').update(run.id).digest('hex'));
  const write = (path, bytes) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), bytes);
  };
  const content = [];
  for (let s = 0; s < 8; s++) {
    const filenames = [];
    for (let k = 0; k < 6; k++) {
      const path = `media/images/samples_${s}_${k}.png`;
      write(
        path,
        png(96, 72, (x, y) => [
          (x * 2 + i * 40 + k * 30) % 256,
          (y * 3 + s * 25) % 256,
          ((x + y) * (k + 1) + i * 20) % 256,
        ]),
      );
      filenames.push(path);
    }
    const single = `media/images/preview_${s}.png`,
      bytes = png(160, 120, (x, y) => [(x + i * 40) % 256, (y * 2 + s * 30) % 256, (i * 50) % 256]);
    write(single, bytes);
    content.push(
      JSON.stringify({
        _step: s * 10,
        loss: Math.exp(-s / 3) + i * 0.05,
        samples: {
          _type: 'images/separated',
          count: 6,
          filenames,
          width: 96,
          height: 72,
          format: 'png',
          captions: filenames.map((_, k) => `sample ${k}`),
        },
        preview: {
          _type: 'image-file',
          path: single,
          width: 160,
          height: 120,
          format: 'png',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        },
      }),
    );
  }
  store.ingest(run.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content } },
    complete: true,
    exitcode: 0,
  });
}
store.db.close();
console.log(`Seeded demo/media-demo in ${directory}`);
