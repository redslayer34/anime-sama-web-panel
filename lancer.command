#!/bin/bash
# Double-clique ce fichier pour lancer le panel.
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo
  echo "  Python 3 est introuvable."
  echo "  Installe-le depuis https://www.python.org/downloads/ puis relance ce fichier."
  echo
  read -r -p "Appuie sur Entrée pour fermer."
  exit 1
fi

"$PY" serve.py "$@"
status=$?
if [ $status -ne 0 ]; then
  read -r -p "Le panel s'est arrêté (code $status). Appuie sur Entrée pour fermer."
fi
