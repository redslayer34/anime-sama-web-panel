/* =============================================================
   Anime-Sama Panel — point d'entrée
   Client 100 % vanilla de l'API AnimeSamaApi (TMCooper), en modules ES
   natifs : aucune étape de build, le navigateur charge js/ tel quel.

   Sommaire
   core.js      Constantes et utilitaires partagés.
   covers.js    Jaquettes : URL directe, relais /img, puis affiche générée.
   store.js     État persistant (localStorage) et migration de l'ancien panel.
   ui.js        Notifications, modales et navigation entre les vues.
   api.js       Couche API : requêtes, tâches 202, normalisation, mode démo.
   discover.js  Vue Découvrir : recherche, grille d'affiches, favoris, fiche détail.
   home.js      Accueil : héros et rangées, affichés tant qu'aucune recherche n'est lancée.
   catalogue.js Catalogue complet : cache navigateur, préchargement, indexation.
   episodes.js  Épisodes : ouverture d'une série, chargement intelligent, cache des épisodes résolus.
   player.js    Lecteur : HLS, MP4 ou iframe, bascule vers le relais, contrôles, progression.
   library.js   Favoris, reprise et historique.
   scans.js     Lecteur de scans.
   settings.js  Réglages, apparence, diagnostic de l'API, export et import.
   keyboard.js  Raccourcis clavier, synchronisation entre onglets, sauvegarde en sortie.
   main.js      Point d'entrée : branche les écouteurs de chaque module, puis démarre.

   Règle d'écriture, qui rend l'ordre de chargement indifférent : au niveau
   haut d'un module, uniquement des déclarations. Tout ce qui agit (écouteurs,
   nettoyages) va dans la fonction wire() du module, que ce fichier appelle
   une fois tous les modules évalués — dans l'ordre de l'ancien script
   unique — puis init() démarre le panel.
   ============================================================= */
import { $, LOCAL_BACKEND } from "./core.js";
import { loadState, persist, state } from "./store.js";
import { applyView, notify, wire as wireUi } from "./ui.js";
import { apiBase, source } from "./api.js";
import { renderDiscover, updateFavCount, wire as wireDiscover } from "./discover.js";
import { pollIndexing, warmHomeCatalogue, wire as wireCatalogue } from "./catalogue.js";
import { renderEpisodes } from "./episodes.js";
import { ensureOption, modeSelect, player, versionSelect, wire as wirePlayer } from "./player.js";
import { renderContinue, renderFavorites, renderHistory, wire as wireLibrary } from "./library.js";
import { renderChapters, wire as wireScans } from "./scans.js";
import {
  applyAppearance, setApiStatus, syncSettingsUI, wire as wireSettings
} from "./settings.js";
import { wire as wireKeyboard } from "./keyboard.js";

/** Sans réglage explicite, on teste la même origine puis le backend local. */
async function autoDiscoverBackend() {
  if (state.settings.demo || apiBase()) return;
  try {
    await source.ping();
    setApiStatus("online");
    return;                                   // servi par serve.py : rien à faire
  } catch { /* on tente le backend local ci-dessous */ }

  if (location.protocol === "https:") { setApiStatus("offline"); return; }
  const previous = state.settings.api;
  state.settings.api = LOCAL_BACKEND;
  try {
    await source.ping();
    $("#apiInput").value = LOCAL_BACKEND;
    persist();
    setApiStatus("online");
    notify(`Backend trouvé sur ${LOCAL_BACKEND}.`, { type: "success", timeout: 4000 });
  } catch {
    state.settings.api = previous;
    setApiStatus("offline");
  }
}

function init() {
  loadState();
  applyAppearance();
  syncSettingsUI();

  player.version = state.settings.version;
  player.mode = state.settings.mode;
  ensureOption(versionSelect, state.settings.version);
  modeSelect.value = state.settings.mode;

  updateFavCount();
  renderDiscover();
  renderFavorites();
  renderHistory();
  renderContinue();
  renderChapters();
  renderEpisodes("idle");

  applyView(location.hash.slice(1) || "discover");

  if (state.settings.demo) setApiStatus("demo");
  else {
    autoDiscoverBackend();
    pollIndexing();
    // Différé : ce confort ne doit pas retarder le premier rendu, ni
    // maintenir le réseau occupé pendant que la page finit de se charger.
    const later = () => setTimeout(warmHomeCatalogue, 1200);
    if (window.requestIdleCallback) requestIdleCallback(later, { timeout: 2000 });
    else later();
  }

  if (location.protocol === "file:") {
    notify("Panel ouvert en file:// — la plupart des navigateurs bloquent alors les requêtes vers l'API. Sers le dossier avec « python -m http.server 8080 ».",
      { type: "warn", title: "Ouverture locale", timeout: 11000 });
  }
}

wireUi();
wireDiscover();
wireCatalogue();
wirePlayer();
wireLibrary();
wireScans();
wireSettings();
wireKeyboard();

init();
