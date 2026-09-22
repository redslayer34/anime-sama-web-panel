/* Anime-Sama Panel — Accueil : héros et rangées, affichés tant qu'aucune recherche n'est lancée. */
import { clamp, clear, el, icon, must } from "./core.js";
import { posterBox, titleHue } from "./covers.js";
import { state } from "./store.js";
import { navigate } from "./ui.js";
import { animeCard, discover, isFavorite, showAnimeDetails, toggleFavorite } from "./discover.js";
import { homePool } from "./catalogue.js";
import { openAnime } from "./episodes.js";
import { continueCard } from "./library.js";

/* ─────────────────────────────────────────────
   Accueil : héros et rangées

   Ce n'est pas une vue séparée mais l'état au repos de « Découvrir ».
   L'ancien écran vide invitait à taper une recherche — la pire entrée en
   matière possible. Il est remplacé par ce que l'utilisateur a déjà :
   ce qu'il regarde, sa liste, et de quoi explorer.
   ───────────────────────────────────────────── */
const homeBlock   = must("#homeBlock");
const hero        = must("#hero");
const heroBg      = must("#heroBg");
const heroBody    = must("#heroBody");
const heroEyebrow = must("#heroEyebrow");
const heroTitle   = must("#heroTitle");
const heroSub     = must("#heroSub");
const heroMeta    = must("#heroMeta");
const heroActions = must("#heroActions");
const heroDots    = must("#heroDots");
const homeRails   = must("#homeRails");

const HERO_MAX = 5;
const HERO_DELAY = 9000;          // assez long pour lire le titre et choisir

/** Reprises les plus récentes, transformées en fiches présentables. */
function continueEntries(limit = 12) {
  return Object.values(state.progress)
    .filter((entry) => entry.lastEpisode != null)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
}

export function animeFromProgress(entry) {
  return {
    id: entry.animeId, title: entry.title, alt: "",
    url: entry.animeUrl || null, cover: state.covers[entry.animeId] || null,
    score: null, index: 0,
  };
}

export function animeFromFavorite(fav) {
  return {
    id: fav.id, title: fav.title, alt: "",
    url: fav.url || null, cover: fav.cover || state.covers[fav.id] || null,
    score: null, index: 0,
  };
}

/** Choix stable dans la journée : la sélection ne doit pas se réordonner à
    chaque rendu, sinon la page semble instable. */
