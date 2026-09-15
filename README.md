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
| `PORT` | Fourni par l'hébergeur ; le panel s'y adapte seul. |

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

## 4. Structure du projet

```
index.html      Structure sémantique, sprite SVG, modale <dialog>, zone de notifications
style.css       Design system : variables CSS, 3 thèmes, 5 accents, responsive, animations
script.js       Toute la logique, en sections numérotées (utilitaires, stockage, API,
                toasts/modales, navigation, découverte, lecteur, favoris, scans, réglages)
serve.py        Lanceur : détecte ou démarre le backend, sert le panel, relaie /api,
                gère le mot de passe et l'indexation de fond
Dockerfile      Image « panel + backend » pour l'hébergement
render.yaml     Blueprint Render (plan gratuit, health check, mot de passe)
docker/         Point d'entrée du backend en conteneur, contrôle des dépendances
                et indexation au build
lancer.py       Raccourci double-clic universel (utile si les .bat sont bloqués)
lancer.bat      Raccourci double-clic Windows
lancer.command  Raccourci double-clic macOS
lancer.sh       Raccourci Linux
legacy/         L'ancien fichier preview.html, conservé pour référence
```

Aucune dépendance à installer. Le seul script externe est **hls.js** (version épinglée,
chargé depuis jsDelivr) pour lire les flux `.m3u8` ; s'il est indisponible, le panel le
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

## 6. Limites connues (côté navigateur, pas côté panel)

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

## 7. En cas de problème au démarrage

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

## 8. Vie privée et usage

Aucune donnée ne quitte ton navigateur : ni compte, ni télémétrie, ni requête vers un
service tiers autre que le CDN de hls.js. Favoris, historique et progression vivent dans
`localStorage` et se suppriment depuis Paramètres → Mes données.

Ce projet est un client destiné à un backend que tu héberges. Respecte les conditions
d'utilisation d'Anime-Sama et la législation applicable : n'utilise l'ensemble que pour
accéder à des contenus auxquels tu as légitimement droit.
