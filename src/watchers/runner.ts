import type { Api } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import type { Watcher, WatcherAlert } from "../types.ts";
import { getWatchersDueNow, updateWatcherLastRun } from "../db/watchers.ts";
import { isQuietHours } from "./quiet-hours.ts";
import { checkEmail } from "./email.ts";
import { checkNews } from "./news.ts";
import { checkX } from "./x.ts";
import { checkAnthropic } from "./anthropic.ts";
import { checkWikiGardener } from "./wiki-gardener.ts";
import { checkWikiLinter } from "./wiki-linter.ts";
import { activityLog } from "../observability/activity-log.ts";
import { agentStatus, getConnectorLabel, createProgressCallback } from "../observability/agent-status.ts";
import { DEFAULT_MODEL, type HaikuTelemetry } from "../scheduler/executor.ts";
import { loadConfig } from "../config.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml, stripHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { getSlackApp } from "../slack/registry.ts";
import { makePostToChannel } from "../slack/cache.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers");

// IDs + content hashes share this rolling array. Sized so the anthropic Weekly
// digest's dedup window survives two busy runs: each can track up to
// DIGEST_MAX_TIER1 (12 feeds × 20) + 1 Tier-2/digest ids ≈ 241, and its
// lookbackDays (16) spans two 7-day runs — at 400, ~82 of the older run's ids
// were evicted and could re-surface as duplicates.
const MAX_NOTIFIED_IDS = 600;

/**
 * Per-watcher safety-net timeout. Each checker already applies its own model
 * timeout (X: `config.timeoutMs`, default 5 min; email: `spawnHaiku`, default
 * 60s), but a stuck MCP connection or a hung subprocess can outlive that and
 * wedge the scheduler tick (which has only a tick-level overlap guard) or
 * starve the watchers queued behind it. This outer net bounds a single
 * watcher's checker run. It sits ABOVE the checker's configured timeout —
 * `max(floor, config.timeoutMs + margin)` — so a legitimately slow Sonnet
 * digest is never cut off prematurely; the net only fires when the inner
 * timeout itself is stuck.
 */
const WATCHER_TIMEOUT_FLOOR_MS = 120_000; // 2 min for watchers with no configured timeout
const WATCHER_TIMEOUT_MARGIN_MS = 30_000; // headroom above the checker's own timeout

export function computeWatcherTimeoutMs(watcher: Watcher): number {
  const configured = (watcher.config as { timeoutMs?: number })?.timeoutMs;
  const base =
    typeof configured === "number" && configured > 0 ? configured + WATCHER_TIMEOUT_MARGIN_MS : 0;
  return Math.max(WATCHER_TIMEOUT_FLOOR_MS, base);
}

// ── In-flight checker guard (concurrent-duplicate prevention) ────────────────
//
// The scheduler tick races `runWatchers` against TICK_TIMEOUT_MS (10 min) and
// releases `tickRunning` when the RACE settles — but an orphaned checker (a
// 20-min gardener, a wedged MCP subprocess) keeps running past that. Because
// `force_next_run`/`last_run_at` only change at run END, the next tick re-selects
// the same watcher and would dispatch a CONCURRENT duplicate. This module-level
// guard, keyed on the RAW `runChecker(...)` promise (released in that promise's
// own `.finally`, NOT the timeout-raced one — that would release while the
// orphan still runs), skips the duplicate dispatch until the real work settles.

interface InFlightEntry {
  startedAt: number;
  token: number;
}
const checkerInFlight = new Map<string, InFlightEntry>();
let checkerTokenSeq = 0;

/** Test-only: clear the in-flight guard between cases. */
export function __resetCheckerGuardForTest(): void {
  checkerInFlight.clear();
  checkerTokenSeq = 0;
}

/**
 * Try to claim the in-flight slot for a watcher's checker. Returns a `token`
 * (pass to {@link releaseChecker} from the raw checker's `.finally`) plus a
 * `forced` flag, or `null` when a live dispatch already holds the slot (caller
 * must skip). A slot older than 2× the watcher timeout is force-reclaimed with
 * `forced: true` — an escape hatch for a never-settling checker (wedged MCP
 * subprocess) that would otherwise park that watcher until restart. The reclaim
 * mints a fresh token, so the stale checker's late `.finally` (old token) becomes
 * a no-op and can't free the new dispatch's slot.
 */
