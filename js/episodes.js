/* Anime-Sama Panel — Épisodes : ouverture d'une série, chargement intelligent, cache des épisodes résolus. */
import { $$, clamp, clear, el, icon, safeUrl } from "./core.js";
import { rememberCover } from "./covers.js";
import { persist, safeStorage, state } from "./store.js";
import { navigate, notify } from "./ui.js";
import { animeIdFrom, ApiError, describeError, invalidate, source } from "./api.js";
import { emptyState } from "./discover.js";
import {
  ensureOption, episodeCount, episodeList, fillSources, modeSelect, mountSource, playEpisode,
  player, progressEntry, resumeBanner, seasonSelect, setNote, showResumeBanner, sourceSelect,
  updatePlayerHeader, versionSelect
} from "./player.js";
import { recordHistory, renderContinue, renderHistory } from "./library.js";
import { setApiStatus } from "./settings.js";

/* ─────────────────────────────────────────────
   Épisodes résolus, conservés d'une visite à l'autre

   Résoudre une saison coûte une à plusieurs requêtes par épisode vers les
   hébergeurs vidéo : c'est, de loin, l'attente la plus longue du panel. Le
   serveur garde déjà ses résultats six heures, mais sur une instance
   gratuite qui s'endort au bout de quinze minutes ce cache est froid la
   plupart du temps — et le cache mémoire du navigateur, lui, disparaît à
   chaque rechargement de page.

   D'où ce magasin : rouvrir une saison déjà vue redevient instantané, sans
   une seule requête. Les liens des hébergeurs finissant par expirer, il est
   à la fois daté et auto-réparant — une lecture qui échoue efface l'entrée,
   et la fois suivante repart d'une résolution fraîche.
   ───────────────────────────────────────────── */
export const RESOLVED_KEY = "animeSamaPanel.resolved.v1";
const RESOLVED_TTL = 12 * 3600 * 1000;    // au-delà, les liens sont trop incertains
const RESOLVED_MAX = 40;                  // saisons conservées, les plus anciennes partent

export function seasonKey(anime, slug, version) { return `${anime?.id}::${slug}::${version}`; }

function readResolvedStore() {
  try {
    const raw = JSON.parse(safeStorage.get(RESOLVED_KEY) || "null");
    return (raw && typeof raw === "object") ? raw : {};
  } catch { return {}; }
}

function readResolved(key) {
  const entry = readResolvedStore()[key];
  if (!entry || !Array.isArray(entry.episodes)) return null;
  if (Date.now() - (entry.at || 0) > RESOLVED_TTL) return null;
  // Une saison partielle ne sert à rien : elle laisserait des boutons
  // « non résolus » sans qu'aucun chargement de fond ne soit lancé.
  if (entry.episodes.length < (entry.count || 0)) return null;
  return entry;
}

function writeResolved(key, episodes, count) {
  if (!key || !episodes?.length) return;
  const store = readResolvedStore();
  store[key] = { at: Date.now(), count: count || episodes.length, episodes };
  const keys = Object.keys(store);
  if (keys.length > RESOLVED_MAX) {
    for (const old of keys.sort((a, b) => (store[a].at || 0) - (store[b].at || 0))
                          .slice(0, keys.length - RESOLVED_MAX)) {
      delete store[old];
    }
  }
  safeStorage.set(RESOLVED_KEY, JSON.stringify(store));
}

export function dropResolved(key) {
  const store = readResolvedStore();
  if (!(key in store)) return;
  delete store[key];
  safeStorage.set(RESOLVED_KEY, JSON.stringify(store));
}

export async function openAnime(anime, options = {}) {
  rememberCover(anime);
  if (!anime?.title) return;
  const token = ++player.token;
  player.anime = {
    id: anime.id || animeIdFrom(anime.title, anime.url),
    title: anime.title,
    url: safeUrl(anime.url) || null,
  };
  player.version = options.version || state.settings.version;
  player.mode = state.settings.mode;
  ensureOption(versionSelect, player.version);
  modeSelect.value = player.mode;
  setNote("");
  resumeBanner.hidden = true;
  navigate("player");
  updatePlayerHeader();
  renderEpisodes("loading");

  let seasons = [];
  try {
    seasons = await source.seasons(player.anime);
  } catch (err) {
    if (token !== player.token) return;
    setNote(`Saisons indisponibles : ${describeError(err)} — le panel suppose une saison unique.`);
  }
  if (token !== player.token) return;

  if (!seasons.length) seasons = [{ label: "Saison 1", slug: "saison1", url: null }];
  if (options.seasonSlug && !seasons.some((s) => s.slug === options.seasonSlug)) {
    seasons = [...seasons, { label: options.seasonLabel || options.seasonSlug, slug: options.seasonSlug, url: null }];
  }
  player.seasons = seasons;

  clear(seasonSelect);
  for (const season of seasons) seasonSelect.append(el("option", { value: season.slug, text: season.label }));
  player.season = seasons.find((s) => s.slug === options.seasonSlug) || seasons[0];
  seasonSelect.value = player.season.slug;

  updatePlayerHeader();
  await loadEpisodes({ episode: options.episode ?? null, seek: options.seek ?? null, autoplay: options.autoplay !== false && options.episode != null });
}

