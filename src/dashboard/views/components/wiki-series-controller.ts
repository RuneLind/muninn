/// <reference lib="dom" />
/**
 * The /wiki reader's series editor (mimir plan muninn-wiki-browser-split, C5):
 * the popover `#wikiSeriesMenu`, its CAS-guarded writes and the repaint after
 * them.
 *
 * Moved out of the shell (`wiki-browser.ts`). The controller owns `seriesMenu`
 * (the shell reads its opener through `seriesMenuOpener`), `postSeriesWrite`
 * (`getPostSeriesWrite`; `initSeries` sets it at the spot in `boot()` that
 * assigned it before the move) and `seriesBaseHash`, built at import as before.
 * `registerSeriesInputs` adds the popover's five listeners right after
 * `initSeries`, where `boot()` held them. It never imports the shell: what it reads and
 * calls there arrives through {@link SeriesPort}. It imports the ⋯ menus'
 * focus rule and row items (`wiki-menus-controller.ts`), the rail's
 * `railControlSelector` and the article controller's `repaintRelatedBlock`
 * directly; none of those imports it back, so the ⋯ menus keep reaching the
 * editor through the shell's `menusDeps()` relay.
 */
import { buildSeriesMenu, headMoveWrites, SERIES_EDIT_ATTR, SERIES_MENU_ATTR, SERIES_MENU_ID, seriesMenuHtml, type SeriesMenuModel, type SeriesWrite } from "./wiki-series-menu.ts";
import { boundaryItemClick, focusPopOpener, type PopCloseCause, popCloseReturnsFocus, rowMenuItemHtml, workPopBusy } from "./wiki-menus-controller.ts";
import { escHtml as esc } from "./escape.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { railControlSelector } from "./wiki-rail-controller.ts";
import { repaintRelatedBlock } from "./wiki-article-controller.ts";
import { type OpenPageAtLoad, readSeriesBasesAfterWrites, seriesBaseReader, seriesConflictCopy, seriesPoster, type SeriesPoster, trackSeriesWrite, withinSeriesBound, writeSeriesUnlessOpenChanged } from "./wiki-series-write.ts";
import { refreshLensSwitch } from "./wiki-lens.ts";
import { seriesEditable } from "./wiki-readonly-client.ts";
import type { ReceiveOutcome } from "./wiki-refresh.ts";
import type { WikiListing } from "./wiki-filter.ts";

/** What the series editor reads and calls on the shell, read live through a
 *  function so a value the shell reassigns is never a stale copy. Every member
 *  is shell-owned. */
export interface SeriesPort {
  /** The shell's `WIKI` let: `initSeries` builds the series POST for it. */
  WIKI(): string;
  /** The shell's `allPages` let (the listing): the menu model and the head repaint. */
  allPages(): WikiListing[];
  /** The shell's `currentRelPath` let: which page's head to repaint. */
  currentRelPath(): string | null;
  /** The shell's `withWiki()`: the CAS base reader's page URL. */
  withWiki(url: string): string;
  /** The shell's `recencyNow()`: the menu model's recency. */
  recencyNow(): number;
  /** The shell's `requestPagesAwaited()` (listing refresh): the refetch after a write. */
  requestPagesAwaited(opts: { refresh: boolean; boot?: boolean; force?: boolean }): Promise<ReceiveOutcome | "error">;
  /** The shell's `seriesStripHtml()` (the article head): the strip a write repaints. */
  seriesStripHtml(m: WikiListing): string;
  /** The shell's `openPageAtLoad()`, the same member `MenusDeps` has: it reads
   *  only shell lets (`currentRelPath`, `currentPageHash`). */
  openPageAtLoad(): OpenPageAtLoad;
  /** The shell's `adoptOwnSeriesHashes()`, the same member `MenusDeps` has: it
   *  writes `currentPageHash`, which stays single-writer in the shell. */
  adoptOwnSeriesHashes(hashes: ReadonlyMap<string, string>): void;
}

let deps!: SeriesPort;