function daySeed() {
  const now = new Date();
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

function pickSpread(items, count, offset = 0) {
  if (items.length <= count) return items.slice();
  const step = Math.max(1, Math.floor(items.length / count));
  const start = (daySeed() + offset) % step;
  const out = [];
  for (let i = start; i < items.length && out.length < count; i += step) out.push(items[i]);
  return out;
}

function reducedMotion() {
  return state.settings.motion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/* ── Héros en carrousel ─────────────────────── */
const carousel = { slides: [], index: 0, signature: "", timer: 0, paused: false };

/** Reprises d'abord, puis Ma liste, puis la sélection du jour : le héros
    parle de ce que l'utilisateur regarde avant de lui suggérer autre chose. */
function heroSlides() {
  const slides = [];
  const seen = new Set();
  const push = (anime, kind, resume = null) => {
    if (!anime?.id || seen.has(anime.id) || slides.length >= HERO_MAX) return;
    seen.add(anime.id);
    slides.push({ anime, kind, resume });
  };
  for (const entry of continueEntries(2)) push(animeFromProgress(entry), "resume", entry);
  for (const fav of state.favorites.slice(0, 2)) push(animeFromFavorite(fav), "list");
  const pool = homePool().filter((a) => a.cover);
  for (const anime of pickSpread(pool, HERO_MAX, 3)) push(anime, "pick");
  return slides;
}

function remaining(entry) {
  const saved = entry?.episodes?.[entry.lastEpisode];
  if (!saved?.d || saved.done) return null;
  return Math.max(1, Math.round((saved.d - saved.t) / 60));
}

function slideContent(slide) {
  const { anime, kind, resume } = slide;
  const eyebrows = { resume: "Reprendre", list: "Dans ma liste", pick: "Sélection du jour" };
  heroEyebrow.textContent = eyebrows[kind];
  heroTitle.textContent = anime.title;

  heroSub.textContent = resume
    ? `${resume.seasonLabel} · Épisode ${resume.lastEpisode} · ${String(resume.version).toUpperCase()}`
    : (anime.alt || "");
  heroSub.hidden = !heroSub.textContent;

  clear(heroMeta);
  if (resume) {
    const saved = resume.episodes?.[resume.lastEpisode];
    const ratio = saved?.d ? clamp(saved.t / saved.d, 0, 1) : 0;
    const left = remaining(resume);
    if (ratio > 0) heroMeta.append(el("span", { class: "hero-progress", "aria-hidden": "true" },
      el("i", { style: { width: `${ratio * 100}%` } })));
    if (left) heroMeta.append(el("span", { class: "hero-left", text: `${left} min restantes` }));
  }
  heroMeta.hidden = !heroMeta.childElementCount;

  const inList = isFavorite(anime.id);
  clear(heroActions);
  heroActions.append(
    el("button", {
      type: "button", class: "btn btn-primary btn-lg",
      onclick: () => openAnime(anime, resume
        ? { seasonSlug: resume.seasonSlug, version: resume.version, episode: resume.lastEpisode }
        : {}),
    }, [icon("play"), el("span", { text: resume ? `Reprendre l'épisode ${resume.lastEpisode}` : "Regarder" })]),
    el("button", {
      type: "button", class: `btn btn-glass btn-lg${inList ? " is-on" : ""}`,
      "aria-pressed": String(inList),
      onclick: () => { toggleFavorite(anime); slideContent(slide); },
    }, [icon(inList ? "check" : "plus"), el("span", { text: "Ma liste" })]),
    el("button", {
      type: "button", class: "btn btn-glass btn-lg btn-icon-lg",
      title: "Plus d'infos", "aria-label": `Plus d'infos sur ${anime.title}`,
      onclick: () => showAnimeDetails(anime),
    }, icon("info")),
  );

  // La teinte vient du titre : disponible même quand l'image ne l'est pas.
  hero.style.setProperty("--hero-tint", `hsl(${titleHue(anime.title)} 62% 40% / .38)`);
}

function showSlide(index, { animate = true } = {}) {
  const count = carousel.slides.length;
  if (!count) return;
  carousel.index = (index + count) % count;
  const slide = carousel.slides[carousel.index];

  heroBg.querySelectorAll(".hero-slide").forEach((layer, i) => layer.classList.toggle("is-active", i === carousel.index));
  heroDots.querySelectorAll("button").forEach((dot, i) => {
    dot.classList.toggle("is-active", i === carousel.index);
    dot.setAttribute("aria-current", i === carousel.index ? "true" : "false");
  });

  slideContent(slide);
  if (animate && !reducedMotion()) {
    heroBody.classList.remove("is-entering");
    void heroBody.offsetWidth;                    // relance l'animation d'entrée
    heroBody.classList.add("is-entering");
  }
  restartTimer();
}

function restartTimer() {
  clearInterval(carousel.timer);
  carousel.timer = 0;
  if (carousel.slides.length < 2 || reducedMotion()) return;
  hero.style.setProperty("--hero-delay", `${HERO_DELAY}ms`);
  heroDots.classList.remove("is-running");
  void heroDots.offsetWidth;
  heroDots.classList.add("is-running");
  carousel.timer = setInterval(() => {
    const root = document.documentElement;
    // Rien ne défile quand personne ne regarde : onglet caché, autre vue,
    // survol ou focus dans le héros.
    if (document.hidden || carousel.paused || root.dataset.view !== "discover" || root.dataset.browse !== "idle") return;
    showSlide(carousel.index + 1);
  }, HERO_DELAY);
}

function renderHero() {
  const slides = heroSlides();
  if (!slides.length) {
    hero.hidden = true;
    clearInterval(carousel.timer);
    return false;
  }
  hero.hidden = false;

  // Même sélection qu'au rendu précédent : on ne reconstruit pas les images
  // (et on ne ramène pas le carrousel au début), on rafraîchit le texte.
  const signature = slides.map((s) => `${s.kind}:${s.anime.id}:${s.resume?.lastEpisode ?? ""}`).join("|");
  if (signature === carousel.signature) {
    carousel.slides = slides;
    slideContent(slides[carousel.index] || slides[0]);
    return true;
  }
  carousel.signature = signature;
  carousel.slides = slides;

  clear(heroBg);
  clear(heroDots);
  slides.forEach((slide, i) => {
    heroBg.append(el("div", { class: "hero-slide" }, [
      posterBox(slide.anime, { className: "hero-ambient", eager: i === 0 }),
      posterBox(slide.anime, { className: "hero-art", eager: i === 0 }),
    ]));
    if (slides.length > 1) heroDots.append(el("button", {
      type: "button", class: "hero-dot",
      "aria-label": `Titre ${i + 1} sur ${slides.length} : ${slide.anime.title}`,
      onclick: () => showSlide(i),
    }, el("i")));
  });
  heroDots.hidden = slides.length < 2;
  showSlide(Math.min(carousel.index, slides.length - 1), { animate: false });
  return true;
}

/* ── Rangées ────────────────────────────────── */

/** Rangée horizontale : défilement confiné, flèches au survol, et un pas
    calé sur la largeur visible plutôt que sur un nombre de cartes. */
function buildRail(title, cards, { more = null, wide = false } = {}) {
  if (!cards.length) return null;

  const track = el("div", { class: wide ? "rail-track rail-track-wide" : "rail-track" }, cards);

  const scrollBy = (dir) => track.scrollBy({
    left: dir * Math.max(240, track.clientWidth * 0.85),
    behavior: reducedMotion() ? "auto" : "smooth",
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
      more ? el("button", { type: "button", class: "rail-more", onclick: more.onClick },
        [el("span", { text: more.label }), icon("next")]) : null,
    ]),
    el("div", { class: "rail" }, [prev, track, next]),
  ]);
}

