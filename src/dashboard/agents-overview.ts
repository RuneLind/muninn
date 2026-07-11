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
  type RecentExtractorRow,
  type RecentTraceRow,
} from "../db/agent-activity.ts";
import { getLog } from "../logging.ts";

const log = getLog("dashboard", "agents");

const OSLO = "Europe/Oslo";
/** Kinds whose Recent rows are sourced from the registry ring only — every other
 *  kind has a durable trace/usage row, so taking them from the ring too would
 *  double-count. */
const RING_RECENT_KINDS: ReadonlySet<AgentKind> = new Set<AgentKind>([
  "gardener_drain",
  "capture",
  "research",
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
}

export interface AgentsOverview {
  generatedAt: number;
  running: AgentRun[];
  upNext: UpNextEntry[];
  recent: RecentEntry[];
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
}

export const DEFAULT_AGENTS_OVERVIEW_DEPS: AgentsOverviewDeps = {
  getRunning: () => agentStatus.getAll().filter((r) => !r.completed),
  getCompletedRing: () => agentStatus.getRecentCompleted(),
  getScheduledTasks: () => getAllScheduledTasks(),
  getWatchers: () => getAllWatchers(),
  getRecentTraces: () => getRecentAgentTraces(),
  getRecentExtractors: () => getRecentExtractorUsage(),
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
 * Next expected fire for a watcher — mirrors `isScheduledTimeDue`
 * (src/watchers/runner.ts). `force_next_run` ⇒ next tick; a time-of-day
 * (`config.hour`) watcher fires at today's hour:minute if that hasn't passed and
 * it hasn't already run today, otherwise tomorrow's slot; a slot that has passed
 * today without a run is "due now". No `config.hour` ⇒ `last_run_at + interval`.
 */
export function computeWatcherNextRun(w: Watcher, now: number): { nextRunAt: number; label?: string } {
  if (w.forceNextRun) return { nextRunAt: now, label: "queued for next tick" };
  const cfg = (w.config ?? {}) as { hour?: number; minute?: number };
  if (cfg.hour != null) {
    const minute = cfg.minute ?? 0;
    const ranToday = w.lastRunAt != null && sameOsloDay(w.lastRunAt, now);
    if (ranToday) return { nextRunAt: osloSlotMs(now, cfg.hour, minute, 1) };
    const todaySlot = osloSlotMs(now, cfg.hour, minute, 0);
    if (todaySlot > now) return { nextRunAt: todaySlot };
    return { nextRunAt: todaySlot, label: "due now" }; // slot passed, not yet run
  }
  if (w.lastRunAt == null) return { nextRunAt: now, label: "due now" };
  return { nextRunAt: w.lastRunAt + w.intervalMs };
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
  };
}

function extractorToRecent(r: RecentExtractorRow): RecentEntry {
  return {
    kind: "extractor",
    bot: r.botName,
    name: `Extractor: ${r.source}`,
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
  };
}

function kindLabel(kind?: AgentKind): string {
  switch (kind) {
    case "gardener_drain": return "Gardener drain";
    case "capture": return "Capture job";
    case "research": return "Research";
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

  const [tasks, watchers, traces, extractors] = await Promise.all([
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
  ]);

  const running = deps.getRunning();

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
    running,
    upNext: upNext.slice(0, UP_NEXT_LIMIT),
    recent: recent.slice(0, RECENT_LIMIT),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function _internalsForTest() {
  return { osloSlotMs, osloWallParts, sameOsloDay, RING_RECENT_KINDS, kindLabel };
}
