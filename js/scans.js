/* Anime-Sama Panel — Lecteur de scans. */
import { $, clear, debounce, el, icon, must, safeUrl } from "./core.js";
import { state } from "./store.js";
import { notify } from "./ui.js";
import { describeError, source } from "./api.js";
import { emptyState } from "./discover.js";

const chapterList   = must("#chapterList");
const chapterCount  = must("#chapterCount");
const scanReader    = must("#scanReader");
const chapterFilter = must("#chapterFilter");

const scans = { name: "", chapters: [], current: null };

export function renderChapters() {
  clear(chapterList);
  const needle = chapterFilter.value.trim();
  const items = needle ? scans.chapters.filter((c) => String(c.number).includes(needle)) : scans.chapters;

  chapterCount.textContent = String(scans.chapters.length);
  chapterCount.hidden = scans.chapters.length === 0;

  if (!items.length) {
    chapterList.append(el("p", { class: "hint", text: scans.chapters.length ? "Aucun chapitre ne correspond." : "Charge un manga pour voir ses chapitres." }));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const chapter of items) {
    fragment.append(el("button", {
      type: "button",
      class: `chapter${scans.current === chapter.number ? " is-current" : ""}`,
      onclick: () => loadChapter(chapter.number),
    }, [
      el("span", { text: `Chapitre ${chapter.number}` }),
      chapter.pages ? el("small", { text: `${chapter.pages} p.` }) : null,
    ]));
  }
  chapterList.append(fragment);
}

async function loadChapter(number) {
  scans.current = number;
  renderChapters();
  clear(scanReader);
  scanReader.append(el("div", { class: "empty" }, [icon("book"), el("p", { class: "empty-title", text: `Chargement du chapitre ${number}…` })]));

  try {
    const data = await source.scanPages(scans.name, number);
    const pages = Array.isArray(data) ? data : (Object.values(data || {}).find(Array.isArray) || []);
    const urls = pages.map(safeUrl).filter(Boolean);

    clear(scanReader);
    if (!urls.length) {
      scanReader.append(emptyState({ glyph: "alert", tone: "error", title: "Chapitre vide", text: "L'API n'a renvoyé aucune image exploitable pour ce chapitre." }));
      return;
    }

    const index = scans.chapters.findIndex((c) => c.number === number);
    const widthSelect = el("select", { "aria-label": "Largeur de lecture" }, [
      el("option", { value: "comfy", text: "Largeur confortable" }),
      el("option", { value: "wide", text: "Large" }),
      el("option", { value: "full", text: "Pleine largeur" }),
      el("option", { value: "webtoon", text: "Webtoon (pages jointes)" }),
    ]);
    const pagesWrap = el("div", { class: "scan-pages", dataset: { width: "comfy" } });
    widthSelect.addEventListener("change", () => { pagesWrap.dataset.width = widthSelect.value; });

    scanReader.append(el("div", { class: "scan-toolbar" }, [
      el("strong", { text: `Chapitre ${number}` }),
      el("span", { class: "chip chip-sm", text: `${urls.length} pages` }),
      el("span", { class: "scan-spacer" }),
      el("div", { class: "field" }, widthSelect),
      el("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: index <= 0, onclick: () => loadChapter(scans.chapters[index - 1].number) }, [icon("prev"), el("span", { text: "Précédent" })]),
      el("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: index < 0 || index >= scans.chapters.length - 1, onclick: () => loadChapter(scans.chapters[index + 1].number) }, [el("span", { text: "Suivant" }), icon("next")]),
    ]));

    urls.forEach((url, i) => {
      const image = el("img", {
        class: "scan-page", src: url, alt: `Page ${i + 1}`,
        loading: i < 2 ? "eager" : "lazy", decoding: "async", referrerpolicy: "no-referrer",
      });
      image.addEventListener("error", () => {
        image.replaceWith(el("p", { class: "hint scan-page-error", text: `Page ${i + 1} : image bloquée par l'hébergeur (protection anti-hotlink).` }));
      }, { once: true });
      pagesWrap.append(image);
    });
    scanReader.append(pagesWrap);
    window.scrollTo({ top: 0, behavior: state.settings.motion ? "auto" : "smooth" });
  } catch (err) {
    clear(scanReader);
    scanReader.append(emptyState({ glyph: "alert", tone: "error", title: "Chapitre indisponible", text: describeError(err) }));
  }
}

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
  must("#scanForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("#scanInput").value.trim();
    if (name.length < 2) { notify("Saisis le nom du manga.", { type: "warn", timeout: 3000 }); return; }

    scans.name = name;
    scans.chapters = [];
    scans.current = null;
    clear(scanReader);
    scanReader.append(el("div", { class: "empty" }, [icon("book"), el("p", { class: "empty-title", text: "Chargement des chapitres…" })]));

    try {
      const data = await source.scanChapters(name);
      const chapters = [];
      for (const [key, value] of Object.entries(data || {})) {
        if (!/^\d+(\.\d+)?$/.test(key)) continue;
        chapters.push({ number: key, pages: Number(value) || 0 });
      }
      chapters.sort((a, b) => Number(a.number) - Number(b.number));
      scans.chapters = chapters;
      renderChapters();
      clear(scanReader);
      if (!chapters.length) {
        scanReader.append(emptyState({ glyph: "book", title: "Aucun chapitre", text: `L'API ne connaît pas de scans pour « ${name} ». Vérifie l'orthographe exacte du titre.` }));
        return;
      }
      scanReader.append(emptyState({ glyph: "book", title: `${chapters.length} chapitres disponibles`, text: "Choisis un chapitre dans la liste pour commencer la lecture." }));
      notify(`${chapters.length} chapitres trouvés.`, { type: "success", timeout: 3200 });
    } catch (err) {
      scans.chapters = [];
      renderChapters();
      clear(scanReader);
      scanReader.append(emptyState({ glyph: "alert", tone: "error", title: "Chargement impossible", text: describeError(err) }));
    }
  });

  chapterFilter.addEventListener("input", debounce(renderChapters, 140));
}
