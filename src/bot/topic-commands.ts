import type { Bot } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import type { Thread } from "../db/threads.ts";
import { switchThread, listThreads, getActiveThread, deleteThread, getThreadMessageCount } from "../db/threads.ts";
import { getLog } from "../logging.ts";

const log = getLog("bot", "topics");

export function registerTopicCommands(bot: Bot, botConfig: BotConfig): void {
  // /topic [name] — show current topic or switch
  bot.command("topic", async (ctx) => {
    const userId = String(ctx.from!.id);
    const arg = ctx.match?.trim() ?? "";

    if (!arg) {
      // Show current topic
      const active = await getActiveThread(userId, botConfig.name);
      const threads = await listThreads(userId, botConfig.name);

      if (threads.length === 0) {
        await ctx.reply("No topics yet. Messages go to the <b>main</b> topic by default.\n\nUse <code>/topic name</code> to create and switch.", { parse_mode: "HTML" });
        return;
      }

      const current = active?.name ?? "main";
      await ctx.reply(
        `Current topic: <b>${esc(current)}</b>\n\n${formatThreadList(threads)}\n\nSwitch: <code>/topic name</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Switch to topic
    const thread = await switchThread(userId, botConfig.name, arg);
    const count = await getThreadMessageCount(thread.id);

    log.info("User {userId} switched to topic \"{topic}\" ({count} msgs)", { userId, topic: thread.name, count });
    await ctx.reply(
      count === 0
        ? `Created and switched to topic: <b>${esc(thread.name)}</b>\nStarting fresh conversation.`
        : `Switched to topic: <b>${esc(thread.name)}</b>\n${count} messages in this thread.`,
      { parse_mode: "HTML" },
    );
  });

  // /topics — list all topics
  bot.command("topics", async (ctx) => {
    const userId = String(ctx.from!.id);
    const threads = await listThreads(userId, botConfig.name);

    if (threads.length === 0) {
      await ctx.reply("No topics yet. Use <code>/topic name</code> to create one.", { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(formatThreadList(threads), { parse_mode: "HTML" });
  });

  // /deltopic <name> — delete/archive a topic
  bot.command("deltopic", async (ctx) => {
    const userId = String(ctx.from!.id);
    const arg = ctx.match?.trim() ?? "";

    if (!arg) {
      await ctx.reply("Usage: <code>/deltopic name</code>", { parse_mode: "HTML" });
      return;
    }

    if (arg.toLowerCase() === "main") {
      await ctx.reply("Cannot delete the <b>main</b> topic.", { parse_mode: "HTML" });
      return;
    }

    const deleted = await deleteThread(userId, botConfig.name, arg);
    if (deleted) {
      log.info("User {userId} deleted topic \"{topic}\"", { userId, topic: arg });
      await ctx.reply(`Deleted topic: <b>${esc(arg)}</b>\nSwitched back to <b>main</b>.`, { parse_mode: "HTML" });
    } else {
      await ctx.reply(`Topic not found: <code>${esc(arg)}</code>`, { parse_mode: "HTML" });
    }
  });
}

function formatThreadList(threads: Thread[]): string {
  return threads.map((t) => {
    const marker = t.isActive ? "\u25B6\uFE0F" : "\u25CB";
    const count = t.messageCount ?? 0;
    const ago = formatTimeAgo(t.updatedAt);
    return `${marker} <b>${esc(t.name)}</b> — ${count} msgs, ${ago}`;
  }).join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTimeAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
