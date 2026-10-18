/**
 * The rail's INPUT: the pool, the filter and sort, the series and family
 * groups and their order, and the Activity ranking — everything `buildRail`
 * is handed. Pure and DOM-free, so `renderList` and the work replay
 * (`scripts/wiki-work-replay.ts`) assemble the rail from one function rather
 * than a copy (plan D20). The comments on each step are the reasons that used
 * to sit inline in `renderList`.
 */

import { railPool } from "./wiki-cull-view.ts";
import { pageWorkTerm, rankActivity, type ActivityWeights, type WorkedGate } from "./wiki-activity-rank.ts";
import {
  displayTitleOf,
  filterPages,
  isRecencySort,
  sortPages,
  type WikiFilters,
  type WikiListing,
  type WikiSortMode,
} from "./wiki-filter.ts";
import {
  closedFoldKey,
  groupSeries,
  isMonthGrouping,
  orderPagesForGroups,
  orderSeriesGroups,
  railGroups,
  withoutSeriesMembers,
} from "./wiki-groups.ts";
import {
  GROUP_CHILDREN_SHOWN,
  groupFoldState,
  normalizeFoldKey,
  openWorkThreadCards,
  railSectionsVisible,
  THREAD_CARDS_MAX,
  threadFoldKey,
  type RailGroupCard,
  type RailInput,
  type RailThreadCard,
  type RailSessionSplit,
  type RailWorkCard,
  type RailWorkControl,
} from "./wiki-recents.ts";
import {
  groupWorkThreads,
  projectSessionCards,
  projectWorkGroups,
  readWorkEvidence,
  threadSessionsAvailability,
  workSessionCards,
  type WorkGroupChild,
  type WorkGroupChildView,
  type WorkWitness,
} from "./wiki-work-groups.ts";
import { WORK_GROUP_STOPS, type WorkGroupEvidenceToggles, type WorkGroupSplit, type WorkGroupStop } from "./wiki-work-group-prefs.ts";
import { applyWorkBoundaries, type BoundedThread, type WorkBoundaries } from "./wiki-work-boundaries.ts";
import { saveAsSeriesPlan } from "./wiki-work-series.ts";
import { pageAddedMs } from "./wiki-filter.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { WORK_WINDOW_MS, workSessionRef, type IndexWork, type WorkThread, type WorkThreadSession } from "../../../wiki/work-focus.ts";
import {
  claimOwnedFocus,
  newestFocusPage,
  threadCardRows,
  threadHoldsPin,
  threadName,
  threadRankScore,
  usableThreads,
  workGroupingInstant,
  workTermOrder,
} from "./wiki-thread-core.ts";

export { threadName, threadPinAnchor, usableThreads } from "./wiki-thread-core.ts";

/** What the wiki's listing says — the same for every viewer. */
export interface RailWikiFacts {
  allPages: WikiListing[];
  /** The wiki's project names (`/api/wiki/pages`' `projects`). */
  projects: Record<string, number>;
  activityWeights: ActivityWeights;
  workedGate: WorkedGate | null;
  /** The work threads (`/api/wiki/pages`' `work`); absent or null with no
   *  sessions memo, which renders no section (D11). */
  work?: (Pick<IndexWork, "threads"> & Partial<Pick<IndexWork, "asOfMs" | "evidence">>) | null;
}

/** What this viewer has chosen. */
export interface RailViewer {
  mode: WikiSortMode;
  /** ONE anchored instant for the sort, the rows and the ranking. */
  now: number;
  filters: WikiFilters;
  showRetired: boolean;
  familiesOn: boolean;
  pins: string[];
  openFolds: string[];
  /** The page the reader has open, if any. */
  openRelPath?: string;
  /** The reader's pinned work-thread page (D7), or null. */
  threadPin?: string | null;
  /** The Group control's settings (`workGroupPrefsOf`, D1 when nothing is
   *  stored). Absent ⇒ today's Threads cards with no control (the replay's and
   *  the unit tests' default). */
  workGroup?: RailWorkGroupView;
}

