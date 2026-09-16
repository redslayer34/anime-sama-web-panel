"""Backend factice conforme au contrat d'AnimeSamaApi.

Reproduit volontairement les cas pénibles rencontrés en vrai : épisodes
numérotés à partir de 0, version absente d'une saison, sources mêlant fichiers
directs et pages de lecteur.

    python api.py [port]
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
STATIC = "http://127.0.0.1:8080"          # racine du dépôt servie par les tests
FIXTURES = STATIC + "/tests/fixtures"

CATALOGUE = [
    {"title": "One Piece", "AlterTitle": "Wan Pisu", "link": "https://anime-sama.org/catalogue/one-piece/"},
    {"title": "Frieren", "AlterTitle": "Sousou no Frieren", "link": "https://anime-sama.org/catalogue/frieren/"},
    {"title": "Demon Slayer", "AlterTitle": "Kimetsu no Yaiba", "link": "https://anime-sama.org/catalogue/demon-slayer/"},
    {"title": "Jujutsu Kaisen", "AlterTitle": "", "link": "https://anime-sama.org/catalogue/jujutsu-kaisen/"},
    {"title": "Attack on Titan", "AlterTitle": "Shingeki no Kyojin", "link": "https://anime-sama.org/catalogue/attack-on-titan/"},
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        path = url.path

        if path == "/":
            return self.json({"Bonjours": "Je suis une api", "Valeur q": query.get("q", "")})

        if path == "/api/loadBaseAnimeData":
            return self.json(CATALOGUE)

        if path == "/api/getSerchAnime":
            needle = query.get("q", "").lower()
            limit = int(query.get("l", 5) or 5)
            return self.json([
                {"title": a["title"], "lien": a["link"], "score": 95 - i * 3}
                for i, a in enumerate(CATALOGUE) if needle in a["title"].lower()
            ][:limit])

        if path == "/api/getInfoAnime":
            name = query.get("q", "Anime")
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
            base = f"https://anime-sama.org/catalogue/{slug}/"
            return self.json([
                {"base_url": base, "title": name, "Saison": "Saison 1", "url": base + "saison1/"},
                {"base_url": base, "title": name, "Saison": "Saison 2", "url": base + "saison2/"},
                {"base_url": base, "title": name, "Saison": "Film", "url": base + "film/"},
            ])

        if path == "/api/getAnimeLink":
            season, version = query.get("s", "saison1"), query.get("v", "vostfr")
            if version == "vf" and season == "saison2":
                return self.json([])                     # version absente : cas réel
            count = 3 if season == "film" else 8
            start = 0 if season == "saison2" else 1      # l'API numérote parfois depuis 0
            return self.json([
                {"episode": i,
                 "url": (f"{FIXTURES}/test.mp4" if i % 3 == 0
                         else f"https://vidmoly.invalid/embed-{season}-{i}.html")}
                for i in range(start, start + count)
            ])

        if path == "/api/getAnimeSamaURL":
            return self.json([{"url": "https://anime-sama.org"}])

        if path == "/api/getScanHashmap":
            return self.json({"title": query.get("n", ""), "max_chapter": 4,
                              "1": 3, "2": 2, "3": 3, "4": 1})

        if path == "/api/getScanLink":
            chapter = query.get("c", "1")
            return self.json({f"Chapitre {chapter}": [
                f"{FIXTURES}/page{i}.svg" for i in (1, 2, 3)]})

        return self.json({"error": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
