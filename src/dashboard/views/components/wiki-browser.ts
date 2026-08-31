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
import {
  installWikiReadonlyGuard,
  wikiReadonlyWikiFlag,
  WIKI_READONLY_INPUT_PLACEHOLDER,
} from "./wiki-readonly-client.ts";
import { makeSseFrameParser, sseClient, type SseFrame, type SseHandle } from "./client-runtime.ts";
import { askAnswerBodyHtml, renderStreamingBody, enhanceConfidenceHtml } from "./wiki-ask-render.ts";
import {
  tallyClaimOutcomes,
  factcheckOutcomeSummary,
  appendSuccessStatus,
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
  chatEscBarHtml,
  composeDeclineQuestion,
  discussArticleBtnHtml,
  CHAT_ESC_ANSWER_MAX,
  type ChatEscState,
} from "./wiki-chat-target.ts";
// The chat-options / Discuss dialog (the DOM half — the pure half stays in
// `wiki-chat-target.ts` above): IMPORTED for the same reason as the share dialog
// below, and like it the module OWNS its document listeners, so the delegates in
// this file carry no chat-options branch at all. `initChatOptions` both wires the
// port and registers those listeners; where it is called from is load-bearing —
// see that file's header.
import { closeChatOptionsIfNavigatingAway, initChatOptions } from "./wiki-chat-options.ts";
// The share dialog: IMPORTED, never the standalone bundle. This file is itself a
// `Bun.build` entrypoint, so loading both would give the page two copies of the
// module — two states, two document listener sets, one split dialog.
import { openShareDialog, closeShareDialogOnNavigate } from "./share-dialog.ts";
import { shareArticleBtnHtml, SHARE_BTN_ID } from "./wiki-share-dialog.ts";
// The start-view cards (What's new · Index coverage · reindex poller): IMPORTED
// for the same reason as the share dialog above — one bundle, one module state.
import {
  initStartCards,
  loadDigest,
  loadIndexCoverage,
  mountStartCards,
  startReindex,
  type IndexCoverage,
} from "./wiki-start-cards.ts";
import { readActiveWikiName, readActiveWikiRoot, withWikiParam } from "./wiki-param.ts";
import {
  COPY_PATH_BTN_ID,
  COPY_PATH_FAIL,
  COPY_PATH_IDLE,
  COPY_PATH_OK,
  copyPathAriaLabel,
  copyText,
  flashCopyResult,
  wikiPagePath,
} from "./copy-path.ts";
import { enhanceMermaid } from "./wiki-mermaid.ts";
import { atlasBodyHtml, initAtlas } from "./wiki-atlas.ts";
import { enhanceCodeTabs } from "./code-tabs.ts";
import { enhanceCodeBlocks } from "./code-block-chrome.ts";
import { enhanceFactCheck } from "./wiki-factcheck-reader.ts";
import { type DeclineReason } from "../../../wiki/ask-chat.ts";
import {
  askDeclineReason,
  askStatusText,
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
  appendLedeAmendment,
  claimCountFromMap,
  claimOutcomeMapFromRows,
  claimRefFromHeadingText,
  claimRetryBatchLabel,
  claimRetryDoneCopy,
  claimRetryRunningCopy,
  claimRetryStoppedCopy,
  claimRetryUrlFor,
  isClaimOutcome,
  outcomeCountsFromMap,
  retryableClaims,
  spliceClaimBlock,
  CLAIM_RETRY_APPLY_RACE_COPY,
  CLAIM_RETRY_CANCEL_COPY,
  CLAIM_RETRY_WROTE_COPY,
  type ClaimOutcomeByIndex,
  type ClaimRetryStopReason,
  type RetryableClaim,
} from "./wiki-claim-retry.ts";
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
  appendBlockedCopy,
  appendBlockedTone,
  shouldOpenDroppedList,
  INTEGRATE_STALE_COPY_EDIT,
  type DroppedEditRow,
  type IntegrateProposal,
} from "./wiki-integrate.ts";
import {
  findPageByRelPath,
  isActivePage,
  navTargetFrom,
  NAV_LINK_SELECTOR,
  type NavTarget,
} from "./wiki-nav.ts";
import {
  anchorNow,
  connectionTypeOrder,
  breadcrumbLeaf,
  displayTitleOf,
  shortGraphLabel,
  facetKeys,
  filterPages,
  folderCounts,
  folderLabelOf,
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

/** The wiki's effective folder labels (its `.wiki-reader.json` `folderLabels`
 *  plus the store's common-prefix strip), stored at boot from the
 *  /api/wiki/pages response. `{}` — every folder under its own name — for every
 *  wiki that declares none and needs none, which is the default. */
let folderLabels: Record<string, string> = {};

/** The wiki's `defaultType` (its `.wiki-reader.json` leftovers bucket), "" when it
 *  declares none. Stored at boot from the /api/wiki/pages response and read by
 *  exactly one call — `hubTypeList`, which keeps that bucket out of the start
 *  view's "Top … by connections" sections. */
let defaultType = "";

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
/** Which wiki is being browsed — resolved once at boot from the injected
 *  canonical name (else the raw query) by the shared rule in `wiki-param.ts`,
 *  which `wiki-start-cards.ts` re-uses for its un-wired default. Empty =
 *  default/env. */
const WIKI = readActiveWikiName();
/** Where this wiki lives ON DISK — injected by the server, `null` when it named
 *  no servable root. Only the breadcrumb's ⧉ Copy path reads it, and like `WIKI`
 *  it is a boot-time fact: switching wiki is a full navigation. */
const WIKI_ROOT = readActiveWikiRoot();
/** Append the active `wiki` param to a URL so every /api/wiki/* fetch stays on-wiki. */
function withWiki(url: string): string {
  return withWikiParam(url, WIKI);
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
/**
 * The relPath of the page currently rendered in the article pane — the identity
 * the active-row test prefers (`isActivePage`).
 *
 * `currentName` cannot answer "is this row the open page?" on a wiki with
 * same-stem pages: the memory wiki's 30 `MEMORY.md` hubs all have the name
 * `MEMORY`, so opening one drew every one of them active. Assigned from the page
 * RESPONSE (like `currentName`), and cleared with it, so it can never describe a
 * page other than the one on screen.
 */
let currentRelPath: string | null = null;
/**
 * The listing of the page currently rendered in the article pane — stamped by
 * `renderBreadcrumb`, which every article render path calls.
 *
 * Kept beside `currentName` rather than derived from `allPages`, because the
 * single-page `/api/wiki/page` response is the ONLY payload carrying `desc` (the
 * hot listing strips it — see `toListing`'s `includeDesc`), and `desc` is what
 * the Discuss popover shows as its question hint. Looking the page up in
 * `allPages` would silently lose it.
 */
let currentArticle: WikiListing | null = null;
/**
 * Titles of the current page's outgoing links, stamped by `renderConnections`.
 *
 * Only used to offer a "how does this relate to X and Y?" starter question in the
 * Discuss dialog. Kept beside `currentArticle` (rather than read out of the rail's
 * DOM) so the suggestion is derived from data, and cleared with the breadcrumb so
 * a stale page's neighbours can't leak into the next page's chips.
 */
let currentOutgoingTitles: string[] = [];
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

// ── Start-view cards (What's new · Index coverage · reindex) ──────────
// The three cards, their module state and the reindex poller live in
// `wiki-start-cards.ts`; only their entry points are called from here —
// `mountStartCards` from `renderStart`, the three loaders from the click
// delegate. Wired once, at module scope, with the two things they need from the
// shell: the on-wiki URL builder and a lookup over the live page listing.

/** Map a coverage relPath back to a wiki page name so a missing page can link
 *  into the reader (loadPage keys off the stem name). Matches on the same posix
 *  + lowercase rule the store uses (NFC differences fall back to plain text). */
function relPathToName(relPath: string): string | null {
  const key = relPath.replace(/\\/g, "/").toLowerCase();
  const hit = allPages.find((p) => (p.relPath || "").replace(/\\/g, "/").toLowerCase() === key);
  return hit ? hit.name : null;
}

initStartCards({ withWiki, resolvePageName: relPathToName });

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
  // Sorted (and shown) by LABEL: on a wiki whose folder names are opaque — the
  // `memory` wiki's mangled `-Users-rune-source-private-muninn` project dirs — the
  // raw name is neither readable nor a useful sort key. The option VALUE stays the
  // raw folder, so every filter path is untouched.
  const folders = facetKeys(counts, filters.folder).sort((a, b) => {
    if (a === ROOT_FOLDER) return 1; // root pages last — they're the odd ones out
    if (b === ROOT_FOLDER) return -1;
    return folderLabelOf(a, folderLabels).localeCompare(folderLabelOf(b, folderLabels));
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
    const label = f === ROOT_FOLDER ? "(root)" : folderLabelOf(f, folderLabels);
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
    // Both keys on every row: `data-relpath` is what the click delegate and the
    // active test use (it names ONE page), `data-page` stays for anything still
    // reading the name. `isActivePage` falls back to the name comparison only
    // while no relPath is known — see `wiki-nav.ts`.
    const active = isActivePage(p, { name: currentName, relPath: currentRelPath });
    html +=
      `<div class="wiki-list-item${active ? " active" : ""}" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div>` +
      // `title=` carries the full name: the row ellipsizes, and a status pill +
      // ⚑ flag eat enough width that plan titles routinely clip.
      `<div class="wiki-list-title" title="${esc(displayTitleOf(p))}">${esc(displayTitleOf(p))}</div>` +
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

/**
 * ⧉ Copy path — the open page's path ON DISK, for pasting into an agent brief.
 *
 * The same control the plan drawer got, on the surface where the decision is
 * actually made: you read a page, decide it needs an agent, and the one string
 * you then need is the one the breadcrumb does NOT show — its trail's leaf is
 * the page's TITLE, not its filename. Absolute where the server named a root,
 * the relPath alone otherwise (`wikiPagePath`) — and every registered wiki has
 * a root, not just mimir.
 *
 * The path is carried on the button rather than re-derived at click time, so the
 * string in the tooltip and the string on the clipboard cannot be different
 * pages — which is the whole failure mode of a control that reads "the current
 * article" from module state a navigation may already have moved.
 */
function copyPathBtnHtml(m: WikiListing): string {
  const full = wikiPagePath(WIKI_ROOT, m.relPath);
  const aria = copyPathAriaLabel(full);
  // Icon-only: the `title` is the whole discoverability story AND names the exact
  // string, which the dropped "Copy path" label never did.
  return (
    `<button class="wiki-bc-copy" id="${COPY_PATH_BTN_ID}" type="button" ` +
    `data-copy-path="${esc(full)}" title="${esc(full ? "Copy " + full : "Nothing to copy")}" ` +
    `aria-label="${esc(aria)}">${COPY_PATH_IDLE}</button>`
  );
}

/** Run the copy and report it IN the button — the only feedback a clipboard
 *  write can give, and the only way the tailnet `execCommand` path's failure is
 *  visible at all. A missing path reports "Copy failed" rather than returning
 *  silently: `writeText("")` RESOLVES, so copying nothing would report success
 *  while emptying the reader's clipboard, and a bare `return` is a control that
 *  looks live and does nothing — the one outcome with no feedback at all. */
function copyArticlePath(btn: HTMLButtonElement): void {
  const full = btn.getAttribute("data-copy-path") || "";
  const idle = {
    text: COPY_PATH_IDLE,
    ariaLabel: copyPathAriaLabel(full),
    okText: COPY_PATH_OK,
    failText: COPY_PATH_FAIL,
  };
  if (!full) return flashCopyResult(btn, false, idle);
  void copyText(full).then((ok) => flashCopyResult(btn, ok, idle));
}

// ── Breadcrumb bar (above the article) ────────────────────────────────
// Shows "wiki / folder / page · updated" for the open page and hosts the
// Explain affordance (a button shown only while a selection exists — see the
// Select-to-Explain section). Hidden on the start view and on Ask answers.
function renderBreadcrumb(m: WikiListing): void {
  const el = document.getElementById("wikiBreadcrumb");
  // Navigating to a DIFFERENT page invalidates an open article popover: it still
  // targets the page the reader just left, and its anchor button has been
  // detached by this very render. Close it rather than let Send file the question
  // against the wrong article.
  // (The decision itself is `shouldCloseArticleChatOnNavigate`, inside the dialog
  // module — it reads the live dialog state, which no longer lives here.)
  closeChatOptionsIfNavigatingAway(m.relPath);
  // Same rule for the Share dialog, and it needs its own call: the scrim eats a
  // pointer click on a list row (so that path dismisses it for free), but Back /
  // popstate involves no click at all and left it open over the new article,
  // still targeting — and about to summarize — the page the reader had left.
  // Keyed on relPath (`shareNavigationKey`): under the NAME, moving between two
  // same-stem pages left the dialog open and still aimed at the page just left.
  closeShareDialogOnNavigate(m.relPath || m.name);
  // Stamped even when there is no breadcrumb node: it is the "which page is open"
  // answer for the Discuss popover, and every render path funnels through here.
  currentArticle = m;
  // A new page's neighbours aren't known until its `/api/wiki/page` response
  // lands, and the PREVIOUS page's are wrong the moment this render runs.
  currentOutgoingTitles = [];
  if (!el) return;
  const crumbs: string[] = [];
  if (WIKI) crumbs.push('<span class="wiki-bc-wiki">' + esc(WIKI) + "</span>");
  const folder = pageFolder(m);
  const folderCrumb = folder && folder !== ROOT_FOLDER ? folderLabelOf(folder, folderLabels) : "";
  if (folder && folder !== ROOT_FOLDER) {
    // The folder's LABEL, matching the facet — the raw segment is the mangled
    // project dir on the `memory` wiki and unreadable in a breadcrumb.
    crumbs.push('<span class="wiki-bc-folder">' + esc(folderCrumb) + "</span>");
  }
  // The DISPLAYED title: the crumb before this one is the folder LABEL, which on
  // the memory wiki is the project and on mimir is `projects` — so a bare `MEMORY`
  // here leaves the trail reading `memory / muninn / MEMORY` on 30 pages and
  // `mimir / projects / architecture` on three. `displayTitleOf` repeats the
  // discriminator where the store computed one, which is exactly where it is
  // needed.
  crumbs.push('<span class="wiki-bc-cur">' + esc(breadcrumbLeaf(m, folderCrumb)) + "</span>");
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
    // ⧉ Copy path — first in the action cluster because it is about the trail to
    // its left, not about the page's content. Deliberately NOT in either
    // read-only selector list (`wiki-readonly-client.ts`): it spends no model
    // call, writes nothing and reaches no network at all, so it stays live on
    // the wiki this instance may only read — which is the one whose paths get
    // pasted into briefs most.
    copyPathBtnHtml(m) +
    // Selection-gated actions (hidden until a selection exists — see maybeShowExplainPill).
    '<button class="wiki-bc-explain" id="wikiExplainBtn" style="display:none">✨ Explain</button>' +
    '<button class="wiki-bc-factcheck" id="wikiFactcheckBtn" style="display:none">✓ Fact check</button>' +
    // Always-visible whole-article fact check (markdown pages + explainers).
    '<button class="wiki-bc-factcheck wiki-bc-factcheck-article" id="wikiFactcheckArticleBtn" ' +
    'title="Fact-check this whole page against the web">🔎 Fact check</button>' +
    // …and its sibling article-level action: take this page into a real chat
    // thread. Same row deliberately — see `discussArticleBtnHtml`.
    discussArticleBtnHtml() +
    // Third article-level action, same row: turn the page into a pasteable post.
    shareArticleBtnHtml();
  el.style.display = "flex";
}
function hideBreadcrumb(): void {
  const el = document.getElementById("wikiBreadcrumb");
  if (el) el.style.display = "none";
  // No page is open any more, so there is nothing for the Discuss button to act
  // on. Leaving the last page stamped here is the stale-state trap: the button is
  // hidden with the breadcrumb, but every other path that reads `currentArticle`
  // would still be handed a page the reader is no longer on.
  currentArticle = null;
  currentOutgoingTitles = [];
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
      `<div class="wiki-hub-card" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
      `<div class="wiki-hub-title">${esc(displayTitleOf(p))}</div>` +
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
    hubTypeList(allPages, typeOrder, defaultType).forEach((t) => {
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
        `<div class="wiki-tl-item" data-page="${esc(it.p.name)}" data-relpath="${esc(it.p.relPath)}">` +
        `<div class="wiki-tl-kind ${it.kind}">${it.kind === "new" ? "+" : "~"}</div>` +
        `<div class="wiki-type-dot type-${esc(it.p.type)}"></div>` +
        `<div class="wiki-tl-title">${esc(displayTitleOf(it.p))}</div>` +
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
  currentRelPath = null; // the two identities are cleared together, always
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
  // Re-attach the "what's new" and index-coverage cards: cached render reused on
  // a tab switch, otherwise a single lazy fetch each, so neither ever blocks the
  // page list from rendering.
  mountStartCards();
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
  // `shortGraphLabel`, not a head-slice: a colliding node's label is
  // `<prefix>/<stem>`, and cutting from the front threw the stem away entirely.
  const short = (t: string) => shortGraphLabel(t, 15);
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
      `<g class="mini-node" data-page="${esc(n.p.name)}" data-relpath="${esc(n.p.relPath)}"><title>${esc(displayTitleOf(n.p))}</title>` +
      `<circle class="mini-hit" cx="${n.x!.toFixed(1)}" cy="${n.y!.toFixed(1)}" r="14" fill="transparent"></circle>` +
      `<circle class="mini-dot t-${esc(n.p.type)}" cx="${n.x!.toFixed(1)}" cy="${n.y!.toFixed(1)}" r="5"></circle>` +
      // The VISIBLE label, like the `<title>` tooltip two lines up — they were
      // reading from two different fields, so a colliding node's hover text said
      // `muninn/MEMORY` while the dot under it said `MEMORY`.
      `<text x="${n.x!.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(short(displayTitleOf(n.p)))}</text></g>`;
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
  // Feeds the Discuss dialog's "How it connects" starter question. Stamped here
  // because this is the one place the page's resolved neighbours arrive.
  currentOutgoingTitles = (data.outgoing || []).map((p) => p.title).filter((t) => !!t);
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
            `<div class="wiki-conn-item" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
            `<div class="wiki-type-dot type-${esc(p.type)}"></div><span>${esc(displayTitleOf(p))}</span></div>`;
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
      `<div class="wiki-conn-item" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}" title="${esc(p.snippet || "")}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div><span>${esc(displayTitleOf(p))}</span></div>`;
  });
  return html + "</div>";
}

/** Fill the placeholder — but only if the reader is still on the page we fetched
 *  for (a fast tab flip may have moved on). Keyed on relPath, like the fetch. */
function renderSimilarInto(relPath: string, items: SimilarPage[]): void {
  if (currentRelPath !== relPath) return;
  const el = document.getElementById("wikiSimilar");
  if (el) el.innerHTML = similarSectionHtml(items);
}

/** Lazily fetch + render the Similar section for a page. Memoized per page and
 *  guarded against concurrent duplicate fetches; a failed/empty fetch leaves the
 *  section absent.
 *
 *  Keyed on relPath end to end — memo, in-flight guard, query param and the
 *  still-on-this-page test. Under the name key, two same-stem pages shared one
 *  memo entry and the route resolved both to whichever registered first, so the
 *  rail showed another page's cousins under this one.
 *
 *  Skipped entirely on a read-only WIKI: the route ships the page's prose to
 *  huginn's embedder, so it now carries the per-wiki egress prologue and can only
 *  answer 403. The section is absent either way — this just stops one pointless
 *  request per page open. Deliberately NOT in the readonly click guard: nothing
 *  here is a click. */
function loadSimilar(page: { relPath: string }): void {
  if (wikiReadonlyWikiFlag()) return;
  const relPath = page.relPath;
  const memo = similarMemo.get(relPath);
  if (memo) {
    renderSimilarInto(relPath, memo);
    return;
  }
  if (similarInFlight.has(relPath)) return;
  similarInFlight.add(relPath);
  fetch(withWiki("/api/wiki/similar?relPath=" + encodeURIComponent(relPath)))
    .then((r) => r.json())
    .then((data: { similar?: SimilarPage[] }) => {
      const items = Array.isArray(data.similar) ? data.similar : [];
      similarMemo.set(relPath, items);
      renderSimilarInto(relPath, items);
    })
    .catch(() => {
      /* huginn down or route error — hide the section silently */
    })
    .finally(() => {
      similarInFlight.delete(relPath);
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
    // The disambiguated title where the store set one: a shared/reloaded link to
    // one of 30 same-stem pages must say WHICH one it landed on, and the
    // breadcrumb above shows the FIRST path segment, which on the memory wiki is
    // the folder label and on mimir is `projects` — neither is the discriminator.
    `<div class="wiki-article-head"><h1>${esc(displayTitleOf(m))}</h1>${subtitle}<div class="wiki-meta-row">` +
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
  // The listing IS the identity here (no page response to wait for), so the
  // active-row test gets its relPath immediately.
  currentRelPath = m.relPath;
  navInFlight = false; // `currentName` now carries the "article" signal on its own
  if (push) {
    history.pushState({ relPath: m.relPath }, "", pageUrlByRelPath(m.relPath));
  }
  renderBreadcrumb(m);
  // relPath on all three fetches: two explainers in different folders can share a
  // stem, and `?name=` would serve/describe whichever registered first.
  const src = withWiki("/api/wiki/html?relPath=" + encodeURIComponent(m.relPath));
  document.getElementById("articleWrap")!.innerHTML =
    articleHeadHtml(m) +
    `<iframe class="wiki-explainer-frame" src="${esc(src)}" sandbox="allow-scripts allow-popups" title="${esc(m.title)}"></iframe>`;
  document.getElementById("articleWrap")!.scrollTop = 0;
  document.getElementById("connBody")!.innerHTML = '<div class="wiki-conn-empty">Loading…</div>';
  fetch(withWiki("/api/wiki/page?relPath=" + encodeURIComponent(m.relPath)))
    .then((r) => r.json())
    .then((data: WikiPageDetail) => {
      // A fast page flip may have moved on — don't clobber the new page's panel.
      if (data.error || currentRelPath !== m.relPath) return;
      // Re-stamp from the SINGLE-PAGE payload: the listing this render started
      // from came out of `/api/wiki/pages`, which strips `desc` (and an
      // explainer's `description` is sniffed, not always in the listing).
      if (data.meta) currentArticle = data.meta;
      renderConnections(data);
      loadSimilar(m);
    })
    .catch(() => {
      if (currentRelPath !== m.relPath) return;
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

/** Open whatever a click (or a URL) resolved to — the ONE entry point both
 *  navigation keys funnel through, so the explainer branch, the in-flight flag and
 *  the pending-listing apply can't drift between them. */
function openNavTarget(target: NavTarget, push: boolean): void {
  if (target.kind === "relPath") loadPageByRelPath(target.relPath, push);
  else loadPage(target.name, push);
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

/** Open a page by its exact relPath — the collision-proof route, and now the
 *  DEFAULT for every in-reader click (every row/card/rail/wikilink emits a
 *  `data-relpath`). The by-`name` route resolves first-stem-match, which on a wiki
 *  with same-stem pages opens the wrong page entirely. The relPath rides into the
 *  pushed history entry so Back/reload/share re-resolve the SAME page;
 *  `push=false` on popstate/boot replays without re-pushing. */
function loadPageByRelPath(relPath: string, push = true): void {
  hideExplainPill();
  navInFlight = true; // same in-flight window as loadPage
  applyPendingPages(); // same "navigating anyway" moment as loadPage
  // The explainer branch is `loadPage`'s, and it has to exist here too now that
  // ordinary clicks come through this path: an explainer renders in a sandboxed
  // iframe off `/api/wiki/html`, and asking `/api/wiki/page` for one returns the
  // raw HTML file as if it were markdown. The lookup is `findPageByRelPath`, not
  // a raw `===`: an Atlas node key is lowercased and a `?relPath=` can be typed by
  // hand, and a case-differing miss here does not degrade to "not found" — it
  // paints escaped HTML source into the article pane.
  const listing = findPageByRelPath(allPages, relPath);
  if (listing && listing.type === "explainer") {
    loadExplainer(listing, push);
    return;
  }
  fetchAndRenderPage(withWiki("/api/wiki/page?relPath=" + encodeURIComponent(relPath)), push);
}

/** Shared fetch + article render for both by-name and by-relPath navigation.
 *  History is pushed as `?relPath=<relPath>` off the RESOLVED page (see below), so
 *  the round-trip survives Back/reload/share even where stems collide; a response
 *  carrying no relPath at all falls back to the name-based `?page=<name>` URL. */
function fetchAndRenderPage(url: string, push: boolean): void {
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
      // The RESPONSE's relPath, not the requested one: a by-name navigation
      // resolves server-side, and the active row must key on the page that
      // actually came back.
      currentRelPath = data.meta.relPath || null;
      renderBreadcrumb(data.meta);
      if (push) {
        // Push the resolved relPath whenever we have one, even for a by-name
        // navigation — that is what makes reload/Back/share land on the SAME page
        // instead of re-resolving the stem to the first registration.
        if (currentRelPath) {
          history.pushState({ relPath: currentRelPath }, "", pageUrlByRelPath(currentRelPath));
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
      const articleRoot = document.getElementById("articleWrap")!;
      enhanceCodeTabs(articleRoot);
      enhanceCodeBlocks(articleRoot);
      // Fact-check layer: chip → evidence card, the summary strip, and the
      // layer toggle. No-op on a page carrying no annotation.
      enhanceFactCheck(document.getElementById("articleWrap")!);
      renderConnections(data);
      // Lazy: fetch semantic cousins after the page + connections are on screen,
      // so it never blocks the article render.
      loadSimilar(data.meta);
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
  const link = target.closest ? target.closest(NAV_LINK_SELECTOR) : null;
  if (!link) return;
  // `navTargetFrom` prefers `data-relpath` — the only key that names ONE page on a
  // wiki with same-stem pages. The decision is pure + unit-tested (`wiki-nav.ts`);
  // this listener only does the DOM half.
  const targetPage = navTargetFrom(link);
  if (!targetPage) return;
  e.preventDefault();
  openNavTarget(targetPage, true);
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
  // A relPath URL round-trips collision-proof (and is what every in-reader
  // navigation now pushes); check it first, `?page=` stays for older links.
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
  /** The matched page's exact wiki-relative path — the collision-proof click
   *  target beside `pageName` (see `Citation.pageRelPath`). */
  pageRelPath?: string;
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
  // The checked page's exact wiki-relative path — the COLLISION-PROOF half of that
  // target, sent beside the name by every action this turn can launch (➕ append,
  // ✎ integrate, ↻ claim retry, the post-write reload). It rides the TURN, not
  // `currentArticle`, because a persisted turn outlives the open article. See
  // `StoredAskTurn.pageRelPath`.
  pageRelPath?: string;
  pageType?: string; // the checked page's type — ➕ gates markdown-only (hides on "explainer")
  toolSources?: string[]; // hostnames consulted during a fact check (WebFetch targets, deduped)
  toolSourceUrls?: Record<string, string>; // host → first full URL seen (feeds the Consulting chip hrefs). Persisted intentionally; a pre-PR / malformed-dropped turn lacks it ⇒ chips fall back to https://<host>/.
  claimCount?: number; // claims verified in a fact check (from the `done` payload; drives the meta line)
  claimOutcomes?: ClaimOutcomeCounts; // per-outcome tally for the honest fact-check meta line (persisted)
  // Per-claim outcome keyed by the claim's 1-based index. PERSISTED: it is what
  // decides which claims get a ↻ retry, while the outcomes themselves arrive only
  // on the transient `claim_result` events. The tally beside it counts but can't
  // say WHICH claim timed out. After a successful retry this map is the single
  // authority — `claimOutcomes` + `claimCount` are re-derived from it.
  claimOutcomeByIndex?: ClaimOutcomeByIndex;
  // The fact-check mode + the selection/heading it ran against, so a ↻ can re-issue
  // the same scoped call (a sel-mode turn retried in article mode would verify the
  // claim against a passage nobody selected). PERSISTED.
  fcMode?: string;
  fcSel?: string;
  fcCtx?: string;
  claims?: ClaimRow[]; // per-claim checklist for a multi-claim fact check (transient; not persisted)
  toolLog?: ToolLogRow[]; // compact per-claim tool log during a fact check (transient; not persisted)
  // Which write action this turn already performed. PERSISTED, because both write
  // buttons' disabled state is derived from it at render time — a DOM-only disable
  // would come back enabled after a reload and the click would only ever 409
  // (whichever write happened staled this turn's baseHash).
  wrote?: string; // "append" | "integrate"
  // Did that write actually persist a fact-check BLOCK (the `.mdx` `<FactCheck>`
  // appendix or the `.md` `> [!factcheck]` callout)? PERSISTED for the same reason
  // as `wrote`: the ➕ bar's copy AND its tone are derived from it at render time.
  // Deliberately not inferred from `annotatable` — the apply route has an explicit
  // no-block branch that an `.mdx` page reaches whenever every mark drops and the
  // callout checkbox is off.
  wroteBlock?: boolean;
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
  // The retrieval decline that ended this turn, mapped from the `done` payload by
  // `askDeclineReason` (which checks lowConfidence FIRST — `noHits` is true on both
  // decline branches). PERSISTED: the decline hook replaces the ordinary escalate
  // bar and is re-derived on every turn switch / rehydrate, while the flags exist
  // only on the transient `done` event.
  declined?: DeclineReason;
  // Explain turns only: the page the passage was selected from (its title, else
  // its name). PERSISTED — without it an escalated Explain turn carries only the
  // `Explain: "…"` display label, which names neither the page nor the real
  // question (`composeDeclineQuestion`).
  explainPage?: string;
  // Follow-up turns only: the ALREADY-COMPOSED question that opened this chain.
  // PERSISTED for the same reason — "and what about the second one?" is
  // unanswerable on its own. Chains keep the ROOT (a follow-up of a follow-up
  // inherits its parent's origin rather than nesting).
  originQuestion?: string;
  // "Continue in chat →" state for THIS turn. Not declared on StoredAskTurn — but
  // `serializeAskSession` JSON-stringifies the live turns, so it DOES ride along
  // into localStorage and a rehydrated turn can still show a link to a thread from
  // a previous session (accepted, pre-existing; `isValidTurn` neither validates nor
  // strips it). The field's real job is intra-session: `#wikiChatEscBar` is a
  // singleton node owned by whichever turn is painted, so holding the outcome on
  // the TURN is what stops a late fetch painting turn A's result onto turn B.
  chatEsc?: ChatEscState;
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
      // Both keys, as on every other row emitter: `data-relpath` names ONE page
      // and `navTargetFrom` prefers it; the name stays for a citation the
      // enrichment could not give a path.
      const pageAttr =
        (c.pageName ? ' data-page="' + esc(c.pageName) + '"' : "") +
        (c.pageRelPath ? ' data-relpath="' + esc(c.pageRelPath) + '"' : "");
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
  // A read-only wiki disables the bar at RENDER time, not only through the body
  // class: `disabled` is a per-render property and this bar is repainted on
  // every turn switch / SSE terminal event / splice, so a one-shot DOM sweep at
  // boot would be undone by the next paint. (The body-class guard still cancels
  // the mousedown/Enter, and the placeholder is the same shared string the
  // server renders into `#wikiAskInput`.)
  const ro = wikiReadonlyWikiFlag();
  const disabled = turn.answer && !ro ? "" : " disabled";
  const placeholder = ro ? WIKI_READONLY_INPUT_PLACEHOLDER : "Ask a follow-up…";
  return (
    '<div class="wiki-followup" id="wikiFollowupBar">' +
    '<input id="wikiFollowupInput" class="wiki-followup-input" type="text" ' +
    'placeholder="' + esc(placeholder) + '" autocomplete="off"' + disabled + " />" +
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
  return '<div class="wiki-chatesc" id="wikiChatEscBar">' + chatEscBarHtml(turn) + "</div>";
}

/** Re-render the escalate bar from the turn. TURN-GUARDED for the same reason
 *  `refreshWriteActionBars` is: the bar is a singleton node belonging to whichever
 *  turn is on screen. Nothing is lost by skipping — `showAskAnswer` renders the
 *  bar from the newly shown turn's own `chatEsc`. */
function refreshChatEscalateBar(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const bar = document.getElementById("wikiChatEscBar");
  if (bar) bar.innerHTML = chatEscBarHtml(turn);
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
  // A write that COMPLETED is not an error. The tone and the words come from the
  // same turn state, so the red class and the sentence can never disagree the way
  // they did when the class was derived from `blocked` alone.
  const tone = blocked && appendBlockedTone(turn) === "error" ? " error" : "";
  return (
    '<button id="wikiFactcheckAppendBtn" class="wiki-fc-append-btn"' + disabled + ">➕ Add to article</button>" +
    '<span class="wiki-fc-append-msg' + tone + '" id="wikiFactcheckAppendMsg">' +
    (blocked ? esc(appendBlockedCopy(turn)) : "") +
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
  // Same reasoning for the ↻ retry bar: it is derived from `turn.answer` +
  // `turn.claimOutcomeByIndex`, neither of which exists when the pane is painted.
  refreshClaimRetryBar(turn);
}

// ── Claim retry (↻) ───────────────────────────────────────────────────
// The client half of `GET /api/wiki/factcheck/claim`: re-verify ONE claim that
// timed out, was skipped, or errored, and splice its fresh verdict block into the
// persisted answer. A model-chosen ❓ (`unverifiable`) is deliberately NOT
// retryable — see `RETRYABLE_OUTCOMES`.
//
// TWO CONTRACTS this code lives or dies on:
//
//  - **`###` in markdown, `<h4>` in the DOM.** `formatWebHtml`'s heading renderer
//    emits `h${Math.min(level + 1, 6)}`, so the `### <emoji> Claim n/m` prompt
//    contract lands in the pane as an `<h4>`. An `h3` selector here would match
//    NOTHING and ship an invisible button, so the DOM pass queries ALL heading
//    levels and filters on the `Claim n/m` TEXT (`claimRefFromHeadingText`) —
//    a future level shift can't silently kill it either.
//  - **The affordance is re-applied at EVERY paint, never injected once.** The
//    answer body is replaced wholesale by `showAskAnswer`, by the `done` paint, by
//    the `answer_html` paint and by this feature's OWN repaint after a splice, so
//    a one-shot injection would vanish on the very next render.
//
// **Cancel is client-side only** and the UI says so: there is no abort plumbing on
// this path (`streamFactcheckSSE` treats a gone client as a launch GATE, and
// `tracedOneShot` carries no cancellation token). Cancel stops the BATCH from
// launching the next claim and detaches this client; the in-flight claim finishes
// server-side while holding the page's single-flight slot — which is exactly why a
// row ↻ clicked mid-batch 409s, and why the 409's `expiresAtMs` is rendered.

/** Per-turn, per-claim ↻ row message (live progress · a failure · a 409's
 *  deadline), keyed `askedAt` → claim index, the `integrateBarMsgs` precedent.
 *  Held OFF the DOM so the repaint after a splice — or a turn switch and back —
 *  reproduces it instead of wiping it. */
const claimRetryMsgs: Record<number, Record<number, { text: string; error: boolean }>> = {};

/** Per-turn ↻ BAR message, keyed by `askedAt` — the `integrateBarMsgs` shape one
 *  level up from the rows. It exists because the bar's two most important states
 *  outlive the run record: the cancel copy (which must not be replaced, one frame
 *  later, by an enabled button whose click can only 409) and the terminal
 *  "Re-checked N of M". Both were promised by comments and rendered by nothing. */
const claimRetryBarMsgs: Record<number, string> = {};

/** The retry currently in flight — at most ONE. The route is per-page
 *  single-flight anyway, and a batch runs SEQUENTIALLY so the tool chips and the
 *  status line stay legible (bounded by FACTCHECK_MAX_CLAIMS × 180s ≈ 24 min worst
 *  case, hence a visible running state rather than a silent spinner). */
interface ClaimRetryRun {
  turn: AskTurn;
  /** The claim currently being re-checked. */
  index: number;
  batch: boolean;
  cancelled: boolean;
  /** Claims in this run's queue (1 for a row ↻). */
  total: number;
  /** Claims that actually landed a fresh verdict — NOT "attempted". A failure, a
   *  409 or a cancel must not read as done. */
  done: number;
  cancel: () => void;
}
let claimRetryRun: ClaimRetryRun | null = null;

/**
 * Is `turn` still part of the session?
 *
 * `clearAskSession` empties `askTurns` and drops both message records, but the ↻ it
 * aborts resolves AFTERWARDS — `driveClaimRetry`'s tail and `retryAllClaims`'
 * terminal `setClaimRetryBarMsg` both run on the evicted turn and would re-create
 * its key, leaking a record nothing will ever read or drop again. Both setters are
 * gated on this, so a late write on an evicted turn PRUNES instead of resurrecting.
 */
function askTurnIsLive(turn: AskTurn): boolean {
  return askTurns.indexOf(turn) !== -1;
}

/** Set (or clear, with an empty `text`) one ↻ row's message and repaint that row. */
function setClaimRetryMsg(turn: AskTurn, index: number, text: string, error = false): void {
  const forTurn = claimRetryMsgs[turn.askedAt] || (claimRetryMsgs[turn.askedAt] = {});
  if (text && askTurnIsLive(turn)) forTurn[index] = { text, error };
  else delete forTurn[index];
  // Prune the empty per-turn bucket, the `integrateBarMsgs` lifecycle: the record
  // is keyed by `askedAt` and nothing else would ever drop it.
  if (!Object.keys(forTurn).length) delete claimRetryMsgs[turn.askedAt];
  paintClaimRetryRow(turn, index);
}

/** Set (or clear) the ↻ bar's persistent per-turn message and repaint the bar.
 *  Same evicted-turn pruning as {@link setClaimRetryMsg} — the bar record used to be
 *  the one that got resurrected, since the batch's terminal line is written after
 *  everything else has settled. */
function setClaimRetryBarMsg(turn: AskTurn, text: string): void {
  if (text && askTurnIsLive(turn)) claimRetryBarMsgs[turn.askedAt] = text;
  else delete claimRetryBarMsgs[turn.askedAt];
  refreshClaimRetryBar(turn);
}

/** Drop every ↻ message for a turn (its rows and its bar) — used when the whole
 *  session is cleared, the one lifecycle point that otherwise leaks both records. */
function clearClaimRetryMsgs(turn: AskTurn): void {
  delete claimRetryMsgs[turn.askedAt];
  delete claimRetryBarMsgs[turn.askedAt];
}

/** Inner markup of one ↻ row, DERIVED from turn + run state (never mutated in
 *  place only), so every repaint reproduces it. */
function claimRetryRowInnerHtml(turn: AskTurn, claim: RetryableClaim): string {
  const running = !!claimRetryRun && claimRetryRun.turn === turn && claimRetryRun.index === claim.index;
  const busy = !!claimRetryRun && !running;
  const msg = (claimRetryMsgs[turn.askedAt] || {})[claim.index];
  // A turn that already wrote to the page gets a DISABLED ↻ with one line of copy,
  // not nothing: check → ➕ → notice-the-❓ is a common sequence, and every other
  // derived-disable state here explains itself (the INTEGRATE_STALE_COPY precedent).
  // Silently removing the affordance reads as a bug.
  const wrote = !!turn.wrote;
  const label = running ? "↻ Re-checking… up to ~3 min" : "↻ Re-check this claim";
  const disabled = wrote || running || busy ? " disabled" : "";
  const text = wrote ? CLAIM_RETRY_WROTE_COPY : msg?.text || "";
  return (
    '<button class="wiki-fc-retry-btn" data-claim-retry-btn="' + claim.index + '"' + disabled + ">" +
    label + "</button>" +
    '<span class="wiki-fc-retry-msg' + (!wrote && msg?.error ? " error" : "") + '">' +
    esc(text) + "</span>"
  );
}

/**
 * Insert a ↻ row under every retryable claim's heading in the rendered answer.
 *
 * Idempotent by construction (it removes its own rows first), because it runs at
 * every paint site the other body enhancers run at. See the section header for the
 * h4 trap driving the all-levels query.
 *
 * TURN-GUARDED like `refreshWriteActionBars`/`refreshClaimRetryBar`: `#askAnswerBody`
 * is a singleton node owned by whichever turn is painted, and two of the four call
 * sites are late SSE handlers that can resolve after a turn switch.
 *
 * `turn.page` gates it exactly as it gates the bar — without a page there is no
 * retry URL to build, and a live-looking ↻ whose click is a silent no-op is worse
 * than no ↻ at all.
 */
function applyRetryAffordances(bodyEl: HTMLElement | null, turn: AskTurn): void {
  if (!bodyEl || turn !== askShownTurn) return;
  bodyEl.querySelectorAll(".wiki-fc-retry").forEach((n) => n.remove());
  if (turn.kind !== "factcheck" || !turn.answer || !turn.page) return;
  const claims = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes);
  if (!claims.length) return;
  const byIndex: Record<number, RetryableClaim> = {};
  claims.forEach((c) => { byIndex[c.index] = c; });
  // A rendered heading can repeat an index even after `retryableClaims` refuses to
  // OFFER duplicates (the answer's own duplicates are skipped there, but a heading
  // may also be echoed by unrelated markup). Decorate the FIRST one only —
  // `data-claim-retry` is the row's lookup key and must stay unique in the pane.
  const decorated = new Set<number>();
  // Markdown contract `###`, DOM contract `h4` — both load-bearing, so match on the
  // heading TEXT across every level rather than on a tag name.
  bodyEl.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const ref = claimRefFromHeadingText(h.textContent || "");
    if (!ref) return;
    const claim = byIndex[ref.index];
    if (!claim || decorated.has(claim.index)) return;
    decorated.add(claim.index);
    const row = document.createElement("div");
    row.className = "wiki-fc-retry";
    row.setAttribute("data-claim-retry", String(claim.index));
    row.innerHTML = claimRetryRowInnerHtml(turn, claim);
    h.insertAdjacentElement("afterend", row);
  });
}

/** Repaint ONE ↻ row in place (live progress during a 180s run — the common path
 *  is a single claim, not the batch, so the progress belongs on the row itself).
 *  Scoped to the answer body: `data-claim-retry` is unique THERE, but a bare
 *  `document.querySelector` would happily pick up a same-keyed node anywhere. */
function paintClaimRetryRow(turn: AskTurn, index: number): void {
  if (turn !== askShownTurn) return;
  const body = document.getElementById("askAnswerBody");
  const row = body?.querySelector('.wiki-fc-retry[data-claim-retry="' + index + '"]');
  if (!row) return;
  const claim = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes).find(
    (c) => c.index === index,
  );
  if (!claim) return;
  row.innerHTML = claimRetryRowInnerHtml(turn, claim);
}

/** Repaint EVERY ↻ row on the shown turn. A run start/end flips every sibling
 *  row's `busy` disable, and repainting only the running row left the others
 *  looking enabled while their clicks no-opped. */
function paintAllClaimRetryRows(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const body = document.getElementById("askAnswerBody");
  if (!body) return;
  body.querySelectorAll(".wiki-fc-retry[data-claim-retry]").forEach((row) => {
    const idx = Number(row.getAttribute("data-claim-retry"));
    if (Number.isFinite(idx)) paintClaimRetryRow(turn, idx);
  });
}

/** "Retry N unverified claims" bar — rendered only above ONE retryable claim (a
 *  lone one is served by its own row ↻). Always emitted as a wrapper so the `done`
 *  refresh can fill it in place; `.wiki-fc-retryall:empty` collapses it. */
function askClaimRetryBarHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck") return "";
  return '<div class="wiki-fc-retryall" id="wikiClaimRetryBar">' + claimRetryBarInnerHtml(turn) + "</div>";
}

