/* Anime-Sama Panel — Vue Découvrir : recherche, grille d'affiches, favoris, fiche détail. */
import { $, $$, clamp, clear, deaccent, debounce, el, icon, must, safeUrl } from "./core.js";
import { coverFor, posterBox, rememberCover } from "./covers.js";
import { persist, state } from "./store.js";
import { closeModal, navigate, notify, openModal } from "./ui.js";
import { ApiError, describeError, source } from "./api.js";
import { renderHome } from "./home.js";
import { pollIndexing } from "./catalogue.js";
import { openAnime } from "./episodes.js";
import { updatePlayerFavButton } from "./player.js";
import { renderFavorites } from "./library.js";
import { setApiStatus } from "./settings.js";

const discoverResults = must("#discoverResults");
const filterInput     = must("#filterInput");
const sortSelect      = must("#sortSelect");
const favOnlyToggle   = must("#favOnlyToggle");
const resultCount     = must("#resultCount");
const searchInput     = must("#searchInput");

// kind : « search » ou « catalogue » — ce que la grille montre, pour la
// titrer et pour allumer le bon onglet. query : le terme recherché.
export const discover = { items: [], origin: "idle", limit: 60, message: "", kind: "search", query: "" };

/** Retour à l'accueil : la grille se vide, le héros et les rangées reviennent. */
export function goHome() {
  discover.items = [];
  discover.origin = "idle";
  discover.query = "";
  searchInput.value = "";
  filterInput.value = "";
  renderDiscover();
  navigate("discover");
  window.scrollTo({ top: 0 });
}

/** Titre et sous-titre des résultats, et état exposé au CSS (onglet actif,
    en-tête transparent sur l'accueil). */
function renderBrowseHead(count = null) {
  const root = document.documentElement;
  root.dataset.browse = discover.origin === "idle" ? "idle" : discover.kind;
  const title = must("#catalogueTitle");
  const sub = must("#browseSub");
  if (discover.kind === "catalogue") {
    title.textContent = "Catalogue";
    sub.textContent = count === null ? "Chargement…" : `${count} titre${count > 1 ? "s" : ""} disponible${count > 1 ? "s" : ""}`;
  } else {
    title.textContent = discover.query ? `Résultats pour « ${discover.query} »` : "Recherche";
    sub.textContent = count === null ? "Recherche en cours…" : `${count} titre${count > 1 ? "s" : ""} trouvé${count > 1 ? "s" : ""}`;
  }
  if (discover.origin === "error") sub.textContent = "La requête a échoué.";
}

/** Seule primitive d'état vide du panel. Elle est utilisée dans six
    conteneurs dont certains sont comptés par les tests : elle ne doit
    jamais porter .card ni .row. La variante compacte évite d'avoir à
    créer un second composant — qui serait justement l'occasion
    d'introduire une de ces classes par accident. */
export function emptyState({ glyph = "info", title, text, tone = "", action = null, size = "" }) {
  const dataset = {};
  if (tone) dataset.tone = tone;
  if (size) dataset.size = size;
  return el("div", { class: "empty", dataset }, [
    icon(glyph),
    el("p", { class: "empty-title", text: title }),
    text ? el("p", { class: "empty-text", text }) : null,
    action ? el("button", { type: "button", class: "btn btn-primary", onclick: action.onClick }, action.label) : null,
  ]);
}

export function isFavorite(id) { return state.favorites.some((f) => f.id === id); }

export function toggleFavorite(anime) {
  const index = state.favorites.findIndex((f) => f.id === anime.id);
  if (index >= 0) {
    state.favorites.splice(index, 1);
    notify(`« ${anime.title} » retiré des favoris.`, { type: "info", timeout: 3200 });
  } else {
    state.favorites.unshift({
      id: anime.id, title: anime.title, url: anime.url || null,
      cover: coverFor(anime), addedAt: Date.now(),
    });
    notify(`« ${anime.title} » ajouté aux favoris.`, { type: "success", timeout: 3200 });
  }
  rememberCover(anime);
  persist();
  renderFavorites();
  // Reconstruire toute la grille rechargerait chaque affiche et ferait
  // clignoter la page. On ne le fait que si le filtre « favoris
  // uniquement » est actif, car la carte doit alors disparaître.
  if (favOnlyToggle.checked) renderDiscover();
  else {
    refreshFavMarks();
    // La rangée « Ma liste » doit refléter l'ajout tout de suite. Les
    // affiches déjà résolues sont mémoïsées, la reconstruction ne
    // relance donc aucun téléchargement.
    if (discover.origin === "idle") renderHome();
  }
  updateFavCount();
  updatePlayerFavButton();
}

