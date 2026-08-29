/**
 * The `/plans` board's WRITE rules — everything a priority click or a ▲▼ nudge
 * decides before a DOM node or a `fetch` is involved.
 *
 * Same split as `board-client-pure.ts`, and for the same reason: what an edit
 * MEANS is tested here with no browser, and `plan-board.ts` only wires the
 * result into elements and requests. **This module imports nothing but
 * constants and types** — it is bundled into the page.
 *
 * Six rules live here, each of which went wrong in an obvious way first:
 *
 *   1. **There are three write modes, not two.** `MUNINN_WIKI_READONLY` and an
 *      unreadable `queue.yaml` are different refusals: the readonly instance
 *      keeps the localStorage DRAFT (the overlay is all a reader there has),
 *      while a queue that exists but cannot be read disables ranking outright —
 *      drafting over it would promise a write the server refuses on purpose
 *      (`src/plans/write.ts` treats `hash === null` as "there is no base"). The
 *      two are INDEPENDENT: a readonly instance whose queue is also unreadable
 *      gets the unreadable banner and no order drafting, because `diskRanked`
 *      is empty there and the draft would promise an order nothing can check.
 *   2. **The draft is retired PER AXIS.** Retiring the whole overlay only when
 *      the server owns both axes left a stale draft PRIORITY shadowing the
 *      server-owned priority axis whenever ranking was off — the chip rendered
 *      `p0` off a draft with nothing on disk, and clicking `p0` (the toggle-off
 *      gesture) wrote `p0` to the file with no visible change. Each half is
 *      retired the moment ITS OWN axis is server-owned.
 *   3. **Only the four active columns are rankable.** `queue.yaml`'s grammar has
 *      no key for `shipped`/`followups`, so a nudge there could only ever 400 —
 *      the pre-write board happily drafted one.
 *   4. **A 200 body is parsed, never cast.** Both endpoints answer with the hash
 *      the NEXT edit must present as its CAS base; a hash read off an unchecked
 *      shape arms every later edit on that card to 409 with nothing on screen
 *      saying why. The same discipline covers the REFRESH payload
 *      ({@link parseBoardRefresh}) — a half-adopted board is a board whose
 *      cards and CAS bases disagree.
 *   5. **A write in flight does not disable the controls; a stale board does.**
 *      Disabling every ▲▼ while one order write ran made the serialization
 *      chain dead code (a second click could never arrive), dropped keyboard
 *      focus to `<body>` after every write, and greyed out columns nothing was
 *      writing. What DOES block is a board known to be out of date — a standing
 *      reload-worthy failure, or a refresh in flight.
 *   6. **A refusal that means "this board is stale" offers Reload.** 409 is the
 *      obvious one, but `no plan named "x"` (a retired or renamed plan —
 *      mimir's everyday lifecycle) is a 404 and the priority route's unknown
 *      slug is a 400: both mean the board is describing a corpus that moved.
 *      422 does not — a human has to go and fix a file by hand — and neither
 *      does a transport failure, which says nothing about disk at all.
 */

import { PLAN_PRIORITIES, PLAN_STATUSES, type PlanPriority, type PlanStatus } from "./constants.ts";
import {
  ACTIVE_COLUMN_KEYS,
  BOARD_COLUMNS,
  ageInDays,
  columnForStatus,
  type BoardCard,
  type BoardColumnKey,
  type BoardColumnMeta,
  type BoardOrder,
  type BoardOverlay,
} from "./board-client-pure.ts";

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

/** A write in flight does NOT block a nudge (rule 5) — these two do, because
 *  both mean the base every queued move holds is known to be gone or about to
 *  be replaced. */
export const NUDGE_RELOAD_FIRST =
  "this board is out of date — press Reload before ranking again";
export const NUDGE_RELOADING = "refreshing the board…";

/** What one column says while its own writes are in flight. Per column, because
 *  the reader is entitled to know WHICH ranking is still being saved — and to
 *  keep clicking in the other three meanwhile. */
export const COLUMN_SAVING = "saving…";

/** The two 409 sentences. Per surface: a reader who just clicked a priority is
 *  not being told about a queue file they never touched. A status write edits
 *  the same file a priority write does, so it shares the plan sentence. */
export const PRIORITY_STALE_MESSAGE = "this plan changed on disk — reload";
export const ORDER_STALE_MESSAGE = "the queue changed on disk — reload";

