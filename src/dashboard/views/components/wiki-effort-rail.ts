/**
 * The rail's `group by effort` mode (plan `muninn-wiki-work-map`, P4, D8):
 * which effort each listed page belongs to, read off the work map through
 * `joinWorkMap`, and the mode's key in the folds store. `buildRail` folds the
 * Activity rows by it; this module owns no layout.
 */

import { joinWorkMap } from "../../../wiki/work-map/join.ts";
import type { EffortState, WorkMap } from "../../../wiki/work-map/schema.ts";
import { normalizeRel } from "./wiki-nav.ts";
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

export function effortFoldKey(id: string): string {
  return EFFORT_FOLD_PREFIX + id;
}

/** What an effort fold row says about its effort. */
export interface RailEffort {
  id: string;
  name: string;
  state: EffortState;
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
    const effort: RailEffort = { id: e.id, name: e.name, state: e.state };
    for (const p of e.pages) {
      const key = normalizeRel(p.page.relPath);
      if (!out.has(key)) out.set(key, effort);
    }
  }
  return out;
}
