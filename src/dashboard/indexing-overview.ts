/**
 * Indexing overview — server-side assembly of huginn's indexing-run ledger for
 * the `/indexing` dashboard page. It answers "when did each indexing job last
 * run, how long did it take, is it drifting" — a read-only diagnostic over
 * huginn's `GET /api/indexing/jobs?history=N`.
 *
 * The 20-ish collections fall into three classes, rendered scheduled-first:
 *   1. Scheduled + tracked (`schedule != null`) — the jobs that can drift.
 *   2. Tracked, unscheduled (`schedule == null && lastRun != null`) — manual
 *      scripts / watch daemons.
 *   3. Served, never tracked (`lastRun == null`) — indexed once by hand.
 * Class sizes are NOT hardcoded (they moved 19→20 in a day); the invariant is
 * that every row appears in exactly one class and the class sizes sum to total.
 *
 * Like `models-overview.ts`, the assembler NEVER throws — a degraded huginn
 * lands in `errors: string[]` on a 200 payload with `classes` still present
 * (empty rows). All display-model derivation (relative times, schedule → human
 * string, status → badge class, per-variant medians) happens here so the page
 * view stays DOM-free-testable.
 */

import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { buildIndexingDetail, type IndexingDetail } from "./indexing-detail.ts";
import { getLog } from "../logging.ts";

const log = getLog("dashboard", "indexing");

/** How much run history to request from huginn (per-collection `history[]`). */
export const DEFAULT_HISTORY_N = 20;

/** Staleness thresholds for tracked-but-unscheduled jobs (no schedule to drift
 *  against, so age is the only signal). `aging` is a muted middle band (warning-
 *  tinted text, no chip); `stale` earns the STALE chip. Scheduled jobs use drift
 *  (missed cycles) instead — see `assessRowHealth`. */
export const AGING_MS = 7 * 24 * 60 * 60 * 1000;
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;
/** A scheduled job is "drifting" once it has missed more than this many full
 *  schedule cycles without a run (grace for a slightly-late launchd tick). */
export const DRIFT_CYCLES = 2;

// ---- Raw huginn contract (only the fields we read) -------------------------

/** One phase of a run (reindex / embed / …). */
export interface RawPhase {
  name?: string;
  status?: string;
  durationSeconds?: number | null;
  fatal?: boolean;
  /** ISO start time (huginn #92+, chronological). Absent on pre-#92 phases —
   *  see `buildPhaseTimeline`: any phase missing this ⇒ the run's list is
   *  treated as unordered (arrival order, no time axis). */
  startedAt?: string | null;
}

/** A run row — `lastRun`, `current`, or a `history[]` entry. */
export interface RawRun {
  runId?: string;
  status?: string;
  variant?: string;
  trigger?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** null for `running` / `incomplete` runs — render elapsed-or-nothing. */
  durationSeconds?: number | null;
  phases?: RawPhase[];
  error?: string | null;
  documentCount?: number | null;
  chunkCount?: number | null;
}

/** Three schedule shapes plus null. `weekday` null on calendar ⇒ daily. */
export type RawSchedule =
  | { kind: "calendar"; hour?: number; minute?: number; weekday?: number | null }
  | { kind: "hourly"; minute?: number }
  | { kind: "interval"; seconds?: number };

export interface RawJob {
  collection: string;
  loaded: boolean;
  job: string | null;
  schedule: RawSchedule | null;
  /** In-flight run (or null). */
  current: RawRun | null;
  lastRun: RawRun | null;
  history: RawRun[];
  /** Keyed by variant, e.g. `{incremental: 211}` or `{incremental: 10, rebuild: 83}`. */
  medianDurationSeconds: Record<string, number>;
}

export interface IndexingJobsResponse {
  jobs: RawJob[];
}

// ---- Display model ---------------------------------------------------------

/** The canonical run statuses we style. Anything else folds to `unknown`. */
export type RunStatus =
  | "succeeded"
  | "degraded"
  | "failed"
  | "skipped"
  | "running"
  | "incomplete"
  | "unknown";

const KNOWN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "degraded",
  "failed",
  "skipped",
  "running",
  "incomplete",
  "unknown",
];

export interface StatusBadge {
  status: RunStatus;
  /** Human label shown on the badge. */
  label: string;
  /** CSS class suffix — `.badge-<cls>` in the page. */
  cls: RunStatus;
}

export interface MedianEntry {
  variant: string;
  /** Formatted, e.g. "3m 23s". */
  duration: string;
}