// ── Series editor: the popover, the writes, the repaint ───────────────
//
// ONE popover node, keyed by id, so "only one open at a time" is a property of
// the DOM rather than a rule something has to enforce. It is `position: fixed`
// and CLOSES on a scroll of the PAGE rather than re-anchoring: the openers live
// in a scrolling rail, and a menu that chases its row is a menu whose click
// lands somewhere else. A scroll INSIDE the popover is not that scroll — the
// listener is a capture-phase one, so its own overflowing list used to dismiss
// it on the first wheel tick and the `max-height` was unreachable.
//
// The CAS bases are captured when the popover OPENS, one per page the menu can
// write, and held for as long as it is open. Reading them a millisecond before
// each POST is a CAS whose window is the network round trip, where the window
// that matters is the one a human spends deciding — exactly the span this menu
// is on screen. Measured: a file edited while the popover stood open was
// written anyway, against bytes the reader had never seen and with no refusal
// shown. The page the reader has OPEN needs no request at all:
// its `/api/wiki/page` payload carried the hash, and every write here answers
// the hash it left behind, so the editor's own writes keep it current instead
// of staling it.

/** The page the open popover acts on, which view it is painting, and the bases
 *  its writes will send. `null` when no menu is open. */
interface SeriesMenuState {
  model: SeriesMenuModel;
  edit: boolean;
  busy: boolean;
  /** The control that opened it — focus goes back there on every close, because
   *  a keyboard reader who dismisses a menu must not be returned to `<body>`. */
  opener: HTMLElement | null;
  /** The opener as a selector by its key, taken at open time (a repaint
   *  detaches the node); see `seriesOpenerSel`. */
  openerSel: string | null;
  /** relPath → the page's content hash as of OPEN time. A target missing from
   *  this map is one whose read failed; its write is refused rather than sent
   *  with no base. */
  bases: Map<string, string>;
  /** Resolves when every base above has been read (or failed). A click that
   *  beats the fetches waits for it instead of racing them. */
  basesReady: Promise<void>;
  /** The open page as loaded, taken with the bases once the reader's own
   *  writes in flight have settled: at the click, a verb that writes it is
   *  refused before any write when its base read at open differs
   *  (`writeSeriesUnlessOpenChanged`). */
  open: OpenPageAtLoad;
  /** The base read gave up waiting for an earlier save of the reader's
   *  (`readSeriesBasesAfterWrites`' bound): every verb is refused with
   *  `SERIES_STALLED_COPY`, and the menu is free again. */
  stalled: boolean;
  /** Set when the held bases no longer describe the files on disk — a write
   *  came back 409, or one of this menu's own writes landed and the popover
   *  stayed open to report it. Either way no further write may go out under
   *  them, and the reader is told to reopen rather than shown a 409 about a
   *  change they made themselves. */
  staleBases: boolean;
  /** What the next click says while `staleBases` holds: reload after a 409 on
   *  the open page, close and reopen otherwise (`seriesConflictCopy`). */
  staleNote: string;
}

let seriesMenu: SeriesMenuState | null = null;

function seriesMenuEl(): HTMLElement | null {
  return document.getElementById(SERIES_MENU_ID);
}

// Every close of the popover sets focus by the table at `PopCloseCause`
// (`wiki-menus-controller.ts`), which the work popover shares.

/** A series opener as a selector by its key, for a repaint that replaces it:
 *  the rail's own selector for a rail control, else the opener's attribute
 *  and page inside its nearest container with an id (a plain rail row, the
 *  Related work block, the article header). */
function seriesOpenerSel(anchor: HTMLElement): string | null {
  const rail = railControlSelector(anchor);
  if (rail) return rail;
  const attr = anchor.hasAttribute(SERIES_EDIT_ATTR) ? SERIES_EDIT_ATTR : anchor.hasAttribute(SERIES_MENU_ATTR) ? SERIES_MENU_ATTR : null;
  if (!attr) return null;
  const box = anchor.parentElement?.closest<HTMLElement>("[id]");
  const scope = box?.id === "wikiList" ? "#wikiList .wiki-list-item:not(.thread-row)" : box ? `#${CSS.escape(box.id)}` : "";
  return `${scope} [${attr}="${CSS.escape(anchor.getAttribute(attr) ?? "")}"]`.trim();
}

/** Close the series popover; focus per the `PopCloseCause` table (⋯ menus
 *  controller). `preventScroll`: the opener may have scrolled out of view. */
export function closeSeriesMenu(cause: PopCloseCause): void {
  const was = seriesMenu;
  const el = seriesMenuEl();
  const refocus = popCloseReturnsFocus(cause, el);
  el?.remove();
  seriesMenu = null;
  if (refocus && was?.opener) focusPopOpener(was.opener, was.openerSel, was.model.relPath);
}

/** The popover node, positioned under `anchor`. Shared by the real menu and by
 *  the one-line note below, so a refusal lands in the same place a menu would. */
