import type { Bot } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import {
  handleTopicCommand,
  handleTopicsCommand,
  handleDelTopicCommand,
} from "../core/topic-commands.ts";

export function registerTopicCommands(bot: Bot, botConfig: BotConfig): void {
  // /topic [name] — show current topic or switch
  bot.command("topic", async (ctx) => {
    const userId = String(ctx.from!.id);
    const arg = ctx.match?.trim() ?? "";
    const reply = (text: string) => telegramReply(ctx, text);
    await handleTopicCommand(userId, botConfig.name, arg, reply);
  });

  // /topics — list all topics
  bot.command("topics", async (ctx) => {
    const userId = String(ctx.from!.id);
    const reply = (text: string) => telegramReply(ctx, text);
    await handleTopicsCommand(userId, botConfig.name, reply);
  });

  // /deltopic <name> — delete/archive a topic
  bot.command("deltopic", async (ctx) => {
    const userId = String(ctx.from!.id);
    const arg = ctx.match?.trim() ?? "";
    const reply = (text: string) => telegramReply(ctx, text);
    await handleDelTopicCommand(userId, botConfig.name, arg, reply);
  });
}

/** Convert shared plain-text-with-markdown replies to Telegram HTML. */
async function telegramReply(ctx: { reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown> }, text: string): Promise<void> {
  await ctx.reply(convertToTelegramHtml(text), { parse_mode: "HTML" });
}

/** Convert *bold* to <b>bold</b> and `code` to <code>code</code>, with HTML escaping. */
export function convertToTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*([^*]+)\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
