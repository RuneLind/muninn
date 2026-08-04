/// <reference lib="dom" />
/**
 * Browser entrypoint for the /wiki reader page. Bundled by Bun.build()
 * (see wiki-client.ts) and injected as an IIFE into the wiki page's inline
 * `<script>`. A mechanical port of the former hand-written inline IIFE — same
 * DOM ids/classes, same `/api/wiki/*` fetches, same keyboard/click handling.
 *
 * Three panes: filterable page list · rendered article with clickable
 * wikilinks · connections panel (backlinks + outgoing links grouped by type).
 * The whole page listing is fetched at load and re-fetched when the tab regains
 * focus (with `?refresh=1`, so the server's index TTL can't serve it stale) or on
 * a slow idle heartbeat — both throttled by `WIKI_REFETCH_MIN_INTERVAL_MS` — then
 * filtered client-side; a fresh set is applied only on the browse/start view and
 * otherwise stashed until the reader returns/navigates, so the list never
 * re-sorts mid-article. Article + connections come per-page from /api/wiki/page.
 */

import { escHtml as esc } from "./escape.ts";
import { sseClient, type SseHandle } from "./client-runtime.ts";
import { askAnswerBodyHtml, renderStreamingBody, enhanceConfidenceHtml } from "./wiki-ask-render.ts";
import {
  tallyClaimOutcomes,
  factcheckOutcomeSummary,
  type ClaimOutcomeCounts,
} from "./wiki-factcheck-outcomes.ts";
import {
  buildExplainUrl,
  explainLabel,
  buildFactcheckUrl,
  factcheckLabel,
  applyToolLogEvent,
  toolLogRowLabel,
  type ToolLogRow,
} from "./wiki-explain.ts";
import {
  botDefaultOptionLabel,
  chatUserStorageKey,
  chosenSupportsWebTools,
  conflictCopy,
  connectorOptionLabel,
  pickConnectorId,
  pickUserId,
  previewThreadName,
  wikiConnectorStorageKey,
  type ChatTarget,
} from "./wiki-chat-target.ts";
import { enhanceMermaid } from "./wiki-mermaid.ts";
import { atlasBodyHtml, initAtlas } from "./wiki-atlas.ts";
import { enhanceCodeTabs } from "./code-tabs.ts";
import { enhanceFactCheck } from "./wiki-factcheck-reader.ts";
import {
  serializeAskSession,
  deserializeAskSession,
  type StoredAskTurn,
} from "./wiki-ask-session.ts";
import {
  createRefreshModel,
  markApplied,
  pagesFingerprint,
  receivePages,
  shouldRefetch,
  startFetch,
  takePending,
  viewStateOf,
  WIKI_REFETCH_TICK_MS,
  type PendingPages,
  type WikiPagesResponse,
} from "./wiki-refresh.ts";
import {
  annotationIndexes,
  appendBlockedByIntegrate,
  buildIntegrateApplyBody,
  carriesFactWrapper,
  claimQuotesFromClaimsEvent,
  integrateBarState,
  integratePreviewHtml,
  integrateSuccessCopy,
  INTEGRATE_NO_ANCHORS_COPY,
  INTEGRATE_STALE_COPY,
  INTEGRATE_STALE_COPY_EDIT,
  type DroppedEditRow,
  type IntegrateProposal,
} from "./wiki-integrate.ts";
import {
  anchorNow,
  connectionTypeOrder,
  facetKeys,
  filterPages,
  folderCounts,
  followupCount,
  hasTypedHubs,
  hubTypeList,
  pageAddedLabel,
  pageDateLabel,
  pageHeaderDates,
  pageFolder,
  pageFollowups,
  ROOT_FOLDER,
  sanitizeColorToken,
  sortPages,
  statusCounts,
  statusFacetVisible,
  STATUS_ORDER,
  tagCounts,
  topPages,
  typeCounts,
  TYPE_LABEL,
  TYPE_ORDER,
  type WikiFilters,
  type WikiListing,
  type WikiSortMode,
} from "./wiki-filter.ts";

// The wiki's merged type list (built-in defaults + `.wiki-reader.json` customs),
// stored at boot from the /api/wiki/pages response and used by every type-keyed
// render site below. Falls back to the built-in constants until (or unless) the
// server sends a list — so an older server / a failed load still renders standard
// types correctly instead of dropping content.
let typeOrder: string[] = [...TYPE_ORDER];
let typeLabels: Record<string, string> = { ...TYPE_LABEL };
/** Label for a type — the wiki's configured label, else the raw slug. */
function typeLabel(t: string): string {
  return typeLabels[t] || t;
}

// ── Data shapes (mirror src/dashboard/routes/wiki-routes.ts) ──────────
interface WikiPageDetail {
  meta: WikiListing;
  html: string;
  outgoing: WikiListing[];
  backlinks: WikiListing[];
  error?: string;
}

// `WikiPagesResponse` is declared in `wiki-refresh.ts` (imported above) — the
// refresh model stores whole payloads, so it needs the shape concretely.

// ── Page state ────────────────────────────────────────────────────────
/** Which wiki is being browsed — the server injects the *canonical* wiki name
 *  (case-corrected, or the resolved default) as `window.__WIKI_NAME__`, so our
 *  `?wiki=` fetches and the picker's selected option always agree. Falls back to
 *  the raw `?wiki=` (or legacy `?bot=`) query if the global is somehow absent.
 *  Empty = default/env. */
const injectedName = (window as unknown as { __WIKI_NAME__?: unknown }).__WIKI_NAME__;
const params0 = new URLSearchParams(location.search);
const WIKI =
  typeof injectedName === "string" ? injectedName : params0.get("wiki") || params0.get("bot") || "";
/** Append the active `wiki` param to a URL so every /api/wiki/* fetch stays on-wiki. */
function withWiki(url: string): string {
  if (!WIKI) return url;
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "wiki=" + encodeURIComponent(WIKI);
}
/** Build a shareable in-page URL that preserves the active wiki. */
function pageUrl(name: string): string {
  const wiki = WIKI ? "wiki=" + encodeURIComponent(WIKI) + "&" : "";
  return "/wiki?" + wiki + "page=" + encodeURIComponent(name);
}
/** Collision-proof shareable URL keyed by the page's exact relPath — used for
 *  pages opened via the Atlas tab so Back/reload/share re-resolve the SAME page
 *  even on a wiki with same-stem pages in different folders (the `?page=` name
 *  route resolves first-stem-match). */
function pageUrlByRelPath(relPath: string): string {
  const wiki = WIKI ? "wiki=" + encodeURIComponent(WIKI) + "&" : "";
  return "/wiki?" + wiki + "relPath=" + encodeURIComponent(relPath);
}

let allPages: WikiListing[] = [];
/** The server's index-scan instant from `/api/wiki/pages`, kept solely to anchor the
 *  recency reads' `now` (see `recencyNow`). Null until the listing lands / on a
 *  degraded response. */
let scannedAtMs: number | null = null;
/**
 * The `now` every recency read on this page must use — the viewer's clock anchored
 * forward to the server's scan instant (`anchorNow`).
 *
 * This is not a nicety: `wiki-filter.ts`'s future-date guard drops any date more than
 * 48 h ahead of the `now` it is given, and this bundle runs on the VIEWER's machine.
 * A viewer clock set >48 h behind would therefore make EVERY frontmatter stamp in the
 * wiki look implausible at once, collapsing the whole listing onto its git/mtime
 * floors with nothing on screen to explain it. Read fresh per call (not captured at
 * boot) so a long-open tab's dates keep tracking real time.
 */
function recencyNow(): number {
  return anchorNow(Date.now(), scannedAtMs);
}
let currentName: string | null = null;
/** True from the moment a page navigation is requested until its response (or
 *  error) lands. `currentName` is only assigned from that response, so this is the
 *  only signal that the pane is "about to be an article" — see `viewStateOf`. */
let navInFlight = false;
const filters: WikiFilters = {
  q: "",
  domain: "",
  folder: "",
  type: "",
  tag: "",
  status: "",
  followups: "",
};
let startTab: "hubs" | "timeline" | "atlas" = "hubs";
let tagsExpanded = false;

// ── "What's new" digest (start view) ──────────────────────────────────
interface WikiDigest {
  bullets: string;
  html: string;
  generatedAt: number;
  logMtimeMs: number;
  entryCount: number;
  fromDate: string;
  toDate: string;
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
    (gen ? '<div class="wiki-wn-gen">' + esc(gen) + "</div>" : "")
  );
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
  el.style.display = "";
}

/** Fetch (or refresh) the digest and paint the card. Hidden entirely when the
 *  wiki genuinely has no digest (no log.md / no bot, and no error); a failure
 *  keeps the previous digest and shows a retry instead. A user refresh may
 *  supersede an in-flight auto-load; duplicate loads/refreshes are coalesced. */
