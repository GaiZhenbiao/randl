import type { Plugin, PlotSettings } from './types';
import type { OptionValue } from '../../backend/src/plugin-options';
import { smoothingParameters, type Smoothing } from './chart-math';

// Plot settings cascade from the workspace to a section to a panel. A layer that
// omits a key inherits it; `null` axis bounds and run limits are explicit values
// meaning "automatic" and "all". Smoothing, grouping and outlier percentile keys belong
// together, so a layer that sets any key of those groups replaces the whole group.
// Plugin options (`options[pluginId][key]`) cascade the same way, key by key, and the
// keys of one `inheritGroup` replace each other together.
export type SettingsScope = 'workspace' | 'section' | 'panel';
export type SettingsSource = SettingsScope | 'default';
export type SettingsLayer = { scope: SettingsScope; settings?: PlotSettings };
type Key = Exclude<keyof PlotSettings, 'options'>;
/** A host setting, or a plugin option named `options.<plugin>.<key>`. */
export type SettingKey = Key | `options.${string}.${string}`;
export type Sources = Partial<Record<SettingKey, SettingsSource>>;
type Descriptors = Pick<Plugin, 'id' | 'settings'>[];

export const settingGroups: Key[][] = [
  ['smoothingMethod', 'smoothingValue'],
  ['groupBy', 'aggregation', 'spread'],
  ['outlierLower', 'outlierUpper'],
];
export const optionKey = (plugin: string, key: string): SettingKey => `options.${plugin}.${key}`;
function parseOption(key: SettingKey) {
  if (!key.startsWith('options.')) return;
  const [, plugin, name] = key.split('.');
  return { plugin, name };
}
/** The keys that override and reset together with `key`. */
export function groupOf(key: SettingKey, plugins: Descriptors = []): SettingKey[] {
  const option = parseOption(key);
  if (!option) return settingGroups.find((group) => group.includes(key as Key)) || [key];
  const options = plugins.find((p) => p.id === option.plugin)?.settings.options || [],
    group = options.find((item) => item.key === option.name)?.inheritGroup;
  return group
    ? options
        .filter((item) => item.inheritGroup === group)
        .map((item) => optionKey(option.plugin, item.key))
    : [key];
}
/** A layer's own value for a host setting or plugin option. */
export function settingValue(settings: PlotSettings, key: SettingKey): unknown {
  const option = parseOption(key);
  return option ? settings.options?.[option.plugin]?.[option.name] : settings[key as Key];
}
/** A copy of `settings` with `key` set, or removed when `value` is undefined. */
export function withSetting(settings: PlotSettings, key: SettingKey, value: unknown) {
  const option = parseOption(key),
    next: PlotSettings = { ...settings };
  if (!option) {
    if (value === undefined) delete next[key as Key];
    else Object.assign(next, { [key]: value });
    return next;
  }
  const values = { ...next.options?.[option.plugin] };
  if (value === undefined) delete values[option.name];
  else values[option.name] = value as OptionValue;
  const options = { ...next.options, [option.plugin]: values };
  if (!Object.keys(values).length) delete options[option.plugin];
  if (Object.keys(options).length) next.options = options;
  else delete next.options;
  return next;
}
export function defaultSmoothingValue(method: string | undefined) {
  return method && method !== 'none'
    ? smoothingParameters[method as Exclude<Smoothing, 'none'>].value
    : 0;
}

/**
 * `defaults` are the panel plugin's own defaults for host settings (such as a media item
 * size); they apply only when no layer sets the key, so the source stays "default".
 */
export function resolvePlotSettings(
  layers: SettingsLayer[],
  plugins: Descriptors = [],
  defaults: Partial<PlotSettings> = {},
) {
  let settings: PlotSettings = {};
  const sources: Sources = {};
  for (const { scope, settings: layer = {} } of layers) {
    const keys: SettingKey[] = [
      ...(Object.keys(layer) as (keyof PlotSettings)[]).filter(
        (key): key is Key => key !== 'options' && layer[key] !== undefined,
      ),
      ...Object.entries(layer.options || {}).flatMap(([plugin, values]) =>
        Object.keys(values)
          .filter((key) => values[key] !== undefined)
          .map((key) => optionKey(plugin, key)),
      ),
    ];
    for (const key of keys)
      for (const member of groupOf(key, plugins)) {
        settings = withSetting(settings, member, undefined);
        delete sources[member];
      }
    for (const key of keys) {
      settings = withSetting(settings, key, settingValue(layer, key));
      sources[key] = scope;
    }
  }
  for (const [key, value] of Object.entries(defaults) as [Key, unknown][])
    if (settings[key] === undefined) {
      settings = withSetting(settings, key, value);
      sources[key] = 'default';
    }
  if (!settings.smoothingMethod) {
    settings.smoothingMethod = 'none';
    sources.smoothingMethod = 'default';
  }
  if (settings.smoothingMethod !== 'none' && settings.smoothingValue === undefined) {
    settings.smoothingValue = defaultSmoothingValue(settings.smoothingMethod);
    sources.smoothingValue = sources.smoothingMethod;
  }
  return { settings, sources };
}

// The most specific source among keys shown by one control.
export function sourceOf(sources: Sources, keys: SettingKey[]) {
  const order: SettingsSource[] = ['panel', 'section', 'workspace'];
  return order.find((scope) => keys.some((key) => sources[key] === scope)) || 'default';
}
