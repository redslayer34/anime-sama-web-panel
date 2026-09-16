"""Backend dont les épisodes pointent sur le faux hébergeur anti-hotlink.

Sert à vérifier la bascule du panel vers le relais.

    python api_media.py [port] [hôte_vidéo]
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
HOST = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1:9100"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            return self.json({"ok": 1})
        if path == "/api/loadBaseAnimeData":
            return self.json([{"title": "Frieren", "link": "https://x/catalogue/frieren/"}])
        if path == "/api/getSerchAnime":
            return self.json([{"title": "Frieren", "lien": "https://x/catalogue/frieren/", "score": 99}])
        if path == "/api/getInfoAnime":
            return self.json([{"Saison": "Saison 1", "url": "https://x/catalogue/frieren/saison1/"}])
        if path == "/api/getAnimeLink":
            return self.json([{"episode": i, "url": f"http://{HOST}/media/ep{i}.mp4"}
                              for i in range(1, 9)])
        return self.json({"error": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