/** What the Work threads section is grouped by, for one render. */
export interface RailWorkGroupView {
  stop: WorkGroupStop;
  evidence: WorkGroupEvidenceToggles;
  /** Group fold keys whose `+ N more threads` the reader pressed (this tab). */
  moreOpen?: readonly string[];
  /** PR 4: the reader's page splits and kept-apart anchors (D5). */
  splits?: readonly WorkGroupSplit[];
  keptApart?: readonly string[];
  /** PR 4: thread fold keys whose `▸ split into N sessions` is open (this tab). */
  sessionsOpen?: readonly string[];
  /** PR 4: Save as series may write this wiki (absent on a read-only one, D14). */
  seriesWritable?: boolean;
  /** PR 4: the boundaries already applied this render (`workBoundariesOf`
   *  over `splits` and `keptApart`), so the reader computes them once. */
  boundaries?: WorkBoundaries;
}

/** The reader's boundaries over this listing's threads — the one call the
 *  rail, the pin's anchor and the row ⋯ all read (`wiki-work-boundaries.ts`). */
export function workBoundariesOf(
  work: RailWikiFacts["work"],
  allPages: readonly WikiListing[],
  view: Pick<RailWorkGroupView, "splits" | "keptApart"> | null | undefined,
): WorkBoundaries {
  return applyWorkBoundaries({ work, allPages, splits: view?.splits ?? [], keptApart: view?.keptApart ?? [] });
}


/**
 * The work-thread cards, in render order, and which are OPEN — the ONE decision
 * `railInputFor` hands both to `rankActivity` (as the exclude set) and to
 * `buildRail` (as the lift), so the two never disagree (D19).
 *
 *  - `pages` is the rail's POOL; a card's rows are those pages under the
 *    facets, so a facet filters each card and a card left with no focus row is
 *    dropped. A query renders no section at all.
 *  - Order (D6), name and page OWNERSHIP are decided over `allPages`, the full
 *    listing, so neither Show retired nor a facet moves or renames a card.
 *    Order is `threadScore` at `workGroupingInstant(now, asOfMs)` — the
 *    grouping model's instant, so the order is the server's — except the PINNED thread
 *    (the one holding `pin`, `threadHoldsPin`, D7), which renders first. At most
 *    `THREAD_CARDS_MAX` cards, cut after the drops.
 *  - The first card defaults OPEN, so it offers the `closed:` spelling (as the
 *    newest month does); every card reads whichever spelling the reader wrote
 *    last (`groupFoldState`). Keys are `thread:<key>`, never a bare relPath.
 *  - Focus rows are ordered by work term; a page an earlier thread already
 *    owns is neither a row of a later card nor its name (a hub has one owner,
 *    D16).
 */
export function openThreadCards(
  threads: readonly WorkThread[] | null | undefined,
  pages: readonly WikiListing[],
  filters: WikiFilters,
  foldState: readonly string[],
  pin: string | null,
  now: number,
  allPages: readonly WikiListing[] = pages,
  asOfMs?: number,
  rank?: WorkBoundaries["rank"],
): RailThreadCard[] {
  const cards = threadCardBodies(threads, pages, filters, pin, now, allPages, asOfMs, THREAD_CARDS_MAX, rank);
  return cards.map((c, i) => {
    const stored = groupFoldState(foldState, c.foldKey);
    const defaultOpen = i === 0;
    return {
      ...c,
      open: stored ? stored === "open" : defaultOpen,
      toggleKey: defaultOpen ? closedFoldKey(c.foldKey) : c.foldKey,
    };
  });
}

/** `openThreadCards` before the folds, at most `cap` cards: the one path both
 *  the drawn Threads cards and the Group menu's Threads count (uncapped) take. */
