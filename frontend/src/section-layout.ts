export const gap = 16;
export function columnLimit(width: number, count: number) {
  return Math.max(1, Math.min(6, count, Math.floor((width + gap) / 256)));
}
export function columnsFor(width: number, desired: number, count: number) {
  return Math.max(
    1,
    Math.min(columnLimit(width, count), Math.round((width + gap) / (desired + gap))),
  );
}
export function cardWidth(width: number, columns: number) {
  return (width - (columns - 1) * gap) / columns;
}
