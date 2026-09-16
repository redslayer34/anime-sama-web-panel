const { check: ck, launch, finish, watchPageErrors, request } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8403";
const SHOTS = process.env.SHOTS_DIR || "tests/screenshots";

(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  watchPageErrors(p);

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  ck("bannière affichée pendant l'indexation", await p.isVisible("#indexBanner"));
  ck("texte explicite", (await p.textContent("#indexText")).includes("3 à 5 minutes"));
  ck("pastille « Indexation »", (await p.textContent("#apiStatusLabel")).includes("Indexation"), await p.textContent("#apiStatusLabel"));
  await p.screenshot({ path: `${SHOTS}/08-indexation.png` });

  // L'indexation simulée dure 4 s ; la sonde repasse toutes les 5 s.
  await p.waitForSelector("#indexBanner", { state: "hidden", timeout: 25000 });
  ck("bannière retirée à la fin", !(await p.isVisible("#indexBanner")));
  await p.waitForSelector("#discoverResults .card", { timeout: 15000 });
  ck("catalogue chargé automatiquement", (await p.$$("#discoverResults .card")).length === 42);
  ck("notification de fin", (await p.textContent("#toasts")).includes("Indexation terminée"));
  await b.close();
  finish("INDEXATION");
})();
