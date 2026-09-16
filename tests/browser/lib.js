/** Harnais commun aux tests navigateur : lancement, comptage, sortie. */
const { chromium, request } = require("playwright");

const state = { failures: 0, checks: 0 };

function check(label, ok, extra = "") {
  state.checks++;
  if (!ok) state.failures++;
  console.log(`${ok ? "  ok " : "  KO "} ${label}${extra ? " :: " + extra : ""}`);
}

async function launch() {
  // CHROMIUM_PATH sert aux environnements où le navigateur est déjà installé
  // ailleurs que dans le cache de Playwright.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch(executablePath ? { executablePath } : {});
}

function finish(title) {
  const ok = state.failures === 0;
  console.log(`\n${title} : ${ok ? "TOUT EST VERT" : state.failures + " ÉCHEC(S)"}` +
              ` (${state.checks} vérifications)`);
  process.exit(ok ? 0 : 1);
}

/** Signale une erreur JavaScript de la page comme un échec de test. */
function watchPageErrors(page) {
  page.on("pageerror", (err) => check("aucune erreur JavaScript", false, err.message));
}

module.exports = { check, launch, finish, watchPageErrors, request, state };
