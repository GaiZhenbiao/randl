export function seriesLabel(element: HTMLElement, name: string, full = false) {
  element.replaceChildren();
  element.title = name;
  element.classList.toggle('series-label-full', full);
  element.classList.toggle('series-label-cropped', !full);
  if (full) {
    element.textContent = name;
    return;
  }
  const chars = Array.from(name),
    split = Math.max(0, chars.length - Math.min(8, Math.ceil(chars.length * 0.4))),
    start = document.createElement('span'),
    end = document.createElement('span');
  start.textContent = chars.slice(0, split).join('');
  const suffix = document.createElement('span');
  suffix.textContent = chars.slice(split).join('');
  end.append(suffix);
  element.append(start, end);
}
