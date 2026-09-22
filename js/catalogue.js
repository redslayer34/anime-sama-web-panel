/* Anime-Sama Panel — Catalogue complet : cache navigateur, préchargement, indexation. */
import { CATALOGUE_KEY, CATALOGUE_MAX, CATALOGUE_TTL, el, must, panelServer } from "./core.js";
import { safeStorage, state } from "./store.js";
import { navigate, notify, openModal } from "./ui.js";
import { ApiError, describeError, request, source } from "./api.js";
import { discover, renderDiscover } from "./discover.js";
import { renderHome } from "./home.js";
import { setApiStatus } from "./settings.js";

/** Réservoir de fiches pour l'accueil : la liste affichée si elle existe,
    sinon le catalogue mis en cache, qu'on lit une seule fois. */
let cataloguePool = null;
export function homePool() {
  if (discover.items.length) return discover.items;
  if (cataloguePool === null) cataloguePool = readCatalogueCache()?.items || [];
  return cataloguePool;
}

function readCatalogueCache() {
  try {
    const raw = JSON.parse(safeStorage.get(CATALOGUE_KEY) || "null");
    if (raw && Array.isArray(raw.items) && raw.items.length) return raw;
  } catch { /* cache illisible */ }
  return null;
}

async function fetchCatalogue() {
  discover.origin = "loading";
  discover.kind = "catalogue";
  renderDiscover();
  navigate("discover");
  try {
    const items = await source.catalogue();
    if (!items.length) throw new ApiError("Le catalogue renvoyé est vide. Lance d'abord l'indexation via /api/getAllAnime (3 à 5 minutes).", "empty");
    showCatalogue(items);
    writeCatalogueCache(items);
    notify(`${items.length} titres chargés et mis en cache.`, { type: "success", title: "Catalogue complet" });
    setApiStatus(source.isDemo ? "demo" : "online");
  } catch (err) {
    discover.origin = "error";
    discover.message = describeError(err);
    renderDiscover();
    setApiStatus("offline");
    const state = await fetchPanelState();
    if (state?.indexing) pollIndexing();     // le serveur s'en charge déjà
    else offerIndexing();
  }
}

function writeCatalogueCache(items) {
  const payload = JSON.stringify({ at: Date.now(), items });
  if (payload.length < CATALOGUE_MAX) safeStorage.set(CATALOGUE_KEY, payload);
}

/** Remplit l'accueil au tout premier lancement.

    Sans catalogue en mémoire, le héros et les rangées n'ont rien à
    montrer et le site s'ouvre sur un écran vide — précisément ce que
    cette refonte cherche à supprimer. On récupère donc le catalogue en
    tâche de fond, sans toucher ni à la grille, ni à la navigation, ni au
    statut affiché : un échec passe inaperçu, l'accueil se contente alors
    de ce qu'il a. */
export async function warmHomeCatalogue() {
  if (state.settings.demo || readCatalogueCache()) return;
  // Pendant une indexation serveur, le catalogue est vide par définition :
  // le demander ne ferait qu'ajouter du bruit. La bannière d'indexation
  // s'en charge, et le catalogue sera rechargé à la fin.
  if (indexing.seen) return;
  try {
    const items = await source.catalogue();
    if (!items.length) return;
    writeCatalogueCache(items);
    cataloguePool = items;
    if (discover.origin === "idle") renderHome();
  } catch { /* silencieux, c'est un confort et non un prérequis */ }
}

function showCatalogue(items) {
  discover.items = items.map((a, i) => ({ ...a, index: i }));
  discover.origin = "results";
  discover.kind = "catalogue";
  discover.limit = 60;
  renderDiscover();
}

function offerIndexing() {
  openModal({
    title: "Indexer le catalogue ?",
    body: el("div", {}, [
      el("p", { text: "La route /api/loadBaseAnimeData ne renvoie rien tant que la base locale du backend n'a pas été construite." }),
      el("p", { text: "L'indexation (/api/getAllAnime) parcourt tout le catalogue d'Anime-Sama et prend 3 à 5 minutes. Le panel attendra jusqu'à 10 minutes." }),
    ]),
    actions: [
      { label: "Plus tard", variant: "btn-ghost" },
      { label: "Lancer l'indexation", variant: "btn-primary", onClick: runIndexing },
    ],
  });
}

