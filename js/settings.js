/* Anime-Sama Panel — Réglages, apparence, diagnostic de l'API, export et import. */
import {
  $, $$, CATALOGUE_KEY, clamp, clear, DEFAULT_SETTINGS, el, HISTORY_MAX, must, STORE_KEY,
  toArray
} from "./core.js";
import { persist, safeStorage, state } from "./store.js";
import { confirmDialog, navigate, notify } from "./ui.js";
import { apiBase, ApiError, describeError, memory, mixedContentIssue, source } from "./api.js";
import { discover, renderDiscover, updateFavCount } from "./discover.js";
import { indexing } from "./catalogue.js";
import { RESOLVED_KEY } from "./episodes.js";
import { mountSource, player, video } from "./player.js";
import { renderContinue, renderFavorites, renderHistory } from "./library.js";

const apiStatusDot   = must("#apiStatusDot");
const apiStatusLabel = must("#apiStatusLabel");
const apiDiag        = must("#apiDiag");

const STATUS_LABELS = {
  online: "API OK", offline: "API KO", demo: "Démo",
  pending: "Test…", indexing: "Indexation…", unknown: "API ?",
};

export function setApiStatus(status) {
  if (!status) return;
  // Tant que le serveur indexe, l'état du catalogue prime sur celui de la
  // connexion : afficher « API OK » ferait croire que la recherche est prête.
  if (indexing.seen && status !== "indexing") return;
  apiStatusDot.dataset.state = status === "indexing" ? "pending" : status;
  apiStatusLabel.textContent = STATUS_LABELS[status] || STATUS_LABELS.unknown;
}

export function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = ["dark", "abyss", "light"].includes(state.settings.theme) ? state.settings.theme : "dark";
  root.dataset.accent = state.settings.accent || "ember";
  root.dataset.motion = state.settings.motion ? "reduced" : "";
  root.dataset.compact = state.settings.compact ? "1" : "";
  for (const button of $$(".accent")) {
    button.setAttribute("aria-checked", String(button.dataset.accent === state.settings.accent));
  }
}

export function syncSettingsUI() {
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
  must(selector).addEventListener(event, (e) => { handler(e.target); persist(); });
}

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

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
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

  must("#themeBtn").addEventListener("click", () => {
    const order = ["dark", "abyss", "light"];
    state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    applyAppearance();
    $("#themeSelect").value = state.settings.theme;
    persist();
    notify(`Thème : ${{ dark: "Sombre", abyss: "Abysse", light: "Clair" }[state.settings.theme]}`, { type: "info", timeout: 2200 });
  });

  must("#accentRow").addEventListener("click", (event) => {
    const button = event.target.closest(".accent");
    if (!button) return;
    state.settings.accent = button.dataset.accent;
    applyAppearance();
    persist();
  });

  must("#apiStatusBtn").addEventListener("click", () => { navigate("settings"); checkApi(); });

  must("#testApiBtn").addEventListener("click", () => checkApi());

  must("#resolveDomainBtn").addEventListener("click", async () => {
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
  must("#exportBtn").addEventListener("click", () => {
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

  must("#importBtn").addEventListener("click", () => $("#importInput").click());

  must("#importInput").addEventListener("change", async (event) => {
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

  must("#resetBtn").addEventListener("click", async () => {
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
}