function loadDigest(refresh: boolean): void {
  const el = document.getElementById("wikiWhatsNew");
  if (!el) return;
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
    .then((r) => r.json())
    .then((data: { digest: WikiDigest | null; error?: string }) => {
      if (myId !== whatsNewFetchId) return; // superseded by a newer fetch
      whatsNewLoading = false;
      whatsNewRefreshInFlight = false;
      const cur = document.getElementById("wikiWhatsNew");
      if (!cur) return;
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
        cur.style.display = "none";
        return;
      }
      whatsNewHtml = buildWhatsNewInner(data.digest);
      cur.innerHTML = whatsNewHtml;
      cur.style.display = "";
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
interface IndexCoverage {
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

/** Map a coverage relPath back to a wiki page name so a missing page can link
 *  into the reader (loadPage keys off the stem name). Matches on the same posix
 *  + lowercase rule the store uses (NFC differences fall back to plain text). */
function relPathToName(relPath: string): string | null {
  const key = relPath.replace(/\\/g, "/").toLowerCase();
  const hit = allPages.find((p) => (p.relPath || "").replace(/\\/g, "/").toLowerCase() === key);
  return hit ? hit.name : null;
}

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
    const name = linkable ? relPathToName(rp) : null;
    html += name
      ? '<li><span class="wiki-ix-link" data-page="' + esc(name) + '">' + esc(rp) + "</span></li>"
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
function loadIndexCoverage(refresh: boolean): void {
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
const REINDEX_SETTLED_TTL_MS = 60_000;

/** Set the persisted reindex-status markup and paint it into the live slot. */
function setReindexStatus(html: string): void {
  reindexStatusHtml = html;
  const el = document.getElementById("wikiIndexReindexStatus");
  if (el) el.innerHTML = html;
}

/** Re-apply the persisted status + button-disabled state after any card (re)render
 *  so a cached-HTML reuse (tab switch) or a post-settle coverage refresh doesn't
 *  drop an in-flight reindex's status or leave the button in the wrong state. */
function applyReindexUi(): void {
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
function startReindex(): void {
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

function sortMode(): WikiSortMode {
  return (document.getElementById("wikiSort") as HTMLSelectElement).value as WikiSortMode;
}

// ── Left pane: filter + list ──────────────────────────────────────────
/** Populate the folder picker from the pages themselves — wikis differ wildly
 *  (mimir has blogs/plans/archive/…, huginn-jarvis has sources/concepts/…), so
 *  the options are derived, never hardcoded. A flat wiki (everything at the root)
 *  gets no picker at all. Rebuilt on a domain switch so the counts stay honest.
 *
 *  The ACTIVE folder is UNIONED into the options even at count 0 (the status and
 *  tag rows' rule, made symmetric here): clearing `filters.folder` from a render
 *  would let a domain switch — or a background listing refresh — silently rewrite
 *  a filter the user set, and the picker is the only way back out of it. */
function renderFolderSelect(): void {
  const sel = document.getElementById("wikiFolder") as HTMLSelectElement | null;
  const row = document.getElementById("wikiFolderRow");
  if (!sel || !row) return;
  const counts = folderCounts(allPages, filters.domain);
  const folders = facetKeys(counts, filters.folder).sort((a, b) => {
    if (a === ROOT_FOLDER) return 1; // root pages last — they're the odd ones out
    if (b === ROOT_FOLDER) return -1;
    return a.localeCompare(b);
  });
  const real = folders.filter((f) => f !== ROOT_FOLDER);
  if (!real.length) {
    row.style.display = "none";
    sel.innerHTML = "";
    return;
  }
  row.style.display = "";
  let html = `<option value="">All folders</option>`;
  folders.forEach((f) => {
    const label = f === ROOT_FOLDER ? "(root)" : f;
    html += `<option value="${esc(f)}"${filters.folder === f ? " selected" : ""}>${esc(label)} ${counts[f] || 0}</option>`;
  });
  sel.innerHTML = html;
}

function renderTypeChips(): void {
  const counts = typeCounts(allPages, filters.domain);
  let html = `<button class="wiki-chip${filters.type === "" ? " active" : ""}" data-type="">All types</button>`;
  // Union the stored order with the types actually present, so a custom type is
  // never dropped from the chip row even if the stored list is missing/late — and
  // with the ACTIVE type even at count 0 (the status row's rule), so a scope
  // change can't strand the very filter that is emptying the list.
  connectionTypeOrder(facetKeys(counts, filters.type), typeOrder).forEach((t) => {
    html += `<button class="wiki-chip${filters.type === t ? " active" : ""}" data-type="${esc(t)}">${esc(typeLabel(t))} ${counts[t] || 0}</button>`;
  });
  document.getElementById("typeChips")!.innerHTML = html;
}

/** A colored `plan_status` pill — the ONE spelling shared by the page list and the
 *  article header, so the two never drift. Empty string for a page without one. */
function statusPillHtml(p: WikiListing): string {
  if (!p.plan_status) return "";
  // `status_note` arrives UNESCAPED from the server (free prose, no validator) —
  // esc() before it reaches this attribute sink.
  const note = [p.status_date, p.status_note].filter(Boolean).join(" — ");
  const title = note ? ` title="${esc(note)}"` : "";
  return `<span class="wiki-status plan-${esc(p.plan_status)}"${title}>${esc(p.plan_status)}</span>`;
}

/** The open-follow-ups marker — deliberately separate from the status pill so the
 *  two axes stay distinguishable, and independent of `plan_status` (a page can
 *  declare follow-ups without a status). */
function followupFlagHtml(p: WikiListing): string {
  return pageFollowups(p) === "open"
    ? '<span class="wiki-followup-flag" title="has open follow-ups">⚑</span>'
    : "";
}

/** The Status chip row + ⚑ follow-ups toggle. Rendered only on wikis that use
 *  either plan-status axis (`statusFacetVisible`); everywhere else the row stays
 *  hidden and empty, so a wiki without the convention looks exactly as it did
 *  before. */
function renderStatusChips(): void {
  const row = document.getElementById("statusChips");
  if (!row) return;
  const hide = () => {
    row.innerHTML = "";
    row.style.display = "none";
  };
  if (!statusFacetVisible(allPages)) {
    hide();
    return;
  }
  const counts = statusCounts(allPages, filters.domain, filters.type);
  const open = followupCount(allPages, filters.domain, filters.type);
  // The whole-wiki gate above says the facet EXISTS here; this says whether it has
  // anything to offer in the CURRENT domain/type scope. Without it a type switch
  // could leave a row holding nothing but the inert "All status" chip. An active
  // filter keeps the row up regardless — it is the only way back out of it.
  if (!Object.keys(counts).length && !open && !filters.status && !filters.followups) {
    hide();
    return;
  }
  let html = `<button class="wiki-chip${filters.status === "" ? " active" : ""}" data-status="">All status</button>`;
  // Union the enum order with whatever is actually present, same belt-and-braces
  // as the type row: a status the client's copy of the enum doesn't know still
  // shows. The ACTIVE status joins that union even at count 0 (`facetKeys`, here
  // placed in STATUS_ORDER position) — a domain/type switch that empties it would
  // otherwise hide the very filter that is emptying the list.
  connectionTypeOrder(facetKeys(counts, filters.status), STATUS_ORDER).forEach((s) => {
    html +=
      `<button class="wiki-chip${filters.status === s ? " active" : ""}" data-status="${esc(s)}">` +
      `<span class="wiki-status-dot plan-${esc(s)}"></span>${esc(s)} ${counts[s] || 0}</button>`;
  });
  if (open || filters.followups) {
    html += `<button class="wiki-chip${filters.followups ? " active" : ""}" data-followups="open" title="Only pages with open follow-ups">⚑ has follow-ups ${open}</button>`;
  }
  row.innerHTML = html;
  row.style.display = "";
}

function renderTagChips(): void {
  const counts = tagCounts(allPages, filters.domain, filters.type);
  const tags = Object.keys(counts).sort((a, b) => counts[b]! - counts[a]! || a.localeCompare(b));
  const limit = tagsExpanded ? 36 : 8;
  const shown = tags.slice(0, limit);
  if (filters.tag && shown.indexOf(filters.tag) === -1) shown.unshift(filters.tag);
  let html = "";
  shown.forEach((t) => {
    html += `<button class="wiki-chip${filters.tag === t ? " active" : ""}" data-tag="${esc(t)}">#${esc(t)} ${counts[t] || 0}</button>`;
  });
  if (tags.length > shown.length || tagsExpanded) {
    html += `<button class="wiki-chip" data-tag-more="1">${tagsExpanded ? "less" : "+" + (tags.length - shown.length) + " tags"}</button>`;
  }
  document.getElementById("tagChips")!.innerHTML = html;
}

/** Count of active secondary filters (folder + type + tag + status + follow-ups) —
 *  drives the Filters disclosure's badge and its auto-open. Status and follow-ups
 *  count separately because they ARE separate axes. Domain lives in the compact
 *  head, so it is deliberately excluded here. */
function activeFilterCount(): number {
  let n = 0;
  if (filters.folder) n++;
  if (filters.type) n++;
  if (filters.tag) n++;
  if (filters.status) n++;
  if (filters.followups) n++;
  return n;
}

/** Keep the Filters disclosure honest: badge the active-filter count and auto-open
 *  it whenever a filter is set (a hidden active filter is worse than a tall stack).
 *  Never force-closes — a user who opened it manually keeps it open.
 *
 *  `autoOpen` is false for renders NOT caused by a user action (the background
 *  listing refresh): a deliberately collapsed stack must not spring open because a
 *  gardener wrote a page. The badge still updates on every path. */
function syncFilters(autoOpen = true): void {
  const count = activeFilterCount();
  const badge = document.getElementById("wikiFilterCount");
  if (badge) {
    badge.textContent = count ? String(count) : "";
    badge.style.display = count ? "" : "none";
  }
  const details = document.getElementById("wikiFilters") as HTMLDetailsElement | null;
  if (autoOpen && details && count && !details.open) details.open = true;
}

function renderList(): void {
  const mode = sortMode();
  // ONE anchored instant for the sort AND its row labels, so the date a row shows is
  // the date it sorted on even for a page sitting at the 48h future-guard boundary.
  const now = recencyNow();
  const pages = sortPages(filterPages(allPages, filters), mode, now);
  let html = "";
  pages.forEach((p) => {
    // In recency modes show the date we actually sorted on (mtime/birthtime or
    // frontmatter) — otherwise a frontmatter-less page would show nothing while
    // sitting at the top, which is exactly what looked broken before.
    const meta =
      mode === "backlinks"
        ? p.backlinkCount + " ←"
        : mode === "created"
          ? pageAddedLabel(p, now)
          : pageDateLabel(p, now);
    html +=
      `<div class="wiki-list-item${p.name === currentName ? " active" : ""}" data-page="${esc(p.name)}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div>` +
      `<div class="wiki-list-title">${esc(p.title)}</div>` +
      // Pill THEN flag, the same order as the article header's `badgeHtml` — the
      // two surfaces show the same two facts and must not read differently.
      statusPillHtml(p) +
      followupFlagHtml(p) +
      `<div class="wiki-list-meta">${esc(meta)}</div>` +
      `</div>`;
  });
  // Scroll restore lives HERE, not at the refresh call site (the `renderBacklog`
  // precedent): every deferred-apply path ends in its caller's own renderList, so
  // a capture/restore wrapped around the adopt was undone a frame later. Owning it
  // inside the one function that replaces the rows makes the guarantee hold on
  // every path — a background refresh can never yank a reader to the top.
  const listEl = document.getElementById("wikiList")!;
  const scroll = listEl.scrollTop;
  listEl.innerHTML = html || '<div class="wiki-conn-empty">No pages match.</div>';
  if (scroll) listEl.scrollTop = scroll;
  document.getElementById("wikiCount")!.textContent = pages.length + " / " + allPages.length;
}

/** The five payload-derived facet renders, in one place so the boot load and a
 *  refresh adopt can't drift. Paints no rows — `renderList` owns those. */
function renderPageFacets(autoOpen: boolean): void {
  renderFolderSelect();
  renderTypeChips();
  renderStatusChips();
  renderTagChips();
  syncFilters(autoOpen);
}

// ── Coverage footer (under the page list) ─────────────────────────────
// A one-line index-coverage summary linking the full Index card on the start
// view. Reuses the same /api/wiki/index-coverage endpoint as that card; a
// no-collections/degraded/failed response simply hides the footer.
function loadCoverageFooter(): void {
  const el = document.getElementById("wikiCoverageFoot");
  if (!el) return;
  fetch(withWiki("/api/wiki/index-coverage"))
    .then((r) => r.json())
    .then((cov: IndexCoverage) => {
      const cur = document.getElementById("wikiCoverageFoot");
      if (!cur) return;
      if (cov.error || cov.totalMd === null || cov.indexed === null) {
        cur.style.display = "none";
        return;
      }
      const missing = cov.missing ? cov.missing.length : 0;
      cur.innerHTML =
        '<span class="wiki-cov-link" id="wikiCoverageLink" title="Open the full Index card">' +
        cov.totalMd + " pages · indexed " + cov.indexed +
        (missing ? " · " + missing + " missing" : "") +
        "</span>";
      cur.style.display = "";
    })
    .catch(() => {
      const cur = document.getElementById("wikiCoverageFoot");
      if (cur) cur.style.display = "none";
    });
}

// ── Breadcrumb bar (above the article) ────────────────────────────────
// Shows "wiki / folder / page · updated" for the open page and hosts the
// Explain affordance (a button shown only while a selection exists — see the
// Select-to-Explain section). Hidden on the start view and on Ask answers.
function renderBreadcrumb(m: WikiListing): void {
  const el = document.getElementById("wikiBreadcrumb");
  if (!el) return;
  const crumbs: string[] = [];
  if (WIKI) crumbs.push('<span class="wiki-bc-wiki">' + esc(WIKI) + "</span>");
  const folder = pageFolder(m);
  if (folder && folder !== ROOT_FOLDER) {
    crumbs.push('<span class="wiki-bc-folder">' + esc(folder) + "</span>");
  }
  crumbs.push('<span class="wiki-bc-cur">' + esc(m.title) + "</span>");
  // BOTH dates, each labelled — unlike a list row, which shows the one date it sorted
  // on. `pageHeaderDates` owns which slots appear; the "no known edit" case yields a
  // creation date only, so the header never asserts an edit the history doesn't record.
  const { created, updated } = pageHeaderDates(m, recencyNow());
  const dateHtml =
    created || updated
      ? '<span class="wiki-bc-date">' +
        (created ? "created " + esc(created) : "") +
        (created && updated ? " · " : "") +
        (updated ? "updated " + esc(updated) : "") +
        "</span>"
      : "";
  el.innerHTML =
    '<div class="wiki-bc-trail">' +
    crumbs.join('<span class="wiki-bc-sep">/</span>') +
    "</div>" +
    dateHtml +
    // Selection-gated actions (hidden until a selection exists — see maybeShowExplainPill).
    '<button class="wiki-bc-explain" id="wikiExplainBtn" style="display:none">✨ Explain</button>' +
    '<button class="wiki-bc-factcheck" id="wikiFactcheckBtn" style="display:none">✓ Fact check</button>' +
    // Always-visible whole-article fact check (markdown pages + explainers).
    '<button class="wiki-bc-factcheck wiki-bc-factcheck-article" id="wikiFactcheckArticleBtn" ' +
    'title="Fact-check this whole page against the web">🔎 Fact check</button>';
  el.style.display = "flex";
}
function hideBreadcrumb(): void {
  const el = document.getElementById("wikiBreadcrumb");
  if (el) el.style.display = "none";
}

// ── Middle pane: article / start view ─────────────────────────────────
function badgeHtml(p: WikiListing): string {
  // A custom type (e.g. mimir's "subsystem") has no dedicated `badge-*` rule — the
  // neutral `.wiki-badge` base styles it. `esc` guards the class + label since the
  // type string can come from a wiki's `.wiki-reader.json`.
  let html = `<span class="wiki-badge badge-${esc(p.type)}">${esc(p.type)}</span>`;
  if (p.domain === "life") html += '<span class="wiki-badge badge-life">life</span>';
  // Plan status sits beside the type badge (same row), with the follow-up flag as
  // its own marker. Both are page-driven, not facet-driven: a page with no
  // `plan_status` shows no pill here even on a wiki where the Status facet is live.
  html += statusPillHtml(p) + followupFlagHtml(p);
  return html;
}

/** One hub grid of cards from a pre-sorted page list. */
function hubGridHtml(heading: string, pages: WikiListing[]): string {
  let html = `<h2>${heading}</h2><div class="wiki-hub-grid">`;
  pages.forEach((p) => {
    html +=
      `<div class="wiki-hub-card" data-page="${esc(p.name)}">` +
      `<div class="wiki-hub-title">${esc(p.title)}</div>` +
      `<div class="wiki-hub-sub">${p.backlinkCount} pages link here</div>` +
      `</div>`;
  });
  return html + "</div>";
}

function hubsHtml(): string {
  // Wikis with a real ontology (≥2 non-note types) get per-type hub sections, one
  // per non-note type the wiki actually carries (jarvis: concept/entity/source/…;
  // mimir: subsystem/plan/report/…). Wikis that are all `note` (plain markdown, no
  // frontmatter `type`, no config) fall back to a single cross-type "by connections"
  // hub. `esc` the heading — custom labels come from a wiki's `.wiki-reader.json`.
  if (hasTypedHubs(allPages)) {
    let html = "";
    hubTypeList(allPages, typeOrder).forEach((t) => {
      const top = topPages(allPages, (p) => p.type === t, 12);
      if (!top.length) return;
      html += hubGridHtml(`Top ${esc(typeLabel(t).toLowerCase())} by connections`, top);
    });
    if (html) return html;
    // No typed section had pages — fall through to the cross-type hub.
  }
  const top = topPages(allPages, (p) => p.backlinkCount > 0, 12);
  if (!top.length) {
    return '<div class="wiki-conn-empty">No linked pages yet — this wiki has no resolvable internal links.</div>';
  }
  return hubGridHtml("Top pages by connections", top);
}

function timelineHtml(): string {
  const groups: Record<string, { p: WikiListing; kind: "new" | "upd" }[]> = {};
  const now = recencyNow();
  filterPages(allPages, filters).forEach((p) => {
    if (p.created) (groups[p.created] = groups[p.created] || []).push({ p, kind: "new" });
    if (p.updated && p.updated !== p.created) {
      (groups[p.updated] = groups[p.updated] || []).push({ p, kind: "upd" });
    }
    // No frontmatter dates at all (mimir, melosys-kode-wiki) — file it under its
    // mtime date so a whole wiki isn't missing from its own timeline.
    if (!p.created && !p.updated) {
      const d = pageDateLabel(p, now);
      if (d) (groups[d] = groups[d] || []).push({ p, kind: "upd" });
    }
  });
  const dates = Object.keys(groups).sort().reverse();
  if (!dates.length) {
    return '<div class="wiki-conn-empty">No dated pages match the current filters.</div>';
  }
  let html = "";
  dates.forEach((d) => {
    const items = groups[d]!;
    items.sort((a, b) =>
      a.kind === b.kind ? a.p.title.localeCompare(b.p.title) : a.kind === "new" ? -1 : 1,
    );
    let news = 0;
    let upds = 0;
    items.forEach((it) => {
      if (it.kind === "new") news++;
      else upds++;
    });
    html +=
      `<div class="wiki-day">${esc(d)} <span>· ` +
      (news ? news + " new" : "") +
      (news && upds ? " · " : "") +
      (upds ? upds + " updated" : "") +
      `</span></div>`;
    items.forEach((it) => {
      html +=
        `<div class="wiki-tl-item" data-page="${esc(it.p.name)}">` +
        `<div class="wiki-tl-kind ${it.kind}">${it.kind === "new" ? "+" : "~"}</div>` +
        `<div class="wiki-type-dot type-${esc(it.p.type)}"></div>` +
        `<div class="wiki-tl-title">${esc(it.p.title)}</div>` +
        `</div>`;
    });
  });
  return html;
}

function startBodyHtml(): string {
  if (startTab === "atlas") return atlasBodyHtml();
  return startTab === "hubs" ? hubsHtml() : timelineHtml();
}

/** The per-type counters above the start view's tabs. Derived straight from
 *  `allPages`, so a refreshed listing has to repaint them — a stale "10 Concepts"
 *  above an 11-row list is exactly the staleness this refresh exists to kill. */
function startStatsHtml(): string {
  const counts = typeCounts(allPages, "");
  let html = "";
  connectionTypeOrder(Object.keys(counts), typeOrder).forEach((t) => {
    if (!counts[t]) return;
    html += `<div class="wiki-stat"><b>${counts[t]}</b><span>${esc(typeLabel(t))}</span></div>`;
  });
  return html;
}

function refreshStartStats(): void {
  const el = document.getElementById("wikiStartStats");
  if (el && currentName === null) el.innerHTML = startStatsHtml();
}

/** Re-render the hubs/timeline area in place when filters change on the start view.
 *  The Atlas tab isn't filter-driven (it reads its own `/api/wiki/atlas`
 *  projection), so a filter change must NOT wipe its built canvas + selection.
 *  That early return is load-bearing for the background listing refresh too: an
 *  adopt must not wipe an in-progress Atlas exploration. The accepted cost is that
 *  the Atlas projection stays frozen at whatever it was built from until the next
 *  tab switch rebuilds it. */
function refreshStartBody(): void {
  if (startTab === "atlas") return;
  const el = document.getElementById("startBody");
  if (el && currentName === null) el.innerHTML = startBodyHtml();
}

/** Atlas gets the full viewport while its tab is active on the start view —
 *  the left browse pane + right rail collapse (`.atlas-full` on the layout,
 *  styled in wiki-page.ts). Restored on tab switch / page open. Toggled BEFORE
 *  initAtlas builds so the canvas lays out (and draws edges) at final width. */
function setAtlasFull(on: boolean): void {
  const layout = document.querySelector(".wiki-layout");
  if (layout) layout.classList.toggle("atlas-full", on);
}

function renderStart(): void {
  // Returning to the browse view is the moment a page set stashed during reading
  // becomes safe to apply — before anything below reads `allPages`.
  applyPendingPages();
  currentName = null;
  hideBreadcrumb(); // no page open — the breadcrumb has nothing to show
  let html =
    '<div class="wiki-start"><div class="wiki-article-head"><h1>Knowledge Wiki</h1>' +
    '<div class="wiki-meta-row"><span class="wiki-dates">Browse by search and filters on the left, or start from a hub below. Click any wikilink to follow connections.</span></div></div>' +
    '<div id="wikiWhatsNew" class="wiki-whatsnew" style="display:none"></div>' +
    '<div id="wikiIndexCard" class="wiki-index-card" style="display:none"></div>' +
    '<div class="wiki-start-stats" id="wikiStartStats">' +
    startStatsHtml();
  html +=
    "</div>" +
    '<div class="wiki-tabs">' +
    `<button class="wiki-tab${startTab === "hubs" ? " active" : ""}" data-tab="hubs">Hubs</button>` +
    `<button class="wiki-tab${startTab === "timeline" ? " active" : ""}" data-tab="timeline">Timeline</button>` +
    `<button class="wiki-tab${startTab === "atlas" ? " active" : ""}" data-tab="atlas">Atlas</button>` +
    "</div>" +
    `<div id="startBody">${startBodyHtml()}</div></div>`;
  document.getElementById("articleWrap")!.innerHTML = html;
  setAtlasFull(startTab === "atlas");
  // The Atlas tab lazy-loads its projection into the placeholder just inserted.
  if (startTab === "atlas") {
    // Atlas passes (relPath, name); drop the display name — the relPath is
    // authoritative and drives the collision-proof history round-trip.
    initAtlas({ withWiki, openPage: (relPath) => loadPageByRelPath(relPath), wiki: WIKI });
  }
  document.getElementById("connBody")!.innerHTML =
    '<div class="wiki-conn-empty">Select a page to see its connections.</div>';
  // Re-attach the "what's new" card: reuse the cached render if we have it (tab
  // switches re-run renderStart), otherwise lazily fetch it once so it never
  // blocks the page list from rendering.
  const wn = document.getElementById("wikiWhatsNew");
  if (wn) {
    if (whatsNewHtml) {
      wn.innerHTML = whatsNewHtml;
      wn.style.display = "";
    } else if (!digestAttempted) {
      digestAttempted = true;
      loadDigest(false);
    }
  }
  // Re-attach the index-coverage card the same way: reuse the cached render on a
  // tab switch, otherwise lazily fetch it once so it never blocks the page list.
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
  renderList();
}

interface MiniNode {
  p: WikiListing;
  out: boolean;
  inn: boolean;
  x?: number;
  y?: number;
}

/** 1-hop neighborhood as a small radial SVG: current page centered, top neighbors on a ring. */
function miniGraphHtml(data: WikiPageDetail): string {
  const byName: Record<string, MiniNode> = {};
  data.outgoing.forEach((p) => {
    byName[p.name] = { p, out: true, inn: false };
  });
  data.backlinks.forEach((p) => {
    if (byName[p.name]) byName[p.name]!.inn = true;
    else byName[p.name] = { p, out: false, inn: true };
  });
  const all = Object.keys(byName).map((k) => byName[k]!);
  if (!all.length) return "";
  all.sort((a, b) => {
    const ab = a.out && a.inn ? 1 : 0;
    const bb = b.out && b.inn ? 1 : 0;
    return bb - ab || b.p.backlinkCount - a.p.backlinkCount;
  });
  const shown = all.slice(0, 12);
  const W = 272;
  const H = 244;
  const cx = W / 2;
  const cy = H / 2 - 4;
  const r = 86;
  const short = (t: string) => (t.length > 15 ? t.slice(0, 14) + "…" : t);
  let edges = "";
  let nodes = "";
  shown.forEach((n, i) => {
    const ang = (2 * Math.PI * i) / shown.length - Math.PI / 2;
    n.x = cx + r * Math.cos(ang);
    n.y = cy + r * Math.sin(ang);
    edges +=
      `<line class="mini-edge${n.out && n.inn ? " both" : ""}"` +
      (n.inn && !n.out ? ' stroke-dasharray="3,3"' : "") +
      ` x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}"/>`;
  });
  shown.forEach((n) => {
    const ly = n.y! + (n.y! >= cy ? 15 : -9);
    nodes +=
      `<g class="mini-node" data-page="${esc(n.p.name)}"><title>${esc(n.p.title)}</title>` +
      `<circle class="mini-hit" cx="${n.x!.toFixed(1)}" cy="${n.y!.toFixed(1)}" r="14" fill="transparent"></circle>` +
      `<circle class="mini-dot t-${esc(n.p.type)}" cx="${n.x!.toFixed(1)}" cy="${n.y!.toFixed(1)}" r="5"></circle>` +
      `<text x="${n.x!.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(short(n.p.title))}</text></g>`;
  });
  nodes +=
    `<g class="mini-center"><circle class="mini-dot t-${esc(data.meta.type)}" cx="${cx}" cy="${cy}" r="7"></circle>` +
    `<text x="${cx}" y="${cy + 21}" text-anchor="middle">${esc(short(data.meta.title))}</text></g>`;
  const more =
    all.length > shown.length
      ? `<div class="wiki-mini-more">strongest ${shown.length} of ${all.length} — full lists below</div>`
      : "";
  return `<div class="wiki-mini-graph"><svg viewBox="0 0 ${W} ${H}">${edges}${nodes}</svg>${more}</div>`;
}

// ── Right pane: connections ───────────────────────────────────────────
function renderConnections(data: WikiPageDetail): void {
  function section(title: string, items: WikiListing[]): string {
    let html = `<div class="wiki-conn-section"><div class="wiki-conn-title">${title} (${items.length})</div>`;
    if (!items.length) {
      return html + '<div class="wiki-conn-empty">None</div></div>';
    }
    // Group by the union of (stored order ∪ types actually present in the items),
    // ordered by the stored list — so a custom-typed neighbor is NEVER dropped even
    // if the stored list arrived late or empty (the pre-fix bug silently excluded it).
    connectionTypeOrder(items.map((p) => p.type), typeOrder).forEach((t) => {
      const group = items.filter((p) => p.type === t);
      if (!group.length) return;
      html += `<div class="wiki-conn-group">${esc(typeLabel(t))}</div>`;
      group
        .sort((a, b) => b.backlinkCount - a.backlinkCount)
        .forEach((p) => {
          html +=
            `<div class="wiki-conn-item" data-page="${esc(p.name)}">` +
            `<div class="wiki-type-dot type-${esc(p.type)}"></div><span>${esc(p.title)}</span></div>`;
        });
    });
    return html + "</div>";
  }
  document.getElementById("connBody")!.innerHTML =
    miniGraphHtml(data) +
    section("Linked from", data.backlinks) +
    section("Links to", data.outgoing) +
    // Placeholder the lazy "Similar" fetch fills in after the page renders.
    '<div id="wikiSimilar"></div>';
}

// ── Right rail tabs (Connections | Ask) ───────────────────────────────
/** Toggle the right rail between the Connections body and the Ask compose body.
 *  Default tab is Connections (so Linked from / Links to / Similar are visible on
 *  page select). Auto-switched to Ask when an Ask/Explain stream starts (via
 *  `runAskStream`); switching back to Connections is manual. `focus` (manual tab
 *  clicks only) drops the caret into the Ask box; the auto-switch path passes it
 *  false so a follow-up ask can't steal focus from the in-pane follow-up input. */
function switchConnTab(tab: string, focus?: boolean): void {
  document.querySelectorAll(".wiki-conn-tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-conntab") === tab);
  });
  const connBody = document.getElementById("connBody");
  const askBody = document.getElementById("askBody");
  const ask = tab === "ask";
  if (connBody) connBody.style.display = ask ? "none" : "";
  if (askBody) askBody.style.display = ask ? "flex" : "none";
  if (ask && focus) {
    const input = document.getElementById("wikiAskInput") as HTMLTextAreaElement | null;
    if (input) input.focus();
  }
}

// ── Similar articles (semantic cousins, lazily fetched) ───────────────
/** One resolved similar page (mirrors SimilarPage in src/wiki/similar.ts). */
interface SimilarPage {
  name: string;
  title: string;
  relPath: string;
  type: string;
  snippet?: string;
  relevance: number;
}
/** Per-page memo so flipping tabs / re-rendering doesn't refetch. */
const similarMemo = new Map<string, SimilarPage[]>();
/** In-flight guard so a page render can't kick two concurrent fetches. */
const similarInFlight = new Set<string>();

/** Render the "Similar" section markup, or "" when there are no cousins (so the
 *  section is simply absent). Rows reuse the connection-item shape → clicking one
 *  opens it in the reader via the delegated `[data-page]` handler. */
function similarSectionHtml(items: SimilarPage[]): string {
  if (!items.length) return "";
  let html = `<div class="wiki-conn-section"><div class="wiki-conn-title">Similar (${items.length})</div>`;
  items.forEach((p) => {
    html +=
      `<div class="wiki-conn-item" data-page="${esc(p.name)}" title="${esc(p.snippet || "")}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div><span>${esc(p.title)}</span></div>`;
  });
  return html + "</div>";
}

/** Fill the placeholder — but only if the reader is still on the page we fetched
 *  for (a fast tab flip may have moved on). */
function renderSimilarInto(pageName: string, items: SimilarPage[]): void {
  if (currentName !== pageName) return;
  const el = document.getElementById("wikiSimilar");
  if (el) el.innerHTML = similarSectionHtml(items);
}

/** Lazily fetch + render the Similar section for a page. Memoized per page and
 *  guarded against concurrent duplicate fetches; a failed/empty fetch leaves the
 *  section absent. */
function loadSimilar(pageName: string): void {
  const memo = similarMemo.get(pageName);
  if (memo) {
    renderSimilarInto(pageName, memo);
    return;
  }
  if (similarInFlight.has(pageName)) return;
  similarInFlight.add(pageName);
  fetch(withWiki("/api/wiki/similar?page=" + encodeURIComponent(pageName)))
    .then((r) => r.json())
    .then((data: { similar?: SimilarPage[] }) => {
      const items = Array.isArray(data.similar) ? data.similar : [];
      similarMemo.set(pageName, items);
      renderSimilarInto(pageName, items);
    })
    .catch(() => {
      /* huginn down or route error — hide the section silently */
    })
    .finally(() => {
      similarInFlight.delete(pageName);
    });
}

/** Article-head block (title, badges, tags, dates, source link) — shared by
 *  markdown pages and HTML explainers. */
function articleHeadHtml(m: WikiListing): string {
  // Explainer-style subtitle under the H1 for blog pages that declared a
  // `description` (user text → escaped into innerHTML). Non-blog pages are unchanged.
  const subtitle =
    m.type === "blog" && m.description
      ? `<p class="wiki-subtitle">${esc(m.description)}</p>`
      : "";
  let head =
    `<div class="wiki-article-head"><h1>${esc(m.title)}</h1>${subtitle}<div class="wiki-meta-row">` +
    badgeHtml(m);
  m.tags.forEach((t) => {
    head += `<span class="wiki-tag">${esc(t)}</span>`;
  });
  if (m.created || m.updated) {
    head += `<span class="wiki-dates">${esc(m.created || "")}${m.updated && m.updated !== m.created ? " · upd " + esc(m.updated) : ""}</span>`;
  }
  if (m.url) {
    head += `<a class="wiki-source-url" href="${esc(m.url)}" target="_blank" rel="noopener">Open source ↗</a>`;
  }
  head += "</div></div>";
  return head;
}

/** Standalone HTML explainers aren't markdown, so the article renders in a
 *  sandboxed <iframe> (scripts allowed — they use inline JS/mermaid and are
 *  trusted local docs on a loopback-only dashboard) instead of the markdown
 *  pane. The Connections panel is fetched from /api/wiki/page like any other
 *  page: explainers carry backlinks ("Linked from") since md→.html links join
 *  the link graph, plus the lazy Similar section; outgoing links stay empty. */
function loadExplainer(m: WikiListing, push: boolean): void {
  hideExplainPill(); // a page switch drops any stale pill from the prior page
  setAtlasFull(false);
  currentName = m.name;
  navInFlight = false; // `currentName` now carries the "article" signal on its own
  if (push) {
    history.pushState({ page: currentName }, "", pageUrl(currentName));
  }
  renderBreadcrumb(m);
  const src = withWiki("/api/wiki/html?name=" + encodeURIComponent(m.name));
  document.getElementById("articleWrap")!.innerHTML =
    articleHeadHtml(m) +
    `<iframe class="wiki-explainer-frame" src="${esc(src)}" sandbox="allow-scripts allow-popups" title="${esc(m.title)}"></iframe>`;
  document.getElementById("articleWrap")!.scrollTop = 0;
  document.getElementById("connBody")!.innerHTML = '<div class="wiki-conn-empty">Loading…</div>';
  fetch(withWiki("/api/wiki/page?name=" + encodeURIComponent(m.name)))
    .then((r) => r.json())
    .then((data: WikiPageDetail) => {
      // A fast page flip may have moved on — don't clobber the new page's panel.
      if (data.error || currentName !== m.name) return;
      renderConnections(data);
      loadSimilar(m.name);
    })
    .catch(() => {
      if (currentName !== m.name) return;
      document.getElementById("connBody")!.innerHTML =
        '<div class="wiki-conn-empty">Connections unavailable.</div>';
    });
  renderList();
}

/**
 * Per-page accent `<style>` block for a `type: blog` page that declared an
 * `accent`. Overrides `--accent`/`--accent-light` on the `.wiki-article-blog`
 * scope so the page's headings/links/callouts tint to its brand color. The values
 * are re-validated here (defense-in-depth — the server already sanitized them to a
 * strict color token, so `</style>` / `;}` breakouts are structurally impossible).
 *
 * Theme correctness across all three toggle states: the light `accent` is the base;
 * `accentDark` (when present) is applied under BOTH `html[data-theme="dark"]` (the
 * explicit-dark override) AND `@media (prefers-color-scheme: dark) html:not([data-theme="light"])`
 * (system-follow on a dark OS, but NOT when the user forced light). So: system+light
 * OS → base accent; system+dark OS → accentDark; explicit light → base accent (the
 * media rule's `:not([data-theme="light"])` excludes it); explicit dark → accentDark.
 *
 * The block is injected INSIDE `#articleWrap` alongside the article, so a page flip
 * (or the Ask/Explain answer that replaces `#articleWrap`) drops it automatically —
 * it never leaks onto another page.
 */
function blogAccentStyleBlock(m: WikiListing): string {
  const light = sanitizeColorToken(m.accent);
  if (!light) return "";
  const dark = sanitizeColorToken(m.accentDark);
  let css = `.wiki-article-blog{--accent:${light};--accent-light:${light};}`;
  if (dark) {
    css += `html[data-theme="dark"] .wiki-article-blog{--accent:${dark};--accent-light:${dark};}`;
    css += `@media (prefers-color-scheme:dark){html:not([data-theme="light"]) .wiki-article-blog{--accent:${dark};--accent-light:${dark};}}`;
  }
  return `<style>${css}</style>`;
}

function loadPage(name: string, push: boolean): void {
  hideExplainPill(); // a page switch drops any stale pill from the prior page
  // Raised BEFORE anything else: `currentName` is only set from the response, so
  // without this signal the whole round-trip reads as the "start" view and a
  // refetch resolving mid-click would re-sort the list under the row just clicked.
  navInFlight = true;
  // A navigation is a re-render anyway, so a stashed page set lands here too —
  // and it must land BEFORE the explainer lookup below reads `allPages`.
  applyPendingPages();
  const listing = allPages.find((p) => p.name === name);
  if (listing && listing.type === "explainer") {
    loadExplainer(listing, push);
    return;
  }
  fetchAndRenderPage(withWiki("/api/wiki/page?name=" + encodeURIComponent(name)), push);
}

/** Open a page by its exact normalized relPath — collision-proof navigation used
 *  by the Atlas tab, where a same-stem page in another folder must not shadow the
 *  intended one (the by-`name` route resolves first-stem-match). Atlas never maps
 *  explainers, so this render path (no explainer branch) always applies. The
 *  relPath rides into the pushed history entry so Back/reload/share re-resolve the
 *  SAME page; `push=false` on popstate/boot replays without re-pushing. */
function loadPageByRelPath(relPath: string, push = true): void {
  hideExplainPill();
  navInFlight = true; // same in-flight window as loadPage
  applyPendingPages(); // same "navigating anyway" moment as loadPage
  fetchAndRenderPage(withWiki("/api/wiki/page?relPath=" + encodeURIComponent(relPath)), push, relPath);
}

/** Shared fetch + article render for both by-name and by-relPath navigation.
 *  When `relPath` is given (a collision-proof Atlas open), history is pushed as
 *  `?relPath=<relPath>` so the round-trip survives Back/reload/share; otherwise
 *  the name-based `?page=<name>` URL is used (existing links unchanged). */
function fetchAndRenderPage(url: string, push: boolean, relPath?: string): void {
  fetch(url)
    .then((r) => r.json())
    .then((data: WikiPageDetail) => {
      // Restore the 3-pane layout on every outcome — an error rendered into
      // #articleWrap has replaced the atlas, so the panes must come back too.
      setAtlasFull(false);
      navInFlight = false;
      if (data.error) {
        document.getElementById("articleWrap")!.innerHTML =
          `<div class="wiki-empty-state">${esc(data.error)}</div>`;
        // The PREVIOUS page's `currentName` deliberately survives a failed load, so
        // the view state keeps reading "article" and a refresh keeps deferring
        // until the reader navigates somewhere that succeeds or returns to start.
        // Erring toward "don't re-sort" is the right direction; the nav flag is
        // cleared above so it isn't a second, permanent reason to defer.
        renderList(); // the facets may have moved under us via applyPendingPages
        return;
      }
      currentName = data.meta.name;
      renderBreadcrumb(data.meta);
      if (push) {
        if (relPath) {
          history.pushState({ relPath }, "", pageUrlByRelPath(relPath));
        } else {
          history.pushState({ page: currentName }, "", pageUrl(currentName));
        }
      }
      // Blog pages get explainer-ish article chrome: an accent-tinted scope
      // (`.wiki-article-blog` + a per-page accent style block) plus the subtitle
      // rendered in `articleHeadHtml`. Non-blog pages render exactly as before.
      const isBlog = data.meta.type === "blog";
      const articleClass = isBlog ? "wiki-article wiki-article-blog" : "wiki-article";
      const accentBlock = isBlog ? blogAccentStyleBlock(data.meta) : "";
      document.getElementById("articleWrap")!.innerHTML =
        accentBlock + articleHeadHtml(data.meta) + `<div class="${articleClass}">${data.html}</div>`;
      document.getElementById("articleWrap")!.scrollTop = 0;
      // Client-side enhancement: upgrade any ```mermaid fences to inline SVG.
      // No-op (zero mermaid bytes) for pages without a mermaid fence. Covers
      // every navigation path — direct clicks, popstate, and boot deep-link all
      // funnel through loadPage. (The Ask/Explain answer replaces #articleWrap
      // with its own markup, so rendered diagrams disappear with it — not hooked.)
      enhanceMermaid(document.getElementById("articleWrap")!);
      enhanceCodeTabs(document.getElementById("articleWrap")!);
      // Fact-check layer: chip → evidence card, the summary strip, and the
      // layer toggle. No-op on a page carrying no annotation.
      enhanceFactCheck(document.getElementById("articleWrap")!);
      renderConnections(data);
      // Lazy: fetch semantic cousins after the page + connections are on screen,
      // so it never blocks the article render.
      loadSimilar(data.meta.name);
      renderList();
    })
    .catch((err: Error) => {
      setAtlasFull(false);
      navInFlight = false;
      document.getElementById("articleWrap")!.innerHTML =
        `<div class="wiki-empty-state">Failed to load page: ${esc(err.message)}</div>`;
      renderList();
    });
}

// ── Event wiring (all clicks delegated) ───────────────────────────────
document.body.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest && target.closest("#wikiWhatsNewRefresh, #wikiWhatsNewRetry")) {
    loadDigest(true);
    return;
  }
  if (target.closest && target.closest("#wikiIndexReindex")) {
    startReindex();
    return;
  }
  if (target.closest && target.closest("#wikiIndexRefresh")) {
    loadIndexCoverage(true);
    return;
  }
  // Coverage footer under the page list → open the full Index card on the start
  // view (it lazy-loads there); scroll it into view once the render settles.
  if (target.closest && target.closest("#wikiCoverageLink")) {
    renderStart();
    setTimeout(() => {
      const card = document.getElementById("wikiIndexCard");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return;
  }
  const tab = target.closest ? target.closest(".wiki-tab") : null;
  if (tab) {
    startTab = (tab.getAttribute("data-tab") as "hubs" | "timeline" | "atlas") || "hubs";
    renderStart();
    return;
  }
  // Right rail Connections | Ask tab switch (manual — focus the Ask box).
  const connTab = target.closest ? target.closest(".wiki-conn-tab") : null;
  if (connTab) {
    switchConnTab(connTab.getAttribute("data-conntab") || "conn", true);
    return;
  }
  const link = target.closest ? target.closest("[data-wiki-page], [data-page]") : null;
  if (!link) return;
  const name = link.getAttribute("data-wiki-page") || link.getAttribute("data-page");
  if (!name) return;
  e.preventDefault();
  loadPage(name, true);
});

(document.getElementById("wikiSearch") as HTMLInputElement).addEventListener("input", (e) => {
  filters.q = (e.target as HTMLInputElement).value;
  renderList();
  refreshStartBody();
});

document.getElementById("domainChips")!.addEventListener("click", function (this: HTMLElement, e) {
  const target = e.target as HTMLElement;
  const chip = target.closest ? target.closest(".wiki-chip") : null;
  if (!chip) return;
  filters.domain = chip.getAttribute("data-domain") || "";
  this.querySelectorAll(".wiki-chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  renderFolderSelect();
  renderTypeChips();
  renderStatusChips();
  renderTagChips();
  renderList();
  refreshStartBody();
  syncFilters();
});

document.getElementById("wikiFolder")!.addEventListener("change", function (this: HTMLSelectElement) {
  filters.folder = this.value;
  renderList();
  refreshStartBody();
  syncFilters();
});

document.getElementById("typeChips")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const chip = target.closest ? target.closest(".wiki-chip") : null;
  if (!chip) return;
  filters.type = chip.getAttribute("data-type") || "";
  renderTypeChips();
  renderStatusChips();
  renderTagChips();
  renderList();
  refreshStartBody();
  syncFilters();
});

// Status facet: the enum chips and the ⚑ follow-ups toggle share one row (and so
// one delegated handler), but write to two independent filter fields.
document.getElementById("statusChips")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const chip = target.closest ? target.closest(".wiki-chip") : null;
  if (!chip) return;
  if (chip.hasAttribute("data-followups")) {
    filters.followups = filters.followups ? "" : "open";
  } else {
    const status = chip.getAttribute("data-status") || "";
    // Re-clicking the active chip clears it (the tag-row convention); "All status"
    // carries an empty value and so clears by assignment.
    filters.status = filters.status === status ? "" : status;
  }
  renderStatusChips();
  renderList();
  refreshStartBody();
  syncFilters();
});

