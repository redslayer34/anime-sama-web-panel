const { check: ck, launch, finish, watchPageErrors, request } = require("./lib");
const BASE = process.env.PANEL_URL || "http://127.0.0.1:8405";
const CREDS = { username: process.env.PANEL_USER || "panel",
                password: process.env.PANEL_PASSWORD || "mot-de-passe-test" };
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";

(async () => {
  const b = await launch();

  // Sans identifiants, via le client HTTP : Chromium refuserait de rendre le 401.
  const anon = await request.newContext();
  for (const [label, path] of [["/", "/"], ["/api", "/api/getSerchAnime?q=a&l=1"], ["/panel/state", "/panel/state"]]) {
    const r = await anon.get(BASE + path);
    ck(`sans identifiants, ${label} : 401`, r.status() === 401, "reçu " + r.status());
  }
  const health = await anon.get(BASE + "/healthz");
  ck("sans identifiants, /healthz : 200", health.status() === 200, "reçu " + health.status());
  await anon.dispose();

  const p = await b.newPage({ viewport: { width: 1280, height: 860 }, httpCredentials: CREDS });
  watchPageErrors(p);
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  ck("avec identifiants : panel chargé", (await p.title()).includes("Anime-Sama"));

  await p.waitForTimeout(1200);
  ck("backend détecté sur la même origine", await p.getAttribute("#apiStatusDot", "data-state") === "online",
     await p.textContent("#apiStatusLabel"));
  ck("champ API laissé vide", (await p.inputValue("#apiInput")) === "");

  await p.fill("#searchInput", "Frieren");
  await p.press("#searchInput", "Enter");
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });
  ck("recherche à travers le proxy authentifié", (await p.$$("#discoverResults .card")).length === 1);

  await p.click("#discoverResults .card:first-child .btn-primary");
  await p.waitForSelector("#episodeList .episode", { timeout: 15000 });
  ck("épisodes chargés", (await p.$$("#episodeList .episode")).length === 8);
  await p.click('#episodeList .episode[data-episode="2"]');
  await p.waitForTimeout(600);
  ck("lecture démarrée", await p.isVisible("#frame"));

  // /panel/state doit répondre avec les identifiants du contexte.
  const state = await p.evaluate(async () => (await fetch("/panel/state")).json());
  ck("/panel/state accessible", state.backend === true && state.protected === true, JSON.stringify(state));

  await p.screenshot({ path: `${SHOTS}/09-heberge.png` });
  await b.close();
  finish("ACCÈS PROTÉGÉ");
})();
