// Widths people give sidebars by dragging their edge (SidebarResize.svelte), remembered per
// sidebar in this browser. Storage may be unavailable (private windows, blocked site data):
// then widths last until the page reloads.
const prefix = 'randl.sidebar-width';
const keyOf = (id: string) => (id === 'runs' ? prefix : prefix + '.' + id);

/** The width last chosen for sidebar `id`, or null when none was (or storage is unavailable). */
export function loadWidth(id: string): number | null {
  try {
    const value = Number(localStorage.getItem(keyOf(id)));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveWidth(id: string, width: number) {
  try {
    localStorage.setItem(keyOf(id), String(Math.round(width)));
  } catch {
    // Not remembered; the width still applies until the page reloads.
  }
}
