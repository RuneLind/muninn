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
 *   4. **One action must not pin 49 cards.** A column's hand order is a ranked
 *      PREFIX, never a full permutation: {@link nudgeRanked} appends an
 *      unranked card to the bottom of that prefix, swaps a ranked one with its
 *      ranked neighbour, and UN-ranks the last one on ▼ — so ranking six cards
 *      leaves the other 43 out of the order entirely. {@link dropIntoColumn}
 *      follows the same rule, and is still unwired: the board has no drag, since
 *      dragging between columns means a `plan_status` change and no endpoint
 *      writes one.
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

/**
 * The cards a scope actually RENDERS — the ones in {@link visibleColumns}.
 *
 * The meter strip counts through this rather than over every filtered card,
 * because a tile counting cards no column on screen shows is a number the
 * reader cannot check: under `active`, "Active plans 41 of 186" counted the
 * whole corpus as the denominator while four columns held 41 cards.
 */
export function cardsInScope<T extends { column: BoardColumnKey }>(
  cards: readonly T[],
  scope: BoardScope,
): T[] {
  const keys = new Set(visibleColumns(scope).map((c) => c.key));
  return cards.filter((c) => keys.has(c.column));
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

/** The draft layer, now reached only where the board cannot write — a
 *  `MUNINN_WIKI_READONLY` instance, or an unreadable `queue.yaml`
 *  (`board-writes.ts`, `writeCapability`). It lives in `localStorage` and it is
 *  a DRAFT, not a cache: disk wins on every load, and a board whose server owns
 *  both axes clears the key outright. */
export interface BoardOverlay {
  priority: Partial<Record<string, PlanPriority>>;
  order: Partial<Record<BoardColumnKey, string[]>>;
}

/** Frozen: it is the shared default argument of {@link applyOverlay}, so a
 *  caller that mutated it would silently give every later board a draft. */
export const EMPTY_OVERLAY: BoardOverlay = Object.freeze({
  priority: Object.freeze({}),
  order: Object.freeze({}),
}) as BoardOverlay;

/**
 * Take a `localStorage` blob apart into a draft we are willing to act on.
 *
 * The overlay is written by an older build of this page, by hand, or by a
 * half-finished write — so every value is checked rather than cast: a priority
 * outside {@link BOARD_PRIORITIES} would render a pill with no colour and sort
 * under a rank the comparator does not know, and a non-string in an order list
 * would sit in the ranked prefix forever, matching no card and offsetting every
 * badge below it.
 */
export function sanitizeOverlay(raw: unknown): BoardOverlay {
  const out: BoardOverlay = { priority: {}, order: {} };
  if (!raw || typeof raw !== "object") return out;
  const src = raw as { priority?: unknown; order?: unknown };

  if (src.priority && typeof src.priority === "object") {
    for (const [slug, value] of Object.entries(src.priority as Record<string, unknown>)) {
      if (typeof value === "string" && (BOARD_PRIORITIES as readonly string[]).includes(value)) {
        out.priority[slug] = value as PlanPriority;
      }
    }
  }

  if (src.order && typeof src.order === "object") {
    const known = new Set<string>(BOARD_COLUMNS.map((c) => c.key));
    for (const [key, value] of Object.entries(src.order as Record<string, unknown>)) {
      if (!known.has(key) || !Array.isArray(value)) continue;
      const slugs = value.filter((s): s is string => typeof s === "string");
      if (slugs.length > 0) out.order[key as BoardColumnKey] = slugs;
    }
  }
  return out;
}

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
  /** Columns `queue.yaml` ranks. In DRAFT mode their ▲▼ are disabled — a draft
   *  that silently loses on the next load is worse than an honest refusal. A
   *  writing board nudges them like any other column. */
  diskRanked: BoardColumnKey[];
  /** Draft orders this merge threw away entirely — the disk took the column
   *  over, or not one of the draft's slugs is in it any more. The client
   *  purges these from the stored overlay so a dead draft cannot come back
   *  the day the disk order is removed. */
  staleDraftColumns: BoardColumnKey[];
}