export function claimChecker(
  watcherId: string,
  timeoutMs: number,
  now: number = Date.now(),
): { token: number; forced: boolean } | null {
  const existing = checkerInFlight.get(watcherId);
  if (existing && now - existing.startedAt < 2 * timeoutMs) {
    return null;
  }
  const token = ++checkerTokenSeq;
  checkerInFlight.set(watcherId, { startedAt: now, token });
  return { token, forced: !!existing };
}

/** Release the in-flight slot, but only if `token` still owns it (a stale
 *  orphan's late release is a no-op after a force-reclaim). */
export function releaseChecker(watcherId: string, token: number): void {
  const cur = checkerInFlight.get(watcherId);
  if (cur && cur.token === token) checkerInFlight.delete(watcherId);
}

/**
 * Races `work` against a timeout, clearing the timer when either settles. After
 * a timeout the orphaned `work` keeps running (a checker subprocess can't be
 * cancelled), but its late rejection is still observed by this `Promise.race`
 * subscription, so it won't surface as an unhandledRejection.
 */
export function withWatcherTimeout<T>(work: Promise<T>, watcherName: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Watcher "${watcherName}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Content-based dedup hash, extracted from the summary text itself.
 * Extracts sender name (from "Fra/From: X —" pattern) + proper nouns.
 * These survive Haiku's translation between runs.
 * Prefixed with "h:" to distinguish from message IDs in the shared array.
 */
export function contentHash(alert: WatcherAlert): string | null {
  const text = alert.summary;
  if (!text) return null;

  // Extract sender from summary: "**Fra:** Sender Name — ..." or "From: Sender — ..."
  const senderMatch = text.match(/(?:Fra|From)[:\s*]*\s*(.+?)\s*[—\-–]/i);
  const sender = senderMatch?.[1]?.trim().toLowerCase() ?? "";

  // Extract proper nouns from the rest (after the —)
  const afterDash = text.split(/[—\-–]/).slice(1).join(" ");
  const nouns = extractProperNouns(afterDash);

  const fingerprint = `${sender}|${nouns.join(",")}`;
  if (!sender && nouns.length === 0) return null;
  return `h:${Bun.hash(fingerprint)}`;
}

/** Extract proper nouns: ALL-CAPS words, mid-sentence capitalized words, long numbers */
export function extractProperNouns(text: string): string[] {
  const words = text.split(/[\s,;:—–\-\(\)\/]+/).filter((w) => w.length > 1);
  const tokens: string[] = [];
  let skippedFirst = false;
  for (const word of words) {
    if (/^[A-ZÆØÅÜ]{2,}$/.test(word)) {
      tokens.push(word.toLowerCase());             // ALL CAPS: AS, AB, NASA
    } else if (/^[A-ZÆØÅÜ][a-zæøåü]{2,}/.test(word)) {
      if (!skippedFirst) { skippedFirst = true; continue; } // Skip sentence-initial cap
      tokens.push(word.toLowerCase());
    } else if (/^\d{3,}$/.test(word)) {
      tokens.push(word);                           // Order IDs, numbers
    }
  }
  return tokens.sort();
}

// Cached formatter for time-of-day schedule checks (reused every scheduler tick)
const scheduleFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Oslo",
  hour: "numeric",
  minute: "numeric",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour12: false,
});

interface TimeParts { hour: number; minute: number; dayStr: string; }

