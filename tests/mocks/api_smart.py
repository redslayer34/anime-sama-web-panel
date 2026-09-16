"""Backend factice dédié au test du chargement intelligent.

Deux comportements distincts, choisis à l'appel :
  - un épisode demandé via &e=N répond vite (0.3 s) — comme le fait le patch
    du panel une fois appliqué ;
  - la saison entière (sans &e) répond lentement (4 s) — comme le ferait un
    backend qui résout tous les épisodes en série.

Cet écart de délai rend le bénéfice mesurable dans le test navigateur : un
épisode doit être jouable bien avant que la saison entière ait fini.

Variable d'environnement MOCK_UNPATCHED=1 : simule un backend non patché, qui
ignore &e et renvoie toujours le tableau complet (lentement) — sert à vérifier
que le panel se dégrade proprement sans ce chemin rapide.

    python api_smart.py [port]
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
UNPATCHED = os.environ.get("MOCK_UNPATCHED", "").strip() in ("1", "true")

EPISODE_DELAY = 0.3
SEASON_DELAY = 4.0
COUNT = 12


def episodes():
    # Le vrai backend patché numérote toujours depuis 0 (enumerate() sur une
    # liste Python) : ce mock reste cohérent avec ça pour les deux chemins.
    return [{"episode": i, "url": f"https://vidmoly.invalid/embed-s1-{i}.html"} for i in range(COUNT)]


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
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        path = url.path

        if path == "/":
            return self.json({"Bonjours": "api"})
        if path == "/api/loadBaseAnimeData":
            return self.json([{"title": "Frieren", "AlterTitle": "", "link": "https://x/catalogue/frieren/"}])
        if path == "/api/getSerchAnime":
            return self.json([{"title": "Frieren", "lien": "https://x/catalogue/frieren/", "score": 95}])
        if path == "/api/getInfoAnime":
            return self.json([{"Saison": "Saison 1", "url": "https://x/catalogue/frieren/saison1/"}])

        if path == "/api/getAnimeLink":
            episode_arg = query.get("e", "")
            if not UNPATCHED and episode_arg.isdigit():
                time.sleep(EPISODE_DELAY)
                target = int(episode_arg)
                match = next((x for x in episodes() if x["episode"] == target), None)
                return self.json({"count": COUNT, "results": [match] if match else []})
            time.sleep(SEASON_DELAY)
            return self.json(episodes())

        return self.json({"error": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
