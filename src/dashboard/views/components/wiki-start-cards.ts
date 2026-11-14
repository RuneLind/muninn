/// <reference lib="dom" />
/**
 * Start-view cards for the /wiki reader: the "What's new" digest, the
 * index-coverage card, and the manual reindex trigger with its status poller.
 *
 * Lifted out of `wiki-browser.ts` unchanged (2026-08 architecture review, cut 1)
 * — same DOM ids/classes, same `/api/wiki/*` request shapes, same fetch/poll
 * timings.
 *
 * IMPORTED by `wiki-browser.ts`, never bundled on its own: the reader page loads
 * exactly one client bundle, and a second `makeBundledClientScript` entrypoint
 * would give the page two module states and two document listener sets — the
 * rule already written above the `share-dialog.ts` import.
 *
 * All three cards' module state lives HERE and stays private. The shell mounts
 * them with `mountStartCards()` (the block `renderStart` used to inline) and
 * re-enters through `loadDigest` / `loadIndexCoverage` / `startReindex` from its
 * click delegate. The two things the cards need from the shell — the on-wiki URL
 * builder and the relPath→page-name lookup over the live listing — are injected
 * once via `initStartCards`, so no `let` is shared across the file boundary.
 */

import { escHtml as esc } from "./escape.ts";
import { readActiveWikiName, withWikiParam } from "./wiki-param.ts";
import { localStore } from "./wiki-local-store.ts";
import {
  needKey,
  parseDone,
  writeDone,
  pollState,
  refreshRefusalText,
  WORK_MAP_DONE_KEY_PREFIX,
  STRIP_ROWS_SHOWN,
  stripKey,
  workCardHtml,
  type CardPage,
  type StripCell,
  type GhFoldedGroup,
  type StripView,
  type RefreshView,
  type WorkMapGetBody,
} from "./wiki-work-card.ts";
import type { WorkMapChecksBody } from "../../../wiki/work-map/gh-check.ts";
import type { AnyWorkMap } from "../../../wiki/work-map/join.ts";
import { declarationKey, isThemeMap } from "../../../wiki/work-map/join.ts";
import { handleInboxClick, inboxHtml, initInbox, loadInbox } from "./wiki-work-inbox.ts";
import { INITIAL_SLOT, isCardKind, nextSlot, slotLive, slotView, type SlotEvent, type SlotState } from "./wiki-start-slot.ts";

export interface StartCardsDeps {
  /** The shell's `withWiki`: append the active `wiki` param to a URL so every
   *  `/api/wiki/*` fetch stays on-wiki. */
  withWiki(url: string): string;
  /** Map a coverage relPath back to a wiki page name (or null when it doesn't
   *  resolve). A callback, not a copy: it reads the shell's live page listing. */
  resolvePageName(relPath: string): string | null;
  /** The listing's `workMap.runAt`, or null when the wiki has no work map —
   *  then the start view shows What's new. */
  workMapRunAt?(): number | null;
  /** The map, from the cache the rail and the effort page share (P4);
   *  `fresh` skips the cache (the ↻ poll). Absent, the card fetches itself.
   *  `body` is the parsed JSON, or null when it was not JSON. */
  fetchWorkMap?(fresh?: boolean): Promise<{ ok: boolean; status: number; body: unknown }>;
  /** Hand a map the ↻ poll fetched to the shared cache, so the rail and the
   *  effort page fold by the run the card shows. */
  adoptWorkMap?(body: WorkMapGetBody): void;
  /** The live listing the Your work card joins the map to. */
  pages?(): readonly CardPage[];
  /** The listing's `waitsCounted`: the strip's two wait cells apply here. */
  waitsCounted?(): boolean;
  /** The reader URL of a page, for a link's `href`. */
  hrefFor?(relPath: string): string;
  /** The reader URL of an effort page (P3); absent, effort names are text. */
  effortHref?(id: string): string;
}

/** Injected at boot by `initStartCards`.
 *
 *  `resolvePageName`'s default is deliberately inert rather than throwing: a
 *  card rendered before wiring degrades to "no link", never a broken reader.
 *
 *  `withWiki` gets no such default. An inert `(url) => url` drops `?wiki=`,
 *  which is not a degrade — the request silently succeeds against the DEFAULT
 *  wiki, so an un-wired card would report another wiki's coverage and its
 *  "Reindex now" would rebuild another wiki's collections. So the default
 *  re-derives the active wiki from the page itself, by the same rule the shell
 *  uses (`wiki-param.ts`), and is read per call — the global the shell reads at
 *  boot may not be there yet when a default runs. */
let deps: StartCardsDeps = {
  withWiki: (url) => withWikiParam(url, readActiveWikiName()),
  resolvePageName: () => null,
};

/** Wire the cards to the shell. Called once, from `boot()` in `wiki-browser.ts`. */
export function initStartCards(d: StartCardsDeps): void {
  deps = d;
  initInbox((focusSel, passive) => {
    const focus = focusSel ? { sel: focusSel } : undefined;
    if (!passive) return paintWorkCard(focus);
    // After an await: a press or a selection on the card holds it until `flushWaitingPaint`.
    const el = document.getElementById("wikiWorkCard");
    if (pointerHeld || (el && selectionTouchesCard(el))) paintWaiting = true;
    else if (focus) paintWorkCard(focus);
    else paintWorkCardIfChanged();
  });
  // `toggle` does not bubble: capture it, so a lane the reader opens or closes
  // is remembered across the card's repaints and the start view's rebuilds.
  if (!laneListening && typeof document !== "undefined" && typeof document.addEventListener === "function") {
    laneListening = true;
    document.addEventListener(
      "toggle",
      (e) => {
        const t = e.target as HTMLElement | null;
        const lane = t && typeof t.closest === "function" && t.closest("#wikiWorkCard") ? t.getAttribute("data-wm-lane") : null;
        if (lane) laneOpen.set(lane, (t as HTMLDetailsElement).open);
      },
      true,
    );
    // The reader's choice, ahead of `toggle`: a waiting paint can land between the
    // click and that event, and would rebuild the lane from the old state.
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target as HTMLElement | null;
        const summary = t && typeof t.closest === "function" ? t.closest("#wikiWorkCard details[data-wm-lane] > summary") : null;
        const lane = summary?.parentElement as HTMLDetailsElement | null | undefined;
        if (lane) laneOpen.set(lane.getAttribute("data-wm-lane") ?? "", !lane.open);
      },
      true,
    );
    document.addEventListener("selectionchange", flushWaitingPaint);
    // A release can miss this document (over an iframe, into a context menu), so a
    // hover with no button down and `contextmenu` end the press too.
    document.addEventListener("pointerdown", () => { pointerHeld = true; }, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerEnd, true);
    document.addEventListener("contextmenu", onPointerEnd, true);
    document.addEventListener("pointermove", (e) => { if (pointerHeld && e.buttons === 0) onPointerEnd(); }, true);
  }
}

/** Append the active `wiki` param to a URL — the shell's helper, via the deps. */
function withWiki(url: string): string {
  return deps.withWiki(url);
}
// ── "What's new" digest (start view) ──────────────────────────────────
interface WikiDigest {
  bullets: string;
  html: string;
  generatedAt: number;
  logMtimeMs: number;
  entryCount: number;
  fromDate: string;
  toDate: string;
  /** Batch mode: the syncs summarized, newest first. `count` is null when no
   *  commit could be read for the entry; `html` is the server-rendered page list. */
  syncs?: { date: string; title: string; count: number | null; html: string }[];
}
/** Cached rendered card body — reused across renderStart calls (tab switches).
 *  Retained across a failed refresh so a transient error never drops the last
 *  good digest. */
let whatsNewHtml: string | null = null;
/** Guards a single lazy first fetch and any in-flight refresh. */
let whatsNewLoading = false;
/** True only while a user-clicked refresh is in flight — lets a refresh supersede
 *  an in-flight auto-load, while still coalescing duplicate refreshes. */
