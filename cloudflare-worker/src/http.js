/**
 * Shared HTTP helpers for the audio proxy.
 *
 * Kept separate from the request handler so the SoundCloud resolver and the
 * local Vite dev middleware can reuse the exact same CORS contract — a drift
 * between the deployed worker and local development is the kind of bug that
 * only shows up in production.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};

/** Copy `headers` and stamp the CORS contract onto the result. */
export function withCors(headers) {
  const merged = new Headers(headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) merged.set(key, value);
  return merged;
}

/** JSON error response, CORS-stamped so the browser can read the message. */
export function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: withCors({ 'Content-Type': 'application/json' }),
  });
}

/**
 * A failure with an HTTP status attached, so callers can map it straight onto a
 * response instead of guessing.
 */
export class HttpError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
