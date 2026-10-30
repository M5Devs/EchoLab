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
 *
 * Deploy
 *   cd cloudflare-worker
 *   npx wrangler deploy
 *   # then set VITE_AUDIO_PROXY_URL=https://<worker>.<subdomain>.workers.dev
 *
 * Local development
 *   npx wrangler dev
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};

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

function withCors(headers) {
  const merged = new Headers(headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) merged.set(key, value);
  return merged;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: withCors({ 'Content-Type': 'application/json' }),
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors({}) });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'Method not allowed');
    }

    const requestUrl = new URL(request.url);
    const rawTarget = requestUrl.searchParams.get('url');
    if (!rawTarget) {
      return errorResponse(400, 'Missing "url" query parameter');
    }

    let target;
    try {
      target = new URL(rawTarget);
    } catch {
      return errorResponse(400, 'Invalid "url" query parameter');
    }

    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return errorResponse(400, 'Only http(s) URLs are supported');
    }

    if (!isAllowedTarget(target)) {
      return errorResponse(403, 'Host is not on the audio allow-list');
    }

    // Forward only the headers that matter for streaming; never leak cookies.
    const upstreamHeaders = new Headers();
    const range = request.headers.get('Range');
    if (range) upstreamHeaders.set('Range', range);
    const accept = request.headers.get('Accept');
    if (accept) upstreamHeaders.set('Accept', accept);
    upstreamHeaders.set('User-Agent', 'EchoLab-AudioProxy/1.0');

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        redirect: 'follow',
      });
    } catch (err) {
      return errorResponse(502, `Upstream fetch failed: ${err.message}`);
    }

    const responseHeaders = new Headers();
    for (const name of [
      'Content-Type',
      'Content-Length',
      'Content-Range',
      'Accept-Ranges',
      'Last-Modified',
      'ETag',
      'Cache-Control',
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (!responseHeaders.has('Accept-Ranges')) responseHeaders.set('Accept-Ranges', 'bytes');
    if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'audio/mpeg');

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: withCors(responseHeaders),
    });
  },
};
