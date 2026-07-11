/**
 * Agent ETA estimator — pure, DOM/DB-free duration-history math behind the
 * `/agents` dashboard's honest countdowns (PR 3).
 *
 * Two responsibilities, both pure:
 *   1. `buildRunEstimates` — for each live run, estimate `expectedDurationMs` as
 *      the MEDIAN of the last ~20 completed runs of the same `(kind, name)`
 *      identity, sourced per kind:
 *        - watchers  → `watcher:<type>` child-span durations (durable; survives a
 *          restart), skip-span no-ops excluded (`groupWatcherDurations`).
 *        - everything else (gardener_drain / capture / research / scheduled_task /
 *          extractor) → the in-memory completed-runs ring (empty after a restart ⇒
 *          no estimate, elapsed-only — honest, not fabricated).
 *        - chat → NEVER estimated.
 *      The estimates ride the `/api/agents/overview` payload keyed by
 *      `estimateIdentity(kind, name)`; the `/agents` client looks each live run up
 *      by that identity (the SSE `agent_runs` cards carry no estimate themselves).
 *
 *   2. `computeCardEta` — the pure per-card render model (bar mode + ETA line)
 *      the client JS mirrors. Paced extrapolation (`elapsed/done × total`) beats
 *      the history median where real discrete progress exists (gardener drain);
 *      past the estimate it reports "running over est." rather than a frozen bar.
 *
 * The client JS in `views/agents-page.ts` is a hand-mirror of `computeCardEta` +
 * `fmtDurationShort` + `estimateIdentity` (it lives inside a template literal and
 * cannot import) — keep the two in sync, exactly like the `kindLabel` mirror.
 */

import type { AgentKind, AgentRun } from "../observability/agent-status.ts";

/** Max completed runs of one identity folded into a median. */
export const ETA_HISTORY_CAP = 20;

/** Compact duration label for the ETA line — "45s" / "5m" / "1h 3m". Minutes are
 *  rounded above 60s so the countdown doesn't jitter second-by-second. */
