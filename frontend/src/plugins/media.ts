import { chevronIcon, mutedIcon, playIcon } from './icons';
import { Carousel, TileGrid } from './tile-view';
import { attachPlayer, detach, detachPlayers, pausePlayers } from '../media-playback';
import { cachedPoster, loadPoster } from '../media-poster';
import { color } from '../run-colors';
import panelLimits from '../../../backend/src/panel-limits.json';
import { mediaItems, type MediaItem } from '../../../backend/src/media-items';
import type { MediaEntry, PanelContext, Renderer } from '../types';

// Image, audio and video panels: a virtualized grid of tiles, one per logged file, at the
// host's item size; a logged list (W&B `images/separated`, `videos`, `audio`) is one tile per
// file. Coverflow shows one file at a time: a run's files, with run tabs, or the runs. Tables
// keep one table at a time.
type Tile = { entry: MediaEntry; item?: MediaItem; index: number; files: number };
/** What a Coverflow shows: see `sync`. */
type Flow = { key?: string; position: number; tab: number; tabs: boolean; items: Tile[] };
const newFlow = (): Flow => ({ position: 0, tab: 0, tabs: false, items: [] });
const captionHeight = 20,
  headerHeight = 28,
  tileCap = 200,
  /** Height below Coverflow's current file, for its caption. */
  footerHeight = 28;
