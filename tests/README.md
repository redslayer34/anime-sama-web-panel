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
| `unit/test_parallel_equivalence.py` | La résolution parallèle des épisodes rend exactement le même résultat que la boucle séquentielle d'origine. |
| `browser/panel.test.js` | Parcours complet : recherche, catalogue, favoris, lecteur, saisons, historique, modales, scans, thèmes, mode démo, persistance, raccourcis, rendu mobile. |
| `browser/auth.test.js` | Mot de passe : 401 sur `/`, `/api` et `/panel/state`, `/healthz` laissé ouvert, lecture normale une fois authentifié. |
| `browser/jobs.test.js` | Tâches de fond : réponse immédiate, suivi de progression, cache partagé, backend sollicité une seule fois. |
| `browser/indexing.test.js` | Bannière d'indexation, de son apparition au rechargement automatique du catalogue. |
| `browser/relay.test.js` | Bascule vers le relais vidéo et respect des trois réglages. |

## Détails utiles

**Doublures** (`mocks/`) — elles reproduisent volontairement les pièges du vrai
backend : épisodes numérotés à partir de 0, version absente d'une saison,
sources mêlant fichiers directs et pages de lecteur, hébergeur refusant les
requêtes sans `Referer`, catalogue vide au démarrage, `getAnimeLink` lent.

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
