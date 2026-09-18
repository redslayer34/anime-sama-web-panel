"""
Rend parallèle la résolution des épisodes d'AnimeSamaApi, et ajoute un mode
« épisode prioritaire » pour le chargement intelligent du panel.

Pourquoi (parallélisation) : `Cardinal.getAnimeLink` résout les épisodes **l'un
après l'autre**, et chaque épisode coûte une à trois requêtes HTTP de 3 à 10
secondes chez les hébergeurs vidéo. Une saison de 25 épisodes demande donc
plusieurs minutes sur une petite instance, ce qui dépasse la patience de
n'importe quel navigateur. Les épisodes étant indépendants, un pool de threads
divise ce temps d'autant.

Pourquoi (épisode prioritaire) : même parallélisée, une saison entière reste
lente à charger avant que le premier épisode soit jouable. Le calcul du
*nombre* d'épisodes, lui, ne coûte que deux requêtes bon marché (page de
saison + fichier JS listant les liens bruts) — aucune résolution vidéo. Le
panel peut donc afficher tous les boutons d'épisodes tout de suite, puis ne
résoudre que celui choisi (`&e=N`) en quelques secondes, pendant que le reste
de la saison continue en tâche de fond via l'appel habituel (sans `e`).

Le patch est appliqué au moment du `docker build`, sur le commit d'AnimeSamaApi
épinglé dans le Dockerfile. Chaque ancre doit se trouver **exactement une fois** :
sinon le script échoue et le build s'arrête, plutôt que de produire une image à
moitié modifiée.

Usage : python speedup_patch.py /chemin/vers/AnimeSamaApi
"""
import ast
import io
import sys
from pathlib import Path

WORKERS_DEFAULT = "8"


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"Patch impossible ({label}) : l'ancre apparaît {count} fois au lieu d'une.\n"
            "Le code amont a probablement changé ; vérifie le commit épinglé "
            "dans le Dockerfile."
        )
    return text.replace(old, new, 1)


# ─────────────────────────────────────────────
#  resolvers.py : une session HTTP par thread
# ─────────────────────────────────────────────
RESOLVERS_OLD = '''# --- Configuration & Headers ---
scraper = cloudscraper.create_scraper()
'''

RESOLVERS_NEW = '''# --- Configuration & Headers ---
import threading as _panel_threading


class _PanelThreadScraper:
    """Un scraper par thread, derrière l'interface d'un scraper unique.

    Les résolveurs partageaient une seule session cloudscraper. Dès qu'ils sont
    appelés en parallèle, son état — cookies, résolution du défi Cloudflare —
    subirait des mutations concurrentes. Cette façade délègue chaque attribut à
    la session du thread courant, sans toucher aux appels existants."""

    _local = _panel_threading.local()

    def _session(self):
        session = getattr(self._local, "session", None)
        if session is None:
            session = self._local.session = cloudscraper.create_scraper()
        return session

    def __getattr__(self, name):
        return getattr(self._session(), name)


scraper = _PanelThreadScraper()
'''


# ─────────────────────────────────────────────
#  backend.py : en-tête (pool + scraper par thread)
# ─────────────────────────────────────────────
BACKEND_HEADER_OLD = '''PATH = os.path.dirname(os.path.abspath(__file__))
'''

BACKEND_HEADER_NEW = '''# ── Patch du panel Anime-Sama : résolution parallèle des épisodes ──
import threading as _panel_threading
from concurrent.futures import ThreadPoolExecutor as _PanelPool

# Nombre de résolutions simultanées. Au-delà d'une poignée, les hébergeurs
# vidéo commencent à limiter les requêtes venant d'une même adresse.
try:
    _PANEL_WORKERS = max(1, int(os.environ.get("PANEL_RESOLVER_WORKERS", "%s")))
except ValueError:
    _PANEL_WORKERS = %s

# (connexion, lecture) : borne les requêtes du préambule, qui n'en avaient
# aucune. Large exprès — il s'agit d'éviter un blocage, pas de couper court.
_PANEL_TIMEOUT = (10, 30)

_panel_local = _panel_threading.local()


def _panel_scraper():
    """Session HTTP propre au thread courant (voir resolvers.py)."""
    session = getattr(_panel_local, "scraper", None)
    if session is None:
        session = _panel_local.scraper = cloudscraper.create_scraper()
    return session


PATH = os.path.dirname(os.path.abspath(__file__))
''' % (WORKERS_DEFAULT, WORKERS_DEFAULT)


