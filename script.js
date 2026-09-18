/* =============================================================
   Anime-Sama Panel — logique applicative
   Client 100 % vanilla de l'API AnimeSamaApi (TMCooper).

   Sommaire
   1. Constantes            6. Navigation
   2. Utilitaires           7. Vue Découvrir
   3. Stockage local        8. Lecteur
   4. Toasts & modales      9. Favoris / Historique
   5. Couche API + démo    10. Scans, réglages, init
   ============================================================= */
(() => {
"use strict";

/* ─────────────────────────────────────────────
   1. Constantes
   ───────────────────────────────────────────── */
/** Capacités annoncées par le serveur qui sert la page (voir /panel/state). */
const panelServer = { relay: false };

const STORE_KEY     = "animeSamaPanel.v1";
// .v2 : le cache .v1 a été écrit par une version qui jetait les jaquettes.
// Changer de clé force un rafraîchissement plutôt qu'une grille d'affiches vides.
const CATALOGUE_KEY = "animeSamaPanel.catalogue.v2";
const LEGACY_KEY    = "animeWebPlayer.v3";          // ancien panel mono-fichier
const SVG_NS        = "http://www.w3.org/2000/svg";

const VIEWS = ["discover", "player", "favorites", "history", "scans", "settings"];

const MEM_TTL       = 10 * 60 * 1000;   // cache mémoire saisons/épisodes
const CATALOGUE_TTL = 24 * 60 * 60 * 1000;
const CATALOGUE_MAX = 3_000_000;        // ne pas persister un catalogue trop lourd
const HISTORY_MAX   = 120;
const SAVE_EVERY    = 5000;             // fréquence d'enregistrement de la position
const JOB_POLL      = 2000;             // intervalle d'interrogation d'une tâche de fond
const JOB_MAX_WAIT  = 15 * 60 * 1000;   // au-delà, on abandonne

const LOCAL_BACKEND = "http://127.0.0.1:5000";

const DEFAULT_SETTINGS = {
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

/* ─────────────────────────────────────────────
   2. Utilitaires
   ───────────────────────────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Construit un élément. `text` passe par textContent : aucune injection HTML possible. */
function el(tag, props = {}, children = []) {
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

function icon(name, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function deaccent(str) {
  return String(str).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function slugify(str) {
  return deaccent(str).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "anime";
}

/** Seules les URL http(s) sont acceptées : bloque javascript:, data:, etc. */
function safeUrl(value) {
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
function relayUrl(url) {
  // Le relais n'existe que si la page est servie par serve.py. Sur un
  // hébergement statique, tenter la bascule ne ferait qu'ajouter une requête
  // perdue et un message d'erreur trompeur.
  if (!panelServer.relay || location.protocol === "file:") return null;
  const safe = safeUrl(url);
  if (!safe) return null;
  return new URL(`stream?u=${encodeURIComponent(safe)}`, location.href).href;
}

/* ─────────────────────────────────────────────
   2 bis. Jaquettes

   Le catalogue amont fournit une URL d'affiche pour chaque fiche. Trois
   obstacles séparent cette URL d'une image à l'écran, d'où la chaîne de
   repli ci-dessous :
     1. l'hébergeur refuse souvent une requête sans Referer cohérent — et
        la page impose `referrer: no-referrer` ;
     2. le CDN peut être filtré par le réseau de l'utilisateur ;
     3. certaines fiches n'ont tout simplement pas d'image.
   On tente donc l'URL directe, puis le relais du serveur (qui ajoute le
   Referer et ramène tout à la même origine), puis une affiche dessinée.
   L'échec d'une origine est retenu : une seule image paie le détour.
   ───────────────────────────────────────────── */

/** Route image du serveur. Distincte du relais vidéo : les tests du relais
    comptent les appels à /stream, et la politique de cache n'est pas la
    même — une affiche se garde, un flux vidéo signé non. */
function imageProxyUrl(url) {
  if (!panelServer.relay || location.protocol === "file:") return null;
  const safe = safeUrl(url);
  if (!safe) return null;
  return new URL(`img?u=${encodeURIComponent(safe)}`, location.href).href;
}

const coverMemo = new Map();      // id d'anime → URL retenue, évite de renégocier à chaque rendu
const brokenOrigins = new Set();  // origines dont le chargement direct a échoué

/** Teinte stable déduite du titre : deux séries n'ont jamais la même, et
    la même série garde la sienne d'une session à l'autre. */
function titleHue(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** Mémorise la jaquette d'une fiche pour les vues qui ne stockent que du
    texte (favoris, historique, reprises). */
function rememberCover(anime) {
  if (!anime?.id || !anime.cover) return;
  if (state.covers[anime.id] === anime.cover) return;
  state.covers[anime.id] = anime.cover;
  const keys = Object.keys(state.covers);
  if (keys.length > COVERS_MAX) {
    for (const key of keys.slice(0, keys.length - COVERS_MAX)) delete state.covers[key];
  }
  persist();
}

function coverFor(anime) {
  if (!anime) return null;
  return anime.cover || state.covers[anime.id] || null;
}

/** Remplace l'image par l'affiche dessinée, sans jamais laisser une image
    cassée à l'écran. */
function paintFallback(box, title) {
  const hue = titleHue(title || "?");
  box.querySelector(".poster-img")?.remove();
  if (box.querySelector(".poster-gen")) return;
  box.prepend(el("div", {
    class: "poster-gen",
    vars: {
      "--g1": `hsl(${hue} 52% 32%)`,
      "--g2": `hsl(${(hue + 38) % 360} 46% 12%)`,
    },
  }, el("span", { text: title || "Sans titre" })));
}

/** Construit la boîte d'affiche : ratio figé, chargement différé, repli
    automatique. `extra` reçoit les surcouches (voile, actions, barre). */
function posterBox(anime, { className = "", eager = false, extra = [] } = {}) {
  const title = anime?.title || "";
  const box = el("div", { class: className ? `poster ${className}` : "poster" });
  const direct = coverFor(anime);

  if (direct) {
    const memo = coverMemo.get(anime.id);
    let origin = "";
    try { origin = new URL(direct).origin; } catch { /* URL relative */ }
    const first = memo || (origin && brokenOrigins.has(origin) ? imageProxyUrl(direct) : direct);

    if (first) {
      const img = el("img", {
        class: "poster-img",
        src: first,
        alt: "",
        loading: eager ? "eager" : "lazy",
        decoding: "async",
        onerror: () => {
          // Première déconvenue : on retente par le serveur, qui ajoute le
          // Referer attendu. Seconde : on dessine.
          const proxied = imageProxyUrl(direct);
          if (img.dataset.stage !== "proxy" && proxied && img.src !== proxied) {
            if (origin) brokenOrigins.add(origin);
            img.dataset.stage = "proxy";
            img.src = proxied;
            return;
          }
          coverMemo.delete(anime.id);
          paintFallback(box, title);
        },
        onload: () => { if (anime?.id) coverMemo.set(anime.id, img.src); },
      });
      box.append(img);
    } else {
      paintFallback(box, title);
    }
  } else {
    paintFallback(box, title);
  }

  for (const node of extra) if (node) box.append(node);
  return box;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const relFormatter = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const STEPS = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
function relTime(timestamp) {
  const diff = Number(timestamp) - Date.now();
  if (!Number.isFinite(diff)) return "";
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return relFormatter.format(Math.round(diff / ms), unit);
  }
  return "à l'instant";
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["data", "results", "result", "items", "episodes", "list"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  }
  return [];
}

/* ─────────────────────────────────────────────
   3. Stockage local
   ───────────────────────────────────────────── */
const safeStorage = {
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

const state = {
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

const COVERS_MAX = 600;

function loadState() {
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

function persistNow() {
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
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 250);
}

function cryptoId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function progressKey(animeId, slug, version) { return `${animeId}::${slug}::${version}`; }

/* ─────────────────────────────────────────────
   4. Toasts & modales
   ───────────────────────────────────────────── */
const toastHost = $("#toasts");
const TOAST_ICONS = { info: "info", success: "check", warn: "alert", error: "alert" };

function notify(message, { type = "info", title = "", timeout = 5200 } = {}) {
  if (!toastHost) return;
  const body = el("div", { class: "toast-body" }, [
    title ? el("b", { text: title }) : null,
    el("span", { text: message }),
  ]);
  const close = el("button", { type: "button", class: "toast-close", "aria-label": "Fermer la notification" }, icon("close"));
  const toast = el("div", { class: "toast", dataset: { type } }, [icon(TOAST_ICONS[type] || "info"), body, close]);

  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.classList.add("is-out");
    setTimeout(() => toast.remove(), 220);
  };
  close.addEventListener("click", dismiss);
  toastHost.append(toast);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  if (timeout > 0) setTimeout(dismiss, timeout);
}

const modal      = $("#modal");
const modalTitle = $("#modalTitle");
const modalBody  = $("#modalBody");
const modalFoot  = $("#modalFoot");

let modalGeneration = 0;

function openModal({ title, body, actions = [], variant = "" }) {
  modalGeneration++;
  modal.dataset.variant = variant;
  modalTitle.textContent = title;
  clear(modalBody);
  modalBody.append(body instanceof Node ? body : el("p", { text: String(body) }));
  clear(modalFoot);
  for (const action of actions) {
    modalFoot.append(el("button", {
      type: "button",
      class: `btn ${action.variant || "btn-ghost"}`,
      onclick: () => {
        const generation = modalGeneration;
        action.onClick?.();
        // Si l'action a ouvert une autre modale, on ne referme pas celle-ci.
        if (generation === modalGeneration) closeModal();
      },
    }, action.label));
  }
  if (!modal.open) modal.showModal();
}
function closeModal() { if (modal.open) modal.close(); }

function confirmDialog({ title, message, confirmLabel = "Confirmer", danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    // Échap et clic sur le fond déclenchent aussi « close » : la réponse est alors « non ».
    modal.addEventListener("close", () => resolve(answer), { once: true });
    openModal({
      title,
      body: el("p", { text: message }),
      actions: [
        { label: "Annuler", variant: "btn-ghost" },
        { label: confirmLabel, variant: danger ? "btn-danger" : "btn-primary", onClick: () => { answer = true; } },
      ],
    });
  });
}

$("#modalClose").addEventListener("click", closeModal);

/* ─────────────────────────────────────────────
   5. Couche API
   ───────────────────────────────────────────── */
class ApiError extends Error {
  constructor(message, kind = "unknown", detail = "") {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.detail = detail;
  }
}

function apiBase() { return String(state.settings.api || "").trim().replace(/\/+$/, ""); }

function mixedContentIssue() {
  return location.protocol === "https:" && apiBase().startsWith("http://");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      // `reason` peut être indéfini selon le navigateur : sans ce repli, la
      // promesse serait rejetée avec `undefined` et l'erreur deviendrait muette.
      reject(signal.reason ?? new DOMException("annulé", "AbortError"));
    }, { once: true });
  });
}

/** Le serveur répond 202 tant qu'une tâche de fond travaille : on la suit ici,
    ce qui évite de laisser une requête HTTP ouverte pendant plusieurs minutes.
    Tous les appels en bénéficient sans avoir à s'en préoccuper. */
async function request(path, options = {}) {
  const deadline = Date.now() + JOB_MAX_WAIT;
  for (let attempt = 0; ; attempt++) {
    const result = await requestOnce(path, options);
    if (!result || !result.pending) return result;

    options.onPending?.({ elapsed: result.elapsed ?? 0, attempt });
    if (Date.now() > deadline) {
      throw new ApiError(`La résolution des épisodes dépasse ${Math.round(JOB_MAX_WAIT / 60000)} minutes. Le serveur est peut-être surchargé.`, "timeout");
    }
    await sleep(JOB_POLL, options.signal);
  }
}

async function requestOnce(path, { signal, timeoutMs } = {}) {
  const base = apiBase();
  if (!base && location.protocol === "file:") {
    throw new ApiError("Aucune URL d'API n'est configurée, et une page ouverte en file:// n'a pas d'origine à interroger. Renseigne l'URL du backend dans les paramètres.", "config");
  }
  if (mixedContentIssue()) {
    throw new ApiError("Cette page est servie en HTTPS mais l'API est en HTTP : le navigateur bloque la requête (contenu mixte). Ouvre le panel en http:// ou passe l'API en HTTPS.", "mixed");
  }

  // Champ vide : on interroge la même origine, ce que fait le proxy serve.py.
  let url;
  try { url = base ? new URL(base + path).href : new URL(path.replace(/^\//, ""), location.href).href; }
  catch { throw new ApiError(`L'URL de l'API est invalide : ${base}`, "config"); }

  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : clamp(Number(state.settings.timeout) || 45, 3, 600) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      mode: "cors",
      // « same-origin » et non « omit » : quand le panel est servi derrière un
      // mot de passe, le navigateur doit rejoindre l'authentification à nos
      // propres appels /api, sinon tout repart en 401. Un backend externe
      // renseigné à la main reste, lui, interrogé sans identifiants.
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new ApiError(`L'API n'a pas répondu en moins de ${ms / 1000} s. Augmente le délai d'attente dans les réglages : le scraping d'une saison peut être long.`, "timeout");
    }
    if (err?.name === "AbortError") throw new ApiError("Requête annulée.", "abort");
    throw new ApiError(`Impossible de joindre ${base || "l'API sur cette origine"}. Vérifie que le serveur tourne et qu'il autorise le CORS pour cette page.`, "network", String(err?.message || err));
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok && response.status !== 202) {
    throw new ApiError(`L'API a répondu HTTP ${response.status} (${response.statusText || "erreur"}) sur ${path.split("?")[0]}.`, "http");
  }

  const text = await response.text();
  if (!text.trim()) return null;

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new ApiError("La réponse de l'API n'est pas du JSON valide.", "parse", text.slice(0, 200)); }

  // 202 + pending : le serveur a mis la requête en tâche de fond.
  if (response.status === 202 && parsed && parsed.pending) {
    return { pending: true, elapsed: Number(parsed.elapsed) || 0 };
  }
  return parsed;
}

/* Normalisation : l'API peut renvoyer `lien`, `url` ou `link` selon la route. */
function animeIdFrom(title, url) {
  if (url) {
    const match = url.match(/\/catalogue\/([^/?#]+)/i);
    if (match) return decodeURIComponent(match[1]).toLowerCase();
  }
  return slugify(title);
}

function normAnime(raw, index = 0) {
  if (typeof raw === "string") {
    const title = raw.trim();
    return title ? { id: slugify(title), title, alt: "", url: null, cover: null, score: null, index } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const title = String(pick(raw, ["title", "Title", "name", "nom", "matchedTitle"]) ?? "").trim();
  const url   = safeUrl(pick(raw, ["lien", "url", "link", "Lien", "URL", "base_url"]));
  if (!title && !url) return null;
  const alt   = pick(raw, ["AlterTitle", "alterTitle", "altTitle", "alternative", "alt"]);
  const score = Number(pick(raw, ["score", "Score"]));
  return {
    id: animeIdFrom(title, url),
    title: title || "Sans titre",
    alt: Array.isArray(alt) ? alt.join(", ") : (alt ? String(alt) : ""),
    url,
    // Le catalogue amont porte l'affiche de chaque fiche ; sans cette ligne
    // elle était simplement jetée ici, d'où une interface sans aucune image.
    cover: safeUrl(pick(raw, ["cover", "Cover", "image", "img", "affiche", "poster"])),
    score: Number.isFinite(score) ? Math.round(score) : null,
    index,
  };
}

function seasonSlug(label, url) {
  if (url) {
    const parts = String(url).split(/[?#]/)[0].split("/").filter(Boolean);
    const at = parts.findIndex((p) => p.toLowerCase() === "catalogue");
    if (at >= 0 && parts[at + 2]) return parts[at + 2].toLowerCase();
  }
  const slug = slugify(label).replace(/-/g, "");
  return slug === "anime" ? "saison1" : slug;
}

function normSeason(raw, index = 0) {
  if (typeof raw === "string") return { label: raw, url: null, cover: null, slug: seasonSlug(raw, null) };
  const label = String(pick(raw, ["Saison", "saison", "season", "name", "title"]) ?? `Saison ${index + 1}`).trim();
  const url = safeUrl(pick(raw, ["url", "lien", "link"]));
  const cover = safeUrl(pick(raw, ["cover", "Cover", "image", "img", "affiche", "poster"]));
  return { label: label || `Saison ${index + 1}`, url, cover, slug: seasonSlug(label, url) };
}

function collectUrls(item) {
  const found = [];
  for (const key of ["url", "urls", "lien", "liens", "link", "links", "source", "sources", "video"]) {
    const value = item[key];
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) found.push(...value.filter((v) => typeof v === "string"));
  }
  const seen = new Set();
  const out = [];
  for (const candidate of found) {
    const url = safeUrl(candidate);
    if (url && !seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

function normEpisodes(raw) {
  const list = [];
  toArray(raw).forEach((item, index) => {
    if (typeof item === "string") {
      const url = safeUrl(item);
      if (url) list.push({ number: index + 1, label: "", sources: [url] });
      return;
    }
    if (!item || typeof item !== "object") return;
    const sources = collectUrls(item);
    if (!sources.length) return;
    const number = Number(pick(item, ["episode", "Episode", "ep", "number", "num", "index"]));
    const label = pick(item, ["name", "title", "label", "nom"]);
    list.push({
      number: Number.isFinite(number) ? number : index + 1,
      label: label ? String(label) : "",
      sources,
    });
  });
  list.sort((a, b) => a.number - b.number);
  return list;
}

/* Cache mémoire, avec déduplication des requêtes simultanées identiques. */
const memory = { seasons: new Map(), episodes: new Map(), pending: new Map() };

function cached(bucket, key, producer) {
  const hit = bucket.get(key);
  if (hit && Date.now() - hit.at < MEM_TTL) return Promise.resolve(hit.value);
  if (memory.pending.has(key)) return memory.pending.get(key);
  const promise = producer()
    .then((value) => { bucket.set(key, { at: Date.now(), value }); return value; })
    .finally(() => memory.pending.delete(key));
  memory.pending.set(key, promise);
  return promise;
}

function invalidate(key) { memory.seasons.delete(key); memory.episodes.delete(key); }

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
const RESOLVED_KEY = "animeSamaPanel.resolved.v1";
const RESOLVED_TTL = 12 * 3600 * 1000;    // au-delà, les liens sont trop incertains
const RESOLVED_MAX = 40;                  // saisons conservées, les plus anciennes partent

function seasonKey(anime, slug, version) { return `${anime?.id}::${slug}::${version}`; }

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

function dropResolved(key) {
  const store = readResolvedStore();
  if (!(key in store)) return;
  delete store[key];
  safeStorage.set(RESOLVED_KEY, JSON.stringify(store));
}

/* ── Mode démo : données locales + vidéos de test libres de droits ──
   Aucun contenu Anime-Sama n'est diffusé ici ; il s'agit uniquement de
   vérifier que l'interface et le lecteur fonctionnent sans backend.     */
const DEMO_STREAMS = [
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
];
const DEMO_TITLES = [
  "Démo — Aurora Blade", "Démo — Neon Samurai", "Démo — Petal Requiem",
  "Démo — Starlight Circuit", "Démo — Iron Lotus", "Démo — Echoes of Tomorrow",
];
const demo = {
  catalogue: DEMO_TITLES.map((title) => ({
    id: slugify(title), title, alt: "Jeu de données de démonstration", url: null, score: 100,
    seasons: [
      { label: "Saison 1", slug: "saison1", url: null, count: 12 },
      { label: "Saison 2", slug: "saison2", url: null, count: 8 },
    ],
  })),
  wait: (ms = 280) => new Promise((r) => setTimeout(r, ms)),
  find(title) {
    const needle = deaccent(title);
    return this.catalogue.find((a) => deaccent(a.title) === needle)
        || this.catalogue.find((a) => deaccent(a.title).includes(needle));
  },
};

/* ── Façade unique : bascule entre l'API réelle et le mode démo ── */
const source = {
  get isDemo() { return !!state.settings.demo; },

  async ping() {
    if (this.isDemo) { await demo.wait(120); return { demo: true }; }
    return request(`/?q=${encodeURIComponent("panel-ping")}`);
  },

  async search(query, limit) {
    if (this.isDemo) {
      await demo.wait();
      const needle = deaccent(query);
      return demo.catalogue.filter((a) => deaccent(a.title).includes(needle)).slice(0, limit)
        .map((a, i) => ({ ...a, index: i }));
    }
    const raw = await request(`/api/getSerchAnime?q=${encodeURIComponent(query)}&l=${encodeURIComponent(limit)}`);
    return toArray(raw).map(normAnime).filter(Boolean);
  },

  async catalogue() {
    if (this.isDemo) { await demo.wait(); return demo.catalogue.map((a, i) => ({ ...a, index: i })); }
    const raw = await request("/api/loadBaseAnimeData");
    return toArray(raw).map(normAnime).filter(Boolean);
  },

  async seasons(anime) {
    if (this.isDemo) {
      await demo.wait();
      return (demo.find(anime.title)?.seasons || []).map((s) => ({ label: s.label, slug: s.slug, url: null }));
    }
    const key = `seasons:${anime.id}:${anime.title}`;
    return cached(memory.seasons, key, async () => {
      const raw = await request(`/api/getInfoAnime?q=${encodeURIComponent(anime.title)}`);
      return toArray(raw).map(normSeason);
    });
  },

  async episodes(anime, slug, version, options = {}) {
    if (this.isDemo) {
      await demo.wait(420);
      const season = demo.find(anime.title)?.seasons.find((s) => s.slug === slug);
      const count = season?.count ?? 6;
      return Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        label: "",
        sources: [DEMO_STREAMS[i % DEMO_STREAMS.length]],
      }));
    }
    const key = `episodes:${anime.title}:${slug}:${version}`;
    return cached(memory.episodes, key, async () => {
      const raw = await request(
        `/api/getAnimeLink?n=${encodeURIComponent(anime.title)}&s=${encodeURIComponent(slug)}&v=${encodeURIComponent(version)}`,
        { onPending: options.onPending });
      return normEpisodes(raw);
    });
  },

  /** Résout un seul épisode (chargement intelligent) au lieu d'attendre toute
      la saison. Le serveur patché répond {count, results} ; un backend non
      patché ignore « e » et renvoie la saison déjà entière — le panel s'en
      aperçoit et se dégrade proprement (voir `degraded` ci-dessous). Jamais
      mis en cache côté client : le serveur le fait déjà (voir README/tests),
      et `player.episodes` sert lui-même d'état "déjà connu" pour la session. */
  async episode(anime, slug, version, episodeNumber, options = {}) {
    if (this.isDemo) {
      const episodes = await this.episodes(anime, slug, version, options);
      return { degraded: true, episodes };
    }
    const raw = await request(
      `/api/getAnimeLink?n=${encodeURIComponent(anime.title)}&s=${encodeURIComponent(slug)}&v=${encodeURIComponent(version)}&e=${encodeURIComponent(episodeNumber)}`,
      { onPending: options.onPending });
    if (Array.isArray(raw)) {
      // Le paramètre « e » n'a pas été compris (backend non patché) : la
      // saison entière est déjà là, rien à faire en tâche de fond ensuite.
      return { degraded: true, episodes: normEpisodes(raw) };
    }
    return {
      degraded: false,
      count: Math.max(0, Number(raw?.count) || 0),
      episode: normEpisodes(raw)[0] ?? null,
    };
  },

  async domain() {
    if (this.isDemo) { await demo.wait(120); return [{ url: "https://exemple.invalid (mode démo)" }]; }
    return request("/api/getAnimeSamaURL");
  },

  async scanChapters(name) {
    if (this.isDemo) throw new ApiError("Le lecteur de scans n'est pas simulé en mode démo : il lui faut de vraies images. Désactive le mode démo et lance le backend.", "demo");
    return request(`/api/getScanHashmap?n=${encodeURIComponent(name)}`);
  },

  async scanPages(name, chapter) {
    if (this.isDemo) throw new ApiError("Indisponible en mode démo.", "demo");
    return request(`/api/getScanLink?n=${encodeURIComponent(name)}&c=${encodeURIComponent(chapter)}`);
  },
};

/* Message d'erreur lisible pour l'utilisateur, quelle que soit l'origine. */
function describeError(err) {
  if (err instanceof ApiError) return err.message;
  if (err?.name === "AbortError") return "Requête annulée.";
  return String(err?.message || err || "Erreur inconnue.");
}

/* ─────────────────────────────────────────────
   6. Navigation
   ───────────────────────────────────────────── */
function applyView(view) {
  const target = VIEWS.includes(view) ? view : "discover";
  for (const section of $$(".view")) section.classList.toggle("is-active", section.dataset.view === target);
  for (const button of $$(".nav-item")) {
    const active = button.dataset.nav === target;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
  window.scrollTo({ top: 0, behavior: state.settings.motion ? "auto" : "smooth" });
}

function navigate(view) {
  // La vue bascule tout de suite ; le hash suit pour garder les boutons
  // précédent/suivant du navigateur fonctionnels (hashchange rappelle applyView).
  applyView(view);
  if (location.hash.slice(1) !== view) location.hash = view;
}

window.addEventListener("hashchange", () => applyView(location.hash.slice(1)));

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-nav]");
  if (!trigger) return;
  event.preventDefault();
  navigate(trigger.dataset.nav);
});

/* ─────────────────────────────────────────────
   7. Vue Découvrir
   ───────────────────────────────────────────── */
const discoverResults = $("#discoverResults");
const filterInput     = $("#filterInput");
const sortSelect      = $("#sortSelect");
const favOnlyToggle   = $("#favOnlyToggle");
const resultCount     = $("#resultCount");
const searchInput     = $("#searchInput");

const discover = { items: [], origin: "idle", limit: 60, message: "" };

/** Seule primitive d'état vide du panel. Elle est utilisée dans six
    conteneurs dont certains sont comptés par les tests : elle ne doit
    jamais porter .card ni .row. La variante compacte évite d'avoir à
    créer un second composant — qui serait justement l'occasion
    d'introduire une de ces classes par accident. */
function emptyState({ glyph = "info", title, text, tone = "", action = null, size = "" }) {
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

function isFavorite(id) { return state.favorites.some((f) => f.id === id); }

function toggleFavorite(anime) {
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

function updateFavCount() {
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

    Trois règles de structure, imposées par les suites de tests et par la
    façon dont un clic automatisé vise le centre d'un élément :
      · le bouton de lecture est le PREMIER .btn-primary du sous-arbre ;
      · .card-fav est un descendant, et rien ne le recouvre — le voile
        dégradé est en `pointer-events: none` ;
      · les actions restent présentes et cliquables en permanence, elles
        ne font que se renforcer au survol. */
function animeCard(anime) {
  const progress = latestProgress(anime.id);
  const resume = progress
    ? { seasonSlug: progress.seasonSlug, version: progress.version, episode: progress.lastEpisode }
    : {};
  const chips = [];
  if (Number.isFinite(anime.score)) chips.push(el("span", { class: "chip chip-sm", text: `Score ${anime.score}` }));
  if (progress) chips.push(el("span", { class: "chip chip-sm chip-accent", text: `${progress.seasonLabel} · É${progress.lastEpisode}` }));

  const ratio = progress ? watchedRatio(progress) : 0;
  const poster = posterBox(anime, {
    extra: [
      el("div", { class: "poster-scrim", "aria-hidden": "true" }),
      el("div", { class: "poster-actions" }, [
        el("button", {
          type: "button", class: "btn btn-primary btn-sm btn-icon",
          title: progress ? "Reprendre" : "Ouvrir",
          "aria-label": `${progress ? "Reprendre" : "Ouvrir"} ${anime.title}`,
          onclick: () => openAnime(anime, resume),
        }, icon("play")),
        el("button", {
          type: "button", class: "icon-btn icon-btn-sm card-info",
          title: "Fiche détaillée", "aria-label": `Fiche de ${anime.title}`,
          onclick: () => showAnimeDetails(anime),
        }, icon("info")),
      ]),
      favButton(anime),
      ratio > 0 ? el("div", { class: "poster-bar" }, el("i", { style: { width: `${ratio * 100}%` } })) : null,
    ],
  });

  return el("article", { class: "card", dataset: { id: anime.id } }, [
    poster,
    el("h3", { class: "card-title", text: anime.title }),
    anime.alt ? el("p", { class: "card-sub", text: anime.alt }) : null,
    chips.length ? el("div", { class: "card-meta" }, chips) : null,
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

/* ─────────────────────────────────────────────
   6 bis. Accueil : héros et rangées

   Ce n'est pas une vue séparée mais l'état au repos de « Découvrir ».
   L'ancien écran vide invitait à taper une recherche — la pire entrée en
   matière possible. Il est remplacé par ce que l'utilisateur a déjà :
   ce qu'il regarde, sa liste, et de quoi explorer.
   ───────────────────────────────────────────── */
const homeBlock   = $("#homeBlock");
const hero        = $("#hero");
const heroBg      = $("#heroBg");
const heroPoster  = $("#heroPoster");
const heroEyebrow = $("#heroEyebrow");
const heroTitle   = $("#heroTitle");
const heroSub     = $("#heroSub");
const heroMeta    = $("#heroMeta");
const heroActions = $("#heroActions");
const homeRails   = $("#homeRails");

/** Réservoir de fiches pour l'accueil : la liste affichée si elle existe,
    sinon le catalogue mis en cache, qu'on lit une seule fois. */
let cataloguePool = null;
function homePool() {
  if (discover.items.length) return discover.items;
  if (cataloguePool === null) cataloguePool = readCatalogueCache()?.items || [];
  return cataloguePool;
}

/** Reprises les plus récentes, transformées en fiches présentables. */
function continueEntries(limit = 12) {
  return Object.values(state.progress)
    .filter((entry) => entry.lastEpisode != null)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
}

function animeFromProgress(entry) {
  return {
    id: entry.animeId, title: entry.title, alt: "",
    url: entry.animeUrl || null, cover: state.covers[entry.animeId] || null,
    score: null, index: 0,
  };
}

function animeFromFavorite(fav) {
  return {
    id: fav.id, title: fav.title, alt: "",
    url: fav.url || null, cover: fav.cover || state.covers[fav.id] || null,
    score: null, index: 0,
  };
}

/** Choix stable dans la journée : la sélection « au hasard » ne doit pas
    se réordonner à chaque rendu, sinon la page semble instable. */
function daySeed() {
  const now = new Date();
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

function pickSpread(items, count) {
  if (items.length <= count) return items.slice();
  const step = Math.max(1, Math.floor(items.length / count));
  const start = daySeed() % step;
  const out = [];
  for (let i = start; i < items.length && out.length < count; i += step) out.push(items[i]);
  return out;
}

function renderHero() {
  const resume = continueEntries(1)[0];
  const pool = homePool();
  let featured = null;
  let eyebrow = "À la une";

  if (resume) {
    featured = animeFromProgress(resume);
    eyebrow = "Reprendre";
  } else if (pool.length) {
    featured = pool.find((a) => a.cover) || pool[daySeed() % pool.length];
  }

  if (!featured) { hero.hidden = true; return null; }
  hero.hidden = false;

  // Le catalogue ne donne que des affiches 2/3 : la même image, floutée et
  // agrandie, tient lieu de panoramique. La teinte vient du titre, donc
  // elle est disponible même quand l'image ne l'est pas.
  const cover = coverFor(featured);
  heroBg.style.backgroundImage = cover ? `url("${cover.replace(/["\\]/g, "\\$&")}")` : "";
  hero.style.setProperty("--hero-tint", `hsl(${titleHue(featured.title)} 60% 42% / .30)`);

  clear(heroPoster);
  heroPoster.append(posterBox(featured, { eager: true }));

  heroEyebrow.textContent = eyebrow;
  heroTitle.textContent = featured.title;
  heroSub.textContent = resume
    ? `${resume.seasonLabel} · Épisode ${resume.lastEpisode} · ${String(resume.version).toUpperCase()}`
    : (featured.alt || "");
  heroSub.hidden = !heroSub.textContent;

  clear(heroMeta);
  if (Number.isFinite(featured.score)) {
    heroMeta.append(el("span", { class: "chip chip-sm", text: `Score ${featured.score}` }));
  }
  if (isFavorite(featured.id)) {
    heroMeta.append(el("span", { class: "chip chip-sm chip-ok", text: "Dans ma liste" }));
  }

  clear(heroActions);
  heroActions.append(el("button", {
    type: "button", class: "btn btn-primary",
    onclick: () => openAnime(featured, resume
      ? { seasonSlug: resume.seasonSlug, version: resume.version, episode: resume.lastEpisode }
      : {}),
  }, [icon("play"), el("span", { text: resume ? "Reprendre" : "Regarder" })]));
  heroActions.append(el("button", {
    type: "button", class: "btn btn-ghost",
    onclick: () => showAnimeDetails(featured),
  }, [icon("info"), el("span", { text: "Détails" })]));

  return featured;
}

/** Rangée horizontale : défilement confiné, flèches au survol, et un pas
    calé sur la largeur visible plutôt que sur un nombre de cartes. */
function buildRail(title, items, note = "") {
  if (!items.length) return null;

  const track = el("div", { class: "rail-track" });
  for (const anime of items) track.append(animeCard(anime));

  const scrollBy = (dir) => track.scrollBy({
    left: dir * Math.max(240, track.clientWidth * 0.8),
    behavior: state.settings.motion ? "auto" : "smooth",
  });

  const prev = el("button", {
    type: "button", class: "rail-arrow", dataset: { dir: "prev" },
    "aria-label": `${title} : défiler vers la gauche`,
    onclick: () => scrollBy(-1),
  }, icon("prev"));
  const next = el("button", {
    type: "button", class: "rail-arrow", dataset: { dir: "next" },
    "aria-label": `${title} : défiler vers la droite`,
    onclick: () => scrollBy(1),
  }, icon("next"));

  const sync = () => {
    const max = track.scrollWidth - track.clientWidth - 1;
    prev.disabled = track.scrollLeft <= 0;
    next.disabled = track.scrollLeft >= max;
  };
  track.addEventListener("scroll", sync, { passive: true });
  requestAnimationFrame(sync);

  return el("section", { class: "rail-section" }, [
    el("div", { class: "rail-head" }, [
      el("h2", { text: title }),
      note ? el("p", { class: "hint", text: note }) : null,
    ]),
    el("div", { class: "rail" }, [prev, track, next]),
  ]);
}

function renderHome() {
  // L'accueil cède la place dès qu'une recherche ou le catalogue remplit
  // la grille : une seule surface à la fois, jamais les deux.
  if (discover.origin !== "idle") { homeBlock.hidden = true; return; }

  const featured = renderHero();
  const pool = homePool();

  clear(homeRails);
  const scored = pool.filter((a) => Number.isFinite(a.score)).sort((a, b) => b.score - a.score);
  const rails = [
    buildRail("Reprendre la lecture", continueEntries().map(animeFromProgress)),
    buildRail("Ma liste", state.favorites.slice(0, 16).map(animeFromFavorite)),
    buildRail("Populaires", scored.slice(0, 16)),
    buildRail("Dans le catalogue", pool.slice(0, 16),
      pool.length ? `${pool.length} fiches en mémoire` : ""),
    // Inutile de proposer une sélection « au hasard » quand le catalogue
    // tient en une rangée : ce serait deux fois la même chose.
    pool.length >= 40 ? buildRail("Au hasard", pickSpread(pool, 16)) : null,
  ].filter(Boolean);

  for (const rail of rails) homeRails.append(rail);
  homeBlock.hidden = !featured && !rails.length;
}

function renderDiscover() {
  clear(discoverResults);
  // L'accueil n'occupe l'écran que tant que la grille n'a rien à montrer.
  renderHome();

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
    discoverResults.append(emptyState({
      glyph: "compass",
      size: "compact",
      title: "Parcourir le catalogue",
      text: "Saisis un titre pour interroger l'API, ou charge le catalogue complet pour filtrer les 4000+ fiches hors ligne.",
      action: { label: "Charger le catalogue", onClick: () => loadCatalogueBtn.click() },
    }));
    return;
  }

  const items = filteredDiscover();
  resultCount.textContent = `${items.length} titre${items.length > 1 ? "s" : ""}`;

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
  $("#quickSearchInput").value = term;
  if (term.length < 2) {
    notify("Saisis au moins 2 caractères.", { type: "warn", timeout: 3200 });
    return;
  }
  discover.origin = "loading";
  discover.limit = 60;
  renderDiscover();
  navigate("discover");
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

$("#searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(searchInput.value);
});

$("#quickSearchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("#quickSearchInput").value;
  searchInput.value = value;
  runSearch(value);
});

filterInput.addEventListener("input", debounce(() => { discover.limit = 60; renderDiscover(); }, 140));
sortSelect.addEventListener("change", renderDiscover);
favOnlyToggle.addEventListener("change", renderDiscover);

/* ── Catalogue complet (route loadBaseAnimeData) ── */
// Le catalogue mis en cache par les versions précédentes a été normalisé
// sans les jaquettes. La clé a changé ; l'ancienne, qui pouvait peser
// jusqu'à 3 Mo, resterait sinon orpheline pour toujours.
safeStorage.remove("animeSamaPanel.catalogue.v1");

function readCatalogueCache() {
  try {
    const raw = JSON.parse(safeStorage.get(CATALOGUE_KEY) || "null");
    if (raw && Array.isArray(raw.items) && raw.items.length) return raw;
  } catch { /* cache illisible */ }
  return null;
}

async function fetchCatalogue() {
  discover.origin = "loading";
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
async function warmHomeCatalogue() {
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

$("#loadCatalogueBtn").addEventListener("click", () => {
  const cache = readCatalogueCache();
  if (!cache) { fetchCatalogue(); return; }
  // Le catalogue étant préchargé en tâche de fond, demander « cache ou
  // rechargement ? » à chaque clic serait une question sans enjeu. On
  // affiche immédiatement, et on actualise derrière si c'est périmé.
  showCatalogue(cache.items);
  navigate("discover");
  if (Date.now() - cache.at >= CATALOGUE_TTL) refreshCatalogueQuietly();
});

/* ── Indexation du catalogue côté serveur ──
   En hébergement, le disque est effacé à chaque redémarrage : le serveur
   réindexe alors en tâche de fond. Sans ce retour visuel, la première visite
   après un réveil ressemble à une panne. La route /panel/state n'existe que
   si le panel est servi par serve.py ; ailleurs, on s'efface silencieusement. */
const indexBanner = $("#indexBanner");
const indexText = $("#indexText");
const indexing = { timer: 0, seen: false, available: true };

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

async function pollIndexing() {
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

/** Fiche détaillée d'une série.

    Volontairement courte : les données ne contiennent ni synopsis, ni
    genres, ni note. Une fiche calquée sur Netflix afficherait des blocs
    vides ; celle-ci ne montre que ce qu'elle peut tenir — grande affiche,
    titres, saisons, et les actions utiles.

    Tous les boutons doivent porter type="button" : la modale est un
    <form method="dialog">, un bouton sans type la refermerait au clic. */
async function showAnimeDetails(anime) {
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

/* ─────────────────────────────────────────────
   8. Lecteur
   ───────────────────────────────────────────── */
const video          = $("#video");
const frame          = $("#frame");
const playerStage    = $("#playerStage");
const placeholder    = $("#playerPlaceholder");
const stageLoader    = $("#stageLoader");
const formatBadge    = $("#formatBadge");
const nowTitle       = $(".now-title");
const nowMeta        = $("#nowMeta");
const playerNote     = $("#playerNote");
const seasonSelect   = $("#seasonSelect");
const versionSelect  = $("#versionSelect");
const modeSelect     = $("#modeSelect");
const sourceSelect   = $("#sourceSelect");
const sourceField    = $("#sourceField");
const episodeList    = $("#episodeList");
const episodeCount   = $("#episodeCount");
const resumeBanner   = $("#resumeBanner");
const resumeText     = $("#resumeText");
const favCurrentBtn  = $("#favCurrentBtn");

const player = {
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

function setNote(message) {
  if (!message) { playerNote.hidden = true; playerNote.textContent = ""; return; }
  playerNote.textContent = message;
  playerNote.hidden = false;
}

function setStageLoading(active) { stageLoader.hidden = !active; }

function ensureOption(select, value, label) {
  if (!value) return;
  if (!Array.from(select.options).some((option) => option.value === value)) {
    select.append(el("option", { value, text: label || value.toUpperCase() }));
  }
  select.value = value;
}

function updatePlayerHeader() {
  if (!player.anime) return;
  nowTitle.textContent = player.episode
    ? `${player.anime.title} — Épisode ${player.episode.number}`
    : player.anime.title;
  const parts = [player.season?.label, player.version?.toUpperCase()].filter(Boolean);
  if (source.isDemo) parts.push("MODE DÉMO");
  nowMeta.textContent = parts.join(" · ") || "—";
  favCurrentBtn.hidden = false;
  updatePlayerFavButton();
}

function updatePlayerFavButton() {
  if (!player.anime) return;
  const active = isFavorite(player.anime.id);
  favCurrentBtn.classList.toggle("is-on", active);
  favCurrentBtn.setAttribute("aria-pressed", String(active));
  favCurrentBtn.title = active ? "Retirer des favoris" : "Ajouter aux favoris";
}

function progressEntry(create = false) {
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

async function openAnime(anime, options = {}) {
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

async function loadEpisodes({ episode = null, seek = null, autoplay = false, force = false } = {}) {
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
function playResolvedEpisode(episode, { seek = null, sourceIndex = 0 } = {}) {
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
async function resolveEpisodePriority(number, { seek = null, sourceIndex = 0, autoplay = false } = {}) {
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

function showResumeBanner(episode) {
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

function fillSources(episode) {
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

function playEpisode(number, { seek = null, sourceIndex = 0 } = {}) {
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

function mountSource(url, { seek = null, relay = null } = {}) {
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
  notify("Lecture directe refusée par l'hébergeur : nouvelle tentative via le serveur.",
    { type: "info", title: "Changement de route", timeout: 5000 });
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

function saveWatchTime(finished = false) {
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

function renderEpisodes(status, message = "", elapsed = 0) {
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

function renderEpisodeStates() {
  const entry = progressEntry(false);
  for (const node of $$(".episode", episodeList)) {
    const number = Number(node.dataset.episode);
    node.classList.toggle("is-current", player.episode?.number === number);
    node.classList.toggle("is-watched", !!entry?.episodes?.[number]?.done);
  }
  const current = episodeList.querySelector(".episode.is-current");
  if (current) current.scrollIntoView({ block: "nearest" });
}

function step(delta, { silent = false } = {}) {
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
$("#prevBtn").addEventListener("click", () => step(-1));
$("#nextBtn").addEventListener("click", () => step(1));
$("#reloadBtn").addEventListener("click", () => {
  if (!player.current) { notify("Aucune source chargée.", { type: "warn", timeout: 3000 }); return; }
  mountSource(player.current, { seek: player.kind !== "iframe" ? video.currentTime : null });
});
$("#reloadEpisodesBtn").addEventListener("click", () => loadEpisodes({ force: true }));
$("#fullscreenBtn").addEventListener("click", () => {
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  (playerStage.requestFullscreen?.() ?? Promise.reject()).catch(() => {
    notify("Le plein écran a été refusé par le navigateur.", { type: "warn", timeout: 3500 });
  });
});
$("#openSourceBtn").addEventListener("click", () => {
  const url = safeUrl(player.current);   // l'originale, pas celle du relais
  if (!url) { notify("Aucune source chargée.", { type: "warn", timeout: 3000 }); return; }
  window.open(url, "_blank", "noopener,noreferrer");
});
$("#autoplayToggle").addEventListener("change", (event) => {
  state.settings.autoplay = event.target.checked;
  $("#autoplaySetting").checked = event.target.checked;
  persist();
});
$("#resumeSeekBtn").addEventListener("click", () => {
  const episode = Number(resumeBanner.dataset.episode);
  const seek = Number(resumeBanner.dataset.seek);
  if (Number.isFinite(episode)) playEpisode(episode, { seek: Number.isFinite(seek) ? seek : null });
});
$("#resumeDismissBtn").addEventListener("click", () => { resumeBanner.hidden = true; });
favCurrentBtn.addEventListener("click", () => { if (player.anime) toggleFavorite(player.anime); });

/* ─────────────────────────────────────────────
   9. Favoris & historique
   ───────────────────────────────────────────── */
const favoritesGrid = $("#favoritesGrid");
const historyList   = $("#historyList");
const continueGrid  = $("#continueGrid");
const continueTitle = $("#continueTitle");

function recordHistory(episodeNumber) {
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

function renderFavorites() {
  clear(favoritesGrid);
  if (!state.favorites.length) {
    favoritesGrid.append(emptyState({
      glyph: "star",
      title: "Aucun favori",
      text: "Clique sur l'étoile d'une carte pour épingler un anime. La liste reste dans ce navigateur.",
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

function renderContinue() {
  clear(continueGrid);
  const entries = Object.values(state.progress)
    .filter((e) => e.lastEpisode != null)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 8);

  continueTitle.hidden = entries.length === 0;
  if (!entries.length) return;

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const saved = entry.episodes?.[entry.lastEpisode];
    const ratio = saved?.d ? clamp(saved.t / saved.d, 0, 1) : 0;
    const resume = () => resumeFrom(
      { ...entry, episode: entry.lastEpisode },
      { seek: saved?.done ? null : saved?.t ?? null });

    const poster = posterBox(animeFromProgress(entry), {
      extra: [
        el("div", { class: "poster-scrim", "aria-hidden": "true" }),
        el("div", { class: "poster-actions" }, el("button", {
          type: "button", class: "btn btn-primary btn-sm btn-icon",
          title: "Reprendre", "aria-label": `Reprendre ${entry.title}`,
          onclick: resume,
        }, icon("play"))),
        el("div", { class: "poster-bar" }, el("i", { style: { width: `${Math.max(ratio, .02) * 100}%` } })),
      ],
    });

    fragment.append(el("article", { class: "card", dataset: { id: entry.animeId } }, [
      poster,
      el("h3", { class: "card-title", text: entry.title }),
      el("p", { class: "card-sub", text: `${entry.seasonLabel} · Ép. ${entry.lastEpisode} · ${String(entry.version).toUpperCase()}` }),
      el("div", { class: "card-meta" }, [
        el("span", { class: "chip chip-sm", text: relTime(entry.updatedAt) }),
        saved?.t ? el("span", { class: "chip chip-sm chip-accent", text: formatTime(saved.t) }) : null,
      ]),
    ]));
  }
  continueGrid.append(fragment);
}

function renderHistory() {
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

$("#favSort").addEventListener("change", renderFavorites);

$("#clearHistoryBtn").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Effacer l'historique ?",
    message: "L'historique et toutes les positions de lecture enregistrées seront supprimés. Les favoris et les réglages sont conservés.",
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

/* ─────────────────────────────────────────────
   10a. Lecteur de scans
   ───────────────────────────────────────────── */
const chapterList   = $("#chapterList");
const chapterCount  = $("#chapterCount");
const scanReader    = $("#scanReader");
const chapterFilter = $("#chapterFilter");

const scans = { name: "", chapters: [], current: null };

function renderChapters() {
  clear(chapterList);
  const needle = chapterFilter.value.trim();
  const items = needle ? scans.chapters.filter((c) => String(c.number).includes(needle)) : scans.chapters;

  chapterCount.textContent = String(scans.chapters.length);
  chapterCount.hidden = scans.chapters.length === 0;

  if (!items.length) {
    chapterList.append(el("p", { class: "hint", text: scans.chapters.length ? "Aucun chapitre ne correspond." : "Charge un manga pour voir ses chapitres." }));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const chapter of items) {
    fragment.append(el("button", {
      type: "button",
      class: `chapter${scans.current === chapter.number ? " is-current" : ""}`,
      onclick: () => loadChapter(chapter.number),
    }, [
      el("span", { text: `Chapitre ${chapter.number}` }),
      chapter.pages ? el("small", { text: `${chapter.pages} p.` }) : null,
    ]));
  }
  chapterList.append(fragment);
}

$("#scanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#scanInput").value.trim();
  if (name.length < 2) { notify("Saisis le nom du manga.", { type: "warn", timeout: 3000 }); return; }

  scans.name = name;
  scans.chapters = [];
  scans.current = null;
  clear(scanReader);
  scanReader.append(el("div", { class: "empty" }, [icon("book"), el("p", { class: "empty-title", text: "Chargement des chapitres…" })]));

  try {
    const data = await source.scanChapters(name);
    const chapters = [];
    for (const [key, value] of Object.entries(data || {})) {
      if (!/^\d+(\.\d+)?$/.test(key)) continue;
      chapters.push({ number: key, pages: Number(value) || 0 });
    }
    chapters.sort((a, b) => Number(a.number) - Number(b.number));
    scans.chapters = chapters;
    renderChapters();
    clear(scanReader);
    if (!chapters.length) {
      scanReader.append(emptyState({ glyph: "book", title: "Aucun chapitre", text: `L'API ne connaît pas de scans pour « ${name} ». Vérifie l'orthographe exacte du titre.` }));
      return;
    }
    scanReader.append(emptyState({ glyph: "book", title: `${chapters.length} chapitres disponibles`, text: "Choisis un chapitre dans la liste pour commencer la lecture." }));
    notify(`${chapters.length} chapitres trouvés.`, { type: "success", timeout: 3200 });
  } catch (err) {
    scans.chapters = [];
    renderChapters();
    clear(scanReader);
    scanReader.append(emptyState({ glyph: "alert", tone: "error", title: "Chargement impossible", text: describeError(err) }));
  }
});

chapterFilter.addEventListener("input", debounce(renderChapters, 140));

async function loadChapter(number) {
  scans.current = number;
  renderChapters();
  clear(scanReader);
  scanReader.append(el("div", { class: "empty" }, [icon("book"), el("p", { class: "empty-title", text: `Chargement du chapitre ${number}…` })]));

  try {
    const data = await source.scanPages(scans.name, number);
    const pages = Array.isArray(data) ? data : (Object.values(data || {}).find(Array.isArray) || []);
    const urls = pages.map(safeUrl).filter(Boolean);

    clear(scanReader);
    if (!urls.length) {
      scanReader.append(emptyState({ glyph: "alert", tone: "error", title: "Chapitre vide", text: "L'API n'a renvoyé aucune image exploitable pour ce chapitre." }));
      return;
    }

    const index = scans.chapters.findIndex((c) => c.number === number);
    const widthSelect = el("select", { "aria-label": "Largeur de lecture" }, [
      el("option", { value: "comfy", text: "Largeur confortable" }),
      el("option", { value: "wide", text: "Large" }),
      el("option", { value: "full", text: "Pleine largeur" }),
      el("option", { value: "webtoon", text: "Webtoon (pages jointes)" }),
    ]);
    const pagesWrap = el("div", { class: "scan-pages", dataset: { width: "comfy" } });
    widthSelect.addEventListener("change", () => { pagesWrap.dataset.width = widthSelect.value; });

    scanReader.append(el("div", { class: "scan-toolbar" }, [
      el("strong", { text: `Chapitre ${number}` }),
      el("span", { class: "chip chip-sm", text: `${urls.length} pages` }),
      el("span", { class: "scan-spacer" }),
      el("div", { class: "field" }, widthSelect),
      el("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: index <= 0, onclick: () => loadChapter(scans.chapters[index - 1].number) }, [icon("prev"), el("span", { text: "Précédent" })]),
      el("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: index < 0 || index >= scans.chapters.length - 1, onclick: () => loadChapter(scans.chapters[index + 1].number) }, [el("span", { text: "Suivant" }), icon("next")]),
    ]));

    urls.forEach((url, i) => {
      const image = el("img", {
        class: "scan-page", src: url, alt: `Page ${i + 1}`,
        loading: i < 2 ? "eager" : "lazy", decoding: "async", referrerpolicy: "no-referrer",
      });
      image.addEventListener("error", () => {
        image.replaceWith(el("p", { class: "hint scan-page-error", text: `Page ${i + 1} : image bloquée par l'hébergeur (protection anti-hotlink).` }));
      }, { once: true });
      pagesWrap.append(image);
    });
    scanReader.append(pagesWrap);
    window.scrollTo({ top: 0, behavior: state.settings.motion ? "auto" : "smooth" });
  } catch (err) {
    clear(scanReader);
    scanReader.append(emptyState({ glyph: "alert", tone: "error", title: "Chapitre indisponible", text: describeError(err) }));
  }
}

/* ─────────────────────────────────────────────
   10b. Réglages
   ───────────────────────────────────────────── */
const apiStatusDot   = $("#apiStatusDot");
const apiStatusLabel = $("#apiStatusLabel");
const apiDiag        = $("#apiDiag");

const STATUS_LABELS = {
  online: "API OK", offline: "API KO", demo: "Démo",
  pending: "Test…", indexing: "Indexation…", unknown: "API ?",
};

function setApiStatus(status) {
  if (!status) return;
  // Tant que le serveur indexe, l'état du catalogue prime sur celui de la
  // connexion : afficher « API OK » ferait croire que la recherche est prête.
  if (indexing.seen && status !== "indexing") return;
  apiStatusDot.dataset.state = status === "indexing" ? "pending" : status;
  apiStatusLabel.textContent = STATUS_LABELS[status] || STATUS_LABELS.unknown;
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = ["dark", "abyss", "light"].includes(state.settings.theme) ? state.settings.theme : "dark";
  root.dataset.accent = state.settings.accent || "ember";
  root.dataset.motion = state.settings.motion ? "reduced" : "";
  root.dataset.compact = state.settings.compact ? "1" : "";
  for (const button of $$(".accent")) {
    button.setAttribute("aria-checked", String(button.dataset.accent === state.settings.accent));
  }
}

function syncSettingsUI() {
  $("#apiInput").value = state.settings.api;
  $("#timeoutInput").value = String(state.settings.timeout);
  $("#themeSelect").value = state.settings.theme;
  $("#motionToggle").checked = state.settings.motion;
  $("#compactToggle").checked = state.settings.compact;
  $("#defaultVersionSelect").value = state.settings.version;
  $("#defaultModeSelect").value = state.settings.mode;
  $("#autoplaySetting").checked = state.settings.autoplay;
  $("#autoplayToggle").checked = state.settings.autoplay;
  $("#rememberToggle").checked = state.settings.remember;
  $("#relaySelect").value = state.settings.relay;
  $("#demoToggle").checked = state.settings.demo;
  renderStats();
}

function renderStats() {
  const stats = $("#statsList");
  clear(stats);
  const watched = Object.values(state.progress)
    .reduce((total, entry) => total + Object.values(entry.episodes || {}).filter((e) => e.done).length, 0);
  const rows = [
    ["Favoris", state.favorites.length],
    ["Historique", state.history.length],
    ["Séries suivies", Object.keys(state.progress).length],
    ["Épisodes terminés", watched],
  ];
  for (const [label, value] of rows) {
    stats.append(el("div", {}, [el("dt", { text: label }), el("dd", { text: String(value) })]));
  }
}

function bindSetting(selector, event, handler) {
  $(selector).addEventListener(event, (e) => { handler(e.target); persist(); });
}

bindSetting("#apiInput", "change", (input) => {
  state.settings.api = input.value.trim();
  memory.seasons.clear();
  memory.episodes.clear();
  checkApi({ silent: true });
});
bindSetting("#timeoutInput", "change", (input) => {
  state.settings.timeout = clamp(Number(input.value) || 45, 3, 600);
  input.value = String(state.settings.timeout);
});
bindSetting("#themeSelect", "change", (input) => { state.settings.theme = input.value; applyAppearance(); });
bindSetting("#motionToggle", "change", (input) => { state.settings.motion = input.checked; applyAppearance(); });
bindSetting("#compactToggle", "change", (input) => { state.settings.compact = input.checked; applyAppearance(); });
bindSetting("#defaultVersionSelect", "change", (input) => { state.settings.version = input.value; });
bindSetting("#defaultModeSelect", "change", (input) => { state.settings.mode = input.value; });
bindSetting("#autoplaySetting", "change", (input) => {
  state.settings.autoplay = input.checked;
  $("#autoplayToggle").checked = input.checked;
});
bindSetting("#rememberToggle", "change", (input) => { state.settings.remember = input.checked; });
bindSetting("#relaySelect", "change", (input) => {
  state.settings.relay = input.value;
  if (player.current && player.kind !== "iframe") {
    mountSource(player.current, { seek: video.currentTime || null, relay: input.value === "always" });
  }
});
bindSetting("#demoToggle", "change", (input) => {
  state.settings.demo = input.checked;
  memory.seasons.clear();
  memory.episodes.clear();
  discover.items = [];
  discover.origin = "idle";
  renderDiscover();
  setApiStatus(input.checked ? "demo" : "unknown");
  notify(input.checked
    ? "Mode démo activé : données locales et vidéos de test libres de droits, aucun contenu Anime-Sama."
    : "Mode démo désactivé : le panel interroge de nouveau ton backend.",
    { type: "info", timeout: 5200 });
  if (!input.checked) checkApi({ silent: true });
});

$("#themeBtn").addEventListener("click", () => {
  const order = ["dark", "abyss", "light"];
  state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  applyAppearance();
  $("#themeSelect").value = state.settings.theme;
  persist();
  notify(`Thème : ${{ dark: "Sombre", abyss: "Abysse", light: "Clair" }[state.settings.theme]}`, { type: "info", timeout: 2200 });
});

$("#accentRow").addEventListener("click", (event) => {
  const button = event.target.closest(".accent");
  if (!button) return;
  state.settings.accent = button.dataset.accent;
  applyAppearance();
  persist();
});

$("#apiStatusBtn").addEventListener("click", () => { navigate("settings"); checkApi(); });

/* ── Diagnostic de connexion ── */
async function checkApi({ silent = false } = {}) {
  if (source.isDemo) { setApiStatus("demo"); return; }
  if (!silent) { apiDiag.hidden = false; apiDiag.textContent = "Test en cours…\n"; }
  setApiStatus("pending");

  const lines = [];
  const log = (line) => { lines.push(line); if (!silent) apiDiag.textContent = lines.join("\n"); };

  log(`Cible : ${apiBase() || "même origine que le panel (proxy serve.py)"}`);
  log(`Page servie depuis : ${location.origin === "null" ? "fichier local (file://)" : location.origin}`);
  if (mixedContentIssue()) log("⚠ Contenu mixte : page HTTPS + API HTTP, le navigateur bloquera tout.");

  const started = performance.now();
  try {
    await source.ping();
    const ms = Math.round(performance.now() - started);
    log(`✔ /?q=ping → réponse en ${ms} ms`);
    setApiStatus("online");
    if (!silent) notify(`Backend joignable (${ms} ms).`, { type: "success", title: "Connexion OK" });
  } catch (err) {
    log(`✘ ${describeError(err)}`);
    if (err instanceof ApiError && err.kind === "network") {
      log("");
      log("Causes fréquentes :");
      log("• le serveur Python n'est pas lancé (python main.py) ;");
      log("• le CORS n'est pas autorisé : ajoute flask-cors au backend (voir le README) ;");
      log("• l'URL ou le port ne correspondent pas.");
      if (err.detail) log(`Détail navigateur : ${err.detail}`);
    }
    setApiStatus("offline");
    if (!silent) notify(describeError(err), { type: "error", title: "Connexion impossible", timeout: 9000 });
    return;
  }

  if (silent) return;   // le sondage du catalogue est volumineux : réservé au test manuel

  try {
    const catalogue = await source.catalogue();
    log(`✔ /api/loadBaseAnimeData → ${catalogue.length} fiches en base`);
    if (!catalogue.length) log("  → base vide : lance /api/getAllAnime pour l'indexer (3 à 5 min).");
  } catch (err) {
    log(`✘ /api/loadBaseAnimeData → ${describeError(err)}`);
  }
}

$("#testApiBtn").addEventListener("click", () => checkApi());

$("#resolveDomainBtn").addEventListener("click", async () => {
  apiDiag.hidden = false;
  apiDiag.textContent = "Interrogation de /api/getAnimeSamaURL…";
  try {
    const data = await source.domain();
    const url = toArray(data)[0]?.url || data?.url || JSON.stringify(data);
    apiDiag.textContent = `Domaine Anime-Sama actif d'après le backend :\n${url}`;
  } catch (err) {
    apiDiag.textContent = `Échec : ${describeError(err)}`;
  }
});

/* ── Export / import / réinitialisation ── */
$("#exportBtn").addEventListener("click", () => {
  const payload = {
    format: "anime-sama-panel", version: 1, exportedAt: new Date().toISOString(),
    settings: state.settings, favorites: state.favorites, history: state.history, progress: state.progress,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `anime-sama-panel-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  notify("Données exportées.", { type: "success", timeout: 3200 });
});

$("#importBtn").addEventListener("click", () => $("#importInput").click());

$("#importInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object") throw new Error("Fichier illisible.");
    if (Array.isArray(parsed.favorites)) state.favorites = parsed.favorites.filter((f) => f && f.id && f.title);
    if (Array.isArray(parsed.history)) state.history = parsed.history.filter((h) => h && h.title).slice(0, HISTORY_MAX);
    if (parsed.progress && typeof parsed.progress === "object") state.progress = parsed.progress;
    if (parsed.settings && typeof parsed.settings === "object") {
      state.settings = { ...DEFAULT_SETTINGS, ...state.settings, ...parsed.settings };
      state.settings.timeout = clamp(Number(state.settings.timeout) || 45, 3, 600);
    }
    persist();
    applyAppearance();
    syncSettingsUI();
    renderFavorites();
    renderHistory();
    renderContinue();
    updateFavCount();
    notify("Données importées.", { type: "success" });
  } catch (err) {
    notify(`Import impossible : ${err.message}`, { type: "error", title: "Fichier invalide" });
  }
});

$("#resetBtn").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Tout réinitialiser ?",
    message: "Favoris, historique, progression, réglages et catalogue en cache seront supprimés définitivement de ce navigateur.",
    confirmLabel: "Tout supprimer",
    danger: true,
  });
  if (!ok) return;
  safeStorage.remove(STORE_KEY);
  safeStorage.remove(CATALOGUE_KEY);
  safeStorage.remove(RESOLVED_KEY);
  location.reload();
});

/* ─────────────────────────────────────────────
   10c. Raccourcis clavier
   ───────────────────────────────────────────── */
function isTyping(target) {
  return target instanceof HTMLElement &&
    (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable);
}

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === "/" && !isTyping(event.target)) {
    event.preventDefault();
    $("#quickSearchInput").focus();
    $("#quickSearchInput").select();
    return;
  }
  if (isTyping(event.target) || modal.open) return;

  const digit = Number(event.key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= VIEWS.length) {
    navigate(VIEWS[digit - 1]);
    return;
  }

  const playerReady = player.kind && player.kind !== "iframe" && !video.hidden;
  switch (event.key.toLowerCase()) {
    case "n": step(1); break;
    case "p": step(-1); break;
    case " ": case "k":
      if (!playerReady) return;
      event.preventDefault();
      video.paused ? video.play().catch(() => {}) : video.pause();
      break;
    case "arrowleft": if (!playerReady) return; event.preventDefault(); video.currentTime -= 5; break;
    case "arrowright": if (!playerReady) return; event.preventDefault(); video.currentTime += 5; break;
    case "j": if (!playerReady) return; video.currentTime -= 10; break;
    case "l": if (!playerReady) return; video.currentTime += 10; break;
    case "m": if (!playerReady) return; video.muted = !video.muted; break;
    case "f": $("#fullscreenBtn").click(); break;
    default: break;
  }
});

/* Un autre onglet vient d'écrire : on adopte ses données plutôt que de les
   écraser à la fermeture. La lecture en cours n'est pas interrompue. */
window.addEventListener("storage", (event) => {
  if (event.key !== STORE_KEY || !event.newValue) return;
  let incoming = null;
  try { incoming = JSON.parse(event.newValue); } catch { return; }
  if (!incoming || typeof incoming !== "object") return;

  state.settings = { ...DEFAULT_SETTINGS, ...(incoming.settings || {}) };
  state.favorites = Array.isArray(incoming.favorites) ? incoming.favorites : [];
  state.history = Array.isArray(incoming.history) ? incoming.history : [];
  state.progress = (incoming.progress && typeof incoming.progress === "object") ? incoming.progress : {};

  applyAppearance();
  syncSettingsUI();
  updateFavCount();
  updatePlayerFavButton();
  renderDiscover();
  renderFavorites();
  renderHistory();
  renderContinue();
  renderEpisodeStates();
});

// Un rechargement ou une fermeture dans les 250 ms ne doit pas perdre la dernière écriture.
function flushOnExit() { saveWatchTime(); persistNow(); }
window.addEventListener("pagehide", flushOnExit);
window.addEventListener("beforeunload", flushOnExit);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnExit(); });

/* ─────────────────────────────────────────────
   10d. Démarrage
   ───────────────────────────────────────────── */
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

init();

})();
