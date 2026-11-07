/// <reference lib="dom" />
/**
 * The /wiki reader's left pane: the filter chips and their facet rows, the page
 * list (`renderList`), its pins, folds, work threads and Group menu, and the
 * coverage footer under it. Moved out of the shell (`wiki-browser.ts`) whole,
 * in the shell's source order (mimir plan muninn-wiki-browser-split, C2); C3
 * added the toolbar's boot code (sort, View options, Filters, the wiki picker)
 * and the rail-control selector the ⋯ menus share.
 *
 * Importing this module runs nothing. The shell's `boot()` calls
 * {@link initRail}, {@link registerRail}, {@link registerRailOptions} and
 * {@link registerRailMenuKeys} at the positions their statements held in it, so
 * every listener keeps its place in the registration order. This module never imports the shell: what the rail
 * reads and calls there arrives through {@link RailDeps}, the `atlasDeps()`
 * shape. Shared shell lets live in `wiki-shell-state.ts`; rail state lives here,
 * with accessors only for what the shell and the ⋯ menus controller read or set.
 */
import { escHtml as esc } from "./escape.ts";
import { seriesEditable } from "./wiki-readonly-client.ts";
import { followupFlagHtml, statusPillHtml } from "./wiki-status-pills.ts";
import { canEditSeriesPage, seriesMenuBtnHtml } from "./wiki-series-menu.ts";
import { workMapDoneSet, type IndexCoverage } from "./wiki-start-cards.ts";
import { proseText, type CardPage, type WorkMapGetBody } from "./wiki-work-card.ts";
import { normalizeRelPath } from "../../../wiki/rel-path.ts";
import { EFFORTS_OFF_TOGGLE_KEY, effortNeedsOpen, effortsOn, effortsToggleWords, type RailEffort } from "./wiki-effort-rail.ts";
import { railIssuePillsHtml } from "./wiki-issue-pills.ts";
import { leaveFocusMode } from "./wiki-pane-toggle.ts";
import { revealScrollTop, rowFullyVisible } from "./wiki-rail-reveal.ts";
import {
  buildRail,
  foldChipCompactLabel,
  foldChipCountsClass,
  foldChipLabelClass,
  foldChipLabel,
  isFoldOpen,
  normalizeFoldKey,
  isPinnedRelPath,
  pairedByWhy,
  railMemberWhy,
  storageEventTouchesThreadPin,
  threadPinSettle,
  threadPinStep,
  type RailEntry,
  type RailWorkCard,
  type ThreadPinState,
  type ThreadPinTrigger,
} from "./wiki-recents.ts";
import { CLOSED_FOLD_PREFIX, GROUP_FAMILIES_TOGGLE_KEY, groupRollup } from "./wiki-groups.ts";
import { railInputFor, threadPinAnchor, workBoundariesOf } from "./wiki-rail-input.ts";
import { rowBoundaryAction, type WorkBoundaries } from "./wiki-work-boundaries.ts";
import { formatRailAge, pageWorkBar, WORK_BAR_STEPS, type ActivityWeights, type WorkedGate } from "./wiki-activity-rank.ts";
import { railTypeIconHtml } from "./wiki-type-icon.ts";
import {
  readFolds,
  readPins,
  toggleFolded,
  togglePinned,
  readThreadPin,
  readWorkGroup,
  writeSort,
  writeThreadPin,
  writeWorkGroup,
} from "./wiki-recents-store.ts";
import {
  railGhostHtml,
  threadAlsoInHtml,
  threadCardHeaderHtml,
  pickUpStripHtml,
  threadGroupBodyStartHtml,
  threadGroupEndHtml,
  threadGroupHeaderHtml,
  threadRowMenuBtnHtml,
  threadSessionLineHtml,
  threadSessionsToggleHtml,
  threadTouchedHtml,
  workSectionHeaderHtml,
} from "./wiki-thread-view.ts";
import { pickUpStep, pickUpTarget } from "./wiki-pick-up.ts";
import {
  storageEventTouchesWorkGroup,
  workGroupPrefsOf,
  workGroupRecordSettle,
  workGroupRecordStep,
  type WorkGroupEdit,
  type WorkGroupRecordState,
  type WorkGroupRecordTrigger,
} from "./wiki-work-group-record.ts";
import type { WorkGroupEvidenceToggles, WorkGroupStop } from "./wiki-work-group-prefs.ts";
import { wikiToolsFlag } from "./wiki-read-slice.ts";
import { findPageByName, findPageByRelPath, isActivePage } from "./wiki-nav.ts";
import {
  connectionTypeOrder,
  displayTitleOf,
  domainFacetVisible,
  facetKeys,
  filterPages,
  filtersRevealing,
  folderCounts,
  folderLabelOf,
  followupCount,
  waitingCount,
  isRecencySort,
  recencyKindFor,
  workedAxisSource,
  workedChip,
  activityRowSource,
  type WorkedSource,
  pageDateSignal,
  projectCounts,
  jiraChipCounts,
  jiraChipRow,
  jiraFacetVisible,
  projectFacetVisible,
  resolveJiraParam,
  ROOT_FOLDER,
  statusCounts,
  statusFacetVisible,
  STATUS_ORDER,
  tagCounts,
  typeCounts,
  type WikiFilters,
  type WikiListing,
  type WikiSortMode,
} from "./wiki-filter.ts";
import { JIRA_TRACKER_ID } from "../../../wiki/trackers/jira-id.ts";
import { railListHtml } from "./wiki-provenance-view.ts";
import { cullLabels, cullToggleText, railPool, RETIRED_TOGGLE_KEY, retiredRevealHtml } from "./wiki-cull-view.ts";
import type { AnyWorkMap } from "../../../wiki/work-map/join.ts";
import { getCurrentName, getRevealOnRender, getWorkMapRunAt, setRevealOnRender, type WorkFacts } from "./wiki-shell-state.ts";

/** What the rail reads and calls on the shell, read live through a function so a
 *  value the shell reassigns is never a stale copy. A member marked `relayed:` is
 *  another controller's export: that controller imports `renderList` from here. */
export interface RailDeps {
  WIKI(): string;
  allPages(): WikiListing[];
  currentRelPath(): string | null;
  typeOrder(): string[];
  folderLabels(): Record<string, string>;
  activityWeights(): ActivityWeights;
  workedGate(): WorkedGate | null;
  projects(): Record<string, number>;
  jiraKeys(): Record<string, number>;
  trackerLabels(): Record<string, string>;
  workMapCache(): { runAt: number; body: WorkMapGetBody & { map: AnyWorkMap } } | null; // relayed: effort
  railMapFailedAt(): number | null; // relayed: effort
  /** The work threads off the last listing (`WorkFacts`), shell-owned. */
  workFacts(): WorkFacts;
  /** The listing's `workMap.kind === "themes"`: View options then says theme. */
  workMapThemes(): boolean;
  /** The shell's one filter object: the rail sets its fields in place. */
  readonly filters: WikiFilters;
  readonly pagesRefresh: { readonly bootRendered: boolean };
  withWiki(url: string): string;
  pageUrlByRelPath(relPath: string): string;
  typeLabel(t: string): string;
  recencyNow(): number;
  sortMode(): WikiSortMode;
  refreshCrumbHref(): void;
  writeProjectParam(): void;
  writeJiraParam(): void;
  refreshStartBody(): void;
  refreshStartStats(): void;
  loadPageByRelPath(relPath: string, push?: boolean, revealHash?: boolean): void;
  resetStaleRailPainted(): void; // relayed: stale; `renderList` starts each paint with the badges' record emptied
  railStaleBadge(relPath: string): string; // relayed: stale
  effortHrefFor(id: string): string; // relayed: effort
  railEffortsIndex(now: number): Map<string, RailEffort> | null; // relayed: effort
  refreshEffortFromListing(): void; // relayed: effort
  openWorkCardMenu(btn: HTMLElement): void; // relayed: ⋯ menus
  openThreadRowMenu(btn: HTMLElement): void; // relayed: ⋯ menus
  showWorkBoundaryStatus(text: string | null): void; // relayed: ⋯ menus
}

/** Set once, by {@link initRail}, before anything here runs. */
let deps!: RailDeps;

/** The tag row's `+N` expander. */
let tagsExpanded = false;
/** The Jira chip row's `+N` expander — `tagsExpanded`'s twin. */
let jiraChipsExpanded = false;

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
  const counts = folderCounts(railPages(), deps.filters.domain);
  // A folder whose pages are all retired stays listed, at its pool count (0):
  // the folder view still reaches it, and picking it shows the rail's reveal
  // control rather than dropping the folder from the picker.
  const withRetired = Object.keys(folderCounts(deps.allPages(), deps.filters.domain));
  // Sorted (and shown) by LABEL: on a wiki whose folder names are opaque — the
  // `memory` wiki's mangled `-Users-rune-source-private-muninn` project dirs — the
  // raw name is neither readable nor a useful sort key. The option VALUE stays the
  // raw folder, so every filter path is untouched.
  const folders = [...new Set([...facetKeys(counts, deps.filters.folder), ...withRetired])].sort((a, b) => {
    if (a === ROOT_FOLDER) return 1; // root pages last — they're the odd ones out
    if (b === ROOT_FOLDER) return -1;
    return folderLabelOf(a, deps.folderLabels()).localeCompare(folderLabelOf(b, deps.folderLabels()));
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
    const label = f === ROOT_FOLDER ? "(root)" : folderLabelOf(f, deps.folderLabels());
    html += `<option value="${esc(f)}"${deps.filters.folder === f ? " selected" : ""}>${esc(label)} ${counts[f] || 0}</option>`;
  });
  sel.innerHTML = html;
}

function renderTypeChips(): void {
  const counts = typeCounts(railPages(), deps.filters.domain);
  let html = `<button class="wiki-chip${deps.filters.type === "" ? " active" : ""}" data-type="">All types</button>`;
  // Union the stored order with the types actually present, so a custom type is
  // never dropped from the chip row even if the stored list is missing/late — and
  // with the ACTIVE type even at count 0 (the status row's rule), so a scope
  // change can't strand the very filter that is emptying the list.
  connectionTypeOrder(facetKeys(counts, deps.filters.type), deps.typeOrder()).forEach((t) => {
    html += `<button class="wiki-chip${deps.filters.type === t ? " active" : ""}" data-type="${esc(t)}">${esc(deps.typeLabel(t))} ${counts[t] || 0}</button>`;
  });
  document.getElementById("typeChips")!.innerHTML = html;
}

/** A class-list fragment: the class with its leading space, or nothing. */
const cls = (c: string): string => (c ? " " + c : "");

/** Are the ✋ "waiting on you" chip and row flag shown? Not on a shared
 *  instance (the nais read slice, `wikiToolsFlag()` false): a `you` lane is the
 *  AUTHOR's next step, and on a pod every colleague reading the wiki would be
 *  told it waits on them. The page's own lane pills still render there — they
 *  carry the lane's `who` label, the author's perspective. */
function movesPersonal(): boolean {
  return wikiToolsFlag();
}

/** The ✋ mark on a rail row whose page has a step waiting on the reader, with
 *  its count: an item of the row's meta line (`.wiki-list-sub`), beside the
 *  status pill and the ⚑, so every title starts at the same x. `aria-hidden`:
 *  the row's title attribute is what a screen reader gets. */
function movesFlagHtml(p: WikiListing): string {
  const n = p.movesYou ?? 0;
  return n > 0 && movesPersonal()
    ? `<span class="wiki-moves-flag" aria-hidden="true" title="${n} step${n === 1 ? "" : "s"} waiting on you">✋ ${n}</span>`
    : "";
}

/** The domain (All/AI/Life) chip row. The three chips are static markup, so this
 *  only owns the row's `display` and which chip is active — the `renderStatusChips`
 *  shape, one level simpler because there is nothing to build.
 *
 *  Hiding also forces `filters.domain` back to "": the four SCOPED facet renders
 *  — `renderFolderSelect`, `renderTypeChips`, `renderStatusChips`,
 *  `renderTagChips` — count within `filters.domain`, so a value left standing
 *  under a hidden row would narrow the list with no control on screen to explain
 *  it. Runs FIRST in `renderPageFacets` for that reason: last, those four would
 *  count under the stale domain and then be reset, leaving facet rows that claim
 *  the wiki has no types or tags beside a list showing every page. (The fifth
 *  render, `syncFilters`, does NOT read it — `activeFilterCount` excludes domain
 *  by design, since the domain control lives outside the Filters disclosure.) */
function renderDomainChips(): void {
  const row = document.getElementById("domainChips");
  if (!row) return;
  const visible = domainFacetVisible(deps.allPages());
  if (!visible) deps.filters.domain = "";
  row.style.display = visible ? "" : "none";
  row.querySelectorAll(".wiki-chip").forEach((c) => {
    c.classList.toggle("active", (c.getAttribute("data-domain") || "") === deps.filters.domain);
  });
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
  if (!statusFacetVisible(deps.allPages(), movesPersonal())) {
    hide();
    return;
  }
  const counts = statusCounts(railPages(), deps.filters.domain, deps.filters.type);
  const open = followupCount(railPages(), deps.filters.domain, deps.filters.type);
  const waiting = movesPersonal() ? waitingCount(railPages(), deps.filters.domain, deps.filters.type) : 0;
  // The whole-wiki gate above says the facet EXISTS here; this says whether it has
  // anything to offer in the CURRENT domain/type scope. Without it a type switch
  // could leave a row holding nothing but the inert "All status" chip. An active
  // filter keeps the row up regardless — it is the only way back out of it.
  if (!Object.keys(counts).length && !open && !waiting && !deps.filters.status && !deps.filters.followups && !deps.filters.waiting) {
    hide();
    return;
  }
  let html = `<button class="wiki-chip${deps.filters.status === "" ? " active" : ""}" data-status="">All status</button>`;
  // Union the enum order with whatever is actually present, same belt-and-braces
  // as the type row: a status the client's copy of the enum doesn't know still
  // shows. The ACTIVE status joins that union even at count 0 (`facetKeys`, here
  // placed in STATUS_ORDER position) — a domain/type switch that empties it would
  // otherwise hide the very filter that is emptying the list.
  connectionTypeOrder(facetKeys(counts, deps.filters.status), STATUS_ORDER).forEach((s) => {
    html +=
      `<button class="wiki-chip${deps.filters.status === s ? " active" : ""}" data-status="${esc(s)}">` +
      `<span class="wiki-status-dot plan-${esc(s)}"></span>${esc(s)} ${counts[s] || 0}</button>`;
  });
  if (open || deps.filters.followups) {
    html += `<button class="wiki-chip${deps.filters.followups ? " active" : ""}" data-followups="open" title="Only pages with open follow-ups">⚑ has follow-ups ${open}</button>`;
  }
  if (waiting || deps.filters.waiting) {
    html += `<button class="wiki-chip${deps.filters.waiting ? " active" : ""}" data-waiting="you" title="Only pages with a step waiting on you (a NextMoves you lane)">✋ waiting on you ${waiting}</button>`;
  }
  row.innerHTML = html;
  row.style.display = "";
}

