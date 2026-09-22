/* Anime-Sama Panel — Couche API : requêtes, tâches 202, normalisation, mode démo. */
import {
  clamp, deaccent, JOB_MAX_WAIT, JOB_POLL, MEM_TTL, pick, safeUrl, slugify, toArray
} from "./core.js";
import { state } from "./store.js";

export class ApiError extends Error {
  constructor(message, kind = "unknown", detail = "") {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.detail = detail;
  }
}

export function apiBase() { return String(state.settings.api || "").trim().replace(/\/+$/, ""); }

export function mixedContentIssue() {
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
export async function request(path, options = {}) {
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
export function animeIdFrom(title, url) {
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

export function seasonSlug(label, url) {
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
export const memory = { seasons: new Map(), episodes: new Map(), pending: new Map() };

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

export function invalidate(key) { memory.seasons.delete(key); memory.episodes.delete(key); }

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
export const source = {
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
export function describeError(err) {
  if (err instanceof ApiError) return err.message;
  if (err?.name === "AbortError") return "Requête annulée.";
  return String(err?.message || err || "Erreur inconnue.");
}
