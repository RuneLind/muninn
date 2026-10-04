/**
 * The find palette's DOM half: open on `/` or ⌘K (Ctrl-K off a Mac), rank as
 * the reader types, open a row. Ranking is `wiki-find.ts`; markup and key
 * predicates are `wiki-find-view.ts`. The shell wires it with ONE call,
 * `initFindPalette(port)`.
 *
 * **The dialog root owns every key pressed inside it.** Its keydown handles the
 * palette's own keys and then stops propagation on EVERY keydown it receives,
 * so none of the reader's document-level shortcuts (`]`, `f`, `g`, `t`, the
 * pane ladder's Escape, the Tools menu's Escape) sees a key typed in the
 * palette. Native typing and activation are untouched. Capture-phase listeners
 * still run first: the graph card's Escape stands aside under `modalOpen`
 * (the palette is `aria-modal`), and the ref-link peek's is never armed,
 * because opening the palette hides any peek.
 *
 * Closing REMOVES the node — opacity or visibility would keep client rects
 * and leave `modalOpen` true — and returns focus to the opener. The shell also
 * closes it on Back/Forward. A page load does NOT close it: the boot's own
 * `?relPath=` load lands after a palette the reader opened while the listing
 * was still in flight, a fact-check reload or a boot heal can land under it
 * too, and every page load the reader starts from inside the palette closes
 * it first (`openRow`).
 *
 * During an IME composition the root still stops every key but acts on none:
 * Enter and Escape belong to the composition there.
 */

import { anchorNow, displayTitleOf, type WikiListing } from "./wiki-filter.ts";
import { applySeriesChip, everywhereRequestQuery, rankFind, type FindResult } from "./wiki-find.ts";
import {
  FIND_CHIPS_ID,
  FIND_EVERY_ID,
  FIND_ID,
  FIND_INPUT_ID,
  FIND_LIST_ID,
  FIND_SCRIM_ID,
  everywhereHref,
  everywherePlan,
  everywhereRows,
  everywhereView,
  findChipsHtml,
  findEverywhereHtml,
  findFailedHtml,
  findReasonChipsHtml,
  findListHtml,
  findLoadingHtml,
  findPaletteHtml,
  findRowId,
  isFindToggleKey,
  isMacPlatform,
  localReasons,
  type FindEverywhereState,
  type FindEverywhereView,
} from "./wiki-find-view.ts";
import type { FindEverywhereResponse, FindEverywhereResult } from "../../../wiki/find-everywhere.ts";
import { modalOpen, navMenuOpen, readerKeyEventOf, readerKeyRefused } from "./wiki-panes.ts";

/** What the palette needs from the shell. */
export interface FindPalettePort {
  /** The listing the rail holds. */
  getPages(): readonly WikiListing[];
  /** Has the first listing arrived — or did the boot request for it fail? */
  listingState(): FindListingState;
  /** The open page's `near` map, `{}` when no page is open. */
  getNear(): Record<string, number>;
  /** The listing's scan instant, for `anchorNow`. */
  getScannedAt(): number | null;
  /** Open a page in this tab. */
  openPage(relPath: string): void;
  /** The page's shareable URL (new-tab opens). */
  hrefFor(relPath: string): string;
  /** Called as the palette opens — hides any hover peek. */
  onOpen(): void;
  /** This wiki's REGISTRY name (`__WIKI_FIND_SELF__`) — Everywhere rows of
   *  this wiki are deduped against the local rows and open in place. */
  selfWiki(): string;
  /** Is `GET /api/wiki/find-everywhere` served here? False on the read slice. */
  everywhere(): boolean;
}

export type FindListingState = "loading" | "ready" | "failed";

/** Debounce between a keystroke and a re-rank. */
export const FIND_DEBOUNCE_MS = 120;
/** Debounce between a keystroke and the Everywhere fetch. */
export const FIND_EVERY_DEBOUNCE_MS = 250;

