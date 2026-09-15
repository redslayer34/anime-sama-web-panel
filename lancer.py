#!/usr/bin/env python3
"""
Double-clique ce fichier pour lancer le panel Anime-Sama.

Utile quand les fichiers .bat sont bloqués par une stratégie de sécurité :
Windows associe les .py à Python, donc le double-clic fonctionne quand même.
Strictement équivalent à `python serve.py`.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import serve
except ImportError:
    sys.exit("serve.py est introuvable : garde lancer.py dans le même dossier que serve.py.")

serve.run()