function threadCardBodies(
  threads: readonly WorkThread[] | null | undefined,
  pages: readonly WikiListing[],
  filters: WikiFilters,
  pin: string | null,
  now: number,
  allPages: readonly WikiListing[],
  asOfMs: number | undefined,
  cap: number,
  rank?: WorkBoundaries["rank"],
): Omit<RailThreadCard, "open" | "toggleKey">[] {
  if (!railSectionsVisible(filters)) return [];
  const ranked = rankThreadCards(threads, allPages, pin, now, asOfMs, rank);
  if (!ranked.length) return [];
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const visible = new Set(filterPages(pages as WikiListing[], filters).map((p) => normalizeRel(p.relPath)));
  const cards: Omit<RailThreadCard, "open" | "toggleKey">[] = [];
  // A split page's card rides with its source's drawn card past the cap
  // (`splitRides`), so Make own thread never moves a page off the section.
  let counted = 0;
  const drawnSources = new Set<string>();
  for (const { t, score, pinned, owned } of ranked) {
    const rides = splitRides(rank, t.key, drawnSources);
    if (counted >= cap && !rides) continue;
    // The created window stays on the reader's `now`.
    const rows = threadCardRows(owned, t.touched, visible, byRel, now);
    if (!rows.focus.length) continue;
    if (!rides) counted++;
    drawnSources.add(rank?.get(t.key)?.rank.key ?? t.key);
    cards.push({
      key: t.key,
      foldKey: threadFoldKey(t.key),
      // Named by the top page the thread OWNS in the whole listing, so neither
      // a facet nor Show retired renames it.
      name: threadName(displayTitleOf(owned[0]!)),
      pinned,
      pinAnchor: newestFocusPage(t, byRel),
      focus: rows.focus,
      created: rows.created,
      touched: rows.touched,
      sessions: t.sessions,
      movesYou: rows.movesYou,
      score,
    });
  }
  return cards;
}

/** Does the card of thread `key` ride past the five-card cap? Only a split
 *  page's (`sub` > 0) whose source already has a drawn card: the split
 *  follows its source (D16), and without this a source at the cap would push
 *  the page the reader just split off the section (measured on a live wiki). */
function splitRides(rank: WorkBoundaries["rank"] | undefined, key: string, drawnSources: ReadonlySet<string>): boolean {
  const r = rank?.get(key);
  return !!r && r.sub > 0 && drawnSources.has(r.rank.key);
}

/** One thread as the Threads stop ranks it: its score, whether it holds the
 *  pin, and the focus pages it owns in the full listing. */
export interface RankedThread {
  t: WorkThread;
  score: number;
  pinned: boolean;
  owned: WikiListing[];
}

/**
 * The Threads stop's decision BEFORE the facets and the cap: every usable
 * thread, pinned first, then by `threadRankScore` at the grouping instant,
 * then key, with ownership over `allPages` in that order through every thread
 * (so a facet or the cap never hands a hub to a later card). Uncapped, so the
 * Group menu can count cards and the grouped rail can share the ownership
 * rule; `openThreadCards` is this plus the facets, the cap and the folds.
 */
export function rankThreadCards(
  threads: readonly WorkThread[] | null | undefined,
  allPages: readonly WikiListing[],
  pin: string | null,
  now: number,
  asOfMs?: number,
  /** PR 4: what a split page and its remainder rank by (`WorkBoundaries.rank`):
   *  the source thread as shipped, then `sub`, so a split follows its source.
   *  Absent, or a thread not in it: the thread itself (today's order). */
  rank?: WorkBoundaries["rank"],
): RankedThread[] {
  const usable = usableThreads(threads);
  if (!usable.length) return [];
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const pinKey = pin ? normalizeRel(pin) : null;
  // Score, ownership and names at the grouping model's instant.
  const at = workGroupingInstant(now, asOfMs);
  let pinTaken = false;
  const ranked = usable
    .map((t) => ({
      t,
      by: rank?.get(t.key)?.rank ?? t,
      sub: rank?.get(t.key)?.sub ?? 0,
    }))
    .map(({ t, by, sub }) => ({
      t,
      by,
      sub,
      score: threadRankScore(by, byRel, at),
      holdsPin: !!pinKey && threadHoldsPin(t, byRel, pinKey),
    }))
    .map((x) => {
      // One pinned thread: the first that holds the page (two cannot, short of
      // a payload that breaks D16).
      const pinned = x.holdsPin && !pinTaken;
      if (pinned) pinTaken = true;
      return { ...x, pinned };
    })
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.score - a.score ||
        (a.by.key < b.by.key ? -1 : a.by.key > b.by.key ? 1 : 0) ||
        a.sub - b.sub,
    );
  const taken = new Set<string>();
  const order = workTermOrder(at);
  return ranked.map(({ t, score, pinned }) => ({ t, score, pinned, owned: claimOwnedFocus(t.pages, byRel, taken, order) }));
}

