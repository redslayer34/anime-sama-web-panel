/* Anime-Sama Panel — Lecteur : HLS, MP4 ou iframe, bascule vers le relais, contrôles, progression. */
import {
  $, clamp, clear, DEFAULT_SETTINGS, el, formatTime, must, relayUrl, safeUrl, SAVE_EVERY
} from "./core.js";
import { persist, progressKey, state } from "./store.js";
import { notify } from "./ui.js";
import { source } from "./api.js";
import { isFavorite, showAnimeDetails, toggleFavorite } from "./discover.js";
import {
  dropResolved, loadEpisodes, playResolvedEpisode, renderEpisodeStates, resolveEpisodePriority,
  seasonKey
} from "./episodes.js";

export const video          = must("#video");
const frame          = must("#frame");
const playerStage    = must("#playerStage");
const placeholder    = must("#playerPlaceholder");
const stageLoader    = must("#stageLoader");
const formatBadge    = must("#formatBadge");
const nowTitle       = must(".now-title");
const nowMeta        = must("#nowMeta");
const playerNote     = must("#playerNote");
export const seasonSelect   = must("#seasonSelect");
export const versionSelect  = must("#versionSelect");
export const modeSelect     = must("#modeSelect");
export const sourceSelect   = must("#sourceSelect");
const sourceField    = must("#sourceField");
export const episodeList    = must("#episodeList");
export const episodeCount   = must("#episodeCount");
export const resumeBanner   = must("#resumeBanner");
const resumeText     = must("#resumeText");
const favCurrentBtn  = must("#favCurrentBtn");

export const player = {
  token: 0,
  anime: null,
  seasons: [],
  season: null,
  version: DEFAULT_SETTINGS.version,
  mode: DEFAULT_SETTINGS.mode,
  episodes: [],
  episode: null,
  sources: [],
  current: null,
  kind: null,
  hls: null,
  pendingSeek: null,
  lastSaved: 0,
  recovered: false,
  relayed: false,        // la source courante passe-t-elle par le relais ?
  triedRelay: false,     // pour ne basculer qu'une fois par source

  // Chargement intelligent : le nombre total d'épisodes est connu avant que
  // `episodes` soit complet (voir loadEpisodes/resolveEpisodePriority).
  episodeCount: 0,
  resolvingEpisodes: new Set(),  // numéros en cours de résolution prioritaire
  pendingPlay: null,             // dernier épisode cliqué, à lancer dès prêt
};

export function setNote(message) {
  if (!message) { playerNote.hidden = true; playerNote.textContent = ""; return; }
  playerNote.textContent = message;
  playerNote.hidden = false;
}

function setStageLoading(active) { stageLoader.hidden = !active; }

export function ensureOption(select, value, label) {
  if (!value) return;
  if (!Array.from(select.options).some((option) => option.value === value)) {
    select.append(el("option", { value, text: label || value.toUpperCase() }));
  }
  select.value = value;
}

export function updatePlayerHeader() {
  if (!player.anime) return;
  // La série au-dessus, en lien vers sa fiche ; l'épisode en titre.
  const series = must("#nowSeries");
  series.textContent = player.anime.title;
  series.hidden = false;
  nowTitle.textContent = player.episode ? `Épisode ${player.episode.number}` : player.anime.title;
  const parts = [player.season?.label, player.version?.toUpperCase()].filter(Boolean);
  if (source.isDemo) parts.push("MODE DÉMO");
  nowMeta.textContent = parts.join(" · ") || "—";
  favCurrentBtn.hidden = false;
  const nowPlaying = must("#nowPlayingBtn");
  must("#nowPlayingTitle").textContent = player.episode
    ? `${player.anime.title} · É${player.episode.number}`
    : player.anime.title;
  nowPlaying.title = `Revenir au lecteur : ${player.anime.title}`;
  nowPlaying.hidden = false;
  updatePlayerFavButton();
}

export function updatePlayerFavButton() {
  if (!player.anime) return;
  const active = isFavorite(player.anime.id);
  favCurrentBtn.classList.toggle("is-on", active);
  favCurrentBtn.setAttribute("aria-pressed", String(active));
  favCurrentBtn.title = active ? "Retirer de ma liste" : "Ajouter à ma liste";
  favCurrentBtn.setAttribute("aria-label", favCurrentBtn.title);
}