let port: FindPalettePort | null = null;
let opener: HTMLElement | null = null;
let result: FindResult | null = null;
let active = 0;
/** The listing state the open palette last painted. */
let shownState: FindListingState = "loading";
let debounce: ReturnType<typeof setTimeout> | null = null;
/** The latest Everywhere fetch, keyed on the free text it asked for. */
let every: FindEverywhereState | null = null;
/** The last answer that landed (done or failed): what a cancelled pending
 *  fetch falls back to. */
let everySettled: FindEverywhereState | null = null;
/** The Everywhere rows on screen: fused rows not shown as a local row. */
let everyShown: FindEverywhereResult[] = [];
let everyTimer: ReturnType<typeof setTimeout> | null = null;
let everyCtrl: AbortController | null = null;
const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform || navigator.userAgent || "");

export function isFindOpen(): boolean {
  return !!document.getElementById(FIND_SCRIM_ID);
}

function input(): HTMLInputElement | null {
  return document.getElementById(FIND_INPUT_ID) as HTMLInputElement | null;
}

function titleOf(relPath: string): string | undefined {
  const key = relPath.toLowerCase();
  const p = port?.getPages().find((x) => x.relPath.toLowerCase() === key);
  return p ? displayTitleOf(p) : undefined;
}

/** A row's identity across repaints: its wiki and relPath. Its index moves
 *  when local rows arrive ahead of it or a row is deduped into the local list. */
function rowIdentity(i: number): string | null {
  if (!port) return null;
  const local = result?.rows[i];
  if (local) return `${port.selfWiki()}\u0000${local.page.relPath}`;
  const every = everyShown[i - localCount()];
  return every ? `${every.wiki}\u0000${every.relPath}` : null;
}

function indexOfIdentity(id: string | null): number {
  if (id === null) return -1;
  for (let i = 0; i < rowCount(); i++) if (rowIdentity(i) === id) return i;
  return -1;
}

/** The selected row's identity, and the focused row's, before a repaint. */
function captureRows(): { active: string | null; focused: string | null } {
  const f = document.activeElement as HTMLElement | null;
  const focusedIdx = f?.closest?.(`#${FIND_LIST_ID}`) && f.hasAttribute("data-find-row") ? Number(f.getAttribute("data-find-row")) : -1;
  return { active: rowIdentity(active), focused: focusedIdx >= 0 ? rowIdentity(focusedIdx) : null };
}

/** After a repaint: the same row stays selected, and a row that had focus
 *  gets it back — or the input does, never `<body>`. */
function restoreRows(kept: { active: string | null; focused: string | null }, hadRowFocus: boolean): void {
  const a = indexOfIdentity(kept.active);
  active = a >= 0 ? a : active < rowCount() ? active : 0;
  syncActive(false);
  if (!hadRowFocus) return;
  const f = indexOfIdentity(kept.focused);
  const el = f >= 0 ? document.getElementById(findRowId(f)) : null;
  (el ?? input())?.focus({ preventScroll: true });
}

function render(keep = false): void {
  if (!port) return;
  const box = input();
  const list = document.getElementById(FIND_LIST_ID);
  const chips = document.getElementById(FIND_CHIPS_ID);
  if (!box || !list || !chips) return;
  const kept = keep ? captureRows() : null;
  const hadRowFocus = !!kept && kept.focused !== null;
  const query = box.value;
  shownState = port.listingState();
  if (shownState !== "ready") {
    // No listing yet (or it failed): Everywhere is the fallback list.
    result = null;
    chips.innerHTML = "";
  } else {
    result = rankFind(port.getPages(), query, {
      near: port.getNear(),
      now: anchorNow(Date.now(), port.getScannedAt()),
    });
    chips.innerHTML = query.trim() ? findChipsHtml(result) : "";
  }
  const view = currentView();
  everyShown = shownRows(view);
  if (active >= rowCount()) active = 0;
  const localHtml = result
    ? findListHtml(result, query, active, port.hrefFor, titleOf)
    : shownState === "failed"
      ? findFailedHtml()
      : findLoadingHtml();
  list.innerHTML =
    localHtml + `<div id="${FIND_EVERY_ID}">${findEverywhereHtml(view, everyShown, localCount(), active)}</div>`;
  addLocalReasons(view);
  if (kept) restoreRows(kept, hadRowFocus);
  else syncActive();
}

