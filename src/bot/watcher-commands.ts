import type { Bot } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import {
  saveWatcher,
  getWatchersForUser,
  deleteWatcher,
  toggleWatcher,
} from "../db/watchers.ts";
import { upsertUserSettings, getUserSettings } from "../db/user-settings.ts";
import type { WatcherType } from "../types.ts";

const VALID_TYPES: WatcherType[] = ["email", "calendar", "github", "news", "goal"];

export function registerWatcherCommands(bot: Bot, botConfig: BotConfig): void {
  bot.command("watchers", async (ctx) => {
    const userId = ctx.from!.id;
    const watchers = await getWatchersForUser(userId, botConfig.name);

    if (watchers.length === 0) {
      await ctx.reply(
        "No active watchers.\n\nUse <code>/watch email [filter]</code> to create one.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const lines = watchers.map((w) => {
      const status = w.enabled ? "\u{2705}" : "\u{274C}";
      const interval = Math.round(w.intervalMs / 60000);
      const lastRun = w.lastRunAt
        ? new Date(w.lastRunAt).toLocaleTimeString("en-GB", { timeZone: "Europe/Oslo" })
        : "never";
      const filter = (w.config as { filter?: string }).filter;
      return `${status} <b>${w.name}</b> (${w.type}, every ${interval}min)\n    Last run: ${lastRun}${filter ? `\n    Filter: <code>${filter}</code>` : ""}\n    ID: <code>${w.id.slice(0, 8)}</code>`;
    });

    await ctx.reply(lines.join("\n\n"), { parse_mode: "HTML" });
  });

  bot.command("watch", async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.match?.trim() ?? "";

    if (!args) {
      await ctx.reply(
        "Usage: <code>/watch &lt;type&gt; [filter]</code>\n\nTypes: email, calendar, github, news, goal\n\nExample: <code>/watch email from:github.com</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const parts = args.split(/\s+/);
    const type = parts[0]!.toLowerCase();
    // Allow "emails" → "email"
    const normalizedType = type.replace(/s$/, "") as WatcherType;

    if (!VALID_TYPES.includes(normalizedType)) {
      await ctx.reply(
        `Unknown watcher type: <code>${type}</code>\n\nValid types: ${VALID_TYPES.join(", ")}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const filter = parts.slice(1).join(" ") || undefined;
    const name = filter
      ? `${normalizedType}: ${filter}`
      : normalizedType;

    const id = await saveWatcher({
      userId,
      botName: botConfig.name,
      name,
      type: normalizedType,
      config: filter ? { filter } : {},
    });

    await ctx.reply(
      `\u{2705} Watcher created: <b>${name}</b>\nChecks every 5 minutes.\nID: <code>${id.slice(0, 8)}</code>`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("unwatch", async (ctx) => {
    const userId = ctx.from!.id;
    const arg = ctx.match?.trim() ?? "";

    if (!arg) {
      await ctx.reply(
        "Usage: <code>/unwatch &lt;name or id&gt;</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const watchers = await getWatchersForUser(userId, botConfig.name);
    const match = watchers.find(
      (w) =>
        w.id.startsWith(arg) ||
        w.name.toLowerCase() === arg.toLowerCase(),
    );

    if (!match) {
      await ctx.reply(`No watcher found matching: <code>${arg}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }

    await deleteWatcher(match.id);
    await ctx.reply(`\u{1F5D1} Watcher removed: <b>${match.name}</b>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("quiet", async (ctx) => {
    const userId = ctx.from!.id;
    const arg = ctx.match?.trim() ?? "";

    if (!arg) {
      const settings = await getUserSettings(userId);
      if (settings.quietStart != null && settings.quietEnd != null) {
        await ctx.reply(
          `Quiet hours: <b>${settings.quietStart}:00 - ${settings.quietEnd}:00</b> (${settings.timezone})\n\nUse <code>/quiet off</code> to disable.`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(
          "No quiet hours set.\n\nUsage: <code>/quiet 22-08</code> to set quiet hours.",
          { parse_mode: "HTML" },
        );
      }
      return;
    }

    if (arg.toLowerCase() === "off") {
      await upsertUserSettings(userId, { quietStart: null, quietEnd: null });
      await ctx.reply("\u{1F514} Quiet hours disabled.");
      return;
    }

    const match = arg.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
      await ctx.reply(
        "Usage: <code>/quiet 22-08</code> or <code>/quiet off</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const start = parseInt(match[1]!, 10);
    const end = parseInt(match[2]!, 10);

    if (start < 0 || start > 23 || end < 0 || end > 23) {
      await ctx.reply("Hours must be between 0 and 23.");
      return;
    }

    await upsertUserSettings(userId, { quietStart: start, quietEnd: end });
    await ctx.reply(
      `\u{1F319} Quiet hours set: <b>${start}:00 - ${end}:00</b>\nNo watcher notifications during this time.`,
      { parse_mode: "HTML" },
    );
  });
}
