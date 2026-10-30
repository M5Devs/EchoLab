# EchoLab CORS Audio Proxy (Cloudflare Worker)

Relays remote audio (SoundCloud, external CDNs) to the browser with the CORS
headers and `Range` support that seeking needs.

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

The request `Range` header is forwarded upstream unchanged and the resulting
`206 Partial Content` / `Content-Range` response is passed back verbatim.

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
`/api/audio-proxy` route. Vite dev and preview servers serve it from
`tools/devAudioProxy.ts`, so remote streams work locally with no extra setup;
for production add a rewrite to the worker (Vercel `vercel.json`, nginx
`proxy_pass`, Cloudflare route, …).

## Host allow-list

The worker only relays URLs whose host ends in a known audio CDN suffix
(`soundcloud.com`, `sndcdn.com`, `cloudfront.net`, …) or whose path ends in an
audio extension, so it cannot be used as an open web relay.

## Verify

`tools/verify_echolab.py` exercises the proxy end-to-end (CORS blocking, relay
integrity, `Range`/206 pass-through, 404 handling) alongside the rest of the
studio's browser behaviour:

```bash
npx vite --port 5173 &
python3 tools/verify_echolab.py
```

## Local development

```bash
npx wrangler dev        # http://localhost:8787
VITE_AUDIO_PROXY_URL=http://localhost:8787 npm run dev
```

## Safety

Only hosts on the allow-list, or URLs ending in a known audio extension, are
relayed — the worker is not an open proxy.
