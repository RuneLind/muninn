/// <reference lib="dom" />
/**
 * The selection menu (Discuss v2 PR 5, mimir plan muninn-wiki-discuss-v2):
 * a bar at the selection and a right-click menu with the same actions (D2),
 * answered in inline cards under the paragraph (D3). It replaces the
 * breadcrumb's selection-gated ✨ Explain and ✓ Fact check; the whole-page
 * 🔎 Fact check stays in the breadcrumb. The pure half (actions, markup, key
 * chips, where a card goes) is `wiki-selection-menu-model.ts`.
 *
 * - The bar shows on the `mouseup` that ends a selection in the article
 *   (the old Explain pill's trigger and checks: a page, not the graph, 3–1,500
 *   characters). A right-click inside the selection opens the menu instead;
 *   ⇧-right-click, or a right-click outside the selection, is the browser's.
 * - «Explain with context» on a wiki with a wiki agent is a turn of the page's
 *   thread, sent through the pane's own entry (`startInlineTurn`): the same
 *   turn record the pane draws, so it is never a second copy, and the pane
 *   need not be open. Its card repaints on `onDiscussChange` and links to the
 *   turn in the pane. Where the thread cannot take it (the selection is no
 *   passage, or a turn of the discussion is still running) the card streams
 *   the classic `/api/wiki/explain` answer instead. Without an agent (and on
 *   an explainer) it is the classic Explain, an Ask turn in the article pane.
 * - «Where else» and «History» read `GET /api/wiki/mentions` (no model), for
 *   a selection the route accepts as a key (one line, 3–80 characters); a key
 *   found in the selection gets its own chip, which opens its «Where else».
 *   An answer is reused for {@link MENTIONS_FRESH_MS} at most, never one with
 *   a PR row still being refreshed, and a page render drops them all.
 * - «Fact check» is the existing selection fact check; «Add to Oppfølging»
 *   (a page with an `Oppfølging` heading and an agent) is an Edit turn whose
 *   proposed-edit card and Apply are the pane's.
 *
 * - An Explain or Oppfølging card still open when the same page renders again
 *   (an in-place reload, an Apply from the pane) is put back at its passage,
 *   found again by the Discuss chip's finder, or at the article's top with a
 *   note when the passage is gone; its classic stream keeps running meanwhile.
 *   Not after an Apply of its own turn (its outcome is on the Discuss tab),
 *   and not on another page.
 * - Keyboard: the ContextMenu key or ⇧F10 opens the menu at the selection
 *   with focus on its first item; arrows move (↑/↓ in the menu, ←/→ in the
 *   bar), Escape closes with focus back on the page. The bar hides while its
 *   selection is scrolled out of the article pane; a scroll closes the menu.
 *
 * The bar's Explain and Fact check keep the ids `#wikiExplainBtn` and
 * `#wikiFactcheckBtn`, and every egress action carries `data-selact`, which
 * the read-only selectors name. Actions run on `mousedown` (its default
 * prevented, so the selection stays), as the old buttons did, and on a
 * keyboard `click`.
 */

import { copyText } from "./copy-path.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { enhanceConfidenceHtml, renderStreamingBody } from "./wiki-ask-render.ts";
import { readerSelectionText } from "./wiki-lens.ts";
import { nearestHeading } from "./wiki-nearest-heading.ts";
import { readSelectionPassage } from "./wiki-discuss-handoff.ts";
import { discussAgentOn, discussSendBlocked, discussTurnForCard, onDiscussChange, showTurnInDiscuss, startInlineTurn } from "./wiki-discuss-tab.ts";
import { discussTurnBodyParts, findPassage, renderedPassageText, type PassageContext } from "./wiki-discuss-state.ts";
import {
  EXPLAIN_QUESTION,
  FOLLOW_QUESTION,
  SEL_BAR_ID,
  SEL_CARD_CLASS,
  SEL_MENU_ID,
  detectKeys,
  followHeading,
  historyHtml,
  inlineCardAnchor,
  inlineCardHtml,
  keyKindsFrom,
  selBarHtml,
  selMenuOffers,
  selectionEndNode,
  selMenuHtml,
  selMenuItems,
  whereElseHtml,
  type CardKind,
  type SelAction,
  type SelMenuItem,
} from "./wiki-selection-menu-model.ts";
import { WIKI_READ_SLICE_HIDDEN_SELECTOR, wikiToolsFlag } from "./wiki-read-slice.ts";
import type { KeyKind } from "../../../wiki/key-kinds.ts";
import type { MentionsBody } from "../../../wiki/mentions.ts";

