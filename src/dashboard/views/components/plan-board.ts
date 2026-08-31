/// <reference lib="dom" />
/**
 * The `/plans` board's DOM half — meters, controls, columns, cards and the
 * drawer, rendered from the payload the page embedded as `window.PLAN_BOARD`.
 *
 * Every RULE lives in `src/plans/board-client-pure.ts` (sorting, the degrade
 * rule, filters, the meter maths, the overlay merge) and is unit-tested there
 * with no DOM. This file only turns those results into elements — so a change
 * to what the board *means* is a test in the pure half, and a change to what it
 * *looks like* is here.
 *
 * Transcribed from the design prototype (`docs/proto/plan-board.html`). There is
 * still **no drag** — dragging is how a card changes STATUS, and no endpoint
 * writes `plan_status`; ranking within a column is the ▲▼ nudges.
 *
 * PR 5 gave the two edits somewhere to go: a priority click POSTs
 * `/api/plans/priority` and a nudge POSTs `/api/plans/order`, both carrying the
 * CAS base they were rendered with and adopting the hash the 200 answers with.
 * The rules that decide WHETHER an edit may run, what it posts and what a
 * non-200 says live in `src/plans/board-writes.ts`, tested with no DOM; this
 * file owns the elements, the requests and the serialization:
 *
 *   - **One write per card; every queue write through ONE chain.** A card whose
 *     priority is in flight has its buttons disabled and drops a racing click.
 *     The ▲▼ stay ENABLED while a queue write runs and the click is appended to
 *     the chain, which computes its move from the order the previous write
 *     LANDED — that is what the chain is for, and disabling the buttons meant
 *     no second click could ever reach it. Measured against the pre-fix build,
 *     five ▲ dispatched in one tick: **1 of 5 reached a live button** and the
 *     other four were eaten, and focus came back on `<body>` (a disabled button
 *     cannot take it back, so `restoreNudgeFocus` fell through). What a write in
 *     flight gets instead is a per-column "saving…" marker.
 *   - **A stale board DOES stop the controls.** A standing reload-worthy
 *     failure or a refresh in flight disables the nudges and the affected
 *     card's priority buttons, because every CAS base they hold is known dead.
 *     The standing message is cleared when a write LAUNCHES, never when one is
 *     queued — nulling it at queue time wiped the Reload button mid-flight and
 *     fired a request that could only 409. A move ALREADY queued when that
 *     failure lands cannot be sent either, so it is counted on the message
 *     rather than dropped in silence; after a 403 flip it is folded into the
 *     draft, like the click that discovered the refusal.
 *   - **A display leaf costs a dash, never a throw.** `parseBoardRefresh` waves
 *     `estimate`/`ledger` through unchecked by design, so every read of one goes
 *     through `fin`/`numText` — and `openDrawer` keeps a backstop, because it
 *     mutates state before it builds.
 *   - **A refresh is serialized against both write chains.** `reloadBoard`
 *     waits for everything in flight, then adopts a payload it has fully
 *     parsed — all of it or none of it — and clears only the messages that
 *     predate the refresh, so a failure raised while it ran is not erased.
 *   - **Nothing is applied optimistically.** The board redraws from the
 *     response, so it can never show an order the wiki refused.
 *   - **The `localStorage` draft is retired PER AXIS**, the moment the server
 *     owns that axis — on a readonly instance both halves stay, because there
 *     they are the only priority and the only ranking a reader has.
 */

import {
  BOARD_PRIORITIES,
  applyOverlay,
  canNudge,
  cardsInScope,
  computeMeters,
  familyCounts,
  filterCards,
  formatAge,
  formatUsd,
  isTerminalColumn,
  nudgeRanked,
  rankOf,
  sanitizeOverlay,
  showRankUi,
  sortCards,
  viewStateFromQuery,
  viewStateToQuery,
  visibleColumns,
  type BoardColumnKey,
  type BoardColumnMeta,
  type BoardOrder,
  type BoardOverlay,
  type BoardCard,
  type BoardScope,
  type BoardSort,
  type BoardViewState,
  type EffectiveCard,
} from "../../../plans/board-client-pure.ts";
import {
  admitPriorityEdit,
  applyPriorityResult,
  applyStatusResult,
  archiveControlState,
  classifyWriteFailure,
  foldRefusedPriority,
  nudgeBlockedReason,
  orderDraftReason,
  orderRequest,
  parseBoardRefresh,
  parseOrderResult,
  parsePriorityResult,
  parseStatusResult,
  priorityControlState,
  priorityDraftReason,
  priorityRequest,
  prunedRankSlugs,
  prunedRankWarning,
  queuedMovesDroppedNote,
  retainDraft,
  statusRequest,
  transportFailure,
  unknownColumnWarning,
  writeCapability,
  writeModeSentence,
  ARCHIVE_TARGETS,
  COLUMN_SAVING,
  PLAN_READONLY_NOTE,
  RESTORE_TARGET,
  type BoardRefresh,
  type WriteCapability,
} from "../../../plans/board-writes.ts";
import { getJson } from "./client-runtime.ts";
import { COPIED_MS, copyText, flashCopyResult, wikiPagePath } from "./copy-path.ts";
import type { BoardPayload } from "../../../plans/board.ts";
import type { PlanPriority, PlanStatus } from "../../../plans/constants.ts";

const OVERLAY_KEY = "muninn.planboard.draft.v1";

/**
 * A message a write left on a surface, with the reload the CAS loss needs.
 *
 * `at` is what a refresh compares against: a message raised while the refresh
 * was in flight describes state NEWER than the payload being adopted, and
 * clearing it is how a click's only feedback vanished (measured: a nudge during
 * a reload 409'd and the adopt erased the message before it could be read).
 */
interface WriteMessage {
  text: string;
  reload: boolean;
  at: number;
  /** Moves the chain refused to send while this message stood. Counted on the
   *  message itself, so clearing the message (at launch, or on a refresh)
   *  clears the count with it and the `at` rule above covers both. */
  queuedDropped?: number;
}

/** The 200 body was not the contract — see `parse*Result`. Adopting a hash off
 *  an unchecked shape arms every later edit on that card to 409. */
const BAD_BODY = "the write answered with a body this board does not understand — reload";

interface ViewState extends BoardViewState {
  openSlug: string | null;
}

/**
 * The money half of a card, read defensively.
 *
 * `parseBoardRefresh` waves `estimate` and `ledger` through as opaque records
 * ON PURPOSE — they are display-only, and rejecting a whole refresh over one
 * cosmetic leaf would be worse than rendering a dash. That promise only holds
 * if the render side actually keeps it: it did not, and a leaf of the wrong
 * type (a `number | null` that arrived absent, a `prs` that is not an array)
 * threw inside `openDrawer` AFTER the previous panel was removed and
 * `view.openSlug` set — leaving the card permanently un-openable. So every read
 * of one of those leaves goes through these three, and the cost of a leaf this
 * board cannot use is a dash.
 */
function fin(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function numText(raw: unknown, fmt: (n: number) => string = String): string {
  const n = fin(raw);
  return n === null ? "—" : fmt(n);
}

function strText(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw ? raw : fallback;
}

function el(tag: string, cls?: string | null, text?: string | null): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- overlay io

function loadOverlay(): BoardOverlay {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return { priority: {}, order: {} };
    // Validated field by field, never cast: an older build of this page, a hand
    // edit, or a half-finished write can leave a priority the pill has no
    // colour for and an order entry no card can ever match.
    return sanitizeOverlay(JSON.parse(raw));
  } catch {
    // A corrupt draft is not worth taking the board down for.
    return { priority: {}, order: {} };
  }
}

function writeOverlay(overlay: BoardOverlay): void {
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  } catch {
    /* private mode / quota — the board still works, the draft just does not persist */
  }
}

/** Drop the draft key. Called once on a board whose server owns both axes: from
 *  there on disk and the write responses are the only state, and a draft left
 *  behind would come back the day someone opens the board on the readonly
 *  instance and shadow a priority that is committed to mimir. */
function clearOverlay(): void {
  try {
    localStorage.removeItem(OVERLAY_KEY);
  } catch {
    /* nothing to do — the draft is not read again on this board either way */
  }
}

// ---------------------------------------------------------------- mount

