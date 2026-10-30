/**
 * The rail's INPUT: the pool, the filter and sort, the series and family
 * groups and their order, and the Activity ranking — everything `buildRail`
 * is handed. Pure and DOM-free, so `renderList` and the work replay
 * (`scripts/wiki-work-replay.ts`) assemble the rail from one function rather
 * than a copy (plan D20). The comments on each step are the reasons that used
 * to sit inline in `renderList`.
 */

import { railPool } from "./wiki-cull-view.ts";
import { activityAgeMs, pageWorkTerm, rankActivity, splitLiftedChildren, type ActivityWeights, type WorkedGate } from "./wiki-activity-rank.ts";
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
  isRailGroupCard,
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
  type WorkGroup,
  type WorkGroupView,
  type WorkGrouping,
  type WorkUnit,
  type WorkWitness,
} from "./wiki-work-groups.ts";
import { WORK_GROUP_KEPT_APART_MAX, WORK_GROUP_STOPS, type WorkGroupEvidenceToggles, type WorkGroupSplit, type WorkGroupStop } from "./wiki-work-group-prefs.ts";
import { applyWorkBoundaries, type BoundedThread, type WorkBoundaries } from "./wiki-work-boundaries.ts";
import { saveAsSeriesPlan } from "./wiki-work-series.ts";
import { pageAddedMs } from "./wiki-filter.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { effortFoldOf, foldedEffortIds, type RailEffort } from "./wiki-effort-rail.ts";
import { pickUpRows, workAgeSource, workCardAgeMs, type WorkAgeSource } from "./wiki-pick-up.ts";
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
  /** Work map P4: page key → its effort (`railEffortIndex`), or null/absent on
   *  a wiki with no map (or before the map has loaded). */
  efforts?: ReadonlyMap<string, RailEffort> | null;
  /** X1: the map GET for this run time failed, so `efforts` will not arrive and
   *  `group by effort` draws Work threads instead of waiting for it. */
  effortMapFailed?: boolean;
}

