# Anime-Sama Web Panel

Panel web en **HTML / CSS / JavaScript vanilla**, sans framework ni build, qui pilote
l'API [AnimeSamaApi de TMCooper](https://github.com/TMCooper/AnimeSamaApi) : recherche
d'animes, lecteur vidéo HLS / MP4 / iframe, favoris, historique, reprise de lecture et
lecteur de scans.

Le panel est un **client** : il n'héberge, ne scrape et ne stocke aucun contenu. Tout ce
qu'il affiche vient du backend que tu fais tourner toi-même.

---

## 1. Démarrage

### En une commande

```bash
python3 serve.py
```

Ou en double-cliquant, selon ton système :

| Système | Fichier à double-cliquer |
|---|---|
| Windows | `lancer.bat` |
| Windows où les `.bat` sont bloqués (PC d'école, d'entreprise) | **`lancer.py`** |
| macOS | `lancer.command` |
| Linux | `lancer.sh` |

`lancer.py` fait exactement la même chose que `lancer.bat` : Windows associe les fichiers
`.py` à Python, donc le double-clic fonctionne même quand les scripts `.bat`, `.cmd` et
`.ps1` sont interdits par une stratégie de sécurité. Sinon, ouvre le dossier dans
l'Explorateur, tape `cmd` dans la barre d'adresse, Entrée, puis :

```
python serve.py
```

Ce lanceur fait tout seul :

1. il cherche un backend AnimeSamaApi déjà en route (ports 5000, 5001, 5002) ;
2. s'il n'en trouve pas, il **le démarre lui-même** si le dossier `AnimeSamaApi` est à
   côté du panel, dans le dossier parent ou dans ton dossier personnel ;
3. il sert le panel et relaie `/api` vers ce backend, sur la même origine — donc aucun
   souci de CORS et **rien à saisir dans les paramètres** ;
4. il ouvre ton navigateur sur la bonne adresse ;
5. `Ctrl+C` arrête le panel *et* le backend qu'il a démarré.

Si aucun backend n'est disponible, le panel démarre quand même : le **mode démo**
(Paramètres → Lecture) fonctionne sans lui. Et si tu lances le backend *après* le panel,
celui-ci le détecte tout seul à la requête suivante — inutile de le redémarrer.

Options si besoin :

```bash
python3 serve.py --port 9000              # autre port (incrémenté s'il est occupé)
python3 serve.py --api http://127.0.0.1:5001   # adresse imposée, sans détection
python3 serve.py --backend ~/AnimeSamaApi      # dossier du backend à démarrer
python3 serve.py --no-open                # ne pas ouvrir le navigateur
```

### Installer le backend (pour les vraies données)

Place-le **à côté du panel** pour que le lanceur le trouve tout seul :

```bash
git clone https://github.com/TMCooper/AnimeSamaApi
cd AnimeSamaApi
pip install -r requirements.txt
```

Inutile de le lancer à la main ensuite : `serve.py` s'en charge.

À la première utilisation, le backend doit indexer le catalogue (~4000 fiches, 3 à
5 minutes). Le panel te le propose automatiquement quand il constate que la base est
vide — accepte, et laisse l'onglet ouvert.

### Et si je préfère tout faire à la main ?

| Méthode | Champ « URL du backend » | Remarque |
|---|---|---|
| `python3 serve.py` | *(vide)* | **Recommandé.** Rien à configurer. |
| `python3 -m http.server 8080` | `http://127.0.0.1:5000` | Le backend doit autoriser le CORS (ci-dessous). |
| Double-clic sur `index.html` | — | `file://` : le navigateur bloque les requêtes. À éviter. |

Pour la méthode manuelle, autorise le CORS côté backend :

```bash
pip install flask-cors
```

```python
from flask_cors import CORS
CORS(app)            # `app` = l'instance Flask d'AnimeSamaApi
```

---

## 2. Mettre le panel en ligne (une seule URL)

Pour y accéder depuis n'importe quel ordinateur, sans rien lancer : le dépôt contient une
image Docker qui embarque **le panel et le backend ensemble**. Une seule origine, donc ni
CORS ni contenu mixte, et le champ « URL du backend » reste vide.

