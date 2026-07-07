import type { Context } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { UserIdentity } from "../types.ts";
import { processMessage } from "../core/message-processor.ts";
import { stripHtml } from "./telegram-format.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { setTelegramMessageId } from "../db/messages.ts";
import { getLog } from "../logging.ts";

const log = getLog("bot", "handler");

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

    // say callback — message-processor already handles splitting for Telegram.
    // Track the last successfully-sent reply's message_id so an incoming
    // reaction can be resolved back to this turn's assistant DB row. A long
    // response may be split into several Telegram messages but maps to one DB
    // row; we anchor on the last chunk (the tail the user sees in the chat).
    let lastReplyMessageId: number | undefined;
    const say = async (html: string) => {
      try {
        const msg = await ctx.reply(html, { parse_mode: "HTML" });
        lastReplyMessageId = msg.message_id;
      } catch {
        const msg = await ctx.reply(stripHtml(html)).catch(() => undefined);
        if (msg) lastReplyMessageId = msg.message_id;
      }
    };

    // Tool status: send one message, edit it to append each new line, delete when done.
    // Serialized via promise chain to prevent race conditions (two rapid tool_start events
    // could both see statusMsgId as undefined and send two messages).
    let statusMsgId: number | undefined;
    let statusLines: string[] = [];
    let statusChain: Promise<void> = Promise.resolve();
    const chatId = ctx.chat!.id;

    const onToolStatus = (info: { text: string; name: string; displayName: string }) => {
      statusChain = statusChain.then(async () => {
        statusLines.push(info.text);
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
      const result = await processMessage({
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
      // Anchor the assistant DB row to the sent Telegram message so a later
      // 👍/👎 reaction can be attributed to it (see reaction-handler.ts).
      if (result?.messageId && lastReplyMessageId !== undefined) {
        await setTelegramMessageId(result.messageId, chatId, lastReplyMessageId).catch((err) => {
          log.warn("Failed to stamp Telegram message id: {error}", {
            botName: botConfig.name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
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