/** The stops drawn, finest first (Sessions since PR 4). */
const DRAWN_STOPS: readonly WorkGroupStop[] = WORK_GROUP_STOPS;

/** A page's title for a witness line. */
function witnessTitle(rel: string, byRel: ReadonlyMap<string, WikiListing>): string {
  const p = byRel.get(normalizeRel(rel));
  return p ? displayTitleOf(p) : rel;
}

/** One witness as a line of the group's or a child's hover. */
export function witnessLine(w: WorkWitness, byRel: ReadonlyMap<string, WikiListing>): string {
  switch (w.kind) {
    case "related":
      return `${witnessTitle(w.from, byRel)} ↔ ${witnessTitle(w.to, byRel)} (related:)`;
    case "issue":
      return `${w.key}: owned by ${witnessTitle(w.owner, byRel)}, named by ${witnessTitle(w.referrer, byRel)}`;
    case "series":
      return `series ${w.label}`;
    case "project":
      return `project ${w.key}`;
  }
}

/** A child's third meta line: the evidence kinds that joined it to the anchor
 *  (`↔ 5 links · ABC-12 · series`), or `anchor`. */
export function childWhyLine(child: Pick<WorkGroupChild, "witnesses">, anchor: boolean): string {
  if (anchor) return "anchor";
  const ws = child.witnesses;
  const parts: string[] = [];
  const links = ws.filter((w) => w.kind === "related").length;
  if (links) parts.push(`${links} ${links === 1 ? "link" : "links"}`);
  const issues = [...new Set(ws.flatMap((w) => (w.kind === "issue" ? [w.key] : [])))];
  if (issues.length) parts.push(issues.length > 1 ? `${issues[0]} +${issues.length - 1}` : issues[0]!);
  if (ws.some((w) => w.kind === "series")) parts.push("series");
  if (ws.some((w) => w.kind === "project")) parts.push("project");
  return parts.length ? `↔ ${parts.join(" · ")}` : "";
}

/**
 * The Work threads cards at the reader's chosen stop (plan
 * `muninn-wiki-work-thread-grouping`, PR 3), and the Group control's state.
 *
 *  - Threads (chosen, or drawn because the chosen stop is unavailable):
 *    `openThreadCards`, today's cards byte for byte.
 *  - Related, Areas: the grouping model over the FULL listing
 *    (`groupWorkThreads`: membership, names, fold keys, ownership and the pin),
 *    then the pool and facets on the child rows (`projectWorkGroups`: empty
 *    children and groups dropped), then at most `THREAD_CARDS_MAX` cards. A
 *    one-thread card is today's card. A group shows `GROUP_CHILDREN_SHOWN`
 *    children (plus the pinned one past them) until `+ N more threads`.
 *  - The first card defaults open and, if it is a group, its pinned child
 *    (else its first drawn child) too; both offer the `closed:` spelling.
 */
