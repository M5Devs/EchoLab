/**
 * Audio content validation.
 *
 * `decodeAudioData` rejects anything that is not a linear PCM container, and it
 * does so with an opaque `DOMException: EncodingError` that tells the user
 * nothing. The most common way to reach that dead end is to fetch a *web page*
 * instead of a file: a SoundCloud track page, a Cloudflare/captcha interstitial,
 * a login redirect or an HLS `.m3u8` playlist are all valid HTTP responses that
 * are not audio at all.
 *
 * These helpers inspect the response `Content-Type` and the leading bytes (magic
 * number) of the payload *before* decoding, so the user gets a specific reason
 * instead of "Unable to decode audio data".
 */

export type AudioContainer =
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'm4a'
  | 'aac'
  | 'webm'
  | 'aiff';

/** Why a payload was rejected. Drives the message the user sees. */
export type AudioRejection =
  | 'html'
  | 'playlist'
  | 'json'
  | 'text'
  | 'unsupported';

export type SniffResult =
  | { ok: true; container: AudioContainer }
  | { ok: false; reason: AudioRejection; message: string };

export const HTML_PAGE_MESSAGE =
  'Invalid audio format: The URL returned a web page (HTML) instead of a direct audio file.';

export const PLAYLIST_MESSAGE =
  'Unsupported audio format: The URL is an HLS playlist (.m3u8), which cannot be decoded directly. Please provide a progressive MP3/stream URL.';

export const UNSUPPORTED_MESSAGE =
  'Unsupported audio codec: The file is not a recognised audio container (MP3, WAV, OGG, FLAC, M4A or AAC).';

export const JSON_RESPONSE_MESSAGE =
  'Invalid audio format: The URL returned a JSON response instead of audio.';

export const TEXT_RESPONSE_MESSAGE =
  'Invalid audio format: The URL returned a text response instead of audio.';

/** Content types that are never audio, however the response is labelled. */
const NON_AUDIO_CONTENT_TYPES: ReadonlyArray<{
  pattern: RegExp;
  reason: AudioRejection;
  message: string;
}> = [
  { pattern: /text\/html|application\/xhtml/i, reason: 'html', message: HTML_PAGE_MESSAGE },
  {
    pattern: /application\/(?:x-)?mpegurl|application\/vnd\.apple\.mpegurl/i,
    reason: 'playlist',
    message: PLAYLIST_MESSAGE,
  },
  { pattern: /application\/json|\+json/i, reason: 'json', message: JSON_RESPONSE_MESSAGE },
  {
    pattern: /text\/(?:plain|xml)|application\/xml/i,
    reason: 'text',
    message: TEXT_RESPONSE_MESSAGE,
  },
];

/**
 * Check a `Content-Type` header. Returns the rejection to surface, or `null` when
 * the header is absent or plausibly audio.
 *
 * A server that omits the header (or sends the generic
 * `application/octet-stream`) is given the benefit of the doubt and validated by
 * magic bytes instead — many CDNs label audio exactly that way.
 */
export function rejectByContentType(
  contentType: string | null | undefined
): { reason: AudioRejection; message: string } | null {
  if (!contentType) return null;
  const value = contentType.split(';')[0].trim();
  if (!value) return null;
  for (const entry of NON_AUDIO_CONTENT_TYPES) {
    if (entry.pattern.test(value)) return { reason: entry.reason, message: entry.message };
  }
  return null;
}

const startsWith = (bytes: Uint8Array, ascii: string, offset = 0): boolean => {
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
};

/**
 * Identify the audio container from the leading bytes of a payload.
 *
 * Detection is deliberately structural rather than exhaustive: the goal is to
 * tell "this is audio" apart from "this is a web page", and to name the
 * container well enough to explain a failure.
 */
