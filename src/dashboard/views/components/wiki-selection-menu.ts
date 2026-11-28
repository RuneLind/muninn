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
 *   characters), and on a selection that settles after a touch or pen press
 *   (a long-press ends with no `mouseup`: `queueTouchSettle`), never on the
 *   keyboard's Shift+arrow steps. A right-click inside the selection opens
 *   the menu instead; ⇧-right-click, or a right-click outside the selection, is the browser's.
 * - «Explain with context» on a wiki with a wiki agent is a turn of the page's
 *   thread, sent through the pane's own entry (`startInlineTurn`): the same
 *   turn record the pane draws, so it is never a second copy, and the pane
 *   need not be open. Its card repaints on `onDiscussChange` and links to the
 *   thread in /chat. Where the thread cannot take it (the selection is no
 *   passage, or a turn of the discussion is still running) the card streams
 *   the classic `/api/wiki/explain` answer instead. Without an agent (and on
 *   an explainer, whose card goes before its frame) the card streams that
 *   classic answer too: never in place of the page.
 * - «Where else» and «History» read `GET /api/wiki/mentions` (no model), for
 *   a selection the route accepts as a key (one line, 3–80 characters); a key
 *   found in the selection gets its own chip, which opens its Trace
 *   (`wiki-key-trace.ts`, PR 6). The answers are cached in
 *   `wiki-mentions-fetch.ts`, which a page render clears.
 * - «Fact check» is the existing selection fact check; «Add to Oppfølging»
 *   (a page with an `Oppfølging` heading and an agent) is an Edit turn whose
 *   proposed-edit card and Apply are the pane's.
 *
 * - An Explain or Oppfølging card still open when the same page renders again
 *   (an in-place reload, an Apply from the pane) is put back at its passage,
 *   a copy whose surroundings, read in DOM order off the live range when the
 *   card opened (`holdPassage`), still match (`findSamePassage`), or at the
 *   article's top with a note when there is none; its classic stream keeps
 *   running meanwhile. A card is shown exactly while the element its
 *   selection ends in is laid out (`syncCardVisibility`).
 *   Not after an Apply of its own turn (its outcome is on the Discuss tab),
 *   and not on another page.
 * - Keyboard: the ContextMenu key or ⇧F10 opens the menu at the selection
 *   with focus on its first item; arrows move (↑/↓ in the menu, ←/→ in the
 *   bar), Escape closes with focus back where it was. The bar hides while its
 *   selection is scrolled out of the article pane; a scroll that moves the
 *   selection closes the menu.
 *
 * - Who answers (Discuss v3 P1): Explain's tooltip is drawn by the bar (a
 *   native `title` cannot hold a control): the sentence, then «Runs as
 *   <user> · <model> · <connector> · Change…», the user the next turn runs as
 *   (`discussRunsAsHere`, «…» while the page's light read is pending) and the
 *   page payload's `discussWho`. «Change…» opens the who box: the users to
 *   pick from (a pick is rule R3, `pickDiscussUser`, and closes the open turn
 *   card), the bot and where it comes from, the model with «Change on /models
 *   ↗». A wiki pinned to a bot that is missing has no one to answer: the
 *   tooltip says so and Explain is the classic one. A turn card's head names
 *   the same user, set when it is placed; placed while no read has named
 *   the user (pending or refused), it is filled once from its own turn, and
 *   a refused one says «not sent» (R6, `fillPendingWho`). The
 *   who box follows the bar and hides with it; Escape closes it either way.
 *   The menu (right-click, ⇧F10) has the same «Runs as» line under Explain
 *   and «Change…» as a menu item the arrows reach; that who box opens beside
 *   the menu, and closing it puts focus back on «Change…».
 * - «Follow up» (Discuss v3 P2): a thread card holds the keys of its turns
 *   (`data-sel-turns`) and paints each; its foot's box sends an Explore turn
 *   naming the card's first turn as its origin, about the passage that turn
 *   stored (`sendFollowUp`), so it works with the selection gone. The held
 *   passage is read before the first POST and stored with it (D12).
 *   «⌘ Continue in Claude Code» once the card has two turns (D4), «Open in
 *   chat ↗» in place of «Open in Discuss →», Collapse and «⧉ Copy answer».
 *   A send refused 409 `closed` closes the card and says so.
 * - «One button» (Discuss v3 P1): the handoff's passage control is a bar item
 *   («⌘ Ask Claude Code», or «💬 Ask about this» where the wiki has an agent
 *   and no handoff), offered up to the handoff's own bound: a selection past
 *   the bar's 1,500 characters gets only it and Copy.
 *
 * The bar's Explain, Fact check and handoff keep the ids `#wikiExplainBtn`,
 * `#wikiFactcheckBtn` and `#wikiDiscussHandoffBtn`, and every egress action
 * carries `data-selact`, which the read-only selectors name. Actions run on
 * `mousedown` (its default prevented, so the selection stays), as the old
 * buttons did, and on a keyboard `click`.
 */

import { copyText } from "./copy-path.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { enhanceConfidenceHtml, renderStreamingBody } from "./wiki-ask-render.ts";
import { readerSelectionText } from "./wiki-lens.ts";
import { nearestHeading } from "./wiki-nearest-heading.ts";
import { discussHandoffMode, mayBePassage, openDiscussHandoff, readSelectionPassage } from "./wiki-discuss-handoff.ts";
import {
  discussAgentOn,
  discussRunsAsHere,
  discussSendBlocked,
  discussTurnForCard,
  discussUserNameHere,
  discussWhoUsersHere,
  retryDiscussWho,
  discussPopOutHrefHere,
  onDiscussChange,
  pickDiscussUser,
  startInlineTurn,
} from "./wiki-discuss-tab.ts";
import { HANDOFF_QUESTION_MAX, HANDOFF_SELECTION_MAX } from "../../../wiki/discuss-bounds.ts";
import { discussTurnBodyParts, findSamePassage, holdPassage, turnLive, type DiscussTurnView, type HeldPassage } from "./wiki-discuss-state.ts";
import {
  CARD_CLOSED_ELSEWHERE,
  cardContinueHtml,
  cardTurnHtml,
  EXPLAIN_QUESTION,
  FOLLOW_QUESTION,
  SEL_BAR_ID,
  SEL_CARD_CLASS,
  SEL_HANDOFF_BTN_ID,
  SEL_MENU_ID,
  SEL_MENU_WHO_ID,
  SEL_TIP_ID,
  SEL_WHO_ID,
  detectKeys,
  followHeading,
  hasBox,
  historyHtml,
  inlineCardAnchor,
  inlineCardHtml,
  keyKindsFrom,
  inlineTurnSub,
  selRunsAsHtml,
  selTipHtml,
  selWhoFrom,
  selWhoHtml,
  selBarHtml,
  selMenuOffers,
  selectionEndNode,
  selMenuHtml,
  selMenuItems,
  whereElseHtml,
  type CardKind,
  type SelAction,
  type SelMenuItem,
  type SelWho,
} from "./wiki-selection-menu-model.ts";
import { WIKI_READ_SLICE_HIDDEN_SELECTOR, wikiToolsFlag } from "./wiki-read-slice.ts";
import type { KeyKind } from "../../../wiki/key-kinds.ts";
import { clearMentionsCache, fetchMentions } from "./wiki-mentions-fetch.ts";
import { hideKeyPeek, openTrace } from "./wiki-key-trace.ts";

export { MENTIONS_FRESH_MS } from "./wiki-mentions-fetch.ts";

export const SEL_MIN_CHARS = 3;
export const SEL_MAX_CHARS = 1500;
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
  /** The classic Explain's `/api/wiki/explain` URL, for an inline card. */
  explainUrl(sel: string, heading: string): string;
  /** The selection fact check (an Ask turn in the article pane). */
  factcheck(sel: string, heading: string): void;
  hrefFor(relPath: string): string;
}