export interface IndexingRow {
  collection: string;
  loaded: boolean;
  job: string | null;
  /** Last-run badge (null when never tracked). */
  lastStatus: StatusBadge | null;
  /** Relative time of the last run's start ("2h ago"); null when never tracked. */
  lastRelative: string | null;
  /** Epoch ms of the last run's start (for a title/tooltip); null when unknown. */
  lastStartedAt: number | null;
  /** Formatted duration of the last run; null when durationSeconds was null. */
  lastDuration: string | null;
  /** Per-variant medians (sorted, incremental-first). */
  medians: MedianEntry[];
  /** Human schedule string for class 1 ("daily 08:00"); null otherwise. */
  nextScheduled: string | null;
  /** True when a `current` run is in flight. */
  running: boolean;
  /** Elapsed time of the in-flight run ("1m 12s"); null when startedAt unknown. */
  runningElapsed: string | null;
  /** Per-collection depth for the expansion row (phase timeline + sparkline +
   *  in-flight phases) — derived by the pure `buildIndexingDetail`. */
  detail: IndexingDetail;
  /** Row attention state driving the STALE chip + relative-time text tint:
   *  `stale` (unscheduled >14d, or a drifting scheduled job) ⇒ chip + warning
   *  text; `aging` (unscheduled 7–14d) ⇒ warning-tinted text, no chip; null ⇒
   *  quiet. Never-tracked rows have no run to age ⇒ null. */
  attention: "stale" | "aging" | null;
  /** True when the last run is old past the stale threshold (unscheduled jobs). */
  stale: boolean;
  /** True when the last run is in the aging band (unscheduled jobs). */
  aging: boolean;
  /** True when a scheduled job has missed enough cycles to be drifting. */
  drifting: boolean;
  /** True when the last run failed or degraded. */
  failed: boolean;
  /** Age of the last run in ms (now − lastStartedAt); null when never tracked. */
  ageMs: number | null;
  /** Projected next scheduled fire (epoch ms); null for unscheduled jobs. */
  nextRunAtMs: number | null;
  /** Forward countdown to the next fire ("in 18h 40m"); null when unscheduled. */
  nextRelative: string | null;
}

export type IndexingClassKey = "scheduled" | "tracked" | "never";

export interface IndexingClass {
  key: IndexingClassKey;
  title: string;
  subtitle: string;
  rows: IndexingRow[];
}

/** A summary stat tile shipped ready-to-render in the overview payload (the page
 *  maps `tileHtml` over these; the plan puts tile derivation in the pure assembly,
 *  not the client). `tone` drives the attention border + label color per the
 *  shared summary-tiles rule; absent ⇒ neutral. */
export interface IndexingTile {
  label: string;
  value: string;
  sub: string;
  tone?: "warning" | "success" | "error" | "info";
}

export interface IndexingOverview {
  generatedAt: number;
  total: number;
  classes: IndexingClass[];
  /** Summary tiles (Healthy / Stale / Drift / Running), derived server-side. */
  tiles: IndexingTile[];
  errors?: string[];
}

/** Injectable seam so tests drive the assembly without a live huginn. */
export interface IndexingOverviewDeps {
  fetchJobs: () => Promise<IndexingJobsResponse>;
}

/** Build the production deps that hit live huginn (never throws to the assembler
 *  — a `KnowledgeApiError` is caught there and pushed to `errors[]`). */
export function defaultIndexingDeps(
  knowledgeApiUrl: string,
  historyN: number = DEFAULT_HISTORY_N,
): IndexingOverviewDeps {
  return {
    fetchJobs: async () => {
      const data = await fetchKnowledgeApi(
        knowledgeApiUrl,
        `/api/indexing/jobs?history=${historyN}`,
      );
      return (data ?? { jobs: [] }) as IndexingJobsResponse;
    },
  };
}

// ---- Pure helpers (exported for unit tests) --------------------------------

/** Normalize a raw status string to one of the known statuses. */
export function normalizeStatus(raw: string | null | undefined): RunStatus {
  const v = (raw ?? "").toLowerCase().trim();
  return (KNOWN_STATUSES as readonly string[]).includes(v) ? (v as RunStatus) : "unknown";
}

const STATUS_LABELS: Record<RunStatus, string> = {
  succeeded: "succeeded",
  degraded: "degraded",
  failed: "failed",
  skipped: "skipped",
  running: "running",
  incomplete: "incomplete",
  unknown: "unknown",
};

