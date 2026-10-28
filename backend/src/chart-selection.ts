// Grouped charts can compare up to the selection limit of runs. Their requests name the
// selection by a content token instead of resending every run ID: the client registers
// the IDs once (POST /api/chart-selections) and every grouped panel refers to them.
const mix = (h1: number, h2: number) => {
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
/** A content token for an ordered list of run IDs (two 53-bit cyrb53 hashes and the count). */
export function selectionToken(ids: readonly string[]) {
  let a1 = 0xdeadbeef,
    a2 = 0x41c6ce57,
    b1 = 0xdeadbeef ^ 0x9e3779b9,
    b2 = 0x41c6ce57 ^ 0x9e3779b9;
  for (const id of ids) {
    for (let i = 0; i <= id.length; i++) {
      // A NUL after each ID separates neighbours.
      const c = i < id.length ? id.charCodeAt(i) : 0;
      a1 = Math.imul(a1 ^ c, 2654435761);
      a2 = Math.imul(a2 ^ c, 1597334677);
      b1 = Math.imul(b1 ^ c, 2246822519);
      b2 = Math.imul(b2 ^ c, 3266489917);
    }
  }
  return ids.length + '.' + mix(a1, a2).toString(36) + '.' + mix(b1, b2).toString(36);
}
/** Registered selections, most recently used last, within a total ID budget. */
export class ChartSelections {
  private entries = new Map<string, string[]>();
  private size = 0;
  constructor(readonly limit = 1_000_000) {}
  put(ids: string[]) {
    const token = selectionToken(ids),
      old = this.entries.get(token);
    if (old) this.entries.delete(token);
    else this.size += ids.length;
    this.entries.set(token, old || ids);
    while (this.size > this.limit && this.entries.size > 1) {
      const [first, entry] = this.entries.entries().next().value!;
      this.entries.delete(first);
      this.size -= entry.length;
    }
    return token;
  }
  get(token: string) {
    const ids = this.entries.get(token);
    if (ids) {
      this.entries.delete(token);
      this.entries.set(token, ids);
    }
    return ids;
  }
}