# ─────────────────────────────────────────────
#  backend.py : is_stream_playable sans session partagée
# ─────────────────────────────────────────────
# La vérification « ce flux répond-il ? » était la principale dépense
# évitable : une tentative vouée à l'échec avant la bonne, et une
# connexion jamais rendue au pool. Le booléen produit est inchangé.
PLAYABLE_OLD = '''            # Test direct sans Referer spécifique (mode standard de yt-dlp)
            standard_headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
                "Accept": "*/*"
            }
            try:
                r = scraper.get(test_link, headers=standard_headers, timeout=3, stream=True)
                if r.status_code in (200, 206):
                    return True
            except Exception:
                pass

            # Si échec, tester avec Referer du domaine
            parsed = urlparse(test_link)
            domain = parsed.netloc.lower()
            try:
                r = scraper.get(test_link, headers={**standard_headers, "Referer": f"{parsed.scheme}://{domain}/"}, timeout=3, stream=True)
                if r.status_code in (200, 206):
                    return True
            except Exception:
                pass

            return False
'''

PLAYABLE_NEW = '''            standard_headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
                "Accept": "*/*"
            }
            parsed = urlparse(test_link)
            domain = parsed.netloc.lower()

            # Deux tentatives dont le résultat est un OU logique : leur ordre
            # ne change donc aucune réponse. On commence par celle qui porte
            # le Referer, parce que les hébergeurs qui l'exigent — sibnet en
            # tête, et c'est le lecteur prioritaire — rejettent l'autre
            # systématiquement. Elle coûtait jusqu'à trois secondes d'attente
            # avant même d'essayer la bonne.
            for headers in (
                {**standard_headers, "Referer": f"{parsed.scheme}://{domain}/"},
                standard_headers,
            ):
                try:
                    r = _panel_scraper().get(test_link, headers=headers, timeout=3, stream=True)
                except Exception:
                    continue
                try:
                    if r.status_code in (200, 206):
                        return True
                finally:
                    # Le corps n'est jamais lu (stream=True) : sans fermeture
                    # explicite, urllib3 ne peut pas remettre la connexion au
                    # pool et chaque vérification repayait un handshake TLS.
                    r.close()

            return False
'''


# ─────────────────────────────────────────────
#  backend.py : préambule — session partagée et délais bornés
# ─────────────────────────────────────────────
# Trois requêtes précèdent toute résolution, et aucune n'avait de délai
# maximal : un hébergeur qui ne répond jamais immobilisait le worker
# indéfiniment. Elles créaient en plus deux sessions par appel, chacune
# reparsant un mégaoctet de données d'empreinte navigateur.
PREAMBLE_INFO_OLD = '''        scraper = cloudscraper.create_scraper()  # équivaut à un navigateur
        reponse = scraper.get(base_url)
'''

PREAMBLE_INFO_NEW = '''        scraper = _panel_scraper()  # équivaut à un navigateur, une par thread
        reponse = scraper.get(base_url, timeout=_PANEL_TIMEOUT)
'''

PREAMBLE_SEASON_OLD = '''        scraper = cloudscraper.create_scraper()
        second = scraper.get(link)
'''

PREAMBLE_SEASON_NEW = '''        scraper = _panel_scraper()
        second = scraper.get(link, timeout=_PANEL_TIMEOUT)
'''

PREAMBLE_JS_OLD = '''        js_text = scraper.get(jsfile).text
'''

PREAMBLE_JS_NEW = '''        js_text = scraper.get(jsfile, timeout=_PANEL_TIMEOUT).text
'''