export function openWorkCards(
  work: RailWikiFacts["work"],
  pool: readonly WikiListing[],
  filters: WikiFilters,
  foldState: readonly string[],
  pin: string | null,
  now: number,
  allPages: readonly WikiListing[],
  view: RailWorkGroupView,
  boundaries: WorkBoundaries = view.boundaries ?? workBoundariesOf(work, allPages, view),
): { cards: RailWorkCard[]; control: RailWorkControl } {
  const requested = view.stop;
  // Page assignments first (D5): the model groups the units after the splits.
  const units = boundaries.units;
  const grouping = groupWorkThreads({ work, allPages, now, stop: requested, toggles: view.evidence, pin, units });
  const at = workGroupingInstant(now, work?.asOfMs);
  // Uncapped card counts. Threads counts the cards `openThreadCards` draws (its
  // own order and ownership, which a score tie can tell apart from the model's).
  const visibleAt = (stop: WorkGroupStop) =>
    stop === "threads"
      ? threadCardBodies(boundaries.derived, pool, filters, pin, now, allPages, work?.asOfMs, Infinity, boundaries.rank).length
      : stop === "sessions"
        ? projectSessionCards(stop === requested ? grouping.sessions : workSessionCards(work, allPages, at), pool, filters, Infinity).length
        : projectWorkGroups(stop === requested ? grouping : groupWorkThreads({ work, allPages, now, stop, toggles: view.evidence, pin, units }), pool, filters, now, Infinity).length;
  const sections = railSectionsVisible(filters);
  const control: RailWorkControl = {
    requested,
    stop: grouping.stop,
    evidence: { ...view.evidence },
    evidenceApplies: grouping.togglesApply,
    stops: DRAWN_STOPS.map((stop) => {
      const a = grouping.availability[stop];
      return { stop, available: a.available, reasons: [...a.reasons], cards: sections && a.available ? visibleAt(stop) : 0 };
    }),
    ...resetArea(boundaries, view, allPages),
  };
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const fold = (foldKey: string, defaultOpen: boolean) => {
    const stored = groupFoldState(foldState, foldKey);
    return { open: stored ? stored === "open" : defaultOpen, toggleKey: defaultOpen ? closedFoldKey(foldKey) : foldKey };
  };

  // The Sessions stop (D19): one card per session, the newest session owning
  // a page, later ones linking it on `also in:`. No splits, no kept-apart, no 📌.
  if (grouping.stop === "sessions") {
    if (!sections) return { cards: [], control };
    const window = now - WORK_WINDOW_MS;
    const cards = projectSessionCards(grouping.sessions, pool, filters)
      .slice(0, THREAD_CARDS_MAX)
      .map(({ card: sc, rows, alsoIn, touched }, i): RailThreadCard => ({
        key: sc.ref,
        foldKey: sc.foldKey,
        ...fold(sc.foldKey, i === 0),
        // The ledger's session title, never a derived name.
        name: sc.title || sc.id,
        pinned: false,
        pinAnchor: "",
        focus: rows,
        created: rows.filter((p) => pageAddedMs(p, now) >= window).map((p) => normalizeRel(p.relPath)),
        touched,
        sessions: [{ id: sc.id, provider: sc.provider, first: sc.first, last: sc.last, title: sc.title }],
        movesYou: rows.reduce((n, p) => n + (p.movesYou ?? 0), 0),
        score: 0,
        session: { ref: sc.ref },
        alsoIn,
      }));
    return { cards, control };
  }

  const evidence = readWorkEvidence(work?.evidence, work?.threads);
  const bounded = new Map<string, BoundedThread>(boundaries.threads.map((b) => [b.thread.key, b] as const));
  const sessionsOpen = new Set((view.sessionsOpen ?? []).map(normalizeFoldKey));
  /** The reader's boundary on a card, its ⋯ (Related and Areas), and its
   *  `▸ split into N sessions` (every stop but Sessions). */
  const decorate = (card: RailThreadCard, menus: boolean): RailThreadCard => {
    const b = bounded.get(card.key);
    if (!b) return card;
    const out: RailThreadCard = { ...card };
    if (b.split) out.boundary = "split";
    else if (b.keptApart) out.boundary = "keptApart";
    if (menus) {
      out.menu = b.split
        ? { action: "return", id: b.split.id, page: b.split.page }
        : b.keptApart
          ? { action: "allow", anchors: [...b.keptApart] }
          : { action: "keep", anchor: card.pinAnchor };
    }
    const split = sessionSplitOf(b, card, work, allPages, at, evidence, sessionsOpen.has(normalizeFoldKey(card.foldKey)));
    if (split) out.sessionSplit = split;
    return out;
  };

  if (grouping.stop === "threads" || !sections) {
    const cards = openThreadCards(boundaries.derived, pool, filters, foldState, pin, now, allPages, work?.asOfMs, boundaries.rank);
    return { cards: cards.map((c) => decorate(c, false)), control };
  }

  const more = new Set((view.moreOpen ?? []).map(normalizeFoldKey));
  // At most `THREAD_CARDS_MAX` cards, a split page's card riding with its
  // source's drawn card past the cap (`splitRides`).
  const views: ReturnType<typeof projectWorkGroups> = [];
  {
    let counted = 0;
    const drawnSources = new Set<string>();
    for (const gv of projectWorkGroups(grouping, pool, filters, now, Infinity)) {
      const rides = gv.group.kind === "thread" && splitRides(boundaries.rank, gv.children[0]!.child.key, drawnSources);
      if (counted >= THREAD_CARDS_MAX && !rides) continue;
      if (!rides) counted++;
      views.push(gv);
      for (const cv of gv.children) drawnSources.add(cv.child.unit.rank.key);
    }
  }
  const threadCard = (cv: WorkGroupChildView, defaultOpen: boolean, child?: RailThreadCard["child"]): RailThreadCard =>
    decorate(
      {
        key: cv.child.key,
        foldKey: cv.child.foldKey,
        ...fold(cv.child.foldKey, defaultOpen),
        name: cv.child.name,
        pinned: cv.child.pinned,
        pinAnchor: cv.child.pinAnchor,
        focus: cv.focus,
        created: cv.created,
        // A child's touched pages are the group's shared context, listed once.
        touched: child ? [] : cv.touched,
        sessions: cv.child.unit.thread.sessions,
        movesYou: cv.movesYou,
        score: cv.child.score,
        ...(child ? { child } : {}),
      },
      true,
    );
  const cards = views.map((gv, i): RailWorkCard => {
    const g = gv.group;
    if (g.kind === "thread") return threadCard(gv.children[0]!, i === 0);
    const anchor = g.children[0]!;
    const drawnAll = more.has(normalizeFoldKey(g.foldKey));
    const shownViews = gv.children.filter((cv, j) => drawnAll || j < GROUP_CHILDREN_SHOWN || cv.child.pinned);
    // The default-open child of the first card: the pinned one when the group
    // holds the pin (as the Threads stop opens the pinned thread), else the first.
    const openAt = Math.max(0, shownViews.findIndex((cv) => cv.child.pinned));
    const children = shownViews.map((cv, j) =>
      threadCard(cv, i === 0 && j === openAt, {
        anchor: cv.child === anchor,
        why: childWhyLine(cv.child, cv.child === anchor),
        witnesses: cv.child.witnesses.map((w) => witnessLine(w, byRel)),
        also: cv.child.also.map((a) => a.label),
      }),
    );
    // Shared context: the visible pages the children only touched, once,
    // never a page any child of the group owns.
    const owned = new Set(g.children.flatMap((c) => c.owned.map((p) => normalizeRel(p.relPath))));
    const context: WikiListing[] = [];
    const seen = new Set<string>();
    for (const cv of gv.children)
      for (const p of cv.touched) {
        const k = normalizeRel(p.relPath);
        if (owned.has(k) || seen.has(k)) continue;
        seen.add(k);
        context.push(p);
      }
    // Sessions deduplicated by `workSessionRef` after the projection: a
    // session a split shares with its remainder counts once here.
    const sessions = new Map<string, WorkThreadSession>();
    for (const cv of gv.children) for (const s of cv.child.unit.thread.sessions) if (!sessions.has(workSessionRef(s))) sessions.set(workSessionRef(s), s);
    // Save as series (D8, D14): on a wiki this instance may write, on a group
    // whose children share no series.
    const plan = view.seriesWritable && g.label !== "series" ? saveAsSeriesPlan(g, allPages) : undefined;
    const shared = plan && plan.mode === "join" && plan.children.every((c) => c.joined.length > 0);
    const card: RailGroupCard = {
      group: true,
      key: g.anchorKey,
      foldKey: g.foldKey,
      ...fold(g.foldKey, i === 0),
      label: g.label === "thread" ? "related" : g.label,
      name: g.name,
      pinned: g.pinned,
      pinAnchor: anchor.pinAnchor,
      anchorVisible: gv.anchorVisible,
      threads: gv.counts.threads,
      sessions: [...sessions.values()].sort((a, b) => b.last - a.last),
      movesYou: gv.counts.movesYou,
      children,
      hidden: gv.children.length - children.length,
      context,
      witnesses: g.witnesses.map((w) => witnessLine(w, byRel)),
      score: anchor.score,
      ...(plan && !shared ? { series: plan } : {}),
    };
    return card;
  });
  return { cards, control };
}

