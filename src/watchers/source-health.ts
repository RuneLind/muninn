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
  };
}

/**
 * Should this source alert on this run? True on EVERY run at or past the threshold —
 * suppression of the repeats is the RUNNER's id-dedup job, not ours (see
 * {@link healthAlertId}).
 *
 * That split is deliberate and load-bearing. The obvious design — "alert once, record
 * that we did, stay quiet for N more failures" — has to commit its bookkeeping when the
 * alert is BUILT, which is long before the runner has actually delivered it. A watcher
 * timeout or a transient Telegram error after that write silently swallows the alert AND
 * the record of it, so the source goes quiet for another full re-escalation window — the
 * exact "silently dead source" failure this module exists to prevent. Emitting every run
 * and letting id-dedup collapse them means an undelivered alert is simply re-emitted next
 * run, because the runner only records an id it managed to send.
 */
export function shouldEscalate(h: SourceHealth): boolean {
  return h.outcome !== "ok" && h.consecutive >= HEALTH_ESCALATE_AFTER;
}

/**
 * Stable alert id for one source's current unhealthy EPISODE and nag bucket.
 *
 * Two properties matter, and an earlier cut got both wrong by keying on `consecutive`:
 * - **Stable within an episode**, so re-emitting every run collapses to ONE delivery.
 * - **Distinct across episodes**, so a source that recovers and later wedges again is
 *   heard. Keying on `consecutive` alone produced a byte-identical id for the second
 *   wedge (`recordOutcome` resets the streak on recovery), and the runner's 600-id
 *   `lastNotifiedIds` window — already full on the live rows — dropped it. The next
 *   chance to be heard would have been 24 further failures: 48h on the 2h row, ~24 WEEKS
 *   on the weekly one.
 *
 * `lastOkAt` is the episode discriminator (the moment the source was last healthy);
 * `never` covers a source that has never succeeded.
 */
export function healthAlertId(watcherName: string, key: string, h: SourceHealth): string {
  const episode = h.lastOkAt ?? "never";
  const bucket = Math.floor((h.consecutive - HEALTH_ESCALATE_AFTER) / HEALTH_RE_ESCALATE_EVERY);
  return `watcher-health:${watcherName}:${key}:${episode}:${bucket}`;
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
  // The ceiling itself is floored at 2 intervals, because a window SHORTER than the poll
  // interval is nonsense: a 7d source's `lastOkAt` is ~7d old on its very next run, so a
  // flat 4-day ceiling made one transient 503 render a red `stale` chip indistinguishable
  // from a source wedged for months, and made `warn` unreachable on that row entirely.
  const ceiling = Math.max(HEALTH_STALE_CEILING_MS, 2 * intervalMs);
  return Math.min(Math.max(3 * intervalMs, 86_400_000), ceiling);
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
 * One alert for every source at or past its escalation threshold. Returns an empty array
 * when nothing needs saying — the common case, so this never adds noise. PURE: it mutates
 * nothing, so there is no bookkeeping that can be committed before delivery (see
 * {@link shouldEscalate}); the runner's id-dedup does the suppression.
 */
export function buildHealthAlerts(
  watcherName: string,
  map: SourceHealthMap,
  now: number,
): WatcherAlert[] {
  const alerts: WatcherAlert[] = [];
  for (const [key, h] of Object.entries(map)) {
    if (!shouldEscalate(h)) continue;
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
      id: healthAlertId(watcherName, key, h),
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