document.getElementById("tagChips")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const chip = target.closest ? target.closest(".wiki-chip") : null;
  if (!chip) return;
  if (chip.hasAttribute("data-tag-more")) {
    tagsExpanded = !tagsExpanded;
    renderTagChips();
    return;
  }
  const tag = chip.getAttribute("data-tag") || "";
  filters.tag = filters.tag === tag ? "" : tag;
  renderTagChips();
  renderList();
  refreshStartBody();
  syncFilters();
});

document.getElementById("wikiSort")!.addEventListener("change", renderList);

// Switching wiki is a full navigation — resets browse context and keeps the URL shareable.
const wikiSel = document.getElementById("wikiSelect") as HTMLSelectElement | null;
if (wikiSel) {
  wikiSel.addEventListener("change", () => {
    const value = wikiSel.value;
    location.href = value ? "/wiki?wiki=" + encodeURIComponent(value) : "/wiki";
  });
}

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  // A relPath URL (Atlas-opened page) round-trips collision-proof; check it first.
  const relPath = params.get("relPath");
  if (relPath) {
    loadPageByRelPath(relPath, false);
    return;
  }
  const page = params.get("page");
  if (page) loadPage(page, false);
  else renderStart();
});

// ── Ask tab: research-style Q&A scoped to this wiki ───────────────────
// The controls (question box · status line · history list) live in the right
// column's Ask tab; the ANSWER renders as a formatted article in the main pane
// (articleWrap). The streaming buffer is rendered progressively through the same
// `formatWebHtml` markdown pipeline (throttled to one frame per rAF), so headings/
// lists/code grow formatted during the stream rather than as a wall of plain text;
// the trailing server-rendered `answer_html` (with resolved citations) then swaps
// in as the final article.
interface AskCitation {
  n: number;
  collection: string;
  docId: string;
  title: string;
  url?: string;
  badge: string;
  relevance: number;
  wikiName?: string;
  pageName?: string;
}
interface AskTurn {
  question: string;
  answer: string; // final plain-text answer (history context + streaming fallback)
  citations: AskCitation[];
  cited: number[];
  html: string | null; // server-rendered answer body HTML (null until answer_html)
  askedAt: number;
  kind?: string; // "factcheck" for a fact-check turn (status line; PR B ➕ gate). Absent ⇒ Ask/Explain.
  baseHash?: string; // sha256 of the checked page at fact-check time (factcheck turns only; PR B round-trips it)
  page?: string; // the checked page's name — the ➕ append target (factcheck turns only)
  pageType?: string; // the checked page's type — ➕ gates markdown-only (hides on "explainer")
  toolSources?: string[]; // hostnames consulted during a fact check (WebFetch targets, deduped)
  toolSourceUrls?: Record<string, string>; // host → first full URL seen (feeds the Consulting chip hrefs). Persisted intentionally; a pre-PR / malformed-dropped turn lacks it ⇒ chips fall back to https://<host>/.
  claimCount?: number; // claims verified in a fact check (from the `done` payload; drives the meta line)
  claimOutcomes?: ClaimOutcomeCounts; // per-outcome tally for the honest fact-check meta line (persisted)
  claims?: ClaimRow[]; // per-claim checklist for a multi-claim fact check (transient; not persisted)
  toolLog?: ToolLogRow[]; // compact per-claim tool log during a fact check (transient; not persisted)
  // Which write action this turn already performed. PERSISTED, because both write
  // buttons' disabled state is derived from it at render time — a DOM-only disable
  // would come back enabled after a reload and the click would only ever 409
  // (whichever write happened staled this turn's baseHash).
  wrote?: string; // "append" | "integrate"
  // Integrate-relevant body length of the checked page (from the `done` payload;
  // omitted for explainers). Drives the client-side page-too-long gate so ~10% of
  // pages don't have to learn it from a server 400.
  bodyLen?: number;
  // Per-claim verbatim supporting passages from Phase-1 extraction, keyed by the
  // claim's 1-based index (a claim the extractor gave no quote for is absent).
  // PERSISTED: they arrive on the transient `claims` event, which is dropped at
  // `done`, and the integrate propose POST re-sends them from the turn.
  claimQuotes?: { index: number; quote: string }[];
  // Whether the checked page can carry inline <Fact> annotations (server-derived
  // .mdx-ness of the resolved path). Absent on an older server ⇒ not annotatable.
  annotatable?: boolean;
  // "Continue in chat →" state for THIS turn. In-memory only — deliberately NOT
  // part of StoredAskTurn/localStorage: the escalation is a live action, and a
  // rehydrated turn re-derives an offer-to-escalate bar rather than resurrecting a
  // link to a thread from a previous session.
  chatEsc?: ChatEscState;
}
/** Escalation state of one Ask turn, held on the TURN and never in the DOM:
 *  `#wikiChatEscBar` is a singleton node owned by whichever turn is painted, so a
 *  fetch resolving after a turn switch used to paint turn A's "✓ Opened in chat"
 *  (linking A's thread) onto turn B's bar — and on the error path wrote into a
 *  detached node, so the user saw no error at all. */
interface ChatEscState {
  status: "pending" | "done" | "exists" | "error";
  /** `done`: the thread just created · `exists`: the thread that already covers
   *  this question (built from the 409 body). Absent when the server didn't say. */
  chatUrl?: string;
  /** Whether the deep link actually got a tab — a blocked popup says so honestly
   *  instead of claiming it opened one. */
  opened?: boolean;
  /** Failure copy for the `error` state. */
  message?: string;
}
// One row of the fact-check claim checklist — pending until its verdict block lands.
// `outcome` lands with the verdict (server `claim_result`) and drives the distinct
// checklist label. The band-colored confidence chip is rendered from the verdict
// block's own `Confidence: NN/100` line by enhanceConfidenceHtml (no separate field).
interface ClaimRow { index: number; title: string; status: string; block: string; outcome?: string; }
const askTurns: AskTurn[] = [];
let askConn: SseHandle | null = null;
let askActive: AskTurn | null = null; // the turn currently streaming, or null
let askShownTurn: AskTurn | null = null; // the turn currently painted in the pane
let askBuffer = ""; // streamed plain-text accumulator for askActive
let composeText = ""; // fact-check compose lede accumulator (Phase 3 deltas)
let askRenderRaf = 0; // pending progressive-render frame (0 = none)
const ASK_MAX_HISTORY = 4;
const ASK_ANSWER_CHARS = 700;

/** Throttle progressive markdown renders of the streaming buffer to one per
 *  animation frame (as the web chat does), coalescing bursts of deltas. The
 *  frame re-checks identity + final-HTML at FIRE time: a frame scheduled just
 *  before `answer_html` lands (or before a follow-up ask swaps `askConn`) must
 *  not repaint over the final article or clobber the newer turn's pane. */