/** Insère ou remplace un épisode dans `player.episodes`, en gardant l'ordre. */
function mergeEpisode(episode) {
  const index = player.episodes.findIndex((e) => e.number === episode.number);
  if (index >= 0) player.episodes[index] = episode;
  else {
    player.episodes.push(episode);
    player.episodes.sort((a, b) => a.number - b.number);
  }
}

/** Résout discrètement l'épisode suivant pendant qu'on regarde le courant.

    Sans ça, l'enchaînement automatique en fin d'épisode déclenche une
    résolution à la demande — quelques secondes d'écran noir au pire moment.
    Une seule requête, aucun retour visuel : si elle échoue, le clic normal
    reprendra la main comme avant. */
function prefetchNext(number) {
  if (source.isDemo || !player.anime || !player.season) return;
  const next = number + 1;
  if (next >= player.episodeCount) return;                     // fin de saison
  if (player.episodes.some((e) => e.number === next)) return;   // déjà connu
  if (player.resolvingEpisodes.has(next)) return;

  const token = player.token;
  const anime = player.anime, slug = player.season.slug, version = player.version;
  source.episode(anime, slug, version, next)
    .then((result) => {
      if (token !== player.token || result.degraded || !result.episode) return;
      mergeEpisode(result.episode);
      renderEpisodes(episodesStatus());
    })
    .catch(() => { /* simple confort : un échec ne doit rien changer */ });
}

/** Résout le reste de la saison en tâche de fond, sans bloquer l'affichage.
    Réutilise l'appel habituel (inchangé, toujours en cache côté serveur) :
    même travail que par le passé, seulement réordonné dans le temps. */
function warmFullSeason(token) {
  const anime = player.anime, season = player.season, version = player.version;
  source.episodes(anime, season.slug, version)
    .then((episodes) => {
      if (token !== player.token) return;
      player.episodes = episodes;
      player.episodeCount = episodes.length;
      // Conservé pour les visites suivantes : c'est ce qui rend la
      // réouverture d'une saison déjà vue immédiate.
      if (!source.isDemo) writeResolved(seasonKey(anime, season.slug, version), episodes, episodes.length);
      renderEpisodes(episodes.length ? "ok" : "empty");
    })
    .catch((err) => {
      if (token !== player.token) return;
      // L'épisode déjà résolu reste jouable ; seuls les autres boutons
      // restent "à tenter au clic" plutôt que garantis disponibles.
      notify(`Le reste de la saison n'a pas pu être chargé en fond : ${describeError(err)}`,
        { type: "warn", title: "Chargement partiel", timeout: 7000 });
    });
}