/**
 * Merge the draft overlay under the payload. **Disk wins, per field.**
 *
 * A priority set in the browser applies only to a plan whose frontmatter
 * carries none; a hand order applies only to a column `queue.yaml` does not
 * rank. The alternative — overlay wins — is how a priority someone actually
 * committed to mimir silently disappears behind a months-old draft — and where
 * the server IS authoritative the client clears the overlay outright rather
 * than merging it.
 *
 * **Both** orders are filtered to slugs that are actually in that column now.
 * The draft, because a card that moved or was deleted must not hold a rank —
 * and the DISK order for the same reason: `queue.yaml` lists a slug until
 * someone edits it, so a plan promoted from proposed to ready goes on holding
 * position #1 in proposed and pushes every real card's badge down by one.
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
  const diskRanked: BoardColumnKey[] = [];
  const staleDraftColumns: BoardColumnKey[] = [];
  for (const meta of BOARD_COLUMNS) {
    const inColumn = new Set(effective.filter((c) => c.column === meta.key).map((c) => c.slug));
    const drafted = overlay.order?.[meta.key];
    const onDisk = diskOrder[meta.key];
    if (onDisk && onDisk.length > 0) {
      diskRanked.push(meta.key);
      order[meta.key] = onDisk.filter((slug) => inColumn.has(slug));
      orderIsDraft[meta.key] = false;
      // The column is spoken for; the draft under it is dead weight.
      if (drafted && drafted.length > 0) staleDraftColumns.push(meta.key);
      continue;
    }
    if (!drafted || drafted.length === 0) continue;
    const kept = drafted.filter((slug) => inColumn.has(slug));
    if (kept.length === 0) {
      staleDraftColumns.push(meta.key);
      continue;
    }
    order[meta.key] = kept;
    orderIsDraft[meta.key] = true;
  }
  return { cards: effective, order, orderIsDraft, diskRanked, staleDraftColumns };
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
 * Rank a card by hand, inside the column's RANKED LIST — never the displayed
 * column, and never the filtered view.
 *
 * The list is a prefix: only the cards someone actually ranked are in it, and
 * everything else degrades on priority-then-age behind them. So there are four
 * moves, not two:
 *
 *   - **▲ on an unranked card** — it JOINS the ranked list, at the bottom. This
 *     is the affordance that makes ranking usable on a 49-card column: one
 *     action ranks one card and leaves the other 48 unranked.
 *   - **▲ on a ranked card** — swap with the previous ranked card. Refused at
 *     #1.
 *   - **▼ on a ranked card** — swap with the next ranked card; on the LAST one
 *     it drops out of the list, i.e. "never mind, don't rank this".
 *   - **▼ on an unranked card** — refused. There is no rank to lower.
 *
 * Because the moves are stated against the ranked list rather than against
 * what is on screen, a repo filter or a search cannot change what a nudge
 * does: hidden neighbours are irrelevant when every position is explicit.
 *
 * Returns the new ranked list, or null when the move is refused —
 * {@link canNudge} answers the same question for the button's disabled state.
 */
export function nudgeRanked(
  ranked: readonly string[],
  slug: string,
  delta: -1 | 1,
): string[] | null {
  const i = ranked.indexOf(slug);
  if (i < 0) return delta === -1 ? [...ranked, slug] : null;
  if (delta === -1) {
    if (i === 0) return null;
    const next = [...ranked];
    next[i] = next[i - 1]!;
    next[i - 1] = slug;
    return next;
  }
  if (i === ranked.length - 1) return ranked.filter((s) => s !== slug);
  const next = [...ranked];
  next[i] = next[i + 1]!;
  next[i + 1] = slug;
  return next;
}

/** Whether {@link nudgeRanked} would do anything — the ▲▼ disabled state, so
 *  the button and the action cannot disagree about what is possible. */
export function canNudge(ranked: readonly string[], slug: string, delta: -1 | 1): boolean {
  const i = ranked.indexOf(slug);
  return delta === -1 ? i !== 0 : i >= 0;
}

/**
 * Place `slug` into a column's order at `beforeSlug`'s position (or last when
 * null) — the drop.
 *
 * **An absent OR empty `current` means the column is not hand-ranked**, and a
 * drop on empty column space then returns undefined: it must not pin the other
 * 48 cards into a manual order nobody asked for. The empty case is not
 * theoretical — un-ranking the last ranked card with ▼ leaves exactly `[]`. A
 * drop ON a card is a statement about position, so it passes the order it wants
 * (the displayed list) as `current`.
 */
