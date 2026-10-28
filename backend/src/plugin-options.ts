// Panel plugin settings contract: the host capabilities a panel uses and the typed options
// a plugin adds to the editor (docs/plugins.md#settings-and-options).
//
// Shared by the backend (manifest checks at install, option checks on every view write) and
// the frontend (editor controls, resolving the values a renderer receives). It has no
// dependencies, so the browser bundle imports it like expressions.ts.

/** Host settings a panel can declare. Unknown names refuse installation. */
export const commonCapabilities = [
  'axes',
  'yAxis',
  'outliers',
  'smoothing',
  'grouping',
  'legend',
  'legendLabels',
  'points',
  'lineWidth',
  'tooltip',
  'spread',
  'original',
  'expressions',
  // The host can show each run or group in its own cell (Layout: Grid).
  'cellLayout',
  // The plugin lays out items itself at the host's item size (media tiles).
  'itemLayout',
] as const;
export type Capability = (typeof commonCapabilities)[number];
export type OptionValue = number | boolean | string;
export type OptionScope = 'panel' | 'section' | 'workspace';
export type OptionTab = 'data' | 'axes' | 'smoothing' | 'grouping' | 'display';
/** Host controls an option can follow, in their order within each editor tab. */
export const optionAnchors: Record<OptionTab, readonly string[]> = {
  data: ['metrics', 'xAxis', 'title', 'section', 'shown', 'layout', 'resolution'],
  axes: ['xAxis', 'bounds', 'outliers'],
  smoothing: ['smoothing', 'original'],
  grouping: ['groupBy', 'aggregation', 'spread'],
  display: ['legend', 'points', 'lineWidth', 'tooltip', 'itemSize'],
};
/** Host settings an option's `enabledWhen` may test besides the plugin's own options. */
const hostConditions = ['legend', 'layout', 'smoothingMethod', 'groupBy'];
export type OptionDescriptor = {
  key: string;
  tab: OptionTab;
  after?: string;
  type: 'number' | 'integer' | 'boolean' | 'select' | 'text' | 'color';
  control?: 'slider' | 'input' | 'dropdown' | 'radio';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  choices?: { value: string | number; label: string }[];
  maxLength?: number;
  default: OptionValue;
  label: string;
  help?: string;
  scopes?: OptionScope[];
  inheritGroup?: string;
  enabledWhen?: { key: string; in: OptionValue[] };
};
/** Plugin defaults for host settings, used when no settings layer sets them. */
export type SettingsDefaults = { itemSize?: number };
export type PluginSettings = {
  common: Capability[];
  options: OptionDescriptor[];
  defaults?: SettingsDefaults;
};
export const optionLimits = {
  options: 32,
  choices: 50,
  radioChoices: 5,
  label: 128,
  text: 200,
  plugins: 64,
  catalogBytes: 65536,
};
export const pluginIdPattern = /^[a-z][a-z0-9-]{1,63}$/;
export const optionKeyPattern = /^[a-z][a-zA-Z0-9]{0,31}$/;
export const localeIdPattern = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const colorPattern = /^#[0-9a-fA-F]{6}$/;

/** Whether a stored or submitted value satisfies its descriptor. */
export function optionValid(option: OptionDescriptor, value: unknown): value is OptionValue {
  switch (option.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (option.type === 'number' || Number.isInteger(value)) &&
        (option.min === undefined || value >= option.min) &&
        (option.max === undefined || value <= option.max)
      );
    case 'select':
      return option.choices!.some((choice) => choice.value === value);
    case 'text':
      return typeof value === 'string' && value.length <= (option.maxLength ?? optionLimits.text);
    case 'color':
      return typeof value === 'string' && colorPattern.test(value);
  }
}
/**
 * The complete option values a renderer receives: each declared key from the stored layer
 * when it is valid, otherwise its default. Invalid stored keys are reported, never rewritten.
 */
export function resolveOptions(
  options: readonly OptionDescriptor[],
  stored: Record<string, OptionValue> = {},
) {
  const values: Record<string, OptionValue> = {},
    invalid: string[] = [];
  for (const option of options) {
    const has = Object.hasOwn(stored, option.key);
    if (has && optionValid(option, stored[option.key])) values[option.key] = stored[option.key];
    else {
      values[option.key] = option.default;
      if (has) invalid.push(option.key);
    }
  }
  return { values, invalid };
}
/** Whether an option's `enabledWhen` holds for the resolved option and host values. */
export function optionEnabled(
  option: OptionDescriptor,
  values: Record<string, OptionValue>,
  host: Record<string, unknown>,
) {
  if (!option.enabledWhen) return true;
  const { key, in: allowed } = option.enabledWhen;
  const value = Object.hasOwn(values, key) ? values[key] : host[key];
  return allowed.includes(value as OptionValue);
}