/** What this viewer has chosen. */
export interface RailViewer {
  mode: WikiSortMode;
  /** ONE anchored instant for the sort, the rows and the ranking. */
  now: number;
  filters: WikiFilters;
  showRetired: boolean;
  familiesOn: boolean;
  /** `group by effort` (P4): on unless the reader stored `toggle:no-efforts`.
   *  Reads nothing on a wiki with no map. */
  effortsOn?: boolean;
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
 *  - PR 4: `threads` are the server's; `boundaries` breaks each card into the
 *    pieces the reader's splits made, in its place (`threadCardPieces`, D20).
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
  boundaries?: WorkBoundaries,
): RailThreadCard[] {
  const cards = threadCardPieces(threads, pages, filters, pin, now, allPages, asOfMs, THREAD_CARDS_MAX, boundaries).flat();
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

type ThreadCardBody = Omit<RailThreadCard, "open" | "toggleKey">;

/**
 * The Threads stop's cards before the folds, one list per BASE card (D20):
 * the first `cap` cards the server's threads draw with no manual boundary,
 * after the facets, the pinned one first — exactly today's cards. A base card
 * whose thread the reader's splits broke draws all of its pieces in its
 * place: the remainder and each split page, the piece holding the pin first
 * (and marked, even when its base card did not hold it), then in the
 * source's order. A piece owns only pages its base card owned,
 * so a boundary click never adds a page to the section or removes one, and
 * the section holds at most the pieces of `cap` base cards. `cap` Infinity
 * is the Group menu's Threads count.
 */
export function threadCardPieces(
  threads: readonly WorkThread[] | null | undefined,
  pages: readonly WikiListing[],
  filters: WikiFilters,
  pin: string | null,
  now: number,
  allPages: readonly WikiListing[],
  asOfMs: number | undefined,
  cap: number,
  boundaries?: WorkBoundaries,
): ThreadCardBody[][] {
  if (!railSectionsVisible(filters)) return [];
  const ranked = rankThreadCards(threads, allPages, pin, now, asOfMs);
  if (!ranked.length) return [];
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const visible = new Set(filterPages(pages as WikiListing[], filters).map((p) => normalizeRel(p.relPath)));
  /** source thread key → its pieces, for every thread a split broke. */
  const piecesOf = new Map<string, BoundedThread[]>();
  for (const b of boundaries?.threads ?? []) if (b.split || b.remainder) (piecesOf.get(b.source.key) ?? piecesOf.set(b.source.key, []).get(b.source.key)!).push(b);
  const pinKey = pin ? normalizeRel(pin) : null;
  const order = workTermOrder(workGroupingInstant(now, asOfMs));
  const body = (t: WorkThread, owned: WikiListing[], pinned: boolean, score: number): ThreadCardBody | null => {
    // The created window stays on the reader's `now`.
    const rows = threadCardRows(owned, t.touched, visible, byRel, now);
    if (!rows.focus.length) return null;
    return {
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
    };
  };
  const out: ThreadCardBody[][] = [];
  for (const { t, score, pinned, owned } of ranked) {
    if (out.length >= cap) break;
    const whole = body(t, owned, pinned, score);
    if (!whole) continue;
    const parts = piecesOf.get(t.key);
    if (!parts) {
      out.push([whole]);
      continue;
    }
    const ownable = new Set(owned.map((p) => normalizeRel(p.relPath)));
    // The piece holding the pin after the splits, whether or not its base card
    // held it: a hub pin is held only by a thread of hubs (S1 on a hub).
    const pinPiece = pinKey ? parts.find((b) => threadHoldsPin(b.thread, byRel, pinKey)) : undefined;
    const taken = new Set<string>();
    const cards: ThreadCardBody[] = [];
    for (const b of pinPiece ? [pinPiece, ...parts.filter((x) => x !== pinPiece)] : parts) {
      const mine = claimOwnedFocus(b.thread.pages.filter((p) => ownable.has(normalizeRel(p))), byRel, taken, order);
      const card = body(b.thread, mine, b === pinPiece, score);
      if (card) cards.push(card);
    }
    out.push(cards);
  }
  return out;
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
      score: threadRankScore(t, byRel, at),
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
        (a.t.key < b.t.key ? -1 : a.t.key > b.t.key ? 1 : 0),
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
 *    children and groups dropped), then at most `THREAD_CARDS_MAX` cards —
 *    each of which the reader's boundaries may break into several, in its
 *    place (`groupCardPieces`, D20). A one-thread card is today's card. A group shows `GROUP_CHILDREN_SHOWN`
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
  // The BASE grouping: no manual boundary (D20). The boundaries apply inside
  // each of its cards (`groupCardPieces`).
  const grouping = groupWorkThreads({ work, allPages, now, stop: requested, toggles: view.evidence, pin });
  const at = workGroupingInstant(now, work?.asOfMs);
  // Uncapped card counts. Threads counts the cards `openThreadCards` draws (its
  // own order and ownership, which a score tie can tell apart from the model's).
  const visibleAt = (stop: WorkGroupStop) =>
    stop === "threads"
      ? threadCardPieces(work?.threads, pool, filters, pin, now, allPages, work?.asOfMs, Infinity, boundaries).flat().length
      : stop === "sessions"
        ? projectSessionCards(stop === requested ? grouping.sessions : workSessionCards(work, allPages, at), pool, filters, Infinity).length
        : groupCardPieces(stop === requested ? grouping : groupWorkThreads({ work, allPages, now, stop, toggles: view.evidence, pin }), work, pool, filters, pin, now, allPages, boundaries, Infinity).flat().length;
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
  const ages = workAgeSource(work, allPages);
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
        // D5 on a Sessions-stop card: its one session's newest row, focus or
        // touch, on the session's focus pages (owned and `also in:`, never the
        // touched ones), from the unfiltered lists; never empty for a session card.
        ...ageField(workCardAgeMs(ages, [sc.threadKey], [sc], [...sc.rows, ...sc.alsoIn].map((p) => p.relPath))),
      }));
    return { cards, control };
  }

  const evidence = readWorkEvidence(work?.evidence, work?.threads);
  const bounded = new Map<string, BoundedThread>(boundaries.threads.map((b) => [b.thread.key, b] as const));
  const sessionsOpen = new Set((view.sessionsOpen ?? []).map(normalizeFoldKey));
  const keptApartFull = boundaries.definitions.filter((d) => d.kind === "keptApart").length >= WORK_GROUP_KEPT_APART_MAX;
  /** The reader's boundary chip on a card (every stop but Sessions), its ⋯
   *  (`menus`: Related and Areas only), and its `▸ split into N sessions`
   *  (Threads, Related and Areas: D7, inside any open thread). */
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
          : { action: "keep", anchor: card.pinAnchor, ...(keptApartFull ? { full: true as const } : {}) };
    }
    const split = sessionSplitOf(b, card, work, allPages, at, evidence, sessionsOpen.has(normalizeFoldKey(card.foldKey)));
    if (split) out.sessionSplit = split;
    return out;
  };

  if (grouping.stop === "threads" || !sections) {
    const cards = openThreadCards(work?.threads, pool, filters, foldState, pin, now, allPages, work?.asOfMs, boundaries);
    return { cards: withWorkAges(cards.map((c) => decorate(c, false)), work, allPages, boundaries, ages), control };
  }

  const more = new Set((view.moreOpen ?? []).map(normalizeFoldKey));
  const views = groupCardPieces(grouping, work, pool, filters, pin, now, allPages, boundaries, THREAD_CARDS_MAX).flat();
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
    // A piece of a broken base group also reads the base card's `+ N more`.
    const drawnAll = more.has(normalizeFoldKey(g.foldKey)) || (!!gv.baseFoldKey && more.has(normalizeFoldKey(gv.baseFoldKey)));
    const shownViews = gv.children.filter((cv, j) => drawnAll || j < GROUP_CHILDREN_SHOWN || cv.child.pinned);
    // The default-open child of the first card: the pinned one when the group
    // holds the pin (as the Threads stop opens the pinned thread), else the first.
    const openAt = Math.max(0, shownViews.findIndex((cv) => cv.child.pinned));
    const childOf = (cv: WorkGroupChildView, defaultOpen: boolean) =>
      threadCard(cv, defaultOpen, {
        anchor: cv.child === anchor,
        why: childWhyLine(cv.child, cv.child === anchor),
        witnesses: cv.child.witnesses.map((w) => witnessLine(w, byRel)),
        also: cv.child.also.map((a) => a.label),
      });
    const children = shownViews.map((cv, j) => childOf(cv, i === 0 && j === openAt));
    // Behind `+ N more threads`: never drawn, but the Pick up jump finds a
    // page there and presses `+ N more` first.
    const hiddenChildren = gv.children.filter((cv) => !shownViews.includes(cv)).map((cv) => childOf(cv, false));
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
      ...(hiddenChildren.length ? { hiddenChildren } : {}),
    };
    return card;
  });
  return { cards: withWorkAges(cards, work, allPages, boundaries, ages), control };
}