function paintSeriesMenuEl(anchor: HTMLElement, html: string): HTMLElement {
  const el = document.createElement("div");
  el.id = SERIES_MENU_ID;
  el.className = "wiki-series-menu";
  el.setAttribute("role", "menu");
  el.innerHTML = html;
  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  // Clamped into the viewport on both axes; the rail's rows sit at the left
  // edge and the reader header's control near the right one.
  const width = el.offsetWidth || 260;
  const height = el.offsetHeight || 200;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  return el;
}

/** Open the popover for `relPath`, anchored under `anchor`. */
function openSeriesMenu(anchor: HTMLElement, relPath: string, edit: boolean): void {
  // A Save as series write in flight keeps its popover, the one ⋯ open.
  if (workPopBusy()) return;
  closeSeriesMenu("replace");
  if (!seriesEditable()) return;
  const model = buildSeriesMenu(deps.allPages(), relPath, deps.recencyNow());
  if (!model) {
    // The listing moved under the row between its render and this click — a
    // deleted or renamed page. Said in the popover rather than swallowed: a
    // control that does nothing at all reads as a broken one.
    paintSeriesMenuEl(
      anchor,
      `<div class="wiki-series-menu-msg bad">${esc(relPath)} is no longer in the listing</div>`,
    );
    return;
  }
  // On a work thread's focus row the ⋯ is a page menu (PR 4): Make own
  // thread (or Return to its thread) above today's series items.
  const row = !edit ? anchor.closest<HTMLElement>(".wiki-list-item.thread-row:not(.session-row)") : null;
  const boundary = row ? rowMenuItemHtml(relPath) : "";
  const el = paintSeriesMenuEl(anchor, (boundary ? boundary + `<div class="wiki-work-hr" role="separator"></div>` : "") + seriesMenuHtml(model, edit));
  // The page menu takes the arrow keys (the keydown delegate by the work
  // popover's); the other series menus open on their field and keep base keys.
  if (row) el.setAttribute("data-page-menu", "");
  const state: SeriesMenuState = {
    model,
    edit,
    busy: false,
    opener: anchor,
    openerSel: seriesOpenerSel(anchor),
    bases: new Map(),
    basesReady: Promise.resolve(),
    open: deps.openPageAtLoad(),
    stalled: false,
    staleBases: false,
    staleNote: "Close and reopen this menu — the page has changed",
  };
  state.basesReady = loadSeriesBases(state);
  seriesMenu = state;
  // `preventScroll`, the ★'s own rule: focusing a field inside a popover that
  // is taller than the viewport scrolls the PAGE to reach it — and a page
  // scroll is what this menu closes on, so the menu dismissed itself the moment
  // it opened (measured on a short viewport, where 70vh really binds).
  // A page menu opens on its first item, the boundary item (the Group menu's
  // rule); a series menu on its field.
  (el.querySelector<HTMLElement>("[data-thread-split], [data-work-return]") ?? el.querySelector<HTMLInputElement>("[data-series-input]"))?.focus({ preventScroll: true });
}

/**
 * Every page this menu's verbs can write, as the CAS bases they will be sent
 * with.
 *
 * The join/new/remove verbs write the page the menu was opened on; the rename
 * writes the head (or, with no head yet, that same page); a head MOVE writes
 * both the old head and the member it is moving to, which is any member row the
 * edit view renders — so all of them are read at open. That is one request per
 * member of one series, issued once per popover open, and the alternative is a
 * base read after the reader has decided, which is the CAS this closes.
 *
 * The open page's base is read FRESH too, by Save as series' rule (arch
 * review 2026-10, finding 66): its load-time hash made every reopen after a
 * 409 send the same stale base. At the click, `writeSeriesUnlessOpenChanged`
 * compares it with `state.open` and refuses a verb that writes the open page
 * before writing. Both are taken after the reader's own writes in flight
 * settle (`readSeriesBasesAfterWrites`), or a menu opened during one blames
 * the reader for their own change; a wait past the bound marks the menu
 * `stalled` instead, and every verb is refused with copy that says so.
 */
function loadSeriesBases(state: SeriesMenuState): Promise<void> {
  const { model, edit } = state;
  const targets = new Set<string>([model.relPath]);
  if (edit) {
    if (model.headRel) targets.add(model.headRel);
    for (const m of model.members) targets.add(m.relPath);
  }
  return readSeriesBasesAfterWrites([...targets], seriesBaseHash, deps.openPageAtLoad).then(({ bases, open, stalled }) => {
    state.open = open;
    state.stalled = stalled;
    for (const [rel, hash] of bases) state.bases.set(rel, hash);
  });
}

