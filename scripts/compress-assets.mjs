import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
// Each text asset gets gzip and Brotli copies, built once at the highest levels; the server
// sends the one the browser accepts.
const compress = promisify(gzip),
  brotli = promisify(brotliCompress);
const root = new URL('../frontend/dist/', import.meta.url);
async function walk(path) {
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(js|css|html|svg)$/.test(file)) {
      const content = await fs.readFile(file);
      await fs.writeFile(file + '.gz', await compress(content, { level: 9 }));
      await fs.writeFile(
        file + '.br',
        await brotli(content, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: content.length,
          },
        }),
      );
    }
  }
}
await walk(root.pathname);
