/**
 * Save as series — the Work threads' join action (plan
 * `muninn-wiki-work-thread-grouping`, D8, D14): which pages a group's ⋯ would
 * write `series:` on, under which key, and why it may not. Pure: the reader
 * shows this plan, fetches every base first and runs the writes through
 * `writeSeriesUnlessOpenChanged` (`wiki-series-write.ts`).
 *
 *  - A page is writable when it can carry `series:` at all
 *    (`canEditSeriesPage`), is narrative (`isNarrativePage`, lint 8.2's
 *    predicate, so a reference page is never written), is live and is in no
 *    series yet. An attachment stands for its parent (an `.html` twin writes
 *    its markdown page): a `series:` on an attachment counts nowhere.
 *  - A page already in ANOTHER series is listed and left alone: moving it
 *    could drop that series' label. "In a series" is membership as the rail
 *    counts it (`seriesMembersByFoldKey`), so a page carrying a key the rail
 *    does not count is skipped, not joined.
 *  - The key: one series among the group's pages is joined (its head's
 *    spelling); two or more refuse (merging series is an editorial decision);
 *    none coins a new key from the head's stem, unique under the census
 *    (`coinSeriesKey` on a fresh set).
 *  - Offered only when every child keeps a writable or already-joined page:
 *    a group is named by a series only when every child has a page in it.
 */

import { displayTitleOf, type WikiListing } from "./wiki-filter.ts";
import { bySeriesDateDesc, newestSeriesPlan, seriesCensusKey, seriesHead, seriesKeyOf, seriesMembersByFoldKey } from "./wiki-groups.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { canEditSeriesPage } from "./wiki-series-menu.ts";
import type { WorkGroup } from "./wiki-work-groups.ts";
import { coinSeriesKey, isNarrativePage, seriesPageStem } from "../../../wiki/series-rules.ts";

/** Why a page is not written. */
export type SaveSeriesSkip =
  /** In another series, as the rail counts it. */
  | "other-series"
  /** Carries a `series:` the rail does not count (a retired page whose successor is outside). */
  | "not-counted"
  /** Retired. */
  | "retired"
  /** No page may carry `series:` here (an `.html` page with no markdown parent, a reserved stem). */
  | "not-editable"
  /** A reference page, not a piece of work-in-time. */
  | "not-narrative";

export interface SaveSeriesPage {
  /** The page written (an attachment's parent), as the listing spells it. */
  relPath: string;
  title: string;
}

export interface SaveSeriesChild {
  name: string;
  key: string;
  write: SaveSeriesPage[];
  /** Already in the series the plan joins. */
  joined: SaveSeriesPage[];
  skipped: (SaveSeriesPage & { why: SaveSeriesSkip; series?: string })[];
}

export type SaveSeriesBlock =
  | { kind: "several-series"; labels: string[] }
  | { kind: "uncovered"; children: string[] }
  | { kind: "nothing-to-write" };

export interface SaveSeriesPlan {
  /** False ⇒ the item renders `aria-disabled` with `block` as its reason. */
  available: boolean;
  block?: SaveSeriesBlock;
  /** `join` one existing series, or `coin` a new key. */
  mode: "join" | "coin";
  /** The key written: the joined series' head spelling, or the coined key. */
  key: string;
  /** The joined series' label (its head's), for the confirm line. */
  label?: string;
  children: SaveSeriesChild[];
  /** Every page written, once, in child order. */
  writes: SaveSeriesPage[];
  /** Every census key any page declares: a key the reader types must miss
   *  all of them (a coined key never merges into another series). */
  taken: string[];
}

/**
 * The plan for one group (its children in grouping order), over the full
 * listing. Children are read whole (`unit.thread.pages`, after the reader's
 * splits), not under the facets: a facet never changes what is written.
 */
