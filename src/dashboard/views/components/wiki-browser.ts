/// <reference lib="dom" />
/**
 * The /wiki reader page's shell. Bundled by Bun.build() through the two-line
 * entry `wiki-shell-client.ts` (see wiki-client.ts), which calls {@link boot},
 * and injected as an IIFE into the wiki page's inline `<script>`. Importing this
 * module runs nothing: every listener, timer and boot fetch lives in `boot()`. A mechanical port of the former hand-written inline IIFE — same
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

import { movedWithSectionHtml, type MovedWithListing } from "./wiki-moved-with.ts";
import { staleHomeBodyHtml, staleHomeLineHtml } from "./wiki-stale-summary.ts";
import { escHtml as esc } from "./escape.ts";
import {
  installWikiReadonlyGuard,
  seriesEditable,
  wikiReadonlyWikiFlag,
} from "./wiki-readonly-client.ts";
// The series editor's pure half — the menu model, the head-move plan and the
// markup. Only the DOM (the popover, the writes, the repaint) lives here.
import {
  buildSeriesMenu,
  canEditSeriesPage,
  headMoveWrites,
  seriesEditBtnHtml,
  seriesMenuHtml,
  SERIES_EDIT_ATTR,
  SERIES_MENU_ATTR,
  SERIES_MENU_ID,
  type SeriesMenuModel,
  type SeriesWrite,
} from "./wiki-series-menu.ts";
import {
  buildExplainUrl,
  explainLabel,
  buildFactcheckUrl,
  factcheckLabel,
} from "./wiki-explain.ts";
import { discussArticleBtnHtml } from "./wiki-chat-target.ts";
// The chat-options / Discuss dialog (the DOM half — the pure half stays in
// `wiki-chat-target.ts` above): IMPORTED for the same reason as the share dialog
// below, and like it the module OWNS its document listeners, so the delegates in
// this file carry no chat-options branch at all. `initChatOptions` both wires the
// port and registers those listeners; where it is called from is load-bearing —
// see that file's header.
import { closeChatOptionsIfNavigatingAway, initChatOptions } from "./wiki-chat-options.ts";
// The share dialog: IMPORTED, never the standalone bundle. This file is itself
// bundled (as `wiki-shell-client.ts`'s import), so loading both would give the page two copies of the
// module — two states, two document listener sets, one split dialog.
import { openShareDialog, closeShareDialogOnNavigate } from "./share-dialog.ts";
import { closeWalkthroughOnNavigate, enhanceWalkthroughButtons } from "./wiki-walkthrough.ts";
import { shareArticleBtnHtml, SHARE_BTN_ID } from "./wiki-share-dialog.ts";
import {
  fellesBtnHtml,
  FELLES_BTN_ID,
  initFellesSync,
  openFellesPublishDialog,
  setFellesBtnMark,
  type FellesSync,
} from "./wiki-felles-publish.ts";
import { installMirrorStatus } from "./wiki-mirror-status.ts";
// The `Related work` block: pure string building, moved out so `bun test` can
// load it without a DOM.
import {
  RELATED_HOP_ATTR,
  RELATED_HOP_BODY_ATTR,
  RELATED_ORDER_ATTR,
  relatedHopHtml,
  relatedSectionHtml,
  type RelatedHopResponse,
  type RelatedListing,
  type RelatedViewOptions,
} from "./wiki-related-view.ts";
import { seriesLabelFor, seriesLabels } from "./wiki-find.ts";
import { RELATED_HOP_LIMIT_DEFAULT } from "../../../wiki/related-constants.ts";
// The start-view cards (What's new · Index coverage · reindex poller): IMPORTED
// for the same reason as the share dialog above — one bundle, one module state.
import {
  handleWorkCardClick,
  initStartCards,
  loadDigest,
  loadIndexCoverage,
  mountStartCards,
  refreshWorkCardFromListing,
  startReindex,
} from "./wiki-start-cards.ts";
// The effort page (work map P3): pure HTML, rendered by the effort controller; its clicks go through the body click delegate below.
import { EFFORT_PARAM } from "./wiki-effort-page.ts";
import { readActiveWikiName, readActiveWikiRoot, readFindRowsWiki, readFindSelfWiki, withWikiParam } from "./wiki-param.ts";
import {
  DEFAULT_START_TAB,
  START_VIEW_PARAM,
  lastWikiRedirect,
  rememberWikiName,
  resolveStartTab,
  sameStartUrl,
  startUrl,
  type StartTab,
} from "./wiki-home.ts";
import { readLastWiki, readStartTab, writeLastWiki, writeStartTab } from "./wiki-home-store.ts";
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
import { relationWord } from "./wiki-issue-pills.ts";
import { initRailResize } from "./wiki-rail-resize.ts";
import { initPaneToggles, revealRightPane } from "./wiki-pane-toggle.ts";
import {
  parseRelatedOrder,
  type RelatedOrder,
} from "./wiki-recents.ts";
import {
  clipSeriesTitle,
  seriesContinuePlan,
  seriesKeyOf,
  seriesMembersOf,
  seriesStripOrder,
  workedShownDay,
} from "./wiki-groups.ts";
import { readSeriesBasesAfterWrites, seriesBaseReader, seriesConflictCopy, seriesPoster, trackSeriesWrite, withinSeriesBound, writeSeriesUnlessOpenChanged, type OpenPageAtLoad, type SeriesPoster } from "./wiki-series-write.ts";
import {
  DEFAULT_ACTIVITY_WEIGHTS,
  parseActivityWeights,
  workedGateFor,
  type ActivityWeights,
  type WorkedGate,
} from "./wiki-activity-rank.ts";
import {
  purgeRecentsKeys,
  readRelatedOrder,
  readSort,
  writeRelatedOrder,
} from "./wiki-recents-store.ts";
import {
  WORK_POP_ID,
} from "./wiki-thread-view.ts";
import { atlasBodyHtml, atlasCullOf, initAtlas, type AtlasDeps } from "./wiki-atlas.ts";
import { readSliceStartTab, wikiToolsFlag } from "./wiki-read-slice.ts";
import { enhanceCodeTabs } from "./code-tabs.ts";
import { enhanceCodeBlocks } from "./code-block-chrome.ts";
import { enhanceEmbeds } from "./wiki-embed.ts";
import { bindLaneProgress, enhanceReportBlocks } from "./wiki-report-blocks.ts";
import { enhanceQueryTables } from "./wiki-query-table.ts";
import { enhanceQueryExplorer } from "./wiki-query-explorer.ts";
import { enhanceRefLinks, hideRefPeek } from "./wiki-ref-links.ts";
import { closeFind, initFindPalette, isFindOpen, refreshFind } from "./wiki-find-palette.ts";
import { revealHashTarget } from "./wiki-hash-target.ts";
import {
  enhanceLens,
  lensKeyToggles,
  lensOf,
  readerSelectionText,
  refreshLensSwitch,
  removeLensChip,
  storedLens,
  toggleLens,
} from "./wiki-lens.ts";
import { abortAgentRuns, snapshotAgentPane, type AgentPaneSnapshot } from "./wiki-agent-pane.ts";
import { enhanceNewSince } from "./wiki-new-since.ts";
import { resolveLens, type Lens } from "../../../format/reader-lens.ts";
import type { ReaderPayload } from "../../../wiki/render.ts";
import { EXPLAINER_SANDBOX } from "../../../wiki/explainer-sandbox.ts";
import { enhanceFactCheck } from "./wiki-factcheck-reader.ts";
import { enhanceAnswerCards, type PageAnswersInfo } from "./wiki-answer-cards.ts";
import { mountAnswerExport, unmountAnswerExport } from "./wiki-answer-export.ts";
import { DEFAULT_QUESTION_LANGUAGE, parseQuestionLanguage } from "../../../format/question-labels.ts";
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
  type ReceiveOutcome,
  type WikiPagesResponse,
} from "./wiki-refresh.ts";
import {
  findPageByName,
  findPageByRelPath,
  navTargetFrom,
  normalizeRel,
  NAV_LINK_SELECTOR,
  type NavTarget,
} from "./wiki-nav.ts";
import {
  anchorNow,
  articleUrl,
  connectionTypeOrder,
  breadcrumbLeaf,
  displayTitleOf,
  shortGraphLabel,
  filterPages,
  folderLabelOf,
  hasTypedHubs,
  hubTypeList,
  resolveSortMode,
  touchedLine,
  pageDateLabel,
  pageHeaderDates,
  pageFolder,
  jiraFilterAfterListing,
  JIRA_PARAM,
  jiraParamNeedsRewrite,
  projectFilterAfterListing,
  projectHubPage,
  PROJECT_PARAM,
  projectParamNeedsRewrite,
  ROOT_FOLDER,
  sanitizeColorToken,
  searchWithJira,
  searchWithProject,
  pageTimeMs,
  topPages,
  typeCounts,
  TYPE_LABEL,
  TYPE_ORDER,
  urlWithJira,
  urlWithProject,
  facetJiraKeys,
  readDisplayParams,
  searchWithDisplay,
  type DisplayState,
  type ListingTracker,
  type WikiFilters,
  type WikiListing,
  type WikiSortMode,
} from "./wiki-filter.ts";
import { JIRA_TRACKER_ID } from "../../../wiki/trackers/jira-id.ts";
// Graph mode: the lanes markup, the side card and the `g` rule are pure and
// live in that module; this file owns the state, the fetch and the DOM.
import {
  drawGraphEdges,
  GRAPH_CARD_CLOSE_ATTR,
  GRAPH_CARD_ID,
  GRAPH_DEPTH_ID,
  GRAPH_FOCUS_ATTR,
  GRAPH_LEVEL_ID,
  GRAPH_NODE_ATTR,
  GRAPH_ON_CLASS,
  GRAPH_OPEN_ATTR,
  GRAPH_SECTION_ID,
  GRAPH_TOGGLE_ID,
  graphCardHtml,
  graphErrorHtml,
  graphHtml,
  graphAdjacency,
  graphKeyToggles,
  graphLit,
  graphLoadingHtml,
  graphToggleHtml,
  type GraphAdjacency,
} from "./wiki-graph-view.ts";
import { modalOpen, navMenuOpen, readerKeyEventOf } from "./wiki-panes.ts";
import { graphDefaults, parseIssueRoot, type GraphLevel, type GraphPayload } from "../../../wiki/graph-types.ts";
// The provenance strip: one collapsed line under the title that opens into the
// chain. Every string and every fragment of markup lives in that module (pure,
// `bun test`-covered); this file only decides WHERE it goes and wires the three
// controls it carries — the Jira key, the disclosure and the ⧉ copy button.
import {
  provPendingHtml,
  provStripHtml,
  provUnavailableHtml,
  SESSION_COPY_FAIL,
  SESSION_COPY_IDLE,
  SESSION_COPY_OK,
  sessionCopyAriaLabel,
  STAMP_CONFIRM_LABEL,
  STAMP_LABEL,
} from "./wiki-provenance-view.ts";
import {
  connItemHtml,
  CULL_GO_ATTR,
  cullBannerHtml,
  cullLabels,
  cullMarkHtml,
  miniNodeHtml,
  railPool,
  RETIRED_REVEAL_ATTR,
  retiredRevealHtml,
  setCullLabels,
} from "./wiki-cull-view.ts";
import { provenanceStripCertain, type ProvenancePayload } from "../../../wiki/provenance.ts";
import { compactIssues, relationsCount, type IssueRow } from "../../../wiki/trackers/types.ts";
import {
  CONN_ISSUES_ID,
  DRAFT_PLAN_ATTR,
  ISSUE_LINK_ALL_ATTR,
  ISSUE_LINK_ATTR,
  issueSectionHtml,
  linkAllKeys,
  type IssueRowState,
} from "./wiki-issue-rows.ts";
import { initWikiVisuals } from "./wiki-visuals.ts";
// The left pane: imported, like the start cards, for one bundle and one module state.
import {
  applyJiraFilter,
  applyProjectFilter,
  initRail,
  loadCoverageFooter,
  railPages,
  registerRail,
  registerRailMenuKeys,
  registerRailOptions,
  railControlSelector,
  getSortTouched,
  renderJiraChips,
  renderList,
  renderPageFacets,
  repaintForJira,
  repaintForProject,
  setShowRetired,
  showOpenPageInList,
  showRetired,
  type RailDeps,
} from "./wiki-rail-controller.ts";
import { followupFlagHtml, statusPillHtml } from "./wiki-status-pills.ts";
import {
  getStaleSummary,
  initStale,
  loadStale,
  loadStaleSummary,
  paintStaleSurfaces,
  postStaleFix,
  postStaleVerdict,
  railStaleBadge,
  registerStale,
  resetStaleRailPainted,
  runStaleCheckClient,
  staleFollowShownPage,
  staleForFailedPage,
  staleTabAvailable,
  type StaleDeps,
} from "./wiki-stale-controller.ts";
import {
  adoptWorkMap,
  effortFromUrl,
  effortHrefFor,
  getEffortOpen,
  getRailMapFailedAt,
  getWorkMap,
  getWorkMapCache,
  initEffort,
  openEffort,
  railEffortsIndex,
  refreshEffortFromListing,
  renderEffort,
  workMapFetchFor,
  type EffortDeps,
} from "./wiki-effort-controller.ts";
import {
  boundaryItemClick,
  focusPopOpener,
  initMenus,
  openThreadRowMenu,
  openWorkCardMenu,
  popCloseReturnsFocus,
  registerMenus,
  rowMenuItemHtml,
  showWorkBoundaryStatus,
  workPopBusy,
  type MenusDeps,
  type PopCloseCause,
} from "./wiki-menus-controller.ts";
import {
  acceptFactcheckIntegrate,
  askHistoryParam,
  askQuestion,
  cancelClaimRetryBatch,
  cancelFactcheckIntegrate,
  clearAskSession,
  getAskShownTurn,
  getAskTurns,
  initAsk,
  postAskChat,
  refreshChatEscalateBar,
  registerIntegratePreviewInputs,
  rehydrateAskSession,
  retryAllClaims,
  runAskStream,
  showAskAnswer,
  submitChatEscalate,
  submitClaimRetry,
  submitFactcheckAppend,
  submitFactcheckIntegrate,
  submitFollowup,
  submitRemember,
  type AskTurn,
  type AskTurnPort,
} from "./wiki-ask-controller.ts";
import { getCurrentName, getWorkMapRunAt, setCurrentName, setRevealOnRender, setWorkMapRunAt, type WorkFacts } from "./wiki-shell-state.ts";

/** The URL parameter that opens a page in a lens (`?lens=overview`). */
const LENS_PARAM = "lens";
/** `?lens=` from the URL the reader was opened with (D2): it applies to the
 *  first article this view renders, and is then removed from the address bar
 *  with `replaceState`, so a reload shows the stored choice. It never changes
 *  the stored choice. */
let pendingUrlLens!: string | null;
/** The lens of the view an in-place reload replaces ({@link reloadPageInPlace}),
 *  keyed by the page's relPath: the reloaded page keeps it, unstored. In the
 *  Agent lens, also the pane's inputs and card, which the new pane shows as
 *  possibly stale instead of starting a plan-card child. */
let inPlaceLens: { relPath: string; lens: Lens; agent?: AgentPaneSnapshot } | null = null;
/** The article this view last rendered, and its page. An Ask or fact-check
 *  answer replaces it on screen, so an in-place reload reads the lens off this
 *  element rather than off `#articleWrap`. */
let renderedArticle: { relPath: string; el: Element } | null = null;

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

/** The wiki's Activity weights (its `.wiki-reader.json` `activity` block merged
 *  over the defaults, server-side), stored at boot from the /api/wiki/pages
 *  response and read by the one `rankActivity` call (`railInputFor`). The
 *  defaults until a payload lands, and after one that carries no such field —
 *  an older server must render the section, not lose it. */
let activityWeights: ActivityWeights = DEFAULT_ACTIVITY_WEIGHTS;

/** Whether Activity may substitute this wiki's worked-on dates — measured once
 *  per payload in `setPagesData` over the FULL listing, so a facet cannot open
 *  or shut it. `null` until a payload lands, which ranks as closed. */
let workedGate: WorkedGate | null = null;

/**
 * The wiki's project → page-count map from `/api/wiki/pages`. `{}` for a wiki
 * declaring no project rule (and until the first payload lands), which is what
 * keeps the Project facet off every wiki that predates the declaration.
 *
 * Kept beside `allPages` rather than derived from it because it is also the
 * MEMBERSHIP set a `?project=` deep link is judged against: derived from the
 * rows, an unknown value and a value whose pages the current scope happens to
 * exclude would be indistinguishable.
 */
let projects: Record<string, number> = {};

/**
 * The wiki's Jira key → page-count map from `/api/wiki/pages` — the `projects`
 * twin, and the same two jobs: the Jira chip row's whole-wiki gate, and the
 * MEMBERSHIP set a `?jira=` deep link is judged against. `{}` until a payload
 * lands, on a wiki nothing has stamped, and on an older server — all three of
 * which mean "no Jira facet".
 */
let jiraKeys: Record<string, number> = {};
/** Tracker id → what the UI calls it, for a wiki whose `.wiki-reader.json`
 *  configures one; `{}` on every other wiki, which is what keeps their Jira row
 *  uncapped and unlabelled. */
let trackerLabels: Record<string, string> = {};
/** The publish script's path when this wiki offers ⇪ Felles, else null. From
 *  the listing payload; absent means "no control", never "the last wiki's". */
let fellesPublishBin: string | null = null;
/** muninn's `FELLES_WIKI_BUCKET`, for the copied command line. */
let fellesPublishBucket: string | undefined;
/** The «Felles: N changed» chip and the status behind ⇪ Felles's marker;
 *  started once, on the first listing that offers ⇪ Felles. */
let fellesSync: FellesSync | null = null;

// ── Data shapes (mirror src/dashboard/routes/wiki-routes.ts) ──────────
interface WikiPageDetail {
  meta: WikiListing;
  html: string;
  outgoing: WikiListing[];
  backlinks: WikiListing[];
  /** The pages one hop from this one, strongest first. ABSENT on an older server;
   *  `[]` on a page with no neighbours — both render no block at all. */
  related?: RelatedListing[];
  /** TRUE when the page carries any provenance key and the block is worth
   *  fetching from `/api/wiki/page/provenance`. ABSENT on a page carrying none
   *  of the frontmatter keys — never `false` — so the client's one gate is "is
   *  this key here at all". The block itself never rides on this payload: the
   *  join reaches claude-usage and huginn, and a page open must not wait on it. */
  provenancePending?: boolean;
  /** Connections' issue rows, index-local half. ABSENT on a page with none and
   *  on every page of a wiki with no tracker. The deferred provenance block
   *  carries the whole row and replaces these when it lands. */
  issueRows?: IssueRow[];
  /** Whether a Link may be offered, before the deferred payload says so. */
  issueStampable?: boolean;
  /** Connections' *Moved with* rows (`stale.ts`). ABSENT on an older server;
   *  `[]` without git — both render no section. */
  movedWith?: MovedWithListing[];
  /** sha256 of the page's RAW bytes, as of this response — the series editor's
   *  CAS base for the page the reader has open, captured when the popover opens
   *  rather than fetched again a millisecond before the POST. Kept in step with
   *  every write this client makes (`POST /api/wiki/series` answers the new
   *  hash), so the editor's own first write cannot leave it stale. */
  hash?: string;
  /** The find palette's closeness map: relPath (the listing's spelling) →
   *  (0, 1), one and two hops over the neighbour rule. ABSENT on an older
   *  server; `{}` for a bookkeeping or hub page. */
  near?: Record<string, number>;
  /** Present only on a wiki in `WIKI_ANSWER_WIKIS`: the answer cards' own
   *  flag (D14). Absent ⇒ every `<Question>` card stays read-only. */
  answers?: PageAnswersInfo;
  /** The lens switch's inputs, the ids' nouns and the Agent flag. ABSENT on an
   *  older server: the reader then shows All with English labels. */
  reader?: ReaderPayload;
  error?: string;
}

/** `GET /api/wiki/page/provenance`'s answer: the block, or `{}` on a page
 *  carrying none of the keys. */
interface WikiPageProvenance {
  provenance?: ProvenancePayload;
  error?: string;
}

// `WikiPagesResponse` is declared in `wiki-refresh.ts` (imported above) — the
// refresh model stores whole payloads, so it needs the shape concretely.

// ── Page state ────────────────────────────────────────────────────────
/** Which wiki is being browsed — resolved once at boot from the injected
 *  canonical name (else the raw query) by the shared rule in `wiki-param.ts`,
 *  which `wiki-start-cards.ts` re-uses for its un-wired default. Empty =
 *  default/env. */
