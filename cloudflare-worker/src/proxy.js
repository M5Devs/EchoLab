/**
 * Runtime-neutral CORS audio proxy core.
 *
 * One implementation of the proxy contract, shared by every deployment target:
 *
 *   cloudflare-worker/src/index.js   (Cloudflare Worker)
 *   api/audio-proxy.ts               (Vercel Serverless Function)
 *   tools/devAudioProxy.ts           (Vite dev / preview middleware)
 *
 * The three previously carried separate copies of the relay logic. They drifted
 * — the resolver was wired into the worker but the client still refused
 * SoundCloud URLs, and a `HttpError` import went missing in a copy — so the
 * request handling lives here once and the adapters only translate their
 * platform's request/response types.
 *
 * Everything here is Web-standard (`Request` in, `Response` out) because that is
 * the lowest common denominator: the Worker speaks it natively, and Node 18+
 * (Vercel functions, Vite middleware) provides it globally.
 */

import { withCors, jsonError, HttpError } from './http.js';
import { isSoundCloudPageUrl, resolveSoundCloudTrack } from './soundcloud.js';

/**
 * Vercel Functions cap the request *and* response body at 4.5 MB. A stitched
 * SoundCloud track is routinely larger (a 4-minute track is ~5 MB), so the
 * resolved audio is served in ranges that stay under the cap and the client
 * assembles them. See `PROXY_CHUNK_BYTES`.
 */
export const VERCEL_MAX_RESPONSE_BYTES = 4.5 * 1024 * 1024;

/**
 * Chunk size for serving a resolved SoundCloud track. Deliberately below the
 * 4.5 MB platform ceiling so a chunk plus headers can never trip it.
 */
export const PROXY_CHUNK_BYTES = 4 * 1024 * 1024;

/** How long a resolved track stays cached, and how many are kept. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 4;

/**
 * Hosts the proxy will relay. Only applied when `allowList` is on — the public
 * endpoints (Worker, Vercel) must not become open web relays, while the local
 * dev middleware only ever sees a developer's own machine.
 */
const ALLOWED_HOST_SUFFIXES = [
  'soundcloud.com',
  'sndcdn.com',
  'soundcloud.cloud',
  'cloudfront.net',
  'akamaized.net',
  'scdn.co',
  'mzstatic.com',
];

const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.webm'];

function isAllowedTarget(target) {
  const host = target.hostname.toLowerCase();
  const path = target.pathname.toLowerCase();
  const hostOk = ALLOWED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  const extOk = ALLOWED_EXTENSIONS.some(ext => path.endsWith(ext));
  // A direct audio file on any host is fine; otherwise the host must be trusted.
  return hostOk || extOk;
}

const RELAYED_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
  'Last-Modified',
  'ETag',
  'Cache-Control',
];

function passthroughHeaders(upstream) {
  const headers = new Headers();
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes');
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'audio/mpeg');
  return headers;
}

/** Forward only the headers that matter for streaming; never leak cookies. */
function upstreamRequestHeaders(request) {
  const headers = new Headers();
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  const accept = request.headers.get('Accept');
  if (accept) headers.set('Accept', accept);
  headers.set('User-Agent', 'EchoLab-AudioProxy/1.0');
  return headers;
}

async function relay(request, target) {
  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers: upstreamRequestHeaders(request),
    redirect: 'follow',
  });
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: withCors(passthroughHeaders(upstream)),
  });
}

/**
 * Parse a single-range `Range` header against a known total length.
 * Returns `null` when the header is absent or malformed (caller then serves from
 * the start), so a garbage range degrades to a full read rather than a 416.
 */
export function parseRange(header, total) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return null;

  let start;
  let end;
  if (startRaw === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? total - 1 : Number(endRaw);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= total) return null;
  return { start, end: Math.min(end, total - 1) };
}

// Resolving a track costs a page fetch, a transcoding call and ~25 segment
// fetches. Serving it in ranges means several requests per track, so a warm
// instance keeps the assembled bytes briefly rather than re-resolving each time.
const resolveCache = new Map();

async function resolveCached(pageUrl) {
  const now = Date.now();
  const hit = resolveCache.get(pageUrl);
  if (hit && hit.expires > now) return hit.value;

  const value = await resolveSoundCloudTrack(pageUrl);
  resolveCache.set(pageUrl, { value, expires: now + CACHE_TTL_MS });
  while (resolveCache.size > CACHE_MAX_ENTRIES) {
    const oldest = resolveCache.keys().next().value;
    resolveCache.delete(oldest);
  }
  return value;
}

/** Drop the resolve cache. Exposed for tests. */
export function clearResolveCache() {
  resolveCache.clear();
}

/**
 * Serve a resolved SoundCloud track.
 *
 * When `chunkBytes` is set and the track is larger, a single range is returned
 * with `Content-Range` advertising the full length, and `Accept-Ranges: bytes`
 * so the client can pull the remainder. Without chunking the whole payload is
 * returned and — because there is no upstream range to forward and the response
 * is served once — `Accept-Ranges` is deliberately *not* advertised.
 */
async function serveSoundCloudTrack(request, target, chunkBytes) {
  const { bytes, contentType } = await resolveCached(target.toString());
  const total = bytes.byteLength;

  if (!chunkBytes || total <= chunkBytes) {
    return new Response(request.method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: withCors({
        'Content-Type': contentType,
        'Content-Length': String(total),
        'Cache-Control': 'no-store',
      }),
    });
  }

  const requested = parseRange(request.headers.get('Range'), total);
  // Clamp to one chunk even when the client asked for more (e.g. `bytes=0-`).
  // Serving the requested span verbatim would exceed the platform cap this
  // chunking exists to stay under; the client follows `Content-Range` instead.
  const start = requested ? requested.start : 0;
  const end = Math.min(requested ? requested.end : chunkBytes - 1, start + chunkBytes - 1, total - 1);
  const slice = bytes.subarray(start, end + 1);

  return new Response(request.method === 'HEAD' ? null : slice, {
    status: 206,
    headers: withCors({
      'Content-Type': contentType,
      'Content-Length': String(slice.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    }),
  });
}

/**
 * Handle one audio-proxy request.
 *
 * @param {Request} request
 * @param {{ allowList?: boolean, chunkBytes?: number | null }} [options]
 * @returns {Promise<Response>}
 */
export async function handleAudioProxy(request, options = {}) {
  const { allowList = true, chunkBytes = null } = options;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors({}) });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonError(405, 'Method not allowed');
  }

  const rawTarget = new URL(request.url).searchParams.get('url');
  if (!rawTarget) {
    return jsonError(400, 'Missing "url" query parameter');
  }

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    return jsonError(400, 'Invalid "url" query parameter');
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return jsonError(400, 'Only http(s) URLs are supported');
  }

  if (allowList && !isAllowedTarget(target)) {
    return jsonError(403, 'Host is not on the audio allow-list');
  }

  // A SoundCloud track *page* is resolved to audio before relaying.
  if (isSoundCloudPageUrl(target)) {
    try {
      return await serveSoundCloudTrack(request, target, chunkBytes);
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.status, err.message);
      return jsonError(502, `SoundCloud resolve failed: ${err.message}`);
    }
  }

  try {
    return await relay(request, target);
  } catch (err) {
    return jsonError(502, `Upstream fetch failed: ${err.message}`);
  }
}
