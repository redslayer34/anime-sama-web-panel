"""
Contrôle des dépendances du backend, au moment du build.

Subtilité : `src/backend.py` exécute `BASE_URL = Utils.findLink()` au niveau
module. Importer le backend ouvre donc une connexion vers anime-sama.pw, puis
vers chaque domaine candidat. Un build sur une machine sans accès à ces
domaines échouerait pour une raison étrangère aux dépendances.

On sépare donc les deux cas : un module absent fait échouer le build, une
erreur réseau non.
"""
import importlib
import os
import sys

# Le script vit à côté du panel mais s'exécute depuis le dossier du backend :
# sans ça, sys.path pointe sur le dossier du script et le paquet `src` reste
# introuvable.
sys.path.insert(0, os.getcwd())

REQUIRED = ("flask", "cloudscraper", "requests", "bs4", "lxml", "rapidfuzz")

missing = []
for name in REQUIRED:
    try:
        importlib.import_module(name)
    except ImportError:
        missing.append(name)

if missing:
    sys.exit("Dépendances absentes : " + ", ".join(missing))
print("Dépendances du backend : OK")

try:
    importlib.import_module("src.api")
    print("Backend importable, domaine Anime-Sama résolu.")
except ModuleNotFoundError as err:
    if err.name == "src":
        sys.exit(f"Paquet `src` introuvable : lance ce script depuis le dossier "
                 f"du backend (dossier courant : {os.getcwd()}).")
    sys.exit(f"Module manquant à l'import du backend : {err.name}")
except Exception as err:
    print(f"Import interrompu avant la fin ({type(err).__name__}) : "
          "réseau indisponible au build, sans conséquence sur l'image.")
