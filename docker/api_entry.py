"""
Point d'entrée d'AnimeSamaApi pour un conteneur.

Le main.py du dépôt amont ne convient pas ici :
  - Utils.hashCheck() lance `git fetch` et `git rev-parse`, qui échouent dès
    que le dossier .git n'est plus là ;
  - Utils.gitCheck() appelle input() si git est absent, ce qui lève EOFError
    faute d'entrée standard, puis os._exit(1) ;
  - launch() démarre Flask avec debug=True et le rechargeur automatique.

On instancie donc l'application directement, sans ces vérifications.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.api import Yui  # noqa: E402

if __name__ == "__main__":
    Yui.app.run(
        host=os.environ.get("API_HOST", "127.0.0.1"),
        port=int(os.environ.get("API_PORT", "5000")),
        debug=False,
        use_reloader=False,
        threaded=True,
    )
