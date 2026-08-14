/**
 * WATCHER-RUN health — did the run itself get anywhere?
 *
 * WHY THIS EXISTS. `source-health.ts` tracks the sub-sources *inside* a run, which
 * only helps a checker that RETURNS. A checker that THROWS never reaches its
 * recorder, and until now the entire consequence of a throw was one `log.error`
 * line plus a red child span on `/traces` — neither of which anyone sees unless
 * they go looking on purpose.
 *
 * The email watcher is the case that forced it. #434 turned its silent wrong
 * answers (`[]` from a run that never reached Gmail) into loud throws, and the day
 * of organic ticks that followed failed 7 times out of 12 — with the user told
 * nothing, because "loud in the logs" is not loud to a person. That is the same
 * shape as the six-day dead `llms.txt` leg that motivated source-health, one level
 * up: an indicator that stays green because every indicator we render is about
 * something narrower than what broke.
 *
 * Deliberately reuses source-health's `recordOutcome` fold, its nag bucket and its
 * alert-id convention, so the runner's existing `lastNotifiedIds` dedup collapses
 * the hourly repeats with no new bookkeeping — and so the two health surfaces
 * cannot drift into two different definitions of "unhealthy".
 *
 * Stored under its OWN snapshot key. `source:health` is a map the per-source
 * recorder REBUILDS from the sources configured this run, dropping anything it did
 * not mark (a de-configured source must not linger with a frozen chip). A run-level
 * entry written into that map would be deleted by the next anthropic/x run — or,
 * written the other way round, would delete that run's per-source chips.
 *
 * EVERY DB SEAM IS INJECTABLE, and that is not style. A `mock.module` test of this
 * file invalidates `db/*` for the whole `bun test src/watchers/` chunk; the first
 * cut did exactly that and silently broke six of `x.test.ts`'s assertions. Passing
 * the seams as parameters is the same call `runner.ts` makes for `WikiCheckers`,
 * for the same reason.
 */
import type { Api } from "grammy";
import type { Watcher, WatcherAlert } from "../types.ts";
import { getWatcherSnapshot, setWatcherSnapshot } from "../db/watchers.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml, stripHtml } from "../bot/telegram-format.ts";
import { activityLog } from "../observability/activity-log.ts";
import { formatAlerts } from "./format-alerts.ts";
import {
  recordOutcome,
  healthAlertId,
  HEALTH_ESCALATE_AFTER,
  type SourceHealth,
  type SourceOutcome,
} from "./source-health.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "run-health");

/** Snapshot key holding one watcher's RUN-level health record. */
export const RUN_HEALTH_KEY = "run:health";
/**
 * Map key inside that snapshot. The value is stored as a one-entry map rather than
 * a bare record so it is shaped exactly like `source:health` — the dashboard reads
 * both through the same guard and renders both as chips.
 *
 * Namespaced rather than a bare `run`, because the dashboard spreads the two maps
 * into one chip list and `healthAlertId` keys on this string: a per-source key that
 * ever happened to be called `run` would both hide the run chip and let a source
 * escalation suppress a run escalation through the shared `lastNotifiedIds` window.
 */
export const RUN_HEALTH_ENTRY = "watcher:run";

/**
 * A watcher this slow gets ONE failure's grace, not three.
 *
 * `HEALTH_ESCALATE_AFTER` is a RUN count — a sane bound at source-health's cadence
 * and nonsense at this one. Three runs is ~3h on the hourly email row but **three
 * weeks** on the four weekly rows (both digests, both gardeners), after which the
 * nag bucket would wait 24 more weeks. source-health's own docstring calls out that
 * exact "~24 WEEKS on the weekly one" arithmetic as the bug it fixed for alert IDs;
 * inheriting the threshold wholesale imports it one level up.
 */
export const SLOW_WATCHER_INTERVAL_MS = 24 * 3_600_000;

