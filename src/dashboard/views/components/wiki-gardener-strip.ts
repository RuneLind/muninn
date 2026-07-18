/**
 * Pure, side-effect-free model + HTML builders for the /wiki/gardener "Ingest
 * backlog" strip. Split out from `wiki-gardener-browser.ts` (which touches the
 * DOM at module load, so it can't be imported in tests) so the strip's numbers,
 * control gating, and confirm-panel copy are unit-testable without a DOM — the
 * same split rationale as `wiki-ask-render.ts` / `wiki-filter.ts`.
 *
 * The honest-numbers contract lives here: "offered in past runs" and the reset
 * gate/label both use the server-computed `offeredStillQueued` (queued ∩ offered),
 * NOT the raw all-time `offered` field and NOT a client-side `queued − remaining`
 * derivation. The all-time offered set includes since-consumed keys, and the
 * drain's age floor makes `remaining` exclude merely-too-fresh docs, so neither
 * `offered` nor `queued − remaining` equals the offered-and-still-queued truth —
 * the route emits it explicitly. `batchSize`/`maxProposals` come from the
 * GET response (sourced from `src/gardener/backlog.ts`) so the client never
 * hardcodes them; when live fields are absent (the GET's degraded catch branch)
 * every number falls back cleanly to a real integer — never `NaN`/`undefined`.
 */

import { escHtml as esc } from "./escape.ts";

export interface BacklogCollection {
  collection: string;
  source: string;
  label: string;
  total: number;
  ingested: number;
  queued: number;
}

export interface LastBacklogRun {
  finishedAt: number;
  offered: number;
  drafted: number;
  error?: string;
  /** Set when the run was soft-cancelled — `drafted` of `of` clusters drafted. */
  cancelled?: { drafted: number; of: number };
  /**
   * Set when the eligible batch was below the cluster minimum — the run was
   * provably unable to draft, so nothing was offered/journalled/run. `eligible`
   * is the too-small batch size.
   */
  outcome?: "insufficient";
  eligible?: number;
  /** The resolved threshold the guard fired against — per-bot configurable, default 3. */
  minClusterSize?: number;
}

/** Live progress of an in-flight backlog drain (mirrors the server shape). */
export interface BacklogProgress {
  stage: "assembling" | "harvesting" | "clustering" | "resolving" | "drafting";
  draftsDone: number;
  draftsTotal: number;
  currentTopic?: string;
  startedAt: number;
  cancelRequested: boolean;
}

export interface IngestBacklogResponse {
  byCollection: BacklogCollection[];
  total: number;
  ingested: number;
  queued: number;
  wikiUrlCount: number;
  generatedAt: number;
  errors?: { source: string; collection: string; error: string }[];
  error?: string;
  // Live fields (PR 2) — merged fresh on every response, outside the TTL cache.
  running?: boolean;
  offered?: number;
  remaining?: number;
  /** Queued docs also in the offered set — the honest "offered in past runs" count. */
  offeredStillQueued?: number;
  /** Queued docs still inside the weekly watcher's window — the "new arrivals" lead. */
  fresh?: number;
  /** Per-source breakdown of `fresh` (non-zero sources only). */
  freshBySource?: { label: string; count: number }[];
  /** The resolved age-floor window in days — labels "new (last Nd)"; 0/absent ⇒ degraded. */
  freshWindowDays?: number;
  watcherSeeded?: boolean;
  lastBacklogRun?: LastBacklogRun | null;
  /** Live drain progress (null when idle / a weekly run holds the mutex). */
  progress?: BacklogProgress | null;
  /** Interrupted (crashed/errored) run awaiting Recover/Dismiss (PR 3). */
  interrupted?: { at: number; batchSize: number; drafted: number } | null;
  // Batch constants (PR 1) — echoed from src/gardener/backlog.ts so the confirm
  // panel renders "drain a batch of N … up to M drafts" without hardcoding.
  batchSize?: number;
  maxProposals?: number;
}

