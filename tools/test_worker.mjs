/**
 * Integration test for the Cloudflare Worker audio proxy.
 *
 * Runs the *real* worker handler against a stubbed `fetch` that serves a
 * SoundCloud-shaped tree (track page → transcoding → playlist → fMP4 fragments),
 * so the resolver, the CORS contract and the Range relay are all exercised as
 * deployed code rather than through a re-implementation.
 *
 * Usage:  node tools/test_worker.mjs
 */

import assert from 'node:assert/strict';
import worker from '../cloudflare-worker/src/index.js';

const SC_CLIENT_ID = 'QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k';
const INIT = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypiso5'), Buffer.alloc(16)]);
const SEGMENTS = [
  Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('moof'), Buffer.from('audio-one')]),
  Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('moof'), Buffer.from('audio-two')]),
  Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from('moof'), Buffer.from('audio-three')]),
];
const EXPECTED = Buffer.concat([INIT, ...SEGMENTS]);
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MAP:URI="init.mp4"',
  ...SEGMENTS.flatMap((_, i) => ['#EXTINF:10.0,', `seg${i}.m4s`]),
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const HYDRATION = [
  { hydratable: 'apiClient', data: { id: SC_CLIENT_ID, isExpiring: true } },
  {
    hydratable: 'sound',
    data: {
      id: 123456,
      kind: 'track',
      title: 'Test Track',
      streamable: true,
      duration: 30000,
      track_authorization: 'test-auth-token',
      media: {
        transcodings: [
          {
            format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
            preset: 'aac_160k',
            url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:123456/abc/stream/hls',
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

const AUDIO_BODY = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00' + 'A'.repeat(64));

/** The upstream the worker will see, keyed by hostname. */
function stubFetch(calls) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, headers: new Headers(init?.headers ?? {}) });
    const { hostname, pathname } = new URL(url);

    if (hostname === 'soundcloud.com') {
      return new Response(TRACK_PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (hostname === 'api-v2.soundcloud.com') {
      // The transcoding endpoint must be called with the client_id from the page.
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
      const range = init?.headers?.Range ?? new Headers(init?.headers ?? {}).get('Range');
      if (range) {
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
    if (hostname === 'gone.example.com') {
      return new Response('nope', { status: 404 });
    }
    throw new Error(`unstubbed upstream: ${url}`);
  };
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

function proxyUrl(target) {
  return `https://proxy.example/?url=${encodeURIComponent(target)}`;
}

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = stubFetch(calls);

// ── SoundCloud track page → one progressive stream ────────────────────────────
const scResponse = await worker.fetch(new Request(proxyUrl('https://soundcloud.com/artist/track')));
const scBody = Buffer.from(await scResponse.arrayBuffer());
check('SoundCloud track page resolves to 200', scResponse.status === 200, `status=${scResponse.status}`);
check('resolved payload is the stitched fMP4 (init + every segment)',
  scBody.equals(EXPECTED), `got ${scBody.length} bytes, expected ${EXPECTED.length}`);
check('resolved payload starts with an ftyp box', scBody.subarray(4, 8).toString() === 'ftyp',
  scBody.subarray(0, 12).toString('latin1'));
check('resolved payload carries audio/mp4', scResponse.headers.get('Content-Type') === 'audio/mp4',
  scResponse.headers.get('Content-Type'));
check('resolved payload advertises its exact length',
  scResponse.headers.get('Content-Length') === String(EXPECTED.length));
check('resolved response is CORS-open', scResponse.headers.get('Access-Control-Allow-Origin') === '*');
check('resolved response does NOT advertise Accept-Ranges (no upstream range to forward)',
  scResponse.headers.get('Accept-Ranges') === null, String(scResponse.headers.get('Accept-Ranges')));
check('resolver used the client_id from the page hydration',
  calls.some(c => c.url.includes('client_id=')), 'no client_id call recorded');

// HEAD must not carry a body but must carry the same headers.
const headResponse = await worker.fetch(
  new Request(proxyUrl('https://soundcloud.com/artist/track'), { method: 'HEAD' })
);
check('HEAD resolve returns no body but the right Content-Type',
  headResponse.status === 200 && (await headResponse.text()) === '' &&
  headResponse.headers.get('Content-Type') === 'audio/mp4');

// ── Direct relay still works, with Range pass-through ─────────────────────────
const relay = await worker.fetch(new Request(proxyUrl('https://cdn.example.com/song.mp3')));
check('direct audio relay returns 200', relay.status === 200, `status=${relay.status}`);
check('direct relay is CORS-open with Accept-Ranges',
  relay.headers.get('Access-Control-Allow-Origin') === '*' &&
  relay.headers.get('Accept-Ranges') === 'bytes');

const ranged = await worker.fetch(
  new Request(proxyUrl('https://cdn.example.com/song.mp3'), { headers: { Range: 'bytes=0-9' } })
);
check('Range request is forwarded and returns 206', ranged.status === 206, `status=${ranged.status}`);
check('206 carries Content-Range', ranged.headers.get('Content-Range') === `bytes 0-9/${AUDIO_BODY.length}`,
  String(ranged.headers.get('Content-Range')));

// ── Guard rails ───────────────────────────────────────────────────────────────
const blocked = await worker.fetch(new Request(proxyUrl('https://evil.example.net/steal')));
check('hosts off the allow-list with no audio extension are refused (403)', blocked.status === 403,
  `status=${blocked.status}`);

const missing = await worker.fetch(new Request('https://proxy.example/'));
check('missing ?url= is a 400', missing.status === 400);

const badMethod = await worker.fetch(new Request(proxyUrl('https://cdn.example.com/a.mp3'), { method: 'POST' }));
check('POST is a 405', badMethod.status === 405, `status=${badMethod.status}`);

const preflight = await worker.fetch(new Request('https://proxy.example/', { method: 'OPTIONS' }));
check('OPTIONS preflight is a 204 with the CORS contract',
  preflight.status === 204 &&
  preflight.headers.get('Access-Control-Allow-Methods') === 'GET, HEAD, OPTIONS' &&
  preflight.headers.get('Access-Control-Expose-Headers') ===
    'Content-Length, Content-Range, Accept-Ranges');

const notFound = await worker.fetch(new Request(proxyUrl('https://gone.example.com/track.mp3')));
check('an upstream 404 is relayed as 404, not swallowed', notFound.status === 404, `status=${notFound.status}`);

// A SoundCloud page that yields no hydration is a friendly 502, not a crash.
globalThis.fetch = async input => {
  const url = typeof input === 'string' ? input : input.url;
  if (new URL(url).hostname === 'soundcloud.com') {
    return new Response('<!DOCTYPE html><html><body>no hydration here</body></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  }
  throw new Error('unexpected');
};
const noHydration = await worker.fetch(new Request(proxyUrl('https://soundcloud.com/a/b')));
const noHydrationBody = await noHydration.json();
check('a page without hydration returns a friendly JSON error',
  noHydration.status === 502 && typeof noHydrationBody.error === 'string' &&
  /resolve/i.test(noHydrationBody.error), JSON.stringify(noHydrationBody));

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