function claimRetryBarInnerHtml(turn: AskTurn): string {
  if (turn.kind !== "factcheck" || !turn.answer || !turn.page) return "";
  const claims = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes);
  const run = claimRetryRun && claimRetryRun.turn === turn ? claimRetryRun : null;
  // The terminal message (a cancel, or "Re-checked N of M") lives on the TURN, not
  // on the run record — the run is nulled the moment the batch settles, and the
  // first cut therefore painted both for exactly one frame before repainting an
  // idle enabled bar whose click could only 409.
  const barMsg = claimRetryBarMsgs[turn.askedAt] || "";
  const msgHtml = barMsg ? '<span class="wiki-fc-retryall-msg">' + esc(barMsg) + "</span>" : "";
  // Nothing left to retry — but a settled batch keeps reporting itself until the
  // turn is repainted from scratch, so "Re-checked 3 of 3" doesn't vanish on the
  // last splice.
  if (!claims.length && !run) return msgHtml;
  if (turn.wrote) {
    // The persistent line comes FIRST and is not shadowed: a batch stopped BY the
    // write ("Stopped after 2 of 3 — the article was written from this answer")
    // says what happened to the run, while the wrote copy only explains the
    // disable. Rendering the second alone lost the first.
    if (claims.length < 2) return msgHtml;
    return msgHtml + '<span class="wiki-fc-retryall-msg">' + esc(CLAIM_RETRY_WROTE_COPY) + "</span>";
  }
  if (run && run.batch) {
    const status = run.cancelled
      ? CLAIM_RETRY_CANCEL_COPY
      : "Re-checking claim " + run.index + " — " + run.done + " of " + run.total + " done";
    return (
      '<button class="wiki-fc-retryall-btn" disabled>' + esc(claimRetryBatchLabel(run.total)) + "</button>" +
      (run.cancelled
        ? ""
        : '<button class="wiki-fc-retryall-cancel" id="wikiClaimRetryCancel">Cancel</button>') +
      '<span class="wiki-fc-retryall-msg">' + esc(status) + "</span>"
    );
  }
  if (claims.length < 2) return msgHtml;
  const busy = !!run;
  return (
    '<button class="wiki-fc-retryall-btn" id="wikiClaimRetryAll"' + (busy ? " disabled" : "") + ">" +
    esc(claimRetryBatchLabel(claims.length)) + "</button>" +
    (barMsg
      ? msgHtml
      : '<span class="wiki-fc-retryall-msg">one at a time · up to ~3 min each</span>')
  );
}