let whatsNewRefreshInFlight = false;
/** Monotonic token so a superseded (older) fetch's late result is ignored. */
let whatsNewFetchId = 0;
/** Set once the first auto-load is dispatched; reset on failure so a later tab
 *  switch re-fetches instead of leaving the card permanently blank. */
let digestAttempted = false;

/** Build the card's inner HTML from a digest. `d.html` is server-rendered reader
 *  HTML (wikilinks already anchors) — safe to inject. */
function buildWhatsNewInner(d: WikiDigest): string {
  const range = d.fromDate === d.toDate ? d.toDate : d.fromDate + " – " + d.toDate;
  let gen = "";
  if (d.generatedAt) {
    try {
      gen = "generated " + new Date(d.generatedAt).toLocaleString();
    } catch {
      gen = "";
    }
  }
  return (
    '<div class="wiki-wn-head">' +
    '<span class="wiki-wn-title">What’s new</span>' +
    '<span class="wiki-wn-range">' + esc(range) + "</span>" +
    '<button class="wiki-wn-refresh" id="wikiWhatsNewRefresh" title="Regenerate digest">↻</button>' +
    "</div>" +
    '<div class="wiki-wn-bullets">' + d.html + "</div>" +
    buildChangedPages(d) +
    (gen ? '<div class="wiki-wn-gen">' + esc(gen) + "</div>" : "")
  );
}

/** Batch mode: one collapsed «N pages changed» list per sync that has pages. */
function buildChangedPages(d: WikiDigest): string {
  if (!d.syncs) return "";
  return d.syncs
    .filter((s) => s.count)
    .map(
      (s) =>
        '<details class="wiki-wn-changed"><summary>' +
        esc(s.count + (s.count === 1 ? " page" : " pages") + " changed · " + s.date + " " + s.title) +
        "</summary>" + s.html + "</details>",
    )
    .join("");
}

/** Paint an inline error + retry affordance, keeping the last good digest (if
 *  any) above it so a transient failure never blanks the card. The retry button
 *  carries the shared `.wiki-wn-refresh`-family class so the delegated click
 *  handler re-runs a refresh. */
function renderWhatsNewError(el: HTMLElement, message: string): void {
  el.innerHTML =
    (whatsNewHtml || "") +
    '<div class="wiki-wn-error"><span>' + esc(message) + "</span>" +
    '<button class="wiki-wn-retry" id="wikiWhatsNewRetry">Retry</button></div>';
  whatsNewLanded();
}

/** What's new's content changed: re-apply the slot, and take focus a card
 *  that left the slot handed over. */
function whatsNewLanded(): void {
  applySlot();
  if (!wnFocusPending) return;
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && !a.hasAttribute(PARKED_ATTR)) return;
  if (focusFirst(whatsNewFocusCandidates())) wnFocusPending = false;
}

/** Fetch (or refresh) the digest and paint the card. Hidden entirely when the
 *  wiki genuinely has no digest (no log.md / no bot, and no error); a failure
 *  keeps the previous digest and shows a retry instead. A user refresh may
 *  supersede an in-flight auto-load; duplicate loads/refreshes are coalesced. */
export function loadDigest(refresh: boolean): void {
  const el = document.getElementById("wikiWhatsNew");
  // A listed map holds the slot: no digest, so no model call (D1).
  if (!el || !slotView(slot, false).digestAllowed) return;
  // Coalesce: if a load is in flight, only an explicit refresh (and only when a
  // refresh isn't already running) may supersede it — everything else is dropped.
  if (whatsNewLoading && !(refresh && !whatsNewRefreshInFlight)) return;
  whatsNewLoading = true;
  if (refresh) whatsNewRefreshInFlight = true;
  const myId = ++whatsNewFetchId;
  const spin = document.getElementById("wikiWhatsNewRefresh");
  if (spin) {
    spin.classList.add("spinning");
    (spin as HTMLButtonElement).disabled = true;
  }
  let url = "/api/wiki/digest";
  if (refresh) url += "?refresh=1";
  fetch(withWiki(url))
    // The per-wiki read-only refusal is a 403 carrying `{digest: null, readonly:
    // true, reason}` — deliberately NOT the shared `error` key, since `error`
    // means "generation FAILED, keep the old digest and offer a retry" and a
    // policy refusal is neither. The STATUS is checked here explicitly rather
    // than inferred from the absent `error`, so the two sides are coupled by
    // something a reader can see from either file (route: `egressRefusal`'s
    // digest responder in `wiki-routes.ts`).
    .then((r) => r.json().then((body) => ({ status: r.status, body })))
    .then(({ status, body: data }: { status: number; body: { digest: WikiDigest | null; error?: string; readonly?: boolean } }) => {
      if (myId !== whatsNewFetchId) return; // superseded by a newer fetch
      whatsNewLoading = false;
      whatsNewRefreshInFlight = false;
      const cur = document.getElementById("wikiWhatsNew");
      if (!cur) return;
      if (status === 403 && data.readonly) {
        // Read-only wiki: there is no digest to be had, ever. Hide the card and
        // do NOT clear `digestAttempted` — a retry can only 403 again.
        whatsNewHtml = null;
        cur.innerHTML = "";
        wnFocusPending = false;
        applySlot();
        return;
      }
      if (!data.digest) {
        if (data.error) {
          // Generation failed (busy connector / timeout) — keep any prior digest
          // and offer a retry; allow a later tab switch to re-fetch.
          digestAttempted = false;
          renderWhatsNewError(cur, "Couldn’t refresh what’s new — " + data.error + ".");
          return;
        }
        // Genuine "no digest" (no log.md / no bot) — hide the card entirely.
        whatsNewHtml = null;
        cur.innerHTML = "";
        wnFocusPending = false;
        applySlot();
        return;
      }
      whatsNewHtml = buildWhatsNewInner(data.digest);
      cur.innerHTML = whatsNewHtml;
      whatsNewLanded();
    })
    .catch(() => {
      if (myId !== whatsNewFetchId) return;
      whatsNewLoading = false;
      whatsNewRefreshInFlight = false;
      // Transient network error — reset so a tab switch retries, keep prior data.
      digestAttempted = false;
      const cur = document.getElementById("wikiWhatsNew");
      if (cur) renderWhatsNewError(cur, "Couldn’t load what’s new.");
    });
}

// ── Index coverage card (start view) ──────────────────────────────────
export interface IndexCoverage {
  collections: string[];
  totalMd: number | null;
  indexed: number | null;
  missing: string[] | null;
  excludedByRule: string[] | null;
  ghosts: string[] | null;
  htmlPages: number;
  generatedAt: number;
  dirtyCount?: number;
  oldestDirtyMtimeMs?: number | null;
  error?: string;
  errors?: { source: string; collection: string; error: string }[];
}
/** Cached rendered card body — reused across renderStart calls (tab switches). */
let indexCovHtml: string | null = null;
/** Set once the first auto-load is dispatched; reset on failure so a later tab
 *  switch re-fetches instead of leaving the card permanently blank. */
let indexCovAttempted = false;
/** Guards a single lazy first fetch and any in-flight refresh (mirrors the
 *  What's-new digest guard) so a manual refresh racing the lazy load can't
 *  double-fetch. */
let indexCovLoading = false;
/** Monotonic token so a superseded (older) fetch's late result is ignored. */
let indexCovFetchId = 0;


/** Card head (title + Reindex-now + recompute buttons) + the reindex-status slot.
 *  Shared by the full and the "unavailable" card bodies so both carry the manual
 *  reindex trigger; the slot is (re)populated by `applyReindexUi` after any render
 *  so an in-flight reindex's status survives a cached-HTML reuse (tab switch). */
function indexCovHeadHtml(): string {
  return (
    '<div class="wiki-ix-head"><span class="wiki-ix-title">Index</span>' +
    '<button class="wiki-ix-reindex" id="wikiIndexReindex" title="Rebuild this wiki’s search index now">Reindex now</button>' +
    '<button class="wiki-ix-refresh" id="wikiIndexRefresh" title="Recompute coverage">↻</button></div>' +
    '<div class="wiki-ix-reindex-status" id="wikiIndexReindexStatus"></div>'
  );
}

