/* Anime-Sama Panel — Favoris, reprise et historique. */
import { $, clamp, clear, el, HISTORY_MAX, icon, must, relTime } from "./core.js";
import { posterBox } from "./covers.js";
import { cryptoId, persist, state } from "./store.js";
import { confirmDialog, navigate, notify } from "./ui.js";
import { animeCard, emptyState, renderDiscover } from "./discover.js";
import { animeFromFavorite, animeFromProgress } from "./home.js";
import { openAnime } from "./episodes.js";
import { player } from "./player.js";

const favoritesGrid = must("#favoritesGrid");
const historyList   = must("#historyList");
const continueGrid  = must("#continueGrid");
const continueTitle = must("#continueTitle");

export function recordHistory(episodeNumber) {
  if (!player.anime || !player.season) return;
  const item = {
    id: cryptoId(),
    animeId: player.anime.id,
    title: player.anime.title,
    animeUrl: player.anime.url || null,
    seasonLabel: player.season.label,
    seasonSlug: player.season.slug,
    version: player.version,
    episode: Number(episodeNumber),
    at: Date.now(),
  };
  state.history = [item, ...state.history.filter((h) => !(
    h.animeId === item.animeId && h.seasonSlug === item.seasonSlug &&
    h.version === item.version && h.episode === item.episode
  ))].slice(0, HISTORY_MAX);
  persist();
}

function resumeFrom(entry, { seek = null } = {}) {
  openAnime(
    { id: entry.animeId, title: entry.title, url: entry.animeUrl || null },
    {
      seasonSlug: entry.seasonSlug,
      seasonLabel: entry.seasonLabel,
      version: entry.version,
      episode: entry.episode ?? entry.lastEpisode,
      seek,
      autoplay: true,
    },
  );
}

export function renderFavorites() {
  clear(favoritesGrid);
  if (!state.favorites.length) {
    favoritesGrid.append(emptyState({
      glyph: "star",
      title: "Ta liste est vide",
      text: "Survole une affiche et touche l'étoile, ou utilise « Ma liste » dans la fiche d'un anime.",
      action: { label: "Parcourir", onClick: () => navigate("discover") },
    }));
    return;
  }

  const items = state.favorites.slice();
  if ($("#favSort").value === "az") items.sort((a, b) => a.title.localeCompare(b.title, "fr"));
  else items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  const fragment = document.createDocumentFragment();
  items.forEach((fav, index) => fragment.append(animeCard({ ...animeFromFavorite(fav), index })));
  favoritesGrid.append(fragment);
}

/** Carte « Reprendre » : vignette paysage, épisode et temps restant. Un
    clic n'importe où sur l'image relance la lecture à la seconde près. */
export function continueCard(entry) {
  const saved = entry.episodes?.[entry.lastEpisode];
  const ratio = saved?.d ? clamp(saved.t / saved.d, 0, 1) : 0;
  const left = saved?.d && !saved.done ? Math.max(1, Math.round((saved.d - saved.t) / 60)) : null;
  const resume = () => resumeFrom(
    { ...entry, episode: entry.lastEpisode },
    { seek: saved?.done ? null : saved?.t ?? null });

  const thumb = posterBox(animeFromProgress(entry), {
    className: "poster-wide",
    extra: [
      el("button", { type: "button", class: "card-hit", tabindex: "-1", "aria-hidden": "true", onclick: resume }),
      el("div", { class: "poster-scrim", "aria-hidden": "true" }),
      el("button", {
        type: "button", class: "btn btn-primary play-fab",
        title: "Reprendre", "aria-label": `Reprendre ${entry.title}, épisode ${entry.lastEpisode}`,
        onclick: resume,
      }, icon("play")),
      el("span", { class: "poster-tag", text: `É${entry.lastEpisode}` }),
      el("div", { class: "poster-bar" }, el("i", { style: { width: `${Math.max(ratio, .02) * 100}%` } })),
    ],
  });

  return el("article", { class: "card wide-card", dataset: { id: entry.animeId } }, [
    thumb,
    el("h3", { class: "card-title", text: entry.title }),
    el("p", { class: "card-sub" }, [
      el("span", { text: `${entry.seasonLabel} · Épisode ${entry.lastEpisode}` }),
      left ? el("span", { class: "card-sub-accent", text: ` · ${left} min restantes` }) : null,
      el("span", { text: ` · ${relTime(entry.updatedAt)}` }),
    ]),
  ]);
}

export function renderContinue() {
  clear(continueGrid);
  const entries = Object.values(state.progress)
    .filter((e) => e.lastEpisode != null)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 8);

  continueTitle.hidden = entries.length === 0;
  if (!entries.length) return;

  const fragment = document.createDocumentFragment();
  for (const entry of entries) fragment.append(continueCard(entry));
  continueGrid.append(fragment);
}

export function renderHistory() {
  clear(historyList);
  if (!state.history.length) {
    historyList.append(emptyState({
      glyph: "clock",
      title: "Historique vide",
      text: "Les épisodes lancés depuis ce navigateur apparaîtront ici.",
      action: { label: "Chercher un anime", onClick: () => navigate("discover") },
    }));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of state.history.slice(0, 60)) {
    fragment.append(el("div", { class: "row" }, [
      el("div", { class: "row-thumb", "aria-hidden": "true" },
        posterBox({ id: item.animeId, title: item.title, cover: state.covers[item.animeId] || null })),
      el("div", { class: "row-main" }, [
        el("p", { class: "row-title", text: item.title }),
        el("p", { class: "row-sub", text: `${item.seasonLabel} · Épisode ${item.episode} · ${String(item.version).toUpperCase()} · ${relTime(item.at)}` }),
      ]),
      el("div", { class: "row-actions" }, [
        el("button", {
          type: "button", class: "btn btn-ghost btn-sm",
          onclick: () => resumeFrom(item),
        }, [icon("play"), el("span", { text: "Reprendre" })]),
        el("button", {
          type: "button", class: "icon-btn icon-btn-sm", "aria-label": `Supprimer ${item.title} de l'historique`, title: "Supprimer",
          onclick: () => {
            state.history = state.history.filter((h) => h.id !== item.id);
            persist();
            renderHistory();
          },
        }, icon("close")),
      ]),
    ]));
  }
  historyList.append(fragment);
}

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
  must("#favSort").addEventListener("change", renderFavorites);

  must("#clearHistoryBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Effacer l'historique ?",
      message: "L'historique et toutes les positions de lecture enregistrées seront supprimés. Ma liste et les réglages sont conservés.",
      confirmLabel: "Tout effacer",
      danger: true,
    });
    if (!ok) return;
    state.history = [];
    state.progress = {};
    persist();
    renderHistory();
    renderContinue();
    renderDiscover();
    notify("Historique et progression effacés.", { type: "success" });
  });
}