function getNowParts(): TimeParts {
  const parts = Object.fromEntries(
    scheduleFormatter.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { hour: Number(parts.hour), minute: Number(parts.minute), dayStr: `${parts.year}-${parts.month}-${parts.day}` };
}

/**
 * Check if a watcher with time-of-day config (hour/minute) is due now.
 * Returns false if it's too early or if it already ran today.
 *
 * NB: `computeWatcherNextRun` in src/dashboard/agents-overview.ts mirrors this
 * gate (combined with the DB interval gate) to predict a watcher's next fire
 * for the /agents dashboard — keep the two in sync.
 */
function isScheduledTimeDue(watcher: Watcher, now: TimeParts): boolean {
  const config = watcher.config as { hour?: number; minute?: number };
  if (config.hour == null) return true; // no time-of-day constraint

  // Too early today?
  if (now.hour < config.hour || (now.hour === config.hour && now.minute < (config.minute ?? 0))) {
    return false;
  }

  // Already ran today?
  if (watcher.lastRunAt) {
    const lastParts = Object.fromEntries(
      scheduleFormatter.formatToParts(new Date(watcher.lastRunAt)).map((p) => [p.type, p.value]),
    );
    const lastStr = `${lastParts.year}-${lastParts.month}-${lastParts.day}`;
    if (lastStr === now.dayStr) return false;
  }

  return true;
}

/**
 * Resolve the watchers that should fire this tick: interval-due (DB) AND either
 * forced or past their time-of-day gate. Extracted so the scheduler can check
 * for due watchers up front (to decide whether to open a trace) and hand the
 * already-resolved list to `runWatchers`, avoiding a second DB round-trip.
 */
export async function getDueWatchers(botName: string): Promise<Watcher[]> {
  const now = getNowParts();
  const candidates = await getWatchersDueNow(botName);
  // Forced watchers skip time-of-day checks; regular ones must pass
  return candidates.filter((w) => w.forceNextRun || isScheduledTimeDue(w, now));
}

/**
 * Truthful connector label + model for a watcher run's `/agents` card.
 *
 * The `email`/`x`/`anthropic` checkers all run via `spawnHaiku`, which
 * UNCONDITIONALLY spawns the Claude CLI (`claude -p`) with `config.model ??
 * DEFAULT_MODEL` — it never consults the Haiku router — so the CLI ("Claude
 * Code") label is always correct regardless of the bot's *chat* connector or the
 * `HAIKU_BACKEND` resolution. Stamping the bot's chat connector/model here (the
 * pre-fix behaviour) was an active lie: jarvis chats on `claude-sdk` /
 * `claude-sonnet-5` but its email watcher spawns the CLI on Haiku.
 *
 * `wiki-gardener` is genuinely mixed — a Haiku cluster (`callHaikuWithFallback`)
 * plus a bot-connector draft (`executeOneShot` on `botConfig.connector`). The
 * draft is the dominant work, so it's labelled from the bot's own
 * connector/model (matching what `executeOneShot` actually runs).
 *
 * `news` + `wiki-linter` run no model at all — return `null` so no (false) chip
 * is stamped.
 */
export function watcherConnectorInfo(
  watcher: Pick<Watcher, "type" | "config">,
  botConfig: { connector?: string; model?: string },
  botFallbackModel?: string,
): { label: string; model?: string } | null {
  switch (watcher.type) {
    case "email":
    case "x":
    case "anthropic": {
      const model = (watcher.config as { model?: string } | undefined)?.model ?? DEFAULT_MODEL;
      return { label: getConnectorLabel("claude-cli"), model };
    }
    case "wiki-gardener":
      return {
        label: getConnectorLabel(botConfig.connector ?? "claude-cli"),
        model: botConfig.model ?? botFallbackModel,
      };
    default:
      // news, wiki-linter — no AI model runs.
      return null;
  }
}

export async function runWatchers(api: Api, botConfig: BotConfig, traceContext?: TraceContext, prefetchedDue?: Watcher[]): Promise<void> {
  const tag = botConfig.name;
  // Fallback model for the wiki-gardener's bot-connector draft (mirrors every
  // other setConnectorInfo caller passing config.claudeModel). Resolved once per
  // batch; degrades to undefined if config can't load (botConfig.model still wins).
  let botFallbackModel: string | undefined;
  // Whether emitted tool spans capture tool outputs (mirrors the chat path's
  // config.tracingCaptureToolOutputs). Resolved once per batch alongside the
  // fallback model; degrades to false if config can't load.
  let captureToolOutputs = false;
  try {
    const cfg = loadConfig();
    botFallbackModel = cfg.claudeModel;
    captureToolOutputs = !!cfg.tracingCaptureToolOutputs;
  } catch {
    botFallbackModel = undefined;
  }
  const dueWatchers = prefetchedDue ?? (await getDueWatchers(tag));
  if (dueWatchers.length > 0) {
    log.info("Running {count} due watcher(s)", { botName: tag, count: dueWatchers.length });
  }

  // Run all due watchers concurrently. Each carries its own requestId
  // (agent-status is per-request since #168) and its own Tracer, so parallel
  // runs no longer clobber each other's progress; the per-watcher timeout +
  // catch keep one slow or failing watcher from blocking the rest. allSettled
  // because each iteration is self-contained error-wise — one rejection must
  // never skip the others.
  await Promise.allSettled(dueWatchers.map(async (watcher) => {
    const forced = watcher.forceNextRun;
    let wt: Tracer | undefined;
    if (traceContext) {
      wt = new Tracer(`watcher:${watcher.type}`, {
        botName: tag,
        userId: watcher.userId,
        traceId: traceContext.traceId,
        parentId: traceContext.parentId,
      });
    }

    let requestId: string | undefined;
    try {
      // Check quiet hours — skip notifications but still mark as run (forced runs bypass)
      if (!forced) {
        const quiet = await isQuietHours(watcher.userId);
        if (quiet) {
          await updateWatcherLastRun(watcher.id, watcher.lastNotifiedIds);
          wt?.finish("ok", { type: watcher.type, quietHoursSkipped: true });
          return;
        }
      }

      // Concurrent-duplicate guard: an earlier tick's checker may still be in
      // flight (it outran the tick timeout, and last_run_at/force_next_run only
      // change at run END). Skip the duplicate dispatch until it settles.
      // KNOWN/ACCEPTED: a force_next_run set MID-run is effectively dropped —
      // the skipped forced dispatch never runs, and the in-flight run's
      // completion clears the flag. Before this guard the same scenario
      // produced a redundant CONCURRENT duplicate instead; the silent drop is
      // the lesser evil, and it's only reachable for checkers that outlive the
      // 10-min scheduler tick.
      const timeoutMs = computeWatcherTimeoutMs(watcher);
      const claim = claimChecker(watcher.id, timeoutMs);
      if (!claim) {
        log.warn("Watcher \"{name}\" still in flight from an earlier tick — skipping duplicate dispatch", {
          botName: tag,
          name: watcher.name,
        });
        wt?.finish("ok", { type: watcher.type, skippedInFlight: true });
        return;
      }
      if (claim.forced) {
        log.error("Watcher \"{name}\" checker never settled within 2× its timeout — force-reclaiming the in-flight guard (wedged subprocess/MCP?) and re-dispatching", {
          botName: tag,
          name: watcher.name,
          watcherId: watcher.id,
        });
      }

      if (forced) log.info("Manual trigger: watcher \"{name}\"", { botName: tag, name: watcher.name });
      agentStatus.set("running_watcher", watcher.name);
      requestId = agentStatus.startRequest(botConfig.name, "running_watcher", undefined, {
        kind: "watcher",
        name: watcher.name || watcher.type,
      });
      const cinfo = watcherConnectorInfo(watcher, botConfig, botFallbackModel);
      if (cinfo) {
        agentStatus.setConnectorLabel(requestId, cinfo.label);
        if (cinfo.model) agentStatus.setModel(requestId, cinfo.model);
      }

      // Accumulate token usage across a checker's spawnHaiku calls. x/anthropic
      // make MULTIPLE calls (gate + digest / capture gate) per run, so sum here;
      // the total is stamped onto the `watcher:<type>` span + the Running card.
      const usage = { inputTokens: 0, outputTokens: 0, numTurns: 0, calls: 0, model: undefined as string | undefined };

      // Telemetry seams for the Haiku-driven checkers (email/x/anthropic): the
      // live progress callback fills this run's `/agents` tool mini-log, `wt`
      // receives tool child spans (Gmail MCP calls etc.) under the `watcher:<type>`
      // span, and onUsage sums token usage. News/wiki-linter/wiki-gardener
      // checkers ignore it (no spawnHaiku).
      const telemetry: HaikuTelemetry = {
        onProgress: createProgressCallback(requestId, "running_watcher"),
        tracer: wt,
        captureToolOutputs,
        onUsage: (u) => {
          usage.inputTokens += u.inputTokens;
          usage.outputTokens += u.outputTokens;
          if (u.numTurns != null) usage.numTurns += u.numTurns;
          usage.model = u.model;
          usage.calls++;
        },
      };

      // Key the guard on the RAW checker promise, created BEFORE the timeout wrap
      // and released in its OWN .finally — keying the timeout-raced promise would
      // free the slot while an orphaned checker keeps running.
      const raw = runChecker(watcher, botConfig, telemetry);
      void raw.finally(() => releaseChecker(watcher.id, claim.token));

      const alerts = await withWatcherTimeout(
        raw,
        watcher.name,
        timeoutMs,
      );

      // Filter out already-notified: by message ID and by content hash
      const known = new Set(watcher.lastNotifiedIds);
      // Content-hash dedup (below) exists to catch LLM-resummarized items
      // (email/news/x) whose wording — and thus their alert id/text — drifts
      // between runs. The anthropic watcher's ids are stable canonical GitHub
      // URLs, so id-dedup is already complete; running content-hash on it only
      // causes false drops (two distinct commits like "Update README" fingerprint
      // identically) and doubles slot use in the 400-cap window. Skip it here.
      // Anthropic ids are stable canonical URLs; the wiki-gardener alert id is
      // already per-run-unique (embeds the persisted proposal ids) and its
      // summary names the same topic labels across runs — content-hash dedup
      // would false-drop a legitimate weekly notification. The wiki-linter's
      // alert id is per-day-stable and its summary (identical counts) can repeat
      // across weekly runs, so content-hash would wrongly suppress a recurring
      // report — skip it for all three.
      const skipContentHash =
        watcher.type === "anthropic" ||
        watcher.type === "wiki-gardener" ||
        watcher.type === "wiki-linter";
      const newAlerts = alerts.filter((a) => {
        if (known.has(a.id)) {
          log.debug("Dedup: skipped by ID \"{id}\"", { botName: tag, id: a.id });
          return false;
        }
        const hash = skipContentHash ? null : contentHash(a);
        if (hash && known.has(hash)) {
          log.debug("Dedup: skipped by content hash {hash} — \"{summary}\"", { botName: tag, hash, summary: a.summary.slice(0, 60) });
          return false;
        }
        log.debug("Dedup: NEW alert id=\"{id}\" hash={hash} — \"{summary}\"", { botName: tag, id: a.id, hash, summary: a.summary.slice(0, 60) });
        return true;
      });

      const visibleAlerts = newAlerts.filter((a) => !a.silent);
      const silentAlerts = newAlerts.filter((a) => a.silent);
      if (silentAlerts.length > 0) {
        log.info("Watcher \"{name}\" tracked {count} silent alert(s) without notification", { botName: tag, name: watcher.name, count: silentAlerts.length });
      }

      if (visibleAlerts.length > 0) {
        // Format as markdown (stored in DB), convert to platform format for send
        const markdown = formatAlerts(watcher, visibleAlerts);

        // Send to Telegram (fall back to plain text if HTML is rejected)
        agentStatus.set("sending_telegram", watcher.name);
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

        // Send to Slack channels if configured (slackBot overrides which bot's Slack connection to use)
        const slackConfig = watcher.config as { slackChannels?: string[]; slackBot?: string };
        if (slackConfig.slackChannels?.length) {
          await sendToSlackChannels(slackConfig.slackBot || tag, markdown, slackConfig.slackChannels);
        }

        // Persist markdown in messages so Claude can reference it in conversation.
        // Save to the user's active thread so the alert is visible in context.
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

        activityLog.push(
          "system",
          `Watcher "${watcher.name}" sent ${visibleAlerts.length} alert(s)`,
          { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } as any },
        );
        log.info("Watcher \"{name}\" sent {count} alert(s) to user {userId}", { botName: tag, name: watcher.name, count: visibleAlerts.length, userId: watcher.userId });
      }

      // Update last_run_at and keep a rolling window of IDs + content hashes
      const newEntries = newAlerts.flatMap((a) => {
        const hash = skipContentHash ? null : contentHash(a);
        const extras = a.trackingIds ?? [];
        return hash ? [a.id, hash, ...extras] : [a.id, ...extras];
      });
      const updatedIds = [
        ...watcher.lastNotifiedIds,
        ...newEntries,
      ].slice(-MAX_NOTIFIED_IDS);

      await updateWatcherLastRun(watcher.id, updatedIds);
      // Token totals from the checker's spawnHaiku call(s) — stamped onto the
      // span (read back into Recent via getRecentAgentTraces off the childless
      // watcher span's OWN attributes) and onto the Running/completed card.
      const usageMeta = usage.calls > 0
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.numTurns > 0 ? { numTurns: usage.numTurns } : {}),
            ...(usage.model ? { model: usage.model } : {}),
            // Usage comes exclusively from spawnHaiku, which is always the
            // Claude CLI — lets the /traces Backend column label the run.
            connector: "claude-cli",
          }
        : {};
      // `wt` is a child span sharing the scheduler_tick trace id, so the card's
      // trace link opens the whole tick — coarser than chat's per-request link,
      // but the only handle in scope here.
      agentStatus.completeRequest(requestId, { traceId: wt?.traceId, ...usageMeta });
      wt?.finish("ok", { type: watcher.type, alertsFound: alerts.length, alertsSent: visibleAlerts.length, alertsSilent: silentAlerts.length, ...usageMeta, ...(forced && { manualTrigger: true }) });
    } catch (err) {
      if (requestId) agentStatus.clearRequest(requestId);
      wt?.error(err instanceof Error ? err : String(err));
      log.error("Watcher \"{name}\" ({watcherId}) failed: {error}", { botName: tag, name: watcher.name, watcherId: watcher.id, error: err instanceof Error ? err.message : String(err) });

      // Still advance lastRunAt on failure to prevent retry storms
      try {
        await updateWatcherLastRun(watcher.id, watcher.lastNotifiedIds);
      } catch (updateErr) {
        log.error("Failed to update watcher last_run_at after error: {error}", { botName: tag, watcherId: watcher.id, error: updateErr instanceof Error ? updateErr.message : String(updateErr) });
      }
    }
  }));
  // The per-watcher phase dial (`set("running_watcher")`/`set("sending_telegram")`)
  // races under parallelism (it's a coarse global indicator), so reset to idle
  // once after the whole batch settles rather than per-watcher — otherwise an
  // early finisher would flip the dial to idle while siblings still run.
  if (dueWatchers.length > 0) agentStatus.set("idle");
}

