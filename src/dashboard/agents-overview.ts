/**
 * Agents overview — server-side assembly of the `/agents` dashboard's
 * `running` · `upNext` · `recent` lists. Pure over its injected deps (modeled on
 * `assembleModelsOverview`): the route wires DB-backed + registry-backed
 * defaults, the test wires fabricated ones.
 *
 * Sources of truth:
 *   - `running`  — the AgentRun registry (`agentStatus.getAll()`, non-completed).
 *   - `upNext`   — `scheduled_tasks.next_run_at` (precomputed) + watchers, whose
 *                  next fire mirrors `isScheduledTimeDue` (time-of-day slot
 *                  dominates a naive `last_run_at + interval_ms`).
 *   - `recent`   — a UNION keyed by span NAME (NOT `parent_id IS NULL`): chat +
 *                  watcher trace spans, extractor `haiku_usage` rows, and the
 *                  registry's completed-runs ring for kinds with no durable
 *                  source (gardener_drain / capture / research / per-task).
 */

import type { AgentKind, AgentRun } from "../observability/agent-status.ts";
import { agentStatus } from "../observability/agent-status.ts";
import type { ScheduledTask, Watcher } from "../types.ts";
import { getAllScheduledTasks } from "../db/scheduled-tasks.ts";
import { getAllWatchers } from "../db/watchers.ts";
import {
  getRecentAgentTraces,
  getRecentExtractorUsage,
  getWatcherRunDurations,
  type RecentExtractorRow,
  type RecentTraceRow,
  type WatcherDurationRow,
} from "../db/agent-activity.ts";
import { buildRunEstimates } from "./agent-eta.ts";
import { getLog } from "../logging.ts";

/** Captured at module load (≈ server start). The `/agents` "process restarted"
 *  empty state reads this to say when the in-memory history last reset. */
export const PROCESS_STARTED_AT = Date.now();

const log = getLog("dashboard", "agents");

const OSLO = "Europe/Oslo";
/** Kinds whose Recent rows are sourced from the registry ring only — every other
 *  kind has a durable trace/usage row, so taking them from the ring too would
 *  double-count. */
const RING_RECENT_KINDS: ReadonlySet<AgentKind> = new Set<AgentKind>([
  "gardener_drain",
  "capture",
  "research",
  "digest",
  "scheduled_task",
]);

export interface UpNextEntry {
  kind: AgentKind;
  bot: string;
  name: string;
  /** Epoch ms of the next expected fire. May be in the past ⇒ "due now". */
  nextRunAt: number;
  /** Optional label ("queued for next tick", "due now"). */
  label?: string;
  sourcePage?: string;
}

export interface RecentEntry {
  kind: AgentKind;
  bot: string | null;
  name: string;
  /** Epoch ms the run finished. */
  finishedAt: number;
  durationMs?: number;
  status?: string;
  traceId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Run cost in USD. Absent ⇒ unknown → the client renders a dash; an explicit
   *  `0` (subscription connectors) is kept and renders `$0.00`. Extractor rows
   *  (haiku_usage has no cost column) and gardener drains (no token/cost meta)
   *  are always absent here. */
  costUsd?: number;
}

export interface AgentsOverview {
  generatedAt: number;
  /** Epoch ms the muninn process started — the "history resets on restart" note. */
  processStartedAt: number;
  running: AgentRun[];
  upNext: UpNextEntry[];
  recent: RecentEntry[];
  /**
   * Per-identity `expectedDurationMs` for the LIVE runs, keyed by
   * `estimateIdentity(kind, name)` (`src/dashboard/agent-eta.ts`). The SSE
   * `agent_runs` cards carry no estimate; the client looks each run up here.
   * Absent identity ⇒ no history ⇒ the card renders elapsed-only.
   */
  estimates: Record<string, number>;
  errors?: string[];
}

/** Injectable seams so the route test drives assembly without a live DB. */
export interface AgentsOverviewDeps {
  getRunning: () => AgentRun[];
  getCompletedRing: () => AgentRun[];
  getScheduledTasks: () => Promise<ScheduledTask[]>;
  getWatchers: () => Promise<Watcher[]>;
  getRecentTraces: () => Promise<RecentTraceRow[]>;
  getRecentExtractors: () => Promise<RecentExtractorRow[]>;
  getWatcherDurations: () => Promise<WatcherDurationRow[]>;
}

