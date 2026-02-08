import type { Api } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import type { Watcher, WatcherAlert } from "../types.ts";
import { getWatchersDueNow, updateWatcherLastRun } from "../db/watchers.ts";
import { isQuietHours } from "./quiet-hours.ts";
import { checkEmail } from "./email.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { agentStatus } from "../dashboard/agent-status.ts";

const MAX_NOTIFIED_IDS = 200;

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

      const alerts = await runChecker(watcher, botConfig.dir);

      // Filter out already-notified IDs
      const newAlerts = alerts.filter(
        (a) => !watcher.lastNotifiedIds.includes(a.id),
      );

      if (newAlerts.length > 0) {
        const message = formatAlerts(watcher, newAlerts);
        agentStatus.set("sending_telegram", watcher.name);
        await api.sendMessage(watcher.userId, message, { parse_mode: "HTML" });

        activityLog.push(
          "system",
          `Watcher "${watcher.name}" sent ${newAlerts.length} alert(s)`,
          { userId: watcher.userId, botName: tag, metadata: { totalMs: 0, watcherName: watcher.name, watcherId: watcher.id } as any },
        );
        console.log(
          `[${tag}] Watcher "${watcher.name}" sent ${newAlerts.length} alert(s) to user ${watcher.userId}`,
        );
      }

      // Update last_run_at and keep a rolling window of notified IDs
      const updatedIds = [
        ...watcher.lastNotifiedIds,
        ...newAlerts.map((a) => a.id),
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

async function runChecker(watcher: Watcher, cwd?: string): Promise<WatcherAlert[]> {
  switch (watcher.type) {
    case "email":
      return await checkEmail(watcher, cwd);
    default:
      console.log(`Watcher type "${watcher.type}" not yet implemented`);
      return [];
  }
}

function formatAlerts(watcher: Watcher, alerts: WatcherAlert[]): string {
  const icon = watcher.type === "email" ? "\u{1F4E8}" : "\u{1F514}";
  const header = `${icon} <b>${watcher.name}</b>\n`;
  const lines = alerts.map((a) => {
    const urgencyTag = a.urgency === "high" ? " \u{1F534}" : a.urgency === "medium" ? " \u{1F7E1}" : "";
    return `${urgencyTag} ${a.summary}`;
  });
  return header + lines.join("\n\n");
}
