# Anime-Sama Web Panel

Panel web en **HTML / CSS / JavaScript vanilla**, sans framework ni build, qui pilote
l'API [AnimeSamaApi de TMCooper](https://github.com/TMCooper/AnimeSamaApi) : recherche
d'animes, lecteur vidéo HLS / MP4 / iframe, favoris, historique, reprise de lecture et
lecteur de scans.

Le panel est un **client** : il n'héberge, ne scrape et ne stocke aucun contenu. Tout ce
qu'il affiche vient du backend que tu fais tourner toi-même.

---

## 1. Installation

### a. Le backend (obligatoire pour les vraies données)

```bash
git clone https://github.com/TMCooper/AnimeSamaApi
cd AnimeSamaApi
pip install -r requirements.txt
python main.py                       # écoute sur http://127.0.0.1:5000
```

À la première utilisation, construis la base locale : ouvre
`http://127.0.0.1:5000/api/getAllAnime?r=True` (3 à 5 minutes pour ~4000 fiches).
Le panel propose de le faire pour toi si la base est vide.

### b. Le panel

```bash
git clone https://github.com/redslayer34/anime-sama-web-panel
cd anime-sama-web-panel
python3 serve.py                     # panel sur http://127.0.0.1:8080
```

`serve.py` n'utilise que la bibliothèque standard : il sert les fichiers statiques **et**
relaie `/api/…` vers le backend. Panel et API se retrouvent sur la même origine, ce qui
supprime d'un coup les problèmes de CORS et de contenu mixte. Laisse alors le champ
« URL du backend » **vide** dans les paramètres.

Options : `python3 serve.py --port 9000 --api http://127.0.0.1:5001`.

### c. Les autres façons de lancer

| Méthode | Champ « URL du backend » | Remarque |
|---|---|---|
| `python3 serve.py` | *(vide)* | **Recommandé.** Aucun réglage CORS. |
| `python3 -m http.server 8080` | `http://127.0.0.1:5000` | Le backend doit autoriser le CORS (ci-dessous). |
| Double-clic sur `index.html` | `http://127.0.0.1:5000` | `file://` : la plupart des navigateurs bloquent les requêtes. Le panel prévient. |

Si tu ne veux pas passer par `serve.py`, autorise le CORS côté backend :

```bash
pip install flask-cors
```

```python
from flask_cors import CORS
CORS(app)            # `app` = l'instance Flask d'AnimeSamaApi
```

---

## 2. Ce qui fonctionne vraiment

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

- **Jaquettes, synopsis, genres, notes** : l'API ne renvoie ni image ni métadonnée
  descriptive. Les cartes affichent donc titre, titre alternatif et score de recherche.
  Il faudrait brancher une API tierce (AniList, Jikan/MyAnimeList) pour aller plus loin.
- **Compte utilisateur, synchronisation multi-appareils** : nécessiterait un serveur avec
  base de données. Ici, chaque navigateur a ses propres données (avec synchronisation
  entre onglets d'un même navigateur).
- **Téléchargement des épisodes** : hors sujet pour un client web.

---

## 3. Structure du projet

```
index.html      Structure sémantique, sprite SVG, modale <dialog>, zone de notifications
style.css       Design system : variables CSS, 3 thèmes, 5 accents, responsive, animations
script.js       Toute la logique, en sections numérotées (utilitaires, stockage, API,
                toasts/modales, navigation, découverte, lecteur, favoris, scans, réglages)
serve.py        Serveur statique + proxy /api (bibliothèque standard uniquement)
legacy/         L'ancien fichier preview.html, conservé pour référence
```

Aucune dépendance à installer. Le seul script externe est **hls.js** (version épinglée,
chargé depuis jsDelivr) pour lire les flux `.m3u8` ; s'il est indisponible, le panel le
signale clairement et continue de fonctionner pour tout le reste. Pour un usage
totalement hors ligne, télécharge `hls.min.js` à côté de `index.html` et remplace l'URL
du `<script>` par `hls.min.js`.

---

## 4. Raccourcis clavier

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

## 5. Limites connues (côté navigateur, pas côté panel)

- **Hébergeurs vidéo.** `getAnimeLink` renvoie tantôt un fichier direct (MP4 / M3U8),
  tantôt une page de lecteur (Sibnet, Vidmoly, SendVid…). Les fichiers directs sont lus
  dans la balise `<video>` ; les pages de lecteur sont affichées en iframe. Un hébergeur
  qui refuse l'intégration (`X-Frame-Options`) ou le CORS ne pourra pas être lu dans la
  page : le bouton « Ouvrir la source » reste disponible. Le panel affiche le message
  correspondant au lieu d'un écran noir.
- **Iframe isolée.** Les lecteurs externes tournent en `sandbox`, sans `allow-popups` :
  les pop-ups publicitaires sont bloqués. Si un lecteur en dépend, passe par « Ouvrir la
  source ».
- **Scans.** Les images sont servies par le CDN d'Anime-Sama, qui applique parfois une
  protection anti-hotlink. Le panel remplace alors chaque image manquante par un message
  explicite.
- **Lenteur du premier appel.** `getAnimeLink` scrape la page à la volée : compte
  plusieurs secondes. Le délai d'attente est réglable (45 s par défaut).

---

## 6. Vie privée et usage

Aucune donnée ne quitte ton navigateur : ni compte, ni télémétrie, ni requête vers un
service tiers autre que le CDN de hls.js. Favoris, historique et progression vivent dans
`localStorage` et se suppriment depuis Paramètres → Mes données.

Ce projet est un client destiné à un backend que tu héberges. Respecte les conditions
d'utilisation d'Anime-Sama et la législation applicable : n'utilise l'ensemble que pour
accéder à des contenus auxquels tu as légitimement droit.