/** Re-render the ↻ bar from the turn. TURN-GUARDED for the same reason
 *  `refreshWriteActionBars` is — it is a singleton node owned by whichever turn is
 *  painted. */
function refreshClaimRetryBar(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const bar = document.getElementById("wikiClaimRetryBar");
  if (bar) bar.innerHTML = claimRetryBarInnerHtml(turn);
}

/** Repaint the answer body from `turn.answer` and re-run every enhancer the `done`
 *  path runs — including the retry affordances, which the repaint would otherwise
 *  destroy.
 *
 *  No server round-trip is needed after a splice: the fact-check route's
 *  `renderAnswerHtml` is `renderAskAnswerHtml(answer, [])`, and with an empty
 *  citation list that reduces to `formatWebHtml(answer)` — the same function
 *  `renderStreamingBody` wraps (plus the confidence enhancement the client applies
 *  on every paint anyway). */
function repaintAskAnswerBody(turn: AskTurn): void {
  if (turn !== askShownTurn) return;
  const b = document.getElementById("askAnswerBody");
  if (!b) return;
  b.innerHTML = renderStreamingBody(turn.answer);
  enhanceMermaid(b);
  enhanceCodeTabs(b); enhanceCodeBlocks(b);
  applyRetryAffordances(b, turn);
}