/** `▸ split into N sessions` for one drawn thread card (D19): the sessions
 *  with a kept focus on its pages, from the contribution rows of its SOURCE
 *  thread restricted to its pages, so a split page and its remainder each
 *  split into their own. Offered from two sessions; unavailable, with the
 *  reason, when the thread's contributions do not ship whole. The sessions'
 *  rows are the card's own drawn rows, so the split moves no page. */
function sessionSplitOf(
  b: BoundedThread,
  card: RailThreadCard,
  work: RailWikiFacts["work"],
  allPages: readonly WikiListing[],
  at: number,
  evidence: ReturnType<typeof readWorkEvidence>,
  open: boolean,
): RailSessionSplit | undefined {
  const avail = threadSessionsAvailability(evidence.evidence, b.source.key, evidence.reason);
  if (!avail.available) {
    if (b.thread.sessions.length < 2) return undefined;
    return { count: b.thread.sessions.length, available: false, reason: avail.reasons[0], open: false, sessions: [] };
  }
  const own = workSessionCards(work, allPages, at, b.source.key, new Set(b.thread.pages.map(normalizeRel)));
  if (own.length < 2) return undefined;
  const drawn = new Set(card.focus.map((p) => normalizeRel(p.relPath)));
  const mine = (ps: readonly WikiListing[]) => ps.filter((p) => drawn.has(normalizeRel(p.relPath)));
  return {
    count: own.length,
    available: true,
    open,
    sessions: open
      ? own.map((sc) => ({ ref: sc.ref, title: sc.title || sc.id, first: sc.first, last: sc.last, rows: mine(sc.rows), alsoIn: mine(sc.alsoIn) }))
      : [],
  };
}

