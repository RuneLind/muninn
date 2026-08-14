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
 * Deliberately reuses source-health's escalation constants, its `recordOutcome`
 * fold and its alert-id convention, so the runner's existing `lastNotifiedIds`
 * dedup collapses the hourly repeats with no new bookkeeping — and so the two
 * health surfaces cannot drift into two different definitions of "unhealthy".
 *
 * Stored under its OWN snapshot key. `source:health` is a map the per-source
 * recorder REBUILDS from the sources configured this run, dropping anything it did
 * not mark (a de-configured source must not linger with a frozen chip). A run-level
 * entry written into that map would be deleted by the next anthropic/x run — or,
 * written the other way round, would delete that run's per-source chips.
 */
import type { Api } from "grammy";
import type { Watcher, WatcherAlert } from "../types.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml, stripHtml } from "../bot/telegram-format.ts";
import { activityLog } from "../observability/activity-log.ts";
import { formatAlerts } from "./format-alerts.ts";
import { getWatcherSnapshot, setWatcherSnapshot } from "../db/watchers.ts";
import {
  recordOutcome,
  shouldEscalate,
  healthAlertId,
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
 */
export const RUN_HEALTH_ENTRY = "run";

function isSourceHealth(v: unknown): v is SourceHealth {
  return !!v && typeof v === "object" && typeof (v as SourceHealth).outcome === "string";
}

/** Read one watcher's stored run-health record, or undefined. Never throws. */
export async function loadRunHealth(watcherId: string): Promise<SourceHealth | undefined> {
  try {
    const snap = await getWatcherSnapshot(watcherId, RUN_HEALTH_KEY);
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
): WatcherAlert[] {
  if (!shouldEscalate(h)) return [];
  const hours = h.lastOkAt == null ? null : Math.round((now - h.lastOkAt) / 3_600_000);
  const since = hours == null ? "has never completed a run" : `last completed a run ${hours}h ago`;
  return [
    {
      id: healthAlertId(watcherName, RUN_HEALTH_ENTRY, h),
      source: "watcher-health",
      sender: "Watcher health",
      subject: `${watcherName}: ${h.consecutive} runs failed`,
      summary:
        `⚠️ **Watcher failing** — \`${watcherName}\` has failed **${h.consecutive} runs in a row** ` +
        `and ${since}.` +
        (h.detail ? `\n_${h.detail}_` : "") +
        `\nIt is still scheduled and still retrying — but assume anything it watches has gone unreported since then.`,
      urgency: "high",
    },
  ];
}

/**
 * Fold this run's outcome into the watcher's run-health record, persist it, and
 * return the alerts to deliver (empty on `ok`, and empty on `error` until the
 * streak reaches the threshold).
 *
 * Best-effort by construction: every DB touch is caught, because health is
 * observability and must never break the path it observes — least of all the
 * `catch` block it is called from.
 */
export async function markRunHealth(
  watcherId: string,
  watcherName: string,
  outcome: SourceOutcome,
  now: number = Date.now(),
  detail?: string,
): Promise<WatcherAlert[]> {
  const prior = await loadRunHealth(watcherId);
  const next = recordOutcome(prior, outcome, now, detail);
  const alerts = buildRunHealthAlert(watcherName, next, now);
  if (alerts.length > 0) {
    log.error("Watcher \"{name}\" has failed {n} consecutive run(s): {detail}", {
      name: watcherName,
      n: next.consecutive,
      detail: next.detail ?? "no detail",
    });
  }
  try {
    await setWatcherSnapshot(watcherId, RUN_HEALTH_KEY, { [RUN_HEALTH_ENTRY]: next });
  } catch (err) {
    log.error("Failed to persist run health for watcher \"{name}\": {error}", {
      name: watcherName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return alerts;
}

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
 *
 * Lives HERE rather than in `runner.ts` so the test that drives it can mock the DB
 * without loading every checker (see the header of `format-alerts.ts` — that graph
 * evaluates `x.ts` early enough to break x.test.ts's own logger mock). Every
 * decision in here — the dedup filter, the quiet-hours hold, which ids come back —
 * is invisible from `runWatchers`, whose failure path can only be driven with a
 * live DB and a live Telegram Api.
 */
export async function deliverFailureAlerts(
  api: Api,
  watcher: Watcher,
  tag: string,
  alerts: WatcherAlert[],
  quietHours: boolean,
): Promise<string[]> {
  const known = new Set(watcher.lastNotifiedIds);
  const fresh = alerts.filter((a) => !known.has(a.id));
  if (fresh.length === 0) return [];
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
  // you tell me about X?" with the failure in its own context.
  try {
    const threadId = await getActiveThreadId(watcher.userId, tag);
    await saveMessage({
      userId: watcher.userId,
      botName: tag,
      role: "assistant",
      content: markdown,
      source: `watcher:${watcher.type}`,
      platform: "telegram",
      threadId,
    });
  } catch (saveErr) {
    // The user has ALREADY been told at this point, so a failed save must not
    // un-record the delivery and re-send the same escalation next hour.
    log.error("Failed to persist watcher failure escalation: {error}", { botName: tag, name: watcher.name, error: saveErr instanceof Error ? saveErr.message : String(saveErr) });
  }

  activityLog.push(
    "error",
    `Watcher "${watcher.name}" escalated: ${fresh.length} failure alert(s) sent`,
    { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } as any },
  );
  log.info("Watcher \"{name}\" failure escalation sent to user {userId}", { botName: tag, name: watcher.name, userId: watcher.userId });
  return fresh.map((a) => a.id);
}
