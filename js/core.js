/* Anime-Sama Panel — Constantes et utilitaires partagés. */

/** Capacités annoncées par le serveur qui sert la page (voir /panel/state). */
export const panelServer = { relay: false };

export const STORE_KEY     = "animeSamaPanel.v1";
// .v2 : le cache .v1 a été écrit par une version qui jetait les jaquettes.
// Changer de clé force un rafraîchissement plutôt qu'une grille d'affiches vides.
export const CATALOGUE_KEY = "animeSamaPanel.catalogue.v2";
export const LEGACY_KEY    = "animeWebPlayer.v3";          // ancien panel mono-fichier
const SVG_NS        = "http://www.w3.org/2000/svg";

export const VIEWS = ["discover", "player", "favorites", "history", "scans", "settings"];

export const MEM_TTL       = 10 * 60 * 1000;   // cache mémoire saisons/épisodes
export const CATALOGUE_TTL = 24 * 60 * 60 * 1000;
export const CATALOGUE_MAX = 3_000_000;        // ne pas persister un catalogue trop lourd
export const HISTORY_MAX   = 120;
export const SAVE_EVERY    = 5000;             // fréquence d'enregistrement de la position
export const JOB_POLL      = 2000;             // intervalle d'interrogation d'une tâche de fond
export const JOB_MAX_WAIT  = 15 * 60 * 1000;   // au-delà, on abandonne

export const LOCAL_BACKEND = "http://127.0.0.1:5000";

export const DEFAULT_SETTINGS = {
  // Vide = même origine que la page, ce que fournit serve.py aussi bien en local
  // qu'en ligne. Pointer par défaut vers 127.0.0.1 ferait interroger son propre
  // PC à tout visiteur d'un panel hébergé.
  api: "",
  timeout: 45,
  theme: "dark",
  accent: "ember",
  motion: false,
  compact: false,
  version: "vostfr",
  mode: "auto",
  autoplay: true,
  remember: true,
  demo: false,
  relay: "auto",        // auto | always | never
};

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Construit un élément. `text` passe par textContent : aucune injection HTML possible. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    // Object.assign ne sait pas poser une propriété personnalisée
    // (`--g1`) : il faut passer par setProperty.
    else if (key === "vars") for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of (Array.isArray(children) ? children : [children])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
export function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function deaccent(str) {
  return String(str).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function slugify(str) {
  return deaccent(str).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "anime";
}

/** Seules les URL http(s) sont acceptées : bloque javascript:, data:, etc. */
export function safeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), document.baseURI);
    return (url.protocol === "http:" || url.protocol === "https:") ? url.href : null;
  } catch { return null; }
}

/** Les hébergeurs vidéo n'envoient pas d'en-tête CORS : le navigateur refuse
    alors de lire leur flux. Le faire transiter par le serveur du panel le
    ramène à une requête de même origine, et ajoute au passage le Referer que
    réclament les protections anti-hotlink. */
export function relayUrl(url) {
  // Le relais n'existe que si la page est servie par serve.py. Sur un
  // hébergement statique, tenter la bascule ne ferait qu'ajouter une requête
  // perdue et un message d'erreur trompeur.
  if (!panelServer.relay || location.protocol === "file:") return null;
  const safe = safeUrl(url);
  if (!safe) return null;
  return new URL(`stream?u=${encodeURIComponent(safe)}`, location.href).href;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const relFormatter = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const STEPS = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
export function relTime(timestamp) {
  const diff = Number(timestamp) - Date.now();
  if (!Number.isFinite(diff)) return "";
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return relFormatter.format(Math.round(diff / ms), unit);
  }
  return "à l'instant";
}

export function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function toArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["data", "results", "result", "items", "episodes", "list"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  }
  return [];
}