/** Say what happened, in the popover, without tearing it down — a refusal the
 *  reader cannot read is a click that did nothing.
 *
 *  Keyed on the menu the message BELONGS to: a write is a sequence of awaits,
 *  and by the time one answers the reader may have closed this popover and
 *  opened another on a different page. Painting into that one would report a
 *  page it is not about. */
function setSeriesMenuNote(state: SeriesMenuState, text: string, bad: boolean): void {
  if (seriesMenu !== state) return;
  const el = seriesMenuEl();
  if (!el) return;
  let note = el.querySelector<HTMLElement>(".wiki-series-menu-msg");
  if (!note) {
    note = document.createElement("div");
    note.className = "wiki-series-menu-msg";
    el.appendChild(note);
  }
  note.classList.toggle("bad", bad);
  note.textContent = text;
}

/** The page's current content hash — the CAS base — and the series POST,
 *  both bounded by `SERIES_REQUEST_TIMEOUT_MS` (`wiki-series-write.ts`). A
 *  base that cannot be read is `null`, which the caller reports rather than
 *  writing without one. */
export const seriesBaseHash = seriesBaseReader((relPath) => deps.withWiki(`/api/wiki/page?relPath=${encodeURIComponent(relPath)}`));
let postSeriesWrite!: SeriesPoster;

/**
 * Run the editor's writes, in order, stopping at the first failure.
 *
 * ORDER MATTERS on the two-call head move (see {@link headMoveWrites}) and the
 * stop is what keeps its failure state the VISIBLE one: the label is cleared
 * first, so a failure leaves a series with no labelled member, which the fold
 * and the header render under its bare key — rather than two members claiming
 * the label, where the rail silently picks one and says nothing (only lint
 * 8.3(b) reports that one, on its next run).
 *
 * Both endings refresh. A second write that fails leaves the FIRST one's effect
 * on disk, and without the refresh the header and the rail went on painting a
 * label that is gone from the file.
 *
 * A sequence the route reports as all-noop (`written: false` on every answer —
 * the key typed is the one the page carries) still refreshes, but reports
 * nothing and stales nothing. The refresh stays because the noop's usual
 * trigger is DRIFT: the key reached the disk after THIS BROWSER fetched its
 * listing (`allPages`, read at page load), so the popover offered a join the
 * file no longer needs. The stale party is the client, not the server — the
 * route rebuilds the index before every write, and the lint Accept and the
 * sync loop refresh it themselves — so only a refetch-and-apply here moves the
 * row into the fold (measured: skipping it closed the menu as a success over a
 * rail that stayed wrong). The note and the stale flag go because a
 * byte-identical listing after a non-write is the expected answer, not a
 * failed one: measured, it read as "Saved — reload" and the menu locked
 * itself over its own non-write, refusing the next verb until reopened.
 */