/**
 * The Project chip row. Rendered only on wikis whose `.wiki-reader.json`
 * declares a project rule that resolved something (`projectFacetVisible`);
 * everywhere else the row stays hidden and empty, so a wiki without the
 * declaration looks exactly as it did before.
 *
 * Ordered by count DESC then name, not by a fixed vocabulary: unlike types and
 * plan statuses, projects are the wiki's own open-ended set, so there is no
 * canonical order to union against — the biggest project is the one most worth
 * reaching first, and the name tiebreak keeps the row stable across refreshes.
 */
function renderProjectChips(): void {
  const row = document.getElementById("projectChips");
  if (!row) return;
  const hide = () => {
    row.innerHTML = "";
    row.style.display = "none";
  };
  if (!projectFacetVisible(deps.allPages())) {
    // The whole-wiki gate going false takes the filter with it — the
    // `renderDomainChips` rule: a value left standing under a hidden row narrows
    // the list with no control on screen to explain it. Unreachable from a deep
    // link (`resolveProjectParam` already answers "" against an empty map) and
    // reachable only from a listing that lost its last project mid-session.
    if (deps.filters.project) {
      deps.filters.project = "";
      deps.writeProjectParam();
    }
    hide();
    return;
  }
  const counts = projectCounts(railPages(), deps.filters.domain, deps.filters.type, deps.filters.folder);
  // The gate above says the facet EXISTS here; this says whether it has anything
  // to offer in the CURRENT scope. An active filter keeps the row up regardless —
  // it is the only way back out of it.
  if (!Object.keys(counts).length && !deps.filters.project) {
    hide();
    return;
  }
  let html = `<button class="wiki-chip${deps.filters.project === "" ? " active" : ""}" data-project="">All projects</button>`;
  // The ACTIVE project joins the list even at count 0 (`facetKeys`, the status
  // row's rule), so a domain/type/folder switch that empties it cannot delete the
  // very chip that is emptying the list.
  facetKeys(counts, deps.filters.project)
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b))
    .forEach((p) => {
      html +=
        `<button class="wiki-chip${deps.filters.project === p ? " active" : ""}" data-project="${esc(p)}">` +
        `${esc(p)} ${counts[p] || 0}</button>`;
    });
  row.innerHTML = html;
  row.style.display = "";
}

/** Everything a project change repaints — shared by the chip row, the article
 *  header's hub chip and popstate, so the three cannot drift on which renders
 *  they owe.
 *
 *  Order: `renderProjectChips` may CLEAR `filters.project` (the whole-wiki gate
 *  going false takes the filter with it), so the crumb is rewritten after it or
 *  it carries a project that is dropped a line later.
 *
 *  `autoOpen` is `syncFilters`' own flag: true for the two CLICK callers (the
 *  chip row and the article header's hub chip, where auto-opening the Filters
 *  disclosure is what makes the chip row visible after a click that came from
 *  the article), false for popstate — Back/Forward is not a filter click, and
 *  springing a deliberately collapsed stack open is the same "not caused by a
 *  user action" rule the background listing refresh already passes false for. */
export function repaintForProject(autoOpen = true): void {
  renderProjectChips();
  deps.refreshCrumbHref();
  // The effort page builds every href with the facets; re-paint it in place.
  deps.refreshEffortFromListing();
  renderList();
  deps.refreshStartBody();
  syncFilters(autoOpen);
}

/** Set the project filter, write it to the URL and repaint. */
export function applyProjectFilter(project: string): void {
  deps.filters.project = project;
  deps.writeProjectParam();
  repaintForProject();
}

/**
 * The Jira chip row — `renderProjectChips`' twin, with one difference worth
 * naming: the whole-wiki gate reads the PAYLOAD's `jiraKeys` map rather than the
 * pages, because that is the contract the server states (`{}` on a wiki nothing
 * has stamped ⇒ no facet) and because the map is shape-filtered while a page's
 * own `jira` array deliberately keeps a typo.
 *
 * Everything else is the same decision: the gate going false takes the filter
 * with it, an empty CURRENT scope hides the row unless a filter is active, the
 * active key joins the list even at count 0, and the order is count DESC then
 * key.
 *
 * On a wiki with a tracker the row is CAPPED (`jiraChipRow`) and labelled with
 * the adapter's name: the facet counts inferred keys too, and a
 * kode-wiki-sized corpus would otherwise draw 45 chips (measured with `link`
 * demoted). The top eight show, plus the active key wherever it ranks, plus a
 * `+N` expander. A wiki without one draws the row it always has.
 */
export function renderJiraChips(): void {
  const row = document.getElementById("jiraChips");
  if (!row) return;
  const hide = () => {
    row.innerHTML = "";
    row.style.display = "none";
  };
  if (!jiraFacetVisible(deps.jiraKeys())) {
    if (deps.filters.jira) {
      deps.filters.jira = "";
      deps.writeJiraParam();
    }
    hide();
    return;
  }
  const counts = jiraChipCounts(railPages(), deps.jiraKeys(), deps.filters.domain, deps.filters.type, deps.filters.folder);
  if (!Object.keys(counts).length && !deps.filters.jira) {
    hide();
    return;
  }
  const label = deps.trackerLabels()[JIRA_TRACKER_ID] ?? "";
  let html = label ? `<span class="wiki-chip-row-label">${esc(label)}</span>` : "";
  html += `<button class="wiki-chip${deps.filters.jira === "" ? " active" : ""}" data-jira="">All issues</button>`;
  const chipRow = jiraChipRow(counts, deps.filters.jira, jiraChipsExpanded, !!label);
  chipRow.keys.forEach((k) => {
    html +=
      `<button class="wiki-chip${deps.filters.jira === k ? " active" : ""}" data-jira="${esc(k)}">` +
      `${esc(k)} ${counts[k] || 0}</button>`;
  });
  if (chipRow.expander) {
    const open = chipRow.expander === "less";
    html +=
      `<button type="button" class="wiki-chip" data-jira-more="1" aria-expanded="${open}">` +
      `${open ? "less" : "+" + chipRow.hidden + " issues"}</button>`;
  }
  row.innerHTML = html;
  row.style.display = "";
}

/** Everything a jira change repaints — `repaintForProject`'s twin, same
 *  ordering rule (the chip render may CLEAR the filter, so the crumb is
 *  rewritten after it) and the same `autoOpen` contract. */
export function repaintForJira(autoOpen = true): void {
  renderJiraChips();
  deps.refreshCrumbHref();
  deps.refreshEffortFromListing();
  renderList();
  deps.refreshStartBody();
  syncFilters(autoOpen);
}

/**
 * Set the jira filter, write it to the URL and repaint.
 *
 * **A key this wiki's facet map does not hold is REFUSED, not set.** Unlike the
 * project row, this filter has a second entry point — the article strip's key —
 * and the strip renders whatever the page's frontmatter carries while the map is
 * shape-filtered server-side. A filter `resolveJiraParam` would drop is a dead
 * param: the chip row renders it at count 0 (contradicting "the count is the
 * rows a click leaves"), every link built while it is live carries it, and a
 * reload silently loses it. Running the value THROUGH `resolveJiraParam` also
 * normalizes case, so `?jira=melosys-8045` from a shared link behaves like the
 * chip's own click. Clearing (`""`) always goes through.
 */
export function applyJiraFilter(jira: string): void {
  const next = resolveJiraParam(jira, deps.jiraKeys());
  if (jira && !next) return;
  deps.filters.jira = next;
  deps.writeJiraParam();
  repaintForJira();
}

function renderTagChips(): void {
  const counts = tagCounts(railPages(), deps.filters.domain, deps.filters.type);
  const tags = Object.keys(counts).sort((a, b) => counts[b]! - counts[a]! || a.localeCompare(b));
  const limit = tagsExpanded ? 36 : 8;
  const shown = tags.slice(0, limit);
  if (deps.filters.tag && shown.indexOf(deps.filters.tag) === -1) shown.unshift(deps.filters.tag);
  let html = "";
  shown.forEach((t) => {
    html += `<button class="wiki-chip${deps.filters.tag === t ? " active" : ""}" data-tag="${esc(t)}">#${esc(t)} ${counts[t] || 0}</button>`;
  });
  if (tags.length > shown.length || tagsExpanded) {
    html += `<button class="wiki-chip" data-tag-more="1">${tagsExpanded ? "less" : "+" + (tags.length - shown.length) + " tags"}</button>`;
  }
  document.getElementById("tagChips")!.innerHTML = html;
}

/** Count of active secondary filters (folder + type + tag + status + follow-ups +
 *  project + jira) — drives the Filters disclosure's badge and its auto-open.
 *  Status and follow-ups count separately because they ARE separate axes, and so
 *  do project and jira. Domain lives in the compact head, so it is deliberately
 *  excluded here. */
