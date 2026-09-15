#!/usr/bin/env python3
"""
Sert le panel Anime-Sama et relaie /api/ vers le backend AnimeSamaApi.

Le panel et l'API se retrouvent ainsi sur la même origine : plus aucune
requête cross-origin, donc plus aucun problème de CORS ni de contenu mixte,
et rien à modifier dans le backend.

    python3 serve.py                  # panel sur 8080, backend sur 127.0.0.1:5000
    python3 serve.py --port 9000 --api http://127.0.0.1:5001

Bibliothèque standard uniquement : aucune dépendance à installer.
"""

import argparse
import sys
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROXY_PREFIXES = ("/api/", "/api?")


def is_api_call(path):
    """Route API ? Les routes /api/*, plus « /?q=… » qui est le health-check
    du backend — la racine sans paramètre reste le panel lui-même."""
    return path.startswith(PROXY_PREFIXES) or path.startswith("/?")


class PanelHandler(SimpleHTTPRequestHandler):
    """Fichiers statiques du dossier courant + relais transparent vers l'API."""

    def __init__(self, *args, api_base="http://127.0.0.1:5000", timeout=600, **kwargs):
        self.api_base = api_base.rstrip("/")
        self.timeout = timeout
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def do_GET(self):
        if is_api_call(self.path):
            self.proxy()
        else:
            super().do_GET()

    def do_HEAD(self):
        if is_api_call(self.path):
            self.proxy(body=False)
        else:
            super().do_HEAD()

    def proxy(self, body=True):
        target = self.api_base + self.path
        request = urllib.request.Request(target, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as upstream:
                payload = upstream.read()
                content_type = upstream.headers.get("Content-Type", "application/json")
                status = upstream.status
        except urllib.error.HTTPError as err:          # le backend a répondu une erreur
            payload, content_type, status = err.read(), "application/json", err.code
        except Exception as err:                        # backend injoignable / délai dépassé
            payload = ('{"error": "backend injoignable", "detail": %s}'
                       % _json_string(str(err))).encode()
            content_type, status = "application/json", 502

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(payload)


def _json_string(text):
    import json
    return json.dumps(text)


def main():
    parser = argparse.ArgumentParser(description="Serveur local du panel Anime-Sama.")
    parser.add_argument("--port", type=int, default=8080, help="port d'écoute du panel (défaut : 8080)")
    parser.add_argument("--host", default="127.0.0.1", help="interface d'écoute (défaut : 127.0.0.1)")
    parser.add_argument("--api", default="http://127.0.0.1:5000", help="URL du backend AnimeSamaApi")
    parser.add_argument("--timeout", type=int, default=600, help="délai maximal d'une requête API, en secondes")
    args = parser.parse_args()

    if not (ROOT / "index.html").exists():
        sys.exit(f"index.html est introuvable dans {ROOT}")

    handler = partial(PanelHandler, api_base=args.api, timeout=args.timeout)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Panel   : http://{args.host}:{args.port}/")
    print(f"API     : {args.api} (relayée sur /api/)")
    print("Laisse le champ « URL du backend » vide dans les paramètres du panel.")
    print("Ctrl+C pour arrêter.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")
        server.server_close()


if __name__ == "__main__":
    main()