/** Met à jour les étoiles déjà à l'écran sans reconstruire les cartes. */
function refreshFavMarks() {
  for (const button of $$(".card-fav")) {
    const id = button.dataset.favFor;
    if (!id) continue;
    const active = isFavorite(id);
    button.classList.toggle("is-on", active);
    button.setAttribute("aria-pressed", String(active));
    const label = active ? "Retirer des favoris" : "Ajouter aux favoris";
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
  }
}

export function updateFavCount() {
  const badge = $("#navFavCount");
  badge.textContent = String(state.favorites.length);
  badge.hidden = state.favorites.length === 0;
}

/** Dernière progression connue pour un anime, toutes saisons confondues. */
function latestProgress(animeId) {
  let best = null;
  for (const entry of Object.values(state.progress)) {
    if (entry.animeId !== animeId || entry.lastEpisode == null) continue;
    if (!best || (entry.updatedAt || 0) > (best.updatedAt || 0)) best = entry;
  }
  return best;
}

function favButton(anime) {
  const active = isFavorite(anime.id);
  return el("button", {
    type: "button",
    dataset: { favFor: anime.id },
    class: `icon-btn icon-btn-sm card-fav${active ? " is-on" : ""}`,
    "aria-pressed": String(active),
    title: active ? "Retirer des favoris" : "Ajouter aux favoris",
    "aria-label": active ? "Retirer des favoris" : "Ajouter aux favoris",
    onclick: () => toggleFavorite(anime),
  }, icon("star"));
}

/** Carte d'anime, pilotée par l'affiche.

    Au repos, l'affiche seule, comme sur une plateforme. Au survol (ou au
    focus clavier), un bouton de lecture et l'étoile apparaissent ; un clic
    ailleurs sur l'affiche ouvre la fiche.

    Trois règles de structure, imposées par les suites de tests et par la
    façon dont un clic automatisé vise le centre d'un élément :
      · le bouton de lecture est le PREMIER .btn-primary du sous-arbre ;
      · .card-fav est un descendant, et rien ne le recouvre — le voile
        dégradé est en `pointer-events: none`, la zone de clic (.card-hit)
        passe dessous ;
      · les boutons restent dans le flux et cliquables : seule leur
        opacité dépend du survol, jamais leur présence. */
export function animeCard(anime) {
  const progress = latestProgress(anime.id);
  const resume = progress
    ? { seasonSlug: progress.seasonSlug, version: progress.version, episode: progress.lastEpisode }
    : {};
  const ratio = progress ? watchedRatio(progress) : 0;
  const details = () => showAnimeDetails(anime);

  const poster = posterBox(anime, {
    extra: [
      el("button", { type: "button", class: "card-hit", tabindex: "-1", "aria-hidden": "true", onclick: details }),
      el("div", { class: "poster-scrim", "aria-hidden": "true" }),
      el("button", {
        type: "button", class: "btn btn-primary play-fab",
        title: progress ? "Reprendre" : "Regarder",
        "aria-label": `${progress ? "Reprendre" : "Regarder"} ${anime.title}`,
        onclick: () => openAnime(anime, resume),
      }, icon("play")),
      favButton(anime),
      progress ? el("span", { class: "poster-tag", text: `É${progress.lastEpisode}` }) : null,
      ratio > 0 ? el("div", { class: "poster-bar" }, el("i", { style: { width: `${ratio * 100}%` } })) : null,
    ],
  });

  const sub = progress
    ? el("p", { class: "card-sub card-sub-accent", text: `${progress.seasonLabel} · Épisode ${progress.lastEpisode}` })
    : (anime.alt ? el("p", { class: "card-sub", text: anime.alt }) : null);

  return el("article", { class: "card", dataset: { id: anime.id } }, [
    poster,
    el("h3", { class: "card-title" },
      el("button", { type: "button", class: "card-link", onclick: details }, anime.title)),
    sub,
  ]);
}

/** Part regardée de l'épisode en cours, pour le liseré de reprise. */
function watchedRatio(entry) {
  const saved = entry?.episodes?.[entry.lastEpisode];
  if (!saved?.d) return saved?.done ? 1 : 0;
  return clamp(saved.t / saved.d, 0, 1);
}