interface Shown {
  text: string;
  heading: string;
  /** Past the bar's own bound, within the handoff's: only the handoff and Copy. */
  long?: boolean;
  /** The selection's range when it was shown (null on an explainer). */
  range: Range | null;
  explainer: boolean;
  items: SelMenuItem[];
}

let deps: SelectionMenuDeps | null = null;
let shown: Shown | null = null;
/** The page's reader flags (`setSelectionMenuPage`). */
let page: { mentions: boolean; trackerProjects: string[]; kinds: KeyKind[]; who: SelWho | null | undefined } = { mentions: false, trackerProjects: [], kinds: [], who: undefined };
/** The markup each turn card body was drawn from. */
const drawnBody = new WeakMap<Element, string>();
let repositionQueued = false;
/** An action ran on a press: the release that follows lands on the article
 *  under the bar (now hidden) and must not show the bar again. The next
 *  press clears it. */
let actedOnPress = false;
/** The open Explain / Oppfølging / Trace card, kept so a render of its page can put
 *  it back; `passage` null when the page's text has no copy of it to find. */
let held: { el: HTMLElement; wiki: string; relPath: string; passage: HeldPassage | null } | null = null;
let reattachQueued = false;
/** Until then a `contextmenu` belongs to the keyboard gesture that opened the menu. */
let keyMenuUntil = 0;
const KEY_MENU_MS = 500;
/** The article element that had focus when the keyboard opened the menu. */
let keyOpener: HTMLElement | null = null;

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

// ── Who answers: Explain's tooltip and the who box (Discuss v3 P1) ──────

/** The tooltip's «Runs as» part for the page shown: undefined where Explain
 *  is no thread turn (no agent, an explainer's selection). */
function tipWho(): SelWho | null | undefined {
  return shown?.explainer || !discussAgentOn() ? undefined : page.who;
}

/** Put Explain's tooltip into the bar, right after Explain (so Tab goes from
 *  Explain to «Change…»), hidden until Explain is hovered or focused. */
function mountTip(b: HTMLElement): void {
  const explain = b.querySelector('[data-selact="explain"]');
  if (!explain) return;
  const tip = document.createElement("div");
  tip.id = SEL_TIP_ID;
  tip.setAttribute("role", "tooltip");
  tip.innerHTML = selTipHtml(tipWho(), discussRunsAsHere());
  explain.after(tip);
}

let tipTimer: ReturnType<typeof setTimeout> | null = null;
const TIP_HIDE_MS = 280;

function showTip(): void {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = null;
  const tip = document.getElementById(SEL_TIP_ID);
  if (!tip) return;
  if (tipWho()) retryDiscussWho();
  refreshTip();
  tip.style.display = "block";
}

/** Hide the tooltip, at once or after a short delay (the pointer may be on its way into it). */
function hideTip(now = false): void {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = null;
  const run = () => {
    tipTimer = null;
    const tip = document.getElementById(SEL_TIP_ID);
    // Kept while focus is in it or on Explain (the keyboard's way to «Change…»).
    const active = document.activeElement;
    if (!now && tip && active && (tip.contains(active) || active.id === "wikiExplainBtn")) return;
    if (tip) tip.style.display = "none";
  };
  if (now) run();
  else tipTimer = setTimeout(run, TIP_HIDE_MS);
}

/** The «Runs as» part again (the read landed, a pick), its «Change…» button
 *  left in place so focus on it survives. */
function refreshTip(): void {
  const tip = document.getElementById(SEL_TIP_ID);
  if (!tip) return;
  const who = tipWho();
  const span = tip.querySelector<HTMLElement>("[data-seltip-who]");
  const hasChange = !!tip.querySelector("[data-selwho-open]");
  if (span && who !== undefined && hasChange === !!who) {
    const html = selRunsAsHtml(who, discussRunsAsHere());
    if (span.innerHTML !== html) span.innerHTML = html;
    return;
  }
  const html = selTipHtml(who, discussRunsAsHere());
  if (tip.innerHTML !== html) tip.innerHTML = html;
}

/** A pick's refusal, shown in the box until it is drawn for another reason. */
let whoMessage: string | null = null;

