/* Anime-Sama Panel — État persistant (localStorage) et migration de l'ancien panel. */
import { clamp, DEFAULT_SETTINGS, HISTORY_MAX, LEGACY_KEY, slugify, STORE_KEY } from "./core.js";
import { notify } from "./ui.js";
import { seasonSlug } from "./api.js";

export const safeStorage = {
  warned: false,
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch {
      if (!this.warned) {
        this.warned = true;
        notify("Le navigateur refuse d'enregistrer les données (mode privé ou quota atteint). La session fonctionne, mais rien ne sera conservé.", { type: "warn", title: "Sauvegarde impossible", timeout: 9000 });
      }
      return false;
    }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignoré */ } },
};

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  favorites: [],
  history: [],
  progress: {},
  // Jaquettes retenues par identifiant d'anime. Favoris, historique et
  // reprises ne stockent que du texte : sans ce répertoire, les trois
  // surfaces où l'on juge une plateforme n'auraient aucune image. On n'y
  // écrit que ce que l'utilisateur touche vraiment, pas les 4000 fiches
  // du catalogue.
  covers: {},
  meta: { migrated: false },
};

export const COVERS_MAX = 600;

export function loadState() {
  let parsed = null;
  try { parsed = JSON.parse(safeStorage.get(STORE_KEY) || "null"); } catch { parsed = null; }
  if (parsed && typeof parsed === "object") {
    state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
    state.favorites = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    state.history   = Array.isArray(parsed.history) ? parsed.history : [];
    state.progress  = (parsed.progress && typeof parsed.progress === "object") ? parsed.progress : {};
    state.covers    = (parsed.covers && typeof parsed.covers === "object") ? parsed.covers : {};
    state.meta      = { migrated: false, ...(parsed.meta || {}) };
  }
  state.settings.timeout = clamp(Number(state.settings.timeout) || 45, 3, 600);
  if (!["dark", "abyss", "light"].includes(state.settings.theme)) state.settings.theme = "dark";
  if (!["auto", "video", "iframe"].includes(state.settings.mode)) state.settings.mode = "auto";
  migrateLegacy();
}

/** Récupère l'historique et la progression de l'ancien fichier preview.html. */
function migrateLegacy() {
  if (state.meta.migrated) return;
  let old = null;
  try { old = JSON.parse(safeStorage.get(LEGACY_KEY) || "null"); } catch { old = null; }
  state.meta.migrated = true;
  if (!old || typeof old !== "object") { persist(); return; }

  let imported = 0;
  if (old.prefs && typeof old.prefs.api === "string" && old.prefs.api.trim()) {
    state.settings.api = old.prefs.api.trim();
  }
  for (const entry of (Array.isArray(old.history) ? old.history : [])) {
    const title = String(entry?.title || "").trim();
    if (!title) continue;
    state.history.push({
      id: cryptoId(),
      animeId: slugify(title),
      title,
      seasonLabel: String(entry.season || "Saison 1"),
      seasonSlug: seasonSlug(String(entry.season || "Saison 1"), null),
      episode: Number(entry.episode) || 1,
      version: String(entry.version || "vostfr"),
      at: Date.parse(entry.at) || Date.now(),
    });
    imported++;
  }
  for (const value of Object.values(old.progress || {})) {
    const title = String(value?.title || "").trim();
    if (!title || !Number.isFinite(Number(value.episode))) continue;
    const slug = seasonSlug(String(value.season || "Saison 1"), null);
    const version = String(value.version || "vostfr");
    const key = progressKey(slugify(title), slug, version);
    const entry = state.progress[key] || (state.progress[key] = {
      animeId: slugify(title), title, animeUrl: null,
      seasonLabel: String(value.season || "Saison 1"), seasonSlug: slug, version,
      lastEpisode: null, episodes: {}, updatedAt: 0,
    });
    entry.lastEpisode = Number(value.episode);
    if (Number(value.currentTime) > 0) {
      entry.episodes[entry.lastEpisode] = {
        t: Math.floor(Number(value.currentTime)),
        d: Math.floor(Number(value.duration) || 0),
      };
    }
    entry.updatedAt = Math.max(entry.updatedAt, Date.parse(value.savedAt) || 0);
    imported++;
  }
  state.history.sort((a, b) => b.at - a.at);
  state.history = state.history.slice(0, HISTORY_MAX);
  persist();
  if (imported) {
    notify(`${imported} entrée(s) reprises depuis l'ancienne version du panel.`, { type: "success", title: "Données importées" });
  }
}

export function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = 0;
  safeStorage.set(STORE_KEY, JSON.stringify({
    settings: state.settings,
    favorites: state.favorites,
    history: state.history,
    progress: state.progress,
    covers: state.covers,
    meta: state.meta,
  }));
}

let persistTimer = 0;
/** Regroupe les écritures rapprochées ; persistNow() force l'enregistrement. */
export function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 250);
}

export function cryptoId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function progressKey(animeId, slug, version) { return `${animeId}::${slug}::${version}`; }
