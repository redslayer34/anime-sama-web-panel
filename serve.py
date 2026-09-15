#!/usr/bin/env python3
"""
Lanceur du panel Anime-Sama.

Une seule commande suffit :

    python3 serve.py

Le script se charge de tout :
  1. il cherche le backend AnimeSamaApi déjà en route (ports 5000, 5001, 5002) ;
  2. s'il n'en trouve pas, il essaie de le démarrer lui-même (dossier voisin,
     ou chemin donné via --backend) et attend qu'il réponde ;
  3. il sert le panel et relaie /api vers ce backend, sur la même origine —
     donc aucun souci de CORS, et rien à saisir dans les paramètres ;
  4. il ouvre le navigateur sur la bonne adresse.

Options utiles :
    --api http://127.0.0.1:5001   forcer l'adresse du backend (pas de détection)
    --backend ../AnimeSamaApi     dossier du backend à démarrer
    --no-backend                  ne pas chercher ni démarrer de backend
    --port 9000                   port du panel (incrémenté s'il est occupé)
    --no-open                     ne pas ouvrir le navigateur

Bibliothèque standard uniquement : aucune dépendance à installer.
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PROBE_PORTS = (5000, 5001, 5002)
BACKEND_DIR_NAMES = ("AnimeSamaApi", "animesamaapi", "anime-sama-api", "api")
PROXY_PREFIXES = ("/api/", "/api?")

# Le backend garde ces routes longues : scraping à la volée, indexation initiale.
SLOW_ROUTES = ("/api/getAllAnime", "/api/getAnimeLink", "/api/getScanLink")


def say(message=""):
    print(message, flush=True)


# ─────────────────────────────────────────────
#  Détection et démarrage du backend
# ─────────────────────────────────────────────
def backend_answers(base, timeout=1.0):
    """Le backend répond-il sur son health-check ?"""
    try:
        with urllib.request.urlopen(f"{base}/?q=panel", timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def detect_backend():
    for port in PROBE_PORTS:
        base = f"http://127.0.0.1:{port}"
        if backend_answers(base, timeout=0.7):
            return base
    return None


def find_backend_dir(explicit=None):
    """Localise le dossier d'AnimeSamaApi : chemin donné, dossier voisin, ou home."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    for name in BACKEND_DIR_NAMES:
        candidates += [ROOT / name, ROOT.parent / name, Path.home() / name]
    for path in candidates:
        try:
            if (path / "main.py").is_file():
                return path.resolve()
        except OSError:
            continue
    return None


def start_backend(directory, wait=90):
    """Démarre `python main.py` dans le dossier donné et attend sa réponse."""
    say(f"Démarrage du backend depuis {directory}")
    try:
        process = subprocess.Popen(
            [sys.executable, "main.py"],
            cwd=str(directory),
            stdout=subprocess.DEVNULL if os.name == "nt" else None,
            stderr=subprocess.STDOUT if os.name == "nt" else None,
        )
    except Exception as err:
        say(f"  Échec du démarrage : {err}")
        return None, None

    deadline = time.time() + wait
    while time.time() < deadline:
        if process.poll() is not None:
            say(f"  Le backend s'est arrêté immédiatement (code {process.returncode}).")
            say("  Vérifie ses dépendances : pip install -r requirements.txt")
            return None, None
        base = detect_backend()
        if base:
            say(f"  Backend prêt sur {base}")
            return base, process
        time.sleep(0.8)

    say(f"  Le backend n'a pas répondu en {wait} s ; il continue peut-être de démarrer.")
    return None, process


def resolve_backend(args):
    """Retourne (url_du_backend_ou_None, processus_lancé_ou_None)."""
    if args.no_backend:
        return None, None

    if args.api:                                    # adresse imposée : on la respecte
        base = args.api.rstrip("/")
        say(f"Backend imposé : {base}" + ("" if backend_answers(base) else "  (il ne répond pas encore)"))
        return base, None

    base = detect_backend()
    if base:
        say(f"Backend détecté sur {base}")
        return base, None

    directory = find_backend_dir(args.backend)
    if directory:
        return start_backend(directory)

    say("Aucun backend trouvé sur les ports 5000-5002, et aucun dossier AnimeSamaApi repéré.")
    say("  → Le panel démarre quand même : le mode démo (Paramètres → Lecture) fonctionne sans backend.")
    say("  → Pour les vraies données : https://github.com/TMCooper/AnimeSamaApi")
    return None, None


# ─────────────────────────────────────────────
#  Serveur : fichiers statiques + relais /api
# ─────────────────────────────────────────────
def is_api_call(path):
    """Route API ? Les routes /api/*, plus « /?q=… » qui est le health-check du
    backend — la racine sans paramètre reste le panel lui-même."""
    return path.startswith(PROXY_PREFIXES) or path.startswith("/?")