// The logged digest lets the browser reuse a file without asking the server.
function preview(entry: MediaEntry, path: string, digest?: string, route = 'run-file-preview') {
  return (
    `/api/${route}?run=` +
    encodeURIComponent(entry.run) +
    '&path=' +
    encodeURIComponent(path) +
    (digest ? '&digest=' + encodeURIComponent(digest) : '')
  );
}
const source = (tile: Tile) => preview(tile.entry, tile.item!.path, tile.item!.sha256);
const contentKey = (tile: Tile) => tile.item!.sha256 || tile.entry.run + '\0' + tile.item!.path;
/** Width over height of files whose size was not logged, learned from their posters and images. */
const learned = new Map<string, number>();
function learn(tile: Tile, width: number, height: number) {
  if (!width || !height) return false;
  const key = contentKey(tile),
    ratio = width / height,
    old = learned.get(key);
  learned.delete(key);
  learned.set(key, ratio);
  if (learned.size > 5000) learned.delete(learned.keys().next().value!);
  return !old || Math.abs(old - ratio) > 0.01;
}
/** Width over height from the logged or learned size, or undefined. */
function ratio(tile: Tile) {
  const { width, height } = tile.item || {};
  return width && height ? width / height : tile.item ? learned.get(contentKey(tile)) : undefined;
}
/** A grid tile's aspect, within 1:2 and 3:1. */
const gridAspect = (aspect: number) => Math.max(1 / 2, Math.min(3, aspect));
/** Nearest items searched for a known aspect. */
const nearestItems = 50;
export function create({ element }: { element: HTMLElement }): Renderer {
  let controller: AbortController | undefined,
    grid: TileGrid | undefined,
    carousel: Carousel | undefined,
    ctx: PanelContext | undefined,
    tiles: Tile[] = [],
    /** Each entry's tiles: one entry per run (or per step). */
    groups: Tile[][] = [],
    gridLayout: Parameters<TileGrid['layout']>[0] | undefined,
    shown = '';
  const owner = {},
    icons = new Map<HTMLElement, () => void>(),
    /** What Coverflow shows, kept while the panel stays. */
    flow = newFlow();
  const kind = () => ctx!.panel.plugin;
  const fullscreen = () => {
    const shown = document.fullscreenElement;
    return !!shown && element.contains(shown);
  };
  // Media pauses when the whole panel leaves the viewport, except a full-screen video.
  const visibility = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting && !fullscreen()) pausePlayers(owner);
  });
  visibility.observe(element);
  // A video plays while any part of its tile is on screen. When the tile has left entirely,
  // a muted video is released and one with sound pauses. Autoplay starts a video muted while
  // its tile is on screen; the playback limits keep the newest. Reduced motion turns it off.
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'),
    autoplay = () => kind() === 'video' && ctx!.options.autoplay === true && !reducedMotion.matches,
    framed = new WeakMap<HTMLElement, Tile>(),
    onScreen = new Set<HTMLElement>();
  const watched = new IntersectionObserver((records) => {
    for (const record of records) {
      const frame = record.target as HTMLElement;
      if (record.isIntersecting) {
        onScreen.add(frame);
        autostart(frame);
      } else {
        onScreen.delete(frame);
        const media = frame.querySelector('video');
        if (!media || media === document.fullscreenElement) continue;
        if (media.muted) detach(media);
        else media.pause();
      }
    }
  });
  function autostart(frame: HTMLElement) {
    const tile = framed.get(frame);
    if (!tile || !autoplay() || document.hidden) return;
    const media = frame.querySelector('video');
    if (!media) startPlayer(tile, frame, true);
    else if (media.paused && media.muted && !media.ended) void media.play().catch(() => {});
  }
  // The workspace pauses media while the page is hidden; autoplay resumes on return.
  const resume = () => {
    for (const frame of onScreen) autostart(frame);
  };
  document.addEventListener('visibilitychange', resume);
  // Posters load for frames near the view, a few at a time, and stop when a frame leaves.
  const posterLoads = new Map<HTMLElement, AbortController>();
  const posterView = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        const frame = record.target as HTMLElement,
          tile = framed.get(frame);
        posterView.unobserve(frame);
        if (!tile?.item || posterLoads.has(frame)) continue;
        const load = new AbortController();
        posterLoads.set(frame, load);
        void loadPoster(
          contentKey(tile),
          preview(tile.entry, tile.item.path, tile.item.sha256, 'run-file-poster'),
          source(tile),
          load.signal,
        ).then((poster) => {
          if (posterLoads.get(frame) === load) posterLoads.delete(frame);
          if (!poster || load.signal.aborted) return;
          showPoster(frame, poster.url);
          if (learned(tile, poster.width, poster.height)) reflow();
        });
      }
    },
    { rootMargin: '100px' },
  );
  function showPoster(frame: HTMLElement, url: string) {
    const image = frame.querySelector<HTMLImageElement>('.media-poster');
    if (image) image.src = url;
    const media = frame.querySelector('video');
    if (media && !media.poster) media.poster = url;
  }
  // Sizes are shared by every panel, so a file this panel laid out without its size lays out
  // again once its poster, image or video shows it here, even when another panel learned it.
  const guessed = new Set<string>();
  function sized(tile: Tile) {
    const known = ratio(tile);
    if (known === undefined && tile.item) guessed.add(contentKey(tile));
    return known;
  }
  function learned(tile: Tile, width: number, height: number) {
    if (!width || !height) return false;
    const fresh = guessed.delete(contentKey(tile));
    return learn(tile, width, height) || fresh;
  }
  // A learned aspect lays out Coverflow's items and the grid on the next frame; the grid waits
  // while full screen would lose its tile.
  let reflowFrame = 0;
  function reflow() {
    if (reflowFrame) return;
    reflowFrame = requestAnimationFrame(() => {
      reflowFrame = 0;
      for (const made of views.keys()) made.layout();
      if (!carousel && grid && gridLayout && !fullscreen()) layoutGrid(false);
    });
  }
  // Rows the layout keeps keep their tiles, whose files may have new heights.
  function layoutGrid(rebuild: boolean) {
    grid!.layout(gridLayout!, rebuild);
    for (const [index, cell] of grid!.cells)
      cell.querySelector<HTMLElement>('.media-frame')!.style.height =
        frameHeight(index, grid!.tileWidth) + 'px';
  }
  // A file whose size is not known (the server reads videos' sizes from their headers) takes
  // the aspect of the nearest known file among the items, usually its run's, or 16:9, and
  // moves to its own once its poster, image or video shows it. Grid tiles and Coverflow share it.
  function shape(items: Tile[], index: number) {
    const own = items[index] && sized(items[index]);
    if (own) return own;
    for (let distance = 1; distance <= nearestItems && distance < items.length; distance++)
      for (const at of [index - distance, index + distance]) {
        const known = items[at] && ratio(items[at]);
        if (known) return known;
      }
    return 16 / 9;
  }
  /** A grid tile's file height: its own aspect, also in a row of taller tiles. */
  const frameHeight = (index: number, width: number) =>
    Math.round(width / gridAspect(shape(tiles, index)));
  function name(tile: Tile) {
    return tile.item?.caption ?? caption(tile);
  }
  function caption(tile: Tile) {
    const { entry } = tile;
    if (ctx!.panel.settings?.mediaAcross === 'steps')
      return tile.files > 1
        ? ctx!.translate('media.tile.stepItem', { step: entry.step!, index: tile.index + 1 })
        : ctx!.translate('media.tile.step', { step: entry.step! });
    const run = entry.runName || entry.run.split('/').at(-1)!;
    return tile.files > 1
      ? ctx!.translate('media.tile.caption', { run, index: tile.index + 1 })
      : run;
  }
  // A video or audio tile that is not playing: the video's first frame and a play button,
  // which is a tab stop only outside the grid (the grid's tile takes the keys).
  function placeholder(tile: Tile, frame: HTMLElement, tabbable = !frame.closest('.tile-grid')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'media-play bx--btn bx--btn--ghost bx--btn--icon-only';
    const label = ctx!.translate('media.tile.play', { name: name(tile) });
    button.setAttribute('aria-label', label);
    button.title = label;
    if (!tabbable) button.tabIndex = -1;
    icons.set(button, playIcon(button));
    button.onclick = () => startPlayer(tile, frame);
    for (const old of frame.querySelectorAll('button')) releaseIcon(old);
    frame.replaceChildren();
    if (kind() === 'video') frame.append(posterImage(tile, frame));
    frame.append(button);
  }
  function posterImage(tile: Tile, frame: HTMLElement) {
    const image = document.createElement('img');
    image.className = 'media-poster';
    image.alt = '';
    image.decoding = 'async';
    const known = cachedPoster(contentKey(tile));
    if (!known) {
      if (!posterLoads.has(frame)) posterView.observe(frame);
    } else {
      image.src = known.url;
      if (learned(tile, known.width, known.height)) reflow();
    }
    return image;
  }
  // Players mount on activation and play within the gesture, or muted for autoplay.
  function startPlayer(tile: Tile, frame: HTMLElement, auto = false) {
    const media = document.createElement(kind() === 'audio' ? 'audio' : 'video');
    media.controls = true;
    media.preload = 'metadata';
    media.muted = auto;
    if (media instanceof HTMLVideoElement) {
      media.playsInline = true;
      media.loop = ctx!.options.loop === true;
      const poster = cachedPoster(contentKey(tile));
      if (poster) media.poster = poster.url;
      media.addEventListener(
        'loadedmetadata',
        () => {
          if (learned(tile, media.videoWidth, media.videoHeight) && views.size) reflow();
        },
        { once: true },
      );
    }
    media.src = source(tile);
    const tabbable = !frame.closest('.tile-grid');
    if (!tabbable) media.tabIndex = -1;
    for (const button of frame.querySelectorAll('button')) releaseIcon(button);
    frame.replaceChildren(media);
    if (auto) frame.append(unmuteButton(tile, media, tabbable));
    attachPlayer(
      owner,
      media,
      () => {
        if (frame.isConnected) placeholder(tile, frame, tabbable);
      },
      auto,
    );
    void media.play().catch(() => {});
  }
  function unmuteButton(tile: Tile, media: HTMLMediaElement, tabbable: boolean) {
    const button = document.createElement('button'),
      label = ctx!.translate('media.tile.unmute', { name: name(tile) });
    button.type = 'button';
    button.className = 'media-unmute bx--btn bx--btn--secondary bx--btn--sm bx--btn--icon-only';
    button.setAttribute('aria-label', label);
    button.title = label;
    if (!tabbable) button.tabIndex = -1;
    icons.set(button, mutedIcon(button));
    button.onclick = () => {
      media.muted = false;
      if (media.paused) void media.play().catch(() => {});
    };
    media.addEventListener('volumechange', () => {
      if (media.muted || !button.isConnected) return;
      releaseIcon(button);
      button.remove();
    });
    return button;
  }
  function releaseIcon(button: Element) {
    icons.get(button as HTMLElement)?.();
    icons.delete(button as HTMLElement);
  }
  // A file's view: the image, or for audio and video the poster and a play button. Coverflow's
  // neighbors are decorative previews and never load players.
  function frame(tile: Tile, use: 'tile' | 'stage' | 'peek', host?: HTMLElement) {
    const frame = document.createElement('div');
    frame.className = 'media-frame';
    if (!tile.item) {
      frame.classList.add('media-missing');
      frame.textContent = ctx!.translate('media.tile.noEntry', { step: ctx!.data.step ?? 0 });
      return frame;
    }
    if (kind() === 'image') {
      const image = document.createElement('img');
      image.alt = use === 'peek' ? '' : name(tile);
      image.loading = 'lazy';
      image.decoding = 'async';
      image.style.objectFit = use === 'tile' && ctx!.options.fit === 'cover' ? 'cover' : 'contain';
      image.style.imageRendering = ctx!.options.smooth === false ? 'pixelated' : 'auto';
      image.onload = () => {
        if (learned(tile, image.naturalWidth, image.naturalHeight)) reflow();
      };
      image.src = source(tile);
      // A file that is missing or cannot be decoded says so instead of a broken image.
      image.onerror = () => {
        if (!image.getAttribute('src')) return;
        frame.classList.replace('media-checker', 'media-missing');
        frame.textContent = ctx!.translate('media.tile.unavailable');
      };
      frame.classList.add('media-checker');
      frame.append(image);
      return frame;
    }
    framed.set(frame, tile);
    // The frame joins its tile or slide before its play button decides whether it is a tab stop.
    host?.append(frame);
    if (use === 'peek') {
      if (kind() === 'video') frame.append(posterImage(tile, frame));
      else {
        const icon = document.createElement('span');
        icon.className = 'media-icon';
        icons.set(icon, playIcon(icon));
        frame.append(icon);
      }
    } else {
      placeholder(tile, frame);
      if (kind() === 'video') watched.observe(frame);
    }
    return frame;
  }
  // Without the grid's run headers, Coverflow names each file's run with its caption.
  function withRun(tile: Tile) {
    const text = name(tile),
      run = tile.entry.runName;
    return ctx!.panel.settings?.mediaAcross === 'steps' || !tile.item || text === run
      ? text
      : ctx!.translate('media.tile.runCaption', { run, caption: text });
  }
  function label(tile: Tile) {
    const caption = document.createElement('div'),
      text = tile.item ? name(tile) : tile.entry.runName;
    caption.className = 'media-caption';
    caption.textContent = text;
    caption.title = text;
    return caption;
  }
  function tileName(tile: Tile, named = false) {
    return tile.item
      ? ctx!.translate('media.tile.name', {
          name: named ? withRun(tile) : name(tile),
          step: tile.entry.step!,
          index: tile.index + 1,
          count: tile.files,
        })
      : tile.entry.runName +
          ', ' +
          ctx!.translate('media.tile.noEntry', { step: ctx!.data.step ?? 0 });
  }
  // A tile with a player keeps it while the grid rebuilds its rows, as when the panel expands
  // or new data arrive: the frame moves to the file's new cell in the same pass, so the media
  // plays on. Frames that no cell takes are released when the pass ends.
  const moving = new Map<string, HTMLElement>();
  const tileKey = (tile: Tile) =>
    [tile.entry.run, tile.entry.step, tile.index, tile.item!.path].join('\0');
  function mountTile(index: number, cell: HTMLElement, width: number) {
    const tile = tiles[index],
      key = tile.item && tileKey(tile),
      kept = key && moving.get(key);
    cell.classList.add('media-tile');
    cell.setAttribute('aria-label', tileName(tile));
    let view: HTMLElement;
    if (kept) {
      moving.delete(key);
      framed.set(kept, tile);
      cell.append(kept);
      view = kept;
    } else {
      view = frame(tile, 'tile', cell);
      if (!view.isConnected) cell.append(view);
    }
    view.style.height = frameHeight(index, width) + 'px';
    cell.append(label(tile));
  }
  function unmountTile(cell: HTMLElement) {
    const view = cell.querySelector<HTMLElement>('.media-frame'),
      tile = view && framed.get(view);
    if (tile && view.querySelector('audio,video')) {
      view.remove();
      moving.set(tileKey(tile), view);
    }
    release(cell);
  }
  function releaseMoving() {
    for (const view of moving.values()) release(view);
    moving.clear();
  }
  /** The first tile playing media, which a new column count keeps in view. */
  function playingTile() {
    for (const [index, cell] of grid!.cells) {
      const media = cell.querySelector<HTMLMediaElement>('audio,video');
      if (media && !media.paused) return index;
    }
  }
  // Releases players, posters, icons and image downloads inside an element leaving the view
  // (or the frame itself); the caches serve them again.
  function release(element: HTMLElement) {
    const frames = element.matches('.media-frame')
      ? [element]
      : element.querySelectorAll<HTMLElement>('.media-frame');
    for (const frame of frames) {
      watched.unobserve(frame);
      posterView.unobserve(frame);
      posterLoads.get(frame)?.abort();
      posterLoads.delete(frame);
      onScreen.delete(frame);
    }
    for (const media of element.querySelectorAll<HTMLMediaElement>('audio,video')) detach(media);
    for (const icon of element.querySelectorAll('.media-play,.media-icon,.media-unmute'))
      releaseIcon(icon);
    for (const image of element.querySelectorAll('img')) image.removeAttribute('src');
  }
  // Coverflow's items. When a run logged several files at the step, the items are one run's
  // files and the tabs below choose the run; otherwise the items are the runs. Across steps,
  // the items are the run's files at every step, and the panel's Run chooses the run. A view
  // keeps the run (or, across steps, the file) it shows and one position among a run's
  // files, which every run shows (its last file when it has fewer).
  const across = () => (ctx!.panel.settings?.mediaAcross === 'steps' ? 'steps' : 'runs');
  const runKey = (tile: Tile) => tile.entry.run;
  const fileKey = (tile: Tile) => tile.entry.step + ':' + tile.index;
  function sync(view: Flow) {
    view.tabs = across() === 'runs' && groups.some((group) => group.length > 1);
    if (view.tabs) {
      let tab = groups.findIndex((group) => runKey(group[0]) === view.key);
      if (tab < 0) tab = Math.min(view.tab, groups.length - 1);
      view.tab = tab;
      view.key = runKey(groups[tab][0]);
      view.items = groups[tab];
    } else view.items = across() === 'steps' ? tiles : groups.map((group) => group[0]);
  }
  /** The item a view shows, or `fallback` when its run or file is gone. */
  function shownIndex(view: Flow, fallback: number) {
    if (view.tabs) return Math.min(view.position, view.items.length - 1);
    const key = across() === 'steps' ? fileKey : runKey,
      index = view.items.findIndex((tile) => key(tile) === view.key);
    return index >= 0 ? index : fallback;
  }
  function show(made: Carousel, view: Flow, refresh: boolean) {
    sync(view);
    made.set(view.items.length, shownIndex(view, made.index), refresh);
  }
  const runName = (entry: MediaEntry) => entry.runName || entry.run.split('/').at(-1)!;
  const views = new Map<Carousel, Flow>();
  function carouselOf(host: HTMLElement, view: Flow) {
    const made: Carousel = new Carousel(
      host,
      {
        stage: (index, slide) => {
          const tile = view.items[index],
            footer = document.createElement('div'),
            caption = label(tile);
          slide.classList.add('media-stage');
          const shown = frame(tile, 'stage', slide);
          if (!shown.isConnected) slide.append(shown);
          // Without run tabs, the caption names the run.
          if (!view.tabs && tile.item) caption.textContent = caption.title = withRun(tile);
          footer.className = 'media-footer';
          footer.append(caption);
          slide.append(footer);
        },
        release: (_, slide) => release(slide),
        peek: (index, peek) => peek.append(frame(view.items[index], 'peek')),
        unpeek: (_, peek) => release(peek),
        name: (index) => tileName(view.items[index], true),
        aspect: (index) => shape(view.items, index),
        change: (index) => {
          // Moving pauses the current media.
          pausePlayers(owner);
          const tile = view.items[index];
          if (view.tabs) view.position = index;
          else view.key = across() === 'steps' ? fileKey(tile) : runKey(tile);
        },
        tabs: {
          count: () => (view.tabs ? groups.length : 0),
          selected: () => view.tab,
          name: (index) => runName(groups[index][0].entry),
          fill: (index, chip) => {
            const entry = groups[index][0].entry,
              swatch = document.createElement('span'),
              text = document.createElement('span');
            swatch.className = 'cell-swatch';
            swatch.style.background = color(entry.run, ctx!.colors, ctx!.dark);
            text.className = 'cell-name';
            text.textContent = runName(entry);
            chip.append(swatch, text);
          },
          select: (index) => {
            pausePlayers(owner);
            view.key = runKey(groups[index][0]);
            show(made, view, true);
          },
        },
      },
      {
        label: ctx!.panel.title || ctx!.panel.metric,
        carousel: ctx!.translate('panel.coverflow.role'),
        slide: ctx!.translate('panel.coverflow.slide'),
        previous: ctx!.translate('panel.coverflow.previous'),
        next: ctx!.translate('panel.coverflow.next'),
        position: (index, count) => ctx!.translate('panel.coverflow.position', { index, count }),
      },
      { chipWidth: 160, footer: footerHeight, icon: chevronIcon },
    );
    views.set(made, view);
    return made;
  }
  function dropCarousel(made: Carousel) {
    made.destroy();
    views.delete(made);
  }
  // Quick Look: Enter on a tile opens a full-screen Coverflow at that file; Escape closes it
  // and returns focus to the file last shown.
  function quickLook(index: number) {
    const dialog = document.createElement('dialog'),
      close = document.createElement('button'),
      closeLabel = ctx!.translate('common.action.close'),
      tile = tiles[index],
      view: Flow = {
        ...newFlow(),
        key: across() === 'steps' ? fileKey(tile) : runKey(tile),
        position: tile.index,
      };
    dialog.className = 'media-quicklook';
    dialog.setAttribute('aria-label', ctx!.panel.title || ctx!.panel.metric);
    close.type = 'button';
    close.className = 'media-quicklook-close bx--btn bx--btn--ghost';
    close.textContent = closeLabel;
    close.onclick = () => dialog.close();
    dialog.append(close);
    element.append(dialog);
    const look = carouselOf(dialog, view);
    dialog.showModal();
    show(look, view, false);
    look.current.focus();
    dialog.addEventListener('close', () => {
      const shown = view.items[look.index];
      dropCarousel(look);
      dialog.remove();
      grid?.focusTile(shown ? tiles.indexOf(shown) : index);
    });
  }
  async function table(entries: MediaEntry[], signal: AbortSignal) {
    const select = document.createElement('select');
    select.className = 'bx--select-input';
    select.setAttribute('aria-label', ctx!.translate('media.panel.select'));
    for (const [i, item] of entries.entries()) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = ctx!.translate('media.panel.option', {
        run: item.runName || item.run.split('/').at(-1)!,
        step: item.step!,
      });
      select.append(option);
    }
    const content = document.createElement('div');
    content.className = 'media-content';
    element.append(select, content);
    const show = async () => {
      const entry = entries[Number(select.value)];
      content.replaceChildren();
      try {
        const response = await fetch(preview(entry, entry.value.path), { signal });
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        if (signal.aborted) return;
        const table = document.createElement('table');
        table.className = 'bx--data-table bx--data-table--compact';
        const head = document.createElement('tr');
        for (const name of data.columns) {
          const th = document.createElement('th');
          th.textContent = String(name);
          head.append(th);
        }
        table.append(head);
        for (const row of data.data) {
          const tr = document.createElement('tr');
          for (const value of row) {
            const td = document.createElement('td');
            td.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
            tr.append(td);
          }
          table.append(tr);
        }
        content.append(table);
        if (data.truncated)
          content.append(document.createTextNode(ctx!.translate('media.panel.tableTruncated')));
      } catch (e) {
        if (!signal.aborted) content.textContent = (e as Error).message;
      }
    };
    select.onchange = () => void show();
    await show();
  }
  return {
    async update(next: PanelContext) {
      ctx = next;
      const entries = next.data.entries || [];
      if (next.panel.plugin === 'table') {
        controller?.abort();
        controller = new AbortController();
        element.replaceChildren();
        element.style.overflow = 'auto';
        const logged = entries.filter((entry) => entry.value);
        if (!logged.length) element.textContent = next.translate('media.panel.empty');
        else await table(logged, controller.signal);
        return;
      }
      groups = entries.map((entry) => {
        const items: (MediaItem | undefined)[] = entry.value ? mediaItems(entry.value) : [];
        if (!items.length) items.push(undefined);
        return items.map((item, index) => ({ entry, item, index, files: items.length }));
      });
      tiles = groups.flat();
      // New content rebuilds the items in view (the browser cache serves their files); a new
      // size or panel width only lays them out again.
      const content = JSON.stringify([
          entries,
          next.options,
          next.locale,
          next.dark,
          next.panel.settings?.mediaAcross,
        ]),
        rebuild = content !== shown;
      shown = content;
      if (next.panel.settings?.layout === 'coverflow') {
        grid?.destroy();
        grid = undefined;
        releaseMoving();
        if (!carousel) {
          element.replaceChildren();
          carousel = carouselOf(element, flow);
        }
        // The view's run, file and position are kept while data change.
        for (const [made, view] of views) show(made, view, rebuild);
        return;
      }
      if (carousel) dropCarousel(carousel);
      carousel = undefined;
      // Quick Look follows new data too.
      for (const [made, view] of views) show(made, view, rebuild);
      // A run's tiles follow a header when several runs each show several files.
      const grouped =
        new Set(entries.map((entry) => entry.run)).size > 1 && tiles.some((tile) => tile.files > 1);
      if (!grid) {
        element.replaceChildren();
        grid = new TileGrid(
          element,
          {
            mount: (index, cell, width) => mountTile(index, cell, width),
            unmount: (_, cell) => unmountTile(cell),
            settled: releaseMoving,
            anchor: playingTile,
            header: (row, cell) => {
              const run = tiles[row.start].entry,
                swatch = document.createElement('span'),
                title = document.createElement('span'),
                count = document.createElement('span');
              cell.className = 'media-header';
              swatch.className = 'cell-swatch';
              swatch.style.background = color(run.run, ctx!.colors, ctx!.dark);
              title.className = 'cell-name';
              title.textContent = run.runName;
              count.className = 'cell-members';
              count.textContent = ctx!.translate('media.tile.runItems', {
                count: tiles[row.start].files,
              });
              cell.append(swatch, title, count);
            },
            key: (event, index) => {
              if (event.key === 'Enter' && tiles[index].item) {
                quickLook(index);
                return true;
              }
              const cell = grid!.cells.get(index)!,
                media = cell.querySelector<HTMLMediaElement>('audio,video');
              // M unmutes or mutes the tile's player.
              if (event.key === 'm' && media) {
                media.muted = !media.muted;
                return true;
              }
              if (event.key !== ' ' || kind() === 'image') return false;
              if (media) {
                if (media.paused) void media.play();
                else media.pause();
              } else startPlayer(tiles[index], cell.querySelector<HTMLElement>('.media-frame')!);
              return true;
            },
          },
          next.panel.title || next.panel.metric,
        );
        grid.scroller.classList.add('media-grid');
      }
      grid.label = next.panel.title || next.panel.metric;
      gridLayout = {
        count: tiles.length,
        size: next.panel.settings?.itemSize ?? panelLimits.itemSize.media,
        cap: tileCap,
        height: (index, width) => frameHeight(index, width) + captionHeight,
        ...(grouped ? { group: (index: number) => tiles[index].entry.run, headerHeight } : {}),
      };
      layoutGrid(rebuild);
    },
    resize() {},
    destroy() {
      controller?.abort();
      cancelAnimationFrame(reflowFrame);
      visibility.disconnect();
      watched.disconnect();
      posterView.disconnect();
      for (const load of posterLoads.values()) load.abort();
      document.removeEventListener('visibilitychange', resume);
      detachPlayers(owner);
      grid?.destroy();
      for (const made of [...views.keys()]) dropCarousel(made);
      for (const icon of [...icons.keys()]) releaseIcon(icon);
      element.replaceChildren();
      element.style.removeProperty('overflow');
    },
  };
}
