import { promises as fs } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from './db.js';
import {
  checkCatalog,
  checkLocaleMap,
  checkPluginSettings,
  optionLimits,
  pluginIdPattern,
  type Capability,
  type OptionDescriptor,
} from './plugin-options.js';
const exec = promisify(execFile);
// Bundled options name randl catalog keys; external plugins name their own catalogs.
const mediaOptions: Record<string, OptionDescriptor[]> = {
  image: [
    {
      key: 'fit',
      tab: 'display',
      after: 'itemSize',
      type: 'select',
      control: 'radio',
      default: 'contain',
      label: 'panelSettings.display.media.fit.label',
      choices: [
        { value: 'contain', label: 'panelSettings.display.media.fit.contain' },
        { value: 'cover', label: 'panelSettings.display.media.fit.cover' },
      ],
    },
    {
      key: 'smooth',
      tab: 'display',
      after: 'itemSize',
      type: 'boolean',
      default: true,
      label: 'panelSettings.display.media.smooth',
    },
  ],
  video: [
    {
      key: 'loop',
      tab: 'display',
      after: 'itemSize',
      type: 'boolean',
      default: true,
      label: 'panelSettings.display.media.loop',
    },
    {
      key: 'autoplay',
      tab: 'display',
      after: 'itemSize',
      type: 'boolean',
      default: true,
      label: 'panelSettings.display.media.autoplay.label',
      help: 'panelSettings.display.media.autoplay.help',
    },
  ],
};
export const builtins = [
  ['line', 'Line plot'],
  ['area', 'Area plot'],
  ['stacked-area', 'Stacked area'],
  ['percent-area', 'Percent area'],
  ['bar', 'Bar chart'],
  ['scatter', 'Scatter plot'],
  ['scatter-history', 'History scatter'],
  ['parallel', 'Parallel coordinates'],
  ['image', 'Images'],
  ['audio', 'Audio'],
  ['video', 'Video'],
  ['table', 'Table'],
  ['histogram', 'Histogram'],
].map(([id, name]) => ({
  id,
  name,
  version: '1.0.0',
  apiVersion: 1,
  builtin: true,
  dataKind: ['image', 'audio', 'video', 'table', 'histogram'].includes(id)
    ? 'media'
    : ['bar', 'scatter', 'parallel'].includes(id)
      ? 'snapshot'
      : 'scalar',
  metricTypes:
    (
      {
        image: ['image-file', 'images/separated'],
        audio: ['audio-file', 'audio'],
        video: ['video-file', 'videos'],
        table: ['table-file'],
        histogram: ['histogram'],
      } as Record<string, string[]>
    )[id] ||
    (['bar', 'scatter', 'parallel'].includes(id)
      ? ['scalar', 'number', ...(id === 'bar' ? [] : ['category'])]
      : ['scalar']),
  metricSelection: ['scatter', 'scatter-history'].includes(id)
    ? 'xy'
    : id === 'parallel'
      ? 'axes'
      : ['image', 'audio', 'video', 'table', 'histogram'].includes(id)
        ? 'single'
        : 'multiple',
  // Several metrics in one stacked panel are aligned within each record by the host request.
  ...(id === 'stacked-area' || id === 'percent-area'
    ? {
        recordTransform: {
          kind: 'align',
          normalization: id === 'percent-area' ? 'percent' : 'none',
        },
      }
    : {}),

  settings: {
    common: (['line', 'area', 'stacked-area', 'percent-area'].includes(id)
      ? [
          'axes',
          'smoothing',
          'grouping',
          'legend',
          'legendLabels',
          'points',
          'lineWidth',
          'tooltip',
          'expressions',
          'outliers',
          ...(['line', 'area'].includes(id) ? ['spread', 'original'] : []),
          'cellLayout',
        ]
      : ['scatter', 'scatter-history'].includes(id)
        ? [
            'axes',
            'outliers',
            'grouping',
            'legend',
            'legendLabels',
            'tooltip',
            ...(id === 'scatter-history' ? ['cellLayout'] : []),
          ]
        : id === 'parallel'
          ? ['grouping', 'legend', 'legendLabels', 'lineWidth']
          : id === 'bar'
            ? ['yAxis', 'outliers', 'grouping', 'legend', 'tooltip']
            : id === 'histogram'
              ? ['outliers']
              : ['image', 'audio', 'video'].includes(id)
                ? ['itemLayout']
                : []) as Capability[],
    options: mediaOptions[id] || [],
    ...(['image', 'audio', 'video'].includes(id) ? { defaults: { itemSize: 200 } } : {}),
  },
  enabled: true,
  renderer: ['image', 'audio', 'video', 'table'].includes(id) ? 'dom' : 'echarts',
}));
export function contained(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
export class Plugins {
  root: string;
  constructor(
    readonly db: DB,
    directory: string,
  ) {
    this.root = join(directory, 'plugins');
  }
  async list() {
    const bundled = await Promise.all(
      builtins.map(async (plugin) => ({
        ...plugin,
        enabled: (await this.db.call('settingGet', 'plugin.enabled:' + plugin.id)) !== false,
      })),
    );
    return [...bundled, ...(await this.db.call('plugins'))];
  }
  async install(source: string, expectedId?: string) {
    const tmp = await fs.mkdtemp(join(tmpdir(), 'randl-plugin-'));
    let path = resolve(source),
      revision = 'local';
    try {
      if (source.startsWith('https://')) {
        const u = new URL(source);
        if (
          u.hostname !== 'github.com' ||
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          !/^\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname)
        )
          throw Error('Use an HTTPS GitHub repository root URL');
        path = join(tmp, 'source');
        await exec(
          'git',
          ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth=1', '--', source, path],
          { timeout: 90000 },
        );
        revision = (await exec('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim();
      } else if (source.includes('://'))
        throw Error('Only local source directories and HTTPS GitHub URLs are supported');
      const manifestPath = join(path, 'panel.json'),
        stat = await fs.lstat(manifestPath);
      if (stat.isSymbolicLink() || stat.size > 65536) throw Error('Invalid manifest');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!pluginIdPattern.test(manifest.id) || builtins.some((p) => p.id === manifest.id))
        throw Error('Invalid or reserved plugin id');
      if (
        manifest.apiVersion !== 1 ||
        typeof manifest.name !== 'string' ||
        typeof manifest.version !== 'string' ||
        typeof manifest.entry !== 'string'
      )
        throw Error('Manifest requires id, name, version, apiVersion: 1 and entry');
      const transform = manifest.recordTransform;
      if (
        transform !== undefined &&
        (transform?.kind !== 'align' ||
          !['none', 'percent'].includes(transform.normalization) ||
          Object.keys(transform).length !== 2)
      )
        throw Error('recordTransform must be {"kind": "align", "normalization": "none" or "percent"}');
      // Catalogs are flat string maps inside the source; option labels must be in English.
      const locales = checkLocaleMap(manifest.locales),
        catalogs: Record<string, Record<string, string>> = {};
      for (const [id, file] of Object.entries(locales)) {
        const target = resolve(path, file);
        if (!contained(path, target)) throw Error(`locales: ${id} must be inside the source directory`);
        const info = await fs.lstat(target).catch(() => undefined);
        if (!info?.isFile()) throw Error(`locales: ${id} names ${file}, which is not a file`);
        if (info.size > optionLimits.catalogBytes) throw Error(`locales: ${id} exceeds 64 KiB`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await fs.readFile(target, 'utf8'));
        } catch {
          throw Error(`locales: ${id} is not valid JSON`);
        }
        catalogs[id] = checkCatalog(id, parsed);
      }
      const options = manifest.settings?.options;
      if (Array.isArray(options) && options.length && !catalogs.en)
        throw Error('settings: options require an English catalog in locales.en');
      manifest.settings = checkPluginSettings(manifest.settings, catalogs.en);
      const entry = resolve(path, manifest.entry);
      if (!contained(path, entry) || !entry.endsWith('.js') || !(await fs.stat(entry)).isFile())
        throw Error('entry must be a JavaScript module inside the source directory');
      const existing = (await this.list()).find((p) => p.id === manifest.id);
      if (expectedId && manifest.id !== expectedId)
        throw Error('Updated manifest id does not match the installed plugin');
      if (existing && !expectedId) throw Error('Plugin already installed; use update');
      const staging = join(tmp, 'staged');
      await fs.mkdir(staging);
      let bytes = 0;
      const digest = createHash('sha256');
      const copy = async (dir: string) => {
        for (const item of await fs.readdir(dir, { withFileTypes: true })) {
          if (['.git', 'node_modules'].includes(item.name)) continue;
          const file = join(dir, item.name),
            target = join(staging, relative(path, file));
          if (item.isSymbolicLink()) throw Error('Plugin source must not contain symlinks');
          if (item.isDirectory()) {
            await fs.mkdir(target, { recursive: true });
            await copy(file);
          } else if (item.isFile()) {
            bytes += (await fs.stat(file)).size;
            if (bytes > 20 * 1024 * 1024) throw Error('Plugin exceeds 20 MiB');
            const content = await fs.readFile(file);
            digest.update(relative(path, file));
            digest.update(content);
            await fs.writeFile(target, content);
          }
        }
      };
      await copy(path);
      if (source.startsWith('https://')) manifest.sourceCommit = revision;
      revision = digest.digest('hex');
      await fs.mkdir(this.root, { recursive: true });
      const destination = join(this.root, manifest.id),
        backup = destination + '.previous';
      await fs.rm(backup, { recursive: true, force: true });
      if (existing) await fs.rename(destination, backup);
      try {
        await fs.cp(staging, destination, { recursive: true });
        await this.db.call('pluginSave', {
          id: manifest.id,
          manifest,
          source: source.startsWith('https://') ? source : path,
          revision,
          enabled: existing?.enabled || false,
        });
      } catch (error) {
        await fs.rm(destination, { recursive: true, force: true });
        if (existing) await fs.rename(backup, destination);
        throw error;
      }
      await fs.rm(backup, { recursive: true, force: true });
      return (await this.list()).find((p) => p.id === manifest.id);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  async change(id: string, action: string) {
    const p = (await this.list()).find((p) => p.id === id);
    if (!p) throw Error('Plugin not found');
    if (p.builtin) {
      if (!['enable', 'disable'].includes(action))
        throw Error('Bundled plugins can be enabled or disabled; update them with randl');
      await this.db.call('settingSet', 'plugin.enabled:' + id, action === 'enable');
      return { ...p, enabled: action === 'enable' };
    }
    if (action === 'update') return this.install(p.source, id);
    if (action === 'remove') {
      await this.db.call('pluginDelete', id);
      await fs.rm(join(this.root, id), { recursive: true, force: true });
      return { removed: id };
    }
    if (!['enable', 'disable'].includes(action)) throw Error('Unknown plugin action');
    await this.db.call('pluginSave', {
      id,
      manifest: p,
      source: p.source,
      revision: p.revision,
      enabled: action === 'enable',
    });
    return (await this.list()).find((p) => p.id === id);
  }
}