/** The section's view for the query in the box. */
function currentView(): FindEverywhereView | null {
  return everywhereView(everywherePlan(input()?.value ?? "", !!port?.everywhere()), every);
}

/** The Everywhere rows on screen: fused rows not shown as a local row. */
function shownRows(view: FindEverywhereView | null): FindEverywhereResult[] {
  return view?.kind === "done" && port ? everywhereRows(view.data, port.selfWiki(), localRelPaths()) : [];
}

function localRelPaths(): Set<string> {
  return new Set(result?.rows.map((r) => r.page.relPath) ?? []);
}

function localCount(): number {
  return result?.rows.length ?? 0;
}

/** Local rows plus Everywhere rows — what the arrow keys walk. */
function rowCount(): number {
  return localCount() + everyShown.length;
}

/** Give each local row the fused response's reasons for it, in place. */
function addLocalReasons(view: FindEverywhereView | null): void {
  if (!port || view?.kind !== "done") return;
  const reasons = localReasons(view.data, port.selfWiki());
  document.querySelectorAll<HTMLElement>(`#${FIND_LIST_ID} .wiki-find-row:not(.wiki-find-every-row)`).forEach((el) => {
    const r = reasons.get(el.getAttribute("data-relpath") ?? "");
    const meta = el.querySelector(".wiki-find-meta");
    if (!r || !meta || meta.querySelector(".wiki-find-reasons")) return;
    meta.insertAdjacentHTML("beforeend", findReasonChipsHtml(r));
  });
}

/**
 * Paint the Everywhere section alone, when its response lands. The local rows
 * stay in place — they only gain reason chips. The section's rows are new
 * nodes, so the selection moves to its row by identity (wiki + relPath), and a
 * focused row's focus is restored by identity — never dropped to `<body>` (a
 * whole-list repaint under a Tab-focused row did that, the #639 finding).
 */
function paintEverywhere(): void {
  const box = document.getElementById(FIND_EVERY_ID);
  if (!port || !box) return;
  const kept = captureRows();
  const hadRowFocus = kept.focused !== null;
  const view = currentView();
  everyShown = shownRows(view);
  box.innerHTML = findEverywhereHtml(view, everyShown, localCount(), active);
  addLocalReasons(view);
  // The selection follows its row, aria-activedescendant follows the
  // selection, and a focused row keeps focus — no scroll on the way.
  restoreRows(kept, hadRowFocus);
}

function cancelEverywhere(): void {
  if (everyTimer) clearTimeout(everyTimer);
  everyTimer = null;
  everyCtrl?.abort();
  everyCtrl = null;
}

/**
 * On a query change. The fetch is keyed on the free text: an edit that keeps
 * it (a filter token, a trailing space, a chip) keeps the fetch in flight and
 * the rows on screen, and only the dedupe re-runs. A filter suppresses the
 * section without dropping what was fetched, but a fetch still waiting on its
 * debounce is cancelled and the last answer kept; free text typed under a
 * filter is not fetched. Free text that returns to the last answer's key
 * reuses that answer instead of asking again.
 */
function updateEverywhere(): void {
  const query = input()?.value ?? "";
  const plan = everywherePlan(query, !!port?.everywhere());
  if (plan.kind === "fetch" && every?.key !== plan.key && everySettled?.key === plan.key && everySettled.status === "done") {
    // Back to the free text of the last answer (`felles t…` → `felles type:`):
    // reuse it rather than ask again. A failed answer is asked again.
    cancelEverywhere();
    every = everySettled;
  } else if (plan.kind === "fetch" && every?.key !== plan.key) {
    cancelEverywhere();
    every = { key: plan.key, status: "pending" };
    const key = plan.key;
    // The free words: filters out, `#12` kept a hard number for the text leg
    // (its remote form is the key), and quoted where the server's parse
    // would otherwise read a filter or a number.
    const q = everywhereRequestQuery(query);
    everyTimer = setTimeout(() => {
      everyTimer = null;
      void fetchEverywhere(key, q);
    }, FIND_EVERY_DEBOUNCE_MS);
  } else if (plan.kind === "filtered" && everyTimer) {
    cancelEverywhere();
    every = everySettled;
  } else if (plan.kind === "off") {
    cancelEverywhere();
    every = null;
  }
  paintEverywhere();
}