export function statusBadge(raw: string | null | undefined): StatusBadge {
  const status = normalizeStatus(raw);
  return { status, label: STATUS_LABELS[status], cls: status };
}

/** Parse an ISO timestamp to epoch ms, or null on missing/garbage. */
export function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** Format a whole-second duration as "45s" / "2m 39s" / "1h 20m". Never "null s". */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

/** Relative time like "just now" / "5m ago" / "2h ago" / "3d ago" / a date. */
export function formatRelative(then: number | null, now: number): string | null {
  if (then == null) return null;
  const diff = now - then;
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

const WEEKDAY_NAMES = [
  "Sundays", // launchd/cron: 0 (and 7) = Sunday
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Human schedule string from a schedule shape (null ⇒ null). Handles the three
 *  live shapes plus a defensive unknown-kind fallback. */
export function describeSchedule(schedule: RawSchedule | null): string | null {
  if (!schedule) return null;
  if (schedule.kind === "calendar") {
    const hh = pad2(schedule.hour ?? 0);
    const mm = pad2(schedule.minute ?? 0);
    const weekday = schedule.weekday;
    if (weekday == null) return `daily ${hh}:${mm}`;
    const name = WEEKDAY_NAMES[((weekday % 7) + 7) % 7] ?? `weekday ${weekday}`;
    return `${name} ${hh}:${mm}`;
  }
  if (schedule.kind === "hourly") {
    return `hourly at :${pad2(schedule.minute ?? 0)}`;
  }
  if (schedule.kind === "interval") {
    return `every ${schedule.seconds ?? 0}s`;
  }
  return null;
}

/** Expected cadence of a schedule in ms (drives drift detection). Null when a
 *  schedule carries no usable interval (e.g. `interval` with 0 seconds). */
export function scheduleIntervalMs(schedule: RawSchedule | null): number | null {
  if (!schedule) return null;
  if (schedule.kind === "calendar") {
    return schedule.weekday == null ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  }
  if (schedule.kind === "hourly") return 60 * 60 * 1000;
  if (schedule.kind === "interval") {
    const ms = (schedule.seconds ?? 0) * 1000;
    return ms > 0 ? ms : null;
  }
  return null;
}

/**
 * Project the next fire of a schedule (epoch ms), or null for no/undatable
 * schedule. Calendar/hourly are computed in the SERVER's local timezone (launchd
 * schedules are local), so the countdown matches the wall-clock the jobs fire on.
 * Interval jobs advance from the last start (or now when never run).
 */
export function computeNextRunMs(
  schedule: RawSchedule | null,
  lastStartedAt: number | null,
  now: number,
): number | null {
  if (!schedule) return null;
  if (schedule.kind === "interval") {
    const iv = (schedule.seconds ?? 0) * 1000;
    if (iv <= 0) return null;
    const base = lastStartedAt ?? now;
    if (base > now) return base;
    const cycles = Math.floor((now - base) / iv) + 1;
    return base + cycles * iv;
  }
  if (schedule.kind === "hourly") {
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMinutes(schedule.minute ?? 0);
    if (d.getTime() <= now) d.setTime(d.getTime() + 60 * 60 * 1000);
    return d.getTime();
  }
  if (schedule.kind === "calendar") {
    const d = new Date(now);
    d.setHours(schedule.hour ?? 0, schedule.minute ?? 0, 0, 0);
    if (schedule.weekday == null) {
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    const target = ((schedule.weekday % 7) + 7) % 7;
    let guard = 0;
    while ((d.getDay() !== target || d.getTime() <= now) && guard < 8) {
      d.setDate(d.getDate() + 1);
      guard += 1;
    }
    return d.getTime();
  }
  return null;
}

/** Forward countdown string ("in 45m" / "in 18h 40m" / "in 3d 4h"). Null when
 *  the target is unknown; "due now" when it's already past. Unlike
 *  `formatDuration` (which stops at hours), this rolls into days for weekly jobs. */
export function formatCountdown(nextRunAtMs: number | null, now: number): string | null {
  if (nextRunAtMs == null) return null;
  const delta = nextRunAtMs - now;
  if (delta <= 0) return "due now";
  const totalMin = Math.floor(delta / 60000);
  if (totalMin < 60) return `in ${Math.max(1, totalMin)}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 48) return `in ${h}h${m ? ` ${m}m` : ""}`;
  const days = Math.floor(h / 24);
  const rh = h % 24;
  return `in ${days}d${rh ? ` ${rh}h` : ""}`;
}

/** Short age label for the worst-offender tile sub-line ("69d" / "5h" / "12m"). */
export function formatAge(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface RowHealth {
  attention: "stale" | "aging" | null;
  stale: boolean;
  aging: boolean;
  drifting: boolean;
  failed: boolean;
  ageMs: number | null;
}

/**
 * Assess a job's health. Scheduled jobs use drift (missed cycles) — the 7/14d
 * age rule would never fire on a daily job. Unscheduled tracked jobs use the
 * age bands. Never-tracked jobs (no last run) are quiet — no run to age against.
 */
export function assessRowHealth(job: RawJob, lastStartedAt: number | null, now: number): RowHealth {
  const failed = job.lastRun ? isFailedStatus(job.lastRun.status) : false;
  const ageMs = lastStartedAt != null ? Math.max(0, now - lastStartedAt) : null;
  let stale = false;
  let aging = false;
  let drifting = false;

  if (job.schedule != null) {
    const iv = scheduleIntervalMs(job.schedule);
    drifting = ageMs != null && iv != null && ageMs > iv * DRIFT_CYCLES;
  } else if (job.lastRun != null && ageMs != null) {
    if (ageMs > STALE_MS) stale = true;
    else if (ageMs > AGING_MS) aging = true;
  }

  const attention: RowHealth["attention"] = stale || drifting ? "stale" : aging ? "aging" : null;
  return { attention, stale, aging, drifting, failed, ageMs };
}

function isFailedStatus(raw: string | null | undefined): boolean {
  const s = normalizeStatus(raw);
  return s === "failed" || s === "degraded";
}

/** Sort medians incremental-first, then alphabetically — stable output. */
function sortMedians(median: Record<string, number>): MedianEntry[] {
  return Object.entries(median ?? {})
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === "incremental") return -1;
      if (b === "incremental") return 1;
      return a < b ? -1 : 1;
    })
    .map(([variant, secs]) => ({
      variant,
      duration: formatDuration(secs) ?? `${secs}s`,
    }));
}

/** Derive the display row for a single job. */
export function toRow(job: RawJob, now: number): IndexingRow {
  const last = job.lastRun;
  const lastStartedAt = parseTs(last?.startedAt);
  const current = job.current;
  const running = current != null;
  const currentStarted = parseTs(current?.startedAt);
  // Elapsed-or-nothing: never fabricate elapsed without a start timestamp.
  const runningElapsed =
    running && currentStarted != null
      ? formatDuration(Math.max(0, (now - currentStarted) / 1000))
      : null;

  const health = assessRowHealth(job, lastStartedAt, now);
  const nextRunAtMs = computeNextRunMs(job.schedule, lastStartedAt, now);

  return {
    collection: job.collection,
    loaded: Boolean(job.loaded),
    job: job.job ?? null,
    lastStatus: last ? statusBadge(last.status) : null,
    lastRelative: formatRelative(lastStartedAt, now),
    lastStartedAt,
    // durationSeconds is null for running/incomplete runs ⇒ null, never "null s".
    lastDuration: last ? formatDuration(last.durationSeconds) : null,
    medians: sortMedians(job.medianDurationSeconds),
    nextScheduled: describeSchedule(job.schedule),
    running,
    runningElapsed,
    detail: buildIndexingDetail(job),
    attention: health.attention,
    stale: health.stale,
    aging: health.aging,
    drifting: health.drifting,
    failed: health.failed,
    ageMs: health.ageMs,
    nextRunAtMs,
    nextRelative: formatCountdown(nextRunAtMs, now),
  };
}

/** Classify a job into exactly one of the three classes. */
export function classifyJob(job: RawJob): IndexingClassKey {
  if (job.schedule != null) return "scheduled";
  if (job.lastRun != null) return "tracked";
  return "never";
}

const CLASS_META: Record<IndexingClassKey, { title: string; subtitle: string }> = {
  scheduled: {
    title: "Scheduled & tracked",
    subtitle: "Jobs with a launchd schedule — these are the ones that can drift.",
  },
  tracked: {
    title: "Tracked, unscheduled",
    subtitle: "Ran at least once but has no schedule — manual scripts and watch daemons.",
  },
  never: {
    title: "Served, never tracked",
    subtitle: "Loaded and searchable but no recorded run — indexed once by hand.",
  },
};

const CLASS_ORDER: IndexingClassKey[] = ["scheduled", "tracked", "never"];

/**
 * Derive the four summary tiles from the flattened rows. Pure + unit-tested.
 *   - Healthy = rows needing no attention (not stale/aging/drifting/failed/running).
 *     Never-tracked rows count as healthy — loaded and searchable, no evidence of
 *     a problem (no timestamp to age).
 *   - Stale   = unscheduled rows past the stale threshold; sub names the worst.
 *   - Drift   = scheduled rows that have missed cycles.
 *   - Running = in-flight rows; idle sub shows the soonest next scheduled fire.
 */
export function computeTiles(rows: IndexingRow[], now: number): IndexingTile[] {
  const total = rows.length;
  const staleRows = rows.filter((r) => r.stale);
  const driftRows = rows.filter((r) => r.drifting);
  const runningRows = rows.filter((r) => r.running);
  const healthy = rows.filter(
    (r) => !r.stale && !r.aging && !r.drifting && !r.failed && !r.running,
  ).length;

  const worstStale = [...staleRows].sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0))[0];
  const staleSub = worstStale
    ? `${worstStale.collection} · ${formatAge(worstStale.ageMs) ?? "old"}`
    : "all fresh";

  const worstDrift = [...driftRows].sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0))[0];
  const driftSub = worstDrift
    ? `${worstDrift.collection} · ${formatAge(worstDrift.ageMs) ?? "overdue"}`
    : "all schedules on time";

  // Soonest upcoming scheduled fire (for the idle Running sub-line).
  const upcoming = rows
    .filter((r) => r.nextRunAtMs != null)
    .sort((a, b) => (a.nextRunAtMs ?? 0) - (b.nextRunAtMs ?? 0))[0];
  let runningSub: string;
  if (runningRows.length > 0) {
    const r = runningRows[0]!;
    runningSub = r.runningElapsed
      ? `${r.collection} · ${r.runningElapsed} elapsed`
      : r.collection;
  } else if (upcoming) {
    const cd = formatCountdown(upcoming.nextRunAtMs, now);
    runningSub = `next: ${upcoming.collection}${cd ? ` · ${cd}` : ""}`;
  } else {
    runningSub = "no schedules";
  }

  return [
    { label: "Healthy", value: `${healthy} / ${total}`, sub: "last run succeeded" },
    {
      label: "Stale",
      value: String(staleRows.length),
      sub: staleSub,
      ...(staleRows.length > 0 ? { tone: "warning" as const } : {}),
    },
    {
      label: "Drift",
      value: String(driftRows.length),
      sub: driftSub,
      ...(driftRows.length > 0 ? { tone: "warning" as const } : {}),
    },
    {
      label: "Running",
      value: String(runningRows.length),
      sub: runningSub,
      ...(runningRows.length > 0 ? { tone: "success" as const } : {}),
    },
  ];
}

/**
 * Assemble the full overview. Pure over its injected `fetchJobs` — the route
 * wires the huginn-backed default, the test wires a fabricated one. Never throws.
 */
export async function assembleIndexingOverview(
  deps: IndexingOverviewDeps,
  now: number = Date.now(),
): Promise<IndexingOverview> {
  const errors: string[] = [];
  let jobs: RawJob[] = [];
  try {
    const res = await deps.fetchJobs();
    jobs = Array.isArray(res?.jobs) ? res.jobs : [];
  } catch (err) {
    errors.push(`indexing jobs: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Group into the three classes; sort each by collection for stable output.
  const grouped: Record<IndexingClassKey, IndexingRow[]> = {
    scheduled: [],
    tracked: [],
    never: [],
  };
  for (const job of jobs) {
    grouped[classifyJob(job)].push(toRow(job, now));
  }
  for (const key of CLASS_ORDER) {
    grouped[key].sort((a, b) => (a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0));
  }

  const classes: IndexingClass[] = CLASS_ORDER.map((key) => ({
    key,
    title: CLASS_META[key].title,
    subtitle: CLASS_META[key].subtitle,
    rows: grouped[key],
  }));

  const allRows = CLASS_ORDER.flatMap((key) => grouped[key]);

  if (errors.length > 0) {
    log.warn("indexing overview assembled with {count} degraded source(s)", { count: errors.length });
  }

  return {
    generatedAt: now,
    total: jobs.length,
    classes,
    tiles: computeTiles(allRows, now),
    ...(errors.length > 0 ? { errors } : {}),
  };
}