export function runEscalateAfter(intervalMs: number): number {
  return intervalMs >= SLOW_WATCHER_INTERVAL_MS ? 1 : HEALTH_ESCALATE_AFTER;
}

export interface RunHealthDeps {
  getSnapshot: (watcherId: string, key: string) => Promise<unknown | null>;
  setSnapshot: (watcherId: string, key: string, value: unknown) => Promise<void>;
}

const DEFAULT_HEALTH_DEPS: RunHealthDeps = {
  getSnapshot: getWatcherSnapshot,
  setSnapshot: setWatcherSnapshot,
};

function isSourceHealth(v: unknown): v is SourceHealth {
  return !!v && typeof v === "object" && typeof (v as SourceHealth).outcome === "string";
}

/** Read one watcher's stored run-health record, or undefined. Never throws. */
export async function loadRunHealth(
  watcherId: string,
  deps: RunHealthDeps = DEFAULT_HEALTH_DEPS,
): Promise<SourceHealth | undefined> {
  try {
    const snap = await deps.getSnapshot(watcherId, RUN_HEALTH_KEY);
    const entry = (snap as Record<string, unknown> | null)?.[RUN_HEALTH_ENTRY];
    return isSourceHealth(entry) ? entry : undefined;
  } catch (err) {
    log.warn("Could not read run health for watcher {watcherId}: {error}", {
      watcherId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * One alert for a watcher whose runs keep failing, or none. PURE — nothing is
 * committed here, so an alert that is never delivered is simply re-emitted next
 * run (see `shouldEscalate`'s note in source-health.ts: the runner only records an
 * id it managed to send).
 *
 * Says something different from a source-health alert on purpose. That one's
 * closing line is "the watcher itself is running fine"; here the watcher itself is
 * what is not fine, and the user's real question — *am I missing email?* — needs
 * answering explicitly.
 */
export function buildRunHealthAlert(
  watcherName: string,
  h: SourceHealth,
  now: number,
  escalateAfter: number = HEALTH_ESCALATE_AFTER,
): WatcherAlert[] {
  if (h.outcome === "ok" || h.consecutive < escalateAfter) return [];
  const hours = h.lastOkAt == null ? null : Math.round((now - h.lastOkAt) / 3_600_000);
  // "completed a run", NOT "succeeded": `lastOkAt` is seeded from the row's own
  // `last_run_at` on the first record (see `markRunHealth`), and that column
  // advances on failures too. The weaker claim is the true one for both sources of
  // the timestamp — where "has never succeeded" would be a flat lie on day one
  // about a watcher that has been running for months.
  const since = hours == null ? "has no recorded run before this" : `last completed a run ${hours}h ago`;
  const runs = h.consecutive === 1 ? "1 run" : `${h.consecutive} runs in a row`;
  return [
    {
      id: healthAlertId(watcherName, RUN_HEALTH_ENTRY, h),
      source: "watcher-health",
      sender: "Watcher health",
      subject: `${watcherName}: ${h.consecutive} run(s) failed`,
      summary:
        `⚠️ **Watcher failing** — \`${watcherName}\` has failed **${runs}** ` +
        `and ${since}.` +
        (h.detail ? `\n_${h.detail}_` : "") +
        `\nIt is still scheduled and still retrying — but assume anything it watches has gone unreported since then.`,
      urgency: "high",
    },
  ];
}

export interface MarkRunHealthResult {
  /** Alerts to deliver — empty on `ok`, and until the streak reaches the threshold. */
  alerts: WatcherAlert[];
  /** The record just written, so a caller can key on `consecutive` without re-reading. */
  health: SourceHealth;
}

/**
 * Fold this run's outcome into the watcher's run-health record, persist it, and
 * return the alerts to deliver.
 *
 * Best-effort by construction: every DB touch is caught, because health is
 * observability and must never break the path it observes — least of all the
 * `catch` block it is called from.
 */
export async function markRunHealth(
  watcher: Pick<Watcher, "id" | "name" | "intervalMs" | "lastRunAt">,
  outcome: SourceOutcome,
  now: number = Date.now(),
  detail?: string,
  deps: RunHealthDeps = DEFAULT_HEALTH_DEPS,
): Promise<MarkRunHealthResult> {
  let prior = await loadRunHealth(watcher.id, deps);
  // FIRST record: seed `lastOkAt` from the row's own `last_run_at`. Without it the
  // first escalation after deploy says "has never completed a run" about a watcher
  // with months of history — and `healthLevel` reads a null `lastOkAt` as infinite
  // staleness, painting the FIRST failure of a healthy watcher red `stale` rather
  // than amber `warn`. The column is the only evidence that exists before this
  // module has ever run; the alert's wording is chosen to match exactly what it
  // attests (a run completed, not a run succeeded).
  if (!prior && watcher.lastRunAt != null) {
    prior = { outcome: "ok", at: watcher.lastRunAt, consecutive: 0, lastOkAt: watcher.lastRunAt };
  }
  const next = recordOutcome(prior, outcome, now, detail);
  const alerts = buildRunHealthAlert(watcher.name, next, now, runEscalateAfter(watcher.intervalMs));
  if (alerts.length > 0) {
    log.error("Watcher \"{name}\" has failed {n} consecutive run(s): {detail}", {
      name: watcher.name,
      n: next.consecutive,
      detail: next.detail ?? "no detail",
    });
  }
  try {
    await deps.setSnapshot(watcher.id, RUN_HEALTH_KEY, { [RUN_HEALTH_ENTRY]: next });
  } catch (err) {
    log.error("Failed to persist run health for watcher \"{name}\": {error}", {
      name: watcher.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { alerts, health: next };
}

export interface FailureNotifyDeps extends RunHealthDeps {
  saveMessage: typeof saveMessage;
  getActiveThreadId: typeof getActiveThreadId;
  pushActivity: (type: "error" | "system", text: string, extra: Record<string, unknown>) => void;
}

const DEFAULT_NOTIFY_DEPS: FailureNotifyDeps = {
  ...DEFAULT_HEALTH_DEPS,
  saveMessage,
  getActiveThreadId,
  pushActivity: (type, text, extra) => activityLog.push(type, text, extra as never),
};

/**
 * Deliver a run-health escalation for a watcher whose checker THREW.
 *
 * Separate from the success path's send block rather than shared with it, because
 * the two differ in every way that block is complicated: no content-hash dedup (the
 * id is already episode-stable by construction), no silent alerts, no Slack fan-out
 * (a broken watcher is the owner's problem, not a channel's), and no `alerts.length`
 * bookkeeping to reconcile. Sharing would mean threading four flags through it.
 *
 * Returns the ids it actually DELIVERED, so the caller records only those: an alert
 * suppressed by quiet hours or lost to a Telegram error stays unrecorded and is
 * re-emitted on the next failed run, which is the property that makes "emit every
 * run, let id-dedup collapse it" safe (see `shouldEscalate` in source-health.ts).
 */
export async function deliverFailureAlerts(
  api: Api,
  watcher: Watcher,
  tag: string,
  alerts: WatcherAlert[],
  quietHours: boolean,
  deps: FailureNotifyDeps = DEFAULT_NOTIFY_DEPS,
): Promise<string[]> {
  const known = new Set(watcher.lastNotifiedIds);
  const fresh = alerts.filter((a) => !known.has(a.id));
  if (fresh.length === 0) return [];
  // Reachable only for a quiet-hours-RUN-EXEMPT type (today just `wiki-committer`)
  // or a forced manual trigger — every other watcher returns before its checker
  // runs during quiet hours, so its failure path is never entered at all. Kept
  // because the exempt set is a list that grows, and holding is the right behaviour
  // when it does.
  if (quietHours) {
    log.info("Watcher \"{name}\" failure escalation held until quiet hours end", { botName: tag, name: watcher.name });
    return [];
  }

  const markdown = formatAlerts(watcher, fresh);
  const html = formatTelegramHtml(markdown);
  try {
    await api.sendMessage(watcher.userId, html, { parse_mode: "HTML" });
  } catch (sendErr) {
    if (sendErr instanceof Error && sendErr.message.includes("can't parse entities")) {
      log.warn("Telegram rejected HTML, falling back to plain text", { botName: tag, name: watcher.name });
      await api.sendMessage(watcher.userId, stripHtml(html));
    } else {
      throw sendErr;
    }
  }

  // Persisted like any other proactive message so the bot can answer "why didn't
  // you tell me about X?" with the failure in its own context. Source is
  // `watcher:health`, NOT `watcher:<type>`: it still matches the `watcher:` prefix
  // (so `PROACTIVE_SOURCE_PREFIXES` keeps it out of conversation history and inside
  // the bounded alerts block), but a "Watcher failing" row is no longer
  // indistinguishable from an actual email digest inside that block.
  try {
    const threadId = await deps.getActiveThreadId(watcher.userId, tag);
    await deps.saveMessage({
      userId: watcher.userId,
      botName: tag,
      role: "assistant",
      content: markdown,
      source: "watcher:health",
      platform: "telegram",
      threadId,
    });
  } catch (saveErr) {
    // The user has ALREADY been told at this point, so a failed save must not
    // un-record the delivery and re-send the same escalation next hour.
    log.error("Failed to persist watcher failure escalation: {error}", { botName: tag, name: watcher.name, error: saveErr instanceof Error ? saveErr.message : String(saveErr) });
  }

  deps.pushActivity(
    "error",
    `Watcher "${watcher.name}" escalated: ${fresh.length} failure alert(s) sent`,
    { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } },
  );
  log.info("Watcher \"{name}\" failure escalation sent to user {userId}", { botName: tag, name: watcher.name, userId: watcher.userId });
  return fresh.map((a) => a.id);
}

/**
 * The whole failure path in one call, which is what the runner's `catch` makes:
 * record the outcome, put a row where a human can see it, escalate if the streak
 * says so, and hand back the ids the caller must record.
 *
 * It lives here behind injected deps because the runner's catch is otherwise
 * untestable — driving it needs a live DB and a live Telegram `Api`, so every
 * decision it makes would be pinned by nothing. That is exactly the
 * mutation-survivable shape this repo keeps shipping.
 *
 * NEVER THROWS. The run already failed; the caller still has to advance
 * `last_run_at` to prevent a retry storm, and no observability failure may take
 * that away from it.
 */
export async function handleWatcherFailure(
  api: Api,
  watcher: Watcher,
  tag: string,
  errText: string,
  quietHours: boolean,
  deps: FailureNotifyDeps = DEFAULT_NOTIFY_DEPS,
  now: number = Date.now(),
): Promise<string[]> {
  try {
    const { alerts, health } = await markRunHealth(watcher, "error", now, errText, deps);
    // An activity row on the FIRST failure of an episode, and on the escalating
    // runs (which push their own row from `deliverFailureAlerts`). NOT on every
    // failure: `X Daily Digest` polls every 5 minutes, so a wedged row would push
    // 288 error rows a day into `activity_log` AND fan 288 SSE events out to every
    // open dashboard tab, indefinitely. The Telegram side is carefully deduped;
    // this side had no dedup at all, which is backwards.
    if (health.consecutive === 1 && alerts.length === 0) {
      deps.pushActivity(
        "error",
        `Watcher "${watcher.name}" failed: ${errText}`,
        { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } },
      );
    }
    if (alerts.length === 0) return [];
    return await deliverFailureAlerts(api, watcher, tag, alerts, quietHours, deps);
  } catch (err) {
    log.error("Watcher \"{name}\": failure notification failed: {error}", {
      botName: tag,
      name: watcher.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