const ageField = (ms: number | undefined): { ageMs?: number } => (ms === undefined ? {} : { ageMs: ms });

/**
 * The age chip's instant on every card (plan `muninn-wiki-pick-up`, D5):
 * a thread card, a split page, a remainder or a kept-apart thread reads the
 * rows of its own sessions on its own focus pages (the derived thread's, after
 * the reader's boundaries), falling back on its SOURCE thread's cut; a group
 * takes its newest child's, the children behind `+ N more` included. A card
 * that already has one (a Sessions-stop card) keeps it.
 */
export function withWorkAges(
  cards: readonly RailWorkCard[],
  work: RailWikiFacts["work"],
  allPages: readonly WikiListing[],
  boundaries?: WorkBoundaries,
  src: WorkAgeSource = workAgeSource(work, allPages),
): RailWorkCard[] {
  const server = new Map(usableThreads(work?.threads).map((t) => [t.key, t] as const));
  const bounded = new Map((boundaries?.threads ?? []).map((b) => [b.thread.key, b] as const));
  const aged = (c: RailThreadCard): RailThreadCard => {
    if (c.ageMs !== undefined || c.session) return c;
    const b = bounded.get(c.key);
    const t = b?.thread ?? server.get(c.key);
    if (!t) return c;
    return { ...c, ...ageField(workCardAgeMs(src, [b?.source.key ?? t.key], c.sessions, t.pages)) };
  };
  return cards.map((c) => {
    if (!isRailGroupCard(c)) return aged(c);
    const children = c.children.map(aged);
    const hidden = c.hiddenChildren?.map(aged);
    const times = [...children, ...(hidden ?? [])].flatMap((x) => (x.ageMs === undefined ? [] : [x.ageMs]));
    return { ...c, children, ...(hidden ? { hiddenChildren: hidden } : {}), ...ageField(times.length ? Math.max(...times) : undefined) };
  });
}

/**
 * The Related and Areas cards, one list per BASE card (D20): the first `cap`
 * cards of `base` — the grouping with no manual boundary, the pinned card
 * first — after the pool and the facets, exactly today's cards. A base card
 * holding a unit the reader's boundaries changed (a split page, a remainder,
 * a kept-apart thread) is regrouped from its own units after the boundaries,
 * and draws every card that makes, in its place: the pinned one first (marked
 * even when the base card held no pin), then in rank order. Those cards own
 * only the pages the base card owned and take no fold key another card of the
 * section holds, so a boundary click never adds a page to the section or
 * removes one, and the section holds at most the pieces of `cap` base cards.
 */