export function sniffAudioContainer(buffer: ArrayBuffer | Uint8Array): SniffResult {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.length < 12) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Invalid audio data: The response was too short to contain an audio file.',
    };
  }

  // Skip a UTF-8 BOM and leading whitespace before testing for markup: a page
  // served with a BOM still begins with `<` in spirit.
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && /[\s]/.test(String.fromCharCode(bytes[start]))) start++;

  if (bytes[start] === 0x3c /* '<' */) {
    return { ok: false, reason: 'html', message: HTML_PAGE_MESSAGE };
  }
  // UTF-16 markup: a BOM followed by '<' (0x3C 0x00 or 0x00 0x3C). Checked here
  // because 0xFF/0xFE would otherwise be mistaken for an MPEG frame sync below.
  if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x3c) {
    return { ok: false, reason: 'html', message: HTML_PAGE_MESSAGE };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff && bytes[3] === 0x3c) {
    return { ok: false, reason: 'html', message: HTML_PAGE_MESSAGE };
  }
  if (startsWith(bytes, '#EXTM3U', start)) {
    return { ok: false, reason: 'playlist', message: PLAYLIST_MESSAGE };
  }
  if (bytes[start] === 0x7b /* '{' */ || bytes[start] === 0x5b /* '[' */) {
    return { ok: false, reason: 'json', message: JSON_RESPONSE_MESSAGE };
  }

  // WAV: "RIFF" .... "WAVE"
  if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WAVE', 8)) {
    return { ok: true, container: 'wav' };
  }
  // AIFF: "FORM" .... "AIFF"
  if (startsWith(bytes, 'FORM') && startsWith(bytes, 'AIFF', 8)) {
    return { ok: true, container: 'aiff' };
  }
  if (startsWith(bytes, 'OggS')) return { ok: true, container: 'ogg' };
  if (startsWith(bytes, 'fLaC')) return { ok: true, container: 'flac' };
  // ISO base media (M4A/MP4): size .... "ftyp"
  if (startsWith(bytes, 'ftyp', 4)) return { ok: true, container: 'm4a' };
  // Matroska/WebM: EBML header.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { ok: true, container: 'webm' };
  }
  // MP3 with an ID3v2 tag.
  if (startsWith(bytes, 'ID3')) return { ok: true, container: 'mp3' };
  // MPEG audio frame sync (11 set bits) — raw MP3 without an ID3 tag.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // ADTS AAC shares the sync word; layer bits (0xF6 mask) of 00 mean AAC.
    if ((bytes[1] & 0xf6) === 0xf0) {
      return { ok: true, container: 'aac' };
    }
    return { ok: true, container: 'mp3' };
  }

  return { ok: false, reason: 'unsupported', message: UNSUPPORTED_MESSAGE };
}

/**
 * Full pre-decode gate: `Content-Type` first (cheap, and it catches a redirect to
 * an HTML error page), then magic bytes.
 */
export function validateAudioPayload(
  buffer: ArrayBuffer | Uint8Array,
  contentType?: string | null
): SniffResult {
  const byType = rejectByContentType(contentType);
  if (byType) return { ok: false, reason: byType.reason, message: byType.message };
  return sniffAudioContainer(buffer);
}

export const SOUNDCLOUD_PAGE_MESSAGE =
  'SoundCloud track pages cannot be streamed directly. Please provide a direct audio stream URL or MP3 link.';

export const STREAMING_PAGE_MESSAGE =
  'That link is a streaming web page, not an audio file. Please provide a direct audio stream URL or MP3 link.';

const PAGE_HOSTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)soundcloud\.com$/i, SOUNDCLOUD_PAGE_MESSAGE],
  [/(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i, STREAMING_PAGE_MESSAGE],
  [/(^|\.)(spotify\.com|open\.spotify\.com)$/i, STREAMING_PAGE_MESSAGE],
  [/(^|\.)(bandcamp\.com)$/i, STREAMING_PAGE_MESSAGE],
];

/** Extensions that are direct audio files rather than a web page. */
const DIRECT_AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac|weba|webm|aiff?|mp4)(\?|#|$)/i;

/**
 * Detect a link that points at a *page* (SoundCloud, YouTube, …) rather than a
 * direct audio file, and return the guidance to show. Returns `null` when the URL
 * looks like a plausible direct audio resource.
 *
 * EchoLab has no streaming-service resolver, so a page URL can only ever resolve
 * to HTML — better to say so up front than to fail later with a decode error.
 */
export function describeUnsupportedPageUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (DIRECT_AUDIO_EXTENSIONS.test(parsed.pathname)) return null;
  for (const [pattern, message] of PAGE_HOSTS) {
    if (pattern.test(parsed.hostname)) return message;
  }
  return null;
}
