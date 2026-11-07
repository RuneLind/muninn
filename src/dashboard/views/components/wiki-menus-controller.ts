/// <reference lib="dom" />
/**
 * The /wiki reader's ⋯ menus (work thread grouping PR 4): the one work popover
 * `#wikiWorkPop` behind a card's ⋯ and a focus row's ⋯, its boundary items
 * (Make own thread, Return, Keep separate, Allow grouping) and Save as series;
 * plus the focus rule both body-level popovers close by. Moved out of the shell
 * (`wiki-browser.ts`) whole, in source order (mimir plan
 * muninn-wiki-browser-split, C3). The series editor's popover stays in the
 * shell; it imports {@link closeWorkPop}'s focus rule and the boundary items
 * from here.
 *
 * Importing this module runs nothing. The shell's `boot()` calls
 * {@link initMenus} beside `initRail` and {@link registerMenus} where the work
 * popover's listeners stood. This module never imports the shell: what it reads
 * and calls there arrives through {@link MenusDeps}.
 */
import { normalizeRel } from "./wiki-nav.ts";
import { displayTitleOf, type WikiListing } from "./wiki-filter.ts";
import { isRailGroupCard, normalizeFoldKey, type RailGroupCard, type RailThreadCard, type RailWorkCard } from "./wiki-recents.ts";
import { rowBoundaryAction } from "./wiki-work-boundaries.ts";
import { readSeriesBasesAfterWrites, SERIES_REQUEST_TIMEOUT_MS, SERIES_STALLED_COPY, trackSeriesWrite, writeSeriesUnlessOpenChanged, type OpenPageAtLoad, type SeriesPoster } from "./wiki-series-write.ts";
import { checkNewSeriesKey, recheckSaveAsSeries } from "./wiki-work-series.ts";
import {
  groupCardMenuHtml,
  saveSeriesConfirmHtml,
  threadCardMenuHtml,
  threadRowMenuHtml,
  WORK_GROUP_FULL_TEXT,
  WORK_POP_ID,
} from "./wiki-thread-view.ts";
import { SERIES_MENU_ID } from "./wiki-series-menu.ts";
import { workGroupAddRefused, type WorkGroupEdit } from "./wiki-work-group-record.ts";
import type { ReceiveOutcome } from "./wiki-refresh.ts";
import type { WorkFacts } from "./wiki-shell-state.ts";
import {
  editWorkGroup,
  focusWorkMenuButton,
  getWorkBounds,
  getWorkCardsDrawn,
  getWorkGroupRec,
  railControlSelector,
  renderList,
  toggleRailFold,
} from "./wiki-rail-controller.ts";

/** What the ⋯ menus read and call on the shell, read live. */
export interface MenusDeps {
  WIKI(): string;
  allPages(): WikiListing[];
  /** The work threads off the last listing (the row ⋯'s boundary item). */
  workFacts(): WorkFacts;
  /** The open series menu's opener, or null: a boundary item clicked in it
   *  returns focus there by its key. */
  seriesMenuOpener(): HTMLElement | null;
  /** The series POST, set once in `boot()`. */
  postSeriesWrite(): SeriesPoster;
  withWiki(url: string): string;
  closeSeriesMenu(cause: PopCloseCause): void;
  /** The series editor's CAS base reader, shared with Save as series. */
  seriesBaseHash(relPath: string): Promise<string | null>;
  openPageAtLoad(): OpenPageAtLoad;
  adoptOwnSeriesHashes(hashes: ReadonlyMap<string, string>): void;
  refreshAfterSeriesWrite(): Promise<ReceiveOutcome | "error">;
}

/** Set once, by {@link initMenus}, before anything here runs. */
let deps!: MenusDeps;

