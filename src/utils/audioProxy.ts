/**
 * Client helper for the Cloudflare Worker CORS audio proxy.
 *
 * Browsers cannot fetch most third-party audio hosts (SoundCloud CDNs, label
 * CDNs) directly because they omit `Access-Control-Allow-Origin`. The worker in
 * `cloudflare-worker/` relays the stream, mirrors the `Range` header so seeking
 * keeps working, and adds the CORS headers the browser requires.
 *
 * Configure the endpoint with `VITE_AUDIO_PROXY_URL`; when unset the app falls
 * back to the same-origin `/api/audio-proxy` route.
 */

import { HTML_PAGE_MESSAGE, PLAYLIST_MESSAGE } from './audioFormat';

const DEFAULT_PROXY_PATH = '/api/audio-proxy';

export function getAudioProxyEndpoint(): string {
  const configured = (import.meta.env.VITE_AUDIO_PROXY_URL as string | undefined)?.trim();
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
    return proxied;
  } catch (err) {
    if (err instanceof AudioProxyError) throw err;
    throw new AudioProxyError(describeFailure());
  }
}
