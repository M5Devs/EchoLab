/**
 * SoundCloud track resolver.
 *
 * SoundCloud no longer serves progressive MP3 for most tracks: a track page
 * offers only HLS, and that HLS stream is *fragmented MP4* (`init.mp4` plus
 * numbered `.m4s` segments) rather than MPEG-TS. Browsers cannot hand an
 * `.m3u8` playlist to `decodeAudioData`, and Media Source Extensions do not help
 * a Web Audio pipeline, so the fragments are stitched into one progressive file
 * here.
 *
 * The page's `window.__sc_hydration` blob is the whole story — it carries the
 * track (`media.transcodings`, `track_authorization`) and an `apiClient`
 * hydratable whose `id` is the `client_id`. Nothing needs to be scraped out of
 * the hashed `a-v2.sndcdn.com` asset bundles, and no extra `/resolve` round trip
 * is needed.
 *
 * Resolution order:
 *   1. a `progressive` transcoding, when the track still has one (a direct MP3);
 *   2. otherwise the HLS transcoding, whose playlist is fetched and stitched into
 *      a single fragmented-MP4 stream.
 */

import { HttpError } from './http.js';

const SC_HOST_RE = /(^|\.)soundcloud\.com$/i;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_TRACK_BYTES = 128 * 1024 * 1024;
const MAX_SEGMENTS = 2000;
const SEGMENT_CONCURRENCY = 6;

export const RESOLVE_FAILED_MESSAGE =
  'Could not resolve this SoundCloud track. It may be private, removed or region-restricted.';

/** True when `target` is a SoundCloud *page* rather than a direct CDN file. */
export function isSoundCloudPageUrl(target) {
  let url;
  try {
    url = target instanceof URL ? target : new URL(String(target));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!SC_HOST_RE.test(url.hostname)) return false;
  // api-v2 / api / cdn hosts are handled by the plain relay, not the resolver.
  if (/^(api|api-v2|cf-media|playback|media-streaming)\./.test(url.hostname)) return false;
  // A direct file on soundcloud.com is already audio.
  return !/\.(mp3|wav|ogg|m4a|aac|flac|opus|webm|mp4)$/i.test(url.pathname);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function scHeaders(extra) {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
}

/**
 * Extract and parse the `window.__sc_hydration = [...]` blob from a track page.
 * Returns `null` when the marker is absent (bot wall, redirect, error page).
 */
export function parseHydration(html) {
  if (!html) return null;
  const match = /window\.__sc_hydration\s*=\s*(\[.*?\])\s*;\s*<\/script>/s.exec(html);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hydrationEntry(hydration, kind) {
  if (!Array.isArray(hydration)) return null;
  const entry = hydration.find(item => item && item.hydratable === kind);
  return entry ? entry.data : null;
}

/** The track object (`hydratable: "sound"`, or `"track"` on older pages). */
export function findTrack(hydration) {
  return hydrationEntry(hydration, 'sound') ?? hydrationEntry(hydration, 'track');
}

/** The `client_id` the page itself is using (`hydratable: "apiClient"`). */
export function findClientId(hydration) {
  const apiClient = hydrationEntry(hydration, 'apiClient');
  if (apiClient && typeof apiClient.id === 'string') return apiClient.id;
  return null;
}

/**
 * Pick the best transcoding: progressive first, then HLS. `abr_sq` (the adaptive
 * `audio/mpegurl` variant) is skipped — it is a pure playlist with no fixed
 * quality and the fixed-bitrate AAC variants are what a stitched file wants.
 */
export function selectTranscoding(track) {
  const transcodings = track?.media?.transcodings;
  if (!Array.isArray(transcodings)) return null;

  const progressive = transcodings.find(
    t => t?.format?.protocol === 'progressive' && typeof t.url === 'string'
  );
  if (progressive) return { protocol: 'progressive', url: progressive.url };

  const hls =
    transcodings.find(
      t =>
        t?.format?.protocol === 'hls' &&
        typeof t.url === 'string' &&
        t.preset !== 'abr_sq' &&
        /audio\/(mp4|mpeg)/i.test(t.format.mime_type ?? '')
    ) ?? transcodings.find(t => t?.format?.protocol === 'hls' && typeof t.url === 'string');

  return hls ? { protocol: 'hls', url: hls.url, preset: hls.preset } : null;
}

/** Build the media URL the API expects, carrying whichever auth it needs. */
function mediaUrl(transcodingUrl, clientId, trackAuthorization) {
  const url = new URL(transcodingUrl);
  url.searchParams.set('client_id', clientId);
  if (trackAuthorization) url.searchParams.set('track_authorization', trackAuthorization);
  return url.toString();
}

async function fetchText(url, accept) {
  const response = await fetch(url, {
    headers: scHeaders(accept ? { Accept: accept } : undefined),
    redirect: 'follow',
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, text: await response.text() };
}

async function fetchJson(url) {
  const result = await fetchText(url, 'application/json');
  if (!result.ok) return { ok: false, status: result.status };
  try {
    return { ok: true, data: JSON.parse(result.text) };
  } catch {
    return { ok: false, status: 502 };
  }
}

/**
 * Read an HLS playlist. Distinguishes a *master* playlist (variant streams, no
 * media) from a *media* playlist (init segment + fragments) — treating a master
 * playlist's variant URI as a media fragment would stitch an `.m3u8` into the
 * audio and corrupt it.
 *
 * Relative URIs are resolved against the playlist's own URL.
 */
export function parseHlsPlaylist(text, playlistUrl) {
  const base = new URL(playlistUrl);
  const isMaster = /#EXT-X-STREAM-INF/.test(text);
  let init = null;
  const segments = [];
  const variants = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]+)"/.exec(line);
      if (uri) init = new URL(uri[1], base).toString();
    } else if (line.startsWith('#')) {
      continue;
    } else if (isMaster) {
      variants.push(new URL(line, base).toString());
    } else {
      segments.push(new URL(line, base).toString());
    }
  }

  return { isMaster, init, segments, variants };
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchBytes(url, limit) {
  const response = await fetch(url, { headers: scHeaders(), redirect: 'follow' });
  if (!response.ok) throw new HttpError(`Segment fetch failed (${response.status})`, 502);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limit) throw new HttpError('Stream exceeds the size limit', 502);
  return new Uint8Array(buffer);
}