function scheduleAskStreamRender(turn: AskTurn, conn: SseHandle): void {
  if (askRenderRaf) return;
  askRenderRaf = requestAnimationFrame(() => {
    askRenderRaf = 0;
    if (askConn !== conn) return; // superseded by a newer ask
    if (turn.html) return; // final article already swapped in
    const b = document.getElementById("askAnswerBody");
    if (b) { b.innerHTML = renderStreamingBody(askBuffer); } // confidence chip baked into renderStreamingBody
  });
}

/** Rebuild `askBuffer` for a multi-phase fact-check turn: the compose lede (empty
 *  until Phase 3) on top, then each claim's verdict block (once verified) or its
 *  pending checklist row (`n. ☐ <title>`), in claim order. Called on every
 *  `claims`/`claim_result`/compose-`delta` so the pane grows coherently with no
 *  transient bottom-then-top reorder at `done`. */
function rebuildFactcheckBuffer(turn: AskTurn): void {
  const claims = turn.claims || [];
  const rows = claims.map((c) => factcheckRowMarkdown(c));
  askBuffer = (composeText ? composeText + "\n\n" : "") + rows.join("\n\n");
}

/** One checklist row's live markdown. Pending ⇒ `n. ☐ title`. A real verdict
 *  (verified / model-chosen unverifiable) renders the model block verbatim (its
 *  emoji + reasoning + `Confidence:` line, chip-enhanced post-render). The
 *  synthetic non-verdict outcomes get a DISTINCT compact label instead of a
 *  generic ❓ block, so "ran out of time" reads differently from "the web
 *  genuinely doesn't know" (the persisted answer keeps ❓ — this is live-only). */
function factcheckRowMarkdown(c: ClaimRow): string {
  if (c.status !== "done") return c.index + ". ☐ " + c.title;
  if (c.outcome === "timeout") return c.index + ". ⏱️ " + c.title + " — timed out";
  if (c.outcome === "skipped") return c.index + ". ⏭️ " + c.title + " — skipped (out of time)";
  if (c.outcome === "error") return c.index + ". ⚠️ " + c.title + " — verification failed";
  return c.block || c.index + ". ☐ " + c.title;
}

/** Cancel any pending progressive-render frame (on supersede / done / final swap). */
function cancelAskStreamRender(): void {
  if (askRenderRaf) {
    cancelAnimationFrame(askRenderRaf);
    askRenderRaf = 0;
  }
}

/** Compact, bounded replay of committed turns sent as context on each follow-up. */
function askHistoryParam(): string {
  if (!askTurns.length) return "";
  const recent = askTurns.slice(-ASK_MAX_HISTORY).map((t) => ({
    q: (t.question || "").slice(0, 500),
    a: (t.answer || "").slice(0, ASK_ANSWER_CHARS),
  }));
  return JSON.stringify(recent);
}

/** Update the single status line in the Ask controls. Empty text hides it. */
function setAskStatus(text: string, state: string): void {
  const wrap = document.getElementById("wikiAskStatus");
  if (!wrap) return;
  wrap.className = "wiki-ask-status" + (state ? " " + state : "");
  wrap.style.display = text ? "flex" : "none";
  const st = wrap.querySelector(".st") as HTMLElement | null;
  if (st) st.textContent = text;
}

/** Relative "asked …" label for the answer's meta row. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

/** Render the citation list — matched pages become in-reader links (data-page,
 *  handled by the global delegated click), the rest are plain rows. */
function askSourcesHtml(citations: AskCitation[], cited: number[]): string {
  if (!citations.length) return "";
  const citedSet: Record<number, boolean> = {};
  (cited || []).forEach((n) => { citedSet[n] = true; });
  const anyCited = (cited || []).length > 0;
  const rows = citations
    .map((c) => {
      const uncited = anyCited && !citedSet[c.n] ? " uncited" : "";
      const linked = c.pageName ? " linked" : "";
      const pageAttr = c.pageName ? ' data-page="' + esc(c.pageName) + '"' : "";
      const pageTag = c.pageName ? '<span class="wiki-ask-src-page">page ↗</span>' : "";
      return (
        '<div class="wiki-ask-src' + uncited + linked + '"' + pageAttr + ">" +
        '<span class="wiki-ask-src-num">' + c.n + "</span>" +
        '<span class="wiki-ask-src-badge">' + esc(c.badge || "") + "</span>" +
        '<span class="wiki-ask-src-title">' + esc(c.title || c.docId) + "</span>" +
        pageTag +
        "</div>"
      );
    })
    .join("");
  return '<div class="wiki-ask-src-head">Sources</div>' + rows;
}

/** Meta line under the answer's headline. Ask/Explain: "Asked … · wiki: X · N sources".
 *  Fact-check has no retrieval sources (`citations` is always empty), so counting
 *  them shows a misleading "0 sources" next to the "Consulting: <hosts>" chip row —
 *  instead report the claim count + the number of sites actually opened. */
function askMetaText(turn: AskTurn): string {
  const prefix = "Asked " + relTime(turn.askedAt) + (WIKI ? " · wiki: " + WIKI : "");
  if (turn.kind === "factcheck") {
    const sites = (turn.toolSources || []).length;
    const sitesLabel = sites ? " · " + sites + " site" + (sites === 1 ? "" : "s") + " consulted" : "";
    // Prefer the honest per-outcome breakdown ("5 verified · 1 unverifiable · 2
    // skipped"); fall back to the plain claim count for a pre-outcome turn.
    const summary = turn.claimOutcomes ? factcheckOutcomeSummary(turn.claimOutcomes) : "";
    if (summary) return prefix + " · " + summary + sitesLabel;
    const claims = typeof turn.claimCount === "number" ? turn.claimCount : 0;
    return prefix + " · " + claims + " claim" + (claims === 1 ? "" : "s") + sitesLabel;
  }
  const n = turn.citations.length;
  return prefix + " · " + n + " source" + (n === 1 ? "" : "s");
}

/** Follow-up bar rendered under every Ask/Explain answer (input + Ask button).
 *  Bound via document-level delegation (`showAskAnswer` replaces the whole pane
 *  per turn, destroying direct listeners). Disabled until the turn is committed
 *  (`turn.answer` is assigned only in the `done` handler) — the `done`/`answer_html`
 *  handlers re-enable it by id, since they replace only `#askAnswerBody`. */
function askFollowupHtml(turn: AskTurn): string {
  const disabled = turn.answer ? "" : " disabled";
  return (
    '<div class="wiki-followup" id="wikiFollowupBar">' +
    '<input id="wikiFollowupInput" class="wiki-followup-input" type="text" ' +
    'placeholder="Ask a follow-up…" autocomplete="off"' + disabled + " />" +
    '<button id="wikiFollowupBtn" class="wiki-followup-btn"' + disabled + ">Ask</button>" +
    "</div>"
  );
}

/** "Remember this" button rendered under the follow-up bar. Persists the shown
 *  turn's Q&A as a durable memory (POST /api/wiki/remember). Gated on the turn
 *  being committed (same `turn.answer` gate as the follow-up bar) and bound via
 *  document-level delegation. One save per render — a re-render resets it. */
function askRememberHtml(turn: AskTurn): string {
  const disabled = turn.answer ? "" : " disabled";
  return (
    '<div class="wiki-remember" id="wikiRememberBar">' +
    '<button id="wikiRememberBtn" class="wiki-remember-btn"' + disabled + ">Remember this</button>" +
    '<span class="wiki-remember-msg" id="wikiRememberMsg"></span>' +
    "</div>"
  );
}

/** "Continue in chat →" bar, a sibling of Remember. Escalates the shown turn into
 *  a real conversation thread for the wiki's owning bot (POST /api/wiki/ask/chat),
 *  seeded with the question + this answer + its sources, and opens the chat
 *  deep-link in a new tab. Its own bar (not the Remember bar, whose innerHTML is
 *  swapped wholesale on a successful save). Bound via document-level delegation.
 *
 *  The WRAPPER is always rendered (even when the inner markup is empty): the pane
 *  is painted before the answer exists, and `refreshChatEscalateBar` fills the bar
 *  in place at `done` — which needs the node to be there. `.wiki-chatesc:empty`
 *  hides the empty row. */
function askChatEscalateHtml(turn: AskTurn): string {
  return '<div class="wiki-chatesc" id="wikiChatEscBar">' + chatEscInnerHtml(turn) + "</div>";
}

/** Inner markup of the escalate bar, DERIVED from `turn.chatEsc` so a re-render —
 *  a `done` refresh, a turn switch, re-opening the turn from history — reproduces
 *  the state instead of losing (or misattributing) it. */
function chatEscInnerHtml(turn: AskTurn): string {
  // No committed answer (still streaming, or a turn that died at app_error / an
  // SSE drop): the click's only possible outcome is a silent no-op, so render no
  // bar at all rather than a button that does nothing.
  if (!turn.answer) return "";
  // Fact-check turns are excluded: the question is synthetic and the answer is
  // tool-produced, so the seed's "answered from indexed page excerpts alone — no
  // memories, no tools" framing would be false. (Same turn-kind gate shape as
  // `askFactcheckAppendHtml`.)
  if (turn.kind === "factcheck") return "";
  const st = turn.chatEsc;
  if (st?.status === "done") {
    return (
      '<a class="wiki-chatesc-done" href="' + esc(st.chatUrl || "") + '" target="_blank">' +
      (st.opened ? "✓ Opened in chat →" : "Chat thread created — open it →") +
      "</a>"
    );
  }
  if (st?.status === "exists") {
    // A 409 is NOT auto-retried with `forceNew` — that minted a fresh thread (and
    // a fresh auto-sent model turn) on every re-click. Offer the existing thread,
    // and make starting another an explicit second choice.
    return (
      '<span class="wiki-chatesc-msg">A chat for this question already exists' +
      (st.chatUrl
        ? ' — <a class="wiki-chatesc-done" href="' + esc(st.chatUrl) + '" target="_blank">Open it →</a>'
        : "") +
      "</span>" +
      '<button id="wikiChatEscNewBtn" class="wiki-chatesc-btn">Start new thread</button>'
    );
  }
  const pending = st?.status === "pending";
  return (
    '<button id="wikiChatEscBtn" class="wiki-chatesc-btn"' + (pending ? " disabled" : "") + ">" +
    (pending ? "Opening chat…" : "Continue in chat →") + "</button>" +
    // Same escalation, with the choices the one-click path decides for you (user,
    // model, thread name). Opens the shared popover.
    '<button id="wikiChatEscOptBtn" class="wiki-chatesc-gear" title="Chat options…"' +
    (pending ? " disabled" : "") + ' aria-label="Chat options">⚙</button>' +
    '<span class="wiki-chatesc-msg' + (st?.status === "error" ? " error" : "") +
    '" id="wikiChatEscMsg">' + esc(st?.status === "error" ? st.message || "" : "") + "</span>"
  );
}

/** Re-render the escalate bar from the turn. TURN-GUARDED for the same reason
 *  `refreshWriteActionBars` is: the bar is a singleton node belonging to whichever
 *  turn is on screen. Nothing is lost by skipping — `showAskAnswer` renders the
 *  bar from the newly shown turn's own `chatEsc`. */
function refreshChatEscalateBar(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const bar = document.getElementById("wikiChatEscBar");
  if (bar) bar.innerHTML = chatEscInnerHtml(turn);
}

/** "➕ Add to article" button — ONLY on committed fact-check turns whose page is
 *  markdown (never an explainer, whose .html can't take a markdown callout).
 *  Persists the fact-check answer as a `> [!factcheck]` callout on the page
 *  (POST /api/wiki/factcheck/append). Bound via document-level delegation, gated
 *  on the turn being committed (same `turn.answer` gate as the follow-up bar). */
function askFactcheckAppendHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck" || turn.pageType === "explainer" || !turn.page) return "";
  return (
    '<div class="wiki-fc-append" id="wikiFactcheckAppendBar">' +
    factcheckAppendInnerHtml(turn) +
    "</div>"
  );
}

/** Inner markup of the ➕ bar, DERIVED from the turn (never mutated in place only)
 *  so a re-render — including a rehydrated turn after a reload — reproduces the
 *  post-write state. An integrate write staled this turn's `baseHash`, so the
 *  button goes disabled with the same copy a live 409 would show. */
function factcheckAppendInnerHtml(turn: AskTurn): string {
  if (turn.wrote === "append") {
    return '<span class="wiki-fc-append-done">✓ Added to article</span>';
  }
  const blocked = appendBlockedByIntegrate(turn);
  const disabled = turn.answer && !blocked ? "" : " disabled";
  return (
    '<button id="wikiFactcheckAppendBtn" class="wiki-fc-append-btn"' + disabled + ">➕ Add to article</button>" +
    '<span class="wiki-fc-append-msg' + (blocked ? " error" : "") + '" id="wikiFactcheckAppendMsg">' +
    (blocked ? esc(INTEGRATE_STALE_COPY) : "") +
    "</span>"
  );
}

/** "✎ Integrate into article" — the second write action on a fact-check turn.
 *  Unlike ➕ (which appends a callout) it EDITS THE PROSE, so it only renders when
 *  the check actually found something correctable (a ❌/⚠️ claim block, via the
 *  shared heading parser — never a substring scan) on a markdown page within the
 *  integrate body cap. The whole bar is derived from `integrateBarState`. */
function askFactcheckIntegrateHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck" || turn.pageType === "explainer" || !turn.page) return "";
  // An all-✅ / non-correctable check never becomes integrable, so drop the
  // wrapper entirely — it carries margin, and an always-empty div left a phantom
  // gap under the ➕ row. A `pending` turn KEEPS the (empty) wrapper: `done`
  // fills it in place via `refreshWriteActionBars`, which needs the node to exist.
  // `.wiki-fc-integrate:empty` hides it meanwhile.
  if (integrateBarState(turn) === "hidden") return "";
  return (
    '<div class="wiki-fc-integrate" id="wikiFactcheckIntegrateBar">' +
    factcheckIntegrateInnerHtml(turn) +
    "</div>"
  );
}

function factcheckIntegrateInnerHtml(turn: AskTurn): string {
  const state = integrateBarState(turn);
  if (state === "hidden" || state === "pending") return "";
  if (state === "done") {
    // Within the session the label carries the full outcome copy (edit count +
    // whether it was committed); a rehydrated turn only knows THAT it integrated.
    const note = integratedNotes[turn.askedAt];
    return '<span class="wiki-fc-int-done">' + esc(note || "✓ Integrated") + "</span>";
  }
  if (state === "blocked-append") {
    return (
      '<button class="wiki-fc-int-open" disabled>✎ Integrate into article</button>' +
      '<span class="wiki-fc-int-bar-msg error">' + esc(INTEGRATE_STALE_COPY_EDIT) + "</span>"
    );
  }
  if (state === "too-long") {
    return (
      '<button class="wiki-fc-int-open" disabled>✎ Integrate into article</button>' +
      '<span class="wiki-fc-int-bar-msg">This page is too long to integrate automatically ' +
      "— edit it by hand, or add the callout instead.</span>"
    );
  }
  // Nothing to correct AND no verbatim passage to mark: the only reachable outcome
  // is an empty panel, so say why instead of offering the click.
  if (state === "no-anchors") {
    return (
      '<button class="wiki-fc-int-open" disabled>✎ Integrate into article</button>' +
      '<span class="wiki-fc-int-bar-msg">' + esc(INTEGRATE_NO_ANCHORS_COPY) + "</span>"
    );
  }
  // In-flight propose is TURN state, not DOM state: a re-render (a `done`
  // refresh, an SSE drop, re-opening the turn from history) must reproduce the
  // disabled "Proposing…" button, or a second click races the first and the
  // loser's `finally` pins a stale label.
  const proposing = integrateProposing === turn;
  const msg = integrateBarMsgs[turn.askedAt];
  return (
    '<button id="wikiFactcheckIntegrateBtn" class="wiki-fc-int-open"' +
    (proposing ? " disabled" : "") + ">" +
    (proposing ? "Proposing edits… up to ~90s" : "✎ Integrate into article") + "</button>" +
    '<span class="wiki-fc-int-bar-msg' + (msg?.error ? " error" : "") +
    '" id="wikiFactcheckIntegrateMsg">' + esc(msg?.text || "") + "</span>"
  );
}

/** Full success copy per integrated turn, keyed by `askedAt` (edit count + commit
 *  outcome). Transient by design — the durable fact is the persisted `turn.wrote`;
 *  this only enriches the label within the session, and a rehydrated turn falls
 *  back to a bare "✓ Integrated". */
const integratedNotes: Record<number, string> = {};

/** Per-turn ✎ bar message (a 409, a propose failure, the too-long copy), keyed by
 *  `askedAt` like {@link integratedNotes}. Held off the DOM so a re-render — which
 *  replaces the bar's innerHTML wholesale — reproduces it instead of wiping it. */
const integrateBarMsgs: Record<number, { text: string; error: boolean }> = {};

/** The turn whose propose call is currently in flight (at most one — the bar
 *  disables while it runs). Module-level so the bar's rendered state is derived,
 *  never mutated in place. */
let integrateProposing: AskTurn | null = null;

/** Re-render BOTH write-action bars from the turn. Called at `done` (the pane was
 *  painted before the answer existed, so the gates couldn't run yet) and after any
 *  write. The rendered state is authoritative — `turn.wrote` drives it.
 *
 *  TURN-GUARDED, exactly like `renderIntegratePreview`: the two bars are SINGLETON
 *  nodes belonging to whichever turn is painted, so a late caller for another turn
 *  (a ~90s propose or an SSE handler resolving after the reader switched turns)
 *  would paint turn A's live ✎ button — or its 409 copy — into turn B's retired
 *  bar, reviving a button whose click fires a doomed one-shot against the wrong
 *  page. Nothing is lost by skipping: `showAskAnswer` re-renders both bars from
 *  the newly shown turn (`askArticleHtml` → `askFactcheck*Html`), and every piece
 *  of bar state is held off the DOM (`turn.wrote`, `integrateBarMsgs`,
 *  `integratedNotes`, `integrateProposing`) so re-opening the turn reproduces it. */
function refreshWriteActionBars(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const appendBar = document.getElementById("wikiFactcheckAppendBar");
  if (appendBar) appendBar.innerHTML = factcheckAppendInnerHtml(turn);
  const intBar = document.getElementById("wikiFactcheckIntegrateBar");
  if (intBar) intBar.innerHTML = factcheckIntegrateInnerHtml(turn);
  // The escalate bar is derived from the same turn and rides the same commit gate
  // (it renders nothing until `turn.answer` exists), so it refreshes here rather
  // than at five separate SSE call sites where one could quietly be missed. It is
  // rendered from `turn.chatEsc`, so this is idempotent.
  refreshChatEscalateBar(turn);
}

/** Only http(s) URLs are safe to put in a chip href (the URL is model output). A
 *  non-http(s) or missing value degrades to `https://<host>/` — the host itself
 *  comes from `new URL(...).hostname` server-side, so it's a real hostname. */
function factcheckSrcHref(host: string, url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? url : "https://" + host + "/";
}

/** Inner markup of the "Consulting" chip row — a label + one linked chip per
 *  consulted hostname (opens the source in a new tab). Empty string when there are
 *  none (the container then hides). The href is the first full URL seen for that
 *  host (`toolSourceUrls`), falling back to `https://<host>/` for a rehydrated turn
 *  that only persisted the hostnames. */
function toolSourceChips(turn: AskTurn): string {
  const hosts = turn.toolSources || [];
  if (!hosts.length) return "";
  const urls = turn.toolSourceUrls || {};
  return (
    '<span class="wiki-fc-src-label">Consulting</span>' +
    hosts
      .map(
        (h) =>
          '<a class="wiki-fc-src-chip" href="' + esc(factcheckSrcHref(h, urls[h])) +
          '" target="_blank" rel="noopener">' + esc(h) + "</a>",
      )
      .join("")
  );
}

/** The "Consulting: host · host" chip row for a fact-check turn. Always emitted
 *  (hidden while empty) so `refreshAskToolSources` can populate it live during the
 *  stream. Renders nothing on non-fact-check turns. */
function askToolSourcesHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck") return "";
  const has = (turn.toolSources || []).length > 0;
  return (
    '<div class="wiki-fc-sources" id="askToolSources"' +
    (has ? "" : ' style="display:none"') + ">" + toolSourceChips(turn) + "</div>"
  );
}