/** Handlers for one retry stream. */
interface ClaimRetryStreamHandlers {
  tool?: (d: Record<string, unknown>) => void;
  claim_result?: (d: Record<string, unknown>) => void;
  app_error?: (message: string) => void;
  /** The route's per-page single-flight 409 `{state:"running", expiresAtMs}`. */
  conflict?: (expiresAtMs: unknown) => void;
  /** Transport-level failure (unreachable server, non-200 that isn't the 409). */
  failed?: (message: string) => void;
}

/**
 * Consume the retry SSE through **fetch + a ReadableStream**, deliberately NOT
 * `sseClient`/`EventSource`.
 *
 * Two reasons, both empirical: `EventSource` exposes neither the status nor the
 * body on a non-200, so the route's 409 `{state:"running", expiresAtMs}` — the
 * whole point of the deadline riding that body — would be unreadable; and it
 * auto-reconnects on a network drop, where the reconnect would hit the very
 * single-flight slot the first connection is holding and fail opaquely while
 * wedging the row.
 */
function openClaimRetryStream(
  url: string,
  h: ClaimRetryStreamHandlers,
): { done: Promise<void>; cancel: () => void } {
  const ctrl = new AbortController();
  const done = (async () => {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
    } catch {
      if (!ctrl.signal.aborted) h.failed?.("Could not reach the server — nothing was changed.");
      return;
    }
    if (res.status === 409) {
      let body: { expiresAtMs?: unknown } = {};
      try { body = (await res.json()) as { expiresAtMs?: unknown }; } catch { /* keep the default copy */ }
      h.conflict?.(body?.expiresAtMs);
      return;
    }
    if (!res.ok || !res.body) {
      let msg = "The re-check could not start (HTTP " + res.status + ").";
      try {
        const b = (await res.json()) as { error?: unknown };
        if (b && typeof b.error === "string") msg = b.error;
      } catch { /* non-JSON body — keep the status copy */ }
      h.failed?.(msg);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // Framing (CRLF delimiters, chunk-straddling frames, the unterminated tail a
    // server that closes right after `claim_result` leaves behind) is the shared,
    // unit-tested `makeSseFrameParser` beside `sseClient` — it is generic stream
    // plumbing and cannot be tested from inside this DOM module.
    const parser = makeSseFrameParser((frame) => dispatchClaimRetryFrame(frame, h));
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
      // Flush the decoder's own trailing state, then the buffered final frame.
      parser.push(decoder.decode());
      parser.end();
    } catch {
      if (!ctrl.signal.aborted) h.failed?.("The connection dropped — nothing was changed.");
    }
  })();
  return { done, cancel: () => ctrl.abort() };
}

