/* Anime-Sama Panel — Accueil : héros et rangées, affichés tant qu'aucune recherche n'est lancée. */
import { clear, el, icon, must } from "./core.js";
import { coverFor, posterBox, titleHue } from "./covers.js";
import { state } from "./store.js";
import { animeCard, discover, isFavorite, showAnimeDetails } from "./discover.js";
import { homePool } from "./catalogue.js";
import { openAnime } from "./episodes.js";

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
const heroPoster  = must("#heroPoster");
const heroEyebrow = must("#heroEyebrow");
const heroTitle   = must("#heroTitle");
const heroSub     = must("#heroSub");
const heroMeta    = must("#heroMeta");
const heroActions = must("#heroActions");
const homeRails   = must("#homeRails");

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

export function renderHome() {
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