function activeFilterCount(): number {
  let n = 0;
  if (deps.filters.folder) n++;
  if (deps.filters.type) n++;
  if (deps.filters.tag) n++;
  if (deps.filters.status) n++;
  if (deps.filters.followups) n++;
  if (deps.filters.waiting) n++;
  if (deps.filters.project) n++;
  if (deps.filters.jira) n++;
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

/** The reader's own pin list for THIS wiki, read once at boot and kept in step by
 *  the writer below — re-reading localStorage inside `renderList` would put a
 *  synchronous storage hit on every keystroke in the search box. */
let pins!: string[];

/** Which GROUPS this reader has opened on this wiki — same discipline as `pins`:
 *  read once at boot, kept in step by the toggle, never re-read per render. It
 *  also carries the `group families` toggle itself (`GROUP_FAMILIES_TOGGLE_KEY`),
 *  a sentinel in the same flat key namespace as `section:meta`, so the toggle is
 *  remembered per wiki with no second store. */
let openFolds!: string[];

/** The reader's pinned work thread on this wiki (D7): `held` (one page
 *  relPath, what the rail renders) and `known` (what this tab last read or
 *  wrote). Every change goes through `stepThreadPin`, the state table. */
let threadPin!: ThreadPinState;

/** Run one row of the pin's state table and perform the write it asks for.
 *  Answers whether the rail should repaint (`storage` rows only). */
function stepThreadPin(t: ThreadPinTrigger): boolean {
  const r = threadPinStep(threadPin, t);
  threadPin = r.write ? threadPinSettle(r.state, r.write.value, writeThreadPin(deps.WIKI(), r.write.value)) : r.state;
  return r.repaint;
}

/** The reader's Work threads grouping record on this wiki (D17): `held` (what
 *  the rail renders from; null = D1), `known` (what this tab last read or
 *  wrote) and whether the held record lives in this tab only. Every change
 *  goes through `stepWorkGroup`, the record's state table. */
let workGroupRec!: WorkGroupRecordState;

/** Run one row of the record's state table and perform the write it asks for.
 *  Answers whether the rail should repaint (`storage` rows only). */
export function stepWorkGroup(t: WorkGroupRecordTrigger): boolean {
  const r = workGroupRecordStep(workGroupRec, t);
  workGroupRec = r.write ? workGroupRecordSettle(r.state, r.write.value, writeWorkGroup(deps.WIKI(), r.write.value)) : r.state;
  return r.repaint;
}

/** Is the Group menu open? Per tab, never stored. */
let workMenuOpen = false;
/** Group fold keys whose `+ N more threads` this tab pressed. Never stored: a
 *  broad group opens on three children again after a reload. */
const workMoreOpen = new Set<string>();
/** Group fold keys whose shared-context `+N` this tab pressed. Never stored. */
const workContextOpen = new Set<string>();
/** Thread fold keys whose `▸ split into N sessions` this tab opened. Never
 *  stored: the split shows the same rows, it changes no stop (D7, D19). */
const workSessionsOpen = new Set<string>();
/** The boundaries the last render applied (`workBoundariesOf`): the row ⋯
 *  reads them, so its item matches the rail on screen. */
let workBounds: WorkBoundaries | null = null;
/** The Work threads cards the last render drew: the card ⋯ reads them. */
let workCardsDrawn: readonly RailWorkCard[] = [];

/** Document focus: the only state in which a render may write the pin. */
function tabHasFocus(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}


/** Is the reader grouping this wiki's rail into families and months? OFF by
 *  default: the finder-rail retro found the rail is scanned more than browsed,
 *  and a fold that hides a row the reader expected costs more than ten rows they
 *  skim past. */
export function familiesOn(): boolean {
  return isFoldOpen(openFolds, GROUP_FAMILIES_TOGGLE_KEY);
}

/** Is `group by effort` on for this wiki (P4)? On by default wherever the
 *  listing says a work map exists; `toggle:no-efforts` stores the reader's
 *  OFF. */
function effortsGrouped(): boolean {
  return effortsOn(openFolds, getWorkMapRunAt() !== null);
}

/** Is the reader showing RETIRED (culled) pages in the rail? Off by default, and
 *  remembered per wiki as a `toggle:` mode key in the same folds store. */
export function showRetired(): boolean {
  return isFoldOpen(openFolds, RETIRED_TOGGLE_KEY);
}

/** The pages the rail's facets count — the query-free pool (`railPool`). */
export function railPages(): WikiListing[] {
  return railPool(deps.allPages(), showRetired(), "");
}

/** The retired pages the current facets select, the query aside — the toggle's
 *  N, and what the empty rail and the `#wikiCount` hover say is held back. */
function retiredUnderFacets(): number {
  return filterPages(
    deps.allPages().filter((p) => p.culled),
    { ...deps.filters, q: "" },
  ).length;
}

/** How many retired pages the rail is holding back right now: 0 while they are
 *  shown or a search (which reaches them) is typed. */
function retiredHeldBack(): number {
  return showRetired() || deps.filters.q.trim() ? 0 : retiredUnderFacets();
}

/**
 * Paint the `Show retired (N)` toggle. N is the retired pages the current
 * facets select (the query aside — a search already shows them), so the number
 * says what one click adds. Hidden on a wiki with no retired page, and while
 * the facets select none — unless it is checked, the only way back out of it.
 */
function paintRetiredToggle(): void {
  const wrap = document.getElementById("wikiRetiredToggle");
  const box = document.getElementById("wikiShowRetired") as HTMLInputElement | null;
  const label = document.getElementById("wikiRetiredLabel");
  if (!wrap || !box || !label) return;
  const n = retiredUnderFacets();
  box.checked = showRetired();
  wrap.hidden = !deps.allPages().some((p) => p.culled) || (n === 0 && !box.checked);
  label.textContent = cullToggleText(n);
  paintViewOptions();
}

/**
 * The view options a closed pane would otherwise hide: a dot on the toolbar's
 * options button, and one removable chip per option that is on, so a rail that
 * folds families or shows retired pages always says why.
 */
export function paintViewOptions(): void {
  const families = familiesOn();
  // A stored toggle on a wiki with no retired page changes nothing and has no
  // control in the pane, so it says nothing either.
  const retired = showRetired() && deps.allPages().some((p) => p.culled);
  const dot = document.getElementById("wikiOptionsDot");
  if (dot) dot.hidden = !(families || retired);
  const strip = document.getElementById("wikiActiveOptions");
  if (!strip) return;
  // The chip names the state: the retired chip uses the wiki's own marker
  // (the word its retired rows carry), not the toggle's action text.
  const chip = (key: string, text: string) =>
    `<span class="wiki-active-option"><span class="wiki-active-option-label">${esc(text)}</span>` +
    `<button type="button" data-view-option-off="${key}" aria-label="${esc(`Turn off: ${text}`)}" title="Turn off">×</button></span>`;
  const html = (families ? chip("families", "group families") : "") + (retired ? chip("retired", cullLabels().marker) : "");
  // Every renderList repaints this; rewriting unchanged markup would drop the
  // focus of a × the reader is on. Compared against the markup last written,
  // not `innerHTML`, which the browser re-serialises (an escaped quote in a
  // marker would never compare equal).
  if (strip.dataset.html !== html) {
    strip.innerHTML = html;
    strip.dataset.html = html;
  }
  strip.hidden = !html;
}

/** Turn `Show retired` on — the toggle itself, or a reveal control on an empty
 *  surface. A flip changes the pool every facet counts from, so the facets,
 *  the start view's stats, Hubs or Timeline, and the rows all repaint. The
 *  Atlas is never on screen for a flip (its tab hides the rail, and the one
 *  start-view reveal is on Hubs); it reads the pool when its tab opens. */
export function setShowRetired(on: boolean): void {
  if (showRetired() !== on) openFolds = toggleFolded(deps.WIKI(), RETIRED_TOGGLE_KEY);
  const box = document.getElementById("wikiShowRetired") as HTMLInputElement | null;
  if (box) box.checked = showRetired();
  renderPageFacets(false);
  deps.refreshStartStats();
  deps.refreshStartBody();
  renderList();
}

// ── View options, sort, Filters, wiki picker (moved with C3) ───────────
/** The reader changed the sort in this tab: it outranks the default for the rest
 *  of the session, even where storage refuses the write. */
let sortTouched = false;

/** Whether this tab changed the sort (`applyWorkedSortOption` in the shell). */
export function getSortTouched(): boolean {
  return sortTouched;
}

// `group families`, per wiki. The control is painted from the STORE at boot (the
// server has no idea what this browser remembers) and written back through the
// same `toggleFolded` every fold uses — the toggle is a sentinel key in that one
// flat namespace, so nothing about the store changes to hold it.
let familiesBox!: HTMLInputElement | null;
function setGroupFamilies(on: boolean): void {
  if (familiesOn() !== on) openFolds = toggleFolded(deps.WIKI(), GROUP_FAMILIES_TOGGLE_KEY);
  // Painted from the store rather than trusted from the event: a write that
  // localStorage refused still has to leave the box saying what the rail is
  // about to render.
  if (familiesBox) familiesBox.checked = familiesOn();
  renderList();
}

// `group by effort` (P4), per wiki: the same store, inverted — the stored
// `toggle:no-efforts` is the OFF, so a click writes the exception to an ON
// default. Painted (and shown) from the listing on every render, since the
// map can appear or go with any adopt.
let effortsBox!: HTMLInputElement | null;
function setGroupEfforts(on: boolean): void {
  if (effortsOn(openFolds, true) !== on) openFolds = toggleFolded(deps.WIKI(), EFFORTS_OFF_TOGGLE_KEY);
  paintEffortsToggle();
  renderList();
}

// `Show retired (N)`, per wiki: the same store and discipline as `group
// families`. A flip changes the pool every facet counts from, so the facets,
// the start view and the rows all repaint.
let retiredBox!: HTMLInputElement | null;

// The toolbar's Filters button flips the <details> under it. The details keeps
// its own open state, so syncFilters' auto-open and a background adopt read it
// as before; aria-expanded follows the details whoever opened it.
let filtersDetails!: HTMLDetailsElement | null;
let filtersBtn!: HTMLElement | null;

// The view-options pane: opened by its button; closed by the button, a pointer
// or focus outside it, Escape from anywhere, or a reader shortcut. It is a
// role="dialog", so while open modalOpen() makes the page's single keys stand
// aside — it must never stay open once the reader has moved on.
let optionsBtn!: HTMLElement | null;
let optionsPane!: HTMLElement | null;
function setOptionsOpen(open: boolean): void {
  if (!optionsBtn || !optionsPane) return;
  optionsPane.hidden = !open;
  optionsBtn.setAttribute("aria-expanded", String(open));
}

// Switching wiki is a full navigation — resets browse context and keeps the URL shareable.
let wikiSel!: HTMLSelectElement | null;

/**
 * ★ — hidden until the row is hovered, always shown once pinned.
 *
 * `tabindex="-1"` is deliberate and measured: as an ordinary tab stop it put ONE
 * per page into the tab order — 485 on mimir, 953 on jarvis — all of them ahead
 * of the rail resizer PR #501 shipped for keyboard users, and the rail's rows are
 * plain `div`s that a keyboard cannot open anyway. Pinning is a pointer
 * affordance until the rail gets row-level keyboard navigation; adding 500 stops
 * to a list nothing can navigate makes the page worse, not more accessible.
 */
function pinBtnHtml(pinned: boolean): string {
  const label = pinned ? "Unpin this page" : "Pin this page";
  return (
    `<button type="button" class="wiki-pin${pinned ? " on" : ""}" data-pin="1" tabindex="-1"` +
    ` aria-pressed="${pinned}" title="${label}" aria-label="${label}">\u2605</button>`
  );
}

/**
 * Paint EVERY row's ★ from the stored pin list. No notion of which page changed,
 * because "the page that was clicked" is the wrong unit: `togglePin` displaces
 * the oldest pin at `PINS_MAX`, so a toggle at the cap flips TWO pages. Painting
 * only the clicked row left the displaced one lit — its ★ still read "Unpin this
 * page", and clicking it RE-pinned (evicting another page) while the star never
 * moved, a control that reads as dead and does the opposite of its own label.
 *
 * Reading the whole list back is what makes that class unreachable rather than
 * handled: there is no case to get wrong. It touches only class and attributes
 * on one button per row, so it triggers no layout — which is the whole point of
 * doing this instead of `renderList`.
 */
function paintPinState(): void {
  const rows = document.getElementById("wikiList")!.querySelectorAll<HTMLElement>(".wiki-list-item");
  for (let i = 0; i < rows.length; i++) {
    const btn = rows[i]!.querySelector<HTMLElement>(".wiki-pin");
    const relPath = rows[i]!.getAttribute("data-relpath");
    if (!btn || !relPath) continue;
    // `isPinnedRelPath`, not an `indexOf`: this and `buildRail` must answer the
    // same question, and a raw comparison here disagreed with the renderer's
    // normalized one — see that function's own doc for what that cost.
    const pinned = isPinnedRelPath(pins, relPath);
    const label = pinned ? "Unpin this page" : "Pin this page";
    btn.classList.toggle("on", pinned);
    btn.setAttribute("aria-pressed", String(pinned));
    btn.setAttribute("title", label);
    btn.setAttribute("aria-label", label);
  }
}

/**
 * The work bar on a row whose page carries in-window session events (plan
 * `muninn-wiki-work-threads`): four steps lit by its work term, on the meta
 * line just before the group chip's slot. Absent on a page with none — and
 * so everywhere with no sessions memo (D11).
 */
function workBarHtml(p: WikiListing, now: number): string {
  const bar = pageWorkBar(p, now);
  if (!bar) return "";
  let steps = "";
  for (let i = 1; i <= WORK_BAR_STEPS; i++) steps += `<i${i <= bar.level ? ' class="on"' : ""}></i>`;
  return `<span class="wiki-work-bar" data-work-level="${bar.level}" role="img" aria-label="${esc(bar.title)}" title="${esc(bar.title)}">${steps}</span>`;
}

/** Why a fold cannot close: a Jira filter opens every fold (`expandAll`), else
 *  the reader is on a page inside it. */
function forcedOpenWhy(what: "group" | "section"): string {
  return deps.filters.jira ? "the Jira filter shows every matching page" : `the open page is in this ${what}`;
}

/**
 * One effort fold row: caret · name (link) · age on line one, then a meta
 * line — the effort's state, ✋ N (the map's Needs-you items for it, minus the
 * ones ✓ on the card, as the effort page counts them), and the plan-status
 * roll-up over every page of the fold (one nowrap unit per count, so it wraps
 * between counts and never clips one).
 */
function effortRowHtml(entry: Extract<RailEntry, { kind: "effort" }>, now: number, done: ReadonlySet<string>): string {
  const { effort } = entry;
  // A pinned page is still the effort's: the roll-up counts its ghost too.
  const members = [...entry.members, ...(entry.ghosts ?? [])];
  const roll = groupRollup("series", members);
  const moves = effortNeedsOpen(effort, done);
  const age = formatRailAge(now - entry.ageMs, now);
  const n = members.length;
  const what = `${n} page${n === 1 ? "" : "s"} of ${effort.name}`;
  const caretWhy = entry.forcedOpen ? forcedOpenWhy("group") : `${entry.folded ? "Show" : "Hide"} the ${what}`;
  // A themes map names its words as the card does: a theme, Worth a look.
  const theme = effort.kind === "themes";
  const sep = '<span class="wiki-rollup-sep"> ·</span>';
  const parts = [
    `<span class="wiki-rollup-part wiki-effort-state">${esc(effort.state)}</span>`,
    ...(moves > 0 ? [`<span class="wiki-rollup-part wiki-effort-moves" title="${moves} item${moves === 1 ? "" : "s"} in ${theme ? "Worth a look" : "Needs you"}">✋ ${moves}</span>`] : []),
    ...roll.parts.map(
      (p) => `<span class="wiki-rollup-part${p.word === "shipped" || p.word === "in-flight" ? " s-" + p.word : ""}">${p.n} ${esc(p.word)}</span>`,
    ),
  ];
  // The separator rides inside the part before it, so a wrapped line never
  // starts with one (the series roll-up's rule).
  const meta = parts.map((h, i) => (i < parts.length - 1 ? h.replace(/<\/span>$/, sep + "</span>") : h)).join(" ");
  return (
    `<div class="wiki-list-group effort${entry.folded ? " folded" : ""}" data-section="${esc(entry.section)}" data-group="${esc(entry.foldKey)}" data-effort="${esc(effort.id)}">` +
    `<button type="button" class="wiki-effort-fold${entry.folded ? " folded" : ""}" data-fold-key="${esc(entry.toggleKey)}"` +
    ` aria-expanded="${entry.folded ? "false" : "true"}"${entry.forcedOpen ? " disabled" : ""}` +
    ` aria-label="${esc(caretWhy)}" title="${esc(caretWhy)}"><span class="wiki-fold-caret" aria-hidden="true">▸</span></button>` +
    `<div class="wiki-effort-body">` +
    `<div class="wiki-effort-line">` +
    `<a class="wiki-effort-name" href="${esc(deps.effortHrefFor(effort.id))}" data-effort-link="${esc(effort.id)}" title="${esc(`Open the ${theme ? "theme" : "effort"} page: ${effort.name}`)}">${esc(effort.name)}</a>` +
    (age ? `<span class="wiki-effort-age" title="${esc(`${entry.members.length ? "newest page drawn here" : "newest pinned page"} ${age}`)}">${esc(age)}</span>` : "") +
    `</div>` +
    `<small class="wiki-group-rollup wiki-effort-meta">${meta}</small>` +
    `</div></div>`
  );
}

/** The lookup an effort fold's summary reads its `⟦relPath⟧` markers through
 *  (the card's `proseText`), rebuilt when the listing changes. */
let effortProseMemo: { pages: WikiListing[]; byKey: Map<string, CardPage> } | null = null;

/** An open effort fold's head (D14): its one-line summary, then «Open effort →». */
function effortIntroHtml(effort: RailEffort): string {
  if (effortProseMemo?.pages !== deps.allPages()) {
    effortProseMemo = { pages: deps.allPages(), byKey: new Map(deps.allPages().map((p) => [normalizeRelPath(p.relPath), p as CardPage])) };
  }
  // Plain text, no links (they would be Tab stops on clipped lines): clamped
  // to three lines (CSS), the title carries the whole summary. The effort
  // page, one click away, links the pages.
  const text = effort.oneLine.trim() ? esc(proseText(effort.oneLine, effortProseMemo.byKey)) : "";
  const line = text ? `<span class="wiki-effort-oneline" title="${text}">${text}</span> ` : "";
  return (
    `<div class="wiki-effort-intro" data-section="activity" data-effort="${esc(effort.id)}">${line}` +
    `<a class="wiki-effort-open" href="${esc(deps.effortHrefFor(effort.id))}" data-effort-link="${esc(effort.id)}">Open ${effort.kind === "themes" ? "theme" : "effort"} →</a></div>`
  );
}

/** The `group by effort` checkbox: shown only on a wiki with a work map,
 *  checked from the store (absent `toggle:no-efforts` = on). */
export function paintEffortsToggle(): void {
  const wrap = document.getElementById("wikiEffortsToggle");
  const box = document.getElementById("wikiGroupEfforts") as HTMLInputElement | null;
  if (!wrap || !box) return;
  wrap.hidden = getWorkMapRunAt() === null;
  box.checked = effortsOn(openFolds, true);
  // The label's text node follows the checkbox (wiki-page.ts).
  const words = effortsToggleWords(deps.workMapThemes());
  if (wrap.title !== words.title) wrap.title = words.title;
  const text = box.nextSibling;
  if (text?.nodeType === Node.TEXT_NODE && text.textContent?.trim() !== words.label) text.textContent = words.label;
}

/** True while `renderList` puts focus back on the rail control its repaint replaced. */
let restoringRailFocus = false;

/** `cause: "storage"` is a repaint after another tab changed the pin: it runs
 *  no pin step, so it never writes (the no-loop rule, `threadPinStep`).
 *
 *  Focus (spec "Keep focus after updates"): a repaint never moves focus by
 *  itself. When the swap below drops focus from a rail control, the same
 *  control, found again by its own key, gets it back; otherwise focus is left
 *  alone. No cause gate: every caller (listed in `src/wiki/CLAUDE.md`, Work
 *  threads) can land while a rail control holds focus. A handler that focuses
 *  something after its own render still wins. */
export function renderList(cause: "storage" | "local" = "local"): void {
  deps.resetStaleRailPainted();
  paintEffortsToggle();
  const mode = deps.sortMode();
  // ONE anchored instant for the sort AND its row labels, so the date a row shows is
  // the date it sorted on even for a page sitting at the 48h future-guard boundary.
  const now = deps.recencyNow();
  // The rail's POOL — `#wikiCount`'s denominator below; `railInputFor` derives
  // the same pool for its own rows.
  const pool = railPool(deps.allPages(), showRetired(), deps.filters.q);
  // D7: keep the thread pin on the pinned thread's newest focus page, so the
  // pin survives the thread's oldest pages leaving the window
  // (`threadPinAnchor`); the state table decides whether that is written.
  if (cause === "local") {
    // D17: the grouping record runs the pin's table — adopt another tab's
    // record, or retry a refused write while this tab has focus (R6).
    stepWorkGroup({ kind: "render", stored: readWorkGroup(deps.WIKI()), focused: tabHasFocus() });
    // PR 4: a kept-apart anchor follows its thread's newest focus page, the
    // way the pin does (A1–A3), over the record as just adopted.
    const reanchor = workBoundariesOf(deps.workFacts(), deps.allPages(), workGroupPrefsOf(workGroupRec.held)).reanchor;
    if (reanchor.length) stepWorkGroup({ kind: "render", stored: readWorkGroup(deps.WIKI()), focused: tabHasFocus(), reanchor });
    // The pin re-anchors over the threads AFTER the reader's splits, never
    // the server's raw threads: a split page that becomes its source's newest
    // focus page must not pull the pin out of the remainder (S3).
    stepThreadPin({
      kind: "render",
      stored: readThreadPin(deps.WIKI()),
      focused: tabHasFocus(),
      anchor: threadPinAnchor(workBoundariesOf(deps.workFacts(), deps.allPages(), workGroupPrefsOf(workGroupRec.held)).derived, deps.allPages(), threadPin.held),
    });
  }
  const groupPrefs = workGroupPrefsOf(workGroupRec.held);
  const bounds = workBoundariesOf(deps.workFacts(), deps.allPages(), groupPrefs);
  workBounds = bounds;
  // The input assembly is `railInputFor` (`wiki-rail-input.ts`), shared with the
  // work replay.
  const railInput = railInputFor(
    {
      allPages: deps.allPages(),
      projects: deps.projects(),
      activityWeights: deps.activityWeights(),
      workedGate: deps.workedGate(),
      work: deps.workFacts(),
      // Built only when it can be used: the mode on, and no query (a search
      // flattens every group).
      efforts: effortsGrouped() && !deps.filters.q.trim() ? deps.railEffortsIndex(now) : null,
      // X1: a failed GET is not retried for this run time, so the rail draws
      // Work threads instead of waiting for it.
      effortMapFailed: getWorkMapRunAt() !== null && deps.railMapFailedAt() === getWorkMapRunAt(),
    },
    {
      mode,
      now,
      filters: deps.filters,
      showRetired: showRetired(),
      familiesOn: familiesOn(),
      effortsOn: effortsGrouped(),
      pins,
      openFolds,
      openRelPath: deps.currentRelPath() || undefined,
      threadPin: threadPin.held,
      workGroup: {
        stop: groupPrefs.stop,
        evidence: groupPrefs.evidence,
        moreOpen: [...workMoreOpen],
        splits: groupPrefs.splits,
        keptApart: groupPrefs.keptApart,
        sessionsOpen: [...workSessionsOpen],
        seriesWritable: seriesEditable(),
        boundaries: bounds,
      },
    },
  );
  workCardsDrawn = railInput.threads ?? [];
  const rail = buildRail(railInput);
  // The open page's sessions used to be a section at the head of this rail. They
  // are now rows in the chain under the page title, which is where they have
  // room; `railListHtml` below still owns the empty state, because the rule that
  // made it a function of the PAGE ROWS alone outlives the prefix that broke it.
  let html = "";
  // Read ONCE per render, not per row: the answer is a fact about the instance
  // and the wiki, and it is the same for all 953 rows.
  const canEditSeries = seriesEditable();
  // The Needs-you items ✓ on the card for the cached run: an effort fold's ✋
  // leaves them out, as the effort page does.
  const effortDone: ReadonlySet<string> = deps.workMapCache() ? workMapDoneSet(deps.workMapCache()!.body.map.runAtMs) : new Set();
  rail.entries.forEach((entry: RailEntry) => {
    // A WORK-THREAD card's header and its `touched:` line (`wiki-thread-view.ts`).
    if (entry.kind === "thread") {
      html += threadCardHeaderHtml(entry.card, entry.folded, now, movesPersonal(), entry.pages);
      return;
    }
    if (entry.kind === "touched") {
      html += threadTouchedHtml(entry.foldKey, entry.pages, deps.pageUrlByRelPath);
      return;
    }
    // PR 4: the Sessions stop's `also in:` line, a split thread's session
    // lines, and `▸ split into N sessions` (D19).
    if (entry.kind === "also-in") {
      html += threadAlsoInHtml(entry.foldKey, entry.pages, deps.pageUrlByRelPath);
      return;
    }
    if (entry.kind === "thread-session") {
      html += threadSessionLineHtml(entry.foldKey, entry.session, now);
      return;
    }
    if (entry.kind === "thread-sessions") {
      html += threadSessionsToggleHtml(entry.card);
      return;
    }
    // A GROUP card (plan `muninn-wiki-work-thread-grouping`): its header, and
    // when open the body that holds the child cards, closed by its end entry.
    if (entry.kind === "thread-group") {
      html += threadGroupHeaderHtml(entry.card, entry.folded, now, movesPersonal());
      if (!entry.folded) html += threadGroupBodyStartHtml(entry.foldKey);
      return;
    }
    if (entry.kind === "thread-group-end") {
      html += threadGroupEndHtml(entry.foldKey, entry.hidden, entry.context, deps.pageUrlByRelPath, entry.name, workContextOpen.has(entry.foldKey));
      return;
    }
    // The Pick up strip (plan `muninn-wiki-pick-up`): pointers, never rows.
    if (entry.kind === "pickup") {
      html += pickUpStripHtml(entry.rows, now);
      return;
    }
    if (entry.kind === "header" && entry.control) {
      html += workSectionHeaderHtml(entry.label, entry.control, workMenuOpen, workGroupRec.failed);
      return;
    }
    if (entry.kind === "header") {
      // A FOLDABLE header (today: Bookkeeping) is a real button: it carries the
      // count whether open or closed, so a collapsed section says how much it
      // holds rather than reading as an empty heading.
      if (entry.foldKey) {
        const label = entry.folded ? "Show" : "Hide";
        html +=
          `<div class="wiki-list-sec" data-section="${esc(entry.section)}">` +
          `<button type="button" class="wiki-sec-fold${entry.folded ? " folded" : ""}"` +
          ` data-fold-key="${esc(entry.toggleKey ?? entry.foldKey)}" aria-expanded="${entry.folded ? "false" : "true"}"` +
          // Forced open by the reader being on a page inside it: a click could
          // only write a stored key nothing on screen reflects, so the control
          // says what it is instead of behaving like a broken toggle. `disabled`
          // is what makes that true — a disabled button dispatches no click.
          (entry.forcedOpen ? ` disabled` : "") +
          // Pick up holds pointers, not pages: its hover names the strip.
          ` title="${esc(entry.forcedOpen ? forcedOpenWhy("section") : entry.section === "pickup" ? `${label} ${entry.label}` : label + " the " + entry.label.toLowerCase() + " pages")}">` +
          `<span class="wiki-fold-caret" aria-hidden="true">▸</span>` +
          `<span class="wiki-sec-label">${esc(entry.label)}</span>` +
          `<span class="wiki-sec-count">${entry.count ?? 0}</span>` +
          `</button></div>`;
        return;
      }
      html +=
        `<div class="wiki-list-sec" data-section="${esc(entry.section)}">` +
        `<span class="wiki-sec-label">${esc(entry.label)}</span>` +
        `</div>`;
      return;
    }
    // A FAMILY, MONTH or SERIES row: a fold control with a roll-up on it, and
    // the one row in this list that is not a page — no `data-relpath`, nothing
    // to open, and `#wikiCount` does not count it. A family or month reuses the
    // parent row's furniture (the caret, both chip label forms, the
    // `.wiki-list-mid` container) but takes its OWN breakpoint (`.is-group`,
    // `RAIL_GROUP_CHIP_SWITCH`): this
    // row's mid holds a label and a chip and nothing else — no type dot, no
    // status pill, no ⚑, no ★+date — so the width at which the words stop
    // fitting is a different number, and borrowing the parent row's hid the
    // roll-up behind a hover at the shipped 300px default.
    //
    // `data-fold-key` is the entry's `toggleKey`, which is the group's own key
    // for every group but the one that defaults open — that one offers the
    // `closed:` spelling, so this one generic handler writes the right key.
    if (entry.kind === "group") {
      const isSeries = entry.group.kind === "series";
      // A SERIES roll-up counts its ghost rows too — the pinned members are on
      // screen one section up, but they are members of the work and the roll-up
      // is a census of it. A family's chip drops a lifted member, because there the
      // lift really does take the page out of the slate for that render.
      const roll = groupRollup(
        entry.group.kind,
        isSeries ? [...entry.members, ...(entry.ghosts ?? [])] : entry.members,
        entry.superseded,
      );
      const why = entry.forcedOpen
        ? forcedOpenWhy("group")
        : (entry.folded ? "Show" : "Hide") +
          " the " +
          entry.group.label +
          (isSeries ? " series" : " pages");
      // `N of M shown` says a facet is hiding part of the series. It sits on its
      // OWN LINE under the label, inside the same box — beside it, it was inside
      // `.wiki-group-label`'s `overflow: hidden; nowrap`, where the label ate the
      // width first: measured 15px visible of 65 at the 300px shipped default
      // under `folder=plans`, i.e. clipped to nothing on every rail anybody has
      // while `toHaveText("3 of 4 shown")` still passed. A line under the label
      // costs `.wiki-list-mid` no width, so no chip breakpoint moves.
      const census = entry.census ? `${entry.census.shown} of ${entry.census.total} shown` : "";
      const hover = `${roll.label} — ${why}` + (census ? ` (${census})` : "");
      // A family or month chip: the same two size classes as a page chip, from
      // the same functions, so the two painters can never classify one label two
      // ways. On a group row `is-wide` selects RAIL_GROUP_CHIP_SWITCH (235) and
      // fires at the 260px rail; a one-kind roll-up's RAIL_CHIP_SWITCH_SHORT
      // (168) or, for `is-long`, _LONG (183) and the counts floors (≤ 156) bind
      // only in a window narrow enough to take the rail under 260px.
      // `groupRollup`'s `wide` field says the same thing as the label test.
      const chipHtml = isSeries
        ? ""
        : `<span class="wiki-fold-chip is-group${cls(foldChipLabelClass(roll.label))}` +
        `${cls(foldChipCountsClass(roll.compact))} static">` +
        `<span class="wiki-fold-chip-label">${esc(roll.label)}</span>` +
        `<span class="wiki-fold-chip-counts">${esc(roll.compact)}</span>` +
        `</span>`;
      html +=
        `<div class="wiki-list-group${isSeries ? " series" : ""}" data-section="${esc(entry.section)}" data-group="${esc(entry.foldKey)}">` +
        `<button type="button" class="wiki-group-fold${entry.folded ? " folded" : ""}"` +
        ` data-fold-key="${esc(entry.toggleKey)}" aria-expanded="${entry.folded ? "false" : "true"}"` +
        (entry.forcedOpen ? ` disabled` : "") +
        ` aria-label="${esc(entry.group.label + " · " + hover)}" title="${esc(hover)}">` +
        `<span class="wiki-fold-caret" aria-hidden="true">▸</span>` +
        `<div class="wiki-list-mid">` +
        `<div class="wiki-group-label">` +
        `<span class="wiki-group-name">${esc(entry.group.label)}</span>` +
        // A SERIES draws its roll-up as a line under the name instead of a chip
        // beside it: a five-status roll-up is ~310px, and sharing one line with
        // the name left the name at its 72px floor and the chip clipped too.
        // Each count is one unbreakable unit, so the line wraps between counts
        // and never clips one — a clipped count is a wrong count. The `·` rides
        // inside the count before it, so a wrapped line never starts with one.
        // Only the two coloured statuses get a class: the word is free
        // frontmatter and never becomes a class name of its own.
        (isSeries
          ? `<small class="wiki-group-rollup">` +
            roll.parts
              .map(
                (p, i) =>
                  `<span class="wiki-rollup-part${p.word === "shipped" || p.word === "in-flight" ? " s-" + p.word : ""}">${p.n} ${esc(p.word)}` +
                  (i < roll.parts.length - 1 ? `<span class="wiki-rollup-sep"> ·</span>` : "") +
                  `</span>`,
              )
              .join(" ") +
            `</small>`
          : "") +
        (census ? `<small class="wiki-group-sub">${esc(census)}</small>` : "") +
        `</div>` +
        chipHtml +
        `</div>` +
        `</button></div>`;
      return;
    }
    // An EFFORT fold row (work map P4): two controls, never one button — the
    // caret folds and the name opens the effort page (D2). Not a page row: no
    // `data-relpath`, and `#wikiCount` does not count it.
    if (entry.kind === "effort") {
      html += effortRowHtml(entry, now, effortDone);
      return;
    }
    // A GHOST row: a series member the reader pinned, so the real row is under
    // `Pinned` and this is a dim placeholder saying where it went. Deliberately
    // NOT a `.wiki-list-item` and carrying no `data-relpath` — that selector
    // must keep naming exactly one element per page (four e2e specs rely on it,
    // and `#wikiCount` would disagree with a second row for one page).
    if (entry.kind === "ghost") {
      // Lifted by a pin, or by an open work-thread card (D13) — the note says
      // which section above holds the real row.
      html += railGhostHtml(entry.page.relPath, displayTitleOf(entry.page), entry.reason);
      return;
    }
    // An open effort fold's head (D14): its summary and «Open effort →».
    if (entry.kind === "effort-intro") {
      html += effortIntroHtml(entry.effort);
      return;
    }
    // An open effort fold's «+N more» (D14), its own stored key; once pressed it
    // stays as «Show fewer», so focus has a control to come back to.
    if (entry.kind === "more" && entry.effort) {
      const label = entry.expanded ? "Show fewer" : `+${entry.hidden} more`;
      const why = entry.expanded
        ? `Show the first pages of ${entry.effort.name} only`
        : `Show the other ${entry.hidden} ${entry.hidden === 1 ? "page" : "pages"} of ${entry.effort.name}`;
      html +=
        `<button type="button" class="wiki-list-more wiki-effort-more" data-section="${esc(entry.section)}"` +
        ` data-fold-key="${esc(entry.toggleKey)}" aria-expanded="${entry.expanded ? "true" : "false"}"` +
        ` title="${esc(why)}" aria-label="${esc(why)}">${esc(label)}</button>`;
      return;
    }
    // The `+N more` row under a CLOSED series in Activity: a second button for
    // the same fold, so the generic `[data-fold-key]` handler opens the series.
    // Not a page row — no `data-relpath`, and `#wikiCount` does not count it.
    if (entry.kind === "more") {
      const label = `+${entry.hidden} more`;
      html +=
        `<button type="button" class="wiki-list-more wiki-series-cont" data-section="${esc(entry.section)}"` +
        ` data-fold-key="${esc(entry.toggleKey)}" aria-expanded="false"` +
        ` title="${esc(`Show the other ${entry.hidden} ${entry.hidden === 1 ? "member" : "members"} of this series`)}">${esc(label)}</button>`;
      return;
    }
    const p = entry.page;
    // The page whose dates the cell reads: the attachment child that earned a
    // rolled-up Activity row (`via`), else the row's own page.
    const datePage = entry.activity?.via ?? p;
    // WHICH SIGNAL this row's date comes from: the one that PUT an Activity row
    // there, the one the list SORTED on for every other row. `null` is the
    // backlinks mode, whose rows count links rather than days. In every recency
    // mode the date shown is the one actually sorted on (mtime/birthtime or
    // frontmatter) — otherwise a frontmatter-less page would show nothing while
    // sitting at the top, which is exactly what looked broken before.
    // A work-thread row is about the work, so its cell is the worked-on date
    // whatever the sort (the `13h` the card's sketch shows).
    const signal: "added" | "updated" | "worked" | null = entry.activity
      ? entry.activity.kind === "new"
        ? "added"
        : entry.activity.worked
          ? "worked"
          : "updated"
      : entry.thread
        ? "worked"
        : mode === "backlinks"
        ? null
        : // `isRecencySort` is a TYPE PREDICATE, so the mode goes straight to the
          // shared `recencyKindFor` and the mode→kind map lives in one place.
          // `title` is deliberately NOT folded in here: it falls through to the
          // update date, which is what that mode has always shown in this cell.
          isRecencySort(mode)
          ? recencyKindFor(mode)
          : "updated";
    // ONE signal derivation per row — the stamp AND the label in a single call,
    // because this runs for every row on every keystroke (1261 of them on jarvis).
    const dateSignal = signal === null ? null : pageDateSignal(datePage, signal, now);
    // The STAMP the age counts from. For an Activity row it is the one the
    // ranking already derived (`now - ageMs`, off the same anchored instant), so
    // the row's date and its `why` sentence cannot disagree about the age; for a
    // listing row it is the sort key itself.
    const stampMs = entry.activity ? now - entry.activity.ageMs : (dateSignal?.ms ?? 0);
    // The full date, from the SAME signal — kept one hover away below.
    const fullDate = dateSignal?.label ?? "";
    // In WORKED-ON mode the hover also names WHICH signal answered, because the
    // axis is sparse by construction: a covered wiki still holds pages with no
    // worked date (every write discounted as a bulk pass) that fall back to the
    // update signal, so a bare day would read as a worked date the page never
    // earned. The suffix goes on the `title=` ONLY — `formatRailAge` reads
    // `fullDate` as a BARE day and would fall back to `localDay(ms)` for a
    // decorated one, which shifts a frontmatter date west of UTC.
    // Where a worked-on date came from, marked on the chip: a session wrote it
    // (`worked`, and `changed-since` when a change landed after that session with
    // no ledger row) or no session did (`fallback`). An Activity "changed" row on
    // a wiki whose worked gate is open is a fallback too when the page has neither
    // a usable ledger row nor usable session events — the one case its update
    // date stands in for a worked day. A page WITH usable events never takes
    // `fallback`: its winning worked term keeps its `worked` mark, otherwise it
    // takes the `events` kind (its T/T0 touch still marked) or no mark at all
    // (`activityRowSource`).
    const source: WorkedSource | null =
      entry.activity && signal !== null
        ? activityRowSource(datePage, now, signal, dateSignal, entry.activity.kind, !!deps.workedGate()?.open, deps.workedGate()?.asOfMs)
        : signal === "worked" && dateSignal
          ? workedAxisSource(datePage, now, dateSignal, deps.workedGate()?.asOfMs)
          : null;
    const chip = workedChip(source, fullDate, dateSignal?.kind === "added" ? "added" : "updated");
    // A NEW page (its own creation won, not a child's) says so in the date cell:
    // a bordered NEW tag and the age in the same green. "Changed" is Activity's
    // default and carries no mark — its `why` hover holds the derivation.
    // A work-thread row created inside the work window says NEW too.
    const isNew = (entry.activity?.kind === "new" && !entry.activity.via) || !!entry.created;
    const metaClass = chip.cls + (isNew ? " new" : "");
    const dateTitle = chip.title;
    // Every rail row shows a COMPACT age (`formatRailAge`, whose docblock has the
    // why), the backlinks sort its link count instead.
    const meta = signal === null ? p.backlinkCount + " ←" : formatRailAge(stampMs, now, fullDate);
    // Both keys on every row: `data-relpath` is what the click delegate and the
    // active test use (it names ONE page), `data-page` stays for anything still
    // reading the name. `isActivePage` falls back to the name comparison only
    // while no relPath is known — see `wiki-nav.ts`.
    const active = isActivePage(p, { name: getCurrentName(), relPath: deps.currentRelPath() });
    // A CHILD row says on hover why it folds and under which page — the rail's
    // only place to state a relation the file names cannot. An Activity row's own
    // derivation wins the attribute (it explains the placement, which is the
    // stranger fact of the two) and the `why` line carries the parent instead.
    const childWhy = entry.child
      ? pairedByWhy(entry.child.pairedBy, displayTitleOf(entry.child.parent))
      : "";
    const memberWhy = railMemberWhy(entry.member);
    // The latest dot (a pseudo-element on the series rail) says WHAT it is here,
    // because a dot cannot: the words live in the reader header.
    const latestWhy = entry.latest ? "newest plan in this series that is not retired" : "";
    const threadWhy = entry.thread ? `In the ${entry.thread.name} work thread` : "";
    const pills = railIssuePillsHtml(p.issues, (id) => deps.trackerLabels()[id] ?? "");
    // A retired row (the toggle is on, or a search found it) says so on hover;
    // the row itself is muted by `.culled` and grows no element.
    const culledWhy = p.culled ? cullLabels().marker : "";
    const rowTitle = [culledWhy, entry.activity?.why ?? "", childWhy, memberWhy, threadWhy, latestWhy]
      .filter(Boolean)
      .join("\n");
    // The META LINE, under the title: status pill · ⚑ · ✋ · NEW · group chip.
    // Line one is icon · title · ★+age only, so the title has the row's width
    // less the age, and every title starts at the same x. A row with none of
    // these has no meta line and stays one line tall. Pill THEN ⚑ THEN ✋, the
    // article header's order (`badgeHtml`, then the lane pills after the last
    // badge) — the two surfaces show the same facts and must not read
    // differently.
    // The group CHIP: what is folded under this row, and the control that
    // opens it. A click here toggles; a click anywhere else on the row opens
    // the page, as it always has.
    const compact = entry.children?.length ? foldChipCompactLabel(entry.children) : "";
    const chipHtml = entry.children?.length
      ? (() => {
          const full = foldChipLabel(entry.children);
          // The chip's two size classes are the LABEL's, not the group's: the
          // words pick the breakpoint at which they yield to the counts (three
          // shapes, three measured budgets), and the digits pick how much row
          // the compact form is guaranteed — see `foldChipLabelClass` and
          // `foldChipCountsClass`.
          const sizeClasses = cls(foldChipLabelClass(full)) + cls(foldChipCountsClass(compact));
          const why = entry.forcedOpen
            ? forcedOpenWhy("group")
            : (entry.folded ? "Show" : "Hide") + " what folds under this page";
          // The full label rides BOTH attributes whichever form is painted —
          // the compact form is the words moved to the hover, not dropped, and
          // `aria-label` is what makes that true for a screen reader as well
          // (a `display:none` span is out of the accessible name).
          // The dot is drawn by CSS (`.newer::after`, absolute — no chip
          // width), so its meaning lives here, on both attributes.
          const hover = `${full} — ${why}` + (entry.childNewer ? " (something inside changed after this page)" : "");
          return (
            `<button type="button" class="wiki-fold-chip${sizeClasses}${entry.folded ? " folded" : ""}${entry.childNewer ? " newer" : ""}"` +
            ` data-fold-key="${esc(normalizeFoldKey(p.relPath))}" aria-expanded="${entry.folded ? "false" : "true"}"` +
            // Forced open because the reader is ON a page in this group: the same
            // inert control the section header renders, for the same reason.
            (entry.forcedOpen ? ` disabled` : "") +
            ` aria-label="${esc(hover)}" title="${esc(hover)}">` +
            `<span class="wiki-fold-caret" aria-hidden="true">▸</span>` +
            // Both forms are rendered and CSS picks one (`wiki-page.ts`): which
            // fits is a question about the row's remaining space, which the
            // server does not have and the client would have to recompute on
            // every rail drag.
            `<span class="wiki-fold-chip-label">${esc(full)}</span>` +
            `<span class="wiki-fold-chip-counts">${esc(compact)}</span>` +
            `</button>`
          );
        })()
      : "";
    // The chip goes LAST in a slot that takes the rest of the line: the slot is
    // its container, so it swaps words for counts by the room the other marks
    // leave, not by the whole line's width. The slot's floor is the compact
    // form's (its counts class), so a line too full for that wraps the chip.
    const chipSlot = chipHtml
      ? `<span class="wiki-fold-chip-wrap${cls(foldChipCountsClass(compact))}">${chipHtml}</span>`
      : "";
    // The work bar goes FIRST, into the meta line's icon gutter (`wiki-page.ts`),
    // so it takes no room from the marks: pill + ⚑ + ✋ 12 + NEW + bar in line
    // left the chip 36px at the 260px rail, under its 46px floor, and it wrapped.
    const subItems =
      workBarHtml(p, now) +
      statusPillHtml(p) +
      followupFlagHtml(p) +
      movesFlagHtml(p) +
      (isNew ? `<span class="wiki-new-tag" title="New page">NEW</span>` : "") +
      // The page's role in its effort (D14), on a row inside an open effort fold.
      (entry.role ? `<span class="wiki-effort-role" title="${esc(`Role in the ${entry.member?.theme ? "theme" : "effort"}: ${entry.role}`)}">${esc(entry.role)}</span>` : "") +
      // The Stale check's two numbers (PR 2b, D26), off the summary route.
      deps.railStaleBadge(p.relPath) +
      chipSlot;
    const sub = subItems ? `<div class="wiki-list-sub">${subItems}</div>` : "";
    html +=
      // The indent is for a row drawn INSIDE its parent's group. A lifted child
      // (Activity ranked it, or the reader pinned it) sits under an unrelated
      // row, where an indent + left rule claims a parentage the rail invented;
      // it keeps the hover sentence, which is the true statement of the two.
      // A group MEMBER is indented under its group's row, and a member's own
      // attachment child indents one level further (`.member.child`) — at the
      // family's own depth it would read as a sibling of the page it belongs to.
      // A SERIES member (and its attachment child) also carries
      // `wiki-series-cont`, which runs the series' accent rail through the row.
      `<div class="wiki-list-item${active ? " active" : ""}${p.culled ? " culled" : ""}${entry.child && !entry.lifted ? " child" : ""}${entry.member ? " member" : ""}${entry.member?.kind === "series" ? " wiki-series-cont" : ""}${entry.thread ? " thread-row" : ""}${entry.thread?.session ? " session-row" : ""}${entry.latest ? " latest" : ""}" data-section="${esc(entry.section)}" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}"` +
      // The derivation on the ROW, and again on the title element below:
      // the child's own `title=` wins the hover over most of the row's width.
      (rowTitle ? ` title="${esc(rowTitle)}"` : "") +
      `>` +
      // The type ICON, a fixed 14px lead column on EVERY row — Activity rows grow
      // no extra column, so their titles line up with their neighbours'.
      railTypeIconHtml(p.type) +
      // The title's box, `.wiki-list-mid`: what is left of line one after the
      // icon and the ★+age. The ✋ and the group chip used to share it; they are
      // on the meta line below, with the pill and the ⚑.
      `<div class="wiki-list-mid">` +
      // `title=` carries the full name, since the title clamps at two lines. On
      // an Activity row it carries the derivation UNDER the name as well — this
      // element is most of the row, and its own `title` is what the pointer
      // lands on there, so the row's attribute alone is unreachable over it.
      (pills
        ? // A row with issue pills: the title element becomes a flex pair — the
          // clamped text, and the pills in their own column beside it — so the
          // clamp can never hide them. Rows without pills keep the plain markup.
          `<div class="wiki-list-title has-issues" title="${esc(displayTitleOf(p) + (rowTitle ? "\n" + rowTitle : ""))}">` +
          `<span class="wiki-list-title-text">${esc(displayTitleOf(p))}</span>` +
          pills +
          `</div>`
        : `<div class="wiki-list-title" title="${esc(displayTitleOf(p) + (rowTitle ? "\n" + rowTitle : ""))}">` +
          `${esc(displayTitleOf(p))}</div>`) +
      `</div>` +
      // ★ and date in ONE flex slot: as a sibling of the title the ★ also cost
      // the row's 8px `gap`, and the pair measured 21px off `.wiki-list-title`
      // on every row — a third of the title box at RAIL_WIDTH_MIN, paid by a
      // reader who never pins anything.
      `<div class="wiki-list-end">` +
      // The series `⋯`, in the ★'s slot and revealed by this row's own hover.
      // Unlike the ★ it is OUT OF FLOW while hidden (`wiki-page.ts`): the row's
      // six items are each budgeted by `wiki-rail-width.ts`, and a seventh took
      // the end slot to 90px and wrapped a plan row's title under its floor on
      // CI's fonts — out of flow, it costs the row's layout nothing.
      // Absent entirely on a read-only instance or root, and on a page no
      // series may claim (`canEditSeriesPage`: an `.html` attachment, an
      // `index.md`), where the only thing a click could produce is a refusal.
      // On a work thread's focus row (PR 4) the ⋯ is a PAGE menu holding Make
      // own thread above the series items; where no series opener applies it
      // still renders, on its own attribute, holding Make own thread only. A
      // Sessions-stop card's rows are not a thread's: today's opener.
      (entry.thread && !entry.thread.session && rowBoundaryAction(bounds, deps.workFacts(), p.relPath)
        ? canEditSeries && canEditSeriesPage(p.relPath)
          ? seriesMenuBtnHtml(p.relPath, !!p.series, true)
          : threadRowMenuBtnHtml(p.relPath)
        : canEditSeries && canEditSeriesPage(p.relPath)
          ? seriesMenuBtnHtml(p.relPath, !!p.series)
          : "") +
      pinBtnHtml(entry.pinned) +
      // The full date on the META element, never on the row — same reason the
      // derivation is repeated onto `.wiki-list-title` above. It carries the
      // signal's label verbatim, time and all, since a hover has room for it.
      `<div class="wiki-list-meta${metaClass}"${dateTitle ? ` title="${esc(dateTitle)}"` : ""}>${esc(meta)}</div>` +
      `</div>` +
      sub +
      `</div>`;
  });
  // Scroll restore lives HERE, not at the refresh call site (the `renderBacklog`
  // precedent): every deferred-apply path ends in its caller's own renderList, so
  // a capture/restore wrapped around the adopt was undone a frame later. Owning it
  // inside the one function that replaces the rows makes the guarantee hold on
  // every path — a background refresh can never yank a reader to the top.
  const listEl = document.getElementById("wikiList")!;
  const scroll = listEl.scrollTop;
  // Retired pages held back under these facets: the empty rail offers them.
  const heldBack = retiredHeldBack();
  const focusedEl = document.activeElement;
  const keptFocus = railControlSelector(focusedEl);
  listEl.innerHTML = railListHtml(html, retiredRevealHtml(heldBack));
  if (keptFocus && (!document.activeElement || document.activeElement === document.body)) {
    // The control focus was already on: a popover that closes on focus leaving
    // it (the options pane) must not read this as the reader moving.
    restoringRailFocus = true;
    try {
      refocusRailControl(keptFocus, focusedEl!);
    } finally {
      restoringRailFocus = false;
    }
  }
  // ⚠️ Measured DEAD in Chromium and kept anyway: an `innerHTML` swap PRESERVES
  // `scrollTop` when the new content is at least as tall (300 → 300), and when it
  // is shorter the browser clamps to the new maximum and re-assigning the saved
  // value re-clamps to the same number (saved 2398 → 0 → 0). So this line changes
  // nothing here. It is not deleted because scroll preservation across an
  // `innerHTML` replacement is not specified — Firefox and WebKit may reset to 0
  // — and `playwright.config.ts` runs only Chromium, so the half of that state
  // space where the line matters is not buildable in this harness.
  if (scroll) listEl.scrollTop = scroll;
  // `rail.shown` counts DISTINCT pages among the rendered rows, so a page that
  // appears both in a recall section and in the listing below is one, and a jump
  // hit the query itself would not have matched is counted.
  // The denominator is the POOL, so a hidden retired page is in neither number;
  // the hover is the toggle's own text with the same facet-aware N, in the
  // wiki's own words.
  const countEl = document.getElementById("wikiCount")!;
  countEl.textContent = rail.shown + " / " + pool.length;
  if (heldBack) countEl.setAttribute("title", cullToggleText(heldBack));
  else countEl.removeAttribute("title");
  paintRetiredToggle();
  if (getRevealOnRender() && deps.allPages().length) {
    setRevealOnRender(false);
    revealActiveRow(false);
  }
}

/**
 * Scroll the rail so the open page's row is on screen. A page can hold two rows
 * (an Activity row and its listing row); when either is already wholly visible
 * nothing moves, so a row the reader just clicked stays under the pointer.
 * Scrolls `#wikiList` only — `scrollIntoView` would scroll the page as well.
 * Returns false when the rail has no row for the open page.
 */
function revealActiveRow(flash: boolean): boolean {
  const listEl = document.getElementById("wikiList");
  if (!listEl) return false;
  const rows = Array.from(listEl.querySelectorAll<HTMLElement>(".wiki-list-item.active"));
  if (!rows.length) return false;
  const box = listEl.getBoundingClientRect();
  let row = rows.find((r) => rowFullyVisible(box, r.getBoundingClientRect()));
  if (!row) {
    row = rows[0]!;
    const top = revealScrollTop(box, row.getBoundingClientRect(), listEl.scrollTop);
    if (top !== null) listEl.scrollTop = top;
  }
  if (flash) {
    row.classList.remove("reveal-flash");
    void row.offsetWidth; // restart the animation on a repeat click
    row.classList.add("reveal-flash");
  }
  return true;
}

/**
 * A Pick up row's jump (plan `muninn-wiki-pick-up`, D12): at any stop, the
 * target is the drawn card that holds the page now. Its group opens, `+ N
 * more threads` is pressed for a child behind it, the card opens; then the
 * row scrolls into view, flashes and stays highlighted until the next render.
 * With no drawn card holding the page, the page itself opens. Each step
 * re-reads the cards a render drew (`pickUpStep`), so the folds' two-spelling
 * rule decides every write. Focus stays on the strip row through those
 * renders (`data-pickup` is a rail control `renderList` restores), then moves
 * to the drawing card's fold, the header control a later render restores
 * (`railControlSelector`); the scroll keeps that header and the row in view
 * when both fit. Page rows get no `tabindex`.
 */
function jumpToPickUp(rel: string): void {
  const page = findPageByRelPath(deps.allPages(), rel);
  if (!page) return;
  // Two opening steps at most (the group with `+ N more`, then the child),
  // then `drawn`; four rounds leave a spare.
  for (let i = 0; i < 4; i++) {
    const step = pickUpStep(workCardsDrawn, page.relPath);
    if (step.kind === "page") {
      deps.loadPageByRelPath(page.relPath);
      return;
    }
    if (step.kind === "drawn") break;
    for (const key of step.toggle) openFolds = toggleFolded(deps.WIKI(), key);
    if (step.more) workMoreOpen.add(step.more);
    renderList();
  }
  const listEl = document.getElementById("wikiList");
  const row = listEl?.querySelector<HTMLElement>(`.wiki-list-item[data-section="threads"][data-relpath="${CSS.escape(page.relPath)}"]`);
  if (!listEl || !row) {
    deps.loadPageByRelPath(page.relPath);
    return;
  }
  const t = pickUpTarget(workCardsDrawn, page.relPath);
  const fold = t ? listEl.querySelector<HTMLElement>(`.wiki-thread-card[data-thread="${CSS.escape(t.card.foldKey)}"] > .wiki-thread-fold`) : null;
  const box = listEl.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const h = fold?.getBoundingClientRect();
  // Header and row together when they fit, else the row alone.
  const span = h ? { top: Math.min(h.top, r.top), bottom: Math.max(h.bottom, r.bottom) } : r;
  const top = revealScrollTop(box, span.bottom - span.top <= box.bottom - box.top ? span : r, listEl.scrollTop);
  if (top !== null) listEl.scrollTop = top;
  listEl.querySelectorAll(".wiki-list-item.pickup-hl").forEach((el) => el.classList.remove("pickup-hl"));
  row.classList.add("pickup-hl");
  row.classList.remove("reveal-flash");
  void row.offsetWidth; // restart the animation on a repeat jump
  row.classList.add("reveal-flash");
  fold?.focus({ preventScroll: true });
}

/**
 * ⌖ Show in list: give the open page a rail row and scroll to it. Clears only
 * the filters that hide the page (`filtersRevealing`), turns `Show retired` on
 * for a retired page, and leaves focus mode, which hides the rail.
 */
export function showOpenPageInList(): void {
  const page = deps.currentRelPath()
    ? findPageByRelPath(deps.allPages(), deps.currentRelPath()!)
    : getCurrentName()
      ? findPageByName(deps.allPages(), getCurrentName()!)
      : undefined;
  if (!page) return;
  leaveFocusMode();
  const next = filtersRevealing(page, deps.filters);
  if ((Object.keys(next) as (keyof WikiFilters)[]).some((k) => next[k] !== deps.filters[k])) {
    Object.assign(deps.filters, next);
    (document.getElementById("wikiSearch") as HTMLInputElement).value = deps.filters.q;
    deps.writeProjectParam();
    deps.writeJiraParam();
    renderPageFacets(false);
    // After the chip rows, which may clear a project or jira key (`repaintForProject`).
    deps.refreshCrumbHref();
    deps.refreshStartBody();
  }
  if (page.culled && !showRetired() && !deps.filters.q.trim()) setShowRetired(true);
  else renderList();
  revealActiveRow(true);
}

/** The payload-derived facet renders, in one place so the boot load and a
 *  refresh adopt can't drift. Paints no rows — `renderList` owns those. */
export function renderPageFacets(autoOpen: boolean): void {
  renderDomainChips();
  renderFolderSelect();
  renderTypeChips();
  renderStatusChips();
  renderProjectChips();
  renderJiraChips();
  renderTagChips();
  syncFilters(autoOpen);
}

// ── Coverage footer (under the page list) ─────────────────────────────
// A one-line index-coverage summary linking the full Index card on the start
// view. Reuses the same /api/wiki/index-coverage endpoint as that card; a
// no-collections/degraded/failed response simply hides the footer.
export function loadCoverageFooter(): void {
  const el = document.getElementById("wikiCoverageFoot");
  if (!el || !wikiToolsFlag()) return;
  fetch(deps.withWiki("/api/wiki/index-coverage"))
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

// ── Rail focus after a repaint, and the Group menu's open state ──────
/** After a `renderList` that replaced the control the reader pressed, focus the
 *  same control again wherever it now is (the related-order precedent), so a
 *  keyboard reader's next Tab continues from it instead of from the page top.
 *  Prefers a match of the same kind when a key names two controls. */
function refocusRailControl(selector: string, pressed: Element): void {
  const found = Array.from(document.querySelectorAll<HTMLElement>(selector));
  const kind = pressed.classList[0];
  const pick =
    found.find((el) => el.classList[0] === kind) ??
    found[0] ??
    // A Pick up row whose page a refresh pushed out of the five: the strip's
    // first row, else its header (folded), rather than `<body>`.
    (pressed.hasAttribute("data-pickup")
      ? (document.querySelector<HTMLElement>("#wikiList .wiki-pickup-row") ??
        document.querySelector<HTMLElement>('#wikiList .wiki-list-sec[data-section="pickup"] [data-fold-key]'))
      : null);
  pick?.focus({ preventScroll: true });
}

/** Focus the Group menu's item for `selector`, else its first item. */
function focusWorkMenuItem(selector?: string): void {
  const menu = document.querySelector<HTMLElement>("#wikiList .wiki-work-menu");
  const items = menu ? Array.from(menu.querySelectorAll<HTMLElement>("[role^='menuitem']")) : [];
  const pick = (selector ? menu?.querySelector<HTMLElement>(selector) : null) ?? items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0];
  pick?.focus({ preventScroll: true });
}

const WORK_FORGET_SEL = "[data-work-forget-split], [data-work-forget-anchor]";

/** A reset-area Forget's stable selector: its kind and its split id or page. */
function workForgetKey(el: HTMLElement): string {
  const attr = el.hasAttribute("data-work-forget-split") ? "data-work-forget-split" : "data-work-forget-anchor";
  return `[${attr}="${CSS.escape(el.getAttribute(attr) ?? "")}"]`;
}

export function focusWorkMenuButton(): void {
  document.querySelector<HTMLElement>("#wikiList [data-work-group-menu]")?.focus({ preventScroll: true });
}

/** Open or close the Group menu and repaint; focus follows the menu. */
function setWorkMenu(open: boolean, focus: boolean): void {
  workMenuOpen = open;
  renderList();
  if (!focus) return;
  if (open) focusWorkMenuItem();
  else focusWorkMenuButton();
}

/** The rail control `el` is, as a selector by its own key that finds it again
 *  after a repaint; null for anything else (a page row, a link other than an
 *  effort fold's name). Covers the Group button and its menu items, `+ N more
 *  threads`, the shared context's `+N`, a 📌 (by its card's key, never by
 *  position), an effort fold's name (by effort id), and every
 *  `[data-fold-key]` fold in the rail: thread, group and child cards, series
 *  and folder groups, Bookkeeping, under either spelling. */
export function railControlSelector(el: Element | null): string | null {
  if (!(el instanceof HTMLElement) || !el.closest("#wikiList")) return null;
  const at = (attr: string, v: string) => `#wikiList [${attr}="${CSS.escape(v)}"]`;
  for (const attr of [
    "data-work-stop",
    "data-work-evidence",
    "data-thread-more",
    "data-thread-ctx-more",
    // PR 4: a card's ⋯ (by its card's fold key), `▸ split into N sessions`
    // (by its card's fold key), a focus row's own ⋯ (by its page) and Reset.
    "data-work-card-menu",
    "data-thread-sessions",
    "data-thread-row-menu",
    "data-work-reset",
    // A Pick up row, by its page: kept through the renders a jump runs.
    "data-pickup",
    // An effort fold's name, by effort id: opening the effort repaints the rail.
    "data-effort-link",
  ]) {
    const v = el.getAttribute(attr);
    if (v !== null) return at(attr, v);
  }
  const fold = el.getAttribute("data-fold-key");
  if (fold !== null) {
    // Either spelling, as the fold's own click handler looks for.
    const base = fold.startsWith(CLOSED_FOLD_PREFIX) ? fold.slice(CLOSED_FOLD_PREFIX.length) : fold;
    return `${at("data-fold-key", base)}, ${at("data-fold-key", CLOSED_FOLD_PREFIX + base)}`;
  }
  // A thread row's page menu (a tab stop, unlike a plain row's ⋯), by page.
  const seriesRow = el.getAttribute("data-series-menu");
  if (seriesRow !== null && el.closest(".wiki-list-item.thread-row")) {
    return `#wikiList .wiki-list-item.thread-row [data-series-menu="${CSS.escape(seriesRow)}"]`;
  }
  if (el.hasAttribute("data-thread-pin")) {
    const cardEl = el.closest(".wiki-thread-card");
    const attr = cardEl?.hasAttribute("data-thread-group") ? "data-thread-group" : "data-thread";
    const card = cardEl?.getAttribute(attr);
    return card ? `#wikiList .wiki-thread-card[${attr}="${CSS.escape(card)}"] [data-thread-pin]` : null;
  }
  return el.hasAttribute("data-work-group-menu") ? "#wikiList [data-work-group-menu]" : null;
}

/** One explicit edit from the Group menu: merged onto the record as read now
 *  and written (D17); the first edit is what creates the record. */
export function editWorkGroup(edit: WorkGroupEdit): void {
  stepWorkGroup({ kind: "click", stored: readWorkGroup(deps.WIKI()), edit });
}

// ── Accessors: the rail state the shell and the ⋯ menus read or set ──
/** Flip one stored fold or toggle by its key (the ⋯ menus' Save as series
 *  carries a group's open state onto its new key). */
export function toggleRailFold(toggleKey: string): void {
  openFolds = toggleFolded(deps.WIKI(), toggleKey);
}

export function getWorkGroupRec(): WorkGroupRecordState {
  return workGroupRec;
}

export function getWorkBounds(): WorkBoundaries | null {
  return workBounds;
}

export function getWorkCardsDrawn(): readonly RailWorkCard[] {
  return workCardsDrawn;
}

export function getRestoringRailFocus(): boolean {
  return restoringRailFocus;
}

// ── Boot: called by the shell's boot(), each where its statements stood ───
/** Take the port, then read this wiki's stored rail state: the pins, the folds,
 *  the thread pin and the grouping record. */
export function initRail(d: RailDeps): void {
  deps = d;
  pins = readPins(deps.WIKI());
  openFolds = readFolds(deps.WIKI());
  threadPin = threadPinStep({ held: null, known: undefined }, { kind: "boot", stored: readThreadPin(deps.WIKI()) }).state;
  workGroupRec = workGroupRecordStep(
    { held: null, known: undefined, patch: null, failed: false },
    { kind: "boot", stored: readWorkGroup(deps.WIKI()) },
  ).state;
}

/** The list's click delegate, the search box and the facet rows. */
export function registerRail(): void {
  /**
   * The rail's own control: the ★ pin on every row.
   *
   * On `#wikiList`, not on the shell's body click delegate — the control sits INSIDE a
   * `.wiki-list-item`, and that delegate opens whatever `[data-relpath]` a click
   * landed in. A listener on the list runs first because it is deeper in the tree.
   *
   * ⚠️ It deliberately does NOT call `stopPropagation`; the body delegate skips
   * this control by selector instead, so a handler on ONE widget cannot
   * silence unrelated document-level listeners.
   *
   * **Correcting the claim this comment first carried**, which a verify pass
   * disproved by measurement: the failure named was "with the Discuss popover
   * open, a click on a ★ leaves the popover standing". It cannot happen. The
   * popover renders a full-viewport scrim (`.wiki-chatopt-scrim`), so a real click
   * never reaches the rail at all — and forced past the scrim, the popover stays
   * open regardless, because `shouldCloseChatOptions` returns false while
   * unattached and `renderList` swaps the clicked element out of the
   * document synchronously, before any document listener runs. The rule stands as
   * a rule; the story about it was invented.
   */
  document.getElementById("wikiList")!.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest) return;
    // A click outside the open Group menu closes it in the pressed control's own
    // render, which also refocuses that control; the document handler below
    // repaints only when no render here removed the menu.
    if (workMenuOpen && !target.closest(".wiki-work-menu, [data-work-group-menu]")) workMenuOpen = false;
    // The Group control and its menu (plan `muninn-wiki-work-thread-grouping`).
    // Menu items are buttons, so a keyboard Enter or Space lands here too.
    if (target.closest("[data-work-group-menu]")) {
      e.preventDefault();
      setWorkMenu(!workMenuOpen, true);
      return;
    }
    // PR 4: Reset your splits and groups — clears the record's four
    // preferences as this tab shows them (D1), through the state table like
    // any edit; an entry another tab added unseen stays. The menu closes and
    // focus returns to the Group button, which reopens it.
    if (target.closest("[data-work-reset]")) {
      e.preventDefault();
      editWorkGroup({ reset: true });
      deps.showWorkBoundaryStatus(null);
      setWorkMenu(false, true);
      return;
    }
    // Forget one definition the reset area lists (it has no Return or Allow
    // grouping item); the menu stays open. Focus, by key, after the repaint:
    // the Forget now at the forgotten one's place (the next), else the previous,
    // else the menu's default item (its checked stop) — never Reset, which sits
    // above every entry, so a second Enter never wipes the record.
    const forget = target.closest<HTMLElement>(WORK_FORGET_SEL);
    if (forget) {
      e.preventDefault();
      const keys = Array.from(document.querySelectorAll<HTMLElement>(`#wikiList .wiki-work-menu :is(${WORK_FORGET_SEL})`), workForgetKey);
      const at = keys.indexOf(workForgetKey(forget));
      const next = at < 0 ? [] : [...keys.slice(at + 1), ...keys.slice(0, at).reverse()];
      const id = forget.getAttribute("data-work-forget-split");
      editWorkGroup(id !== null ? { forgetSplit: id } : { allowGrouping: [forget.getAttribute("data-work-forget-anchor") ?? ""] });
      deps.showWorkBoundaryStatus(null);
      renderList();
      focusWorkMenuItem(next.find((sel) => document.querySelector(`#wikiList .wiki-work-menu ${sel}`)));
      return;
    }
    // PR 4: a card's ⋯ and a focus row's ⋯ (the one with no series menu).
    const cardMenuBtn = target.closest<HTMLElement>("[data-work-card-menu]");
    if (cardMenuBtn) {
      e.preventDefault();
      deps.openWorkCardMenu(cardMenuBtn);
      return;
    }
    const rowMenuBtn = target.closest<HTMLElement>("[data-thread-row-menu]");
    if (rowMenuBtn) {
      e.preventDefault();
      deps.openThreadRowMenu(rowMenuBtn);
      return;
    }
    // PR 4: `▸ split into N sessions` — per tab, never stored.
    const splitBtn = target.closest<HTMLElement>("[data-thread-sessions]");
    if (splitBtn) {
      e.preventDefault();
      if (splitBtn.getAttribute("aria-disabled") === "true") return;
      const key = normalizeFoldKey(splitBtn.getAttribute("data-thread-sessions") ?? "");
      if (!key) return;
      const hadFocus = document.activeElement === splitBtn;
      if (workSessionsOpen.has(key)) workSessionsOpen.delete(key);
      else workSessionsOpen.add(key);
      renderList();
      if (hadFocus) document.querySelector<HTMLElement>(`#wikiList [data-thread-sessions="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
      return;
    }
    const stopBtn = target.closest("[data-work-stop]");
    if (stopBtn) {
      e.preventDefault();
      editWorkGroup({ stop: stopBtn.getAttribute("data-work-stop") as WorkGroupStop });
      setWorkMenu(false, true);
      return;
    }
    const boxBtn = target.closest("[data-work-evidence]");
    if (boxBtn) {
      e.preventDefault();
      // Disabled at Threads: the box keeps its value and the click does nothing.
      if (boxBtn.getAttribute("aria-disabled") === "true") return;
      const key = boxBtn.getAttribute("data-work-evidence") as keyof WorkGroupEvidenceToggles;
      editWorkGroup({ evidence: key, value: boxBtn.getAttribute("aria-checked") !== "true" });
      renderList();
      focusWorkMenuItem(`[data-work-evidence="${CSS.escape(key)}"]`);
      return;
    }
    // A Pick up row (plan `muninn-wiki-pick-up`): reveal its page in the card
    // that draws it, or open the page when no drawn card does (D12).
    const pickBtn = target.closest<HTMLElement>("[data-pickup]");
    if (pickBtn) {
      e.preventDefault();
      const rel = pickBtn.getAttribute("data-pickup");
      if (rel) jumpToPickUp(rel);
      return;
    }
    const moreBtn = target.closest("[data-thread-more]");
    if (moreBtn) {
      e.preventDefault();
      const key = moreBtn.getAttribute("data-thread-more");
      if (!key) return;
      const hadFocus = document.activeElement === moreBtn;
      const childCards = () => Array.from(document.querySelectorAll<HTMLElement>(`#wikiList [data-thread-group-body="${CSS.escape(key)}"] .wiki-thread-card[data-thread]`));
      // By key, not by count: a pinned child past the first three is drawn
      // before the press and moves to its own place after it.
      const before = new Set(childCards().map((c) => c.getAttribute("data-thread")));
      workMoreOpen.add(key);
      renderList();
      // Focus the first child the press revealed.
      if (hadFocus) {
        const after = childCards();
        const card = after.find((c) => !before.has(c.getAttribute("data-thread"))) ?? after[after.length - 1];
        card?.querySelector<HTMLElement>(".wiki-thread-fold")?.focus({ preventScroll: true });
      }
      return;
    }
    // The shared context's `+N`: the full list in place, focus on the first link
    // the press revealed.
    const ctxBtn = target.closest("[data-thread-ctx-more]");
    if (ctxBtn) {
      e.preventDefault();
      const key = ctxBtn.getAttribute("data-thread-ctx-more");
      if (!key) return;
      const hadFocus = document.activeElement === ctxBtn;
      const links = () => Array.from(document.querySelectorAll<HTMLElement>(`#wikiList .wiki-thread-context[data-thread-group="${CSS.escape(key)}"] .wiki-thread-link`));
      const shown = links().length;
      workContextOpen.add(key);
      renderList();
      if (hadFocus) links()[shown]?.focus({ preventScroll: true });
      return;
    }
    // The group chip and the section fold — the rail's second control, on the same
    // listener and BEFORE the pin, since both sit inside a row the body delegate
    // would otherwise open. A fold DOES re-render (`renderList`): unlike the ★,
    // which paints one button, this one adds and removes rows, so there is nothing
    // to paint in place.
    const fold = target.closest("[data-fold-key]");
    if (fold) {
      e.preventDefault();
      const key = fold.getAttribute("data-fold-key");
      if (!key) return;
      const hadFocus = document.activeElement === fold;
      openFolds = toggleFolded(deps.WIKI(), key);
      renderList();
      // The key's spelling can flip with the default it is drawn under, so look
      // for either (`closed:` or not).
      if (hadFocus) {
        const base = key.startsWith(CLOSED_FOLD_PREFIX) ? key.slice(CLOSED_FOLD_PREFIX.length) : key;
        const at = (k: string) => `#wikiList [data-fold-key="${CSS.escape(k)}"]`;
        refocusRailControl(`${at(base)}, ${at(CLOSED_FOLD_PREFIX + base)}`, fold);
      }
      return;
    }
    // A work thread's 📌 (D7): the pinned card clears, any other pins its newest
    // focus page (`pinAnchor`).
    // This one DOES re-render — the pinned card moves to the top of the section,
    // so there is no single button to repaint in place (the ★'s rule).
    const threadPinBtn = target.closest("[data-thread-pin]");
    if (threadPinBtn) {
      e.preventDefault();
      const key = threadPinBtn.getAttribute("data-thread-pin");
      if (!key) return;
      const hadFocus = document.activeElement === threadPinBtn;
      const cardEl = threadPinBtn.closest(".wiki-thread-card");
      // A group card is addressed by its own key, a thread card (child or not) by its.
      const attr = cardEl?.hasAttribute("data-thread-group") ? "data-thread-group" : "data-thread";
      const card = cardEl?.getAttribute(attr);
      stepThreadPin({ kind: "click", value: threadPinBtn.getAttribute("data-thread-pinned") === "1" ? null : key });
      renderList();
      // The card moved: follow it by its own key, not by position.
      if (hadFocus && card) {
        refocusRailControl(`#wikiList .wiki-thread-card[${attr}="${CSS.escape(card)}"] [data-thread-pin]`, threadPinBtn);
      }
      return;
    }
    const pin = target.closest("[data-pin]");
    if (!pin) return;
    e.preventDefault();
    const row = pin.closest(".wiki-list-item");
    const relPath = row?.getAttribute("data-relpath");
    if (!relPath) return;
    pins = togglePinned(deps.WIKI(), relPath);
    // ⚠️ IN PLACE — deliberately NOT `renderList()`. Re-rendering here moved
    // content under the reader, and the state space of "how much, and which way"
    // (render cause × scroll position × whether the list reorders) produced a
    // different defect in each of two review rounds: a numeric restore shifted the
    // row at the cursor ~96px so a second click pinned a DIFFERENT page; the
    // anchored restore that replaced it threw the reader down the list on a sort
    // change and hid the new Pinned header when pinning at the top. Painting one
    // button removes the space rather than picking a third point in it. The ★
    // filling in is the confirmation in the meantime.
    //
    // ⚠️ The residual, stated because "nothing moves" is only true of THIS click:
    // the render that first paints the new section can be the BACKGROUND listing
    // refresh rather than one the reader caused, and the section then appears on a
    // repaint nothing on screen explains — measured at ~50px of extra downward
    // shift on top of the ~46px that refresh already moves content by, which is
    // pre-existing and unrelated to pins. Bounded, and only on a render that
    // already repaints the list.
    paintPinState();
  });
  (document.getElementById("wikiSearch") as HTMLInputElement).addEventListener("input", (e) => {
    deps.filters.q = (e.target as HTMLInputElement).value;
    renderList();
    deps.refreshStartBody();
  });
  document.getElementById("domainChips")!.addEventListener("click", function (this: HTMLElement, e) {
    const target = e.target as HTMLElement;
    const chip = target.closest ? target.closest(".wiki-chip") : null;
    if (!chip) return;
    deps.filters.domain = chip.getAttribute("data-domain") || "";
    this.querySelectorAll(".wiki-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    renderFolderSelect();
    renderTypeChips();
    renderStatusChips();
    renderProjectChips();
    renderTagChips();
    renderList();
    deps.refreshStartBody();
    syncFilters();
  });
  document.getElementById("wikiFolder")!.addEventListener("change", function (this: HTMLSelectElement) {
    deps.filters.folder = this.value;
    // The one facet whose counts are scoped by folder (see `projectCounts`), so
    // this handler is the only one that has to repaint a chip row at all.
    renderProjectChips();
    renderList();
    deps.refreshStartBody();
    syncFilters();
  });
  document.getElementById("typeChips")!.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest ? target.closest(".wiki-chip") : null;
    if (!chip) return;
    deps.filters.type = chip.getAttribute("data-type") || "";
    renderTypeChips();
    renderStatusChips();
    renderProjectChips();
    renderTagChips();
    renderList();
    deps.refreshStartBody();
    syncFilters();
  });
  // Status facet: the enum chips and the ⚑ follow-ups toggle share one row (and so
  // one delegated handler), but write to two independent filter fields.
  document.getElementById("statusChips")!.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest ? target.closest(".wiki-chip") : null;
    if (!chip) return;
    if (chip.hasAttribute("data-followups")) {
      deps.filters.followups = deps.filters.followups ? "" : "open";
    } else if (chip.hasAttribute("data-waiting")) {
      deps.filters.waiting = deps.filters.waiting ? "" : "you";
    } else {
      const status = chip.getAttribute("data-status") || "";
      // Re-clicking the active chip clears it (the tag-row convention); "All status"
      // carries an empty value and so clears by assignment.
      deps.filters.status = deps.filters.status === status ? "" : status;
    }
    renderStatusChips();
    renderList();
    deps.refreshStartBody();
    syncFilters();
  });
  // Project facet. The only facet that is also URL state, so every path through it
  // goes via `applyProjectFilter`, which owns the `replaceState`.
  document.getElementById("projectChips")!.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest ? target.closest(".wiki-chip") : null;
    if (!chip) return;
    const project = chip.getAttribute("data-project") || "";
    // Re-clicking the active chip clears it (the tag/status-row convention); "All
    // projects" carries an empty value and so clears by assignment.
    applyProjectFilter(deps.filters.project === project ? "" : project);
  });
  // Jira facet. The project row's twin, and URL state for the same reason, so
  // every path through it likewise goes via `applyJiraFilter`.
  document.getElementById("jiraChips")!.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest ? target.closest(".wiki-chip") : null;
    if (!chip) return;
    if (chip.hasAttribute("data-jira-more")) {
      jiraChipsExpanded = !jiraChipsExpanded;
      renderJiraChips();
      // The row was re-rendered under the reader's focus: hand it to the new
      // expander, so a keyboard user can toggle again without hunting for it.
      (document.querySelector("#jiraChips [data-jira-more]") as HTMLElement | null)?.focus();
      return;
    }
    const key = chip.getAttribute("data-jira") || "";
    applyJiraFilter(deps.filters.jira === key ? "" : key);
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
    deps.filters.tag = deps.filters.tag === tag ? "" : tag;
    renderTagChips();
    renderList();
    deps.refreshStartBody();
    syncFilters();
  });
}

