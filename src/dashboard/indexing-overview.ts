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
import { getLog } from "../logging.ts";

const log = getLog("dashboard", "indexing");

/** How much run history to request from huginn (per-collection `history[]`). */
export const DEFAULT_HISTORY_N = 20;

// ---- Raw huginn contract (only the fields we read) -------------------------

/** One phase of a run (reindex / embed / …). */
export interface RawPhase {
  name?: string;
  status?: string;
  durationSeconds?: number | null;
  fatal?: boolean;
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
}

export type IndexingClassKey = "scheduled" | "tracked" | "never";

export interface IndexingClass {
  key: IndexingClassKey;
  title: string;
  subtitle: string;
  rows: IndexingRow[];
}

export interface IndexingOverview {
  generatedAt: number;
  total: number;
  classes: IndexingClass[];
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

  if (errors.length > 0) {
    log.warn("indexing overview assembled with {count} degraded source(s)", { count: errors.length });
  }

  return {
    generatedAt: now,
    total: jobs.length,
    classes,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
