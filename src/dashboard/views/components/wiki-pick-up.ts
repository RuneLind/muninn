/**
 * The Pick up strip and the work cards' age chip (plan `muninn-wiki-pick-up`,
 * PR 3: D2, D5, D11, D12, D14). Pure and DOM-free: `railInputFor` builds the
 * strip's rows and the cards' ages from it, the reader runs the jump's steps
 * through it, and the replay prints the same rows.
 *
 * One source for both: the work snapshot's contribution rows
 * (`IndexWork.evidence.contributions`). The strip reads focus rows only, so a
 * touch (a weak link after PR 2, a hub link, a one-line side edit) never
 * reaches it. The age chip reads focus and touch rows of the card's own
 * sessions on its focus pages. Where a thread's rows did not ship (`cut`, an
 * unreadable block, an older server), both fall back to the listing's
 * page-level `work.focusMs`, which the server classifies the same way.
 */

import { filterPages, type WikiFilters, type WikiListing } from "./wiki-filter.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { isRailGroupCard, railSectionsVisible, type RailThreadCard, type RailWorkCard } from "./wiki-recents.ts";
import { readWorkEvidence } from "./wiki-work-groups.ts";
import { usableThreads } from "./wiki-thread-core.ts";
import {
  WORK_FOCUS_EVENTS_MAX,
  workFamilyParentOf,
  workSessionRef,
  type IndexWork,
  type WorkContribution,
  type WorkFamilyPage,
  type WorkThreadSession,
} from "../../../wiki/work-focus.ts";

/** D2: the strip shows five rows. */
export const PICK_UP_ROWS_MAX = 5;

/** The work payload as the rail reads it. */
export type PickUpWork = (Pick<IndexWork, "threads"> & Partial<Pick<IndexWork, "asOfMs" | "evidence">>) | null | undefined;

// ── The age source ──────────────────────────────────────────────────────────

/** What a card's age and a strip row's time are read from. */
export interface WorkAgeSource {
  /** The contribution rows by session ref; null when no block is readable. */
  bySession: ReadonlyMap<string, readonly WorkContribution[]> | null;
  /** Server thread keys whose rows were left out whole (`contributions.cut`). */
  cut: ReadonlySet<string>;
  /** The ledger answer was clipped: the oldest sessions are missing. */
  truncated: boolean;
  /** Normalized relPath → the page-level `work.focusMs`. */
  focusMs: ReadonlyMap<string, number>;
}

export function workAgeSource(work: PickUpWork, allPages: readonly WikiListing[]): WorkAgeSource {
  const focusMs = new Map<string, number>();
  for (const p of allPages) {
    const ms = p.work?.focusMs;
    if (typeof ms === "number" && Number.isFinite(ms)) focusMs.set(normalizeRel(p.relPath), ms);
  }
  const contributions = work ? readWorkEvidence(work.evidence, work.threads).evidence?.contributions ?? null : null;
  if (!contributions) return { bySession: null, cut: new Set(), truncated: false, focusMs };
  const bySession = new Map<string, WorkContribution[]>();
  for (const row of contributions.rows) {
    const list = bySession.get(row[0]);
    if (list) list.push(row);
    else bySession.set(row[0], [row]);
  }
  return { bySession, cut: new Set(contributions.cut), truncated: contributions.reasons.includes("ledger-truncated"), focusMs };
}

/**
 * A card's age (D5): the newest `lastMs` of a contribution row, focus or
 * touch, whose session is one of `sessions` (`workSessionRef`) and whose page
 * is one of `pages`, the card's focus pages. A card whose source thread is in
 * `contributions.cut`, or with no readable block or no such row, falls back to
 * the newest page-level focus time of its pages. Undefined when neither
 * exists. Never a creation or git date.
 */