/** Fan one decoded SSE frame out to the handlers.
 *
 *  The route's vocabulary is `tool` · `claim_result` · `app_error` · `done`
 *  (the per-claim terminal) · `end` (the shared scaffold's terminal) ·
 *  `heartbeat`. The last three carry nothing this client acts on — but they are
 *  named explicitly rather than silently falling through, so a future event can't
 *  be swallowed as "probably a sentinel". */
function dispatchClaimRetryFrame(frame: SseFrame, h: ClaimRetryStreamHandlers): void {
  const event = frame.event;
  if (event === "heartbeat" || event === "done" || event === "end") return;
  let d: Record<string, unknown>;
  try { d = JSON.parse(frame.data) as Record<string, unknown>; } catch { return; }
  if (event === "tool") h.tool?.(d);
  else if (event === "claim_result") h.claim_result?.(d);
  else if (event === "app_error") {
    h.app_error?.(typeof d.message === "string" ? d.message : "The re-check failed.");
  }
}

/**
 * Fold a retry's `tool` event into the turn's Consulting chips, exactly as the
 * article run's own handler does — a retried claim's sources belong on the turn
 * that will carry its verdict.
 */
function recordToolSource(turn: AskTurn, d: Record<string, unknown>): boolean {
  const detail = typeof d.detail === "string" ? d.detail : "";
  if (!detail || d.name !== "WebFetch") return false;
  if (!turn.toolSources) turn.toolSources = [];
  if (turn.toolSources.indexOf(detail) !== -1) return false;
  turn.toolSources.push(detail);
  if (typeof d.url === "string" && d.url) {
    if (!turn.toolSourceUrls) turn.toolSourceUrls = {};
    if (!turn.toolSourceUrls[detail]) turn.toolSourceUrls[detail] = d.url;
  }
  return true;
}

/**
 * Fold a successful `claim_result` into the turn: splice the block, amend the lede,
 * re-derive the counts, repaint, persist. Returns whether anything was written.
 *
 * **A SUPERSEDED retry keeps its work and skips only the paint.** The splice, the
 * outcome-map write and `persistAskSession` are all turn-scoped and perfectly safe
 * off-screen; discarding them threw away a completed 180-second verdict, left the
 * hole at ❓ and left the ↻ live to spend it all over again. Only the DOM repaint
 * (which owns singleton nodes belonging to whichever turn is painted) is guarded —
 * and when the reader switches back, the rehydrated paint shows the spliced answer.
 */