/** A quiet "unavailable" card body — used on a degraded (errors[]) response or a
 *  network failure, so a transient hiccup never breaks the reader. Still-valid
 *  informational counts (htmlPages, and excludedByRule when the builder kept it)
 *  are rendered on the line so a failed collection listing doesn't discard the
 *  page-index facts the builder deliberately preserves. */
function indexCovUnavailableHtml(cov?: IndexCoverage): string {
  const extras: string[] = [];
  if (cov && cov.htmlPages) {
    extras.push(cov.htmlPages + " explainer" + (cov.htmlPages === 1 ? "" : "s") + " (not indexed)");
  }
  if (cov && cov.excludedByRule && cov.excludedByRule.length) {
    extras.push(cov.excludedByRule.length + " meta (not indexed)");
  }
  const tail = extras.length ? " · " + extras.join(" · ") : "";
  return (
    indexCovHeadHtml() +
    '<div class="wiki-ix-unavailable">Index status unavailable.' + esc(tail) + "</div>"
  );
}

/** A collapsible list of relPaths — missing pages link into the reader (when the
 *  relPath resolves to a page name), everything else is plain code. */
function indexCovList(cssClass: string, label: string, items: string[], linkable: boolean): string {
  let html =
    '<details class="wiki-ix-details ' + cssClass + '"><summary>' + items.length +
    " " + label + "</summary><ul class=\"wiki-ix-list\">";
  items.forEach((rp) => {
    // `resolvePageName` is the "can the reader open this?" test; the link itself
    // is keyed on the relPath we already hold, which names ONE page even where
    // stems collide (`resolvePageName` matches on that same relPath, so a name
    // coming back means this relPath resolves).
    const name = linkable ? deps.resolvePageName(rp) : null;
    html += name
      ? '<li><span class="wiki-ix-link" data-page="' + esc(name) + '" data-relpath="' + esc(rp) +
        '">' + esc(rp) + "</span></li>"
      : "<li><code>" + esc(rp) + "</code></li>";
  });
  return html + "</ul></details>";
}

/** "uncommitted changes: N" badge for the Index card summary — rendered ONLY when
 *  the wiki's git subtree is dirty (N > 0). Red when the oldest dirty file has
 *  been sitting > 24h (a stale-uncommitted signal the daily sweeper should have
 *  caught); amber otherwise. Absent when clean, so a clean card stays
 *  uncluttered. */
function dirtyBadge(cov: IndexCoverage): string {
  const n = cov.dirtyCount || 0;
  if (n <= 0) return "";
  const STALE_MS = 24 * 60 * 60 * 1000;
  const oldest = cov.oldestDirtyMtimeMs;
  const stale = typeof oldest === "number" && Date.now() - oldest > STALE_MS;
  return (
    ' · <span class="wiki-ix-dirty' + (stale ? " stale" : "") + '"' +
    (stale ? ' title="oldest uncommitted change is over a day old">' : ">") +
    "uncommitted changes: " + n + "</span>"
  );
}

/** Build the card's inner HTML from a fully-populated coverage response. */
function buildIndexCovInner(cov: IndexCoverage): string {
  const missing = cov.missing || [];
  const excludedByRule = cov.excludedByRule || [];
  const ghosts = cov.ghosts || [];
  const summary =
    "<b>" + cov.indexed + "</b> of <b>" + cov.totalMd + "</b> pages indexed" +
    " · <b>" + missing.length + "</b> missing" +
    " · <b>" + ghosts.length + "</b> ghost" + (ghosts.length === 1 ? "" : "s") +
    (excludedByRule.length ? " · " + excludedByRule.length + " meta (not indexed)" : "") +
    (cov.htmlPages
      ? " · " + cov.htmlPages + " explainer" + (cov.htmlPages === 1 ? "" : "s") + " (not indexed)"
      : "") +
    dirtyBadge(cov);
  let html = indexCovHeadHtml() + '<div class="wiki-ix-summary">' + summary + "</div>";
  if (missing.length) {
    html += indexCovList("", "missing (not in search)", missing, true);
  }
  if (excludedByRule.length) {
    html += indexCovList("meta", "meta (excluded by rule)", excludedByRule, true);
  }
  if (ghosts.length) {
    html += indexCovList("ghost", "ghost (indexed, no file)", ghosts, false);
  }
  return html;
}

/** Fetch (or refresh) the coverage overview and paint the card. Hidden entirely
 *  when the wiki has no backing collections (or is unknown / dir missing) — a
 *  no-corpus wiki has no index to report. A degraded/failed fetch leaves a quiet
 *  "unavailable" line, never breaks the reader. */
export function loadIndexCoverage(refresh: boolean): void {
  const el = document.getElementById("wikiIndexCard");
  if (!el) return;
  // Coalesce: a load already in flight is not double-fetched. An explicit refresh
  // is allowed through (it supersedes the in-flight fetch via the fetch-id token).
  if (indexCovLoading && !refresh) return;
  indexCovLoading = true;
  const myId = ++indexCovFetchId;
  const spin = document.getElementById("wikiIndexRefresh");
  if (spin) (spin as HTMLButtonElement).disabled = true;
  let url = "/api/wiki/index-coverage";
  if (refresh) url += "?refresh=1";
  fetch(withWiki(url))
    .then((r) => r.json())
    .then((cov: IndexCoverage) => {
      if (myId !== indexCovFetchId) return; // superseded by a newer fetch
      indexCovLoading = false;
      const cur = document.getElementById("wikiIndexCard");
      if (!cur) {
        // The user navigated away before this resolved — reset so the next
        // start-view render retries instead of leaving the card blank forever.
        indexCovAttempted = false;
        return;
      }
      // No wiki / no collections / dir missing — hide the card (no index to show).
      if (cov.error) {
        indexCovHtml = null;
        cur.innerHTML = "";
        cur.style.display = "none";
        return;
      }
      // Degraded (a collection listing failed) — coverage fields suppressed, but
      // the still-valid informational counts (htmlPages / excludedByRule) render.
      if (cov.totalMd === null || cov.indexed === null) {
        indexCovHtml = indexCovUnavailableHtml(cov);
        cur.innerHTML = indexCovHtml;
        cur.style.display = "";
        applyReindexUi();
        return;
      }
      indexCovHtml = buildIndexCovInner(cov);
      cur.innerHTML = indexCovHtml;
      cur.style.display = "";
      applyReindexUi();
    })
    .catch(() => {
      if (myId !== indexCovFetchId) return;
      indexCovLoading = false;
      // Transient network error — reset so a tab switch retries, show unavailable.
      indexCovAttempted = false;
      const cur = document.getElementById("wikiIndexCard");
      if (cur) {
        cur.innerHTML = indexCovUnavailableHtml();
        cur.style.display = "";
        applyReindexUi();
      }
    });
}

// ── Manual reindex trigger (Index card) ───────────────────────────────
interface ReindexCollResult {
  name: string;
  state: "started" | "already-running" | "error";
  error?: string;
}
interface ReindexResponse {
  collections: ReindexCollResult[];
  error?: string;
}
interface ReindexStatusColl {
  name: string;
  status: "idle" | "running" | "succeeded" | "failed" | "unknown";
  error?: string;
}
interface ReindexStatusResponse {
  collections: ReindexStatusColl[];
  error?: string;
}

/** True while a reindex POST + its status poll cycle is in flight — drives the
 *  button's disabled state (re-applied after every card render). */
let reindexActive = false;
/** Pending status-poll timer handle (0 = none). */
let reindexPollTimer = 0;
/** Consecutive poll-fetch failures — give up quietly after 3 (gardener-strip
 *  tolerance) so a transient huginn blip doesn't wedge the poll forever. */
let reindexPollFailures = 0;
/** Persisted status markup, re-injected into the card's slot after any render so
 *  an in-flight reindex survives a cached-HTML reuse (tab switch). */
let reindexStatusHtml = "";
/** True when a poll bailed because the card left the DOM mid-run (user navigated
 *  to a page) — the next card render resumes polling so the UI never freezes on
 *  a stale "rebuilding…" for a run that has long since settled. */