export function groupCardPieces(
  base: WorkGrouping,
  work: RailWikiFacts["work"],
  pool: readonly WikiListing[],
  filters: WikiFilters,
  pin: string | null,
  now: number,
  allPages: readonly WikiListing[],
  boundaries: WorkBoundaries,
  cap: number,
): WorkGroupView[][] {
  const views = projectWorkGroups(base, pool, filters, now, cap);
  /** source thread key → its units after the boundaries, for every source a boundary changed. */
  const unitsOf = new Map<string, WorkUnit[]>();
  for (const u of boundaries.units) (unitsOf.get(u.rank.key) ?? unitsOf.set(u.rank.key, []).get(u.rank.key)!).push(u);
  const changed = new Set(boundaries.units.filter((u) => u.isolated || u.thread !== u.rank).map((u) => u.rank.key));
  if (!changed.size) return views.map((v) => [v]);
  // Every fold key the section holds so far: the base cards', then each
  // regrouped card's as it is drawn, so no two cards share one.
  const taken = new Set(base.groups.map((g) => g.foldKey));
  return views.map((v) => {
    const sources = v.group.children.map((c) => c.unit.rank.key);
    if (!sources.some((k) => changed.has(k))) return [v];
    const local = groupWorkThreads({
      work,
      allPages,
      now,
      stop: base.stop,
      toggles: base.toggles,
      // Always: a piece can hold the pin its base card did not (S1 on a hub).
      pin,
      units: sources.flatMap((k) => unitsOf.get(k) ?? []),
      ownable: new Set(v.group.children.flatMap((c) => c.owned.map((p) => normalizeRel(p.relPath)))),
      foldKeysTaken: [...taken].filter((k) => k !== v.group.foldKey),
    });
    const pieces = inheritFoldKey(v.group, projectWorkGroups(local, pool, filters, now, Infinity));
    for (const piece of pieces) taken.add(piece.group.foldKey);
    return pieces;
  });
}

/**
 * A broken base GROUP's fold key stays on one of its pieces, so the reader's
 * fold and `+ N more` survive a boundary click that renames its anchor (D15)
 * or dissolves it: the piece that took the key itself, else the group piece
 * holding the base anchor's source, else the first group piece in grouping
 * order (pin-free, so a pin never moves the key). Every other piece of the
 * block reads the base key's `+ N more` too (`baseFoldKey`).
 */
function inheritFoldKey(baseGroup: WorkGroup, pieces: WorkGroupView[]): WorkGroupView[] {
  if (baseGroup.kind !== "group") return pieces;
  const key = baseGroup.foldKey;
  const groups = pieces.filter((p) => p.group.kind === "group");
  const anchorSource = baseGroup.children[0]!.unit.rank.key;
  // `orderWorkUnits`' order on the anchors: the order groups form in.
  const formed = (a: WorkGroupView, b: WorkGroupView) => {
    const x = a.group.children[0]!;
    const y = b.group.children[0]!;
    return y.score - x.score || x.unit.index - y.unit.index || x.unit.sub - y.unit.sub || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  };
  const heir =
    groups.find((p) => p.group.foldKey === key) ??
    groups.find((p) => p.group.children.some((c) => c.unit.rank.key === anchorSource)) ??
    [...groups].sort(formed)[0];
  return pieces.map((p) => ({ ...p, ...(p === heir ? { group: { ...p.group, foldKey: key } } : {}), baseFoldKey: key }));
}

