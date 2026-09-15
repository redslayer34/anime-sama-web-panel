"""
Rend parallèle la résolution des épisodes d'AnimeSamaApi.

Pourquoi : `Cardinal.getAnimeLink` résout les épisodes **l'un après l'autre**, et
chaque épisode coûte une à trois requêtes HTTP de 3 à 10 secondes chez les
hébergeurs vidéo. Une saison de 25 épisodes demande donc plusieurs minutes sur
une petite instance, ce qui dépasse la patience de n'importe quel navigateur.
Les épisodes étant indépendants, un pool de threads divise ce temps d'autant.

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

WORKERS_DEFAULT = "6"


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
    _PANEL_WORKERS = 6

_panel_local = _panel_threading.local()


def _panel_scraper():
    """Session HTTP propre au thread courant (voir resolvers.py)."""
    session = getattr(_panel_local, "scraper", None)
    if session is None:
        session = _panel_local.scraper = cloudscraper.create_scraper()
    return session


PATH = os.path.dirname(os.path.abspath(__file__))
''' % WORKERS_DEFAULT


# ─────────────────────────────────────────────
#  backend.py : is_stream_playable sans session partagée
# ─────────────────────────────────────────────
PLAYABLE_OLD_1 = '''                r = scraper.get(test_link, headers=standard_headers, timeout=3, stream=True)'''
PLAYABLE_NEW_1 = '''                r = _panel_scraper().get(test_link, headers=standard_headers, timeout=3, stream=True)'''

PLAYABLE_OLD_2 = '''                r = scraper.get(test_link, headers={**standard_headers, "Referer": f"{parsed.scheme}://{domain}/"}, timeout=3, stream=True)'''
PLAYABLE_NEW_2 = '''                r = _panel_scraper().get(test_link, headers={**standard_headers, "Referer": f"{parsed.scheme}://{domain}/"}, timeout=3, stream=True)'''


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


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage : python speedup_patch.py /chemin/vers/AnimeSamaApi")
    root = Path(sys.argv[1]).resolve()

    resolvers = root / "src" / "utils" / "resolvers.py"
    backend = root / "src" / "backend.py"
    for path in (resolvers, backend):
        if not path.is_file():
            raise SystemExit(f"Fichier introuvable : {path}")

    text = io.open(resolvers, encoding="utf-8").read()
    text = replace_once(text, RESOLVERS_OLD, RESOLVERS_NEW, "resolvers.py / session partagée")
    ast.parse(text)
    io.open(resolvers, "w", encoding="utf-8").write(text)

    text = io.open(backend, encoding="utf-8").read()
    text = replace_once(text, BACKEND_HEADER_OLD, BACKEND_HEADER_NEW, "backend.py / en-tête")
    text = replace_once(text, PLAYABLE_OLD_1, PLAYABLE_NEW_1, "backend.py / is_stream_playable (1)")
    text = replace_once(text, PLAYABLE_OLD_2, PLAYABLE_NEW_2, "backend.py / is_stream_playable (2)")
    text = replace_once(text, LOOP_OLD, LOOP_NEW, "backend.py / boucle de résolution")
    ast.parse(text)
    io.open(backend, "w", encoding="utf-8").write(text)

    print(f"Résolution parallélisée ({WORKERS_DEFAULT} threads par défaut, "
          "réglable avec PANEL_RESOLVER_WORKERS).")


if __name__ == "__main__":
    main()