let reindexAbandoned = false;
/** When the last run settled (0 = never / still running). Settled rows stay
 *  visible briefly, then a later card render clears them instead of repainting
 *  an old "rebuilt" forever. */
let reindexSettledAt = 0;
const REINDEX_POLL_MS = 3000;
const REINDEX_MAX_POLL_FAILURES = 3;
/** How long a settled run's rows stay on the card before a later render clears
 *  them. Exported so the test asserts the boundary against this value rather
 *  than a copied literal (and so it can pin `Date.now` around it). */
export const REINDEX_SETTLED_TTL_MS = 60_000;

/** Set the persisted reindex-status markup and paint it into the live slot. */
function setReindexStatus(html: string): void {
  reindexStatusHtml = html;
  const el = document.getElementById("wikiIndexReindexStatus");
  if (el) el.innerHTML = html;
}

/** Re-apply the persisted status + button-disabled state after any card (re)render
 *  so a cached-HTML reuse (tab switch) or a post-settle coverage refresh doesn't
 *  drop an in-flight reindex's status or leave the button in the wrong state. */
export function applyReindexUi(): void {
  // A run abandoned mid-poll (card left the DOM) resumes now that the card is
  // back — mark active again here, poll immediately below after painting. Only
  // the abandoned flag triggers a resume, so a tab-switch repaint during a live
  // poll cycle can never start a second concurrent poll chain.
  const resume = reindexAbandoned;
  if (resume) {
    reindexAbandoned = false;
    reindexActive = true;
    reindexPollFailures = 0;
  }
  // Settled rows outlive their usefulness after a minute — clear instead of
  // repainting an old "rebuilt" on every later tab switch.
  if (
    !reindexActive &&
    reindexStatusHtml &&
    reindexSettledAt &&
    Date.now() - reindexSettledAt > REINDEX_SETTLED_TTL_MS
  ) {
    reindexStatusHtml = "";
    reindexSettledAt = 0;
  }
  const el = document.getElementById("wikiIndexReindexStatus");
  if (el) el.innerHTML = reindexStatusHtml;
  const btn = document.getElementById("wikiIndexReindex") as HTMLButtonElement | null;
  if (btn) btn.disabled = reindexActive;
  // An immediate poll repaints reality (and settles + refreshes coverage if the
  // rebuild finished while we were away).
  if (resume) pollReindexStatus();
}

/** Stop the poll cycle and re-enable the button (leaves the last status visible
 *  briefly — cleared after `REINDEX_SETTLED_TTL_MS` by `applyReindexUi`). */
function stopReindex(): void {
  if (reindexPollTimer) {
    clearTimeout(reindexPollTimer);
    reindexPollTimer = 0;
  }
  reindexActive = false;
  reindexAbandoned = false;
  reindexSettledAt = Date.now();
  const btn = document.getElementById("wikiIndexReindex") as HTMLButtonElement | null;
  if (btn) btn.disabled = false;
}

/** Render a per-collection status list into the card's reindex slot. */
function renderReindexRows(rows: { name: string; text: string; cls: string }[]): void {
  if (!rows.length) {
    setReindexStatus("");
    return;
  }
  let html = '<div class="wiki-ix-reindex-list">';
  rows.forEach((r) => {
    html +=
      '<div class="wiki-ix-reindex-row ' + r.cls + '"><code>' + esc(r.name) + "</code>" +
      "<span>" + esc(r.text) + "</span></div>";
  });
  setReindexStatus(html + "</div>");
}

/** Row text/colour for a POST trigger result. `already-running` is honest, not an
 *  error — huginn's CAS refused because a rebuild (often the nightly job) is live. */
function reindexResultRow(r: ReindexCollResult): { name: string; text: string; cls: string } {
  if (r.state === "started") return { name: r.name, text: "rebuild started", cls: "running" };
  if (r.state === "already-running") {
    return { name: r.name, text: "a rebuild is already in progress — watching it", cls: "running" };
  }
  return { name: r.name, text: "error" + (r.error ? ": " + r.error : ""), cls: "error" };
}

/** Row text/colour for a `/update-status` poll entry. A `failed` status surfaces
 *  huginn's error text — the first visibility into a silently failing nightly job. */
function reindexStatusRow(c: ReindexStatusColl): { name: string; text: string; cls: string } {
  switch (c.status) {
    case "running":
      return { name: c.name, text: "rebuilding…", cls: "running" };
    case "succeeded":
      return { name: c.name, text: "rebuilt", cls: "ok" };
    case "idle":
      return { name: c.name, text: "idle", cls: "ok" };
    case "failed":
      return { name: c.name, text: "failed" + (c.error ? ": " + c.error : ""), cls: "error" };
    default:
      return {
        name: c.name,
        text: "status unavailable" + (c.error ? " (" + c.error + ")" : ""),
        cls: "warn",
      };
  }
}

/** Schedule the next status poll (3 s), replacing any pending one. */
function scheduleReindexPoll(): void {
  if (reindexPollTimer) clearTimeout(reindexPollTimer);
  reindexPollTimer = window.setTimeout(pollReindexStatus, REINDEX_POLL_MS);
}

/** Poll each collection's rebuild status; stop (and refresh coverage) once none
 *  is still `running`. Survives the card disappearing mid-poll (navigate away):
 *  bail quietly, unwedge the flags, let the next start-view render show reality. */
function pollReindexStatus(): void {
  reindexPollTimer = 0;
  if (!document.getElementById("wikiIndexCard")) {
    // Card left the DOM (user opened a page) — mark abandoned so the next card
    // render resumes the poll instead of freezing on a stale "rebuilding…".
    reindexActive = false;
    reindexAbandoned = true;
    return;
  }
  fetch(withWiki("/api/wiki/reindex-status"))
    .then((r) => r.json())
    .then((data: ReindexStatusResponse) => {
      if (!document.getElementById("wikiIndexCard")) {
        reindexActive = false;
        reindexAbandoned = true;
        return;
      }
      if (data.error) {
        // Wiki/collection resolution error mid-run (shouldn't happen) — stop.
        setReindexStatus('<div class="wiki-ix-reindex-msg">' + esc(data.error) + "</div>");
        stopReindex();
        return;
      }
      reindexPollFailures = 0;
      const colls = data.collections || [];
      renderReindexRows(colls.map(reindexStatusRow));
      if (colls.some((c) => c.status === "running")) {
        scheduleReindexPoll();
      } else {
        // Settled — re-fetch coverage so missing/ghosts reflect the fresh index.
        // The final per-collection statuses (incl. any `failed` error) ride along
        // via applyReindexUi when the rebuilt card paints.
        stopReindex();
        loadIndexCoverage(true);
      }
    })
    .catch(() => {
      if (!document.getElementById("wikiIndexCard")) {
        reindexActive = false;
        reindexAbandoned = true;
        return;
      }
      reindexPollFailures += 1;
      if (reindexPollFailures >= REINDEX_MAX_POLL_FAILURES) {
        setReindexStatus(
          '<div class="wiki-ix-reindex-msg">Lost track of the rebuild — recompute with ↻.</div>',
        );
        stopReindex();
      } else {
        scheduleReindexPoll();
      }
    });
}

/** Kick a manual reindex: POST the trigger, render per-collection state, then poll
 *  until every collection settles. Button is disabled for the whole cycle. */
export function startReindex(): void {
  if (reindexActive || !document.getElementById("wikiIndexCard")) return;
  reindexActive = true;
  reindexPollFailures = 0;
  const btn = document.getElementById("wikiIndexReindex") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setReindexStatus('<div class="wiki-ix-reindex-msg">Starting reindex…</div>');
  fetch(withWiki("/api/wiki/reindex"), { method: "POST" })
    .then((r) => r.json())
    .then((data: ReindexResponse) => {
      if (!document.getElementById("wikiIndexCard")) {
        reindexActive = false;
        return;
      }
      if (data.error) {
        setReindexStatus(
          '<div class="wiki-ix-reindex-msg">Reindex unavailable — ' + esc(data.error) + ".</div>",
        );
        stopReindex();
        return;
      }
      const colls = data.collections || [];
      renderReindexRows(colls.map(reindexResultRow));
      // Poll while any collection may still be rebuilding (started, or an
      // already-running nightly job we're now watching). All-errored ⇒ nothing to
      // watch: re-enable and leave the errors visible.
      if (colls.some((r) => r.state === "started" || r.state === "already-running")) {
        scheduleReindexPoll();
      } else {
        stopReindex();
      }
    })
    .catch(() => {
      if (!document.getElementById("wikiIndexCard")) {
        reindexActive = false;
        return;
      }
      setReindexStatus('<div class="wiki-ix-reindex-msg">Couldn’t start reindex.</div>');
      stopReindex();
    });
}