/** `▸ split into N sessions` for one drawn thread card (D19): the sessions
 *  with a kept focus on its pages, from the contribution rows of its SOURCE
 *  thread restricted to its pages, so a split page and its remainder each
 *  split into their own. Ownership (which session's line a page is a row of)
 *  is decided facet-free; the lines are then the card's own drawn rows, so
 *  the split moves no page, and a session with neither a drawn row nor an
 *  `also in:` link is no line (`projectSessionCards`' rule). Offered from two
 *  lines; unavailable, with the reason, when the thread's contributions do
 *  not ship whole. */
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
  const drawn = new Set(card.focus.map((p) => normalizeRel(p.relPath)));
  const mine = (ps: readonly WikiListing[]) => ps.filter((p) => drawn.has(normalizeRel(p.relPath)));
  const shown = workSessionCards(work, allPages, at, b.source.key, new Set(b.thread.pages.map(normalizeRel)))
    .map((sc) => ({ ref: sc.ref, title: sc.title || sc.id, first: sc.first, last: sc.last, rows: mine(sc.rows), alsoIn: mine(sc.alsoIn) }))
    .filter((s) => s.rows.length || s.alsoIn.length);
  if (shown.length < 2) return undefined;
  return { count: shown.length, available: true, open, sessions: open ? shown : [] };
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
      return { kind: d.kind, title: p ? displayTitleOf(p) : d.stored, state: d.state, forget: d.kind === "split" ? (d.id ?? "") : d.stored };
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
  // D14: `group by effort` on a map wiki draws no Work threads while its folds
  // replace them (unchecking the box brings them back). X1: they hide only
  // while the map GET is pending (no thread flash before it lands) or while a
  // fold forms; a failed GET, an empty index or no fold draws them as with the
  // box off.
  const effortMode = !!viewer.effortsOn && railSectionsVisible(filters);
  const effortIndex = effortMode && wiki.efforts?.size ? wiki.efforts : null;
  // Activity is ranked BEFORE the groups in this mode: an effort with a page
  // in Activity becomes a fold that claims every page of the effort, so those
  // pages leave the series and family input (`buildRail` skips them too). The
  // ranking reads no group, so the order changes nothing else. X3: a row an
  // attachment child in an effort earned becomes the child's own row, and the
  // parent keeps one only on its own signal.
  const effortActivity = effortIndex
    ? splitLiftedChildren(
        rankActivity(filtered, wiki.activityWeights, now, wiki.workedGate),
        (c) => !c.culled && effortIndex.has(normalizeRel(c.relPath)),
        wiki.activityWeights,
        now,
        wiki.workedGate,
      )
    : null;
  const foldedEfforts = effortActivity ? foldedEffortIds(effortActivity, effortIndex!) : new Set<string>();
  const efforts = foldedEfforts.size ? effortIndex : null;
  const threadsHidden = effortMode && (!!efforts || (!wiki.efforts && !wiki.effortMapFailed));
  const outsideEfforts = (pages: WikiListing[]): WikiListing[] =>
    efforts ? pages.filter((p) => !effortFoldOf(p, efforts, foldedEfforts)) : pages;
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
    ? orderSeriesGroups(groupSeries(outsideEfforts(filtered), wiki.allPages, now), { sort: mode, now })
    : [];
  // ⚠️ A series CLAIMS its members before the family and month rules see the
  // list: a family that drops under FAMILY_MIN dissolves into plain rows, and a
  // prefix that was over FAMILY_MAX may drop to the cap and form.
  const groups =
    viewer.familiesOn && railSectionsVisible(filters)
      ? railGroups(withoutSeriesMembers(outsideEfforts(filtered), seriesGroups), {
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
  const work = threadsHidden
    ? null
    : viewer.workGroup
    ? openWorkCards(wiki.work, pool, filters, viewer.openFolds, viewer.threadPin ?? null, now, wiki.allPages, viewer.workGroup)
    : null;
  const ages = workAgeSource(wiki.work, wiki.allPages);
  const threads: readonly RailWorkCard[] = threadsHidden
    ? []
    : work?.cards ??
    withWorkAges(
      openThreadCards(wiki.work?.threads, pool, filters, viewer.openFolds, viewer.threadPin ?? null, now, wiki.allPages, wiki.work?.asOfMs),
      wiki.work,
      wiki.allPages,
      undefined,
      ages,
    );
  // The Pick up strip (plan `muninn-wiki-pick-up`): the same pool and facets
  // as the cards, each row pointing at the card drawn above that holds it.
  const pickUp = pickUpRows(wiki.work, wiki.allPages, pool, filters, threads, ages);
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
    activity: efforts
      ? effortActivity!
      : (railSectionsVisible(filters)
        ? rankActivity(rows, wiki.activityWeights, now, wiki.workedGate, exclude.size ? exclude : undefined)
        : []),
    ...(threads.length ? { threads } : {}),
    ...(threads.length && work ? { workControl: work.control } : {}),
    ...(pickUp.length ? { pickUp } : {}),
    ...(efforts ? { efforts, effortFolds: foldedEfforts, pageAgeMs: (p: WikiListing) => activityAgeMs(p, wiki.activityWeights, now, wiki.workedGate) } : {}),
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
