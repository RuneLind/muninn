/**
 * The work-thread helpers both the rail's thread cards (`wiki-rail-input.ts`)
 * and the grouping model (`wiki-work-groups.ts`) read: the payload guard, the
 * card name, the pin's anchor and match, and the order score. Moved out of
 * `wiki-rail-input.ts` unchanged so the grouping model can import them without
 * an import cycle once the rail calls the model. Pure and DOM-free.
 */

import { pageWorkTerm } from "./wiki-activity-rank.ts";
import { pageAddedMs, type WikiListing } from "./wiki-filter.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { isWorkHub, threadScore, WORK_WINDOW_MS, type WorkThread, type WorkThreadSession } from "../../../wiki/work-focus.ts";

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

const isHubRel = (rel: string, byRel: ReadonlyMap<string, WikiListing>) => isWorkHub(byRel.get(rel)?.backlinkCount ?? 0);

/** The page the 📌 stores for a thread (D7): its NEWEST non-hub focus page —
 *  the highest `work.focusMs` — because the server drops a page from `pages`
 *  once its last focus event leaves the window, so the newest is the last to
 *  go (the `key` is the earliest, the first). A hub is never the anchor of a
 *  thread that holds a non-hub page: D16 moves a hub's focus row to whichever
 *  thread works it most. A thread of hubs only anchors on its newest hub. Ties
 *  go to the smaller relPath. */
export function newestFocusPage(t: WorkThread, byRel: ReadonlyMap<string, WikiListing>): string {
  const pick = (hubs: boolean) => {
    let best: { rel: string; ms: number } | null = null;
    for (const raw of t.pages) {
      const rel = normalizeRel(raw);
      if (isHubRel(rel, byRel) !== hubs) continue;
      const ms = byRel.get(rel)?.work?.focusMs ?? -Infinity;
      if (!best || ms > best.ms || (ms === best.ms && rel < best.rel)) best = { rel, ms };
    }
    return best?.rel;
  };
  return pick(false) ?? pick(true) ?? normalizeRel(t.key);
}

/**
 * Does thread `t` hold the pin on `pinKey` (D7 × D16)? It must hold the page
 * as a focus page. A pin on a HUB also needs a thread of hubs only: D16 moves
 * a hub into whichever thread works it most, so a hub pin matched by
 * membership alone would follow the hub into a thread the reader never pinned.
 * The hub test reads the listing as it is now, so a pinned page that crosses
 * the hub threshold while its thread holds other pages stops matching.
 */
export function threadHoldsPin(t: WorkThread, byRel: ReadonlyMap<string, WikiListing>, pinKey: string): boolean {
  if (!t.pages.some((p) => normalizeRel(p) === pinKey)) return false;
  return !isHubRel(pinKey, byRel) || t.pages.every((p) => isHubRel(normalizeRel(p), byRel));
}

/**
 * The stored pin re-anchored (D7): the newest focus page of the thread holding
 * `pin` (`threadHoldsPin`), or null when no thread holds it. The pin's state
 * table (`threadPinStep`) decides whether the move is written, so a pinned
 * thread stays pinned as it grows and its oldest pages age out of the window.
 * A thread that ages out WHOLE between two renders loses its pin — the server
 * no longer names it.
 */
export function threadPinAnchor(
  threads: readonly WorkThread[] | null | undefined,
  allPages: readonly WikiListing[],
  pin: string | null,
): string | null {
  if (!pin) return null;
  const pinKey = normalizeRel(pin);
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const t = usableThreads(threads).find((x) => threadHoldsPin(x, byRel, pinKey));
  return t ? newestFocusPage(t, byRel) : null;
}

/** The instant the work threads rank at: never before `asOfMs`, where an
 *  event's age would clamp at 0 (`eventRaw`) and could reorder threads away
 *  from the server's order. The rail and the grouping model both use it. */
export function workGroupingInstant(now: number, asOfMs: number | undefined): number {
  return typeof asOfMs === "number" && Number.isFinite(asOfMs) ? Math.max(now, asOfMs) : now;
}

/** A thread's order score at `now` over the full listing's work — the score
 *  `openThreadCards` orders its cards by and the grouping model orders its
 *  units by (D16). `byRel` is keyed on `normalizeRel`. */
export function threadRankScore(t: WorkThread, byRel: ReadonlyMap<string, WikiListing>, now: number): number {
  return threadScore(t, (rel) => byRel.get(normalizeRel(rel))?.work, now);
}

// ── Ownership and card rows ─────────────────────────────────────────────────
// ONE copy for the rail's thread cards (`openThreadCards`) and the grouping
// model (`groupWorkThreads`, `projectWorkGroups`), so the two cannot drift.

/** Focus-row order at `at`: work term, highest first, then relPath. */
export function workTermOrder(at: number): (a: WikiListing, b: WikiListing) => number {
  const term = (p: WikiListing) => pageWorkTerm(p, at);
  return (a, b) => term(b) - term(a) || (normalizeRel(a.relPath) < normalizeRel(b.relPath) ? -1 : 1);
}

/**
 * The focus pages a thread OWNS, taken in drawn order over the full listing:
 * its pages not yet in `taken`, sorted by `order`, and then added to `taken`.
 * A hub has one owner (D16): a page an earlier card owns is neither a row nor
 * the name of a later one. `byRel` is keyed on `normalizeRel`.
 */
export function claimOwnedFocus(
  pages: readonly string[],
  byRel: ReadonlyMap<string, WikiListing>,
  taken: Set<string>,
  order: (a: WikiListing, b: WikiListing) => number,
): WikiListing[] {
  const owned = pages
    .map((rel) => byRel.get(normalizeRel(rel)))
    .filter((p): p is WikiListing => !!p && !taken.has(normalizeRel(p.relPath)))
    .sort(order);
  for (const p of owned) taken.add(normalizeRel(p.relPath));
  return owned;
}

/** A card's rows under the facets: its owned focus pages that are `visible`,
 *  the ones created inside the work window at the reader's `now` (never the
 *  grouping instant), the touched pages that are visible and not owned, and
 *  the open `you` steps across the focus rows. */
export function threadCardRows(
  owned: readonly WikiListing[],
  touchedRels: readonly string[],
  visible: ReadonlySet<string>,
  byRel: ReadonlyMap<string, WikiListing>,
  now: number,
): { focus: WikiListing[]; created: string[]; touched: WikiListing[]; movesYou: number } {
  const focus = owned.filter((p) => visible.has(normalizeRel(p.relPath)));
  const ownedKeys = new Set(owned.map((p) => normalizeRel(p.relPath)));
  const touched = touchedRels
    .map((rel) => byRel.get(normalizeRel(rel)))
    .filter((p): p is WikiListing => !!p && visible.has(normalizeRel(p.relPath)) && !ownedKeys.has(normalizeRel(p.relPath)));
  const window = now - WORK_WINDOW_MS;
  return {
    focus,
    created: focus.filter((p) => pageAddedMs(p, now) >= window).map((p) => normalizeRel(p.relPath)),
    touched,
    movesYou: focus.reduce((sum, p) => sum + (p.movesYou ?? 0), 0),
  };
}
