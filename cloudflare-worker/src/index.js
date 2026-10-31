/**
 * EchoLab CORS Audio Proxy — Cloudflare Worker
 *
 * Relays remote audio streams (SoundCloud, external CDNs) so the browser can
 * fetch and decode them despite the origin server omitting CORS headers.
 *
 * Features
 *  - GET / HEAD / OPTIONS, with full CORS preflight support
 *  - Transparent `Range` pass-through, so seeking/scrubbing keeps working
 *  - `Accept-Ranges`, `Content-Length`, `Content-Range` exposure for the client
 *  - Native SoundCloud resolver: a track *page* URL is resolved to its audio and
 *    returned as one progressive stream (see `soundcloud.js`)
 *
 * Deploy
 *   cd cloudflare-worker
 *   npx wrangler deploy
 *   # then set VITE_AUDIO_PROXY_URL=https://<worker>.<subdomain>.workers.dev
 *
 * Local development
 *   npx wrangler dev
 */

import { withCors, jsonError, HttpError } from './http.js';
import { isSoundCloudPageUrl, resolveSoundCloudTrack } from './soundcloud.js';

// Only relay plausible audio/media URLs so the worker cannot be abused as an
// open web relay.
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
 * Resolve a SoundCloud track page and return the whole audio as one buffer.
 *
 * Range is deliberately not honoured: the response is a freshly stitched file
 * with no upstream byte range to forward, so advertising `Accept-Ranges: bytes`
 * would be a lie and seeking would break.
 */
async function serveSoundCloudTrack(request, target) {
  const { bytes, contentType } = await resolveSoundCloudTrack(target.toString());
  const headers = withCors({
    'Content-Type': contentType,
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store',
  });
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors({}) });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonError(405, 'Method not allowed');
    }

    const requestUrl = new URL(request.url);
    const rawTarget = requestUrl.searchParams.get('url');
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

    if (!isAllowedTarget(target)) {
      return jsonError(403, 'Host is not on the audio allow-list');
    }

    // A SoundCloud track *page* is resolved to audio before relaying.
    if (isSoundCloudPageUrl(target)) {
      try {
        return await serveSoundCloudTrack(request, target);
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
  },
};
