/** Chargement intelligent : l'épisode ciblé doit être jouable bien avant que
    toute la saison soit résolue, et un clic sur un épisode encore inconnu
    doit le résoudre à la demande sans bloquer le reste de la liste. */
const { check: ck, launch, finish, watchPageErrors } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8603";
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";
const SEASON_DELAY_MS = 4000;   // doit correspondre à SEASON_DELAY de api_smart.py

(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  watchPageErrors(p);

  const requests = [];
  p.on("request", (r) => { if (r.url().includes("/api/getAnimeLink")) requests.push(r.url()); });

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.fill("#searchInput", "Frieren");
  await p.press("#searchInput", "Enter");
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });

  const started = Date.now();
  await p.click("#discoverResults .card:first-child .btn-primary");

  // Les boutons doivent apparaître bien avant la fin de la saison entière
  // (4 s) : c'est tout l'intérêt du chargement intelligent.
  await p.waitForSelector("#episodeList .episode", { timeout: 3500 });
  const buttonsElapsed = Date.now() - started;
  const buttons = await p.$$("#episodeList .episode");
  ck("12 boutons affichés avant la fin de la saison", buttons.length === 12, `${buttons.length} en ${buttonsElapsed} ms`);
  ck("affichage bien avant les 4 s de la saison entière", buttonsElapsed < SEASON_DELAY_MS, buttonsElapsed + " ms");

  const firstReq = requests.find((u) => u.includes("&e="));
  ck("le premier appel cible un épisode précis (&e=)", Boolean(firstReq), firstReq || "aucun");

  // La cible par défaut (aucune progression sauvegardée) est l'épisode 0 :
  // résolu et sélectionné, mais l'ouverture d'un anime sans reprise ne lance
  // pas la lecture toute seule (comportement déjà en place, inchangé ici).
  await p.waitForFunction(
    () => !document.querySelector('.episode[data-episode="0"]')?.classList.contains("is-unresolved"),
    { timeout: 3500 });
  ck("épisode 0 résolu en premier", true);
  ck("épisode 0 sélectionné (pas encore lancé)",
    await p.evaluate(() => document.querySelector('.episode[data-episode="0"]')?.classList.contains("is-current")));

  const unresolvedBefore = await p.$$eval(".episode.is-unresolved", (nodes) => nodes.length);
  ck("les autres épisodes restent « non résolus » au départ", unresolvedBefore > 0, unresolvedBefore + " boutons");

  // Cliquer l'épisode déjà résolu doit être immédiat (aucune requête réseau,
  // c'est tout l'intérêt : la cible est déjà en mémoire).
  const playStart = Date.now();
  await p.click('.episode[data-episode="0"]');
  await p.waitForSelector("#video:not([hidden]), #frame:not([hidden])", { timeout: 1500 });
  const playElapsed = Date.now() - playStart;
  ck("lecture immédiate sur l'épisode déjà résolu", playElapsed < 1000, playElapsed + " ms");
  await p.screenshot({ path: `${SHOTS}/12-chargement-intelligent.png` });

  // Clic sur un épisode pas encore résolu : doit passer par « en résolution »
  // puis devenir jouable, sans qu'aucun autre bouton ne disparaisse.
  const targetBtn = '.episode[data-episode="7"]';
  await p.click(targetBtn);
  const becameResolving = await p.waitForSelector(`${targetBtn}.is-resolving`, { timeout: 1000 }).then(() => true).catch(() => false);
  ck("bouton cliqué passe par l'état « en résolution »", becameResolving);
  await p.waitForFunction(
    (sel) => !document.querySelector(sel)?.classList.contains("is-resolving"),
    targetBtn, { timeout: 3000 });
  const stillTwelve = await p.$$eval("#episodeList .episode", (nodes) => nodes.length);
  ck("le reste de la liste n'est pas perturbé par ce clic", stillTwelve === 12, stillTwelve);
  ck("l'épisode cliqué devient l'épisode courant", await p.evaluate((sel) => document.querySelector(sel)?.classList.contains("is-current"), targetBtn));

  // Le fond finit par tout résoudre : plus aucun bouton « non résolu ».
  await p.waitForFunction(() => document.querySelectorAll(".episode.is-unresolved").length === 0,
    { timeout: SEASON_DELAY_MS + 4000 });
  ck("saison entière résolue en tâche de fond", true);
  const finalCount = await p.textContent("#episodeCount");
  ck("compteur final cohérent", finalCount.trim() === "12", finalCount);

  await b.close();
  finish("CHARGEMENT INTELLIGENT");
})();
