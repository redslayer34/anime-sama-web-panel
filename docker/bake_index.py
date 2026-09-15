"""
Construit le catalogue pendant le `docker build`, pour qu'un conteneur neuf
dispose des données immédiatement.

Sur un hébergement gratuit, le disque est effacé à chaque redémarrage : sans
cette étape, chaque réveil imposerait 3 à 5 minutes d'indexation avant la
première recherche. L'échec ici n'est pas fatal — le serveur réindexe alors en
tâche de fond au démarrage, avec une bannière dans le panel.
"""
import json
import subprocess
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:5000"
DIRECTORY = "/app/AnimeSamaApi"


def answers(timeout=2):
    try:
        with urllib.request.urlopen(f"{BASE}/?q=bake", timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def catalogue_size():
    try:
        with urllib.request.urlopen(f"{BASE}/api/loadBaseAnimeData", timeout=60) as response:
            data = json.loads(response.read() or b"null")
        return len(data) if isinstance(data, list) else 0
    except Exception:
        return 0


def main():
    process = subprocess.Popen([sys.executable, "api_entry.py"], cwd=DIRECTORY)
    try:
        deadline = time.time() + 60
        while time.time() < deadline and not answers():
            if process.poll() is not None:
                print("Le backend s'est arrêté avant de répondre.", flush=True)
                return 1
            time.sleep(1)
        if not answers():
            print("Le backend n'a pas répondu en 60 s.", flush=True)
            return 1

        print("Indexation du catalogue…", flush=True)
        with urllib.request.urlopen(f"{BASE}/api/getAllAnime?r=True", timeout=1500):
            pass
        size = catalogue_size()
        print(f"Catalogue cuit dans l'image : {size} fiches.", flush=True)
        return 0 if size else 1
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except Exception:
            process.kill()


if __name__ == "__main__":
    sys.exit(main())