export function workCardAgeMs(
  src: WorkAgeSource,
  sourceKeys: readonly string[],
  sessions: readonly Pick<WorkThreadSession, "provider" | "id">[],
  pages: readonly string[],
): number | undefined {
  const keys = new Set(pages.map(normalizeRel));
  let best: number | undefined;
  if (src.bySession && !sourceKeys.some((k) => src.cut.has(k))) {
    for (const s of sessions) {
      for (const row of src.bySession.get(workSessionRef(s)) ?? []) {
        if (keys.has(normalizeRel(row[1])) && (best === undefined || row[6] > best)) best = row[6];
      }
    }
  }
  if (best !== undefined) return best;
  for (const k of keys) {
    const ms = src.focusMs.get(k);
    if (ms !== undefined && (best === undefined || ms > best)) best = ms;
  }
  return best;
}

// ── The strip ───────────────────────────────────────────────────────────────

/** Where a strip row jumps: the drawn card that draws its page now. */
export interface PickUpTarget {
  /** The thread card (a lone card or a group's child). */
  card: { foldKey: string; toggleKey: string; open: boolean; name: string };
  /** The group the card is a child of. */
  group?: { foldKey: string; toggleKey: string; open: boolean; name: string };
  /** The child sits behind the group's `+ N more threads`. */
  more?: true;
}

export interface PickUpRow {
  /** The family's parent page (a plan and its `.html` are one row). */
  page: WikiListing;
  /** Its newest focus row's `lastMs`, or the page-level focus time. */
  atMs: number;
  /** Edits and sessions over its focus rows. */
  edits: number;
  sessions: number;
  /** The counts may be low: the ledger answer was clipped, or the page-level
   *  fallback holds only its newest focus events. */
  low: boolean;
  /** `rows`: contribution rows; `page`: the page-level fallback. */
  source: "rows" | "page";
  /** Null: no drawn card holds the page, so the row opens the page (D12). */
  target: PickUpTarget | null;
}

/** The drawn card that holds `rel` as a focus page under the facets: a lone
 *  thread card, a drawn child of a group, or a child behind `+ N more`. */
export function pickUpTarget(cards: readonly RailWorkCard[], rel: string): PickUpTarget | null {
  const key = normalizeRel(rel);
  const holds = (c: RailThreadCard) => c.focus.some((p) => normalizeRel(p.relPath) === key);
  const ref = (c: RailThreadCard | { foldKey: string; toggleKey: string; open: boolean; name: string }) => ({
    foldKey: c.foldKey,
    toggleKey: c.toggleKey,
    open: c.open,
    name: c.name,
  });
  for (const c of cards) {
    if (!isRailGroupCard(c)) {
      if (holds(c)) return { card: ref(c) };
      continue;
    }
    const child = c.children.find(holds);
    if (child) return { card: ref(child), group: ref(c) };
    const hidden = (c.hiddenChildren ?? []).find(holds);
    if (hidden) return { card: ref(hidden), group: ref(c), more: true };
  }
  return null;
}

/**
 * The strip's rows (D2, D11, D12): one per page family, newest first, at
 * most `PICK_UP_ROWS_MAX`, over the rail's pool under the facets, none while
 * a query is active.
 *
 *  - Focus contribution rows: a page's time is its newest focus row, its
 *    counts the rows' edits and distinct sessions.
 *  - A page in a thread whose rows were cut, or with no readable block, and a
 *    focus page outside every shipped thread: the page-level `focusMs`, edits
 *    and sessions from its focus events (D12's fallback). An attachment child
 *    is its family's: the parent's page-level work holds the family's rows.
 *  - The target is the drawn card holding the page (`pickUpTarget`), else null.
 */