export function progressEntry(create = false) {
  if (!player.anime || !player.season) return null;
  const key = progressKey(player.anime.id, player.season.slug, player.version);
  let entry = state.progress[key];
  if (!entry && create) {
    entry = state.progress[key] = {
      animeId: player.anime.id,
      title: player.anime.title,
      animeUrl: player.anime.url || null,
      seasonLabel: player.season.label,
      seasonSlug: player.season.slug,
      version: player.version,
      lastEpisode: null,
      episodes: {},
      updatedAt: Date.now(),
    };
  }
  return entry || null;
}

export function showResumeBanner(episode) {
  const entry = progressEntry(false);
  const saved = entry?.episodes?.[episode.number];
  if (!state.settings.remember || !saved || saved.t < 20 || (saved.d && saved.t > saved.d - 25)) {
    resumeBanner.hidden = true;
    return;
  }
  resumeText.textContent = `Épisode ${episode.number} : reprendre à ${formatTime(saved.t)}${saved.d ? ` / ${formatTime(saved.d)}` : ""}`;
  resumeBanner.hidden = false;
  resumeBanner.dataset.seek = String(saved.t);
  resumeBanner.dataset.episode = String(episode.number);
}

export function fillSources(episode) {
  player.sources = episode.sources;
  clear(sourceSelect);
  episode.sources.forEach((url, index) => {
    let label = `Source ${index + 1}`;
    try { label = `${index + 1}. ${new URL(url).hostname.replace(/^www\./, "")}`; } catch { /* libellé par défaut */ }
    sourceSelect.append(el("option", { value: String(index), text: label }));
  });
  sourceSelect.value = "0";
  sourceField.hidden = episode.sources.length < 2;
}

export function playEpisode(number, { seek = null, sourceIndex = 0 } = {}) {
  const num = Number(number);
  const episode = player.episodes.find((e) => e.number === num);
  if (episode) { playResolvedEpisode(episode, { seek, sourceIndex }); return; }

  // Pas encore résolu (chargement intelligent en cours) : on le demande en
  // priorité au lieu d'échouer, pendant que le reste continue en fond.
  if (player.episodeCount && (num < 0 || num >= player.episodeCount)) {
    notify(`L'épisode ${number} n'est pas disponible dans « ${player.season?.label ?? "cette saison"} » en ${player.version.toUpperCase()}.`,
      { type: "error", title: "Épisode introuvable" });
    return;
  }
  resolveEpisodePriority(num, { seek, sourceIndex, autoplay: true });
}

function teardown() {
  if (player.hls) { try { player.hls.destroy(); } catch { /* déjà détruit */ } player.hls = null; }
  try { video.pause(); } catch { /* lecture non démarrée */ }
  video.removeAttribute("src");
  try { video.load(); } catch { /* ignoré */ }
  video.hidden = true;
  if (frame.getAttribute("src")) frame.setAttribute("src", "about:blank");
  frame.removeAttribute("src");
  frame.hidden = true;
  player.kind = null;
  player.recovered = false;
  setStageLoading(false);
}

function mountIframe(url) {
  frame.hidden = false;
  frame.setAttribute("src", url);
  player.kind = "iframe";
  formatBadge.textContent = "Lecteur externe";
  setNote("Le lecteur externe est isolé dans une iframe : les pop-ups publicitaires sont bloqués. Si la vidéo refuse de démarrer, certains hébergeurs interdisent l'intégration — utilise alors « Ouvrir la source ».");
}

