import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const compress = promisify(gzip);
const root = new URL('../frontend/dist/', import.meta.url);
async function walk(path) {
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(js|css|html|svg)$/.test(file))
      await fs.writeFile(file + '.gz', await compress(await fs.readFile(file), { level: 9 }));
  }
}
await walk(root.pathname);
