/**
 * Pure, side-effect-free model + HTML builders for the /wiki/gardener "Ingest
 * backlog" strip. Split out from `wiki-gardener-browser.ts` (which touches the
 * DOM at module load, so it can't be imported in tests) so the strip's numbers,
 * control gating, and confirm-panel copy are unit-testable without a DOM — the
 * same split rationale as `wiki-ask-render.ts` / `wiki-filter.ts`.
 *
 * The honest-numbers contract lives here: "offered in past runs" and the reset
 * gate/label both use `queued − remaining` (offered-and-STILL-queued), NOT the
 * raw all-time `offered` field. The all-time offered set includes since-consumed
 * keys, so `queued ≠ remaining + offered` in general and the raw number would
 * visibly not add up in the sentence. `batchSize`/`maxProposals` come from the
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
  watcherSeeded?: boolean;
  lastBacklogRun?: LastBacklogRun | null;
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
  draftsAwaitingReview: number;
  running: boolean;
  /** No wiki-gardener watcher seeded ⇒ hide the run/reset control entirely. */
  controlHidden: boolean;
  showRun: boolean;
  showReset: boolean;
  /** Everything queued has been offered — keep the "all offered" wording. */
  allOffered: boolean;
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
  const offeredStillQueued = Math.max(0, queued - remaining);
  const running = data.running === true;
  const controlHidden = data.watcherSeeded === false;
  const batchSize = numOr(data.batchSize, 0);
  const maxProposals = numOr(data.maxProposals, 0);
  return {
    totalNeverIngested: queued,
    perSource: (data.byCollection || []).map((c) => ({ label: c.label, queued: c.queued })),
    eligibleNow: remaining,
    offeredStillQueued,
    draftsAwaitingReview: Math.max(0, numOr(pendingDraftCount, 0)),
    running,
    controlHidden,
    showRun: !controlHidden && !running && remaining > 0,
    // Reset whenever offered-and-still-queued > 0 (not the raw all-time offered):
    // gating on `offered > 0` could render "Reset offered (0)" once every offered
    // key is consumed, where a reset would be a no-op anyway.
    showReset: !controlHidden && !running && offeredStillQueued > 0,
    allOffered: !controlHidden && !running && remaining <= 0 && queued > 0,
    batchSize,
    maxProposals,
    drainNow: Math.max(0, Math.min(batchSize, remaining)),
  };
}

function strong(n: number): string {
  return `<span class="bk-strong">${n}</span>`;
}

/** The honest labeled sentence (pure HTML string). */
export function backlogSentenceHtml(model: BacklogStripModel): string {
  const segs: string[] = [`${strong(model.totalNeverIngested)} never ingested`];
  if (model.perSource.length) {
    segs.push(
      model.perSource
        .map((s) => `${esc(s.label)} <span class="bk-n">${s.queued}</span>`)
        .join('<span class="bk-sep"> · </span>'),
    );
  }
  segs.push(`${strong(model.eligibleNow)} eligible now`);
  if (model.offeredStillQueued > 0) {
    segs.push(`${strong(model.offeredStillQueued)} offered in past runs`);
  }
  if (model.draftsAwaitingReview > 0) {
    segs.push(`${strong(model.draftsAwaitingReview)} drafts awaiting review`);
  }
  return `<span class="bk-sentence">${segs.join('<span class="bk-sep"> · </span>')}</span>`;
}

/** The run/reset control + the (hidden) informed-consent confirm panel. */
export function backlogControlHtml(model: BacklogStripModel): string {
  if (model.controlHidden) return "";
  if (model.running) {
    return `<span class="bk-control"><button class="gard-btn bk-run" disabled>Running…</button></span>`;
  }
  let inner = "";
  if (model.showRun) {
    inner += `<button class="gard-btn bk-run" data-backlog-action="confirm">Drain a batch (${model.drainNow})</button>`;
  } else if (model.allOffered) {
    inner += `<span class="bk-run-note">all offered</span>`;
  }
  if (model.showReset) {
    const label = model.allOffered ? "Reset to re-run" : `Reset offered (${model.offeredStillQueued})`;
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
    `(of ${model.eligibleNow} eligible) through the gardener? ~10–20 min in the background — ` +
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
  if (run.drafted > 0) {
    return ` <span class="bk-run-note">last run: ${run.drafted} draft(s) from ${run.offered} docs — see proposals below</span>`;
  }
  return ` <span class="bk-run-note">last run finished — nothing clustered; ${run.offered} docs offered</span>`;
}

/** Full strip innerHTML (pure). renderBacklog just assigns this to the element. */
export function backlogStripHtml(model: BacklogStripModel, errors?: unknown[]): string {
  const errNote = errors && errors.length
    ? ` <span class="bk-err">(some sources unavailable)</span>`
    : "";
  return (
    `<span class="bk-label">Ingest backlog:</span> ` +
    backlogSentenceHtml(model) +
    errNote +
    " " +
    backlogControlHtml(model)
  );
}