export function pickUpRows(
  work: PickUpWork,
  allPages: readonly WikiListing[],
  pool: readonly WikiListing[],
  filters: WikiFilters,
  cards: readonly RailWorkCard[],
  src: WorkAgeSource = workAgeSource(work, allPages),
): PickUpRow[] {
  if (!work || !railSectionsVisible(filters) || !usableThreads(work.threads).length) return [];
  const byRel = new Map<string, WikiListing>();
  for (const p of allPages) byRel.set(normalizeRel(p.relPath), p);
  const visible = new Set(filterPages(pool as WikiListing[], filters).map((p) => normalizeRel(p.relPath)));
  const agg = new Map<string, { atMs: number; edits: number; sessions: Set<string>; low: boolean; source: "rows" | "page"; count?: number }>();
  if (src.bySession) {
    for (const rows of src.bySession.values()) {
      for (const [ref, page, thread, kind, edits, , lastMs] of rows) {
        if (kind !== "focus" || src.cut.has(thread)) continue;
        const k = normalizeRel(page);
        const a = agg.get(k) ?? { atMs: lastMs, edits: 0, sessions: new Set<string>(), low: src.truncated, source: "rows" as const };
        a.atMs = Math.max(a.atMs, lastMs);
        a.edits += edits;
        a.sessions.add(ref);
        agg.set(k, a);
      }
    }
  }
  // The page-level fallback, for every focus page the rows do not cover.
  // The listing's `pairedBy` is a plain string; the family rule reads only
  // the three pairings it names, so the cast loses nothing.
  const familyOf = workFamilyParentOf(allPages as readonly WorkFamilyPage[]);
  for (const p of allPages) {
    const w = p.work;
    if (w?.state !== "F" || typeof w.focusMs !== "number") continue;
    if (familyOf(p as WorkFamilyPage) !== undefined) continue;
    const k = normalizeRel(p.relPath);
    if (agg.has(k)) continue;
    const focus = w.events.filter((e) => e[2] === "focus");
    agg.set(k, {
      atMs: w.focusMs,
      edits: focus.reduce((n, e) => n + e[1], 0),
      sessions: new Set(),
      count: focus.length,
      low: src.truncated || focus.length >= WORK_FOCUS_EVENTS_MAX,
      source: "page",
    });
  }
  const out: PickUpRow[] = [];
  for (const [k, a] of agg) {
    const page = byRel.get(k);
    if (!page || !visible.has(k)) continue;
    out.push({ page, atMs: a.atMs, edits: a.edits, sessions: a.count ?? a.sessions.size, low: a.low, source: a.source, target: null });
  }
  out.sort((x, y) => y.atMs - x.atMs || (normalizeRel(x.page.relPath) < normalizeRel(y.page.relPath) ? -1 : 1));
  return out.slice(0, PICK_UP_ROWS_MAX).map((r) => ({ ...r, target: pickUpTarget(cards, r.page.relPath) }));
}

/** What a strip row's jump does next, over the cards drawn now. */
export type PickUpStep =
  /** No drawn card holds the page: open the page itself (D12). */
  | { kind: "page" }
  /** The card holding it is drawn open, its group too: reveal the row. */
  | { kind: "drawn" }
  /** Open these folds (each a `toggleKey` whose flip opens it) and press
   *  `more` (a group's fold key), then render and ask again. */
  | { kind: "open"; toggle: string[]; more?: string };

export function pickUpStep(cards: readonly RailWorkCard[], rel: string): PickUpStep {
  const t = pickUpTarget(cards, rel);
  if (!t) return { kind: "page" };
  const toggle: string[] = [];
  if (t.group && !t.group.open) toggle.push(t.group.toggleKey);
  // A child behind `+ N more` is opened on the next step, once it is drawn.
  if (!t.more && !t.card.open) toggle.push(t.card.toggleKey);
  if (!toggle.length && !t.more) return { kind: "drawn" };
  return { kind: "open", toggle, ...(t.more && t.group ? { more: t.group.foldKey } : {}) };
}

/** A strip row's second line: edits, sessions, then the card that draws the
 *  page, or `not in Work threads`. A `+` marks a count that may be low. Edits
 *  are weighted (an attachment's count half), so they print rounded. */
export function pickUpMetaLine(r: PickUpRow): string {
  const plus = r.low ? "+" : "";
  const edits = Math.round(r.edits);
  const counts = [
    `${edits}${plus} ${edits === 1 && !plus ? "edit" : "edits"}`,
    `${r.sessions}${plus} ${r.sessions === 1 && !plus ? "session" : "sessions"}`,
  ];
  return [...counts, r.target ? `in ${r.target.card.name}` : "not in Work threads"].join(" · ");
}