### Déployer sur Render (gratuit, sans carte bancaire)

1. **Fork** ce dépôt sur ton compte GitHub.
2. Sur [render.com](https://render.com), connecte ton compte GitHub, puis
   **New → Blueprint** et choisis le dépôt. Render lit `render.yaml` tout seul.
3. Il demande la valeur de **`PANEL_PASSWORD`** : choisis un mot de passe. C'est la seule
   chose à saisir. L'identifiant est `panel` (modifiable avec la variable `PANEL_USER`).
4. Attends la fin du build, puis ouvre l'URL fournie. Le navigateur demande le mot de
   passe, puis le panel s'affiche.

### Au premier démarrage

Le catalogue est construit pendant le build quand c'est possible. Sinon, le serveur
l'indexe en tâche de fond au démarrage et le panel affiche une bannière
« Indexation du catalogue en cours » : compte 3 à 5 minutes, puis la recherche fonctionne.
Rien à cliquer.

### Vérifier tout de suite si ça marche vraiment

**Paramètres → Tester la connexion.** Deux lignes avec `✔` : c'est bon. Si le test échoue
ou que les épisodes ne se chargent jamais, c'est très probablement Cloudflare (voir
ci-dessous) — inutile de chercher ailleurs.

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `PANEL_PASSWORD` | Mot de passe d'accès. Vide = site ouvert à tous. |
| `PANEL_USER` | Identifiant, `panel` par défaut. |
| `PANEL_AUTO_INDEX` | `1` pour indexer au démarrage si le catalogue est vide. |
| `PANEL_RESOLVER_WORKERS` | Résolutions d'épisodes simultanées (8 par défaut). |
| `PORT` | Fourni par l'hébergeur ; le panel s'y adapte seul. |

### Vitesse de chargement des épisodes

La route `getAnimeLink` d'AnimeSamaApi est de loin la plus lourde : elle résout l'URL
vidéo de **chaque épisode** chez son hébergeur, à raison d'une à trois requêtes HTTP de 3
à 10 secondes. En série, une saison de 25 épisodes demande plusieurs minutes. Trois
mesures s'y attaquent :

- **Résolution parallèle.** L'image applique un patch à AnimeSamaApi qui traite les
  épisodes dans un pool de threads, avec une session HTTP par thread. Comptez un gain d'un
  facteur 5 à 6. Réglable par `PANEL_RESOLVER_WORKERS` (8 par défaut) ; monter plus haut
  expose à un blocage par les hébergeurs vidéo.
- **Aucune requête suspendue.** Le serveur répond immédiatement `202` et travaille en
  tâche de fond ; le panel suit l'avancement et affiche le temps écoulé. Ni le navigateur
  ni le proxy de l'hébergeur ne peuvent plus couper la requête, quelle que soit sa durée.
- **Cache partagé de 6 heures.** Une saison déjà résolue est servie instantanément, à tous
  les visiteurs. Seul le tout premier chargement est long.

Quatrième mesure, côté panel cette fois : le **chargement intelligent** (section 6)
n'attend même plus cette résolution complète pour afficher quelque chose — voir plus bas.

### Lecture des vidéos : le relais

Les hébergeurs vidéo (Sibnet, Vidmoly, SendVid…) n'envoient pas d'en-tête CORS et
vérifient souvent le `Referer`. Un navigateur refuse donc de lire leur flux depuis le
panel, ce qui se traduisait par « le navigateur n'a pas pu lire cette source ».

Le serveur expose une route `/stream` qui relaie le flux : la lecture redevient une
requête de même origine, et le bon `Referer` est ajouté au passage. Les playlists HLS sont
réécrites pour que les segments, les clés de chiffrement et les qualités alternatives
passent aussi par le relais — sans quoi seul le manifeste serait relayé. Les requêtes
`Range` sont transmises, donc l'avance rapide fonctionne.

Réglage dans **Paramètres → Lecture → Relais vidéo** :

