/**
 * The `/plans` board's shared vocabulary and view rules — the half that has no
 * DOM and no filesystem, so both ends can use it.
 *
 * The server (`board.ts`) builds the payload with these types and computes the
 * meters with {@link computeMeters}; the browser (`plan-board-browser.ts`)
 * re-runs the SAME functions after every filter change. That is deliberate: the
 * "Backlog, priced" tile and the cards it counts cannot disagree if there is one
 * function that decides which cards are counted and what they sum to.
 *
 * **This module imports NOTHING but types.** It is bundled into the page's
 * browser script, so a runtime import here would drag `estimate.ts`'s pricing
 * machinery (or worse, the wiki registry) into the browser. Anything the client
 * needs from those modules is resolved server-side and lands in the payload as
 * data — `family`, for one, is always a string here (`"unknown"` where the
 * server could not name a repo), so the client never needs the enum.
 *
 * Four behaviours the design prototype (`docs/proto/plan-board.html`) settled
 * live in here, each with its own test:
 *
 *   1. **Rank belongs to the column, not to the plan** — {@link rankOf} is keyed
 *      by column, so a card that changes column has no rank in the new one.
 *   2. **The rank badge is hidden under other sorts** ({@link showRankUi}). A
 *      "#3" on the card sitting fifth because the column is sorted by age is a
 *      number that contradicts what the reader can see.
 *   3. **Ranking degrades** ({@link sortCards} under `"rank"`): hand-ranked
 *      cards hold the top of the column in placed order, everything untouched
 *      falls in behind them on priority then age. That is what makes ranking
 *      usable on a 49-card column — rank the six that matter, let the rest sort
 *      themselves.
 *   4. **One drop must not pin 49 cards** ({@link dropIntoColumn}): dropping on
 *      empty column space appends to the order only if that column is ALREADY
 *      ranked. PR 2 ships no drag — the rule is tested here so it cannot
 *      regress under the PR that wires one.
 */

import type { PlanPriority, PlanStatus } from "./constants.ts";

// ---------------------------------------------------------------- columns

/** A board column. Five of the six are a `plan_status`; `followups` is the
 *  cross-cut (shipped ∧ `followups: open`) that the plan slice asks for, and
 *  `shipped` collects the three terminal states. */
export type BoardColumnKey =
  | "proposed"
  | "ready"
  | "in-flight"
  | "blocked"
  | "followups"
  | "shipped";

/** Which scope first shows a column. `active` columns are in every scope. */
export type BoardScope = "active" | "followups" | "all";

export type BoardSort = "rank" | "age" | "priority" | "cost";

export interface BoardColumnMeta {
  key: BoardColumnKey;
  label: string;
  /** The narrowest scope this column appears in. */
  scope: BoardScope;
  /** mimir's own legend for the status, verbatim — the board must not invent a
   *  second definition of a state the wiki already defines. */
  hint: string;
  /** CSS custom property carrying the column's tint. */
  tone: string;
}

export const BOARD_COLUMNS: readonly BoardColumnMeta[] = [
  { key: "proposed", label: "Proposed", scope: "active", tone: "--pb-proposed", hint: "Written; awaiting go/no-go." },
  { key: "ready", label: "Ready", scope: "active", tone: "--pb-ready", hint: "Reviewed / plan-review-looped; safe to dispatch." },
  { key: "in-flight", label: "In flight", scope: "active", tone: "--pb-inflight", hint: "Actively executing." },
  { key: "blocked", label: "Blocked", scope: "active", tone: "--pb-blocked", hint: "Waiting on something external." },
  { key: "followups", label: "Follow-ups open", scope: "followups", tone: "--pb-followups", hint: "Shipped, but the plan still carries followups: open." },
  { key: "shipped", label: "Shipped", scope: "all", tone: "--pb-shipped", hint: "Terminal — shipped, superseded or abandoned." },
] as const;

/** The four columns that count as backlog. Mirrors `QUEUE_COLUMNS`, which is
 *  the same four for the same reason (nobody hand-ranks a terminal state). */
