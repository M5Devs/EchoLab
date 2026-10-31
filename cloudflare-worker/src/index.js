/**
 * EchoLab CORS Audio Proxy — Cloudflare Worker.
 *
 * A thin adapter over the shared core in `proxy.js`, which is also used by the
 * Vercel Serverless Function (`api/audio-proxy.ts`) and the Vite dev middleware
 * (`tools/devAudioProxy.ts`).
 *
 * Deploy
 *   cd cloudflare-worker
 *   npx wrangler deploy
 *   # then set VITE_AUDIO_PROXY_URL=https://<worker>.<subdomain>.workers.dev
 *
 * Local development
 *   npx wrangler dev
 */

import { handleAudioProxy } from './proxy.js';

export default {
  fetch(request) {
    // The Worker streams its own response, so there is no response-size cap to
    // work around — the resolved track is served whole.
    return handleAudioProxy(request, { allowList: true });
  },
};
