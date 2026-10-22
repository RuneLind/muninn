/// <reference lib="dom" />
/**
 * «Walk me through» — the reader's DOM half: the 🧭 button on each section
 * heading, the panel, the request and its abort discipline. Pure helpers and
 * markup live in `wiki-walkthrough-view.ts`.
 *
 * **Which headings.** `.wiki-article > h1…h6`: the elements a top-level
 * markdown heading renders to, which is the set the server counts
 * (`src/wiki/walkthrough.ts`). A heading inside a fold or a component is not a
 * direct child and gets no button.
 *
 * **Gating.** No button at all on a read-only wiki (`wikiReadonlyWikiFlag`)
 * or under the read slice (`wikiToolsFlag` false — the route is not
 * registered there, and the zone refuses it to role `user` everywhere).
 *
 * **One run at a time.** A click while the same section is loading is
 * ignored; any other click, a close, or a navigation aborts the run in flight,
 * and every write is guarded on the run's own AbortController and on the
 * panel state still being the one that started it, so a late answer renders
 * nowhere.
 *
 * **Navigation is watched at the article, not at the router.** The panel
 * belongs to the heading button that opened it; every page swap (a load, a
 * failed load, an Ask answer, an explainer) replaces `#articleWrap`'s
 * children, which detaches that button, and a `childList` observer on
 * `#articleWrap` closes the panel then. No navigation path has to remember to
 * call in.
 *
 * **Escape and focus: Escape closes the thing focus is in.** Escape closes
 * the panel only while focus is inside it (the panel itself included: it is
 * focusable with tabindex -1, so a click on its body puts focus there), and
 * then focus goes back to the opener 🧭. Focus on a 🧭, in the article or in
 * the rail is someone else's Escape: the fact-check card closes on any Escape
 * from inside `.wiki-article`, and one Escape closes one thing. Owners that
 * stop the event (a peek, a glossary tip, the graph card, the rail options
 * pane, Share) never reach this listener; one that only calls
 * `preventDefault` wins through the `defaultPrevented` guard — focus mode's
 * Escape, so with focus mode on the first Escape leaves focus mode and the
 * second closes the panel. The Explain pill hides on every Escape and takes
 * nothing from anyone. The panel is `role="region"`, not `dialog`: the
 * reader's `modalOpen()` reads every visible `[role="dialog"]` as a modal, and
 * a non-modal panel counted as one stopped the graph card's Escape and the
 * page's single-key shortcuts for as long as it was open.
 *
 * Where focus goes: every open (first, or a switch from A to B) moves it to
 * the panel's Close; a re-render puts it back on Close when it was inside the
 * panel, and a quiz answer moves it to that question's verdict, since the
 * choices come back disabled. ✕ and Escape return it to the opener. A close
 * because the article was swapped (a navigation, a failed load) does not move
 * it — the reader's own navigation owns it. Reload is the exception that moves
 * it on purpose: after the article re-renders it goes to the NEW 🧭 for the
 * same section (heading text + ordinal), else to the page title.
 *
 * The stream is read with `fetch` + a ReadableStream (Share's reason: the 409
 * body carries a message EventSource cannot surface).
 */

import { makeSseFrameParser, type SseFrame } from "./client-runtime.ts";
import { wikiReadonlyWikiFlag } from "./wiki-readonly-client.ts";
import { wikiToolsFlag } from "./wiki-read-slice.ts";
import { normalizeHeadingText, type WalkthroughDonePayload } from "../../../wiki/walkthrough-wire.ts";
import {
  chooseAnswer,
  errorKindOf,
  headingIdentities,
  initialPanelState,
  parseDonePayload,
  walkthroughBtnHtml,
  walkthroughKey,
  walkthroughPanelHtml,
  WALKTHROUGH_BTN_ATTR,
  WALKTHROUGH_CHOICE_ATTR,
  WALKTHROUGH_CLOSE_ID,
  WALKTHROUGH_PANEL_ID,
  WALKTHROUGH_RELOAD_ID,
  WALKTHROUGH_VERDICT_ATTR,
  type HeadingIdentity,
  type WalkthroughErrorKind,
  type WalkthroughPanelState,
} from "./wiki-walkthrough-view.ts";

export interface WalkthroughPageContext {
  relPath: string;
  /** The open page's content hash, read at CLICK time: the reader's own
   *  series write moves it without re-rendering the article, and a hash
   *  captured when the buttons were added would 409 on that change. */
  hash: () => string | null;
  /** Builds a URL carrying the open wiki's `?wiki=`. */
  withWiki: (url: string) => string;
  /** Reload the open page in place; the article swap closes the panel and
   *  re-adds the buttons with the fresh hash. */
  reload: () => void;
}