export function saveAsSeriesPlan(group: Pick<WorkGroup, "children">, allPages: readonly WikiListing[]): SaveSeriesPlan {
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const census = seriesMembersByFoldKey(allPages);
  const memberOf = new Map<string, string>();
  for (const [fold, members] of census) for (const m of members) memberOf.set(normalizeRel(m.relPath), fold);
  const labelOf = (fold: string) => {
    const head = seriesHead(census.get(fold) ?? []);
    return head?.seriesLabel || (head ? seriesKeyOf(head) : "") || fold;
  };
  const taken = [...new Set(allPages.map((p) => seriesKeyOf(p)).filter(Boolean).map(seriesCensusKey))].sort();

  interface Seen { page: SaveSeriesPage; fold?: string; skip?: SaveSeriesSkip; listing: WikiListing }
  const perChild = group.children.map((c) => {
    const seen: Seen[] = [];
    const mine = new Set<string>();
    for (const raw of c.unit.thread.pages) {
      const own = byRel.get(normalizeRel(raw));
      if (!own) continue;
      // An attachment stands for its parent; a retired (superseded) child does not.
      const target = own.parent && own.pairedBy !== "superseded" ? byRel.get(normalizeRel(own.parent)) ?? own : own;
      const k = normalizeRel(target.relPath);
      if (mine.has(k)) continue;
      mine.add(k);
      const page = { relPath: target.relPath, title: displayTitleOf(target) };
      const fold = memberOf.get(k);
      if (fold) seen.push({ page, fold, listing: target });
      else if (seriesKeyOf(target)) seen.push({ page, skip: "not-counted", listing: target });
      else if (target.culled) seen.push({ page, skip: "retired", listing: target });
      else if (!canEditSeriesPage(target.relPath)) seen.push({ page, skip: "not-editable", listing: target });
      else if (!isNarrativePage(target)) seen.push({ page, skip: "not-narrative", listing: target });
      else seen.push({ page, listing: target });
    }
    return { c, seen };
  });

  const folds = [...new Set(perChild.flatMap((x) => x.seen.flatMap((s) => (s.fold ? [s.fold] : []))))];
  const joinFold = folds.length === 1 ? folds[0] : undefined;
  const children: SaveSeriesChild[] = perChild.map(({ c, seen }) => ({
    name: c.name,
    key: c.key,
    write: seen.filter((s) => !s.fold && !s.skip).map((s) => s.page),
    joined: seen.filter((s) => s.fold && s.fold === joinFold).map((s) => s.page),
    skipped: seen
      .filter((s) => s.skip || (s.fold && s.fold !== joinFold))
      .map((s) => (s.skip ? { ...s.page, why: s.skip } : { ...s.page, why: "other-series" as const, series: labelOf(s.fold!) })),
  }));
  const writes: SaveSeriesPage[] = [];
  const once = new Set<string>();
  for (const ch of children)
    for (const w of ch.write) {
      const k = normalizeRel(w.relPath);
      if (!once.has(k)) once.add(k), writes.push(w);
    }

  let key: string;
  let label: string | undefined;
  if (joinFold) {
    const head = seriesHead(census.get(joinFold) ?? []);
    key = (head && seriesKeyOf(head)) || joinFold;
    label = labelOf(joinFold);
  } else {
    // The head the lint picks for a coined series: the newest open plan, else
    // the newest page, by the series date order.
    const listings = perChild.flatMap((x) => x.seen.filter((s) => !s.fold && !s.skip).map((s) => s.listing));
    const sorted = [...listings].sort(bySeriesDateDesc);
    const head = newestSeriesPlan(sorted) ?? sorted[0];
    key = head ? coinSeriesKey(seriesPageStem(head.relPath), new Set(taken)) : "";
  }

  const base = { mode: joinFold ? ("join" as const) : ("coin" as const), key, ...(label ? { label } : {}), children, writes, taken };
  if (folds.length >= 2) return { ...base, available: false, block: { kind: "several-series", labels: folds.map(labelOf).sort() } };
  const uncovered = children.filter((ch) => !ch.write.length && !ch.joined.length).map((ch) => ch.name);
  if (uncovered.length) return { ...base, available: false, block: { kind: "uncovered", children: uncovered } };
  if (!writes.length) return { ...base, available: false, block: { kind: "nothing-to-write" } };
  return { ...base, available: true };
}

/** A key the reader typed for a NEW series, or why not: empty, or the fold
 *  of an existing series (a new key must never merge into one). */