/**
 * The options of `tab` an editor places after the host control `anchor`, or at the end of
 * the tab when `anchor` is undefined. `shown` names the host controls the editor renders;
 * an option without `after`, or whose control is not shown, goes at the end.
 */
export function optionsAt(
  options: readonly OptionDescriptor[],
  tab: OptionTab,
  anchor: string | undefined,
  shown: ReadonlySet<string>,
) {
  return options.filter(
    (option) =>
      option.tab === tab &&
      (option.after !== undefined && shown.has(option.after) ? option.after : undefined) === anchor,
  );
}

type Plugin = { id: string; settings: PluginSettings };
type Layer = { options?: Record<string, Record<string, unknown>> } | undefined;
/**
 * The first submitted option that fails its installed plugin's descriptor. Undeclared keys,
 * plugins that are not installed and values unchanged from the stored layer are accepted, so
 * a plugin update or removal never makes existing views unsavable; the host shows such
 * values' defaults instead.
 */
export function invalidOption(
  layers: { settings: Layer; stored?: Layer }[],
  plugins: readonly Plugin[],
) {
  for (const { settings, stored } of layers)
    for (const [id, values] of Object.entries(settings?.options || {})) {
      const plugin = plugins.find((item) => item.id === id);
      if (!plugin) continue;
      for (const option of plugin.settings.options)
        if (
          Object.hasOwn(values, option.key) &&
          !optionValid(option, values[option.key]) &&
          values[option.key] !== stored?.options?.[id]?.[option.key]
        )
          return { plugin: id, key: option.key };
    }
}

const descriptorFields = new Set([
  'key',
  'tab',
  'after',
  'type',
  'control',
  'min',
  'max',
  'step',
  'unit',
  'choices',
  'maxLength',
  'default',
  'label',
  'help',
  'scopes',
  'inheritGroup',
  'enabledWhen',
]);
const isObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const messageKey = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= optionLimits.label;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
/**
 * Checks a manifest's `settings` and returns it in its complete form. `messages` is the
 * plugin's English catalog; every label it names must be there. Bundled plugins pass none:
 * their labels are randl catalog keys, checked by the localization tests.
 */