/**
 * Attach both start cards to a freshly-rendered start view.
 *
 * Reuses the cached render when we have one (tab switches re-run the shell's
 * `renderStart`), otherwise lazily fetches once — so neither card ever blocks
 * the page list from rendering. The reindex status/button state is re-applied
 * on the cached-HTML path, since a run in flight must survive a tab switch.
 */
export function mountStartCards(): void {
  const wc = document.getElementById("wikiWorkCard");
  // A wiki with a work map shows the Your work card and never asks for the
  // digest, so What's new's model call stops there (D1: no map ⇒ What's new).
  syncCard({ type: "mount", runAt: wc && deps.workMapRunAt ? deps.workMapRunAt() : null, hasBody: workBody !== null });
  const ix = document.getElementById("wikiIndexCard");
  if (ix) {
    if (indexCovHtml) {
      ix.innerHTML = indexCovHtml;
      ix.style.display = "";
      applyReindexUi();
    } else if (!indexCovAttempted) {
      indexCovAttempted = true;
      loadIndexCoverage(false);
    }
  }
}

// ── Your work card (start view, plan muninn-wiki-work-map P2) ─────────
/** Which card holds the start slot (`wiki-start-slot.ts`). Every path changes
 *  it through `transition`, and `applySlot` alone sets the two cards' visibility. */
let slot: SlotState = INITIAL_SLOT;
/** The last GET body with a map; reused across start-view renders. */
let workBody: (WorkMapGetBody & { map: AnyWorkMap }) | null = null;
let workRefresh: RefreshView = { phase: "idle" };
let workPollTimer: ReturnType<typeof setTimeout> | null = null;
/** The generation of the GET in flight, if any. */
let workLoadGen: number | null = null;
/** Lanes the reader opened or closed, by lane id; for the page's life. */
const laneOpen = new Map<string, boolean>();
let laneListening = false;
/** Needs-you items whose why the reader opened, by `needKey`; for the page's life. */
const whyOpen = new Set<string>();
/** The strip's open cell and list: held here, so a repaint keeps them. */
let stripView: StripView = { open: null, expanded: false };
/** Cards whose resize re-checks which whys are clamped. */
const whyObserved = new WeakSet<HTMLElement>();

/** A card control to re-focus after a repaint, by what survives one. */
type FocusKey = { sel: string } | { doneAt: number } | { why: string } | { link: string; nth: number } | { href: string; nth: number } | { heading: true };
/** A control that could not take focus back (↻ disabled while running): focus
 *  waits on the card's heading, and the next paint tries the control again. */
let pendingFocus: FocusKey | null = null;
/** Marks an element focus waits on for something better. */
const PARKED_ATTR = "data-wm-parked";
/** The card left the slot with focus inside it: What's new takes focus when it paints. */
let wnFocusPending = false;

/** How often ↻ polls the GET, and for how long before it stops waiting. */
const WORK_POLL_MS = 5_000;
const WORK_POLL_MAX_MS = 20 * 60_000;
/** Consecutive failed poll GETs before ↻ stops waiting. */
const WORK_POLL_MAX_FAILURES = 3;
/** The wait before the first GET's one network retry, so a dev-server restart
 *  or a wake-from-sleep blip can pass. */
const WORK_GET_RETRY_MS = 1_500;