/** Inner rows of the compact per-claim tool log — one line per verify step,
 *  `Claim n · <label>[: <detail>]`, dimmed once done. Empty string when there
 *  are no rows (the container then hides). */
function toolLogRows(turn: AskTurn): string {
  const rows = turn.toolLog || [];
  if (!rows.length) return "";
  return rows
    .map((r) =>
      '<div class="wiki-fc-tool' + (r.done ? " done" : "") + '">' +
      '<span class="wiki-fc-tool-claim">Claim ' + r.claimIndex + "</span>" +
      '<span class="wiki-fc-tool-label">' + esc(toolLogRowLabel(r)) + "</span>" +
      '<span class="wiki-fc-tool-state">' + (r.done ? "✓" : "…") + "</span>" +
      "</div>",
    )
    .join("");
}

/** The compact per-claim tool log for a fact-check turn — a scrolling list of
 *  live verify steps under the Consulting chips. Always emitted (hidden while
 *  empty) so `refreshAskToolLog` can populate it live. Ephemeral: `turn.toolLog`
 *  is cleared at `done`, so a committed/rehydrated turn never re-renders it. */
function askToolLogHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck") return "";
  const has = (turn.toolLog || []).length > 0;
  return (
    '<div class="wiki-fc-toollog" id="askToolLog" data-log' +
    (has ? "" : ' style="display:none"') + ">" + toolLogRows(turn) + "</div>"
  );
}

/** Re-render the on-screen tool log in place as verify steps arrive, then
 *  auto-scroll to the newest row (same as /agents' mini-log). The article body
 *  still streams separately, so only this container is repainted. */
function refreshAskToolLog(turn: AskTurn): void {
  const el = document.getElementById("askToolLog");
  if (!el) return;
  el.innerHTML = toolLogRows(turn);
  el.style.display = (turn.toolLog || []).length ? "flex" : "none";
  el.scrollTop = el.scrollHeight;
}

/** Update the on-screen "Consulting" chip row in place as WebFetch hosts arrive
 *  (the article body still streams, so re-render just this container). */
function refreshAskToolSources(turn: AskTurn): void {
  const el = document.getElementById("askToolSources");
  if (!el) return;
  el.innerHTML = toolSourceChips(turn);
  el.style.display = (turn.toolSources || []).length ? "flex" : "none";
}

/** Full article-pane HTML for one Ask turn: question headline, meta row, the
 *  fact-check "Consulting" chip row (fact-check turns only), answer body (rendered
 *  final article once available, else the progressively-formatted streaming
 *  buffer), then Sources, then the follow-up bar, then Remember, then — for
 *  fact-check turns on markdown pages — the ➕ Add-to-article button. */
function askArticleHtml(turn: AskTurn, buffer: string): string {
  const body = askAnswerBodyHtml(turn.html, buffer, turn.answer);
  return (
    '<div class="wiki-article-head"><h1>' + esc(turn.question) + "</h1>" +
    '<div class="wiki-meta-row"><span class="wiki-dates" id="askAnswerMeta">' +
    esc(askMetaText(turn)) + "</span></div></div>" +
    askToolLogHtml(turn) +
    askToolSourcesHtml(turn) +
    '<div class="wiki-article wiki-ask-article" id="askAnswerBody">' + body + "</div>" +
    '<div class="wiki-ask-sources" id="askAnswerSources">' +
    askSourcesHtml(turn.citations, turn.cited) + "</div>" +
    askFollowupHtml(turn) +
    askRememberHtml(turn) +
    askChatEscalateHtml(turn) +
    askFactcheckAppendHtml(turn) +
    askFactcheckIntegrateHtml(turn) +
    // Transient per-turn preview host — the proposal is never persisted, so a
    // rehydrated turn simply re-proposes on click (its inputs, the persisted
    // answer + baseHash, are all the propose route needs).
    '<div class="wiki-fc-int-host" id="wikiFcIntHost"></div>'
  );
}

/** Enable/disable the follow-up + Remember controls by id (they may not exist yet
 *  at module load, and the article pane is re-rendered per turn — always look up
 *  fresh). The Remember button rides the same commit gate as the follow-up bar.
 *
 *  The two WRITE buttons are deliberately NOT here. Their state is derived from
 *  `turn.wrote` + the in-flight propose flag (`refreshWriteActionBars`), and a
 *  blanket `setFollowupDisabled(false)` from an SSE drop or the `end` fallback
 *  would force-enable a button the derivation had correctly retired — reviving a
 *  ✎ button mid-propose so a second click races the first. Every site that used
 *  to rely on this re-derives instead. */
function setFollowupDisabled(disabled: boolean): void {
  const input = document.getElementById("wikiFollowupInput") as HTMLInputElement | null;
  const btn = document.getElementById("wikiFollowupBtn") as HTMLButtonElement | null;
  if (input) input.disabled = disabled;
  if (btn) btn.disabled = disabled;
  const remember = document.getElementById("wikiRememberBtn") as HTMLButtonElement | null;
  if (remember) remember.disabled = disabled;
  // "Continue in chat →" is deliberately NOT here, for the same reason the two
  // write buttons aren't: every terminal path (app_error / end / onerror) called
  // `setFollowupDisabled(false)`, which force-enabled the button on turns that
  // never committed — and clicking it was then a silent no-op. Its state is
  // derived from the turn (`refreshChatEscalateBar`).
}

/** Paint an Ask turn into the main article pane (replaces the page/start view). */
function showAskAnswer(turn: AskTurn, buffer: string): void {
  currentName = null;
  hideBreadcrumb(); // an Ask answer replaces the page — no breadcrumb
  askShownTurn = turn; // the turn the in-pane Remember button acts on
  document.getElementById("articleWrap")!.innerHTML = askArticleHtml(turn, buffer);
  // The preview is TURN-KEYED, not "whatever was last proposed": nulling it here
  // stranded a ~90s propose whose user had switched turns (and, worse, an earlier
  // build painted the panel under an unrelated turn, whose Apply then wrote turn
  // A's page). It survives the swap; `renderIntegratePreview` paints it only when
  // its own turn is the one on screen, so re-opening that turn from history brings
  // the pending/ready preview back.
  renderIntegratePreview();
  // Rehydrated turns (history re-show) inject stored answer HTML that may carry
  // mermaid fences; the streaming paths hook separately. No-op when absent.
  const askBody = document.getElementById("askAnswerBody");
  if (askBody) {
    // Confidence chips are already baked into the body HTML by askAnswerBodyHtml.
    enhanceMermaid(askBody);
    enhanceCodeTabs(askBody);
  }
  document.getElementById("articleWrap")!.scrollTop = 0;
  document.getElementById("connBody")!.innerHTML =
    '<div class="wiki-conn-empty">Showing an Ask answer — sources are listed under it.</div>';
  renderList();
}

/** Refresh the meta count + sources block of the on-screen answer in place
 *  (used when the `sources`/`done` events land while the body still streams). */
function refreshAskSources(turn: AskTurn): void {
  const meta = document.getElementById("askAnswerMeta");
  if (meta) meta.textContent = askMetaText(turn);
  const s = document.getElementById("askAnswerSources");
  if (s) s.innerHTML = askSourcesHtml(turn.citations, turn.cited);
}

/** History list in the Ask controls — one clickable line per committed turn,
 *  newest first. Clicking re-renders that turn's stored answer in the main pane. */
function renderAskHistory(): void {
  const el = document.getElementById("wikiAskHistory");
  if (!el) return;
  if (!askTurns.length) { el.innerHTML = ""; return; }
  let html =
    '<div class="wiki-ask-hist-head">This session' +
    '<span class="wiki-ask-hist-clear" id="wikiAskHistClear" title="Clear this session">clear</span>' +
    "</div>";
  for (let i = askTurns.length - 1; i >= 0; i--) {
    html +=
      '<div class="wiki-ask-hist-item" data-ask-idx="' + i + '">' +
      esc(askTurns[i]!.question) + "</div>";
  }
  el.innerHTML = html;
}

/** Shared stream runner for the Ask box AND the Explain pill: supersede any
 *  in-flight ask, paint `turn` into the main pane, and drive the SSE stream to
 *  completion. The `delta`/`done` handlers read the module-level `askBuffer`, so
 *  the reset here is load-bearing — omitting it bleeds a stale buffer across
 *  turns. Both entry points converge here so the committed turn lands in
 *  `askTurns` (session history + follow-up context) with zero extra code. */
function runAskStream(url: string, turn: AskTurn): void {
  // Supersede any in-flight ask: close its stream so late events are ignored, and
  // drop any pending progressive-render frame so it can't repaint the new pane.
  if (askConn) { askConn.close(); askConn = null; }
  cancelAskStreamRender();
  // Reveal the Ask tab in the rail so the compose + session history are visible
  // while the answer streams into the main pane. Covers the Ask box, the in-pane
  // follow-up bar, and Explain (all converge here). No focus steal — the follow-up
  // input in the article pane keeps the caret.
  switchConnTab("ask");
  askActive = turn;
  askBuffer = "";
  composeText = "";
  showAskAnswer(turn, "");
  // Fact-check starts with claim extraction (Haiku), then per-claim web verification.
  setAskStatus(turn.kind === "factcheck" ? "Extracting claims…" : "Searching…", "");
  const btn = document.getElementById("wikiAskBtn") as HTMLButtonElement;
  btn.disabled = true;
  setFollowupDisabled(true);

  const conn = sseClient(url, {
    phase: (e: MessageEvent) => {
      const d = JSON.parse((e as MessageEvent).data);
      setAskStatus(d.phase === "synthesizing" ? "Synthesizing…" : "Searching…", "");
    },
    sources: (e: MessageEvent) => {
      // Guard against a superseded connection whose late events would clobber the
      // active turn (a follow-up ask swaps askConn before the old stream drains).
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      turn.citations = d.citations || [];
      refreshAskSources(turn);
    },
    delta: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      // On a fact-check turn WITH a claim checklist, deltas are the Phase-3 compose
      // lede — accumulate them separately and rebuild the buffer so they render
      // ABOVE the blocks (append-only `askBuffer +=` would put them at the bottom).
      if (turn.kind === "factcheck" && turn.claims && turn.claims.length) {
        composeText += d.text || "";
        rebuildFactcheckBuffer(turn);
      } else {
        askBuffer += d.text || "";
      }
      if (!turn.html) scheduleAskStreamRender(turn, conn);
    },
    // Phase 1 — the extracted claim list. Seed the checklist + rebuild the buffer.
    // Once total > 1 the claim counter OWNS the status line (per-tool events stop
    // overwriting it; with concurrency 2 the host flips would thrash).
    claims: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      const list = Array.isArray(d.claims) ? d.claims : [];
      turn.claims = list.map((c: { index: number; title: string }) => ({
        index: c.index, title: c.title, status: "pending", block: "",
      }));
      // The checklist itself is transient (cleared at `done`), so the quotes are
      // lifted onto the turn HERE — this event is the only place they exist. The
      // lift is the pure, unit-tested `claimQuotesFromClaimsEvent`; claims the
      // extractor gave no usable quote for are simply absent from the list.
      const quotes = claimQuotesFromClaimsEvent(list);
      turn.claimQuotes = quotes.length ? quotes : undefined;
      composeText = "";
      rebuildFactcheckBuffer(turn);
      if (!turn.html) scheduleAskStreamRender(turn, conn);
      if (turn.claims && turn.claims.length > 1) {
        setAskStatus("Verifying claim 0/" + turn.claims.length + "…", "");
      }
    },
    // Phase 2 — a claim's verdict block landed. Mark it done, store the block,
    // rebuild the buffer (blocks-or-checklist-rows in claim order), re-render.
    claim_result: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      if (!turn.claims) return;
      const row = turn.claims.find((c) => c.index === d.index);
      if (row) {
        row.status = "done";
        row.block = typeof d.markdown === "string" ? d.markdown : "";
        row.outcome = typeof d.outcome === "string" ? d.outcome : undefined;
      }
      rebuildFactcheckBuffer(turn);
      if (!turn.html) scheduleAskStreamRender(turn, conn);
      if (turn.claims.length > 1) {
        const done = turn.claims.filter((c) => c.status === "done").length;
        setAskStatus("Verifying claim " + done + "/" + turn.claims.length + "…", "");
      }
    },
    // Live tool progress — fact-check only (Ask/Explain never emit `tool`). Drives
    // the "Searching the web / Reading <host>" status line and accumulates the
    // "Consulting" hostname chips (WebFetch targets, deduped) on the turn.
    tool: (e: MessageEvent) => {
      if (askConn !== conn) return;
      if (turn.kind !== "factcheck") return;
      const d = JSON.parse((e as MessageEvent).data);
      // Compact per-claim tool log — folds every start/end (paired by name +
      // claimIndex, so concurrent claims resolve to their own rows) into a
      // scrolling list under the Consulting chips. Rendered on ALL fact-check
      // turns (it lives in the article pane, not the rail, so it doesn't compete
      // with the status line the way the per-tool narration below would). Cleared
      // at `done` — never persisted.
      if (!turn.toolLog) turn.toolLog = [];
      applyToolLogEvent(turn.toolLog, {
        state: d.state === "end" ? "end" : "start",
        name: typeof d.name === "string" ? d.name : "",
        claimIndex: typeof d.claimIndex === "number" ? d.claimIndex : 0,
        label: typeof d.label === "string" ? d.label : undefined,
        detail: typeof d.detail === "string" ? d.detail : undefined,
      });
      refreshAskToolLog(turn);
      // With a multi-claim checklist the claim counter owns the status line — don't
      // let per-tool flips thrash it. A single-claim (sel) run keeps tool narration.
      const multiClaim = !!(turn.claims && turn.claims.length > 1);
      if (d.state === "start") {
        const detail = typeof d.detail === "string" ? d.detail : "";
        if (!multiClaim) {
          const label = typeof d.label === "string" && d.label ? d.label : "Working";
          setAskStatus(label + (detail ? ": " + detail : "") + "…", "");
        }
        // WebFetch carries a hostname detail — record deduped consulted sources,
        // keeping the FIRST full URL seen per host for the chip href.
        if (detail && d.name === "WebFetch") {
          if (!turn.toolSources) turn.toolSources = [];
          if (turn.toolSources.indexOf(detail) === -1) {
            turn.toolSources.push(detail);
            if (typeof d.url === "string" && d.url) {
              if (!turn.toolSourceUrls) turn.toolSourceUrls = {};
              if (!turn.toolSourceUrls[detail]) turn.toolSourceUrls[detail] = d.url;
            }
            refreshAskToolSources(turn);
          }
        }
      } else if (d.state === "end") {
        if (!multiClaim) setAskStatus("Checking the web…", "");
      }
    },
    done: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      turn.answer = d.answer || askBuffer || "";
      turn.cited = d.cited || [];
      askBuffer = turn.answer;
      // Keep the streamed (now fully-formatted) answer visible until (and unless)
      // `answer_html` arrives; render the final buffer directly and drop any
      // pending frame so it can't repaint stale text afterward. Refresh sources +
      // the meta count with the final `cited` set.
      cancelAskStreamRender();
      const b = document.getElementById("askAnswerBody");
      if (b && !turn.html) { b.innerHTML = renderStreamingBody(turn.answer); enhanceMermaid(b); enhanceCodeTabs(b); } // chip baked into renderStreamingBody
      refreshAskSources(turn);
      let statusText: string;
      if (turn.kind === "factcheck") {
        // Fact-check has no retrieval sources — report the claim count instead.
        turn.baseHash = typeof d.baseHash === "string" ? d.baseHash : undefined;
        // Integrate-relevant body length of the checked page — omitted entirely
        // for explainers (they can never be integrated), so an absent value is
        // meaningful and must stay undefined rather than defaulting to 0.
        turn.bodyLen = typeof d.bodyLen === "number" ? d.bodyLen : undefined;
        // .mdx-ness of the checked page, decided server-side from the resolved
        // path. Absent (older server) stays undefined — never defaulted to false,
        // so "unknown" and "definitely not annotatable" remain distinguishable.
        turn.annotatable = typeof d.annotatable === "boolean" ? d.annotatable : undefined;
        // Tally the per-outcome breakdown from the checklist BEFORE it's cleared
        // below — it's persisted (drives the honest meta line on rehydrated turns).
        turn.claimOutcomes = tallyClaimOutcomes(turn.claims);
        const n = typeof d.claimCount === "number" ? d.claimCount : 0;
        turn.claimCount = n; // drives the meta line's "N claims · M sites consulted"
        refreshAskSources(turn); // repaint the meta line now that claimCount is set
        statusText = n > 0
          ? "Checked " + n + " claim" + (n === 1 ? "" : "s") + " against the web"
          : "Fact check complete";
      } else if (d.lowConfidence) statusText = "No strong match — closest sources below";
      else if (d.noHits) statusText = "No matching sources";
      else statusText = "Answered from " + turn.citations.length + " source" + (turn.citations.length === 1 ? "" : "s");
      setAskStatus(statusText, "done");
      // Drop the transient claim checklist before persisting — it's fully folded
      // into `turn.answer` by now (the final render above uses `turn.answer`, not
      // the checklist), and no post-done path reads it. Leaving it on the turn would
      // round-trip the whole verdict-block markdown into localStorage, duplicating
      // `turn.answer`.
      turn.claims = undefined;
      // The tool log is ephemeral streaming chrome (the trace is the durable
      // record) — drop it so it neither survives into the committed turn nor gets
      // persisted to localStorage. The final render above uses `turn.answer`, and
      // no post-done path reads it.
      turn.toolLog = undefined;
      // Clearing the data alone leaves the already-rendered #askToolLog node
      // on screen (with any unpaired "…" row) — hide it too.
      refreshAskToolLog(turn);
      askTurns.push(turn);
      renderAskHistory();
      persistAskSession();
      btn.disabled = false;
      setFollowupDisabled(false); // committed — the follow-up bar is now usable
      // The pane was painted before the answer existed, so neither write-action
      // gate could run (both read the committed answer). Re-derive them now.
      refreshWriteActionBars(turn);
      // Do NOT close here — the server emits a trailing `answer_html` after `done`.
      // We close on `answer_html` (or the `end` fallback if it never comes).
    },
    answer_html: (e: MessageEvent) => {
      if (askConn !== conn) return;
      const d = JSON.parse((e as MessageEvent).data);
      turn.html = d.html || null;
      if (typeof d.cited !== "undefined") turn.cited = d.cited || [];
      // Swap the streamed markdown for the final rendered article — but only if
      // this turn's answer is still the one on screen (the user may have navigated
      // away, in which case it's reachable via the history list). Drop any pending
      // progressive-render frame so it can't repaint over the final article.
      cancelAskStreamRender();
      const b = document.getElementById("askAnswerBody");
      if (b && turn.html) { b.innerHTML = enhanceConfidenceHtml(turn.html); enhanceMermaid(b); enhanceCodeTabs(b); }
      refreshAskSources(turn);
      persistAskSession(); // re-store so the rehydrated turn carries the final HTML
      setFollowupDisabled(false); // belt: `done` enabled it, but never re-render since
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
      askActive = null;
      conn.close();
      askConn = null;
    },
    app_error: (e: MessageEvent) => {
      if (askConn !== conn) return;
      let msg = "Something went wrong.";
      try { msg = JSON.parse((e as MessageEvent).data).message || msg; } catch {}
      setAskStatus(msg, "error");
      askActive = null;
      btn.disabled = false;
      setFollowupDisabled(false);
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
      // Terminal for this turn — close so a drop before `end` can't reconnect + re-run.
      conn.close();
      askConn = null;
    },
    end: () => {
      // Fallback close if `answer_html` never arrived (older server / render error):
      // the streamed plain text stands.
      if (askConn !== conn) return;
      askConn.close();
      askConn = null;
      askActive = null;
      btn.disabled = false;
      setFollowupDisabled(false);
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
    },
    onerror: () => {
      if (askConn !== conn) return;
      conn.close();
      askConn = null;
      askActive = null;
      btn.disabled = false;
      setFollowupDisabled(false);
      refreshWriteActionBars(turn); // re-derive (never force-enable) the write buttons
      const wrap = document.getElementById("wikiAskStatus");
      if (wrap && !wrap.classList.contains("done") && !wrap.classList.contains("error")) {
        setAskStatus("Connection lost", "error");
      }
    },
  });
  askConn = conn;
}

