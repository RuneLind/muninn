/**
 * Per-source health tracking for watchers that poll several sub-sources in one run.
 *
 * WHY THIS EXISTS. On 2026-07-21 the anthropic watcher's `llms.txt` leg stopped diffing
 * and stayed dead for six days. Nothing was broken in a way anything could see: the
 * watcher ran on schedule, `last_run_at` advanced every 2h, the blog legs kept producing
 * alerts, and the only trace of the failure was a WARN line in `logs/`. A source can be
 * 100% dead while every indicator we render says healthy, because our indicators are all
 * WATCHER-level and the failure was SOURCE-level.
 *
 * The rule this encodes: **any defensive skip that can persist across runs needs a
 * counter, a bound, and a surface.** Layer A/B in `anthropic.ts` supply the counter and
 * the bound; this module is the surface, plus the escalation that turns six days of
 * silence into one message on day one.
 *
 * Deliberately GENERIC (per the plan's settled decision #2): the escalation is a plain
 * `WatcherAlert` built here, not anthropic-specific outreach, because the Phase-4 audit is
 * expected to find more watchers with the same shape and a per-watcher alert would have to
 * be rebuilt each time. Storage is the existing `watcher_snapshots` table, so there is no
 * migration.
 */
import type { WatcherAlert } from "../types.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "source-health");

/** Snapshot key holding one watcher's whole per-source health map. */
export const SOURCE_HEALTH_KEY = "source:health";

/**
 * Consecutive non-`ok` runs of the SAME source before one alert is sent. 3 is low on
 * purpose — the cost of a false alarm is one Telegram line, the cost of a miss is what
 * this module exists to prevent.
 */
export const HEALTH_ESCALATE_AFTER = 3;
/**
 * Skips between repeat alerts once a source is already escalated. Without this the alert
 * fires once and a source dead for a month looks the same as one dead for an hour; with
 * it, a wedge keeps nagging without becoming per-run spam.
 */
export const HEALTH_RE_ESCALATE_EVERY = 24;

export type SourceOutcome = "ok" | "skipped" | "error";

export interface SourceHealth {
  /** Outcome of this source's most recent run. */
  outcome: SourceOutcome;
  /** Epoch ms of that run. */
  at: number;
  /** Short human-readable reason, for non-`ok` outcomes. */
  detail?: string;
  /** Consecutive non-`ok` runs. Reset to 0 by an `ok`. */
  consecutive: number;
  /** Epoch ms of the last run whose outcome was `ok` — the real freshness signal. */
  lastOkAt?: number;
  /** `consecutive` at the last escalation, so repeats are spaced rather than per-run. */
  escalatedAtCount?: number;
}

/** The whole map for one watcher, keyed by source key (e.g. `tier2:llms`). */
export type SourceHealthMap = Record<string, SourceHealth>;

export function isSourceHealthMap(v: unknown): v is SourceHealthMap {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (h) => !!h && typeof h === "object" && typeof (h as SourceHealth).outcome === "string",
  );
}

/**
 * Fold one run's outcome for one source into its prior health record. Pure — the caller
 * owns loading/persisting the map, so this is unit-testable without a DB.
 */
export function recordOutcome(
  prior: SourceHealth | undefined,
  outcome: SourceOutcome,
  now: number,
  detail?: string,
): SourceHealth {
  if (outcome === "ok") {
    return { outcome, at: now, consecutive: 0, lastOkAt: now };
  }
  return {
    outcome,
    at: now,
    ...(detail ? { detail } : {}),
    consecutive: (prior?.consecutive ?? 0) + 1,
    ...(prior?.lastOkAt != null ? { lastOkAt: prior.lastOkAt } : {}),
    ...(prior?.escalatedAtCount != null ? { escalatedAtCount: prior.escalatedAtCount } : {}),
  };
}

/**
 * Should this source alert on this run? True on the run that crosses the threshold, then
 * only every `HEALTH_RE_ESCALATE_EVERY` further consecutive failures.
 */
export function shouldEscalate(h: SourceHealth): boolean {
  if (h.outcome === "ok" || h.consecutive < HEALTH_ESCALATE_AFTER) return false;
  if (h.escalatedAtCount == null) return true;
  return h.consecutive - h.escalatedAtCount >= HEALTH_RE_ESCALATE_EVERY;
}

/**
 * Age a source's `lastOkAt` into a staleness verdict for the dashboard chip.
 *
 * The bound is `max(3 × interval, 24h)` with a CEILING, because a raw 3× multiplier is
 * meaningless at both ends of our cadence range: 6h on the 2h Highlights row (noisy) and
 * 21 days on the 7d weekly row (uselessly permissive — the wedge this came from lasted 6).
 */
export const HEALTH_STALE_CEILING_MS = 4 * 86_400_000;

export function stalenessMs(intervalMs: number): number {
  return Math.min(Math.max(3 * intervalMs, 86_400_000), HEALTH_STALE_CEILING_MS);
}

export type HealthLevel = "ok" | "warn" | "stale";

/**
 * `ok` — advanced on its last run. `warn` — skipped/errored recently but still within its
 * staleness window. `stale` — hasn't succeeded inside the window, i.e. `last_run_at` being
 * fresh no longer implies this source is doing anything.
 */
export function healthLevel(h: SourceHealth, intervalMs: number, now: number): HealthLevel {
  if (h.outcome === "ok") return "ok";
  const since = h.lastOkAt == null ? Number.POSITIVE_INFINITY : now - h.lastOkAt;
  return since > stalenessMs(intervalMs) ? "stale" : "warn";
}

/**
 * One alert for every source that crossed its escalation threshold this run. Returns an
 * empty array when nothing needs saying — the common case, so this never adds noise.
 * MUTATES `escalatedAtCount` on the escalating entries so the caller persists the
 * bookkeeping along with the outcomes.
 */
export function buildHealthAlerts(
  watcherName: string,
  map: SourceHealthMap,
  now: number,
): WatcherAlert[] {
  const alerts: WatcherAlert[] = [];
  for (const [key, h] of Object.entries(map)) {
    if (!shouldEscalate(h)) continue;
    h.escalatedAtCount = h.consecutive;
    const hours = h.lastOkAt == null ? null : Math.round((now - h.lastOkAt) / 3_600_000);
    const since = hours == null ? "never succeeded" : `no successful run in ${hours}h`;
    log.error("Watcher \"{name}\": source {key} unhealthy — {n} consecutive {outcome} ({detail})", {
      name: watcherName,
      key,
      n: h.consecutive,
      outcome: h.outcome,
      detail: h.detail ?? "no detail",
    });
    alerts.push({
      // Keyed by the streak length so each escalation is its own alert and the runner's
      // id-dedup can't swallow a repeat, while a re-run of the SAME state stays deduped.
      id: `watcher-health:${watcherName}:${key}:${h.consecutive}`,
      source: "watcher-health",
      sender: "Watcher health",
      subject: `${watcherName}: ${key} ${h.outcome}`,
      summary:
        `⚠️ **Watcher health** — \`${watcherName}\` source \`${key}\` has been **${h.outcome}** ` +
        `for ${h.consecutive} consecutive run(s) (${since}).` +
        (h.detail ? `\n_${h.detail}_` : "") +
        `\nThe watcher itself is running fine — this source alone is not producing data.`,
      urgency: "medium",
    });
  }
  return alerts;
}
