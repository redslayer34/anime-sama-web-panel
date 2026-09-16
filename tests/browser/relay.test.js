const { check: ck, launch, finish, watchPageErrors, request } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8602";
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";

(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  watchPageErrors(p);

  const relayHits = [];
  p.on("request", r => { if (r.url().includes("/stream?u=")) relayHits.push(r.url()); });

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.fill("#searchInput", "Frieren");
  await p.press("#searchInput", "Enter");
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });
  await p.click("#discoverResults .card:first-child .btn-primary");
  await p.waitForSelector("#episodeList .episode", { timeout: 30000 });

  // Épisode 1 : MP4 direct servi par un hôte qui refuse sans Referer.
  await p.click('#episodeList .episode[data-episode="1"]');
  await p.waitForTimeout(3500);

  const badge = await p.textContent("#formatBadge");
  ck("bascule automatique sur le relais", badge.includes("relais"), badge);
  ck("le lecteur interroge bien le relais", relayHits.length > 0, relayHits.length + " requête(s)");
  ck("notification de bascule", (await p.textContent("#toasts")).includes("via le serveur"));
  const src = await p.getAttribute("#video", "src");
  ck("source du lecteur pointant sur le relais", (src || "").includes("/stream?u="), (src || "").slice(0, 60));
  await p.screenshot({ path: `${SHOTS}/11-relais.png` });

  // Réglage « jamais » : plus de bascule.
  await p.click('[data-nav="settings"]');
  await p.selectOption("#relaySelect", "never");
  await p.click('[data-nav="player"]');
  relayHits.length = 0;
  await p.click('#episodeList .episode[data-episode="2"]');
  await p.waitForTimeout(3000);
  ck("réglage « jamais » respecté", relayHits.length === 0, relayHits.length + " requête(s)");
  ck("message d'erreur affiché à la place", await p.isVisible("#playerNote"));

  // Réglage « toujours » : relais dès la première tentative.
  await p.click('[data-nav="settings"]');
  await p.selectOption("#relaySelect", "always");
  await p.click('[data-nav="player"]');
  relayHits.length = 0;
  await p.click('#episodeList .episode[data-episode="4"]');
  await p.waitForTimeout(2500);
  ck("réglage « toujours » : relais immédiat", relayHits.length > 0, relayHits.length + " requête(s)");

  await b.close();
  finish("RELAIS VIDÉO");
})();