let page: WalkthroughPageContext | null = null;
let state: WalkthroughPanelState | null = null;
let inFlight: AbortController | null = null;
let opener: HTMLElement | null = null;
/** The section a Reload was asked from, focused again once the article it
 *  reloads has its buttons back. */
let refocus: { relPath: string; heading: string; ordinal: number } | null = null;
let wired = false;
let observed: Element | null = null;

/** What the reader sees as a heading's text: `textContent` without the
 *  reader's own chrome (this button, reader-only badges, glossary tips). */
export function headingTextOf(h: Element): string {
  const clone = h.cloneNode(true) as Element;
  clone.querySelectorAll(`[${WALKTHROUGH_BTN_ATTR}], [data-reader-only], .gl-tip`).forEach((n) => n.remove());
  return normalizeHeadingText(clone.textContent ?? "");
}

/** Put a 🧭 button on every top-level heading of the rendered article. */
export function enhanceWalkthroughButtons(root: ParentNode, ctx: WalkthroughPageContext): void {
  wire();
  watchArticle();
  root.querySelectorAll(`[${WALKTHROUGH_BTN_ATTR}]`).forEach((b) => b.remove());
  page = ctx;
  const want = refocus;
  refocus = null;
  if (wikiReadonlyWikiFlag() || !wikiToolsFlag()) return;
  const article = root.querySelector(".wiki-article:not(.wiki-ask-article)");
  if (!article) return;
  const heads = Array.from(article.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6"));
  const ids = headingIdentities(heads.map(headingTextOf));
  heads.forEach((h, k) => {
    const id = ids[k];
    if (id) h.insertAdjacentHTML("beforeend", walkthroughBtnHtml(id));
  });
  if (want && want.relPath === ctx.relPath) {
    const again = Array.from(article.querySelectorAll<HTMLElement>(`[${WALKTHROUGH_BTN_ATTR}]`)).find(
      (b) => b.getAttribute("data-wt-heading") === want.heading && Number(b.getAttribute("data-wt-ordinal")) === want.ordinal,
    );
    const title = document.querySelector<HTMLElement>("#articleWrap .wiki-article-head h1");
    if (!again && title) title.tabIndex = -1;
    (again ?? title)?.focus({ preventScroll: true });
  }
}

/** Close the panel, abort its run and hand focus back to the opener. On the
 *  article-swap path the opener is detached, so the focus call does nothing
 *  and focus stays where the reader's navigation put it. */
function closeWalkthrough(): void {
  inFlight?.abort();
  inFlight = null;
  state = null;
  document.getElementById(WALKTHROUGH_PANEL_ID)?.remove();
  opener?.focus({ preventScroll: true });
  opener = null;
}

/** The reader calls this on every breadcrumb render. It does nothing: every
 *  navigation, failed or not, also swaps `#articleWrap`'s children, and the
 *  observer below closes the panel then. Closing here as well ran while the
 *  opener was still attached, so it pulled focus back to a 🧭 about to be
 *  removed. Kept so the reader's call site needs no change. */
export function closeWalkthroughOnNavigate(_relPath: string | null): void {}

/** Close the panel once the article its opener sat in has been swapped out. */
function watchArticle(): void {
  const wrap = document.getElementById("articleWrap");
  if (!wrap || wrap === observed) return;
  observed = wrap;
  new MutationObserver(() => {
    if (!opener?.isConnected) closeWalkthrough();
  }).observe(wrap, { childList: true });
}

/** Paint `s` into the panel. `focusSel`: where focus goes (an open → Close,
 *  a quiz answer → its verdict); without it, focus that was inside the panel
 *  goes back to Close, the one control every state renders. */
function render(s: WalkthroughPanelState, focusSel?: string): void {
  let panel = document.getElementById(WALKTHROUGH_PANEL_ID);
  const hadFocus = !!panel && panel.contains(document.activeElement);
  if (!panel) {
    panel = document.createElement("div");
    panel.id = WALKTHROUGH_PANEL_ID;
    panel.className = "wiki-wt";
    // A region, not a dialog: see the header's Escape paragraph.
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-labelledby", "wikiWalkthroughTitle");
    // Focusable, out of the tab order: a click on the panel's body puts focus
    // in it, so Escape closes it.
    panel.tabIndex = -1;
    document.body.appendChild(panel);
  }
  panel.innerHTML = walkthroughPanelHtml(s);
  const target = focusSel ?? (hadFocus ? `#${WALKTHROUGH_CLOSE_ID}` : null);
  if (target) panel.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
}

function open(btn: HTMLElement): void {
  if (!page) return;
  if (wikiReadonlyWikiFlag() || !wikiToolsFlag()) return;
  const id: HeadingIdentity = {
    heading: btn.getAttribute("data-wt-heading") ?? "",
    ordinal: Number(btn.getAttribute("data-wt-ordinal")),
    count: Number(btn.getAttribute("data-wt-count")),
  };
  if (!id.heading || !Number.isInteger(id.ordinal) || !Number.isInteger(id.count)) return;
  // A second click on the section already loading spends nothing.
  if (state && state.phase === "loading" && state.key === walkthroughKey(page.relPath, id)) return;
  inFlight?.abort();
  opener = btn;
  state = initialPanelState(page.relPath, id);
  render(state, `#${WALKTHROUGH_CLOSE_ID}`);
  void run(state, page);
}

async function run(target: WalkthroughPanelState, ctx: WalkthroughPageContext): Promise<void> {
  const ctrl = new AbortController();
  inFlight = ctrl;
  const live = () => state === target && !ctrl.signal.aborted;
  const fail = (kind: WalkthroughErrorKind, message: string): void => {
    if (!live()) return;
    target.phase = "error";
    target.errorKind = kind;
    target.error = message;
    if (inFlight === ctrl) inFlight = null;
    render(target);
  };

  const hash = ctx.hash();
  let res: Response;
  try {
    res = await fetch(ctx.withWiki("/api/wiki/walkthrough"), {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        relPath: target.relPath,
        heading: target.identity.heading,
        ordinal: target.identity.ordinal,
        count: target.identity.count,
        ...(hash ? { hash } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch {
    fail("transport", "Could not reach the server.");
    return;
  }
  if (!res.ok || !res.body) {
    let msg = `The walkthrough could not start (HTTP ${res.status}).`;
    let stale = false;
    try {
      const b = (await res.json()) as { error?: unknown; stale?: unknown };
      if (typeof b?.error === "string") msg = b.error;
      stale = b?.stale === true;
    } catch { /* keep the status copy */ }
    fail(stale ? "stale" : "request", msg);
    return;
  }

  let done: WalkthroughDonePayload | null = null;
  let appError: { kind: WalkthroughErrorKind; message: string } | null = null;
  let badDone = false;
  const parser = makeSseFrameParser((frame: SseFrame) => {
    if (frame.event !== "done" && frame.event !== "app_error") return;
    let d: Record<string, unknown>;
    try { d = JSON.parse(frame.data) as Record<string, unknown>; } catch { badDone = true; return; }
    if (frame.event === "app_error") {
      appError = {
        kind: errorKindOf(d.code),
        message: typeof d.message === "string" ? d.message : "The walkthrough failed.",
      };
    } else {
      done = parseDonePayload(d);
      if (!done) badDone = true;
    }
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch {
    fail("transport", "The connection dropped before the walkthrough arrived.");
    return;
  }
  if (!live()) return;
  const err = appError as { kind: WalkthroughErrorKind; message: string } | null;
  if (err) return fail(err.kind, err.message);
  if (!done || badDone) return fail("parse", "The server sent a walkthrough this page can't show.");
  target.phase = "ready";
  target.result = done;
  if (inFlight === ctrl) inFlight = null;
  render(target);
}

function wire(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("click", (e) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== "function") return;
    const btn = t.closest<HTMLElement>(`[${WALKTHROUGH_BTN_ATTR}]`);
    if (btn) {
      e.preventDefault();
      open(btn);
      return;
    }
    if (t.closest(`#${WALKTHROUGH_CLOSE_ID}`)) {
      closeWalkthrough();
      return;
    }
    if (t.closest(`#${WALKTHROUGH_RELOAD_ID}`)) {
      if (state && page) refocus = { relPath: page.relPath, heading: state.identity.heading, ordinal: state.identity.ordinal };
      page?.reload();
      return;
    }
    const choice = t.closest<HTMLElement>(`[${WALKTHROUGH_CHOICE_ATTR}]`);
    if (choice && state) {
      const [q, c] = (choice.getAttribute(WALKTHROUGH_CHOICE_ATTR) ?? "").split(":").map(Number);
      if (chooseAnswer(state, q!, c!)) render(state, `[${WALKTHROUGH_VERDICT_ATTR}="${q}"]`);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const panel = document.getElementById(WALKTHROUGH_PANEL_ID);
    if (panel && panel.contains(document.activeElement)) closeWalkthrough();
  });
}
