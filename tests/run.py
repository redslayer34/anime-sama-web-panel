#!/usr/bin/env python3
"""
Lance toute la campagne de tests du panel.

    python3 tests/run.py              # tout ce qui est disponible
    python3 tests/run.py --unit       # seulement les tests Python
    python3 tests/run.py --list       # liste les suites sans rien exécuter

Les tests Python n'ont besoin que de la bibliothèque standard. Les tests
navigateur demandent Node et Playwright :

    npm install playwright && npx playwright install chromium

Chaque suite démarre ses propres doublures de backend, sur des ports dédiés,
et les arrête ensuite. Rien ne touche à un vrai serveur Anime-Sama.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
sys.path.insert(0, str(TESTS))
from lib.ports import free                                    # noqa: E402

PORTS = {
    "api": 5000, "static": 8080, "auth": 8405,
    "jobs": 8501, "indexing": 8403, "relay": 8602, "video": 9100,
    "smart": 8603, "smart_degraded": 8604, "cache": 8605,
}
SHOTS = TESTS / "screenshots"
PASSWORD = "mot-de-passe-test"


def wait_for(url, timeout=25):
    """Attend qu'un serveur réponde, quel que soit son code HTTP.

    Une erreur HTTP prouve que le serveur écoute : le faux hébergeur répond
    volontairement 403 sans Referer, et l'attendre comme un échec ferait perdre
    le délai entier à chaque suite."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            time.sleep(0.3)
    return False


class Stack:
    """Ensemble de processus démarrés pour une suite, arrêtés ensemble."""

    def __init__(self):
        self.processes = []

    def start(self, args, cwd=None, env=None):
        merged = {**os.environ, **(env or {})}
        self.processes.append(subprocess.Popen(
            args, cwd=str(cwd or ROOT), env=merged,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

    def mock(self, name, port, *extra):
        self.start([sys.executable, str(TESTS / "mocks" / name), str(port), *extra])

    def panel(self, port, env=None):
        self.start([sys.executable, str(ROOT / "serve.py"), "--port", str(port),
                    "--no-open", "--host", "127.0.0.1"], env=env)

    def stop(self):
        for process in self.processes:
            try:
                process.terminate()
                process.wait(timeout=5)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
        self.processes.clear()


def run(command, env=None):
    result = subprocess.run(command, cwd=str(ROOT), env={**os.environ, **(env or {})})
    return result.returncode == 0


# ─────────────────────────────────────────────
#  Suites
# ─────────────────────────────────────────────
def unit_stream():
    stack = Stack()
    try:
        free(PORTS["video"])
        stack.mock("video_host.py", PORTS["video"])
        wait_for(f"http://127.0.0.1:{PORTS['video']}/x")       # 403 suffit : il répond
        return run([sys.executable, str(TESTS / "unit" / "test_stream.py")],
                   {"VIDEO_HOST": f"http://127.0.0.1:{PORTS['video']}"})
    finally:
        stack.stop()


def unit_equivalence():
    return run([sys.executable, str(TESTS / "unit" / "test_parallel_equivalence.py")])


def unit_playable():
    return run([sys.executable, str(TESTS / "unit" / "test_playable_check.py")])


def unit_config():
    return run([sys.executable, str(TESTS / "unit" / "test_config_consistency.py")])


def browser_panel():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["static"])
        stack.mock("api.py", PORTS["api"])
        stack.start([sys.executable, "-m", "http.server", str(PORTS["static"]),
                     "--bind", "127.0.0.1"])
        if not wait_for(f"http://127.0.0.1:{PORTS['static']}/index.html"):
            print("  le serveur statique n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "panel.test.js")], {
            "PANEL_URL": f"http://127.0.0.1:{PORTS['static']}",
            "API_URL": f"http://127.0.0.1:{PORTS['api']}",
        })
    finally:
        stack.stop()


def browser_auth():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["auth"])
        stack.mock("api.py", PORTS["api"])
        wait_for(f"http://127.0.0.1:{PORTS['api']}/?q=x")
        stack.panel(PORTS["auth"], {"PANEL_PASSWORD": PASSWORD})
        if not wait_for(f"http://127.0.0.1:{PORTS['auth']}/healthz"):
            print("  le panel n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "auth.test.js")], {
            "PANEL_URL": f"http://127.0.0.1:{PORTS['auth']}", "PANEL_PASSWORD": PASSWORD,
        })
    finally:
        stack.stop()


def browser_jobs():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["jobs"])
        stack.mock("api_slow.py", PORTS["api"])
        wait_for(f"http://127.0.0.1:{PORTS['api']}/?q=x")
        stack.panel(PORTS["jobs"])
        if not wait_for(f"http://127.0.0.1:{PORTS['jobs']}/healthz"):
            print("  le panel n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "jobs.test.js")],
                   {"PANEL_URL": f"http://127.0.0.1:{PORTS['jobs']}"})
    finally:
        stack.stop()


