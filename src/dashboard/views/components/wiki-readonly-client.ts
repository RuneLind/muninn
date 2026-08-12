/// <reference lib="dom" />
/**
 * Client half of `MUNINN_WIKI_READONLY` — makes a readonly instance fail
 * LEGIBLY instead of at a 403 the reader only discovers after clicking.
 *
 * The server is the authority (the two write seams + the route guards); this is
 * presentation. It is deliberately NOT a per-render `disabled` sweep: the
 * gardener strip and the reader's answer pane replace their innerHTML on every
 * poll, SSE event and turn switch, so any state written into a button is gone by
 * the next paint. Instead it does two render-independent things:
 *
 *   1. Stamps `wiki-readonly` on `<body>` — the page's CSS dims the mutation
 *      controls, which survives every re-render because it is a selector.
 *   2. Installs ONE capture-phase click listener that cancels a click on a
 *      mutation control and states why.
 *
 * The selectors are the SAME attributes the real delegated handlers key on
 * (`data-action`, `data-backlog-action`, `data-doc-action`, the write-action ids),
 * so the guard cannot drift from the handlers by naming something else.
 */

/**
 * Controls that would POST to a route the readonly guard 403s. Read-only
 * affordances — the inspector's filters/toggles, `reject` (a DB status flip that
 * mutates no wiki), the panel open/close buttons — are deliberately absent.
 */
export const WIKI_READONLY_BLOCKED_SELECTOR = [
  '[data-action="approve"]',
  '[data-backlog-action="run"]',
  '[data-backlog-action="source-draft"]',
  '[data-doc-action="draft"]',
  '[data-doc-action="rename-draft"]',
  "#wikiFactcheckAppendBtn",
  "#wikiFactcheckIntegrateBtn",
  "#wikiFcIntAccept",
  ".wiki-atlas-cdraft",
].join(",");

/** The one sentence shown when a blocked control is clicked. Mirrors the server's
 *  `WIKI_READONLY_REASON` in substance; kept here so the browser bundle imports
 *  nothing server-side. */
export const WIKI_READONLY_CLIENT_MESSAGE =
  "This muninn instance is wiki-readonly (MUNINN_WIKI_READONLY=1) — wiki page writes happen on the write-owning instance.";

/** Is the page running against a wiki-readonly instance? The flag is injected by
 *  the server render as `window.__WIKI_READONLY__`. */
export function wikiReadonlyFlag(win: unknown = globalThis): boolean {
  return (win as { __WIKI_READONLY__?: unknown })?.__WIKI_READONLY__ === true;
}

/**
 * Does this click target a control the readonly instance would refuse? Pure, so
 * the selector list is unit-testable without a DOM event.
 */
export function isBlockedByReadonly(target: Element | null): boolean {
  return !!target?.closest(WIKI_READONLY_BLOCKED_SELECTOR);
}

/**
 * Install the guard. No-op (and no listener) when the instance owns writes, so a
 * normal install pays nothing. Idempotent — a second call is ignored, since both
 * bundles on a page would otherwise cancel the same click twice.
 */
export function installWikiReadonlyGuard(): void {
  if (!wikiReadonlyFlag()) return;
  const body = document.body;
  if (!body || body.classList.contains("wiki-readonly")) return;
  body.classList.add("wiki-readonly");

  document.addEventListener(
    "click",
    (e) => {
      if (!isBlockedByReadonly(e.target as Element | null)) return;
      e.preventDefault();
      e.stopPropagation();
      // The handlers are delegated on `document` too, so stopping propagation is
      // not enough on its own — the other listener on the SAME node still runs.
      e.stopImmediatePropagation();
      showReadonlyNote();
    },
    true,
  );
}

/** A single transient toast — one node, reused, so repeated clicks don't stack. */
function showReadonlyNote(): void {
  let el = document.getElementById("wikiReadonlyNote");
  if (!el) {
    el = document.createElement("div");
    el.id = "wikiReadonlyNote";
    el.className = "wiki-readonly-note";
    document.body.appendChild(el);
  }
  el.textContent = WIKI_READONLY_CLIENT_MESSAGE;
  el.classList.add("show");
  window.clearTimeout((el as HTMLElement & { _t?: number })._t);
  (el as HTMLElement & { _t?: number })._t = window.setTimeout(
    () => el?.classList.remove("show"),
    6000,
  );
}

/** Styles for the dimmed controls + the toast. Injected by the pages that render
 *  a readonly-capable surface (`/wiki`, `/wiki/gardener`). */
export function wikiReadonlyStyles(): string {
  return `
    body.wiki-readonly ${WIKI_READONLY_BLOCKED_SELECTOR.split(",").join(", body.wiki-readonly ")} {
      opacity: 0.45; cursor: not-allowed; filter: grayscale(0.6);
    }
    .wiki-readonly-note {
      position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
      max-width: 560px; z-index: 200; display: none;
      padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.45;
      background: var(--bg-surface); color: var(--text-primary);
      border: 1px solid var(--status-warning);
      box-shadow: 0 6px 24px rgba(0,0,0,0.28);
    }
    .wiki-readonly-note.show { display: block; }
  `;
}
