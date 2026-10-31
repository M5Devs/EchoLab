/**
 * Client helper for the CORS audio proxy.
 *
 * Browsers cannot fetch most third-party audio hosts (SoundCloud CDNs, label
 * CDNs) directly because they omit `Access-Control-Allow-Origin`. The proxy
 * relays the stream, mirrors the `Range` header so seeking keeps working, and
 * adds the CORS headers the browser requires.
 *
 * The proxy is the Cloudflare Worker in `cloudflare-worker/`, the Vercel
 * Serverless Function in `api/audio-proxy.ts`, or the Vite dev middleware in
 * `tools/devAudioProxy.ts` — all three run the same core in
 * `cloudflare-worker/src/proxy.js`.
 *
 * Configure the endpoint with `VITE_AUDIO_PROXY_URL`; when unset the app falls
 * back to the same-origin `/api/audio-proxy` route.
 */

import { HTML_PAGE_MESSAGE, PLAYLIST_MESSAGE } from './audioFormat';

const DEFAULT_PROXY_PATH = '/api/audio-proxy';

/** Guard against a proxy that keeps advertising more bytes than it sends. */
const MAX_ASSEMBLED_BYTES = 256 * 1024 * 1024;
const MAX_CHUNK_REQUESTS = 64;

export function getAudioProxyEndpoint(): string {
  const configured = (import.meta.env?.VITE_AUDIO_PROXY_URL as string | undefined)?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return DEFAULT_PROXY_PATH;
}

/**
 * Wrap a remote streaming URL so it is fetched through the CORS proxy.
 * Relative and `data:`/`blob:` URLs are returned untouched — they are already
 * same-origin or in-memory and gain nothing from the proxy.
 */
export function getProxiedAudioUrl(url: string): string {
  if (!url) return url;
  if (/^(data|blob):/i.test(url)) return url;
  if (/^\/(?!\/)/.test(url)) return url;

  try {
    const parsed = new URL(url);
    if (parsed.origin === window.location.origin) return url;
  } catch {
    return url;
  }

  const endpoint = getAudioProxyEndpoint();
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}url=${encodeURIComponent(url)}`;
}

export class AudioProxyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AudioProxyError';
  }
}

function describeFailure(status?: number): string {
  if (status === 403) return 'Track unavailable or geo-restricted.';
  if (status === 404) return 'Track not found at that URL.';
  if (status === 429) return 'Too many requests — try again shortly.';
  if (status && status >= 500) return 'Audio proxy is temporarily unavailable.';
  return 'Track unavailable or geo-restricted.';
}

/**
 * Build the message for a non-OK response.
 *
 * An HTML body is reported as such even when the status also carries a meaning
 * (a Cloudflare/captcha interstitial is a 403 whose body is a web page), because
 * "you were served a web page" is the actionable diagnosis. The proxy's own JSON
 * errors carry a specific message — a SoundCloud resolve failure, for instance —
 * which is more useful than any generic phrasing. Other statuses keep their
 * precise HTTP meaning.
 */
async function describeHttpFailure(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  if (/text\/html|application\/xhtml/i.test(contentType)) return HTML_PAGE_MESSAGE;
  if (/mpegurl/i.test(contentType)) return PLAYLIST_MESSAGE;
  if (/application\/json/i.test(contentType)) {
    try {
      const body = await response.clone().json();
      if (body && typeof body.error === 'string' && body.error) return body.error;
    } catch {
      // Not a JSON error envelope — fall through to the status wording.
    }
  }
  return describeFailure(response.status);
}

/**
 * Follow a chunked (`206` + `Content-Range`) response to completion.
 *
 * A Vercel Function cannot return a body over 4.5 MB, and a resolved SoundCloud
 * track is routinely larger, so the function serves it in ranges that stay under
 * the cap. Each chunk is fetched with an explicit `Range` so this works even if
 * the platform ignores `Accept-Ranges` for the follow-up requests.
 *
 * Returns the original response untouched when it is not a partial one, so the
 * Cloudflare Worker and the dev middleware — which serve the whole payload in a
 * single 200 — keep streaming without buffering.
 *
 * A partial response is also passed through when the *caller* asked for a range.
 * Only a 206 the proxy produced on its own (to stay under a platform body cap)
 * should be followed to completion; reassembling a caller's `Range: bytes=0-99`
 * would turn a deliberate 100-byte read into a full-file download.
 */
export async function assembleChunkedResponse(
  response: Response,
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (new Headers(init?.headers).has('Range')) return response;

  const contentRange = response.headers.get('content-range');
  if (response.status !== 206 || !contentRange) return response;

  const match = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(contentRange);
  if (!match) return response;

  const total = Number(match[3]);
  if (!Number.isFinite(total) || total <= 0 || total > MAX_ASSEMBLED_BYTES) return response;

  const chunks: Uint8Array[] = [new Uint8Array(await response.arrayBuffer())];
  let received = chunks[0].byteLength;

  // Resume from where the last chunk ended rather than trusting its advertised
  // end, so a short read cannot silently leave a hole in the audio.
  let next = Number(match[1]) + chunks[0].byteLength;
  const endpoint = getProxiedAudioUrl(url);

  for (let request = 0; received < total && request < MAX_CHUNK_REQUESTS; request++) {
    const headers = new Headers(init?.headers);
    headers.set('Range', `bytes=${next}-${total - 1}`);

    const part = await fetchImpl(endpoint, { ...init, headers });
    if (!part.ok || part.status !== 206) break;

    const bytes = new Uint8Array(await part.arrayBuffer());
    if (!bytes.byteLength) break;
    chunks.push(bytes);
    received += bytes.byteLength;
    next += bytes.byteLength;
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Length', String(merged.byteLength));
  headers.delete('Content-Range');
  return new Response(merged, { status: 200, headers });
}

/**
 * Fetch an audio resource, first directly (cheap, no proxy hop) and then through
 * the proxy. Throws an {@link AudioProxyError} with a user-facing message.
 */
export async function fetchAudioWithProxy(
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const isRemote = /^https?:\/\//i.test(url) && !url.startsWith(window.location.origin);

  if (!isRemote) {
    const direct = await fetchImpl(url, init);
    if (!direct.ok) {
      throw new AudioProxyError(await describeHttpFailure(direct), direct.status);
    }
    return direct;
  }

  try {
    const direct = await fetchImpl(url, init);
    if (direct.ok) return direct;
  } catch {
    // Expected for CORS-restricted hosts — fall through to the proxy.
  }

  try {
    const proxied = await fetchImpl(getProxiedAudioUrl(url), init);
    if (!proxied.ok) {
      throw new AudioProxyError(await describeHttpFailure(proxied), proxied.status);
    }
    return await assembleChunkedResponse(proxied, url, init, fetchImpl);
  } catch (err) {
    if (err instanceof AudioProxyError) throw err;
    throw new AudioProxyError(describeFailure());
  }
}