let WIKI!: string;
/** Where this wiki lives ON DISK — injected by the server, `null` when it named
 *  no servable root. Only the breadcrumb's ⧉ Copy path reads it, and like `WIKI`
 *  it is a boot-time fact: switching wiki is a full navigation. */
let WIKI_ROOT!: string | null;
/** This wiki's registry name — the requested one, which the answer, new-since
 *  and Agent consumers send as `wiki`. */
let FIND_SELF_WIKI!: string;
/** The name Everywhere rows carry for this wiki's root (the first registry
 *  entry on it). Only the palette reads it; never send it as `wiki`. */
let FIND_ROWS_WIKI!: string;
/** Append the active `wiki` param to a URL so every /api/wiki/* fetch stays on-wiki. */
function withWiki(url: string): string {
  return withWikiParam(url, WIKI);
}
/** Build a shareable in-page URL that preserves the active wiki AND the active
 *  facet filters (`articleUrl`) — the rail stays narrowed when an article
 *  opens, so a URL without them would describe a different screen. */
function pageUrl(name: string): string {
  return articleUrl(WIKI, "page", name, filters.project, filters.jira, displayState());
}
/** Collision-proof shareable URL keyed by the page's exact relPath — used for
 *  pages opened via the Atlas tab so Back/reload/share re-resolve the SAME page
 *  even on a wiki with same-stem pages in different folders (the `?page=` name
 *  route resolves first-stem-match). Carries both facets for the same reason. */
function pageUrlByRelPath(relPath: string): string {
  return articleUrl(WIKI, "relPath", relPath, filters.project, filters.jira, displayState());
}

// ── Graph mode state ──────────────────────────────────────────────────
/**
 * Graph mode is URL state only (`display=graph`, `issue=`; see `wiki-filter.ts`):
 * read at boot and on popstate, written on every toggle and re-root, carried by
 * every article URL, never stored per wiki. A rail or wikilink click keeps the
 * mode and re-roots on the page it opens (`issue` cleared); Focus here on an
 * issue node roots at the issue.
 */
let graphMode = false;
/** `tracker:KEY` when the graph is rooted at an issue, else `""` (the open page). */
let graphIssue = "";
/** The lanes and depth the reader picked; `null` ⇒ the scope's defaults. Not
 *  URL state: a shared link opens at the defaults. */
let graphLevel: GraphLevel | null = null;
let graphDepth: number | null = null;
/** Sequence guard for the graph fetch — a fast re-root must not paint an older answer. */
let graphSeq = 0;
/** The in-flight graph fetch, aborted when a newer one starts or the graph goes. */
let graphAbort: AbortController | null = null;
/** The graph on screen, for hover and the card, and its adjacency (built once
 *  per drawn graph). */
let graphData: GraphPayload | null = null;
let graphAdj: GraphAdjacency | null = null;
let graphResize: ResizeObserver | null = null;
/** The node whose neighbourhood is lit, and the node whose card is open. */
let graphLitId: string | null = null;
let graphCardId: string | null = null;
/** The article's scroll position when graph mode came on, restored when it goes. */
let readingScrollTop = 0;

/** Does this wiki name a tracker? Graph mode exists only there. */
function hasTracker(): boolean {
  return Object.keys(trackerLabels).length > 0;
}
function displayState(): DisplayState {
  return graphMode && hasTracker() ? { graph: true, issue: graphIssue } : { graph: false, issue: "" };
}
function syncDisplayFromUrl(): void {
  const d = readDisplayParams(location.search);
  graphMode = d.graph;
  graphIssue = d.issue;
}

let allPages: WikiListing[] = [];
/** Has any listing arrived? Before it, the find palette says "Loading". */
let pagesLoaded = false;
/** Did the boot request for the listing fail? The palette then says so. */
let pagesLoadFailed = false;
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
/**
 * The relPath of the page currently rendered in the article pane — the identity
 * the active-row test prefers (`isActivePage`).
 *
 * `currentName` cannot answer "is this row the open page?" on a wiki with
 * same-stem pages: the memory wiki's 30 `MEMORY.md` hubs all have the name
 * `MEMORY`, so opening one drew every one of them active. Assigned from the page
 * RESPONSE (like `currentName`), and cleared with it, so it can never describe a
 * page other than the one on screen. Written only through `setCurrentRelPath`.
 */
let currentRelPath: string | null = null;
/**
 * Which view the article pane was last asked for. Raised by every view change
 * (`setCurrentRelPath`) and by every page fetch (`fetchAndRenderPage`), so a
 * page response compares the number it started with and drops itself once a
 * later view has begun: a page left behind that fails late must not paint its
 * error, or clear the STALE tab, over the page now on screen (R2B4).
 */
let pageViewSeq = 0;
/** The `pageViewSeq` of the newest page fetch. */
let pageFetchSeq = 0;
/** The one writer of `currentRelPath`. The shown page changing is what ends a
 *  Check that belongs to another page (A9), on every route off it: another
 *  page, an explainer, the start view, an Ask answer, an issue graph; the
 *  STALE tab follows it (`staleFollowShownPage`). */
function setCurrentRelPath(relPath: string | null): void {
  currentRelPath = relPath;
  pageViewSeq++;
  staleFollowShownPage(relPath);
}
/**
 * The open page's content hash, from the `/api/wiki/page` response that
 * rendered it — the series editor's CAS base for that one page.
 *
 * Kept in step rather than re-fetched: every series write answers the hash of
 * the bytes it left on disk, so the editor's own write updates this instead of
 * staling it. Any OTHER writer (a hand edit, the stamper, the other machine)
 * stales it, and the CAS answers 409 — which is the honest outcome and what the
 * popover reports.
 */
let currentPageHash: string | null = null;
/**
 * The `near` map of the page whose response last rendered, keyed by that page's
 * relPath — the find palette boosts by it only while that page is still the
 * open one, so an explainer or the start view (no page response) ranks with no
 * closeness at all rather than with the previous page's.
 */
let currentNear: { relPath: string; near: Record<string, number> } | null = null;
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
 * Connections' issue rows for the open page: the inline half from the page
 * payload, replaced by the whole rows when the deferred provenance fetch (or a
 * Link's answer) lands — written only under that fetch's sequence guard.
 * `stampable` comes from the same payload; until it lands no Link is offered.
 * Per-key Link state lives beside them and is dropped with them on navigation.
 */
let issueRows: IssueRow[] | null = null;
let issueStampable = false;
const issueStates = new Map<string, IssueRowState>();
/**
 * In-flight Links, per page (`linkLockId`) → the keys being written, plus
 * {@link LINK_ALL_LOCK} while Link all runs. Module-level and keyed by wiki and
 * relPath, NOT cleared by a render: a reader who leaves a page mid-Link and
 * comes back finds its Links still disabled until the POST lands.
 */
const linkLocks = new Map<string, Set<string>>();
const LINK_ALL_LOCK = "*";
/** The Link control the reader activated and whose POST is still settling — a
 *  key, or {@link LINK_ALL_LOCK} for Link all. While focus is parked on the
 *  section (the control is disabled mid-POST), a redraw returns it there. The
 *  only other way focus lands on a Link is a redraw of the Link that already
 *  held it. Cleared when the Link settles and on navigation. */
let issueFocusKey: string | null = null;
/** The page payload Connections last rendered, so the mini-graph can redraw
 *  when the issue rows change under it. */
let connData: WikiPageDetail | null = null;
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
  waiting: "",
  project: "",
  jira: "",
};
/** Which overview tab is showing. Set from the URL's `view=` (else the per-wiki
 *  stored value) at boot — on EVERY boot, an article deep link included, since
 *  the crumb's href is computed from it — and on popstate (`syncStartTabFromUrl`),
 *  and stored on every tab click, so Back from an article and a reload both land
 *  on the tab the reader left, and an Atlas link is a link. */
let startTab: StartTab = DEFAULT_START_TAB;

function syncStartTabFromUrl(): void {
  startTab = readSliceStartTab(
    resolveStartTab(new URLSearchParams(location.search).get(START_VIEW_PARAM), readStartTab(WIKI)),
    wikiToolsFlag(),
    staleTabAvailable(),
  );
}
/** The overview URL for the CURRENT wiki + tab — what the breadcrumb crumb links
 *  to and what a return-to-overview pushes.
 *
 *  The active project rides along, exactly as `view=` does: the filter is still
 *  set when the reader lands back on the overview and the rail is still narrowed
 *  by it, so an overview URL that dropped it would describe a screen nobody is
 *  looking at. It does NOT leak into the remembered wiki home — `writeLastWiki`
 *  stores the wiki's NAME, never a URL, so the nav's Wiki link keeps opening the
 *  whole wiki. */
function currentStartUrl(): string {
  return urlWithJira(urlWithProject(startUrl(WIKI, startTab), filters.project), filters.jira);
}

/**
 * Write `filters.project` into the address bar, in place.
 *
 * `replaceState`, never `pushState`: a facet is not a navigation, and the tab
 * switch above already established that shape for the reader's other piece of
 * overview state. In PLACE rather than through `currentStartUrl()` because the
 * chip row is on screen while an ARTICLE is open — replacing the URL with the
 * overview's would navigate the address bar off the `?relPath=` being read.
 *
 * Guarded on the param's CURRENT value rather than on the rebuilt string, so a
 * no-op change cannot rewrite (and thereby re-encode) the reader's other params
 * — `projectParamNeedsRewrite`, which also answers "yes" for a present-but-blank
 * param that a raw string compare read as equal to "no filter". `location.hash`
 * rides along HERE: this writer edits the URL in place, so the reader's anchor
 * survives a chip click. It is not a property of the page's other writers — the
 * tab click and `goToStart` both build from `currentStartUrl()`, which carries
 * no hash, so a Timeline click after a chip click drops the anchor (pre-existing,
 * out of scope for this PR).
 */
function writeProjectParam(): void {
  if (!projectParamNeedsRewrite(location.search, filters.project)) return;
  history.replaceState(
    history.state,
    "",
    location.pathname + searchWithProject(location.search, filters.project) + location.hash,
  );
}

/**
 * Adopt the project filter a freshly landed listing implies — the ONE place
 * `filters.project` is set from anywhere but a click.
 *
 * `boot` (the first render, a boot heal, and popstate) reads the ADDRESS BAR:
 * the deep link is what the reader asked for. Every later adopt re-validates the
 * filter the reader has since set instead — see `projectFilterAfterListing`; it
 * ran as a URL re-read on every refresh and on the `applyPendingPages()` at the
 * top of each navigation, which is a wipe.
 *
 * A value this wiki does not know is cleared AND taken out of the URL either
 * way, so a stale link renders the whole wiki with nothing highlighted rather
 * than an empty list under an unrepresentable filter.
 */
function adoptProjectFilter(boot: boolean): void {
  const raw = new URLSearchParams(location.search).get(PROJECT_PARAM);
  filters.project = projectFilterAfterListing(boot, raw, filters.project, projects);
  writeProjectParam();
}

/** `writeProjectParam`'s twin for `?jira=` — same in-place `replaceState`, same
 *  guard on the param's CURRENT value, same hash preservation. */
function writeJiraParam(): void {
  if (!jiraParamNeedsRewrite(location.search, filters.jira)) return;
  history.replaceState(
    history.state,
    "",
    location.pathname + searchWithJira(location.search, filters.jira) + location.hash,
  );
}

/** `adoptProjectFilter`'s twin: the address bar leads at BOOT (and on popstate),
 *  the reader's own filter is re-validated on every later listing, and a key this
 *  wiki does not know is cleared AND dropped from the URL. */
function adoptJiraFilter(boot: boolean): void {
  const raw = new URLSearchParams(location.search).get(JIRA_PARAM);
  filters.jira = jiraFilterAfterListing(boot, raw, filters.jira, jiraKeys);
  writeJiraParam();
}

/** Keep the wiki-crumb hrefs in step with the facets. They are built once per
 *  render, so after a chip click a middle-click or copy-link would hand over
 *  the filter the reader had before it. Every crumb: the hidden breadcrumb
 *  keeps its old one while the effort page shows its own, and the effort
 *  page's Efforts links go to the same overview. */
function refreshCrumbHref(): void {
  document.querySelectorAll(".wiki-bc-wiki, #wikiEffortPage [data-effort-home]").forEach((crumb) => crumb.setAttribute("href", currentStartUrl()));
}
/**
 * Return to the overview from wherever the reader is — the breadcrumb's wiki
 * crumb and the rail's coverage footer. Pushes the
 * overview URL so the address bar stops showing the article just left. The
 * guard is on what the URL DENOTES (`sameStartUrl`), not on the view state and
 * not on the string: an Ask answer shows with the overview URL already in place
 * (a push there made the next Back a no-op), an article that failed to load
 * reads as "start" with the article's URL still up, and a bare boot URL with a
 * stored tab spells the same overview differently from `currentStartUrl()`.
 * The second clause is the byte-identical case the first cannot see: storage
 * is read at CLICK time, and another tab may have changed it since this one
 * booted, so the bar can read as "another tab" while the URL about to be pushed
 * is the one already there.
 */
function goToStart(): void {
  const target = currentStartUrl();
  // `sameStartUrl` reads an `?effort=` URL as the overview it sits on, so the
  // effort page's way home must push explicitly.
  const onEffort = new URLSearchParams(location.search).has(EFFORT_PARAM);
  if (
    onEffort ||
    (!sameStartUrl(location.search, WIKI, startTab, readStartTab(WIKI), wikiToolsFlag(), staleTabAvailable()) &&
      location.pathname + location.search !== target)
  ) {
    history.pushState({}, "", target);
  }
  renderStart();
  // A visit to the home reads the summary afresh (D31).
  loadStaleSummary();
}

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

function sortMode(): WikiSortMode {
  return (document.getElementById("wikiSort") as HTMLSelectElement).value as WikiSortMode;
}

/**
 * Show or hide the "Worked on" sort option for the wiki whose listing just
 * arrived.
 *
 * Three states, and the third is why `matched: 0` and an ABSENT coverage are not
 * the same answer:
 *
 *  - `matched > 0` ⇒ the option is offered.
 *  - `matched === 0` ⇒ hidden. Every page would fall back to its update date, so
 *    the mode is "Recently updated" relabelled. The corpus that shape was
 *    measured on is named once, in `WikiIndex.workedCoverage` (`src/wiki/store.ts`).
 *  - ABSENT (a cold memo, an unreachable ledger, an older server) ⇒ LEFT AS IS.
 *    Nothing is known yet, and hiding on that is a verdict the data did not give.
 *
 * On a hide it also walks the select back to `updated` when `worked` was
 * selected — the reader switches wikis without a reload, and a select stuck on a
 * hidden option sorts by a mode with no control on screen to leave it.
 */
function applyWorkedSortOption(coverage: WikiPagesResponse["workedCoverage"]): void {
  const select = document.getElementById("wikiSort") as HTMLSelectElement | null;
  const option = select?.querySelector<HTMLOptionElement>('option[value="worked"]');
  if (!select || !option) return;
  const workedShown = coverage && typeof coverage.matched === "number" ? coverage.matched > 0 : null;
  if (workedShown !== null) {
    option.hidden = !workedShown;
    const was = workedAxisOn;
    workedAxisOn = workedShown;
    // Related work's ages mark their source on this axis too.
    if (was !== workedAxisOn) repaintRelatedBlock();
  }
  // "Worked on" is the default where it is offered; a sort the reader picked
  // (this tab, or stored for this wiki) wins. `resolveSortMode` owns the rules.
  select.value = resolveSortMode({
    current: select.value as WikiSortMode,
    stored: readSort(WIKI),
    touched: getSortTouched(),
    workedShown,
  });
}

/** The last listing said the ledger covers pages on this wiki — what lets the
 *  article header name a worked day, or say no session wrote the page. */
let workedAxisOn = false;
/** The listing's `waitsCounted`: the Your work strip's wait cells apply here. */
let waitsCounted = false;

// ── Article tools: ⧉ Copy path, the provenance strip, issue links ────

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

/**
 * Copy one session id off a chain row — the ⧉ Copy path control's twin, and
 * through the same `copyText`/`flashCopyResult` pair rather than a second
 * clipboard write.
 *
 * That matters more here than on the breadcrumb: the reader most likely to want
 * a session id is on the tailnet over plain HTTP, where `navigator.clipboard` is
 * simply absent and the `execCommand` fallback is the ONLY path — and the flash
 * is the only report either path can give. The id is the whole reason the chip
 * is copyable text: the browser cannot reach claude-usage (see the strip's own
 * comment), so a search for this string is what a reader does with it.
 */
function copySessionId(btn: HTMLButtonElement): void {
  const id = btn.getAttribute("data-sess-copy") || "";
  const idle = {
    text: SESSION_COPY_IDLE,
    // The SAME spelling the button was rendered with — two copies meant the
    // button quietly renamed itself the first time a reader pressed it.
    ariaLabel: sessionCopyAriaLabel(id),
    okText: SESSION_COPY_OK,
    failText: SESSION_COPY_FAIL,
  };
  // An empty id reports a failure rather than returning silently: `writeText("")`
  // RESOLVES, so copying nothing would report success while emptying the
  // reader's clipboard (the ⧉ Copy path reasoning, verbatim).
  if (!id) return flashCopyResult(btn, false, idle);
  void copyText(id).then((ok) => flashCopyResult(btn, ok, idle));
}

/**
 * Stamp a ghost session onto the open page — the ONE write the provenance
 * feature makes, and it is a POST to a route that shells out to claude-usage's
 * `wiki-stamp` CLI. muninn writes no frontmatter line here or anywhere.
 *
 * ── The two-step confirm, and the three ways the first cut lost it ──────────
 *
 * A handoff ghost's button carries `data-prov-stamp-confirm`: a handoff link
 * says a later session pasted this one's prompt, which is not the same as saying
 * it wrote the page, and the write is a permanent claim. So the first press only
 * ARMS; a second, separate press writes.
 *
 *  1. **A double-click delivered both presses.** `dblclick` fires two `click`
 *     events milliseconds apart, so the confirm label was set and consumed
 *     inside one gesture and the write happened with the confirmation never on
 *     screen. Arming therefore DISABLES the button for {@link STAMP_ARM_MS};
 *     the second click of a double-click lands on a disabled button and is
 *     dropped, while a deliberate second press half a second later is not.
 *  2. **A failed attempt disarmed the button permanently.** The confirm state
 *     lived in the ATTRIBUTE, which the first press removed — so after a 409 the
 *     row said `not stamped: …` and the NEXT single click wrote with no
 *     confirmation at all. The attribute is now a static fact from the server
 *     ("this ghost needs confirming") and the armed state is
 *     `data-prov-stamp-armed`, which every failure path clears along with the
 *     label.
 *  3. **A 200 carrying no `provenance` disabled the button forever.** The
 *     re-resolve can legitimately answer nothing (the index lost the page, the
 *     ledger context is absent), and the row was left with a dead `…` button.
 *     It now re-enables and re-reads the page's payload.
 *
 * The state lives on the BUTTON, never in a module flag, for `toggleProvChain`'s
 * reason — the strip is re-rendered from scratch on every page load, so a flag
 * would outlive the element it described.
 *
 * The REASON goes in its own `.wiki-chain-stamp-msg` span, not into the label:
 * a label is what the control does, and `not stamped: not-a-stamp-root` as a
 * label is a button that renamed itself to a sentence. `textContent` is the
 * escape — the reason is server copy and a route can echo a `ref` inside it.
 */

/** How long an armed Stamp button stays disabled. Long enough to swallow a
 *  double-click's second event (a system double-click threshold is ~500 ms),
 *  short enough that a reader who meant it is not made to wait. */
const STAMP_ARM_MS = 500;

/** The message span beside one Stamp button, if the row has one. */
function stampMsgSpan(btn: HTMLButtonElement): HTMLElement | null {
  const row = btn.closest(".wiki-chain-row");
  return row ? row.querySelector<HTMLElement>("[data-prov-stamp-msg]") : null;
}

function showStampMsg(btn: HTMLButtonElement, text: string): void {
  const span = stampMsgSpan(btn);
  if (!span) return;
  span.textContent = text;
  span.hidden = false;
}

function clearStampMsg(btn: HTMLButtonElement): void {
  const span = stampMsgSpan(btn);
  if (!span) return;
  span.textContent = "";
  span.hidden = true;
}

/** Back to an offerable Stamp: the label restored, the confirm re-armable, the
 *  button live. Every non-success path ends here. */
function resetStampButton(btn: HTMLButtonElement): void {
  btn.disabled = false;
  btn.textContent = STAMP_LABEL;
  btn.removeAttribute("data-prov-stamp-armed");
}