export const ACTIVE_COLUMN_KEYS: readonly BoardColumnKey[] = [
  "proposed",
  "ready",
  "in-flight",
  "blocked",
];

export const BOARD_PRIORITIES: readonly PlanPriority[] = ["p0", "p1", "p2", "p3"];

/** Family label for a plan whose repo could not be named. Server-side value —
 *  the client only ever reads it. */
export const UNKNOWN_FAMILY = "unknown";

export function visibleColumns(scope: BoardScope): BoardColumnMeta[] {
  if (scope === "active") return BOARD_COLUMNS.filter((c) => c.scope === "active");
  if (scope === "followups") return BOARD_COLUMNS.filter((c) => c.scope !== "all");
  return [...BOARD_COLUMNS];
}

/** The column a plan belongs in. `followups` beats `shipped`, and the three
 *  terminal states share one column. A status the enum does not know (or none
 *  at all) files under Proposed rather than vanishing off the board. */
export function columnForStatus(
  status: PlanStatus | string | null | undefined,
  followupsOpen: boolean,
): BoardColumnKey {
  if (status === "shipped" && followupsOpen) return "followups";
  if (status === "shipped" || status === "superseded" || status === "abandoned") return "shipped";
  if (status === "ready" || status === "in-flight" || status === "blocked") return status;
  return "proposed";
}

/** True for the columns whose cards carry actuals rather than an estimate. */
export function isTerminalColumn(column: BoardColumnKey): boolean {
  return column === "shipped" || column === "followups";
}

// ---------------------------------------------------------------- card shape

export interface BoardEstimate {
  low: number | null;
  mid: number | null;
  high: number | null;
  prCount: number;
  /** The count is the pool's median, not the plan's own declaration. */
  assumedCount: boolean;
  pool: "family" | "global" | "none";
  poolKey: string;
  sampleSize: number;
  dollarsPerPR: { p25: number; p50: number; p75: number } | null;
}

export interface BoardPr {
  number: number | null;
  url: string | null;
  repo: string | null;
  mergedAt: string | null;
  reviewed: boolean | null;
  findings: number | null;
  rounds: number | null;
  subject: string | null;
}

/** What the ledger RECORDED, as opposed to what the estimate predicts. */
export interface BoardLedgerFacts {
  costUSD: number | null;
  landed: number | null;
  merges: number | null;
  activeHours: number | null;
  findings: number | null;
  maxRounds: number | null;
  handovers: number | null;
  sessions: number | null;
  prs: BoardPr[];
}

export interface BoardCard {
  slug: string;
  title: string;
  /** The ledger's one-line description, when it has one. */
  description: string | null;
  statusNote: string | null;
  /** The frontmatter value, verbatim — `null` when the file carried one the
   *  enum does not know (the card still renders, under Proposed). */
  planStatus: PlanStatus | null;
  column: BoardColumnKey;
  statusDate: string | null;
  /** Days since `status_date`. Null for an undated plan — never a fabricated
   *  age off the file's mtime, which is an edit, not a status change. */
  ageDays: number | null;
  /** Mtime, epoch ms. The tie-breaker among undated plans, nothing else. */
  mtimeMs: number;
  /** The priority ON DISK. The overlay never overwrites this — see
   *  {@link applyOverlay}. */
  priority: PlanPriority | null;
  tags: string[];
  relPath: string;
  hash: string;
  followupsOpen: boolean;
  /** Reader link for the plan page. */
  wikiUrl: string;
  /** Repo family, `"unknown"` when it could not be named. */
  family: string;
  familySource: "prs" | "slug" | null;
  familyConfident: boolean;
  mixedRepos: boolean;
  estimate: BoardEstimate | null;
  ledger: BoardLedgerFacts | null;
}

// ---------------------------------------------------------------- overlay

/** The PR-2-only draft layer. Priorities and orders have nowhere to go yet
 *  (PR 4 owns the write path), so they live in `localStorage` — and they are a
 *  DRAFT, not a cache: disk wins on every load. */
