/* Anime-Sama Panel — Notifications, modales et navigation entre les vues. */
import { $, $$, clear, el, icon, must, VIEWS } from "./core.js";
import { state } from "./store.js";

const toastHost = $("#toasts");
const TOAST_ICONS = { info: "info", success: "check", warn: "alert", error: "alert" };

export function notify(message, { type = "info", title = "", timeout = 5200 } = {}) {
  if (!toastHost) return;
  const body = el("div", { class: "toast-body" }, [
    title ? el("b", { text: title }) : null,
    el("span", { text: message }),
  ]);
  const close = el("button", { type: "button", class: "toast-close", "aria-label": "Fermer la notification" }, icon("close"));
  const toast = el("div", { class: "toast", dataset: { type } }, [icon(TOAST_ICONS[type] || "info"), body, close]);

  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.classList.add("is-out");
    setTimeout(() => toast.remove(), 220);
  };
  close.addEventListener("click", dismiss);
  toastHost.append(toast);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  if (timeout > 0) setTimeout(dismiss, timeout);
}

export const modal      = must("#modal");
const modalTitle = must("#modalTitle");
const modalBody  = must("#modalBody");
const modalFoot  = must("#modalFoot");

let modalGeneration = 0;

export function openModal({ title, body, actions = [], variant = "" }) {
  modalGeneration++;
  modal.dataset.variant = variant;
  modalTitle.textContent = title;
  clear(modalBody);
  modalBody.append(body instanceof Node ? body : el("p", { text: String(body) }));
  clear(modalFoot);
  for (const action of actions) {
    modalFoot.append(el("button", {
      type: "button",
      class: `btn ${action.variant || "btn-ghost"}`,
      onclick: () => {
        const generation = modalGeneration;
        action.onClick?.();
        // Si l'action a ouvert une autre modale, on ne referme pas celle-ci.
        if (generation === modalGeneration) closeModal();
      },
    }, action.label));
  }
  if (!modal.open) modal.showModal();
}
export function closeModal() { if (modal.open) modal.close(); }

export function confirmDialog({ title, message, confirmLabel = "Confirmer", danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    // Échap et clic sur le fond déclenchent aussi « close » : la réponse est alors « non ».
    modal.addEventListener("close", () => resolve(answer), { once: true });
    openModal({
      title,
      body: el("p", { text: message }),
      actions: [
        { label: "Annuler", variant: "btn-ghost" },
        { label: confirmLabel, variant: danger ? "btn-danger" : "btn-primary", onClick: () => { answer = true; } },
      ],
    });
  });
}

export function applyView(view) {
  const target = VIEWS.includes(view) ? view : "discover";
  for (const section of $$(".view")) section.classList.toggle("is-active", section.dataset.view === target);
  for (const button of $$(".nav-item")) {
    const active = button.dataset.nav === target;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
  window.scrollTo({ top: 0, behavior: state.settings.motion ? "auto" : "smooth" });
}

export function navigate(view) {
  // La vue bascule tout de suite ; le hash suit pour garder les boutons
  // précédent/suivant du navigateur fonctionnels (hashchange rappelle applyView).
  applyView(view);
  if (location.hash.slice(1) !== view) location.hash = view;
}

/** Écouteurs du module, branchés par main.js une fois tous les modules évalués. */
export function wire() {
  must("#modalClose").addEventListener("click", closeModal);

  window.addEventListener("hashchange", () => applyView(location.hash.slice(1)));

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-nav]");
    if (!trigger) return;
    event.preventDefault();
    navigate(trigger.dataset.nav);
  });
}