async function stampGhost(btn: HTMLButtonElement): Promise<void> {
  const ref = btn.getAttribute("data-prov-stamp") || "";
  if (!ref || !currentRelPath || btn.disabled) return;
  // The page the button was pressed on. The redraw below keys on the DOM, and
  // the DOM is another page's if the reader navigated while the POST ran.
  const pressedOn = currentRelPath;
  // ARM. `data-prov-stamp-confirm` says this ghost needs confirming and is never
  // removed; `data-prov-stamp-armed` is the press that answered it.
  if (btn.getAttribute("data-prov-stamp-confirm") && !btn.hasAttribute("data-prov-stamp-armed")) {
    btn.setAttribute("data-prov-stamp-armed", "1");
    btn.textContent = STAMP_CONFIRM_LABEL;
    clearStampMsg(btn);
    // See (1) above: the gap is what makes the confirm a separate gesture.
    btn.disabled = true;
    setTimeout(() => {
      // Only re-enable a button still waiting for its confirm — a redraw may
      // have replaced the row, and a POST cannot have started from here.
      if (btn.hasAttribute("data-prov-stamp-armed")) btn.disabled = false;
    }, STAMP_ARM_MS);
    return;
  }
  btn.disabled = true;
  btn.textContent = "…";
  clearStampMsg(btn);
  try {
    const res = await fetch("/api/wiki/provenance/stamp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: WIKI, relPath: currentRelPath, ref }),
    });
    const body = (await res.json().catch(() => null)) as
      | { provenance?: ProvenancePayload; reason?: string; error?: string }
      | null;
    if (!res.ok) {
      // The route's own reason, verbatim — `not-a-stamp-root`, `lock-timeout`, a
      // 403 from the read-only guards. A refusal the reader can act on beats a
      // button that silently goes back to saying "Stamp" — but it goes back to
      // saying "Stamp" all the same, so a retry asks again.
      resetStampButton(btn);
      showStampMsg(btn, `not stamped: ${body?.reason || body?.error || res.status}`);
      return;
    }
    // The route answers with the RE-RESOLVED block, so the strip redraws with no
    // second fetch — and with the chain left open, since the reader was reading
    // it when they pressed the button.
    if (body?.provenance) {
      if (currentRelPath === pressedOn) redrawProvStrip(body.provenance);
      return;
    }
    // A 200 with no block: the write happened, the re-resolve did not answer.
    // Re-read the page's own payload rather than leaving a dead button.
    resetStampButton(btn);
    refetchProvStrip();
  } catch {
    resetStampButton(btn);
    showStampMsg(btn, "not stamped: the request failed");
  }
}

/** Re-read the open page's provenance block and redraw the strip from it —
 *  through the ONE load path, so it takes a sequence number like any load and
 *  writes through `placeProvStrip` like any writer. */
function refetchProvStrip(): void {
  if (currentRelPath) void loadProvStrip(currentRelPath);
}

function provenanceUrl(relPath: string): string {
  return withWiki("/api/wiki/page/provenance?relPath=" + encodeURIComponent(relPath));
}

/** The newest provenance load's sequence number. Only that load may write —
 *  see `loadProvStrip`; a Stamp redraw bumps it to retire whatever is in
 *  flight. */
let provLoadSeq = 0;

/** The provenance load in flight. Leaving the page aborts it, which cancels
 *  the server's claude-usage fetches with it (the route passes the request
 *  signal into `pageProvenance`; its huginn reads are raced, not cancelled). */
let provLoadAbort: AbortController | null = null;

function abortProvLoad(): void {
  provLoadAbort?.abort();
  provLoadAbort = null;
}

/**
 * The ONE writer of the strip. Every writer — a load, the Stamp redraw, the
 * retry — replaces whatever `.wiki-prov-strip` is on the page (the
 * placeholder, the failure line, a real strip), and inserts after the meta
 * row when none is there (a `prs:`-only page rendered no placeholder; an empty
 * insert is a no-op). Two writers with rules of their own is how this page
 * came to show two strips, twice: each rule enumerated the DOM states the
 * OTHER writer could leave and got one wrong. What a load may WRITE is decided
 * in `loadProvStrip` (an empty or failed answer replaces only a placeholder);
 * where it goes is decided here. An open chain stays open across the
 * replacement: the reader was looking at it. A cost line that lands brings
 * the lens switch with it when Overview hides nothing else on the page.
 */
function placeProvStrip(html: string): void {
  writeProvStrip(html);
  refreshLensSwitch(document.getElementById("articleWrap")!);
}

function writeProvStrip(html: string): void {
  const existing = document.querySelector(".wiki-prov-strip");
  if (!existing) {
    document.querySelector(".wiki-article-head .wiki-meta-row")?.insertAdjacentHTML("afterend", html);
    return;
  }
  const wasOpen =
    existing.querySelector("[data-prov-toggle]")?.getAttribute("aria-expanded") === "true";
  existing.outerHTML = html;
  if (!wasOpen) return;
  const line = document.querySelector<HTMLButtonElement>("[data-prov-toggle]");
  if (line) toggleProvChain(line);
}

/**
 * Fill the placeholder strip a `provenancePending` page rendered. Runs AFTER
 * the article is on screen, so the join's 10 s budget is spent behind a
 * spinner rather than in front of the markdown.
 *
 * Who may write is decided once: the NEWEST load for the page that is still
 * open. Loads overlap whenever the reader leaves a page and returns before
 * its first answer lands, or presses Stamp and the refetch races the page's
 * own load — both are for the same relPath, so a relPath guard alone lets
 * both through. An older answer is dropped whatever it carries; the newest
 * writes through `placeProvStrip`. A failed fetch becomes the failure line
 * with a retry only where a placeholder promised a strip; on a `prs:`-only
 * page, which rendered none, it stays silent.
 */
async function loadProvStrip(relPath: string): Promise<void> {
  const seq = ++provLoadSeq;
  abortProvLoad();
  const ctl = new AbortController();
  provLoadAbort = ctl;
  let next: string | null = null;
  let prov: ProvenancePayload | undefined;
  try {
    const res = await fetch(provenanceUrl(relPath), { signal: ctl.signal });
    if (res.ok) {
      const data = (await res.json()) as WikiPageProvenance | null;
      prov = data?.provenance;
      next = prov ? provStripHtml(prov, jiraKeys) : "";
    }
  } catch {
    /* falls through to the unavailable line */
  }
  // An aborted load was retired on purpose: it never writes the failure line.
  if (ctl.signal.aborted) return;
  if (provLoadAbort === ctl) provLoadAbort = null;
  if (currentRelPath !== relPath || seq !== provLoadSeq) return;
  // Connections is the fetch's second consumer, under the same guard.
  if (prov) adoptIssueRows(prov);
  if (next) {
    placeProvStrip(next);
    return;
  }
  // Nothing to show, or nothing came back. Either one may only replace a
  // PLACEHOLDER: a real strip stays (the Stamp refetch re-reads a page that
  // just resolved to no keys — the same state that answered its POST with no
  // block — and a successful write must not make the strip, the chain and the
  // Stamp button vanish), and a bare head stays bare.
  if (!document.querySelector(".wiki-prov-strip.wiki-prov-pending")) return;
  placeProvStrip(next === null ? provUnavailableHtml() : "");
}

/** The retry on a failed load: back to the placeholder, then the fetch again. */
function retryProvStrip(): void {
  if (!document.querySelector(".wiki-prov-strip.wiki-prov-unavailable") || !currentRelPath) return;
  placeProvStrip(provPendingHtml());
  void loadProvStrip(currentRelPath);
}

/** Redraw the strip from the block the stamp route answered with. That block
 *  is a re-resolve AFTER the write, so it is fresher than any load in flight:
 *  the sequence is bumped to retire them. */
function redrawProvStrip(provenance: ProvenancePayload): void {
  provLoadSeq += 1;
  abortProvLoad();
  placeProvStrip(provStripHtml(provenance, jiraKeys));
  adoptIssueRows(provenance);
}

/** Take a provenance block's whole issue rows (and its `stampable`) into
 *  Connections and the mini-graph. A block with no `issues` means the page has
 *  none now, so the rows go too. */
function adoptIssueRows(provenance: ProvenancePayload): void {
  const had = issueRows !== null;
  issueRows = provenance.issues ?? null;
  issueStampable = provenance.stampable;
  // A wiki with no tracker has rows on neither side: nothing to redraw.
  if (!had && !issueRows) return;
  redrawConnIssues();
  redrawMiniGraph();
}

function linkLockId(relPath: string): string {
  return JSON.stringify([WIKI, relPath]);
}

function pageLinkLocked(relPath: string): boolean {
  return (linkLocks.get(linkLockId(relPath))?.size ?? 0) > 0;
}

function setLinkLock(relPath: string, key: string, on: boolean): void {
  const id = linkLockId(relPath);
  const held = linkLocks.get(id) ?? new Set<string>();
  if (on) held.add(key);
  else held.delete(key);
  if (held.size) linkLocks.set(id, held);
  else linkLocks.delete(id);
}

/** The open page is markdown — only then is Link offered. */
function isMarkdownRel(relPath: string | null): boolean {
  return !!relPath && /\.mdx?$/i.test(relPath);
}

function issueSectionFor(relPath: string | null): string {
  if (!relPath) return "";
  // A Link in flight on this page reads "linking…" on its row, whichever
  // render drew the section.
  const states = new Map(issueStates);
  for (const key of linkLocks.get(linkLockId(relPath)) ?? []) {
    if (key !== LINK_ALL_LOCK) states.set(key, { kind: "busy" });
  }
  return issueSectionHtml(issueRows ?? undefined, {
    labelOf: (id) => trackerLabels[id] || "",
    stampable: issueStampable,
    markdown: isMarkdownRel(relPath),
    relPath,
    states,
    discuss: !wikiReadonlyWikiFlag(),
    locked: pageLinkLocked(relPath),
  });
}

/** The ONE writer of Connections' issue section: replaces it in place, or
 *  inserts it at the top of the panel (above the mini-graph). Focus inside
 *  the section stays inside it — see {@link issueFocusSelector}. */
function redrawConnIssues(): void {
  const html = issueSectionFor(currentRelPath);
  const el = document.getElementById(CONN_ISSUES_ID);
  if (el) {
    const active = document.activeElement;
    const sel = active && el.contains(active) ? issueFocusSelector(active, el) : null;
    el.outerHTML = html;
    if (sel !== null) {
      const sec = document.getElementById(CONN_ISSUES_ID);
      const target = sel ? sec?.querySelector<HTMLElement>(`${sel}:not(:disabled)`) : null;
      (target ?? sec)?.focus({ preventScroll: true });
    }
    return;
  }
  if (html) document.getElementById("connBody")?.insertAdjacentHTML("afterbegin", html);
}

/**
 * Where focus goes after a redraw replaced `active`: the EQUIVALENT control in
 * the new section — same kind, same key — as a selector, or `""` for the
 * section itself (`tabindex="-1"`). Focus is moved onto a Link or Link all only
 * from that same control, or from the section while it holds focus for the
 * Link the reader activated ({@link issueFocusKey}); never from anything else,
 * so Enter on a focused key anchor cannot become a write.
 */
function issueFocusSelector(active: Element, sec: Element): string {
  const attr = (name: string) => CSS.escape(active.getAttribute(name) ?? "");
  if (active === sec) {
    if (issueFocusKey === LINK_ALL_LOCK) return `[${ISSUE_LINK_ALL_ATTR}]`;
    return issueFocusKey ? `[${ISSUE_LINK_ATTR}="${CSS.escape(issueFocusKey)}"]` : "";
  }
  if (active.hasAttribute(ISSUE_LINK_ATTR)) return `[${ISSUE_LINK_ATTR}="${attr(ISSUE_LINK_ATTR)}"]`;
  if (active.hasAttribute(ISSUE_LINK_ALL_ATTR)) return `[${ISSUE_LINK_ALL_ATTR}]`;
  if (active.hasAttribute(DRAFT_PLAN_ATTR)) return `[${DRAFT_PLAN_ATTR}="${attr(DRAFT_PLAN_ATTR)}"]`;
  const row = active.closest("[data-issue-row]");
  if (!row) return "";
  const key = CSS.escape(row.getAttribute("data-issue-row") ?? "");
  for (const cls of ["wiki-issue-key", "wiki-issue-plan"]) {
    if (active.classList.contains(cls)) return `[data-issue-row="${key}"] a.${cls}`;
  }
  return "";
}

/** Redraw the mini-graph from the current issue rows (a Link, or the deferred
 *  rows landing), in place. */
function redrawMiniGraph(): void {
  if (!connData || (connData.meta?.relPath ?? currentRelPath) !== currentRelPath) return;
  const html = miniGraphHtml(connData, issueRows);
  const el = document.querySelector("#connBody .wiki-mini-graph");
  if (el) {
    if (html) el.outerHTML = html;
    else el.remove();
    return;
  }
  if (!html) return;
  const sec = document.getElementById(CONN_ISSUES_ID);
  if (sec) sec.insertAdjacentHTML("afterend", html);
  else document.getElementById("connBody")?.insertAdjacentHTML("afterbegin", html);
}

/**
 * A Link changed a page's relations: its rail row's pills and the Jira facet
 * take the answer's rows (the listing's own compact shape) without a listing
 * refetch. A key that newly counts joins the facet's membership.
 */
function refreshListingIssues(relPath: string, rows: readonly IssueRow[]): void {
  const hit = allPages.find((p) => p.relPath === relPath);
  if (!hit) return;
  const before = new Set(facetJiraKeys(hit));
  hit.issues = compactIssues(rows);
  if (currentArticle && currentArticle !== hit && currentArticle.relPath === relPath) currentArticle.issues = hit.issues;
  for (const key of facetJiraKeys(hit)) if (!before.has(key)) jiraKeys[key] = (jiraKeys[key] ?? 0) + 1;
  renderJiraChips();
  renderList();
}

/**
 * **Link**: write one key to a page's tracker line through the Stamp route's
 * `{ tracker, key }` form — the only write path, which shells out to the same
 * CLI as a session Stamp. The answer carries the re-resolved block, so the
 * strip, the rows, the mini-graph and the rail row redraw from it with no
 * second fetch. A skip lands on the row as its named state. The page's Link
 * lock is held for the POST, so no second Link starts beside it (`inLinkAll`:
 * Link all already holds it). Resolves true on success.
 */
async function linkIssue(relPath: string, tracker: string, key: string, inLinkAll = false): Promise<boolean> {
  if (!inLinkAll && pageLinkLocked(relPath)) return false;
  if (!inLinkAll) issueFocusKey = key;
  if (currentRelPath === relPath) issueStates.delete(key);
  setLinkLock(relPath, key, true);
  if (currentRelPath === relPath) redrawConnIssues();
  let state: IssueRowState | null = null;
  let provenance: ProvenancePayload | undefined;
  let ok = false;
  try {
    const res = await fetch("/api/wiki/provenance/stamp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: WIKI, relPath, tracker, key }),
    });
    const body = (await res.json().catch(() => null)) as
      | { provenance?: ProvenancePayload; reason?: string; error?: string }
      | null;
    if (res.ok) {
      ok = true;
      provenance = body?.provenance;
    } else {
      state =
        res.status === 409 && body?.reason
          ? { kind: "refused", reason: body.reason }
          : { kind: "error", text: `not linked: ${body?.reason || body?.error || res.status}` };
    }
  } catch {
    state = { kind: "error", text: "not linked: the request failed" };
  } finally {
    setLinkLock(relPath, key, false);
  }
  // The rail row is that page's wherever the reader is now.
  if (provenance) refreshListingIssues(relPath, provenance.issues ?? []);
  if (currentRelPath !== relPath) return ok;
  if (!ok) {
    issueStates.set(key, state!);
    redrawConnIssues();
  } else if (provenance) redrawProvStrip(provenance);
  else {
    redrawConnIssues();
    refetchProvStrip();
  }
  if (!inLinkAll && issueFocusKey === key) issueFocusKey = null;
  return ok;
}

/** **Link all**: the eligible keys one POST at a time (the CLI's lockfile
 *  serializes them anyway), under the page's Link lock from first to last, and
 *  stopping at the first that does not land. A key the open page already shows
 *  stamped by its turn is skipped. */
async function linkAllIssues(): Promise<void> {
  const relPath = currentRelPath;
  if (!relPath || pageLinkLocked(relPath)) return;
  const rows = [...(issueRows ?? [])];
  const keys = linkAllKeys(rows, { stampable: issueStampable, markdown: isMarkdownRel(relPath) });
  setLinkLock(relPath, LINK_ALL_LOCK, true);
  issueFocusKey = LINK_ALL_LOCK;
  try {
    for (const key of keys) {
      const row = rows.find((r) => r.key === key)!;
      const now = currentRelPath === relPath ? issueRows?.find((r) => r.key === key) : undefined;
      if (now?.relations.includes("stamped")) continue;
      if (!(await linkIssue(relPath, row.tracker, key, true))) break;
    }
  } finally {
    setLinkLock(relPath, LINK_ALL_LOCK, false);
    if (currentRelPath === relPath) redrawConnIssues();
    if (issueFocusKey === LINK_ALL_LOCK) issueFocusKey = null;
  }
}

/**
 * Open or close the provenance chain under the page title.
 *
 * The button's `aria-expanded` and the chain's `hidden` are flipped TOGETHER and
 * both read off the DOM rather than a module-level flag: the strip is re-rendered
 * from scratch on every page load (collapsed, by the renderer), so a flag here
 * would outlive the element it described and report the wrong state on the next
 * page.
 *
 * `aria-controls` names the chain, so the element is found through the button
 * rather than by a second selector that could drift from the markup.
 */
function toggleProvChain(btn: HTMLButtonElement): void {
  const id = btn.getAttribute("aria-controls") || "";
  const chain = id ? document.getElementById(id) : null;
  if (!chain) return;
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", open ? "false" : "true");
  // `hidden`, not a display style: it is what the renderer ships the element
  // with, so one property is the whole state.
  chain.hidden = open;
}

// ── Breadcrumb bar (above the article) ────────────────────────────────
// Shows "wiki / folder / page · updated" for the open page and hosts the
// Explain affordance (a button shown only while a selection exists — see the
// Select-to-Explain section). Hidden on the start view and on Ask answers.
const WORKED_SLOT_TITLE = "The day an agent session last wrote this page (claude-usage's session ledger)";
const CHANGED_SINCE_TITLE =
  "Changed after the last session by something the ledger does not record: a hand edit, a script, a lint or sync commit";
const ledgerReadTitle = (day: string) =>
  `The session ledger was last read ${day}; this page changed after that, so whether a session wrote it is not known yet.`;
const NO_SESSION_TITLE =
  "No agent session write is recorded for this page (bulk passes are not counted). The date is the file's own.";