function doneStorageKey(): string {
  return WORK_MAP_DONE_KEY_PREFIX + readActiveWikiName();
}
/** The done store per key when storage fails: a dismiss then lasts the page's life. */
const doneMemory = new Map<string, string | null>();
function readDoneRaw(): string | null {
  const key = doneStorageKey();
  if (doneMemory.has(key)) return doneMemory.get(key)!;
  try {
    return localStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeDoneRaw(v: string | null): void {
  const key = doneStorageKey();
  try {
    const store = localStore();
    if (!store) throw new Error("no storage");
    if (v === null) store.removeItem(key);
    else store.setItem(key, v);
    doneMemory.delete(key);
  } catch {
    doneMemory.set(key, v);
  }
}

/** Feed the slot one event. A card leaving the slot drops its in-flight work
 *  (a new generation) and hands focus it held to What's new. */
function transition(e: SlotEvent): void {
  const prev = slot;
  const wc = document.getElementById("wikiWorkCard");
  const focusInCard = !!wc && typeof wc.contains === "function" && wc.contains(document.activeElement);
  slot = nextSlot(prev, e);
  if (slot.gen !== prev.gen) {
    workBody = null;
    workRefresh = { phase: "idle" };
    pendingFocus = null;
    if (workPollTimer) clearTimeout(workPollTimer);
    workPollTimer = null;
    resetWorkChecks();
  }
  if (isCardKind(slot.kind)) wnFocusPending = false;
  applySlot();
  if (focusInCard && !slotView(slot, false).card) focusAfterCardLeft();
}

/** The one place the slot's visibility is set. What's new is filled (cache, or
 *  one first load) only where the slot allows a digest. */
function applySlot(): void {
  const wc = document.getElementById("wikiWorkCard");
  const wn = document.getElementById("wikiWhatsNew");
  if (wn && slotView(slot, false).digestAllowed && wn.innerHTML === "") {
    if (whatsNewHtml) wn.innerHTML = whatsNewHtml;
    else if (!digestAttempted) {
      digestAttempted = true;
      loadDigest(false);
    }
  }
  const v = slotView(slot, !!wn && wn.innerHTML !== "");
  if (wc) wc.style.display = v.card ? "" : "none";
  if (wn) wn.style.display = v.whatsNew ? "" : "none";
}

/** A listing event: transition, then paint or load what the new state needs.
 *  An adopt that changes nothing touches nothing. */
function syncCard(e: SlotEvent & { type: "mount" | "adopt" }): void {
  const prev = slot;
  transition(e);
  // A start view after a check that left something unread asks again: the remedy
  // may have been followed. Never on a repaint, so it cannot loop, and at most once
  // a minute, since every tab click mounts and each ask can spawn `gh`.
  if (e.type === "mount" && workChecks && checksLeftUnread(workChecks) && Date.now() - workChecks.startedAt >= WORK_CHECKS_REASK_MS) workChecks = { ...workChecks, fetchedAt: 0 };
  if (e.type === "adopt" && slot === prev) {
    // The run did not move, but a page may have declared an effort since it
    // (P6): re-join, and only when something a join reads changed, so an
    // ordinary adopt leaves the card's markup alone. A themes card has no strip.
    if (slot.kind === "card" && workBody && (currentDeclarationKey(workBody.map.runAtMs) !== paintedDeclarationKey || (!isThemeMap(workBody.map) && currentStripKey() !== paintedStripKey))) paintWorkCard(undefined, true);
    return;
  }
  if (slot.kind === "card") paintWorkCard();
  if ((slot.kind === "card" || slot.kind === "card-loading") && (!workBody || workBody.map.runAtMs < slot.runAt!)) loadWorkMap();
}

/** `declarationKey` of the listing the card last painted from (P6). */
let paintedDeclarationKey: string | null = null;
function currentDeclarationKey(runAt: number): string {
  return declarationKey(deps.pages ? deps.pages() : [], runAt);
}
/** `stripKey` of the listing the card last painted from: the strip counts the live listing. */
let paintedStripKey: string | null = null;
function currentStripKey(): string {
  return stripKey(deps.pages ? deps.pages() : [], deps.waitsCounted ? deps.waitsCounted() : false);
}

/** The adopt path's half of `mountStartCards`: the card follows the listing,
 *  and the Index card is not touched. */
export function refreshWorkCardFromListing(): void {
  if (!document.getElementById("wikiWorkCard")) return;
  syncCard({ type: "adopt", runAt: deps.workMapRunAt ? deps.workMapRunAt() : null, hasBody: workBody !== null });
}

/** The Needs-you keys marked done on the card for run `runAt` (the effort
 *  page shows the same items, so it reads the same store). */
export function workMapDoneSet(runAt: number): Set<string> {
  return parseDone(readDoneRaw(), runAt);
}

// ── Focus: one resolver, an ordered chain of visible, focusable targets ──
function focusable(t: HTMLElement | null | undefined): t is HTMLElement {
  if (!t || !t.isConnected || t.hidden || (t as HTMLButtonElement).disabled || t.getClientRects().length === 0) return false;
  // Inside a shut fold an element still has client rects; only this call says it is skipped.
  return typeof t.checkVisibility !== "function" || t.checkVisibility();
}

/** Focus `t`, giving a non-control (a heading, a why's text) `tabindex=-1` when
 *  it needs one, and taking it back when focus still did not land: a link left
 *  with it drops out of the tab order. */
function focusOn(t: HTMLElement): boolean {
  t.focus({ preventScroll: true });
  if (document.activeElement !== t && !t.hasAttribute("tabindex")) {
    t.setAttribute("tabindex", "-1");
    t.focus({ preventScroll: true });
    if (document.activeElement !== t) t.removeAttribute("tabindex");
  }
  return document.activeElement === t;
}

/** Focus the first candidate that is present, visible and focusable. */
function focusFirst(candidates: readonly (HTMLElement | null | undefined)[]): HTMLElement | null {
  for (const c of candidates) if (focusable(c) && focusOn(c)) return c;
  return null;
}

function whatsNewFocusCandidates(): (HTMLElement | null)[] {
  const wn = document.getElementById("wikiWhatsNew");
  return [wn?.querySelector<HTMLElement>(".wiki-wn-title") ?? null, wn?.querySelector<HTMLElement>("#wikiWhatsNewRetry") ?? null];
}

/** The card left the slot while it held focus: What's new's heading, else the
 *  start view's heading until What's new paints. */
function focusAfterCardLeft(): void {
  if (focusFirst(whatsNewFocusCandidates())) return;
  wnFocusPending = true;
  focusFirst([document.querySelector<HTMLElement>(".wiki-start h1")])?.setAttribute(PARKED_ATTR, "");
}

/** The targets for `key`, best first; every chain ends at the card's heading. */
function focusCandidates(el: HTMLElement, key: FocusKey): (HTMLElement | null | undefined)[] {
  const heading = el.querySelector<HTMLElement>(".wiki-wn-title");
  if ("doneAt" in key) {
    // By position, not key: two items can share a key and leave together.
    const done = Array.from(el.querySelectorAll<HTMLElement>("[data-wm-done]")).filter(focusable);
    const at = (b: HTMLElement) => Number(b.getAttribute("data-wm-done"));
    const prev = done.filter((b) => at(b) < key.doneAt);
    return [done.find((b) => at(b) >= key.doneAt), prev[prev.length - 1], el.querySelector<HTMLElement>("#wikiWorkMapRestore"), heading];
  }
  if ("why" in key) {
    const btn = Array.from(el.querySelectorAll<HTMLElement>("[data-wm-why]")).find((b) => b.getAttribute("data-wm-why") === key.why);
    return [btn, btn?.parentElement?.querySelector<HTMLElement>(".wiki-wm-why-text"), heading];
  }
  // A control in a shut board column takes no focus: the column's head does.
  // A themes lane is not one: there focus parks on the heading and the next paint retries.
  const orFold = (t: HTMLElement | null | undefined) => [t, t?.closest(".wiki-wm-col")?.querySelector<HTMLElement>(":scope > summary"), heading];
  if ("sel" in key) return orFold(el.querySelector<HTMLElement>(key.sel));
  if ("link" in key) return orFold(cardLinks(el, key.link)[key.nth]);
  if ("href" in key) return orFold(hrefLinks(el, key.href)[key.nth]);
  return [heading];
}

/** The focused control inside the card, to re-focus after a repaint. */
function focusedCardControl(el: HTMLElement): FocusKey | null {
  const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (!active || active === el || typeof el.contains !== "function" || !el.contains(active)) return null;
  if (active.id) return { sel: "#" + active.id };
  const doneAt = active.getAttribute("data-wm-done");
  if (doneAt !== null) return { doneAt: Number(doneAt) };
  const whyKey = active.getAttribute("data-wm-why") ?? (active.classList.contains("wiki-wm-why-text") ? active.parentElement?.querySelector("[data-wm-why]")?.getAttribute("data-wm-why") : null);
  if (whyKey != null) return { why: whyKey };
  // An effort id matches EFFORT_ID_RE, so it needs no escaping in a selector.
  // A themes card names a theme in its lane and in 0..N Connected rows: the
  // key picks the same copy, a Connected one by its row's pair.
  const effort = active.getAttribute("data-effort-link");
  if (effort !== null) {
    if (!active.hasAttribute("data-wm-conn-link")) return { sel: `[data-effort-link="${effort}"]:not([data-wm-conn-link])` };
    const pair = active.parentElement?.getAttribute("data-wm-conn");
    if (pair != null) return { sel: `[data-wm-conn="${pair}"] [data-effort-link="${effort}"]` };
  }
  const rel = active.getAttribute("data-relpath");
  const cell = active.getAttribute("data-wm-cell");
  if (cell !== null) return { sel: `[data-wm-cell="${cell}"]` };
  if (active.hasAttribute("data-wm-drill-more")) return { sel: "[data-wm-drill-more]" };
  const ghMore = active.getAttribute("data-wm-gh-more");
  if (ghMore !== null) return { sel: `[data-wm-gh-more="${ghMore}"]` };
  if (rel !== null) return { link: rel, nth: cardLinks(el, rel).indexOf(active) };
  // A link off the wiki, such as a PR in the GitHub list, has no page to key on.
  const href = active.tagName === "A" ? active.getAttribute("href") : null;
  if (href !== null) return { href, nth: hrefLinks(el, href).indexOf(active) };
  if (active.classList.contains("wiki-wn-title")) return { heading: true };
  const lane = active.tagName === "SUMMARY" ? active.parentElement?.getAttribute("data-wm-lane") : null;
  return lane ? { sel: `[data-wm-lane="${lane}"] > summary` } : null;
}

function cardLinks(el: HTMLElement, rel: string): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("a[data-relpath]")).filter((a) => a.getAttribute("data-relpath") === rel);
}

function hrefLinks(el: HTMLElement, href: string): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("a[href]:not([data-relpath])")).filter((a) => a.getAttribute("href") === href);
}

/** Re-focus `key` in the freshly painted card, by the fallback chain. A control
 *  still there but disabled leaves focus parked on the heading for the next paint. */
function resolveFocus(el: HTMLElement, key: FocusKey): void {
  const t = focusFirst(focusCandidates(el, key));
  const wanted = "sel" in key ? el.querySelector<HTMLElement>(key.sel) : null;
  if (t && wanted && t !== wanted && !wanted.closest(".wiki-wm-col")) {
    pendingFocus = key;
    t.setAttribute(PARKED_ATTR, "");
  }
}

/** The markup the card last got: a checks answer or an adopt that renders the same leaves the DOM alone. */
let paintedCardHtml: string | null = null;

/** A checks answer's paint: a selection or a focus inside the card outlives an answer that changes nothing,
 *  and an answer that changes something waits until the reader's selection ends. An adopt whose keys moved
 *  paints the same way. */
function paintWorkCardIfChanged(): void {
  paintWorkCard(undefined, true);
}

/** Does the reader have text selected that touches the card? `innerHTML` would wipe it. */
function selectionTouchesCard(el: HTMLElement): boolean {
  const sel = globalThis.getSelection?.();
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.getRangeAt(0).intersectsNode(el);
}

let paintWaiting = false;
let pointerHeld = false;

