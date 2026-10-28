import { lineChart, optionExtent, renderer, type Host } from './shared';
import type { PanelContext } from '../types';
export const create = (host: Host) => renderer(host, (ctx) => lineChart(ctx, true), false);
export const extent = (ctx: PanelContext) =>
  optionExtent(lineChart(ctx, true), ctx.panel.settings || {});