function filteredDiscover() {
  const needle = deaccent(filterInput.value.trim());
  let items = discover.items;
  if (needle) items = items.filter((a) => deaccent(`${a.title} ${a.alt}`).includes(needle));
  if (favOnlyToggle.checked) items = items.filter((a) => isFavorite(a.id));

  const sorted = items.slice();
  switch (sortSelect.value) {
    case "az": sorted.sort((a, b) => a.title.localeCompare(b.title, "fr")); break;
    case "za": sorted.sort((a, b) => b.title.localeCompare(a.title, "fr")); break;
    case "fav": sorted.sort((a, b) => (isFavorite(b.id) ? 1 : 0) - (isFavorite(a.id) ? 1 : 0) || a.index - b.index); break;
    default: sorted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.index - b.index);
  }
  return sorted;
}

export function renderDiscover() {
  clear(discoverResults);
  // L'accueil n'occupe l'écran que tant que la grille n'a rien à montrer.
  renderHome();
  renderBrowseHead();

  if (discover.origin === "loading") {
    resultCount.textContent = "…";
    // Le squelette prend exactement la forme d'une affiche : la boîte est
    // réservée à l'avance, donc aucun saut quand les cartes arrivent.
    for (let i = 0; i < 12; i++) discoverResults.append(el("div", { class: "skeleton skeleton-poster" }));
    return;
  }

  if (discover.origin === "error") {
    resultCount.textContent = "0";
    discoverResults.append(emptyState({
      glyph: "alert", tone: "error", title: "La requête a échoué", text: discover.message,
      action: { label: "Ouvrir les paramètres", onClick: () => navigate("settings") },
    }));
    return;
  }

  if (discover.origin === "idle") {
    resultCount.textContent = "—";
    // Tant que l'accueil a quelque chose à montrer, il suffit ; l'invitation
    // ne sert qu'au tout premier lancement, quand il n'y a encore rien.
    if (!must("#homeBlock").hidden) return;
    discoverResults.append(emptyState({
      glyph: "compass",
      size: "compact",
      title: "Parcourir le catalogue",
      text: "Saisis un titre pour interroger l'API, ou charge le catalogue complet pour filtrer les 4000+ fiches hors ligne.",
      action: { label: "Charger le catalogue", onClick: () => must("#loadCatalogueBtn").click() },
    }));
    return;
  }

  const items = filteredDiscover();
  resultCount.textContent = `${items.length} titre${items.length > 1 ? "s" : ""}`;
  renderBrowseHead(discover.items.length);

  if (!items.length) {
    discoverResults.append(emptyState({
      glyph: "search",
      title: "Aucun résultat",
      text: favOnlyToggle.checked
        ? "Aucun favori ne correspond à ce filtre. Décoche « Favoris uniquement » pour voir tous les titres."
        : "Aucun titre ne correspond au filtre. Essaie une orthographe différente : la recherche de l'API est floue mais exige un minimum de ressemblance.",
    }));
    return;
  }

  const slice = items.slice(0, discover.limit);
  const fragment = document.createDocumentFragment();
  for (const anime of slice) fragment.append(animeCard(anime));
  discoverResults.append(fragment);

  if (items.length > slice.length) {
    discoverResults.append(el("div", { class: "empty load-more" }, [
      el("p", { class: "empty-text", text: `${slice.length} titres affichés sur ${items.length}.` }),
      el("button", {
        type: "button", class: "btn btn-ghost",
        onclick: () => { discover.limit += 120; renderDiscover(); },
      }, "Afficher plus"),
    ]));
  }
}

async function runSearch(query) {
  const term = query.trim();
  searchInput.value = term;
  if (term.length < 2) {
    notify("Saisis au moins 2 caractères.", { type: "warn", timeout: 3200 });
    return;
  }
  discover.origin = "loading";
  discover.kind = "search";
  discover.query = term;
  discover.limit = 60;
  renderDiscover();
  navigate("discover");
  searchInput.blur();
  try {
    const items = await source.search(term, Number($("#searchLimit").value) || 10);
    discover.items = items.map((a, i) => ({ ...a, index: i }));
    discover.origin = "results";
    renderDiscover();
    setApiStatus(source.isDemo ? "demo" : "online");
    if (!items.length) notify(`Aucun résultat pour « ${term} ».`, { type: "warn" });
  } catch (err) {
    discover.origin = "error";
    discover.message = describeError(err);
    renderDiscover();
    if (!(err instanceof ApiError && err.kind === "abort")) setApiStatus("offline");
    pollIndexing();
  }
}