export function mountPlanBoard(payload: BoardPayload, root: HTMLElement): void {
  // The URL is the view's home: a board someone filtered down to "huginn, p0,
  // by cost" is worth linking to, and a reload that silently threw the filter
  // away read as the board losing the plans it was just showing.
  const view: ViewState = { ...viewStateFromQuery(location.search), openSlug: null };
  // A `?sort=cost` link opened against a board with no money would sort by a
  // number nothing renders; the Cost button is disabled in that state, so the
  // URL must land where the button would.
  if (!payload.money.available && view.sort === "cost") view.sort = "rank";

  const metersBox = root.querySelector<HTMLElement>("#pbMeters")!;
  const controlsBox = root.querySelector<HTMLElement>("#pbControls")!;
  const boardBox = root.querySelector<HTMLElement>("#pbBoard")!;
  const draftBox = root.querySelector<HTMLElement>("#pbDraft")!;
  const noticeBox = root.querySelector<HTMLElement>("#pbNotice")!;
  const modeBox = root.querySelector<HTMLElement>("#pbMode");

  // Everything a write or a reload can change is state, not the frozen payload:
  // a 200 replaces a card's priority AND its hash, an order response replaces
  // the whole queue, and a 403 flips the board into the readonly rendering.
  let cards: BoardCard[] = payload.cards;
  let queue: { order: BoardOrder; hash: string | null } = payload.queue;
  /** What the LAST payload said. The client banner is rendered only when the
   *  capability has since diverged from it (a 403 flip), because a payload that
   *  already said readonly is stated once, in the masthead. */
  let payloadReadonly = payload.readonly;
  let capability: WriteCapability = writeCapability({
    readonly: payload.readonly,
    queueHash: payload.queue.hash,
  });
  let columnMeta = new Map<string, BoardColumnMeta>(payload.columns.map((c) => [c.key, c]));
  let money: { available: boolean; reason: string | null } = payload.money;

  /** The wiki root on THIS host — what makes the drawer's copy-path button
   *  yield a path an agent can open. Boot-time fact; a refresh cannot move it. */
  const wikiRoot = payload.wiki.root;

  let overlay = retainDraft(loadOverlay(), capability);
  saveOverlay();

  // ---- write state --------------------------------------------------------
  /** Slugs whose priority write is in flight — the per-card serialization. */
  const priorityPending = new Set<string>();
  /** The same writes as promises: a refresh has to WAIT for them, and a Set of
   *  slugs cannot be awaited. */
  const priorityInFlight = new Map<string, Promise<void>>();
  /** Cards whose hash a 4xx proved dead. Their priority buttons stay disabled
   *  until a Reload replaces the hash — armed buttons over a known-dead base
   *  can only 409 again. */
  const staleCards = new Set<string>();
  /** The drawer's message, keyed to the card it was raised on: the drawer is a
   *  singleton node and a message left over from another plan reads as this
   *  one's failure. */
  let priorityMsg: (WriteMessage & { slug: string }) | null = null;
  /** The archive control's message — its own slot for the same singleton-drawer
   *  reason, rendered under the Archive heading rather than Priority's. */
  let statusMsg: (WriteMessage & { slug: string }) | null = null;
  /** Order writes in flight, per column — the "saving…" marker's source. One
   *  CHAIN for all of them, so two ▲ presses cannot send the same CAS base
   *  twice; per-COLUMN counting only so the marker names the right column. */
  const orderPendingByColumn = new Map<string, number>();
  let orderChain: Promise<void> = Promise.resolve();
  let orderMsg: WriteMessage | null = null;
  let orderWarnings: string[] = [];
  /** When `orderWarnings` was raised — the `WriteMessage.at` rule, for the same
   *  reason: a refresh must not erase the details of a write that outran it. */
  let orderWarningsAt = 0;
  let reloading = false;
  let reloadStartedAt = 0;

  function stamp(text: string, reload: boolean): WriteMessage {
    return { text, reload, at: Date.now() };
  }

  /** Persist the draft as the capability allows. Retirement is applied HERE as
   *  well as on load, so no path — the stale-column purge in `merged()`, a
   *  post-flip draft — can write back an axis the server owns. */
  function saveOverlay(): void {
    overlay = retainDraft(overlay, capability);
    if (Object.keys(overlay.priority).length === 0 && Object.keys(overlay.order).length === 0) {
      clearOverlay();
      return;
    }
    writeOverlay(overlay);
  }

  function orderBusy(column: string): boolean {
    return (orderPendingByColumn.get(column) ?? 0) > 0;
  }

  function bumpOrderPending(column: string, delta: 1 | -1): void {
    const next = (orderPendingByColumn.get(column) ?? 0) + delta;
    if (next > 0) orderPendingByColumn.set(column, next);
    else orderPendingByColumn.delete(column);
  }

  interface Merged {
    cards: EffectiveCard[];
    order: BoardOrder;
    draftCols: Set<string>;
    /** Columns queue.yaml ranks — no ▲▼ until the board can write. */
    diskCols: Set<string>;
  }

  /** Merge the draft under the payload — disk wins, every render. */
  function merged(): Merged {
    const res = applyOverlay(cards, queue.order, overlay);
    // A draft the merge threw away (the disk took the column over, or none of
    // its slugs is in the column any more) is deleted from the STORED overlay
    // too, so it cannot reappear the day someone edits queue.yaml. Purging
    // here is stable: the next applyOverlay reports nothing stale, so this
    // cannot loop.
    if (res.staleDraftColumns.some((key) => overlay.order[key])) {
      const order = { ...overlay.order };
      for (const key of res.staleDraftColumns) delete order[key];
      overlay = { priority: { ...overlay.priority }, order };
      saveOverlay();
    }
    const draftCols = new Set(
      Object.entries(res.orderIsDraft)
        .filter(([, isDraft]) => isDraft)
        .map(([key]) => key),
    );
    return { cards: res.cards, order: res.order, draftCols, diskCols: new Set(res.diskRanked) };
  }

  /** Mirror the view into the URL. `replaceState`, not `pushState`: a chip
   *  click is not a navigation, and Back must leave the board, not walk back
   *  through eleven filter changes. */
  function syncUrl(): void {
    try {
      history.replaceState(history.state, "", `${location.pathname}${viewStateToQuery(view)}`);
    } catch {
      /* sandboxed / opaque origin — the board works, the link just is not shareable */
    }
  }

  function render(): void {
    // A chip or segment click re-renders the controls it was fired from, which
    // destroys the focused button. Remember which one it was by its stable key
    // and give focus back after the rebuild — otherwise keyboard filtering
    // dumps the user back at the top of the document on every click.
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && controlsBox.contains(active) ? active.dataset.key ?? null : null;
    // A ▲/▼ press rebuilds the whole board, so the pressed button is destroyed
    // too — and it lives in `boardBox`, which the key above deliberately does
    // not cover. Remember it the way the drawer remembers its opener: by the
    // stable pair (slug, direction), re-found after the rebuild.
    const nudgeFocus =
      active && boardBox.contains(active) && active.dataset.slug && active.dataset.dir
        ? { slug: active.dataset.slug, dir: active.dataset.dir }
        : null;

    const { cards: effective, order, draftCols, diskCols } = merged();
    const shown = filterCards(effective, view.filters);
    renderMode();
    renderNotice();
    renderMeters(shown);
    renderControls(effective);
    renderBoard(shown, order, draftCols, diskCols);
    renderDraftNote(effective, order, draftCols);
    syncUrl();

    if (focusKey) {
      controlsBox.querySelector<HTMLElement>(`[data-key="${cssEscape(focusKey)}"]`)?.focus();
    }
    if (nudgeFocus) restoreNudgeFocus(nudgeFocus.slug, nudgeFocus.dir);
  }

  /**
   * Put focus back on the nudge that was just pressed.
   *
   * The same button first — but a nudge can DISABLE the button that fired it:
   * ▲ on an unranked card ranks it, and a card that lands at #1 has no ▲ any
   * more. A disabled button cannot hold focus, so the card's other nudge takes
   * it (same control group, one button away, and it is the move that undoes
   * what was just done), and the card itself is the last resort — anything
   * rather than dropping the keyboard back to `<body>`.
   */
  function restoreNudgeFocus(slug: string, dir: string): void {
    const base = `.pb-nudge button[data-slug="${cssEscape(slug)}"]`;
    const pick = (d: string) =>
      boardBox.querySelector<HTMLButtonElement>(`${base}[data-dir="${d}"]`);
    const same = pick(dir);
    if (same && !same.disabled) {
      same.focus();
      return;
    }
    const other = pick(dir === "up" ? "down" : "up");
    if (other && !other.disabled) {
      other.focus();
      return;
    }
    boardBox.querySelector<HTMLElement>(`.pb-card[data-slug="${cssEscape(slug)}"]`)?.focus();
  }

  // ---------------------------------------------------------------- writes

  interface PostOutcome {
    ok: boolean;
    status: number;
    body: unknown;
  }

  /** A write, reduced to the three things the classifier needs. Never throws:
   *  an unreachable muninn is a message on the surface, like every 4xx. */
  async function postJson(url: string, payloadBody: unknown): Promise<PostOutcome> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payloadBody),
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        /* an empty or non-JSON body classifies on its status alone */
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, body: { error: `the write did not reach muninn (${reason})` } };
    }
  }

  /**
   * A 403 is the whole page's answer, not one control's: the instance is
   * wiki-readonly, so every other control would answer the same. Flipping the
   * board is the honest rendering — controls disabled and visible, one banner
   * naming the flag — rather than N identical refusals one click at a time.
   *
   * The refused edit is NOT lost: the caller folds it into the draft right
   * after, because on a readonly board the draft is where that edit belongs and
   * "the first click does nothing, the second one drafts" is indistinguishable
   * from a broken control.
   */
  function flipReadonly(): void {
    capability = writeCapability({ readonly: true, queueHash: queue.hash });
    priorityMsg = null;
    statusMsg = null;
    orderMsg = null;
    // A stale mark is a statement about a CAS BASE, and this board no longer
    // sends one — the draft it falls back to has no hash. Left set, it disabled
    // that card's buttons for the rest of the session, because the only thing
    // that clears the mark is a Reload and a readonly board offers none (both
    // messages carrying one were just dropped, two lines up).
    staleCards.clear();
  }

  /** Write one plan's priority. Serialized per card; the response's priority and
   *  hash are adopted, never the requested ones (a `noop` echoes what is on
   *  disk, and the next edit's CAS base has to be that). */
  function writePriority(slug: string, clicked: PlanPriority): void {
    if (reloading || staleCards.has(slug)) return;
    const card = cards.find((c) => c.slug === slug);
    if (!card || !admitPriorityEdit(priorityPending, slug)) return;
    priorityPending.add(slug);
    priorityMsg = null;
    refreshDrawer(slug);

    const run = runPriorityWrite(card, clicked).finally(() => {
      priorityPending.delete(slug);
      priorityInFlight.delete(slug);
      render();
      refreshDrawer(slug, `pri-${clicked}`);
    });
    // Held as a promise as well as a slug: `reloadBoard` waits on these, so a
    // refresh cannot issue its GET while a write is still deciding what disk
    // says.
    priorityInFlight.set(slug, run);
  }

  async function runPriorityWrite(
    card: { slug: string; priority: PlanPriority | null; hash: string },
    clicked: PlanPriority,
  ): Promise<void> {
    const out = await postJson("/api/plans/priority", priorityRequest(card, clicked));
    if (out.ok) {
      const result = parsePriorityResult(out.body);
      if (result) cards = applyPriorityResult(cards, result);
      else priorityMsg = { slug: card.slug, ...stamp(transportFailure(BAD_BODY).message, true) };
      return;
    }
    const fail = classifyWriteFailure(out.status, out.body, "priority");
    if (fail.kind === "readonly") {
      flipReadonly();
      // The click that discovered the refusal is the one the reader made — so it
      // folds into the draft, EXCEPT where a draft cannot express it: on a plan
      // whose frontmatter carries a priority, disk wins on every load, so the
      // click (which on a writing board meant "clear it") gets the sentence
      // naming who can, and no dead entry. See `foldRefusedPriority`.
      const fold = foldRefusedPriority(card.priority);
      if (fold.kind === "draft") draftPriority(card.slug, clicked);
      else priorityMsg = { slug: card.slug, ...stamp(fold.message, false) };
      return;
    }
    // A reload-worthy failure means THIS card's hash is dead, whatever else is
    // true: 409 says so outright, and a 404 naming the plan says the board is
    // describing a file that is not there any more.
    if (fail.reload) staleCards.add(card.slug);
    priorityMsg = { slug: card.slug, ...stamp(fail.message, fail.reload) };
  }

  /**
   * Write one plan's `plan_status` — the archive/restore control. It shares the
   * per-card lock with the priority writes ON PURPOSE: both edit the same file
   * under the same CAS base, so two concurrent writes on one card could only
   * 409 each other.
   */
  function writeStatus(slug: string, status: PlanStatus): void {
    if (reloading || staleCards.has(slug)) return;
    const card = cards.find((c) => c.slug === slug);
    if (!card || !admitPriorityEdit(priorityPending, slug)) return;
    priorityPending.add(slug);
    statusMsg = null;
    refreshDrawer(slug);

    const run = runStatusWrite(card, status).finally(() => {
      priorityPending.delete(slug);
      priorityInFlight.delete(slug);
      render();
      refreshDrawer(slug, `st-${status}`);
    });
    priorityInFlight.set(slug, run);
  }

  async function runStatusWrite(
    card: { slug: string; priority: PlanPriority | null; hash: string },
    status: PlanStatus,
  ): Promise<void> {
    const out = await postJson("/api/plans/status", statusRequest(card, status));
    if (out.ok) {
      const result = parseStatusResult(out.body);
      if (result) cards = applyStatusResult(cards, result, Date.now());
      else statusMsg = { slug: card.slug, ...stamp(transportFailure(BAD_BODY).message, true) };
      return;
    }
    const fail = classifyWriteFailure(out.status, out.body, "status");
    if (fail.kind === "readonly") {
      // No draft to fold into — a status draft would show a card in a column
      // mimir contradicts on every load — so the click becomes the sentence.
      flipReadonly();
      statusMsg = { slug: card.slug, ...stamp(fail.message, false) };
      return;
    }
    if (fail.reload) staleCards.add(card.slug);
    statusMsg = { slug: card.slug, ...stamp(fail.message, fail.reload) };
  }

  /**
   * Rank on the server, one write at a time.
   *
   * The chain is the point: each write's CAS base is the hash the PREVIOUS one
   * returned, so a queued move is computed only once the earlier one has landed
   * — from the ADOPTED order, not from the list the click saw. Sending both at
   * once would put the same base on two requests and the second could only 409.
   * The ▲▼ therefore stay live while a write runs; what a queued click must not
   * do is DISTURB the state the standing write left, which is why nothing is
   * cleared here.
   */
  function queueOrderWrite(slug: string, column: BoardColumnKey, delta: -1 | 1): void {
    bumpOrderPending(column, 1);
    render();
    orderChain = orderChain.then(async () => {
      try {
        await runOrderWrite(slug, column, delta);
      } catch (err) {
        const fail = transportFailure(err instanceof Error ? err.message : String(err));
        orderMsg = stamp(fail.message, fail.reload);
      } finally {
        bumpOrderPending(column, -1);
        render();
      }
    });
  }

  async function runOrderWrite(slug: string, column: BoardColumnKey, delta: -1 | 1): Promise<void> {
    // Two states a queued move must not run under: a 403 landed while it waited
    // (the board is readonly now), or an earlier write lost its CAS — the base
    // every queued move holds is gone too, so they would 409 in a row and bury
    // the reload the first one raised.
    //
    // A refresh in flight is deliberately NOT one of them. Every move in this
    // chain was clicked BEFORE the refresh started (`nudge` refuses once
    // `reloading` is set, and the buttons are disabled), its base is still the
    // current one, and the refresh WAITS for the chain — so letting it run
    // costs nothing and dropping it would silently eat a click the reader made.
    if (capability.orderMode !== "write") {
      // A 403 landed while this move waited its turn. The click is the reader's
      // and this board no longer writes, so it goes where the click that
      // DISCOVERED the refusal goes: into the draft. Dropping it here made the
      // first nudge after a flip land and the second vanish.
      draftNudge(slug, column, delta);
      return;
    }
    if (orderMsg?.reload) {
      // An earlier write lost its CAS base, so the base this move holds is gone
      // too. It cannot be sent, and it cannot be drafted either (this board
      // still writes), so the only honest thing left is to say it was dropped —
      // counted on the standing message, which is also what clears it.
      orderMsg = { ...orderMsg, queuedDropped: (orderMsg.queuedDropped ?? 0) + 1 };
      return;
    }
    const { order } = merged();
    const shown = order[column] ?? [];
    const next = nudgeRanked(shown, slug, delta);
    if (!next) return;
    const req = orderRequest(column, next, queue.hash);
    if (!req) return;

    // What this write is about to make durable that nobody asked for: the board
    // posts the column-filtered list, so a disk-ranked slug whose plan has moved
    // column is dropped by the same write — and the server cannot warn, because
    // every slug it received is a slug it knows.
    const label = columnMeta.get(column)?.label ?? column;
    const clientWarnings = prunedRankSlugs(queue.order[column] ?? [], shown).map((dropped) =>
      prunedRankWarning(dropped, label),
    );

    // The standing message is cleared HERE — at launch, by the write that is
    // replacing it — never at queue time, where it wiped a Reload the reader
    // had not pressed yet. The repaint is UNCONDITIONAL: hanging it off the
    // warnings meant a retracted failure banner stayed on screen for the whole
    // round trip, so a slow queue write showed a failure that had already been
    // withdrawn beside its own "saving…" marker.
    orderMsg = null;
    if (clientWarnings.length > 0) {
      orderWarnings = clientWarnings;
      orderWarningsAt = Date.now();
    }
    render();

    const out = await postJson("/api/plans/order", req);
    if (!out.ok) {
      const fail = classifyWriteFailure(out.status, out.body, "order");
      // The details belonged to a write that did not happen; leaving them under
      // an unrelated error reads as the failure's explanation.
      orderWarnings = [];
      if (fail.kind === "readonly") {
        flipReadonly();
        draftNudge(slug, column, delta);
        return;
      }
      orderMsg = stamp(fail.message, fail.reload);
      return;
    }
    const result = parseOrderResult(out.body);
    if (!result) {
      orderWarnings = [];
      orderMsg = stamp(BAD_BODY, true);
      return;
    }
    // The MERGED order, wholesale: it carries the columns this request did not
    // post, corpus-filtered exactly as the board filters them.
    queue = { order: result.order, hash: result.hash };
    orderWarnings = [
      ...clientWarnings,
      ...result.unknownColumns.map(unknownColumnWarning),
      ...result.warnings,
    ];
    orderWarningsAt = Date.now();
  }

  /** Everything currently writing. A refresh waits on this — that wait IS the
   *  generation guard: nothing can land after the GET is issued, because every
   *  control that could start one is disabled while `reloading`. */
  async function settleWrites(): Promise<void> {
    await Promise.allSettled([orderChain, ...priorityInFlight.values()]);
  }

  /** Refetch `GET /api/plans/board` and adopt it — the recovery a 409 offers.
   *  Not `location.reload()`: the reader's filters, sort and open drawer are
   *  view state worth keeping across a hash that went stale under them. */
  async function reloadBoard(): Promise<void> {
    if (reloading) return;
    reloading = true;
    reloadStartedAt = Date.now();
    render();
    if (view.openSlug) refreshDrawer(view.openSlug);
    try {
      await settleWrites();
      const fresh = parseBoardRefresh(
        await getJson<unknown>("/api/plans/board", { headers: { accept: "application/json" } }),
      );
      if (!fresh) {
        // Nothing was adopted: the parse either produced a whole board or none
        // of one, so the board on screen is still the board the writes agree
        // with.
        orderMsg = stamp("could not refresh — GET /api/plans/board did not answer with a board", true);
        return;
      }
      adoptPayload(fresh);
    } catch (err) {
      orderMsg = stamp(
        `could not refresh (${err instanceof Error ? err.message : String(err)})`,
        true,
      );
    } finally {
      reloading = false;
      render();
      if (view.openSlug) refreshDrawer(view.openSlug);
    }
  }

  /** Commit a parsed refresh. Every field comes off `parseBoardRefresh`, so
   *  there is no half-adopted state to reason about — and the messages are
   *  cleared only where they PREDATE the refresh. */
  function adoptPayload(fresh: BoardRefresh): void {
    cards = fresh.cards;
    queue = fresh.queue;
    payloadReadonly = fresh.readonly;
    capability = writeCapability({ readonly: fresh.readonly, queueHash: fresh.queue.hash });
    columnMeta = new Map(fresh.columns.map((c) => [c.key, c]));
    money = fresh.money;
    if (!money.available && view.sort === "cost") view.sort = "rank";
    saveOverlay();
    // Every card's hash was just replaced, so no card is known-stale any more.
    staleCards.clear();
    if (priorityMsg && priorityMsg.at < reloadStartedAt) priorityMsg = null;
    if (statusMsg && statusMsg.at < reloadStartedAt) statusMsg = null;
    if (orderMsg && orderMsg.at < reloadStartedAt) orderMsg = null;
    if (orderWarningsAt < reloadStartedAt) orderWarnings = [];
  }

  /** The message block a failed (or stale) write leaves on its surface. Used by
   *  the DRAWER, which is rebuilt wholesale per open — the board-level one is
   *  the persistent live region below, because that node survives every render
   *  and re-announcing an unchanged sentence on each keystroke is noise. */
  function writeMessage(msg: WriteMessage): HTMLElement {
    const box = el("div", "pb-wmsg");
    box.setAttribute("role", "status");
    box.append(el("span", null, msg.text));
    if (msg.reload) box.append(reloadButton());
    return box;
  }

  function reloadButton(): HTMLButtonElement {
    const b = el("button", "pb-reload", reloading ? "Reloading…" : "Reload") as HTMLButtonElement;
    b.type = "button";
    b.disabled = reloading;
    b.onclick = () => void reloadBoard();
    return b;
  }

  /**
   * The board-level order message: ONE node, created at mount and updated in
   * place.
   *
   * It carries `role="status"`, so rebuilding it per render re-announced the
   * same sentence every time anything on the board changed — including every
   * keystroke in the search box. Its text is written only when it differs, and
   * the whole banner is hidden rather than removed, so the live region stays in
   * the document and an unchanged message stays silent.
   */
  const orderMsgBanner = el("div", "pb-banner pb-banner-bad");
  const orderMsgBox = el("div", "pb-wmsg");
  orderMsgBox.setAttribute("role", "status");
  const orderMsgText = el("span");
  orderMsgBox.append(orderMsgText);
  orderMsgBanner.append(orderMsgBox);
  orderMsgBanner.hidden = true;
  /** Ephemeral banners above it, dropped details below — the message node sits
   *  between them and is never cleared with them. */
  const noticeBanners = el("div", "pb-notice-part");
  const noticeDetails = el("div", "pb-notice-part");
  noticeBox.append(noticeBanners, orderMsgBanner, noticeDetails);

  function renderOrderMsg(): void {
    if (!orderMsg) {
      orderMsgBanner.hidden = true;
      if (orderMsgText.textContent !== "") orderMsgText.textContent = "";
      const stale = orderMsgBox.querySelector("button.pb-reload");
      if (stale) stale.remove();
      return;
    }
    orderMsgBanner.hidden = false;
    // The dropped-move note rides the same sentence rather than a node of its
    // own: it only ever exists under a standing failure, and one live region is
    // one announcement.
    const dropped = queuedMovesDroppedNote(orderMsg.queuedDropped ?? 0);
    const text = dropped ? `${orderMsg.text} · ${dropped}` : orderMsg.text;
    if (orderMsgText.textContent !== text) orderMsgText.textContent = text;
    const existing = orderMsgBox.querySelector<HTMLButtonElement>("button.pb-reload");
    if (!orderMsg.reload) {
      existing?.remove();
      return;
    }
    // The button's own state does change per render (a refresh in flight
    // disables it), so it is updated rather than replaced — replacing it would
    // take focus off the very control the reader just pressed.
    if (existing) {
      existing.disabled = reloading;
      existing.textContent = reloading ? "Reloading…" : "Reload";
      return;
    }
    orderMsgBox.append(reloadButton());
  }

  /**
   * The board-level notice strip: why this instance cannot write, why ranking
   * is off, what the last order write failed on, and anything the merge dropped.
   *
   * The readonly banner is rendered here ONLY for a mid-session flip. A payload
   * that already said readonly has the masthead state it (from the same
   * capability, through the same `writeModeSentence`), and rendering both put
   * the identical sentence on screen twice.
   */
  function renderNotice(): void {
    noticeBanners.textContent = "";
    if (capability.readonly && !payloadReadonly) {
      noticeBanners.append(el("div", "pb-banner pb-banner-warn", PLAN_READONLY_NOTE));
    }
    if (capability.orderMode === "off" && capability.orderOffReason) {
      noticeBanners.append(el("div", "pb-banner pb-banner-warn", capability.orderOffReason));
    }
    renderOrderMsg();
    noticeDetails.textContent = "";
    if (orderWarnings.length > 0) {
      // Non-modal on purpose: every one of these is a DURABLE drop the write
      // just made (a retired slug, a hand-written comment serialization cannot
      // keep) — worth reading, never worth blocking the next nudge on.
      const box = el("details", "pb-banner pb-banner-note");
      const sum = el("summary", null, `${orderWarnings.length} queue entr${orderWarnings.length === 1 ? "y" : "ies"} the write dropped`);
      box.append(sum);
      const list = el("ul");
      for (const w of orderWarnings) list.append(el("li", null, w));
      box.append(list);
      noticeDetails.append(box);
    }
  }

  /** The masthead's write-mode sentence, re-stated from the CURRENT capability.
   *  Server-rendered first (so a no-JavaScript reader gets it) and replaced on
   *  every render, because a 403 flip and a queue that cannot be read both make
   *  the sentence the server sent untrue. */
  function renderMode(): void {
    if (!modeBox) return;
    const sentence = writeModeSentence(capability);
    if (modeBox.textContent !== sentence) modeBox.textContent = sentence;
  }

  // ---------------------------------------------------------------- meters
  /**
   * The meter strip.
   *
   * **Every COUNT is over the cards this scope actually renders** — the strip
   * used to count the filtered corpus, so under `Active` the "of N"
   * denominator and the follow-ups tile described columns that were not on
   * screen. What each tile means, one line each:
   *
   *   - **Active plans** — active cards visible now, of all cards visible now.
   *   - **In flight** — visible cards in the in-flight column (an active
   *     column, so it is in every scope).
   *   - **Backlog, priced** — visible active cards carrying an estimate.
   *   - **Spent to date** — deliberately CORPUS-WIDE (over the filtered cards,
   *     every scope): it is the context the estimates are read against, not a
   *     count of what is on screen, and it would otherwise read `$0` under the
   *     default scope, which shows no terminal column at all. The note says so.
   *   - **Median age** — visible active cards that carry a `status_date`.
   *   - **Follow-ups open** — visible follow-up cards; `—`, never `0`, in a
   *     scope with no follow-ups column, because absent is not zero.
   */
  function renderMeters(shown: readonly EffectiveCard[]): void {
    const inScope = cardsInScope(shown, view.scope);
    const m = computeMeters(inScope, money.available);
    const corpus = computeMeters(shown, money.available);
    const showsFollowups = visibleColumns(view.scope).some((c) => c.key === "followups");
    metersBox.textContent = "";
    const tiles: Array<{ k: string; v: string; sub?: string; note: string }> = [
      {
        k: "Active plans",
        v: String(m.activeCount),
        // Under the default scope every shown card IS active, so "N of N" would be a tautology;
        // the corpus size is the denominator that carries information there.
        sub: view.scope === "active" ? `of ${corpus.totalCount} in the corpus` : `of ${m.totalCount} shown`,
        note: `proposed · ready · in flight · blocked — ${view.scope === "active" ? `the whole corpus holds ${corpus.totalCount} card(s)` : `of the ${m.totalCount} card(s) this scope shows`}`,
      },
      {
        k: "In flight",
        v: String(m.inFlightCount),
        note: m.inFlightCount ? "running right now" : "nothing running",
      },
      {
        k: "Backlog, priced",
        v: m.backlog ? formatUsd(m.backlog.mid) : "—",
        note: m.backlog
          ? `${formatUsd(m.backlog.low)}–${formatUsd(m.backlog.high)} band over the ${m.backlog.count} active plan(s) that can be priced`
          : money.reason ?? "no estimate available",
      },
      {
        k: "Spent to date",
        v: corpus.spentToDate !== null ? formatUsd(corpus.spentToDate) : "—",
        note:
          corpus.spentToDate !== null
            ? "recorded cost of every shipped plan — all scopes, not just the columns shown"
            : "the ledger is not answering",
      },
      {
        k: "Median age",
        v: m.medianAgeDays !== null ? String(m.medianAgeDays) : "—",
        sub: m.medianAgeDays !== null ? "days" : undefined,
        note: "since the last status_date on an active plan",
      },
      {
        k: "Follow-ups open",
        v: showsFollowups ? String(m.followupsCount) : "—",
        note: showsFollowups
          ? "shipped, but the plan still carries followups: open"
          : "no follow-ups column in this scope — switch to “+ Follow-ups”",
      },
    ];
    for (const t of tiles) {
      const tile = el("div", "pb-meter");
      tile.append(el("div", "pb-k", t.k));
      const v = el("div", "pb-v");
      v.append(document.createTextNode(t.v));
      if (t.sub) v.append(el("small", null, t.sub));
      tile.append(v, el("div", "pb-n", t.note));
      metersBox.append(tile);
    }
  }

  // ---------------------------------------------------------------- controls
  function renderControls(cards: readonly EffectiveCard[]): void {
    controlsBox.textContent = "";

    const scopes: Array<[BoardScope, string]> = [
      ["active", "Active"],
      ["followups", "+ Follow-ups"],
      ["all", "Everything"],
    ];
    controlsBox.append(
      segment("Show", scopes, view.scope, (k) => {
        view.scope = k;
        render();
      }),
    );

    const famBox = el("div", "pb-ctl");
    famBox.append(el("span", "pb-lab", "Repo"));
    const chips = el("div", "pb-chips");
    const visible = new Set(visibleColumns(view.scope).map((c) => c.key));
    const counts = familyCounts(cards.filter((c) => visible.has(c.column)));
    // A selected family with no chip in the current scope still gets one, at
    // count 0. Without it, narrowing the scope deletes the very control that
    // is emptying the board — the facet rule the wiki reader learned the hard
    // way (`facetKeys`): a control may never remove its own active value.
    for (const family of view.filters.families) {
      if (!counts.some((c) => c.family === family)) counts.push({ family, count: 0 });
    }
    for (const { family, count } of counts) {
      const b = el("button", "pb-chip") as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `repo:${family}`;
      b.append(document.createTextNode(family), el("span", "pb-c", String(count)));
      b.setAttribute("aria-pressed", String(view.filters.families.includes(family)));
      if (count === 0) b.title = `no ${family} plan in this scope — click to clear the filter`;
      b.onclick = () => {
        const on = view.filters.families.includes(family);
        view.filters = {
          ...view.filters,
          families: on
            ? view.filters.families.filter((f) => f !== family)
            : [...view.filters.families, family],
        };
        render();
      };
      chips.append(b);
    }
    famBox.append(chips);
    controlsBox.append(famBox);

    const priBox = el("div", "pb-ctl");
    priBox.append(el("span", "pb-lab", "Priority"));
    const pchips = el("div", "pb-chips");
    for (const p of [...BOARD_PRIORITIES, "unset"] as Array<PlanPriority | "unset">) {
      const b = el("button", "pb-chip", p) as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `pri:${p}`;
      b.setAttribute("aria-pressed", String(view.filters.priority === p));
      b.onclick = () => {
        view.filters = { ...view.filters, priority: view.filters.priority === p ? null : p };
        render();
      };
      pchips.append(b);
    }
    priBox.append(pchips);
    controlsBox.append(priBox);

    const sorts: Array<[BoardSort, string]> = [
      ["rank", "My order"],
      ["age", "Age"],
      ["priority", "Priority"],
      ["cost", "Cost"],
    ];
    // With no money there is nothing to sort by: every card's cost is hidden,
    // so a live Cost button can only reshuffle the board into an order the
    // reader cannot see the reason for. Disabled, carrying the reason.
    const disabledSorts = money.available
      ? undefined
      : new Map<BoardSort, string>([
          ["cost", money.reason ?? "no cost on this board — the ledger is not answering"],
        ]);
    controlsBox.append(
      segment(
        "Sort",
        sorts,
        view.sort,
        (k) => {
          view.sort = k;
          render();
        },
        disabledSorts,
      ),
    );

    const search = document.createElement("input");
    search.type = "search";
    search.className = "pb-search";
    search.dataset.key = "search";
    search.placeholder = "Filter by title, slug or tag";
    search.value = view.filters.query;
    search.setAttribute("aria-label", "Filter plans");
    // Typing re-renders the board and the meters but NOT the controls: replacing
    // the input under the caret is how a search box loses focus mid-word.
    search.oninput = () => {
      view.filters = { ...view.filters, query: search.value };
      const { cards: all, order, draftCols, diskCols } = merged();
      const shown = filterCards(all, view.filters);
      renderMeters(shown);
      renderBoard(shown, order, draftCols, diskCols);
      syncUrl();
    };
    controlsBox.append(search);
  }

  function segment<T extends string>(
    label: string,
    options: Array<[T, string]>,
    active: T,
    onPick: (value: T) => void,
    disabled?: Map<T, string>,
  ): HTMLElement {
    const box = el("div", "pb-ctl");
    box.append(el("span", "pb-lab", label));
    const seg = el("div", "pb-seg");
    for (const [key, text] of options) {
      const b = el("button", null, text) as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `${label}:${key}`;
      b.setAttribute("aria-pressed", String(active === key));
      const why = disabled?.get(key);
      if (why) {
        b.disabled = true;
        b.title = why;
      }
      b.onclick = () => onPick(key);
      seg.append(b);
    }
    box.append(seg);
    return box;
  }

  // ---------------------------------------------------------------- board
  function renderBoard(
    shown: readonly EffectiveCard[],
    order: BoardOrder,
    draftCols: Set<string>,
    diskCols: Set<string>,
  ): void {
    // A nudge rebuilds every column, and a rebuilt `.pb-stack` starts at
    // scrollTop 0 — measured twice per nudge, which throws a reader ranking the
    // 30th card in a column back to the top of it. Captured by column key, the
    // `renderList` precedent.
    const scrollTops = new Map<string, number>();
    boardBox.querySelectorAll<HTMLElement>(".pb-col").forEach((node) => {
      const key = node.dataset.col;
      const stack = node.querySelector<HTMLElement>(".pb-stack");
      if (key && stack && stack.scrollTop > 0) scrollTops.set(key, stack.scrollTop);
    });
    boardBox.textContent = "";
    for (const col of visibleColumns(view.scope)) {
      const inColumn = sortCards(
        shown.filter((c) => c.column === col.key),
        view.sort,
        order[col.key] ?? [],
      );
      const box = el("div", "pb-col");
      box.dataset.col = col.key;
      box.style.setProperty("--pb-tone", `var(${col.tone})`);

      const head = el("div", "pb-head");
      head.title = col.hint;
      head.append(el("span", "pb-swatch"), el("span", "pb-name", col.label));
      if (money.available) {
        const sum = inColumn.reduce(
          (s, c) =>
            s + (fin(isTerminalColumn(c.column) ? c.ledger?.costUSD : c.estimate?.mid) ?? 0),
          0,
        );
        head.append(el("span", "pb-money", inColumn.length ? formatUsd(sum) : ""));
      }
      if (draftCols.has(col.key) && showRankUi(view.sort)) {
        head.append(el("span", "pb-draft-pill", "draft order"));
      }
      // Per column, and NOT a disabled control: the reader keeps clicking, the
      // clicks queue on the write chain, and this says which column is still
      // catching up.
      if (orderBusy(col.key)) {
        const saving = el("span", "pb-saving", COLUMN_SAVING);
        saving.title = "the previous move is still being written to plans/queue.yaml";
        head.append(saving);
      }
      head.append(el("span", "pb-count", String(inColumn.length)));
      box.append(head);

      const stack = el("div", "pb-stack");
      if (inColumn.length === 0) stack.append(el("div", "pb-empty", "nothing here"));
      // A nudge edits the column's RANKED LIST — the prefix someone actually
      // placed — never the displayed column and never the filtered view. Every
      // position in it is explicit, so a repo filter or a search cannot change
      // what ▲▼ does, and ranking one card ranks exactly one card.
      const ranked = order[col.key] ?? [];
      for (const card of inColumn) {
        stack.append(renderCard(card, col, order, ranked, diskCols.has(col.key)));
      }
      box.append(stack);
      boardBox.append(box);
      const top = scrollTops.get(col.key);
      if (top) stack.scrollTop = top;
    }
  }

  function renderCard(
    card: EffectiveCard,
    col: BoardColumnMeta,
    order: BoardOrder,
    ranked: readonly string[],
    diskRanked: boolean,
  ): HTMLElement {
    const wrap = el("div", "pb-cardwrap");
    wrap.dataset.slug = card.slug;

    const button = el("button", "pb-card") as HTMLButtonElement;
    button.type = "button";
    button.dataset.slug = card.slug;
    if (view.openSlug === card.slug) button.classList.add("pb-sel");

    const r1 = el("div", "pb-r1");
    const rank = rankOf(order, col.key, card.slug);
    if (rank >= 0 && showRankUi(view.sort)) r1.append(el("span", "pb-rank", `#${rank + 1}`));
    const pill = el(
      "span",
      `pb-pri${card.effectivePriority ? "" : " pb-pri-unset"}${card.priorityIsDraft ? " pb-pri-draft" : ""}`,
      card.effectivePriority ?? "—",
    );
    if (card.effectivePriority) {
      pill.style.setProperty("--pb-pri-color", `var(--pb-${card.effectivePriority})`);
    }
    if (card.priorityIsDraft) pill.title = "Draft — not saved to mimir yet";
    r1.append(pill);
    const fam = el("span", `pb-fam${card.familyConfident ? "" : " pb-fam-soft"}`, card.family);
    // Three-way, exactly as the drawer's basis line reads it — "guessed from
    // the slug" over a family nothing attributed at all is a claim the board
    // did not make.
    fam.title =
      card.familySource === "prs"
        ? "family from the PRs this plan landed"
        : card.familySource === "slug"
          ? "family guessed from the slug"
          : "not attributable — no PRs in the ledger and nothing in the slug";
    r1.append(fam);
    if (card.mixedRepos) r1.append(el("span", "pb-fam pb-fam-soft", "mixed"));
    if (card.followupsOpen && card.column !== "followups") {
      const flag = el("span", "pb-flag", "⚑");
      flag.title = "followups: open";
      r1.append(flag);
    }
    button.append(r1);

    button.append(el("div", "pb-title", card.title));
    // 91 of mimir's 185 plans carry no title, so the store falls back to the
    // slug — printing it twice is noise on half the board.
    if (card.title !== card.slug) button.append(el("div", "pb-slug", card.slug));

    const r2 = el("div", "pb-r2");
    if (money.available) {
      if (isTerminalColumn(card.column) && card.ledger) {
        const landed = fin(card.ledger.landed) ?? 0;
        r2.append(el("span", "pb-est", `${formatUsd(card.ledger.costUSD)} · ${landed} PR${landed === 1 ? "" : "s"}`));
      } else if (isTerminalColumn(card.column)) {
        // A terminal card with no ledger row has no SPEND, and the column
        // header sums actuals only — so the card says "—" too, and the
        // estimate rides along muted and labelled. Rendering the band here
        // unlabelled read as money that was spent.
        const dash = el("span", "pb-est pb-est-guess", "—");
        dash.title = "no ledger row in claude-usage for this plan — nothing recorded to sum";
        r2.append(dash);
        if (fin(card.estimate?.mid) !== null) {
          r2.append(
            el("span", "pb-prs pb-prs-guess", `est ${formatUsd(card.estimate?.mid)} · no ledger row`),
          );
        }
      } else if (fin(card.estimate?.mid) !== null) {
        const e = card.estimate!;
        const est = el(
          "span",
          `pb-est${e.assumedCount ? " pb-est-guess" : ""}`,
          `${formatUsd(e.low)}–${formatUsd(e.high)} · ${formatUsd(e.mid)}`,
        );
        est.title = `Band from ${numText(e.sampleSize)} shipped plans in ${strText(e.poolKey, "comparable plans")}`;
        r2.append(est);
        r2.append(
          el(
            "span",
            e.assumedCount ? "pb-prs pb-prs-guess" : "pb-prs",
            `${numText(e.prCount)} PR${e.prCount === 1 ? "" : "s"}${e.assumedCount ? "?" : ""}`,
          ),
        );
      }
    }
    const age = el("span", "pb-age", formatAge(card.ageDays));
    if (card.statusDate) age.title = `status_date ${card.statusDate}`;
    r2.append(age);
    button.append(r2);

    button.onclick = () => openDrawer(card, button);
    wrap.append(button);

    const link = openLink(card.wikiUrl, `Open ${card.title} in the mimir reader`);
    link.className = "pb-open";
    wrap.append(link);

    // The nudges are ALWAYS rendered, disabled where they cannot act, and the
    // tooltip says which reason applies — off-sort, a terminal column, a
    // readonly instance, an unreadable queue, or a write still in flight. A
    // control that vanishes reads as a board that lost the ability to rank.
    const nudges = el("div", "pb-nudge");
    const rankUi = showRankUi(view.sort);
    const isRanked = ranked.includes(card.slug);
    const blockedReason = nudgeBlockedReason({
      rankUi,
      column: col.key,
      capability,
      diskRanked,
      // A write in flight is NOT a block (see the module doc): the click queues
      // on the chain. A board known to be out of date is.
      reloadPending: orderMsg?.reload === true,
      reloading,
    });
    for (const [delta, glyph, word] of [
      [-1, "▲", "up"],
      [1, "▼", "down"],
    ] as Array<[-1 | 1, string, string]>) {
      const b = el("button", null, glyph) as HTMLButtonElement;
      b.type = "button";
      // The pair that survives the rebuild a nudge causes — see
      // `restoreNudgeFocus`. `data-key` is the controls' namespace; these are
      // per-card, so they carry their own.
      b.dataset.slug = card.slug;
      b.dataset.dir = delta === -1 ? "up" : "down";
      b.disabled = blockedReason !== null || !canNudge(ranked, card.slug, delta);
      // The action is stated, not the direction: ▲ on an unranked card RANKS
      // it, and ▼ on the last ranked card un-ranks it.
      const action = !isRanked
        ? delta === -1
          ? `Rank in ${col.label}`
          : `Not ranked in ${col.label}`
        : delta === 1 && ranked[ranked.length - 1] === card.slug
          ? `Un-rank in ${col.label}`
          : `Move ${word} in ${col.label}`;
      b.title = blockedReason ?? action;
      b.setAttribute("aria-label", `${action}: ${card.title}`);
      b.onclick = (ev) => {
        ev.stopPropagation();
        nudge(card.slug, col.key, delta);
      };
      nudges.append(b);
    }
    wrap.append(nudges);
    return wrap;
  }

  /**
   * The open-the-plan link. Its own anchor rather than a click handler, so
   * cmd-click and middle-click open a tab the way every other link does — and
   * it stops the click from reaching the card, whose body means "open the
   * drawer" (settled by the prototype).
   */
  function openLink(href: string, title: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.href = href;
    a.title = title;
    // Prototype parity, and the reason for it: the board is a place someone
    // works THROUGH — opening a plan must not replace the filtered board they
    // spent the last minute building.
    a.target = "_blank";
    a.rel = "noopener";
    a.setAttribute("aria-label", title);
    a.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-3"/>' +
      '<path d="M9.5 2.5H14v4.5"/><path d="M7 9l6.5-6.5"/></svg>';
    a.onclick = (ev) => ev.stopPropagation();
    return a;
  }

  /**
   * Rank a card by hand — the ranked PREFIX is what is written, never the
   * displayed column: ranking one card must leave the other 48 unranked, and
   * a filter that hides half the column cannot change what the move means.
   *
   * An emptied list DELETES the column's entry rather than storing `[]`: an
   * empty order is the same statement as no order ("nothing here is
   * hand-ranked"), and keeping it would make the column read as drafted.
   *
   * **What is written is the MERGED list, not the stored one.** `ranked` comes
   * from `applyOverlay`, which filters a column's order to the slugs actually
   * in that column right now — so a nudge rewrites the column's draft as
   * "these cards, in this order", and any slug that has moved column or left
   * the corpus is pruned by the same write. That is the intended behaviour:
   * the reader ranks what they can see, and a dead slug holding position #1
   * pushes every real badge down by one.
   *
   * On a writing board this goes to `/api/plans/order`; on the readonly one it
   * writes the draft, which is the same move against a different destination.
   */
  function nudge(slug: string, column: BoardColumnKey, delta: -1 | 1): void {
    if (reloading) return;
    if (capability.orderMode === "write") {
      if (orderMsg?.reload) return;
      queueOrderWrite(slug, column, delta);
      return;
    }
    draftNudge(slug, column, delta);
  }

  /**
   * The draft half of a nudge — the readonly board's ranking, and where a
   * refused (403) write's click lands so it is not simply lost.
   *
   * Recomputed from `merged()` rather than from the list the click was rendered
   * with, because the 403 path has no such list: it is running inside the write
   * that just failed.
   */
  function draftNudge(slug: string, column: BoardColumnKey, delta: -1 | 1): void {
    if (capability.orderMode !== "draft") return;
    const { order, diskCols } = merged();
    // The overlay never overwrites a column queue.yaml already ranks — that
    // draft would lose silently on the next load.
    if (diskCols.has(column)) return;
    const next = nudgeRanked(order[column] ?? [], slug, delta);
    if (!next) return;
    const nextOrder = { ...overlay.order };
    if (next.length === 0) delete nextOrder[column];
    else nextOrder[column] = next;
    overlay = { priority: { ...overlay.priority }, order: nextOrder };
    saveOverlay();
    render();
  }

  // ---------------------------------------------------------------- drawer

  /** The card button the drawer was opened from — focus goes back to it on
   *  close, so Escape leaves the keyboard where it was, not at `<body>`. */
  let drawerOpener: HTMLElement | null = null;

  /**
   * Rebuild the open drawer from the freshest card — every write changes the
   * card underneath it (priority, hash, and after a reload the whole payload).
   * A no-op when the drawer is closed or showing another plan, so a response
   * that lands after the reader moved on cannot paint into someone else's
   * panel; `focusKey` puts the keyboard back on the button that was pressed.
   */
  function refreshDrawer(slug: string, focusKey?: string): void {
    if (view.openSlug !== slug) return;
    const fresh = merged().cards.find((c) => c.slug === slug);
    if (!fresh) {
      closeDrawer();
      return;
    }
    openDrawer(fresh);
    if (focusKey) {
      root
        .querySelector<HTMLElement>(`.pb-drawer .pb-priset button[data-key="${focusKey}"]`)
        ?.focus();
    }
  }

  /**
   * Open the drawer, and never leave the board mid-open if that fails.
   *
   * The panel is torn down before the new one is built and `view.openSlug` is
   * set before either — so a throw anywhere in the build left the reader with
   * no drawer, a card marked selected, possibly an inert board, and a click
   * handler that could only throw again: the card was dead until a page reload
   * (measured on a refresh whose `ledger.activeHours` was absent). Every leaf
   * that could throw is now read through {@link fin}/{@link numText}, so this is
   * a backstop rather than the fix — but a backstop is exactly what the state
   * mutation before the build calls for.
   */
  function openDrawer(card: EffectiveCard, opener?: HTMLElement | null): void {
    const restoreTo = opener ?? drawerOpener;
    closeDrawer({ silent: true });
    drawerOpener = restoreTo ?? null;
    view.openSlug = card.slug;
    try {
      mountDrawer(card);
    } catch (err) {
      root.querySelectorAll(".pb-scrim,.pb-drawer").forEach((n) => n.remove());
      document.removeEventListener("keydown", escClose);
      setBackdropInert(false);
      view.openSlug = null;
      // The one-line message loses the stack; keep it for whoever debugs this.
      console.error("plan board: drawer render failed", err);
      restoreTo?.focus?.();
      drawerOpener = null;
      // Reload-worthy: the only thing that can put a payload this board cannot
      // render right is a fresh one, and the message must not be a dead end.
      orderMsg = stamp(
        `could not open ${card.slug} (${err instanceof Error ? err.message : String(err)})`,
        true,
      );
      render();
    }
  }

  function mountDrawer(card: EffectiveCard): void {
    const scrim = el("div", "pb-scrim");
    scrim.onclick = () => closeDrawer();
    const drawer = el("aside", "pb-drawer");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", card.title);
    // Focusable so the panel itself can hold focus — a dialog whose focus is
    // still on the card behind the scrim tabs into a board the reader cannot
    // see and cannot click.
    drawer.tabIndex = -1;
    const col = columnMeta.get(card.column);
    if (col) drawer.style.setProperty("--pb-tone", `var(${col.tone})`);

    const head = el("div", "pb-dh");
    const titleBox = el("div");
    titleBox.append(el("h2", null, card.title));
    const sub = el("div", "pb-r2");
    sub.append(el("span", "pb-fam", card.family), el("span", "pb-slug", card.slug));
    sub.append(el("span", "pb-est", col?.label ?? card.column));
    sub.append(el("span", "pb-age", card.statusDate ? `since ${card.statusDate}` : "no status_date"));
    titleBox.append(sub);
    const acts = el("div", "pb-acts");
    const big = openLink(card.wikiUrl, `Open ${card.relPath} in the mimir reader`);
    big.className = "pb-openbig";
    big.append(document.createTextNode("Open plan"));
    const close = el("button", "pb-x", "Close") as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => closeDrawer();
    acts.append(big, close);
    head.append(titleBox, acts);

    const body = el("div", "pb-db");
    if (card.description) body.append(el("p", "pb-desc", card.description));
    if (card.statusNote) {
      const s = el("div", "pb-sec");
      s.append(el("h3", null, "Status note"), el("div", "pb-note", card.statusNote));
      body.append(s);
    }
    if (card.tags.length) {
      const s = el("div", "pb-sec");
      s.append(el("h3", null, "Tags"));
      const list = el("div", "pb-chips");
      for (const tag of card.tags) list.append(el("span", "pb-chip pb-chip-static", tag));
      s.append(list);
      body.append(s);
    }

    body.append(estimateSection(card));
    if (card.ledger) {
      body.append(ledgerSection(card));
    } else if (money.available && isTerminalColumn(card.column)) {
      // Terminal and unrecorded: say so under the same heading the recorded
      // ones use, so the card, the drawer and the column total tell one story
      // (the header sums actuals, and this plan contributes none).
      const s = el("div", "pb-sec");
      s.append(
        el("h3", null, "What it actually cost"),
        el(
          "p",
          "pb-basis",
          "No ledger row — claude-usage has nothing recorded against this plan, so it adds nothing to the column's total.",
        ),
      );
      body.append(s);
    }
    body.append(prioritySection(card));
    const archive = archiveSection(card);
    if (archive) body.append(archive);

    const fileSec = el("div", "pb-sec");
    fileSec.append(el("h3", null, "File"));
    const fileRow = el("div", "pb-filerow");
    const fileLink = document.createElement("a");
    fileLink.className = "pb-filelink";
    fileLink.href = card.wikiUrl;
    fileLink.target = "_blank";
    fileLink.rel = "noopener";
    fileLink.textContent = card.relPath;
    fileRow.append(fileLink, copyPathButton(card.relPath));
    fileSec.append(fileRow);
    fileSec.append(
      el(
        "p",
        "pb-basis",
        `Family ${card.family} — ${card.familySource === "prs" ? "by the PRs it landed" : card.familySource === "slug" ? "by its slug" : "not attributable"}${card.mixedRepos ? ", PRs span more than one repo" : ""}.`,
      ),
    );
    body.append(fileSec);

    drawer.append(head, body);
    // Mounted INSIDE `#pbRoot`, not on `<body>`: every `--pb-*` token is
    // defined on `.pb`, so a drawer outside it renders with each of them
    // undefined — which is how the selected priority button lost its fill in
    // light theme and the status note lost its coloured spine.
    root.append(scrim, drawer);
    document.addEventListener("keydown", escClose);
    // `aria-modal="true"` is a CLAIM, and these two are what make it true: the
    // scrim stops the pointer, `inert` stops the tab order and the screen
    // reader from reaching the board underneath, and the Tab handler wraps
    // within the panel so the keyboard cannot walk out of it either.
    drawer.addEventListener("keydown", trapDrawerTab);
    setBackdropInert(true);
    // Selection is a one-class change on two buttons, NOT a re-render: a full
    // render rebuilds every card, which throws away the focus the drawer just
    // took and the caret in the search box.
    markSelected(card.slug);
    drawer.focus();
  }

  /** Paint the `pb-sel` ring without touching the rest of the board. */
  function markSelected(slug: string | null): void {
    boardBox.querySelectorAll<HTMLElement>(".pb-card").forEach((b) => {
      b.classList.toggle("pb-sel", slug !== null && b.dataset.slug === slug);
    });
  }

  function estimateSection(card: EffectiveCard): HTMLElement {
    const terminal = isTerminalColumn(card.column);
    const sec = el("div", "pb-sec");
    // On a terminal card this section is the PREDICTION, not the spend — the
    // actuals live under "What it actually cost" below it. Heading it "What it
    // cost" put an estimate under the one word that means money that left.
    sec.append(el("h3", null, terminal ? "What the model would have estimated" : "What it should cost"));
    if (!money.available || !card.estimate || fin(card.estimate.mid) === null) {
      sec.append(
        el("p", "pb-basis", money.reason ?? "No shipped plan in the ledger prices this one yet."),
      );
      return sec;
    }
    const e = card.estimate;
    const perPrQ = e.dollarsPerPR && typeof e.dollarsPerPR === "object" ? e.dollarsPerPR : null;
    const kv = el("div", "pb-kv");
    const cell = (k: string, v: string) => {
      const c = el("div");
      c.append(el("div", "pb-k", k), el("div", "pb-v", v));
      return c;
    };
    kv.append(
      cell("Estimate", formatUsd(e.mid)),
      cell("Band", `${formatUsd(e.low)}–${formatUsd(e.high)}`),
      cell("PRs", `${numText(e.prCount)}${e.assumedCount ? "?" : ""}`),
      cell("$/PR", perPrQ ? formatUsd(perPrQ.p50) : "—"),
    );
    sec.append(kv);
    const quartiles = [perPrQ?.p25, perPrQ?.p50, perPrQ?.p75].map(fin);
    const perPr = quartiles.every((q) => q !== null)
      ? quartiles.map((q) => `$${Math.round(q!)}`).join("/")
      : "—";
    sec.append(
      el(
        "p",
        "pb-basis",
        `Priced off ${numText(e.sampleSize)} ${strText(e.poolKey, "comparable")} plans at ${perPr} per PR × ${numText(e.prCount)} PRs.` +
          (e.assumedCount
            ? " This plan declares no PR slate, so the count is the pool's median — treat the number as an order of magnitude."
            : ""),
      ),
    );
    return sec;
  }

  /**
   * A URL we are willing to put in an `href`. The ledger's `url` is a string
   * from another service's JSON, and an anchor is the one sink where that
   * matters — `javascript:` and `data:` both execute on click. Anything that
   * is not http(s) falls through to the plain-span branch this function's
   * caller already has for a PR with no URL at all.
   */
  function httpUrl(raw: string | null): string | null {
    if (!raw) return null;
    try {
      const u = new URL(raw, location.origin);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  }

  function ledgerSection(card: EffectiveCard): HTMLElement {
    const facts = card.ledger!;
    const sec = el("div", "pb-sec");
    sec.append(el("h3", null, "What it actually cost"));
    // A ledger row exists for every plan claude-usage has ever seen, including
    // the ones it has recorded NOTHING about. Six "—" cells under "what it
    // actually cost" read as data that failed to load; one sentence says the
    // true thing.
    const recorded =
      (fin(facts.landed) ?? 0) > 0 || (fin(facts.costUSD) ?? 0) > 0 || (fin(facts.sessions) ?? 0) > 0;
    if (!recorded) {
      sec.append(
        el("p", "pb-basis", "Nothing recorded yet — no session, no cost and no landed PR against this plan."),
      );
      return sec;
    }
    const kv = el("div", "pb-kv");
    const cell = (k: string, v: string) => {
      const c = el("div");
      c.append(el("div", "pb-k", k), el("div", "pb-v", v));
      return c;
    };
    kv.append(
      cell("Cost", formatUsd(facts.costUSD)),
      cell("PRs landed", numText(facts.landed)),
      cell("Active hours", numText(facts.activeHours, (n) => n.toFixed(1))),
      cell("Findings", numText(facts.findings)),
      cell("Max rounds", numText(facts.maxRounds)),
      cell("Sessions", numText(facts.sessions)),
    );
    sec.append(kv);
    const prs = Array.isArray(facts.prs) ? facts.prs : [];
    if (prs.length) {
      const list = el("div", "pb-prlist");
      for (const pr of prs.slice(0, 40)) {
        if (!pr || typeof pr !== "object") continue;
        const label = `#${fin(pr.number) ?? "?"}`;
        let node: HTMLElement;
        const href = httpUrl(typeof pr.url === "string" ? pr.url : null);
        if (href) {
          const a = document.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = label;
          node = a;
        } else {
          node = el("span", null, label);
        }
        if (pr.reviewed === false) node.classList.add("pb-unrev");
        node.title = [
          typeof pr.repo === "string" ? pr.repo : null,
          typeof pr.mergedAt === "string" ? pr.mergedAt.slice(0, 10) : null,
          pr.reviewed === false ? "no review recorded" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        list.append(node);
      }
      sec.append(list);
    }
    return sec;
  }

  /**
   * The drawer's priority editor — the one surface that writes a plan's
   * frontmatter.
   *
   * On a writing board every level is live whatever is on disk, and clicking
   * the one already set CLEARS it; the request carries THIS card's hash as its
   * CAS base, and the response's priority + hash are what the card adopts. On a
   * readonly instance it falls back to the draft, where mimir's own value still
   * wins and the buttons under it are disabled.
   */
  function prioritySection(card: EffectiveCard): HTMLElement {
    const sec = el("div", "pb-sec");
    sec.append(el("h3", null, "Priority"));
    const set = el("div", "pb-priset");
    const onDisk = card.priority !== null;
    const mode = capability.priorityMode;
    const busy = priorityPending.has(card.slug);
    const state = priorityControlState({
      mode,
      onDisk,
      busy,
      staleHash: staleCards.has(card.slug),
      reloading,
    });
    for (const p of BOARD_PRIORITIES) {
      const b = el("button", null, p) as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `pri-${p}`;
      b.style.setProperty("--pb-pri-color", `var(--pb-${p})`);
      b.setAttribute("aria-pressed", String(card.effectivePriority === p));
      b.disabled = state.disabled;
      const title =
        state.title ?? (card.priority === p ? `Clear priority: ${p}` : `Set priority: ${p} in mimir`);
      b.title = title;
      b.setAttribute("aria-label", `${title} — ${card.title}`);
      b.onclick = () => {
        if (mode === "write") writePriority(card.slug, p);
        else draftPriority(card.slug, p);
      };
      set.append(b);
    }
    sec.append(set);
    if (busy) sec.append(el("p", "pb-basis", "saving to mimir…"));
    if (priorityMsg && priorityMsg.slug === card.slug) sec.append(writeMessage(priorityMsg));
    sec.append(
      el(
        "p",
        "pb-basis",
        mode === "write"
          ? onDisk
            ? `priority: ${card.priority} is in the plan's frontmatter. Click it again to clear it — this board writes the file.`
            : "Not set. Clicking a level writes `priority:` into the plan's frontmatter in mimir."
          : onDisk
            ? `priority: ${card.priority} is in the plan's frontmatter — edit it in mimir, not here.`
            : "Draft — not saved to mimir yet. Kept in this browser; this instance cannot write the wiki.",
      ),
    );
    return sec;
  }

  /**
   * The drawer's archive control — the one surface that writes `plan_status`.
   *
   * Three shapes: an active card offers the two terminal targets (superseded /
   * abandoned — both file under the Shipped column, which the default `active`
   * scope does not show, i.e. archived); ANY superseded/abandoned card offers
   * the way back (restore to proposed) — the control has no memory of who
   * archived it, so the restore prose says outright that clicking restamps
   * `status_date` over the original transition's date; a `shipped` card gets NO
   * section at all — shipped is an earned end state, not an archive, and
   * un-shipping a plan is a mimir edit, not a board click. Null for that third
   * shape.
   */
  function archiveSection(card: EffectiveCard): HTMLElement | null {
    const archived = card.planStatus === "superseded" || card.planStatus === "abandoned";
    if (!archived && card.planStatus === "shipped") return null;
    const sec = el("div", "pb-sec");
    sec.append(el("h3", null, "Archive"));
    const busy = priorityPending.has(card.slug);
    const state = archiveControlState({
      readonly: capability.readonly,
      busy,
      staleHash: staleCards.has(card.slug),
      reloading,
    });
    const set = el("div", "pb-priset");
    const targets: Array<{ status: PlanStatus; label: string; what: string }> = archived
      ? [{ status: RESTORE_TARGET, label: `Restore to ${RESTORE_TARGET}`, what: "back onto the active board" }]
      : ARCHIVE_TARGETS.map((status) => ({
          status,
          label: status,
          what: "into the Shipped column (All scope)",
        }));
    for (const t of targets) {
      const b = el("button", null, t.label) as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `st-${t.status}`;
      b.disabled = state.disabled;
      const title =
        state.title ?? `Set plan_status: ${t.status} in mimir — moves this plan ${t.what}`;
      b.title = title;
      b.setAttribute("aria-label", `${title} — ${card.title}`);
      b.onclick = () => writeStatus(card.slug, t.status);
      set.append(b);
    }
    sec.append(set);
    if (busy) sec.append(el("p", "pb-basis", "saving to mimir…"));
    if (statusMsg && statusMsg.slug === card.slug) sec.append(writeMessage(statusMsg));
    sec.append(
      el(
        "p",
        "pb-basis",
        capability.readonly
          ? "This instance cannot write the wiki — edit plan_status in mimir."
          : archived
            ? `plan_status: ${card.planStatus}${card.statusDate ? ` since ${card.statusDate}` : ""} — this plan is archived. Restoring writes the frontmatter and REPLACES that status_date with today's.`
            : "Archiving writes plan_status (and today's status_date) into the plan's frontmatter. The file stays in mimir; the card leaves the active board.",
      ),
    );
    return sec;
  }

  /**
   * Copy the plan's ON-DISK path — the string you paste into an agent brief.
   * Absolute (root + relPath) when the payload named the root; the relPath
   * alone otherwise, which still identifies the file inside mimir. The join,
   * the clipboard write and the label flip are shared with the /wiki reader's
   * own copy-path button (`copy-path.ts`) — one fallback path and one revert
   * timer, not two of each that drift.
   */
  function copyPathButton(relPath: string): HTMLButtonElement {
    const full = wikiPagePath(wikiRoot, relPath);
    const idle = {
      text: "⧉ Copy path",
      ariaLabel: full ? `Copy the plan's file path: ${full}` : "Copy the plan's file path",
    };
    const b = el("button", "pb-copy") as HTMLButtonElement;
    b.type = "button";
    b.textContent = idle.text;
    b.title = full ? `Copy ${full}` : "Nothing to copy";
    b.setAttribute("aria-label", idle.ariaLabel);
    b.onclick = () => {
      // A blank path reports the refusal rather than copying "" — `writeText("")`
      // resolves, so the button would say Copied and empty the clipboard.
      if (!full) return flashCopyResult(b, false, idle, COPIED_MS);
      void copyText(full).then((ok) => flashCopyResult(b, ok, idle, COPIED_MS));
    };
    return b;
  }

  /** The readonly board's priority edit: the overlay, which `applyOverlay`
   *  applies only where the frontmatter carries nothing. Takes a SLUG, not a
   *  card, because the 403 path calls it from inside the failed write, where
   *  the only thing in hand is what the reader clicked. */
  function draftPriority(slug: string, p: PlanPriority): void {
    if (capability.priorityMode !== "draft") return;
    const next = { ...overlay.priority };
    if (next[slug] === p) delete next[slug];
    else next[slug] = p;
    overlay = { priority: next, order: { ...overlay.order } };
    saveOverlay();
    render();
    refreshDrawer(slug, `pri-${p}`);
  }

  function escClose(ev: KeyboardEvent): void {
    if (ev.key === "Escape") closeDrawer();
  }

  /** Everything the drawer covers. `inert` rather than `aria-hidden`, because
   *  the board behind a modal must be unfocusable as well as unreadable — the
   *  draft note is in the list too: it carries a live "Discard drafts" button,
   *  which is the worst thing to reach by accident from behind a scrim. */
  function setBackdropInert(on: boolean): void {
    // The degrade banners (`<details>` disclosures) sit above the meters inside `#pbRoot` and
    // are focusable too. The site nav is deliberately NOT covered: it is chrome outside the
    // board's region, and the scrim already blocks the pointer over it.
    const banners = Array.from(root.querySelectorAll<HTMLElement>(":scope > details.pb-banner"));
    // The notice strip is in the list for the same reason the draft note is: it
    // carries a live Reload button, and a board reloaded from behind a scrim
    // rebuilds the drawer the reader is looking at.
    for (const box of [metersBox, controlsBox, noticeBox, draftBox, boardBox, ...banners]) {
      if (on) box.setAttribute("inert", "");
      else box.removeAttribute("inert");
    }
  }

  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  /** Wrap Tab/Shift+Tab inside the open drawer. Read off the live DOM on every
   *  press rather than captured at open: the priority buttons rebuild the panel
   *  (and change which of them are disabled), so a list taken once goes stale. */
  function trapDrawerTab(ev: KeyboardEvent): void {
    if (ev.key !== "Tab") return;
    const drawer = root.querySelector<HTMLElement>(".pb-drawer");
    if (!drawer) return;
    // `Array.from`, not a spread: this file compiles without `dom.iterable`.
    const items = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      // Nothing to move to — hold the panel rather than tabbing into the page.
      ev.preventDefault();
      drawer.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    // Shift+Tab off the panel itself wraps to the end: the drawer takes focus
    // on open, and its own node sits BEFORE its children in document order.
    if (ev.shiftKey && (active === first || active === drawer || !drawer.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  /** `silent` is the re-open path (a priority click rebuilds the drawer):
   *  neither the focus restore nor the selection clear should run there. */
  function closeDrawer(opts: { silent?: boolean } = {}): void {
    root.querySelectorAll(".pb-scrim,.pb-drawer").forEach((n) => n.remove());
    document.removeEventListener("keydown", escClose);
    // Before the early return AND before any focus restore below: a board left
    // inert is a page nothing can be clicked or tabbed on, and the restore
    // targets a card inside it. (The re-open path sets it straight back.)
    setBackdropInert(false);
    if (opts.silent) return;
    if (view.openSlug) {
      view.openSlug = null;
      markSelected(null);
    }
    const back = drawerOpener;
    drawerOpener = null;
    // The card may have been re-rendered since; find it again by slug rather
    // than focusing a node that is no longer in the document.
    if (back?.isConnected) back.focus();
    else if (back?.dataset.slug) {
      boardBox
        .querySelector<HTMLElement>(`.pb-card[data-slug="${cssEscape(back.dataset.slug)}"]`)
        ?.focus();
    }
  }

  function cssEscape(value: string): string {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value;
  }

  // ---------------------------------------------------------------- draft note
  function renderDraftNote(
    cards: readonly EffectiveCard[],
    order: BoardOrder,
    draftCols: Set<string>,
  ): void {
    const drafted = cards.filter((c) => c.priorityIsDraft).length;
    // Column LABELS, not the payload's keys: "hand order on in-flight" is a
    // raw enum value leaking into a sentence someone is meant to read.
    const ranked = Object.keys(order)
      .filter((key) => draftCols.has(key))
      .map((key) => columnMeta.get(key)?.label ?? key);
    draftBox.textContent = "";
    if (!drafted && ranked.length === 0) {
      draftBox.classList.remove("pb-visible");
      return;
    }
    draftBox.classList.add("pb-visible");
    // Each half names the reason for ITS OWN axis. One shared reason blamed a
    // priority draft on a `queue.yaml` nobody had touched; the two are folded
    // back into one clause only when they really are the same sentence.
    const parts: Array<{ text: string; why: string }> = [];
    if (drafted) {
      parts.push({
        text: `${drafted} priority draft${drafted === 1 ? "" : "s"}`,
        why: priorityDraftReason(capability),
      });
    }
    if (ranked.length) {
      parts.push({ text: `hand order on ${ranked.join(" + ")}`, why: orderDraftReason(capability) });
    }
    const reasons = [...new Set(parts.map((p) => p.why))];
    const sentence =
      reasons.length === 1
        ? `${parts.map((p) => p.text).join(" · ")} — kept in this browser only: ${reasons[0]}. mimir wins on every load.`
        : `${parts.map((p) => `${p.text} (${p.why})`).join(" · ")} — kept in this browser only. mimir wins on every load.`;
    draftBox.append(el("span", "pb-draft-pill", "draft"), el("span", null, sentence));
    const discard = el("button", "pb-discard", "Discard drafts") as HTMLButtonElement;
    discard.type = "button";
    discard.onclick = () => {
      overlay = { priority: {}, order: {} };
      saveOverlay();
      render();
    };
    draftBox.append(discard);
  }

  render();
}
