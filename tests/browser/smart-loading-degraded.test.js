/** Dégradation propre : un backend qui ignore le paramètre &e (non patché,
    comme un clone AnimeSamaApi lancé hors de l'image Docker) doit toujours
    fonctionner — juste sans le bénéfice du chargement rapide. Le panel
    détecte la réponse en tableau simple et retombe sur le comportement
    d'avant, sans bouton « non résolu » ni erreur visible. */
const { check: ck, launch, finish, watchPageErrors } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8604";
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";

(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  watchPageErrors(p);

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.fill("#searchInput", "Frieren");
  await p.press("#searchInput", "Enter");
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });
  await p.click("#discoverResults .card:first-child .btn-primary");

  // Le backend simulé met 4 s à répondre, en tableau complet, quel que soit &e.
  await p.waitForSelector("#episodeList .episode", { timeout: 15000 });
  const buttons = await p.$$("#episodeList .episode");
  ck("12 épisodes affichés malgré la dégradation", buttons.length === 12, buttons.length);

  const unresolved = await p.$$eval(".episode.is-unresolved", (nodes) => nodes.length);
  ck("aucun bouton marqué « non résolu » (tout est déjà là)", unresolved === 0, unresolved);

  ck("aucun état d'erreur affiché", !(await p.isVisible("#episodeList .empty")));
  await p.screenshot({ path: `${SHOTS}/13-degradation.png` });

  // Cliquer un épisode fonctionne toujours, instantanément (déjà en mémoire).
  const t0 = Date.now();
  await p.click('.episode[data-episode="5"]');
  await p.waitForSelector("#video:not([hidden]), #frame:not([hidden])", { timeout: 2000 });
  ck("lecture immédiate (aucune requête réseau nécessaire)", Date.now() - t0 < 1500, (Date.now() - t0) + " ms");

  await b.close();
  finish("DÉGRADATION SANS BACKEND PATCHÉ");
})();
