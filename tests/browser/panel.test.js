const { check: ck, launch, finish, watchPageErrors, request } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8080";
const API  = process.env.API_URL   || "http://127.0.0.1:5000";
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";

const errors = [];

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  watchPageErrors(page);
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  console.log("\n— Réglages & connexion —");
  await page.click('[data-nav="settings"]');
  await page.fill("#apiInput", API);
  await page.dispatchEvent("#apiInput", "change");
  await page.click("#testApiBtn");
  await page.waitForFunction(() => document.querySelector("#apiDiag").textContent.includes("loadBaseAnimeData"), { timeout: 15000 });
  const diag = await page.textContent("#apiDiag");
  ck("ping API réussi", diag.includes("✔ /?q=ping"), diag.split("\n")[2]);
  ck("catalogue sondé", /5 fiches en base/.test(diag));
  ck("pastille API en ligne", await page.getAttribute("#apiStatusDot", "data-state") === "online");

  console.log("\n— Recherche —");
  await page.click('[data-nav="discover"]');
  await page.fill("#searchInput", "One");
  await page.press("#searchInput", "Enter");
  await page.waitForSelector("#discoverResults .card", { timeout: 10000 });
  ck("résultats affichés", (await page.$$("#discoverResults .card")).length === 1);
  ck("compteur mis à jour", (await page.textContent("#resultCount")).includes("1 titre"));

  await page.fill("#searchInput", "a");
  await page.press("#searchInput", "Enter");
  await page.waitForTimeout(300);
  ck("garde-fou < 2 caractères", (await page.$$(".toast")).length > 0);

  console.log("\n— Catalogue complet + filtrage instantané —");
  await page.click("#loadCatalogueBtn");
  await page.waitForFunction(() => document.querySelectorAll("#discoverResults .card").length === 5, { timeout: 10000 });
  ck("5 fiches du catalogue", (await page.$$("#discoverResults .card")).length === 5);
  await page.fill("#filterInput", "frier");
  await page.waitForTimeout(260);
  ck("filtre instantané", (await page.$$("#discoverResults .card")).length === 1);
  await page.fill("#filterInput", "");
  await page.waitForTimeout(260);

  console.log("\n— Favoris —");
  await page.click("#discoverResults .card:first-child .card-fav");
  ck("compteur de favoris", (await page.textContent("#navFavCount")) === "1");
  await page.click('[data-nav="favorites"]');
  ck("carte en favoris", (await page.$$("#favoritesGrid .card")).length === 1);

  console.log("\n— Ouverture d'une série —");
  await page.click('[data-nav="discover"]');
  await page.click("#discoverResults .card:first-child .btn-primary");
  await page.waitForSelector("#episodeList .episode", { timeout: 15000 });
  const epCount = (await page.$$("#episodeList .episode")).length;
  ck("8 épisodes en saison 1", epCount === 8, "reçu " + epCount);
  ck("3 saisons listées", (await page.$$("#seasonSelect option")).length === 3);
  ck("vue lecteur active", await page.getAttribute("#view-player", "class") === "view is-active");

  console.log("\n— Lecture : page de lecteur (iframe) —");
  await page.click('#episodeList .episode[data-episode="2"]');
  await page.waitForTimeout(500);
  ck("iframe affichée", await page.isVisible("#frame"));
  ck("vidéo masquée", !(await page.isVisible("#video")));
  ck("badge lecteur externe", (await page.textContent("#formatBadge")) === "Lecteur externe");
  ck("iframe en sandbox", (await page.getAttribute("#frame", "sandbox")).includes("allow-scripts"));
  ck("épisode courant marqué", (await page.getAttribute('#episodeList .episode[data-episode="2"]', "class")).includes("is-current"));

  console.log("\n— Lecture : fichier direct —");
  await page.click('#episodeList .episode[data-episode="3"]');
  await page.waitForTimeout(600);
  ck("balise vidéo affichée", await page.isVisible("#video"));
  ck("iframe masquée", !(await page.isVisible("#frame")));
  ck("badge vidéo", (await page.textContent("#formatBadge")) === "Vidéo");
  ck("src vidéo correct", (await page.getAttribute("#video", "src")) === BASE + "/tests/fixtures/test.mp4");
  await page.waitForTimeout(900);
  ck("erreur de décodage expliquée", await page.isVisible("#playerNote"), await page.textContent("#playerNote"));

  console.log("\n— Navigation entre épisodes —");
  await page.click("#nextBtn");
  await page.waitForTimeout(400);
  ck("épisode suivant chargé", (await page.textContent(".now-title")).includes("Épisode 4"));
  await page.click("#prevBtn");
  await page.waitForTimeout(400);
  ck("épisode précédent chargé", (await page.textContent(".now-title")).includes("Épisode 3"));

  console.log("\n— Saison 2 : épisodes démarrant à 0 —");
  await page.selectOption("#seasonSelect", "saison2");
  await page.waitForSelector('#episodeList .episode[data-episode="0"]', { timeout: 10000 });
  ck("épisode 0 présent", (await page.$$("#episodeList .episode")).length === 8);

  console.log("\n— Version absente : état vide explicite —");
  await page.selectOption("#versionSelect", "vf");
  await page.waitForSelector("#episodeList .empty", { timeout: 10000 });
  ck("état vide affiché", (await page.textContent("#episodeList .empty-title")) === "Aucun épisode");
  await page.selectOption("#versionSelect", "vostfr");
  await page.waitForSelector("#episodeList .episode", { timeout: 10000 });

  console.log("\n— Historique & reprise —");
  await page.click('[data-nav="history"]');
  const rows = (await page.$$("#historyList .row")).length;
  ck("historique alimenté", rows >= 3, rows + " lignes");
  
  ck("section « reprendre » visible", await page.isVisible("#continueGrid .card"));

  console.log("\n— Modale de confirmation —");
  await page.click("#clearHistoryBtn");
  await page.waitForSelector("dialog[open]");
  ck("modale ouverte", await page.isVisible("#modal"));
  await page.click("#modalFoot .btn-danger");
  await page.waitForTimeout(400);
  ck("historique vidé après confirmation", (await page.$$("#historyList .row")).length === 0);
  ck("état vide de l'historique", await page.isVisible("#historyList .empty"));

  console.log("\n— Scans —");
  await page.click('[data-nav="scans"]');
  await page.fill("#scanInput", "Frieren");
  await page.press("#scanInput", "Enter");
  await page.waitForSelector("#chapterList .chapter", { timeout: 10000 });
  ck("4 chapitres", (await page.$$("#chapterList .chapter")).length === 4);
  await page.click("#chapterList .chapter:first-child");
  await page.waitForSelector(".scan-page", { timeout: 10000 });
  ck("3 pages affichées", (await page.$$(".scan-page")).length === 3);
  ck("barre d'outils chapitre", await page.isVisible(".scan-toolbar"));

  console.log("\n— Thèmes, accents, mode démo —");
  await page.click('[data-nav="settings"]');
  await page.click("#themeBtn");
  ck("thème abysse", await page.getAttribute("html", "data-theme") === "abyss");
  await page.selectOption("#themeSelect", "light");
  ck("thème clair", await page.getAttribute("html", "data-theme") === "light");
  await page.selectOption("#themeSelect", "dark");
  await page.click('.accent[data-accent="rose"]');
  ck("accent rose", await page.getAttribute("html", "data-accent") === "rose");
  await page.click('.accent[data-accent="violet"]');

  await page.check("#demoToggle");
  await page.click('[data-nav="discover"]');
  await page.fill("#searchInput", "Démo");
  await page.press("#searchInput", "Enter");
  await page.waitForSelector("#discoverResults .card", { timeout: 10000 });
  ck("mode démo : résultats locaux", (await page.$$("#discoverResults .card")).length === 6);
  ck("pastille démo", await page.getAttribute("#apiStatusDot", "data-state") === "demo");
  await page.click('[data-nav="settings"]');
  await page.uncheck("#demoToggle");

  console.log("\n— Persistance —");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  ck("URL d'API conservée", (await page.inputValue("#apiInput")) === API);
  ck("favori conservé", (await page.textContent("#navFavCount")) === "1");

  console.log("\n— Raccourcis clavier —");
  await page.keyboard.press("2");
  await page.waitForTimeout(200);
  ck("touche 2 → lecteur", await page.isVisible("#view-player"));
  await page.keyboard.press("/");
  await page.waitForTimeout(200);
  ck("touche / → recherche de l'en-tête", await page.evaluate(() => document.activeElement.id) === "searchInput");
  await page.keyboard.press("Escape");

  console.log("\n— Captures —");
  await page.goto(BASE + "/#discover", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/01-decouvrir.png` });
  await page.fill("#searchInput", "Demon");
  await page.press("#searchInput", "Enter");
  await page.waitForSelector("#discoverResults .card", { timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/02-resultats.png` });
  await page.click("#discoverResults .card:first-child .btn-primary");
  await page.waitForSelector("#episodeList .episode", { timeout: 15000 });
  await page.click('#episodeList .episode[data-episode="2"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/05-lecteur.png` });
  await page.goto(BASE + "/#settings");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/03-parametres.png`, fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mobile.goto(BASE + "/#discover", { waitUntil: "networkidle" });
  await mobile.waitForTimeout(700);
  ck("nav basse en mobile", (await mobile.evaluate(() => getComputedStyle(document.querySelector(".sidebar")).position)) === "fixed");
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ck("pas de débordement horizontal", overflow <= 0, "delta " + overflow);
  await mobile.screenshot({ path: `${SHOTS}/04-mobile.png` });

  console.log("\n— Erreurs JavaScript —");
  const unexpected = errors.filter((e) => !/net::ERR|Failed to load resource|404|vidmoly|Format error|MEDIA_ELEMENT/i.test(e));
  ck("aucune erreur JS inattendue", unexpected.length === 0, unexpected.join(" | "));
  if (errors.length) console.log("  (bruit réseau attendu ignoré : " + errors.length + " message(s))");

  await browser.close();
  finish("PANEL");
})().catch((e) => { console.error("PLANTAGE:", e); process.exit(2); });