const openCatalogue = () => document.getElementById("loadCatalogueBtn")?.click();

export function renderHome() {
  // L'accueil cède la place dès qu'une recherche ou le catalogue remplit
  // la grille : une seule surface à la fois, jamais les deux.
  if (discover.origin !== "idle") { homeBlock.hidden = true; return; }

  const hasHero = renderHero();
  const pool = homePool();

  clear(homeRails);
  const scored = pool.filter((a) => Number.isFinite(a.score)).sort((a, b) => b.score - a.score);
  const daily = pickSpread(pool, 18);
  const dailyIds = new Set(daily.map((a) => a.id));
  const discoverMore = pickSpread(pool.filter((a) => !dailyIds.has(a.id)), 18, 7);
  const rails = [
    buildRail("Reprendre la lecture", continueEntries().map((entry) => continueCard(entry)),
      { wide: true, more: { label: "Historique", onClick: () => navigate("history") } }),
    buildRail("Ma liste", state.favorites.slice(0, 18).map((fav) => animeCard(animeFromFavorite(fav))),
      { more: { label: "Tout voir", onClick: () => navigate("favorites") } }),
    buildRail("Les plus pertinents", scored.slice(0, 18).map((a) => animeCard(a))),
    buildRail("Sélection du jour", daily.map((a) => animeCard(a)),
      { more: { label: "Catalogue", onClick: openCatalogue } }),
    // Inutile de proposer une seconde sélection quand le catalogue tient en
    // une rangée : ce serait deux fois la même chose.
    pool.length >= 40 ? buildRail("À découvrir", discoverMore.map((a) => animeCard(a)),
      { more: { label: "Catalogue", onClick: openCatalogue } }) : null,
  ].filter(Boolean);

  for (const rail of rails) homeRails.append(rail);
  homeBlock.hidden = !hasHero && !rails.length;
}

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
  // Le carrousel se tient tranquille tant qu'on survole ou qu'on navigue au
  // clavier dans le héros.
  const pause = (value) => () => {
    carousel.paused = value;
    heroDots.classList.toggle("is-paused", value);
  };
  hero.addEventListener("pointerenter", pause(true));
  hero.addEventListener("pointerleave", pause(false));
  hero.addEventListener("focusin", pause(true));
  hero.addEventListener("focusout", pause(false));
}