/** The sort select, the View options pane and its three toggles, the Filters
 *  disclosure, the active-options chips and the wiki picker. */
export function registerRailOptions(): void {
  document.getElementById("wikiSort")!.addEventListener("change", () => {
    sortTouched = true;
    writeSort(deps.WIKI(), deps.sortMode());
    renderList();
  });
  familiesBox = document.getElementById("wikiGroupFamilies") as HTMLInputElement | null;
  if (familiesBox) {
    familiesBox.checked = familiesOn();
    familiesBox.addEventListener("change", () => setGroupFamilies(familiesBox!.checked));
  }
  effortsBox = document.getElementById("wikiGroupEfforts") as HTMLInputElement | null;
  if (effortsBox) effortsBox.addEventListener("change", () => setGroupEfforts(effortsBox!.checked));
  retiredBox = document.getElementById("wikiShowRetired") as HTMLInputElement | null;
  if (retiredBox) {
    retiredBox.checked = showRetired();
    retiredBox.addEventListener("change", () => setShowRetired(retiredBox!.checked));
  }
  filtersDetails = document.getElementById("wikiFilters") as HTMLDetailsElement | null;
  filtersBtn = document.getElementById("wikiFiltersBtn");
  if (filtersDetails && filtersBtn) {
    filtersBtn.addEventListener("click", () => {
      filtersDetails!.open = !filtersDetails!.open;
    });
    filtersDetails.addEventListener("toggle", () => {
      filtersBtn!.setAttribute("aria-expanded", String(filtersDetails!.open));
    });
  }
  optionsBtn = document.getElementById("wikiOptionsBtn");
  optionsPane = document.getElementById("wikiOptions");
  if (optionsBtn && optionsPane) {
    const inOptions = (n: EventTarget | null) =>
      n instanceof Node && (optionsPane!.contains(n) || optionsBtn!.contains(n));
    optionsBtn.addEventListener("click", () => setOptionsOpen(optionsPane!.hidden));
    document.addEventListener("pointerdown", (e) => {
      if (!optionsPane!.hidden && !inOptions(e.target)) setOptionsOpen(false);
    });
    document.addEventListener("focusin", (e) => {
      if (!optionsPane!.hidden && !inOptions(e.target) && !getRestoringRailFocus()) setOptionsOpen(false);
    });
    // Capture phase. Escape closes the pane and stops, so it neither leaves focus
    // mode nor closes a graph card (whose own capture listener, registered
    // earlier, already stood aside for the open dialog). A shortcut key — one
    // printable character other than Space (the button's own key), no
    // modifier — pressed OUTSIDE the pane (on its button,
    // or on <body> in Safari, which does not focus a clicked button) closes it and
    // carries on, so modalOpen() is false by the time the shortcut's own listener
    // reads it. Inside the pane the target is a checkbox, which every shortcut
    // owner treats as typing; the key is left to it.
    document.addEventListener(
      "keydown",
      (e) => {
        if (optionsPane!.hidden) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOptionsOpen(false);
          optionsBtn!.focus();
        } else if (
          e.key.length === 1 &&
          e.key !== " " &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !optionsPane!.contains(e.target as Node)
        ) {
          setOptionsOpen(false);
        }
      },
      true,
    );
  }
  document.getElementById("wikiActiveOptions")?.addEventListener("click", (e) => {
    const off = (e.target as HTMLElement).closest?.("[data-view-option-off]");
    if (!off) return;
    if (off.getAttribute("data-view-option-off") === "families") setGroupFamilies(false);
    else setShowRetired(false);
    // The chip is gone; its option lives behind the options button.
    optionsBtn?.focus();
  });
  paintViewOptions();
  wikiSel = document.getElementById("wikiSelect") as HTMLSelectElement | null;
  if (wikiSel) {
    wikiSel.addEventListener("change", () => {
      const value = wikiSel!.value;
      location.href = value ? "/wiki?wiki=" + encodeURIComponent(value) : "/wiki";
    });
  }
}