# ─────────────────────────────────────────────
#  backend.py : signature — épisode prioritaire optionnel
# ─────────────────────────────────────────────
SIGNATURE_OLD = '''    def getAnimeLink(nom, saison=None, version=None): # Recupère les différents liens disponibles afin de retourner une playlist complète et prête à être téléchargée
'''

SIGNATURE_NEW = '''    def getAnimeLink(nom, saison=None, version=None, episode=None): # Recupère les différents liens disponibles afin de retourner une playlist complète et prête à être téléchargée
'''


# ─────────────────────────────────────────────
#  backend.py : la boucle séquentielle devient un pool
# ─────────────────────────────────────────────
LOOP_OLD = '''        # Résolution épisode par épisode
        for episode in range(nombre_episodes):
            best_link = None

            for lecteur in valid_lecteurs:
                eps_list = all_eps[lecteur]
                if episode >= len(eps_list):
                    continue

                url_to_test = eps_list[episode].strip(" \\t\\n\\r\\xa0")
                if not url_to_test:
                    continue

                is_sibnet = "sibnet.ru" in url_to_test.lower()

                # Tentative de résolution directe en .m3u8 ou .mp4
                try:
                    resolved = resolve_video_url(url_to_test)
                except Exception:
                    resolved = None

                if resolved and isinstance(resolved, dict):
                    resolved_url = resolved.get("url")
                    resolved_type = resolved.get("type")

                    if resolved_type in ("m3u8", "mp4") and resolved_url:
                        if is_stream_playable(resolved_url):
                            best_link = resolved_url
                            break

                    elif resolved_type == "embed" and resolved_url:
                        if is_stream_playable(resolved_url):
                            best_link = resolved_url
                            break

                if is_sibnet and not best_link:
                    if is_stream_playable(url_to_test):
                        best_link = url_to_test
                        break

            if best_link:
                good_link.append({
                    "episode": episode,
                    "url": best_link
                })

        return good_link'''

LOOP_NEW = '''        # Résolution des épisodes en parallèle (patch du panel Anime-Sama).
        # Le corps de la boucle d'origine est repris tel quel : les `break` qui
        # retenaient le premier lecteur exploitable deviennent des `return`.
        def _panel_resolve(episode):
            for lecteur in valid_lecteurs:
                eps_list = all_eps[lecteur]
                if episode >= len(eps_list):
                    continue

                url_to_test = eps_list[episode].strip(" \\t\\n\\r\\xa0")
                if not url_to_test:
                    continue

                is_sibnet = "sibnet.ru" in url_to_test.lower()

                # Tentative de résolution directe en .m3u8 ou .mp4
                try:
                    resolved = resolve_video_url(url_to_test)
                except Exception:
                    resolved = None

                if resolved and isinstance(resolved, dict):
                    resolved_url = resolved.get("url")
                    resolved_type = resolved.get("type")

                    if resolved_type in ("m3u8", "mp4") and resolved_url:
                        if is_stream_playable(resolved_url):
                            return resolved_url

                    elif resolved_type == "embed" and resolved_url:
                        if is_stream_playable(resolved_url):
                            return resolved_url

                # `not best_link` était toujours vrai ici : la boucle s'arrêtait
                # dès qu'un lien était trouvé.
                if is_sibnet:
                    if is_stream_playable(url_to_test):
                        return url_to_test

            return None

        # Chargement intelligent du panel : un seul épisode demandé (&e=N côté
        # API), résolu seul en quelques secondes au lieu d'attendre toute la
        # saison. `nombre_episodes` est déjà connu à ce stade (scraping léger,
        # sans résolution vidéo) : le panel peut donc dessiner tous les boutons
        # d'épisodes avant même que celui-ci ait fini de se résoudre.
        if episode is not None:
            link = _panel_resolve(episode) if 0 <= episode < nombre_episodes else None
            return {
                "count": nombre_episodes,
                "results": [{"episode": episode, "url": link}] if link else [],
            }

        if nombre_episodes > 0:
            with _PanelPool(max_workers=min(_PANEL_WORKERS, nombre_episodes)) as pool:
                # `map` conserve l'ordre des entrées : la numérotation des
                # épisodes reste celle de la version séquentielle.
                resolved_links = list(pool.map(_panel_resolve, range(nombre_episodes)))
        else:
            resolved_links = []

        for episode, best_link in enumerate(resolved_links):
            if best_link:
                good_link.append({
                    "episode": episode,
                    "url": best_link
                })

        return good_link'''