export interface BoardOverlay {
  priority: Partial<Record<string, PlanPriority>>;
  order: Partial<Record<BoardColumnKey, string[]>>;
}

export const EMPTY_OVERLAY: BoardOverlay = { priority: {}, order: {} };

export interface EffectiveCard extends BoardCard {
  /** What the card renders. Disk value when there is one. */
  effectivePriority: PlanPriority | null;
  /** True when the rendered priority came from the overlay — the UI says
   *  "draft, not saved to mimir yet" next to it. */
  priorityIsDraft: boolean;
}

export type BoardOrder = Partial<Record<BoardColumnKey, string[]>>;

export interface OverlayResult {
  cards: EffectiveCard[];
  order: BoardOrder;
  /** Per column: the order shown is the overlay's, not the wiki's. */
  orderIsDraft: Partial<Record<BoardColumnKey, boolean>>;
}

/**
 * Merge the draft overlay under the payload. **Disk wins, per field.**
 *
 * A priority set in the browser applies only to a plan whose frontmatter
 * carries none; a hand order applies only to a column `queue.yaml` does not
 * rank. The alternative — overlay wins — is how a priority someone actually
 * committed to mimir silently disappears behind a months-old draft, and PR 5
 * clears the overlay once the server is authoritative.
 *
 * Overlay orders are filtered to slugs that are actually in that column now, so
 * a stale draft cannot rank a card that has since moved or been deleted.
 */
export function applyOverlay(
  cards: readonly BoardCard[],
  diskOrder: BoardOrder,
  overlay: BoardOverlay = EMPTY_OVERLAY,
): OverlayResult {
  const priorities = overlay.priority ?? {};
  const effective: EffectiveCard[] = cards.map((card) => {
    const draft = card.priority === null ? priorities[card.slug] ?? null : null;
    return {
      ...card,
      effectivePriority: card.priority ?? draft,
      priorityIsDraft: card.priority === null && draft !== null,
    };
  });

  const order: BoardOrder = {};
  const orderIsDraft: Partial<Record<BoardColumnKey, boolean>> = {};
  for (const meta of BOARD_COLUMNS) {
    const onDisk = diskOrder[meta.key];
    if (onDisk && onDisk.length > 0) {
      order[meta.key] = [...onDisk];
      orderIsDraft[meta.key] = false;
      continue;
    }
    const drafted = overlay.order?.[meta.key];
    if (!drafted || drafted.length === 0) continue;
    const inColumn = new Set(effective.filter((c) => c.column === meta.key).map((c) => c.slug));
    const kept = drafted.filter((slug) => inColumn.has(slug));
    if (kept.length === 0) continue;
    order[meta.key] = kept;
    orderIsDraft[meta.key] = true;
  }
  return { cards: effective, order, orderIsDraft };
}

// ---------------------------------------------------------------- ranking

/** Manual position of a plan inside ITS OWN column, or -1 when unranked. The
 *  column is part of the question: an order for another column says nothing
 *  about this card. */
export function rankOf(order: BoardOrder, column: BoardColumnKey, slug: string): number {
  const list = order[column];
  if (!list) return -1;
  return list.indexOf(slug);
}

/** Rank badges and the ▲▼ nudges are live only under "My order". */
export function showRankUi(sort: BoardSort): boolean {
  return sort === "rank";
}

/**
 * Move one slug up (-1) or down (+1) inside the order it is displayed in.
 * Returns the new full list, or null when the move is impossible (the card is
 * at the edge, or not in the list).
 *
 * `displayed` is the FULL column in the order the board is currently showing —
 * never the filtered view. A rank stored while a repo filter was on would drop
 * every plan the filter hid, and the next unfiltered render would read as a
 * reshuffle nobody asked for.
 */
export function nudgeOrder(
  displayed: readonly string[],
  slug: string,
  delta: -1 | 1,
): string[] | null {
  const i = displayed.indexOf(slug);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= displayed.length) return null;
  const next = [...displayed];
  next[i] = next[j]!;
  next[j] = slug;
  return next;
}