async function sendToSlackChannels(botName: string, markdown: string, channels: string[]): Promise<void> {
  const slackApp = getSlackApp(botName);
  if (!slackApp) {
    log.warn("Watcher wants to post to Slack but no Slack app registered for bot \"{botName}\"", { botName });
    return;
  }
  const postToChannel = makePostToChannel(slackApp.client, botName);
  const mrkdwn = formatSlackMrkdwn(markdown);
  for (const channel of channels) {
    try {
      await postToChannel(channel, mrkdwn);
    } catch (err) {
      log.error("Failed to post to Slack channel \"{channel}\": {error}", { botName, channel, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function runChecker(watcher: Watcher, botConfig: BotConfig, telemetry?: HaikuTelemetry): Promise<WatcherAlert[]> {
  const cwd = botConfig.dir;
  const botName = botConfig.name;
  switch (watcher.type) {
    case "email":
      return await checkEmail(watcher, cwd, botName, telemetry);
    case "news":
      return await checkNews(watcher);
    case "x":
      return await checkX(watcher, cwd, botName, telemetry);
    case "anthropic":
      return await checkAnthropic(watcher, telemetry);
    case "wiki-gardener":
      // The gardener needs the full BotConfig (wikiDir, connector, gardener block)
      // for executeOneShot — passed through instead of re-running bot discovery.
      return await checkWikiGardener(watcher, botConfig);
    case "wiki-linter":
      // Report-only lint over the bot's wikiDir — needs the full BotConfig for
      // its wikiDir; never writes to the wiki or DB.
      return await checkWikiLinter(watcher, botConfig);
    default:
      log.warn("Watcher type \"{type}\" not yet implemented", { type: watcher.type });
      return [];
  }
}


export function formatAlerts(watcher: Watcher, alerts: WatcherAlert[]): string {
  const icon = watcher.type === "email" ? "\u{1F4E8}" : watcher.type === "news" ? "\u{1F4F0}" : watcher.type === "x" ? "\u{1D54F}" : watcher.type === "anthropic" ? "\u{1F9E0}" : watcher.type === "wiki-gardener" ? "\u{1F331}" : watcher.type === "wiki-linter" ? "\u{1F9F9}" : "\u{1F514}";
  const header = `${icon} **${watcher.name}**\n`;
  const lines = alerts.map((a) => {
    const urgencyTag = a.urgency === "high" ? " \u{1F534}" : a.urgency === "medium" ? " \u{1F7E1}" : "";
    return `${urgencyTag} ${a.summary}`;
  });
  return header + lines.join("\n\n");
}