function applyClaimRetryResult(
  turn: AskTurn,
  claim: RetryableClaim,
  d: Record<string, unknown>,
): boolean {
  // Re-check the write state AT SPLICE TIME, not just at launch: a ➕/✎ that landed
  // mid-run committed the PRE-splice answer to the page, so splicing now would
  // leave the committed article and the turn silently disagreeing about what the
  // check found — and both write buttons already read as "already written".
  if (turn.wrote) {
    setClaimRetryMsg(turn, claim.index, CLAIM_RETRY_WROTE_COPY, true);
    return false;
  }
  const markdown = typeof d.markdown === "string" ? d.markdown : "";
  // A block whose heading RENUMBERED is corrected, not thrown away. The route
  // deliberately accepts one (`isClaimVerdictBlock` in `factcheck-sse.ts` calls a
  // renumbered heading a formatting wobble rather than a wrong claim, because
  // refusing it discards a completed 180s verification), so refusing it here just
  // moved that loss to the last hop; `spliceClaimBlock` rewrites the `n/m` to the
  // claim it was asked about — which is also what keeps the answer free of the
  // duplicate index that would retire the wrong ↻. A block carrying NO claim
  // heading at all is still refused there: it has no anchor to correct.
  //
  // The WIRE index is a different check and stays strict — the route echoes the
  // index it was asked for, so a disagreement is a transport-level problem, not a
  // model wobble.
  const wireIndex = typeof d.index === "number" ? d.index : undefined;
  const mismatched = wireIndex !== undefined && wireIndex !== claim.index;
  const spliced = mismatched ? null : spliceClaimBlock(turn.answer, claim.index, markdown);
  if (!spliced) {
    setClaimRetryMsg(
      turn,
      claim.index,
      "The re-checked block didn't match this claim — nothing was changed.",
      true,
    );
    return false;
  }
  // The outcome map is written FIRST and is the single authority from here on:
  // `tallyClaimOutcomes` reads `turn.claims`, which `done` cleared, and `claimCount`
  // was a server-side count of real blocks. Skipping this write is the silent
  // failure mode — the claim would keep offering ↻ forever.
  const map: ClaimOutcomeByIndex = turn.claimOutcomeByIndex || (turn.claimOutcomeByIndex = {});
  // VALIDATE the wire value against the five-outcome vocabulary. An arbitrary
  // string sails through `isValidOutcomeMap`'s `.every` on the next load and drops
  // the ENTIRE persisted map — every other claim's outcome with it.
  map[claim.index] = isClaimOutcome(d.outcome) ? d.outcome : "verified";
  turn.answer = appendLedeAmendment(spliced, claim.index);
  turn.claimOutcomes = outcomeCountsFromMap(map);
  turn.claimCount = claimCountFromMap(map);
  // The stored server-rendered HTML describes the pre-splice answer; drop it so
  // every later paint (including a history re-show) renders the new markdown.
  turn.html = null;
  // An open integrate preview was resolved against the PRE-splice answer: its
  // ranges came from that body and its Apply would post edits computed for text
  // this splice just changed. Invalidate it rather than let it write.
  invalidateIntegratePreviewAfterSplice(turn);
  // NB no `persistAskSession()` here — `driveClaimRetry` owns it and calls it on
  // EVERY path (it also has to persist the tool chips a failed retry grew), so a
  // second call was one write of the same session per success.
  // Everything above is turn-scoped. Everything below touches singleton DOM nodes.
  if (turn !== askShownTurn) return true;
  setClaimRetryMsg(turn, claim.index, "");
  repaintAskAnswerBody(turn);
  refreshAskSources(turn); // the meta line reads claimOutcomes / claimCount
  refreshWriteActionBars(turn);
  return true;
}

/** A splice changed the answer under an open integrate preview — the proposal's
 *  resolved ranges and its `answer` payload now describe a body that no longer
 *  exists, and Apply would post pre-splice edits alongside a post-splice answer.
 *  Drop it with an honest message instead. */
function invalidateIntegratePreviewAfterSplice(turn: AskTurn): void {
  if (!integratePreview || integratePreview.turn !== turn) return;
  // An apply already in flight owns its own response path and cannot be recalled —
  // it is posting the PRE-splice answer and will set `turn.wrote` when it lands, so
  // the page ends up written from a version of the answer this turn no longer
  // holds. Nothing here can prevent that ordering; what it must not do is stay
  // SILENT about it. The `turn.wrote` re-check in `applyClaimRetryResult` only
  // covers the other order (apply first, splice after).
  if (integratePreview.applying) {
    setIntegrateBarMsg(turn, CLAIM_RETRY_APPLY_RACE_COPY, true);
    setClaimRetryBarMsg(turn, CLAIM_RETRY_APPLY_RACE_COPY);
    return;
  }
  integratePreview = null;
  renderIntegratePreview();
  setIntegrateBarMsg(turn, "The answer changed — propose the edits again.", true);
}

/** Re-verify ONE claim end to end. Resolves `true` when the answer was rewritten.
 *  Every refusal that a CLICK can reach reports itself on the row — a silently
 *  dead button is the failure mode this affordance can least afford. */
async function retryOneClaim(turn: AskTurn, claim: RetryableClaim, batch: boolean): Promise<boolean> {
  if (claimRetryRun) {
    setClaimRetryMsg(turn, claim.index, "A re-check is already running on this page.", true);
    return false;
  }
  if (turn.wrote) {
    setClaimRetryMsg(turn, claim.index, CLAIM_RETRY_WROTE_COPY, true);
    return false;
  }
  if (!turn.page || !turn.answer) {
    setClaimRetryMsg(turn, claim.index, "This turn has no page to re-check against.", true);
    return false;
  }
  const run: ClaimRetryRun = {
    turn, index: claim.index, batch, cancelled: false, total: 1, done: 0, cancel: () => {},
  };
  claimRetryRun = run;
  // A row ↻ runs UNDER the bar, so the bar's persistent line — a previous batch's
  // "Stopped after 1 of 4 — …" or its "Re-checked 2 of 3" — would sit there
  // describing a run that ended, while this one is live. Clear it here rather than
  // in `driveClaimRetry`, which the batch also drives and whose own terminal line
  // `retryAllClaims` writes afterwards. `driveClaimRetry`'s finally re-derives the
  // bar from the turn at the end.
  setClaimRetryBarMsg(turn, "");
  return await driveClaimRetry(turn, claim, run, claimRetryUrlFor(turn, claim, WIKI));
}

/** The stream half of {@link retryOneClaim} / the batch, split out so the batch can
 *  own the counters on the shared run record.
 *
 *  The whole body sits in a try/FINALLY: any throw in the tail (the splice, a
 *  render, `persistAskSession`) used to leave `claimRetryRun` set forever, which
 *  disables EVERY ↻ on the page until a reload. The run record must be released on
 *  the failure path or the feature wedges itself. */
async function driveClaimRetry(
  turn: AskTurn,
  claim: RetryableClaim,
  run: ClaimRetryRun,
  url: string,
): Promise<boolean> {
  let ok = false;
  try {
    setClaimRetryMsg(turn, claim.index, "Re-checking…");
    // Every sibling row's `busy` disable flips with the run — repaint them all, or
    // a second row's ↻ looks live and no-ops on click.
    paintAllClaimRetryRows(turn);
    refreshClaimRetryBar(turn);
    const stream = openClaimRetryStream(url, {
      tool: (d) => {
        // `start` frames only, matching the article run's own gate: an `end` frame
        // carries no `detail`, so recording from it can only ever be a no-op or a
        // host recorded from a field that doesn't mean what the chip claims.
        if (d.state === "start" && recordToolSource(turn, d)) {
          // `#askToolSources` is a singleton node owned by the painted turn.
          if (turn === askShownTurn) refreshAskToolSources(turn);
        }
        if (d.state === "start") {
          const label = typeof d.label === "string" && d.label ? d.label : "Working";
          const detail = typeof d.detail === "string" ? d.detail : "";
          setClaimRetryMsg(turn, claim.index, label + (detail ? ": " + detail : "") + "…");
        } else if (d.state === "end") {
          setClaimRetryMsg(turn, claim.index, "Re-checking…");
        }
      },
      claim_result: (d) => { ok = applyClaimRetryResult(turn, claim, d); },
      // A FAILED retry leaves the persisted answer byte-untouched (the route emits no
      // claim_result) — the reason lands on the row and the ↻ stays live.
      app_error: (m) => setClaimRetryMsg(turn, claim.index, m, true),
      conflict: (expiresAtMs) =>
        setClaimRetryMsg(turn, claim.index, claimRetryRunningCopy(expiresAtMs), true),
      failed: (m) => setClaimRetryMsg(turn, claim.index, m, true),
    });
    run.cancel = stream.cancel;
    await stream.done;
    // Clear a stale live-progress line (an error/409 line is left in place).
    const msg = (claimRetryMsgs[turn.askedAt] || {})[claim.index];
    if (msg && !msg.error) setClaimRetryMsg(turn, claim.index, "");
    // Tool chips grew during the run; persist them even on a failed retry.
    persistAskSession();
    return ok;
  } finally {
    if (claimRetryRun === run) claimRetryRun = null;
    paintAllClaimRetryRows(turn);
    refreshClaimRetryBar(turn);
  }
}

/** True while the ↻ bar this batch is driving is still in the document. Navigating
 *  away does NOT clear `askShownTurn` (see `currentViewState`), so without a DOM
 *  liveness test a batch kept launching claims — up to ~24 minutes of model spend —
 *  with the Cancel button long since destroyed. */
function claimRetryPaneAlive(): boolean {
  const bar = document.getElementById("wikiClaimRetryBar");
  const body = document.getElementById("askAnswerBody");
  return !!(bar?.isConnected && body?.isConnected);
}

/** Retry every unverified claim on the shown turn, SEQUENTIALLY (concurrency 1):
 *  the route is per-page single-flight, and parallel runs would interleave tool
 *  chips and status text into noise. */