class PanelHandler(SimpleHTTPRequestHandler):
    api_base = None          # renseigné par serve()
    timeout = 600
    quiet = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write("  %s\n" % (fmt % args))

    def do_GET(self):
        self.proxy() if is_api_call(self.path) else super().do_GET()

    def do_HEAD(self):
        self.proxy(body=False) if is_api_call(self.path) else super().do_HEAD()

    def proxy(self, body=True):
        if not PanelHandler.api_base:
            # Le backend n'était pas là au démarrage : on retente une détection.
            PanelHandler.api_base = detect_backend()
        if not PanelHandler.api_base:
            return self.send_payload(503, json.dumps({
                "error": "aucun backend",
                "detail": "Lance AnimeSamaApi (python main.py), ou active le mode démo "
                          "dans Paramètres → Lecture.",
            }).encode())

        timeout = self.timeout if self.path.startswith(SLOW_ROUTES) else min(self.timeout, 60)
        request = urllib.request.Request(PanelHandler.api_base + self.path,
                                         headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as upstream:
                payload = upstream.read()
                return self.send_payload(upstream.status, payload,
                                         upstream.headers.get("Content-Type", "application/json"), body)
        except urllib.error.HTTPError as err:        # le backend a répondu une erreur
            return self.send_payload(err.code, err.read(), "application/json", body)
        except Exception as err:                     # injoignable ou délai dépassé
            PanelHandler.api_base = None             # forcera une nouvelle détection
            return self.send_payload(502, json.dumps({
                "error": "backend injoignable", "detail": str(err),
            }).encode(), body=body)

    def send_payload(self, status, payload, content_type="application/json", body=True):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(payload)


def bind(host, port, span=20):
    """Premier port libre à partir de celui demandé."""
    for candidate in range(port, port + span):
        try:
            return ThreadingHTTPServer((host, candidate), PanelHandler), candidate
        except OSError as err:
            if getattr(err, "errno", None) not in (48, 98, 10048):   # déjà utilisé
                raise
    raise SystemExit(f"Aucun port libre entre {port} et {port + span - 1}.")


def main():
    parser = argparse.ArgumentParser(
        description="Lance le panel Anime-Sama et, si besoin, le backend AnimeSamaApi.")
    parser.add_argument("--port", type=int, default=8080, help="port du panel (défaut : 8080)")
    parser.add_argument("--host", default="127.0.0.1", help="interface d'écoute (défaut : 127.0.0.1)")
    parser.add_argument("--api", default=None, help="URL du backend (désactive la détection)")
    parser.add_argument("--backend", default=None, help="dossier d'AnimeSamaApi à démarrer")
    parser.add_argument("--no-backend", action="store_true", help="ne pas chercher de backend")
    parser.add_argument("--no-open", action="store_true", help="ne pas ouvrir le navigateur")
    parser.add_argument("--timeout", type=int, default=600, help="délai maximal d'un appel API, en secondes")
    parser.add_argument("--verbose", action="store_true", help="journaliser chaque requête")
    args = parser.parse_args()

    if not (ROOT / "index.html").is_file():
        sys.exit(f"index.html est introuvable dans {ROOT}")

    say("Panel Anime-Sama")
    say("─" * 46)
    api_base, child = resolve_backend(args)

    PanelHandler.api_base = api_base
    PanelHandler.timeout = args.timeout
    PanelHandler.quiet = not args.verbose

    server, port = bind(args.host, args.port)
    url = f"http://{args.host}:{port}/"

    say("─" * 46)
    say(f"Panel   : {url}")
    say(f"Backend : {api_base or 'aucun pour le moment (mode démo utilisable)'}")
    say("Ctrl+C pour tout arrêter.")
    say()

    if not args.no_open:
        threading.Timer(0.6, lambda: _open(url)).start()

    install_stop_signals(server)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        say()
    finally:
        say("Arrêt…")
        server.server_close()
        stop_child(child)


def install_stop_signals(server):
    """Ctrl+C lève déjà KeyboardInterrupt ; on traite aussi la fermeture du
    terminal et `kill`, sinon le backend démarré ici resterait orphelin."""
    def handler(signum, frame):
        # shutdown() doit être appelé depuis un autre fil que serve_forever().
        threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass                                   # signal indisponible sur la plateforme


def _open(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass                                   # pas de navigateur : l'URL est affichée


def stop_child(process):
    """Arrête le backend seulement si c'est nous qui l'avons démarré."""
    if not process or process.poll() is not None:
        return
    say("Arrêt du backend…")
    try:
        process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
        process.wait(timeout=8)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


if __name__ == "__main__":
    main()