// ── Where focus goes when a body-level popover closes ─────────────────
//
// Both popovers — `#wikiSeriesMenu` (every series menu, a thread row's page
// menu included) and `#wikiWorkPop` (a card's or a read-only row's ⋯) — close
// through ONE function each, `closeSeriesMenu(cause)` / `closeWorkPop(cause)`,
// and the cause alone decides focus (`popCloseReturnsFocus`):
//
//   cause     when                                         focus
//   key       Escape; Tab (work popover)                   the opener (*)
//   toggle    its own opener clicked or pressed again      the opener (*)
//   done      Cancel; a series write that closed the menu  the opener (*) if focus
//                                                          was in the popover or on <body>
//   edit      a boundary item (Make own thread, Return,    none here: applyBoundaryEdit's
//             Keep separate, Allow grouping)               per-edit table
//   replace   another popover opening                      none: the new one takes it
//   outside   a click anywhere else                        none: where the click put it
//   viewport  a scroll that moves the opener; a resize     none, unless focus was IN the
//                                                          popover: then the opener (*)
//
// (*) the opener node while connected; after a repaint, its replacement by
// key (`openerSel`); then the card holding the page; then the Group button.
// A repaint while a popover is open closes nothing: the popover is
// body-level and keeps its own focus.

/** Why a ⋯ popover closes — the one input to where focus goes. */
export type PopCloseCause = "key" | "toggle" | "done" | "edit" | "replace" | "outside" | "viewport";

/** Whether `cause` returns focus to the opener, judged BEFORE `el` is removed
 *  (removing a node that holds focus drops it to `<body>`). */
export function popCloseReturnsFocus(cause: PopCloseCause, el: HTMLElement | null): boolean {
  const a = document.activeElement;
  const inside = !!el && !!a && el.contains(a);
  if (cause === "key" || cause === "toggle") return true;
  if (cause === "done") return inside || !a || a === document.body;
  if (cause === "viewport") return inside;
  return false;
}

/** Focus a closed popover's opener: the node, its replacement by key, the
 *  card holding `page`, the Group button. */
export function focusPopOpener(opener: HTMLElement | null, openerSel: string | null, page: string): void {
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  else focusFirstRailControl([openerSel, workCardControlSel(page, "menu")]);
}

// ── PR 4: the ⋯ menus — boundaries and Save as series ─────────────────────
// (plan `muninn-wiki-work-thread-grouping`, D5, D8, D14). One popover at a
// time, `#wikiWorkPop`, painted like the series editor's and closed by the
// same events. A boundary edit goes through the record's state table like a
// Group menu edit (D17); Save as series is the only action that writes the
// wiki, and on a read-only wiki its item is absent.

/** The open work popover: what opened it, and for Save as series, the plan. */
interface WorkPopState {
  opener: HTMLElement;
  /** The opener as a rail selector by its key, taken at open time: a repaint
   *  while the popover is open detaches the opener node itself. */
  openerSel: string | null;
  /** A page of the thread the popover acts on: where focus goes when the
   *  opener is gone from the rail. */
  page: string;
  key: string;
  /** The opener's viewport position when the popover was placed: a scroll
   *  that leaves it there is not one the reader made (see the scroll handler). */
  at: { top: number; left: number };
  /** Save as series' confirm view: `busy` while its write runs, `done` once
   *  it has reported a spent plan (Write stays off until the popover reopens). */
  series?: { card: RailGroupCard; busy: boolean; done?: boolean };
}
let workPop: WorkPopState | null = null;

function workPopEl(): HTMLElement | null {
  return document.getElementById(WORK_POP_ID);
}

/** A Save as series write is in flight: the popover holds its report. */
export function workPopBusy(): boolean {
  return !!workPop?.series?.busy;
}

/** Close the work popover; focus per the table at `PopCloseCause`. Refused
 *  while a Save as series write is in flight (its report lands in this
 *  popover). */
function closeWorkPop(cause: PopCloseCause): void {
  if (workPopBusy()) return;
  const was = workPop;
  const el = workPopEl();
  const refocus = popCloseReturnsFocus(cause, el);
  el?.remove();
  workPop = null;
  if (!was) return;
  was.opener.setAttribute("aria-expanded", "false");
  if (refocus) focusPopOpener(was.opener, was.openerSel, was.page);
}

/** Focus the first selector that finds a rail control, else the Group button.
 *  A wiki with no work threads has no Group button, and focus then stays on
 *  `<body>`. */
function focusFirstRailControl(selectors: readonly (string | null | undefined)[]): void {
  for (const sel of selectors) {
    const el = sel ? document.querySelector<HTMLElement>(sel) : null;
    if (el) {
      el.focus({ preventScroll: true });
      return;
    }
  }
  focusWorkMenuButton();
}