function renderBreadcrumb(m: WikiListing): void {
  // A page render starts over: the previous page's provenance load is not wanted.
  abortProvLoad();
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
  // A walkthrough panel belongs to the page it was opened on.
  closeWalkthroughOnNavigate(m.relPath || null);
  // The answer export belongs to the page that mounted it; the markdown path
  // mounts it again after this render, an explainer never does.
  unmountAnswerExport();
  // Stamped even when there is no breadcrumb node: it is the "which page is open"
  // answer for the Discuss popover, and every render path funnels through here.
  currentArticle = m;
  // A new page's neighbours aren't known until its `/api/wiki/page` response
  // lands, and the PREVIOUS page's are wrong the moment this render runs.
  currentOutgoingTitles = [];
  if (!el) return;
  const crumbs: string[] = [];
  // The wiki crumb is the way BACK to the overview (Hubs / Timeline / Atlas):
  // before it was an anchor the only routes there were browser Back and the
  // coverage footer. The href is the real overview URL so middle-click/copy
  // work; the click delegate intercepts a plain click into `goToStart`.
  crumbs.push(
    '<a class="wiki-bc-wiki" href="' + esc(currentStartUrl()) + '" title="Back to the overview">' +
      '<span aria-hidden="true">⌂</span> ' +
      esc(WIKI || "Wiki") +
      "</a>",
  );
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
  // With the ledger on, a `worked` slot names the day the last agent session wrote
  // the page; `updated` then appears only as a change after that session, or as
  // the fallback on a page no session wrote.
  const dates = pageHeaderDates(m, recencyNow(), { ledger: workedAxisOn, ledgerAsOfMs: workedGate?.asOfMs });
  // The page changed after the ledger was last read: whether a session wrote
  // it is not known yet, so the slots say when the ledger was read instead.
  const noSessionTitle = dates.ledgerReadDay ? ledgerReadTitle(dates.ledgerReadDay) : NO_SESSION_TITLE;
  const changedTitle = dates.ledgerReadDay ? ledgerReadTitle(dates.ledgerReadDay) : CHANGED_SINCE_TITLE;
  const slots: string[] = [];
  if (dates.created) slots.push("created " + esc(dates.created));
  if (dates.worked) {
    slots.push(
      `<span class="wiki-bc-worked" title="${esc(WORKED_SLOT_TITLE)}">worked ${esc(dates.worked)}</span>`,
    );
  }
  if (dates.updated) {
    slots.push(
      dates.changedSince
        ? `<span class="wiki-bc-changed" title="${esc(changedTitle)}">updated ${esc(dates.updated)}</span>`
        : dates.noSession
          ? `<span class="wiki-bc-fallback" title="${esc(noSessionTitle)}">updated ${esc(dates.updated)}</span>`
          : "updated " + esc(dates.updated),
    );
  }
  if (dates.noSession) {
    slots.push(
      `<span class="wiki-bc-nosession" title="${esc(noSessionTitle)}">` +
        (dates.ledgerReadDay ? `ledger read ${esc(dates.ledgerReadDay)}` : "no session") +
        "</span>",
    );
  }
  // State T/T0 (D15): the window holds only touches or pass markers for this
  // page, so the dates above are not focused work — the mark names the touch.
  if (dates.touched) {
    slots.push(`<span class="wiki-bc-touched" title="${esc(touchedLine(dates.touched))}">touched ${esc(dates.touched.label)}</span>`);
  }
  const dateHtml = slots.length ? '<span class="wiki-bc-date">' + slots.join(" · ") + "</span>" : "";
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
    // ⌖ Show in list — the rail's row for this page, beside Copy path for the
    // same reason: a utility about where the page is, not about its content.
    `<button class="wiki-bc-copy wiki-bc-locate" id="wikiLocateBtn" type="button" ` +
    `title="Show in list" aria-label="Show this page in the list">⌖</button>` +
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
    shareArticleBtnHtml() +
    // ⇪ Felles — publish to the melosys-felles bucket, on an allowlisted wiki only.
    (fellesPublishBin ? fellesBtnHtml(m.relPath, fellesSync?.markFor(m.relPath) ?? null) : "");
  el.style.display = "flex";
}
function hideBreadcrumb(): void {
  abortProvLoad(); // no page open: its provenance load is not wanted either
  const el = document.getElementById("wikiBreadcrumb");
  if (el) el.style.display = "none";
  unmountAnswerExport(); // an Ask answer, the start view or an issue graph: no page
  closeWalkthroughOnNavigate(null);
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
      `<div class="wiki-hub-card${p.culled ? " culled" : ""}" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}">` +
      `<div class="wiki-hub-title">${esc(displayTitleOf(p))}${p.culled ? " " + cullMarkHtml() : ""}</div>` +
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
  const pages = railPages();
  if (hasTypedHubs(pages)) {
    let html = "";
    hubTypeList(pages, typeOrder, defaultType).forEach((t) => {
      const top = topPages(pages, (p) => p.type === t, 12);
      if (!top.length) return;
      html += hubGridHtml(`Top ${esc(typeLabel(t).toLowerCase())} by connections`, top);
    });
    if (html) return html;
    // No typed section had pages — fall through to the cross-type hub.
  }
  const top = topPages(pages, (p) => p.backlinkCount > 0, 12);
  if (!top.length) {
    // Linked pages that are all retired are held back, not absent: offer them
    // rather than claim the wiki has no links.
    if (!showRetired() && allPages.some((p) => p.culled && p.backlinkCount > 0)) {
      return `<div class="wiki-conn-empty">${retiredRevealHtml(allPages.filter((p) => p.culled).length)}</div>`;
    }
    return '<div class="wiki-conn-empty">No linked pages yet — this wiki has no resolvable internal links.</div>';
  }
  return hubGridHtml("Top pages by connections", top);
}

function timelineHtml(): string {
  const groups: Record<string, { p: WikiListing; kind: "new" | "upd" }[]> = {};
  const now = recencyNow();
  // The rows' own pool, query included: a search reaches a retired page here too.
  filterPages(railPool(allPages, showRetired(), filters.q), filters).forEach((p) => {
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
  if (startTab === "stale") return staleHomeBodyHtml(getStaleSummary());
  return startTab === "hubs" ? hubsHtml() : timelineHtml();
}

/** The per-type counters above the start view's tabs. Derived straight from
 *  `allPages`, so a refreshed listing has to repaint them — a stale "10 Concepts"
 *  above an 11-row list is exactly the staleness this refresh exists to kill. */
function startStatsHtml(): string {
  const counts = typeCounts(railPages(), "");
  let html = "";
  connectionTypeOrder(Object.keys(counts), typeOrder).forEach((t) => {
    if (!counts[t]) return;
    html += `<div class="wiki-stat"><b>${counts[t]}</b><span>${esc(typeLabel(t))}</span></div>`;
  });
  return html;
}

function refreshStartStats(): void {
  const el = document.getElementById("wikiStartStats");
  if (el && getCurrentName() === null) el.innerHTML = startStatsHtml();
}

/** Re-render the hubs/timeline area in place when filters change on the start view.
 *  The Atlas tab isn't filter-driven (it reads its own `/api/wiki/atlas`
 *  projection), so a filter change must NOT wipe its built canvas + selection.
 *  That early return is load-bearing for the background listing refresh too: an
 *  adopt must not wipe an in-progress Atlas exploration. The accepted cost is that
 *  the Atlas projection stays frozen at whatever it was built from until the next
 *  tab switch rebuilds it — which is also when it reads the `Show retired` pool
 *  (`atlasDeps().cull`), since the toggle is off screen on the Atlas tab. */
function refreshStartBody(): void {
  const el = document.getElementById("startBody");
  if (!el || getCurrentName() !== null) return;
  if (startTab !== "atlas") el.innerHTML = startBodyHtml();
}

/** What the Atlas reads from the reader, retired pages included. Atlas passes
 *  (relPath, name); the name is dropped — the relPath is authoritative and
 *  drives the collision-proof history round-trip. */
function atlasDeps(): AtlasDeps {
  return {
    withWiki,
    openPage: (relPath) => loadPageByRelPath(relPath),
    wiki: WIKI,
    cull: () => atlasCullOf(allPages, !showRetired(), cullLabels().marker),
  };
}

/** Atlas gets the full viewport while its tab is active on the start view —
 *  the left browse pane + right rail collapse (`.atlas-full` on the layout,
 *  styled in wiki-page.ts). Restored on tab switch / page open. Toggled BEFORE
 *  initAtlas builds so the canvas lays out (and draws edges) at final width. */
function setAtlasFull(on: boolean): void {
  const layout = document.querySelector(".wiki-layout");
  if (layout) layout.classList.toggle("atlas-full", on);
}

/** Show the home's `name` tab (a tab click, or the Stale line's Show). */
function switchStartTab(name: string | null): void {
  startTab = readSliceStartTab(resolveStartTab(name, null), wikiToolsFlag(), staleTabAvailable());
  writeStartTab(WIKI, startTab);
  // REPLACE, never push: Back from the overview should leave it, not walk
  // through every tab the reader tried.
  history.replaceState(history.state, "", currentStartUrl());
  renderStart();
}

function renderStart(): void {
  // Returning to the browse view is the moment a page set stashed during reading
  // becomes safe to apply — before anything below reads `allPages`.
  applyPendingPages();
  // No article: a `?lens=` is spent, and a plan-card run in flight is dropped.
  consumeUrlLens();
  abortAgentRuns();
  setCurrentName(null);
  // The two identities are cleared together, always; the STALE tab and its count go with the page.
  setCurrentRelPath(null);
  currentPageHash = null;
  // The overview has no graph, and its URL carries no `display=`: leaving an
  // article for it leaves graph mode too. Back restores it from the URL.
  graphMode = false;
  graphIssue = "";
  removeGraph();
  hideBreadcrumb(); // no page open — the breadcrumb has nothing to show
  let html =
    '<div class="wiki-start"><div class="wiki-article-head"><h1>Knowledge Wiki</h1>' +
    '<div class="wiki-meta-row"><span class="wiki-dates">Browse by search and filters on the left, or start from a hub below. Click any wikilink to follow connections.</span></div></div>' +
    '<div id="wikiWorkCard" class="wiki-whatsnew wiki-workcard" style="display:none"></div>' +
    '<div id="wikiWhatsNew" class="wiki-whatsnew" style="display:none"></div>' +
    '<div id="wikiIndexCard" class="wiki-index-card" style="display:none"></div>' +
    // The Stale check's line (PR 2b), beside the Index card rather than in
    // it: that card hides on a wiki with no search collections.
    (staleTabAvailable() ? `<div id="wikiStaleHome" class="wiki-stale-home">${staleHomeLineHtml(getStaleSummary())}</div>` : "") +
    '<div class="wiki-start-stats" id="wikiStartStats">' +
    startStatsHtml();
  html +=
    "</div>" +
    '<div class="wiki-tabs">' +
    `<button class="wiki-tab${startTab === "hubs" ? " active" : ""}" data-tab="hubs">Hubs</button>` +
    `<button class="wiki-tab${startTab === "timeline" ? " active" : ""}" data-tab="timeline">Timeline</button>` +
    (wikiToolsFlag() ? `<button class="wiki-tab${startTab === "atlas" ? " active" : ""}" data-tab="atlas">Atlas</button>` : "") +
    (staleTabAvailable() ? `<button class="wiki-tab${startTab === "stale" ? " active" : ""}" data-tab="stale">Stale</button>` : "") +
    "</div>" +
    `<div id="startBody">${startBodyHtml()}</div></div>`;
  document.getElementById("articleWrap")!.innerHTML = html;
  setAtlasFull(startTab === "atlas");
  // The Atlas tab lazy-loads its projection into the placeholder just inserted.
  if (startTab === "atlas") initAtlas(atlasDeps());
  document.getElementById("connBody")!.innerHTML =
    '<div class="wiki-conn-empty">Select a page to see its connections.</div>';
  // Re-attach the "what's new" and index-coverage cards: cached render reused on
  // a tab switch, otherwise a single lazy fetch each, so neither ever blocks the
  // page list from rendering. Both routes are outside the read slice.
  if (wikiToolsFlag()) mountStartCards();
  // No summary fetch here: a start-tab switch is no visit. The visits
  // (goToStart, Back to the home, boot) fetch it themselves (D31).
  renderList();
}

interface MiniNode {
  p: WikiListing;
  out: boolean;
  inn: boolean;
  x?: number;
  y?: number;
}

/** How many of the page's issue keys the mini-graph draws beside its pages;
 *  the rest are counted in its footer line. */
const MINI_ISSUES_MAX = 4;

/** 1-hop neighborhood as a small radial SVG: current page centered, top
 *  neighbors on a ring, and the page's counting Jira keys as diamonds on the
 *  same ring (dashed edge when inferred; a click filters by the key). `rows`
 *  are Connections' current issue rows, which a Link or the deferred fetch
 *  replaces after the page renders. */
function miniGraphHtml(data: WikiPageDetail, rows: readonly IssueRow[] | null | undefined): string {
  // Jira only: a diamond's click is the Jira facet's filter.
  const counting = (rows ?? []).filter((r) => r.tracker === JIRA_TRACKER_ID && relationsCount(r.relations));
  const issues = counting.slice(0, MINI_ISSUES_MAX);
  const byName: Record<string, MiniNode> = {};
  data.outgoing.forEach((p) => {
    byName[p.name] = { p, out: true, inn: false };
  });
  data.backlinks.forEach((p) => {
    if (byName[p.name]) byName[p.name]!.inn = true;
    else byName[p.name] = { p, out: false, inn: true };
  });
  const all = Object.keys(byName).map((k) => byName[k]!);
  if (!all.length && !issues.length) return "";
  all.sort((a, b) => {
    const ab = a.out && a.inn ? 1 : 0;
    const bb = b.out && b.inn ? 1 : 0;
    return bb - ab || b.p.backlinkCount - a.p.backlinkCount;
  });
  const shown = all.slice(0, 12 - issues.length);
  const slots = shown.length + issues.length;
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
    const ang = (2 * Math.PI * i) / slots - Math.PI / 2;
    n.x = cx + r * Math.cos(ang);
    n.y = cy + r * Math.sin(ang);
    edges +=
      `<line class="mini-edge${n.out && n.inn ? " both" : ""}"` +
      (n.inn && !n.out ? ' stroke-dasharray="3,3"' : "") +
      ` x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}"/>`;
  });
  shown.forEach((n) => {
    const ly = n.y! + (n.y! >= cy ? 15 : -9);
    // The VISIBLE label and the `<title>` tooltip read one field — they used to
    // read two, so a colliding node's hover said `muninn/MEMORY` while the dot
    // under it said `MEMORY`. A culled neighbour is muted and says so on hover.
    const title = displayTitleOf(n.p);
    nodes += miniNodeHtml(n.p, { x: n.x!, y: n.y!, labelY: ly, label: short(title), title });
  });
  issues.forEach((row, j) => {
    const ang = (2 * Math.PI * (shown.length + j)) / slots - Math.PI / 2;
    const x = cx + r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);
    const inferred = !row.relations.includes("stamped");
    edges +=
      `<line class="mini-edge mini-issue-edge"${inferred ? ' stroke-dasharray="2,3"' : ""}` +
      ` x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    const ly = y + (y >= cy ? 15 : -9);
    nodes +=
      `<g class="mini-node mini-issue${inferred ? " inferred" : ""}" data-prov-jira="${esc(row.key)}" data-mini-issue="${esc(row.key)}">` +
      `<title>${esc(`${trackerLabels[row.tracker] || row.tracker} ${row.key} — ${row.relations.map(relationWord).join(", ")}`)}</title>` +
      `<circle class="mini-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="transparent"></circle>` +
      `<rect class="mini-issue-dot" x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9"` +
      ` transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})"></rect>` +
      `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(row.key)}</text></g>`;
  });
  nodes +=
    `<g class="mini-center"><circle class="mini-dot t-${esc(data.meta.type)}" cx="${cx}" cy="${cy}" r="7"></circle>` +
    `<text x="${cx}" y="${cy + 21}" text-anchor="middle">${esc(short(data.meta.title))}</text></g>`;
  const hiddenIssues = counting.length - issues.length;
  const more = [
    all.length > shown.length ? `strongest ${shown.length} of ${all.length} — full lists below` : "",
    hiddenIssues > 0 ? `+${hiddenIssues} issue${hiddenIssues === 1 ? "" : "s"} not drawn` : "",
  ]
    .filter(Boolean)
    .map((t) => `<div class="wiki-mini-more">${esc(t)}</div>`)
    .join("");
  return `<div class="wiki-mini-graph"><svg viewBox="0 0 ${W} ${H}">${edges}${nodes}</svg>${more}</div>`;
}

// ── Right pane: connections ───────────────────────────────────────────
/** The Related work order this reader picked on this wiki. */
let relatedOrder!: RelatedOrder;

/*
 * Second-hop state for ONE page open, keyed by the hop row's normalized
 * relPath. `resetRelatedHops` runs on every `renderConnections` — a page open,
 * A → start → A, an in-place reload — so a ▸ never shows a cut made against an
 * earlier open, and an answer arriving for an earlier open is dropped by
 * generation. An answer is cached for the open; a failure is shown while the
 * hop stays open and refetched on the next open.
 */
const relatedHops = new Map<string, RelatedHopResponse>();
const relatedHopErrors = new Map<string, RelatedHopResponse>();
const relatedHopsOpen = new Set<string>();
/** One request per hop at a time: a re-click while it is in flight waits on it. */
const relatedHopsInFlight = new Set<string>();
let relatedHopsGen = 0;

function resetRelatedHops(): void {
  relatedHops.clear();
  relatedHopErrors.clear();
  relatedHopsOpen.clear();
  relatedHopsInFlight.clear();
  relatedHopsGen++;
}

/** A hop's render state: `undefined` closed, `null` loading, else its answer. */
function relatedHopState(rel: string): RelatedHopResponse | null | undefined {
  const key = normalizeRel(rel);
  if (!relatedHopsOpen.has(key)) return undefined;
  const answer = relatedHops.get(key) ?? relatedHopErrors.get(key);
  return answer ? { ...answer, related: freshenRelated(answer.related) } : null;
}

/**
 * Related rows with their LISTING fields taken from the listing the rail holds
 * now; only `why`, `strength` and `signals` stay the row's. The block's rows
 * come from the page response, which a series write or a later listing does
 * not re-send. The fresh entry REPLACES the row's listing fields rather than
 * merging over them: `toListing` omits an absent optional key, so a merge kept
 * a `series` (or `seriesLabel`, `culled`, …) the page had since lost.
 */
function freshenRelated(rows: RelatedListing[]): RelatedListing[] {
  const byRel = new Map(allPages.map((p) => [normalizeRel(p.relPath), p]));
  return rows.map((p) => {
    const fresh = byRel.get(normalizeRel(p.relPath));
    return fresh ? { ...fresh, why: p.why, strength: p.strength, signals: p.signals } : p;
  });
}

/** The block's options: the worked axis and instant the rail reads, the order,
 *  the rail's series labels and the open hops. */
function relatedViewOpts(): RelatedViewOptions {
  const labels = seriesLabels(allPages);
  return {
    workedAxis: workedAxisOn,
    ledgerAsOfMs: workedGate?.asOfMs,
    now: recencyNow(),
    order: relatedOrder,
    hops: true,
    seriesLabelOf: (p) => seriesLabelFor(p, labels),
    hopState: relatedHopState,
  };
}

function relatedBlockHtml(data: WikiPageDetail): string {
  return relatedSectionHtml(freshenRelated(data.related ?? []), seriesEditable(), relatedViewOpts());
}

/** Repaint the block alone from `connData` and the listing held now — after an
 *  order pick, a series write, or a flip of the worked-on axis. Open hops stay
 *  open (`hopState`). */
function repaintRelatedBlock(): void {
  const section = document.querySelector("#connBody .wiki-related");
  if (!section || !connData) return;
  section.outerHTML = relatedBlockHtml(connData);
}

/** The reader picked an order: remember it for this wiki and repaint the block
 *  alone, keeping focus on the button pressed. */
function setRelatedOrder(order: RelatedOrder): void {
  relatedOrder = order;
  writeRelatedOrder(WIKI, order);
  repaintRelatedBlock();
  document.querySelector<HTMLButtonElement>(`#connBody [${RELATED_ORDER_ATTR}="${order}"]`)?.focus();
}

/** Paint one hop's ▸ and body from its state, leaving the rest of the block —
 *  and the focus on the ▸ — in place. */
function paintRelatedHop(rel: string): void {
  const sel = CSS.escape(rel);
  const btn = document.querySelector<HTMLButtonElement>(`#connBody .wiki-related [${RELATED_HOP_ATTR}="${sel}"]`);
  const body = document.querySelector<HTMLElement>(`#connBody .wiki-related [${RELATED_HOP_BODY_ATTR}="${sel}"]`);
  if (!btn || !body) return;
  const state = relatedHopState(rel);
  const open = state !== undefined;
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = open ? "▾" : "▸";
  body.hidden = !open;
  const viaRow = connData?.related?.find((p) => p.relPath === rel);
  body.innerHTML = open ? relatedHopHtml(viaRow ? displayTitleOf(viaRow) : rel, state, relatedViewOpts()) : "";
}

/**
 * ▸ on a Related work row: open (or close) THAT page's own related work under
 * the row — `GET /api/wiki/related`, minus the page open now and its
 * attachments. One request per row per page open, in flight or answered.
 */
function toggleRelatedHop(btn: HTMLButtonElement): void {
  const rel = btn.getAttribute(RELATED_HOP_ATTR) || "";
  if (!rel) return;
  const key = normalizeRel(rel);
  if (relatedHopsOpen.has(key)) {
    relatedHopsOpen.delete(key);
    relatedHopErrors.delete(key);
  } else {
    relatedHopsOpen.add(key);
    if (!relatedHops.has(key) && !relatedHopsInFlight.has(key)) fetchRelatedHop(rel, key);
  }
  paintRelatedHop(rel);
}

