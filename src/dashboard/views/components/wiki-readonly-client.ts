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
 * Controls that would POST to a route the readonly guard 403s.
 *
 * Deliberately ABSENT, and each for its own reason:
 *   - `[data-action="reject"]` — a DB status flip that mutates no wiki, and the
 *     server leaves it unguarded on purpose.
 *   - the inspector's `data-inspect-bucket` filters and its `close`/`more`
 *     controls — pure reads/pagination (only its `bulk-dismiss` verb writes).
 *   - `[data-backlog-action="cancel"]` — the confirm PANEL's close button (not
 *     the drain's `cancel-run`); blocking it would strand the panel open.
 */
export const WIKI_READONLY_BLOCKED_SELECTOR = [
  '[data-action="approve"]',
  // Backlog drain: opening the confirm panel is blocked too — every action
  // inside it is refused, so the panel is a dead end on a readonly instance.
  '[data-backlog-action="confirm"]',
  '[data-backlog-action="run"]',
  '[data-backlog-action="cancel-run"]',
  '[data-backlog-action="reset"]',
  '[data-backlog-action="reset-dismissed"]',
  '[data-backlog-action="recover"]',
  '[data-backlog-action="dismiss"]',
  // "Run gardener now" — POSTs the watcher trigger, which the readonly guard
  // refuses for wiki-drafting watcher types.
  '[data-backlog-action="run-watcher"]',
  '[data-backlog-action="source-draft"]',
  '[data-doc-action="draft"]',
  '[data-doc-action="rename-draft"]',
  '[data-doc-action="dismiss"]',
  '[data-doc-action="undismiss"]',
  '[data-doc-action="delete"]',
  '[data-inspect-action="bulk-dismiss"]',
  "#wikiFactcheckAppendBtn",
  "#wikiFactcheckIntegrateBtn",
  "#wikiFcIntAccept",
  ".wiki-atlas-cdraft",
].join(",");

/**
 * Controls that reach a route the PER-WIKI guard 403s but the instance flag does
 * not: the egress family — anything that spends a model call, reaches the live
 * web, or seeds a chat thread from this wiki's pages. They are NOT write
 * controls, which is exactly why they are a separate list: adding them to the
 * set above would dim 📤 Share and 🔎 Fact check on the read-only INSTANCE too,
 * where the server happily serves both.
 *
 * The ids are the ones the real delegated handlers key on (`wiki-browser.ts`'s
 * breadcrumb + answer-pane wiring, `SHARE_BTN_ID`, `DISCUSS_ARTICLE_BTN_ID`,
 * `DECLINE_CHAT_BTN_ID`), so the two cannot drift by naming something else.
 */
export const WIKI_READONLY_EGRESS_SELECTOR = [
  // Breadcrumb article actions.
  "#wikiExplainBtn",
  "#wikiFactcheckBtn",
  "#wikiFactcheckArticleBtn",
  "#wikiDiscussBtn",
  "#wikiShareBtn",
  // Ask rail + in-pane answer actions.
  "#wikiAskBtn",
  "#wikiNewChatBtn",
  "#wikiFollowupBtn",
  "#wikiRememberBtn",
  "#wikiChatEscBtn",
  "#wikiChatEscNewBtn",
  "#wikiChatEscOptBtn",
  "#wikiChatDeclineBtn",
  // Fact-check claim retry (row ↻ + the batch bar).
  "[data-claim-retry-btn]",
  "#wikiClaimRetryAll",
].join(",");

/** The one sentence shown when a blocked control is clicked. Mirrors the server's
 *  `WIKI_READONLY_REASON` in substance; kept here so the browser bundle imports
 *  nothing server-side. */
export const WIKI_READONLY_CLIENT_MESSAGE =
  "This muninn instance is wiki-readonly (MUNINN_WIKI_READONLY=1) — wiki page writes happen on the write-owning instance.";

/** The per-wiki counterpart, shown on a wiki listed in `WIKI_READONLY_ROOTS`.
 *  Deliberately a different sentence: the instance one would tell a reader on the
 *  write-OWNING laptop something false about every other wiki on it. */
export const WIKI_READONLY_WIKI_MESSAGE =
  "This wiki is registered read-only (WIKI_READONLY_ROOTS) — muninn only reads it: no writes, no model calls, nothing sent to the web.";

/** Is the page running against a wiki-readonly instance? The flag is injected by
 *  the server render as `window.__WIKI_READONLY__`. */
