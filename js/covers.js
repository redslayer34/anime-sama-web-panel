/* Anime-Sama Panel — Jaquettes : URL directe, relais /img, puis affiche générée. */
import { el, panelServer, safeUrl } from "./core.js";
import { COVERS_MAX, persist, state } from "./store.js";

/* ─────────────────────────────────────────────
   Jaquettes

   Le catalogue amont fournit une URL d'affiche pour chaque fiche. Trois
   obstacles séparent cette URL d'une image à l'écran, d'où la chaîne de
   repli ci-dessous :
     1. l'hébergeur refuse souvent une requête sans Referer cohérent — et
        la page impose `referrer: no-referrer` ;
     2. le CDN peut être filtré par le réseau de l'utilisateur ;
     3. certaines fiches n'ont tout simplement pas d'image.
   On tente donc l'URL directe, puis le relais du serveur (qui ajoute le
   Referer et ramène tout à la même origine), puis une affiche dessinée.
   L'échec d'une origine est retenu : une seule image paie le détour.
   ───────────────────────────────────────────── */

/** Route image du serveur. Distincte du relais vidéo : les tests du relais
    comptent les appels à /stream, et la politique de cache n'est pas la
    même — une affiche se garde, un flux vidéo signé non. */
function imageProxyUrl(url) {
  if (!panelServer.relay || location.protocol === "file:") return null;
  const safe = safeUrl(url);
  if (!safe) return null;
  return new URL(`img?u=${encodeURIComponent(safe)}`, location.href).href;
}

const coverMemo = new Map();      // id d'anime → URL retenue, évite de renégocier à chaque rendu
const brokenOrigins = new Set();  // origines dont le chargement direct a échoué

/** Teinte stable déduite du titre : deux séries n'ont jamais la même, et
    la même série garde la sienne d'une session à l'autre. */
export function titleHue(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** Mémorise la jaquette d'une fiche pour les vues qui ne stockent que du
    texte (favoris, historique, reprises). */
export function rememberCover(anime) {
  if (!anime?.id || !anime.cover) return;
  if (state.covers[anime.id] === anime.cover) return;
  state.covers[anime.id] = anime.cover;
  const keys = Object.keys(state.covers);
  if (keys.length > COVERS_MAX) {
    for (const key of keys.slice(0, keys.length - COVERS_MAX)) delete state.covers[key];
  }
  persist();
}

export function coverFor(anime) {
  if (!anime) return null;
  return anime.cover || state.covers[anime.id] || null;
}

/** Remplace l'image par l'affiche dessinée, sans jamais laisser une image
    cassée à l'écran. */
function paintFallback(box, title) {
  const hue = titleHue(title || "?");
  box.querySelector(".poster-img")?.remove();
  if (box.querySelector(".poster-gen")) return;
  box.prepend(el("div", {
    class: "poster-gen",
    vars: {
      "--g1": `hsl(${hue} 52% 32%)`,
      "--g2": `hsl(${(hue + 38) % 360} 46% 12%)`,
    },
  }, el("span", { text: title || "Sans titre" })));
}

/** Construit la boîte d'affiche : ratio figé, chargement différé, repli
    automatique. `extra` reçoit les surcouches (voile, actions, barre). */
export function posterBox(anime, { className = "", eager = false, extra = [] } = {}) {
  const title = anime?.title || "";
  const box = el("div", { class: className ? `poster ${className}` : "poster" });
  const direct = coverFor(anime);

  if (direct) {
    const memo = coverMemo.get(anime.id);
    let origin = "";
    try { origin = new URL(direct).origin; } catch { /* URL relative */ }
    const first = memo || (origin && brokenOrigins.has(origin) ? imageProxyUrl(direct) : direct);

    if (first) {
      const img = el("img", {
        class: "poster-img",
        src: first,
        alt: "",
        loading: eager ? "eager" : "lazy",
        decoding: "async",
        onerror: () => {
          // Première déconvenue : on retente par le serveur, qui ajoute le
          // Referer attendu. Seconde : on dessine.
          const proxied = imageProxyUrl(direct);
          if (img.dataset.stage !== "proxy" && proxied && img.src !== proxied) {
            if (origin) brokenOrigins.add(origin);
            img.dataset.stage = "proxy";
            img.src = proxied;
            return;
          }
          coverMemo.delete(anime.id);
          paintFallback(box, title);
        },
        onload: () => { if (anime?.id) coverMemo.set(anime.id, img.src); },
      });
      box.append(img);
    } else {
      paintFallback(box, title);
    }
  } else {
    paintFallback(box, title);
  }

  for (const node of extra) if (node) box.append(node);
  return box;
}
