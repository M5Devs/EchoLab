/**
 * Unit test for the client half of the chunked-transfer contract.
 *
 * The Vercel function cannot return a body over 4.5 MB, so it serves a resolved
 * SoundCloud track in ranged 206 responses and `assembleChunkedResponse` stitches
 * them back together. That mirror image of the server logic is the highest-risk
 * part of the feature — a gap or an overlap silently corrupts the audio — so it
 * is tested directly against a stub that behaves like the real endpoint.
 *
 * Usage:  node --experimental-transform-types --import ./tools/register_ts_resolve.mjs \
 *           tools/test_audio_proxy_client.mjs
 */

import assert from 'node:assert/strict';

// The module touches `window.location.origin`, which does not exist in Node.
globalThis.window = { location: { origin: 'http://localhost:5173' } };

const { assembleChunkedResponse, getProxiedAudioUrl } = await import('../src/utils/audioProxy.ts');

const TOTAL = 10 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const ORIGINAL = new Uint8Array(TOTAL);
for (let i = 0; i < TOTAL; i++) ORIGINAL[i] = (i * 7 + 13) & 0xff;

const REMOTE = 'https://soundcloud.com/artist/big-track';

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

/** Serve `ORIGINAL` the way the Vercel function does: ranges of at most CHUNK. */
function chunkedEndpoint(requests) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const range = new Headers(init?.headers ?? {}).get('Range');
    requests.push({ url, range });

    let start = 0;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      assert.ok(match, `unexpected range: ${range}`);
      start = Number(match[1]);
    }
    const end = Math.min(start + CHUNK, TOTAL) - 1;
    const body = ORIGINAL.subarray(start, end + 1);

    if (start === 0 && !range) {
      // A whole-file request: the function still has to cap it.
      return new Response(ORIGINAL.subarray(0, CHUNK), {
        status: 206,
        headers: {
          'Content-Type': 'audio/mp4',
          'Content-Length': String(CHUNK),
          'Content-Range': `bytes 0-${CHUNK - 1}/${TOTAL}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': 'audio/mp4',
        'Content-Length': String(body.length),
        'Content-Range': `bytes ${start}-${end}/${TOTAL}`,
        'Accept-Ranges': 'bytes',
      },
    });
  };
}

// ── A chunked response is reassembled exactly ────────────────────────────────
{
  const requests = [];
  const fetchImpl = chunkedEndpoint(requests);
  const first = await fetchImpl(getProxiedAudioUrl(REMOTE));
  const assembled = await assembleChunkedResponse(first, REMOTE, undefined, fetchImpl);
  const bytes = new Uint8Array(await assembled.arrayBuffer());

  check('a chunked response is reassembled to the full length', bytes.length === TOTAL,
    `got ${bytes.length}, expected ${TOTAL}`);
  check('the reassembled bytes match the original exactly',
    bytes.every((b, i) => b === ORIGINAL[i]), 'byte mismatch');
  check('the reassembled response is a 200 with the full length',
    assembled.status === 200 && assembled.headers.get('Content-Length') === String(TOTAL),
    `status=${assembled.status} len=${assembled.headers.get('Content-Length')}`);
  check('the stale Content-Range header is dropped',
    assembled.headers.get('Content-Range') === null,
    String(assembled.headers.get('Content-Range')));
  check('follow-up requests carry an explicit Range (not relying on Accept-Ranges)',
    requests.length >= 2 && requests.slice(1).every(r => typeof r.range === 'string'),
    JSON.stringify(requests.map(r => r.range)));
}

// ── A plain 200 is passed straight through, un-buffered ──────────────────────
{
  const whole = new Response('whole-body', { status: 200 });
  const result = await assembleChunkedResponse(whole, REMOTE);
  check('a non-partial response is returned untouched', result === whole);
}

// ── A short final chunk must not leave a hole ────────────────────────────────
{
  const shortTotal = 3 * 1024 * 1024;
  const short = new Uint8Array(shortTotal);
  for (let i = 0; i < shortTotal; i++) short[i] = (i * 3) & 0xff;

  const fetchImpl = async (input, init) => {
    const range = new Headers(init?.headers ?? {}).get('Range');
    const start = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    // Deliberately return less than asked for, as a flaky origin would.
    const end = Math.min(start + 1024 * 1024, shortTotal) - 1;
    return new Response(short.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${shortTotal}`, 'Accept-Ranges': 'bytes' },
    });
  };

  const first = await fetchImpl(getProxiedAudioUrl(REMOTE));
  const assembled = await assembleChunkedResponse(first, REMOTE, undefined, fetchImpl);
  const bytes = new Uint8Array(await assembled.arrayBuffer());
  check('a short final chunk still yields the complete payload',
    bytes.length === shortTotal && bytes.every((b, i) => b === short[i]),
    `got ${bytes.length}, expected ${shortTotal}`);
}

// ── A caller-requested range must NOT be reassembled into the whole file ─────
{
  const ranged = new Response('0123456789', {
    status: 206,
    headers: { 'Content-Range': `bytes 0-9/${TOTAL}`, 'Accept-Ranges': 'bytes' },
  });
  const result = await assembleChunkedResponse(ranged, REMOTE, { headers: { Range: 'bytes=0-99' } });
  check('an explicit caller Range is passed through untouched, not reassembled',
    result === ranged);
}

// ── A malformed Content-Range degrades to a pass-through, never a crash ──────
{
  const weird = new Response('abc', {
    status: 206,
    headers: { 'Content-Range': 'bytes */100' },
  });
  const result = await assembleChunkedResponse(weird, REMOTE);
  check('an unparseable Content-Range is passed through rather than thrown on',
    result === weird);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
