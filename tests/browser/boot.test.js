/* Démarrage du panel en modules ES : tous les modules chargés, marque de
   démarrage posée, fichiers revalidés à chaque chargement — et, quand un
   module manque ou qu'un élément attendu a disparu, un bandeau qui le nomme
   au lieu d'une page inerte et muette. */
const fs = require("fs");
const path = require("path");
const { check: ck, launch, finish, request } = require("./lib");

const BASE = process.env.PANEL_URL || "http://127.0.0.1:8606";
const MODULES = fs.readdirSync(path.join(__dirname, "..", "..", "js")).filter((f) => f.endsWith(".js"));

async function bootError(page) {
  await page.waitForSelector("#bootError:not([hidden])", { timeout: 5000 }).catch(() => {});
  return (await page.isVisible("#bootError")) ? await page.textContent("#bootError") : "";
}

(async () => {
  const browser = await launch();

  console.log("\n— Démarrage normal —");
  let page = await browser.newPage();
  const loaded = new Set(), errors = [];
  page.on("request", (r) => { const m = r.url().match(/\/js\/([\w-]+\.js)$/); if (m) loaded.add(m[1]); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "load" });
  ck("marque de démarrage posée", (await page.getAttribute("html", "data-boot")) === "ok");
  ck(`les ${MODULES.length} modules de js/ chargés`, MODULES.every((m) => loaded.has(m)),
     MODULES.filter((m) => !loaded.has(m)).join(", "));
  ck("bandeau d'échec masqué", !(await page.isVisible("#bootError")));
  ck("aucune erreur au démarrage", errors.length === 0, errors.join(" | "));
  await page.close();

  console.log("\n— Module manquant —");
  page = await browser.newPage();
  await page.route("**/js/scans.js", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto(BASE + "/", { waitUntil: "load" });
  let text = await bootError(page);
  ck("bandeau affiché", text !== "");
  ck("le fichier manquant est nommé", text.includes("js/scans.js"), text);
  ck("pas de marque de démarrage", (await page.getAttribute("html", "data-boot")) === null);
  await page.close();

  console.log("\n— Élément attendu absent de la page —");
  page = await browser.newPage();
  await page.route(BASE + "/", async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace('id="prevBtn"', 'id="prevBtn-retire"');
    await route.fulfill({ response, body: html });
  });
  await page.goto(BASE + "/", { waitUntil: "load" });
  text = await bootError(page);
  ck("bandeau affiché", text !== "");
  ck("l'élément manquant est nommé", text.includes("#prevBtn"), text);
  await page.close();

  console.log("\n— Fichiers du panel : revalidés à chaque chargement —");
  const api = await request.newContext();
  const first = await api.get(BASE + "/js/core.js");
  ck("servi comme JavaScript", /javascript/.test(first.headers()["content-type"] || ""), first.headers()["content-type"]);
  ck("Cache-Control: no-cache", first.headers()["cache-control"] === "no-cache", first.headers()["cache-control"]);
  const again = await api.get(BASE + "/js/core.js", { headers: { "If-Modified-Since": first.headers()["last-modified"] } });
  ck("304 quand rien n'a changé", again.status() === 304, String(again.status()));
  await api.dispose();

  await browser.close();
  finish("DÉMARRAGE");
})().catch((e) => { console.error("PLANTAGE:", e); process.exit(2); });