export async function loadEpisodes({ episode = null, seek = null, autoplay = false, force = false } = {}) {
  if (!player.anime || !player.season) return;
  const token = ++player.token;
  player.episodes = [];
  player.episodeCount = 0;
  player.resolvingEpisodes = new Set();
  player.pendingPlay = null;
  renderEpisodes("loading");

  const key = seasonKey(player.anime, player.season.slug, player.version);
  if (force) {
    invalidate(`episodes:${player.anime.title}:${player.season.slug}:${player.version}`);
    dropResolved(key);
  }

  // Chargement intelligent : on résout d'abord la cible probable (reprise de
  // lecture, ou premier épisode) plutôt que d'attendre toute la saison. Le
  // décompte total arrive dans la même réponse, donc les boutons s'affichent
  // dès ce premier aller-retour — voir source.episode().
  const saved = progressEntry(false);
  const target = Number(episode ?? saved?.lastEpisode ?? 0);

  // Saison déjà résolue lors d'une visite précédente : aucune requête, la
  // liste est complète immédiatement. C'est le cas le plus fréquent dès qu'on
  // revient sur une série commencée.
  const stored = (!force && !source.isDemo) ? readResolved(key) : null;
  if (stored) {
    player.episodes = stored.episodes;
    player.episodeCount = stored.count;
    renderEpisodes("ok");
    const known = player.episodes.find((e) => e.number === target);
    if (known) {
      if (autoplay) playResolvedEpisode(known, { seek });
      else selectEpisode(target);
    }
    return;
  }

  let degraded = false;
  try {
    const result = await source.episode(player.anime, player.season.slug, player.version, target, {
      onPending: ({ elapsed }) => {
        if (token === player.token) renderEpisodes("loading", "", elapsed);
      },
    });
    if (token !== player.token) return;

    degraded = result.degraded;
    if (degraded) {
      player.episodes = result.episodes;
      player.episodeCount = result.episodes.length;
      if (!source.isDemo) writeResolved(key, result.episodes, result.episodes.length);
    } else {
      player.episodeCount = result.count;
      if (result.episode) mergeEpisode(result.episode);
    }
  } catch (err) {
    if (token !== player.token) return;
    player.episodes = [];
    player.episodeCount = 0;
    renderEpisodes("error", describeError(err));
    setApiStatus(err instanceof ApiError && err.kind === "network" ? "offline" : null);
    return;
  }
  if (token !== player.token) return;

  setApiStatus(source.isDemo ? "demo" : "online");

  if (!player.episodeCount) {
    renderEpisodes("empty");
    return;
  }

  // « ok » si la saison est déjà entière (dégradé, ou tout juste chargée par
  // le fond), « partial » si seule la cible est connue pour l'instant.
  renderEpisodes(episodesStatus());

  const found = player.episodes.find((e) => e.number === target);
  if (found) {
    if (autoplay) playResolvedEpisode(found, { seek });
    else selectEpisode(target);
  }
  // Sinon : la cible demandée n'existe pas pour cette version (ex. reprise
  // sur un numéro qui n'y figure plus). Les boutons restent utilisables ;
  // aucune lecture automatique tant que l'utilisateur n'en choisit pas un.

  if (!degraded) warmFullSeason(token);
}

/** Comme `resolveEpisodePriority`, mais synchrone : l'épisode est déjà connu. */
export function playResolvedEpisode(episode, { seek = null, sourceIndex = 0 } = {}) {
  player.episode = episode;
  fillSources(episode);
  sourceSelect.value = String(clamp(sourceIndex, 0, episode.sources.length - 1));
  resumeBanner.hidden = true;

  const entry = progressEntry(true);
  entry.lastEpisode = episode.number;
  entry.updatedAt = Date.now();
  recordHistory(episode.number);
  persist();

  mountSource(episode.sources[Number(sourceSelect.value)], { seek });
  renderEpisodeStates();
  updatePlayerHeader();
  renderHistory();
  renderContinue();
  prefetchNext(episode.number);
}

/** "ok" une fois tous les épisodes connus, "partial" tant qu'il en manque. */
function episodesStatus() {
  return player.episodes.length >= player.episodeCount ? "ok" : "partial";
}

/** Résout un épisode qui n'est pas encore dans `player.episodes` (bouton
    cliqué avant la fin du chargement de fond), puis le joue si c'est
    toujours ce que l'utilisateur attend une fois la réponse arrivée.

    Reconstruit toute la liste à chaque changement d'état (plutôt que de se
    contenter de `renderEpisodeStates()`) : les classes `is-resolving` et le
    spinner qui l'accompagne n'existent que sur les boutons fraîchement créés
    par `renderEpisodes()`, pas sur ceux déjà présents dans le DOM. */
export async function resolveEpisodePriority(number, { seek = null, sourceIndex = 0, autoplay = false } = {}) {
  if (!player.anime || !player.season) return;
  const token = player.token;
  if (autoplay) player.pendingPlay = number;

  if (player.resolvingEpisodes.has(number)) { renderEpisodes(episodesStatus()); return; }
  player.resolvingEpisodes.add(number);
  renderEpisodes(episodesStatus());

  let result;
  try {
    result = await source.episode(player.anime, player.season.slug, player.version, number);
  } catch (err) {
    if (token !== player.token) return;
    player.resolvingEpisodes.delete(number);
    renderEpisodes(episodesStatus());
    notify(`Impossible de résoudre l'épisode ${number} : ${describeError(err)}`,
      { type: "error", title: "Épisode indisponible" });
    return;
  }
  if (token !== player.token) return;
  player.resolvingEpisodes.delete(number);

  if (result.degraded) {
    player.episodes = result.episodes;
    player.episodeCount = result.episodes.length;
  } else {
    player.episodeCount = result.count;
    if (result.episode) mergeEpisode(result.episode);
  }
  renderEpisodes(episodesStatus());

  if (player.pendingPlay !== number) return;   // l'utilisateur a cliqué ailleurs entre-temps
  player.pendingPlay = null;
  const found = player.episodes.find((e) => e.number === number);
  if (found) playResolvedEpisode(found, { seek, sourceIndex });
  else notify(`L'épisode ${number} n'est pas disponible dans « ${player.season?.label ?? "cette saison"} » en ${player.version.toUpperCase()}.`,
    { type: "error", title: "Épisode introuvable" });
}

