// W&B ROBIN16, in assignment order. Low-contrast legacy night-mode values have
// higher OKLCH lightness for Carbon g100; see docs/wandb-reference.md for the audit.
export type RunColorPair = { light: string; dark: string };
export const runPalette: RunColorPair[] = [
  { light: '#538ae5', dark: '#6499f0' }, // blue
  { light: '#f0434f', dark: '#ff8b96' }, // red
  { light: '#479a5f', dark: '#5aaa71' }, // kelly green
  { light: '#865ed6', dark: '#bf98ff' }, // purple
  { light: '#f07fdd', dark: '#cb5eb9' }, // pink
  { light: '#e57439', dark: '#ea7e45' }, // orange
  { light: '#87cebf', dark: '#4c8f7e' }, // seafoam
  { light: '#dc4bdc', dark: '#ff7cff' }, // magenta
  { light: '#ffb83d', dark: '#b8723c' }, // yellow
  { light: '#5bc5db', dark: '#328ea3' }, // cyan
  { light: '#229487', dark: '#48b6a9' }, // forest
  { light: '#fab796', dark: '#ca8463' }, // peach
  { light: '#9bc750', dark: '#638f39' }, // lime
  { light: '#ad6f50', dark: '#cf9476' }, // brown
  { light: '#c2327a', dark: '#ff9fe4' }, // maroon
  { light: '#a1a9ad', dark: '#7b8488' }, // gray
];
/** Use W&B's run-palette order for metric components, independent of run selection or theme.
 * In particular, lime separates the similar dark peach and brown swatches.
 */
export function componentColor(index: number, dark: boolean) {
  return runPalette[index % runPalette.length][dark ? 'dark' : 'light'];
}
// Legend and tooltip text retain W&B light variants, with dark contrast corrections.
const runTextColors: Record<string, RunColorPair> = {
  '#538ae5': { light: '#538ae5', dark: '#6da3fa' },
  '#479a5f': { light: '#479a5f', dark: '#62b379' },
  '#f07fdd': { light: '#e077cf', dark: '#e47ed3' },
  '#e57439': { light: '#e57439', dark: '#f2854c' },
  '#87cebf': { light: '#6eb8a8', dark: '#68af9f' },
  '#dc4bdc': { light: '#cc45cc', dark: '#ff87ff' },
  '#ffb83d': { light: '#f0a118', dark: '#df904a' },
  '#5bc5db': { light: '#1fa8d4', dark: '#32afd9' },
  '#fab796': { light: '#e09267', dark: '#de8f66' },
  '#9bc750': { light: '#81a83d', dark: '#87af4a' },
  '#ad6f50': { light: '#b87654', dark: '#d39472' },
  '#a1a9ad': { light: '#818a8f', dark: '#9aa4a9' },
};
/** Resolve a stored (light palette or custom) color without modifying custom hex values. */
export function resolvePaletteColor(color: string, dark: boolean) {
  const entry = runPalette.find((entry) => entry.light === color.toLowerCase());
  return entry ? entry[dark ? 'dark' : 'light'] : color;
}
/** Input is the already resolved series color used by the renderer. */
export function runTextColor(color: string, dark = false) {
  const theme = dark ? 'dark' : 'light';
  const entry = runPalette.find((entry) => entry[theme] === color.toLowerCase());
  return entry ? (runTextColors[entry.light]?.[theme] ?? color) : color;
}
/** W&B's color for an identity without a creation index: a 32-bit string hash. */
export function color(key: string, overrides: Record<string, string> = {}, dark = false) {
  if (overrides[key]) return overrides[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 10) - hash + key.charCodeAt(i)) | 0;
  return runPalette[Math.abs(hash) % runPalette.length][dark ? 'dark' : 'light'];
}
/**
 * Each run keeps the palette color of the index it received at creation, as in W&B;
 * explicit view colors override it.
 */
export function resolveRunColors(
  runs: { id: string; name?: string; color_index?: number | null }[],
  overrides: Record<string, string> = {},
  dark = false,
) {
  const result: Record<string, string> = {};
  for (const run of runs)
    result[run.id] =
      run.color_index == null
        ? color(run.name ?? run.id, {}, dark)
        : runPalette[run.color_index % runPalette.length][dark ? 'dark' : 'light'];
  for (const [id, stored] of Object.entries(overrides))
    result[id] = resolvePaletteColor(stored, dark);
  return result;
}
