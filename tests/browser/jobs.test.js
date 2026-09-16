const { check: ck, launch, finish, watchPageErrors, request } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8501";
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";

(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  watchPageErrors(p);

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.fill("#searchInput", "Frieren");
  await p.press("#searchInput", "Enter");
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });
  const started = Date.now();
  await p.click("#discoverResults .card:first-child .btn-primary");

  // Le message de progression doit apparaître pendant la résolution.
  await p.waitForFunction(
    () => (document.querySelector("#episodeList")?.textContent || "").includes("Résolution des épisodes"),
    { timeout: 20000 });
  const progress = await p.textContent("#episodeList");
  ck("message de progression affiché", progress.includes("Résolution des épisodes"), progress.trim().slice(0, 80));
  ck("compteur de secondes présent", /\d+ s\./.test(progress));
  await p.screenshot({ path: `${SHOTS}/10-resolution.png` });

  await p.waitForSelector("#episodeList .episode", { timeout: 60000 });
  const elapsed = Math.round((Date.now() - started) / 1000);
  ck("28 épisodes chargés", (await p.$$("#episodeList .episode")).length === 28, elapsed + " s");
  ck("aucune erreur affichée", !(await p.isVisible("#episodeList .empty")));

  // Seconde saison / rechargement : doit venir du cache serveur, donc rapide.
  const t2 = Date.now();
  await p.click("#reloadEpisodesBtn");
  await p.waitForSelector("#episodeList .episode", { timeout: 20000 });
  const again = Date.now() - t2;
  ck("rechargement servi par le cache", again < 6000, again + " ms");

  await b.close();
  finish("TÂCHES DE FOND");
})();
