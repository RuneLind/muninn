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

    // Tool status: send one message, edit it to append each new line, delete when done.
    // Serialized via promise chain to prevent race conditions (two rapid tool_start events
    // could both see statusMsgId as undefined and send two messages).
    let statusMsgId: number | undefined;
    let statusLines: string[] = [];
    let statusChain: Promise<void> = Promise.resolve();
    const chatId = ctx.chat!.id;

    const onToolStatus = (line: string) => {
      statusChain = statusChain.then(async () => {
        statusLines.push(line);
        const text = statusLines.map(l => `⏳ ${l}`).join("\n");
        try {
          if (!statusMsgId) {
            const msg = await ctx.api.sendMessage(chatId, text);
            statusMsgId = msg.message_id;
          } else {
            await ctx.api.editMessageText(chatId, statusMsgId, text).catch(() => {});
          }
        } catch { /* ignore send/edit failures */ }
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
        onToolStatus,
      });
    } catch (error) {
      // processMessage handles its own errors and calls say() with the error message,
      // but if say() itself fails (e.g. Telegram API down), we need a last-resort fallback
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Something went wrong: ${msg}`).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      // Wait for any pending status edits before deleting
      await statusChain.catch(() => {});
      if (statusMsgId) {
        ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
      }
    }
  };
}
