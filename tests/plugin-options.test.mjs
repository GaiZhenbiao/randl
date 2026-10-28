import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  checkPluginSettings,
  invalidOption,
  optionEnabled,
  optionAnchors,
  optionsAt,
  resolveOptions,
} from '../backend/dist/plugin-options.js';
import { builtins } from '../backend/dist/plugins.js';

const en = {
  'options.size.label': 'Size',
  'options.size.unit': 'px',
  'options.mode.label': 'Mode',
  'options.mode.a': 'A',
  'options.mode.b': 'B',
};
const size = {
  key: 'size',
  tab: 'display',
  type: 'integer',
  control: 'slider',
  min: 0,
  max: 8,
  unit: 'options.size.unit',
  default: 2,
  label: 'options.size.label',
};
const mode = {
  key: 'mode',
  tab: 'display',
  after: 'legend',
  type: 'select',
  control: 'radio',
  default: 'a',
  label: 'options.mode.label',
  choices: [
    { value: 'a', label: 'options.mode.a' },
    { value: 'b', label: 'options.mode.b' },
  ],
};
const settings = (options, common = []) => ({ common, options });

test('option descriptors are checked when a plugin is installed', () => {
  const accepted = checkPluginSettings(settings([size, mode], ['legend']), en);
  assert.deepEqual(accepted.common, ['legend']);
  assert.equal(accepted.options.length, 2);
  assert.deepEqual(checkPluginSettings(undefined), { common: [], options: [] });
  assert.deepEqual(
    checkPluginSettings({ ...settings([], ['itemLayout']), defaults: { itemSize: 200 } }),
    {
      common: ['itemLayout'],
      options: [],
      defaults: { itemSize: 200 },
    },
  );
  const refused = [
    [settings([{ ...size, min: 8, max: 2 }]), /min below max/],
    [settings([{ ...size, default: 9 }]), /default/],
    [settings([size, size]), /declared twice/],
    [settings([{ ...mode, after: 'smoothing' }]), /cannot follow/],
    [settings([{ ...size, label: 'options.missing' }]), /locales.en does not define/],
    [
      settings(Array.from({ length: 33 }, (_, i) => ({ ...size, key: 'size' + i }))),
      /at most 32 options/,
    ],
    [settings([], ['ratio']), /unknown capability/],
    [{ common: [], options: [], extra: true }, /unknown field/],
    [settings([{ ...size, control: 'slider', min: undefined }]), /min and max/],
    [
      settings([
        {
          ...mode,
          choices: [
            ...mode.choices,
            ...['c', 'd', 'e', 'f'].map((value) => ({ value, label: 'options.mode.a' })),
          ],
        },
      ]),
      /at most 5/,
    ],
    [settings([{ ...size, enabledWhen: { key: 'resolution', in: ['high'] } }]), /enabledWhen/],
    [settings([{ ...size, scopes: ['everywhere'] }]), /scopes/],
    [settings([], ['cellLayout', 'itemLayout']), /both cellLayout and itemLayout/],
    [{ ...settings([]), defaults: { itemSize: 40 } }, /itemSize, 80–960/],
    [{ ...settings([]), defaults: { legend: false } }, /itemSize, 80–960/],
  ];
  for (const [value, message] of refused)
    assert.throws(() => checkPluginSettings(value, en), message);
  for (const plugin of builtins)
    assert.deepEqual(checkPluginSettings(plugin.settings), plugin.settings);
});

test('stored option values resolve to defaults when invalid, without rewriting them', () => {
  const stored = { size: 12, mode: 'b', removed: true };
  const { values, invalid } = resolveOptions([size, mode], stored);
  assert.deepEqual(values, { size: 2, mode: 'b' });
  assert.deepEqual(invalid, ['size']);
  assert.deepEqual(stored, { size: 12, mode: 'b', removed: true });
  assert.deepEqual(resolveOptions([size]).values, { size: 2 });
  const accent = { ...size, enabledWhen: { key: 'mode', in: ['b'] } };
  assert.equal(optionEnabled(accent, { mode: 'a' }, {}), false);
  assert.equal(optionEnabled(accent, { mode: 'b' }, {}), true);
  assert.equal(
    optionEnabled({ ...size, enabledWhen: { key: 'legend', in: [false] } }, {}, { legend: false }),
    true,
  );
});

test('writes check installed plugins only, and only their declared keys', () => {
  const plugins = [{ id: 'stat-card', settings: settings([size, mode]) }];
  const layer = (values) => ({ settings: { options: { 'stat-card': values } } });
  assert.deepEqual(invalidOption([layer({ size: 1.5 })], plugins), {
    plugin: 'stat-card',
    key: 'size',
  });
  assert.equal(invalidOption([layer({ size: 3, other: 'x' })], plugins), undefined);
  assert.equal(
    invalidOption(
      [{ settings: { options: { missing: { size: 'x' } } } }, { settings: undefined }],
      plugins,
    ),
    undefined,
  );
  // A stored value a later revision refuses does not block unrelated edits.
  assert.equal(
    invalidOption([{ ...layer({ size: 30 }), stored: layer({ size: 30 }).settings }], plugins),
    undefined,
  );
  assert.deepEqual(
    invalidOption([{ ...layer({ size: 31 }), stored: layer({ size: 30 }).settings }], plugins),
    { plugin: 'stat-card', key: 'size' },
  );
});

