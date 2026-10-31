/**
 * Integration test for the Vercel Serverless Function `api/audio-proxy`.
 *
 * Drives the *real* handler through a minimal fake `VercelRequest`/
 * `VercelResponse` against a stubbed `fetch`, so the adapter (header forwarding,
 * origin reconstruction, body handling) and the shared proxy core are exercised
 * as deployed.
 *
 * The Vercel-specific behaviour under test is the 4.5 MB response cap: a
 * resolved track larger than that must come back as ranged 206 responses, and
 * following those ranges must reproduce the audio byte-for-byte.
 *
 * Usage:  node tools/test_vercel_api.mjs
 */

import assert from 'node:assert/strict';
import handler, { config } from '../api/audio-proxy.ts';

const SC_CLIENT_ID = 'QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k';
const VERCEL_MAX_RESPONSE_BYTES = 4.5 * 1024 * 1024;

const INIT = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypiso5'), Buffer.alloc(16)]);

// Deliberately larger than the 4.5 MB Vercel response cap so the chunking path
// is the one under test.
const SEGMENT_BYTES = 1024 * 1024;
const SEGMENTS = Array.from({ length: 5 }, (_, i) =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('moof'), Buffer.alloc(SEGMENT_BYTES, i + 1)])
);
const EXPECTED = Buffer.concat([INIT, ...SEGMENTS]);

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MAP:URI="init.mp4"',
  ...SEGMENTS.flatMap((_, i) => ['#EXTINF:10.0,', `seg${i}.m4s`]),
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const HYDRATION = [
  { hydratable: 'apiClient', data: { id: SC_CLIENT_ID } },
  {
    hydratable: 'sound',
    data: {
      kind: 'track',
      title: 'Vercel Test Track',
      streamable: true,
      track_authorization: 'token',
      media: {
        transcodings: [
          {
            format: { protocol: 'hls', mime_type: 'audio/mp4' },
            preset: 'aac_160k',
            url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:1/abc/stream/hls',
          },
        ],
      },
    },
  },
];

const TRACK_PAGE =
  '<!DOCTYPE html><html><body><script>window.__sc_hydration = ' +
  JSON.stringify(HYDRATION) +
  ';</script></body></html>';

const AUDIO_BODY = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00' + 'B'.repeat(64));

