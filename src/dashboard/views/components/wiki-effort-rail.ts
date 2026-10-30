/**
 * The rail's `group by effort` mode (plan `muninn-wiki-work-map`, P4, D8):
 * which effort each listed page belongs to, read off the work map through
 * `joinWorkMap`, and the mode's key in the folds store. `buildRail` folds the
 * Activity rows by it; this module owns no layout.
 */

import { joinWorkMap } from "../../../wiki/work-map/join.ts";
import type { EffortState, WorkMap } from "../../../wiki/work-map/schema.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { effortNeedItems, openNeeds, WORK_MAP_LANES } from "./wiki-work-card.ts";
import type { WikiListing } from "./wiki-filter.ts";

/**
 * The mode's key in the folds store. The store reads a `toggle:` key as ON,
 * and this mode defaults ON wherever a map exists, so the key stores the
 * exception: present means the reader turned grouping OFF.
 */
export const EFFORTS_OFF_TOGGLE_KEY = "toggle:no-efforts";

/** An effort fold's key: `effort:<id>`. Its `closed:` spelling is written only
 *  for a fold that defaults open. */
export const EFFORT_FOLD_PREFIX = "effort:";

/** How many effort folds start open: the most recently active ones. */
export const EFFORTS_OPEN_DEFAULT = 3;

/** The effort states whose folds may start open (D14): the card's Moving lane. */
export const EFFORT_MOVING_STATES: readonly EffortState[] = WORK_MAP_LANES.find((l) => l.id === "moving")!.states;

/** How many rows an open fold shows before «+N more» (D14). */
export const EFFORT_ROWS_SHOWN = 4;

/** An open fold's «+N more» key: `effort-all:<id>`. Stored means every row
 *  shows; absent means the first {@link EFFORT_ROWS_SHOWN}. */
export const EFFORT_ALL_PREFIX = "effort-all:";

export function effortAllKey(id: string): string {
  return EFFORT_ALL_PREFIX + id;
}

export function effortFoldKey(id: string): string {
  return EFFORT_FOLD_PREFIX + id;
}

/** What an effort fold row says about its effort. */
export interface RailEffort {
  id: string;
  name: string;
  state: EffortState;
  /** The map's one-line summary, raw: `⟦relPath⟧` markers and all. The
   *  painter renders it through the card's `proseHtml`. */
  oneLine: string;
  /** The keys (`needKey`) of the map's Needs-you items for this effort; the
   *  painter subtracts the ones ✓ on the card, as the effort page does. */
  needs: string[];
  /** Page key (normalized relPath) → the page's role in this effort. */
  roles: ReadonlyMap<string, string>;
}

/** ✋ on a fold: the effort's Needs-you items not marked done on the card. */
export function effortNeedsOpen(effort: Pick<RailEffort, "needs">, done: ReadonlySet<string>): number {
  return openNeeds(effort.needs.map((key) => ({ key })), done).length;
}

/** The efforts that fold (D14): those with a page in Activity. Computed once,
 *  in `railInputFor`, and handed to `buildRail` as `RailInput.effortFolds`. */
export function foldedEffortIds(activity: readonly { page: WikiListing }[], efforts: ReadonlyMap<string, RailEffort>): Set<string> {
  const out = new Set<string>();
  for (const r of activity) {
    const e = efforts.get(normalizeRel(r.page.relPath));
    if (e) out.add(e.id);
  }
  return out;
}

/** The fold that lists `p`, or undefined. A culled page is never listed: it
 *  stays where culled pages go with retired shown (X2). */
export function effortFoldOf(p: WikiListing, efforts: ReadonlyMap<string, RailEffort>, folded: ReadonlySet<string>): RailEffort | undefined {
  if (p.culled) return undefined;
  const e = efforts.get(normalizeRel(p.relPath));
  return e && folded.has(e.id) ? e : undefined;
}

/** Is the reader's mode on? Off on a wiki with no map, whatever is stored. */
export function effortsOn(openFolds: readonly string[], hasMap: boolean): boolean {
  // The folds store's own comparison (`isFoldOpen`), inlined: `wiki-recents.ts`
  // imports this module, so importing it back would be a cycle.
  return hasMap && !openFolds.some((k) => normalizeRel((k || "").trim()) === EFFORTS_OFF_TOGGLE_KEY);
}

/**
 * Page key (normalized relPath) → its effort, over the live listing. A
 * sub-effort is its own entry, as flat as its parent (the rail does not
 * nest). A page two efforts list belongs to the first one in map order, so a
 * page sits in one fold.
 */
export function railEffortIndex(map: WorkMap, pages: readonly WikiListing[], now: number): Map<string, RailEffort> {
  const out = new Map<string, RailEffort>();
  for (const e of joinWorkMap(map, pages, now).efforts) {
    const roles = new Map<string, string>();
    const needs = effortNeedItems(map.needsYou, e.id).map((n) => n.key);
    const effort: RailEffort = { id: e.id, name: e.name, state: e.state, oneLine: e.oneLine, needs, roles };
    for (const p of e.pages) {
      const key = normalizeRel(p.page.relPath);
      if (out.has(key)) continue;
      out.set(key, effort);
      roles.set(key, p.role);
    }
  }
  return out;
}