export function fmtDurationShort(ms: number): string {
  const clamped = ms < 0 ? 0 : ms;
  const s = Math.round(clamped / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** Median of a non-empty number list; null for an empty list. */
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Stable estimate-map key. NUL separator can't collide with a run name. */
export function estimateIdentity(kind: AgentKind | undefined, name: string | undefined): string {
  return `${kind ?? "chat"}\u0000${name ?? ""}`;
}

// ── Watcher durations (durable trace source) ──────────────────────────────────

/** One `watcher:<type>` child span, as read by `getWatcherRunDurations`. The two
 *  skip flags mirror the JSONB attributes a no-op tick finishes with. */
export interface WatcherDurationRow {
  /** Span name — `watcher:<type>`. */
  name: string;
  durationMs: number | null;
  quietHoursSkipped: boolean;
  skippedInFlight: boolean;
}

/**
 * Group watcher span durations by `<type>` (the `watcher:` prefix stripped),
 * EXCLUDING quiet-hours / in-flight-guard skip spans (they finish "ok" with ~0ms
 * and would poison the median — the same predicate `getRecentAgentTraces` uses to
 * keep them out of Recent), and capping each type at the newest {@link
 * ETA_HISTORY_CAP} (rows arrive newest-first). Pure so the skip-exclusion is
 * unit-testable without a DB.
 */
export function groupWatcherDurations(
  rows: WatcherDurationRow[],
  cap: number = ETA_HISTORY_CAP,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    if (r.quietHoursSkipped || r.skippedInFlight) continue;
    if (r.durationMs == null || r.durationMs <= 0) continue;
    const type = r.name.startsWith("watcher:") ? r.name.slice("watcher:".length) : r.name;
    const bucket = (out[type] ??= []);
    if (bucket.length < cap) bucket.push(r.durationMs);
  }
  return out;
}

/** Durations of the last {@link ETA_HISTORY_CAP} completed ring runs matching
 *  `(kind, name)`, newest-first. The ring stores runs newest-LAST, so we walk it
 *  backwards. */
export function ringDurations(
  ring: AgentRun[],
  kind: AgentKind,
  name: string | undefined,
  cap: number = ETA_HISTORY_CAP,
): number[] {
  const out: number[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < cap; i--) {
    const r = ring[i]!;
    if ((r.kind ?? "chat") !== kind) continue;
    if ((r.name ?? "") !== (name ?? "")) continue;
    if (!r.completed || r.completedAt == null) continue;
    const d = r.completedAt - r.startedAt;
    if (d < 0) continue;
    out.push(d);
  }
  return out;
}

/**
 * Estimate `expectedDurationMs` for every live run, keyed by
 * `estimateIdentity(kind, name)`. Chat is never estimated; watchers source from
 * the trace-derived `watcherRows`, every other kind from the completed-runs ring.
 * A run with no history (or a null median) is simply absent from the map ⇒ the
 * card renders elapsed-only.
 */
export function buildRunEstimates(
  running: AgentRun[],
  ring: AgentRun[],
  watcherRows: WatcherDurationRow[],
): Record<string, number> {
  const watcherGroups = groupWatcherDurations(watcherRows);
  const estimates: Record<string, number> = {};
  for (const r of running) {
    if (r.completed) continue;
    const kind = r.kind ?? "chat";
    if (kind === "chat") continue; // chat gets NO ETA ever
    const durations =
      kind === "watcher" ? (watcherGroups[r.name ?? ""] ?? []) : ringDurations(ring, kind, r.name);
    const m = median(durations);
    if (m != null && m > 0) estimates[estimateIdentity(kind, r.name)] = Math.round(m);
  }
  return estimates;
}

// ── Per-card render model (mirrored in the client) ────────────────────────────

export type CardBarMode = "done" | "determinate" | "estimate" | "over" | "indeterminate";

export interface CardEtaModel {
  elapsedMs: number;
  barMode: CardBarMode;
  /** Fill percentage for `determinate` (n/m) and `estimate` (elapsed/expected). */
  barPct?: number;
  /** ETA line text — "~5m left · est." | "running over est."; absent = elapsed-only. */
  etaLabel?: string;
  /** The effective expected duration used (pace where it beat the history median). */
  expectedDurationMs?: number;
}

/** The subset of a run the card render model reads. */
export type CardEtaRun = Pick<
  AgentRun,
  "kind" | "name" | "progress" | "startedAt" | "completed" | "completedAt"
>;

/**
 * The bar + ETA-line model for one run card. `historyExpectedMs` is the median
 * from {@link buildRunEstimates} (null ⇒ no history). Pace — `elapsed/done ×
 * total` — beats the median where a gardener drain reports real discrete
 * progress. Never fabricates a countdown: no history AND no progress ⇒
 * elapsed-only (`indeterminate`, no ETA line). The `· est.` qualifier is always
 * on the ETA line; past the estimate it reads "running over est." instead of a
 * frozen/overflowing bar.
 */
export function computeCardEta(
  run: CardEtaRun,
  historyExpectedMs: number | null | undefined,
  now: number,
): CardEtaModel {
  const end = run.completed && run.completedAt != null ? run.completedAt : now;
  const elapsedMs = Math.max(0, end - run.startedAt);
  if (run.completed) return { elapsedMs, barMode: "done" };

  const kind = run.kind ?? "chat";
  const p = run.progress;
  const hasDiscrete = !!(p && p.total > 0);

  let expected = kind === "chat" ? undefined : (historyExpectedMs ?? undefined);
  // Pace beats the history median where real progress exists (gardener drain).
  if (kind === "gardener_drain" && p && p.total > 0 && p.done > 0) {
    expected = Math.round((elapsedMs / p.done) * p.total);
  }

  let barMode: CardBarMode;
  let barPct: number | undefined;
  if (hasDiscrete) {
    barMode = "determinate";
    barPct = Math.min(100, Math.round((p!.done / p!.total) * 100));
  } else if (expected && expected > 0) {
    if (elapsedMs >= expected) {
      barMode = "over";
    } else {
      barMode = "estimate";
      barPct = Math.min(95, Math.round((elapsedMs / expected) * 100));
    }
  } else {
    barMode = "indeterminate";
  }

  let etaLabel: string | undefined;
  if (expected && expected > 0) {
    const remaining = expected - elapsedMs;
    etaLabel = remaining > 0 ? `~${fmtDurationShort(remaining)} left · est.` : "running over est.";
  }

  return {
    elapsedMs,
    barMode,
    ...(barPct != null ? { barPct } : {}),
    ...(etaLabel ? { etaLabel } : {}),
    ...(expected ? { expectedDurationMs: expected } : {}),
  };
}
