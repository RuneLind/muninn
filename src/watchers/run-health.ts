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
  healthLevel,
  isSourceHealthMap,
  HEALTH_ESCALATE_AFTER,
  HEALTH_RE_ESCALATE_EVERY,
  type HealthLevel,
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

/**
 * How often this watcher can ACTUALLY run — which is not `intervalMs` whenever
 * `config.hour` is set, because `isScheduledTimeDue` then gates it to once a day.
 * `X Daily Digest` carries `interval_ms: 300000` AND `config.hour: 12`: reading the
 * column alone gives it a 3-run (=3-day) escalation threshold and a 24h staleness
 * window that paints its FIRST failure red — the two exact defects the threshold and
 * the `lastOkAt` seed exist to prevent, surviving on the one row where the column
 * lies about the cadence.
 */
export function effectiveCadenceMs(w: { intervalMs: number; config?: unknown }): number {
  const hour = (w.config as { hour?: unknown } | undefined)?.hour;
  return typeof hour === "number" ? Math.max(w.intervalMs, SLOW_WATCHER_INTERVAL_MS) : w.intervalMs;
}

export function runEscalateAfter(cadenceMs: number): number {
  return cadenceMs >= SLOW_WATCHER_INTERVAL_MS ? 1 : HEALTH_ESCALATE_AFTER;
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
/**
 * Stable alert id for one unhealthy EPISODE and nag bucket — source-health's shape
 * (`watcher-health:<watcher>:<key>:<episode>:<bucket>`) with two corrections it
 * cannot make from over there.
 *
 * The BUCKET counts from this watcher's own threshold. `healthAlertId` divides by
 * the shared `HEALTH_ESCALATE_AFTER`, so on a row escalating at 1 the bucket runs
 * -1, -1, 0, 0… — crossing zero at consecutive 3 and firing an undesigned second
 * alert two runs after the first (measured: week 1, week 3, week 27).
 *
 * The EPISODE is `"seed"` for a record whose `lastOkAt` came from the `last_run_at`
 * seed rather than a real `ok` mark. That seed is re-derived from a column the runner
 * ADVANCES on every failure, so if the snapshot write keeps failing the discriminator
 * moves every run, the id is never stable, and `lastNotifiedIds` dedups nothing —
 * measured as one Telegram alert per run under a snapshot-write outage, where before
 * the seed there were none.
 */
export function runHealthAlertId(
  watcherName: string,
  h: SourceHealth,
  escalateAfter: number,
  seeded: boolean,
): string {
  const episode = h.lastOkAt == null ? "never" : seeded ? "seed" : h.lastOkAt;
  const bucket = Math.floor((h.consecutive - escalateAfter) / HEALTH_RE_ESCALATE_EVERY);
  return `watcher-health:${watcherName}:${RUN_HEALTH_ENTRY}:${episode}:${bucket}`;
}

export function buildRunHealthAlert(
  watcherName: string,
  h: SourceHealth,
  now: number,
  escalateAfter: number = HEALTH_ESCALATE_AFTER,
  seeded = false,
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
      id: runHealthAlertId(watcherName, h, escalateAfter, seeded),
      source: "watcher-health",
      sender: "Watcher health",
      subject: `${watcherName}: ${h.consecutive} run(s) failed`,
      summary:
        `⚠️ **Watcher failing** — \`${watcherName}\` has failed **${runs}** ` +
        `and ${since}.` +
        (h.detail ? `\n${h.detail}` : "") +
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
  watcher: Pick<Watcher, "id" | "name" | "intervalMs" | "lastRunAt" | "config">,
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
  let seeded = false;
  if (!prior && watcher.lastRunAt != null) {
    // Only `consecutive` and `lastOkAt` are read back out of this by `recordOutcome`;
    // the `outcome` is inert and deliberately claims nothing (the surrounding comment
    // is explicit that a completed run is not a successful one).
    prior = { outcome: "ok", at: watcher.lastRunAt, consecutive: 0, lastOkAt: watcher.lastRunAt };
    seeded = true;
  }
  const next = recordOutcome(prior, outcome, now, detail);
  const alerts = buildRunHealthAlert(
    watcher.name, next, now, runEscalateAfter(effectiveCadenceMs(watcher)), seeded,
  );
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

export interface HealthChip extends SourceHealth {
  key: string;
  level: HealthLevel;
}

/**
 * The chip list `GET /api/watchers` renders: the per-source map and the run-level
 * record merged into one list, run entry FIRST.
 *
 * Pure and here rather than inline in the route, because the route is only reachable
 * with a live Postgres — so every decision in it was mutation-survivable. Measured:
 * reverting the sort, swapping the two spreads, and DELETING the run-health read
 * outright (i.e. removing the chip this whole feature renders) each left the entire
 * suite green.
 *
 * Cadence, not `intervalMs`: `healthLevel`'s staleness window is derived from it, and
 * an hour-gated row's column understates its real period by orders of magnitude —
 * which paints a chip red `stale` on a watcher that ran on schedule this morning.
 */
export function mergeHealthChips(
  runSnap: unknown,
  sourceSnap: unknown,
  watcher: { intervalMs: number; config?: unknown },
  now: number,
): HealthChip[] {
  const merged: Record<string, SourceHealth> = {
    ...(isSourceHealthMap(runSnap) ? runSnap : {}),
    // Source entries win a key collision, which is why the run entry is namespaced —
    // an un-namespaced `run` key could be shadowed by a source of the same name.
    ...(isSourceHealthMap(sourceSnap) ? sourceSnap : {}),
  };
  const cadence = effectiveCadenceMs(watcher);
  return Object.entries(merged)
    .map(([key, h]) => ({ key, ...h, level: healthLevel(h, cadence, now) }))
    // Run health first: it is the one entry that says whether the watcher ran at all,
    // so it must not sort alphabetically into the middle of the per-source chips.
    .sort((a, b) => (a.key === RUN_HEALTH_ENTRY ? -1 : b.key === RUN_HEALTH_ENTRY ? 1 : a.key.localeCompare(b.key)));
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

  // Guarded for the same reason the save above is: the user has ALREADY been told,
  // and anything that throws here un-records the delivery and re-sends next run.
  // (Measured with a throwing `pushActivity`: two Telegram messages for one episode.)
  try {
    deps.pushActivity(
      "error",
      `Watcher "${watcher.name}" escalated: ${fresh.length} failure alert(s) sent`,
      { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } },
    );
  } catch (activityErr) {
    log.error("Failed to log watcher failure escalation: {error}", { botName: tag, name: watcher.name, error: activityErr instanceof Error ? activityErr.message : String(activityErr) });
  }
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

    let delivered: string[] = [];
    let escalationRendered = false;
    if (alerts.length > 0) {
      try {
        delivered = await deliverFailureAlerts(api, watcher, tag, alerts, quietHours, deps);
        // An escalation that was HELD (quiet hours) or LOST (Telegram error) renders
        // nothing and records nothing — it is not a surface.
        escalationRendered = delivered.length > 0;
      } catch (sendErr) {
        log.error("Watcher \"{name}\": failure escalation could not be sent: {error}", {
          botName: tag,
          name: watcher.name,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
    }

    // The activity row is keyed on what was RENDERED, not on what was DUE. Gating it
    // on `alerts.length === 0` was a regression with a nasty shape: past the
    // threshold, a quiet-hours hold or a dead Telegram channel suppressed the row too
    // — so a broken watcher AND a broken notification channel, the state where a
    // fallback surface matters most, showed nothing anywhere but `logs/`. The
    // wiki-committer (the only quiet-hours-exempt type, and the 87-page-loss row) hit
    // that on every failure inside its quiet window.
    //
    // Still deduped for the ordinary case: a continuously wedged watcher writes ONE
    // row per episode rather than one per run — the hourly email row is the worst
    // configured case at 24 rows a day, each fanned as an SSE event to every open
    // dashboard tab. (A FLAPPING watcher does write one per failure: each failure
    // resets the streak, so each is genuinely a new episode.)
    if (!escalationRendered && alerts.length > 0) {
      // An escalation was DUE and nothing went out. Say so EVERY run and say which
      // it was, because the channel the dedup relies on is precisely what is broken.
      deps.pushActivity(
        "error",
        `Watcher "${watcher.name}" failed (${health.consecutive} in a row, escalation not delivered): ${errText}`,
        { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } },
      );
    } else if (!escalationRendered && health.consecutive === 1) {
      deps.pushActivity(
        "error",
        `Watcher "${watcher.name}" failed: ${errText}`,
        { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } },
      );
    }
    return delivered;
  } catch (err) {
    log.error("Watcher \"{name}\": failure notification failed: {error}", {
      botName: tag,
      name: watcher.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