/** Build the `/api/wiki/ask` URL for a plain question (the Ask box + follow-up
 *  bar share this — same `q`/`wiki`/`history` params). */
function buildAskUrl(q: string): string {
  let url = "/api/wiki/ask?q=" + encodeURIComponent(q);
  if (WIKI) url += "&wiki=" + encodeURIComponent(WIKI);
  const hist = askHistoryParam();
  if (hist) url += "&history=" + encodeURIComponent(hist);
  return url;
}

/** Start an Ask turn from a plain question string (shared by the Ask box and the
 *  in-pane follow-up bar). */
function askPlainQuestion(q: string): void {
  const turn: AskTurn = {
    question: q, answer: "", citations: [], cited: [], html: null, askedAt: Date.now(),
  };
  runAskStream(buildAskUrl(q), turn);
}

function askQuestion(): void {
  const input = document.getElementById("wikiAskInput") as HTMLTextAreaElement;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  const hint = document.getElementById("wikiAskHint");
  if (hint) hint.style.display = "none";
  askPlainQuestion(q);
}

/** Submit the in-pane follow-up bar under an answer. Reads + clears the input,
 *  then runs the same Ask stream — the turn lands in `askTurns` via the shared
 *  `done` handler, carrying the prior turns as `history`. */
function submitFollowup(): void {
  const input = document.getElementById("wikiFollowupInput") as HTMLInputElement | null;
  if (!input || input.disabled) return;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  askPlainQuestion(q);
}

/** Persist the shown answer as a durable memory (POST /api/wiki/remember).
 *  Pending → success swaps the bar to a non-interactive "✓ Remembered: …" line;
 *  a failure re-enables the button and shows an inline error. Acts on
 *  `askShownTurn` (set by `showAskAnswer`), sending its plain-markdown answer. */
async function submitRemember(): Promise<void> {
  const btn = document.getElementById("wikiRememberBtn") as HTMLButtonElement | null;
  const msg = document.getElementById("wikiRememberMsg");
  const turn = askShownTurn;
  if (!btn || btn.disabled || !turn || !turn.answer) return;
  btn.disabled = true;
  const prevLabel = btn.textContent || "Remember this";
  btn.textContent = "Saving…";
  if (msg) { msg.textContent = ""; msg.className = "wiki-remember-msg"; }
  try {
    const res = await fetch("/api/wiki/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: WIKI || undefined,
        question: turn.question,
        answer: turn.answer,
      }),
    });
    const data = await res.json().catch(() => ({} as { saved?: boolean; summary?: string; error?: string }));
    if (!res.ok || !data.saved) {
      throw new Error(data.error || ("HTTP " + res.status));
    }
    const bar = document.getElementById("wikiRememberBar");
    if (bar) {
      bar.innerHTML =
        '<span class="wiki-remember-done">✓ Remembered: ' + esc(data.summary || "") + "</span>";
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevLabel;
    if (msg) {
      msg.textContent =
        "Couldn't remember that — " + (err instanceof Error ? err.message : String(err));
      msg.className = "wiki-remember-msg error";
    }
  }
}

/** Cap on the answer this button POSTs — mirrors the server's FACTCHECK_ANSWER_MAX
 *  (32k), the cap the two fact-check write routes enforce. The seed builder bounds
 *  the answer at 6k anyway, so a rehydrated 500 KB turn would only be uploading
 *  bytes the server is about to discard. */
const CHAT_ESC_ANSWER_MAX = 32_000;

/** The `/chat` deep link for the thread a 409 says already covers this question.
 *  Built client-side from the conflict body (`existingThreadId` + `userId` +
 *  `botName`); anything missing ⇒ no link, and the bar just offers a new thread. */
function chatEscExistingUrl(d: {
  existingThreadId?: string;
  userId?: string;
  botName?: string;
}): string | undefined {
  if (!d.existingThreadId || !d.userId || !d.botName) return undefined;
  return (
    "/chat?bot=" + encodeURIComponent(d.botName) +
    "&thread=" + encodeURIComponent(d.existingThreadId) +
    "&user=" + encodeURIComponent(d.userId) +
    // Same suppression flag the route's own chatUrl carries: this thread may have
    // been created from here with "(bot default)", i.e. deliberately no connector,
    // which the chat sidebar's remembered preference would otherwise stamp over.
    "&src=wiki"
  );
}

/** Escalate the shown Ask turn into a real chat thread (POST /api/wiki/ask/chat)
 *  and open the returned deep-link in a new tab, where the seeded message
 *  auto-sends.
 *
 *  A 409 means a thread for this question already exists. It is NOT auto-retried
 *  with `forceNew`: that minted a new thread — and a new auto-sent model turn —
 *  on every re-click. The bar offers the existing thread, with "Start new thread"
 *  as an explicit second choice.
 *
 *  All outcome state lands on the TURN (`turn.chatEsc`), never on the DOM node, so
 *  a turn switch mid-flight can neither paint this result onto another turn's bar
 *  nor swallow the error into a detached node. */
async function submitChatEscalate(forceNew: boolean): Promise<void> {
  const turn = askShownTurn;
  if (!turn || !turn.answer || turn.kind === "factcheck") return;
  if (turn.chatEsc?.status === "pending") return;
  // Pre-open the tab SYNCHRONOUSLY, still inside the click's user gesture: Safari
  // blocks a `window.open` issued after an await unconditionally, so opening after
  // the fetch silently did nothing while the bar claimed "✓ Opened in chat →".
  // Blocked anyway (win === null) ⇒ fall back to rendering an honest link.
  const win = window.open("", "_blank");
  turn.chatEsc = { status: "pending" };
  refreshChatEscalateBar(turn);
  try {
    const res = await fetch("/api/wiki/ask/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: WIKI || undefined,
        question: turn.question,
        answer: turn.answer.slice(0, CHAT_ESC_ANSWER_MAX),
        citations: turn.citations.map((ci) => ({ title: ci.title, pageName: ci.pageName })),
        forceNew: forceNew || undefined,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      chatUrl?: string;
      error?: string;
      existingThreadId?: string;
      userId?: string;
      botName?: string;
    };
    if (res.status === 409 && !forceNew) {
      if (win) win.close();
      turn.chatEsc = { status: "exists", chatUrl: chatEscExistingUrl(data) };
      return;
    }
    if (!res.ok || !data.chatUrl) throw new Error(data.error || "HTTP " + res.status);
    if (win) win.location.href = data.chatUrl;
    turn.chatEsc = { status: "done", chatUrl: data.chatUrl, opened: !!win };
  } catch (err) {
    if (win) win.close();
    turn.chatEsc = {
      status: "error",
      message: "Couldn't open a chat — " + (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    refreshChatEscalateBar(turn);
  }
}

// ── Chat options popover ──────────────────────────────────────────────
// One popover, two entry points: the "New chat" button beside the Ask box (a
// DIRECT escalation — the reader's question goes straight to a real thread, no
// Ask turn first) and the ⚙ on a committed turn's "Continue in chat →" bar. Both
// resolve the same way and POST the same route; only `mode` and whether an answer
// rides along differ.
//
// Everything the panel prefills comes from ONE `GET /api/wiki/chat-target` fetch:
// the reader client holds a WIKI NAME, and which bot/user/connector a thread lands
// on is a server question (a wiki name is not a bot name, and the bot that answers
// Ask can differ from the bot that owns the chat). Defaults, labels and the thread
// name preview are the pure `wiki-chat-target.ts`.

interface ChatOptState {
  mode: "direct" | "escalate";
  /** Escalate mode: the turn whose answer + citations ride along. */
  turn: AskTurn | null;
  question: string;
  target: ChatTarget | null;
  loading: boolean;
  /** Fatal load error (no target ⇒ nothing to send). */
  error?: string;
  /** Transient line under the fields (send failures, "already queued", …). */
  status?: string;
  statusIsError?: boolean;
  /** Bot override in flight — set only once the reader picks one. */
  botName: string;
  userId: string;
  connectorId: string;
  /** Typed thread-name override; "" ⇒ derive from the question. */
  threadName: string;
  sending: boolean;
  /** A name collision the reader must resolve (409 `threadExists`). */
  conflict?: { existingThreadId: string; typedName: boolean };
  /** Terminal success — the thread's deep link. */
  doneUrl?: string;
  openedTab?: boolean;
}
let chatOpt: ChatOptState | null = null;
/** Monotonic id so a slow chat-target fetch can't repopulate a newer open. */
let chatOptLoadSeq = 0;

function chatOptPanel(): HTMLElement | null {
  return document.getElementById("wikiChatOpt");
}

/** Read a localStorage key, tolerating a disabled/foreign-origin store. */
function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** Open the popover anchored under `anchor`. `mode` decides what gets sent. */
function openChatOptions(mode: "direct" | "escalate", anchor: HTMLElement | null): void {
  let question = "";
  let turn: AskTurn | null = null;
  if (mode === "direct") {
    const input = document.getElementById("wikiAskInput") as HTMLTextAreaElement | null;
    question = (input?.value || "").trim();
  } else {
    turn = askShownTurn;
    if (!turn || !turn.answer || turn.kind === "factcheck") return;
    question = turn.question;
  }
  chatOpt = {
    mode, turn, question,
    target: null, loading: true,
    botName: "", userId: "", connectorId: "", threadName: "",
    sending: false,
  };
  renderChatOptions(anchor);
  void loadChatTarget();
}

function closeChatOptions(): void {
  chatOpt = null;
  const panel = chatOptPanel();
  if (panel) panel.remove();
}

/** Fetch the target for the current bot selection and derive every default.
 *  Re-run whenever the bot picker changes — users, the default-user mapping and
 *  the bot default connector are ALL bot-keyed. */
async function loadChatTarget(): Promise<void> {
  const state = chatOpt;
  if (!state) return;
  const seq = ++chatOptLoadSeq;
  state.loading = true;
  state.error = undefined;
  renderChatOptions();
  try {
    let url = withWiki("/api/wiki/chat-target");
    if (state.botName) {
      url += (url.indexOf("?") === -1 ? "?" : "&") + "bot=" + encodeURIComponent(state.botName);
    }
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as ChatTarget & { error?: string };
    if (chatOpt !== state || seq !== chatOptLoadSeq) return; // superseded
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    state.target = data;
    if (data.botName) {
      state.botName = data.botName;
      state.userId = pickUserId(data, lsGet(chatUserStorageKey(data.botName)));
      const preferred = state.userId ? await fetchPreferredConnector(state.userId, data.botName) : null;
      if (chatOpt !== state || seq !== chatOptLoadSeq) return;
      state.connectorId = pickConnectorId(data, lsGet(wikiConnectorStorageKey(WIKI)), preferred);
    } else {
      // `needs_bot` renders the picker; the other two reasons are real errors.
      state.error = data.needsBot ? undefined : data.error || "No chat target for this wiki.";
    }
  } catch (err) {
    if (chatOpt !== state || seq !== chatOptLoadSeq) return;
    state.error = "Couldn't work out where this chat would go — " +
      (err instanceof Error ? err.message : String(err));
  } finally {
    if (chatOpt === state && seq === chatOptLoadSeq) {
      state.loading = false;
      renderChatOptions();
    }
  }
}

/** The user+bot's persisted preferred connector (the chat page's own sidebar
 *  memory, in DB). Never fatal — no preference just means "bot default". */
async function fetchPreferredConnector(userId: string, botName: string): Promise<string | null> {
  try {
    const res = await fetch(
      "/chat/preferences/" + encodeURIComponent(userId) + "/" + encodeURIComponent(botName),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { connectorId?: string | null };
    return data.connectorId || null;
  } catch { return null; }
}

/** Panel markup, fully derived from `chatOpt` — every field re-renders from state
 *  so a re-render can never lose (or misattribute) a pick. */
function chatOptionsHtml(state: ChatOptState): string {
  const t = state.target;
  const title = state.mode === "direct" ? "New chat from this wiki" : "Continue in chat";
  let body = "";
  if (state.loading && !t) {
    body = '<div class="wiki-chatopt-line">Working out where this chat lands…</div>';
  } else if (state.error) {
    body = '<div class="wiki-chatopt-line error">' + esc(state.error) + "</div>";
  } else if (t) {
    const rows: string[] = [];
    // Bot — hidden once resolved; a picker when the wiki belongs to nobody.
    if (!t.botName || t.needsBot) {
      rows.push(
        '<label class="wiki-chatopt-row"><span>Bot</span><select id="wikiChatOptBot">' +
        '<option value="">Pick a bot…</option>' +
        t.bots.map((b) =>
          '<option value="' + esc(b.name) + '"' +
          (b.name === state.botName ? " selected" : "") + ">" + esc(b.name) + "</option>",
        ).join("") +
        "</select></label>",
      );
    }
    if (t.botName) {
      if (t.users.length > 1) {
        rows.push(
          '<label class="wiki-chatopt-row"><span>As</span><select id="wikiChatOptUser">' +
          t.users.map((u) =>
            '<option value="' + esc(u.id) + '"' +
            (u.id === state.userId ? " selected" : "") + ">" + esc(u.name) + "</option>",
          ).join("") +
          "</select></label>",
        );
      }
      rows.push(
        '<label class="wiki-chatopt-row"><span>Model</span><select id="wikiChatOptConn">' +
        '<option value=""' + (state.connectorId ? "" : " selected") + ">" +
        esc(botDefaultOptionLabel(t.botDefault)) + "</option>" +
        t.connectors.map((cRow) =>
          '<option value="' + esc(cRow.id) + '"' +
          (cRow.id === state.connectorId ? " selected" : "") + ">" +
          esc(connectorOptionLabel(cRow)) + "</option>",
        ).join("") +
        "</select></label>",
      );
      rows.push(
        '<label class="wiki-chatopt-row"><span>Thread</span>' +
        '<input id="wikiChatOptName" type="text" spellcheck="false" placeholder="' +
        esc(previewThreadName("", state.question)) + '" value="' + esc(state.threadName) + '"></label>',
      );
      rows.push(
        '<div class="wiki-chatopt-preview">will be named <code>' +
        esc(previewThreadName(state.threadName, state.question)) + "</code></div>",
      );
      if (!chosenSupportsWebTools(t, state.connectorId)) {
        rows.push(
          '<div class="wiki-chatopt-note">This model has no web search — the question will ask for ' +
          "research with the tools it does have.</div>",
        );
      }
    }
    body = rows.join("");
  }

  let foot = "";
  if (state.doneUrl) {
    foot =
      '<a class="wiki-chatopt-done" href="' + esc(state.doneUrl) + '" target="_blank">' +
      (state.openedTab ? "✓ Opened in chat →" : "Chat thread ready — open it →") + "</a>";
  } else if (state.conflict) {
    foot =
      '<button id="wikiChatOptSendThere" class="wiki-chatopt-btn">Send there →</button>' +
      '<button id="wikiChatOptForce" class="wiki-chatopt-btn ghost">Start new thread</button>';
  } else if (state.target?.botName) {
    const blocked = state.sending || !state.question || !state.userId;
    foot =
      '<button id="wikiChatOptSend" class="wiki-chatopt-btn"' + (blocked ? " disabled" : "") + ">" +
      (state.sending ? "Opening…" : "Start chat →") + "</button>";
  }
  const status = state.status
    ? '<div class="wiki-chatopt-line' + (state.statusIsError ? " error" : "") + '">' +
      esc(state.status) + "</div>"
    : state.target?.botName && !state.question
      ? '<div class="wiki-chatopt-line">Type a question first.</div>'
      : state.target?.botName && !state.userId
        ? '<div class="wiki-chatopt-line">Pick who this chat belongs to.</div>'
        : "";

  return (
    '<div class="wiki-chatopt-head">' + esc(title) +
    '<button id="wikiChatOptClose" class="wiki-chatopt-x" aria-label="Close">×</button></div>' +
    '<div class="wiki-chatopt-body">' + body + "</div>" +
    status +
    '<div class="wiki-chatopt-foot">' + foot + "</div>"
  );
}

/** Paint the panel, creating + positioning it on the first call of an open. */
function renderChatOptions(anchor?: HTMLElement | null): void {
  const state = chatOpt;
  let panel = chatOptPanel();
  if (!state) { if (panel) panel.remove(); return; }
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "wikiChatOpt";
    panel.className = "wiki-chatopt";
    document.body.appendChild(panel);
  }
  panel.innerHTML = chatOptionsHtml(state);
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    const width = 340;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left));
    panel.style.left = left + "px";
    panel.style.top = Math.min(window.innerHeight - 40, r.bottom + 6) + "px";
    panel.style.width = width + "px";
  }
}

/** POST the escalation. `opts` carries the one field that differs per button:
 *  nothing (first try) · `existingThreadId` (Send there) · `forceNew`. */
async function submitChatOptions(
  win: Window | null,
  opts: { existingThreadId?: string; forceNew?: boolean } = {},
): Promise<void> {
  const state = chatOpt;
  if (!state || state.sending || !state.target?.botName) { if (win) win.close(); return; }
  if (!state.question || !state.userId) { if (win) win.close(); return; }
  state.sending = true;
  state.status = undefined;
  state.statusIsError = false;
  renderChatOptions();
  const typedName = !!state.threadName.trim();
  try {
    const payload: Record<string, unknown> = {
      wiki: WIKI || undefined,
      bot: state.botName,
      userId: state.userId,
      question: state.question,
      connectorId: state.connectorId || undefined,
      threadName: state.threadName.trim() || undefined,
      existingThreadId: opts.existingThreadId,
      forceNew: opts.forceNew || undefined,
    };
    if (state.mode === "direct") {
      // The discriminator is explicit: a missing answer alone must stay a 400.
      payload.mode = "direct";
    } else {
      const turn = state.turn!;
      payload.answer = turn.answer.slice(0, CHAT_ESC_ANSWER_MAX);
      payload.citations = turn.citations.map((ci) => ({ title: ci.title, pageName: ci.pageName }));
    }
    const res = await fetch("/api/wiki/ask/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as {
      chatUrl?: string;
      error?: string;
      threadExists?: boolean;
      alreadyQueued?: boolean;
      existingThreadId?: string;
    };
    if (chatOpt !== state) { if (win) win.close(); return; }
    if (res.status === 409 && data.threadExists && data.existingThreadId) {
      if (win) win.close();
      state.conflict = { existingThreadId: data.existingThreadId, typedName };
      state.status = conflictCopy(typedName) + " Send this question there, or start another.";
      return;
    }
    if (res.status === 409 && data.alreadyQueued) {
      // The other question hasn't been opened yet; seeding over it would delete
      // it. Keep the conflict affordances so "Start new thread" is one click.
      if (win) win.close();
      state.status = data.error || "A question is already queued on that thread — open it first.";
      state.statusIsError = true;
      state.doneUrl = undefined;
      return;
    }
    if (!res.ok || !data.chatUrl) throw new Error(data.error || "HTTP " + res.status);
    lsSet(chatUserStorageKey(state.botName), state.userId);
    lsSet(wikiConnectorStorageKey(WIKI), state.connectorId);
    if (win) win.location.href = data.chatUrl;
    state.conflict = undefined;
    state.doneUrl = data.chatUrl;
    state.openedTab = !!win;
    // Mirror the outcome onto the turn's own bar so it survives closing the panel.
    if (state.turn) {
      state.turn.chatEsc = { status: "done", chatUrl: data.chatUrl, opened: !!win };
      refreshChatEscalateBar(state.turn);
    }
  } catch (err) {
    if (win) win.close();
    if (chatOpt !== state) return;
    state.status = "Couldn't start the chat — " + (err instanceof Error ? err.message : String(err));
    state.statusIsError = true;
  } finally {
    if (chatOpt === state) {
      state.sending = false;
      renderChatOptions();
    }
  }
}

/** Persist the shown fact-check answer onto the page as a `> [!factcheck]` callout
 *  (POST /api/wiki/factcheck/append). Sends the turn's stored `page` + `baseHash`
 *  + answer. Success ⇒ swap the button to a non-interactive "✓ Added to article"
 *  and reload the page in the reader so the new callout is visible. A 409 (page
 *  changed since the check) shows a clear re-run message. Acts on `askShownTurn`. */