function stubFetch(calls) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, headers });
    const { hostname, pathname } = new URL(url);

    if (hostname === 'soundcloud.com') {
      return new Response(TRACK_PAGE, { headers: { 'Content-Type': 'text/html' } });
    }
    if (hostname === 'api-v2.soundcloud.com') {
      assert.ok(url.includes(`client_id=${SC_CLIENT_ID}`), `client_id missing from ${url}`);
      return Response.json({ url: 'https://playback.media-streaming.soundcloud.cloud/x/playlist.m3u8' });
    }
    if (pathname === '/x/playlist.m3u8') {
      return new Response(PLAYLIST, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (pathname === '/x/init.mp4') {
      return new Response(INIT, { headers: { 'Content-Type': 'video/mp4' } });
    }
    if (/^\/x\/seg\d+\.m4s$/.test(pathname)) {
      const index = Number(/(\d+)/.exec(pathname)[1]);
      return new Response(SEGMENTS[index], { headers: { 'Content-Type': 'video/iso.segment' } });
    }
    if (hostname === 'cdn.example.com') {
      if (headers.get('Range')) {
        return new Response(AUDIO_BODY.subarray(0, 10), {
          status: 206,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Length': '10',
            'Content-Range': `bytes 0-9/${AUDIO_BODY.length}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }
      return new Response(AUDIO_BODY, {
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(AUDIO_BODY.length) },
      });
    }
    if (hostname === 'gone.example.com') return new Response('nope', { status: 404 });
    throw new Error(`unstubbed upstream: ${url}`);
  };
}

/**
 * Minimal stand-in for Vercel's `(req, res)` pair. Captures the status, headers
 * and body so the test can assert on exactly what would reach the client.
 */
function invoke({ method = 'GET', url = '/api/audio-proxy', headers = {}, body }) {
  const req = { method, url, headers, query: {}, cookies: {}, body };
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    send(payload) {
      this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
      this.ended = true;
      return this;
    },
    json(payload) {
      this.body = Buffer.from(JSON.stringify(payload));
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return handler(req, res).then(() => res);
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const proxyPath = target => `/api/audio-proxy?url=${encodeURIComponent(target)}`;

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = stubFetch(calls);

// ── The function exists and is configured as Vercel expects ───────────────────
check('default export is a function (a valid Vercel handler)', typeof handler === 'function');
check('a maxDuration is configured for the long assemble+relay path',
  typeof config?.maxDuration === 'number' && config.maxDuration >= 30, JSON.stringify(config));

// ── CORS preflight (the route must answer, not fall through to index.html) ────
const preflight = await invoke({ method: 'OPTIONS' });
check('OPTIONS preflight is a 204 with the full CORS contract',
  preflight.statusCode === 204 &&
  preflight.headers['access-control-allow-origin'] === '*' &&
  preflight.headers['access-control-allow-methods'] === 'GET, HEAD, OPTIONS' &&
  preflight.headers['access-control-expose-headers'] ===
    'Content-Length, Content-Range, Accept-Ranges',
  `status=${preflight.statusCode} ${JSON.stringify(preflight.headers)}`);

// ── Argument handling ────────────────────────────────────────────────────────
const missing = await invoke({ url: '/api/audio-proxy' });
check('missing ?url= is a 400 with a JSON error',
  missing.statusCode === 400 && JSON.parse(missing.body).error, `status=${missing.statusCode}`);

const badMethod = await invoke({ method: 'POST', url: proxyPath('https://cdn.example.com/a.mp3') });
check('POST is a 405', badMethod.statusCode === 405, `status=${badMethod.statusCode}`);

const blocked = await invoke({ url: proxyPath('https://evil.example.net/steal') });
check('hosts off the allow-list are refused (403)', blocked.statusCode === 403, `status=${blocked.statusCode}`);

// ── A resolved track larger than the cap is served in ranges ─────────────────
const first = await invoke({ url: proxyPath('https://soundcloud.com/artist/big-track') });
const firstBytes = first.body;

check('a >4.5 MB track is served as 206, not one oversized body', first.statusCode === 206,
  `status=${first.statusCode}`);
check('no single response exceeds the 4.5 MB Vercel cap',
  firstBytes.length <= VERCEL_MAX_RESPONSE_BYTES,
  `${firstBytes.length} bytes > ${VERCEL_MAX_RESPONSE_BYTES}`);
check('the chunk advertises the full length and its own range',
  first.headers['content-range'] === `bytes 0-${firstBytes.length - 1}/${EXPECTED.length}`,
  String(first.headers['content-range']));
check('the chunk advertises Accept-Ranges so the client can continue',
  first.headers['accept-ranges'] === 'bytes', String(first.headers['accept-ranges']));
check('the chunk carries audio/mp4', first.headers['content-type'] === 'audio/mp4',
  String(first.headers['content-type']));
check('the chunk is CORS-open', first.headers['access-control-allow-origin'] === '*');
check('the first chunk is the head of the stitched fMP4',
  firstBytes.subarray(4, 8).toString() === 'ftyp', firstBytes.subarray(0, 12).toString('latin1'));

// Follow the range the way the client does, and prove the audio reassembles.
const chunks = [firstBytes];
let cursor = firstBytes.length;
while (cursor < EXPECTED.length) {
  const part = await invoke({
    url: proxyPath('https://soundcloud.com/artist/big-track'),
    headers: { range: `bytes=${cursor}-` },
  });
  assert.equal(part.statusCode, 206, `range follow-up returned ${part.statusCode}`);
  check(`range follow-up at ${cursor} stays under the cap`,
    part.body.length <= VERCEL_MAX_RESPONSE_BYTES, `${part.body.length} bytes`);
  chunks.push(part.body);
  cursor += part.body.length;
}

const assembled = Buffer.concat(chunks);
check('following the ranges reproduces the stitched audio byte-for-byte',
  assembled.equals(EXPECTED), `got ${assembled.length}, expected ${EXPECTED.length}`);
check('the reassembled payload starts with an ftyp box',
  assembled.subarray(4, 8).toString() === 'ftyp');

// ── An open-ended range must still be capped to one chunk ────────────────────
// `Range: bytes=0-` asks for everything. Serving it verbatim would exceed the
// 4.5 MB cap the chunking exists to stay under, so the span must be clamped.
const openEnded = await invoke({
  url: proxyPath('https://soundcloud.com/artist/big-track'),
  headers: { range: 'bytes=0-' },
});
check('an open-ended range is clamped to one chunk, not served whole',
  openEnded.statusCode === 206 &&
  openEnded.body.length <= VERCEL_MAX_RESPONSE_BYTES &&
  openEnded.headers['content-range'] === `bytes 0-${openEnded.body.length - 1}/${EXPECTED.length}`,
  `status=${openEnded.statusCode} bytes=${openEnded.body.length} range=${openEnded.headers['content-range']}`);

const wholeRange = await invoke({
  url: proxyPath('https://soundcloud.com/artist/big-track'),
  headers: { range: `bytes=0-${EXPECTED.length - 1}` },
});
check('a range spanning the whole file is clamped to one chunk',
  wholeRange.statusCode === 206 && wholeRange.body.length <= VERCEL_MAX_RESPONSE_BYTES,
  `bytes=${wholeRange.body.length}`);

// ── HEAD reports headers without a body ──────────────────────────────────────
const head = await invoke({ method: 'HEAD', url: proxyPath('https://soundcloud.com/artist/big-track') });
check('HEAD returns headers with no body',
  head.body === null && head.headers['content-type'] === 'audio/mp4',
  `body=${head.body === null ? 'null' : head.body.length} type=${head.headers['content-type']}`);

// ── The plain relay still works ──────────────────────────────────────────────
const relay = await invoke({ url: proxyPath('https://cdn.example.com/song.mp3') });
check('direct audio relay returns 200 with Accept-Ranges',
  relay.statusCode === 200 && relay.headers['accept-ranges'] === 'bytes' &&
  relay.body.equals(AUDIO_BODY), `status=${relay.statusCode}`);

const ranged = await invoke({
  url: proxyPath('https://cdn.example.com/song.mp3'),
  headers: { range: 'bytes=0-9' },
});
check('a Range request to a direct file is forwarded and relayed as 206',
  ranged.statusCode === 206 && ranged.headers['content-range'] === `bytes 0-9/${AUDIO_BODY.length}`,
  `status=${ranged.statusCode} range=${ranged.headers['content-range']}`);

const notFound = await invoke({ url: proxyPath('https://gone.example.com/track.mp3') });
check('an upstream 404 is relayed as 404', notFound.statusCode === 404, `status=${notFound.statusCode}`);

// ── A resolver failure is a friendly JSON error, not a platform crash ────────
globalThis.fetch = async input => {
  const url = typeof input === 'string' ? input : input.url;
  if (new URL(url).hostname === 'soundcloud.com') {
    return new Response('<html><body>no hydration</body></html>', { headers: { 'Content-Type': 'text/html' } });
  }
  throw new Error('unexpected');
};
const failedResolve = await invoke({ url: proxyPath('https://soundcloud.com/a/b') });
const failedBody = JSON.parse(failedResolve.body);
check('a page without hydration yields a friendly JSON error, not a ReferenceError',
  failedResolve.statusCode === 502 &&
  /resolve/i.test(failedBody.error) &&
  !/is not defined/i.test(failedBody.error),
  JSON.stringify(failedBody));

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