export function checkPluginSettings(
  settings: unknown,
  messages?: Record<string, string>,
): PluginSettings {
  if (settings === undefined) return { common: [], options: [] };
  const fail = (message: string): never => {
    throw Error('settings: ' + message);
  };
  if (!isObject(settings)) fail('must be an object with common and options');
  const value = settings as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!['common', 'options', 'defaults'].includes(key)) fail(`unknown field “${key}”`);
  const common = value.common ?? [],
    options = value.options ?? [];
  if (!Array.isArray(common)) fail('common must be an array');
  for (const name of common as unknown[])
    if (!commonCapabilities.includes(name as Capability)) fail(`unknown capability “${name}”`);
  if (new Set(common as unknown[]).size !== (common as unknown[]).length)
    fail('common repeats a capability');
  if ((common as unknown[]).includes('cellLayout') && (common as unknown[]).includes('itemLayout'))
    fail('common cannot declare both cellLayout and itemLayout');
  const defaults = value.defaults;
  if (defaults !== undefined) {
    if (!isObject(defaults)) fail('defaults must be an object');
    for (const [key, setting] of Object.entries(defaults as Record<string, unknown>))
      if (
        key !== 'itemSize' ||
        !Number.isInteger(setting) ||
        (setting as number) < 80 ||
        (setting as number) > 960
      )
        fail(`defaults: “${key}” must be itemSize, 80–960`);
  }
  if (!Array.isArray(options)) fail('options must be an array');
  const list = options as unknown[];
  if (list.length > optionLimits.options) fail(`at most ${optionLimits.options} options`);
  const keys = new Set<string>();
  for (const item of list) {
    if (!isObject(item)) fail('each option must be an object');
    const option = item as Record<string, any>,
      name = String(option.key);
    const refuse = (message: string): never => fail(`option “${name}” ${message}`);
    for (const field of Object.keys(option))
      if (!descriptorFields.has(field)) refuse(`has unknown field “${field}”`);
    if (typeof option.key !== 'string' || !optionKeyPattern.test(option.key))
      fail('option keys use a letter followed by up to 31 letters or digits');
    if (keys.has(name)) refuse('is declared twice');
    keys.add(name);
    if (!Object.hasOwn(optionAnchors, option.tab))
      refuse('needs tab data, axes, smoothing, grouping or display');
    if (
      option.after !== undefined &&
      !optionAnchors[option.tab as OptionTab].includes(option.after)
    )
      refuse(`cannot follow “${option.after}” in the ${option.tab} tab`);
    const numeric = option.type === 'number' || option.type === 'integer';
    if (!['number', 'integer', 'boolean', 'select', 'text', 'color'].includes(option.type))
      refuse('needs type number, integer, boolean, select, text or color');
    if (option.control !== undefined) {
      const controls = numeric
        ? ['slider', 'input']
        : option.type === 'select'
          ? ['dropdown', 'radio']
          : [];
      if (!controls.includes(option.control)) refuse(`cannot use control “${option.control}”`);
    }
    for (const bound of ['min', 'max', 'step'])
      if (option[bound] !== undefined && (!numeric || !finite(option[bound])))
        refuse(`${bound} must be a finite number on a numeric option`);
    if (option.control === 'slider' && (option.min === undefined || option.max === undefined))
      refuse('needs min and max for a slider');
    if (option.min !== undefined && option.max !== undefined && option.min >= option.max)
      refuse('needs min below max');
    if (option.step !== undefined && option.step <= 0) refuse('needs a positive step');
    if (option.unit !== undefined && (!numeric || !messageKey(option.unit)))
      refuse('unit must be a message key on a numeric option');
    if (option.type === 'select') {
      const choices = option.choices;
      if (!Array.isArray(choices) || !choices.length || choices.length > optionLimits.choices)
        refuse(`needs 1 to ${optionLimits.choices} choices`);
      if (option.control === 'radio' && choices.length > optionLimits.radioChoices)
        refuse(`radio buttons allow at most ${optionLimits.radioChoices} choices`);
      const seen = new Set();
      for (const choice of choices) {
        if (
          !isObject(choice) ||
          Object.keys(choice).some((key) => !['value', 'label'].includes(key)) ||
          !(typeof choice.value === 'string' || finite(choice.value)) ||
          !messageKey(choice.label)
        )
          refuse('choices are {value, label} with a string or number value');
        if (seen.has(choice.value)) refuse('repeats a choice value');
        seen.add(choice.value);
      }
    } else if (option.choices !== undefined) refuse('has choices but is not a select');
    if (option.maxLength !== undefined) {
      if (option.type !== 'text') refuse('has maxLength but is not text');
      if (
        !Number.isInteger(option.maxLength) ||
        option.maxLength < 1 ||
        option.maxLength > optionLimits.text
      )
        refuse(`maxLength must be 1 to ${optionLimits.text}`);
    }
    if (!messageKey(option.label))
      refuse(`needs a label key of at most ${optionLimits.label} characters`);
    if (option.help !== undefined && !messageKey(option.help)) refuse('help must be a message key');
    if (option.scopes !== undefined) {
      const scopes = option.scopes;
      if (
        !Array.isArray(scopes) ||
        !scopes.length ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => !['panel', 'section', 'workspace'].includes(scope))
      )
        refuse('scopes must list panel, section or workspace');
    }
    if (
      option.inheritGroup !== undefined &&
      (typeof option.inheritGroup !== 'string' || !optionKeyPattern.test(option.inheritGroup))
    )
      refuse('inheritGroup must be an identifier');
    if (option.default === undefined || !optionValid(option as OptionDescriptor, option.default))
      refuse('needs a default that satisfies the option');
    if (messages)
      for (const key of [
        option.label,
        option.help,
        option.unit,
        ...(option.choices || []).map((c: any) => c.label),
      ])
        if (key !== undefined && typeof messages[key] !== 'string')
          refuse(`names “${key}”, which locales.en does not define`);
  }
  for (const item of list) {
    const option = item as OptionDescriptor;
    if (option.enabledWhen === undefined) continue;
    const condition = option.enabledWhen as unknown;
    if (
      !isObject(condition) ||
      Object.keys(condition).some((key) => !['key', 'in'].includes(key)) ||
      !(keys.has(condition.key) || hostConditions.includes(condition.key)) ||
      condition.key === option.key ||
      !Array.isArray(condition.in) ||
      !condition.in.length ||
      condition.in.some((value: unknown) => !['string', 'number', 'boolean'].includes(typeof value))
    )
      fail(
        `option “${option.key}” enabledWhen must name another option or ${hostConditions.join(', ')} with values`,
      );
  }
  return {
    common: common as Capability[],
    options: list as OptionDescriptor[],
    ...(defaults ? { defaults: defaults as SettingsDefaults } : {}),
  };
}
/** Checks a manifest's `locales` map: locale IDs to catalog paths inside the plugin. */
export function checkLocaleMap(locales: unknown): Record<string, string> {
  if (locales === undefined) return {};
  if (!isObject(locales)) throw Error('locales must map locale IDs to JSON files');
  for (const [id, path] of Object.entries(locales))
    if (!localeIdPattern.test(id) || typeof path !== 'string' || !path.endsWith('.json'))
      throw Error(`locales: “${id}” must name a .json file`);
  return locales as Record<string, string>;
}
/** Checks one parsed plugin catalog: a flat map of string keys to string messages. */
export function checkCatalog(id: string, catalog: unknown): Record<string, string> {
  if (!isObject(catalog) || Object.values(catalog).some((value) => typeof value !== 'string'))
    throw Error(`locales: ${id} must be a flat map of strings`);
  return catalog as Record<string, string>;
}