async function submitFactcheckAppend(): Promise<void> {
  const btn = document.getElementById("wikiFactcheckAppendBtn") as HTMLButtonElement | null;
  const msg = document.getElementById("wikiFactcheckAppendMsg");
  const turn = askShownTurn;
  if (!btn || btn.disabled || !turn || !turn.answer || !turn.page) return;
  const showErr = (text: string): void => {
    if (msg) { msg.textContent = text; msg.className = "wiki-fc-append-msg error"; }
  };
  if (!turn.baseHash) {
    showErr("No page snapshot from this check — re-run the fact check, then add it.");
    return;
  }
  btn.disabled = true;
  const prevLabel = btn.textContent || "➕ Add to article";
  btn.textContent = "Adding…";
  if (msg) { msg.textContent = ""; msg.className = "wiki-fc-append-msg"; }
  try {
    const res = await fetch("/api/wiki/factcheck/append", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: WIKI || undefined,
        page: turn.page,
        answer: turn.answer,
        baseHash: turn.baseHash,
      }),
    });
    const data = await res
      .json()
      .catch(() => ({} as { written?: boolean; error?: string; stale?: boolean }));
    if (res.status === 409 || data.stale) {
      btn.disabled = false;
      btn.textContent = prevLabel;
      showErr("The page changed since the check — re-run the fact check, then add it.");
      return;
    }
    if (!res.ok || !data.written) {
      throw new Error(data.error || "HTTP " + res.status);
    }
    // Record the write on the TURN and persist immediately: the session is only
    // stored on explicit calls, so without this the derived disable would die on
    // the next reload and the button would come back live against a stale
    // baseHash. The innerHTML swap below is just immediate feedback — the render
    // path (`factcheckAppendInnerHtml`) is what's authoritative on a re-render.
    turn.wrote = "append";
    persistAskSession();
    // Both bars are re-DERIVED from the turn (an append also stales this turn's
    // baseHash, retiring the ✎ action), never poked one node at a time.
    refreshWriteActionBars(turn);
    // …and the outcome goes on the rail's Ask status line, the only surface that
    // survives the `loadPage` below (which replaces #articleWrap, bars included).
    setAskStatus("✓ Added to article", "done");
    // Reload the page content so the freshly-written callout is visible.
    loadPage(turn.page, false);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevLabel;
    showErr("Couldn't add that — " + (err instanceof Error ? err.message : String(err)));
  }
}

// ── Integrate into article (fact-check v4) ────────────────────────────
// The second write action on a fact-check turn: propose a structured edit list
// (one 25–90s fenced one-shot server-side), preview it as a per-edit diff with
// checkboxes, then apply the accepted subset in one CAS-guarded write.
//
// The proposal is per-turn TRANSIENT and never persisted — a rehydrated turn just
// re-proposes on click, since the inputs (the persisted answer + baseHash) are all
// the propose route takes.
interface IntegratePreviewState {
  /** The turn this proposal belongs to. `renderIntegratePreview` paints ONLY when
   *  this is the turn currently on screen — a ~90s propose that resolves after the
   *  user switched turns must not paint a live Apply under an unrelated turn (its
   *  Apply would write THIS turn's page while another is displayed). */
  turn: AskTurn;
  proposal: IntegrateProposal;
  /** Parallel to `proposal.edits` — all ON by default. */
  selected: boolean[];
  callout: boolean;
  /** An apply is in flight. Lives HERE, not on the DOM: the panel re-renders
   *  wholesale on every checkbox toggle, so a DOM-held disable produced a fresh
   *  enabled Apply mid-flight and detached the nodes the error path wrote into. */
  applying: boolean;
  /** Panel message (an error, or an `applied: 0` outcome) + its severity. */
  message?: string;
  messageError?: boolean;
  /** Apply is disabled for THIS selection (an `applied: 0` would reproduce
   *  forever). Any checkbox toggle clears it. */
  applyBlocked?: boolean;
  /** The apply route's own per-edit rejections, rendered with their honest reasons. */
  applyDropped?: DroppedEditRow[];
  /** `<details>` open state of the propose-time dropped list, so a re-render
   *  doesn't snap it shut under the reader. */
  droppedOpen: boolean;
  /** Same, for the APPLY-time dropped list. Kept as its OWN field because both
   *  lists render with the `.wiki-fc-int-dropped` class — one shared flag meant
   *  opening either one flipped the other on the next re-render. `undefined` ⇒
   *  the renderer's default (open). */
  applyDroppedOpen?: boolean;
  /** Index of the checkbox to refocus after a re-render (-1 = none). */
  focusEditIdx: number;
}
let integratePreview: IntegratePreviewState | null = null;

/** Show a message on the ✎ bar (not the preview panel). Stored per turn and
 *  RE-RENDERED, never poked into a node the next refresh would replace. */
function setIntegrateBarMsg(turn: AskTurn, text: string, isError: boolean): void {
  if (text) integrateBarMsgs[turn.askedAt] = { text, error: isError };
  else delete integrateBarMsgs[turn.askedAt];
  refreshWriteActionBars(turn);
}

/** Repaint the preview panel from `integratePreview` — every visual bit (checkbox
 *  states, the Apply count/budget/in-flight state, the messages, the dropped
 *  disclosure) derives from it. Renders NOTHING when the stored preview belongs to
 *  a turn other than the one on screen. */
function renderIntegratePreview(): void {
  const host = document.getElementById("wikiFcIntHost");
  if (!host) return;
  const state = integratePreview;
  if (!state || state.turn !== askShownTurn) { host.innerHTML = ""; return; }
  host.innerHTML = integratePreviewHtml(state.proposal, state.selected, state.callout, {
    applying: state.applying,
    message: state.message,
    messageError: state.messageError,
    applyBlocked: state.applyBlocked,
    applyDropped: state.applyDropped,
    droppedOpen: state.droppedOpen,
    applyDroppedOpen: state.applyDroppedOpen,
    calloutDisabled: !state.turn.answer,
  });
  // A full re-render on every toggle is the simple, state-honest choice — but it
  // must not cost the reader their caret. Restore focus to the checkbox they just
  // flipped (the details open state is carried on the state above).
  if (state.focusEditIdx >= 0) {
    const cb = host.querySelector(
      '.wiki-fc-int-cb[data-edit-idx="' + state.focusEditIdx + '"]',
    ) as HTMLElement | null;
    cb?.focus();
    state.focusEditIdx = -1;
  }
}

/** Fresh preview state for a landed proposal. */
function newPreviewState(
  turn: AskTurn,
  proposal: IntegrateProposal,
  selected: boolean[],
  callout: boolean,
): IntegratePreviewState {
  return { turn, proposal, selected, callout, applying: false, droppedOpen: false, focusEditIdx: -1 };
}

/**
 * Ask the server to propose edits for the shown fact-check turn. One synchronous
 * model call server-side, so the button carries an explicit "up to ~90s" label
 * rather than a spinner with no expectation set.
 */
async function submitFactcheckIntegrate(): Promise<void> {
  const btn = document.getElementById("wikiFactcheckIntegrateBtn") as HTMLButtonElement | null;
  const turn = askShownTurn;
  if (!btn || btn.disabled || !turn || !turn.answer || !turn.page) return;
  if (integrateProposing) return; // one propose at a time (the bar renders disabled)
  if (!turn.baseHash) {
    setIntegrateBarMsg(turn, "No page snapshot from this check — re-run the fact check, then integrate.", true);
    return;
  }
  // In-flight state is derived, not poked: `integrateProposing` drives the bar's
  // disabled "Proposing…" label through `factcheckIntegrateInnerHtml`, so any
  // re-render (an SSE `end`, re-opening the turn) reproduces it.
  integrateProposing = turn;
  delete integrateBarMsgs[turn.askedAt];
  refreshWriteActionBars(turn);
  integratePreview = null;
  renderIntegratePreview();
  try {
    const res = await fetch("/api/wiki/factcheck/integrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: WIKI || undefined,
        page: turn.page,
        answer: turn.answer,
        baseHash: turn.baseHash,
        // Claim quotes ride along for instrumentation (PR 2) — the server
        // re-validates them against the answer it parses itself and silently
        // degrades to "no quotes" on any disagreement.
        ...(turn.claimQuotes && turn.claimQuotes.length ? { quotes: turn.claimQuotes } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as IntegrateProposal & {
      error?: string;
      stale?: boolean;
    };
    if (res.status === 409 || data.stale) {
      setIntegrateBarMsg(turn, INTEGRATE_STALE_COPY_EDIT, true);
      return;
    }
    // A page over the cap is a legitimate outcome, not a failure — the client
    // usually catches it from `turn.bodyLen`, but a pre-`bodyLen` turn learns it
    // here. Say the same thing either way.
    if (res.status === 400 && (data.error || "").indexOf("too long") !== -1) {
      setIntegrateBarMsg(
        turn,
        "This page is too long to integrate automatically — edit it by hand, or add the callout instead.",
        true,
      );
      return;
    }
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    const edits = Array.isArray(data.edits) ? data.edits : [];
    // ALWAYS store, THEN attempt the render. A propose that resolved while the
    // reader was on another turn (or another page) is not lost — the state is
    // turn-keyed, and re-opening the turn from history paints it.
    integratePreview = newPreviewState(
      turn,
      { ...data, edits, dropped: Array.isArray(data.dropped) ? data.dropped : [] },
      edits.map(() => true),
      // Default ON only when the page already carries a fact-check block AND the
      // turn actually has an answer to build one from (no answer ⇒ the checkbox
      // renders disabled).
      data.hasSentinelBlock === true && !!turn.answer,
    );
    renderIntegratePreview();
  } catch (err) {
    setIntegrateBarMsg(
      turn,
      "Couldn't propose edits — " + (err instanceof Error ? err.message : String(err)),
      true,
    );
  } finally {
    // Re-DERIVE the bar rather than force-enabling it: the write may have retired
    // the button in the meantime, and a restored label would out-live the state.
    integrateProposing = null;
    refreshWriteActionBars(turn);
  }
}

/** Apply the selected edits. The accepted subset goes back VERBATIM with the same
 *  `baseHash`, so the server's CAS still guards the write. */
async function acceptFactcheckIntegrate(): Promise<void> {
  const state = integratePreview;
  // Every gate is state-side: an in-flight apply, a turn that is no longer the
  // one on screen, or a selection already known to resolve to nothing.
  if (!state || state.applying || state.applyBlocked) return;
  if (state.turn !== askShownTurn) return;
  const { turn } = state;
  if (!turn.page || !turn.baseHash) return;
  const calloutRequested = state.callout && !!turn.answer;
  const calloutReplaced = state.proposal.hasSentinelBlock === true;
  const body = buildIntegrateApplyBody({
    wiki: WIKI || undefined,
    page: turn.page,
    baseHash: turn.baseHash,
    edits: state.proposal.edits,
    selected: state.selected,
    appendCallout: state.callout,
    answer: turn.answer,
  });
  if (!body) return;
  // Show a message by mutating STATE and re-rendering — never by writing into a
  // node captured before the render, which a mid-flight toggle would have detached.
  const showErr = (text: string): void => {
    state.message = text;
    state.messageError = true;
    renderIntegratePreview();
  };
  state.applying = true;
  state.message = undefined;
  state.messageError = false;
  state.applyDropped = undefined;
  state.applyDroppedOpen = undefined; // a fresh apply's reasons open by default again
  renderIntegratePreview();
  try {
    const res = await fetch("/api/wiki/factcheck/integrate/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      applied?: number;
      calloutAdded?: boolean;
      dropped?: DroppedEditRow[];
      committed?: boolean;
      reason?: string;
      error?: string;
      stale?: boolean;
    };
    if (res.status === 409 || data.stale) {
      state.applying = false;
      showErr(INTEGRATE_STALE_COPY_EDIT);
      return;
    }
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    const applied = typeof data.applied === "number" ? data.applied : 0;
    const copy = integrateSuccessCopy({
      applied,
      committed: data.committed,
      reason: data.reason,
      calloutAdded: data.calloutAdded,
      calloutRequested,
      calloutReplaced,
      // An annotated write persists the `<FactCheck>` APPENDIX, not the `.md`
      // summary callout — name the thing that actually landed on the page.
      annotated: carriesFactWrapper(body.edits),
    });
    if (applied === 0) {
      // Nothing was written. Re-offering the SAME selection would reproduce this
      // forever, so Apply stays disabled until a checkbox changes — and the
      // server's honest per-edit reasons are shown instead of being discarded.
      state.applying = false;
      state.applyBlocked = true;
      state.applyDropped = Array.isArray(data.dropped) ? data.dropped : [];
      showErr(copy);
      return;
    }
    // Record the write on the TURN and persist IMMEDIATELY — the session only
    // persists on explicit calls, and this flag is what makes both write buttons
    // come back correctly disabled after a reload.
    turn.wrote = "integrate";
    integratedNotes[turn.askedAt] = copy;
    delete integrateBarMsgs[turn.askedAt];
    persistAskSession();
    integratePreview = null;
    renderIntegratePreview();
    refreshWriteActionBars(turn);
    // The outcome copy ALSO goes on the rail's Ask status line, which is the only
    // place it can actually be read: `loadPage` below replaces #articleWrap
    // wholesale — bars and all — so a message left only on the bar is destroyed
    // within a frame, whichever order the two calls are made in (loadPage is
    // fire-and-forget; there is no post-render hook to re-attach to). The bar copy
    // stays for the re-opened turn; the status line is what the user sees NOW.
    setAskStatus(copy, "done");
    // Reload the page in the reader so the corrected prose is visible.
    loadPage(turn.page, false);
  } catch (err) {
    state.applying = false;
    showErr("Couldn't apply — " + (err instanceof Error ? err.message : String(err)));
  }
}

/** Dismiss the preview panel without writing anything. Refuses while an apply is
 *  in flight (the button renders disabled then too) — dropping the state mid-write
 *  would strand the response with nowhere honest to report itself. */
function cancelFactcheckIntegrate(): void {
  if (integratePreview?.applying) return;
  integratePreview = null;
  renderIntegratePreview();
}

// ── Ask session persistence (localStorage) ────────────────────────────
// Persist the last N committed Ask/Explain turns so a page reload rehydrates the
// "This session" list. Keyed per wiki (the bare /wiki reader may have no WIKI —
// fall back to a shared default key). localStorage works here (the reader is a
// normal page); the no-storage constraint only applies inside explainer iframes.
const ASK_SESSION_CAP = 10;
const ASK_SESSION_CAP_FALLBACK = 5; // quota retry
function askSessionKey(): string {
  return "wikiAskSession:" + (WIKI || "__default__");
}
/** Store the current session; a quota error retries once at a smaller cap, then
 *  gives up silently (persistence is best-effort). */
function persistAskSession(): void {
  const key = askSessionKey();
  try {
    localStorage.setItem(key, serializeAskSession(askTurns as StoredAskTurn[], ASK_SESSION_CAP));
  } catch {
    try {
      localStorage.setItem(
        key,
        serializeAskSession(askTurns as StoredAskTurn[], ASK_SESSION_CAP_FALLBACK),
      );
    } catch {
      /* out of quota even at 5 — drop persistence silently */
    }
  }
}
/** Rehydrate the stored session into `askTurns` + the history list at boot. Does
 *  NOT auto-show an answer — the list is enough; clicking a turn re-shows it. */
function rehydrateAskSession(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(askSessionKey());
  } catch {
    return; // storage unavailable — nothing to rehydrate
  }
  const stored = deserializeAskSession(raw);
  if (!stored.length) return;
  for (const t of stored) askTurns.push(t as unknown as AskTurn);
  renderAskHistory();
}
/** Clear the session (history + storage), from the "clear" affordance. */
function clearAskSession(): void {
  askTurns.length = 0;
  renderAskHistory();
  try {
    localStorage.removeItem(askSessionKey());
  } catch {
    /* ignore */
  }
}

document.getElementById("wikiAskBtn")?.addEventListener("click", askQuestion);
document.getElementById("wikiAskInput")?.addEventListener("keydown", (e) => {
  const ke = e as KeyboardEvent;
  if (ke.key === "Enter" && !ke.shiftKey) { e.preventDefault(); askQuestion(); }
});
// Re-open a stored answer from the session history (no re-ask), or clear the
// session via the header affordance.
document.getElementById("wikiAskHistory")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("#wikiAskHistClear")) { clearAskSession(); return; }
  const item = target.closest("[data-ask-idx]");
  if (!item) return;
  const idx = parseInt(item.getAttribute("data-ask-idx") || "-1", 10);
  const turn = askTurns[idx];
  if (turn) showAskAnswer(turn, "");
});

// Follow-up bar (in the article pane) — delegated at the document level because
// `showAskAnswer` replaces the pane per turn, destroying any direct listeners.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("#wikiFollowupBtn")) submitFollowup();
  else if (t.closest("#wikiRememberBtn")) submitRemember();
  else if (t.closest("#wikiChatEscBtn")) submitChatEscalate(false);
  // Explicit "start another thread anyway" after a 409 (never automatic).
  else if (t.closest("#wikiChatEscNewBtn")) submitChatEscalate(true);
  // Chat options popover — two entry points, one panel. The tab is pre-opened
  // SYNCHRONOUSLY inside the click (Safari blocks a `window.open` after an await
  // unconditionally), exactly as the plain escalate button does.
  else if (t.closest("#wikiChatEscOptBtn")) {
    openChatOptions("escalate", t.closest("#wikiChatEscOptBtn") as HTMLElement);
  } else if (t.closest("#wikiNewChatBtn")) {
    openChatOptions("direct", t.closest("#wikiNewChatBtn") as HTMLElement);
  } else if (t.closest("#wikiChatOptClose")) closeChatOptions();
  else if (t.closest("#wikiChatOptSend")) void submitChatOptions(window.open("", "_blank"));
  else if (t.closest("#wikiChatOptSendThere")) {
    void submitChatOptions(window.open("", "_blank"), {
      existingThreadId: chatOpt?.conflict?.existingThreadId,
    });
  } else if (t.closest("#wikiChatOptForce")) {
    void submitChatOptions(window.open("", "_blank"), { forceNew: true });
  } else if (t.closest("#wikiFactcheckAppendBtn")) submitFactcheckAppend();
  else if (t.closest("#wikiFactcheckIntegrateBtn")) submitFactcheckIntegrate();
  else if (t.closest("#wikiFcIntAccept")) acceptFactcheckIntegrate();
  else if (t.closest("#wikiFcIntCancel")) cancelFactcheckIntegrate();
  // Click-away dismissal, evaluated AFTER the chain so a click on another control
  // still does its own job (and the two openers above aren't self-closing).
  if (
    chatOpt && !t.closest("#wikiChatOpt") &&
    !t.closest("#wikiChatEscOptBtn") && !t.closest("#wikiNewChatBtn")
  ) {
    closeChatOptions();
  }
});

// Popover field changes — delegated (the panel is re-rendered from state on every
// change, so direct listeners wouldn't survive). Nothing is read back off the DOM.
document.addEventListener("change", (e) => {
  const state = chatOpt;
  if (!state) return;
  const el = e.target as HTMLElement;
  if (el.id === "wikiChatOptBot") {
    state.botName = (el as HTMLSelectElement).value;
    state.target = null;
    state.conflict = undefined;
    state.status = undefined;
    if (state.botName) void loadChatTarget();
    else renderChatOptions();
  } else if (el.id === "wikiChatOptUser") {
    state.userId = (el as HTMLSelectElement).value;
    state.conflict = undefined;
    // The connector preference is per user+bot, so re-resolve it for the new user.
    void (async () => {
      const preferred = await fetchPreferredConnector(state.userId, state.botName);
      if (chatOpt !== state || !state.target) return;
      state.connectorId = pickConnectorId(
        state.target, lsGet(wikiConnectorStorageKey(WIKI)), preferred,
      );
      renderChatOptions();
    })();
    renderChatOptions();
  } else if (el.id === "wikiChatOptConn") {
    state.connectorId = (el as HTMLSelectElement).value;
    renderChatOptions();
  }
});

// The thread-name field re-renders its own lowercased preview as you type. The
// input keeps focus + caret because only the preview node is rewritten.
document.addEventListener("input", (e) => {
  const state = chatOpt;
  const el = e.target as HTMLElement;
  if (!state || el.id !== "wikiChatOptName") return;
  state.threadName = (el as HTMLInputElement).value;
  state.conflict = undefined;
  const preview = document.querySelector("#wikiChatOpt .wiki-chatopt-preview code");
  if (preview) preview.textContent = previewThreadName(state.threadName, state.question);
});