async function retryAllClaims(turn: AskTurn): Promise<void> {
  // Every refusal a click can reach says so on the bar — the button is rendered
  // disabled in each of these states, but a delegated handler must not depend on
  // that and go quiet.
  if (claimRetryRun) {
    setClaimRetryBarMsg(turn, "A re-check is already running on this page.");
    return;
  }
  if (turn.wrote) {
    setClaimRetryBarMsg(turn, CLAIM_RETRY_WROTE_COPY);
    return;
  }
  if (!turn.page) {
    setClaimRetryBarMsg(turn, "This turn has no page to re-check against.");
    return;
  }
  const queue = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes);
  if (queue.length < 2) {
    setClaimRetryBarMsg(turn, "Nothing left to re-check in a batch.");
    return;
  }
  const run: ClaimRetryRun = {
    turn,
    index: queue[0]!.index,
    batch: true,
    cancelled: false,
    total: queue.length,
    done: 0,
    cancel: () => {},
  };
  claimRetryRun = run;
  setClaimRetryBarMsg(turn, ""); // a prior batch's terminal line must not linger
  refreshClaimRetryBar(turn);
  // WHY the loop ended, so the terminal line can say so. A batch stopped by a turn
  // switch / a navigation / a mid-run write is NOT a completed batch, and reporting
  // "Re-checked 1 of 4" for one told the reader the other three were unfixable.
  let stopped: ClaimRetryStopReason | null = null;
  for (const claim of queue) {
    if (run.cancelled) break;
    // The reader switched turns — stop rather than rewriting an off-screen answer.
    if (turn !== askShownTurn) { stopped = "switched"; break; }
    // …or navigated away entirely, which leaves `askShownTurn` set but destroys
    // the pane (and with it Cancel).
    if (!claimRetryPaneAlive()) { stopped = "navigated"; break; }
    // A ➕/✎ that landed between claims commits the answer as it stands; keep
    // going would splice into a turn the page has already been written from.
    if (turn.wrote) { stopped = "wrote"; break; }
    run.index = claim.index;
    refreshClaimRetryBar(turn);
    // Each claim owns the run record for the duration of its own stream.
    claimRetryRun = run;
    const wrote = await driveClaimRetry(turn, claim, run, claimRetryUrlFor(turn, claim, WIKI));
    // Count SUCCESSES, not attempts — a 409, a failure or a cancel is not "done" —
    // and increment BEFORE the repaint so the running label isn't one behind.
    if (wrote) run.done++;
    claimRetryRun = run;
    refreshClaimRetryBar(turn);
  }
  if (claimRetryRun === run) claimRetryRun = null;
  // The terminal state has to outlive the run record, or it paints for one frame
  // and is replaced by an idle bar (which, after a cancel, offers a button whose
  // click can only 409).
  setClaimRetryBarMsg(
    turn,
    run.cancelled
      ? CLAIM_RETRY_CANCEL_COPY
      : stopped
        ? claimRetryStoppedCopy(stopped, run.done, run.total)
        : claimRetryDoneCopy(run.done, run.total),
  );
  paintAllClaimRetryRows(turn);
}

/** Cancel the batch — CLIENT-SIDE ONLY. Stops the next launch and detaches this
 *  client; the claim already running finishes server-side holding the page's slot. */
function cancelClaimRetryBatch(): void {
  if (!claimRetryRun || !claimRetryRun.batch) return;
  claimRetryRun.cancelled = true;
  claimRetryRun.cancel();
  refreshClaimRetryBar(claimRetryRun.turn);
}

/** Abort whatever retry is in flight and forget the run — the session it was going
 *  to splice into is about to stop existing. Without this a landing `claim_result`
 *  spliced into an emptied session and re-persisted a `[]`-plus-ghost. */
function abortClaimRetryRun(): void {
  const run = claimRetryRun;
  if (!run) return;
  run.cancelled = true;
  run.cancel();
  claimRetryRun = null;
}

/** Click entry point for one row's ↻. */
function submitClaimRetry(index: number): void {
  const turn = askShownTurn;
  if (!turn || turn.kind !== "factcheck") return;
  const claim = retryableClaims(turn.answer, turn.claimOutcomeByIndex, turn.claimQuotes).find(
    (c) => c.index === index,
  );
  if (!claim) return;
  void retryOneClaim(turn, claim, false);
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
    askClaimRetryBarHtml(turn) +
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
  currentRelPath = null;
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
    enhanceCodeTabs(askBody); enhanceCodeBlocks(askBody);
    // The ↻ rows are re-applied at EVERY paint site (never injected once): this is
    // the turn-switch / history-click repaint.
    applyRetryAffordances(askBody, turn);
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
        // keeping the FIRST full URL seen per host for the chip href. Shared with
        // the ↻ retry's own handler set so the two can't drift on the chip contract.
        if (recordToolSource(turn, d)) refreshAskToolSources(turn);
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
      if (b && !turn.html) { b.innerHTML = renderStreamingBody(turn.answer); enhanceMermaid(b); enhanceCodeTabs(b); enhanceCodeBlocks(b); } // chip baked into renderStreamingBody
      refreshAskSources(turn);
      let statusText: string;
      // NB the ↻ rows are applied further down, AFTER `claimOutcomeByIndex` is
      // written — they are derived from it, so a pass here would find nothing.
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
        // …and keep the PER-CLAIM outcomes too, for the same reason and one more:
        // the tally counts, but only this map says WHICH claim timed out, which is
        // what decides where a ↻ retry affordance goes. Same last chance to read it
        // — the checklist is dropped a few lines below.
        turn.claimOutcomeByIndex = claimOutcomeMapFromRows(turn.claims);
        const n = typeof d.claimCount === "number" ? d.claimCount : 0;
        turn.claimCount = n; // drives the meta line's "N claims · M sites consulted"
        refreshAskSources(turn); // repaint the meta line now that claimCount is set
        statusText = n > 0
          ? "Checked " + n + " claim" + (n === 1 ? "" : "s") + " against the web"
          : "Fact check complete";
      } else {
        // The decline lands on the TURN, not just on this status string: the
        // escalate bar is re-derived from turn state on every switch/rehydrate,
        // and `done` fires exactly once. `askDeclineReason` owns the
        // lowConfidence-before-noHits order both branches below depend on.
        turn.declined = askDeclineReason(d);
        statusText = askStatusText(turn.declined, turn.citations.length);
      }
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
      // The `done` paint above ran before the outcome map existed; apply the ↻ rows
      // now that both the answer and the map are on the turn.
      applyRetryAffordances(document.getElementById("askAnswerBody"), turn);
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
      if (b && turn.html) { b.innerHTML = enhanceConfidenceHtml(turn.html); enhanceMermaid(b); enhanceCodeTabs(b); enhanceCodeBlocks(b); applyRetryAffordances(b, turn); }
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
 *  in-pane follow-up bar). `originQuestion` is set only by the follow-up bar —
 *  see `submitFollowup`. */
