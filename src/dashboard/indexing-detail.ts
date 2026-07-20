/**
 * Indexing per-collection depth — the DOM-free derivation behind the `/indexing`
 * row expansion (PR B). Clicking a row reveals a detail area with a phase
 * timeline (from `lastRun.phases`), a duration sparkline (from `history`), and
 * the in-flight run (from `current`). All the tricky decisions live here so they
 * unit-test without a DOM; the page client just renders the derived model.
 *
 * Three real-data shapes drive the timeline logic (all present in live huginn):
 *   - **ordered** — every phase carries `startedAt` (huginn #92+). Sort ascending
 *     by start; render left-to-right with a time axis.
 *   - **unordered** — at least one phase lacks `startedAt` (pre-#92 mixed data).
 *     A partial timeline is unordered, not half-ordered: render in arrival order,
 *     no axis, no proportional gaps.
 *   - **none** — the run has no phases at all (backfilled `trigger:"unknown"`
 *     runs predate phase reporting). Render an explicit "no phases recorded",
 *     never an empty area that implies zero phases ran.
 *
 * The sparkline distinguishes variants (x-feed's incremental runs are ~10s,
 * rebuilds ~80s — a mixed sparkline without variant distinction is a lie) and
 * never renders a null duration (failed/incomplete run) as 0 — it's carried as a
 * null-duration point the client draws as a gap/failure marker.
 */

import {
  formatDuration,
  parseTs,
  statusBadge,
  type RawJob,
  type RawPhase,
  type RawRun,
  type StatusBadge,
} from "./indexing-overview.ts";

// ---- Phase timeline --------------------------------------------------------

export type PhaseTimelineKind = "ordered" | "unordered" | "none";

export interface PhaseCell {
  name: string;
  status: StatusBadge;
  /** Formatted phase duration ("8s"), or null when unknown. */
  duration: string | null;
  /** Raw seconds (for proportional widths in ordered timelines); null ⇒ omit. */
  durationSeconds: number | null;
  /** True when this phase is fatal to the run (fetch/reindex). */
  fatal: boolean;
  /** Epoch ms of the phase start; null on the unordered path. */
  startedAtMs: number | null;
  /** A failed phase that did NOT abort the run — this is what `degraded` means.
   *  Surfaced so the timeline makes the non-fatal failure visible. */
  nonFatalFailure: boolean;
}

export interface PhaseTimeline {
  kind: PhaseTimelineKind;
  phases: PhaseCell[];
}

function isFailureStatus(badge: StatusBadge): boolean {
  return badge.status === "failed" || badge.status === "degraded";
}

function toPhaseCell(phase: RawPhase, startedAtMs: number | null): PhaseCell {
  const status = statusBadge(phase.status);
  const fatal = phase.fatal === true;
  return {
    name: phase.name ?? "(unnamed)",
    status,
    duration: formatDuration(phase.durationSeconds),
    durationSeconds:
      phase.durationSeconds != null && Number.isFinite(phase.durationSeconds)
        ? Math.max(0, phase.durationSeconds)
        : null,
    fatal,
    startedAtMs,
    nonFatalFailure: isFailureStatus(status) && !fatal,
  };
}

/**
 * Derive the phase timeline for a run. Returns `kind:"none"` for a run with no
 * phases (empty or absent — backfilled runs), `kind:"unordered"` when ANY phase
 * lacks `startedAt`, otherwise `kind:"ordered"` sorted ascending by start time.
 */
export function buildPhaseTimeline(run: RawRun | null | undefined): PhaseTimeline {
  const phases = run?.phases;
  if (!phases || phases.length === 0) {
    return { kind: "none", phases: [] };
  }

  // Any phase missing startedAt ⇒ the whole list is unordered (arrival order).
  const parsed = phases.map((p) => ({ phase: p, ms: parseTs(p.startedAt) }));
  const anyMissing = parsed.some((p) => p.ms == null);

  if (anyMissing) {
    return {
      kind: "unordered",
      phases: parsed.map(({ phase }) => toPhaseCell(phase, null)),
    };
  }

  const ordered = [...parsed].sort((a, b) => (a.ms! - b.ms!));
  return {
    kind: "ordered",
    phases: ordered.map(({ phase, ms }) => toPhaseCell(phase, ms)),
  };
}

// ---- Duration sparkline ----------------------------------------------------

export interface SparkPoint {
  /** Epoch ms of the run start; null when unparseable (still plotted by index). */
  startedAtMs: number | null;
  /** Null for failed/incomplete runs — the client renders a gap/marker, NEVER 0. */
  durationSeconds: number | null;
  /** Formatted duration for the tooltip ("1m 23s"); null mirrors durationSeconds. */
  duration: string | null;
  status: StatusBadge;
  variant: string;
  /** Stable per-variant index (0-based, first-seen order) — the client colors by
   *  this so incremental vs rebuild are visually distinct. */
  variantIndex: number;
}

export interface Sparkline {
  /** Chronological (oldest-first), stable. */
  points: SparkPoint[];
  /** Distinct variants in first-seen order (drives the legend + colors). */
  variants: string[];
  /** Max non-null duration across points (y-scale); null when no real durations. */
  maxDurationSeconds: number | null;
}

/**
 * Build the sparkline point model from a run history. Points are sorted oldest-
 * first by `startedAt` (null starts sort last, stable). Null durations are kept
 * as null (never coerced to 0). Variants get a stable first-seen index so the
 * client can color/mark incremental vs rebuild distinctly.
 */
export function buildSparkline(history: RawRun[] | null | undefined): Sparkline {
  const runs = Array.isArray(history) ? history : [];

  const variantOrder: string[] = [];
  const variantIndex = (v: string): number => {
    let i = variantOrder.indexOf(v);
    if (i === -1) {
      i = variantOrder.length;
      variantOrder.push(v);
    }
    return i;
  };

  const points: SparkPoint[] = runs
    .map((r) => ({ r, ms: parseTs(r.startedAt) }))
    .sort((a, b) => {
      if (a.ms == null && b.ms == null) return 0;
      if (a.ms == null) return 1;
      if (b.ms == null) return -1;
      return a.ms - b.ms;
    })
    .map(({ r, ms }) => {
      const variant = r.variant ?? "unknown";
      const secs =
        r.durationSeconds != null && Number.isFinite(r.durationSeconds)
          ? Math.max(0, r.durationSeconds)
          : null;
      return {
        startedAtMs: ms,
        durationSeconds: secs,
        duration: formatDuration(secs),
        status: statusBadge(r.status),
        variant,
        variantIndex: variantIndex(variant),
      };
    });

  const durations = points
    .map((p) => p.durationSeconds)
    .filter((d): d is number => d != null);
  const maxDurationSeconds = durations.length ? Math.max(...durations) : null;

  return { points, variants: variantOrder, maxDurationSeconds };
}

// ---- Combined detail model -------------------------------------------------

export interface IndexingDetail {
  /** Phase timeline of the last completed run. */
  lastTimeline: PhaseTimeline;
  /** Duration-over-time sparkline from the history window. */
  sparkline: Sparkline;
  /** In-flight run's phases-so-far (null when nothing is running). */
  current: PhaseTimeline | null;
}

/** Assemble the full per-collection detail model for a job. Pure. */
export function buildIndexingDetail(job: RawJob): IndexingDetail {
  return {
    lastTimeline: buildPhaseTimeline(job.lastRun),
    sparkline: buildSparkline(job.history),
    current: job.current ? buildPhaseTimeline(job.current) : null,
  };
}
