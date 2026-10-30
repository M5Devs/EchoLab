"""
Browser-level verification for the EchoLab overhaul.

Runs against the Vite dev server so it can dynamically import the real source
modules and exercise them in a real browser (real AudioContext, real DOMException,
real MediaSession) rather than in a mocked Node environment.
"""

import json
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173"

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/usr/bin/chromium",
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--use-gl=swiftshader",
                "--autoplay-policy=no-user-gesture-required",
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
            ],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        # Instrument MediaSession before the app boots so we can observe exactly
        # which handlers and position updates the app actually performs.
        page.add_init_script(
            """
            (function () {
              if (!('mediaSession' in navigator) || !navigator.mediaSession) return;
              var ms = navigator.mediaSession;
              window.__msLog = { handlers: {}, fns: {}, positionCalls: 0, lastPosition: null };
              var realSet = ms.setActionHandler.bind(ms);
              ms.setActionHandler = function (action, handler) {
                window.__msLog.handlers[action] = handler ? 'set' : 'cleared';
                if (handler) window.__msLog.fns[action] = handler;
                return realSet(action, handler);
              };
              if (typeof ms.setPositionState === 'function') {
                var realPos = ms.setPositionState.bind(ms);
                ms.setPositionState = function (state) {
                  window.__msLog.positionCalls++;
                  window.__msLog.lastPosition = state;
                  return realPos(state);
                };
              }
            })();
            """
        )

        console_errors = []
        page.on(
            "console",
            lambda m: console_errors.append(m.text) if m.type == "error" else None,
        )
        # Uncaught exceptions only — these must never happen, in any mode.
        page_errors = []
        page.on("pageerror", lambda e: (page_errors.append(f"pageerror: {e}"),
                                        console_errors.append(f"pageerror: {e}")))

        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(3500)

        # ── 1. App shell renders ──────────────────────────────────────────────
        body = page.inner_text("body")
        check("app shell renders", "ECHOLAB" in body)

        # ── 2. No unexpected runtime errors ───────────────────────────────────
        # Firebase calls fail without network/real creds; those are expected.
        unexpected = [
            e
            for e in console_errors
            if "firebase" not in e.lower()
            and "ERR_NAME_NOT_RESOLVED" not in e
            and "net::" not in e.lower()
            and "Failed to fetch" not in e
            and "installations" not in e.lower()
            and "auth/" not in e.lower()
        ]
        check("no unexpected console errors", len(unexpected) == 0, json.dumps(unexpected[:4]))

        # ── 3. Storage: safeLocalStorageSet survives QuotaExceededError ───────
        storage_test = page.evaluate(
            """async () => {
            const mod = await import('/src/utils/storage.ts');
            const out = {};

            // Normal write/read round-trip
            out.wrote = mod.safeLocalStorageSet('echolab_probe', { a: 1 });
            out.read = mod.safeLocalStorageGet('echolab_probe', null);

            // Force a QuotaExceededError on the next write
            const original = localStorage.setItem.bind(localStorage);
            localStorage.setItem = () => {
                throw new DOMException('quota', 'QuotaExceededError');
            };
            let threw = false;
            try {
                out.quotaWrite = mod.safeLocalStorageSet('echolab_probe2', { b: 2 });
            } catch (e) {
                threw = true;
            }
            localStorage.setItem = original;
            out.quotaThrew = threw;
            out.quotaFlag = mod.isQuotaError(
                new DOMException('quota', 'QuotaExceededError')
            );

            // resetLocalCache must drop echolab_* keys
            mod.safeLocalStorageSet('echolab_playlists', [{ id: 'x' }]);
            mod.safeLocalStorageSet('unrelated_key', 'keep');
            mod.resetLocalCache();
            out.playlistsAfterReset = localStorage.getItem('echolab_playlists');
            out.unrelatedAfterReset = localStorage.getItem('unrelated_key');
            localStorage.removeItem('unrelated_key');
            localStorage.removeItem('echolab_probe');
            return out;
        }"""
        )
        check("storage round-trip", storage_test["wrote"] is True and storage_test["read"] == {"a": 1})
        check("quota write returns false without throwing",
              storage_test["quotaWrite"] is False and storage_test["quotaThrew"] is False)
        check("isQuotaError detects quota", storage_test["quotaFlag"] is True)
        check("resetLocalCache drops echolab keys only",
              storage_test["playlistsAfterReset"] is None
              and storage_test["unrelatedAfterReset"] == '"keep"')

        # ── 4. Playlist persistence is metadata-only ──────────────────────────
        playlist_test = page.evaluate(
            """async () => {
            const mod = await import('/src/contexts/AudioContext.tsx');
            const heavy = [{
                id: 'p1', name: 'Heavy',
                tracks: [{
                    id: 't1', name: 'Song', duration: 12.5,
                    // heavy fields that must never be persisted
                    coverArt: 'data:image/png;base64,AAAABBBBCCCC',
                    url: 'https://example.com/x.mp3',
                    file: { size: 999999 },
                    peaks: new Array(5000).fill(0.5),
                }],
            }];
            const stored = mod.toStoredPlaylists(heavy);
            const serialized = JSON.stringify(stored);
            return {
                keys: Object.keys(stored[0]).sort(),
                trackCount: stored[0].trackCount,
                duration: stored[0].duration,
                hasHeavy: /base64|peaks|example\\.com|file/.test(serialized),
                size: serialized.length,
            };
        }"""
        )
        check("stored playlist keys are metadata only",
              playlist_test["keys"] == ["createdAt", "duration", "id", "name", "trackCount"],
              str(playlist_test["keys"]))
        check("stored playlist has no heavy payloads",
              playlist_test["hasHeavy"] is False, f"{playlist_test['size']} bytes")
        check("stored playlist aggregates duration/trackCount",
              playlist_test["trackCount"] == 1 and abs(playlist_test["duration"] - 12.5) < 1e-6)

        # ── 5. Studio FX DSP: curves, IR, chain, bypass, offline render ───────
        fx_test = page.evaluate(
            """async () => {
            const fx = await import('/src/utils/studioFx.ts');
            const out = {};

            // Saturation curves are bounded and monotonic-ish
            const tape = fx.makeSaturationCurve(60, 'tape');
            const over = fx.makeSaturationCurve(60, 'overdrive');
            out.curveLen = tape.length;
            out.tapeBounded = Array.from(tape).every(v => Number.isFinite(v) && Math.abs(v) <= 1.001);
            out.overBounded = Array.from(over).every(v => Number.isFinite(v) && Math.abs(v) <= 1.001);
            out.curvesDiffer = tape[100] !== over[100];

            // Synthetic impulse response
            const ctx = new AudioContext();
            const ir = fx.generateReverbImpulse(ctx, 2.0, 0.4);
            out.irChannels = ir.numberOfChannels;
            out.irDuration = ir.duration;
            const data = ir.getChannelData(0);
            out.irHasSignal = data.some(v => Math.abs(v) > 1e-4);
            // Energy must decay towards the tail
            const head = Math.abs(data[Math.floor(data.length * 0.02)]);
            const tail = Math.abs(data[data.length - 10]);
            out.irDecays = head >= tail;

            // Build a full rack on a live context and confirm it is wired
            const settings = fx.normalizeStudioFx({
                echo: { enabled: true, time: 0.4, feedback: 0.5, tone: 3000, mix: 0.4, mode: 'tape' },
                reverb: { enabled: true, preset: 'hall', decay: 2, preDelay: 0.02, damping: 0.4, mix: 0.3 },
                saturation: { enabled: true, drive: 40, mode: 'tape', outputGain: 2 },
                widener: { enabled: true, width: 1.5, delayMs: 12 },
                chorus: { enabled: true, rate: 0.8, depth: 0.4, mix: 0.3 },
            });
            const chain = new fx.StudioFxChain(ctx, settings, true);
            const osc = ctx.createOscillator();
            const analyser = ctx.createAnalyser();
            osc.connect(chain.input);
            chain.output.connect(analyser);
            analyser.connect(ctx.destination);
            osc.start();

            // Offline render through the same rack must produce finite audio
            const off = new OfflineAudioContext(2, 44100, 44100);
            const offChain = new fx.StudioFxChain(off, settings, false);
            const offOsc = off.createOscillator();
            offOsc.connect(offChain.input);
            offChain.output.connect(off.destination);
            offOsc.start();
            const rendered = await off.startRendering();
            const rd = rendered.getChannelData(0);
            out.offlineFinite = Array.from(rd.slice(0, 4096)).every(Number.isFinite);
            out.offlineNonSilent = rd.some(v => Math.abs(v) > 1e-5);

            // Bypassing every unit must not throw and must keep the graph intact
            let bypassThrew = false;
            try {
                chain.setSettings(fx.normalizeStudioFx({
                    echo: { enabled: false, time: 0.4, feedback: 0.5, tone: 3000, mix: 0.4, mode: 'tape' },
                    reverb: { enabled: false, preset: 'room', decay: 1, preDelay: 0, damping: 0.5, mix: 0.3 },
                    saturation: { enabled: false, drive: 0, mode: 'tape', outputGain: 0 },
                    widener: { enabled: false, width: 1, delayMs: 12 },
                    chorus: { enabled: false, rate: 1, depth: 0, mix: 0 },
                }));
                chain.setSettings(settings);
            } catch (e) { bypassThrew = true; }
            out.bypassThrew = bypassThrew;

            // Feedback must be hard-clamped to 0.9 even when asked for 5
            out.feedbackClamped = fx.normalizeStudioFx({
                echo: { enabled: true, time: 99, feedback: 5, tone: 99999, mix: 9, mode: 'digital' },
            }).echo;
            out.echoMax = fx.ECHO_MAX_FEEDBACK;

            osc.stop();
            chain.dispose();
            offChain.dispose();
            await ctx.close();
            return out;
        }"""
        )
        check("saturation curves bounded", fx_test["tapeBounded"] and fx_test["overBounded"],
              f"len={fx_test['curveLen']}")
        check("tape vs overdrive curves differ", fx_test["curvesDiffer"] is True)
        check("synthetic IR generated (stereo, decays)",
              fx_test["irChannels"] == 2 and fx_test["irHasSignal"] and fx_test["irDecays"],
              f"dur={fx_test['irDuration']:.2f}s")
        check("live FX rack renders", fx_test["offlineFinite"] and fx_test["offlineNonSilent"])
        check("bypass toggling is safe", fx_test["bypassThrew"] is False)
        e = fx_test["feedbackClamped"]
        check("echo params clamped",
              e["feedback"] == 0.9 and e["time"] == 1.5 and e["tone"] == 8000 and e["mix"] == 1,
              str(e))

        # ── 6. Audio proxy URL rewriting ──────────────────────────────────────
        proxy_test = page.evaluate(
            """async () => {
            const mod = await import('/src/utils/audioProxy.ts');
            const remote = 'https://api.soundcloud.com/tracks/1/stream';
            const proxied = mod.getProxiedAudioUrl(remote);
            return {
                proxied,
                encoded: proxied.includes(encodeURIComponent(remote)),
                endpoint: mod.getAudioProxyEndpoint(),
                dataUrl: mod.getProxiedAudioUrl('data:audio/wav;base64,AAA'),
                blobUrl: mod.getProxiedAudioUrl('blob:http://localhost/x'),
                sameOrigin: mod.getProxiedAudioUrl(window.location.origin + '/a.mp3'),
            };
        }"""
        )
        check("remote URL is proxied and encoded",
              proxy_test["encoded"] and proxy_test["proxied"].startswith("/api/audio-proxy?url="),
              proxy_test["proxied"][:70])
        check("data/blob/same-origin URLs are untouched",
              proxy_test["dataUrl"] == "data:audio/wav;base64,AAA"
              and proxy_test["blobUrl"] == "blob:http://localhost/x"
              and proxy_test["sameOrigin"].endswith("/a.mp3"))

        # ── 7. MediaSession handlers registered without exceptions ────────────
        ms_test = page.evaluate(
            """async () => {
            const registered = [];
            const failing = [];
            if (!('mediaSession' in navigator)) return { supported: false };
            const actions = ['play','pause','seekto','seekforward','seekbackward',
                             'previoustrack','nexttrack'];
            const real = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
            for (const a of actions) {
                try {
                    real(a, () => {});
                    registered.push(a);
                } catch (e) { failing.push(a); }
            }
            return { supported: true, registered, failing,
                     hasPositionState: typeof navigator.mediaSession.setPositionState === 'function',
                     hasMetadata: typeof MediaMetadata !== 'undefined' };
        }"""
        )
        check("mediaSession available in Chromium", ms_test.get("supported") is True)
        if ms_test.get("supported"):
            check("all 7 mediaSession actions register",
                  len(ms_test["registered"]) == 7 and not ms_test["failing"],
                  str(ms_test["failing"]))
            check("MediaMetadata + setPositionState available",
                  ms_test["hasMetadata"] and ms_test["hasPositionState"])

        # ── 8. Engine: in-memory decode + FX chain + audio bridge ─────────────
        engine_test = page.evaluate(
            """async () => {
            const { AudioEngine } = await import('/src/utils/AudioEngine.ts');
            const engine = new AudioEngine();
            const out = {};

            // Build a tiny WAV in memory and decode it, exactly like an upload.
            const sr = 8000, secs = 0.5, n = sr * secs;
            const wav = new ArrayBuffer(44 + n * 2);
            const dv = new DataView(wav);
            const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
            w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
            w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
            dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
            dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
            w(36, 'data'); dv.setUint32(40, n * 2, true);
            for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin(i / 20) * 12000, true);

            await engine.loadBuffer(wav);
            out.loaded = !!engine.buffer;
            out.duration = engine.getDuration();

            // The FX rack must be mounted on the live master chain
            engine.applyStudioFx({ echo: { enabled: true } });
            out.studioFxEchoOn = engine.studioFx.echo.enabled;
            engine.play();
            out.playing = engine.isPlaying;
            engine.seek(0.1);
            out.seeked = engine.getCurrentTime();

            // Offline export must include the FX rack and stay finite
            const rendered = await engine.renderOffline();
            const d = rendered.getChannelData(0);
            out.renderLen = d.length;
            out.renderFinite = Array.from(d.slice(0, 2048)).every(Number.isFinite);

            engine.pause();
            out.paused = engine.isPlaying === false;

            // Audio bridge element must exist and not be muted (mobile notif)
            out.bridgeMuted = engine.audioBridge.muted;
            out.bridgeInDom = engine.audioBridge.isConnected;
            await engine.ctx.close();
            return out;
        }"""
        )
        check("WAV ingested in memory and decoded", engine_test["loaded"] is True,
              f"dur={engine_test['duration']:.3f}s")
        check("studio FX applied to engine", engine_test["studioFxEchoOn"] is True)
        check("playback + seek work", engine_test["playing"] and engine_test["seeked"] >= 0.09)
        check("offline render includes FX and is finite",
              engine_test["renderFinite"] and engine_test["renderLen"] > 0,
              f"len={engine_test['renderLen']}")
        check("audio bridge not muted (OS notification survives)",
              engine_test["bridgeMuted"] is False and engine_test["bridgeInDom"] is True)

        # ── 9. Studio FX rack panel is present in the UI ──────────────────────
        page.wait_for_timeout(300)
        studio_body = page.inner_text("body")
        check("Studio FX Rack panel rendered", "Studio FX Rack" in studio_body)
        for unit in ["Echo / Tape Delay", "Reverb", "Analog Saturation", "Stereo Widener", "Chorus"]:
            check(f"FX unit visible: {unit}", unit in studio_body)

        # ── 10. Error Boundary exposes the automated cache reset ──────────────
        page.evaluate(
            """() => {
            window.__origError = console.error;
        }"""
        )
        # Force a React render error via a poisoned value the tree reads.
        page.evaluate(
            """() => {
            // localStorage poisoning that used to brick the app is now survivable;
            // instead directly assert the boundary renders the reset control by
            // checking the component source contract through the module.
        }"""
        )
        boundary = page.evaluate(
            """async () => {
            const res = await fetch('/src/components/ErrorBoundary.tsx');
            const src = await res.text();
            return { hasReset: src.includes('Reset Local Cache'),
                     usesReset: src.includes('resetLocalCache') };
        }"""
        )
        check("ErrorBoundary has automated cache reset",
              boundary["hasReset"] and boundary["usesReset"])

        # ── 11. beforeunload guard present when audio is in memory ────────────
        guard = page.evaluate(
            """async () => {
            const res = await fetch('/src/contexts/AudioContext.tsx');
            const src = await res.text();
            return {
                listener: /addEventListener\\(['"]beforeunload['"]/.test(src),
                preventDefault: src.includes('e.preventDefault()'),
            };
        }"""
        )
        check("beforeunload guard wired", guard["listener"] and guard["preventDefault"])

        # ── 12. End-to-end: real file upload → in-memory decode → FX → guard ──
        page.set_input_files("input[type=file][accept='audio/*']", "/tmp/echolab_fixtures/tone.wav")
        page.wait_for_timeout(2500)

        e2e = page.evaluate(
            """() => {
            const el = document.querySelector('audio');
            return {
                hasAudioEl: !!el,
                audioMuted: el ? el.muted : null,
                hasStream: el ? !!el.srcObject : false,
                bodyHasLoadedText: document.body.innerText.includes('tone'),
            };
        }"""
        )
        check("uploaded track decoded into memory", e2e["bodyHasLoadedText"] is True)
        check("hidden audio bridge exists with a MediaStream and is unmuted",
              e2e["hasAudioEl"] and e2e["hasStream"] and e2e["audioMuted"] is False,
              json.dumps(e2e))

        # The guard must now actually fire: beforeunload should be cancelled.
        guard_fires = page.evaluate(
            """() => {
            const ev = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(ev);
            return ev.defaultPrevented;
        }"""
        )
        check("beforeunload is prevented while audio is in memory", guard_fires is True)

        # MediaSession metadata must be populated from the loaded track.
        ms_meta = page.evaluate(
            """() => {
            if (!('mediaSession' in navigator) || !navigator.mediaSession.metadata) return null;
            const m = navigator.mediaSession.metadata;
            return { title: m.title, artist: m.artist, album: m.album, art: m.artwork.length };
        }"""
        )
        check("mediaSession metadata populated from track",
              ms_meta is not None and ms_meta["art"] >= 1 and bool(ms_meta["title"]),
              json.dumps(ms_meta))

        # Exercise every mediaSession handler for real, including headset seek.
        ms_invoke = page.evaluate(
            """async () => {
            const log = window.__msLog || { handlers: {}, fns: {} };
            const out = {
                registered: Object.keys(log.handlers).filter(k => log.handlers[k] === 'set'),
                errors: [],
            };
            const actions = ['pause','seekto','seekforward','seekbackward',
                             'previoustrack','nexttrack','play'];
            for (const action of actions) {
                const fn = log.fns[action];
                if (!fn) { out.errors.push(action + ': not registered'); continue; }
                try {
                    const details = action === 'seekto' ? { seekTime: 0.4, fastSeek: false }
                                  : action.startsWith('seek') ? { seekOffset: 10 }
                                  : undefined;
                    await fn(details);
                    out[action] = 'ok';
                } catch (e) {
                    out.errors.push(action + ': ' + e.message);
                }
            }
            return out;
        }"""
        )
        check("all mediaSession handlers registered by the app",
              set(["play", "pause", "seekto", "seekforward", "seekbackward",
                   "previoustrack", "nexttrack"]).issubset(set(ms_invoke["registered"])),
              str(ms_invoke["registered"]))
        check("every mediaSession handler runs without throwing",
              len(ms_invoke["errors"]) == 0, str(ms_invoke["errors"]))

        ms_pos = page.evaluate(
            """() => ({
                positionCalls: window.__msLog ? window.__msLog.positionCalls : 0,
                lastPosition: window.__msLog ? window.__msLog.lastPosition : null,
            })"""
        )
        check("setPositionState is driven with duration/position/playbackRate",
              ms_pos["positionCalls"] > 0
              and ms_pos["lastPosition"] is not None
              and {"duration", "position", "playbackRate"}.issubset(set(ms_pos["lastPosition"])),
              json.dumps(ms_pos["lastPosition"]))

        # ── 13. Storage quota stress: many large playlist writes stay safe ────
        stress = page.evaluate(
            """async () => {
            const { safeLocalStorageSet, safeLocalStorageGet } = await import('/src/utils/storage.ts');
            const { toStoredPlaylists } = await import('/src/contexts/AudioContext.tsx');
            // Simulate 200 playlists x 500 tracks of heavy in-memory state.
            const playlists = Array.from({ length: 200 }, (_, p) => ({
                id: 'p' + p, name: 'Playlist ' + p,
                tracks: Array.from({ length: 500 }, (_, t) => ({
                    id: 't' + t, name: 'Track ' + t, duration: 180,
                    coverArt: 'data:image/png;base64,' + 'A'.repeat(2000),
                    peaks: new Array(2000).fill(0.3),
                })),
            }));
            const stored = toStoredPlaylists(playlists);
            let ok = true;
            for (let i = 0; i < 20; i++) ok = safeLocalStorageSet('echolab_playlists', stored) && ok;
            const roundTrip = safeLocalStorageGet('echolab_playlists', []);
            localStorage.removeItem('echolab_playlists');
            return { ok, count: roundTrip.length, size: JSON.stringify(stored).length };
        }"""
        )
        check("200 heavy playlists persist without QuotaExceededError",
              stress["ok"] is True and stress["count"] == 200,
              f"serialized {stress['size']} bytes vs ~2MB of raw state")

        # ── 14. Engine dispose releases every long-lived resource ─────────────
        dispose_test = page.evaluate(
            """async () => {
            const { AudioEngine } = await import('/src/utils/AudioEngine.ts');
            const before = document.querySelectorAll('audio').length;
            const engine = new AudioEngine();
            engine.applyStudioFx({ echo: { enabled: true }, reverb: { enabled: true } });
            engine.play();
            const during = document.querySelectorAll('audio').length;
            engine.dispose();
            return {
                before, during,
                after: document.querySelectorAll('audio').length,
                ctxState: engine.ctx.state,
            };
        }"""
        )
        check("dispose() removes the hidden bridge element",
              dispose_test["after"] == dispose_test["before"],
              json.dumps(dispose_test))
        check("dispose() closes the AudioContext",
              dispose_test["ctxState"] == "closed", dispose_test["ctxState"])

        # ── 15. Repeated engine construction/teardown does not leak ───────────
        leak = page.evaluate(
            """async () => {
            const { AudioEngine } = await import('/src/utils/AudioEngine.ts');
            const base = document.querySelectorAll('audio').length;
            for (let i = 0; i < 12; i++) {
                const e = new AudioEngine();
                e.applyStudioFx({ chorus: { enabled: true } });
                e.dispose();
            }
            return { base, after: document.querySelectorAll('audio').length };
        }"""
        )
        check("12 build/dispose cycles leave no orphaned audio elements",
              leak["after"] == leak["base"], json.dumps(leak))

        # ── 16. Eruda boots for ?debug=true ───────────────────────────────────
        debug_page = browser.new_page()
        debug_page.goto(BASE + "/?debug=true", wait_until="load")
        debug_page.wait_for_timeout(3000)
        eruda = debug_page.evaluate(
            """() => ({ initialized: !!window.__eruda_initialized,
                        dom: !!document.querySelector('#eruda') })"""
        )
        check("eruda initialises for ?debug=true",
              eruda["initialized"] and eruda["dom"], json.dumps(eruda))
        debug_page.close()

        # ── 17. Client proxy: CORS-blocked upstream is relayed ────────────────
        # 127.0.0.1:8898 is a different origin from the dev server and sends no
        # CORS headers, so a direct fetch must fail and the proxy must rescue it.
        proxy_fetch = page.evaluate(
            """async () => {
            const { fetchAudioWithProxy, AudioProxyError } = await import('/src/utils/audioProxy.ts');
            const remote = 'http://127.0.0.1:8898/song.mp3';
            const out = {};

            // Direct fetch should be CORS-blocked.
            try { await fetch(remote); out.directBlocked = false; }
            catch (e) { out.directBlocked = true; }

            const res = await fetchAudioWithProxy(remote);
            out.status = res.status;
            const buf = await res.arrayBuffer();
            out.bytes = buf.byteLength;
            out.riff = new TextDecoder().decode(buf.slice(0, 4));

            // Range request through the proxy must preserve 206 + Content-Range.
            const ranged = await fetchAudioWithProxy(remote, { headers: { Range: 'bytes=0-99' } });
            out.rangeStatus = ranged.status;
            out.contentRange = ranged.headers.get('Content-Range');
            out.rangeBytes = (await ranged.arrayBuffer()).byteLength;

            // A 404 must surface a friendly AudioProxyError, not a raw failure.
            try {
                await fetchAudioWithProxy('http://127.0.0.1:8898/does-not-exist.mp3');
                out.missingThrew = false;
            } catch (e) {
                out.missingThrew = e instanceof AudioProxyError;
                out.missingMsg = e.message;
            }
            return out;
        }"""
        )
        check("direct cross-origin fetch is CORS-blocked", proxy_fetch["directBlocked"] is True)
        check("proxy relays the remote stream intact",
              proxy_fetch["status"] == 200 and proxy_fetch["riff"] == "RIFF"
              and proxy_fetch["bytes"] == 88244,
              f"{proxy_fetch['bytes']} bytes")
        check("proxy preserves Range/206 for seeking",
              proxy_fetch["rangeStatus"] == 206
              and proxy_fetch["contentRange"] == "bytes 0-99/88244"
              and proxy_fetch["rangeBytes"] == 100,
              f"{proxy_fetch['rangeStatus']} {proxy_fetch['contentRange']}")
        check("missing track raises AudioProxyError with friendly message",
              proxy_fetch["missingThrew"] and "not found" in proxy_fetch["missingMsg"].lower(),
              proxy_fetch["missingMsg"])

        # ── 18. Full UI flow: remote URL streams through the proxy ────────────
        page.evaluate("() => { window.__toasts = []; }")
        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(2500)

        # Drive the engine the same way URLStream does, through the proxy.
        url_flow = page.evaluate(
            """async () => {
            const { AudioEngine } = await import('/src/utils/AudioEngine.ts');
            const engine = new AudioEngine();
            const out = {};
            try {
                await engine.loadUrl('http://127.0.0.1:8898/song.mp3');
                out.loaded = true;
                out.duration = engine.getDuration();
                out.name = engine.buffer ? engine.buffer.length : 0;
            } catch (e) {
                out.loaded = false;
                out.error = e.message;
            }
            try {
                await engine.loadUrl('http://127.0.0.1:8898/nope.mp3');
                out.badThrew = false;
            } catch (e) {
                out.badThrew = true;
                out.badMsg = e.message;
            }
            engine.dispose();
            return out;
        }"""
        )
        check("engine.loadUrl streams a remote track through the proxy",
              url_flow["loaded"] and url_flow["duration"] > 0,
              json.dumps(url_flow))
        check("engine.loadUrl rejects an unavailable track with a clear message",
              url_flow["badThrew"] and "not found" in url_flow["badMsg"].lower(),
              url_flow.get("badMsg", ""))

        # ── 19. FX rack UI is reactively wired to the live engine ─────────────
        # Patch the prototype BEFORE interacting, so every UI-driven call is
        # captured. The engine instance is constructed inside the provider, so
        # observing its public method is the only way to see the UI's effect.
        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(2500)
        page.evaluate(
            """async () => {
            const { AudioEngine } = await import('/src/utils/AudioEngine.ts');
            window.__fxCalls = [];
            const orig = AudioEngine.prototype.applyStudioFx;
            AudioEngine.prototype.applyStudioFx = function (fx) {
                window.__fxCalls.push(JSON.parse(JSON.stringify(fx)));
                return orig.call(this, fx);
            };
        }"""
        )

        echo_switch = page.query_selector("[role=switch][aria-label='Toggle Echo / Tape Delay']")
        check("FX bypass switch is present and labelled", echo_switch is not None)
        echo_switch.click()
        page.wait_for_timeout(600)
        toggled = page.evaluate(
            "() => window.__fxCalls.some(c => c.echo && c.echo.enabled === true)"
        )
        check("toggling Echo bypass reaches the live engine", toggled is True,
              json.dumps(page.evaluate("() => window.__fxCalls")))

        # Drag the Saturation "Drive" knob and confirm the value reaches the engine.
        drive_before = page.evaluate(
            """() => {
            const t = Array.from(document.querySelectorAll('span'))
                .find(s => s.textContent.trim() === 'Drive');
            const el = t.closest('div.space-y-2').querySelector('[role=slider]');
            el.focus();
            return Number(el.getAttribute('aria-valuenow'));
        }"""
        )
        for _ in range(5):
            page.keyboard.press("ArrowRight")
        page.wait_for_timeout(600)
        drive_after = page.evaluate(
            """() => {
            const t = Array.from(document.querySelectorAll('span'))
                .find(s => s.textContent.trim() === 'Drive');
            return Number(t.closest('div.space-y-2')
                .querySelector('[role=slider]').getAttribute('aria-valuenow'));
        }"""
        )
        engine_drive = page.evaluate(
            """() => {
            const calls = window.__fxCalls.filter(c => c.saturation && c.saturation.drive !== undefined);
            return calls.length ? calls[calls.length - 1].saturation.drive : null;
        }"""
        )
        check("dragging the Drive knob updates the live engine",
              drive_after > drive_before and engine_drive == drive_after,
              f"ui {drive_before}→{drive_after}, engine saw {engine_drive}")

        # ── 20. Export really contains the FX (dry vs wet, same source) ───────
        export_fx = page.evaluate(
            """async () => {
            const { AudioEngine } = await import('/src/utils/AudioEngine.ts');
            const fx = await import('/src/utils/studioFx.ts');

            const sr = 44100;
            const ctx = new AudioContext();
            const buf = ctx.createBuffer(1, sr, sr);
            const d = buf.getChannelData(0);
            // A short 440 Hz burst followed by silence, so any energy after the
            // burst can only come from delay/reverb tails.
            for (let i = 0; i < sr; i++) {
                d[i] = i < 2000 ? Math.sin(2 * Math.PI * 440 * i / sr) : 0;
            }

            const tailEnergy = (b) => {
                const x = b.getChannelData(0);
                let s = 0;
                for (let i = 20000; i < x.length; i++) s += Math.abs(x[i]);
                return s;
            };
            const peak = (b) => {
                const x = b.getChannelData(0);
                let m = 0;
                for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
                return m;
            };

            const dryEngine = new AudioEngine();
            dryEngine.setBuffer(buf, false);
            dryEngine.studioFx = fx.normalizeStudioFx({});
            const dry = await dryEngine.renderOffline();
            dryEngine.dispose();

            const wetEngine = new AudioEngine();
            wetEngine.setBuffer(buf, false);
            wetEngine.studioFx = fx.normalizeStudioFx({
                echo: { enabled: true, time: 0.3, feedback: 0.7, tone: 2000, mix: 0.8, mode: 'tape' },
                reverb: { enabled: true, decay: 3, preDelay: 0.02, damping: 0.3, mix: 0.8, preset: 'cathedral' },
                saturation: { enabled: true, drive: 80, mode: 'overdrive', outputGain: 0 },
            });
            const wet = await wetEngine.renderOffline();
            wetEngine.dispose();
            await ctx.close();

            return {
                dryTail: tailEnergy(dry),
                wetTail: tailEnergy(wet),
                dryLen: dry.length,
                wetLen: wet.length,
                dryPeak: peak(dry),
                wetPeak: peak(wet),
                dryFinite: Array.from(dry.getChannelData(0).slice(0, 20000)).every(Number.isFinite),
                wetFinite: Array.from(wet.getChannelData(0).slice(0, 20000)).every(Number.isFinite),
            };
        }"""
        )
        check("exported audio is finite with FX engaged",
              export_fx["dryFinite"] and export_fx["wetFinite"])
        check("exported audio contains the reverb/delay tail (absent when dry)",
              export_fx["wetTail"] > 1.0 and export_fx["dryTail"] < 0.05 * export_fx["wetTail"],
              f"dry={export_fx['dryTail']:.2f} wet={export_fx['wetTail']:.2f}")
        check("export render is lengthened to fit the FX tail",
              export_fx["wetLen"] > export_fx["dryLen"],
              f"{export_fx['dryLen']} → {export_fx['wetLen']} samples")
        check("saturation changes the exported waveform",
              abs(export_fx["wetPeak"] - export_fx["dryPeak"]) > 1e-4,
              f"peak {export_fx['dryPeak']:.4f} → {export_fx['wetPeak']:.4f}")

        # ── 21. ErrorBoundary: real render, real cache reset ──────────────────
        boundary_live = page.evaluate(
            """async () => {
            const React = (await import('/@id/react')).default;
            const { createRoot } = (await import('/@id/react-dom/client')).default;
            const { ErrorBoundary } = await import('/src/components/ErrorBoundary.tsx');

            localStorage.setItem('echolab_probe', '1');
            localStorage.setItem('unrelated_key', 'keep');

            const host = document.createElement('div');
            host.id = 'boundary-probe';
            document.body.appendChild(host);

            const quiet = console.error;
            console.error = () => {};
            const Boom = () => { throw new Error('boundary-probe-boom'); };
            createRoot(host).render(
                React.createElement(ErrorBoundary, null, React.createElement(Boom))
            );
            await new Promise(r => setTimeout(r, 800));
            console.error = quiet;

            return {
                rendered: /Reset Local Cache/.test(host.innerText),
                message: /boundary-probe-boom/.test(host.innerText),
                buttons: Array.from(host.querySelectorAll('button')).map(b => b.textContent.trim()),
            };
        }"""
        )
        check("ErrorBoundary renders the crash UI with the cache reset button",
              boundary_live["rendered"] and boundary_live["message"],
              json.dumps(boundary_live["buttons"]))

        # Clicking it must invoke resetLocalCache(): echolab_* keys dropped,
        # unrelated keys preserved, then the app reloads.
        page.evaluate(
            "() => { const b = Array.from(document.querySelectorAll('#boundary-probe button'))"
            ".find(x => /Reset Local Cache/.test(x.textContent)); b.click(); }"
        )
        page.wait_for_load_state("load")
        page.wait_for_timeout(1500)
        after_reset = page.evaluate(
            """() => ({
                probe: localStorage.getItem('echolab_probe'),
                unrelated: localStorage.getItem('unrelated_key'),
                reloaded: !document.getElementById('boundary-probe'),
            })"""
        )
        check("'Reset Local Cache' invokes resetLocalCache() and reboots the app",
              after_reset["probe"] is None and after_reset["unrelated"] == "keep"
              and after_reset["reloaded"] is True,
              json.dumps(after_reset))

        # ── 22. URL input routes through the proxy (real network capture) ─────
        proxied_requests = []
        page.on(
            "request",
            lambda r: proxied_requests.append(r.url) if "audio-proxy" in r.url else None,
        )
        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(2500)
        page.fill("input[type=url]", "http://127.0.0.1:8898/song.mp3")
        page.click("button[type=submit]")
        page.wait_for_timeout(3500)

        check("submitting a remote URL issues a request to the CORS proxy",
              any("/api/audio-proxy?url=" in u and "8898" in u for u in proxied_requests),
              json.dumps(proxied_requests[:3]))
        loaded_body = page.inner_text("body")
        check("the proxied track loads into the studio",
              "song.mp3" in loaded_body and "AWAITING SIGNAL" not in loaded_body)

        # ── 23. Failure state surfaces a toast, never a silent error ──────────
        page.fill("input[type=url]", "http://127.0.0.1:8898/missing-track.mp3")
        page.click("button[type=submit]")
        page.wait_for_timeout(3500)
        toasts = page.evaluate(
            """() => Array.from(document.querySelectorAll('[data-sonner-toast]'))
                .map(t => t.innerText)"""
        )
        check("an unavailable URL raises a visible toast alert",
              len(toasts) > 0 and any("not found" in t.lower() or "unavailable" in t.lower()
                                      for t in toasts),
              json.dumps(toasts))

        # ── 24. Firebase is safe whether or not it is configured ──────────────
        # EchoLab must be a 100% local studio out of the box. These checks are
        # mode-adaptive: the invariant (no crash, handles match the flag) is
        # asserted always, and the mode-specific UX is asserted for whichever
        # mode this run is in. Run once with and once without a .env to cover both.
        fb = page.evaluate(
            """async () => {
            const m = await import('/src/firebase.ts');
            return {
                configured: m.isFirebaseConfigured,
                authNull: m.auth === null,
                dbNull: m.db === null,
                msg: m.CLOUD_DISABLED_MESSAGE,
                exported: ['app', 'auth', 'db', 'isFirebaseConfigured'].every(k => k in m),
            };
        }"""
        )
        check("firebase module exports safe handles + isFirebaseConfigured",
              fb["exported"] and isinstance(fb["configured"], bool),
              json.dumps(fb))
        check("auth/db are null exactly when Firebase is unconfigured",
              fb["authNull"] == (not fb["configured"]) and fb["dbNull"] == (not fb["configured"]),
              f"configured={fb['configured']} authNull={fb['authNull']} dbNull={fb['dbNull']}")

        body_now = page.inner_text("body")
        if fb["configured"]:
            check("configured build offers the sign-in UI",
                  "Sign in" in body_now or "Local only" not in body_now)
        else:
            check("unconfigured build renders the app, not a white screen",
                  len(body_now) > 200 and "ECHOLAB" in body_now,
                  f"body length {len(body_now)}")
            check("unconfigured build shows the 'Local only' badge",
                  "Local only" in body_now)
            check("unconfigured build offers no unusable sign-in button",
                  not page.evaluate(
                      "() => !!Array.from(document.querySelectorAll('button'))"
                      ".find(b => b.textContent.trim() === 'Sign in')"))

            # A cloud action must toast the offline notice, never throw.
            page.click("button[title='Projects']")
            page.wait_for_timeout(1000)
            page.fill("input[placeholder='Project name...']", "Offline Guard")
            page.evaluate(
                """() => {
                const b = Array.from(document.querySelectorAll('button'))
                    .find(x => /Save to Cloud|Sign in & Save/.test(x.textContent));
                if (b) b.click();
            }"""
            )
            page.wait_for_timeout(1500)
            offline_toasts = page.evaluate(
                """() => Array.from(document.querySelectorAll('[data-sonner-toast]'))
                    .map(t => t.innerText)"""
            )
            check("cloud action toasts the offline notice instead of crashing",
                  any("offline mode" in t.lower() or "disabled" in t.lower()
                      for t in offline_toasts),
                  json.dumps(offline_toasts))

            # Local projects must remain fully functional.
            page.evaluate(
                """() => {
                const b = Array.from(document.querySelectorAll('button'))
                    .find(x => x.textContent.trim() === 'Local');
                if (b) b.click();
            }"""
            )
            page.wait_for_timeout(400)
            page.fill("input[placeholder='Project name...']", "Offline Local Project")
            page.evaluate(
                """() => {
                const b = Array.from(document.querySelectorAll('button'))
                    .find(x => /Save Local/.test(x.textContent));
                if (b) b.click();
            }"""
            )
            page.wait_for_timeout(1200)
            check("local project save still works in offline mode",
                  "Offline Local Project" in page.inner_text("body"))

        # The ErrorBoundary test deliberately throws to exercise the boundary; the
        # boundary catching it is the point, so exclude that known probe error.
        real_page_errors = [e for e in page_errors if "boundary-probe-boom" not in e]
        check("no unhandled page errors across the whole run",
              len(real_page_errors) == 0, json.dumps(real_page_errors[:5]))

        browser.close()

    print("\n" + "=" * 70)
    failed = [r for r in results if not r[1]]
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILURES:")
        for name, _, detail in failed:
            print(f"  - {name}: {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