function askPlainQuestion(q: string, originQuestion?: string): void {
  const turn: AskTurn = {
    question: q, answer: "", citations: [], cited: [], html: null, askedAt: Date.now(),
    originQuestion: originQuestion || undefined,
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
 *  `done` handler, carrying the prior turns as `history`.
 *
 *  The originating question is stamped onto the turn because `history` is a
 *  STREAM param: nothing else survives to the point where a declined follow-up
 *  escalates into chat, and "and what about the second one?" is unanswerable on
 *  its own. Chains keep the ROOT (the parent's own origin wins over the parent's
 *  question), and an Explain-rooted chain stores the composed page+passage form
 *  rather than the bare `Explain: "…"` label. */
function submitFollowup(): void {
  const input = document.getElementById("wikiFollowupInput") as HTMLInputElement | null;
  if (!input || input.disabled) return;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  const parent = askShownTurn;
  const origin = parent
    ? parent.originQuestion ||
      composeDeclineQuestion({ question: parent.question, explainPage: parent.explainPage })
    : undefined;
  askPlainQuestion(q, origin);
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

/** Every field either escalation path reads off `POST /api/wiki/ask/chat`. */
interface AskChatResponse {
  chatUrl?: string;
  error?: string;
  threadId?: string;
  threadExists?: boolean;
  /** Article mode: the derived name collided with a thread that is NOT this
   *  article's (its description carries no matching article tag). Distinct from
   *  `threadExists` precisely because "Send there →" must not be offered. */
  nameTaken?: boolean;
  alreadyQueued?: boolean;
  existingThreadId?: string;
  /** Reuse path only: whether a posted `connectorId` was actually applied. An
   *  established thread keeps its own model, and the pick is dropped. */
  connectorApplied?: boolean;
}

/** The one POST both escalation entry points make. Shared so the body encoding
 *  and the response shape have a single spelling; the 409 handling and all
 *  presentation stay with each caller, which is where they genuinely differ.
 *
 *  NB `connectorId` is passed through VERBATIM, including `""`: its mere presence
 *  is what tells the route this request expressed a connector decision (and so
 *  earns the chatUrl's `&src=wiki` stamp-suppression flag). The one-click path
 *  omits the key entirely — it offers no choice, and must keep the chat sidebar's
 *  ordinary stamping. */
async function postAskChat(
  payload: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; data: AskChatResponse }> {
  const res = await fetch("/api/wiki/ask/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as AskChatResponse;
  return { status: res.status, ok: res.ok, data };
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
    // No `connectorId` key at all: this path decides nothing about the model, so
    // the thread it opens keeps the chat sidebar's ordinary connector stamping.
    const { status, ok, data } = await postAskChat({
      wiki: WIKI || undefined,
      question: turn.question,
      answer: turn.answer.slice(0, CHAT_ESC_ANSWER_MAX),
      citations: turn.citations.map((ci) => ({ title: ci.title, pageName: ci.pageName })),
      forceNew: forceNew || undefined,
    });
    if (status === 409 && !forceNew) {
      if (win) win.close();
      // The link comes from the route (which builds it with the same helper its
      // 200s use), never re-derived here.
      turn.chatEsc = { status: "exists", chatUrl: data.chatUrl };
      return;
    }
    if (!ok || !data.chatUrl) throw new Error(data.error || "HTTP " + status);
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

/**
 * 📤 Share on the open article.
 *
 * Sends `relPath` BESIDE the name: the route prefers the path and falls back to
 * the stem, because `index.resolve(name)` is first-registration-wins — sharing
 * one of two same-stem pages generated a post from the OTHER one under this
 * page's title. (This comment used to assert the opposite; see `resolvePageRef`.)
 *
 * `SHARE_BTN_ID` is declared as the opener so the click that opens the dialog is
 * not also read as a click-away by its own document listener.
 */
function openArticleShare(): void {
  // A read-only wiki never opens the dialog. The capture-phase guard already
  // cancels the click on `#wikiShareBtn`, but this opener is also reachable from
  // code paths that never dispatch one, and the dialog's own Generate would spend
  // the one-shot the route then 403s.
  if (wikiReadonlyWikiFlag()) return;
  const m = currentArticle;
  if (!m) return;
  openShareDialog({
    wiki: WIKI || "",
    page: m.name,
    relPath: m.relPath,
    title: displayTitleOf(m),
    openerIds: [SHARE_BTN_ID],
  });
}

/**
 * Re-open the page a fact-check turn was checked on, after a write to it.
 *
 * By relPath when the turn carries one — a name reload after a write lands on
 * whichever same-stem page registered first, i.e. shows the reader an UNCHANGED
 * page and makes a successful write look like it did nothing. Falls back to the
 * name for a turn persisted before `pageRelPath` existed.
 *
 * `push=false` in both spellings: the reader is already on this page, and a write
 * must not add a history entry.
 */
function reloadCheckedPage(turn: AskTurn): void {
  if (turn.pageRelPath) loadPageByRelPath(turn.pageRelPath, false);
  else if (turn.page) loadPage(turn.page, false);
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
        // The collision-proof half of the target. Without it the callout was
        // written into whichever same-stem page registered first — measured on
        // mimir, a check on `projects/yggdrasil/architecture.md` landed in
        // `projects/claude-hivemind/architecture.md`.
        ...(turn.pageRelPath ? { relPath: turn.pageRelPath } : {}),
        answer: turn.answer,
        baseHash: turn.baseHash,
      }),
    });
    const data = await res.json().catch(
      () =>
        ({}) as {
          written?: boolean;
          error?: string;
          stale?: boolean;
          /** Set when the write removed `<Fact>` marks left by an earlier check —
           *  the only notice the reader gets that the page lost its underlines. */
          supersededNote?: string;
        },
    );
    if (res.status === 409 || data.stale) {
      btn.disabled = false;
      btn.textContent = prevLabel;
      showErr(INTEGRATE_STALE_COPY);
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
    // It carries the route's `supersededNote` when there is one: the reload that
    // follows shows a page whose marks are simply gone, and a fixed "✓ Added to
    // article" leaves that looking like a rendering fault rather than this click.
    setAskStatus(appendSuccessStatus(data.supersededNote), "done");
    // Reload the page content so the freshly-written callout is visible — by
    // relPath where the turn has one, so the reader lands on the page that was
    // just WRITTEN rather than on the stem's first registration.
    reloadCheckedPage(turn);
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
  return {
    turn,
    proposal,
    selected,
    callout,
    applying: false,
    // A run whose drops OUTNUMBER its edits gets its reason list opened: the
    // headline "1 proposed edit" is exactly the case where the reasons are the
    // information (`shouldOpenDroppedList`).
    droppedOpen: shouldOpenDroppedList(proposal),
    focusEditIdx: -1,
  };
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
  // The proposal's ranges are resolved against THIS answer. A ↻ retry splicing a
  // fresh verdict block mid-propose (the propose takes ~90s; a retry takes ~180s,
  // so the overlap is routine) would leave every offset describing a body that no
  // longer exists — and Apply posts the answer too, so it would ship pre-splice
  // edits beside a post-splice answer.
  const proposedAgainst = turn.answer;
  try {
    const res = await fetch("/api/wiki/factcheck/integrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wiki: WIKI || undefined,
        page: turn.page,
        ...(turn.pageRelPath ? { relPath: turn.pageRelPath } : {}),
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
    if (turn.answer !== proposedAgainst) {
      setIntegrateBarMsg(turn, "The answer changed — propose the edits again.", true);
      return;
    }
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
    ...(turn.pageRelPath ? { relPath: turn.pageRelPath } : {}),
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
    // What the write actually PERSISTED, not what the page's extension allows. The
    // route sets `calloutAdded` on the one branch that splices a fact-check block,
    // and the ➕ bar's copy + tone are derived from this on every later render
    // (a reload included — the whole turn is serialized).
    turn.wroteBlock = data.calloutAdded === true;
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
    // Reload the page in the reader so the corrected prose is visible — by
    // relPath where the turn has one (see `reloadCheckedPage`).
    reloadCheckedPage(turn);
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
  // Disown any in-flight ↻ first: its `claim_result` would otherwise land on a turn
  // that is no longer in `askTurns`, splice it, and `persistAskSession` an empty
  // array while the orphan turn kept a live run record pointing at it.
  abortClaimRetryRun();
  for (const t of askTurns) clearClaimRetryMsgs(t as AskTurn);
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
  // 📤 Share — the dialog is IMPORTED here rather than loaded as the standalone
  // bundle: this file IS a bundle, and doing both would put two copies of the
  // module (two states, two listener sets) on the same page.
  else if (t.closest("#" + SHARE_BTN_ID)) openArticleShare();
  // ⧉ Copy path — delegated like its neighbours because the breadcrumb's
  // innerHTML is rewritten on every navigation, which would drop a direct
  // listener on the second page the reader opens.
  else if (t.closest("#" + COPY_PATH_BTN_ID))
    copyArticlePath(t.closest("#" + COPY_PATH_BTN_ID) as HTMLButtonElement);
  else if (t.closest("#wikiFactcheckAppendBtn")) submitFactcheckAppend();
  // ↻ claim retry — the row buttons are injected into the answer body by a DOM
  // pass, so they are delegated by ATTRIBUTE rather than by id.
  else if (t.closest("[data-claim-retry-btn]")) {
    const btn = t.closest("[data-claim-retry-btn]") as HTMLButtonElement;
    if (!btn.disabled) submitClaimRetry(Number(btn.getAttribute("data-claim-retry-btn")));
  } else if (t.closest("#wikiClaimRetryAll")) {
    if (askShownTurn) void retryAllClaims(askShownTurn);
  }
  else if (t.closest("#wikiClaimRetryCancel")) cancelClaimRetryBatch();
  else if (t.closest("#wikiFactcheckIntegrateBtn")) submitFactcheckIntegrate();
  else if (t.closest("#wikiFcIntAccept")) acceptFactcheckIntegrate();
  else if (t.closest("#wikiFcIntCancel")) cancelFactcheckIntegrate();
});

// The chat-options dialog wires its OWN click/change/input/keydown delegates —
// HERE, deliberately, the slot its `change` listener used to occupy, i.e. AFTER
// the click delegate above. The dialog's click-away test reads
// `document.contains(target)`, and a branch above that synchronously detaches its
// own target (`cancelFactcheckIntegrate`) must still run BEFORE that test, exactly
// as it did when every branch lived in one listener.
//
// Note that ALL the click delegates run for every click — the one above, the
// dialog's own (registered inside this call) and the `document.body` navigation
// delegate (`NAV_LINK_SELECTOR` — `[data-wiki-page]`/`[data-page]`/`[data-relpath]`,
// registered first) — so their
// selector sets must stay disjoint. The shell's sets are the `if / else if`
// chain above and the body delegate; the dialog's is the chain in
// `wireChatOptions` (`wiki-chat-options.ts`). One chain made that exclusivity
// structural; three make it a convention nothing enforces.
initChatOptions({
  getShownTurn: () => askShownTurn,
  getAskTurns: () => askTurns,
  getCurrentArticle: () => currentArticle,
  getOutgoingTitles: () => currentOutgoingTitles,
  postAskChat,
  refreshChatEscalateBar,
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
  // `currentArticle` — the listing the OPEN page was rendered from — never an
  // `allPages` lookup by name: that lookup is first-match-on-stem, so on a wiki
  // with same-stem pages it answered about a DIFFERENT page (wrong type, wrong
  // title, wrong everything the caller then acted on).
  const meta = currentArticle;
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
  const explainMeta = currentArticle;
  const turn: AskTurn = {
    question: explainLabel(pillSel),
    // The page the passage was read on. The question is only a display LABEL, so
    // without this an escalated Explain turn names neither the page nor the real
    // question (`composeDeclineQuestion`). Title where there is one — it is what
    // wikilinks and the bot's own notes search use.
    explainPage: explainMeta?.title || currentName,
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(),
  };
  const url = buildExplainUrl({
    sel: pillSel,
    page: currentName,
    // relPath beside the name — the route resolves it first. Without it, Explain
    // read the passage's context out of whichever same-stem page registered first.
    ...(currentRelPath ? { relPath: currentRelPath } : {}),
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
  const selMeta = currentArticle;
  const turn: AskTurn = {
    question: factcheckLabel(pillSel),
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(), kind: "factcheck",
    page: currentName, pageType: selMeta ? selMeta.type : undefined,
    // Persisted so a later ↻ can re-issue the SAME scoped call: the retry route
    // re-locates the excerpt from `sel`, and retrying a sel-mode claim in article
    // mode would verify it against a passage nobody selected.
    fcMode: "sel", fcSel: pillSel, fcCtx: pillHeading || undefined,
    // The exact page this check ran on, stamped at START — every write/retry the
    // turn can launch later resolves against it.
    ...(currentRelPath ? { pageRelPath: currentRelPath } : {}),
  };
  const url = buildFactcheckUrl({
    mode: "sel",
    page: currentName,
    ...(currentRelPath ? { relPath: currentRelPath } : {}),
    wiki: WIKI,
    sel: pillSel,
    ctx: pillHeading,
  });
  runAskStream(url, turn);
}

/** Fact-check the whole current page (`article` mode) — the always-visible
 *  breadcrumb button. Works on markdown pages AND explainers (server reduces the
 *  explainer HTML to prose). No selection needed. */
function activateFactcheckArticle(): void {
  hideExplainPill();
  if (!currentName) return;
  const meta = currentArticle;
  const turn: AskTurn = {
    question: factcheckLabel("", meta ? displayTitleOf(meta) : currentName),
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(), kind: "factcheck",
    page: currentName, pageType: meta ? meta.type : undefined,
    fcMode: "article", // the ↻ retry re-issues the same mode (see activateFactcheckSel)
    ...(currentRelPath ? { pageRelPath: currentRelPath } : {}),
  };
  const url = buildFactcheckUrl({
    mode: "article",
    page: currentName,
    ...(currentRelPath ? { relPath: currentRelPath } : {}),
    wiki: WIKI,
  });
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
  const meta = currentArticle;
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
  // Same degrade rule: an older server / a payload without the field keeps the
  // last known map rather than blanking readable labels mid-session.
  if (data.folderLabels && typeof data.folderLabels === "object") {
    folderLabels = data.folderLabels;
  }
  // Same degrade rule again: an older server / an absent field keeps the last
  // known value rather than re-admitting the leftovers bucket mid-session.
  if (typeof data.defaultType === "string") {
    defaultType = data.defaultType;
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
  // A shared/reloaded relPath URL re-resolves collision-proof; check it first
  // (`?page=` remains for links written before relPath URLs were pushed).
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
// Two independent flags, one installer (`wikiBlockedSelectorFor`):
//   - a wiki-readonly INSTANCE dims + blocks the write actions (➕ / ✎ / Apply /
//     Draft synthesis);
//   - a read-only WIKI (`WIKI_READONLY_ROOTS`) adds the egress family — Share,
//     both fact-check buttons, Explain, Discuss, Ask / New chat / follow-up /
//     Remember, the escalate bar and the claim-retry ↻ — and disables the two
//     question inputs.
// Either way the refusal is visible before the click rather than after a 403.
// No-op when neither flag is set (no listeners installed at all).
installWikiReadonlyGuard();
// Rehydrate any persisted Ask session into the "This session" list (does not
// auto-show an answer). Safe at module load — the history element is static.
rehydrateAskSession();
requestPages({ refresh: false, boot: true });
