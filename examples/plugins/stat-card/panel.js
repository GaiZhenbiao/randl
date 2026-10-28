export function create({ element, apiVersion }) {
  if (apiVersion !== 1) throw new Error('Requires panel API v1');
  return {
    // The host shares read-only data between panels; copy arrays before transforming.
    // `options` holds this plugin's declared options, resolved and defaulted by the host.
    update({ data, panel, locale, options, localize }) {
      const format = new Intl.NumberFormat(locale, {
        minimumFractionDigits: options.decimals,
        maximumFractionDigits: options.decimals,
      });
      const fragment = document.createDocumentFragment();
      for (const series of data.series) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:12px 16px;display:flex;justify-content:space-between;gap:16px';
        const name = document.createElement('span');
        name.textContent = series.name;
        name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const value = document.createElement('strong');
        const latest = series.values[panel.metric]?.at(-1)?.[1];
        const above = options.trend === 'arrow' && latest !== undefined && latest > options.threshold;
        // The prefix is user text: set it as text, never as HTML.
        value.textContent =
          latest === undefined
            ? localize('panel.noData')
            : (above ? '▲ ' : '') + options.prefix + format.format(latest);
        if (above) value.style.color = options.accent;
        row.append(name, value);
        fragment.append(row);
      }
      element.style.overflow = 'auto';
      element.replaceChildren(fragment);
    },
    resize() {},
    destroy() { element.replaceChildren(); element.style.removeProperty('overflow'); },
  };
}