export const DEFAULT_AGENTS_OVERVIEW_DEPS: AgentsOverviewDeps = {
  getRunning: () => agentStatus.getAll().filter((r) => !r.completed),
  getCompletedRing: () => agentStatus.getRecentCompleted(),
  getScheduledTasks: () => getAllScheduledTasks(),
  getWatchers: () => getAllWatchers(),
  getRecentTraces: () => getRecentAgentTraces(),
  getRecentExtractors: () => getRecentExtractorUsage(),
  getWatcherDurations: () => getWatcherRunDurations(),
};

const RECENT_LIMIT = 40;
const UP_NEXT_LIMIT = 25;

// ── Europe/Oslo wall-clock helpers (mirror db/scheduled-tasks.ts arithmetic) ──

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

interface OsloParts { year: number; month: number; day: number; hour: number; minute: number; }

function osloWallParts(ms: number): OsloParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: OSLO,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute),
  };
}

/** Epoch ms of hour:minute in Europe/Oslo on the calendar day `addDays` from the
 *  Oslo day of `baseMs`. Uses the same UTC-offset trick as computeNextCronRun. */
function osloSlotMs(baseMs: number, hour: number, minute: number, addDays: number): number {
  const { year, month, day } = osloWallParts(baseMs);
  const shifted = new Date(year, month - 1, day + addDays);
  const y = shifted.getFullYear();
  const mo = shifted.getMonth() + 1;
  const da = shifted.getDate();
  const dateStr = `${y}-${pad(mo)}-${pad(da)}T${pad(hour)}:${pad(minute)}:00`;
  const approx = new Date(dateStr + "Z"); // treat wall-clock as UTC first
  const utcStr = approx.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = approx.toLocaleString("en-US", { timeZone: OSLO });
  const offsetMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();
  return approx.getTime() + offsetMs;
}

