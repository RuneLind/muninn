/**
 * The `/plans` board's WRITE rules — everything a priority click or a ▲▼ nudge
 * decides before a DOM node or a `fetch` is involved.
 *
 * Same split as `board-client-pure.ts`, and for the same reason: what an edit
 * MEANS is tested here with no browser, and `plan-board.ts` only wires the
 * result into elements and requests. **This module imports nothing but
 * constants and types** — it is bundled into the page.
 *
 * Four rules live here, each of which went wrong in an obvious way first:
 *
 *   1. **There are three write modes, not two.** `MUNINN_WIKI_READONLY` and an
 *      unreadable `queue.yaml` are different refusals: the readonly instance
 *      keeps the localStorage DRAFT (the overlay is all a reader there has),
 *      while a queue that exists but cannot be read disables ranking outright —
 *      drafting over it would promise a write the server refuses on purpose
 *      (`src/plans/write.ts` treats `hash === null` as "there is no base").
 *   2. **The draft is retired only when the server owns BOTH axes.** Keeping it
 *      alongside real writes is how a months-old draft priority shadows the one
 *      that was just committed to mimir.
 *   3. **Only the four active columns are rankable.** `queue.yaml`'s grammar has
 *      no key for `shipped`/`followups`, so a nudge there could only ever 400 —
 *      the pre-write board happily drafted one.
 *   4. **A 200 body is parsed, never cast.** Both endpoints answer with the hash
 *      the NEXT edit must present as its CAS base; a hash read off an unchecked
 *      shape arms every later edit on that card to 409 with nothing on screen
 *      saying why.
 */

import { PLAN_PRIORITIES, type PlanPriority } from "./constants.ts";
import { ACTIVE_COLUMN_KEYS, type BoardColumnKey, type BoardOrder } from "./board-client-pure.ts";

// ---------------------------------------------------------------- copy

/** Pinned against `WIKI_READONLY_ENV` (`src/wiki/readonly.ts`) by a test —
 *  importing it would drag `config.ts` into the browser bundle. */
export const PLAN_READONLY_ENV = "MUNINN_WIKI_READONLY";

/** The banner. Mirrors the `/models` Machine card's sentence — same flag, same
 *  "git commits are still allowed" carve-out — with this board's two writes
 *  named in place of the gardener's. */
export const PLAN_READONLY_NOTE =
  `${PLAN_READONLY_ENV}=1 — this muninn instance does not write wiki pages, so priority and ` +
  `hand-order edits are refused here (the controls stay visible, disabled); git commits are still allowed. ` +
  `Anything you set is a draft in this browser, and mimir wins on every load.`;

/** The short form, for a control's `title`. */
export const PLAN_READONLY_SHORT = `${PLAN_READONLY_ENV}=1 — this instance cannot write mimir`;

export const QUEUE_UNREADABLE_REASON =
  "plans/queue.yaml exists but could not be read — ranking is disabled until it can be, " +
  "because writing without a base hash would clobber an order that is still on disk";

export const NUDGE_OFF_SORT = "Switch Sort to “My order” to rank by hand";
export const NUDGE_TERMINAL_COLUMN = "queue.yaml ranks only the active columns — nothing terminal is hand-ordered";
export const NUDGE_SAVING = "saving the previous move…";

/** The two 409 sentences. Per surface: a reader who just clicked a priority is
 *  not being told about a queue file they never touched. */
export const PRIORITY_STALE_MESSAGE = "this plan changed on disk — reload";
export const ORDER_STALE_MESSAGE = "the queue changed on disk — reload";

// ---------------------------------------------------------------- capability

export type OrderMode = "write" | "draft" | "off";
export type PriorityMode = "write" | "draft";

export interface WriteCapability {
  /** `write` ⇒ POST `/api/plans/order`; `draft` ⇒ the localStorage overlay;
   *  `off` ⇒ the ▲▼ are disabled and say why. */
  orderMode: OrderMode;
  priorityMode: PriorityMode;
  /** Drop `muninn.planboard.draft.v1` and stop writing it — see rule 2. */
  retireDraft: boolean;
  /** Set only when `orderMode === "off"`. */
  orderOffReason: string | null;
  readonly: boolean;
}