async function fetchEverywhere(key: string, q: string): Promise<void> {
  const ctrl = new AbortController();
  everyCtrl = ctrl;
  let next: FindEverywhereState;
  try {
    const res = await fetch(`/api/wiki/find-everywhere?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    next = { key, status: "done", data: (await res.json()) as FindEverywhereResponse };
  } catch {
    if (ctrl.signal.aborted) return;
    next = { key, status: "failed" };
  }
  // A newer free text aborted this fetch or replaced it: drop the answer.
  if (ctrl.signal.aborted || everyCtrl !== ctrl || every?.key !== key) return;
  everyCtrl = null;
  every = next;
  everySettled = next;
  paintEverywhere();
}

function syncActive(scroll = true): void {
  const box = input();
  if (!box) return;
  if (!rowCount()) {
    box.removeAttribute("aria-activedescendant");
    return;
  }
  box.setAttribute("aria-activedescendant", findRowId(active));
  document.querySelectorAll<HTMLElement>(`#${FIND_LIST_ID} .wiki-find-row`).forEach((el) => {
    const on = Number(el.getAttribute("data-find-row")) === active;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", String(on));
    if (on && scroll) el.scrollIntoView({ block: "nearest" });
  });
}

/** Rank a query change the debounce still holds, NOW, from the top row —
 *  so a key pressed inside the debounce acts on the fresh results. */
function flushPending(): void {
  if (!debounce) return;
  clearTimeout(debounce);
  debounce = null;
  active = 0;
  render();
}

/**
 * Repaint an open palette that is still showing "Loading" or the failure line
 * — the shell calls it whenever the listing arrives or its boot request fails.
 * A palette already showing rows is left alone: a background adoption (focus
 * refetch, heartbeat) would otherwise replace the rows and chips under a
 * Tab-focused one, dropping focus to `<body>`, where reader keys fire behind
 * the open dialog. Its rows re-rank over the new listing on the next keystroke.
 */
export function refreshFind(): void {
  // `keep`: the rows arrive ahead of the Everywhere rows the reader may have
  // selected or focused; both follow their row by identity.
  if (isFindOpen() && shownState !== "ready") render(true);
}

function scheduleRender(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    active = 0;
    render();
  }, FIND_DEBOUNCE_MS);
}

function openRow(i: number, newTab: boolean): void {
  if (!port) return;
  if (i >= localCount()) {
    openEverywhereRow(everyShown[i - localCount()], newTab);
    return;
  }
  const row = result?.rows[i];
  if (!row) return;
  if (newTab) {
    window.open(port.hrefFor(row.page.relPath), "_blank", "noopener");
    return;
  }
  const rel = row.page.relPath;
  closeFind(false);
  port.openPage(rel);
}

/** An Everywhere row: this wiki's page opens in place, another wiki's loads. */
function openEverywhereRow(r: FindEverywhereResult | undefined, newTab: boolean): void {
  if (!r || !port) return;
  const href = everywhereHref(r.wiki, r.relPath);
  if (newTab) {
    window.open(href, "_blank", "noopener");
    return;
  }
  const same = r.wiki === port.selfWiki();
  closeFind(false);
  if (same) port.openPage(r.relPath);
  else window.location.assign(href);
}

function onInput(e: Event): void {
  scheduleRender();
  // An IME composition is mid-word: fetch on compositionend instead.
  if ((e as InputEvent).isComposing) return;
  updateEverywhere();
}

