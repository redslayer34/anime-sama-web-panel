#!/usr/bin/env python3
"""
Lanceur et serveur du panel Anime-Sama.

Une seule commande suffit :

    python3 serve.py

Le script se charge de tout :
  1. il cherche le backend AnimeSamaApi déjà en route (ports 5000, 5001, 5002) ;
  2. s'il n'en trouve pas, il essaie de le démarrer lui-même (dossier voisin,
     ou chemin donné via --backend) et attend qu'il réponde ;
  3. il sert le panel et relaie /api vers ce backend, sur la même origine —
     donc aucun souci de CORS, et rien à saisir dans les paramètres ;
  4. il ouvre le navigateur sur la bonne adresse.

Ce qu'il fait en plus, pour un panel exposé sur Internet :
  • /healthz, ouvert sans identifiants, pour la sonde de l'hébergeur ;
  • mot de passe sur tout le reste dès que PANEL_PASSWORD est défini ;
  • /stream, qui relaie les flux vidéo dont l'hébergeur refuse la lecture
    directe (CORS, contrôle du Referer), playlists HLS réécrites au passage ;
  • getAnimeLink et getScanLink traitées en tâche de fond, avec un cache
    partagé : aucune requête HTTP ne reste ouverte pendant des minutes ;
  • indexation du catalogue au démarrage s'il est vide (PANEL_AUTO_INDEX).

Options :
    --api http://127.0.0.1:5001   forcer l'adresse du backend (pas de détection)
    --backend ../AnimeSamaApi     dossier du backend à démarrer
    --backend-entry api_entry.py  script du backend à exécuter
    --no-backend                  ne pas chercher ni démarrer de backend
    --port 9000                   port du panel (incrémenté s'il est occupé)
    --host 0.0.0.0                interface d'écoute
    --timeout 600                 délai maximal d'un appel API, en secondes
    --auto-index                  indexer le catalogue au démarrage s'il est vide
    --no-open                     ne pas ouvrir le navigateur
    --verbose                     journaliser chaque requête

Variables d'environnement : PORT, PANEL_PASSWORD, PANEL_USER, PANEL_AUTO_INDEX.

Bibliothèque standard uniquement : aucune dépendance à installer.
Tests : python3 tests/run.py
"""

import argparse
import base64
import errno
import hmac
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
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

# Ces routes-là sont si lentes qu'aucune requête HTTP ne doit les attendre :
# getAnimeLink résout l'URL vidéo de chaque épisode l'un après l'autre, soit une
# à trois requêtes par épisode. Elles passent donc par une tâche de fond, et la
# réponse immédiate est un 202 que le panel suit en interrogeant à nouveau.
JOB_ROUTES = ("/api/getAnimeLink", "/api/getScanLink")
CACHE_TTL = 6 * 3600

# Relais de flux vidéo. Les hébergeurs n'envoient pas d'en-tête CORS : un
# navigateur refuse donc de lire leurs flux depuis le panel. En passant par le
# serveur, la lecture redevient une requête de même origine.
STREAM_ROUTE = "/stream"

# Route distincte pour les jaquettes. Elle pourrait passer par /stream, mais
# les deux usages n'ont ni la même politique de cache (une affiche se garde,
# un flux vidéo signé expire) ni le même volume, et les séparer garde le
# réglage « relais vidéo » du panel fidèle à son intitulé.
IMAGE_ROUTE = "/img"
STREAM_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
PLAYLIST_MAX = 4 * 1024 * 1024        # une playlist HLS dépasse rarement quelques Ko
STREAM_CHUNK = 64 * 1024

# Le relais sert du contenu distant depuis l'origine du panel. Un hébergeur
# hostile qui renverrait du HTML verrait donc son script s'exécuter avec les
# droits de la page. Seuls les types médias traversent tels quels ; le reste est
# rendu inerte.
STREAM_SAFE_TYPES = (
    "video/", "audio/", "image/", "text/vtt",
    "application/octet-stream", "application/mp4",
    "application/vnd.apple.mpegurl", "application/x-mpegurl",
    "application/dash+xml",
)