function whoBox(): HTMLElement {
  let el = document.getElementById(SEL_WHO_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = SEL_WHO_ID;
  // A group, never a dialog: `modalOpen()` reads every visible dialog as modal.
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Who answers");
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function whoBoxOpen(): boolean {
  const el = document.getElementById(SEL_WHO_ID);
  return !!el && el.style.display !== "none";
}

function paintWhoBox(): void {
  const el = document.getElementById(SEL_WHO_ID);
  const who = page.who;
  if (!el || !who || !deps) return;
  const users = discussWhoUsersHere();
  const html = selWhoHtml({ wiki: deps.wiki(), who, runsAs: discussRunsAsHere(), users: users.users, choosable: users.choosable, message: whoMessage });
  if (el.innerHTML !== html) {
    const focused = (document.activeElement as HTMLElement | null)?.getAttribute?.("data-selwho-user");
    el.innerHTML = html;
    if (focused) el.querySelector<HTMLElement>(`[data-selwho-user="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
}

/** The menu's «Change…» item that opened the who box (focus goes back to it). */
let whoOpener: HTMLElement | null = null;

/** «Change…»: the who box, under the bar (beside the menu when the menu's
 *  item opened it), focus on its current user (else its ✕). */
function openWhoBox(from: HTMLElement | null): void {
  if (!page.who) return;
  whoOpener = from?.closest?.(`#${SEL_MENU_ID}`) ? from : null;
  const el = whoBox();
  whoMessage = null;
  el.style.display = "block";
  el.style.visibility = "";
  retryDiscussWho();
  paintWhoBox();
  hideTip(true);
  placeWhoBox();
  (el.querySelector<HTMLElement>('[data-selwho-user][aria-pressed="true"]') ?? el.querySelector<HTMLElement>("[data-selwho-user]") ?? el.querySelector<HTMLElement>("[data-selwho-close]"))?.focus({ preventScroll: true });
}

/** Put the open who box under the bar (above it when there is no room). The
 *  bar's placing calls it too, so the box follows the selection. */
function placeWhoBox(): void {
  const el = document.getElementById(SEL_WHO_ID);
  if (!el || el.style.display === "none") return;
  const w = el.offsetWidth || 360;
  const h = el.offsetHeight || 220;
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const m = document.getElementById(SEL_MENU_ID);
  if (m && m.style.display !== "none") {
    // Beside the menu (right of it, else left), level with its «Change…».
    const r = m.getBoundingClientRect();
    const at = whoOpener?.isConnected ? whoOpener.getBoundingClientRect().top : r.top;
    const left = r.right + 6 + w <= vw - 4 ? r.right + 6 : r.left - w - 6;
    el.style.left = `${clamp(left, 4, Math.max(4, vw - w - 4))}px`;
    el.style.top = `${clamp(at, 4, Math.max(4, vh - h - 4))}px`;
    return;
  }
  const b = document.getElementById(SEL_BAR_ID)?.getBoundingClientRect();
  const top = b ? (b.bottom + 6 + h > vh - 4 && b.top - h - 6 > 4 ? b.top - h - 6 : b.bottom + 6) : 8;
  el.style.left = `${clamp(b?.left ?? 8, 4, Math.max(4, vw - w - 4))}px`;
  el.style.top = `${clamp(top, 4, Math.max(4, vh - h - 4))}px`;
}

/** Close the who box; focus back, when it was inside the box, on the menu's
 *  «Change…» that opened it while the menu shows, else on the bar's Explain. */
function closeWhoBox(): void {
  const el = document.getElementById(SEL_WHO_ID);
  if (!el) return;
  const focusIn = el.contains(document.activeElement);
  const opener = whoOpener;
  whoOpener = null;
  el.style.display = "none";
  whoMessage = null;
  if (!focusIn) return;
  const m = document.getElementById(SEL_MENU_ID);
  if (opener?.isConnected && m && m.style.display !== "none" && m.contains(opener)) opener.focus({ preventScroll: true });
  else document.getElementById("wikiExplainBtn")?.focus({ preventScroll: true });
}

/** A user picked in the who box (rule R3): refused while a turn runs (said in
 *  the box); else the thread is that user's now, so the open turn card closes. */
function pickWho(userId: string): void {
  const cur = discussRunsAsHere();
  if (cur.state === "user" && cur.userId === userId) return;
  const r = pickDiscussUser(userId);
  if ("refused" in r) {
    whoMessage = r.refused;
    paintWhoBox();
    return;
  }
  whoMessage = null;
  for (const card of Array.from(document.querySelectorAll(`#articleWrap .${SEL_CARD_CLASS}[data-sel-turn]`))) {
    if (held?.el === card) held = null;
    card.remove();
    dropCard(card);
  }
  if (held?.el.hasAttribute("data-sel-turn")) {
    dropCard(held.el);
    held = null;
  }
  paintWhoBox();
  refreshTip();
}

/** Is the bar or the menu on screen? (A bar hidden while its selection is
 *  scrolled away is not.) */
export function selectionMenuOpen(): boolean {
  return [SEL_BAR_ID, SEL_MENU_ID].some((id) => {
    const el = document.getElementById(id);
    return !!el && el.style.display !== "none" && el.style.visibility !== "hidden";
  });
}

/** Hide both, with Explain's tooltip and the who box. Focus inside them goes
 *  back where the keyboard opened the menu from (a `[tabindex]` container in
 *  the article, `keyOpener`), else to the page. */
export function hideSelectionMenu(): void {
  shown = null;
  const back = keyOpener;
  keyOpener = null;
  const b = document.getElementById(SEL_BAR_ID);
  const m = document.getElementById(SEL_MENU_ID);
  const w = document.getElementById(SEL_WHO_ID);
  const active = document.activeElement as HTMLElement | null;
  const focusIn = !!active && (!!b?.contains(active) || !!m?.contains(active) || !!w?.contains(active));
  hideTip(true);
  if (w) w.style.display = "none";
  if (b) b.style.display = "none";
  if (m) m.style.display = "none";
  if (!focusIn) return;
  if (back?.isConnected) back.focus({ preventScroll: true });
  else active?.blur?.();
}

/** Does the mentions route answer this viewer on the page shown? (The key peek's gate.) */
export function selectionMenuMentionsOn(): boolean {
  return page.mentions;
}

/** Per page render: the reader payload's mentions flag, tracker projects, key
 *  kinds and who answers a Discuss turn (`discussWho`, Discuss v3 P1). */
export function setSelectionMenuPage(reader: { mentions?: unknown; trackerProjects?: unknown; keyKinds?: unknown; discussWho?: unknown } | null | undefined): void {
  page = {
    mentions: reader?.mentions === true,
    trackerProjects: Array.isArray(reader?.trackerProjects) ? (reader.trackerProjects as unknown[]).filter((p): p is string => typeof p === "string") : [],
    kinds: keyKindsFrom(reader?.keyKinds),
    who: reader && "discussWho" in reader ? selWhoFrom(reader.discussWho) : undefined,
  };
  // The page rendered again (navigation, a reload, an Apply's commit): what
  // the files and history say may have moved.
  clearMentionsCache();
  hideKeyPeek();
  if ((held || inlineCards.size) && !reattachQueued) {
    reattachQueued = true;
    // After the rest of the render: its enhancements must not run over the card.
    const run = () => {
      reattachQueued = false;
      reattachCard();
      sweepInlineCards();
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
/** The note on a card whose passage is not on the page as it was. */
export const MOVED_GONE = "The passage this answers is no longer on the page as it was.";
/** The note on a card whose passage is no text the page can be searched for
 *  (a diagram's labels, a control): the page rendered again, so its place is lost. */
export const MOVED_UNFINDABLE = "The page was drawn again, and the passage this answers is not text it can be searched for (a diagram or a control), so its place is not known.";

/** The held card, taken out by a render of its page: back under its passage,
 *  or at the article's top saying the passage is gone. Dropped on another
 *  page and after an Apply of its own turn (the Discuss tab shows that outcome). */
function reattachCard(): void {
  const h = held;
  if (!h || h.el.isConnected) return;
  if (!cardHeld(h.el)) {
    held = null;
    dropCard(h.el);
    return;
  }
  const key = h.el.getAttribute("data-sel-turn");
  if (key && discussTurnForCard(key)?.turn.edit?.state === "applied") {
    held = null;
    dropCard(h.el);
    return;
  }
  const wrap = document.getElementById("articleWrap");
  const a = article();
  // Not a page view (an Ask answer took the pane): kept for the page's next render.
  if (!wrap || !a) return;
  // Only a copy with its own surroundings still around it: a copy of the
  // words elsewhere, after the passage itself was rewritten, is not its place.
  const found = h.passage ? findSamePassage(wrap, h.passage) : null;
  h.el.querySelector(`.${MOVED_CLASS}`)?.remove();
  if (found) insertCard(h.el, found.range);
  else {
    const why = h.passage ? MOVED_GONE : MOVED_UNFINDABLE;
    h.el.querySelector(".wiki-sel-card-head")?.insertAdjacentHTML("afterend", `<div class="wiki-discuss-hint ${MOVED_CLASS}" role="status">${why}</div>`);
    cardAnchor.delete(h.el);
    a.insertBefore(h.el, a.firstChild);
    h.el.style.display = "";
  }
  if (key) paintTurnCard(h.el);
  h.el.scrollIntoView?.({ block: "nearest" });
}

function article(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#articleWrap .wiki-article");
}

/** The live selection as the menu reads it, or null when it offers nothing.
 *  Past the bar's 1,500 characters it is `long` (only the handoff, within its
 *  own bound, and Copy are offered). */
function readSelection(): { text: string; heading: string; range: Range; long: boolean } | null {
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
  const long = text.length > SEL_MAX_CHARS;
  if (text.length < SEL_MIN_CHARS || (long && (!discussHandoffMode() || text.length > HANDOFF_SELECTION_MAX))) return null;
  return { text, heading: nearestHeading(range), range: range.cloneRange(), long };
}

/** The actions this viewer sees. Under the read slice its CSS hides the
 *  egress actions (`wiki-read-slice.ts`): they are not offered at all, by the
 *  same selector, matched on each action's own bar button. */
function itemsFor(text: string, explainer: boolean, long = false): SelMenuItem[] {
  const a = article();
  const items = selMenuItems({
    text,
    explainer,
    mentions: page.mentions,
    follow: !explainer && discussAgentOn() && !!a && !!followHeading(a),
    keys: long ? [] : detectKeys(text, page.trackerProjects, page.kinds),
    // The handoff's own cheap check (its raw-text bounds, one article, no peek card).
    handoff: !explainer && mayBePassage(window.getSelection()) ? discussHandoffMode() : null,
    long,
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
  const items = itemsFor(s.text, false, s.long);
  if (!selMenuOffers(items)) return hideSelectionMenu();
  shown = { ...s, explainer: false, items };
  const m = document.getElementById(SEL_MENU_ID);
  if (m) m.style.display = "none";
  const w = document.getElementById(SEL_WHO_ID);
  if (w) w.style.display = "none";
  const b = bar();
  b.innerHTML = selBarHtml(shown.items);
  mountTip(b);
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
  mountTip(b);
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
  // The who box hides with the bar (it stays open: Escape still closes it).
  const who = document.getElementById(SEL_WHO_ID);
  if (who) who.style.visibility = inView ? "" : "hidden";
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
  placeWhoBox();
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
  const items = itemsFor(s.text, false, s.long);
  // Nothing but Copy: the browser's own menu, untouched.
  if (!selMenuOffers(items)) return;
  e.preventDefault();
  showMenu(s, items, e.clientX, e.clientY);
}

function showMenu(s: { text: string; heading: string; range: Range; long: boolean }, items: SelMenuItem[], x: number, y: number): HTMLElement {
  shown = { ...s, explainer: false, items };
  keyOpener = null;
  const b = document.getElementById(SEL_BAR_ID);
  if (b) b.style.display = "none";
  const whoEl = document.getElementById(SEL_WHO_ID);
  if (whoEl) whoEl.style.display = "none";
  const m = menu();
  // Explain's «Runs as» line and «Change…», as the bar's tooltip has them.
  const who = tipWho();
  if (who) retryDiscussWho();
  m.innerHTML = selMenuHtml(shown.items, s.text, who === undefined ? undefined : { who, runsAs: discussRunsAsHere() });
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
  const items = itemsFor(s.text, false, s.long);
  if (!selMenuOffers(items)) return false;
  const box = selectionBox(s.range);
  const from = document.activeElement;
  const m = showMenu(s, items, box?.left ?? 0, box ? box.bottom + 6 : 0);
  keyOpener = from instanceof HTMLElement && from !== document.body && !!document.getElementById("articleWrap")?.contains(from) ? from : null;
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
  // The menu's «Change…» is one of its items (the bar's is in Explain's tooltip, reached with Tab).
  const items = Array.from(box.querySelectorAll<HTMLElement>(box.id === SEL_MENU_ID ? "[data-selact], [data-selwho-open]" : "[data-selact]"));
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
      // No thread to take the turn (no wiki agent, an explainer, a wiki pinned
      // to a bot that is missing): the classic answer, still in a card.
      if (s.explainer || !discussAgentOn() || page.who === null) classicExplainCard(s, "");
      else threadCard("explain", s, EXPLAIN_QUESTION, "explore", (why) => classicExplainCard(s, why));
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
      // A detected key's chip opens its Trace (PR 6), not «Where else».
      if (key) openTrace(key, s.range);
      return;
    case "handoff":
      // The panel reads the live selection (the press kept it); closing it
      // puts the bar back for that selection with focus on this item.
      openDiscussHandoff(true, null, restoreHandoffItem);
      return;
  }
}

/** After the handoff panel closes with its passage put back: the bar for the
 *  selection again, focus on its handoff item (the control that opened it).
 *  A passage scrolled out of the pane meanwhile is brought back first, so the
 *  bar shows; with no bar to return to, focus goes to the article pane, never
 *  to <body> (the panel's focused box is hidden now). */
function restoreHandoffItem(): void {
  maybeShowSelectionBar();
  const b = document.getElementById(SEL_BAR_ID);
  if (shown?.range && b && b.style.display !== "none" && b.style.visibility === "hidden") {
    // The article pane scrolls (`readingArea`): the passage's first line a third down it.
    const box = selectionBox(shown.range);
    const wrap = document.getElementById("articleWrap");
    if (box && wrap) {
      const area = readingArea();
      wrap.scrollTop += box.top - area.top - (area.bottom - area.top) / 3;
    }
    placeBar();
  }
  const btn = document.getElementById(SEL_HANDOFF_BTN_ID);
  if (btn && selectionMenuOpen()) btn.focus({ preventScroll: true });
  if (btn && document.activeElement === btn) return;
  const wrap = document.getElementById("articleWrap");
  if (!wrap) return;
  if (!wrap.hasAttribute("tabindex")) wrap.setAttribute("tabindex", "-1");
  wrap.focus({ preventScroll: true });
}

/** An inline card at `range` (before an explainer's frame when null): the
 *  Trace view's place (`wiki-key-trace.ts`), the same as every other card's.
 *  Held like an Explain card, so a render of its page puts it back
 *  (fix round 1 K1); `onDrop` runs once when it leaves for good (closed,
 *  replaced, another page). */
export function placeInlineCard(range: Range | null, html: string, onDrop?: () => void): HTMLElement | null {
  const s: Shown = { text: "", heading: "", range, explainer: range === null, items: [] };
  const card = placeCard(s, html);
  if (!card) return null;
  if (onDrop) {
    dropHooks.set(card, onDrop);
    inlineCards.add(card);
  }
  holdCard(card, s);
  return card;
}

/** Inline cards with a drop hook, until dropped. A render that took one off
 *  the page and does not hold it (no passage: an explainer's) drops it, so
 *  its timers and reads end with it (class check C). */
const inlineCards = new Set<Element>();
function sweepInlineCards(): void {
  for (const card of Array.from(inlineCards)) if (!inlineCardLive(card)) dropCard(card);
}

/** Is `card` on the page, or out for a render of its page and coming back? */
export function inlineCardLive(card: Element): boolean {
  return card.isConnected || cardHeld(card);
}

/** What runs when a card leaves for good (`placeInlineCard`'s `onDrop`). */
const dropHooks = new WeakMap<Element, () => void>();
function dropCard(card: Element): void {
  const f = dropHooks.get(card);
  dropHooks.delete(card);
  inlineCards.delete(card);
  f?.();
}

/** Put a card under the selection's paragraph (before the frame on an
 *  explainer), replacing any card already open on the page. */
function placeCard(s: Shown, html: string): HTMLElement | null {
  for (const old of Array.from(document.querySelectorAll(`#articleWrap .${SEL_CARD_CLASS}`))) {
    old.remove();
    dropCard(old);
  }
  // A held card out for a render (not in the pane): replaced too.
  if (held) dropCard(held.el);
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
  // The text the card belongs to: shown exactly while it is (`syncCardVisibility`).
  const textEl = endNode ? (endNode.nodeType === 1 ? (endNode as Element) : endNode.parentElement) : null;
  let anchor: Element | null = textEl;
  if (range && a && endNode && a.contains(endNode)) {
    const at = inlineCardAnchor(range, a);
    at.parent.insertBefore(card, at.before);
  } else if (outside && wrap) {
    wrap.insertBefore(card, outside.nextSibling);
  } else {
    const frame = document.querySelector(".wiki-explainer-frame");
    anchor = range ? textEl : frame;
    if (frame?.parentNode) frame.parentNode.insertBefore(card, frame);
    else if (wrap) wrap.appendChild(card);
    else return false;
  }
  if (anchor) cardAnchor.set(card, anchor);
  else cardAnchor.delete(card);
  syncCardVisibility();
  return true;
}

/** Where each card's text is: the element holding its selection's end, or an
 *  explainer's frame. None for a card at the article's top. */
const cardAnchor = new WeakMap<Element, Element>();

/** A card is shown exactly while the text it belongs to is: graph mode hides
 *  an explainer's frame but not the card before it, Overview hides a fence or
 *  a head line the card sits beside, not in. Nothing changes where nothing is
 *  laid out (a DOM without layout, the article pane itself hidden). */
function syncCardVisibility(): void {
  const wrap = document.getElementById("articleWrap");
  if (!wrap || !hasBox(wrap)) return;
  for (const card of Array.from(wrap.querySelectorAll<HTMLElement>(`.${SEL_CARD_CLASS}`))) {
    const at = cardAnchor.get(card);
    const want = !at || (at.isConnected && hasBox(at)) ? "" : "none";
    if (card.style.display !== want) card.style.display = want;
  }
}

let visibilityQueued = false;
function queueVisibility(): void {
  if (visibilityQueued || !document.querySelector(`#articleWrap .${SEL_CARD_CLASS}`)) return;
  visibilityQueued = true;
  const run = () => {
    visibilityQueued = false;
    syncCardVisibility();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/** Keep an answer card for a render of its page (`reattachCard`): its
 *  passage and the text around it, read off the article pane in DOM order by
 *  the walk the re-attach searches with (`holdPassage`), whatever the
 *  selection's shape (a triple-click's element boundary, DecisionLog items
 *  shown newest first, the article head). */
function holdCard(card: HTMLElement, s: Shown, passage?: HeldPassage | null): void {
  const rel = deps?.relPath();
  const wrap = document.getElementById("articleWrap");
  if (!deps || !rel || !s.range) return;
  held = { el: card, wiki: deps.wiki(), relPath: rel, passage: passage !== undefined ? passage : wrap ? holdPassage(wrap, s.range) : null };
}

/** «Explain with context» or «Add to Oppfølging»: a turn of the page's thread.
 *  `fallback` runs instead of an error card, with the reason, when the
 *  selection is no passage or a turn of the discussion is still running. */
function threadCard(kind: CardKind, s: Shown, question: string, mode: "explore" | "edit", fallback?: (why: string) => void): void {
  const live = window.getSelection();
  const passage = live && s.range ? readSelectionPassage(live) : null;
  if (!passage) {
    if (fallback) return fallback("outside the page's text, so not in its discussion");
    placeCard(s, inlineCardHtml(kind, "", `<div class="wiki-discuss-error" role="alert">This selection cannot be sent as a passage of the page: select it again inside the page's text.</div>`, null));
    return;
  }
  const p = { selection: passage.selection, before: passage.before, after: passage.after, atStart: passage.atStart, atEnd: passage.atEnd, heading: passage.heading, ...(passage.edge ? { edge: passage.edge } : {}) };
  // Held before the POST (Discuss v3 P2, D12): the turn stores it, so the
  // card's place outlives the selection, and the card holds the same one.
  const wrap = document.getElementById("articleWrap");
  const heldPassage = wrap && s.range ? holdPassage(wrap, s.range) : null;
  const r = startInlineTurn(question, p, passage.range, mode, { held: heldPassage });
  if ("refused" in r && r.busy && fallback) return fallback(r.busyWhy ?? "the page's discussion is busy, so not in it");
  if ("refused" in r) {
    placeCard(s, inlineCardHtml(kind, "", `<div class="wiki-discuss-error" role="alert">${escText(r.refused)}</div>`, null));
    return;
  }
  // The head names the id the turn's POST carried (R6), set now when a read
  // has named it; else «…» (or a read's refusal) is reserved, filled once
  // from the card's own turn (`fillPendingWho`). Never «Runs as»: a POST
  // that carried no id runs as the engine's default user, which may have
  // moved since the read «Runs as» comes from.
  const sent = discussTurnForCard(r.key)?.turn.sentUser;
  const name = typeof sent === "string" ? discussUserNameHere(sent) : null;
  const runsAs = discussRunsAsHere();
  const card = placeCard(s, inlineCardHtml(kind, name ? inlineTurnSub(name) : runsAs.state === "refused" ? runsAs.text : inlineTurnSub("…"), "", r.key));
  if (!card) return;
  if (!name) card.setAttribute(WHO_PENDING_ATTR, "");
  holdCard(card, s, heldPassage);
  paintTurnCard(card);
}

/** A turn card placed while no read had named the user: its head's sub
 *  line is filled once, when a read names the user. */
const WHO_PENDING_ATTR = "data-sel-who-pending";

/** Explain where no thread takes the turn (no wiki agent, an explainer) or
 *  the page's thread cannot: the classic `/api/wiki/explain` stream, painted
 *  into an inline card (D3) rather than in place of the page. Not a turn of
 *  the discussion; `why` is its sub line (none without an agent). A
 *  card that leaves the page (replaced, closed, another page) aborts its
 *  stream; one a render of its page took out keeps it, for `reattachCard`. */
function classicExplainCard(s: Shown, why: string): void {
  const d = deps;
  if (!d) return;
  const card = placeCard(s, inlineCardHtml("explain", why, `<div class="wiki-discuss-status"><span class="spinner"></span><span>Searching the wiki…</span></div>`, null));
  const body = card?.querySelector(".wiki-sel-card-body");
  if (!card || !body) return;
  holdCard(card, s);
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
      if (!res.ok || !res.body) {
        // A refusal (400, a read-only or zone guard) names itself in `{ error }`.
        const err = (await res.json().catch(() => null)) as { error?: unknown } | null;
        return fail(typeof err?.error === "string" && err.error ? `The explanation failed: ${err.error} (${res.status}).` : `The explanation failed (${res.status}).`);
      }
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

/** A thread card's turn keys, oldest first (Discuss v3 P2: its first turn
 *  and each follow-up sent from it). */
function cardKeys(card: Element): string[] {
  return (card.getAttribute("data-sel-turns") ?? card.getAttribute("data-sel-turn") ?? "").split(" ").filter(Boolean);
}

/** Draw a turn card's body from its turn records, when its markup changed:
 *  each turn from {@link discussTurnForCard}, a follow-up under its question.
 *  One of them refused because the discussion was started over elsewhere
 *  closes the card with a note. Then its foot ({@link paintCardFoot}). */
function paintTurnCard(card: Element): void {
  const keys = cardKeys(card);
  const body = card.querySelector(".wiki-sel-card-body");
  if (!keys.length || !body) return;
  fillPendingWho(card);
  const found = keys.map((key) => ({ key, hit: discussTurnForCard(key) }));
  const closed = found.some((f) => f.hit?.turn.closedElsewhere);
  // The sub line is set once, when `threadCard` places the card (or filled
  // once by `fillPendingWho`): a repaint after a thread read named the user
  // moved the text below under the reader's drag (#913 CI).
  const html = closed
    ? `<div class="wiki-discuss-hint" role="status">${escText(CARD_CLOSED_ELSEWHERE)}</div>`
    : !found[0]!.hit
      ? `<div class="wiki-discuss-hint">This turn is no longer in the page's discussion.</div>`
      : found
          .map(({ key, hit }, i) => (hit ? cardTurnHtml(key, i === 0 ? null : hit.turn.question, discussTurnBodyParts(hit.turn, hit.current), hit.turn.state === "done" && !!hit.turn.text) : ""))
          .join("");
  if (drawnBody.get(body) !== html) {
    body.innerHTML = html;
    drawnBody.set(body, html);
  }
  paintCardFoot(card, found.map((f) => f.hit?.turn ?? null), closed);
}

/** A thread card's foot and head link: the follow-up box once its first turn
 *  has an id (the origin a follow-up names, D9), disabled while a turn of it
 *  runs; «⌘ Continue in Claude Code» for its newest answered turn once a
 *  follow-up of it ran (D4); «Open in chat ↗» once the thread is known. A closed card
 *  keeps none of them. Each is set only when it changed (a typed follow-up
 *  and focus survive the stream's repaints). */
function paintCardFoot(card: Element, turns: (DiscussTurnView | null)[], closed: boolean): void {
  if (closed !== card.hasAttribute("data-sel-closed")) card.toggleAttribute("data-sel-closed", closed);
  const first = turns[0] ?? null;
  const last = turns[turns.length - 1] ?? null;
  const live = turns.some((t) => !!t && turnLive(t));
  const form = card.querySelector<HTMLFormElement>("form.wiki-sel-follow");
  if (form) {
    const open = !closed && !!first?.turnId && !!first.passage && first.state !== "refused";
    if (form.hidden === open) form.hidden = !open;
    for (const el of Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"))) if (el.disabled !== live) el.disabled = live;
  }
  const cont = card.querySelector<HTMLElement>(".wiki-sel-card-cont");
  if (cont) {
    // Its answered turns (a refused follow-up stays in the card's keys but
    // never ran): Continue needs the first and a follow-up, for the newest
    // answered one; hidden while the newest turn still runs.
    const keys = cardKeys(card);
    const answered = turns.flatMap((t, i) => (t?.turnId && !turnLive(t) && t.state !== "refused" ? [{ key: keys[i] ?? "", t }] : []));
    const target = answered.at(-1);
    const show = !closed && answered.length >= 2 && !!target && !(last && turnLive(last));
    const html = show ? cardContinueHtml(target!.key, target!.t.handover) : "";
    if (cont.dataset.drawn !== html) {
      cont.innerHTML = html;
      cont.dataset.drawn = html;
    }
  }
  const chat = card.querySelector<HTMLAnchorElement>("[data-sel-card-chat]");
  if (chat) {
    const href = closed ? null : discussPopOutHrefHere();
    if (chat.hidden !== !href) chat.hidden = !href;
    if (href && chat.getAttribute("href") !== href) chat.setAttribute("href", href);
  }
}

/** The follow-up box's send (Discuss v3 P2): an Explore turn of the page's
 *  thread naming the card's first turn as its origin (D9), about the passage
 *  that turn stored, so it works after the selection is gone. The posted user
 *  follows R2 like every send; the card's head keeps the name it was filled
 *  with (R6). A refusal before the request shows under the box. */
function sendFollowUp(card: HTMLElement): void {
  const input = card.querySelector<HTMLInputElement>("[data-sel-followup-input]");
  const msg = card.querySelector<HTMLElement>(".wiki-sel-follow-msg");
  const keys = cardKeys(card);
  const first = keys[0] ? (discussTurnForCard(keys[0])?.turn ?? null) : null;
  const q = input?.value.trim() ?? "";
  if (!input || !q || !first?.turnId || !first.passage || discussSendBlocked()) return;
  const r = startInlineTurn(q.slice(0, HANDOFF_QUESTION_MAX), first.passage, null, "explore", { originTurnId: first.turnId });
  if ("refused" in r) {
    if (msg) msg.textContent = r.refused;
    return;
  }
  if (msg) msg.textContent = "";
  input.value = "";
  card.setAttribute("data-sel-turns", [...keys, r.key].join(" "));
  paintTurnCard(card);
}

/** Fill a pending card's sub line once, from its own turn (the head is one
 *  `nowrap` line, so nothing below it moves), never again after (R6): the id
 *  its POST carried, else the user its `turn` frame says it ran as, once a
 *  read knows that user's name. Never «Runs as»: a read that lands while the
 *  POST is in flight may name a default user who moved after the engine took
 *  the turn (fix round 3). Never a later turn's user: a pick after the turn
 *  (R3) names another. A turn the route refused never ran: «not sent». A
 *  turn that ended, or left the discussion (a pick, Start over), before its
 *  user was named: the nameless line. While the turn is live with no user
 *  named, a read's refusal shows its text and the card stays pending. */
function fillPendingWho(card: Element): void {
  if (!card.hasAttribute(WHO_PENDING_ATTR)) return;
  const key = card.getAttribute("data-sel-turn");
  const turn = key ? (discussTurnForCard(key)?.turn ?? null) : null;
  const id = typeof turn?.sentUser === "string" ? turn.sentUser : (turn?.userId ?? null);
  let text: string;
  if (turn?.state === "refused") text = TURN_NOT_SENT;
  else if (id) {
    const name = discussUserNameHere(id);
    if (!name) return;
    text = inlineTurnSub(name);
  } else if (!turn || (turn.state !== "sending" && turn.state !== "running")) text = inlineTurnSub(null);
  else {
    // Still sending or running, its POST carried no id and its `turn` frame
    // has not named the user yet: wait for it, «…» reserved (a read's
    // refusal meanwhile in its place, gone again once a read answers).
    const runsAs = discussRunsAsHere();
    setCardSub(card, runsAs.state === "refused" ? runsAs.text : inlineTurnSub("…"));
    return;
  }
  card.removeAttribute(WHO_PENDING_ATTR);
  setCardSub(card, text);
}

/** A refused turn card's sub line: the turn never ran as anyone. */
const TURN_NOT_SENT = "not sent";

function setCardSub(card: Element, sub: string): void {
  const el = card.querySelector(".wiki-sel-card-sub");
  const text = `· ${sub}`;
  if (el && el.textContent !== text) el.textContent = text;
}

function paintTurnCards(): void {
  for (const card of Array.from(document.querySelectorAll(`#articleWrap .${SEL_CARD_CLASS}[data-sel-turn]`))) paintTurnCard(card);
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

/** What Enter already means something on: links, controls, widgets. A bare
 *  `[tabindex]` is none: the reader gives one to a `<Question>` card, a
 *  scrolling diagram box and a jumped-to heading, and none of them takes Enter. */
const ENTER_OWNERS =
  "a[href], area[href], button, input, select, textarea, summary, label, iframe, [contenteditable]:not([contenteditable='false']), " +
  "[role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [role=checkbox], [role=radio], " +
  "[role=switch], [role=treeitem], [role=combobox], [role=textbox], [role=searchbox], [role=slider], [role=spinbutton]";

/** A focusable element with key handling of its own, as far as the DOM shows it
 *  (an inline handler; an `addEventListener` one is invisible). */
function ownsKeys(el: Element): boolean {
  if (!el.hasAttribute("tabindex")) return false;
  const h = el as HTMLElement;
  return ["onkeydown", "onkeyup", "onkeypress"].some((k) => el.hasAttribute(k)) || !!(h.onkeydown || h.onkeyup || h.onkeypress);
}

/** Is Enter the bar's? Only with focus on the page itself or in the
 *  article's own text (a plain `[tabindex]` container counts): never on a
 *  control, and never outside the article (the rail, the breadcrumb, the panes). */
function enterIsOurs(t: EventTarget | null): boolean {
  const el = t as Element | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  const wrap = document.getElementById("articleWrap");
  if (!wrap || typeof el.closest !== "function" || !wrap.contains(el)) return false;
  for (let n: Element | null = el; n && n !== wrap; n = n.parentElement) if (n.matches(ENTER_OWNERS) || ownsKeys(n)) return false;
  return true;
}

/** Does a scroll of `t` move what the bar or menu is shown for? The document's,
 *  or a scroller holding any part of the selection (`#articleWrap`, a code
 *  block or a results table it starts, ends or runs through: the bar sits at
 *  its end, the menu near its start) or the explainer's frame; not the panes,
 *  nor a scroller beside the selection. */
function scrollMovesSelection(t: EventTarget | null): boolean {
  if (!shown) return false;
  if (!(t instanceof Node) || t === document || t === document.documentElement || t === document.body) return true;
  if (shown.range) return shown.range.intersectsNode(t);
  const frame = document.querySelector(".wiki-explainer-frame");
  return !!frame && t.contains(frame);
}

/** The input behind the last press or key: a selection that settles after a
 *  touch (or pen) press shows the bar (`queueTouchSettle`). */
let lastInput: "mouse" | "touch" | "key" | null = null;
/** A touch selection is settled when it has not changed for this long (a
 *  long-press, then its handles dragged). */
export const TOUCH_SETTLE_MS = 350;
let touchTimer: ReturnType<typeof setTimeout> | null = null;
/** The touch selection the last settle evaluated, by its ends and text:
 *  evaluated once until the selection itself changes. Reading a selection
 *  can set it and restore it (a DecisionLog's authored text,
 *  `authoredSelectionText`), which fires `selectionchange` again with the
 *  same selection; without this each settle queued the next, forever, when
 *  the bar was refused (2 characters). Cleared when the selection collapses. */
let settledSel: { a: Node | null; ao: number; f: Node | null; fo: number; text: string } | null = null;

function sameSettled(sel: Selection): boolean {
  const s = settledSel;
  return !!s && s.a === sel.anchorNode && s.ao === sel.anchorOffset && s.f === sel.focusNode && s.fo === sel.focusOffset && s.text === sel.toString();
}

function queueTouchSettle(): void {
  if (touchTimer) clearTimeout(touchTimer);
  touchTimer = setTimeout(() => {
    touchTimer = null;
    if (lastInput !== "touch") return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      settledSel = null;
      return;
    }
    if (sameSettled(sel)) return;
    // Already shown for this very selection (the bar, or the menu a long-press opened).
    const r = sel.getRangeAt(0);
    let same = false;
    try {
      same = !!shown?.range && shown.range.compareBoundaryPoints(Range.START_TO_START, r) === 0 && shown.range.compareBoundaryPoints(Range.END_TO_END, r) === 0;
    } catch {
      /* the shown range's nodes left the document: not the same selection */
    }
    settledSel = { a: sel.anchorNode, ao: sel.anchorOffset, f: sel.focusNode, fo: sel.focusOffset, text: sel.toString() };
    if (same && selectionMenuOpen()) return;
    maybeShowSelectionBar();
  }, TOUCH_SETTLE_MS);
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
  // Which input made the selection: a touch long-press ends with no mouseup
  // (iOS/iPadOS), so a selection that settles after a touch press shows the
  // bar; the keyboard's Shift+arrow steps never do (its way in is ⇧F10).
  document.addEventListener("pointerdown", (e) => void (lastInput = (e as PointerEvent).pointerType === "mouse" ? "mouse" : "touch"), true);
  document.addEventListener("keydown", () => void (lastInput = "key"), true);
  // Dismiss on selection collapse and Escape.
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if ((!sel || sel.isCollapsed) && shown && !shown.explainer) hideSelectionMenu();
    if (!sel || sel.isCollapsed) settledSel = null;
    if (lastInput === "touch") queueTouchSettle();
  });
  document.addEventListener("keydown", (e) => {
    // The keyboard's context-menu gesture: our menu for a selection that offers it.
    const gesture = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
    // Taken where Enter is (focus on the page or in the article's own text):
    // on a link or a control it is that element's menu.
    if (gesture && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented) {
      if (enterIsOurs(e.target) && openMenuFromKeyboard()) e.preventDefault();
      return;
    }
    // The who box first, open whether or not the bar shows (it hides with a
    // bar whose selection is scrolled away).
    if (e.key === "Escape" && whoBoxOpen()) return closeWhoBox();
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
    // The bar, the menu, Explain's tooltip (inside the bar) and the who box
    // keep the selection; their own controls act on `click`.
    if (t.closest?.(`#${SEL_BAR_ID}, #${SEL_MENU_ID}, #${SEL_WHO_ID}`)) {
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
    const whoOpen = t.closest?.<HTMLElement>("[data-selwho-open]");
    if (whoOpen) {
      e.preventDefault();
      openWhoBox(whoOpen);
      return;
    }
    if (t.closest?.("[data-selwho-close]")) {
      closeWhoBox();
      return;
    }
    const whoUser = t.closest?.<HTMLElement>("[data-selwho-user]");
    if (whoUser) {
      pickWho(whoUser.dataset.selwhoUser ?? "");
      return;
    }
    const close = t.closest?.(`.${SEL_CARD_CLASS} [data-sel-card-close]`);
    if (close) {
      const card = close.closest(`.${SEL_CARD_CLASS}`);
      if (card && held?.el === card) held = null;
      card?.remove();
      if (card) dropCard(card);
      return;
    }
    const collapse = t.closest?.<HTMLElement>(`.${SEL_CARD_CLASS} [data-sel-card-collapse]`);
    if (collapse) {
      const card = collapse.closest(`.${SEL_CARD_CLASS}`);
      const fold = !card?.hasAttribute("data-sel-collapsed");
      card?.toggleAttribute("data-sel-collapsed", fold);
      collapse.setAttribute("aria-expanded", String(!fold));
      collapse.textContent = fold ? "▸" : "▾";
      collapse.title = fold ? "Expand this card" : "Collapse this card";
      return;
    }
    const copy = t.closest?.<HTMLElement>(`.${SEL_CARD_CLASS} [data-sel-copy-answer]`);
    if (copy) {
      const turn = discussTurnForCard(copy.dataset.selCopyAnswer ?? "")?.turn;
      const note = copy.parentElement?.querySelector(".wiki-sel-copy-note");
      if (turn?.text) void copyText(turn.text).then((ok) => note && (note.textContent = ok ? "Copied." : "Copy failed."));
    }
  });
  // A card's follow-up box: Enter or Send (Discuss v3 P2).
  document.addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement | null)?.closest?.<HTMLFormElement>(`.${SEL_CARD_CLASS} form.wiki-sel-follow`);
    if (!form) return;
    e.preventDefault();
    const card = form.closest<HTMLElement>(`.${SEL_CARD_CLASS}`);
    if (card) sendFollowUp(card);
  });
  // The bar is placed in the viewport: it follows the selection when the page
  // scrolls or resizes. The menu closes on a scroll that moves the selection,
  // as the browser's own does; the Discuss pane following its stream does not.
  document.addEventListener(
    "scroll",
    (e) => {
      if (!scrollMovesSelection(e.target)) return;
      // (The menu itself never scrolls: it has no overflow.)
      const m = document.getElementById(SEL_MENU_ID);
      if (m && m.style.display !== "none") return hideSelectionMenu();
      queueReposition();
    },
    true,
  );
  window.addEventListener("resize", queueReposition);
  onDiscussChange(paintTurnCards);
  // The «Runs as» line follows the reads and picks while the tooltip or box shows.
  onDiscussChange(() => {
    if (document.getElementById(SEL_TIP_ID)?.style.display === "block") refreshTip();
    const menuWho = document.querySelector<HTMLElement>(`#${SEL_MENU_WHO_ID} [data-seltip-who]`);
    const who = tipWho();
    if (menuWho && who !== undefined) {
      const html = selRunsAsHtml(who, discussRunsAsHere());
      if (menuWho.innerHTML !== html) menuWho.innerHTML = html;
    }
    if (whoBoxOpen()) paintWhoBox();
  });
  // Explain's tooltip: on hover or focus, kept while the pointer or focus is
  // in it, hidden a moment after both leave.
  document.addEventListener("mouseover", (e) => {
    const t = e.target as Element | null;
    if (t?.closest?.(`#${SEL_TIP_ID}, #${SEL_BAR_ID} #wikiExplainBtn`)) showTip();
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target as Element | null;
    const to = (e as MouseEvent).relatedTarget as Element | null;
    if (!t?.closest?.(`#${SEL_TIP_ID}, #${SEL_BAR_ID} #wikiExplainBtn`)) return;
    if (to?.closest?.(`#${SEL_TIP_ID}, #${SEL_BAR_ID} #wikiExplainBtn`)) return;
    hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target as Element | null;
    if (t?.closest?.(`#${SEL_TIP_ID}, #${SEL_BAR_ID} #wikiExplainBtn`)) showTip();
    else if (document.getElementById(SEL_TIP_ID)?.style.display === "block") hideTip(true);
  });
  // A card follows its text's visibility: graph mode, a lens, a fold or a
  // DecisionLog «Vis alle» each change a class or attribute in the pane.
  const wrapEl = document.getElementById("articleWrap");
  if (wrapEl && typeof MutationObserver === "function") {
    new MutationObserver(queueVisibility).observe(wrapEl, { attributes: true, subtree: true, attributeFilter: ["class", "hidden", "open", "style"] });
  }
}
