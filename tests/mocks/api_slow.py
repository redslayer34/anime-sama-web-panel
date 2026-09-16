"""Backend dont getAnimeLink met douze secondes, comme une vraie résolution.

Compte les appels pour vérifier que le cache du serveur évite les doublons.

    python api_slow.py [port]
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
DELAY = 12
calls = {"getAnimeLink": 0}


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
            return self.json({"Bonjours": "api"})
        if path == "/api/loadBaseAnimeData":
            return self.json([{"title": "Frieren", "AlterTitle": "",
                               "link": "https://x/catalogue/frieren/"}])
        if path == "/api/getSerchAnime":
            return self.json([{"title": "Frieren", "lien": "https://x/catalogue/frieren/", "score": 95}])
        if path == "/api/getInfoAnime":
            return self.json([{"Saison": "Saison 1", "url": "https://x/catalogue/frieren/saison1/"}])
        if path == "/api/getAnimeLink":
            calls["getAnimeLink"] += 1
            time.sleep(DELAY)
            return self.json([{"episode": i, "url": f"https://vidmoly.invalid/e{i}.html"}
                              for i in range(1, 29)])
        if path == "/api/calls":
            return self.json(calls)
        return self.json({"error": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