function fetchRelatedHop(rel: string, key: string): void {
  const open = currentRelPath;
  if (!open) return;
  const gen = relatedHopsGen;
  relatedHopsInFlight.add(key);
  const url =
    "/api/wiki/related?relPath=" +
    encodeURIComponent(rel) +
    "&exclude=" +
    encodeURIComponent(open) +
    "&limit=" +
    RELATED_HOP_LIMIT_DEFAULT;
  const unavailable = (error?: string): RelatedHopResponse => ({ related: [], total: 0, error: error || "unavailable" });
  fetch(withWiki(url))
    .then((r) => r.json() as Promise<RelatedHopResponse>)
    .then((data) => (Array.isArray(data.related) ? data : unavailable(data.error)))
    .catch(() => unavailable())
    .then((answer) => {
      if (gen !== relatedHopsGen) return;
      relatedHopsInFlight.delete(key);
      if (!answer.error) relatedHops.set(key, answer);
      else if (relatedHopsOpen.has(key)) relatedHopErrors.set(key, answer);
      paintRelatedHop(rel);
    });
}

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
          // A culled page stays in Connections, marked (`connItemHtml`).
          html += connItemHtml(p, displayTitleOf(p));
        });
    });
    return html + "</div>";
  }
  // The inline half of the issue rows; the deferred fetch replaces them. A
  // Link lock is not cleared here — see `linkLocks`.
  issueRows = data.issueRows ?? null;
  issueStampable = data.issueStampable === true;
  issueStates.clear();
  issueFocusKey = null;
  connData = data;
  resetRelatedHops();
  document.getElementById("connBody")!.innerHTML =
    issueSectionFor(data.meta?.relPath ?? currentRelPath) +
    miniGraphHtml(data, issueRows) +
    // `Related work` leads: it is the one section that ANSWERS a question
    // ("what else is this piece of work?") rather than listing a mechanism.
    // The two below are the raw link lists it is derived from.
    relatedBlockHtml(data) +
    section("Linked from", data.backlinks) +
    section("Links to", data.outgoing) +
    // Pages committed with this one (D10); absent without git or shared commits.
    movedWithSectionHtml(data.movedWith, displayTitleOf) +
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
  // No Ask route under the read slice: the rail stays on Connections.
  if (!wikiToolsFlag()) tab = "conn";
  // The STALE tab is absent where its routes are (the read slice) and hidden
  // on a read-only instance (D25): the rail stays on Connections there. Decided
  // before the active mark, so only the tab actually shown is marked (A12).
  if (tab === "stale" && !staleTabAvailable()) tab = "conn";
  document.querySelectorAll(".wiki-conn-tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-conntab") === tab);
  });
  const connBody = document.getElementById("connBody");
  const askBody = document.getElementById("askBody");
  const staleBody = document.getElementById("staleBody");
  const ask = tab === "ask";
  const stale = tab === "stale";
  if (connBody) connBody.style.display = ask || stale ? "none" : "";
  if (askBody) askBody.style.display = ask ? "flex" : "none";
  if (staleBody) staleBody.style.display = stale ? "" : "none";
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
  if (wikiReadonlyWikiFlag() || !wikiToolsFlag()) return;
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

// ── Article head: the project hub chip and the series strip ──────────
// (The STALE tab and the stale counts: `wiki-stale-controller.ts`.)

/**
 * The article header's one project affordance: on a project's own hub page,
 * "N pages about <project>" — a way into the rest of it from the page a reader
 * most often lands on first.
 *
 * Rendered ONLY there (`projectHubPage`), and deliberately not on every page
 * carrying a project: a chip on all 497 pages of a wiki is furniture, while the
 * hub page is the one place "there is more of this" is news. `N` comes from the
 * wiki-wide `projects` map — the same number the chip row shows unscoped — so a
 * 0 (a project the listing no longer counts) renders nothing rather than an
 * affordance that would filter to an empty list.
 */
function projectHubChipHtml(m: WikiListing): string {
  const project = projectHubPage(m);
  if (!project) return "";
  const n = projects[project] || 0;
  if (!n) return "";
  return (
    `<button type="button" class="wiki-project-hub" data-project-hub="${esc(project)}"` +
    ` title="Show only this project's pages">${n} page${n === 1 ? "" : "s"} about ${esc(project)}</button>`
  );
}

/** One strip cell's date: the SHOWN instant's day (D22) — on a touched page
 *  (T/T0) its real date, marked, so the strip reads out of order there. */
function stepDateHtml(p: WikiListing, now: number): string {
  const shown = workedShownDay(p, now);
  return shown.touched
    ? `<div class="wiki-series-step-date touched" title="${esc(touchedLine(shown.touched))}">${esc(shown.day)}</div>`
    : `<div class="wiki-series-step-date">${esc(shown.day)}</div>`;
}

/**
 * The SERIES strip under a member's title: what the series is called, how many
 * pages it holds, where to continue, and the members on a date line.
 *
 * Built from `allPages` — the listing the rail already holds — so opening a page
 * costs no extra request. It renders nothing at all for a page carrying no
 * `series:`, which is almost every page of every wiki.
 *
 * Four rules worth stating:
 *
 *  - **Membership is `seriesMembersOf`, never a filter of its own.** This
 *    header and the rail's fold report the same number about the same pages
 *    because they run the same function: it folds the key's case, refuses an
 *    attachment child that happens to carry the key, and applies the successor
 *    test to a retired one. Re-deriving the set here is exactly what made
 *    `N pages` disagree with the fold's `N of M shown`, and let a prototype
 *    carrying a `series_label:` rename the strip. The open page has to be one
 *    of the members, not merely carry the key — see the guard below.
 *  - **`continue at:` never names the open page.** The newest plan IS usually
 *    the page the reader has open (they got here from the latest row), and a link
 *    back to it would be the one useless answer. It names the next-newest plan
 *    instead, and is omitted entirely when there is none. Its label is clipped
 *    to `SERIES_CONTINUE_MAX`, with the whole title one hover away — a wiki
 *    title runs to ~100 characters and an unclipped one took the whole line.
 *  - **The timeline runs oldest → newest**, the opposite of the rail's fold: the
 *    rail answers "where do I go now" and this answers "how did this get here",
 *    which is a story with a beginning. It is the fold's own order REVERSED, so
 *    the two cannot sequence one series two ways.
 *  - **Dates come from `workedShownDay`** — the fold's own day (`workedDateSignal`)
 *    except on a touched page, which prints its real date with a mark (D22) —
 *    the same one the fold's own rows print in their chips, because after the
 *    one-chain fix all three read one signal. Printing a different chain from
 *    the one the order is computed from is what left an mtime-dated member
 *    ordered correctly under a blank date cell, and it is the same trap one rung
 *    up: printing `seriesDateSignal`'s day here would put a `status_date` beside
 *    a row the ledger placed.
 */
