# EchoLab CORS Audio Proxy (Cloudflare Worker)

Relays remote audio (SoundCloud, external CDNs) to the browser with the CORS
headers and `Range` support that seeking needs, and resolves SoundCloud track
pages into playable audio.

## Contract

`GET|HEAD|OPTIONS /?url=<encoded-remote-url>`

Response headers:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: *
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges
Accept-Ranges: bytes
```

For a direct audio URL the request `Range` header is forwarded upstream
unchanged and the resulting `206 Partial Content` / `Content-Range` response is
passed back verbatim.

## SoundCloud resolver

A `?url=` pointing at a SoundCloud **track page** (e.g.
`https://soundcloud.com/artist/track-name`) is resolved to audio before it is
returned, so the client can decode it directly. The steps:

1. Fetch the track page and parse `window.__sc_hydration`. That blob carries the
   track object (`media.transcodings`, `track_authorization`) and an `apiClient`
   hydratable whose `id` is the `client_id` — no scraping of the hashed
   `a-v2.sndcdn.com` bundles and no extra `/resolve` call.
2. Pick a transcoding: a `progressive` one when the track still has it (a direct
   MP3), otherwise HLS.
3. Ask the transcoding endpoint (`?client_id=…&track_authorization=…`) for the
   stream URL.
4. For HLS, fetch the media playlist and **stitch the fragmented MP4** — the init
   segment (`ftyp`/`moov`) followed by every media fragment (`moof`/`mdat`) — into
   one progressive file. SoundCloud's HLS is fMP4, not MPEG-TS; concatenating the
   fragments yields a normal `.mp4` that `decodeAudioData` accepts. (Browsers
   cannot decode an `.m3u8`, and MSE does not help a Web Audio pipeline.)

The resolved response is `Content-Type: audio/mp4` (or `audio/mpeg`) with an
exact `Content-Length` and `Cache-Control: no-store`. It deliberately does **not**
advertise `Accept-Ranges`, because the payload is freshly stitched and there is
no upstream byte range to forward — claiming `bytes` would break seeking.

> Note: the whole track is fetched and assembled before the response starts, so
> there is a delay (roughly a second for a few minutes of audio) before playback
> begins. The UI shows a "Resolving SoundCloud track…" toast meanwhile.

## Deploy

```bash
cd cloudflare-worker
npx wrangler login      # one-time
npx wrangler deploy
```

Then point the app at it:

```env
VITE_AUDIO_PROXY_URL=https://echolab-audio-proxy.<subdomain>.workers.dev
```

If `VITE_AUDIO_PROXY_URL` is unset the client falls back to the same-origin
`/api/audio-proxy` route. That route is served in development by
`tools/devAudioProxy.ts` and in production by the Vercel Serverless Function in
`api/audio-proxy.ts`. All three targets — this worker, the Vercel function and
the dev middleware — delegate to the same request handling in
`cloudflare-worker/src/proxy.js`, so they cannot drift.

## Host allow-list

The worker only relays URLs whose host ends in a known audio CDN suffix
(`soundcloud.com`, `sndcdn.com`, `cloudfront.net`, …) or whose path ends in an
audio extension, so it cannot be used as an open web relay.

## Verify

```bash
npm run test:worker               # worker + resolver, no network or browser needed
npm run test:vercel               # Vercel function adapter + chunked transfer
npm run test:client               # client chunk reassembly
python3 tools/verify_echolab.py   # full browser suite (needs the dev server)
```

`tools/test_worker.mjs` drives the real worker handler against a stubbed fetch
serving a SoundCloud-shaped tree (page → transcoding → playlist → fMP4
fragments), asserting the stitched bytes, the CORS contract and the Range relay.
`tools/test_vercel_api.mjs` does the same for the Vercel handler, including the
chunked transfer a track larger than Vercel's 4.5 MB body cap requires.
`tools/verify_echolab.py` additionally resolves the real acceptance-criteria URL
in the browser and decodes it.

## Local development

```bash
npx wrangler dev        # http://localhost:8787
VITE_AUDIO_PROXY_URL=http://localhost:8787 npm run dev
```

## Safety

Only hosts on the allow-list, or URLs ending in a known audio extension, are
relayed — the worker is not an open proxy.