/** Try what waited again, once the pointer is up: a drag can pass back over its start and collapse its selection,
 *  and a paint then would end the drag. `paintWorkCard` waits on if a selection still touches the card. */
function flushWaitingPaint(): void {
  if (paintWaiting && !pointerHeld) paintWorkCardIfChanged();
}

/** After any click: the browser dispatches it right after this event, ahead of a timer. */
function onPointerEnd(): void {
  pointerHeld = false;
  if (paintWaiting) setTimeout(flushWaitingPaint, 0);
}

function pageHref(rel: string): string {
  return deps.hrefFor ? deps.hrefFor(rel) : withWiki("/wiki?relPath=" + encodeURIComponent(rel));
}

function paintWorkCard(override?: FocusKey, onlyIfChanged = false): void {
  const el = document.getElementById("wikiWorkCard");
  if (!el || !workBody || slot.kind !== "card") return;
  const runAt = workBody.map.runAtMs;
  const pages = deps.pages ? deps.pages() : [];
  const now = Date.now();
  const html = workCardHtml({
    body: workBody,
    pages,
    now,
    done: parseDone(readDoneRaw(), runAt),
    openWhy: whyOpen,
    hrefFor: pageHref,
    ...(deps.effortHref ? { effortHref: deps.effortHref } : {}),
    refresh: workRefresh,
    waitsCounted: deps.waitsCounted ? deps.waitsCounted() : false,
    strip: stripView,
    checks: {
      body: workChecks?.body ?? null,
      answerRunAt: workChecks?.answerRunAt ?? null,
      failed: !!workChecks?.failed,
      retrying: workChecksTimer !== null || workChecksGen === slot.gen,
    },
  }) + inboxHtml(pageHref, now);
  // Before the early return: this listing has been rendered, so the next adopt
  // compares against it and does not render the card again for the same keys.
  paintedDeclarationKey = declarationKey(pages, runAt);
  paintedStripKey = currentStripKey();
  // A held press waits too: a drag back over its start collapses the selection, and a paint ends the drag.
  if (onlyIfChanged && (paintedCardHtml === html || pointerHeld || selectionTouchesCard(el))) {
    paintWaiting = paintedCardHtml !== html;
    ensureWorkChecks();
    return;
  }
  paintWaiting = false;
  const active = document.activeElement as HTMLElement | null;
  const lost = !active || active === document.body;
  const parked = !!active && active.hasAttribute(PARKED_ATTR) && el.contains(active);
  const refocus = override ?? (parked ? pendingFocus : null) ?? focusedCardControl(el) ?? (lost ? pendingFocus : null);
  pendingFocus = null;
  el.innerHTML = html;
  paintedCardHtml = html;
  ensureWorkChecks();
  if (typeof el.querySelectorAll === "function") {
    el.querySelectorAll<HTMLDetailsElement>("details[data-wm-lane]").forEach((d) => {
      const open = laneOpen.get(d.getAttribute("data-wm-lane") ?? "");
      if (open !== undefined) d.open = open;
    });
  }
  applySlot();
  // Before focus: a why control hidden here must not be the focus target.
  syncWhyControls(el);
  if (typeof ResizeObserver !== "undefined" && !whyObserved.has(el)) {
    whyObserved.add(el);
    new ResizeObserver(() => syncWhyControls(el)).observe(el);
  }
  if (refocus) resolveFocus(el, refocus);
}

/** Shows a closed why's expand control only while its text is clamped; an open
 *  why always shows "less". A focused control that hides hands focus to its text. */
function syncWhyControls(el: HTMLElement): void {
  if (typeof el.querySelectorAll !== "function") return;
  el.querySelectorAll<HTMLElement>(".wiki-wm-why:not(.open)").forEach((why) => {
    const text = why.querySelector<HTMLElement>(".wiki-wm-why-text");
    const more = why.querySelector<HTMLElement>(".wiki-wm-why-more");
    if (!text || !more) return;
    const hadFocus = document.activeElement === more;
    more.hidden = text.scrollHeight <= text.clientHeight;
    if (hadFocus && more.hidden) focusFirst([text]);
  });
}

/** Paint the card's 5xx error with its Retry, keeping focus on Retry. */
function paintWorkError(el: HTMLElement): void {
  const refocus = focusedCardControl(el);
  el.innerHTML =
    '<div class="wiki-wn-head"><span class="wiki-wn-title">Your work</span></div>' +
    '<div class="wiki-wn-error"><span>Couldn’t load the work map.</span>' +
    '<button class="wiki-wn-retry" id="wikiWorkMapRetry">Retry</button></div>';
  applySlot();
  if (refocus) resolveFocus(el, refocus);
}

// ── The GitHub check (plan muninn-wiki-your-work-board, P2) ───────────
/** The last answer; it repaints through `paintWorkCard`, so `stripKey` stays out of it. */
let workChecks: {
  body: WorkMapChecksBody | null;
  fetchedAt: number;
  /** When the fetch behind this answer started. */
  startedAt: number;
  /** The map of the last fetch, whatever it answered. */
  runAt: number;
  /** The map `body` answered for: a failed fetch keeps the older pair. */
  answerRunAt: number | null;
  failed: boolean;
} | null = null;
/** The generation of the fetch in flight, if any. */
let workChecksGen: number | null = null;
let workChecksTimer: ReturnType<typeof setTimeout> | null = null;
/** Fetches made because the last answer said `refreshing`. */
let workChecksRetries = 0;

/** An answer older than this is fetched again when the start view renders. */
const WORK_CHECKS_TTL_MS = 60 * 60_000;
/** An answer that left something unread is asked again this long after its fetch started. */
const WORK_CHECKS_REASK_MS = 60_000;
const WORK_CHECKS_RETRY_MS = 15_000;
const WORK_CHECKS_RETRIES_MAX = 3;

function checksLeftUnread(c: { body: WorkMapChecksBody | null; failed: boolean }): boolean {
  if (c.failed || c.body?.refreshing) return true;
  const reason = c.body?.notChecked?.reason;
  return (!!reason && reason !== "disabled") || (c.body?.unchecked ?? 0) > 0;
}

function resetWorkChecks(): void {
  workChecks = null;
  workChecksGen = null;
  workChecksRetries = 0;
  if (workChecksTimer) clearTimeout(workChecksTimer);
  workChecksTimer = null;
}

/** Fetch unless an answer for this map is young enough. A new map's marks are
 *  the server's to compute, so a new `runAt` fetches at once. */
function ensureWorkChecks(): void {
  if (!workBody || isThemeMap(workBody.map) || workChecksGen === slot.gen || workChecksTimer) return;
  if (workChecks && workChecks.runAt === workBody.map.runAtMs && Date.now() - workChecks.fetchedAt < WORK_CHECKS_TTL_MS) return;
  workChecksRetries = 0;
  fetchWorkChecks();
}

function fetchWorkChecks(): void {
  if (!workBody) return;
  const gen = slot.gen;
  const runAt = workBody.map.runAtMs;
  const startedAt = Date.now();
  workChecksGen = gen;
  fetch(withWiki("/api/wiki/work-map/checks"))
    .then(async (res) => {
      const body = (await res.json().catch(() => null)) as WorkMapChecksBody | null;
      if (!res.ok || !body || typeof body.checked !== "number") throw new Error("HTTP " + res.status);
      return body;
    })
    .then((body) => {
      if (!slotLive(slot, gen)) return;
      workChecksGen = null;
      workChecks = { body, fetchedAt: Date.now(), startedAt, runAt, answerRunAt: runAt, failed: false };
      if (body.refreshing && workChecksRetries < WORK_CHECKS_RETRIES_MAX) {
        workChecksRetries++;
        workChecksTimer = setTimeout(() => {
          workChecksTimer = null;
          fetchWorkChecks();
        }, WORK_CHECKS_RETRY_MS);
      }
      paintWorkCardIfChanged();
    })
    .catch(() => {
      if (!slotLive(slot, gen)) return;
      workChecksGen = null;
      workChecks = { body: workChecks?.body ?? null, fetchedAt: Date.now(), startedAt, runAt, answerRunAt: workChecks?.answerRunAt ?? null, failed: true };
      paintWorkCardIfChanged();
    });
}