export const SEL_MIN_CHARS = 3;
export const SEL_MAX_CHARS = 1500;
const MENTIONS_PATH = "/api/wiki/mentions";
/** A right-click this close to the selection's text counts as on it. */
const ON_SELECTION_PX = 4;

export interface SelectionMenuDeps {
  /** The served wiki's registry name, for the mentions route. */
  wiki(): string;
  /** The open page's relPath and name (null off a page). */
  relPath(): string | null;
  currentName(): string | null;
  /** The open page's type (`explainer` takes the iframe path). */
  pageType(): string | null;
  /** The graph section's id: never a selection from there. */
  graphId: string;
  /** The classic Explain (an Ask turn in the article pane) and the selection fact check. */
  explainClassic(sel: string, heading: string): void;
  /** The classic Explain's `/api/wiki/explain` URL, for an inline card. */
  explainUrl(sel: string, heading: string): string;
  factcheck(sel: string, heading: string): void;
  hrefFor(relPath: string): string;
}

interface Shown {
  text: string;
  heading: string;
  /** The selection's range when it was shown (null on an explainer). */
  range: Range | null;
  explainer: boolean;
  items: SelMenuItem[];
}

let deps: SelectionMenuDeps | null = null;
let shown: Shown | null = null;
/** The page's reader flags (`setSelectionMenuPage`). */
let page: { mentions: boolean; trackerProjects: string[]; kinds: KeyKind[] } = { mentions: false, trackerProjects: [], kinds: [] };
type MentionsAnswer = { ok: true; body: MentionsBody } | { ok: false; message: string };
/** How long a mentions answer is reused: «Where else» then «History» on one
 *  key is one request, and a commit made elsewhere shows within this. */
export const MENTIONS_FRESH_MS = 30_000;
/** Mentions answers per wiki and key: `at` null while the request is in
 *  flight (asks share it), else when it answered. */
const mentionsCache = new Map<string, { p: Promise<MentionsAnswer>; at: number | null }>();
/** The markup each turn card body was drawn from. */
const drawnBody = new WeakMap<Element, string>();
let repositionQueued = false;
/** An action ran on a press: the release that follows lands on the article
 *  under the bar (now hidden) and must not show the bar again. The next
 *  press clears it. */
let actedOnPress = false;
/** The open Explain / Oppfølging card, kept so a render of its page can put it back. */
let held: { el: HTMLElement; wiki: string; relPath: string; passage: string; context: PassageContext | null } | null = null;
let reattachQueued = false;
/** Until then a `contextmenu` belongs to the keyboard gesture that opened the menu. */
let keyMenuUntil = 0;
const KEY_MENU_MS = 500;