function seriesStripHtml(m: WikiListing): string {
  const key = seriesKeyOf(m);
  if (!key) return "";
  // ONE server-anchored instant for the whole strip — the order and every date
  // cell below read it, and the future guard compares against it.
  const now = recencyNow();
  const { members, head } = seriesMembersOf(allPages, key, now);
  const openKey = normalizeRel(m.relPath);
  // The open page must be IN the body this header describes. Carrying the key
  // is not the same as counting: a `superseded` child whose successor is in no
  // series counts nowhere, and a `members.length` test alone painted `N pages`
  // over a timeline the reader's own page was absent from.
  if (!members.some((p) => normalizeRel(p.relPath) === openKey)) return "";
  const label = head?.seriesLabel || (head ? seriesKeyOf(head) : key);
  // The DISPLAY pointer (`seriesContinuePlan`): a retired plan is hidden from
  // the rail, so the strip never sends the reader to one.
  const continueAt = seriesContinuePlan(
    members.filter((p) => normalizeRel(p.relPath) !== openKey),
  );
  // `members` is newest first, the fold's own order; the story reads the other
  // way round. ONE exported spelling of that reversal (`seriesStripOrder`), so
  // the invariant is pinned by a unit test rather than by this line.
  const ordered = seriesStripOrder(members);
  const sep = `<span class="wiki-series-sep" aria-hidden="true">·</span>`;
  let strip =
    `<div class="wiki-series-strip">` +
    `<span class="wiki-series-lbl">Series</span>` +
    `<span class="wiki-series-name">${esc(label)}</span>` +
    sep +
    `<span class="wiki-series-count">${members.length} page${members.length === 1 ? "" : "s"}</span>`;
  if (continueAt) {
    const full = displayTitleOf(continueAt);
    strip +=
      sep +
      `<span class="wiki-series-continue">continue at: ` +
      // A button, not an anchor: the reader is a single page and every other
      // in-article navigation goes through the same delegate.
      `<button type="button" class="wiki-series-go" data-series-go="${esc(continueAt.relPath)}"` +
      ` title="${esc("Open " + full)}">${esc(clipSeriesTitle(full))}</button>` +
      `</span>`;
  }
  // The `edit series` affordance PR A deliberately omitted rather than rendering
  // inert — the function behind it is this PR's. Last in the strip, so it never
  // pushes the label, the count or `continue at:` around; absent (never dimmed)
  // where the write is refused, which is what the read-only acceptance asserts.
  if (seriesEditable() && canEditSeriesPage(m.relPath)) {
    strip += sep + seriesEditBtnHtml(m.relPath);
  }
  strip += `</div>`;
  const steps = ordered
    .map((p) => {
      const isOpen = normalizeRel(p.relPath) === openKey;
      const shipped = p.plan_status === "shipped";
      const kind = [pageFolder(p), p.plan_status].filter(Boolean).join(" · ");
      return (
        `<div class="wiki-series-step${isOpen ? " current" : shipped ? " shipped" : ""}">` +
        stepDateHtml(p, now) +
        `<div class="wiki-series-step-title">${esc(displayTitleOf(p))}${p.culled ? " " + cullMarkHtml() : ""}</div>` +
        `<div class="wiki-series-step-kind">${esc(kind)}</div>` +
        `</div>`
      );
    })
    .join("");
  return `<div class="wiki-series-head">${strip}<div class="wiki-series-tl">${steps}</div></div>`;
}

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
function closeSeriesMenu(cause: PopCloseCause): void {
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
  const model = buildSeriesMenu(allPages, relPath, recencyNow());
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
    open: openPageAtLoad(),
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

/** The open page as loaded, the snapshot both series writers compare its
 *  fresh base with (`writeSeriesUnlessOpenChanged`). */
function openPageAtLoad(): OpenPageAtLoad {
  return { relPath: currentRelPath, loadedHash: currentPageHash };
}

/** The open page keeps a CURRENT hash rather than a stale one when the
 *  reader's own series write moved it: the answer says where to. */
function adoptOwnSeriesHashes(hashes: ReadonlyMap<string, string>): void {
  for (const [rel, hash] of hashes) {
    if (currentRelPath && normalizeRel(currentRelPath) === normalizeRel(rel)) currentPageHash = hash;
  }
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
  return readSeriesBasesAfterWrites([...targets], seriesBaseHash, openPageAtLoad).then(({ bases, open, stalled }) => {
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
const seriesBaseHash = seriesBaseReader((relPath) => withWiki(`/api/wiki/page?relPath=${encodeURIComponent(relPath)}`));
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
      if (out.refusal === null) adoptOwnSeriesHashes(out.run.hashes);
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
        const copy = seriesConflictCopy(run.failure.write.relPath, currentRelPath);
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
async function refreshAfterSeriesWrite(): Promise<ReceiveOutcome | "error"> {
  // Bounded: both popovers hold their busy state across this await. A late
  // answer still lands through the listing's own sequence discipline.
  const outcome = await withinSeriesBound(requestPagesAwaited({ refresh: true, force: true }), "error");
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
  if (!currentRelPath) return;
  const host = document.querySelector<HTMLElement>(".wiki-article-head");
  if (!host) return;
  const key = normalizeRel(currentRelPath);
  const meta = allPages.find((p) => normalizeRel(p.relPath) === key);
  const html = meta ? seriesStripHtml(meta) : "";
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

// ── Loading a page: the article head, explainers, the page fetch ──────
/**
 * The retired banner for the open page, or "". Reads `cullReason` and
 * `supersededBy`, which only the single-page payload carries — an explainer's
 * head renders from the listing first and gets its banner when that lands
 * (`placeRetiredBanner`). The server sends `supersededBy` only when the
 * successor resolves, so no link is drawn for an unresolved one; the title
 * comes from the listing, and the relPath stands in only when a listing older
 * than the page payload does not hold it yet.
 */
function retiredBannerHtml(m: WikiListing): string {
  if (!m.culled) return "";
  const rel = m.supersededBy;
  const hit = rel ? findPageByRelPath(allPages, rel) : undefined;
  return cullBannerHtml(
    m,
    rel ? { relPath: rel, title: hit ? displayTitleOf(hit) : rel, href: pageUrlByRelPath(rel) } : undefined,
  );
}

/** Re-render the banner in an already-painted head (the explainer path): the
 *  head drew it from the listing, which carries no reason or successor. */
function placeRetiredBanner(m: WikiListing): void {
  const head = document.querySelector("#articleWrap .wiki-article-head");
  if (!head) return;
  head.querySelector(".wiki-cull-banner")?.remove();
  const html = retiredBannerHtml(m);
  if (html) head.insertAdjacentHTML("afterbegin", html);
}

/**
 * Article-head block (title, badges, tags, dates, source link) — shared by
 * markdown pages and HTML explainers.
 *
 * `provenancePending` is the SINGLE-PAGE payload's flag and is therefore
 * optional: the explainer path renders this head before its `/api/wiki/page`
 * response lands (and an HTML explainer carries no frontmatter to stamp in the
 * first place), so it passes nothing and renders no strip. A page the stamper
 * has not touched carries no `provenancePending` key at all, which is the one
 * gate — never `false`, so there is no "is it set" question to get wrong. The
 * strip rendered here is the PLACEHOLDER; `loadProvStrip` fills it once the
 * page is on screen.
 */
function articleHeadHtml(m: WikiListing, provenancePending?: boolean): string {
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
    `<div class="wiki-article-head">${retiredBannerHtml(m)}<h1>${esc(displayTitleOf(m))}</h1>${subtitle}<div class="wiki-meta-row">` +
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
  head += projectHubChipHtml(m);
  // The Stale check's pill (PR 2b), painted from the open page's report.
  if (staleTabAvailable()) head += `<span id="wikiStalePill" class="wiki-stale-pill-slot"></span>`;
  // Graph mode's toggle, on a wiki with a tracker only.
  if (hasTracker()) head += graphToggleHtml(displayState().graph);
  // The meta row closes first: the strip is a BLOCK under it (the Jira row plus
  // one line of cost), not another chip competing with the tags and dates.
  head += "</div>";
  // The SERIES strip sits above the provenance one, in the same slot and for the
  // same reason: it is a block about the page's place in the work, not a chip.
  // Above, because "which piece of work is this" is the question a reader lands
  // on the page with, and provenance is the one they ask afterwards.
  head += seriesStripHtml(m);
  // `jiraKeys` is the facet's membership set, and the strip's key is a SECOND
  // way into that facet — so the strip renders a control only for a key the
  // facet can actually serve (see `provStripHtml`).
  // The placeholder only where a strip is certain — see `provPendingHtml`.
  // A `prs:`-only page still fetches; its strip, if any, is inserted on arrival.
  if (provenancePending && provenanceStripCertain(m)) head += provPendingHtml();
  head += "</div>";
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
  // An explainer has no lens: a `?lens=` is spent, and a plan-card run dropped.
  consumeUrlLens();
  abortAgentRuns();
  setAtlasFull(false);
  setCurrentName(m.name);
  // The listing IS the identity here (no page response to wait for), so the
  // active-row test gets its relPath immediately.
  setCurrentRelPath(m.relPath);
  /** This view's number: a later view drops this page's response (R2B4). */
  const seq = pageViewSeq;
  navInFlight = false; // `currentName` now carries the "article" signal on its own
  if (push) {
    graphIssue = ""; // a click opens a page: graph mode re-roots on it
    history.pushState({ relPath: m.relPath }, "", pageUrlByRelPath(m.relPath));
  }
  renderBreadcrumb(m);
  // relPath on all three fetches: two explainers in different folders can share a
  // stem, and `?name=` would serve/describe whichever registered first.
  const src = withWiki("/api/wiki/html?relPath=" + encodeURIComponent(m.relPath));
  document.getElementById("articleWrap")!.innerHTML =
    articleHeadHtml(m) +
    `<iframe class="wiki-explainer-frame" src="${esc(src)}" sandbox="${EXPLAINER_SANDBOX}" title="${esc(m.title)}"></iframe>`;
  document.getElementById("articleWrap")!.scrollTop = 0;
  applyDisplay();
  document.getElementById("connBody")!.innerHTML = '<div class="wiki-conn-empty">Loading…</div>';
  fetch(withWiki("/api/wiki/page?relPath=" + encodeURIComponent(m.relPath)))
    .then((r) => r.json())
    .then((data: WikiPageDetail) => {
      // A fast page flip may have moved on — don't clobber the new page's panel.
      if (seq !== pageViewSeq) return;
      if (data.error) {
        staleForFailedPage();
        return;
      }
      // Re-stamp from the SINGLE-PAGE payload: the listing this render started
      // from came out of `/api/wiki/pages`, which strips `desc` (and an
      // explainer's `description` is sniffed, not always in the listing).
      if (data.meta) currentArticle = data.meta;
      if (data.meta) placeRetiredBanner(data.meta);
      renderConnections(data);
      // The same gate as a markdown page: an explainer with inferred keys has
      // provenance too. Its head rendered before this payload, so the strip is
      // inserted when the block lands (`placeProvStrip`), with no placeholder.
      if (data.provenancePending) void loadProvStrip(m.relPath);
      loadSimilar(m);
      loadStale(m.relPath);
    })
    .catch(() => {
      if (seq !== pageViewSeq) return;
      document.getElementById("connBody")!.innerHTML =
        '<div class="wiki-conn-empty">Connections unavailable.</div>';
      staleForFailedPage();
    });
  setRevealOnRender(true);
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

function loadPage(name: string, push: boolean, revealHash = true): void {
  hideExplainPill(); // a page switch drops any stale pill from the prior page
  // Raised BEFORE anything else: `currentName` is only set from the response, so
  // without this signal the whole round-trip reads as the "start" view and a
  // refetch resolving mid-click would re-sort the list under the row just clicked.
  navInFlight = true;
  // A navigation is a re-render anyway, so a stashed page set lands here too —
  // and it must land BEFORE the explainer lookup below reads `allPages`.
  applyPendingPages();
  // `findPageByName`, not a raw `name ===` scan: the listing is relPath-ordered,
  // so a page's own same-stem diagram (`plans/y.html` before `plans/y.md`) was
  // the first match and this branch opened the DIAGRAM for `?page=y`, for an Ask
  // citation and for a chat wiki citation. The server's `index.resolve(name)`
  // answers the markdown page — an attachment registers no stem key — so the
  // route below would have loaded the page the iframe was covering.
  const listing = findPageByName(allPages, name);
  if (listing && listing.type === "explainer") {
    loadExplainer(listing, push);
    return;
  }
  fetchAndRenderPage(withWiki("/api/wiki/page?name=" + encodeURIComponent(name)), push, revealHash);
}

/** Open a page by its exact relPath — the collision-proof route, and now the
 *  DEFAULT for every in-reader click (every row/card/rail/wikilink emits a
 *  `data-relpath`). The by-`name` route resolves first-stem-match, which on a wiki
 *  with same-stem pages opens the wrong page entirely. The relPath rides into the
 *  pushed history entry so Back/reload/share re-resolve the SAME page;
 *  `push=false` on popstate/boot replays without re-pushing. */
function loadPageByRelPath(relPath: string, push = true, revealHash = true): void {
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
  fetchAndRenderPage(withWiki("/api/wiki/page?relPath=" + encodeURIComponent(relPath)), push, revealHash);
}

/** Shared fetch + article render for both by-name and by-relPath navigation.
 *  History is pushed as `?relPath=<relPath>` off the RESOLVED page (see below), so
 *  the round-trip survives Back/reload/share even where stems collide; a response
 *  carrying no relPath at all falls back to the name-based `?page=<name>` URL. */
function fetchAndRenderPage(url: string, push: boolean, revealHash: boolean): void {
  // The page being left stops boosting a find now: a load that fails (an error
  // payload or a rejected fetch) leaves `currentRelPath` on it.
  currentNear = null;
  // Its Agent pane's plan-card run, if one is in flight, is no longer wanted.
  abortAgentRuns();
  // Taken now, so a load that fails cannot leave it for the next one.
  const inPlace = inPlaceLens;
  // This load's number. A later view (another load, an explainer, the start
  // view, an Ask answer, an issue graph) drops this response whatever it is:
  // a page left behind paints nothing, a late failure clears nothing (R2B4).
  let seq = ++pageViewSeq;
  pageFetchSeq = seq;
  const superseded = () => {
    if (seq === pageViewSeq) return false;
    // Left for a view that fetches nothing: no navigation is in flight now.
    if (pageFetchSeq === seq) navInFlight = false;
    return true;
  };
  fetch(url)
    .then((r) => r.json())
    .then((data: WikiPageDetail) => {
      if (superseded()) return;
      // Restore the 3-pane layout on every outcome — an error rendered into
      // #articleWrap has replaced the atlas, so the panes must come back too.
      setAtlasFull(false);
      navInFlight = false;
      if (data.error) {
        removeGraph();
        // A `?lens=` is for the first page this view renders; a failed one
        // spends it, so a later page never opens in a lens its URL did not name.
        consumeUrlLens();
        document.getElementById("articleWrap")!.innerHTML =
          `<div class="wiki-empty-state">${esc(data.error)}</div>`;
        // The breadcrumb is the previous page's; its lens chip goes with that article.
        removeLensChip(document.getElementById("wikiBreadcrumb"));
        // Its stale report goes with it: the tab says the page did not load (A12).
        staleForFailedPage();
        // The PREVIOUS page's `currentName` deliberately survives a failed load, so
        // the view state keeps reading "article" and a refresh keeps deferring
        // until the reader navigates somewhere that succeeds or returns to start.
        // Erring toward "don't re-sort" is the right direction; the nav flag is
        // cleared above so it isn't a second, permanent reason to defer.
        renderList(); // the facets may have moved under us via applyPendingPages
        return;
      }
      setCurrentName(data.meta.name);
      // The RESPONSE's relPath, not the requested one: a by-name navigation
      // resolves server-side, and the active row must key on the page that
      // actually came back.
      setCurrentRelPath(data.meta.relPath || null);
      seq = pageViewSeq; // that view change is this load's own
      currentPageHash = typeof data.hash === "string" ? data.hash : null;
      currentNear = currentRelPath ? { relPath: currentRelPath, near: data.near ?? {} } : null;
      renderBreadcrumb(data.meta);
      if (push) {
        graphIssue = ""; // a click opens a page: graph mode re-roots on it
        // Push the resolved relPath whenever we have one, even for a by-name
        // navigation — that is what makes reload/Back/share land on the SAME page
        // instead of re-resolving the stem to the first registration.
        if (currentRelPath) {
          history.pushState({ relPath: currentRelPath }, "", pageUrlByRelPath(currentRelPath));
        } else {
          history.pushState({ page: getCurrentName() }, "", pageUrl(getCurrentName()!));
        }
      }
      // Blog pages get explainer-ish article chrome: an accent-tinted scope
      // (`.wiki-article-blog` + a per-page accent style block) plus the subtitle
      // rendered in `articleHeadHtml`. Non-blog pages render exactly as before.
      const isBlog = data.meta.type === "blog";
      const articleClass = isBlog ? "wiki-article wiki-article-blog" : "wiki-article";
      const accentBlock = isBlog ? blogAccentStyleBlock(data.meta) : "";
      document.getElementById("articleWrap")!.innerHTML =
        accentBlock +
        articleHeadHtml(data.meta, data.provenancePending) +
        `<div class="${articleClass}">${data.html}</div>`;
      document.getElementById("articleWrap")!.scrollTop = 0;
      // The provenance join runs behind the placeholder, never in front of the
      // article: `/api/wiki/page` no longer waits on claude-usage and huginn.
      if (data.provenancePending && currentRelPath) void loadProvStrip(currentRelPath);
      // Client-side enhancement: upgrade any ```mermaid fences to inline SVG.
      // No-op (zero mermaid bytes) for pages without a mermaid fence. Covers
      // every navigation path — direct clicks, popstate, and boot deep-link all
      // funnel through loadPage. (The Ask/Explain answer replaces #articleWrap
      // with its own markup, so rendered diagrams disappear with it — not hooked.)
      enhanceMermaid(document.getElementById("articleWrap")!);
      const articleRoot = document.getElementById("articleWrap")!;
      enhanceCodeTabs(articleRoot);
      enhanceCodeBlocks(articleRoot);
      // `<Embed src>` → sandboxed iframe, resolved against THIS page's relPath.
      // No-op on a page without one.
      enhanceEmbeds(articleRoot, data.meta.relPath, withWiki);
      // Header's `↻ N historic` pill, the counted pills (decisions, open,
      // queries, cases) and the `line refs` toggle, all counted off the
      // rendered article. No-op on a page with none of them.
      const reader = data.reader;
      const readerLang = reader?.language ?? DEFAULT_QUESTION_LANGUAGE;
      enhanceReportBlocks(articleRoot, { language: readerLang, idLabels: reader?.idLabels, roles: reader?.roles });
      // `<Query>` result tables: header-click sorting. No-op without one.
      enhanceQueryTables(articleRoot);
      // Two or more adjacent `<Query>` cards: a search box and `uses` chips.
      enhanceQueryExplorer(articleRoot);
      // Fact-check layer: chip → evidence card, the summary strip, and the
      // layer toggle. No-op on a page carrying no annotation.
      enhanceFactCheck(document.getElementById("articleWrap")!);
      // Bare ids (D4, Q-8) and quoted section titles → links with a peek card.
      // After the fact-check layer, which anchors marks on the text as served;
      // before the hash reveal, which needs the fold and heading ids it adds.
      enhanceRefLinks(articleRoot, data.meta.relPath, reader?.idLabels);
      // 🧭 on each top-level section heading. After the ref links, which index
      // heading text: the button's own glyph must not join that text.
      if (data.meta.relPath) {
        const wtRelPath = data.meta.relPath;
        enhanceWalkthroughButtons(articleRoot, {
          relPath: wtRelPath,
          hash: () => currentPageHash,
          withWiki,
          reload: () => reloadPageInPlace(wtRelPath),
        });
      }
      // The lens (D2's precedence): a `?lens=` the page was opened with, once,
      // then the viewer's stored choice, then the page's default. Before the
      // hash reveal, whose REVEAL_EVENT switches a hidden target's view to All.
      const keptLens = inPlace && inPlace.relPath === data.meta.relPath ? inPlace.lens : null;
      enhanceLens(articleRoot, {
        language: readerLang,
        agentAvailable: reader?.agentLens === true,
        // The Agent pane's page: the registry name, as the answer cards send it.
        // An in-place reload in Agent carries the pane over instead of running.
        agent: {
          wiki: FIND_SELF_WIKI || WIKI,
          relPath: data.meta.relPath,
          language: readerLang,
          carry: keptLens === "agent" ? (inPlace?.agent ?? { since: "", id: "", card: null }) : undefined,
        },
        inPlace: keptLens !== null,
        chipHost: document.getElementById("wikiBreadcrumb"),
        initial: resolveLens({
          url: pendingUrlLens,
          inPlace: keptLens,
          stored: storedLens(),
          pageDefault: reader?.defaultLens ?? null,
          agentAvailable: reader?.agentLens === true,
        }),
      });
      consumeUrlLens();
      // D20: the items dated after this tab's baseline visit, and whether the
      // page changed since. Any render — an in-place reload after the reader's
      // own write included — keeps the tab's baseline and stores this visit.
      if (data.meta.relPath) {
        const changedMs = pageTimeMs(data.meta, recencyNow());
        enhanceNewSince(articleRoot, {
          wiki: FIND_SELF_WIKI || WIKI,
          relPath: data.meta.relPath,
          language: readerLang,
          changedMs: changedMs > 0 ? changedMs : null,
        });
      }
      const renderedEl = articleRoot.querySelector(".wiki-article");
      renderedArticle = currentRelPath && renderedEl ? { relPath: currentRelPath, el: renderedEl } : null;
      // The pill and marks from the report already held for this page (an
      // in-place reload); the report this render loads repaints them.
      paintStaleSurfaces();
      // `<Question>` cards: answers, composer and edit, on a wiki that takes
      // answers only. After the ref links, so an answer's text is never linked.
      // The registry name, not `WIKI`: under the `WIKI_DIR` override `WIKI` is
      // "" while the answer routes still need the served wiki's own name.
      const answerCards = enhanceAnswerCards(articleRoot, data.answers, {
        wiki: FIND_SELF_WIKI || WIKI,
        relPath: data.meta.relPath,
      });
      // D38: each waiting lane's «N av M besvart», kept current by the cards.
      bindLaneProgress(articleRoot, answerCards);
      // The admin's "Copy new answers (N)" / "Copy again", in the breadcrumb
      // row beside the other page-level actions; removed when the viewer may
      // not export or the page has no answerable card.
      mountAnswerExport(document.getElementById("wikiBreadcrumb"), answerCards, data.answers, {
        wiki: FIND_SELF_WIKI || WIKI,
        relPath: data.meta.relPath,
        lang: parseQuestionLanguage(
          articleRoot.querySelector("section.question[data-question-lang]")?.getAttribute("data-question-lang") ?? undefined,
        ).language,
      });
      applyDisplay();
      // A `#id` in the URL (a shared `#q-8`): open the folds around it, scroll to
      // it. Not on an in-place reload (`reloadPageInPlace`): the URL keeps the
      // hash, and the reader may have closed that fold since.
      if (revealHash) revealHashTarget(articleRoot);
      renderConnections(data);
      // Lazy: fetch semantic cousins after the page + connections are on screen,
      // so it never blocks the article render.
      loadSimilar(data.meta);
      loadStale(data.meta.relPath);
      setRevealOnRender(true);
      renderList();
    })
    .catch((err: Error) => {
      if (superseded()) return;
      setAtlasFull(false);
      navInFlight = false;
      removeGraph();
      consumeUrlLens();
      document.getElementById("articleWrap")!.innerHTML =
        `<div class="wiki-empty-state">Failed to load page: ${esc(err.message)}</div>`;
      removeLensChip(document.getElementById("wikiBreadcrumb"));
      staleForFailedPage();
      renderList();
    });
}

// ── Graph mode ────────────────────────────────────────────────────────
/** What the graph is rooted at: the issue named by `issue=`, else the open page. */
function graphRoot(): { scope: "page" | "issue"; root: string } | null {
  if (graphIssue) return { scope: "issue", root: graphIssue };
  if (currentRelPath) return { scope: "page", root: currentRelPath };
  return null;
}

/**
 * Show or hide the graph to match {@link displayState}. The article stays in
 * the DOM under the graph (hidden, not replaced), so turning graph mode off is
 * instant, and the article's scroll position is put back where it was.
 */
function applyDisplay(): void {
  const wrap = document.getElementById("articleWrap");
  if (!wrap) return;
  const on = displayState().graph && graphRoot() !== null;
  const wasOn = !!document.getElementById(GRAPH_SECTION_ID);
  const toggle = document.getElementById(GRAPH_TOGGLE_ID);
  if (toggle) {
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (on && !wasOn) readingScrollTop = wrap.scrollTop;
  // One class on the pane, not one per child: a child built while graph mode
  // is on (an Agent pane from the lens switch) is hidden by the same CSS rule.
  wrap.classList.toggle(GRAPH_ON_CLASS, on);
  if (!on) {
    removeGraph();
    if (wasOn) wrap.scrollTop = readingScrollTop;
    return;
  }
  if (!wasOn) wrap.scrollTop = 0;
  loadGraph();
}

/** Tear the graph down: its fetch, its observer, its section. Every path that
 *  replaces the article pane calls it. */
function removeGraph(): void {
  graphSeq++;
  graphAbort?.abort();
  graphAbort = null;
  graphData = null;
  graphAdj = null;
  graphLitId = null;
  graphCardId = null;
  graphResize?.disconnect();
  graphResize = null;
  document.getElementById(GRAPH_SECTION_ID)?.remove();
  document.getElementById("articleWrap")?.classList.remove(GRAPH_ON_CLASS);
}

function loadGraph(): void {
  const r = graphRoot();
  const wrap = document.getElementById("articleWrap");
  if (!r || !wrap) return;
  const existing = document.getElementById(GRAPH_SECTION_ID);
  if (existing) existing.outerHTML = graphLoadingHtml();
  else wrap.insertAdjacentHTML("beforeend", graphLoadingHtml());
  graphResize?.disconnect();
  graphResize = null;
  graphData = null;
  graphAdj = null;
  graphLitId = null;
  graphCardId = null;
  graphAbort?.abort();
  graphAbort = null;
  const seq = ++graphSeq;
  const d = graphDefaults(r.scope, graphLevel ?? undefined);
  const level = graphLevel ?? d.level;
  const depth = graphDepth ?? d.depth;
  const rootLabelFor = (body: GraphPayload): string => {
    if (r.scope === "issue") return parseIssueRoot(r.root)?.key ?? r.root;
    const rootNode = body.nodes.find((n) => n.hop === 0);
    return rootNode && rootNode.lane === "page" ? rootNode.title : r.root;
  };
  const paint = (html: string) => {
    if (seq !== graphSeq) return false;
    const el = document.getElementById(GRAPH_SECTION_ID);
    if (!el) return false;
    el.outerHTML = html;
    return true;
  };
  const show = (body: GraphPayload) => {
    if (!paint(graphHtml(body, { level, depth, rootLabel: rootLabelFor(body) }))) return;
    graphData = body;
    layoutGraph();
  };
  const abort = new AbortController();
  graphAbort = abort;
  fetch(
    withWiki(`/api/wiki/graph?scope=${r.scope}&root=${encodeURIComponent(r.root)}&depth=${depth}&level=${level}`),
    { signal: abort.signal },
  )
    .then(async (res) => ({ ok: res.ok, body: (await res.json()) as GraphPayload & { error?: string } }))
    .then(({ ok, body }) => {
      if (graphAbort === abort) graphAbort = null;
      if (!ok || body.error) {
        paint(graphErrorHtml(body.error || "Graph unavailable."));
        return;
      }
      show(body);
    })
    .catch(() => {
      if (abort.signal.aborted) return; // superseded or torn down: nothing to say
      paint(graphErrorHtml("Graph unavailable."));
    });
}

/** Draw the edges once the lanes are laid out, and again whenever the canvas
 *  changes size (the rail, the right pane, the window) — re-lighting whatever
 *  was lit, since a redraw replaces every edge element. */
function layoutGraph(): void {
  const section = document.getElementById(GRAPH_SECTION_ID);
  if (!section || !graphData) return;
  const edges = graphData.edges;
  graphAdj = graphAdjacency(graphData);
  const redraw = () => {
    drawGraphEdges(section, edges);
    paintLit(section);
  };
  redraw();
  const canvas = section.querySelector<HTMLElement>(".wiki-graph-canvas");
  if (canvas && typeof ResizeObserver !== "undefined") {
    graphResize = new ResizeObserver(redraw);
    graphResize.observe(canvas);
  }
}

/** Light a node's neighbourhood and its path to the root; `null` falls back to
 *  the node whose card is open, else clears. */
function lightGraph(id: string | null): void {
  const next = id ?? graphCardId;
  if (next === graphLitId) return;
  graphLitId = next;
  const section = document.getElementById(GRAPH_SECTION_ID);
  if (section) paintLit(section);
}

function paintLit(section: HTMLElement): void {
  const lit = graphLitId && graphAdj ? graphLit(graphAdj, graphLitId) : null;
  section.classList.toggle("hovering", !!lit);
  section.querySelectorAll<HTMLElement>(`[${GRAPH_NODE_ATTR}]`).forEach((el) => {
    el.classList.toggle("lit", !!lit && lit.nodes.has(el.getAttribute(GRAPH_NODE_ATTR) || ""));
  });
  section.querySelectorAll<SVGPathElement>(".wiki-graph-edge").forEach((el) => {
    el.classList.toggle("lit", !!lit && lit.edges.has(el.getAttribute("data-edge") || ""));
  });
}

function graphNodeEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${GRAPH_SECTION_ID} [${GRAPH_NODE_ATTR}="${CSS.escape(id)}"]`);
}

/** Open a node's card and move focus into it; its node stays lit. */
function openGraphCard(id: string): void {
  const node = graphData?.nodes.find((n) => n.id === id);
  const card = document.getElementById(GRAPH_CARD_ID);
  if (!node || !card) return;
  card.innerHTML = graphCardHtml(node, { isRoot: node.hop === 0 });
  card.hidden = false;
  graphCardId = id;
  document.querySelectorAll<HTMLElement>(`#${GRAPH_SECTION_ID} [${GRAPH_NODE_ATTR}]`).forEach((el) => {
    el.classList.toggle("selected", el.getAttribute(GRAPH_NODE_ATTR) === id);
  });
  lightGraph(id);
  card.focus();
}

/** Close the card and give focus back to the node it was opened from. */
function closeGraphCard(): void {
  const card = document.getElementById(GRAPH_CARD_ID);
  if (card) card.hidden = true;
  const from = graphCardId;
  graphCardId = null;
  document.querySelectorAll(`#${GRAPH_SECTION_ID} .wiki-graph-node.selected`).forEach((el) => el.classList.remove("selected"));
  if (from) graphNodeEl(from)?.focus();
}

/** Write the display state into the address bar as a NEW entry, so Back
 *  returns to the previous mode or root. */
function pushDisplay(): void {
  history.pushState(history.state, "", location.pathname + searchWithDisplay(location.search, displayState()) + location.hash);
}

/** The toggle and `g`. Off from an issue-only graph (no page open) goes to the
 *  overview and pushes its URL, which carries no `display=`. */
function toggleGraph(): void {
  if (!hasTracker()) return;
  const on = !displayState().graph;
  if (!on && !currentRelPath) {
    graphMode = false;
    graphIssue = "";
    goToStart();
    return;
  }
  graphMode = on;
  if (!on) graphIssue = "";
  pushDisplay();
  applyDisplay();
}

/** Focus here: an issue node roots the graph at the issue; a page node opens
 *  that page, still in graph mode, rooted at it. */
function focusGraphNode(id: string): void {
  const node = graphData?.nodes.find((n) => n.id === id);
  if (!node) return;
  if (node.lane === "issue") {
    graphIssue = `${node.tracker}:${node.key}`;
    pushDisplay();
    if (currentRelPath) applyDisplay();
    else renderIssueGraph();
  } else if (node.lane === "page") {
    loadPageByRelPath(node.relPath, true);
  }
}

/** `?display=graph&issue=jira:KEY` with no page open: the issue's own head and
 *  its graph fill the article pane. */
function renderIssueGraph(): void {
  consumeUrlLens();
  abortAgentRuns();
  const wrap = document.getElementById("articleWrap");
  const root = parseIssueRoot(graphIssue);
  if (!wrap || !root) return;
  setAtlasFull(false);
  setCurrentName(null);
  setCurrentRelPath(null);
  currentPageHash = null;
  hideBreadcrumb();
  removeGraph();
  wrap.innerHTML =
    `<div class="wiki-article-head"><h1>${esc(root.key)}</h1><div class="wiki-meta-row">` +
    `<span class="wiki-dates">${esc(trackerLabels[root.tracker] || root.tracker)} issue</span>${graphToggleHtml(true)}</div></div>`;
  wrap.scrollTop = 0;
  const conn = document.getElementById("connBody");
  if (conn) conn.innerHTML = '<div class="wiki-conn-empty">No page open.</div>';
  applyDisplay();
}

const GRAPH_NODE_SEL = `#${GRAPH_SECTION_ID} [${GRAPH_NODE_ATTR}]`;
/**
 * Does another Escape owner hold this keypress? The card's listener runs in the
 * capture phase and stops propagation, so every other owner — all bubble-phase —
 * would never see Escape while the card is open. It stands aside for: an open
 * dialog or menu anywhere (Share, Discuss, the series ★ menu, a native dialog —
 * page-wide, so it also covers a target inside one); the Explain pill (the
 * Fact check button only ever shows beside it); the header's Tools menu.
 */
function escapeOwnedElsewhere(): boolean {
  return (
    modalOpen(document) ||
    (document.getElementById("wikiExplainBtn")?.getClientRects().length ?? 0) > 0 ||
    navMenuOpen(document)
  );
}

// ── The URL lens: `?lens=` is spent by the first view that renders ────
function consumeUrlLens(): void {
  if (pendingUrlLens === null) return;
  pendingUrlLens = null;
  const u = new URL(location.href);
  if (!u.searchParams.has(LENS_PARAM)) return;
  u.searchParams.delete(LENS_PARAM);
  history.replaceState(history.state, "", u);
}

// ── Article share and in-place reload (left in the shell for C5) ──────
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

/** Reload one page in place (no history entry, no hash reveal), keeping the
 *  lens its view showed. Shared by a fact-check write and the walkthrough
 *  panel's Reload on a stale page. */
function reloadPageInPlace(relPath: string | undefined, name?: string): void {
  const lens = renderedArticle && renderedArticle.relPath === relPath ? lensOf(renderedArticle.el) : null;
  inPlaceLens = lens
    ? { relPath: renderedArticle!.relPath, lens, ...(lens === "agent" ? { agent: snapshotAgentPane(renderedArticle!.el) } : {}) }
    : null;
  try {
    if (relPath) loadPageByRelPath(relPath, false, false);
    else if (name) loadPage(name, false, false);
  } finally {
    // The load took its copy synchronously; no later load may read it.
    inPlaceLens = null;
  }
}

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
  if (!getCurrentName()) return hideExplainPill();
  // `currentArticle` — the listing the OPEN page was rendered from — never an
  // `allPages` lookup by name: that lookup is first-match-on-stem, so on a wiki
  // with same-stem pages it answered about a DIFFERENT page (wrong type, wrong
  // title, wrong everything the caller then acted on).
  const meta = currentArticle;
  if (meta && meta.type === "explainer") return hideExplainPill();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideExplainPill();
  // Without the reader's own text (id nouns, fold sizes): the server locates
  // this in the page source, which has none of it.
  const text = readerSelectionText(sel).trim();
  if (text.length < EXPLAIN_MIN_CHARS || text.length > EXPLAIN_MAX_CHARS) return hideExplainPill();
  const wrap = document.getElementById("articleWrap");
  const anchor = sel.anchorNode;
  if (!wrap || !anchor || !wrap.contains(anchor)) return hideExplainPill();
  // Never from the graph (its card included), which shares `#articleWrap`.
  const graph = document.getElementById(GRAPH_SECTION_ID);
  if (graph && (graph.contains(anchor) || (sel.focusNode && graph.contains(sel.focusNode)))) return hideExplainPill();
  const range = sel.getRangeAt(0);
  pillSel = text;
  pillHeading = nearestHeading(range);
  showExplainPill();
}

function activateExplain(): void {
  hideExplainPill();
  if (!pillSel || !getCurrentName()) return;
  const explainMeta = currentArticle;
  const turn: AskTurn = {
    question: explainLabel(pillSel),
    // The page the passage was read on. The question is only a display LABEL, so
    // without this an escalated Explain turn names neither the page nor the real
    // question (`composeDeclineQuestion`). Title where there is one — it is what
    // wikilinks and the bot's own notes search use.
    explainPage: explainMeta?.title || getCurrentName()!,
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(),
  };
  const url = buildExplainUrl({
    sel: pillSel,
    page: getCurrentName()!,
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
  if (!pillSel || !getCurrentName()) return;
  const selMeta = currentArticle;
  const turn: AskTurn = {
    question: factcheckLabel(pillSel),
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(), kind: "factcheck",
    page: getCurrentName()!, pageType: selMeta ? selMeta.type : undefined,
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
    page: getCurrentName()!,
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
  if (!getCurrentName()) return;
  const meta = currentArticle;
  const turn: AskTurn = {
    question: factcheckLabel("", meta ? displayTitleOf(meta) : getCurrentName()!),
    answer: "", citations: [], cited: [], html: null, askedAt: Date.now(), kind: "factcheck",
    page: getCurrentName()!, pageType: meta ? meta.type : undefined,
    fcMode: "article", // the ↻ retry re-issues the same mode (see activateFactcheckSel)
    ...(currentRelPath ? { pageRelPath: currentRelPath } : {}),
  };
  const url = buildFactcheckUrl({
    mode: "article",
    page: getCurrentName()!,
    ...(currentRelPath ? { relPath: currentRelPath } : {}),
    wiki: WIKI,
  });
  runAskStream(url, turn);
}

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

/** The listing's `workMap.kind === "themes"`, set by `setPagesData`: View options
 *  and the effort page then say theme. Read by the rail and the effort page through their ports. */
let workMapThemes = false;
/** The work threads off the last listing (`work`, set by `setPagesData`), or
 *  null (an older server, a cold sessions memo, no sessions: no section, D11),
 *  never the last known value: stale threads would lift pages the listing no
 *  longer works on. Read by the rail and the ⋯ menus through their ports. */
let workFacts: WorkFacts = null;

/** What the middle pane is showing right now — see `viewStateOf` for the rules.
 *  An Ask/Explain/Fact-check answer nulls `currentName` but is just as much
 *  "someone is reading" as an article; its body element is the only signal that
 *  survives (`askShownTurn` is never cleared on navigation). */
function currentViewState() {
  return viewStateOf(getCurrentName(), navInFlight, !!document.getElementById("askAnswerBody"));
}

/** Swap in a page set + everything else the payload carries. Data only — paints
 *  nothing; `adoptPagesAndRender`/`bootRender` own the painting.
 *
 *  `boot` is passed through to `adoptProjectFilter`: only the boot render (and a
 *  boot heal) may read `?project=` off the address bar. */
function setPagesData(data: WikiPagesResponse, boot = false): void {
  allPages = data.pages;
  pagesLoaded = true;
  // Anchor every recency read to the server's scan instant BEFORE the first render
  // (`recencyNow`) — a viewer clock running >48h slow would otherwise trip the
  // future-date guard on every frontmatter-dated page in the wiki at once.
  scannedAtMs = typeof data.scannedAt === "number" ? data.scannedAt : null;
  applyWorkedSortOption(data.workedCoverage);
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
  // Same degrade rule again. Re-parsed rather than trusted: the route already
  // resolves the block, but `parseActivityWeights` is the one place that knows
  // what a knob may be, and running it here costs nothing and cannot be wrong.
  if (data.activity && typeof data.activity === "object") {
    activityWeights = parseActivityWeights(data.activity).weights;
  }
  // Re-parsed per field for the same reason; an absent block keeps the defaults.
  if (data.cullLabels && typeof data.cullLabels === "object") setCullLabels(data.cullLabels);
  // After the weights (it reads `workedGate`) and after `scannedAtMs` (so
  // `recencyNow()` is anchored).
  workedGate = workedGateFor(data.pages, activityWeights, recencyNow(), data.workedCoverage?.asOfMs);
  // Shape-checked thread by thread in `openThreadCards` (`usableThreads`).
  workFacts = data.work && typeof data.work === "object" && Array.isArray(data.work.threads) ? data.work : null;
  setWorkMapRunAt(typeof data.workMap?.runAt === "number" ? data.workMap.runAt : null);
  waitsCounted = data.waitsCounted === true;
  workMapThemes = getWorkMapRunAt() !== null && data.workMap?.kind === "themes";
  // NOT the "keep the last known value" degrade the three above use: this map is
  // the membership set a `?project=` link is judged against, and a stale one
  // would admit a project the listing on screen no longer has. An older server /
  // an absent field means "this server tells me nothing about projects", which is
  // exactly `{}` — no facet, no filter.
  projects = data.projects && typeof data.projects === "object" ? data.projects : {};
  // Same rule, same reason, for the Jira facet: `{}` is both "no facet" and the
  // membership set a `?jira=` deep link is judged against, so a stale map would
  // admit a key the listing on screen no longer carries.
  jiraKeys = data.jira && typeof data.jira === "object" ? data.jira : {};
  // Same rule: absent means "no tracker", never "the last wiki's tracker".
  trackerLabels = {};
  if (Array.isArray(data.trackers)) {
    for (const t of data.trackers as ListingTracker[]) {
      if (t && typeof t.id === "string" && typeof t.label === "string") trackerLabels[t.id] = t.label;
    }
  }
  fellesPublishBin =
    data.fellesPublish && typeof data.fellesPublish.bin === "string" ? data.fellesPublish.bin : null;
  fellesPublishBucket =
    typeof data.fellesPublish?.bucket === "string" ? data.fellesPublish.bucket : undefined;
  if (fellesPublishBin && WIKI && !fellesSync) {
    const sync = initFellesSync({
      wiki: WIKI,
      hrefFor: pageUrlByRelPath,
      openPage: (relPath) => loadPageByRelPath(relPath),
      bin: fellesPublishBin,
      bucket: fellesPublishBucket,
      // A status that lands after the breadcrumb was drawn repaints its marker.
      onStatus: () => {
        const btn = document.getElementById(FELLES_BTN_ID);
        if (btn) setFellesBtnMark(btn, sync.markFor(btn.getAttribute("data-felles-relpath") || ""));
      },
    });
    fellesSync = sync;
    // After the render this listing feeds: the status spawns a bucket listing.
    setTimeout(() => void sync.load(), 0);
  }
  // The issue board is a tracker surface: its head link shows only while the
  // listing names a tracker.
  const boardLink = document.getElementById("wikiBoardLink");
  if (boardLink) boardLink.hidden = Object.keys(trackerLabels).length === 0;
  // Before the first `renderPageFacets` on every path that reaches one, so the
  // boot render already paints the chip the URL asked for as active.
  adoptProjectFilter(boot);
  adoptJiraFilter(boot);
  // A palette opened before this listing arrived is showing "Loading" (or the
  // failure line, when a later refetch heals a failed boot).
  refreshFind();
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
  // A run that finished since the last listing shows at once. Only the Your
  // work card: What's new and the Index card are not re-mounted on an adopt.
  if (getCurrentName() === null && wikiToolsFlag()) refreshWorkCardFromListing();
  refreshEffortFromListing();
}

/** Everything an adopt does EXCEPT painting the row list and the start body — the
 *  shared half of `adoptPagesAndRender` and the deferred apply. */
function adoptPagesDataAndFacets(applied: PendingPages): void {
  setPagesData(applied.data);
  markApplied(pagesRefresh, applied);
  renderPageFacets(false);
  refreshStartStats();
  loadCoverageFooter();
  loadStaleSummary();
}

/** The boot-success render: facets, the coverage footer, and the one-time
 *  navigation from `location.search`. Runs on the FIRST successful adopt, which
 *  is normally the boot response — but if boot failed (error pane painted, no
 *  facets, no list) the next successful refetch must run this path too, or the
 *  list heals beside a permanent error message. */
function bootRender(applied: PendingPages): void {
  setPagesData(applied.data, true);
  markApplied(pagesRefresh, applied);
  renderPageFacets(true);
  loadCoverageFooter();
  loadStaleSummary();
  // The initial navigation is boot-only work. On a heal the reader may already be
  // somewhere (a wikilink click out of an Ask answer, an answer in the pane) —
  // re-reading `location.search` there would fight what is on screen, so just
  // paint the rows the failed boot never painted.
  if (currentViewState() !== "start") {
    renderList();
    return;
  }
  const params = new URLSearchParams(location.search);
  syncDisplayFromUrl();
  // A shared/reloaded relPath URL re-resolves collision-proof; check it first
  // (`?page=` remains for links written before relPath URLs were pushed).
  const relPath = params.get("relPath");
  if (relPath) {
    loadPageByRelPath(relPath, false);
  } else {
    const page = params.get("page");
    const effort = page ? null : effortFromUrl(params);
    if (page) loadPage(page, false);
    // `?effort=<id>`: the effort page (work map P3), with no page behind it.
    else if (effort !== null) {
      renderEffort(effort);
      renderList();
    }
    // `?display=graph&issue=jira:KEY` with no page: the issue's graph alone.
    else if (graphMode && graphIssue && hasTracker()) {
      renderIssueGraph();
      renderList();
    } else renderStart(); // renders the list itself
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
 *  so painting here would mean two full 953-row renders per user action.
 *  `renderEffort` paints no list of its own, so it repaints it when this
 *  returns true (something was applied). */
function applyPendingPages(): boolean {
  const pending = takePending(pagesRefresh);
  if (!pending) return false;
  if (!pagesRefresh.bootRendered) {
    bootRender(pending);
    return true;
  }
  adoptPagesDataAndFacets(pending);
  return true;
}

/** Paint the boot-only "this wiki isn't usable" pane. Suppressed once anything has
 *  rendered successfully — a slow boot response must not bury a healed page. */
function paintBootError(html: string): void {
  if (pagesRefresh.bootRendered) return;
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-empty-state">${html}</div>`;
  // An open palette is still saying "Loading pages…".
  pagesLoadFailed = true;
  refreshFind();
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
function handlePagesResponse(
  text: string,
  seq: number,
  isBoot: boolean,
  force = false,
): ReceiveOutcome | "error" {
  let data: WikiPagesResponse | null = null;
  try {
    data = JSON.parse(text) as WikiPagesResponse;
  } catch {
    if (isBoot) paintBootError("Failed to load wiki: malformed response");
    return "error";
  }
  // Shape guard, not just `data.error`: without it a payload carrying no `pages`
  // array would set `allPages = undefined` and take the whole reader down.
  if (!data || !Array.isArray(data.pages)) {
    if (isBoot) paintWikiSetError((data && data.error) || "");
    return "error";
  }
  if (data.error && !data.pages.length) {
    if (isBoot) paintWikiSetError(data.error);
    return "error";
  }
  const fingerprint = pagesFingerprint(text);
  const outcome = receivePages(pagesRefresh, {
    data,
    // `force` reports the START view whatever is on screen, which is the ONE
    // thing it overrides: every other guard — the sequence, the empty set, the
    // unchanged fingerprint — still runs. It is for a refetch the reader's own
    // write asked for (the series editor), where deferring the listing would
    // leave the fold and the header showing the state before the click.
    view: force ? "start" : currentViewState(),
    seq,
    fingerprint,
    // The mirror line paints from every fresh response, not only an adopted one:
    // a deferred or unchanged listing still carries the current mirror health.
    onMirror: paintMirrorFromListing,
  });
  if (outcome === "apply") applyPagesResponse({ data, fingerprint });
  // Returned for the ONE caller that must know: a write's own refetch, where
  // `defer`/`empty`/`stale`/`unchanged` all mean the screen still shows the
  // listing from before the write.
  return outcome;
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
function requestPages(opts: { refresh: boolean; boot?: boolean; force?: boolean }): void {
  void requestPagesAwaited(opts);
}

/** The same request, awaitable — so a caller that must repaint something ELSE
 *  once the listing is in (the series editor's header repaint) can. */
function requestPagesAwaited(opts: {
  refresh: boolean;
  boot?: boolean;
  force?: boolean;
}): Promise<ReceiveOutcome | "error"> {
  // Sequence + throttle stamp at REQUEST time: a hung request must not leave the
  // gate open for a pile-up, and responses are adopted in issue order.
  const seq = startFetch(pagesRefresh, Date.now());
  return fetch(withWiki("/api/wiki/pages" + (opts.refresh ? "?refresh=1" : "")))
    .then((r) => r.text())
    .then((text) => handlePagesResponse(text, seq, !!opts.boot, !!opts.force))
    .catch((err: Error): ReceiveOutcome | "error" => {
      if (opts.boot) paintBootError(`Failed to load wiki: ${esc(err.message)}`);
      // Otherwise silent — a failed refresh keeps the last good listing.
      return "error";
    });
}

function maybeRefetchPages(refresh: boolean): void {
  if (document.hidden) return;
  if (!shouldRefetch(pagesRefresh, Date.now())) return;
  requestPages({ refresh });
  // The felles status rides the same triggers and throttle (finding 67).
  fellesSync?.refresh();
}

// The mirror line: painted from every listing, its age redrawn every minute.
let paintMirrorFromListing!: ReturnType<typeof installMirrorStatus>;

// Remember / return to the wiki last opened BY URL. Stored only when the URL
// named the wiki (remembering the resolved default would make the redirect inert
// exactly when it matters); read when it did not — a bare `/wiki` from the nav
// or the address bar — and applied as a full `location.replace` if the stored
// wiki is still one the picker offers. The pure rule is `lastWikiRedirect`.
function rememberOrRedirectWiki(): boolean {
  const sel = document.getElementById("wikiSelect") as HTMLSelectElement | null;
  const known = sel ? Array.from(sel.options, (o) => o.value).filter(Boolean) : [];
  const remember = rememberWikiName(location.search, WIKI, known);
  if (remember) {
    writeLastWiki(remember);
    return false;
  }
  const url = lastWikiRedirect({ search: location.search, stored: readLastWiki(), rendered: WIKI, known });
  if (!url) return false;
  location.replace(url);
  return true;
}

// ── boot() ────────────────────────────────────────────────────────────
/** The left pane's port onto the shell (`RailDeps`, `atlasDeps()`'s shape):
 *  live reads of the shell's state and the shell functions the rail calls. */
function railDeps(): RailDeps {
  return {
    WIKI: () => WIKI,
    allPages: () => allPages,
    currentRelPath: () => currentRelPath,
    typeOrder: () => typeOrder,
    folderLabels: () => folderLabels,
    activityWeights: () => activityWeights,
    workedGate: () => workedGate,
    projects: () => projects,
    jiraKeys: () => jiraKeys,
    trackerLabels: () => trackerLabels,
    workMapCache: getWorkMapCache,
    railMapFailedAt: getRailMapFailedAt,
    workFacts: () => workFacts,
    workMapThemes: () => workMapThemes,
    filters,
    pagesRefresh,
    withWiki,
    pageUrlByRelPath,
    typeLabel,
    recencyNow,
    sortMode,
    refreshCrumbHref,
    writeProjectParam,
    writeJiraParam,
    refreshStartBody,
    refreshStartStats,
    loadPageByRelPath,
    resetStaleRailPainted,
    railStaleBadge,
    effortHrefFor,
    railEffortsIndex,
    refreshEffortFromListing,
    openWorkCardMenu,
    openThreadRowMenu,
    showWorkBoundaryStatus,
  };
}

/** The stale check's port (`StaleDeps`). */
function staleDeps(): StaleDeps {
  return {
    WIKI: () => WIKI,
    currentRelPath: () => currentRelPath,
    renderedArticle: () => renderedArticle,
    startTab: () => startTab,
    withWiki,
    loadPageByRelPath,
  };
}

/** No page is shown, for the effort page (`EffortDeps.clearShownPage`) and an
 *  Ask answer (`AskTurnPort.clearShownPage`, from `showAskAnswer`): the shell's
 *  own lets, cleared in `renderEffort`'s original order, which is also
 *  `showAskAnswer`'s. */
function clearShownPage(): void {
  setCurrentRelPath(null);
  currentPageHash = null;
  graphMode = false;
  graphIssue = "";
  removeGraph();
  hideBreadcrumb();
}

/** The effort page's port (`EffortDeps`). */
function effortDeps(): EffortDeps {
  return {
    WIKI: () => WIKI,
    allPages: () => allPages,
    filters,
    pageViewSeq: () => pageViewSeq,
    workMapThemes: () => workMapThemes,
    withWiki,
    pageUrlByRelPath,
    currentStartUrl,
    applyPendingPages,
    consumeUrlLens,
    setAtlasFull,
    clearShownPage,
  };
}

/** The Ask tab's port (`AskTurnPort`). */
function askDeps(): AskTurnPort {
  return {
    WIKI: () => WIKI,
    clearShownPage,
    switchConnTab,
    reloadPageInPlace,
  };
}

/** The ⋯ menus' port (`MenusDeps`). */
function menusDeps(): MenusDeps {
  return {
    WIKI: () => WIKI,
    allPages: () => allPages,
    workFacts: () => workFacts,
    seriesMenuOpener: () => seriesMenu?.opener ?? null,
    postSeriesWrite: () => postSeriesWrite,
    withWiki,
    closeSeriesMenu,
    seriesBaseHash,
    openPageAtLoad,
    adoptOwnSeriesHashes,
    refreshAfterSeriesWrite,
  };
}

/** Set by the first {@link boot}; a second call throws (two listener sets). */
let booted = false;

/**
 * Wire the reader: every listener, timer, storage read, injected-global read and
 * boot fetch this file used to run at import, in their original source order —
 * the order is load-bearing (`keydown` handlers read `defaultPrevented`, the
 * click delegate must precede `initChatOptions`). Importing this module touches
 * nothing; `wiki-shell-client.ts` is the bundle entry that calls this once.
 * `dispose()` clears the two intervals (the listing heartbeat and the mirror
 * line's minute tick); listeners stay on the document.
 */
export function boot(): { dispose(): void } {
  if (booted) throw new Error("boot() called twice: the reader is already wired");
  booted = true;
  let mirrorTimer: ReturnType<typeof setInterval> | undefined;
  pendingUrlLens = new URLSearchParams(location.search).get(LENS_PARAM);
  WIKI = readActiveWikiName();
  WIKI_ROOT = readActiveWikiRoot();
  FIND_SELF_WIKI = readFindSelfWiki();
  FIND_ROWS_WIKI = readFindRowsWiki();
  initStartCards({
    withWiki,
    resolvePageName: relPathToName,
    workMapRunAt: () => getWorkMapRunAt(),
    // One map cache for the card, the rail and the effort page (P4). The ↻ poll
    // asks `fresh` and hands a newer map back through `adoptWorkMap`.
    fetchWorkMap: (fresh) => (fresh || getWorkMapRunAt() === null ? getWorkMap() : workMapFetchFor(getWorkMapRunAt()!)),
    adoptWorkMap,
    pages: () => allPages,
    waitsCounted: () => waitsCounted,
    hrefFor: pageUrlByRelPath,
    effortHref: effortHrefFor,
  });
  initWikiVisuals();
  initRailResize();
  initPaneToggles();
  // The one-time cleanup that ships with the removal of `Recently opened`: the
  // `muninn.wiki.recents.v1:*` keys a reader already carries are dropped here,
  // before the first render, and nothing writes one again. Boot-time and
  // idempotent — see `purgeRecentsKeys` for why the prefix is the whole contract.
  purgeRecentsKeys();
  initRail(railDeps());
  initStale(staleDeps());
  initEffort(effortDeps());
  initAsk(askDeps());
  initMenus(menusDeps());
  relatedOrder = readRelatedOrder(WIKI);
  registerStale();
  postSeriesWrite = seriesPoster(WIKI);
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
  document.addEventListener("mouseover", (e) => {
    const t = e.target as HTMLElement | null;
    const node = t?.closest?.(GRAPH_NODE_SEL);
    if (node) lightGraph(node.getAttribute(GRAPH_NODE_ATTR));
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.(GRAPH_NODE_SEL)) return;
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (!to?.closest?.(GRAPH_NODE_SEL)) lightGraph(null);
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target as HTMLElement | null;
    // Focus leaving the nodes (into the card, say) falls back to the card's node.
    const node = t?.closest?.(GRAPH_NODE_SEL);
    lightGraph(node ? node.getAttribute(GRAPH_NODE_ATTR) : null);
  });
  document.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement | null;
    if (!t) return;
    if (t.id === GRAPH_LEVEL_ID) graphLevel = Number(t.value) as GraphLevel;
    else if (t.id === GRAPH_DEPTH_ID) graphDepth = Number(t.value);
    else return;
    loadGraph();
  });
  // Escape with a card open, and no other owner active, closes the card and
  // nothing else. Capture phase, so it runs before the pane keys' bubble
  // listener, which would leave focus mode.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !graphCardId || document.getElementById(GRAPH_CARD_ID)?.hidden) return;
      if (escapeOwnedElsewhere()) return;
      e.preventDefault();
      e.stopPropagation();
      closeGraphCard();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    // Any open modal or menu, not only one around the focused element
    // (`modalOpen` says why).
    const toggles = graphKeyToggles(readerKeyEventOf(e));
    // Only where the toggle is on screen: an article or an issue graph, on a
    // wiki with a tracker — never the overview or an Ask answer.
    if (!toggles || !document.getElementById(GRAPH_TOGGLE_ID)) return;
    e.preventDefault();
    toggleGraph();
  });
  // `v` swaps Overview and All, as the breadcrumb's lens chip does; a no-op
  // where the page shows no lens switch.
  document.addEventListener("keydown", (e) => {
    if (!lensKeyToggles(readerKeyEventOf(e))) return;
    if (toggleLens(document.getElementById("articleWrap")!)) e.preventDefault();
  });
  // ── Event wiring (all clicks delegated) ───────────────────────────────
  document.body.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest && target.closest("#wikiWhatsNewRefresh, #wikiWhatsNewRetry")) {
      loadDigest(true);
      return;
    }
    if (typeof target.closest === "function" && handleWorkCardClick(target)) return;
    if (target.closest && target.closest("#wikiIndexReindex")) {
      startReindex();
      return;
    }
    // Effort links (the Your work card, the effort page) open in the reader;
    // a modifier or middle click keeps the anchor's own href.
    const effortLink = target.closest ? target.closest("[data-effort-link]") : null;
    const effortHome = target.closest ? target.closest("[data-effort-home]") : null;
    const effortRetry = target.closest ? target.closest("#wikiEffortRetry") : null;
    if (effortLink || effortHome || effortRetry) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      if (effortLink) openEffort(effortLink.getAttribute("data-effort-link") || "");
      else if (effortRetry && getEffortOpen() !== null) renderEffort(getEffortOpen()!);
      else if (effortHome) {
        goToStart();
        document.getElementById("wikiWorkCard")?.scrollIntoView({ block: "start" });
      }
      return;
    }
    const crumb = target.closest ? target.closest(".wiki-bc-wiki") : null;
    if (crumb) {
      // Plain click only: a modifier/middle click keeps the anchor's own href.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      goToStart();
      return;
    }
    if (target.closest && target.closest("#wikiIndexRefresh")) {
      loadIndexCoverage(true);
      return;
    }
    // Coverage footer under the page list → open the full Index card on the start
    // view (it lazy-loads there); scroll it into view once the render settles.
    if (target.closest && target.closest("#wikiCoverageLink")) {
      goToStart();
      setTimeout(() => {
        const card = document.getElementById("wikiIndexCard");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
      return;
    }
    const tab = target.closest ? target.closest(".wiki-tab") : null;
    if (tab) {
      switchStartTab(tab.getAttribute("data-tab"));
      return;
    }
    // Right rail Connections | Ask tab switch (manual — focus the Ask box).
    const connTab = target.closest ? target.closest(".wiki-conn-tab") : null;
    if (connTab) {
      switchConnTab(connTab.getAttribute("data-conntab") || "conn", true);
      return;
    }
    // The article pill opens the STALE tab; the home line opens the home's Stale tab.
    if (target.closest && target.closest("[data-stale-pill]")) {
      e.preventDefault();
      // A collapsed pane hides the tab and focus mode hides the pane: show it first.
      revealRightPane();
      switchConnTab("stale");
      return;
    }
    if (target.closest && target.closest("[data-stale-home-open]")) {
      e.preventDefault();
      switchStartTab("stale");
      return;
    }
    // The STALE tab's buttons, before the nav-link branch below.
    const staleCheck = target.closest ? target.closest("[data-stale-check]") : null;
    if (staleCheck) {
      void runStaleCheckClient(staleCheck.getAttribute("data-stale-page") || "");
      return;
    }
    const staleVerdict = target.closest ? target.closest("[data-stale-verdict]") : null;
    if (staleVerdict) {
      void postStaleVerdict(staleVerdict);
      return;
    }
    const staleApply = target.closest ? target.closest("[data-stale-apply]") : null;
    if (staleApply) {
      void postStaleFix(staleApply, "apply");
      return;
    }
    const staleSend = target.closest ? target.closest("[data-stale-send]") : null;
    if (staleSend) {
      void postStaleFix(staleSend, "send");
      return;
    }
    // The rail's ★ lives inside a `[data-relpath]` row; it is the list's own
    // listener's business, and opening the page as well is not what a click on it
    // means. Skipped HERE rather than by stopping propagation in that listener, so
    // one widget's handler cannot silence document-level listeners that have
    // nothing to do with it.
    if (target.closest && target.closest("[data-pin]")) return;
    // The work thread's 📌 is the list's own listener's business too.
    if (target.closest && target.closest("[data-thread-pin]")) return;
    // And the work thread ⋯ menus (PR 4): a focus row's own ⋯ sits inside a
    // `[data-relpath]` row, and the popover is appended to `document.body`.
    if (target.closest && target.closest(`[data-thread-row-menu], [data-work-card-menu], #${WORK_POP_ID}`)) return;
    // Same rule for the group chip and the section fold: both live inside a
    // `[data-relpath]` row, both belong to the list's own listener, and a click on
    // either means "show me what is folded here", never "open this page".
    if (target.closest && target.closest("[data-fold-key]")) return;
    // Same rule again for the series editor: its `⋯` opener sits inside a
    // `[data-relpath]` row (the rail's and the Related-work panel's), and its
    // popover is appended to `document.body`, so without this skip a click on
    // either OPENED THE PAGE underneath — measured, one navigation per menu open.
    // Skipped by SELECTOR rather than by stopping propagation in the editor's own
    // listener, which runs after this one: the ★ and the fold chip settled that
    // rule for exactly this shape.
    if (
      target.closest &&
      target.closest(`[${SERIES_MENU_ATTR}], [${SERIES_EDIT_ATTR}], #${SERIES_MENU_ID}`)
    ) {
      return;
    }
    // Related work's order toggle and ▸ second hop. The ▸ sits INSIDE a
    // `[data-relpath]` row, so it is claimed here, before the nav-link branch
    // below would open the row's page.
    const relOrderBtn = target.closest ? target.closest(`[${RELATED_ORDER_ATTR}]`) : null;
    if (relOrderBtn) {
      e.preventDefault();
      setRelatedOrder(parseRelatedOrder(relOrderBtn.getAttribute(RELATED_ORDER_ATTR)));
      return;
    }
    const relHopBtn = target.closest ? target.closest<HTMLButtonElement>(`[${RELATED_HOP_ATTR}]`) : null;
    if (relHopBtn) {
      e.preventDefault();
      toggleRelatedHop(relHopBtn);
      return;
    }
    // The article header's project hub chip. Delegated here rather than bound at
    // render time because `#articleWrap`'s innerHTML is replaced on every page
    // load — and checked BEFORE the nav-link branch, since the chip sits inside the
    // article head, which that branch would otherwise not claim but future markup
    // might.
    const hubChip = target.closest ? target.closest("[data-project-hub]") : null;
    if (hubChip) {
      e.preventDefault();
      applyProjectFilter(hubChip.getAttribute("data-project-hub") || "");
      return;
    }
    // The series strip's `continue at:` link. Delegated for the hub chip's reason
    // — `#articleWrap`'s innerHTML is replaced on every page load — and by relPath
    // rather than by name, since two pages of one series can share a stem.
    const seriesGo = target.closest ? target.closest("[data-series-go]") : null;
    if (seriesGo) {
      e.preventDefault();
      const rel = seriesGo.getAttribute("data-series-go") || "";
      if (rel) loadPageByRelPath(rel, true);
      return;
    }
    // A reveal control on an empty surface (the rail, Hubs): turn the toggle on.
    if (target.closest && target.closest(`[${RETIRED_REVEAL_ATTR}]`)) {
      e.preventDefault();
      setShowRetired(true);
      // The repaint removed the control that had focus; the options button that
      // holds the toggle it turned on is where a keyboard reader continues.
      document.getElementById("wikiOptionsBtn")?.focus();
      return;
    }
    // The retired banner's successor link — same shape as `continue at:`, but a
    // modified click keeps the anchor's own href (a new tab is a fair ask here).
    const cullGo = target.closest ? target.closest(`[${CULL_GO_ATTR}]`) : null;
    if (cullGo) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      const rel = cullGo.getAttribute(CULL_GO_ATTR) || "";
      if (rel) loadPageByRelPath(rel, true);
      return;
    }
    // Graph mode: the toggle, a node (opens its card), the card's controls.
    if (target.closest && target.closest(`#${GRAPH_TOGGLE_ID}`)) {
      e.preventDefault();
      toggleGraph();
      return;
    }
    const graphFocus = target.closest ? target.closest(`[${GRAPH_FOCUS_ATTR}]`) : null;
    if (graphFocus) {
      e.preventDefault();
      focusGraphNode(graphFocus.getAttribute(GRAPH_FOCUS_ATTR) || "");
      return;
    }
    const graphOpen = target.closest ? target.closest(`[${GRAPH_OPEN_ATTR}]`) : null;
    if (graphOpen) {
      e.preventDefault();
      graphMode = false;
      graphIssue = "";
      loadPageByRelPath(graphOpen.getAttribute(GRAPH_OPEN_ATTR) || "", true);
      return;
    }
    if (target.closest && target.closest(`[${GRAPH_CARD_CLOSE_ATTR}]`)) {
      e.preventDefault();
      closeGraphCard();
      return;
    }
    const graphNode = target.closest ? target.closest(`[${GRAPH_NODE_ATTR}]`) : null;
    if (graphNode) {
      e.preventDefault();
      openGraphCard(graphNode.getAttribute(GRAPH_NODE_ATTR) || "");
      return;
    }
    // Connections' Link and Link all. Before the Jira key below: a Link button
    // sits beside a key, never inside one, but the order is the decision.
    const issueLink = target.closest ? target.closest<HTMLButtonElement>(`[${ISSUE_LINK_ATTR}]`) : null;
    if (issueLink) {
      e.preventDefault();
      if (issueLink.disabled || !currentRelPath) return;
      void linkIssue(
        currentRelPath,
        issueLink.getAttribute("data-issue-tracker") || "",
        issueLink.getAttribute(ISSUE_LINK_ATTR) || "",
      );
      return;
    }
    if (target.closest && target.closest(`[${ISSUE_LINK_ALL_ATTR}]`)) {
      e.preventDefault();
      void linkAllIssues();
      return;
    }
    // The provenance strip's Jira key: the key itself narrows the page list to the
    // pages serving that issue. Delegated here for the hub chip's reason — the
    // strip lives inside `#articleWrap`, whose innerHTML is replaced on every load.
    const provJira = target.closest ? target.closest("[data-prov-jira]") : null;
    if (provJira) {
      e.preventDefault();
      const key = provJira.getAttribute("data-prov-jira") || "";
      // Re-clicking the active key clears it, the chip row's own convention — so a
      // reader who filtered from the strip can undo it from the same control.
      applyJiraFilter(filters.jira === key ? "" : key);
      return;
    }
    // The ⧉ copy button on a chain row. The id is carried ON the button rather
    // than re-read from the row at click time, the ⧉ Copy path rule: the string
    // reported and the string copied cannot then be different sessions. Checked
    // BEFORE the disclosure below, because the button sits INSIDE the chain the
    // line opens — the outer `closest` would otherwise never be reached, but the
    // order is what makes that a decision rather than a coincidence of markup.
    const sessCopy = target.closest ? target.closest<HTMLButtonElement>("[data-sess-copy]") : null;
    if (sessCopy) {
      e.preventDefault();
      copySessionId(sessCopy);
      return;
    }
    // The Stamp button on a ghost row. BEFORE the disclosure, for the ⧉ button's
    // reason: it sits inside the chain the line opens.
    const provStamp = target.closest
      ? target.closest<HTMLButtonElement>("[data-prov-stamp]")
      : null;
    if (provStamp) {
      e.preventDefault();
      void stampGhost(provStamp);
      return;
    }
    // The provenance line itself: one disclosure over the chain under the title.
    // Delegated for the same reason as the two above — `#articleWrap`'s innerHTML
    // is replaced on every page load, so a listener bound at render time would be
    // re-bound per page and lost on the next one.
    const provToggle = target.closest
      ? target.closest<HTMLButtonElement>("[data-prov-toggle]")
      : null;
    if (provToggle) {
      e.preventDefault();
      toggleProvChain(provToggle);
      return;
    }
    if (target.closest && target.closest("[data-prov-retry]")) {
      e.preventDefault();
      retryProvStrip();
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
  registerMenus();
  registerRail();
  registerRailOptions();
  // An in-article `#id` link to a card inside a closed fold: open it on the way.
  window.addEventListener("hashchange", () => {
    const article = document.querySelector("#articleWrap > .wiki-article");
    if (article) revealHashTarget(article);
  });
  window.addEventListener("popstate", () => {
    // Back/Forward is a navigation: an open find palette's rows describe the
    // page being left.
    if (isFindOpen()) closeFind(false);
    const params = new URLSearchParams(location.search);
    // The project rides in the URL, so Back/Forward is a facet change too — and it
    // is the one path where the address bar leads. Adopted on EVERY branch (the
    // article ones included: the rail keeps its chips while a page is open), and
    // repainted only when it actually moved.
    const projectBefore = filters.project;
    adoptProjectFilter(true);
    if (filters.project !== projectBefore) repaintForProject(false);
    // Same for the jira facet — same reason, same `false` (Back/Forward is not a
    // filter click, so a collapsed Filters stack stays collapsed).
    const jiraBefore = filters.jira;
    adoptJiraFilter(true);
    if (filters.jira !== jiraBefore) repaintForJira(false);
    // Graph mode is URL state: Back and Forward restore it with the page.
    syncDisplayFromUrl();
    // A relPath URL round-trips collision-proof (and is what every in-reader
    // navigation now pushes); check it first, `?page=` stays for older links.
    const relPath = params.get("relPath");
    // The page on screen, in another display state: switch the display, never
    // refetch the page (that reset its scroll and re-ran everything under it).
    // Only while the pane shows that page: a failed load keeps the previous
    // page's identity under its error.
    const shown = document.querySelector("#articleWrap > .wiki-article, #articleWrap > .wiki-explainer-frame");
    if (relPath && relPath === currentRelPath && getCurrentName() && !navInFlight && shown) {
      applyDisplay();
      return;
    }
    if (relPath) {
      loadPageByRelPath(relPath, false);
      return;
    }
    const page = params.get("page");
    const effort = page ? null : effortFromUrl(params);
    if (page) loadPage(page, false);
    else if (effort !== null) renderEffort(effort);
    else if (graphMode && graphIssue && hasTracker()) renderIssueGraph();
    else {
      syncStartTabFromUrl();
      renderStart();
      loadStaleSummary();
    }
  });
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
    const turn = getAskTurns()[idx];
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
    else if (t.closest("#" + FELLES_BTN_ID)) {
      const relPath = t.closest("#" + FELLES_BTN_ID)?.getAttribute("data-felles-relpath") || "";
      if (relPath && fellesPublishBin && WIKI_ROOT) {
        openFellesPublishDialog({
          wiki: WIKI || "",
          relPath,
          bin: fellesPublishBin,
          root: WIKI_ROOT,
          bucket: fellesPublishBucket,
          onRun: () => void fellesSync?.load({ afterRun: true }),
        });
      }
    }
    // ⧉ Copy path — delegated like its neighbours because the breadcrumb's
    // innerHTML is rewritten on every navigation, which would drop a direct
    // listener on the second page the reader opens.
    else if (t.closest("#" + COPY_PATH_BTN_ID))
      copyArticlePath(t.closest("#" + COPY_PATH_BTN_ID) as HTMLButtonElement);
    // ⌖ Show in list — delegated for the same reason.
    else if (t.closest("#wikiLocateBtn")) showOpenPageInList();
    else if (t.closest("#wikiFactcheckAppendBtn")) submitFactcheckAppend();
    // ↻ claim retry — the row buttons are injected into the answer body by a DOM
    // pass, so they are delegated by ATTRIBUTE rather than by id.
    else if (t.closest("[data-claim-retry-btn]")) {
      const btn = t.closest("[data-claim-retry-btn]") as HTMLButtonElement;
      if (!btn.disabled) submitClaimRetry(Number(btn.getAttribute("data-claim-retry-btn")));
    } else if (t.closest("#wikiClaimRetryAll")) {
      if (getAskShownTurn()) void retryAllClaims(getAskShownTurn()!);
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
  // The find palette (`/`, ⌘K): ranks `allPages` in the browser, boosted by the
  // open page's `near` map. It owns every key pressed inside it; its opening
  // listener is document-level, bubble phase. See `wiki-find-palette.ts`.
  initFindPalette({
    getPages: () => allPages,
    listingState: () => (pagesLoaded ? "ready" : pagesLoadFailed ? "failed" : "loading"),
    getNear: () => (currentNear && currentNear.relPath === currentRelPath ? currentNear.near : {}),
    getScannedAt: () => scannedAtMs,
    openPage: (relPath) => loadPageByRelPath(relPath),
    hrefFor: (relPath) => pageUrlByRelPath(relPath),
    onOpen: () => hideRefPeek(),
    // Everywhere rows name a root by its FIRST registry entry; on aliased roots
    // that is not the requested name, and under the WIKI_DIR override `WIKI` is "".
    selfWiki: () => FIND_ROWS_WIKI,
    // The read slice (nais) does not register the Everywhere route.
    everywhere: () => wikiToolsFlag(),
  });
  initChatOptions({
    getShownTurn: getAskShownTurn,
    getAskTurns,
    getCurrentArticle: () => currentArticle,
    getOutgoingTitles: () => currentOutgoingTitles,
    postAskChat,
    refreshChatEscalateBar,
  });
  registerIntegratePreviewInputs();
  document.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== "Enter" || ke.shiftKey) return;
    if ((ke.target as HTMLElement)?.id === "wikiFollowupInput") {
      ke.preventDefault();
      submitFollowup();
    }
  });
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
    if (!getCurrentName()) return;
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
  registerRailMenuKeys();
  window.addEventListener("focus", () => maybeRefetchPages(true));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) maybeRefetchPages(true);
  });
  // The never-blurred tab: visible on a second monitor for hours, firing neither
  // event. Same gate, but the PLAIN fetch — server TTL freshness is fine for idle
  // drift.
  const refetchTimer = setInterval(() => maybeRefetchPages(false), WIKI_REFETCH_TICK_MS);
  paintMirrorFromListing = installMirrorStatus({ now: () => Date.now(), setInterval: (tick, ms) => (mirrorTimer = setInterval(tick, ms)) });
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
  // auto-show an answer). Safe at boot — the history element is static.
  rehydrateAskSession();
  // The start tab is resolved HERE, once, whatever the page fetch does: an article
  // deep link needs it for its crumb, and a boot whose fetch failed heals through
  // `bootRender`'s early return with the reader possibly elsewhere — a sync
  // inside that function was skipped on exactly that path.
  syncStartTabFromUrl();
  if (!rememberOrRedirectWiki()) requestPages({ refresh: false, boot: true });

  return {
    dispose() {
      clearInterval(refetchTimer);
      if (mirrorTimer !== undefined) clearInterval(mirrorTimer);
    },
  };
}