async function applySeriesWrites(writes: SeriesWrite[]): Promise<void> {
  const state = seriesMenu;
  if (!state || state.busy) return;
  if (state.staleBases) {
    setSeriesMenuNote(state, state.staleNote, true);
    return;
  }
  state.busy = true;
  setSeriesMenuNote(state, "Saving…", false);
  try {
    // Tracked from the click until the open page's hash has adopted the
    // answers, so a menu opened meanwhile reads its bases after it.
    const { refusal, run } = await trackSeriesWrite(async () => {
      await state.basesReady;
      // The refusal and the loop are `wiki-series-write.ts`'s, shared with
      // the Work threads' Save as series.
      const out = await writeSeriesUnlessOpenChanged({ writes, bases: state.bases, open: state.open, post: postSeriesWrite, stalled: state.stalled });
      if (out.refusal === null) deps.adoptOwnSeriesHashes(out.run.hashes);
      return out;
    });
    if (refusal !== null) {
      setSeriesMenuNote(state, refusal, true);
      return;
    }
    if (run.failure) {
      if (run.failure.status === 409) {
        // The base this menu has held since it opened describes a file
        // somebody else has moved on from. Every base it holds is suspect
        // now, so the menu stops writing and says which page it was.
        // The step follows the page: a reopened menu still holds the open
        // page's load-time hash, and a verb that writes that page is refused
        // at the click, so only a reload clears it.
        const copy = seriesConflictCopy(run.failure.write.relPath, deps.currentRelPath());
        state.staleBases = true;
        state.staleNote = copy.again;
        state.bases.clear();
        setSeriesMenuNote(state, copy.note, true);
      } else {
        setSeriesMenuNote(state, run.failure.error, true);
      }
      await refreshAfterSeriesWrite();
      return;
    }
    /** The series this sequence left without a label — the route reports it
     *  when a MOVE took the page's own `series_label:` with it, since a label
     *  names a series rather than a page. */
    const cleared = run.cleared ? { series: run.cleared } : null;
    /** Whether any answer in the sequence reported bytes moved. */
    const wrote = run.wrote;
    const outcome = await refreshAfterSeriesWrite();
    const notes: string[] = [];
    if (cleared) {
      // The label went with the move, and nothing on screen would otherwise say
      // so: the series this page left renders under its bare key from here on —
      // visible on its fold and on every member's header, and reported by no
      // lint check (measured), which is why the reader is told here.
      notes.push(
        `This page was the head of "${cleared.series}" — that series has no label now`,
      );
    }
    // The write landed; the listing did not. Saying so beats repainting the
    // rail from the set it already had and calling that success.
    if (wrote && outcome !== "apply") notes.push("Saved — reload to see the updated list");
    if (notes.length) {
      // The menu stays OPEN so the line can be read — and the bases it still
      // holds describe files this write has just moved on from, so the next
      // click reopens instead of spending a 409 that blames another writer.
      state.staleBases = true;
      setSeriesMenuNote(state, notes.join(" · "), false);
      return;
    }
    // Keyed to THIS sequence's menu, as the note setter is: the reader can
    // have dismissed this popover and opened another while the write was in
    // flight, and that one is theirs to keep.
    if (seriesMenu === state) closeSeriesMenu("done");
  } finally {
    state.busy = false;
  }
}

/**
 * Re-read the listing and repaint what the edit moved.
 *
 * Deliberately a FORCED apply (`force: true`): `receivePages` defers an arriving
 * listing while the reader has an article open, which is exactly the state the
 * header's `edit series` acts from — and here the re-sort IS the reader's own
 * click, not the background refresh that rule exists for. `?refresh=1` because
 * the index behind `/api/wiki/pages` is a 5-minute TTL cache; the route rebuilt
 * it inside the write, and this is what makes the rail read the rebuild.
 *
 * The OUTCOME is returned, because three of the five are not a refresh at all:
 * a superseded response (`stale`), a degraded empty set (`empty`) and a
 * byte-identical one (`unchanged`) all leave the screen showing the listing
 * from before the write, and repainting from that is a success the reader can
 * see is false.
 */
export async function refreshAfterSeriesWrite(): Promise<ReceiveOutcome | "error"> {
  // Bounded: both popovers hold their busy state across this await. A late
  // answer still lands through the listing's own sequence discipline.
  const outcome = await withinSeriesBound(deps.requestPagesAwaited({ refresh: true, force: true }), "error");
  repaintSeriesHead();
  // Related work's rows carry series too, and the ⋯ on them is one of the
  // editor's openers.
  repaintRelatedBlock();
  return outcome;
}

/** Repaint the open article's series header from the fresh listing — the rail's
 *  own `renderList` does not reach inside `#articleWrap`. Adds, replaces or
 *  removes the block, in the slot `articleHeadHtml` puts it (right after the
 *  meta row). */
function repaintSeriesHead(): void {
  if (!deps.currentRelPath()) return;
  const host = document.querySelector<HTMLElement>(".wiki-article-head");
  if (!host) return;
  const key = normalizeRel(deps.currentRelPath()!);
  const meta = deps.allPages().find((p) => normalizeRel(p.relPath) === key);
  const html = meta ? deps.seriesStripHtml(meta) : "";
  const existing = host.querySelector(".wiki-series-head");
  if (existing) {
    if (html) existing.outerHTML = html;
    else existing.remove();
  } else if (html) {
    host.querySelector(".wiki-meta-row")?.insertAdjacentHTML("afterend", html);
  }
  // A series strip that appears brings the lens switch, as a cost line does.
  if (html) refreshLensSwitch(document.getElementById("articleWrap")!);
}

// ── Wiring: the port, the poster, the popover's listeners ─────────────
/** Wire the port, then build the series POST for this wiki: the assignment
 *  `boot()` made at this spot before the move. */