export function wikiReadonlyFlag(win: unknown = globalThis): boolean {
  return (win as { __WIKI_READONLY__?: unknown })?.__WIKI_READONLY__ === true;
}

/** Is the wiki this page is rendering itself registered read-only? Injected as
 *  `window.__WIKI_READONLY_WIKI__` from the resolved registry entry. Independent
 *  of the instance flag — either, both, or neither can be true. */
export function wikiReadonlyWikiFlag(win: unknown = globalThis): boolean {
  return (win as { __WIKI_READONLY_WIKI__?: unknown })?.__WIKI_READONLY_WIKI__ === true;
}

/**
 * The selector actually installed, given the two independent flags — pure, so
 * the union rule is unit-testable without a DOM.
 *
 * A read-only WIKI blocks the write controls too: every one of them ends in a
 * seam the root-keyed guard refuses. The instance flag alone keeps exactly the
 * set it always had.
 */
export function wikiBlockedSelectorFor(instance: boolean, wiki: boolean): string {
  if (wiki) return WIKI_READONLY_BLOCKED_SELECTOR + "," + WIKI_READONLY_EGRESS_SELECTOR;
  return instance ? WIKI_READONLY_BLOCKED_SELECTOR : "";
}

/** Which sentence explains a blocked click. The per-wiki one wins where both
 *  apply: it is the more specific true statement about the page on screen. */
export function wikiBlockedMessageFor(instance: boolean, wiki: boolean): string {
  if (wiki) return WIKI_READONLY_WIKI_MESSAGE;
  return instance ? WIKI_READONLY_CLIENT_MESSAGE : "";
}

/**
 * Does this click target a control the readonly instance would refuse? Pure, so
 * the selector list is unit-testable without a DOM event.
 *
 * The `closest` capability test is load-bearing, not defensive noise: `e.target`
 * is only *usually* an Element (a click dispatched at `document` or a synthetic
 * event can carry a non-Element target), and a capture-phase listener that
 * THROWS never reaches its `preventDefault`. So the test FAILS SOFT — it never
 * throws — and nothing blockable is lost by returning false: a non-Element
 * target carries no mutation control (real clicks on a blocked button retarget
 * to the Element), so the only clicks let through are ones the THROW would have
 * let through anyway.
 */
export function isBlockedByReadonly(
  target: Element | null,
  selector: string = WIKI_READONLY_BLOCKED_SELECTOR,
): boolean {
  if (!selector) return false;
  if (typeof (target as Element | null)?.closest !== "function") return false;
  return !!target?.closest(selector);
}

/**
 * Install the guard. No-op (and no listener) when neither flag is set, so a
 * normal install pays nothing. Idempotent — a second call is ignored, since both
 * bundles on a page would otherwise cancel the same click twice.
 */
export function installWikiReadonlyGuard(): void {
  const instance = wikiReadonlyFlag();
  const perWiki = wikiReadonlyWikiFlag();
  const selector = wikiBlockedSelectorFor(instance, perWiki);
  if (!selector) return;
  const body = document.body;
  if (!body || body.classList.contains("wiki-readonly")) return;
  // Two classes, not one: the dim CSS is selector-scoped per flag, so a
  // read-only INSTANCE does not dim Share / fact check (which it still serves).
  body.classList.add("wiki-readonly");
  if (perWiki) body.classList.add("wiki-readonly-wiki");
  const message = wikiBlockedMessageFor(instance, perWiki);

  document.addEventListener(
    "click",
    (e) => {
      if (!isBlockedByReadonly(e.target as Element | null, selector)) return;
      e.preventDefault();
      e.stopPropagation();
      // The handlers are delegated on `document` too, so stopping propagation is
      // not enough on its own — the other listener on the SAME node still runs.
      e.stopImmediatePropagation();
      showReadonlyNote(message);
    },
    true,
  );
}

/** A single transient toast — one node, reused, so repeated clicks don't stack. */
function showReadonlyNote(message: string = WIKI_READONLY_CLIENT_MESSAGE): void {
  let el = document.getElementById("wikiReadonlyNote");
  if (!el) {
    el = document.createElement("div");
    el.id = "wikiReadonlyNote";
    el.className = "wiki-readonly-note";
    document.body.appendChild(el);
  }
  el.textContent = message;
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
    body.wiki-readonly-wiki ${WIKI_READONLY_EGRESS_SELECTOR.split(",").join(", body.wiki-readonly-wiki ")} {
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
