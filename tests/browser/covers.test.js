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

  await page.click('[data-nav="history"]');
  await page.waitForSelector("#continueGrid .wide-card");
  ck("l'historique montre aussi l'image", (await page.$$('#continueGrid .wide-card[data-id="frieren"] .poster-wide > .poster-img')).length === 1);

  ck("aucune erreur JavaScript", errors.length === 0, errors.join(" | "));
  await browser.close();
  finish("JAQUETTES");
})().catch((e) => { console.error("PLANTAGE:", e); process.exit(2); });
