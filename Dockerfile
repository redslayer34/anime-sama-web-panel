# Panel Anime-Sama + backend AnimeSamaApi dans une seule image.
# Une seule origine : le panel est servi et /api relayé par serve.py, donc ni
# CORS ni contenu mixte à gérer côté navigateur.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Commit épinglé : une évolution amont ne casse pas un déploiement qui marche.
# Pour suivre la dernière version : --build-arg ANIMESAMAAPI_REF=main
ARG ANIMESAMAAPI_REF=7c060d8a54b59fcf9e254c5f47919a23420cd9b5
RUN git clone --quiet https://github.com/TMCooper/AnimeSamaApi /app/AnimeSamaApi \
 && git -C /app/AnimeSamaApi checkout --quiet "${ANIMESAMAAPI_REF}" \
 && rm -rf /app/AnimeSamaApi/.git

# requirements.txt du dépôt amont est un `pip freeze` de 47 paquets, dont
# certains sont inutiles ici et d'autres ininstallables (pycparser==3.0). On
# installe donc ce que les sources importent réellement : flask, cloudscraper,
# requests, bs4 et rapidfuzz. lxml sert de parseur à BeautifulSoup.
RUN pip install --no-cache-dir \
      "flask>=3,<4" \
      "cloudscraper>=1.2.71,<2" \
      "requests>=2.31,<3" \
      "beautifulsoup4>=4.12,<5" \
      "lxml>=5,<7" \
      "rapidfuzz>=3.6,<4"

COPY docker/api_entry.py /app/AnimeSamaApi/api_entry.py
COPY docker/bake_index.py docker/check_deps.py docker/speedup_patch.py /app/

# AnimeSamaApi résout les épisodes un par un, à raison d'une à trois requêtes
# HTTP de 3 à 10 s chacune : une saison de 25 épisodes prend plusieurs minutes.
# Ce patch les résout en parallèle. Il échoue bruyamment si le code amont a
# changé, plutôt que de produire une image à moitié modifiée.
RUN python /app/speedup_patch.py /app/AnimeSamaApi

# Contrôle d'intégrité : un module absent fait échouer le build ici, en le
# nommant, plutôt qu'au démarrage du conteneur chez l'hébergeur. Une simple
# indisponibilité réseau, elle, ne casse pas le build — voir check_deps.py.
RUN cd /app/AnimeSamaApi && python /app/check_deps.py

# Indexation cuite dans l'image, au mieux. Un échec (réseau filtré, Cloudflare)
# n'interrompt pas le build : le serveur réindexe alors au démarrage.
RUN python /app/bake_index.py || echo "Indexation non effectuée au build ; elle aura lieu au démarrage."

COPY index.html style.css script.js serve.py /app/

ENV PANEL_AUTO_INDEX=1 \
    PANEL_RESOLVER_WORKERS=6 \
    PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz', timeout=4).status==200 else 1)"

CMD ["python", "serve.py", \
     "--host", "0.0.0.0", \
     "--backend", "/app/AnimeSamaApi", \
     "--backend-entry", "api_entry.py", \
     "--no-open"]
