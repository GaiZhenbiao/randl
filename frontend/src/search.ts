const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
/** Lower scores rank first. Callers only use subsequences if no ordinary matches exist. */
export function matchScore(query: string, text: string, subsequence = true): number {
  const q = normalize(query).trim(),
    value = normalize(text);
  if (!q || q === value) return 0;
  const parts = q.split(/\s+/);
  let tier = 0;
  for (const part of parts) {
    if (value.startsWith(part)) tier = Math.max(tier, 1);
    else if (value.split(/[/_.-]/).some((segment) => segment.startsWith(part)))
      tier = Math.max(tier, 2);
    else if (value.includes(part)) tier = Math.max(tier, 3);
    else {
      let at = 0;
      for (const char of value) if (char === part[at]) at++;
      if (!subsequence || at !== part.length) return -1;
      tier = 4;
    }
  }
  return tier;
}
/** Half-open original-string offsets, including compatibility characters that expand in NFKC. */
export function highlightRanges(query: string, text: string): [number, number][] {
  let normalized = '';
  const offsets: [number, number][] = [];
  let offset = 0;
  for (const char of text) {
    const part = normalize(char);
    normalized += part;
    for (let i = 0; i < part.length; i++) offsets.push([offset, offset + char.length]);
    offset += char.length;
  }
  const positions = new Set<number>();
  for (const part of normalize(query).trim().split(/\s+/).filter(Boolean)) {
    const start = normalized.indexOf(part);
    if (start >= 0) for (let i = start; i < start + part.length; i++) positions.add(i);
    else {
      let cursor = 0;
      for (const char of part) {
        const index = normalized.indexOf(char, cursor);
        if (index < 0) break;
        positions.add(index);
        cursor = index + 1;
      }
    }
  }
  const ranges: [number, number][] = [];
  for (const index of [...positions].sort((a, b) => a - b)) {
    const [start, end] = offsets[index],
      previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(end, previous[1]);
    else ranges.push([start, end]);
  }
  return ranges;
}