/** The archive control's two targets, and the way back. `abandoned` is the
 *  closest thing the lifecycle has to delete — the FILE stays in mimir, the
 *  card leaves the active board. */
export const ARCHIVE_TARGETS: readonly PlanStatus[] = ["superseded", "abandoned"];
export const RESTORE_TARGET: PlanStatus = "proposed";

/** Why the archive buttons are disabled on a readonly instance: unlike a
 *  priority there is NO draft fallback — a status draft would show a card in a
 *  column mimir contradicts on every load. */
export const ARCHIVE_READONLY_TITLE = `${PLAN_READONLY_SHORT} — edit plan_status in mimir`;

// ---------------------------------------------------------------- capability

export type OrderMode = "write" | "draft" | "off";
export type PriorityMode = "write" | "draft";

export interface WriteCapability {
  /** `write` ⇒ POST `/api/plans/order`; `draft` ⇒ the localStorage overlay;
   *  `off` ⇒ the ▲▼ are disabled and say why. */
  orderMode: OrderMode;
  priorityMode: PriorityMode;
  /** Drop the draft's PRIORITY half and stop writing it — see rule 2. */
  retirePriorityDraft: boolean;
  /** Drop the draft's ORDER half and stop writing it. */
  retireOrderDraft: boolean;
  /** Set only when `orderMode === "off"`. */
  orderOffReason: string | null;
  readonly: boolean;
}

export function writeCapability(input: {
  readonly: boolean;
  /** `""` = queue.yaml is absent (the bootstrap base) · `null` = unreadable. */
  queueHash: string | null;
}): WriteCapability {
  // An unreadable queue is the same refusal on both kinds of instance, so it is
  // decided BEFORE the readonly branch rather than inside one of them: a
  // readonly board short-circuiting straight to `draft` drafted an order over a
  // column mimir really ranks (the payload's `queue.order` is empty when the
  // file cannot be read, so `diskRanked` never says otherwise) and never showed
  // the banner explaining why nothing could be saved.
  const orderReadable = input.queueHash !== null;
  if (input.readonly) {
    return {
      orderMode: orderReadable ? "draft" : "off",
      priorityMode: "draft",
      // Neither axis is server-owned here, so the whole overlay stays: it is the
      // only priority and the only ranking a reader on this instance has.
      retirePriorityDraft: false,
      retireOrderDraft: false,
      orderOffReason: orderReadable ? null : QUEUE_UNREADABLE_REASON,
      readonly: true,
    };
  }
  return {
    orderMode: orderReadable ? "write" : "off",
    priorityMode: "write",
    // Per axis (rule 2): the priority axis is server-owned here whatever the
    // queue file is doing, and an order draft that can never be saved is still
    // the only ranking a reader on this board has.
    retirePriorityDraft: true,
    retireOrderDraft: orderReadable,
    orderOffReason: orderReadable ? null : QUEUE_UNREADABLE_REASON,
    readonly: false,
  };
}

/**
 * The halves of a stored draft this board is still willing to keep.
 *
 * Called on load and after every refresh, and it is what {@link saveOverlay}'s
 * caller writes back — so a retired axis cannot come back by being re-persisted
 * alongside the axis that survived.
 */
export function retainDraft(overlay: BoardOverlay, capability: WriteCapability): BoardOverlay {
  return {
    priority: capability.retirePriorityDraft ? {} : { ...overlay.priority },
    order: capability.retireOrderDraft ? {} : { ...overlay.order },
  };
}

/** Why the draft note's PRIORITY half is still a draft. */
export function priorityDraftReason(capability: WriteCapability): string {
  return capability.readonly
    ? "this instance cannot write the wiki"
    : "this board is not writing priorities";
}

/**
 * Why the draft note's ORDER half is still a draft — the axis it actually
 * describes. The note used to carry ONE reason for both halves, so a priority
 * draft on a readonly instance was blamed on a `queue.yaml` nobody had touched.
 */
export function orderDraftReason(capability: WriteCapability): string {
  if (capability.orderMode === "off") {
    return "plans/queue.yaml could not be read, so the order cannot be written";
  }
  return "this instance cannot write the wiki";
}

/**
 * The masthead's one-sentence statement of what this board writes.
 *
 * Rendered from the CAPABILITY on both ends — server-side for the no-JavaScript
 * reading, and again on every client render — because the sentence goes stale
 * the moment a 403 flips the board mid-session, and because a second spelling
 * of it in the page template is one copy edit away from contradicting the
 * banner underneath it.
 */
