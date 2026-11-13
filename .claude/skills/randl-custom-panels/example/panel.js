// A minimal randl panel plugin: each run's latest value of one metric, as a bar in the run's
// colour. It shows the parts every panel needs: the lifecycle, theme-aware colours, linked
// hover that never re-renders, and cleanup.
export function create({ element, apiVersion, onHover }) {
  if (apiVersion !== 1) throw new Error('Requires panel API v1');
  const list = document.createElement('div');
  list.style.cssText =
    'height:100%;overflow:auto;box-sizing:border-box;padding:8px 12px;font-size:12px;line-height:20px';
  element.append(list);

  // Linked hover: tell the host which run is under the pointer, once per change.
  let hovered = null;
  const hover = (id) => {
    if (id === hovered) return;
    hovered = id;
    onHover?.(id ? [id] : []);
  };
  const over = (event) => hover(event.target.closest('[data-run]')?.dataset.run ?? null);
  const leave = () => hover(null);
  list.addEventListener('pointerover', over);
  list.addEventListener('pointerleave', leave);

  return {
    // Called with new data, settings, theme or language. The host shares `data` read-only
    // between panels: read it, never sort or change its arrays in place.
    update({ data, panel, options, colors, dark, locale, localize }) {
      const rows = [];
      for (const series of data.series) {
        if (series.pending) continue; // still streaming in
        const value = series.values[panel.metric]?.at(-1)?.[1];
        if (typeof value === 'number' && Number.isFinite(value))
          rows.push({ id: series.id, name: series.name, value });
      }
      rows.sort(
        options.order === 'name'
          ? (a, b) => a.name.localeCompare(b.name, locale)
          : (a, b) => b.value - a.value,
      );
      if (!rows.length) {
        list.textContent = localize('panel.noData');
        return;
      }
      // Carbon variables resolve in the dashboard but are not plugin API: always fall back on `dark`.
      const text = `var(--cds-text-primary, ${dark ? '#f4f4f4' : '#161616'})`;
      const track = `var(--cds-layer-accent-01, ${dark ? '#393939' : '#e0e0e0'})`;
      const largest = Math.max(...rows.map((row) => Math.abs(row.value))) || 1;
      const format = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });
      const fragment = document.createDocumentFragment();
      for (const row of rows) {
        const line = document.createElement('div');
        line.dataset.run = row.id;
        line.style.cssText = `display:grid;grid-template-columns:minmax(0,1fr) 40% auto;gap:8px;align-items:center;color:${text}`;
        const name = document.createElement('span');
        name.textContent = row.name; // logged text: set as text, never as HTML
        name.title = row.name;
        name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const bar = document.createElement('span');
        bar.style.cssText = `height:8px;background:${track}`;
        const fill = document.createElement('span');
        fill.style.cssText = `display:block;height:100%;width:${(100 * Math.abs(row.value)) / largest}%;background:${colors[row.id] ?? text}`;
        bar.append(fill);
        const value = document.createElement('span');
        value.textContent = format.format(row.value);
        value.style.fontVariantNumeric = 'tabular-nums';
        line.append(name, bar, value);
        fragment.append(line);
      }
      list.replaceChildren(fragment);
    },
    // Hover from this or another panel: restyle existing rows only, so hovering stays cheap.
    highlightRuns(ids) {
      for (const line of list.children)
        line.style.opacity = ids.length && !ids.includes(line.dataset.run) ? '0.35' : '';
    },
    resize() {}, // the rows reflow with the element
    destroy() {
      list.removeEventListener('pointerover', over);
      list.removeEventListener('pointerleave', leave);
      element.replaceChildren();
    },
  };
}