export function checkNewSeriesKey(plan: Pick<SaveSeriesPlan, "taken">, typed: string): { key: string } | { error: string } {
  const key = typed.trim();
  if (!key) return { error: "Type a series key" };
  if (plan.taken.includes(seriesCensusKey(key))) return { error: `"${key}" is already a series here — pick another key` };
  return { key };
}

export interface SaveSeriesRecheck {
  /** The planned writes still to send, in plan order. */
  writes: SaveSeriesPage[];
  /** Planned pages another writer put into a different series since. */
  moved: (SaveSeriesPage & { series: string })[];
  /** Set ⇒ write nothing, and say this. */
  error?: string;
  /** The refusal is the reader's to resolve in place (another key): the
   *  confirm view keeps Write on. Unset ⇒ the plan itself is stale. */
  retry?: boolean;
}

/**
 * The plan against a listing read AFTER the CAS bases (D14): the plan is a
 * snapshot from when the item was clicked, the route moves a page from any
 * series, and moving a series' labelled head drops that series' label. A
 * planned write now in another series is left alone; one already under `key`
 * is not rewritten. Nothing is written when an already-joined page is no
 * longer under `key` (the group would no longer be named by it), when a child
 * is left with no page in the series, or when a new key has become a series
 * since (`retry`: the reader picks another).
 */
export function recheckSaveAsSeries(
  plan: Pick<SaveSeriesPlan, "mode" | "children" | "writes" | "label">,
  key: string,
  fresh: readonly WikiListing[],
): SaveSeriesRecheck {
  const byRel = new Map<string, WikiListing>();
  for (const p of fresh) byRel.set(normalizeRel(p.relPath), p);
  const target = seriesCensusKey(key);
  const foldNow = (rel: string): string | undefined => {
    const p = byRel.get(normalizeRel(rel));
    const k = p ? seriesKeyOf(p) : "";
    return k ? seriesCensusKey(k) : undefined;
  };
  const planned = new Set(plan.writes.map((w) => normalizeRel(w.relPath)));
  if (plan.mode === "coin") {
    const clash = fresh.some((p) => !planned.has(normalizeRel(p.relPath)) && seriesKeyOf(p) && seriesCensusKey(seriesKeyOf(p)) === target);
    if (clash) return { writes: [], moved: [], retry: true, error: `"${key}" became a series here since this menu opened — nothing written; pick another key` };
  }
  const census = seriesMembersByFoldKey(fresh);
  const labelOf = (fold: string) => {
    const head = seriesHead(census.get(fold) ?? []);
    return head?.seriesLabel || (head ? seriesKeyOf(head) : "") || fold;
  };
  // The key, re-derived: every page the plan counted as joined is still under it.
  const left = plan.children.flatMap((ch) => ch.joined).filter((j) => foldNow(j.relPath) !== target);
  if (left.length) {
    const now = (j: SaveSeriesPage) => {
      const f = foldNow(j.relPath);
      return f ? `now in «${labelOf(f)}»` : "now in no series";
    };
    return { writes: [], moved: [], error: `Nothing written — left «${plan.label ?? key}» since this menu opened: ${left.map((j) => `${j.title} (${now(j)})`).join(", ")}` };
  }
  const moved: SaveSeriesRecheck["moved"] = [];
  const movedRel = new Set<string>();
  const inAlready = new Set<string>();
  for (const w of plan.writes) {
    const fold = foldNow(w.relPath);
    if (!fold) continue;
    if (fold === target) inAlready.add(normalizeRel(w.relPath));
    else moved.push({ ...w, series: labelOf(fold) }), movedRel.add(normalizeRel(w.relPath));
  }
  // A joined page covers its child (all are still under the key, above).
  const covered = (ch: SaveSeriesChild) => ch.joined.length > 0 || ch.write.some((w) => !movedRel.has(normalizeRel(w.relPath)));
  if (!plan.children.every(covered)) {
    return { writes: [], moved, error: `Nothing written — joined another series since this menu opened: ${moved.map((m) => `${m.title} (in «${m.series}»)`).join(", ")}` };
  }
  const writes = plan.writes.filter((w) => !movedRel.has(normalizeRel(w.relPath)) && !inAlready.has(normalizeRel(w.relPath)));
  return { writes, moved };
}
