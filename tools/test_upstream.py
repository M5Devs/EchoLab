"""
Test upstream for the EchoLab browser suite.

A deliberately *foreign-origin* HTTP server (no CORS headers) that serves:

  /song.mp3            a real, valid WAV/MP3-ish audio payload with `Range` support
  /page                an HTML web page (Content-Type: text/html)
  /captcha              an HTML challenge page, as Cloudflare would return
  /playlist.m3u8        an HLS text playlist (Content-Type: application/vnd.apple.mpegurl)
  /api.json             a JSON error body
  /lyrics.txt           a plain-text body
  /mislabelled.mp3      HTML served with a lying `audio/mpeg` Content-Type
  /notfound.mp3         404
  /boom.mp3            500

And a SoundCloud-shaped tree so the resolver can be exercised without touching
the real service:

  /sc/track             a track page carrying `window.__sc_hydration`
  /sc/media/hls.json    the transcoding endpoint, returning a playlist URL
  /sc/playlist.m3u8     a fragmented-MP4 media playlist (init + segments)
  /sc/init.mp4          the fMP4 init segment (ftyp + moov)
  /sc/seg<N>.m4s        media fragments (moof + mdat)

It exists so the "the URL returned a web page, not audio" path and the SoundCloud
resolver can be tested against real network responses rather than mocks. Python's
built-in `http.server` is not used because it ignores the `Range` header, which
the proxy checks depend on.

Usage:  python3 tools/test_upstream.py [port]   (default 8898)
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# A tiny but structurally valid 8-bit mono WAV (1 kHz-ish square) padded so the
# payload is comfortably larger than the magic-number prefix the app inspects.
SAMPLE_RATE = 8000
SECONDS = 1
SAMPLES = SAMPLE_RATE * SECONDS
PCM = bytes(
    128 + (60 if (i // 40) % 2 == 0 else -60) & 0xFF
    for i in range(SAMPLES)
)
WAV = (
    b'RIFF'
    + (36 + len(PCM)).to_bytes(4, 'little')
    + b'WAVEfmt '
    + (16).to_bytes(4, 'little')
    + (1).to_bytes(2, 'little')          # PCM
    + (1).to_bytes(2, 'little')          # mono
    + SAMPLE_RATE.to_bytes(4, 'little')
    + SAMPLE_RATE.to_bytes(4, 'little')  # byte rate (8-bit mono)
    + (1).to_bytes(2, 'little')          # block align
    + (8).to_bytes(2, 'little')          # bits per sample
    + b'data'
    + len(PCM).to_bytes(4, 'little')
    + PCM
)

HTML_PAGE = (
    b'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    b'<title>SoundCloud</title></head><body>'
    b'<h1>Listen on SoundCloud</h1><p>This is a web page, not an audio file.</p>'
    b'</body></html>'
)

CAPTCHA_PAGE = (
    b'<!DOCTYPE html><html><head><title>Just a moment...</title></head>'
    b'<body><h1>Checking your browser before accessing.</h1>'
    b'<p>Cloudflare challenge.</p></body></html>'
)

HLS_PLAYLIST = (
    b'#EXTM3U\n'
    b'#EXT-X-VERSION:3\n'
    b'#EXT-X-TARGETDURATION:10\n'
    b'#EXTINF:10.0,\n'
    b'segment0.aac\n'
    b'#EXT-X-ENDLIST\n'
)

JSON_BODY = b'{"error":"track is not available in your region"}'
TEXT_BODY = b'Not Found - the requested track has been removed.'

# ── SoundCloud-shaped fixtures ────────────────────────────────────────────────
# A real fMP4 init segment starts with a box size then "ftyp"; the resolver only
# concatenates bytes, so the payload just needs the right shape and order.
SC_INIT = (0x18).to_bytes(4, 'big') + b'ftypiso5' + b'\x00\x00\x00\x00iso5' + b'\x00' * 8
SC_SEGMENTS = [
    (0x10).to_bytes(4, 'big') + b'moof' + b'\x00' * 8 + b'audio-one',
    (0x10).to_bytes(4, 'big') + b'moof' + b'\x00' * 8 + b'audio-two',
    (0x10).to_bytes(4, 'big') + b'moof' + b'\x00' * 8 + b'audio-three',
]
SC_CLIENT_ID = 'QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k'

SC_HYDRATION = [
    {"hydratable": "apiClient", "data": {"id": SC_CLIENT_ID, "isExpiring": True}},
    {
        "hydratable": "sound",
        "data": {
            "id": 123456,
            "kind": "track",
            "title": "Test Track",
            "streamable": True,
            "policy": "MONETIZE",
            "duration": 30000,
            "user": {"username": "Test Artist"},
            "track_authorization": "test-auth-token",
            "media": {
                "transcodings": [
                    {
                        "format": {"protocol": "hls", "mime_type": 'audio/mp4; codecs="mp4a.40.2"'},
                        "preset": "aac_160k",
                        "url": "http://127.0.0.1:{port}/sc/media/hls.json",
                    }
                ]
            },
        },
    },
]


def sc_track_page(port: int) -> bytes:
    """A track page carrying the hydration blob the resolver looks for."""
    hydration = json.dumps(SC_HYDRATION).replace('{port}', str(port))
    return (
        '<!DOCTYPE html><html><head><title>Test Track</title></head><body>'
        '<script>window.__sc_hydration = ' + hydration + ';</script>'
        '</body></html>'
    ).encode('utf-8')


def sc_playlist() -> bytes:
    lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:VOD']
    lines.append('#EXT-X-MAP:URI="init.mp4"')
    for i in range(len(SC_SEGMENTS)):
        lines.append('#EXTINF:10.0,')
        lines.append(f'seg{i}.m4s')
    lines.append('#EXT-X-ENDLIST')
    return ('\n'.join(lines) + '\n').encode('utf-8')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    # Deliberately NO CORS headers: this must behave like a foreign origin.
    def _send(self, status, body: bytes, content_type: str, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _serve_audio(self):
        body = WAV
        range_header = self.headers.get('Range')
        if range_header and range_header.startswith('bytes='):
            spec = range_header[len('bytes='):].split(',')[0]
            start_s, _, end_s = spec.partition('-')
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else len(body) - 1
            end = min(end, len(body) - 1)
            chunk = body[start:end + 1]
            self.send_response(206)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(chunk)))
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(body)}')
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(chunk)
            return
        self._send(200, body, 'audio/wav', {'Accept-Ranges': 'bytes'})

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/song.mp3', '/song.wav'):
            return self._serve_audio()
        if path == '/page':
            return self._send(200, HTML_PAGE, 'text/html; charset=utf-8')
        if path == '/captcha':
            return self._send(403, CAPTCHA_PAGE, 'text/html; charset=utf-8')
        if path == '/playlist.m3u8':
            return self._send(200, HLS_PLAYLIST, 'application/vnd.apple.mpegurl')
        if path == '/api.json':
            return self._send(200, JSON_BODY, 'application/json')
        if path == '/lyrics.txt':
            return self._send(200, TEXT_BODY, 'text/plain; charset=utf-8')
        if path == '/mislabelled.mp3':
            # A lying Content-Type: only the magic bytes reveal the truth.
            return self._send(200, HTML_PAGE, 'audio/mpeg')
        if path == '/boom.mp3':
            return self._send(500, b'internal error', 'text/plain')

        # ── SoundCloud-shaped tree ────────────────────────────────────────────
        if path == '/sc/track':
            return self._send(200, sc_track_page(self.server.server_port), 'text/html; charset=utf-8')
        if path == '/sc/media/hls.json':
            # The transcoding endpoint the resolver calls with ?client_id=…
            playlist_url = f'http://127.0.0.1:{self.server.server_port}/sc/playlist.m3u8'
            return self._send(200, json.dumps({'url': playlist_url}).encode(), 'application/json')
        if path == '/sc/playlist.m3u8':
            return self._send(200, sc_playlist(), 'application/vnd.apple.mpegurl')
        if path == '/sc/init.mp4':
            return self._send(200, SC_INIT, 'video/mp4')
        m = re.fullmatch(r'/sc/seg(\d+)\.m4s', path)
        if m:
            index = int(m.group(1))
            if 0 <= index < len(SC_SEGMENTS):
                return self._send(200, SC_SEGMENTS[index], 'video/iso.segment')

        return self._send(404, b'not found', 'text/plain')

    def do_HEAD(self):
        return self.do_GET()

    def log_message(self, fmt, *args):  # keep the test output readable
        sys.stderr.write('upstream: ' + fmt % args + '\n')


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'test upstream listening on http://127.0.0.1:{port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