export function writeCapability(input: {
  readonly: boolean;
  /** `""` = queue.yaml is absent (the bootstrap base) · `null` = unreadable. */
  queueHash: string | null;
}): WriteCapability {
  if (input.readonly) {
    return {
      orderMode: "draft",
      priorityMode: "draft",
      retireDraft: false,
      orderOffReason: null,
      readonly: true,
    };
  }
  const orderWritable = input.queueHash !== null;
  return {
    orderMode: orderWritable ? "write" : "off",
    priorityMode: "write",
    // The priority axis alone is not enough: an order draft that can never be
    // saved is still the only ranking a reader on this board has.
    retireDraft: orderWritable,
    orderOffReason: orderWritable ? null : QUEUE_UNREADABLE_REASON,
    readonly: false,
  };
}

/** `queue.yaml` has a key for the four active columns and nothing else. */
export function isRankableColumn(column: BoardColumnKey): boolean {
  return (ACTIVE_COLUMN_KEYS as readonly string[]).includes(column);
}

// ---------------------------------------------------------------- gates

export interface NudgeGate {
  rankUi: boolean;
  column: BoardColumnKey;
  capability: WriteCapability;
  /** `queue.yaml` ranks this column. Only meaningful in draft mode, where the
   *  overlay may not overwrite a disk order. */
  diskRanked: boolean;
  /** An order write is in flight. */
  busy: boolean;
}

/** Null ⇒ the ▲▼ may act. Otherwise the sentence its tooltip carries. The
 *  buttons are always RENDERED — a control that vanishes reads as a board that
 *  lost the ability to rank. */
export function nudgeBlockedReason(gate: NudgeGate): string | null {
  if (!gate.rankUi) return NUDGE_OFF_SORT;
  if (!isRankableColumn(gate.column)) return NUDGE_TERMINAL_COLUMN;
  const mode = gate.capability.orderMode;
  if (mode === "off") return gate.capability.orderOffReason ?? QUEUE_UNREADABLE_REASON;
  if (mode === "write") return gate.busy ? NUDGE_SAVING : null;
  // Draft mode (readonly instance): the overlay never overwrites a column the
  // wiki already ranks — that draft would lose silently on the next load.
  return gate.diskRanked
    ? `ranked in mimir's queue.yaml — ${PLAN_READONLY_SHORT}, so this column cannot be re-ordered here`
    : null;
}

export interface PriorityControlState {
  disabled: boolean;
  title: string | null;
}

/** The drawer's four priority buttons. `onDisk` is "the frontmatter carries a
 *  priority", which only constrains the DRAFT path — a writing board edits the
 *  frontmatter itself, including clearing it. */
export function priorityControlState(input: {
  mode: PriorityMode;
  onDisk: boolean;
  busy: boolean;
}): PriorityControlState {
  if (input.busy) return { disabled: true, title: "saving…" };
  if (input.mode === "write") return { disabled: false, title: null };
  if (input.onDisk) {
    return {
      disabled: true,
      title: `${PLAN_READONLY_SHORT} — this priority is on disk; edit it in mimir`,
    };
  }
  return { disabled: false, title: null };
}

/**
 * Per-card serialization. A second click while a write is in flight is DROPPED,
 * not queued: the button is disabled, so a click that still arrives is a race,
 * and its POST would carry the pre-write hash and 409 for no reason.
 */
export function admitPriorityEdit(pending: ReadonlySet<string>, slug: string): boolean {
  return !pending.has(slug);
}

// ---------------------------------------------------------------- requests

export interface PriorityRequest {
  slug: string;
  priority: PlanPriority | "clear";
  baseHash: string;
}

/** Clicking the priority a plan already carries CLEARS it — the same toggle the
 *  draft path had, now spelled in the endpoint's one wire form for a clear. */
export function priorityRequest(
  card: { slug: string; priority: PlanPriority | null; hash: string },
  clicked: PlanPriority,
): PriorityRequest {
  return {
    slug: card.slug,
    priority: card.priority === clicked ? "clear" : clicked,
    baseHash: card.hash,
  };
}

export interface OrderRequest {
  order: Partial<Record<BoardColumnKey, string[]>>;
  baseHash: string;
}

/**
 * One column, never the board: `/api/plans/order` MERGES, so a posted column
 * replaces that column and every column left out is preserved from disk. An
 * empty `next` is legal and means "un-rank this column" (▼ off the last ranked
 * card); `null` comes back when there is no base hash to compare against.
 */
export function orderRequest(
  column: BoardColumnKey,
  next: readonly string[],
  baseHash: string | null,
): OrderRequest | null {
  if (baseHash === null || !isRankableColumn(column)) return null;
  return { order: { [column]: [...next] }, baseHash };
}