/** Fiche détaillée d'une série.

    Volontairement courte : les données ne contiennent ni synopsis, ni
    genres, ni note. Une fiche calquée sur Netflix afficherait des blocs
    vides ; celle-ci ne montre que ce qu'elle peut tenir — grande affiche,
    titres, saisons, et les actions utiles.

    Tous les boutons doivent porter type="button" : la modale est un
    <form method="dialog">, un bouton sans type la refermerait au clic. */
export async function showAnimeDetails(anime) {
  const progress = latestProgress(anime.id);
  const seasonsBox = el("div", { class: "detail-seasons" },
    el("p", { class: "hint", text: "Chargement des saisons…" }));

  const actions = el("div", { class: "detail-actions" }, [
    el("button", {
      type: "button", class: "btn btn-primary",
      onclick: () => { closeModal(); openAnime(anime, progress
        ? { seasonSlug: progress.seasonSlug, version: progress.version, episode: progress.lastEpisode }
        : {}); },
    }, [icon("play"), el("span", { text: progress ? `Reprendre à l'épisode ${progress.lastEpisode}` : "Regarder" })]),
    el("button", {
      type: "button", class: `btn btn-ghost${isFavorite(anime.id) ? " is-on" : ""}`,
      onclick: (event) => {
        toggleFavorite(anime);
        const on = isFavorite(anime.id);
        event.currentTarget.classList.toggle("is-on", on);
        event.currentTarget.querySelector("span").textContent = on ? "Dans ma liste" : "Ajouter à ma liste";
      },
    }, [icon("star"), el("span", { text: isFavorite(anime.id) ? "Dans ma liste" : "Ajouter à ma liste" })]),
  ]);

  const fiche = safeUrl(anime.url);   // revalidé : un favori importé d'un JSON tiers pourrait porter une URL forgée
  const body = el("div", { class: "detail" }, [
    el("div", { class: "detail-poster" }, posterBox(anime, { eager: true })),
    el("div", { class: "detail-body" }, [
      anime.alt ? el("p", { class: "detail-alt", text: anime.alt }) : null,
      el("div", { class: "detail-chips" }, [
        Number.isFinite(anime.score) ? el("span", { class: "chip chip-sm", text: `Score ${anime.score}` }) : null,
        progress ? el("span", { class: "chip chip-sm chip-accent", text: `${progress.seasonLabel} · Ép. ${progress.lastEpisode}` }) : null,
      ]),
      actions,
      seasonsBox,
      fiche ? el("a", {
        class: "detail-link", href: fiche, target: "_blank", rel: "noopener noreferrer nofollow",
      }, [icon("external"), el("span", { text: "Voir la fiche d'origine" })]) : null,
    ]),
  ]);

  openModal({ title: anime.title, body, variant: "detail", actions: [{ label: "Fermer", variant: "btn-ghost" }] });

  try {
    const seasons = await source.seasons(anime);
    clear(seasonsBox);
    if (!seasons.length) {
      seasonsBox.append(el("p", { class: "hint", text: "Aucune saison n'a été renvoyée par l'API pour ce titre." }));
      return;
    }
    seasonsBox.append(el("p", { class: "side-title", text: `${seasons.length} saison${seasons.length > 1 ? "s" : ""}` }));
    seasonsBox.append(el("div", { class: "detail-season-list" }, seasons.map((season) => el("button", {
      type: "button", class: "chip",
      onclick: () => { closeModal(); openAnime(anime, { seasonSlug: season.slug }); },
    }, season.label))));
  } catch (err) {
    clear(seasonsBox);
    seasonsBox.append(el("p", { class: "hint", text: describeError(err) }));
  }
}

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
  must("#searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(searchInput.value);
  });

  must("#browseHomeBtn").addEventListener("click", goHome);

  // Échap vide la recherche en cours de saisie, comme sur les plateformes.
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { searchInput.value = ""; searchInput.blur(); }
  });

  filterInput.addEventListener("input", debounce(() => { discover.limit = 60; renderDiscover(); }, 140));

  sortSelect.addEventListener("change", renderDiscover);

  favOnlyToggle.addEventListener("change", renderDiscover);
}