def browser_indexing():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["indexing"])
        stack.mock("api_empty.py", PORTS["api"])
        wait_for(f"http://127.0.0.1:{PORTS['api']}/?q=x")
        stack.panel(PORTS["indexing"], {"PANEL_AUTO_INDEX": "1"})
        if not wait_for(f"http://127.0.0.1:{PORTS['indexing']}/healthz"):
            print("  le panel n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "indexing.test.js")],
                   {"PANEL_URL": f"http://127.0.0.1:{PORTS['indexing']}"})
    finally:
        stack.stop()


def browser_relay():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["relay"], PORTS["video"])
        stack.mock("video_host.py", PORTS["video"])
        stack.mock("api_media.py", PORTS["api"], f"127.0.0.1:{PORTS['video']}")
        wait_for(f"http://127.0.0.1:{PORTS['api']}/")
        stack.panel(PORTS["relay"])
        if not wait_for(f"http://127.0.0.1:{PORTS['relay']}/healthz"):
            print("  le panel n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "relay.test.js")],
                   {"PANEL_URL": f"http://127.0.0.1:{PORTS['relay']}"})
    finally:
        stack.stop()


def browser_smart_loading():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["smart"])
        stack.mock("api_smart.py", PORTS["api"])
        wait_for(f"http://127.0.0.1:{PORTS['api']}/")
        stack.panel(PORTS["smart"])
        if not wait_for(f"http://127.0.0.1:{PORTS['smart']}/healthz"):
            print("  le panel n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "smart-loading.test.js")],
                   {"PANEL_URL": f"http://127.0.0.1:{PORTS['smart']}"})
    finally:
        stack.stop()


def browser_episode_cache():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["cache"])
        stack.mock("api_smart.py", PORTS["api"])
        wait_for(f"http://127.0.0.1:{PORTS['api']}/")
        stack.panel(PORTS["cache"])
        if not wait_for(f"http://127.0.0.1:{PORTS['cache']}/healthz"):
            print("  le panel n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "episode-cache.test.js")],
                   {"PANEL_URL": f"http://127.0.0.1:{PORTS['cache']}"})
    finally:
        stack.stop()


def browser_smart_loading_degraded():
    stack = Stack()
    try:
        free(PORTS["api"], PORTS["smart_degraded"])
        stack.start([sys.executable, str(TESTS / "mocks" / "api_smart.py"), str(PORTS["api"])],
                    env={"MOCK_UNPATCHED": "1"})
        wait_for(f"http://127.0.0.1:{PORTS['api']}/")
        stack.panel(PORTS["smart_degraded"])
        if not wait_for(f"http://127.0.0.1:{PORTS['smart_degraded']}/healthz"):
            print("  le panel n'a pas démarré"); return False
        return run(["node", str(TESTS / "browser" / "smart-loading-degraded.test.js")],
                   {"PANEL_URL": f"http://127.0.0.1:{PORTS['smart_degraded']}"})
    finally:
        stack.stop()


UNIT = [
    ("Relais de flux (filtre, playlists, Range)", unit_stream),
    ("Équivalence de la résolution parallèle", unit_equivalence),
    ("Vérification de lecture : réécriture équivalente", unit_playable),
    ("Cohérence de la configuration", unit_config),
]
BROWSER = [
    ("Panel complet", browser_panel),
    ("Accès protégé par mot de passe", browser_auth),
    ("Tâches de fond et cache", browser_jobs),
    ("Bannière d'indexation", browser_indexing),
    ("Bascule vers le relais vidéo", browser_relay),
    ("Chargement intelligent (épisode prioritaire)", browser_smart_loading),
    ("Chargement intelligent : dégradation sans patch", browser_smart_loading_degraded),
    ("Cache persistant des épisodes", browser_episode_cache),
]


def playwright_ready():
    if not shutil.which("node"):
        return False, "Node n'est pas installé"
    probe = subprocess.run(["node", "-e", "require('playwright')"], cwd=str(ROOT),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode != 0:
        return False, "Playwright n'est pas installé (npm install playwright)"
    return True, ""


def main():
    parser = argparse.ArgumentParser(description="Campagne de tests du panel Anime-Sama.")
    parser.add_argument("--unit", action="store_true", help="seulement les tests Python")
    parser.add_argument("--list", action="store_true", help="lister les suites")
    args = parser.parse_args()

    suites = list(UNIT)
    if args.list:
        for name, _ in UNIT + BROWSER:
            print(" -", name)
        return 0

    if not args.unit:
        ready, reason = playwright_ready()
        if ready:
            SHOTS.mkdir(parents=True, exist_ok=True)
            suites += BROWSER
        else:
            print(f"Tests navigateur ignorés : {reason}.\n")

    results = []
    for name, runner in suites:
        print(f"\n═══ {name} " + "═" * max(0, 52 - len(name)))
        try:
            ok = runner()
        except Exception as err:                       # une suite ne doit pas tout arrêter
            print(f"  la suite a levé une exception : {err}")
            ok = False
        results.append((name, ok))

    print("\n" + "═" * 60)
    for name, ok in results:
        print(f"  {'RÉUSSI ' if ok else 'ÉCHOUÉ '} {name}")
    failed = [n for n, ok in results if not ok]
    print("═" * 60)
    print(f"{len(results) - len(failed)}/{len(results)} suites réussies.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