# Les jaquettes passent par le relais et sont redemandées à chaque défilement.
# Sans cache, la grille les retélécharge en boucle — coûteux sur un hébergement
# gratuit. La vidéo, elle, reste non stockée : flux volumineux, souvent derrière
# des URLs signées à durée de vie courte.
IMAGE_CACHE = "public, max-age=604800, immutable"
IMAGE_MAX = 6 * 1024 * 1024   # une jaquette de catalogue pèse quelques dizaines de Ko


def inert_type(content_type):
    base = (content_type or "").split(";")[0].strip().lower()
    return base if base.startswith(STREAM_SAFE_TYPES) else "application/octet-stream"


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


def find_backend_dir(explicit=None, entry="main.py"):
    """Localise le dossier d'AnimeSamaApi : chemin donné, dossier voisin, ou home."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    for name in BACKEND_DIR_NAMES:
        candidates += [ROOT / name, ROOT.parent / name, Path.home() / name]
    for path in candidates:
        try:
            if (path / entry).is_file():
                return path.resolve()
        except OSError:
            continue
    return None


def start_backend(directory, entry="main.py", wait=90):
    """Démarre le backend dans le dossier donné et attend qu'il réponde.

    `entry` existe pour les conteneurs : le main.py d'AnimeSamaApi lance `git
    fetch`, puis `input()` si git est absent — ce qui bloque sans entrée
    standard — et démarre Flask en mode debug avec rechargeur. L'image Docker
    fournit donc son propre point d'entrée."""
    say(f"Démarrage du backend depuis {directory} ({entry})")
    try:
        process = subprocess.Popen([sys.executable, entry], cwd=str(directory))
    except Exception as err:
        say(f"  Échec du démarrage : {err}")
        return None, None

    deadline = time.time() + wait
    while time.time() < deadline:
        if process.poll() is not None:
            say(f"  Le backend s'est arrêté immédiatement (code {process.returncode}).")
            say("  Causes habituelles :")
            say("  • dépendances non installées (pip install -r requirements.txt) ;")
            say("  • anime-sama.pw injoignable — AnimeSamaApi résout le domaine actif")
            say("    dès l'import, et s'arrête si aucun ne répond (réseau filtré,")
            say("    ou Cloudflare qui bloque l'adresse IP du serveur).")
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

    directory = find_backend_dir(args.backend, args.backend_entry)
    if directory:
        return start_backend(directory, args.backend_entry)

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


# ─────────────────────────────────────────────
#  Accès protégé (déploiement public)
# ─────────────────────────────────────────────
PANEL_USER = os.environ.get("PANEL_USER", "panel")


def password():
    return os.environ.get("PANEL_PASSWORD", "").strip()


def credentials_ok(header):
    """Compare l'en-tête Authorization au mot de passe attendu, en temps constant."""
    if not header or not header.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(header.split(None, 1)[1].strip()).decode("utf-8")
    except Exception:
        return False
    user, _, given = decoded.partition(":")
    # Les deux comparaisons sont évaluées : pas de court-circuit sur le nom.
    return bool(hmac.compare_digest(user, PANEL_USER)
                & hmac.compare_digest(given, password()))


# ─────────────────────────────────────────────
#  Indexation du catalogue, en tâche de fond
# ─────────────────────────────────────────────
class Indexing:
    """Le proxy d'un hébergeur coupe les requêtes longues : l'indexation, qui dure
    3 à 5 minutes, tourne donc ici plutôt que déclenchée par une requête HTTP."""
    running = False
    done_at = None
    error = None

    @classmethod
    def catalogue_size(cls, base):
        """Nombre de fiches en base, ou None si le backend ne répond pas."""
        try:
            with urllib.request.urlopen(f"{base}/api/loadBaseAnimeData", timeout=30) as response:
                data = json.loads(response.read() or b"null")
            return len(data) if isinstance(data, list) else 0
        except Exception:
            return None

    @classmethod
    def start_if_needed(cls, base):
        if cls.running or not base:
            return
        size = cls.catalogue_size(base)
        if size is None:
            return                                   # backend muet : on ne force rien
        if size > 0:
            say(f"Catalogue déjà indexé : {size} fiches.")
            return
        cls.running = True
        say("Catalogue vide : indexation lancée en tâche de fond (3 à 5 minutes).")
        threading.Thread(target=cls._work, args=(base,), daemon=True).start()

    @classmethod
    def _work(cls, base):
        try:
            with urllib.request.urlopen(f"{base}/api/getAllAnime?r=True", timeout=1800):
                pass
            size = cls.catalogue_size(base) or 0
            cls.error = None if size else "l'indexation n'a produit aucune fiche"
            say(f"Indexation terminée : {size} fiches.")
        except Exception as err:
            cls.error = str(err)
            say(f"Indexation échouée : {err}")
        finally:
            cls.running = False
            cls.done_at = time.time()


def stream_target(url):
    """Valide une cible de relais. Retourne (url, None) ou (None, raison).

    Sans ce filtre, la route servirait de rebond vers le réseau interne de
    l'hébergeur — à commencer par le backend sur 127.0.0.1."""
    if not url:
        return None, "paramètre « u » manquant"
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return None, "seules les URL http(s) sont relayées"
    if not parts.hostname:
        return None, "hôte absent"
    try:
        infos = socket.getaddrinfo(parts.hostname, None)
    except OSError:
        return None, "hôte introuvable"
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (address.is_private or address.is_loopback or address.is_link_local
                or address.is_reserved or address.is_multicast):
            return None, "adresse interne refusée"
    return url, None


def proxied(url):
    return f"{STREAM_ROUTE}?u={urllib.parse.quote(url, safe='')}"


def is_playlist(url, content_type):
    path = urllib.parse.urlsplit(url).path.lower()
    return (path.endswith((".m3u8", ".m3u"))
            or "mpegurl" in (content_type or "").lower())


URI_ATTR = re.compile(r'URI="([^"]*)"')


def rewrite_playlist(text, base_url):
    """Fait passer par le relais tout ce qu'une playlist HLS référence.

    Sans cette réécriture, seul le manifeste serait relayé : le navigateur irait
    chercher les segments en direct et se heurterait de nouveau au CORS."""
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append(line)
        elif stripped.startswith("#"):
            # Clés de chiffrement, segment d'initialisation, rendus alternatifs.
            lines.append(URI_ATTR.sub(
                lambda m: 'URI="%s"' % proxied(urllib.parse.urljoin(base_url, m.group(1))),
                line))
        else:
            lines.append(proxied(urllib.parse.urljoin(base_url, stripped)))
    return "\n".join(lines) + "\n"


def fetch_upstream(base, path, timeout):
    """Interroge le backend. Retourne (statut, type_de_contenu, corps)."""
    request = urllib.request.Request(base + path, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as upstream:
            return (upstream.status,
                    upstream.headers.get("Content-Type", "application/json"),
                    upstream.read())
    except urllib.error.HTTPError as err:          # le backend a répondu une erreur
        return err.code, "application/json", err.read()
    except Exception as err:                       # injoignable ou délai dépassé
        return 502, "application/json", json.dumps({
            "error": "backend injoignable", "detail": str(err),
        }).encode()


class Jobs:
    """Tâches de fond partagées, avec leur cache.

    Deux visiteurs qui demandent la même saison au même moment partagent la même
    tâche ; une fois résolue, elle est servie instantanément à tout le monde
    pendant six heures. C'est ce cache qui rend le panel utilisable sur une
    petite instance : seul le tout premier chargement d'une saison est long."""

    lock = threading.Lock()
    running = {}      # clé -> instant de démarrage
    events = {}       # clé -> threading.Event, posé quand le travail se termine
    results = {}      # clé -> (expiration, statut, type de contenu, corps)

    # Un échec n'est gardé que brièvement : il doit pouvoir être retenté vite,
    # sans pour autant qu'un panel ouvert martèle le backend en boucle.
    ERROR_TTL = 30

    # Une entrée périmée n'était retirée que si la même clé était redemandée :
    # sur un serveur qui tourne des semaines, le cache ne faisait que grossir.
    MAX_ENTRIES = 200

    # Avant de répondre 202, on patiente un peu qu'un travail rapide (un seul
    # épisode, quelques secondes) se termine dans cette même requête : sans
    # ça, le panel attendrait toujours au moins un cycle de sondage complet
    # (JOB_POLL côté client) même pour un travail déjà fini. Négligeable pour
    # les tâches longues (une saison entière, des minutes), sur lesquelles ce
    # court délai ne fait aucune différence perceptible.
    LONG_POLL = 1.5

    @classmethod
    def _evict(cls):
        """À appeler en tenant le verrou : purge les périmées, puis les plus
        anciennes si la limite est dépassée."""
        now = time.time()
        for key in [k for k, v in cls.results.items() if v[0] <= now]:
            del cls.results[key]
        excess = len(cls.results) - cls.MAX_ENTRIES
        if excess > 0:
            for key in sorted(cls.results, key=lambda k: cls.results[k][0])[:excess]:
                del cls.results[key]

    @classmethod
    def get_or_start(cls, key, base, timeout):
        """Retourne ("done", résultat) ou ("pending", secondes écoulées).

        Tout se décide sous un seul verrou : sans ça, une tâche qui se termine
        entre la lecture du cache et le démarrage relancerait le même travail."""
        with cls.lock:
            entry = cls.results.get(key)
            if entry and time.time() < entry[0]:
                return "done", entry
            cls.results.pop(key, None)

            started = cls.running.get(key)
            event = cls.events.get(key)
            if started is None:
                started = cls.running[key] = time.time()
                event = cls.events[key] = threading.Event()
                threading.Thread(target=cls._work, args=(key, base, timeout, event), daemon=True).start()

        # Hors du verrou : les autres requêtes (même clé ou non) ne sont pas
        # bloquées pendant l'attente.
        if event is not None:
            event.wait(cls.LONG_POLL)

        with cls.lock:
            entry = cls.results.get(key)
            if entry and time.time() < entry[0]:
                return "done", entry
            return "pending", time.time() - started

    @classmethod
    def _work(cls, key, base, timeout, event):
        started = time.time()
        status, content_type, payload = fetch_upstream(base, key, timeout)
        ttl = CACHE_TTL if status == 200 else cls.ERROR_TTL
        with cls.lock:
            cls.running.pop(key, None)
            cls.events.pop(key, None)
            cls.results[key] = (time.time() + ttl, status, content_type, payload)
            cls._evict()
        event.set()
        say(f"Tâche {key.split('?')[0]} terminée en {round(time.time() - started)} s (HTTP {status}).")


class PanelHandler(SimpleHTTPRequestHandler):
    api_base = None          # renseigné par main()
    # Surtout pas `timeout` : StreamRequestHandler utilise cet attribut pour le
    # délai du socket. Le nommer ainsi faisait couper toute lecture vidéo au
    # bout de --timeout secondes.
    api_timeout = 600
    quiet = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write("  %s\n" % (fmt % args))

    def do_GET(self):
        self.route(body=True)

    def do_HEAD(self):
        self.route(body=False)

    def route(self, body):
        path = self.path.split("?")[0]

        # Exempté d'authentification : l'hébergeur doit pouvoir sonder le service
        # sans identifiants, sinon il le déclare en échec et le redéploie en boucle.
        if path == "/healthz":
            return self.send_payload(200, b'{"ok": true}', body=body)

        if not self.authorized():
            return
        if path == STREAM_ROUTE:
            return self.serve_stream(body)
        if path == IMAGE_ROUTE:
            return self.serve_image(body)
        if path == "/panel/state":
            return self.send_state(body)
        if is_api_call(self.path):
            return self.proxy(body=body)
        super().do_GET() if body else super().do_HEAD()

    def authorized(self):
        if not password():
            return True
        if credentials_ok(self.headers.get("Authorization")):
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Panel Anime-Sama", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def serve_image(self, body=True):
        """Relaie une jaquette : même garde-fou que le flux vidéo, mais on
        n'accepte que des images et on autorise le cache du navigateur."""
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target, refusal = stream_target((params.get("u") or [""])[0])
        if refusal:
            return self.send_payload(400, json.dumps({"error": refusal}).encode(), body=body)

        origin = urllib.parse.urlsplit(target)
        headers = {
            "User-Agent": STREAM_UA,
            "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
            "Referer": f"{origin.scheme}://{origin.netloc}/",
        }
        try:
            upstream = urllib.request.urlopen(
                urllib.request.Request(target, headers=headers), timeout=15)
        except Exception:
            # Le panel dessine lui-même une affiche de repli : un 404 discret
            # vaut mieux qu'un message d'erreur détaillé dans la console.
            return self.send_payload(404, b"", "image/gif", body=body)

        with upstream:
            served = inert_type(upstream.headers.get("Content-Type", ""))
            if not served.startswith("image/"):
                return self.send_payload(415, b"", "image/gif", body=body)
            payload = upstream.read(IMAGE_MAX)

        self.send_response(200)
        self.send_header("Content-Type", served)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", IMAGE_CACHE)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "sandbox")
        self.end_headers()
        if body:
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def serve_stream(self, body=True):
        """Relaie un flux vidéo, en réécrivant les playlists HLS au passage."""
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        target, refusal = stream_target((params.get("u") or [""])[0])
        if refusal:
            return self.send_payload(400, json.dumps({"error": refusal}).encode(), body=body)

        origin = urllib.parse.urlsplit(target)
        headers = {
            "User-Agent": STREAM_UA,
            "Accept": "*/*",
            # Beaucoup d'hébergeurs refusent une requête sans Referer cohérent.
            "Referer": f"{origin.scheme}://{origin.netloc}/",
        }
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]

        try:
            upstream = urllib.request.urlopen(
                urllib.request.Request(target, headers=headers), timeout=30)
        except urllib.error.HTTPError as err:
            return self.send_payload(err.code, json.dumps({
                "error": f"l'hébergeur a répondu HTTP {err.code}",
            }).encode(), body=body)
        except Exception as err:
            return self.send_payload(502, json.dumps({
                "error": "hébergeur injoignable", "detail": str(err),
            }).encode(), body=body)

        with upstream:
            content_type = upstream.headers.get("Content-Type", "application/octet-stream")

            if is_playlist(target, content_type):
                payload = rewrite_playlist(
                    upstream.read(PLAYLIST_MAX).decode("utf-8", "replace"),
                    upstream.geturl()).encode("utf-8")
                return self.send_payload(200, payload, "application/vnd.apple.mpegurl", body)

            self.send_response(upstream.status)
            served_type = inert_type(content_type)
            self.send_header("Content-Type", served_type)
            for name in ("Content-Length", "Content-Range", "Accept-Ranges"):
                value = upstream.headers.get(name)
                if value:
                    self.send_header(name, value)
            self.send_header(
                "Cache-Control",
                IMAGE_CACHE if served_type.startswith("image/") else "no-store")
            # Double garde-fou : pas de reniflage de type, et exécution
            # impossible même si un HTML passait à travers.
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "sandbox")
            self.end_headers()
            if not body:
                return
            try:
                shutil.copyfileobj(upstream, self.wfile, STREAM_CHUNK)
            except (BrokenPipeError, ConnectionResetError):
                pass          # le lecteur a changé de position ou fermé l'onglet

    def send_state(self, body=True):
        """État du service, pour la bannière d'indexation du panel."""
        base = PanelHandler.api_base or detect_backend()
        payload = json.dumps({
            "backend": bool(base),
            "indexing": Indexing.running,
            "error": Indexing.error,
            "protected": bool(password()),
            "relay": True,          # la route /stream existe sur ce serveur
        }).encode()
        self.send_payload(200, payload, body=body)

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

        timeout = (self.api_timeout if self.path.startswith(SLOW_ROUTES)
                   else min(self.api_timeout, 60))

        if self.path.startswith(JOB_ROUTES):
            return self.serve_job(PanelHandler.api_base, timeout, body)

        status, content_type, payload = fetch_upstream(PanelHandler.api_base, self.path, timeout)
        if status == 502:
            PanelHandler.api_base = None             # forcera une nouvelle détection
        return self.send_payload(status, payload, content_type, body)

    def serve_job(self, base, timeout, body=True):
        """Répond tout de suite : le résultat s'il est prêt, sinon un 202."""
        state, value = Jobs.get_or_start(self.path, base, timeout)
        if state == "done":
            _, status, content_type, payload = value
            return self.send_payload(status, payload, content_type, body)
        return self.send_payload(202, json.dumps({
            "pending": True,
            "elapsed": round(value, 1),
        }).encode(), body=body)

    def send_payload(self, status, payload, content_type="application/json", body=True):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if body:
            self.wfile.write(payload)


# EADDRINUSE et EACCES, sous leurs différentes formes selon la plateforme.
# Sous Windows, WinError 10013 ne veut pas dire « interdit » au sens des droits :
# le port tombe le plus souvent dans une plage réservée par Hyper-V, WSL ou
# Docker, alors même que personne ne l'écoute. Il faut donc simplement essayer
# le suivant, et non abandonner.
PORT_BUSY_ERRNOS = {errno.EADDRINUSE, errno.EACCES, 48, 98, 10013, 10048}
PORT_BUSY_WINERRORS = {10013, 10048}


def port_unavailable(err):
    return (getattr(err, "winerror", None) in PORT_BUSY_WINERRORS
            or getattr(err, "errno", None) in PORT_BUSY_ERRNOS)


def bind(host, port, span=20, strict=False):
    """Premier port utilisable à partir de celui demandé.

    `strict` sert à l'hébergement : quand la plateforme impose le port via $PORT,
    en changer rendrait le service injoignable sans message d'erreur lisible."""
    if strict:
        try:
            return ThreadingHTTPServer((host, port), PanelHandler), port
        except OSError as err:
            raise SystemExit(
                f"Le port {port} imposé par $PORT n'a pas pu être ouvert : {err}\n"
                "L'hébergeur attend le service sur ce port précis ; en changer le "
                "rendrait injoignable.")
    blocked = []
    for candidate in range(port, port + span):
        try:
            return ThreadingHTTPServer((host, candidate), PanelHandler), candidate
        except OSError as err:
            if not port_unavailable(err):
                raise
            blocked.append(candidate)

    # Dernier recours : laisser le système attribuer un port libre. C'est ce qui
    # sauve les machines où toute la plage est réservée.
    say(f"Ports {blocked[0]}-{blocked[-1]} indisponibles ; le système en choisit un.")
    if os.name == "nt":
        say("  (pour voir les plages réservées sous Windows :")
        say("   netsh interface ipv4 show excludedportrange protocol=tcp)")
    try:
        server = ThreadingHTTPServer((host, 0), PanelHandler)
        return server, server.server_address[1]
    except OSError as err:
        raise SystemExit(
            f"Impossible d'ouvrir un port sur {host} : {err}\n"
            "Un pare-feu ou une stratégie de sécurité bloque peut-être l'écoute réseau locale.")


def main():
    parser = argparse.ArgumentParser(
        description="Lance le panel Anime-Sama et, si besoin, le backend AnimeSamaApi.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 8080),
                        help="port du panel (défaut : $PORT si défini, sinon 8080)")
    parser.add_argument("--host", default="127.0.0.1", help="interface d'écoute (défaut : 127.0.0.1)")
    parser.add_argument("--api", default=None, help="URL du backend (désactive la détection)")
    parser.add_argument("--backend", default=None, help="dossier d'AnimeSamaApi à démarrer")
    parser.add_argument("--backend-entry", default="main.py",
                        help="script du backend à exécuter (défaut : main.py)")
    parser.add_argument("--no-backend", action="store_true", help="ne pas chercher de backend")
    parser.add_argument("--no-open", action="store_true", help="ne pas ouvrir le navigateur")
    parser.add_argument("--timeout", type=int, default=600, help="délai maximal d'un appel API, en secondes")
    parser.add_argument("--verbose", action="store_true", help="journaliser chaque requête")
    parser.add_argument("--auto-index", action="store_true",
                        default=os.environ.get("PANEL_AUTO_INDEX", "").strip() not in ("", "0", "false"),
                        help="indexer le catalogue au démarrage s'il est vide (défaut : $PANEL_AUTO_INDEX)")
    args = parser.parse_args()

    if not (ROOT / "index.html").is_file():
        sys.exit(f"index.html est introuvable dans {ROOT}")
    # Sans les feuilles de style, la page s'affiche mais sans aucune mise en
    # forme — un échec silencieux, et difficile à diagnostiquer à distance.
    if not (ROOT / "styles" / "tokens.css").is_file():
        sys.exit(f"le dossier styles/ est introuvable dans {ROOT}")

    say("Panel Anime-Sama")
    say("─" * 46)
    api_base, child = resolve_backend(args)

    PanelHandler.api_base = api_base
    PanelHandler.api_timeout = args.timeout
    PanelHandler.quiet = not args.verbose

    # $PORT défini et non contredit par --port : la plateforme impose ce port.
    imposed = bool(os.environ.get("PORT")) and args.port == int(os.environ.get("PORT") or 0)
    server, port = bind(args.host, args.port, strict=imposed)
    url = f"http://{args.host}:{port}/"

    say("─" * 46)
    say(f"Panel   : {url}")
    say(f"Backend : {api_base or 'aucun pour le moment (mode démo utilisable)'}")
    say(f"Accès   : {'protégé par mot de passe' if password() else 'libre (aucun mot de passe)'}")
    say("Ctrl+C pour tout arrêter.")
    say()

    if args.auto_index:
        # En tâche de fond : la sonde du catalogue ne doit pas retarder l'écoute,
        # que l'hébergeur surveille via /healthz dès les premières secondes.
        threading.Thread(target=Indexing.start_if_needed, args=(api_base,), daemon=True).start()

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
        process.terminate() if os.name == "nt" else process.send_signal(signal.SIGTERM)
        process.wait(timeout=8)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def pause_if_needed():
    """Double-clic sous Windows : sans cette pause, la fenêtre se referme
    instantanément et le message d'erreur est illisible."""
    if os.name != "nt":
        return
    try:
        input("\nAppuie sur Entrée pour fermer cette fenêtre.")
    except Exception:
        pass


def run():
    """Point d'entrée tolérant : garde la fenêtre ouverte en cas d'erreur, ce qui
    compte quand le script est lancé par un double-clic plutôt qu'un terminal."""
    try:
        main()
    except KeyboardInterrupt:
        pass
    except SystemExit as stop:
        if isinstance(stop.code, str):          # message d'erreur explicite
            say()
            say(stop.code)
            pause_if_needed()
            sys.exit(1)
        raise
    except Exception:
        say()
        traceback.print_exc()
        say("\nErreur inattendue. Copie le message ci-dessus pour signaler le problème.")
        pause_if_needed()
        sys.exit(1)


if __name__ == "__main__":
    run()