/**
 * Place `slug` into a column's order at `beforeSlug`'s position (or last when
 * null) — the drop.
 *
 * **`current === undefined` means the column is not hand-ranked**, and a drop on
 * empty column space then returns undefined: it must not pin the other 48 cards
 * into a manual order nobody asked for. A drop ON a card is a statement about
 * position, so it passes the order it wants (the displayed list) as `current`.
 */
export function dropIntoColumn(
  current: readonly string[] | undefined,
  slug: string,
  beforeSlug: string | null,
): string[] | undefined {
  if (!current) return undefined;
  const list = current.filter((s) => s !== slug);
  const at = beforeSlug ? list.indexOf(beforeSlug) : -1;
  list.splice(at < 0 ? list.length : at, 0, slug);
  return list;
}

// ---------------------------------------------------------------- sorting

function priorityRank(p: PlanPriority | null): number {
  const i = p ? BOARD_PRIORITIES.indexOf(p) : -1;
  // Unset sorts LAST, not first: "no opinion" is not "urgent".
  return i < 0 ? BOARD_PRIORITIES.length : i;
}

/**
 * Age comparator. Older `status_date` first; **undated plans sort LAST**,
 * ordered among themselves by mtime (oldest first) as a tie-breaker only. An
 * undated plan renders "no date" — the board never fabricates an age from the
 * file's mtime, which records an edit, not a status change.
 */
function byAge(a: EffectiveCard, b: EffectiveCard): number {
  const ad = a.statusDate;
  const bd = b.statusDate;
  if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
  if (ad) return -1;
  if (bd) return 1;
  return a.mtimeMs - b.mtimeMs;
}

function byPriorityThenAge(a: EffectiveCard, b: EffectiveCard): number {
  return priorityRank(a.effectivePriority) - priorityRank(b.effectivePriority) || byAge(a, b);
}

/** Cost of a card for the "Cost" sort: the estimate's midpoint. Unpriced last. */
function costOf(card: EffectiveCard): number | null {
  return card.estimate?.mid ?? null;
}

/**
 * Sort one column's cards.
 *
 * Under `"rank"` the degrade rule applies: hand-ranked cards hold the top in
 * placed order, everything untouched falls in behind them on priority (p0
 * first, unset last), then age. Slug is the final tie-break everywhere so the
 * order is stable across renders.
 */
export function sortCards(
  cards: readonly EffectiveCard[],
  sort: BoardSort,
  order: readonly string[] = [],
): EffectiveCard[] {
  const copy = [...cards];
  const bySlug = (a: EffectiveCard, b: EffectiveCard) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  if (sort === "rank") {
    const at = (c: EffectiveCard) => {
      const i = order.indexOf(c.slug);
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    };
    copy.sort((a, b) => at(a) - at(b) || byPriorityThenAge(a, b) || bySlug(a, b));
  } else if (sort === "priority") {
    copy.sort((a, b) => byPriorityThenAge(a, b) || bySlug(a, b));
  } else if (sort === "age") {
    copy.sort((a, b) => byAge(a, b) || bySlug(a, b));
  } else {
    copy.sort((a, b) => {
      const av = costOf(a);
      const bv = costOf(b);
      if (av === null && bv === null) return bySlug(a, b);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av || bySlug(a, b);
    });
  }
  return copy;
}

// ---------------------------------------------------------------- filtering

export interface BoardFilters {
  /** Empty ⇒ every family. */
  families: readonly string[];
  /** `"unset"` selects the cards with no priority at all. */
  priority: PlanPriority | "unset" | null;
  /** Free text over title, slug and tags. */
  query: string;
}

export const EMPTY_FILTERS: BoardFilters = { families: [], priority: null, query: "" };

