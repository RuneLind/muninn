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
  pageAddedMs,
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
  groupFoldState,
  railSectionsVisible,
  THREAD_CARDS_MAX,
  threadFoldKey,
  type RailInput,
  type RailThreadCard,
} from "./wiki-recents.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { isWorkHub, threadScore, WORK_WINDOW_MS, type IndexWork, type WorkThread, type WorkThreadSession } from "../../../wiki/work-focus.ts";

/** What the wiki's listing says — the same for every viewer. */
export interface RailWikiFacts {
  allPages: WikiListing[];
  /** The wiki's project names (`/api/wiki/pages`' `projects`). */
  projects: Record<string, number>;
  activityWeights: ActivityWeights;
  workedGate: WorkedGate | null;
  /** The work threads (`/api/wiki/pages`' `work`); absent or null with no
   *  sessions memo, which renders no section (D11). */
  work?: Pick<IndexWork, "threads"> | null;
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
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The threads of a payload this client can draw: a `key`, string `pages` and
 *  `touched` lists and at least one well-formed session (a malformed session
 *  is skipped). A malformed thread — one with no usable session included — is
 *  dropped whole, never thrown on: the payload crossed the wire. */
export function usableThreads(threads: unknown): WorkThread[] {
  if (!Array.isArray(threads)) return [];
  const out: WorkThread[] = [];
  for (const t of threads) {
    if (!t || typeof t !== "object") continue;
    const { key, pages, touched, sessions } = t as Record<string, unknown>;
    if (!isStr(key) || !Array.isArray(pages) || !pages.every(isStr)) continue;
    if (!Array.isArray(touched) || !touched.every(isStr) || !Array.isArray(sessions)) continue;
    const ss: WorkThreadSession[] = [];
    for (const x of sessions) {
      if (!x || typeof x !== "object") continue;
      const r = x as Record<string, unknown>;
      if (!isStr(r.id) || !isFiniteNum(r.first) || !isFiniteNum(r.last)) continue;
      ss.push({
        id: r.id,
        provider: typeof r.provider === "string" ? r.provider : "",
        first: r.first,
        last: r.last,
        title: typeof r.title === "string" ? r.title : "",
      });
    }
    if (!ss.length) continue;
    out.push({ key, pages: pages as string[], touched: touched as string[], sessions: ss });
  }
  return out;
}

/** The card name: the top page's display title, cut at the first ` — `. */
export function threadName(title: string): string {
  const cut = title.indexOf(" — ");
  return cut > 0 ? title.slice(0, cut) : title;
}

/** The page the 📌 stores for a thread (D7): its NEWEST non-hub focus page —
 *  the highest `work.focusMs` — because the server drops a page from `pages`
 *  once its last focus event leaves the window, so the newest is the last to
 *  go. The thread's `key` is its EARLIEST focus page, the first to go. A hub is
 *  never the anchor: D16 moves a hub's focus row to whichever thread works it
 *  most, so a pin on it would follow the hub into another live thread. A thread
 *  holding hubs only anchors on its key, as the server keys it. */
function newestFocusPage(t: WorkThread, byRel: ReadonlyMap<string, WikiListing>): string {
  let best: { rel: string; ms: number } | null = null;
  for (const raw of t.pages) {
    const rel = normalizeRel(raw);
    const p = byRel.get(rel);
    if (isWorkHub(p?.backlinkCount ?? 0)) continue;
    const ms = p?.work?.focusMs ?? -Infinity;
    if (!best || ms > best.ms || (ms === best.ms && rel < best.rel)) best = { rel, ms };
  }
  return best ? best.rel : normalizeRel(t.key);
}

/**
 * The stored pin re-anchored (D7): the newest focus page of the thread holding
 * `pin`, or null when no thread holds it. `renderList` writes it back whenever
 * it differs, so a pinned thread stays pinned as it grows and its oldest pages
 * age out of the window. A thread that ages out WHOLE between two renders
 * loses its pin — the server no longer names it.
 */
export function threadPinAnchor(
  threads: readonly WorkThread[] | null | undefined,
  allPages: readonly WikiListing[],
  pin: string | null,
): string | null {
  if (!pin) return null;
  const pinKey = normalizeRel(pin);
  const t = usableThreads(threads).find((x) => x.pages.some((p) => normalizeRel(p) === pinKey));
  if (!t) return null;
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  return newestFocusPage(t, byRel);
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
 *    Order is `threadScore` at the anchored `now` — except the PINNED thread
 *    (the one holding `pin` as a focus page, D7), which renders first. At most
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
): RailThreadCard[] {
  const usable = usableThreads(threads);
  if (!usable.length || !railSectionsVisible(filters)) return [];
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const visible = new Set(filterPages(pages as WikiListing[], filters).map((p) => normalizeRel(p.relPath)));
  const pinKey = pin ? normalizeRel(pin) : null;
  const term = (p: WikiListing) => pageWorkTerm(p, now);
  const byTerm = (a: WikiListing, b: WikiListing) =>
    term(b) - term(a) || (normalizeRel(a.relPath) < normalizeRel(b.relPath) ? -1 : 1);
  let pinTaken = false;
  const ranked = usable
    .map((t) => ({
      t,
      score: threadScore(t, (rel) => byRel.get(normalizeRel(rel))?.work, now),
      holdsPin: !!pinKey && t.pages.some((p) => normalizeRel(p) === pinKey),
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
  // Ownership runs over the full listing in ranked order and through every
  // thread, a dropped card included, so a facet never hands a hub to a later card.
  const taken = new Set<string>();
  const window = now - WORK_WINDOW_MS;
  const cards: Omit<RailThreadCard, "open" | "toggleKey">[] = [];
  for (const { t, score, pinned } of ranked) {
    if (cards.length >= THREAD_CARDS_MAX) break;
    const owned = t.pages
      .map((rel) => byRel.get(normalizeRel(rel)))
      .filter((p): p is WikiListing => !!p && !taken.has(normalizeRel(p.relPath)))
      .sort(byTerm);
    for (const p of owned) taken.add(normalizeRel(p.relPath));
    const focus = owned.filter((p) => visible.has(normalizeRel(p.relPath)));
    if (!focus.length) continue;
    const ownedKeys = new Set(owned.map((p) => normalizeRel(p.relPath)));
    const touched = t.touched
      .map((rel) => byRel.get(normalizeRel(rel)))
      .filter((p): p is WikiListing => !!p && visible.has(normalizeRel(p.relPath)) && !ownedKeys.has(normalizeRel(p.relPath)));
    cards.push({
      key: t.key,
      foldKey: threadFoldKey(t.key),
      // Named by the top page the thread OWNS in the whole listing, so neither
      // a facet nor Show retired renames it.
      name: threadName(displayTitleOf(owned[0]!)),
      pinned,
      pinAnchor: newestFocusPage(t, byRel),
      focus,
      created: focus.filter((p) => pageAddedMs(p, now) >= window).map((p) => normalizeRel(p.relPath)),
      touched,
      sessions: t.sessions,
      movesYou: focus.reduce((sum, p) => sum + (p.movesYou ?? 0), 0),
      score,
    });
  }
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
  const threads = openThreadCards(wiki.work?.threads, pool, filters, viewer.openFolds, viewer.threadPin ?? null, now, wiki.allPages);
  const exclude = new Set<string>();
  for (const c of threads) if (c.open) for (const p of c.focus) exclude.add(normalizeRel(p.relPath));
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
