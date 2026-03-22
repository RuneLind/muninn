import type { Api } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import type { Watcher, WatcherAlert } from "../types.ts";
import { getWatchersDueNow, updateWatcherLastRun } from "../db/watchers.ts";
import { isQuietHours } from "./quiet-hours.ts";
import { checkEmail } from "./email.ts";
import { checkNews } from "./news.ts";
import { checkX } from "./x.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { agentStatus, setConnectorInfo } from "../dashboard/agent-status.ts";
import { saveMessage } from "../db/messages.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { Tracer, type TraceContext } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers");

const MAX_NOTIFIED_IDS = 400; // IDs + content hashes share this array

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

export async function runWatchers(api: Api, botConfig: BotConfig, traceContext?: TraceContext): Promise<void> {
  const tag = botConfig.name;
  const now = getNowParts();
  const dueWatchers = (await getWatchersDueNow(tag)).filter((w) => isScheduledTimeDue(w, now));
  if (dueWatchers.length > 0) {
    log.info("Running {count} due watcher(s)", { botName: tag, count: dueWatchers.length });
  }

  for (const watcher of dueWatchers) {
    let wt: Tracer | undefined;
    if (traceContext) {
      wt = new Tracer(`watcher:${watcher.type}`, {
        botName: tag,
        userId: watcher.userId,
        traceId: traceContext.traceId,
        parentId: traceContext.parentId,
      });
    }

    try {
      // Check quiet hours — skip notifications but still mark as run
      const quiet = await isQuietHours(watcher.userId);
      if (quiet) {
        await updateWatcherLastRun(watcher.id, watcher.lastNotifiedIds);
        wt?.finish("ok", { type: watcher.type, quietHoursSkipped: true });
        continue;
      }

      agentStatus.set("running_watcher", watcher.name);
      const requestId = agentStatus.startRequest(botConfig.name, "running_watcher");
      setConnectorInfo(botConfig);

      const alerts = await runChecker(watcher, botConfig.dir, tag);

      // Filter out already-notified: by message ID and by content hash
      const known = new Set(watcher.lastNotifiedIds);
      const newAlerts = alerts.filter((a) => {
        if (known.has(a.id)) {
          log.debug("Dedup: skipped by ID \"{id}\"", { botName: tag, id: a.id });
          return false;
        }
        const hash = contentHash(a);
        if (hash && known.has(hash)) {
          log.debug("Dedup: skipped by content hash {hash} — \"{summary}\"", { botName: tag, hash, summary: a.summary.slice(0, 60) });
          return false;
        }
        log.debug("Dedup: NEW alert id=\"{id}\" hash={hash} — \"{summary}\"", { botName: tag, id: a.id, hash, summary: a.summary.slice(0, 60) });
        return true;
      });

      if (newAlerts.length > 0) {
        // Format as markdown (stored in DB), convert to Telegram HTML for send
        const markdown = formatAlerts(watcher, newAlerts);
        agentStatus.set("sending_telegram", watcher.name);
        await api.sendMessage(watcher.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });

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
          `Watcher "${watcher.name}" sent ${newAlerts.length} alert(s)`,
          { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } as any },
        );
        log.info("Watcher \"{name}\" sent {count} alert(s) to user {userId}", { botName: tag, name: watcher.name, count: newAlerts.length, userId: watcher.userId });
      }

      // Update last_run_at and keep a rolling window of IDs + content hashes
      const newEntries = newAlerts.flatMap((a) => {
        const hash = contentHash(a);
        const extras = a.trackingIds ?? [];
        return hash ? [a.id, hash, ...extras] : [a.id, ...extras];
      });
      const updatedIds = [
        ...watcher.lastNotifiedIds,
        ...newEntries,
      ].slice(-MAX_NOTIFIED_IDS);

      await updateWatcherLastRun(watcher.id, updatedIds);
      agentStatus.completeRequest(requestId, {});
      agentStatus.set("idle");
      wt?.finish("ok", { type: watcher.type, alertsFound: alerts.length, alertsSent: newAlerts.length });
    } catch (err) {
      agentStatus.clearRequest();
      agentStatus.set("idle");
      wt?.error(err instanceof Error ? err : String(err));
      log.error("Watcher \"{name}\" ({watcherId}) failed: {error}", { botName: tag, name: watcher.name, watcherId: watcher.id, error: err instanceof Error ? err.message : String(err) });

      // Still advance lastRunAt on failure to prevent retry storms
      try {
        await updateWatcherLastRun(watcher.id, watcher.lastNotifiedIds);
      } catch (updateErr) {
        log.error("Failed to update watcher last_run_at after error: {error}", { botName: tag, watcherId: watcher.id, error: updateErr instanceof Error ? updateErr.message : String(updateErr) });
      }
    }
  }
}