function sameOsloDay(a: number, b: number): boolean {
  const pa = osloWallParts(a);
  const pb = osloWallParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/**
 * Next expected fire for a watcher — mirrors the AND of the TWO gates a watcher
 * actually passes each tick: the DB **interval** gate (`last_run_at +
 * interval_ms <= now()`, src/db/watchers.ts) AND `isScheduledTimeDue`
 * (src/watchers/runner.ts). A watcher fires at the first tick where BOTH hold.
 *
 * `force_next_run` ⇒ next tick. No `config.hour` ⇒ pure interval
 * (`last_run_at + interval_ms`). With `config.hour` we compute the earliest
 * instant satisfying both gates: first the interval floor
 * (`max(last_run_at + interval_ms, now)`), then advance to the next valid
 * hour:minute slot ≥ that floor whose Oslo day differs from `last_run_at`'s
 * (the "not already run that day" rule). If the floor itself is already past
 * today's slot on an eligible day, both gates hold there ⇒ fires at the floor
 * ("due now" when that floor ≤ now). This is why the seeded weekly gardener
 * (interval 7d + hour 10) reads ~next Sunday 10:00, not "due now" every day —
 * the interval gate dominates until a week has elapsed.
 */
export function computeWatcherNextRun(w: Watcher, now: number): { nextRunAt: number; label?: string } {
  if (w.forceNextRun) return { nextRunAt: now, label: "queued for next tick" };
  const cfg = (w.config ?? {}) as { hour?: number; minute?: number };

  // Pure-interval watcher (no time-of-day gate).
  if (cfg.hour == null) {
    if (w.lastRunAt == null) return { nextRunAt: now, label: "due now" };
    return { nextRunAt: w.lastRunAt + w.intervalMs };
  }

  // Combined interval + time-of-day gate.
  const minute = cfg.minute ?? 0;
  // Instant from which the interval gate is satisfied, clamped to now.
  const intervalFloor = w.lastRunAt != null ? w.lastRunAt + w.intervalMs : now;
  const earliest = Math.max(intervalFloor, now);

  // Is the time-of-day gate ALSO already satisfied at `earliest`? (slot already
  // passed that Oslo day, and we didn't run that day) → both gates hold there.
  const parts = osloWallParts(earliest);
  const pastSlotAtEarliest = parts.hour > cfg.hour || (parts.hour === cfg.hour && parts.minute >= minute);
  const ranEarliestDay = w.lastRunAt != null && sameOsloDay(earliest, w.lastRunAt);
  if (pastSlotAtEarliest && !ranEarliestDay) {
    return earliest <= now ? { nextRunAt: now, label: "due now" } : { nextRunAt: earliest };
  }

  // Otherwise advance to the first slot ≥ earliest on a day we didn't run.
  for (let addDays = 0; addDays <= 8; addDays++) {
    const slot = osloSlotMs(earliest, cfg.hour, minute, addDays);
    if (slot < earliest) continue; // slot already passed on this day
    if (w.lastRunAt != null && sameOsloDay(slot, w.lastRunAt)) continue; // already ran that day
    return { nextRunAt: slot };
  }
  return { nextRunAt: earliest }; // unreachable in practice
}

// ── Recent mappers ────────────────────────────────────────────────────────────

function traceToRecent(r: RecentTraceRow): RecentEntry {
  const isWatcher = r.name.startsWith("watcher:");
  const finishedAt = r.startedAt + (r.durationMs ?? 0);
  return {
    kind: isWatcher ? "watcher" : "chat",
    bot: r.botName,
    name: isWatcher ? r.name.slice("watcher:".length) : "Chat turn",
    finishedAt,
    ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
    status: r.status,
    traceId: r.traceId,
    ...(r.model ? { model: r.model } : {}),
    // Token totals come off the root span's own attributes — watcher spans via the
    // runner, chat roots via message-processor's t.finish (externally-traced chat
    // turns skip the stamp and stay tokenless).
    ...(r.inputTokens != null ? { inputTokens: r.inputTokens } : {}),
    ...(r.outputTokens != null ? { outputTokens: r.outputTokens } : {}),
    // Preserve an explicit 0 (subscription connectors) — only null is "unknown".
    ...(r.costUsd != null ? { costUsd: r.costUsd } : {}),
  };
}

const GARDENER_SOURCE_LABELS: Record<string, string> = {
  wiki_gardener_cluster: "Gardener: cluster",
  wiki_gardener_triage: "Gardener: triage",
  wiki_gardener_draft: "Gardener: draft",
  interest_profile: "Interest profile",
};

function extractorToRecent(r: RecentExtractorRow): RecentEntry {
  return {
    kind: "extractor",
    bot: r.botName,
    name: GARDENER_SOURCE_LABELS[r.source] ?? `Extractor: ${r.source}`,
    finishedAt: r.createdAt,
    ...(r.model ? { model: r.model } : {}),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  };
}

function ringToRecent(r: AgentRun): RecentEntry {
  const finishedAt = r.completedAt ?? r.startedAt;
  return {
    kind: r.kind ?? "chat",
    bot: r.botName ?? null,
    name: r.name ?? kindLabel(r.kind),
    finishedAt,
    durationMs: Math.max(finishedAt - r.startedAt, 0),
    status: "ok",
    ...(r.traceId ? { traceId: r.traceId } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.inputTokens != null ? { inputTokens: r.inputTokens } : {}),
    ...(r.outputTokens != null ? { outputTokens: r.outputTokens } : {}),
    // Preserve an explicit 0 — only undefined is "unknown". Drains complete with
    // no meta (costUsd undefined ⇒ dash).
    ...(r.costUsd != null ? { costUsd: r.costUsd } : {}),
  };
}

// NB: mirror of the client `kindLabels` map in views/agents-page.ts — a new
// AgentKind must be added to BOTH (server Recent labels + client pill labels).
function kindLabel(kind?: AgentKind): string {
  switch (kind) {
    case "gardener_drain": return "Gardener drain";
    case "capture": return "Capture job";
    case "research": return "Research";
    case "digest": return "Wiki digest";
    case "scheduled_task": return "Scheduled task";
    case "extractor": return "Extractor";
    case "watcher": return "Watcher";
    case "profile": return "Profile";
    default: return "Chat turn";
  }
}

// ── Assembly ──────────────────────────────────────────────────────────────────

/**
 * Assemble the full overview. Pure over its injected deps; each async source is
 * caught independently so one degraded source lands in `errors[]` rather than
 * failing the whole page (never a 5xx).
 */
export async function assembleAgentsOverview(
  deps: AgentsOverviewDeps = DEFAULT_AGENTS_OVERVIEW_DEPS,
  now: number = Date.now(),
): Promise<AgentsOverview> {
  const errors: string[] = [];

  const [tasks, watchers, traces, extractors, watcherDurations] = await Promise.all([
    deps.getScheduledTasks().catch((err) => {
      errors.push(`scheduled_tasks: ${err instanceof Error ? err.message : String(err)}`);
      return [] as ScheduledTask[];
    }),
    deps.getWatchers().catch((err) => {
      errors.push(`watchers: ${err instanceof Error ? err.message : String(err)}`);
      return [] as Watcher[];
    }),
    deps.getRecentTraces().catch((err) => {
      errors.push(`traces: ${err instanceof Error ? err.message : String(err)}`);
      return [] as RecentTraceRow[];
    }),
    deps.getRecentExtractors().catch((err) => {
      errors.push(`haiku_usage: ${err instanceof Error ? err.message : String(err)}`);
      return [] as RecentExtractorRow[];
    }),
    deps.getWatcherDurations().catch((err) => {
      errors.push(`watcher_durations: ${err instanceof Error ? err.message : String(err)}`);
      return [] as WatcherDurationRow[];
    }),
  ]);

  const running = deps.getRunning();
  // A live watcher run's name is its DISPLAY name (`watcher.name || watcher.type`),
  // but the durable durations bucket by TYPE — map display → type so the lookup hits.
  const watcherTypeByName: Record<string, string> = {};
  for (const w of watchers) watcherTypeByName[w.name || w.type] = w.type;
  // ETA estimates for the live runs — watchers from the durable trace source,
  // everything else from the in-memory ring; a degraded watcher_durations source
  // just means watcher runs fall back to elapsed-only.
  const estimates = buildRunEstimates(running, deps.getCompletedRing(), watcherDurations, watcherTypeByName);

  // ---- upNext --------------------------------------------------------------
  const upNext: UpNextEntry[] = [];
  for (const t of tasks) {
    if (!t.enabled || t.nextRunAt == null) continue;
    upNext.push({ kind: "scheduled_task", bot: t.botName, name: t.title, nextRunAt: t.nextRunAt });
  }
  for (const w of watchers) {
    if (!w.enabled) continue;
    const { nextRunAt, label } = computeWatcherNextRun(w, now);
    upNext.push({
      kind: "watcher",
      bot: w.botName,
      name: w.name || w.type,
      nextRunAt,
      ...(label ? { label } : {}),
      ...(w.type === "wiki-gardener" ? { sourcePage: "/wiki/gardener" } : {}),
    });
  }
  upNext.sort((a, b) => a.nextRunAt - b.nextRunAt);

  // ---- recent (four-source union, per-kind source-of-truth) ----------------
  const recent: RecentEntry[] = [
    ...traces.map(traceToRecent),
    ...extractors.map(extractorToRecent),
    ...deps.getCompletedRing().filter((r) => RING_RECENT_KINDS.has(r.kind ?? "chat")).map(ringToRecent),
  ];
  recent.sort((a, b) => b.finishedAt - a.finishedAt);

  if (errors.length > 0) {
    log.warn("agents overview assembled with {count} degraded source(s)", { count: errors.length });
  }

  return {
    generatedAt: now,
    processStartedAt: PROCESS_STARTED_AT,
    running,
    upNext: upNext.slice(0, UP_NEXT_LIMIT),
    recent: recent.slice(0, RECENT_LIMIT),
    estimates,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function _internalsForTest() {
  return { osloSlotMs, osloWallParts, sameOsloDay, RING_RECENT_KINDS, kindLabel };
}