export function initSeries(d: SeriesPort): void {
  deps = d;
  postSeriesWrite = seriesPoster(deps.WIKI());
}

/** The series POST `initSeries` built (the ⋯ menus' Save as series writes through it). */
export function getPostSeriesWrite(): SeriesPoster {
  return postSeriesWrite;
}

/** The control the open series menu was opened from, or null when none is open. */
export function seriesMenuOpener(): HTMLElement | null {
  return seriesMenu?.opener ?? null;
}

/** The popover's five listeners (Escape, scroll and resize close, its click
 *  delegate, its submit), moved verbatim from `boot()`, which calls this right
 *  after `initSeries` so their place in the listener order is unchanged. */
export function registerSeriesInputs(): void {
  document.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && seriesMenuEl()) closeSeriesMenu("key");
  });
  // Closed rather than re-anchored — see the block comment above. `capture` so a
  // scroll inside the RAIL (which does not bubble) is seen too; the popover's own
  // scroll is excluded by target, or its `overflow-y: auto` list would dismiss it
  // on the first wheel tick.
  window.addEventListener(
    "scroll",
    (e) => {
      const el = seriesMenuEl();
      const target = e.target as Node | null;
      if (el && target && (target === el || el.contains(target))) return;
      closeSeriesMenu("viewport");
    },
    true,
  );
  window.addEventListener("resize", () => closeSeriesMenu("viewport"));
  /** The popover's own delegate, on its node, so the shell's document listeners
   *  carry no branch for it and a click inside it never reaches the rail's
   *  row-opening handler. */
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target?.closest) return;
    const menuEl = seriesMenuEl();
    if (menuEl && menuEl.contains(target)) {
      if (boundaryItemClick(target)) {
        e.preventDefault();
        return;
      }
      const cmd = target.closest<HTMLElement>("[data-series-cmd]");
      if (!cmd || !seriesMenu) return;
      e.preventDefault();
      const arg = cmd.getAttribute("data-series-arg") || "";
      const { model } = seriesMenu;
      if (cmd.getAttribute("data-series-cmd") === "join") {
        void applySeriesWrites([{ relPath: model.relPath, series: arg }]);
      } else if (cmd.getAttribute("data-series-cmd") === "remove") {
        // The route clears `series_label:` with the key — a label on a page in no
        // series names nothing, and no surface reads it (the rail takes the label
        // off a MEMBER, and the lint's census skips a page with no key).
        void applySeriesWrites([{ relPath: model.relPath, series: null }]);
      } else if (cmd.getAttribute("data-series-cmd") === "head" && arg) {
        void applySeriesWrites(headMoveWrites(model, arg, model.label));
      }
      return;
    }
    // An opener. Re-clicking the one that opened the menu closes it, the ordinary
    // popover convention.
    const opener =
      target.closest<HTMLElement>(`[${SERIES_MENU_ATTR}]`) ||
      target.closest<HTMLElement>(`[${SERIES_EDIT_ATTR}]`);
    if (opener) {
      e.preventDefault();
      e.stopPropagation();
      const edit = opener.hasAttribute(SERIES_EDIT_ATTR);
      const rel = opener.getAttribute(edit ? SERIES_EDIT_ATTR : SERIES_MENU_ATTR) || "";
      const wasOpen = !!seriesMenu && seriesMenu.model.relPath === rel && seriesMenu.edit === edit;
      closeSeriesMenu(wasOpen ? "toggle" : "replace");
      if (!wasOpen && rel) openSeriesMenu(opener, rel, edit);
      return;
    }
    // Any other click dismisses, and leaves focus where the click put it.
    if (menuEl) closeSeriesMenu("outside");
  });
  document.addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement)?.closest?.<HTMLElement>("[data-series-form]");
    if (!form || !seriesMenu) return;
    e.preventDefault();
    const value = (form.querySelector("[data-series-input]") as HTMLInputElement | null)?.value.trim();
    if (!value) return;
    const { model } = seriesMenu;
    if (form.getAttribute("data-series-form") === "label") {
      // The label lives on the HEAD. With no labelled member yet, it lands on the
      // page the reader opened the editor from — which is the page they are
      // looking at, and which `seriesHead` then reads it off.
      void applySeriesWrites([
        { relPath: model.headRel || model.relPath, series: model.current, seriesLabel: value },
      ]);
      return;
    }
    void applySeriesWrites([{ relPath: model.relPath, series: value }]);
  });
}
