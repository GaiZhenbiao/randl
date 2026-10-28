import { optionExtent, renderer, type Host } from './shared';
import { stackedOption } from './stacked';
import type { PanelContext } from '../types';
export const create = (host: Host) => renderer(host, (ctx) => stackedOption(ctx, false), false);
export const extent = (ctx: PanelContext) =>
  optionExtent(stackedOption(ctx, false), ctx.panel.settings || {});