async function runChecker(watcher: Watcher, cwd?: string, botName?: string): Promise<WatcherAlert[]> {
  switch (watcher.type) {
    case "email":
      return await checkEmail(watcher, cwd, botName);
    case "news":
      return await checkNews(watcher);
    case "x":
      return await checkX(watcher, cwd, botName);
    default:
      log.warn("Watcher type \"{type}\" not yet implemented", { type: watcher.type });
      return [];
  }
}

/**
 * Trigger a single watcher run manually (from dashboard).
 * Skips quiet hours and time-of-day checks — runs immediately.
 */
export async function runSingleWatcher(api: Api, botConfig: BotConfig, watcher: Watcher): Promise<{ alertsSent: number }> {
  const tag = botConfig.name;
  log.info("Manual trigger: watcher \"{name}\"", { botName: tag, name: watcher.name });

  const alerts = await runChecker(watcher, botConfig.dir, tag);

  const known = new Set(watcher.lastNotifiedIds);
  const newAlerts = alerts.filter((a) => {
    if (known.has(a.id)) return false;
    const hash = contentHash(a);
    return !(hash && known.has(hash));
  });

  if (newAlerts.length > 0) {
    const markdown = formatAlerts(watcher, newAlerts);
    await api.sendMessage(watcher.userId, formatTelegramHtml(markdown), { parse_mode: "HTML" });
    const threadId = await getActiveThreadId(watcher.userId, tag);
    await saveMessage({
      userId: watcher.userId, botName: tag, role: "assistant", content: markdown,
      source: `watcher:${watcher.type}`, platform: "telegram", threadId,
    });
    activityLog.push(
      "system",
      `Watcher "${watcher.name}" manually triggered — sent ${newAlerts.length} alert(s)`,
      { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } as any },
    );
    log.info("Manual trigger: \"{name}\" sent {count} alert(s)", { botName: tag, name: watcher.name, count: newAlerts.length });
  } else {
    log.info("Manual trigger: \"{name}\" — no new alerts", { botName: tag, name: watcher.name });
  }

  const newEntries = newAlerts.flatMap((a) => {
    const hash = contentHash(a);
    const extras = a.trackingIds ?? [];
    return hash ? [a.id, hash, ...extras] : [a.id, ...extras];
  });
  const updatedIds = [...watcher.lastNotifiedIds, ...newEntries].slice(-MAX_NOTIFIED_IDS);
  await updateWatcherLastRun(watcher.id, updatedIds);

  return { alertsSent: newAlerts.length };
}

export function formatAlerts(watcher: Watcher, alerts: WatcherAlert[]): string {
  const icon = watcher.type === "email" ? "\u{1F4E8}" : watcher.type === "news" ? "\u{1F4F0}" : watcher.type === "x" ? "\u{1D54F}" : "\u{1F514}";
  const header = `${icon} **${watcher.name}**\n`;
  const lines = alerts.map((a) => {
    const urgencyTag = a.urgency === "high" ? " \u{1F534}" : a.urgency === "medium" ? " \u{1F7E1}" : "";
    return `${urgencyTag} ${a.summary}`;
  });
  return header + lines.join("\n\n");
}
