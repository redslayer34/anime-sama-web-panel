/** Cache persistant des épisodes : une saison déjà résolue doit se rouvrir
    instantanément après un rechargement de page, sans une seule requête de
    résolution — c'est le gain principal sur une instance qui s'endort et
    perd son propre cache. */
const { check: ck, launch, finish, watchPageErrors } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8605";
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";

(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  watchPageErrors(p);

  let calls = [];
  p.on("request", (r) => { if (r.url().includes("/api/getAnimeLink")) calls.push(r.url()); });

  // ── Première visite : la saison se résout normalement ───────────────
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.fill("#searchInput", "Frieren");
  await p.press("#searchInput", "Enter");
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });
  await p.click("#discoverResults .card:first-child .btn-primary");
  await p.waitForSelector("#episodeList .episode", { timeout: 10000 });

  // Le fond met 4 s à rendre la saison entière (voir api_smart.py).
  await p.waitForFunction(() => document.querySelectorAll(".episode.is-unresolved").length === 0,
    { timeout: 15000 });
  const firstVisitCalls = calls.length;
  ck("première visite : la saison est résolue par le réseau", firstVisitCalls > 0,
    firstVisitCalls + " appels");

  const stored = await p.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("animeSamaPanel.resolved.v1") || "{}");
    const key = Object.keys(raw)[0];
    return key ? { key, count: raw[key].count, episodes: raw[key].episodes.length } : null;
  });
  ck("la saison est conservée dans le navigateur", Boolean(stored), JSON.stringify(stored));
  ck("elle est conservée entière", stored && stored.episodes === stored.count,
    stored ? `${stored.episodes}/${stored.count}` : "rien");

  // ── Deuxième visite : plus rien ne doit partir sur le réseau ────────
  // Le rechargement restaure la dernière vue via l'ancre, donc le lecteur :
  // il faut revenir à la recherche avant de pouvoir s'en servir.
  await p.reload({ waitUntil: "networkidle" });
  await p.click('[data-nav="discover"]');
  await p.waitForSelector("#searchInput", { state: "visible", timeout: 5000 });
  calls = [];
  await p.fill("#searchInput", "Frieren");
  await p.press("#searchInput", "Enter");
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });

  const started = Date.now();
  await p.click("#discoverResults .card:first-child .btn-primary");
  await p.waitForSelector("#episodeList .episode", { timeout: 5000 });
  const elapsed = Date.now() - started;

  const count = await p.$$eval("#episodeList .episode", (n) => n.length);
  ck("les 12 épisodes reviennent immédiatement", count === 12, `${count} en ${elapsed} ms`);
  ck("ouverture quasi instantanée", elapsed < 1500, elapsed + " ms");
  ck("aucun épisode marqué « non résolu »",
    (await p.$$eval(".episode.is-unresolved", (n) => n.length)) === 0);
  ck("aucune requête de résolution", calls.length === 0, calls.length + " appels");

  // La lecture doit partir sans le moindre aller-retour.
  await p.click('.episode[data-episode="3"]');
  await p.waitForSelector("#video:not([hidden]), #frame:not([hidden])", { timeout: 2000 });
  ck("lecture immédiate depuis le cache", calls.length === 0, calls.length + " appels");
  await p.screenshot({ path: `${SHOTS}/14-cache-episodes.png` });

  // ── Recharger la liste doit repasser par le réseau ──────────────────
  await p.click("#reloadEpisodesBtn");
  await p.waitForFunction(() => document.querySelectorAll("#episodeList .episode").length > 0,
    { timeout: 15000 });
  ck("le rechargement manuel repart bien du réseau", calls.length > 0, calls.length + " appels");

  await b.close();
  finish("CACHE PERSISTANT DES ÉPISODES");
})();