/** Another tab's pin or grouping record, and the Group menu's keys and click-away. */
export function registerRailMenuKeys(): void {
  // Another tab pinned, unpinned or cleared storage (D7): adopt what storage now
  // holds and repaint. The repaint is `cause: "storage"`, which writes nothing,
  // so no tab's write can make another tab write.
  window.addEventListener("storage", (e) => {
    // The pin and the grouping record (D17) each run their own table; one
    // repaint, `cause: "storage"`, which runs no render step and writes nothing.
    let repaint = false;
    if (storageEventTouchesThreadPin(e.key, deps.WIKI())) {
      repaint = stepThreadPin({ kind: "storage", stored: readThreadPin(deps.WIKI()), booted: deps.pagesRefresh.bootRendered }) || repaint;
    }
    if (storageEventTouchesWorkGroup(e.key, deps.WIKI())) {
      repaint = stepWorkGroup({ kind: "storage", stored: readWorkGroup(deps.WIKI()), booted: deps.pagesRefresh.bootRendered }) || repaint;
    }
    if (repaint) renderList("storage");
  });
  // The Group menu's keys: the arrows, Home and End move between its items,
  // Escape and Tab close it and return focus to the Group button, and ArrowDown
  // on the button opens it.
  document.getElementById("wikiList")!.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest) return;
    if (target.closest("[data-work-group-menu]") && e.key === "ArrowDown" && !workMenuOpen) {
      e.preventDefault();
      setWorkMenu(true, true);
      return;
    }
    const menu = target.closest(".wiki-work-menu");
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>("[role^='menuitem']"));
    const at = items.indexOf(target.closest("[role^='menuitem']") as HTMLElement);
    const move = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") setWorkMenu(false, true);
    else return;
    e.preventDefault();
  });
  // Escape closes the open Group menu wherever focus is (the list's handler above
  // takes it first inside the menu); focus goes to the Group button only when it
  // was lost to the page, never away from a control the reader is on.
  document.addEventListener("keydown", (e) => {
    if (!workMenuOpen || e.key !== "Escape" || e.defaultPrevented) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    setWorkMenu(false, lost);
    if (lost) e.preventDefault();
  });
  // A click outside the open Group menu closes it, unless a rail control's own
  // render (the list handler above) already did.
  document.addEventListener("click", (e) => {
    if (!document.querySelector("#wikiList .wiki-work-menu")) {
      workMenuOpen = false;
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest?.(".wiki-work-menu, [data-work-group-menu]")) return;
    setWorkMenu(false, false);
  });
}