test('options follow a shown host control, or else go at the end of their tab', () => {
  const video = builtins.find((plugin) => plugin.id === 'video').settings.options;
  const keys = (list) => list.map((option) => option.key);
  // Loop and Autoplay follow Item size in a grid; in Coverflow, without it, they end the tab.
  const grid = new Set(['itemSize']),
    coverflow = new Set();
  assert.deepEqual(keys(optionsAt(video, 'display', 'itemSize', grid)), ['loop', 'autoplay']);
  assert.deepEqual(keys(optionsAt(video, 'display', undefined, grid)), []);
  assert.deepEqual(keys(optionsAt(video, 'display', 'itemSize', coverflow)), []);
  assert.deepEqual(keys(optionsAt(video, 'display', undefined, coverflow)), ['loop', 'autoplay']);
  assert.deepEqual(keys(optionsAt(video, 'data', undefined, grid)), []);
  // Options without an anchor always end their tab; each option has exactly one place.
  const options = [size, { ...mode, after: 'points' }, { ...size, key: 'width', after: 'legend' }];
  const shown = new Set(['legend']);
  const places = [undefined, ...optionAnchors.display].map((anchor) =>
    keys(optionsAt(options, 'display', anchor, shown)),
  );
  assert.deepEqual(places.flat().sort(), ['mode', 'size', 'width']);
  assert.deepEqual(places[0], ['size', 'mode']);
  assert.deepEqual(keys(optionsAt(options, 'display', 'legend', shown)), ['width']);
});

test('the bundled media options default to fitted, smooth images and looping autoplay', () => {
  const defaults = (id) =>
    resolveOptions(builtins.find((plugin) => plugin.id === id).settings.options, undefined).values;
  assert.deepEqual(defaults('image'), { fit: 'contain', smooth: true });
  assert.deepEqual(defaults('video'), { loop: true, autoplay: true });
});

test('the stat-card example declares a caller for every descriptor feature', async () => {
  const directory = new URL('../examples/plugins/stat-card/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('panel.json', directory), 'utf8'));
  const english = JSON.parse(await readFile(new URL('locales/en.json', directory), 'utf8'));
  const french = JSON.parse(await readFile(new URL('locales/fr.json', directory), 'utf8'));
  const checked = checkPluginSettings(manifest.settings, english);
  const features = new Set(
    checked.options.flatMap((option) => [
      option.type + ':' + (option.control || ''),
      ...(option.unit ? ['unit'] : []),
      ...(option.enabledWhen ? ['enabledWhen'] : []),
      ...(option.inheritGroup ? ['inheritGroup'] : []),
      ...(option.scopes ? ['scopes'] : []),
      ...(option.after ? ['after'] : []),
    ]),
  );
  for (const feature of [
    'integer:slider',
    'select:',
    'number:',
    'color:',
    'text:',
    'unit',
    'enabledWhen',
    'inheritGroup',
    'scopes',
    'after',
  ])
    assert.ok(features.has(feature), feature);
  assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
});

test('plugin catalogs resolve the interface language, then English, then the key', async () => {
  const ts = (await import('typescript')).default;
  const source = await readFile(
    new URL('../frontend/src/plugins/catalogs.ts', import.meta.url),
    'utf8',
  );
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { pluginLocalizer } = await import(
    'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
  );
  const files = {
    'locales/en.json': { 'options.size': 'Size', 'options.count': '{count} items' },
    'locales/fr.json': { 'options.size': 'Taille' },
  };
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    const file = url.split('/source/')[1];
    return { ok: !!files[file], json: async () => files[file] };
  };
  const plugin = {
    id: 'card',
    revision: 'r1',
    builtin: false,
    enabled: true,
    locales: { en: 'locales/en.json', fr: 'locales/fr.json' },
  };
  const french = await pluginLocalizer(plugin, 'fr');
  assert.equal(french('options.size'), 'Taille');
  assert.equal(french('options.count', { count: 12 }), '12 items');
  assert.equal(french('charts.tooltip.more'), 'charts.tooltip.more');
  // Region tags fall back to their language; catalogs are fetched once per revision.
  assert.equal((await pluginLocalizer(plugin, 'fr-CA'))('options.size'), 'Taille');
  assert.equal((await pluginLocalizer({ ...plugin }, 'ja'))('options.size'), 'Size');
  assert.deepEqual(requested, [
    '/api/plugins/card/revisions/r1/source/locales/fr.json',
    '/api/plugins/card/revisions/r1/source/locales/en.json',
  ]);
  delete globalThis.fetch;
});