export function mountSource(url, { seek = null, relay = null } = {}) {
  const wasRelayed = relay === null ? (state.settings.relay === "always") : relay;
  teardown();
  setNote("");
  const safe = safeUrl(url);
  if (!safe) {
    placeholder.hidden = false;
    formatBadge.textContent = "Erreur";
    setNote("L'API a renvoyé une source qui n'est pas une URL http(s) exploitable.");
    return;
  }

  player.current = safe;
  player.relayed = false;
  if (relay === null) player.triedRelay = false;
  placeholder.hidden = true;

  const isHls  = /\.m3u8(\?|#|$)/i.test(safe);
  const isFile = isHls || /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|#|$)/i.test(safe);
  const mode   = player.mode;

  if (mode === "iframe" || (mode === "auto" && !isFile)) { mountIframe(safe); return; }
  if (mode === "video" && !isFile) {
    mountIframe(safe);
    setNote("Cette source est une page de lecteur, pas un fichier vidéo : elle est affichée dans une iframe. Le mode « Vidéo intégrée » ne s'applique qu'aux fichiers MP4 / HLS.");
    return;
  }

  video.hidden = false;
  player.kind = isHls ? "hls" : "file";
  player.pendingSeek = seek;

  const relayed = wasRelayed ? relayUrl(safe) : null;
  const playable = relayed || safe;
  player.relayed = Boolean(relayed);
  formatBadge.textContent = (isHls ? "HLS" : "Vidéo") + (player.relayed ? " · relais" : "");
  setStageLoading(true);
  if (player.relayed) {
    setNote("Lecture via le serveur : l'hébergeur n'autorise pas la lecture directe depuis le navigateur.");
  }

  if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
    if (!window.Hls || !window.Hls.isSupported()) {
      setStageLoading(false);
      setNote("Ce flux HLS (.m3u8) a besoin de hls.js, qui n'a pas pu être chargé depuis le CDN. Vérifie ta connexion, ou ouvre la source dans un onglet.");
      return;
    }
    const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
    player.hls = hls;
    hls.on(window.Hls.Events.ERROR, onHlsError);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.loadSource(playable);
    hls.attachMedia(video);
  } else {
    video.setAttribute("src", playable);
  }

  video.play().catch(() => { /* la lecture automatique peut être refusée par le navigateur */ });
}

/** Rejoue la source courante à travers le relais, une seule fois.
    Retourne false si ce n'est pas possible ou déjà tenté. */
function retryThroughRelay() {
  if (player.relayed || player.triedRelay) return false;
  if (state.settings.relay === "never") return false;
  if (!player.current || player.kind === "iframe") return false;
  if (!relayUrl(player.current)) return false;

  player.triedRelay = true;
  const seek = Number.isFinite(video.currentTime) && video.currentTime > 1 ? video.currentTime : player.pendingSeek;
  notify("L'hébergeur refusait la lecture directe : l'épisode passe maintenant via le serveur.",
    { type: "info", title: "Lecture via le serveur", timeout: 5000 });
  mountSource(player.current, { seek, relay: true });
  return true;
}

function onHlsError(_event, data) {
  if (!data?.fatal) return;
  const Hls = window.Hls;
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !player.recovered) {
    player.recovered = true;
    setNote("Erreur réseau sur le flux HLS, nouvelle tentative…");
    player.hls?.startLoad();
    return;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !player.recovered) {
    player.recovered = true;
    player.hls?.recoverMediaError();
    return;
  }
  if (retryThroughRelay()) return;
  setStageLoading(false);
  setNote(player.relayed
    ? "Le flux HLS reste illisible même en passant par le serveur : le lien a probablement expiré. Recharge la liste des épisodes, ou essaie un autre hébergeur."
    : "Le flux HLS n'a pas pu être lu. Passe en mode « Page du lecteur », ou ouvre la source dans un onglet.");
}

export function saveWatchTime(finished = false) {
  if (!state.settings.remember || !player.episode || player.kind === "iframe") return;
  const time = Number(video.currentTime);
  if (!Number.isFinite(time) || time < 2) return;
  const entry = progressEntry(true);
  if (!entry) return;
  const duration = Number.isFinite(video.duration) ? Math.floor(video.duration) : 0;
  const record = entry.episodes[player.episode.number] || (entry.episodes[player.episode.number] = {});
  record.t = Math.floor(time);
  record.d = duration;
  if (finished || (duration && time / duration > 0.92)) record.done = true;
  entry.lastEpisode = player.episode.number;
  entry.updatedAt = Date.now();
  persist();
}

