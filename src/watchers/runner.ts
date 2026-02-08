import type { Api } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import type { Watcher, WatcherAlert } from "../types.ts";
import { getWatchersDueNow, updateWatcherLastRun } from "../db/watchers.ts";
import { isQuietHours } from "./quiet-hours.ts";
import { checkEmail } from "./email.ts";
import { checkNews } from "./news.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { agentStatus } from "../dashboard/agent-status.ts";
import { saveMessage } from "../db/messages.ts";

const MAX_NOTIFIED_IDS = 400; // IDs + content hashes share this array

/**
 * Content-based dedup hash, extracted from the summary text itself.
 * Extracts sender name (from "Fra/From: X —" pattern) + proper nouns.
 * These survive Haiku's translation between runs.
 * Prefixed with "h:" to distinguish from message IDs in the shared array.
 */
function contentHash(alert: WatcherAlert): string | null {
  const text = alert.summary;
  if (!text) return null;

  // Extract sender from summary: "<b>Fra:</b> Sender Name — ..." or "From: Sender — ..."
  const senderMatch = text.match(/(?:Fra|From)[:\s<b>/]*\s*(.+?)\s*[—\-–]/i);
  const sender = senderMatch?.[1]?.replace(/<[^>]+>/g, "").trim().toLowerCase() ?? "";

  // Extract proper nouns from the rest (after the —)
  const afterDash = text.split(/[—\-–]/).slice(1).join(" ");
  const nouns = extractProperNouns(afterDash);

  const fingerprint = `${sender}|${nouns.join(",")}`;
  if (!sender && nouns.length === 0) return null;
  return `h:${Bun.hash(fingerprint)}`;
}

/** Extract proper nouns: ALL-CAPS words, mid-sentence capitalized words, long numbers */
function extractProperNouns(text: string): string[] {
  const clean = text.replace(/<[^>]+>/g, "");
  const words = clean.split(/[\s,;:—–\-\(\)\/]+/).filter((w) => w.length > 1);
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

export async function runWatchers(api: Api, botConfig: BotConfig): Promise<void> {
  const tag = botConfig.name;
  const dueWatchers = await getWatchersDueNow(tag);
  if (dueWatchers.length > 0) {
    console.log(`[${tag}] Running ${dueWatchers.length} due watcher(s)`);
  }

  for (const watcher of dueWatchers) {
    try {
      // Check quiet hours — skip notifications but still mark as run
      const quiet = await isQuietHours(watcher.userId);
      if (quiet) {
        await updateWatcherLastRun(watcher.id, watcher.lastNotifiedIds);
        continue;
      }

      agentStatus.set("running_watcher", watcher.name);

      const alerts = await runChecker(watcher, botConfig.dir, tag);

      // Filter out already-notified: by message ID and by content hash
      const known = watcher.lastNotifiedIds;
      const newAlerts = alerts.filter((a) => {
        if (known.includes(a.id)) {
          console.log(`[${tag}] Dedup: skipped by ID "${a.id}"`);
          return false;
        }
        const hash = contentHash(a);
        if (hash && known.includes(hash)) {
          console.log(`[${tag}] Dedup: skipped by content hash ${hash} — "${a.summary.slice(0, 60)}"`);
          return false;
        }
        console.log(`[${tag}] Dedup: NEW alert id="${a.id}" hash=${hash} — "${a.summary.slice(0, 60)}"`);
        return true;
      });

      if (newAlerts.length > 0) {
        const message = formatAlerts(watcher, newAlerts);
        agentStatus.set("sending_telegram", watcher.name);
        await api.sendMessage(watcher.userId, message, { parse_mode: "HTML" });

        // Persist alert in messages so Claude can reference it in conversation
        await saveMessage({
          userId: watcher.userId,
          botName: tag,
          role: "assistant",
          content: message,
          source: `watcher:${watcher.type}`,
        });

        activityLog.push(
          "system",
          `Watcher "${watcher.name}" sent ${newAlerts.length} alert(s)`,
          { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } as any },
        );
        console.log(
          `[${tag}] Watcher "${watcher.name}" sent ${newAlerts.length} alert(s) to user ${watcher.userId}`,
        );
      }

      // Update last_run_at and keep a rolling window of IDs + content hashes
      const newEntries = newAlerts.flatMap((a) => {
        const hash = contentHash(a);
        return hash ? [a.id, hash] : [a.id];
      });
      const updatedIds = [
        ...watcher.lastNotifiedIds,
        ...newEntries,
      ].slice(-MAX_NOTIFIED_IDS);

      await updateWatcherLastRun(watcher.id, updatedIds);
      agentStatus.set("idle");
    } catch (err) {
      agentStatus.set("idle");
      console.error(
        `[${tag}] Watcher "${watcher.name}" (${watcher.id}) failed:`,
        err,
      );
    }
  }
}

async function runChecker(watcher: Watcher, cwd?: string, botName?: string): Promise<WatcherAlert[]> {
  switch (watcher.type) {
    case "email":
      return await checkEmail(watcher, cwd, botName);
    case "news":
      return await checkNews(watcher);
    default:
      console.log(`Watcher type "${watcher.type}" not yet implemented`);
      return [];
  }
}

function formatAlerts(watcher: Watcher, alerts: WatcherAlert[]): string {
  const icon = watcher.type === "email" ? "\u{1F4E8}" : watcher.type === "news" ? "\u{1F4F0}" : "\u{1F514}";
  const header = `${icon} <b>${watcher.name}</b>\n`;
  const lines = alerts.map((a) => {
    const urgencyTag = a.urgency === "high" ? " \u{1F534}" : a.urgency === "medium" ? " \u{1F7E1}" : "";
    return `${urgencyTag} ${a.summary}`;
  });
  return header + lines.join("\n\n");
}
