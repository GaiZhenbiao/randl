import type { MessageKey } from './i18n';
export const accents: [MessageKey, string][] = [
  ['app.settings.accent.carbonBlue', '#0f62fe'],
  ['app.settings.accent.indigo', '#3f51b5'],
  ['app.settings.accent.blue', '#2196f3'],
  ['app.settings.accent.teal', '#009688'],
  ['app.settings.accent.green', '#4caf50'],
  ['app.settings.accent.purple', '#9c27b0'],
  ['app.settings.accent.pink', '#e91e63'],
  ['app.settings.accent.red', '#f44336'],
  ['app.settings.accent.orange', '#ff9800'],
  ['app.settings.accent.amber', '#ffc107'],
];
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export function luminance(hex: string) {
  return rgb(hex)
    .map((x) => {
      const s = x / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function mix(hex: string, toward: number, amount: number) {
  return (
    '#' +
    rgb(hex)
      .map((x) =>
        Math.round(x + (toward - x) * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
export function palette(seed: string, dark: boolean) {
  const surface = dark ? '#262626' : '#f4f4f4';
  let primary = seed;
  for (let i = 0; contrast(primary, surface) < 4.6 && i < 20; i++)
    primary = mix(seed, dark ? 255 : 0, (i + 1) / 20);
  const onPrimary =
    contrast(primary, '#ffffff') > contrast(primary, '#000000') ? '#ffffff' : '#000000';
  return {
    primary,
    onPrimary,
    hover: mix(primary, dark ? 255 : 0, 0.1),
    active: mix(primary, dark ? 255 : 0, 0.2),
  };
}