/** The Group menu's reset area: the record's splits and kept-apart anchors,
 *  and every one that does not apply now, named for repair. */
function resetArea(b: WorkBoundaries, view: RailWorkGroupView, allPages: readonly WikiListing[]): Pick<RailWorkControl, "reset"> {
  const count = (view.splits?.length ?? 0) + (view.keptApart?.length ?? 0);
  if (!count) return {};
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const entries = b.definitions
    .filter((d) => d.state !== "active")
    .map((d) => {
      const p = d.page ? byRel.get(d.page) : undefined;
      return { kind: d.kind, title: p ? displayTitleOf(p) : d.stored, state: d.state };
    });
  return { reset: { count, entries } };
}

export function railInputFor(wiki: RailWikiFacts, viewer: RailViewer): RailInput {
  const { mode, now, filters } = viewer;
  // The rail's POOL: the live pages, or every page when the reader shows
  // retired ones or searches (`railPool`). Every count below is over it — except
  // the series census, which is over `allPages` on purpose (a culled member
  // counts toward `N of M shown` and can name the fold).
  const pool = railPool(wiki.allPages, viewer.showRetired, filters.q);
  const filtered = sortPages(filterPages(pool, filters), mode, now);
  // The key jump reads the facets WITHOUT the query (the query is the key). Only
  // computed when the query could name one — on every other keystroke this is the
  // same single `filterPages` pass the rail has always done.
  const facetOnly = /[0-9]/.test(filters.q)
    ? sortPages(filterPages(pool, { ...filters, q: "" }), mode, now)
    : filtered;
  // SERIES are computed whether or not `group families` is on: the toggle guards
  // the two NAME heuristics, and a series is a key someone wrote. Over the
  // FILTERED set for the members, over `allPages` for the label, the member total
  // and the newest plan. The SECTION's row order is applied here rather than
  // inside `buildRail`, which arranges what it is handed (`orderSeriesGroups`).
  const seriesGroups = railSectionsVisible(filters)
    ? orderSeriesGroups(groupSeries(filtered, wiki.allPages, now), { sort: mode, now })
    : [];
  // ⚠️ A series CLAIMS its members before the family and month rules see the
  // list: a family that drops under FAMILY_MIN dissolves into plain rows, and a
  // prefix that was over FAMILY_MAX may drop to the cap and form.
  const groups =
    viewer.familiesOn && railSectionsVisible(filters)
      ? railGroups(withoutSeriesMembers(filtered, seriesGroups), {
          folder: filters.folder,
          sort: mode,
          projects: wiki.projects,
          now,
        })
      : [];
  // MONTHS decide their own order (newest first), so the rows are re-ordered to
  // match before the rail places each group at its first member. Families are
  // left alone: they interleave with single pages by age (`orderPagesForGroups`).
  const rows = isMonthGrouping(groups) ? orderPagesForGroups(filtered, groups) : filtered;
  // The work-thread cards (D19): decided ONCE, here, so the pages an OPEN card
  // lifts are exactly the ones Activity ranks without. No sessions memo ⇒ no
  // cards ⇒ an empty exclude set ⇒ today's ranking (D11).
  // With the Group control (`viewer.workGroup`), the stop the reader chose;
  // without it, today's Threads cards and today's label.
  const work = viewer.workGroup
    ? openWorkCards(wiki.work, pool, filters, viewer.openFolds, viewer.threadPin ?? null, now, wiki.allPages, viewer.workGroup)
    : null;
  const threads: readonly RailWorkCard[] =
    work?.cards ??
    openThreadCards(wiki.work?.threads, pool, filters, viewer.openFolds, viewer.threadPin ?? null, now, wiki.allPages, wiki.work?.asOfMs);
  const exclude = new Set<string>();
  for (const c of openWorkThreadCards(threads)) for (const p of c.focus) exclude.add(normalizeRel(p.relPath));
  return {
    filtered: rows,
    facetOnly,
    filters,
    pins: viewer.pins,
    // `isRecencySort`, not a two-value test: this decides whether the sunk
    // bookkeeping run gets its `Bookkeeping` header.
    metaTail: isRecencySort(mode),
    // Ranked over the FILTERED pages and on the same anchored instant as the
    // sort; skipped under a query, where `buildRail` renders no sections.
    activity: railSectionsVisible(filters)
      ? rankActivity(rows, wiki.activityWeights, now, wiki.workedGate, exclude.size ? exclude : undefined)
      : [],
    ...(threads.length ? { threads } : {}),
    ...(threads.length && work ? { workControl: work.control } : {}),
    // The series peek's work term (D12), only while the gate lets work score —
    // a closed gate keeps today's peek as it keeps today's ranking.
    ...(wiki.workedGate?.open ? { workTerm: (p: WikiListing) => pageWorkTerm(p, now) } : {}),
    groups,
    seriesGroups,
    openFolds: viewer.openFolds,
    // The open page's group is expanded whatever the store says.
    openRelPath: viewer.openRelPath,
    // A Jira filter opens every fold, so its chip's count is the rows on screen
    // and `#wikiCount` (the facet's promise; a tag filter makes none).
    expandAll: !!filters.jira,
  };
}
