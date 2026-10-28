import type { Values } from '../i18n';
import type { Plugin } from '../types';

// External plugins bring message catalogs for their option labels and renderer text.
// They load from the plugin's revisioned source on first use and stay cached per
// plugin revision and locale.
const cache = new Map<string, Promise<Record<string, string>>>();
const cacheLimit = 16;
function catalogFile(plugin: Plugin, locale: string) {
  const locales = plugin.locales || {};
  return locales[locale] ?? locales[locale.split('-')[0]];
}
function load(plugin: Plugin, file: string) {
  const id = plugin.id + '@' + plugin.revision + ':' + file;
  let hit = cache.get(id);
  if (hit) cache.delete(id);
  else {
    hit = fetch(
      `/api/plugins/${encodeURIComponent(plugin.id)}/revisions/${encodeURIComponent(plugin.revision!)}/source/${file}`,
    ).then((response) => (response.ok ? response.json() : {}));
    hit.catch(() => cache.delete(id));
  }
  cache.set(id, hit);
  while (cache.size > cacheLimit) cache.delete(cache.keys().next().value!);
  return hit;
}
export type Localize = (key: string, values?: Values) => string;
/**
 * The plugin's messages for `locale`: its catalog for that language, then its English
 * catalog, then the key itself. A plugin catalog never resolves randl's own keys.
 */
export async function pluginLocalizer(plugin: Plugin, locale: string): Promise<Localize> {
  const files = [catalogFile(plugin, locale), catalogFile(plugin, 'en')].filter(
      (file, index, all): file is string => !!file && all.indexOf(file) === index,
    ),
    catalogs: Record<string, string>[] =
      plugin.builtin || !plugin.enabled
        ? []
        : await Promise.all(files.map((file) => load(plugin, file).catch(() => ({})))),
    numbers = new Intl.NumberFormat(locale);
  return (key, values = {}) => {
    const text = catalogs.find((catalog) => typeof catalog[key] === 'string')?.[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (token: string, name: string) => {
      const value = values[name];
      return value === undefined
        ? token
        : typeof value === 'number'
          ? numbers.format(value)
          : value;
    });
  };
}
