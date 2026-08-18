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

export interface StartCardsDeps {
  /** The shell's `withWiki`: append the active `wiki` param to a URL so every
   *  `/api/wiki/*` fetch stays on-wiki. */
  withWiki(url: string): string;
  /** Map a coverage relPath back to a wiki page name (or null when it doesn't
   *  resolve). A callback, not a copy: it reads the shell's live page listing. */
  resolvePageName(relPath: string): string | null;
}

/** Injected at boot by `initStartCards`. The defaults are inert rather than
 *  throwing so a card rendered before wiring degrades to "no link", never a
 *  broken reader. */
let deps: StartCardsDeps = {
  withWiki: (url) => url,
  resolvePageName: () => null,
};

/** Wire the cards to the shell. Called once, at `wiki-browser.ts` module scope. */
export function initStartCards(d: StartCardsDeps): void {
  deps = d;
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
export function loadDigest(refresh: boolean): void {
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
    const name = linkable ? deps.resolvePageName(rp) : null;
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