export function writeModeSentence(capability: WriteCapability): string {
  if (capability.readonly) return `Nothing is written back on this host — ${PLAN_READONLY_NOTE}`;
  if (capability.orderMode === "off") {
    return (
      "Setting a priority (or archiving) writes the plan's frontmatter — straight to the wiki, and " +
      "refused if the file changed since this board was read. Ranking is off: plans/queue.yaml could not be read."
    );
  }
  return (
    "Setting a priority (or archiving) writes the plan's frontmatter and ranking a column writes " +
    "plans/queue.yaml — all straight to the wiki, refused if the file changed since this board was read."
  );
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
  /** A reload-worthy failure (409, or a 4xx that means the corpus moved) is
   *  standing on the order surface. Every base this board holds is suspect
   *  until the reader presses Reload, so a further nudge could only 409 — and
   *  the click that fired it would wipe the Reload button on its way out. */
  reloadPending: boolean;
  /** A refresh is in flight. The bases are about to be replaced wholesale. */
  reloading: boolean;
}

/**
 * Null ⇒ the ▲▼ may act. Otherwise the sentence its tooltip carries. The
 * buttons are always RENDERED — a control that vanishes reads as a board that
 * lost the ability to rank.
 *
 * **A write in flight is deliberately NOT a reason** (rule 5): the second click
 * is queued on the write chain and computed from the order the first one
 * landed, which is the whole point of having a chain.
 */