export function dropIntoColumn(
  current: readonly string[] | undefined,
  slug: string,
  beforeSlug: string | null,
): string[] | undefined {
  if (!current || current.length === 0) return undefined;
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

/**
 * Cost of a card for the "Cost" sort — **the number the card itself shows**:
 * recorded spend in a terminal column, the estimate's midpoint everywhere else,
 * exactly as the column header sums them. Sorting a shipped column on its
 * estimate would order it by a figure nothing on screen displays. Unpriced
 * (and non-finite) sorts last.
 */
function costOf(card: EffectiveCard): number | null {
  const v = isTerminalColumn(card.column) ? card.ledger?.costUSD : card.estimate?.mid;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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
    // Spelled out rather than leaning on ∞ − ∞ = NaN (which sorts as "equal"
    // only by accident): ranked cards hold the top in placed order, unranked
    // ones degrade behind them.
    copy.sort((a, b) => {
      const ai = order.indexOf(a.slug);
      const bi = order.indexOf(b.slug);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return byPriorityThenAge(a, b) || bySlug(a, b);
    });
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

// ---------------------------------------------------------------- view state

/** Everything about the board that is a VIEW decision — the part worth having
 *  in the URL, so a filtered board can be linked to and survives a reload. */
export interface BoardViewState {
  scope: BoardScope;
  sort: BoardSort;
  filters: BoardFilters;
}

export const DEFAULT_VIEW: BoardViewState = {
  scope: "active",
  sort: "rank",
  filters: EMPTY_FILTERS,
};

/** The view as a query string (`""` when it is the default — a URL nobody
 *  changed should stay clean). Only non-defaults are written. */
export function viewStateToQuery(view: BoardViewState): string {
  const p = new URLSearchParams();
  if (view.scope !== DEFAULT_VIEW.scope) p.set("scope", view.scope);
  if (view.sort !== DEFAULT_VIEW.sort) p.set("sort", view.sort);
  if (view.filters.families.length > 0) p.set("repo", view.filters.families.join(","));
  if (view.filters.priority) p.set("pri", view.filters.priority);
  const q = view.filters.query.trim();
  if (q) p.set("q", q);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Read a view back out of a query string, dropping anything it does not
 *  recognise. A hand-edited `?sort=cheapest` must land on the default, never on
 *  a sort the comparator has no branch for. */
export function viewStateFromQuery(search: string): BoardViewState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const scope = p.get("scope");
  const sort = p.get("sort");
  const pri = p.get("pri");
  const scopes: readonly string[] = ["active", "followups", "all"];
  const sorts: readonly string[] = ["rank", "age", "priority", "cost"];
  const prios: readonly string[] = [...BOARD_PRIORITIES, "unset"];
  return {
    scope: scope && scopes.includes(scope) ? (scope as BoardScope) : DEFAULT_VIEW.scope,
    sort: sort && sorts.includes(sort) ? (sort as BoardSort) : DEFAULT_VIEW.sort,
    filters: {
      families: (p.get("repo") ?? "").split(",").map((f) => f.trim()).filter(Boolean),
      priority: pri && prios.includes(pri) ? (pri as PlanPriority | "unset") : null,
      // Trimmed on the way IN as well as out: `viewStateToQuery` writes the
      // trimmed query, so an untrimmed `?q=` can only be hand-typed — and it
      // would seed a search box whose value no longer matches the URL that
      // produced it.
      query: (p.get("q") ?? "").trim(),
    },
  };
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
  // `Number.isFinite`, not `!== null`, everywhere a number is summed or sorted:
  // one NaN reaching a `reduce` turns the whole tile into "NaN" and takes the
  // agreement between the tile and the cards with it.
  const fin = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const ages = active.map((c) => fin(c.ageDays)).filter((a): a is number => a !== null);

  let backlog: BacklogMeter | null = null;
  let spentToDate: number | null = null;
  let spentOnActive: number | null = null;
  if (moneyAvailable) {
    const priced = active.filter((c) => fin(c.estimate?.mid) !== null);
    const sum = (list: readonly BoardCard[], pick: (c: BoardCard) => number | null | undefined) =>
      list.reduce((s, c) => s + (fin(pick(c)) ?? 0), 0);
    backlog = {
      count: priced.length,
      slugs: priced.map((c) => c.slug),
      low: sum(priced, (c) => c.estimate?.low),
      mid: sum(priced, (c) => c.estimate?.mid),
      high: sum(priced, (c) => c.estimate?.high),
    };
    spentToDate = sum(cards.filter((c) => isTerminalColumn(c.column)), (c) => c.ledger?.costUSD);
    spentOnActive = sum(active, (c) => c.ledger?.costUSD);
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

/** Whole days ELAPSED between an ISO date and `now`, or null for an undated
 *  plan. Floored, not rounded: a plan dated 16½ days ago is 16 days old, and
 *  one dated today is 0 until the day actually turns. Rounding made every
 *  afternoon read as a day nobody had lived through yet. */
export function ageInDays(statusDate: string | null | undefined, now: number): number | null {
  if (!statusDate) return null;
  const t = Date.parse(`${statusDate}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}
