export const MEDIA_PLAYBACK_STARTED_EVENT = "mavo-media-playback-started";

export function announceMediaPlayback(playerId: string) {
  window.dispatchEvent(new CustomEvent(MEDIA_PLAYBACK_STARTED_EVENT, { detail: { playerId } }));
}

export function playbackOwner(event: Event) {
  return (event as CustomEvent<{ playerId?: string }>).detail?.playerId;
}