export function openFind(): void {
  if (!port || isFindOpen()) return;
  port.onOpen();
  const focused = document.activeElement;
  opener = focused instanceof HTMLElement && focused !== document.body ? focused : null;
  const scrim = document.createElement("div");
  scrim.className = "wiki-find-scrim";
  scrim.id = FIND_SCRIM_ID;
  scrim.innerHTML = findPaletteHtml();
  document.body.appendChild(scrim);
  const root = document.getElementById(FIND_ID)!;
  root.addEventListener("keydown", onRootKeydown);
  root.addEventListener("click", onRootClick);
  const box = root.querySelector(`#${FIND_INPUT_ID}`)!;
  box.addEventListener("input", onInput);
  box.addEventListener("compositionend", () => updateEverywhere());
  // Outside click: a press on the scrim itself, not on anything inside the dialog.
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) {
      e.preventDefault();
      closeFind(true);
    }
  });
  active = 0;
  result = null;
  every = null;
  everySettled = null;
  everyShown = [];
  render();
  input()!.focus();
}

/** Close and, unless a row is being opened, give focus back to the opener. */
export function closeFind(returnFocus = true): void {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  cancelEverywhere();
  every = null;
  everySettled = null;
  everyShown = [];
  document.getElementById(FIND_SCRIM_ID)?.remove();
  result = null;
  const back = opener;
  opener = null;
  if (returnFocus && back && back.isConnected) back.focus();
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`#${FIND_INPUT_ID}, .wiki-find-chip, .wiki-find-row`),
  );
}

function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  const items = focusables(root);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  const next = e.shiftKey
    ? at <= 0 ? items.length - 1 : at - 1
    : at === -1 || at === items.length - 1 ? 0 : at + 1;
  items[next]!.focus();
}

/** The dialog root's one keydown: the palette's keys, then stop EVERY key. */
function onRootKeydown(e: KeyboardEvent): void {
  const root = e.currentTarget as HTMLElement;
  const target = e.target as HTMLElement | null;
  const inInput = target?.id === FIND_INPUT_ID;
  // 229: Safari's keydown during a composition reports `isComposing` false.
  if (e.isComposing || e.keyCode === 229) {
    // the composition's key, not the palette's
  } else if (e.key === "Escape" || isFindToggleKey(e, mac)) {
    e.preventDefault();
    closeFind(true);
  } else if (e.key === "Tab") {
    trapTab(e, root);
  } else if (inInput && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    flushPending();
    const n = rowCount();
    if (n) {
      active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
      syncActive();
    }
  } else if (inInput && e.key === "Enter") {
    e.preventDefault();
    flushPending();
    openRow(active, e.shiftKey);
  } else if (e.key === " " && target?.hasAttribute("data-find-row")) {
    // A link does not activate on Space; a row is an option, which does.
    e.preventDefault();
    openRow(Number(target.getAttribute("data-find-row")), false);
  }
  e.stopPropagation();
}

function onRootClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const chip = t.closest<HTMLElement>("[data-find-chip]");
  if (chip) {
    const box = input();
    if (!box) return;
    box.value = applySeriesChip(box.value, chip.getAttribute("data-find-chip") ?? "");
    active = 0;
    render();
    updateEverywhere();
    box.focus();
    return;
  }
  const row = t.closest<HTMLElement>("[data-find-row]");
  if (row) {
    // A modifier click or a middle click is the link's own; a plain one opens
    // in place without a page load.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openRow(Number(row.getAttribute("data-find-row")), false);
  }
}

/**
 * The opening listener, on the document in the bubble phase. `/` opens from
 * the page but types into a text field; ⌘K (Ctrl-K off a Mac) opens from
 * anywhere, a text field included. Both are refused while another dialog or
 * menu is open — the header's Tools menu included, which `modalOpen` cannot
 * see. Keys pressed inside the palette never reach here: its root stops them.
 */
function onDocumentKeydown(e: KeyboardEvent): void {
  if (isFindOpen() || navMenuOpen(document)) return;
  if (isFindToggleKey(e, mac)) {
    if (modalOpen(document)) return;
    e.preventDefault();
    openFind();
    return;
  }
  if (e.key !== "/" || readerKeyRefused(readerKeyEventOf(e))) return;
  e.preventDefault();
  openFind();
}

export function initFindPalette(p: FindPalettePort): void {
  port = p;
  document.addEventListener("keydown", onDocumentKeydown);
}