function selectEpisode(number) {
  const episode = player.episodes.find((e) => e.number === Number(number));
  if (!episode) return;
  player.episode = episode;
  fillSources(episode);
  renderEpisodeStates();
  updatePlayerHeader();
  showResumeBanner(episode);
}

export function renderEpisodes(status, message = "", elapsed = 0) {
  clear(episodeList);
  episodeCount.hidden = true;

  if (status === "loading") {
    // Le serveur résout l'URL vidéo de chaque épisode : c'est long la première
    // fois, instantané ensuite grâce au cache partagé. Sans ce compteur,
    // l'attente ressemble à un blocage.
    if (elapsed > 3) {
      episodeList.append(el("p", { class: "hint ep-progress" },
        `Résolution des épisodes chez les hébergeurs… ${Math.round(elapsed)} s. ` +
        "Le premier chargement d'une saison est long ; les suivants seront immédiats."));
    }
    for (let i = 0; i < 6; i++) episodeList.append(el("div", { class: "skeleton skeleton-ep" }));
    return;
  }
  if (status === "error") {
    episodeList.append(emptyState({
      glyph: "alert", tone: "error", title: "Épisodes indisponibles", text: message,
      action: { label: "Réessayer", onClick: () => loadEpisodes({ force: true }) },
    }));
    return;
  }
  if (status === "idle") {
    episodeList.append(el("p", { class: "hint", text: "Aucune série ouverte. Choisis un anime depuis « Découvrir »." }));
    return;
  }
  if (status === "empty") {
    episodeList.append(emptyState({
      glyph: "info",
      title: "Aucun épisode",
      text: `L'API n'a renvoyé aucun lien pour « ${player.season?.label ?? ""} » en ${player.version.toUpperCase()}. Cette version n'existe peut-être pas pour cette saison : essaie VF ou VOSTFR.`,
    }));
    return;
  }

  // « ok » : tout est connu, on affiche exactement ce qui a été résolu.
  // « partial » (chargement intelligent) : le nombre total est connu mais pas
  // encore chaque lien — les boutons non résolus restent cliquables, un clic
  // déclenche leur résolution prioritaire (voir resolveEpisodePriority).
  const total = status === "partial" ? player.episodeCount : player.episodes.length;
  episodeCount.textContent = String(total);
  episodeCount.hidden = false;

  const known = new Map(player.episodes.map((e) => [e.number, e]));
  const numbers = status === "partial"
    ? Array.from({ length: total }, (_, i) => i)
    : player.episodes.map((e) => e.number);

  const entry = progressEntry(false);
  const fragment = document.createDocumentFragment();
  for (const number of numbers) {
    const episode = known.get(number);
    const resolving = player.resolvingEpisodes.has(number);
    const saved = entry?.episodes?.[number];
    const ratio = saved?.d ? clamp(saved.t / saved.d, 0, 1) : 0;

    const button = el("button", {
      type: "button",
      class: `episode${resolving ? " is-resolving" : ""}${!episode && !resolving ? " is-unresolved" : ""}`,
      dataset: { episode: String(number) },
      "aria-busy": resolving ? "true" : null,
      title: !episode && !resolving ? "Pas encore chargé : cliquer pour le résoudre" : null,
      onclick: () => playEpisode(number, { seek: saved && !saved.done ? saved.t : null }),
    }, [
      el("span", { class: "ep-num", text: String(number) }),
      el("span", { class: "ep-label", text: episode?.label || `Épisode ${number}` }),
      resolving ? el("span", { class: "spinner spinner-sm ep-spinner", "aria-hidden": "true" }) : null,
      episode && saved?.done ? icon("check", "ep-check") : null,
      episode && ratio > 0.02 && ratio < 0.95 ? el("i", { class: "ep-bar", style: { width: `${ratio * 100}%` } }) : null,
    ]);
    fragment.append(button);
  }
  episodeList.append(fragment);
  renderEpisodeStates();
}

export function renderEpisodeStates() {
  const entry = progressEntry(false);
  for (const node of $$(".episode", episodeList)) {
    const number = Number(node.dataset.episode);
    node.classList.toggle("is-current", player.episode?.number === number);
    node.classList.toggle("is-watched", !!entry?.episodes?.[number]?.done);
  }
  const current = episodeList.querySelector(".episode.is-current");
  if (current) current.scrollIntoView({ block: "nearest" });
}
