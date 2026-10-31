import type { Connect, Plugin } from 'vite';
// The proxy core lives with the worker so that development, the Cloudflare
// Worker and the Vercel function all run the same request handling. A second
// implementation here would drift and only break in production.
import { handleAudioProxy } from '../cloudflare-worker/src/proxy.js';

/**
 * Dev/preview implementation of the CORS audio proxy.
 *
 * Production is served by either the Cloudflare Worker in `cloudflare-worker/`
 * (via `VITE_AUDIO_PROXY_URL`) or the Vercel Serverless Function in
 * `api/audio-proxy.ts`. Without a local equivalent the client's default
 * `/api/audio-proxy` endpoint would 404 in development and every remote stream
 * would look "unavailable", so this middleware delegates to the same core those
 * two use.
 *
 * Unlike the deployed endpoints this does not restrict target hosts — it only
 * ever runs on a developer's machine and never accepts traffic from the
 * internet. It also serves a resolved track whole, since a local response has no
 * size cap.
 */
export function audioProxyPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/api/audio-proxy') return next();

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }

    const request = new Request(url.toString(), { method: req.method ?? 'GET', headers });
    const response = await handleAudioProxy(request, { allowList: false });

    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });

    // 204/304 must not carry a body, and HEAD reports headers only.
    if (req.method === 'HEAD' || response.status === 204 || response.status === 304) {
      res.writeHead(response.status, out);
      return res.end();
    }

    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
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
