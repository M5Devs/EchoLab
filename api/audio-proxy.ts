/**
 * Vercel Serverless Function — `/api/audio-proxy`.
 *
 * The production endpoint for EchoLab's CORS audio proxy. Without it, requests
 * to `/api/audio-proxy` on Vercel fall through the SPA rewrite to `index.html`
 * and every remote stream looks "unavailable" in production.
 *
 * The request handling itself lives in `cloudflare-worker/src/proxy.js`, shared
 * with the Cloudflare Worker and the Vite dev middleware, so the three cannot
 * drift. This file only adapts Node's `(req, res)` pair to the Web-standard
 * `Request`/`Response` that core speaks.
 *
 * ## The 4.5 MB response cap
 *
 * Vercel Functions cap the response body at 4.5 MB, and a stitched SoundCloud
 * track is routinely larger — the 4-minute acceptance track resolves to 5.0 MB.
 * Returning it in one response would fail with
 * `413 FUNCTION_PAYLOAD_TOO_LARGE`, so the core is asked to serve it in 4 MB
 * ranges (`PROXY_CHUNK_BYTES`) and the client stitches them back together (see
 * `assembleChunkedResponse` in `src/utils/audioProxy.ts`).
 *
 * For that to work the SPA rewrite in `vercel.json` must not swallow `/api/*`,
 * and the function must run long enough to assemble a track (~1-3 s) and to
 * relay a full-length download.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { handleAudioProxy, PROXY_CHUNK_BYTES } from '../cloudflare-worker/src/proxy.js';

/** Assemble a track and relay it back; a few seconds is normal, not an error. */
export const config = { maxDuration: 60 };

/**
 * Rebuild the absolute request URL. Vercel terminates TLS upstream, so
 * `req.url` is a path and the real origin is only in the forwarded headers.
 */
function requestOrigin(req: VercelRequest): string {
  const proto = headerValue(req, 'x-forwarded-proto') ?? 'https';
  const host = headerValue(req, 'x-forwarded-host') ?? headerValue(req, 'host') ?? 'localhost';
  return `${proto}://${host}`;
}

function headerValue(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function toWebRequest(req: VercelRequest): Request {
  const url = new URL(req.url ?? '/', requestOrigin(req));
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  // GET/HEAD carry no body, so it is never read.
  return new Request(url.toString(), { method: req.method ?? 'GET', headers });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let response: Response;
  try {
    response = await handleAudioProxy(toWebRequest(req), {
      allowList: true,
      chunkBytes: PROXY_CHUNK_BYTES,
    });
  } catch (err) {
    // Never let an unexpected throw escape as an opaque platform error — the
    // client turns a JSON `error` field into a readable toast.
    const message = err instanceof Error ? err.message : 'Audio proxy failed';
    res.status(502).json({ error: `Audio proxy failed: ${message}` });
    return;
  }

  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));

  // 204/304 must not carry a body, and HEAD reports headers only.
  if (req.method === 'HEAD' || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }

  res.send(Buffer.from(await response.arrayBuffer()));
}
