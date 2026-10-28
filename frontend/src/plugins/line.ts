import { lineChart, optionExtent, renderer, type Host } from './shared';
import type { PanelContext } from '../types';
export const create = (host: Host) => renderer(host, (ctx) => lineChart(ctx));
export const extent = (ctx: PanelContext) => optionExtent(lineChart(ctx), ctx.panel.settings || {});
