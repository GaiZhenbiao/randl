import { createWriteStream, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export async function writeUpload(
  destination: string,
  source: Readable,
  maxBytes = 10 * 1024 ** 3,
) {
  await fs.mkdir(dirname(destination), { recursive: true });
  const temporary = destination + '.' + randomUUID() + '.part',
    hash = createHash('md5');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(Error('Upload exceeds the configured size limit'));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(temporary, { flags: 'wx' }));
    await fs.rename(temporary, destination);
    return { size, digest: hash.digest('base64') };
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
