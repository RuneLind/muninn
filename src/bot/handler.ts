import type { Context } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { UserIdentity } from "../types.ts";
import { processMessage } from "../core/message-processor.ts";
import { stripHtml } from "./telegram-format.ts";
import { getActiveThreadId } from "../db/threads.ts";

export function createMessageHandler(config: Config, botConfig: BotConfig) {
  return async (ctx: Context) => {
    const text = ctx.message?.text;
    if (!text) return;

    if (!ctx.from?.id) return;
    const userId = String(ctx.from.id);
    const from = ctx.from;
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ");
    const username = from.username ?? from.first_name ?? "unknown";
    const userIdentity: UserIdentity = {
      name: fullName || username,
      ...(from.username && fullName && from.username !== fullName ? { displayName: from.username } : {}),
    };

    // Keep typing indicator alive while processing
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);
    await ctx.replyWithChatAction("typing").catch(() => {});

    // say callback — message-processor already handles splitting for Telegram
    const say = async (html: string) => {
      await ctx.reply(html, { parse_mode: "HTML" }).catch(async () => {
        await ctx.reply(stripHtml(html));
      });
    };

    try {
      const threadId = await getActiveThreadId(userId, botConfig.name);
      await processMessage({
        text,
        userId,
        username,
        userIdentity,
        platform: "telegram",
        botConfig,
        config,
        say,
        threadId,
      });
    } catch (error) {
      // processMessage handles its own errors and calls say() with the error message,
      // but if say() itself fails (e.g. Telegram API down), we need a last-resort fallback
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Something went wrong: ${msg}`).catch(() => {});
    } finally {
      clearInterval(typingInterval);
    }
  };
}
