// Bounds the audio and video elements media panels keep, and plays one audio clip with sound
// at a time in the workspace; videos the viewer starts never pause each other. A panel
// attaches an element when the viewer activates a tile, or when an autoplaying video comes
// into view; the least recently used elements that are paused, or autoplaying muted, are
// released back to their placeholders, so the newest autoplay wins. A playing video the
// viewer started is never released, so the limits give way only to videos the viewer is
// watching: a panel pauses (or, when muted, releases) a video whose tile leaves the view.
type Player = {
  owner: object;
  element: HTMLMediaElement;
  release: () => void;
  used: number;
  autoplay: boolean;
};
export const playbackLimits = { videoPerPanel: 6, video: 12, audioPerPanel: 24 };
const players = new Set<Player>();
let clock = 0;
// A full-screen element is never released, which would end full screen.
const releasable = (player: Player) =>
  player.element !== document.fullscreenElement &&
  (player.element.paused || (player.autoplay && player.element.muted));
function evict(kind: 'VIDEO' | 'AUDIO', owner: object, keep: Player) {
  const list = () =>
    [...players]
      .filter((player) => player !== keep && player.element.tagName === kind && releasable(player))
      .sort((a, b) => a.used - b.used);
  const count = (mine: boolean) =>
    [...players].filter(
      (player) => player.element.tagName === kind && (!mine || player.owner === owner),
    ).length;
  const perPanel = kind === 'VIDEO' ? playbackLimits.videoPerPanel : playbackLimits.audioPerPanel;
  while (count(true) > perPanel) {
    const victim = list().find((player) => player.owner === owner);
    if (!victim) break;
    detach(victim.element);
  }
  while (kind === 'VIDEO' && count(false) > playbackLimits.video) {
    const victim = list()[0];
    if (!victim) break;
    detach(victim.element);
  }
}
// Audio with sound pauses other audio with sound.
function play(this: HTMLMediaElement) {
  for (const player of players) if (player.element === this) player.used = ++clock;
  if (this.tagName !== 'AUDIO' || this.muted || this.paused) return;
  for (const player of players)
    if (player.element !== this && player.element.tagName === 'AUDIO' && !player.element.muted)
      player.element.pause();
}
/**
 * Registers an element a panel created; `release` restores the tile's placeholder. An
 * `autoplay` element may be released while it plays muted.
 */
export function attachPlayer(
  owner: object,
  element: HTMLMediaElement,
  release: () => void,
  autoplay = false,
) {
  const player = { owner, element, release, used: ++clock, autoplay };
  players.add(player);
  element.addEventListener('play', play);
  element.addEventListener('volumechange', play);
  evict(element.tagName as 'VIDEO' | 'AUDIO', owner, player);
}
/** Stops an element, frees its resource and gives the tile its placeholder back. */
export function detach(element: HTMLMediaElement) {
  for (const player of players)
    if (player.element === element) {
      players.delete(player);
      element.removeEventListener('play', play);
      element.removeEventListener('volumechange', play);
      element.pause();
      element.removeAttribute('src');
      element.load();
      player.release();
    }
}
/** Pauses a panel's media, for example when the panel leaves the viewport. */
export function pausePlayers(owner: object) {
  for (const player of players) if (player.owner === owner) player.element.pause();
}
export function detachPlayers(owner: object) {
  for (const player of [...players]) if (player.owner === owner) detach(player.element);
}
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const player of players) player.element.pause();
  });