/** The drawn work card holding `page` as a selector for its ⋯ (`menu`) or its
 *  fold: a child card when it is drawn, else the group around it. */
function workCardControlSel(page: string | undefined, prefer: "menu" | "fold"): string | null {
  if (!page) return null;
  const k = normalizeRel(page);
  const holds = (c: RailThreadCard) => normalizeRel(c.key) === k || c.focus.some((p) => normalizeRel(p.relPath) === k);
  const sel = (attr: string, fk: string) => {
    const at = `#wikiList .wiki-thread-card[${attr}="${CSS.escape(fk)}"] > `;
    const menu = `#wikiList [data-work-card-menu="${CSS.escape(fk)}"]`;
    const fold = `${at}.wiki-thread-fold`;
    return prefer === "menu" ? (document.querySelector(menu) ? menu : fold) : fold;
  };
  for (const c of getWorkCardsDrawn()) {
    if (!isRailGroupCard(c)) {
      if (holds(c)) return sel("data-thread", c.foldKey);
      continue;
    }
    const child = c.children.find(holds);
    if (!child && normalizeRel(c.key) !== k) continue;
    if (child && document.querySelector(`#wikiList .wiki-thread-card[data-thread="${CSS.escape(child.foldKey)}"]`)) return sel("data-thread", child.foldKey);
    return sel("data-thread-group", c.foldKey);
  }
  return null;
}

/** Paint the popover under `anchor` with `html`, focus its first item.
 *  Refused while a Save as series write runs: the one guard for every ⋯. */
function openWorkPop(anchor: HTMLElement, key: string, html: string, label: string, page: string): HTMLElement | null {
  if (workPopBusy()) return null;
  closeWorkPop("replace");
  deps.closeSeriesMenu("replace");
  const el = document.createElement("div");
  el.id = WORK_POP_ID;
  el.className = "wiki-series-menu wiki-work-pop";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth || 260;
  const height = el.offsetHeight || 120;
  el.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`;
  const below = rect.bottom + 6;
  el.style.top = `${Math.round(below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below)}px`;
  anchor.setAttribute("aria-expanded", "true");
  workPop = { opener: anchor, openerSel: railControlSelector(anchor), page, key, at: { top: rect.top, left: rect.left } };
  el.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  return el;
}

/** The drawn card whose fold key is `foldKey` (a child included). */
function drawnWorkCard(foldKey: string): RailWorkCard | undefined {
  const k = normalizeFoldKey(foldKey);
  for (const c of getWorkCardsDrawn()) {
    if (normalizeFoldKey(c.foldKey) === k) return c;
    if (isRailGroupCard(c)) for (const ch of c.children) if (normalizeFoldKey(ch.foldKey) === k) return ch;
  }
  return undefined;
}

/** A Make own thread definition's stable id: random, never the path. */
function newSplitId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return "s" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 15);
}

/** Apply one boundary edit from a ⋯ item and repaint. Focus goes to the
 *  control `focus` names first — a selector, or `{ page, prefer }` for the
 *  drawn card holding that page — then to the opener by its key (taken
 *  BEFORE the render detaches it), then to the Group button. */
function applyBoundaryEdit(edit: WorkGroupEdit, focus: { page: string; prefer: "menu" | "fold"; first?: "card" | "opener"; sel?: string }): void {
  const openerSel = workPop?.openerSel ?? railControlSelector(deps.seriesMenuOpener());
  closeWorkPop("edit");
  deps.closeSeriesMenu("edit");
  editWorkGroup(edit);
  // Another tab filled the list after this menu opened: say so, not nothing.
  // An edit that lands clears the note.
  const full = workGroupAddRefused(getWorkGroupRec().held, edit);
  showWorkBoundaryStatus(full ? `${"split" in edit ? "Make own thread" : "Keep separate"} did nothing: ${WORK_GROUP_FULL_TEXT[full]}` : null);
  renderList();
  const card = workCardControlSel(focus.page, focus.prefer);
  focusFirstRailControl(focus.first === "opener" ? [focus.sel, openerSel, card] : [focus.sel, card, openerSel]);
}

/** A ⋯ item click inside either popover (the work popover, or the series
 *  editor holding a thread row's boundary item). Answers whether it was one. */
export function boundaryItemClick(target: HTMLElement): boolean {
  const item = target.closest<HTMLElement>("[data-thread-split], [data-work-return], [data-work-keep], [data-work-allow]");
  if (!item) return false;
  if (item.getAttribute("aria-disabled") === "true") return true;
  const split = item.getAttribute("data-thread-split");
  if (split) {
    // The split card's fold; the card holding the page when it is not drawn.
    const fold = `#wikiList .wiki-thread-card[data-thread="${CSS.escape(normalizeFoldKey(`thread:${split}`))}"] > .wiki-thread-fold`;
    applyBoundaryEdit({ split: { id: newSplitId(), page: split } }, { sel: fold, page: split, prefer: "fold", first: "opener" });
    return true;
  }
  const ret = item.getAttribute("data-work-return");
  if (ret) {
    // The card that took the page back: its fold.
    const page = item.getAttribute("data-work-return-page") ?? "";
    applyBoundaryEdit({ unsplit: { id: ret, page } }, { page, prefer: "fold" });
    return true;
  }
  const keep = item.getAttribute("data-work-keep");
  if (keep) {
    applyBoundaryEdit({ keepApart: keep }, { page: keep, prefer: "menu", first: "opener" });
    return true;
  }
  const allow = item.getAttribute("data-work-allow");
  if (allow) {
    let anchors: string[] = [];
    try {
      const v = JSON.parse(allow) as unknown;
      if (Array.isArray(v)) anchors = v.filter((x): x is string => typeof x === "string");
    } catch {
      /* a malformed attribute: nothing to remove */
    }
    // The anchors this tab drew on the thread, and only those: an anchor
    // another tab added (or moved) since this tab last read stays.
    applyBoundaryEdit({ allowGrouping: anchors }, { page: anchors[0] ?? "", prefer: "menu", first: "opener" });
    return true;
  }
  return false;
}