/** The pure, testable model behind the strip — numbers + control gating. */
export interface BacklogStripModel {
  totalNeverIngested: number;
  perSource: { label: string; queued: number }[];
  eligibleNow: number;
  offeredStillQueued: number;
  /** New arrivals inside the watcher window (the sentence's lead segment). */
  freshTotal: number;
  freshPerSource: { label: string; count: number }[];
  /** Age-floor window in days; 0 ⇒ degraded response, hide the fresh segment. */
  freshWindowDays: number;
  draftsAwaitingReview: number;
  running: boolean;
  /** Live drain progress when this bot's own drain holds the mutex (else null). */
  progress: BacklogProgress | null;
  /** An interrupted run awaiting Recover/Dismiss (null when none) — banner source. */
  interrupted: { at: number; batchSize: number; drafted: number } | null;
  /** No wiki-gardener watcher seeded ⇒ hide the run/reset control entirely. */
  controlHidden: boolean;
  showRun: boolean;
  showReset: boolean;
  /** Queued but nothing drainable now (every past-floor doc already offered). */
  nothingDrainable: boolean;
  batchSize: number;
  maxProposals: number;
  /** How many docs a click drains now: min(batchSize, eligibleNow). */
  drainNow: number;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Pure model derivation. `pendingDraftCount` comes from the proposal list the
 * page already loads (count of `status === "draft"`), passed in so this stays
 * DOM-free.
 */
export function backlogStripModel(
  data: IngestBacklogResponse,
  pendingDraftCount: number,
): BacklogStripModel {
  const queued = numOr(data.queued, 0);
  // Degraded response (no live fields) ⇒ remaining falls back to queued, i.e.
  // "all eligible, none offered yet" — a clean, add-up-able default.
  const remaining = numOr(data.remaining, queued);
  // Server-computed (queued ∩ offered) — NOT `queued − remaining`, which the age
  // floor would inflate by counting merely-too-fresh docs as offered. Falls back
  // to 0 on a degraded response (no live fields ⇒ "none offered yet").
  const offeredStillQueued = Math.max(0, numOr(data.offeredStillQueued, 0));
  // Fresh bucket (new arrivals inside the watcher window). freshWindowDays doubles
  // as the presence marker: 0/absent ⇒ degraded response ⇒ the sentence hides the
  // fresh segment rather than showing a false "0 new".
  const freshWindowDays = Math.max(0, numOr(data.freshWindowDays, 0));
  const freshTotal = Math.max(0, numOr(data.fresh, 0));
  const freshPerSource = (Array.isArray(data.freshBySource) ? data.freshBySource : []).filter(
    (s): s is { label: string; count: number } =>
      !!s && typeof s.label === "string" && typeof s.count === "number" && s.count > 0,
  );
  const running = data.running === true;
  const controlHidden = data.watcherSeeded === false;
  const batchSize = numOr(data.batchSize, 0);
  const maxProposals = numOr(data.maxProposals, 0);
  return {
    totalNeverIngested: queued,
    perSource: (data.byCollection || []).map((c) => ({ label: c.label, queued: c.queued })),
    eligibleNow: remaining,
    offeredStillQueued,
    freshTotal,
    freshPerSource,
    freshWindowDays,
    draftsAwaitingReview: Math.max(0, numOr(pendingDraftCount, 0)),
    running,
    progress: data.progress ?? null,
    interrupted: data.interrupted ?? null,
    controlHidden,
    showRun: !controlHidden && !running && remaining > 0,
    // Reset whenever offered-and-still-queued > 0 (not the raw all-time offered):
    // gating on `offered > 0` could render "Reset offered (0)" once every offered
    // key is consumed, where a reset would be a no-op anyway.
    showReset: !controlHidden && !running && offeredStillQueued > 0,
    nothingDrainable: !controlHidden && !running && remaining <= 0 && queued > 0,
    batchSize,
    maxProposals,
    drainNow: Math.max(0, Math.min(batchSize, remaining)),
  };
}

function strong(n: number): string {
  return `<span class="bk-strong">${n}</span>`;
}

/** "Label 4 · Label 2" — the per-source breakdown markup (sentence + tail share it). */
function perSourceBreakdownHtml(items: { label: string; n: number }[]): string {
  return items
    .map((s) => `${esc(s.label)} <span class="bk-n">${s.n}</span>`)
    .join('<span class="bk-sep"> · </span>');
}

/**
 * The honest labeled sentence (pure HTML string) — recency-first: the lead is
 * "how many NEW summaries aren't in the wiki" (the number the all-time totals
 * used to bury), then what a drain can act on now. The all-time accounting moved
 * into the collapsed tail ({@link backlogTailHtml}). On a degraded response
 * (no live fields ⇒ `freshWindowDays` 0) the fresh segment is hidden rather than
 * showing a false "0 new".
 */
export function backlogSentenceHtml(model: BacklogStripModel): string {
  const segs: string[] = [];
  if (model.freshWindowDays > 0) {
    let freshSeg = `${strong(model.freshTotal)} new (last ${model.freshWindowDays}d)`;
    if (model.freshPerSource.length) {
      freshSeg +=
        ": " + perSourceBreakdownHtml(model.freshPerSource.map((s) => ({ label: s.label, n: s.count })));
      freshSeg += ` <span class="bk-note">— weekly watcher's turf</span>`;
    }
    segs.push(freshSeg);
  }
  segs.push(`${strong(model.eligibleNow)} drainable now`);
  if (model.draftsAwaitingReview > 0) {
    segs.push(`${strong(model.draftsAwaitingReview)} drafts awaiting review`);
  }
  return `<span class="bk-sentence">${segs.join('<span class="bk-sep"> · </span>')}</span>`;
}

/**
 * The de-emphasized, collapsed all-time accounting (pure HTML): the exhausted
 * tail ("offered in past runs, never drafted") + the all-time never-ingested
 * total in the always-visible summary, with the per-source breakdown behind the
 * toggle. Empty when nothing is queued. This is where "280 never ingested ·
 * YouTube 269" went — true numbers, but dead weight as a headline.
 */
export function backlogTailHtml(model: BacklogStripModel): string {
  if (model.totalNeverIngested <= 0) return "";
  const summaryParts: string[] = [];
  if (model.offeredStillQueued > 0) {
    summaryParts.push(`${strong(model.offeredStillQueued)} offered in past runs, never drafted`);
  }
  summaryParts.push(`${strong(model.totalNeverIngested)} never ingested all-time`);
  const breakdown = perSourceBreakdownHtml(model.perSource.map((s) => ({ label: s.label, n: s.queued })));
  return (
    '<details class="bk-tail">' +
    `<summary>${summaryParts.join('<span class="bk-sep"> · </span>')}</summary>` +
    `<span class="bk-tail-body">${breakdown}</span>` +
    "</details>"
  );
}

/** Friendly stage text for a live drain (drafting shows k/n + the current topic). */
export function backlogProgressText(p: BacklogProgress): string {
  switch (p.stage) {
    case "assembling":
      return "Selecting batch…";
    case "harvesting":
      return "Fetching docs…";
    case "clustering":
      return "Clustering…";
    case "resolving":
      return "Resolving targets…";
    case "drafting": {
      const base = p.draftsTotal > 0 ? `Drafting ${p.draftsDone}/${p.draftsTotal}` : "Drafting…";
      return p.currentTopic ? `${base} — ${p.currentTopic}` : base;
    }
    default:
      return "Working…";
  }
}

/** Local HH:MM from an epoch-ms start time (best-effort; empty on a bad value). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The live-drain progress line + a soft-cancel button (replaces "Running…"). */
export function backlogProgressHtml(p: BacklogProgress): string {
  const parts: string[] = [`⏳ ${esc(backlogProgressText(p))}`];
  const clock = fmtClock(p.startedAt);
  if (clock) parts.push(`started ${esc(clock)}`);
  if (p.draftsDone > 0) {
    parts.push(`${p.draftsDone} draft${p.draftsDone === 1 ? "" : "s"} ready below`);
  }
  const line = parts.join('<span class="bk-sep"> · </span>');
  const cancelLabel = p.cancelRequested ? "Cancelling…" : "Cancel";
  const cancelBtn =
    `<button class="gard-btn bk-cancel-run" data-backlog-action="cancel-run"` +
    `${p.cancelRequested ? " disabled" : ""}>${cancelLabel}</button>`;
  return `<span class="bk-control bk-progress"><span class="bk-progress-line">${line}</span>${cancelBtn}</span>`;
}

/** The run/reset control + the (hidden) informed-consent confirm panel. */
export function backlogControlHtml(model: BacklogStripModel): string {
  if (model.controlHidden) return "";
  if (model.running) {
    // A live drain (this bot's own run) shows progress + soft-cancel; a weekly run
    // holds the mutex with no progress → keep the plain disabled "Running…".
    if (model.progress) return backlogProgressHtml(model.progress);
    return `<span class="bk-control"><button class="gard-btn bk-run" disabled>Running…</button></span>`;
  }
  let inner = "";
  if (model.showRun) {
    inner += `<button class="gard-btn bk-run" data-backlog-action="confirm">Drain a batch (${model.drainNow})</button>`;
  } else if (model.nothingDrainable) {
    // Not "all offered": fresh in-window docs are un-offered too, so that wording
    // lies whenever new arrivals exist. This states what the button's absence means.
    inner += `<span class="bk-run-note">nothing drainable</span>`;
  }
  if (model.showReset) {
    const label = model.nothingDrainable ? "Reset to re-run" : `Reset offered (${model.offeredStillQueued})`;
    inner += `<button class="gard-btn bk-reset" data-backlog-action="reset">${label}</button>`;
  }
  if (!inner) return ""; // nothing queued at all
  let html = `<span class="bk-control">${inner}</span>`;
  if (model.showRun) {
    html += backlogConfirmHtml(model);
  }
  return html;
}

/** The informed-consent confirm panel — hidden until the run button is clicked. */
export function backlogConfirmHtml(model: BacklogStripModel): string {
  return (
    '<div class="bk-confirm">' +
    `<div class="bk-confirm-copy">Drain a batch of <strong>${model.drainNow}</strong> ` +
    `(of ${model.eligibleNow} drainable) through the gardener? ~10–20 min in the background — ` +
    `you can leave this page. 1 Haiku clustering call + up to ${model.maxProposals} drafts on this ` +
    `bot's model. Produces <strong>draft proposals</strong> below — nothing is written to the wiki ` +
    "until you approve.</div>" +
    '<div class="bk-confirm-actions">' +
    '<button class="gard-btn bk-start" data-backlog-action="run">Start batch</button>' +
    '<button class="gard-btn bk-cancel" data-backlog-action="cancel">Cancel</button>' +
    "</div></div>"
  );
}

/** Last-run outcome note (pure HTML string). */
export function backlogOutcomeHtml(run: LastBacklogRun | null | undefined): string {
  if (!run) return "";
  if (run.error) {
    return ` <span class="bk-err">last run failed: ${esc(run.error)}</span>`;
  }
  // Below-minimum batch: the run never touched the offered set (nothing burned),
  // so this is an informational note, not the burn warning below. `eligible` is
  // the too-small batch size (falls back to `offered`, which is 0 for this outcome).
  if (run.outcome === "insufficient") {
    const eligible = run.eligible ?? run.offered;
    const min = run.minClusterSize ?? 3;
    if (eligible === 0) {
      return ` <span class="bk-run-note">last run: no eligible docs in the backlog — nothing offered</span>`;
    }
    return ` <span class="bk-run-note">last run: ${eligible} eligible doc(s) — below the minimum cluster size of ${min}; nothing offered</span>`;
  }
  if (run.cancelled) {
    const { drafted, of } = run.cancelled;
    if (drafted === 0) {
      return ` <span class="bk-run-note">last run cancelled before drafting — batch docs returned to the queue</span>`;
    }
    return ` <span class="bk-run-note">last run cancelled after ${drafted}/${of} drafts — undrafted docs returned to the queue</span>`;
  }
  if (run.drafted > 0) {
    return ` <span class="bk-run-note">last run: ${run.drafted} draft(s) from ${run.offered} docs — see proposals below</span>`;
  }
  // Offered docs but drafted nothing: the batch was burned into the offered set
  // (at-most-once) with zero result — the silent tail-burn this campaign guards.
  // Warn (not a bland "done") so a reviewer notices and can Reset to retry.
  if (run.offered > 0) {
    return ` <span class="bk-warn">⚠ last run offered ${run.offered} docs but drafted nothing — those docs are now marked offered; Reset to retry</span>`;
  }
  return ` <span class="bk-run-note">last run finished — nothing to draft</span>`;
}

/**
 * The interrupted-run recovery banner (pure HTML). Rendered above the strip when
 * the GET carries an `interrupted` field — a run journal that outlived its run (a
 * crash or an error settle) with nothing in flight. Offers Recover (return the
 * undrafted batch to the pool) or Dismiss (leave it skipped). Empty when none.
 */
export function backlogBannerHtml(model: BacklogStripModel): string {
  const i = model.interrupted;
  if (!i) return "";
  const clock = fmtClock(i.at);
  const when = clock ? ` started ${esc(clock)}` : "";
  return (
    '<div class="bk-banner">' +
    `<span class="bk-banner-msg">⚠ A drain${when} was interrupted — ` +
    `${strong(i.drafted)} of ${strong(i.batchSize)} docs produced drafts.</span>` +
    '<span class="bk-banner-actions">' +
    '<button class="gard-btn bk-recover" data-backlog-action="recover">Recover batch</button>' +
    '<button class="gard-btn bk-dismiss" data-backlog-action="dismiss">Dismiss</button>' +
    "</span></div>"
  );
}

/** Full strip innerHTML (pure). renderBacklog just assigns this to the element. */
export function backlogStripHtml(model: BacklogStripModel, errors?: unknown[]): string {
  const errNote = errors && errors.length
    ? ` <span class="bk-err">(some sources unavailable)</span>`
    : "";
  return (
    backlogBannerHtml(model) +
    `<span class="bk-label">Ingest backlog:</span> ` +
    backlogSentenceHtml(model) +
    errNote +
    " " +
    backlogControlHtml(model)
  );
}
