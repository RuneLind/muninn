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
 * **Focus survives a re-render.** `render()` replaces the panel's markup on
 * every state change, so it puts focus back on the matching control (or the
 * panel itself) when focus was inside the panel.
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
  type HeadingIdentity,
  type WalkthroughErrorKind,
  type WalkthroughPanelState,
} from "./wiki-walkthrough-view.ts";

export interface WalkthroughPageContext {
  relPath: string;
  /** `/api/wiki/page`'s content hash, sent so a changed page answers 409. */
  hash: string | null;
  /** Builds a URL carrying the open wiki's `?wiki=`. */
  withWiki: (url: string) => string;
}

let page: WalkthroughPageContext | null = null;
let state: WalkthroughPanelState | null = null;
let inFlight: AbortController | null = null;
let opener: HTMLElement | null = null;
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
  if (wikiReadonlyWikiFlag() || !wikiToolsFlag()) return;
  const article = root.querySelector(".wiki-article:not(.wiki-ask-article)");
  if (!article) return;
  const heads = Array.from(article.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6"));
  const ids = headingIdentities(heads.map(headingTextOf));
  heads.forEach((h, k) => {
    const id = ids[k];
    if (id) h.insertAdjacentHTML("beforeend", walkthroughBtnHtml(id));
  });
}

/** Close the panel and abort its run. */
export function closeWalkthrough(): void {
  inFlight?.abort();
  inFlight = null;
  state = null;
  document.getElementById(WALKTHROUGH_PANEL_ID)?.remove();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  opener = null;
}

/** Close unless the panel belongs to `relPath` (the reader calls this on
 *  every breadcrumb render, and with `null` when no page is open). */
export function closeWalkthroughOnNavigate(relPath: string | null): void {
  if (state && state.relPath !== relPath) closeWalkthrough();
  if (page && page.relPath !== relPath) page = null;
}

/** Close the panel once the article its opener sat in has been swapped out. */
function watchArticle(): void {
  const wrap = document.getElementById("articleWrap");
  if (!wrap || wrap === observed) return;
  observed = wrap;
  new MutationObserver(() => {
    if (state && !opener?.isConnected) closeWalkthrough();
  }).observe(wrap, { childList: true });
}

/** A selector that finds the same control again in freshly rendered markup. */
function focusKeyOf(el: Element): string | null {
  if (el.id === WALKTHROUGH_CLOSE_ID) return `#${WALKTHROUGH_CLOSE_ID}`;
  const choice = el.getAttribute(WALKTHROUGH_CHOICE_ATTR);
  if (choice !== null) return `[${WALKTHROUGH_CHOICE_ATTR}="${choice}"]`;
  return null;
}

function render(): void {
  if (!state) return;
  let panel = document.getElementById(WALKTHROUGH_PANEL_ID);
  const created = !panel;
  const active = document.activeElement;
  const hadFocus = !!panel && !!active && panel.contains(active);
  const key = hadFocus ? focusKeyOf(active!) : null;
  if (!panel) {
    panel = document.createElement("div");
    panel.id = WALKTHROUGH_PANEL_ID;
    panel.className = "wiki-wt";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "wikiWalkthroughTitle");
    // Focusable as a fallback target, out of the tab order.
    panel.tabIndex = -1;
    document.body.appendChild(panel);
  }
  panel.innerHTML = walkthroughPanelHtml(state);
  if (created) {
    document.getElementById(WALKTHROUGH_CLOSE_ID)?.focus({ preventScroll: true });
    return;
  }
  if (!hadFocus) return;
  // A chosen answer's buttons come back disabled, which cannot hold focus.
  const again = key ? panel.querySelector<HTMLElement>(key) : null;
  const target = again && !(again as HTMLButtonElement).disabled ? again : panel;
  target.focus({ preventScroll: true });
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
  render();
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
    render();
  };

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
        ...(ctx.hash ? { hash: ctx.hash } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch {
    fail("transport", "Could not reach the server.");
    return;
  }
  if (!res.ok || !res.body) {
    let msg = `The walkthrough could not start (HTTP ${res.status}).`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b?.error === "string") msg = b.error;
    } catch { /* keep the status copy */ }
    fail("request", msg);
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
  render();
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
    const choice = t.closest<HTMLElement>(`[${WALKTHROUGH_CHOICE_ATTR}]`);
    if (choice && state) {
      const [q, c] = (choice.getAttribute(WALKTHROUGH_CHOICE_ATTR) ?? "").split(":").map(Number);
      if (chooseAnswer(state, q!, c!)) render();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state) return;
    // Another dialog open on top owns its own Escape.
    if (document.querySelector(".wiki-share, .wiki-chatopt")) return;
    const panel = document.getElementById(WALKTHROUGH_PANEL_ID);
    if (panel && panel.contains(document.activeElement)) closeWalkthrough();
  });
}