export function cardMatches(card: EffectiveCard, filters: BoardFilters): boolean {
  if (filters.families.length > 0 && !filters.families.includes(card.family)) return false;
  if (filters.priority === "unset") {
    if (card.effectivePriority !== null) return false;
  } else if (filters.priority && card.effectivePriority !== filters.priority) {
    return false;
  }
  const q = filters.query.trim().toLowerCase();
  if (q) {
    const hay = `${card.slug} ${card.title} ${card.tags.join(" ")}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterCards(
  cards: readonly EffectiveCard[],
  filters: BoardFilters,
): EffectiveCard[] {
  return cards.filter((c) => cardMatches(c, filters));
}

/** Families present in the corpus, most-used first — the repo filter's chips. */
export function familyCounts(cards: readonly BoardCard[]): Array<{ family: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || (a.family < b.family ? -1 : 1));
}

// ---------------------------------------------------------------- meters

export interface BacklogMeter {
  count: number;
  /** The cards the sum is over — so the tile and the board can be compared
   *  slug for slug rather than trusted. */
  slugs: string[];
  low: number;
  mid: number;
  high: number;
}

export interface BoardMeters {
  totalCount: number;
  activeCount: number;
  inFlightCount: number;
  followupsCount: number;
  /** Median age of the active cards that HAVE a `status_date`; null when none
   *  do (the corpus's active plans very often carry no date at all). */
  medianAgeDays: number | null;
  /** Null when the money is hidden — see `BoardPayload.money`. */
  backlog: BacklogMeter | null;
  /** Sum of ledger cost over the terminal columns. Null when money is hidden. */
  spentToDate: number | null;
  /** Sum of ledger cost already spent on ACTIVE plans. Null when hidden. */
  spentOnActive: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * The meter strip, computed from the very cards the board is showing.
 *
 * The "Backlog, priced" tile sums `estimate.mid` over the ACTIVE cards that
 * carry an estimate, and names them in `slugs`. Both ends call this — the
 * server for the payload, the browser after every filter change — so the tile
 * and the cards cannot drift apart.
 */
export function computeMeters(
  cards: readonly BoardCard[],
  moneyAvailable: boolean,
): BoardMeters {
  const active = cards.filter((c) => ACTIVE_COLUMN_KEYS.includes(c.column));
  const ages = active.map((c) => c.ageDays).filter((a): a is number => a !== null);

  let backlog: BacklogMeter | null = null;
  let spentToDate: number | null = null;
  let spentOnActive: number | null = null;
  if (moneyAvailable) {
    const priced = active.filter((c) => c.estimate?.mid != null);
    backlog = {
      count: priced.length,
      slugs: priced.map((c) => c.slug),
      low: priced.reduce((s, c) => s + (c.estimate!.low ?? 0), 0),
      mid: priced.reduce((s, c) => s + (c.estimate!.mid ?? 0), 0),
      high: priced.reduce((s, c) => s + (c.estimate!.high ?? 0), 0),
    };
    spentToDate = cards
      .filter((c) => isTerminalColumn(c.column))
      .reduce((s, c) => s + (c.ledger?.costUSD ?? 0), 0);
    spentOnActive = active.reduce((s, c) => s + (c.ledger?.costUSD ?? 0), 0);
  }

  return {
    totalCount: cards.length,
    activeCount: active.length,
    inFlightCount: cards.filter((c) => c.column === "in-flight").length,
    followupsCount: cards.filter((c) => c.column === "followups").length,
    medianAgeDays: median(ages),
    backlog,
    spentToDate,
    spentOnActive,
  };
}

// ---------------------------------------------------------------- formatting

/** `$1.2k` over a thousand, `$340` under. Shared so the tile, the column header
 *  and the card all round the same way. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${Math.round(value)}`;
}

/** `33 d`, or "no date" — never an age invented from the file's mtime. */
export function formatAge(days: number | null): string {
  return days === null ? "no date" : `${days} d`;
}

/** Whole days between an ISO date and `now`, or null for an undated plan. */
export function ageInDays(statusDate: string | null | undefined, now: number): number | null {
  if (!statusDate) return null;
  const t = Date.parse(`${statusDate}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 86_400_000));
}
