"""Faux hébergeur vidéo : refuse toute requête sans Referer, comme les vrais.

Sert une playlist HLS (avec clé de chiffrement, segment relatif, chemin absolu
et hôte tiers), une playlist maître, des segments et un MP4 gérant les Range.

    python video_host.py [port]
"""
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9100
SEGMENT = b"\x47" + b"\x00" * 1879
MEDIA = b"A" * 200000

PLAYLIST = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1.key"
#EXTINF:4.0,
seg/0.ts
#EXTINF:4.0,
/abs/seg/1.ts
#EXTINF:4.0,
https://cdn.autre.test/seg/2.ts
#EXT-X-ENDLIST
"""

MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
https://host.test/high/index.m3u8
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def empty(self, status):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if not self.headers.get("Referer"):          # protection anti-hotlink
            return self.empty(403)

        if path.endswith("master.m3u8"):
            body, ctype = MASTER.encode(), "application/vnd.apple.mpegurl"
        elif path.endswith(".m3u8"):
            body, ctype = PLAYLIST.encode(), "application/vnd.apple.mpegurl"
        elif path.endswith(".key"):
            body, ctype = b"0123456789abcdef", "application/octet-stream"
        elif path.endswith(".ts"):
            body, ctype = SEGMENT, "video/mp2t"
        elif path.endswith(".mp4"):
            ctype = "video/mp4"
            rng = self.headers.get("Range", "")
            if rng.startswith("bytes="):
                first, _, last = rng[6:].partition("-")
                start = int(first or 0)
                end = int(last) if last else len(MEDIA) - 1
                chunk = MEDIA[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(MEDIA)}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)
                return
            body = MEDIA
        else:
            return self.empty(404)

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