/** The row ⋯'s boundary item for `rel`, from the boundaries on screen. */
export function rowMenuItemHtml(rel: string): string {
  const action = getWorkBounds() ? rowBoundaryAction(getWorkBounds()!, deps.workFacts(), rel) : null;
  return action ? threadRowMenuHtml(rel, action) : "";
}

/** Save as series' message line, in the confirm view of `state`'s popover.
 *  When that popover is gone, the line goes to a status note on the page, so
 *  a write's report is never painted into nothing. */
function setWorkSeriesMsg(state: WorkPopState, text: string, bad: boolean): void {
  const msg = workPop === state ? workPopEl()?.querySelector<HTMLElement>(".wiki-work-series-msg") : null;
  if (!msg) {
    showWorkSeriesStatus(text, bad);
    return;
  }
  msg.textContent = text;
  msg.classList.toggle("bad", bad);
}

/** The fallback for a report whose popover is gone: one status note, fixed at
 *  the foot of the page, dismissed by a click on it. */
function showWorkSeriesStatus(text: string, bad: boolean): void {
  let el = document.getElementById("wikiWorkSeriesStatus");
  if (!el) {
    el = document.createElement("div");
    el.id = "wikiWorkSeriesStatus";
    el.className = "wiki-series-menu wiki-work-series-status";
    el.setAttribute("role", "status");
    el.title = "Click to dismiss";
    el.addEventListener("click", () => el!.remove());
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("bad", bad);
}

/** A boundary click that did nothing says why in its own note (never Save as
 *  series' report line), above that one; `null` clears it. */
export function showWorkBoundaryStatus(text: string | null): void {
  let el = document.getElementById("wikiWorkBoundaryStatus");
  if (text === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "wikiWorkBoundaryStatus";
    el.className = "wiki-series-menu wiki-work-series-status wiki-work-boundary-status bad";
    el.setAttribute("role", "status");
    el.title = "Click to dismiss";
    el.addEventListener("click", () => el!.remove());
    document.body.appendChild(el);
  }
  el.textContent = text;
}

/** Lock or unlock the confirm view's buttons and key while a write runs. */
function setWorkSeriesLocked(state: WorkPopState, locked: boolean, goToo = locked): void {
  if (workPop !== state) return;
  const el = workPopEl();
  if (!el) return;
  for (const b of Array.from(el.querySelectorAll<HTMLButtonElement | HTMLInputElement>("[data-work-series-cancel], [data-work-series-key]"))) b.disabled = locked;
  const go = el.querySelector<HTMLButtonElement>("[data-work-series-go]");
  if (go) go.disabled = goToo;
}

/** The listing as the server has it NOW (`?refresh=1` rescans), read without
 *  applying it; `null` when it cannot be read, or not within
 *  `SERIES_REQUEST_TIMEOUT_MS` (Save as series holds its popover meanwhile). */
async function freshListing(): Promise<WikiListing[] | null> {
  try {
    const res = await fetch(deps.withWiki("/api/wiki/pages?refresh=1"), { signal: AbortSignal.timeout(SERIES_REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { pages?: unknown };
    return Array.isArray(data.pages) ? (data.pages as WikiListing[]) : null;
  } catch {
    return null;
  }
}

/**
 * Save as series, confirmed (D14): every page's CAS base first, then the plan
 * re-checked against a listing read after them (`recheckSaveAsSeries`: a page
 * another writer put into a series since the click is left alone), then one
 * write per page through the series editor's loop, stopping at the first
 * failure. Either ending refreshes the listing, so the group forms from the
 * series on disk rather than from local state; a failure reports `k of N
 * written` with the pages left, and written pages stay written. While the
 * write runs the popover cannot be dismissed, so the report has a place to
 * land. After a landed write the old group's open state moves onto the fold
 * key of the group that now holds its anchor thread.
 */
async function runSaveAsSeries(): Promise<void> {
  const state = workPop;
  const st = state?.series;
  if (!state || !st || st.busy || st.done) return;
  const card = st.card;
  const plan = card.series;
  if (!plan?.available) return;
  let key = plan.key;
  if (plan.mode === "coin") {
    const typed = workPopEl()?.querySelector<HTMLInputElement>("[data-work-series-key]")?.value ?? "";
    const checked = checkNewSeriesKey(plan, typed);
    if ("error" in checked) {
      setWorkSeriesMsg(state, checked.error, true);
      return;
    }
    key = checked.key;
  }
  st.busy = true;
  setWorkSeriesLocked(state, true);
  // Set ⇒ the confirm view stays open with this line. `retry` ⇒ nothing was
  // written and the reader can resolve it in place (another key, another
  // try), so Write stays on; otherwise the plan is spent and Write stays off.
  let report: { text: string; bad: boolean; retry?: boolean } | null = null;
  const wasOpen = card.open;
  const anchorKey = card.key;
  try {
    const planned = plan.writes.map((w) => w.relPath);
    setWorkSeriesMsg(state, `Reading ${planned.length} ${planned.length === 1 ? "page" : "pages"}…`, false);
    const { bases, missing, open, stalled } = await readSeriesBasesAfterWrites(planned, deps.seriesBaseHash, deps.openPageAtLoad);
    if (stalled) {
      // Nothing read and nothing written; Write stays on for another try.
      report = { text: SERIES_STALLED_COPY, bad: true, retry: true };
      return;
    }
    const fresh = await freshListing();
    if (!fresh) {
      report = { text: "Could not re-read the wiki listing — nothing written", bad: true, retry: true };
      return;
    }
    const checked = recheckSaveAsSeries(plan, key, fresh);
    if (checked.error) {
      report = { text: checked.error, bad: true, retry: checked.retry };
      await deps.refreshAfterSeriesWrite();
      return;
    }
    const writes = checked.writes.map((w) => ({ relPath: w.relPath, series: key }));
    const stillMissing = missing.filter((rel) => writes.some((w) => w.relPath === rel));
    if (stillMissing.length) {
      report = { text: `Could not read ${stillMissing.join(", ")} — nothing written`, bad: true };
      return;
    }
    const skipped = checked.moved.length
      ? `Skipped — joined another series since this menu opened: ${checked.moved.map((m) => `${m.title} (in «${m.series}»)`).join(", ")}`
      : "";
    setWorkSeriesMsg(state, "Saving…", false);
    // The open page changed on disk since the reader loaded it: refused before
    // any write rather than 409 on it mid-sequence (arch review 2026-10, 66).
    const { refusal, run } = await trackSeriesWrite(async () => {
      const out = await writeSeriesUnlessOpenChanged({ writes, bases, open, post: deps.postSeriesWrite(), batch: true });
      if (out.refusal === null) deps.adoptOwnSeriesHashes(out.run.hashes);
      return out;
    });
    if (refusal !== null) {
      report = { text: refusal, bad: true };
      return;
    }
    const outcome = await deps.refreshAfterSeriesWrite();
    const notes: string[] = [];
    if (run.failure) {
      const at = writes.findIndex((w) => w.relPath === run.failure!.write.relPath);
      const left = writes.slice(at).map((w) => w.relPath);
      notes.push(`${run.written} of ${run.total} written — stopped at ${run.failure.write.relPath}: ${run.failure.error}. Not written: ${left.join(", ")}`);
    }
    if (skipped) notes.push(skipped);
    if (run.cleared) notes.push(`A page was the head of "${run.cleared}" — that series has no label now`);
    if (run.written && outcome !== "apply") notes.push("Saved — reload to see the updated list");
    if (notes.length) {
      report = { text: notes.join(" · "), bad: !!run.failure || !!run.cleared };
      return;
    }
    st.busy = false;
    if (workPop === state) closeWorkPop("done");
    carryGroupFold(anchorKey, wasOpen);
  } catch (err) {
    // Anything unforeseen still unlocks and reports; what landed is unknown.
    report = { text: `Save as series stopped: ${err instanceof Error ? err.message : String(err)} — reload to see what was written`, bad: true };
  } finally {
    st.busy = false;
    if (report) {
      if (!report.retry) st.done = true;
      setWorkSeriesLocked(state, false, !report.retry);
      setWorkSeriesMsg(state, report.text, report.bad);
    }
  }
}

/** After a Save as series refresh: the group holding `anchorKey`'s thread now
 *  folds under another key (`group:series:`, or an anchor key the duplicate
 *  rule kept); give it the open state the old group had. */
function carryGroupFold(anchorKey: string, wasOpen: boolean): void {
  const holder = getWorkCardsDrawn().find((c) => isRailGroupCard(c) && c.children.some((ch) => ch.key === anchorKey)) as RailGroupCard | undefined;
  if (holder && holder.open !== wasOpen) {
    toggleRailFold(holder.toggleKey);
    renderList();
  }
  const sel = holder ? `#wikiList [data-work-card-menu="${CSS.escape(holder.foldKey)}"], #wikiList [data-thread-group="${CSS.escape(holder.foldKey)}"] .wiki-thread-fold` : null;
  if (sel) document.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
}

/** Open a card's ⋯: a thread card's boundary item, or a group's Save as series. */
export function openWorkCardMenu(btn: HTMLElement): void {
  const key = btn.getAttribute("data-work-card-menu") ?? "";
  if (workPop?.key === `card:${key}`) {
    closeWorkPop("toggle");
    return;
  }
  const card = drawnWorkCard(key);
  if (!card) return;
  const html = isRailGroupCard(card) ? groupCardMenuHtml(card) : card.menu ? threadCardMenuHtml(card.menu) : "";
  if (!html) return;
  openWorkPop(btn, `card:${key}`, html, btn.getAttribute("aria-label") ?? "More", card.key);
}

/** Open a focus row's ⋯ where no series menu applies: Make own thread only. */
export function openThreadRowMenu(btn: HTMLElement): void {
  const rel = btn.getAttribute("data-thread-row-menu") ?? "";
  if (workPop?.key === `row:${rel}`) {
    closeWorkPop("toggle");
    return;
  }
  const html = rowMenuItemHtml(rel);
  const page = deps.allPages().find((p) => normalizeRel(p.relPath) === normalizeRel(rel));
  if (html) openWorkPop(btn, `row:${rel}`, html, `Page menu for ${page ? displayTitleOf(page) : rel}`, rel);
}
// ── Boot: called by the shell's boot(), each where its statements stood ───
/** Take the port. */
export function initMenus(d: MenusDeps): void {
  deps = d;
}

/** The work popover's click delegate, its keys (Escape; the arrows, Home, End
 *  and Tab, which also serve a thread row's page menu) and its scroll and
 *  resize closes. */
export function registerMenus(): void {
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target?.closest) return;
    const el = workPopEl();
    if (el && el.contains(target)) {
      if (boundaryItemClick(target)) return e.preventDefault();
      const save = target.closest<HTMLElement>("[data-work-save-series]");
      if (save && workPop) {
        e.preventDefault();
        if (save.getAttribute("aria-disabled") === "true") return;
        const card = drawnWorkCard(save.getAttribute("data-work-save-series") ?? "");
        if (!card || !isRailGroupCard(card) || !card.series) return;
        el.innerHTML = saveSeriesConfirmHtml(card, card.series);
        // A textbox and plain buttons: a dialog, not a menu (whose reading mode
        // skips anything that is not a menu item). Non-modal: the rail stays live.
        el.setAttribute("role", "dialog");
        el.setAttribute("aria-modal", "false");
        el.setAttribute("aria-label", `Save «${card.name}» as a series`);
        workPop.series = { card, busy: false };
        el.querySelector<HTMLElement>("[data-work-series-key], [data-work-series-go]")?.focus({ preventScroll: true });
        return;
      }
      if (target.closest("[data-work-series-go]")) {
        e.preventDefault();
        void runSaveAsSeries();
        return;
      }
      if (target.closest("[data-work-series-cancel]")) {
        e.preventDefault();
        closeWorkPop("done");
      }
      return;
    }
    // Refused while a write runs (`closeWorkPop`): its report lands here.
    if (el && !target.closest("[data-work-card-menu], [data-thread-row-menu]")) closeWorkPop("outside");
  });
  document.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && workPopEl()) closeWorkPop("key");
  });
  // The arrows, Home and End move between the items of two body-level menus —
  // the ⋯ work popover and a thread row's page menu (`#wikiSeriesMenu` opened
  // from a thread row, marked `data-page-menu`) — the Group menu's keys. A plain
  // row's, Related work's and the header's series menus are not served: they open
  // on their field. Tab closes the work popover back to its opener, as Tab closes
  // the Group menu; the page menu holds text fields, so Tab stays the browser's
  // there. Inside a text field every key is the field's: an item can move focus
  // INTO the field (End, a wrap), never out of it.
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest || e.defaultPrevented) return;
    const work = t.closest<HTMLElement>(`#${WORK_POP_ID}`);
    const el = work ?? t.closest<HTMLElement>(`#${SERIES_MENU_ID}[data-page-menu]`);
    if (!el || el.getAttribute("role") !== "menu") return;
    if (work && e.key === "Tab") {
      e.preventDefault();
      closeWorkPop("key");
      return;
    }
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>("[role^='menuitem'], [data-series-input]")).filter(
      (x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled,
    );
    if (!items.length) return;
    const at = items.findIndex((x) => x === t || x.contains(t));
    const move = (i: number) => {
      const item = items[(i + items.length) % items.length]!;
      // `preventScroll`: a page scroll closes the popover; its own list scrolls.
      item.focus({ preventScroll: true });
      if (item.offsetTop < el.scrollTop) el.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = item.offsetTop + item.offsetHeight - el.clientHeight;
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else return;
    e.preventDefault();
  });
  // Closed on a scroll that MOVES the opener from where the popover was placed.
  // Scroll events arrive a frame late, so the click that opened the popover can
  // deliver its own (a focus or scroll-into-view moving the rail just before the
  // open): measured on a real wiki, that click closed the popover it opened.
  window.addEventListener(
    "scroll",
    (e) => {
      const el = workPopEl();
      const t = e.target as Node | null;
      if (!el || !workPop || (t && (t === el || el.contains(t)))) return;
      const { opener, openerSel, at } = workPop;
      const anchor = opener.isConnected ? opener : openerSel ? document.querySelector(openerSel) : null;
      const r = anchor?.getBoundingClientRect();
      if (r && Math.abs(r.top - at.top) < 1 && Math.abs(r.left - at.left) < 1) return;
      closeWorkPop("viewport");
    },
    true,
  );
  window.addEventListener("resize", () => closeWorkPop("viewport"));
}
