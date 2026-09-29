/* Jaquettes des séries suivies : une lecture enregistrée avant l'existence des
   jaquettes (aucune image mémorisée) doit retrouver la sienne dans le
   catalogue, et la mémoriser. Une série inconnue du catalogue garde l'affiche
   dessinée, sans erreur. */
const { check: ck, launch, finish } = require("./lib");
const BASE = process.env.PANEL_URL || "http://127.0.0.1:8607";

const entry = (id, title, ep) => ({
  animeId: id, title, animeUrl: `https://anime-sama.org/catalogue/${id}/`,
  seasonLabel: "Saison 1", seasonSlug: "saison1", version: "vostfr",
  lastEpisode: ep, episodes: { [ep]: { t: 300, d: 1400 } }, updatedAt: Date.now(),
});

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const seed = {
    settings: {}, favorites: [], history: [], covers: {}, meta: { migrated: true },
    progress: {
      "frieren::saison1::vostfr": entry("frieren", "Frieren", 3),
      "inconnu::saison1::vostfr": entry("inconnu", "Série Inconnue", 2),
      "demon-slayer::saison1::vostfr": entry("demon-slayer", "Demon Slayer", 5),
    },
  };
  await ctx.addInitScript((s) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("animeSamaPanel.v1", JSON.stringify(s));
      sessionStorage.setItem("seeded", "1");
    }
  }, seed);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(BASE + "/", { waitUntil: "load" });
  // Le catalogue se précharge en tâche de fond ; l'accueil se reconstruit à l'arrivée.
  await page.waitForSelector('#homeRails .wide-card[data-id="frieren"] .poster-wide > .poster-img', { timeout: 15000 }).catch(() => {});

  const card = (id) => `#homeRails .wide-card[data-id="${id}"]`;
  ck("reprise sans jaquette mémorisée : l'image du catalogue s'affiche",
     (await page.$$(`${card("frieren")} .poster-wide > .poster-img`)).length === 1);
  ck("pas d'affiche dessinée pour cette série", (await page.$$(`${card("frieren")} .poster-wide > .poster-gen`)).length === 0);
  ck("série absente du catalogue : affiche dessinée",
     (await page.$$(`${card("inconnu")} .poster-gen`)).length >= 1);

  await page.waitForTimeout(500);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("animeSamaPanel.v1")).covers || {});
  ck("jaquette mémorisée pour la suite", !!stored.frieren, JSON.stringify(stored));
  ck("rien de mémorisé pour l'inconnue", !stored.inconnu);

  // Forme et résolution natives : le CSS s'appuie dessus pour ne rien couper ni agrandir.
  await page.waitForSelector(`${card("demon-slayer")} .poster-wide[data-shape]`, { timeout: 8000 }).catch(() => {});
  const shape = (id) => page.getAttribute(`${card(id)} .poster-wide`, "data-shape");
  ck("image paysage détectée", (await shape("demon-slayer")) === "landscape");
  ck("image portrait détectée", (await shape("frieren")) === "portrait");
  ck("largeur native exposée",
     (await page.evaluate((sel) => document.querySelector(sel).style.getPropertyValue("--nat-w"), `${card("demon-slayer")} .poster-wide`)) === "800px");
  const art = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".hero-art")].find((n) => n.dataset.shape === "landscape");
    return el ? { w: el.getBoundingClientRect().width, nat: parseFloat(el.style.getPropertyValue("--nat-w")) } : null;
  });
  ck("héros paysage : jamais agrandi au-delà de 1,4 × sa résolution native",
     !art || art.w <= art.nat * 1.4 + 1, art ? `${Math.round(art.w)} px pour ${art.nat} px natifs` : "aucun héros paysage");

  await page.click('[data-nav="history"]');
  await page.waitForSelector("#continueGrid .wide-card");
  ck("l'historique montre aussi l'image", (await page.$$('#continueGrid .wide-card[data-id="frieren"] .poster-wide > .poster-img')).length === 1);

  ck("aucune erreur JavaScript", errors.length === 0, errors.join(" | "));
  await browser.close();
  finish("JAQUETTES");
})().catch((e) => { console.error("PLANTAGE:", e); process.exit(2); });