export function nudgeBlockedReason(gate: NudgeGate): string | null {
  if (!gate.rankUi) return NUDGE_OFF_SORT;
  if (!isRankableColumn(gate.column)) return NUDGE_TERMINAL_COLUMN;
  const mode = gate.capability.orderMode;
  if (mode === "off") return gate.capability.orderOffReason ?? QUEUE_UNREADABLE_REASON;
  if (gate.reloading) return NUDGE_RELOADING;
  if (gate.reloadPending) return NUDGE_RELOAD_FIRST;
  if (mode === "write") return null;
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

/**
 * The drawer's four priority buttons. `onDisk` is "the frontmatter carries a
 * priority", which only constrains the DRAFT path — a writing board edits the
 * frontmatter itself, including clearing it.
 *
 * `staleHash` is this CARD's own out-of-date state: a 409 (or a 404 naming a
 * plan that is no longer there) proves the hash it holds is dead, and every
 * later click on it could only 409 again. The buttons stay armed on a hash
 * known dead only if nobody says so — so they are disabled until Reload.
 */
export function priorityControlState(input: {
  mode: PriorityMode;
  onDisk: boolean;
  busy: boolean;
  staleHash?: boolean;
  reloading?: boolean;
}): PriorityControlState {
  if (input.busy) return { disabled: true, title: "saving…" };
  if (input.reloading) return { disabled: true, title: NUDGE_RELOADING };
  if (input.staleHash) return { disabled: true, title: NUDGE_RELOAD_FIRST };
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

/**
 * What a move the chain refused to send leaves on the notice.
 *
 * The ▲▼ stay live while a write runs (rule 5), so a click CAN arrive between a
 * write going out and that write turning out to have lost its CAS base — and
 * the guard that then refuses the queued move is refusing something the reader
 * really did. Silently dropping it is the same failure as the disabled buttons:
 * a click with no consequence and no explanation. Null ⇒ nothing was dropped
 * and the message stands unchanged.
 */
export function queuedMovesDroppedNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "a queued move was not sent — reload first"
    : `${count} queued moves were not sent — reload first`;
}

/** The sentence a refused click gets when the plan's priority is in mimir's
 *  frontmatter and this board can no longer write it. */
export function priorityOnDiskNote(diskPriority: PlanPriority): string {
  return (
    `${PLAN_READONLY_SHORT}, and a draft never overrides the frontmatter — ` +
    `priority: ${diskPriority} stays until an instance that writes mimir changes it.`
  );
}

export type RefusedPriorityFold = { kind: "draft" } | { kind: "note"; message: string };

/**
 * Where a 403-refused priority click goes.
 *
 * The click is not lost — on a board that has just discovered it cannot write,
 * the draft is where an edit belongs. But the draft can only express the edit
 * the reader made when the plan carries NO frontmatter priority: `applyOverlay`
 * gives disk the win unconditionally, so for a plan that has one, a draft entry
 * can neither clear it (which is exactly what clicking the level already set
 * means) nor replace it. Storing the clicked value there produced a dead
 * entry — invisible on the board, since the pill renders the disk value either
 * way, and counted by nothing.
 *
 * So the fold toggles against the EFFECTIVE priority, and the honest fold for a
 * disk-priority card is no draft entry plus the sentence that says who can
 * change it. (When disk is null the effective value IS the draft value, which
 * is what the draft toggle already compares against.)
 */
export function foldRefusedPriority(diskPriority: PlanPriority | null): RefusedPriorityFold {
  return diskPriority === null
    ? { kind: "draft" }
    : { kind: "note", message: priorityOnDiskNote(diskPriority) };
}

/**
 * The drawer's archive/restore buttons. Simpler than the priority state on
 * purpose: there is no draft mode (see {@link ARCHIVE_READONLY_TITLE}), so a
 * readonly board disables them outright.
 */
export function archiveControlState(input: {
  readonly: boolean;
  busy: boolean;
  staleHash?: boolean;
  reloading?: boolean;
}): PriorityControlState {
  if (input.busy) return { disabled: true, title: "saving…" };
  if (input.reloading) return { disabled: true, title: NUDGE_RELOADING };
  if (input.staleHash) return { disabled: true, title: NUDGE_RELOAD_FIRST };
  if (input.readonly) return { disabled: true, title: ARCHIVE_READONLY_TITLE };
  return { disabled: false, title: null };
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

export interface StatusRequest {
  slug: string;
  status: PlanStatus;
  baseHash: string;
}

export function statusRequest(card: { slug: string; hash: string }, status: PlanStatus): StatusRequest {
  return { slug: card.slug, status, baseHash: card.hash };
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
  /** Column keys in the 200 this board does not rank. Skipped rather than
   *  refused — see {@link parseOrderResult} — and reported so a server that
   *  grew a fifth column is visible instead of silently half-adopted. */
  unknownColumns: string[];
}

/** The line an unknown column key in an otherwise good 200 leaves on the
 *  warnings surface. */
export function unknownColumnWarning(key: string): string {
  return `the write answered with a column this board does not rank ("${key}") — it was ignored, and this board's order for it is unchanged`;
}

/**
 * Slugs `queue.yaml` ranks that this write is about to DROP, because their plan
 * is no longer in the column.
 *
 * The board posts the merged (column-filtered) list, so the drop is real and
 * durable — and the server cannot warn about it, since every slug it receives
 * is a slug it knows. Measured: an unrelated nudge in `Ready` silently
 * destroyed another plan's #1 rank in the same column.
 */
export function prunedRankSlugs(stored: readonly string[], shown: readonly string[]): string[] {
  const kept = new Set(shown);
  return stored.filter((slug) => !kept.has(slug));
}

export function prunedRankWarning(slug: string, columnLabel: string): string {
  return `"${slug}" was ranked in ${columnLabel} in plans/queue.yaml but its plan is not in that column any more — this write drops it from the order`;
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

/**
 * An unknown column key is SKIPPED, not fatal.
 *
 * Rejecting the whole body over one key rejected a write that had already
 * landed on disk: the board raised "a body this board does not understand —
 * reload", the reader reloaded, and the next write hit the same key again. A
 * column this board cannot rank is a column it has nothing to adopt for, which
 * is exactly what skipping it means; the value itself is still checked, because
 * a mistyped list under a KNOWN key would arm every later badge.
 */
export function parseOrderResult(raw: unknown): OrderResult | null {
  const body = record(raw);
  if (!body) return null;
  if (typeof body.hash !== "string") return null;
  const posted = record(body.order);
  if (!posted) return null;
  const order: BoardOrder = {};
  const unknownColumns: string[] = [];
  for (const [key, value] of Object.entries(posted)) {
    if (!(ACTIVE_COLUMN_KEYS as readonly string[]).includes(key)) {
      unknownColumns.push(key);
      continue;
    }
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
    unknownColumns,
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

export interface StatusResult {
  slug: string;
  /** What is ON DISK — a `noop` echoes the unchanged value, which can be null
   *  for a plan whose frontmatter carries a status outside the enum. */
  status: PlanStatus | null;
  statusDate: string | null;
  hash: string;
  written: boolean;
}

/** Null ⇒ the body is not the contract (rule 4, same as the priority parse). */
export function parseStatusResult(raw: unknown): StatusResult | null {
  const body = record(raw);
  if (!body) return null;
  const { slug, hash, status, statusDate, written } = body;
  if (typeof slug !== "string" || !slug) return null;
  if (typeof hash !== "string" || !hash) return null;
  const st =
    status === null || status === undefined
      ? null
      : typeof status === "string" && (PLAN_STATUSES as readonly string[]).includes(status)
        ? (status as PlanStatus)
        : undefined;
  if (st === undefined) return null;
  const date =
    statusDate === null || statusDate === undefined
      ? null
      : typeof statusDate === "string"
        ? statusDate
        : undefined;
  if (date === undefined) return null;
  return { slug, status: st, statusDate: date, hash, written: written === true };
}

/**
 * Fold a status 200 into the card list. The COLUMN is re-derived exactly as the
 * server derives it (`columnForStatus`, followups beating shipped) and the age
 * from the stamped date, so the card moves on this render rather than on the
 * next reload. Same no-hit contract as {@link applyPriorityResult}.
 */
export function applyStatusResult<
  T extends {
    slug: string;
    planStatus: PlanStatus | null;
    statusDate: string | null;
    ageDays: number | null;
    column: BoardColumnKey;
    followupsOpen: boolean;
    hash: string;
  },
>(cards: readonly T[], result: StatusResult, now: number): T[] {
  let hit = false;
  const next = cards.map((card) => {
    if (card.slug !== result.slug) return card;
    hit = true;
    return {
      ...card,
      planStatus: result.status,
      statusDate: result.statusDate,
      ageDays: ageInDays(result.statusDate, now),
      column: columnForStatus(result.status, card.followupsOpen),
      hash: result.hash,
    };
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
 *
 * **400 and 404 offer Reload too** (rule 6). Both routes answer `no plan named
 * "x"` — a 404 on the priority route, a 400 on the order route — for a plan
 * that was retired or renamed in mimir since this board was read, which is the
 * everyday lifecycle of that directory and is exactly what Reload fixes. The
 * cost of being wrong is one refetch; the cost of the old `reload: false` was a
 * dead end on the most common stale-board failure there is.
 */
export function classifyWriteFailure(
  status: number,
  body: unknown,
  surface: "priority" | "order" | "status",
): WriteFailure {
  const parsed = record(body);
  const error = typeof parsed?.error === "string" && parsed.error.trim() ? parsed.error.trim() : null;
  if (status === 409) {
    return {
      kind: "stale",
      // A status write edits the plan file a priority write edits, so the two
      // share the plan sentence.
      message: surface === "order" ? ORDER_STALE_MESSAGE : PRIORITY_STALE_MESSAGE,
      reload: true,
    };
  }
  if (status === 403) {
    return { kind: "readonly", message: error ?? PLAN_READONLY_SHORT, reload: false };
  }
  if (status === 422) {
    return { kind: "refused", message: error ?? "the wiki refused the write", reload: false };
  }
  if (status === 400 || status === 404) {
    return { kind: "stale", message: error ?? `write failed (HTTP ${status})`, reload: true };
  }
  return { kind: "error", message: error ?? `write failed (HTTP ${status})`, reload: false };
}

/** The fetch itself threw, or the 200 body was not the contract. */
export function transportFailure(reason: string): WriteFailure {
  return { kind: "error", message: reason, reload: false };
}

// ---------------------------------------------------------------- refresh

/**
 * `GET /api/plans/board`, parsed into the state a refresh may commit.
 *
 * Everything the write half depends on is checked — the cards' slugs, hashes,
 * columns and priorities are the CAS bases and the pill values — and the board
 * is then rebuilt from the parsed pieces, so a body that goes wrong halfway
 * leaves the previous board intact instead of half-adopted. The purely
 * DISPLAY-side leaves (`estimate`, `ledger`) ride through as opaque records:
 * they are read with optional chaining everywhere and a malformed one costs a
 * dash on a card, not a wrong write.
 */
export interface BoardRefresh {
  readonly: boolean;
  cards: BoardCard[];
  queue: { order: BoardOrder; hash: string | null };
  columns: BoardColumnMeta[];
  money: { available: boolean; reason: string | null };
}

const COLUMN_KEYS: ReadonlySet<string> = new Set(BOARD_COLUMNS.map((c) => c.key));

function str(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

function priorityOrNull(raw: unknown): PlanPriority | null | undefined {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" && (PLAN_PRIORITIES as readonly string[]).includes(raw)
    ? (raw as PlanPriority)
    : undefined;
}

function parseCard(raw: unknown): BoardCard | null {
  const c = record(raw);
  if (!c) return null;
  const slug = str(c.slug);
  const hash = str(c.hash);
  const title = str(c.title);
  const relPath = str(c.relPath);
  const wikiUrl = str(c.wikiUrl);
  const family = str(c.family);
  const column = str(c.column);
  if (!slug || hash === null || title === null || relPath === null) return null;
  if (wikiUrl === null || family === null || column === null || !COLUMN_KEYS.has(column)) return null;
  const priority = priorityOrNull(c.priority);
  if (priority === undefined) return null;
  const tags = strings(c.tags);
  if (!tags) return null;
  if (typeof c.mtimeMs !== "number" || !Number.isFinite(c.mtimeMs)) return null;
  const ageDays = c.ageDays === null || c.ageDays === undefined ? null : c.ageDays;
  if (ageDays !== null && (typeof ageDays !== "number" || !Number.isFinite(ageDays))) return null;
  // A status the enum does not know is dropped to null exactly as the SERVER
  // drops it (`columnForStatus` files such a card under Proposed), so the
  // refresh cannot introduce a status value the pure layer never sees.
  const planStatus =
    typeof c.planStatus === "string" && (PLAN_STATUSES as readonly string[]).includes(c.planStatus)
      ? (c.planStatus as PlanStatus)
      : null;
  const familySource = c.familySource === "prs" || c.familySource === "slug" ? c.familySource : null;
  return {
    slug,
    title,
    description: str(c.description),
    statusNote: str(c.statusNote),
    planStatus,
    column: column as BoardColumnKey,
    statusDate: str(c.statusDate),
    ageDays,
    mtimeMs: c.mtimeMs,
    priority,
    tags,
    relPath,
    hash,
    followupsOpen: c.followupsOpen === true,
    wikiUrl,
    family,
    familySource,
    familyConfident: c.familyConfident === true,
    mixedRepos: c.mixedRepos === true,
    // Display-only leaves — see the interface doc.
    estimate: (record(c.estimate) ?? null) as BoardCard["estimate"],
    ledger: (record(c.ledger) ?? null) as BoardCard["ledger"],
  };
}

export function parseBoardRefresh(raw: unknown): BoardRefresh | null {
  const body = record(raw);
  if (!body) return null;
  if (typeof body.readonly !== "boolean") return null;

  if (!Array.isArray(body.cards)) return null;
  const cards: BoardCard[] = [];
  for (const entry of body.cards) {
    const card = parseCard(entry);
    if (!card) return null;
    cards.push(card);
  }

  const queue = record(body.queue);
  if (!queue) return null;
  const hash = queue.hash === null ? null : str(queue.hash);
  if (hash === null && queue.hash !== null) return null;
  const rawOrder = record(queue.order);
  if (!rawOrder) return null;
  const order: BoardOrder = {};
  for (const [key, value] of Object.entries(rawOrder)) {
    // The same active-only key set `parseOrderResult` adopts, skipped for the
    // same reason: `queue.yaml` ranks exactly these four, and a key this board
    // cannot rank is one it has nothing to hang a badge on.
    if (!(ACTIVE_COLUMN_KEYS as readonly string[]).includes(key)) continue;
    const slugs = strings(value);
    if (!slugs) return null;
    if (slugs.length > 0) order[key as BoardColumnKey] = slugs;
  }

  if (!Array.isArray(body.columns)) return null;
  const columns: BoardColumnMeta[] = [];
  for (const entry of body.columns) {
    const col = record(entry);
    if (!col) return null;
    const key = str(col.key);
    const label = str(col.label);
    const tone = str(col.tone);
    const hint = str(col.hint);
    const scope = str(col.scope);
    if (!key || !COLUMN_KEYS.has(key) || label === null || tone === null) return null;
    if (hint === null || scope === null) return null;
    columns.push({
      key: key as BoardColumnKey,
      label,
      scope: scope as BoardColumnMeta["scope"],
      hint,
      tone,
    });
  }

  const money = record(body.money);
  if (!money || typeof money.available !== "boolean") return null;
  const reason = money.reason === null || money.reason === undefined ? null : str(money.reason);
  if (reason === null && money.reason !== null && money.reason !== undefined) return null;

  return {
    readonly: body.readonly,
    cards,
    queue: { order, hash },
    columns,
    money: { available: money.available, reason },
  };
}