export function step(delta, { silent = false } = {}) {
  if (!player.episodes.length || !player.episode) {
    if (!silent) notify("Aucun épisode chargé.", { type: "warn", timeout: 3000 });
    return;
  }
  const index = player.episodes.findIndex((e) => e.number === player.episode.number);
  const next = player.episodes[index + delta];
  if (!next) {
    if (!silent) notify(delta > 0 ? "Dernier épisode de la saison." : "Premier épisode de la saison.", { type: "info", timeout: 3000 });
    return;
  }
  playEpisode(next.number);
}

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
  must("#nowSeries").addEventListener("click", () => { if (player.anime) showAnimeDetails(player.anime); });

  /* Écouteurs attachés une seule fois : pas d'accumulation entre deux épisodes. */
  video.addEventListener("loadedmetadata", () => {
    setStageLoading(false);
    if (player.pendingSeek != null && Number.isFinite(video.duration) && video.duration > 0) {
      try { video.currentTime = clamp(player.pendingSeek, 0, Math.max(0, video.duration - 3)); } catch { /* seek refusé */ }
    }
    player.pendingSeek = null;
  });

  video.addEventListener("playing", () => setStageLoading(false));

  video.addEventListener("waiting", () => setStageLoading(true));

  video.addEventListener("error", () => {
    if (retryThroughRelay()) return;
    setStageLoading(false);
    // Un lien qui ne passe même plus par le relais est périmé : on jette la
    // saison mémorisée pour que la prochaine ouverture reparte d'une
    // résolution fraîche, sans que l'utilisateur ait à y penser.
    if (player.anime && player.season) {
      dropResolved(seasonKey(player.anime, player.season.slug, player.version));
    }
    setNote(player.relayed
      ? "Même relayée par le serveur, cette source reste illisible : le lien a sans doute expiré. Recharge la liste des épisodes, ou choisis un autre hébergeur."
      : "Le navigateur n'a pas pu lire cette source (lien expiré ou format non supporté). Essaie un autre hébergeur, le mode « Page du lecteur », ou « Ouvrir la source ».");
  });

  video.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - player.lastSaved < SAVE_EVERY) return;
    player.lastSaved = now;
    saveWatchTime();
  });

  video.addEventListener("pause", saveWatchTime);

  video.addEventListener("ended", () => {
    saveWatchTime(true);
    renderEpisodeStates();
    if (state.settings.autoplay) step(1, { silent: true });
  });

  /* ── Contrôles du lecteur ── */
  seasonSelect.addEventListener("change", () => {
    player.season = player.seasons.find((s) => s.slug === seasonSelect.value) || player.season;
    updatePlayerHeader();
    loadEpisodes();
  });

  versionSelect.addEventListener("change", () => {
    player.version = versionSelect.value;
    updatePlayerHeader();
    loadEpisodes();
  });

  modeSelect.addEventListener("change", () => {
    player.mode = modeSelect.value;
    if (player.current) mountSource(player.current, { seek: player.kind !== "iframe" ? video.currentTime : null });
  });

  sourceSelect.addEventListener("change", () => {
    const url = player.sources[Number(sourceSelect.value)];
    if (url) mountSource(url);
  });

  must("#prevBtn").addEventListener("click", () => step(-1));

  must("#nextBtn").addEventListener("click", () => step(1));

  must("#reloadBtn").addEventListener("click", () => {
    if (!player.current) { notify("Aucune source chargée.", { type: "warn", timeout: 3000 }); return; }
    mountSource(player.current, { seek: player.kind !== "iframe" ? video.currentTime : null });
  });

  must("#reloadEpisodesBtn").addEventListener("click", () => loadEpisodes({ force: true }));

  must("#fullscreenBtn").addEventListener("click", () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    (playerStage.requestFullscreen?.() ?? Promise.reject()).catch(() => {
      notify("Le plein écran a été refusé par le navigateur.", { type: "warn", timeout: 3500 });
    });
  });

  must("#openSourceBtn").addEventListener("click", () => {
    const url = safeUrl(player.current);   // l'originale, pas celle du relais
    if (!url) { notify("Aucune source chargée.", { type: "warn", timeout: 3000 }); return; }
    window.open(url, "_blank", "noopener,noreferrer");
  });

  must("#autoplayToggle").addEventListener("change", (event) => {
    state.settings.autoplay = event.target.checked;
    $("#autoplaySetting").checked = event.target.checked;
    persist();
  });

  must("#resumeSeekBtn").addEventListener("click", () => {
    const episode = Number(resumeBanner.dataset.episode);
    const seek = Number(resumeBanner.dataset.seek);
    if (Number.isFinite(episode)) playEpisode(episode, { seek: Number.isFinite(seek) ? seek : null });
  });

  must("#resumeDismissBtn").addEventListener("click", () => { resumeBanner.hidden = true; });

  favCurrentBtn.addEventListener("click", () => { if (player.anime) toggleFavorite(player.anime); });
}