async function fetchPlaylist(url) {
  const result = await fetchText(url, 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*');
  if (!result.ok) {
    throw new HttpError(`SoundCloud playlist unavailable (${result.status})`, 502);
  }
  if (result.text.length > MAX_PLAYLIST_BYTES) {
    throw new HttpError('SoundCloud playlist is implausibly large', 502);
  }
  return parseHlsPlaylist(result.text, url);
}

/**
 * Stitch an HLS fragmented-MP4 stream into one progressive file: the init
 * segment (ftyp/moov) followed by every media segment (moof/mdat) in order.
 * A master playlist is followed one level down to its first variant.
 */
async function assembleFragmentedMp4(playlistUrl) {
  let playlist = await fetchPlaylist(playlistUrl);
  if (playlist.isMaster) {
    if (!playlist.variants.length) throw new HttpError('SoundCloud master playlist has no variants', 502);
    playlist = await fetchPlaylist(playlist.variants[0]);
  }

  const { init, segments } = playlist;
  if (!segments.length) throw new HttpError('SoundCloud returned an empty playlist', 502);
  if (segments.length > MAX_SEGMENTS) throw new HttpError('SoundCloud stream has too many segments', 502);

  // Fragments are independent, so fetch a few at a time — a 4-minute track has
  // ~25 of them and sequential round trips dominate the latency. The init
  // segment is small and must come first in the output, not first in time.
  const [initChunk, segmentChunks] = await Promise.all([
    init ? fetchBytes(init, MAX_TRACK_BYTES) : Promise.resolve(null),
    mapWithConcurrency(segments, SEGMENT_CONCURRENCY, url => fetchBytes(url, MAX_TRACK_BYTES)),
  ]);

  const chunks = initChunk ? [initChunk, ...segmentChunks] : segmentChunks;
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total > MAX_TRACK_BYTES) throw new HttpError('SoundCloud stream is too large', 502);

  return concatChunks(chunks, total);
}

/**
 * Resolve a SoundCloud track page to a single progressive audio payload.
 *
 * @returns {Promise<{ bytes: Uint8Array, contentType: string, track: object }>}
 * @throws {HttpError} with a user-facing message and an HTTP status
 */
export async function resolveSoundCloudTrack(pageUrl) {
  const page = await fetchText(pageUrl, 'text/html,application/xhtml+xml');
  if (!page.ok) {
    throw new HttpError(
      page.status === 404 ? 'SoundCloud track not found.' : RESOLVE_FAILED_MESSAGE,
      page.status === 404 ? 404 : 502
    );
  }

  const hydration = parseHydration(page.text);
  const track = hydration ? findTrack(hydration) : null;
  if (!track || !track.media) throw new HttpError(RESOLVE_FAILED_MESSAGE, 502);
  if (track.streamable === false) throw new HttpError('This SoundCloud track is not streamable.', 403);

  const clientId = findClientId(hydration);
  if (!clientId) throw new HttpError(RESOLVE_FAILED_MESSAGE, 502);

  const transcoding = selectTranscoding(track);
  if (!transcoding) throw new HttpError('No playable stream found for this track.', 502);

  const media = await fetchJson(mediaUrl(transcoding.url, clientId, track.track_authorization));
  if (!media.ok || typeof media.data?.url !== 'string') {
    throw new HttpError(RESOLVE_FAILED_MESSAGE, 502);
  }
  const streamUrl = media.data.url;

  if (transcoding.protocol === 'progressive') {
    return {
      bytes: await fetchBytes(streamUrl, MAX_TRACK_BYTES),
      contentType: 'audio/mpeg',
      track,
    };
  }

  const bytes = await assembleFragmentedMp4(streamUrl);
  return { bytes, contentType: 'audio/mp4', track };
}