/** A GET this instance answered without a map body: an HTTP error, or a 2xx
 *  whose body is not a JSON object (a proxy's login page). */
class WorkMapHttpError extends Error {
  constructor(readonly status: number) {
    super("HTTP " + status);
  }
}

async function fetchWorkMapBody(fresh = false): Promise<WorkMapGetBody> {
  const r = deps.fetchWorkMap
    ? await deps.fetchWorkMap(fresh)
    : await fetch(withWiki("/api/wiki/work-map")).then(async (res) => ({ ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as unknown }));
  if (!r.ok) throw new WorkMapHttpError(r.status);
  const body = r.body;
  if (!body || typeof body !== "object") throw new WorkMapHttpError(r.status);
  return body as WorkMapGetBody;
}

/** One GET, retried once after `WORK_GET_RETRY_MS` when the request itself
 *  failed (not when the instance answered). */
async function fetchWorkMapBodyRetry(): Promise<WorkMapGetBody> {
  try {
    return await fetchWorkMapBody();
  } catch (err) {
    if (err instanceof WorkMapHttpError) throw err;
    await new Promise((r) => setTimeout(r, WORK_GET_RETRY_MS));
    return fetchWorkMapBody();
  }
}

function loadWorkMap(): void {
  const gen = slot.gen;
  if (workLoadGen === gen) return;
  workLoadGen = gen;
  const settle = (): boolean => {
    if (workLoadGen === gen) workLoadGen = null;
    return slotLive(slot, gen);
  };
  fetchWorkMapBodyRetry()
    .then((body) => {
      if (!settle()) return;
      if (!body.map) return transition({ type: "get-refused", gen });
      transition({ type: "get-map", gen });
      if (slot.kind !== "card") return;
      workBody = body as WorkMapGetBody & { map: AnyWorkMap };
      paintWorkCard();
      // A wiki outside the decision triage's scope answers 404: the card shows no Decisions section.
      if (!isThemeMap(workBody.map)) loadInbox(withWiki("/api/wiki/decision-inbox"));
    })
    .catch((err) => {
      if (!settle()) return;
      // The instance will not serve this map (4xx, or a 2xx that is not JSON),
      // or the network failed twice: What's new takes the slot. A 5xx keeps
      // the card's Retry.
      if (!(err instanceof WorkMapHttpError) || err.status < 500) return transition({ type: "get-refused", gen });
      transition({ type: "get-5xx", gen });
      const el = document.getElementById("wikiWorkCard");
      if (el && slot.kind === "card-error") paintWorkError(el);
    });
}

function startWorkMapRefresh(): void {
  if (!workBody || workRefresh.phase === "running") return;
  const prevRunAt = workBody.map.runAtMs;
  const gen = slot.gen;
  workRefresh = { phase: "running", startedAt: Date.now() };
  paintWorkCard();
  // Never `force`: the route's 10-minute cooldown answers a second click.
  fetch(withWiki("/api/wiki/work-map/refresh"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
    .then(async (r) => {
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!slotLive(slot, gen)) return;
      if (r.status !== 202) {
        workRefresh = { phase: "message", text: refreshRefusalText(r.status, body, Date.now()), tone: "warn" };
        paintWorkCard();
        return;
      }
      const startedAt = typeof body.startedAt === "number" ? body.startedAt : Date.now();
      workRefresh = { phase: "running", startedAt };
      paintWorkCard();
      pollWorkMap(prevRunAt, startedAt, Date.now());
    })
    .catch(() => {
      if (!slotLive(slot, gen)) return;
      workRefresh = { phase: "message", text: "Re-organize failed: the server did not answer.", tone: "warn" };
      paintWorkCard();
    });
}

function pollWorkMap(prevRunAt: number, startedAt: number, since: number, failures = 0): void {
  if (workPollTimer) clearTimeout(workPollTimer);
  const gen = slot.gen;
  workPollTimer = setTimeout(() => {
    workPollTimer = null;
    fetchWorkMapBody(true)
      .then((body) => {
        if (!slotLive(slot, gen)) return;
        const st = pollState(body, prevRunAt, startedAt);
        if (body.map) workBody = body as WorkMapGetBody & { map: AnyWorkMap };
        deps.adoptWorkMap?.(body);
        if (st.state === "updated") {
          workRefresh = { phase: "idle" };
        } else if (st.state === "settled") {
          const a = st.attempt;
          workRefresh =
            a.outcome === "ok"
              ? { phase: "message", text: "Re-organized — nothing changed.", tone: "info" }
              : { phase: "message", text: `Re-organize ${a.outcome}${a.error ? ": " + a.error : ""}.`, tone: "warn" };
        } else if (Date.now() - since > WORK_POLL_MAX_MS) {
          workRefresh = { phase: "message", text: "Still organizing — reload later to see the new map.", tone: "info" };
        } else {
          paintWorkCard();
          return pollWorkMap(prevRunAt, startedAt, since);
        }
        paintWorkCard();
      })
      .catch(() => {
        if (!slotLive(slot, gen)) return;
        if (failures + 1 >= WORK_POLL_MAX_FAILURES || Date.now() - since > WORK_POLL_MAX_MS) {
          workRefresh = { phase: "message", text: "Couldn’t check on the re-organize — reload to see the new map.", tone: "warn" };
          paintWorkCard();
          return;
        }
        pollWorkMap(prevRunAt, startedAt, since, failures + 1);
      });
  }, WORK_POLL_MS);
}

/** The Your work card's clicks, from the shell's click delegate. True when
 *  the click was the card's. */
export function handleWorkCardClick(target: Element): boolean {
  if (handleInboxClick(target, pageHref)) return true;
  if (target.closest("#wikiWorkMapRefresh")) {
    startWorkMapRefresh();
    return true;
  }
  if (target.closest("#wikiWorkMapRetry")) {
    loadWorkMap();
    return true;
  }
  const done = target.closest("[data-wm-done]");
  if (done && workBody) {
    const at = Number(done.getAttribute("data-wm-done"));
    const item = workBody.map.needsYou[at];
    if (item) {
      writeDoneRaw(writeDone(readDoneRaw(), workBody.map.runAtMs, needKey(item), true));
      paintWorkCard({ doneAt: at });
    }
    return true;
  }
  const cell = target.closest("[data-wm-cell]");
  if (cell) {
    const name = cell.getAttribute("data-wm-cell") as StripCell;
    stripView = { open: stripView.open === name ? null : name, expanded: false };
    paintWorkCard({ sel: `[data-wm-cell="${name}"]` });
    return true;
  }
  if (target.closest("[data-wm-drill-more]")) {
    const shown = STRIP_ROWS_SHOWN;
    stripView = { ...stripView, expanded: true };
    // The button goes with the expansion; focus lands on the first row it hid.
    paintWorkCard({ sel: `.wiki-wm-drill-row:nth-child(${shown + 1}) a` });
    return true;
  }
  const ghMore = target.closest("[data-wm-gh-more]");
  if (ghMore) {
    const group = ghMore.getAttribute("data-wm-gh-more") as GhFoldedGroup;
    const was = stripView.ghGroups?.[group];
    stripView = { ...stripView, ghGroups: { ...stripView.ghGroups, [group]: was ? "all" : "window" } };
    // As with +N more: the first row the line or the button hid takes focus.
    paintWorkCard({ sel: `[data-wm-gh-group="${group}"] .wiki-wm-drill-row:nth-child(${was ? STRIP_ROWS_SHOWN + 1 : 1}) a` });
    return true;
  }
  const why = target.closest("[data-wm-why]");
  if (why) {
    const key = why.getAttribute("data-wm-why") ?? "";
    if (whyOpen.has(key)) whyOpen.delete(key);
    else whyOpen.add(key);
    paintWorkCard({ why: key });
    return true;
  }
  if (target.closest("#wikiWorkMapRestore")) {
    writeDoneRaw(null);
    paintWorkCard();
    return true;
  }
  return false;
}
