"""Backend démarrant sur un catalogue vide, comme un conteneur fraîchement créé.

L'indexation est simulée en quatre secondes au lieu de plusieurs minutes.

    python api_empty.py [port]
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
state = {"indexed": False}
CATALOGUE = [{"title": f"Anime {i}", "AlterTitle": "", "link": f"https://x/catalogue/anime-{i}/"}
             for i in range(42)]


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
            return self.json(CATALOGUE if state["indexed"] else [])
        if path == "/api/getAllAnime":
            time.sleep(4)
            state["indexed"] = True
            return self.json("Recuperation achever")
        return self.json({"error": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