# ─────────────────────────────────────────────
#  api.py : la route lit et transmet le paramètre « e »
# ─────────────────────────────────────────────
API_ROUTE_OLD = '''    def getAnimeLink():
        nom = request.args.get("n", "").strip()
        saison = request.args.get("s", "").strip() # saison1 par défaut
        version = request.args.get("v", "").strip() # version sera en vostfr par défaut

        if not nom:
            return jsonify({"error": "Paramètre \'n\' manquant"}), 400
        
        return jsonify(Cardinal.getAnimeLink(nom, saison, version))'''

API_ROUTE_NEW = '''    def getAnimeLink():
        nom = request.args.get("n", "").strip()
        saison = request.args.get("s", "").strip() # saison1 par défaut
        version = request.args.get("v", "").strip() # version sera en vostfr par défaut
        # Patch du panel Anime-Sama : épisode prioritaire (chargement intelligent).
        # Un « e » absent ou non numérique laisse le comportement d'origine.
        episode_arg = request.args.get("e", "").strip()
        episode = int(episode_arg) if episode_arg.isdigit() else None

        if not nom:
            return jsonify({"error": "Paramètre \'n\' manquant"}), 400
        
        return jsonify(Cardinal.getAnimeLink(nom, saison, version, episode))'''


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage : python speedup_patch.py /chemin/vers/AnimeSamaApi")
    root = Path(sys.argv[1]).resolve()

    resolvers = root / "src" / "utils" / "resolvers.py"
    backend = root / "src" / "backend.py"
    api = root / "src" / "api.py"
    for path in (resolvers, backend, api):
        if not path.is_file():
            raise SystemExit(f"Fichier introuvable : {path}")

    text = io.open(resolvers, encoding="utf-8").read()
    text = replace_once(text, RESOLVERS_OLD, RESOLVERS_NEW, "resolvers.py / session partagée")
    ast.parse(text)
    io.open(resolvers, "w", encoding="utf-8").write(text)

    text = io.open(backend, encoding="utf-8").read()
    text = replace_once(text, BACKEND_HEADER_OLD, BACKEND_HEADER_NEW, "backend.py / en-tête")
    text = replace_once(text, PLAYABLE_OLD, PLAYABLE_NEW, "backend.py / is_stream_playable")
    text = replace_once(text, PREAMBLE_INFO_OLD, PREAMBLE_INFO_NEW, "backend.py / préambule getInfoAnime")
    text = replace_once(text, PREAMBLE_SEASON_OLD, PREAMBLE_SEASON_NEW, "backend.py / préambule saison")
    text = replace_once(text, PREAMBLE_JS_OLD, PREAMBLE_JS_NEW, "backend.py / préambule episodes.js")
    text = replace_once(text, SIGNATURE_OLD, SIGNATURE_NEW, "backend.py / signature getAnimeLink")
    text = replace_once(text, LOOP_OLD, LOOP_NEW, "backend.py / boucle de résolution")
    ast.parse(text)
    io.open(backend, "w", encoding="utf-8").write(text)

    text = io.open(api, encoding="utf-8").read()
    text = replace_once(text, API_ROUTE_OLD, API_ROUTE_NEW, "api.py / route getAnimeLink")
    ast.parse(text)
    io.open(api, "w", encoding="utf-8").write(text)

    print(f"Résolution parallélisée ({WORKERS_DEFAULT} threads par défaut, "
          "réglable avec PANEL_RESOLVER_WORKERS) ; épisode prioritaire disponible (&e=N).")


if __name__ == "__main__":
    main()