function bar(): HTMLElement {
  let el = document.getElementById(SEL_BAR_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = SEL_BAR_ID;
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "Selection");
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function menu(): HTMLElement {
  let el = document.getElementById(SEL_MENU_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = SEL_MENU_ID;
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "Selection");
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

/** Is the bar or the menu on screen? (A bar hidden while its selection is
 *  scrolled away is not.) */
export function selectionMenuOpen(): boolean {
  return [SEL_BAR_ID, SEL_MENU_ID].some((id) => {
    const el = document.getElementById(id);
    return !!el && el.style.display !== "none" && el.style.visibility !== "hidden";
  });
}

/** Hide both. Focus inside them goes back to the page: the keyboard opens the
 *  menu only from there (`enterIsOurs`: the page or the article's own text,
 *  which holds no focusable element). */
export function hideSelectionMenu(): void {
  shown = null;
  const b = document.getElementById(SEL_BAR_ID);
  const m = document.getElementById(SEL_MENU_ID);
  const active = document.activeElement as HTMLElement | null;
  const focusIn = !!active && (!!b?.contains(active) || !!m?.contains(active));
  if (b) b.style.display = "none";
  if (m) m.style.display = "none";
  if (focusIn) active?.blur?.();
}

/** Per page render: the reader payload's mentions flag, tracker projects and key kinds. */
export function setSelectionMenuPage(reader: { mentions?: unknown; trackerProjects?: unknown; keyKinds?: unknown } | null | undefined): void {
  page = {
    mentions: reader?.mentions === true,
    trackerProjects: Array.isArray(reader?.trackerProjects) ? (reader.trackerProjects as unknown[]).filter((p): p is string => typeof p === "string") : [],
    kinds: keyKindsFrom(reader?.keyKinds),
  };
  // The page rendered again (navigation, a reload, an Apply's commit): what
  // the files and history say may have moved.
  mentionsCache.clear();
  if (held && !reattachQueued) {
    reattachQueued = true;
    // After the rest of the render: its enhancements must not run over the card.
    const run = () => {
      reattachQueued = false;
      reattachCard();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  }
}

/** Is `card` the held card, on the page still shown? (Its stream keeps running.) */
function cardHeld(card: Element): boolean {
  return !!held && held.el === card && !!deps && deps.wiki() === held.wiki && deps.relPath() === held.relPath;
}

const MOVED_CLASS = "wiki-sel-card-moved";

/** The held card, taken out by a render of its page: back under its passage,
 *  or at the article's top saying the passage is gone. Dropped on another
 *  page and after an Apply of its own turn (the Discuss tab shows that outcome). */
function reattachCard(): void {
  const h = held;
  if (!h || h.el.isConnected) return;
  if (!cardHeld(h.el)) {
    held = null;
    return;
  }
  const key = h.el.getAttribute("data-sel-turn");
  if (key && discussTurnForCard(key)?.turn.edit?.state === "applied") {
    held = null;
    return;
  }
  const wrap = document.getElementById("articleWrap");
  const a = article();
  // Not a page view (an Ask answer took the pane): kept for the page's next render.
  if (!wrap || !a) return;
  const found = findPassage(wrap, h.passage, h.context);
  h.el.querySelector(`.${MOVED_CLASS}`)?.remove();
  if (found) insertCard(h.el, found.range);
  else {
    h.el.querySelector(".wiki-sel-card-head")?.insertAdjacentHTML("afterend", `<div class="wiki-discuss-hint ${MOVED_CLASS}" role="status">The passage this answers is no longer on the page as it was.</div>`);
    a.insertBefore(h.el, a.firstChild);
  }
  if (key) paintTurnCard(h.el);
  h.el.scrollIntoView?.({ block: "nearest" });
}

function article(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#articleWrap .wiki-article");
}

/** The live selection as the menu reads it, or null when it offers nothing. */
function readSelection(): { text: string; heading: string; range: Range } | null {
  if (!deps?.currentName() || deps.pageType() === "explainer") return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const wrap = document.getElementById("articleWrap");
  const anchor = sel.anchorNode;
  if (!wrap || !anchor || !wrap.contains(anchor)) return null;
  const graph = document.getElementById(deps.graphId);
  if (graph && (graph.contains(anchor) || (sel.focusNode && graph.contains(sel.focusNode)))) return null;
  const range = sel.getRangeAt(0);
  // Never from an inline card: its text is the reader's, not the page's.
  for (const n of [range.startContainer, range.endContainer]) {
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    if (el?.closest(`.${SEL_CARD_CLASS}`)) return null;
  }
  // Without the reader's own text (id nouns, fold sizes): the server locates
  // this in the page source, which has none of it.
  const text = readerSelectionText(sel).trim();
  if (text.length < SEL_MIN_CHARS || text.length > SEL_MAX_CHARS) return null;
  return { text, heading: nearestHeading(range), range: range.cloneRange() };
}

/** The actions this viewer sees. Under the read slice its CSS hides the
 *  egress actions (`wiki-read-slice.ts`): they are not offered at all, by the
 *  same selector, matched on each action's own bar button. */
function itemsFor(text: string, explainer: boolean): SelMenuItem[] {
  const a = article();
  const items = selMenuItems({
    text,
    explainer,
    mentions: page.mentions,
    follow: !explainer && discussAgentOn() && !!a && !!followHeading(a),
    keys: detectKeys(text, page.trackerProjects, page.kinds),
  });
  if (wikiToolsFlag()) return items;
  const tpl = document.createElement("template");
  tpl.innerHTML = selBarHtml(items);
  const btns = Array.from(tpl.content.children);
  return items.filter((_, i) => !btns[i]?.matches(WIKI_READ_SLICE_HIDDEN_SELECTOR));
}

/** Called on the article's `mouseup`: show the bar for the selection, or hide it. */
export function maybeShowSelectionBar(): void {
  const s = readSelection();
  if (!s) return hideSelectionMenu();
  const items = itemsFor(s.text, false);
  if (!selMenuOffers(items)) return hideSelectionMenu();
  shown = { ...s, explainer: false, items };
  const m = document.getElementById(SEL_MENU_ID);
  if (m) m.style.display = "none";
  const b = bar();
  b.innerHTML = selBarHtml(shown.items);
  b.style.display = "flex";
  placeBar();
}

/** The explainer iframe's selection (its bridge): the bar at the frame's top. */
export function showSelectionBarForExplainer(text: string, heading: string): void {
  if (!deps?.currentName()) return;
  const items = itemsFor(text, true);
  if (!selMenuOffers(items)) return hideSelectionMenu();
  shown = { text, heading, range: null, explainer: true, items };
  const b = bar();
  b.innerHTML = selBarHtml(shown.items);
  b.style.display = "flex";
  placeBar();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** The selection's first and last line on screen, or null when it has no
 *  layout (a DOM without one, nodes a render took out). */
function selectionBox(range: Range): { left: number; top: number; bottom: number; rects: DOMRect[] } | null {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  if (!rects.length) return null;
  return { left: rects[0]!.left, top: rects[0]!.top, bottom: rects.at(-1)!.bottom, rects };
}

/** The part of the viewport the article pane shows (under the top nav). */
function readingArea(): { top: number; bottom: number } {
  const vh = window.innerHeight || 768;
  const r = document.getElementById("articleWrap")?.getBoundingClientRect();
  return r && r.bottom > r.top ? { top: Math.max(0, r.top), bottom: Math.min(vh, r.bottom) } : { top: 0, bottom: vh };
}

/** Put the bar under the selection's last line (above it when there is no
 *  room), inside the article pane; hidden while no line of the selection is
 *  in the pane. */
function placeBar(): void {
  const b = document.getElementById(SEL_BAR_ID);
  if (!b || !shown || b.style.display === "none") return;
  const area = readingArea();
  let rect: { left: number; top: number; bottom: number } | null = null;
  const box = shown.range ? selectionBox(shown.range) : null;
  // No layout to tell by (an explainer's bar, a DOM without one): shown.
  const inView = !box || box.rects.some((r) => r.bottom > area.top && r.top < area.bottom);
  b.style.visibility = inView ? "" : "hidden";
  if (!inView) return;
  if (shown.range) {
    rect = box ?? shown.range.getBoundingClientRect();
  } else {
    const frame = document.querySelector<HTMLElement>(".wiki-explainer-frame");
    const r = frame?.getBoundingClientRect();
    if (r) rect = { left: r.left + 8, top: r.top + 8, bottom: r.top + 8 };
  }
  if (!rect) return;
  const w = b.offsetWidth || 320;
  const h = b.offsetHeight || 36;
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const below = rect.bottom + 6;
  const top = below + h > vh - 4 && rect.top - h - 6 > 4 ? rect.top - h - 6 : below;
  b.style.left = `${clamp(rect.left, 4, Math.max(4, vw - w - 4))}px`;
  b.style.top = `${clamp(top, area.top + 4, Math.max(area.top + 4, vh - h - 4))}px`;
}

function queueReposition(): void {
  if (repositionQueued || !shown) return;
  repositionQueued = true;
  const run = () => {
    repositionQueued = false;
    placeBar();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/** Is the point on the selection's text? */
function onSelection(range: Range, x: number, y: number): boolean {
  return Array.from(range.getClientRects()).some((r) => x >= r.left - ON_SELECTION_PX && x <= r.right + ON_SELECTION_PX && y >= r.top - ON_SELECTION_PX && y <= r.bottom + ON_SELECTION_PX);
}

/** A right-click: the menu when it is on the selection (not with ⇧). */
function onContextMenu(e: MouseEvent): void {
  // The keyboard gesture opened the menu already (its keydown): no browser menu over it.
  if (Date.now() < keyMenuUntil && selectionMenuOpen()) {
    e.preventDefault();
    return;
  }
  if (e.shiftKey || !document.getElementById("articleWrap")?.contains(e.target as Node)) return;
  const s = readSelection();
  if (!s || !onSelection(s.range, e.clientX, e.clientY)) return;
  const items = itemsFor(s.text, false);
  // Nothing but Copy: the browser's own menu, untouched.
  if (!selMenuOffers(items)) return;
  e.preventDefault();
  showMenu(s, items, e.clientX, e.clientY);
}

function showMenu(s: { text: string; heading: string; range: Range }, items: SelMenuItem[], x: number, y: number): HTMLElement {
  shown = { ...s, explainer: false, items };
  const b = document.getElementById(SEL_BAR_ID);
  if (b) b.style.display = "none";
  const m = menu();
  m.innerHTML = selMenuHtml(shown.items, s.text);
  m.style.display = "block";
  const w = m.offsetWidth || 270;
  const h = m.offsetHeight || 300;
  m.style.left = `${clamp(x, 4, Math.max(4, (window.innerWidth || 1024) - w - 4))}px`;
  m.style.top = `${clamp(y, 4, Math.max(4, (window.innerHeight || 768) - h - 4))}px`;
  return m;
}

/** The ContextMenu key or ⇧F10: the menu under the selection, focus on its
 *  first item. False (the browser's own) when the selection offers nothing. */
function openMenuFromKeyboard(): boolean {
  const s = readSelection();
  if (!s) return false;
  const items = itemsFor(s.text, false);
  if (!selMenuOffers(items)) return false;
  const box = selectionBox(s.range);
  const m = showMenu(s, items, box?.left ?? 0, box ? box.bottom + 6 : 0);
  keyMenuUntil = Date.now() + KEY_MENU_MS;
  m.querySelector<HTMLElement>("[data-selact]")?.focus({ preventScroll: true });
  return true;
}

/** Arrow keys between the menu's items (↑/↓) or the bar's buttons (←/→), Home and End. */
function moveFocus(e: KeyboardEvent): boolean {
  const active = document.activeElement as HTMLElement | null;
  const box = active?.closest?.<HTMLElement>(`#${SEL_BAR_ID}, #${SEL_MENU_ID}`);
  if (!box || !active) return false;
  const [prev, next] = box.id === SEL_MENU_ID ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  const items = Array.from(box.querySelectorAll<HTMLElement>("[data-selact]"));
  const i = items.indexOf(active);
  const n = items.length;
  const to = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : e.key === next ? (i + 1) % n : e.key === prev ? (i - 1 + n) % n : -1;
  if (to < 0 || !n) return false;
  items[to]!.focus({ preventScroll: true });
  return true;
}

// ── Actions ─────────────────────────────────────────────────────────────

/** The actions that reach a model: refused on a read-only wiki here too,
 *  since Enter runs the default with no event the read-only guard sees. */
const EGRESS: ReadonlySet<SelAction> = new Set(["explain", "factcheck", "follow"]);

function activate(act: SelAction, key: string | null): void {
  const s = shown;
  hideSelectionMenu();
  if (!s || !deps) return;
  if (EGRESS.has(act) && discussSendBlocked()) return;
  switch (act) {
    case "explain":
      if (s.explainer || !discussAgentOn()) deps.explainClassic(s.text, s.heading);
      else threadCard("explain", s, EXPLAIN_QUESTION, "explore", (why, context) => classicExplainCard(s, why, context));
      return;
    case "follow":
      threadCard("follow", s, FOLLOW_QUESTION, "edit");
      return;
    case "factcheck":
      deps.factcheck(s.text, s.heading);
      return;
    case "copy":
      void copyText(s.text);
      return;
    case "where":
    case "history":
      void mentionsCard(act, s, s.text);
      return;
    case "key":
      if (key) void mentionsCard("where", s, key);
      return;
  }
}

/** Put a card under the selection's paragraph (before the frame on an
 *  explainer), replacing any card already open on the page. */
function placeCard(s: Shown, html: string): HTMLElement | null {
  for (const old of Array.from(document.querySelectorAll(`#articleWrap .${SEL_CARD_CLASS}`))) old.remove();
  held = null;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const card = tpl.content.firstElementChild as HTMLElement | null;
  if (!card || !insertCard(card, s.range)) return null;
  card.scrollIntoView?.({ block: "nearest" });
  return card;
}

/** Insert `card` under the paragraph that holds `range`'s end; under the
 *  article pane's part that holds it when that is not the page's text (its
 *  head); else before an explainer's frame or at the pane's end. */
function insertCard(card: HTMLElement, range: Range | null): boolean {
  const a = article();
  const wrap = document.getElementById("articleWrap");
  const endNode = range ? (a ? selectionEndNode(range, a) : range.endContainer) : null;
  // In the article pane but not in the page's text (its head): under that part.
  let outside: Node | null = endNode && wrap?.contains(endNode) && !a?.contains(endNode) ? endNode : null;
  while (outside && outside.parentNode !== wrap) outside = outside.parentNode;
  if (range && a && endNode && a.contains(endNode)) {
    const at = inlineCardAnchor(range, a);
    at.parent.insertBefore(card, at.before);
  } else if (outside && wrap) {
    wrap.insertBefore(card, outside.nextSibling);
  } else {
    const frame = document.querySelector(".wiki-explainer-frame");
    if (frame?.parentNode) frame.parentNode.insertBefore(card, frame);
    else if (wrap) wrap.appendChild(card);
    else return false;
  }
  return true;
}

/** Keep an answer card for a render of its page (`reattachCard`): its
 *  passage as the Discuss chip's finder reads the page. */
function holdCard(card: HTMLElement, s: Shown, context: PassageContext | null): void {
  const rel = deps?.relPath();
  if (!deps || !rel || !s.range) return;
  held = { el: card, wiki: deps.wiki(), relPath: rel, passage: renderedPassageText(s.range), context };
}

/** «Explain with context» or «Add to Oppfølging»: a turn of the page's thread.
 *  `fallback` runs instead of an error card, with the reason, when the
 *  selection is no passage or a turn of the discussion is still running. */
function threadCard(kind: CardKind, s: Shown, question: string, mode: "explore" | "edit", fallback?: (why: string, context: PassageContext | null) => void): void {
  const live = window.getSelection();
  const passage = live && s.range ? readSelectionPassage(live) : null;
  if (!passage) {
    if (fallback) return fallback("outside the page's text, so not in its discussion", null);
    placeCard(s, inlineCardHtml(kind, "", `<div class="wiki-discuss-error" role="alert">This selection cannot be sent as a passage of the page: select it again inside the page's text.</div>`, null));
    return;
  }
  const context = { before: passage.before, after: passage.after };
  const p = { selection: passage.selection, before: passage.before, after: passage.after, atStart: passage.atStart, atEnd: passage.atEnd, heading: passage.heading, ...(passage.edge ? { edge: passage.edge } : {}) };
  const r = startInlineTurn(question, p, passage.range, mode);
  if ("refused" in r && r.busy && fallback) return fallback("the page's discussion is busy, so not in it", context);
  if ("refused" in r) {
    placeCard(s, inlineCardHtml(kind, "", `<div class="wiki-discuss-error" role="alert">${escText(r.refused)}</div>`, null));
    return;
  }
  const card = placeCard(s, inlineCardHtml(kind, "a turn in this page's discussion", "", r.key));
  if (!card) return;
  holdCard(card, s, context);
  paintTurnCard(card);
}

/** Explain where the page's thread cannot take the turn: the classic
 *  `/api/wiki/explain` stream, painted into an inline card (D3) rather than in
 *  place of the page. Not a turn of the discussion; `why` is its sub line. A
 *  card that leaves the page (replaced, closed, another page) aborts its
 *  stream; one a render of its page took out keeps it, for `reattachCard`. */
function classicExplainCard(s: Shown, why: string, context: PassageContext | null): void {
  const d = deps;
  if (!d) return;
  const card = placeCard(s, inlineCardHtml("explain", why, `<div class="wiki-discuss-status"><span class="spinner"></span><span>Searching the wiki…</span></div>`, null));
  const body = card?.querySelector(".wiki-sel-card-body");
  if (!card || !body) return;
  holdCard(card, s, context);
  const live = () => card.isConnected || cardHeld(card);
  const ctl = new AbortController();
  let text = "";
  let ended = false;
  const fail = (msg: string) => {
    ended = true;
    body.innerHTML = `<div class="wiki-discuss-error" role="alert">${escText(msg)}</div>`;
  };
  const parser = makeSseFrameParser((f) => {
    if (!live()) return ctl.abort();
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(f.data) as Record<string, unknown>;
    } catch {
      /* a frame with no JSON carries nothing here */
    }
    if (f.event === "delta" && typeof m.text === "string") text += m.text;
    else if (f.event === "done") {
      ended = true;
      if (typeof m.answer === "string" && m.answer) text = m.answer;
    } else if (f.event === "answer_html" && typeof m.html === "string" && m.html) {
      ended = true;
      body.innerHTML = enhanceConfidenceHtml(m.html);
      return;
    } else if (f.event === "app_error") return fail(typeof m.message === "string" && m.message ? m.message : "Something went wrong.");
    else return;
    body.innerHTML = renderStreamingBody(text);
  });
  void (async () => {
    try {
      const res = await fetch(d.explainUrl(s.text, s.heading), { signal: ctl.signal, headers: { Accept: "text/event-stream" } });
      if (!res.ok || !res.body) return fail(`The explanation failed (${res.status}).`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (let r = await reader.read(); !r.done; r = await reader.read()) parser.push(dec.decode(r.value, { stream: true }));
      parser.end();
      if (!ended && live()) fail("The explanation ended before its answer.");
    } catch {
      if (!ctl.signal.aborted && live()) fail("The explanation failed: the server did not answer.");
    }
  })();
}

function escText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Draw a turn card's body from the turn record, when its markup changed. */
function paintTurnCard(card: Element): void {
  const key = card.getAttribute("data-sel-turn");
  const body = card.querySelector(".wiki-sel-card-body");
  if (!key || !body) return;
  const found = discussTurnForCard(key);
  const html = found
    ? discussTurnBodyParts(found.turn, found.current).join("") || ""
    : `<div class="wiki-discuss-hint">This turn is no longer in the page's discussion.</div>`;
  if (drawnBody.get(body) === html) return;
  body.innerHTML = html;
  drawnBody.set(body, html);
}

function paintTurnCards(): void {
  for (const card of Array.from(document.querySelectorAll(`#articleWrap .${SEL_CARD_CLASS}[data-sel-turn]`))) paintTurnCard(card);
}

function fetchMentions(wiki: string, key: string): Promise<MentionsAnswer> {
  const k = `${wiki}\n${key}`;
  const hit = mentionsCache.get(k);
  if (hit && (hit.at === null || Date.now() - hit.at < MENTIONS_FRESH_MS)) return hit.p;
  const p = (async (): Promise<MentionsAnswer> => {
    try {
      const res = await fetch(`${MENTIONS_PATH}?${new URLSearchParams({ wiki, key }).toString()}`, { headers: { Accept: "application/json" } });
      const data = (await res.json().catch(() => null)) as (MentionsBody & { error?: string }) | null;
      if (res.ok && data && Array.isArray(data.files)) return { ok: true as const, body: data };
      return { ok: false as const, message: data?.error ? `The search failed: ${data.error} (${res.status}).` : `The search failed (${res.status}).` };
    } catch {
      return { ok: false as const, message: "The search failed: the server did not answer." };
    }
  })();
  const entry: { p: Promise<MentionsAnswer>; at: number | null } = { p, at: null };
  mentionsCache.set(k, entry);
  // Neither a failure nor a PR row the route is still refreshing is kept: the next ask asks again.
  void p.then((r) => {
    if (mentionsCache.get(k) !== entry) return;
    if (r.ok && !r.body.prs.some((pr) => pr.stale)) entry.at = Date.now();
    else mentionsCache.delete(k);
  });
  return p;
}

/** «Where else» / «History» (no model): the card at once, its body when the route answers. */
async function mentionsCard(kind: "where" | "history", s: Shown, key: string): Promise<void> {
  if (!deps) return;
  const card = placeCard(s, inlineCardHtml(kind, key, `<div class="wiki-discuss-status"><span class="spinner"></span><span>Searching the wiki…</span></div>`, null));
  if (!card) return;
  const r = await fetchMentions(deps.wiki(), key);
  if (!card.isConnected) return;
  const body = card.querySelector(".wiki-sel-card-body");
  if (!body) return;
  if (!r.ok) body.innerHTML = `<div class="wiki-discuss-error" role="alert">${escText(r.message)}</div>`;
  else body.innerHTML = kind === "where" ? whereElseHtml(r.body, { currentRelPath: deps.relPath(), hrefFor: deps.hrefFor }) : historyHtml(r.body);
}

function selActOf(t: EventTarget | null): HTMLElement | null {
  const el = t as HTMLElement | null;
  return el?.closest?.<HTMLElement>(`#${SEL_BAR_ID} [data-selact], #${SEL_MENU_ID} [data-selact]`) ?? null;
}

/** What Enter already means something on: links, controls, widgets. */
const ENTER_OWNERS =
  "a[href], area[href], button, input, select, textarea, summary, label, iframe, [contenteditable]:not([contenteditable='false']), " +
  "[role=button], [role=link], [role=menuitem], [role=option], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=treeitem], [role=combobox], [role=textbox], [tabindex]";

/** Is Enter the bar's? Only with focus on the page itself or on the
 *  article's own text: never on a control, and never outside the article
 *  (the rail, the breadcrumb, the panes). */
function enterIsOurs(t: EventTarget | null): boolean {
  const el = t as Element | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  const wrap = document.getElementById("articleWrap");
  if (!wrap || typeof el.closest !== "function" || !wrap.contains(el)) return false;
  const hit = el.closest(ENTER_OWNERS);
  return !hit || hit === wrap || !wrap.contains(hit);
}

/** Wire the menu once, at boot. */
export function initSelectionMenu(d: SelectionMenuDeps): void {
  deps = d;
  // Show on selection release inside the article pane; the timeout lets the
  // browser finalize the selection first. (articleWrap persists across pages.)
  document.getElementById("articleWrap")?.addEventListener("mouseup", (e) => {
    if ((e as MouseEvent).button !== 0) return;
    if (actedOnPress) {
      actedOnPress = false;
      return;
    }
    // A press on a control (a card's button, the section bar) leaves a live
    // selection as it was: that is no new selection to offer the bar for.
    if ((e.target as Element | null)?.closest?.(`.${SEL_CARD_CLASS}, button, input, textarea, select`)) return;
    setTimeout(maybeShowSelectionBar, 0);
  });
  // On the document: the keyboard's own context menu goes to the focused element.
  document.addEventListener("contextmenu", (e) => onContextMenu(e as MouseEvent));
  // Dismiss on selection collapse and Escape.
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if ((!sel || sel.isCollapsed) && shown && !shown.explainer) hideSelectionMenu();
  });
  document.addEventListener("keydown", (e) => {
    // The keyboard's context-menu gesture: our menu for a selection that offers it.
    const gesture = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
    // Taken where Enter is (focus on the page or the article's own text): on a
    // link or a control it is that element's menu.
    if (gesture && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented) {
      if (enterIsOurs(e.target) && openMenuFromKeyboard()) e.preventDefault();
      return;
    }
    if (!selectionMenuOpen()) return;
    if (e.key === "Escape") return hideSelectionMenu();
    if (moveFocus(e)) return e.preventDefault();
    // Enter: the default action, unless focus is on something Enter already drives.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !e.defaultPrevented && enterIsOurs(e.target)) {
      const def = shown?.items[0];
      if (!def) return;
      e.preventDefault();
      activate(def.act, def.key ?? null);
    }
  });
  // A press on an action runs it (its default prevented, so the selection
  // stays); a press elsewhere in the bar or menu keeps the selection; a press
  // anywhere else closes them. «Ask Claude Code» acts on its own click:
  // closing here would not move it, but its selection must stay.
  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    const act = selActOf(t);
    actedOnPress = false;
    if (act) {
      e.preventDefault();
      if (e.button === 0) {
        actedOnPress = true;
        activate(act.dataset.selact as SelAction, act.dataset.selkey ?? null);
      }
      return;
    }
    if (t.closest?.(`#${SEL_BAR_ID}, #${SEL_MENU_ID}`)) {
      e.preventDefault();
      return;
    }
    if (t.closest?.("#wikiDiscussHandoffBtn, #wikiDiscussHandoffPageBtn")) return;
    hideSelectionMenu();
  });
  // The keyboard's Enter or Space on a focused action (a mouse press already ran it).
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const act = selActOf(t);
    if (act && (e as MouseEvent).detail === 0) {
      e.preventDefault();
      activate(act.dataset.selact as SelAction, act.dataset.selkey ?? null);
      return;
    }
    const close = t.closest?.(`.${SEL_CARD_CLASS} [data-sel-card-close]`);
    if (close) {
      const card = close.closest(`.${SEL_CARD_CLASS}`);
      if (card && held?.el === card) held = null;
      card?.remove();
      return;
    }
    const pane = t.closest?.<HTMLElement>(`.${SEL_CARD_CLASS} [data-sel-card-pane]`);
    if (pane) showTurnInDiscuss(pane.dataset.selCardPane ?? "");
  });
  // The bar is placed in the viewport: it follows the selection when the page
  // scrolls or resizes. The menu closes on a scroll, as the browser's own does.
  document.addEventListener(
    "scroll",
    () => {
      // (The menu itself never scrolls: it has no overflow.)
      const m = document.getElementById(SEL_MENU_ID);
      if (m && m.style.display !== "none") return hideSelectionMenu();
      queueReposition();
    },
    true,
  );
  window.addEventListener("resize", queueReposition);
  onDiscussChange(paintTurnCards);
}