async function runIndexing() {
  notify("Indexation lancée. Garde cet onglet ouvert, cela peut prendre plusieurs minutes.", { type: "info", title: "Patience…", timeout: 12000 });
  try {
    await request("/api/getAllAnime?r=True", { timeoutMs: 10 * 60 * 1000 });
    notify("Indexation terminée.", { type: "success" });
    fetchCatalogue();
  } catch (err) {
    notify(describeError(err), { type: "error", title: "Indexation impossible", timeout: 9000 });
  }
}

/** Actualise le catalogue sans interrompre ce qui est affiché. */
async function refreshCatalogueQuietly() {
  try {
    const items = await source.catalogue();
    if (!items.length) return;
    writeCatalogueCache(items);
    cataloguePool = items;
    if (discover.origin === "results") showCatalogue(items);
    notify(`Catalogue actualisé : ${items.length} titres.`, { type: "success", timeout: 3200 });
  } catch { /* le cache reste affiché, rien à signaler */ }
}

/* ── Indexation du catalogue côté serveur ──
   En hébergement, le disque est effacé à chaque redémarrage : le serveur
   réindexe alors en tâche de fond. Sans ce retour visuel, la première visite
   après un réveil ressemble à une panne. La route /panel/state n'existe que
   si le panel est servi par serve.py ; ailleurs, on s'efface silencieusement. */
const indexBanner = must("#indexBanner");
const indexText = must("#indexText");
export const indexing = { timer: 0, seen: false, available: true };

async function fetchPanelState() {
  if (!indexing.available || location.protocol === "file:") return null;
  try {
    const response = await fetch(new URL("panel/state", location.href), { cache: "no-store" });
    if (!response.ok) { indexing.available = false; panelServer.relay = false; return null; }
    const state = await response.json();
    panelServer.relay = Boolean(state?.relay);
    return state;
  } catch {
    indexing.available = false;
    panelServer.relay = false;
    return null;
  }
}

export async function pollIndexing() {
  clearTimeout(indexing.timer);
  indexing.timer = 0;

  const state = await fetchPanelState();
  if (!state) { indexBanner.hidden = true; return; }

  if (state.indexing) {
    indexing.seen = true;
    indexText.textContent = "Indexation du catalogue en cours : 3 à 5 minutes après le réveil du serveur. La recherche fonctionnera ensuite.";
    indexBanner.hidden = false;
    setApiStatus("indexing");
    indexing.timer = setTimeout(pollIndexing, 5000);
    return;
  }

  indexBanner.hidden = true;
  if (indexing.seen) {
    indexing.seen = false;
    setApiStatus(state.backend ? "online" : "offline");
    notify("Le catalogue est prêt, la recherche est de nouveau disponible.", { type: "success", title: "Indexation terminée" });
    if (discover.origin !== "results") fetchCatalogue();
  } else if (state.error) {
    notify(`L'indexation du catalogue a échoué côté serveur : ${state.error}`, { type: "error", title: "Catalogue indisponible", timeout: 10000 });
  }
}

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
  /* ── Catalogue complet (route loadBaseAnimeData) ── */
  // Le catalogue mis en cache par les versions précédentes a été normalisé
  // sans les jaquettes. La clé a changé ; l'ancienne, qui pouvait peser
  // jusqu'à 3 Mo, resterait sinon orpheline pour toujours.
  safeStorage.remove("animeSamaPanel.catalogue.v1");

  must("#loadCatalogueBtn").addEventListener("click", () => {
    const cache = readCatalogueCache();
    if (!cache) { fetchCatalogue(); return; }
    // Le catalogue étant préchargé en tâche de fond, demander « cache ou
    // rechargement ? » à chaque clic serait une question sans enjeu. On
    // affiche immédiatement, et on actualise derrière si c'est périmé.
    showCatalogue(cache.items);
    navigate("discover");
    if (Date.now() - cache.at >= CATALOGUE_TTL) refreshCatalogueQuietly();
  });
}