// Escape closes the popover (a modal-ish panel with no backdrop).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && chatOpt) closeChatOptions();
});
// Preview-panel checkboxes — same document-level delegation (the panel is
// re-rendered wholesale on every toggle, so direct listeners wouldn't survive).
// State lives on `integratePreview`, never on the DOM.
document.addEventListener("change", (e) => {
  const state = integratePreview;
  if (!state) return;
  // An apply is in flight: the inputs render disabled, but a programmatic or
  // racing change must not re-render the panel out from under it either.
  if (state.applying) return;
  const t = e.target as HTMLElement;
  if (t.id === "wikiFcIntCallout") {
    state.callout = (t as HTMLInputElement).checked;
    renderIntegratePreview();
    return;
  }
  if (t.classList && t.classList.contains("wiki-fc-int-cb")) {
    // The annotation GROUP checkbox owns every wrapper-only index at once — the
    // marks are one editorial act, and a half-marked page would leave chips and
    // appendix disagreeing about what was checked.
    if (t.getAttribute("data-edit-group") === "annotations") {
      const on = (t as HTMLInputElement).checked;
      for (const i of annotationIndexes(state.proposal.edits || [])) state.selected[i] = on;
      state.applyBlocked = false;
      state.applyDropped = undefined;
      state.applyDroppedOpen = undefined;
      renderIntegratePreview();
      return;
    }
    const idx = parseInt(t.getAttribute("data-edit-idx") || "-1", 10);
    if (idx >= 0) {
      state.selected[idx] = (t as HTMLInputElement).checked;
      // The selection changed, so the "this exact selection resolved to nothing"
      // block no longer applies — Apply becomes live again.
      state.applyBlocked = false;
      state.applyDropped = undefined;
      state.applyDroppedOpen = undefined;
      state.focusEditIdx = idx; // restored after the full re-render
      renderIntegratePreview();
    }
  }
});
// The dropped-list disclosure is state, not DOM: without this a checkbox toggle's
// re-render snapped an opened "N not applied" list shut again.
//
// There are TWO such lists (propose-time drops, and the apply route's own
// rejections) and they share the `.wiki-fc-int-dropped` class, so the `apply-drops`
// modifier is what tells them apart — into two separate state fields. A single
// shared field made each list's toggle clobber the other's open state.
document.addEventListener(
  "toggle",
  (e) => {
    const state = integratePreview;
    if (!state) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLDetailsElement && t.classList.contains("wiki-fc-int-dropped")) {
      if (t.classList.contains("apply-drops")) state.applyDroppedOpen = t.open;
      else state.droppedOpen = t.open;
    }
  },
  true, // `toggle` does not bubble — capture it
);
document.addEventListener("keydown", (e) => {
  const ke = e as KeyboardEvent;
  if (ke.key !== "Enter" || ke.shiftKey) return;
  if ((ke.target as HTMLElement)?.id === "wikiFollowupInput") {
    ke.preventDefault();
    submitFollowup();
  }
});

// ── Select-to-Explain ─────────────────────────────────────────────────
// Selecting text inside a rendered (markdown) article — or an HTML explainer,
// via the iframe bridge — reveals the "✨ Explain" button in the breadcrumb bar
// (a stable spot, no floating pill to position). Activating it runs the SAME
// research stream as Ask (via `runAskStream`) against `/api/wiki/explain`, so the
// explanation lands in the article pane + session history like any other Ask turn.
const EXPLAIN_MIN_CHARS = 3;
const EXPLAIN_MAX_CHARS = 1500;
// Captured at selection time — BEFORE any click can collapse the selection.
let pillSel = "";
let pillHeading = "";

/** Nearest preceding h1–h4 above the selection, within `.wiki-article`. Walks up
 *  the ancestor chain from the selection's start, scanning previous siblings (and
 *  their inner headings) at each level. Trimmed text, may be empty. */
function nearestHeading(range: Range): string {
  const startEl =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const article = startEl?.closest(".wiki-article");
  if (!article || !startEl) return "";
  const HEAD = /^H[1-4]$/;
  let node: Element | null = startEl;
  while (node && node !== article) {
    let sib: Element | null = node.previousElementSibling;
    while (sib) {
      if (HEAD.test(sib.tagName)) return (sib.textContent || "").trim();
      const inner = sib.querySelectorAll ? sib.querySelectorAll("h1,h2,h3,h4") : null;
      if (inner && inner.length) return (inner[inner.length - 1]!.textContent || "").trim();
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return "";
}

/** Reveal / hide the breadcrumb's Explain button. The button is (re)rendered
 *  hidden by `renderBreadcrumb` on every page load, so a lookup-by-id is enough;
 *  on the start view / Ask answers there is no breadcrumb and both are no-ops.
 *  (Named `*ExplainPill` still — the call sites below read as before.) */
function hideExplainPill(): void {
  const btn = document.getElementById("wikiExplainBtn");
  if (btn) (btn as HTMLElement).style.display = "none";
  // The selection-gated Fact check button rides the same selection state.
  const fc = document.getElementById("wikiFactcheckBtn");
  if (fc) (fc as HTMLElement).style.display = "none";
}
function showExplainPill(): void {
  const btn = document.getElementById("wikiExplainBtn");
  if (btn) (btn as HTMLElement).style.display = "";
  const fc = document.getElementById("wikiFactcheckBtn");
  if (fc) (fc as HTMLElement).style.display = "";
}

/** Decide whether to reveal the Explain button for the current selection, and
 *  capture the passage + heading if so. Called on `mouseup` inside the article
 *  pane. */
function maybeShowExplainPill(): void {
  // Real markdown page only — not the start view, not an Ask answer (both leave
  // currentName null), not an HTML explainer (iframe selections are unreachable,
  // but loadExplainer sets currentName, so exclude by type).
  if (!currentName) return hideExplainPill();
  const meta = allPages.find((p) => p.name === currentName);
  if (meta && meta.type === "explainer") return hideExplainPill();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideExplainPill();
  const text = sel.toString().trim();
  if (text.length < EXPLAIN_MIN_CHARS || text.length > EXPLAIN_MAX_CHARS) return hideExplainPill();
  const wrap = document.getElementById("articleWrap");
  const anchor = sel.anchorNode;
  if (!wrap || !anchor || !wrap.contains(anchor)) return hideExplainPill();
  const range = sel.getRangeAt(0);
  pillSel = text;
  pillHeading = nearestHeading(range);
  showExplainPill();
}

function activateExplain(): void {
  hideExplainPill();
  if (!pillSel || !currentName) return;
  const turn: AskTurn = {
    question: explainLabel(pillSel),
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(),
  };
  const url = buildExplainUrl({
    sel: pillSel,
    page: currentName,
    wiki: WIKI,
    ctx: pillHeading,
    history: askHistoryParam(),
  });
  runAskStream(url, turn);
}

/** Fact-check the current selection (`sel` mode). Same captured passage/heading
 *  as Explain; the answer streams into the article pane as a `factcheck` Ask turn. */
function activateFactcheckSel(): void {
  hideExplainPill();
  if (!pillSel || !currentName) return;
  const selMeta = allPages.find((p) => p.name === currentName);
  const turn: AskTurn = {
    question: factcheckLabel(pillSel),
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(), kind: "factcheck",
    page: currentName, pageType: selMeta ? selMeta.type : undefined,
  };
  const url = buildFactcheckUrl({ mode: "sel", page: currentName, wiki: WIKI, sel: pillSel, ctx: pillHeading });
  runAskStream(url, turn);
}

/** Fact-check the whole current page (`article` mode) — the always-visible
 *  breadcrumb button. Works on markdown pages AND explainers (server reduces the
 *  explainer HTML to prose). No selection needed. */
function activateFactcheckArticle(): void {
  hideExplainPill();
  if (!currentName) return;
  const meta = allPages.find((p) => p.name === currentName);
  const turn: AskTurn = {
    question: factcheckLabel("", meta ? meta.title : currentName),
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(), kind: "factcheck",
    page: currentName, pageType: meta ? meta.type : undefined,
  };
  const url = buildFactcheckUrl({ mode: "article", page: currentName, wiki: WIKI });
  runAskStream(url, turn);
}

// Show on selection release inside the article pane; the timeout lets the browser
// finalize the selection first. (articleWrap's element persists across page
// navigations — only its innerHTML is swapped — so a one-time listener suffices.)
document.getElementById("articleWrap")?.addEventListener("mouseup", () => {
  setTimeout(maybeShowExplainPill, 0);
});
// Dismiss on: selection collapse, article scroll, Escape, any mousedown outside
// the pill (the pill's own mousedown stops propagation, so it self-excludes).
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) hideExplainPill();
});
document.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Escape") hideExplainPill();
});
// A mousedown on the Explain button activates it (preventDefault keeps the
// selection alive so `activateExplain` reads its captured passage); a mousedown
// anywhere else dismisses the button. One handler so the two never race.
document.addEventListener("mousedown", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest && t.closest("#wikiExplainBtn")) {
    e.preventDefault();
    activateExplain();
    return;
  }
  // Selection-gated Fact check — preventDefault keeps the selection alive so the
  // captured passage is read (same pattern as Explain).
  if (t.closest && t.closest("#wikiFactcheckBtn")) {
    e.preventDefault();
    activateFactcheckSel();
    return;
  }
  // Whole-article Fact check — always visible, needs no selection.
  if (t.closest && t.closest("#wikiFactcheckArticleBtn")) {
    activateFactcheckArticle();
    return;
  }
  hideExplainPill();
});

// ── Explainer-iframe bridge ───────────────────────────────────────────
// Standalone HTML explainers render in a sandboxed (opaque-origin) iframe, so the
// parent can't read their selection directly — the injected forwarder posts it up
// (see src/wiki/explainer-bridge.ts). Trust a message ONLY when the current page
// is that explainer AND the event's source is the live frame's contentWindow
// (looked up per event — never cached across navigations). Everything else is
// ignored silently (other pages/extensions post messages constantly).
window.addEventListener("message", (e: MessageEvent) => {
  if (!currentName) return;
  const meta = allPages.find((p) => p.name === currentName);
  if (!meta || meta.type !== "explainer") return;
  const frame = document.querySelector(".wiki-explainer-frame") as HTMLIFrameElement | null;
  if (!frame || e.source !== frame.contentWindow) return;
  const data = e.data as { type?: string; sel?: unknown; heading?: unknown };
  if (!data || typeof data !== "object") return;
  if (data.type === "wiki-explain-clear") return hideExplainPill();
  if (data.type !== "wiki-explain-sel") return;
  const raw = typeof data.sel === "string" ? data.sel.trim() : "";
  if (raw.length < EXPLAIN_MIN_CHARS) return hideExplainPill();
  // Cap at the same ceiling as the md path (server re-caps too).
  pillSel = raw.length > EXPLAIN_MAX_CHARS ? raw.slice(0, EXPLAIN_MAX_CHARS) : raw;
  pillHeading = typeof data.heading === "string" ? data.heading : "";
  // The Explain button lives in the breadcrumb (stable spot) — no rect to
  // translate anymore; just reveal it. `renderBreadcrumb` already ran for this
  // explainer, so the button exists.
  showExplainPill();
});

// ── Listing refresh ───────────────────────────────────────────────────
// A tab left open for hours used to filter a page set frozen at load time. We
// re-pull `/api/wiki/pages` on focus/visibility and on a slow heartbeat (the
// never-blurred second-monitor tab fires neither event), throttled, and —
// crucially — only ADOPT the fresh set while the reader is on the browse/start
// view: applying it under an open article would re-sort the left list out from
// under someone reading. Everything else is stashed and applied on the next
// return/navigation. Throttle, ordering, guards and the apply/defer decision live
// in the DOM-free `wiki-refresh.ts`; the boot load runs through the SAME
// discipline so a slow boot response can't revert a newer refetch.
const pagesRefresh = createRefreshModel();

/** What the middle pane is showing right now — see `viewStateOf` for the rules.
 *  An Ask/Explain/Fact-check answer nulls `currentName` but is just as much
 *  "someone is reading" as an article; its body element is the only signal that
 *  survives (`askShownTurn` is never cleared on navigation). */
function currentViewState() {
  return viewStateOf(currentName, navInFlight, !!document.getElementById("askAnswerBody"));
}

/** Swap in a page set + everything else the payload carries. Data only — paints
 *  nothing; `adoptPagesAndRender`/`bootRender` own the painting. */
function setPagesData(data: WikiPagesResponse): void {
  allPages = data.pages;
  // Anchor every recency read to the server's scan instant BEFORE the first render
  // (`recencyNow`) — a viewer clock running >48h slow would otherwise trip the
  // future-date guard on every frontmatter-dated page in the wiki at once.
  scannedAtMs = typeof data.scannedAt === "number" ? data.scannedAt : null;
  // Store the wiki's merged type list (defaults + `.wiki-reader.json` customs).
  // Absent/empty (older server / degraded) keeps the built-in constants so
  // standard types still render — the belt-and-suspenders unions in the chip/hub
  // renderers then keep any custom-typed page from being dropped regardless.
  if (data.types && Array.isArray(data.types.order) && data.types.order.length) {
    typeOrder = data.types.order;
    typeLabels = data.types.labels || { ...TYPE_LABEL };
  }
}

/** Adopt a fresh page set and repaint everything derived from it. Filters, the
 *  search box and the sort mode all live outside this render path (the `filters`
 *  object / the DOM controls themselves), so they survive untouched, and the
 *  Filters disclosure is NOT auto-opened — a background event must not reopen a
 *  stack the reader collapsed. `renderList` restores the list's scroll offset. A
 *  selection whose page has disappeared simply stops matching a row — the same
 *  non-event as any name the listing doesn't carry. */
function adoptPagesAndRender(applied: PendingPages): void {
  adoptPagesDataAndFacets(applied);
  renderList();
  refreshStartBody();
}

/** Everything an adopt does EXCEPT painting the row list and the start body — the
 *  shared half of `adoptPagesAndRender` and the deferred apply. */
function adoptPagesDataAndFacets(applied: PendingPages): void {
  setPagesData(applied.data);
  markApplied(pagesRefresh, applied);
  renderPageFacets(false);
  refreshStartStats();
  loadCoverageFooter();
}

/** The boot-success render: facets, the coverage footer, and the one-time
 *  navigation from `location.search`. Runs on the FIRST successful adopt, which
 *  is normally the boot response — but if boot failed (error pane painted, no
 *  facets, no list) the next successful refetch must run this path too, or the
 *  list heals beside a permanent error message. */
function bootRender(applied: PendingPages): void {
  setPagesData(applied.data);
  markApplied(pagesRefresh, applied);
  renderPageFacets(true);
  loadCoverageFooter();
  // The initial navigation is boot-only work. On a heal the reader may already be
  // somewhere (a wikilink click out of an Ask answer, an answer in the pane) —
  // re-reading `location.search` there would fight what is on screen, so just
  // paint the rows the failed boot never painted.
  if (currentViewState() !== "start") {
    renderList();
    return;
  }
  const params = new URLSearchParams(location.search);
  // A shared/reloaded relPath URL re-resolves collision-proof; check it first.
  const relPath = params.get("relPath");
  if (relPath) {
    loadPageByRelPath(relPath, false);
  } else {
    const page = params.get("page");
    if (page) loadPage(page, false);
    else renderStart(); // renders the list itself
  }
}

function applyPagesResponse(applied: PendingPages): void {
  if (pagesRefresh.bootRendered) adoptPagesAndRender(applied);
  else bootRender(applied);
}

/** Apply a page set that arrived while the reader had something open. Called at
 *  the top of every return-to-start / navigation path; a no-op when nothing is
 *  stashed, and `takePending` guarantees it lands exactly once.
 *
 *  Data + facets only: every caller (`renderStart`, `loadPage`/`loadPageByRelPath`
 *  → `fetchAndRenderPage`/`loadExplainer`) paints the list itself a moment later,
 *  so painting here would mean two full 953-row renders per user action. */
function applyPendingPages(): void {
  const pending = takePending(pagesRefresh);
  if (!pending) return;
  if (!pagesRefresh.bootRendered) {
    bootRender(pending);
    return;
  }
  adoptPagesDataAndFacets(pending);
}

/** Paint the boot-only "this wiki isn't usable" pane. Suppressed once anything has
 *  rendered successfully — a slow boot response must not bury a healed page. */
function paintBootError(html: string): void {
  if (pagesRefresh.bootRendered) return;
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-empty-state">${html}</div>`;
}

/** Distinguish the two WIKI-set failures the server reports: an unknown wiki
 *  ("no wiki configured…") vs. a registered wiki whose directory is missing on
 *  disk ("wiki directory not found") — different, accurate hints. */
function paintWikiSetError(error: string): void {
  const configured = /directory not found/i.test(error);
  paintBootError(
    WIKI
      ? configured
        ? `Wiki directory not found for <code>${esc(WIKI)}</code>. Check its configured path exists on disk.`
        : `No wiki named <code>${esc(WIKI)}</code>. Add it as a bot <code>wikiDir</code> or a <code>WIKI_EXTRA</code> entry.`
      : "Wiki directory not found. Set <code>WIKI_DIR</code> in .env to the wiki path.",
  );
}

/** Fold an arrived `/api/wiki/pages` response in. Boot and refresh share every
 *  guard; only the error PAINTING is boot-only (a refresh nobody asked for that
 *  fails silently keeps the last good listing, which is strictly better). */
function handlePagesResponse(text: string, seq: number, isBoot: boolean): void {
  let data: WikiPagesResponse | null = null;
  try {
    data = JSON.parse(text) as WikiPagesResponse;
  } catch {
    if (isBoot) paintBootError("Failed to load wiki: malformed response");
    return;
  }
  // Shape guard, not just `data.error`: without it a payload carrying no `pages`
  // array would set `allPages = undefined` and take the whole reader down.
  if (!data || !Array.isArray(data.pages)) {
    if (isBoot) paintWikiSetError((data && data.error) || "");
    return;
  }
  if (data.error && !data.pages.length) {
    if (isBoot) paintWikiSetError(data.error);
    return;
  }
  const fingerprint = pagesFingerprint(text);
  const outcome = receivePages(pagesRefresh, {
    data,
    view: currentViewState(),
    seq,
    fingerprint,
  });
  if (outcome === "apply") applyPagesResponse({ data, fingerprint });
}

/**
 * Issue one listing request.
 *
 * `refresh` sends `?refresh=1`, which makes the server re-scan the wiki index
 * instead of serving its 5-minute TTL cache — without it a focus refetch usually
 * returns the very listing the tab already has, which is the entire bug this
 * exists to fix (measured ~140 ms warm rescan on a 953-page wiki; the 30 s
 * throttle bounds the cost). Reserved for a user actively returning to the tab:
 * the boot load and the idle heartbeat take the TTL-fresh plain fetch.
 */
function requestPages(opts: { refresh: boolean; boot?: boolean }): void {
  // Sequence + throttle stamp at REQUEST time: a hung request must not leave the
  // gate open for a pile-up, and responses are adopted in issue order.
  const seq = startFetch(pagesRefresh, Date.now());
  fetch(withWiki("/api/wiki/pages" + (opts.refresh ? "?refresh=1" : "")))
    .then((r) => r.text())
    .then((text) => handlePagesResponse(text, seq, !!opts.boot))
    .catch((err: Error) => {
      if (opts.boot) paintBootError(`Failed to load wiki: ${esc(err.message)}`);
      // Otherwise silent — a failed refresh keeps the last good listing.
    });
}

function maybeRefetchPages(refresh: boolean): void {
  if (document.hidden) return;
  if (!shouldRefetch(pagesRefresh, Date.now())) return;
  requestPages({ refresh });
}

window.addEventListener("focus", () => maybeRefetchPages(true));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) maybeRefetchPages(true);
});
// The never-blurred tab: visible on a second monitor for hours, firing neither
// event. Same gate, but the PLAIN fetch — server TTL freshness is fine for idle
// drift.
setInterval(() => maybeRefetchPages(false), WIKI_REFETCH_TICK_MS);

// ── Boot ──────────────────────────────────────────────────────────────
// Rehydrate any persisted Ask session into the "This session" list (does not
// auto-show an answer). Safe at module load — the history element is static.
rehydrateAskSession();
requestPages({ refresh: false, boot: true });
