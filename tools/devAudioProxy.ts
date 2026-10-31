import type { Connect, Plugin } from 'vite';
// The resolver lives with the worker so development and production resolve
// SoundCloud through exactly the same code path — a second implementation here
// would drift and only break in production.
import { isSoundCloudPageUrl, resolveSoundCloudTrack, RESOLVE_FAILED_MESSAGE } from '../cloudflare-worker/src/soundcloud.js';

/**
 * Dev/preview implementation of the CORS audio proxy.
 *
 * Production uses the Cloudflare Worker in `cloudflare-worker/`, configured via
 * `VITE_AUDIO_PROXY_URL`. Without a local equivalent the client's default
 * `/api/audio-proxy` endpoint would 404 in development and every remote stream
 * would look "unavailable", so this middleware mirrors the worker's contract:
 * GET/HEAD/OPTIONS, CORS headers, transparent `Range` pass-through, and the
 * SoundCloud track resolver.
 *
 * Unlike the deployed worker this does not restrict target hosts — it only ever
 * runs on a developer's machine and never accepts traffic from the internet.
 */
export function audioProxyPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/api/audio-proxy') return next();

    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Access-Control-Max-Age': '86400',
    };

    const send = (status: number, body: string | null, extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...cors, ...extra });
      res.end(body);
    };

    if (req.method === 'OPTIONS') return send(204, null);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, JSON.stringify({ error: 'Method not allowed' }), {
        'Content-Type': 'application/json',
      });
    }

    const rawTarget = url.searchParams.get('url');
    if (!rawTarget) {
      return send(400, JSON.stringify({ error: 'Missing "url" query parameter' }), {
        'Content-Type': 'application/json',
      });
    }

    let target: URL;
    try {
      target = new URL(rawTarget);
    } catch {
      return send(400, JSON.stringify({ error: 'Invalid "url" query parameter' }), {
        'Content-Type': 'application/json',
      });
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return send(400, JSON.stringify({ error: 'Only http(s) URLs are supported' }), {
        'Content-Type': 'application/json',
      });
    }

    // Mirror the worker: resolve a SoundCloud track page to a single progressive
    // stream before relaying. Range is not honoured here either — the payload is
    // freshly stitched, so there is no upstream byte range to forward.
    if (isSoundCloudPageUrl(target)) {
      try {
        const { bytes, contentType } = await resolveSoundCloudTrack(target.toString());
        res.writeHead(200, {
          ...cors,
          'Content-Type': contentType,
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'no-store',
        });
        return res.end(req.method === 'HEAD' ? undefined : Buffer.from(bytes));
      } catch (err) {
        const status = (err as { status?: number }).status ?? 502;
        const message = (err as Error).message || RESOLVE_FAILED_MESSAGE;
        return send(status, JSON.stringify({ error: message }), { 'Content-Type': 'application/json' });
      }
    }

    const upstreamHeaders: Record<string, string> = { 'User-Agent': 'EchoLab-AudioProxy/1.0' };
    const range = req.headers.range;
    if (range) upstreamHeaders.Range = range;
    const accept = req.headers.accept;
    if (accept) upstreamHeaders.Accept = accept;

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers: upstreamHeaders,
        redirect: 'follow',
      });

      const out: Record<string, string> = {};
      for (const name of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'last-modified',
        'etag',
        'cache-control',
      ]) {
        const value = upstream.headers.get(name);
        if (value) out[name] = value;
      }
      if (!out['accept-ranges']) out['accept-ranges'] = 'bytes';
      if (!out['content-type']) out['content-type'] = 'audio/mpeg';

      if (req.method === 'HEAD' || !upstream.body) {
        res.writeHead(upstream.status, { ...cors, ...out });
        return res.end();
      }

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { ...cors, ...out });
      res.end(buffer);
    } catch (err) {
      send(502, JSON.stringify({ error: `Upstream fetch failed: ${(err as Error).message}` }), {
        'Content-Type': 'application/json',
      });
    }
  };

  return {
    name: 'echolab-audio-proxy',
    configureServer: server => {
      server.middlewares.use(handler);
    },
    configurePreviewServer: server => {
      server.middlewares.use(handler);
    },
  };
}
