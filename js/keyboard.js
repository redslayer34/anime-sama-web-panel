/* Anime-Sama Panel — Raccourcis clavier, synchronisation entre onglets, sauvegarde en sortie. */
import { $, DEFAULT_SETTINGS, STORE_KEY, VIEWS } from "./core.js";
import { persistNow, state } from "./store.js";
import { modal, navigate } from "./ui.js";
import { renderDiscover, updateFavCount } from "./discover.js";
import { renderEpisodeStates } from "./episodes.js";
import { player, saveWatchTime, step, updatePlayerFavButton, video } from "./player.js";
import { renderContinue, renderFavorites, renderHistory } from "./library.js";
import { applyAppearance, syncSettingsUI } from "./settings.js";

function isTyping(target) {
  return target instanceof HTMLElement &&
    (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable);
}

// Un rechargement ou une fermeture dans les 250 ms ne doit pas perdre la dernière écriture.
function flushOnExit() { saveWatchTime(); persistNow(); }

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
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

  window.addEventListener("pagehide", flushOnExit);

  window.addEventListener("beforeunload", flushOnExit);

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnExit(); });
}