| Valeur | Effet |
|---|---|
| **Automatique** (défaut) | Lecture directe d'abord, bascule sur le relais à la première erreur. |
| Toujours | Passe par le relais dès le départ. |
| Jamais | Lecture directe uniquement. |

Deux points à connaître : **tout le trafic vidéo transite alors par ton hébergement** et
consomme sa bande passante — sur une offre gratuite, c'est la ressource qui partira le
plus vite. Et le relais refuse les adresses internes (`127.0.0.1`, réseaux privés,
métadonnées cloud), pour ne pas servir de rebond vers le réseau de l'hébergeur.

### Les deux limites à connaître avant de déployer

**Cloudflare peut bloquer le serveur.** AnimeSamaApi passe par `cloudscraper`, qui
fonctionne bien depuis une connexion domestique mais beaucoup moins depuis un datacenter,
dont les plages d'adresses sont souvent filtrées par défaut. C'est le seul vrai risque
d'échec, et il ne se tranche qu'en essayant. Particularité à connaître : le backend
résout le domaine actif d'Anime-Sama **dès son import**, donc s'il est bloqué il ne
démarre même pas — le panel reste servi, mais les appels API renvoient une erreur claire.

*Si c'est bloqué :* garde le panel en ligne et fais tourner le backend chez toi, exposé en
HTTPS par un [tunnel Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
(`cloudflared tunnel --url http://localhost:5000`). Colle l'URL obtenue dans
Paramètres → URL du backend. Contrainte : ton PC doit être allumé.

**Mise en veille.** Sur l'offre gratuite de Render, le service s'endort après une quinzaine
de minutes sans visite et met environ 50 secondes à se réveiller. Un ping régulier
l'éviterait, mais consommerait la quasi-totalité des 750 heures mensuelles gratuites — à
toi de voir.

---

## 3. Ce qui fonctionne vraiment

### L'interface

Le panel s'ouvre sur un **accueil** : une série mise en avant, puis des rangées
horizontales — *Reprendre la lecture*, *Ma liste*, *Populaires*, *Dans le catalogue*.
Cet accueil est l'état au repos de la vue « Découvrir » : dès qu'une recherche ou le
catalogue remplit la grille, il s'efface au profit des résultats.

Les **jaquettes** viennent du catalogue d'Anime-Sama, qui en fournit une par fiche. Le
panel tente d'abord l'URL directe, bascule sur sa propre route `/img` si l'hébergeur
refuse (protection anti-hotlink, ou CDN filtré par le réseau), et dessine en dernier
recours une affiche dérivée du titre — stable d'une session à l'autre, jamais une image
cassée. Les jaquettes des séries ouvertes ou mises en favori sont mémorisées, pour que
« Ma liste », l'historique et les reprises en profitent aussi.

### Sans backend, immédiatement

- Navigation entre les six vues, thèmes (Sombre / Abysse OLED / Clair), 5 couleurs
  d'accentuation, mode compact, réduction des animations.
- Favoris, historique, progression, réglages : tout est enregistré dans `localStorage`,
  exportable et réimportable en JSON.
- Filtrage instantané, tri, états vides et messages d'erreur.
- **Mode démo** (Paramètres → Lecture) : jeu de données local et vidéos de test libres de
  droits (*Big Buck Bunny*, flux HLS public de Mux) pour vérifier l'interface et le
  lecteur. Aucun contenu d'Anime-Sama n'y est diffusé — c'est un banc d'essai, pas une
  fausse bibliothèque.

### Avec le backend lancé

| Fonction du panel | Route utilisée |
|---|---|
| Recherche floue | `GET /api/getSerchAnime?q=&l=` |
| Catalogue complet hors ligne (mis en cache 24 h) | `GET /api/loadBaseAnimeData` |
| Indexation du catalogue | `GET /api/getAllAnime?r=True` |
| Liste des saisons | `GET /api/getInfoAnime?q=` |
| Liens des épisodes | `GET /api/getAnimeLink?n=&s=&v=` |
| Domaine Anime-Sama actif | `GET /api/getAnimeSamaURL` |
| Chapitres de scans | `GET /api/getScanHashmap?n=` |
| Pages d'un chapitre | `GET /api/getScanLink?n=&c=` |
| Test de connexion | `GET /?q=ping` |

### Ce qui nécessiterait autre chose

Ces fonctions ne sont **pas** implémentées, faute de source de données : le panel ne
prétend pas les fournir.

- **Synopsis, genres, notes** : l'API ne renvoie aucune métadonnée descriptive. Les
  fiches affichent donc l'affiche, le titre, le titre alternatif et le score de
  recherche — rien de plus. Il faudrait brancher une API tierce (AniList,
  Jikan/MyAnimeList) pour aller plus loin.
  *(Les **jaquettes**, elles, existent bel et bien : le catalogue d'Anime-Sama en
  fournit une par fiche, et le panel les affiche depuis la refonte.)*
- **Compte utilisateur, synchronisation multi-appareils** : nécessiterait un serveur avec
  base de données. Ici, chaque navigateur a ses propres données (avec synchronisation
  entre onglets d'un même navigateur).
- **Téléchargement des épisodes** : hors sujet pour un client web.

---

## 4. Structure du projet

```
index.html      Structure sémantique, sprite SVG, modale <dialog>, zone de notifications
styles/         Feuilles chargées dans cet ordre, chacune s'appuyant sur la précédente :
                  tokens.css      couleurs, espacements, rayons, ombres, 3 thèmes, 5 accents
                  base.css        remise à zéro, polices auto-hébergées, accessibilité
                  components.css  boutons, affiches, cartes, rangées, épisodes, modale…
                  views.css       coque, navigation, accueil, lecteur, scans, réglages
                  fonts/          Inter et Sora en variable (72 Ko, aucun CDN)
js/             La logique, en modules ES natifs chargés tels quels (aucun build) :
                  main.js       point d'entrée, sommaire des modules, démarrage
                  core.js       constantes et utilitaires (el, icon, $…)
                  store.js      état persistant ; ui.js notifications, modales, navigation
                  api.js        requêtes, tâches 202, normalisation, mode démo
                  covers.js     jaquettes ; home.js accueil ; discover.js recherche et grille
                  catalogue.js  catalogue complet et indexation
                  episodes.js   chargement intelligent, cache des épisodes résolus
                  player.js     lecture HLS/MP4/iframe, relais, contrôles
                  library.js, scans.js, settings.js, keyboard.js
                Règle : au niveau haut d'un module, uniquement des déclarations ; les
                écouteurs vont dans sa fonction wire(), appelée par main.js.
serve.py        Lanceur : détecte ou démarre le backend, sert le panel, relaie /api,
                gère le mot de passe et l'indexation de fond
Dockerfile      Image « panel + backend » pour l'hébergement
render.yaml     Blueprint Render (plan gratuit, health check, mot de passe)
docker/         Point d'entrée du backend en conteneur, contrôle des dépendances,
                indexation au build et patch de résolution parallèle
tests/          Campagne de tests : doublures de backend, tests Python et
                suites navigateur (voir tests/README.md)
lancer.py       Raccourci double-clic universel (utile si les .bat sont bloqués)
lancer.bat      Raccourci double-clic Windows
lancer.command  Raccourci double-clic macOS
lancer.sh       Raccourci Linux
legacy/         L'ancien fichier preview.html, conservé pour référence
```

Aucune dépendance à installer, et les polices sont servies depuis le dépôt : rien
d'autre que le panel n'est nécessaire au rendu. Le seul script externe est **hls.js**
(version épinglée, chargé depuis jsDelivr) pour lire les flux `.m3u8` ; s'il est indisponible, le panel le
signale clairement et continue de fonctionner pour tout le reste. Pour un usage
totalement hors ligne, télécharge `hls.min.js` à côté de `index.html` et remplace l'URL
du `<script>` par `hls.min.js`.

---

## 5. Raccourcis clavier

| Touche | Action |
|---|---|
| `/` | Recherche rapide |
| `1` … `6` | Changer de vue |
| `Espace` / `K` | Lecture · pause |
| `←` `→` | Reculer · avancer de 5 s |
| `J` `L` | Reculer · avancer de 10 s |
| `M` | Couper le son |
| `F` | Plein écran |
| `N` / `P` | Épisode suivant · précédent |
| `Échap` | Fermer la fenêtre modale |

---

## 6. Chargement intelligent des épisodes

Ouvrir une saison ne résout plus tous ses épisodes avant d'afficher quoi que ce soit :
le panel demande d'abord **un seul épisode** (celui repris depuis ta dernière position,
ou le premier) et affiche tous les boutons numérotés dès que leur nombre est connu — un
aller-retour bien plus rapide que la résolution vidéo elle-même, puisqu'il ne demande que
de scraper la page de la saison, pas d'interroger chaque hébergeur. Le reste de la saison
continue de se résoudre en tâche de fond (le même appel qu'avant, simplement non
bloquant), et remplit les boutons restants au fur et à mesure.

Cliquer un épisode pas encore résolu (grisé, « non résolu ») le demande à son tour en
priorité : un court instant de résolution, puis la lecture démarre. Rien à configurer.

### Ce qui a été accéléré ensuite

Quatre changements indépendants, chacun mesuré plutôt que supposé
(`python3 tests/bench/resolution.py` rejoue les mesures) :

- **Les saisons déjà résolues sont conservées dans le navigateur** (12 h, 40 saisons au
  plus). Rouvrir une série commencée n'émet plus **aucune** requête : la liste est là
  immédiatement et la lecture part sans aller-retour. C'est le gain le plus visible,
  parce que le cache du serveur ne survit pas à la mise en veille d'une instance
  gratuite. Un lien qui a expiré efface l'entrée tout seul, et la fois suivante repart
  d'une résolution fraîche — rien à purger à la main.
- **L'épisode suivant est préchargé** pendant que tu regardes le courant : l'enchaînement
  automatique en fin d'épisode ne marque plus de pause.
- **La vérification « ce flux répond-il ? » tente d'abord la requête avec `Referer`.**
  Les hébergeurs qui l'exigent — sibnet en tête, et c'est le lecteur prioritaire —
  rejetaient l'autre systématiquement : on payait jusqu'à trois secondes d'attente avant
  d'essayer la bonne. Les deux tentatives forment un OU, donc l'ordre ne change aucune
  réponse ; c'est purement du temps rendu. Les connexions sont en outre refermées, ce qui
  évite de repayer un handshake TLS à chaque contrôle.
- **Les trois requêtes préalables à toute résolution ont enfin un délai maximal** et
  partagent la session du thread : un hébergeur muet n'immobilise plus un worker
  indéfiniment, et on ne reconstruit plus deux sessions HTTP par appel.

Le nombre de résolutions simultanées passe de 6 à 8 (`PANEL_RESOLVER_WORKERS`) : mesuré
à environ ×1,3 sur une saison entière, à nombre de requêtes identique. Au-delà de 12 le
gain s'épuise et le risque de limitation par les hébergeurs augmente.

Une idée a été **écartée par la mesure** : essayer tous les lecteurs en parallèle pour un
même épisode. Le banc donne ×1,11 seulement, pour 73 % de requêtes en plus — le coût ne
vaut pas le gain.

Concrètement :

- **Premier chargement d'une saison jamais visitée** : les boutons apparaissent en
  quelques secondes ; l'épisode ciblé est jouable presque aussitôt ; le reste arrive tout
  seul, sans bloquer la navigation.
- **Saison déjà en cache serveur** (visitée récemment, par toi ou un autre visiteur sur un
  panel hébergé) : tout apparaît résolu immédiatement.
- **Backend local non patché** (un clone brut d'AnimeSamaApi, lancé hors de l'image
  Docker, sans passer par `docker/speedup_patch.py`) : le paramètre `e` est simplement
  ignoré côté serveur, qui renvoie alors la saison déjà entière comme avant. Le panel
  détecte cette réponse et s'y adapte automatiquement — aucune configuration, aucun
  message d'erreur, juste l'ancien comportement (attente unique, tout d'un coup).

---

## 7. Limites connues (côté navigateur, pas côté panel)

- **Hébergeurs vidéo.** `getAnimeLink` renvoie tantôt un fichier direct (MP4 / M3U8),
  tantôt une page de lecteur (Sibnet, Vidmoly, SendVid…). Les fichiers directs sont lus
  dans la balise `<video>`, au besoin à travers le relais décrit plus haut ; les pages de
  lecteur sont affichées en iframe. Un hébergeur qui refuse l'intégration
  (`X-Frame-Options`) ne pourra pas être lu dans la page : le bouton « Ouvrir la source »
  reste disponible. Le panel affiche le message correspondant au lieu d'un écran noir.
  Le relais n'est proposé que si la page est servie par `serve.py` ; sur un hébergement
  statique, la route n'existe pas et le panel ne tente pas la bascule.
- **Iframe isolée.** Les lecteurs externes tournent en `sandbox`, sans `allow-popups` :
  les pop-ups publicitaires sont bloqués. Si un lecteur en dépend, passe par « Ouvrir la
  source ».
- **Scans.** Les images sont servies par le CDN d'Anime-Sama, qui applique parfois une
  protection anti-hotlink. Le panel remplace alors chaque image manquante par un message
  explicite.
- **Lenteur du tout premier appel à une saison jamais visitée.** `getAnimeLink` scrape
  la page à la volée : compte quelques secondes pour un épisode (voir « Chargement
  intelligent » plus haut), plus le temps que le reste de la saison termine en fond. Le
  délai d'attente est réglable (45 s par défaut).

---

## 8. Tests

```bash
python3 tests/run.py            # toute la campagne
python3 tests/run.py --unit     # seulement les tests Python (aucune dépendance)
```

Neuf suites : deux en Python, sept en navigateur via Playwright. Elles couvrent
le parcours complet du panel, le mot de passe, les tâches de fond et leur cache,
la bannière d'indexation, le relais vidéo, le chargement intelligent (épisode
prioritaire et dégradation sans patch), et l'équivalence du patch de
parallélisation. Chacune démarre ses propres doublures de backend — **aucun test
ne contacte Anime-Sama**.

Les tests navigateur demandent Node et Playwright
(`npm install playwright && npx playwright install chromium`) ; sans eux,
`run.py` le signale et exécute quand même les tests Python.

Détail des suites et des conventions : [`tests/README.md`](tests/README.md).

---

## 9. En cas de problème au démarrage

**`PermissionError: [WinError 10013]`** — le port est réservé par Windows (Hyper-V, WSL
ou Docker s'en attribuent des plages entières, même sans rien écouter dessus). Le
lanceur essaie les ports suivants puis en demande un au système, donc ce message ne
devrait plus bloquer. Pour voir les plages réservées :

```
netsh interface ipv4 show excludedportrange protocol=tcp
```

**La fenêtre se ferme instantanément** — lance depuis un terminal (`python serve.py`)
pour lire le message. Depuis un double-clic, le lanceur marque une pause sur erreur.

**« Aucun backend trouvé »** — normal si tu n'as pas encore installé AnimeSamaApi. Le
panel fonctionne quand même en mode démo (Paramètres → Lecture). Pour les vraies
données, place le dossier `AnimeSamaApi` à côté du panel : le lanceur le trouvera et le
démarrera tout seul au prochain lancement.

**`python` n'est pas reconnu** — installe Python depuis
[python.org](https://www.python.org/downloads/) en cochant **« Add Python to PATH »**.

---

## 10. Vie privée et usage

Aucune donnée ne quitte ton navigateur : ni compte, ni télémétrie, ni requête vers un
service tiers autre que le CDN de hls.js. Favoris, historique et progression vivent dans
`localStorage` et se suppriment depuis Paramètres → Mes données.

Ce projet est un client destiné à un backend que tu héberges. Respecte les conditions
d'utilisation d'Anime-Sama et la législation applicable : n'utilise l'ensemble que pour
accéder à des contenus auxquels tu as légitimement droit.
