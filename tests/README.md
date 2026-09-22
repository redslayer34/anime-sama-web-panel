# Tests du panel

```bash
python3 tests/run.py            # toute la campagne
python3 tests/run.py --unit     # seulement les tests Python
python3 tests/run.py --list     # lister les suites
```

Les tests Python ne demandent que la bibliothèque standard. Les tests navigateur
ont besoin de Node et de Playwright :

```bash
npm install playwright && npx playwright install chromium
```

Sans eux, `run.py` le signale et exécute quand même les tests Python.

Chaque suite démarre ses propres doublures de backend sur des ports dédiés, puis
les arrête. **Aucun test ne contacte Anime-Sama** : tout est simulé en local.

## Les suites

| Suite | Ce qu'elle protège |
|---|---|
| `unit/test_stream.py` | Filtre anti-rebond du relais, réécriture des playlists HLS, requêtes `Range`. |
| `unit/test_parallel_equivalence.py` | La résolution parallèle des épisodes, *et* le chemin « épisode prioritaire », rendent exactement le même résultat que la boucle séquentielle d'origine. |
| `unit/test_playable_check.py` | La vérification « ce flux répond-il ? » réécrite (Referer d'abord, réponses refermées) rend le même booléen que l'originale dans tous les cas. |
| `unit/test_config_consistency.py` | `Dockerfile`, `render.yaml` et README n'écrasent ni ne contredisent le nombre de threads par défaut (`WORKERS_DEFAULT`) ; chaque module de `js/` est préchargé par `index.html` et copié dans l'image. |
| `browser/panel.test.js` | Parcours complet : recherche, catalogue, favoris, lecteur, saisons, historique, modales, scans, thèmes, mode démo, persistance, raccourcis, rendu mobile. |
| `browser/auth.test.js` | Mot de passe : 401 sur `/`, `/api` et `/panel/state`, `/healthz` laissé ouvert, lecture normale une fois authentifié. |
| `browser/jobs.test.js` | Tâches de fond : réponse immédiate, suivi de progression, cache partagé, backend sollicité une seule fois. |
| `browser/indexing.test.js` | Bannière d'indexation, de son apparition au rechargement automatique du catalogue. |
| `browser/relay.test.js` | Bascule vers le relais vidéo et respect des trois réglages. |
| `browser/smart-loading.test.js` | Chargement intelligent : boutons numérotés avant résolution complète, épisode ciblé jouable en quelques secondes, clic sur un épisode non résolu, fusion en arrière-plan du reste de la saison. |
| `browser/smart-loading-degraded.test.js` | Dégradation propre face à un backend qui ignore `&e=` (non patché) : tout s'affiche comme avant, sans bouton « non résolu » ni erreur. |
| `browser/episode-cache.test.js` | Cache navigateur des épisodes résolus : série rouverte et lecture sans aucune requête de résolution, rechargement manuel qui repasse par le réseau. |

## Détails utiles

**Doublures** (`mocks/`) — elles reproduisent volontairement les pièges du vrai
backend : épisodes numérotés à partir de 0, version absente d'une saison,
sources mêlant fichiers directs et pages de lecteur, hébergeur refusant les
requêtes sans `Referer`, catalogue vide au démarrage, `getAnimeLink` lent.
`api_smart.py` simule spécifiquement le chargement intelligent : un épisode
ciblé (`&e=N`) répond en 0,3 s, la saison entière en 4 s — l'écart rend le
bénéfice mesurable dans le test. `MOCK_UNPATCHED=1` fait ignorer `&e=` par ce
même mock, pour tester la dégradation sans backend patché.

**`unit/test_stream.py` neutralise `stream_target`** pour sa partie « bout en
bout » : le faux hébergeur écoute sur une adresse privée, que le filtre de
production refuse à juste titre. Le filtre lui-même est testé juste avant, sur
huit cas dont le backend interne et les métadonnées cloud.

**Variables d'environnement** — `CHROMIUM_PATH` pointe un Chromium déjà
installé ailleurs que dans le cache de Playwright ; `PANEL_URL`, `API_URL` et
`SHOTS_DIR` permettent de viser des serveurs déjà lancés.

**Captures d'écran** — les suites navigateur en déposent dans
`tests/screenshots/`, ignoré par Git. Pratique pour constater une régression
visuelle.