// ---------------------------------------------------------------- responses

export interface PriorityResult {
  slug: string;
  /** What is ON DISK now — a `noop` echoes the unchanged value. */
  priority: PlanPriority | null;
  hash: string;
  written: boolean;
}

export interface OrderResult {
  /** The full MERGED order on disk — adopt it wholesale, it carries the columns
   *  this request did not post. */
  order: BoardOrder;
  /** `""` when the file was deleted, which is the bootstrap base again. */
  hash: string;
  written: boolean;
  deleted: boolean;
  /** Per-entry drops the merge made durable (a retired slug, a hand-written
   *  comment lost to serialization). Shown, never swallowed. */
  warnings: string[];
}

function record(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function strings(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    out.push(v);
  }
  return out;
}

/** Null ⇒ the body is not the contract; the caller reports a failed write
 *  rather than adopting a hash it cannot use (rule 4). */
export function parsePriorityResult(raw: unknown): PriorityResult | null {
  const body = record(raw);
  if (!body) return null;
  const { slug, hash, priority, written } = body;
  if (typeof slug !== "string" || !slug) return null;
  // A priority write always leaves bytes on disk, so an empty hash is a broken
  // response — unlike the order route, where `""` means "the file is gone".
  if (typeof hash !== "string" || !hash) return null;
  const pri =
    priority === null || priority === undefined
      ? null
      : typeof priority === "string" && (PLAN_PRIORITIES as readonly string[]).includes(priority)
        ? (priority as PlanPriority)
        : undefined;
  if (pri === undefined) return null;
  return { slug, priority: pri, hash, written: written === true };
}

export function parseOrderResult(raw: unknown): OrderResult | null {
  const body = record(raw);
  if (!body) return null;
  if (typeof body.hash !== "string") return null;
  const posted = record(body.order);
  if (!posted) return null;
  const order: BoardOrder = {};
  for (const [key, value] of Object.entries(posted)) {
    if (!(ACTIVE_COLUMN_KEYS as readonly string[]).includes(key)) return null;
    const slugs = strings(value);
    if (!slugs) return null;
    if (slugs.length > 0) order[key as BoardColumnKey] = slugs;
  }
  const warnings = strings(body.warnings) ?? [];
  return {
    order,
    hash: body.hash,
    written: body.written === true,
    deleted: body.deleted === true,
    warnings,
  };
}

/** Fold a 200 into the card list. Returns the same array when the slug is not
 *  on this board (a card retired between the click and the response). */
export function applyPriorityResult<
  T extends { slug: string; priority: PlanPriority | null; hash: string },
>(cards: readonly T[], result: PriorityResult): T[] {
  let hit = false;
  const next = cards.map((card) => {
    if (card.slug !== result.slug) return card;
    hit = true;
    return { ...card, priority: result.priority, hash: result.hash };
  });
  return hit ? next : (cards as T[]);
}

// ---------------------------------------------------------------- failures

export type WriteFailureKind = "stale" | "readonly" | "refused" | "error";

export interface WriteFailure {
  kind: WriteFailureKind;
  message: string;
  /** Offer the Reload affordance — the only honest recovery from a CAS loss. */
  reload: boolean;
}

/**
 * One non-200 into what the surface says.
 *
 * A 409 gets the board's own sentence rather than the server's, because the
 * server names the file (`plans/foo.mdx changed since the board was loaded`)
 * and the reader needs the action. A 422 keeps the server's text verbatim: it
 * is the one status that means a human must go and fix a file by hand.
 */
export function classifyWriteFailure(
  status: number,
  body: unknown,
  surface: "priority" | "order",
): WriteFailure {
  const parsed = record(body);
  const error = typeof parsed?.error === "string" && parsed.error.trim() ? parsed.error.trim() : null;
  if (status === 409) {
    return {
      kind: "stale",
      message: surface === "priority" ? PRIORITY_STALE_MESSAGE : ORDER_STALE_MESSAGE,
      reload: true,
    };
  }
  if (status === 403) {
    return { kind: "readonly", message: error ?? PLAN_READONLY_SHORT, reload: false };
  }
  if (status === 422) {
    return { kind: "refused", message: error ?? "the wiki refused the write", reload: false };
  }
  return { kind: "error", message: error ?? `write failed (HTTP ${status})`, reload: false };
}

/** The fetch itself threw, or the 200 body was not the contract. */
export function transportFailure(reason: string): WriteFailure {
  return { kind: "error", message: reason, reload: false };
}
