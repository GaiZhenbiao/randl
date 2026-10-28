import { MessageError } from '../api';
import type { ChartCursor, PanelContext, Plugin, Renderer } from '../types';
const builtins: Record<string, () => Promise<any>> = {
  line: () => import('./line'),
  area: () => import('./area'),
  'stacked-area': () => import('./stacked-area'),
  'percent-area': () => import('./percent-area'),
  bar: () => import('./bar'),
  scatter: () => import('./scatter'),
  'scatter-history': () => import('./scatter'),
  parallel: () => import('./parallel'),
  image: () => import('./media'),
  audio: () => import('./media'),
  video: () => import('./media'),
  table: () => import('./media'),
  histogram: () => import('./histogram'),
};
/** The plugin's browser module; dynamic imports are cached by the browser. */
export function pluginModule(plugin: Plugin): Promise<any> {
  return plugin.builtin
    ? builtins[plugin.id]()
    : import(
        /* @vite-ignore */ `/api/plugins/${encodeURIComponent(plugin.id)}/revisions/${encodeURIComponent(plugin.revision || plugin.version)}/source/${plugin.entry}`
      );
}
export type Extent = (ctx: PanelContext) => [number, number] | null;
/**
 * The plugin's optional pure `extent(ctx)` export: the Y range its chart would show for a
 * context, used to give grid cells a shared Y range. Undefined when the plugin has none.
 */
export async function pluginExtent(plugin: Plugin): Promise<Extent | undefined> {
  if (!plugin.enabled) return;
  const module = await pluginModule(plugin);
  return typeof module.extent === 'function' ? module.extent : undefined;
}
export async function mountPlugin(
  plugin: Plugin,
  container: HTMLElement,
  onRange?: (range: { xMin: number; xMax: number } | null) => void,
  onHover?: (ids: string[]) => void,
  onError: (error: Error) => void = () => {},
  onCursor?: (cursor: ChartCursor | null) => void,
): Promise<Renderer> {
  const element = document.createElement('div');
  element.style.cssText = 'width:100%;height:100%';
  container.replaceChildren(element);
  if (!plugin.enabled) throw new MessageError('plugins.errors.disabled');
  const core = plugin.renderer === 'dom' ? undefined : await import('./engine');
  const module = await pluginModule(plugin);
  if (typeof module.create !== 'function') throw new MessageError('plugins.errors.noCreate');
  const cleanup = (canvases = [...element.querySelectorAll('canvas')]) => {
    core?.echarts.getInstanceByDom(element)?.dispose();
    for (const canvas of canvases) canvas.width = canvas.height = 0;
    element.remove();
  };
  let result: Renderer;
  try {
    result = await module.create({
      element,
      echarts: core?.echarts,
      apiVersion: 1,
      onRange,
      onHover,
      onCursor,
    });
    if (
      !result ||
      !['update', 'resize', 'destroy'].every((key) => typeof (result as any)[key] === 'function')
    )
      throw new MessageError('plugins.errors.lifecycle');
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    update: (ctx) => result.update(ctx),
    resize: () => {
      try {
        result.resize();
      } catch (error) {
        onError(error as Error);
      }
    },
    destroy: () => {
      const canvases = [...element.querySelectorAll('canvas')];
      try {
        result.destroy();
      } catch (error) {
        onError(error as Error);
      } finally {
        cleanup(canvases);
      }
    },
    ...(result.highlightRuns
      ? {
          highlightRuns: (ids: string[], local: boolean) => {
            try {
              result.highlightRuns!(ids, local);
            } catch (error) {
              onError(error as Error);
            }
          },
        }
      : {}),
    ...(result.showCursor
      ? {
          showCursor: (cursor: ChartCursor | null) => {
            try {
              result.showCursor!(cursor);
            } catch (error) {
              onError(error as Error);
            }
          },
        }
      : {}),
    ...(result.exportImage
      ? {
          exportImage: () => {
            try {
              return result.exportImage!();
            } catch (error) {
              onError(error as Error);
              return '';
            }
          },
        }
      : {}),
  };
}
