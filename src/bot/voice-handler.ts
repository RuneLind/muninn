import { InputFile } from "grammy";
import type { Context } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { UserIdentity } from "../types.ts";
import { processMessage } from "../core/message-processor.ts";
import { transcribeVoice } from "../voice/stt.ts";
import { synthesizeVoice } from "../voice/tts.ts";
import { stripHtml } from "./telegram-format.ts";
import { activityLog } from "../observability/activity-log.ts";
import { agentStatus } from "../observability/agent-status.ts";
import { Tracer } from "../tracing/index.ts";
import { getActiveThreadId } from "../db/threads.ts";
import { setTelegramMessageId } from "../db/messages.ts";
import { getLog } from "../logging.ts";

const log = getLog("bot", "voice");

export function createVoiceHandler(config: Config, botConfig: BotConfig) {
  return async (ctx: Context): Promise<void> => {
    const voice = ctx.message?.voice;
    if (!voice) return;
    if (!ctx.from?.id) return;

    const userId = String(ctx.from.id);
    const from = ctx.from;
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ");
    const username = from.username ?? from.first_name ?? "unknown";
    const userIdentity: UserIdentity = {
      name: fullName || username,
      ...(from.username && fullName && from.username !== fullName ? { displayName: from.username } : {}),
    };
    const props = { botName: botConfig.name, userId, username };

    const t = new Tracer("telegram_voice", { botName: botConfig.name, userId, username, platform: "telegram" });

    // --- Voice download ---
    agentStatus.set("receiving", username);
    t.start("voice_download");
    let oggBuffer: Uint8Array | null = null;
    let downloadError = "Failed to download voice message";
    try {
      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${botConfig.telegramBotToken!}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (response.ok) oggBuffer = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      // Logged here because the throw no longer reaches bot.catch. The message
      // only, never fileUrl: it carries the bot token.
      downloadError = error instanceof Error ? error.message : String(error);
      log.error("Voice download failed: {error}", { ...props, error: downloadError });
      activityLog.push("error", `[Voice] Download failed: ${downloadError}`, { userId, username, botName: botConfig.name });
    }
    if (!oggBuffer) {
      t.end("voice_download", undefined, "error");
      agentStatus.set("idle");
      t.error(downloadError);
      await ctx.reply("Failed to download voice message.");
      return;
    }
    t.end("voice_download");

    // --- STT transcription ---
    agentStatus.set("transcribing", username);
    t.start("stt");
    let text: string;
    try {
      text = await transcribeVoice(oggBuffer, config);
    } catch (error) {
      t.end("stt", undefined, "error");
      agentStatus.set("idle");
      const msg = error instanceof Error ? error.message : String(error);
      t.error(msg);
      activityLog.push("error", `[Voice] Transcription failed: ${msg}`, { userId, username, botName: botConfig.name });
      await ctx.reply(`Couldn't transcribe voice: ${msg}`);
      return;
    }
    t.end("stt");
    log.info("Voice from {username}: \"{preview}\" (STT: {sttMs}ms)", {
      ...props, preview: text.slice(0, 80) + (text.length > 80 ? "..." : ""), sttMs: Math.round(t.summary().stt ?? 0),
    });

    // Resolve thread
    const threadId = await getActiveThreadId(userId, botConfig.name);

    // Typing indicator
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      // Delegate to shared pipeline — say callback handles Telegram HTML with
      // fallback. Track the last successfully-sent reply's message_id so a
      // reaction on the text reply resolves back to the assistant DB row
      // (same anchoring as handler.ts: last chunk of a split response).
      let lastReplyMessageId: number | undefined;
      const say = async (msg: string) => {
        try {
          const sent = await ctx.reply(msg, { parse_mode: "HTML" });
          lastReplyMessageId = sent.message_id;
        } catch {
          const sent = await ctx.reply(stripHtml(msg)).catch(() => undefined);
          if (sent) lastReplyMessageId = sent.message_id;
        }
      };

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
        tracer: t,
      });

      if (!result) return;

      // Anchor the assistant DB row to the sent Telegram message for reaction
      // feedback (see reaction-handler.ts).
      if (result.messageId && lastReplyMessageId !== undefined && ctx.chat) {
        await setTelegramMessageId(result.messageId, ctx.chat.id, lastReplyMessageId).catch((err) => {
          log.warn("Failed to stamp Telegram message id: {error}", {
            ...props, error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // --- TTS voice reply ---
      agentStatus.set("synthesizing_voice", username);
      // The span still open when a step throws is the one that failed.
      let open: "tts" | "telegram_send_voice" | null = "tts";
      t.start("tts");
      try {
        const voiceBuffer = await synthesizeVoice(result.responseText);
        t.end("tts");
        open = "telegram_send_voice";
        t.start("telegram_send_voice");
        await ctx.replyWithVoice(new InputFile(voiceBuffer, "response.ogg"));
        open = null;
        t.end("telegram_send_voice");
      } catch (ttsError) {
        if (open) t.end(open, undefined, "error");
        const msg = ttsError instanceof Error ? ttsError.message : String(ttsError);
        log.error("TTS failed: {error}", { ...props, error: msg });
        activityLog.push("error", `[Voice] TTS failed: ${msg}`, { userId, username, botName: botConfig.name });
      }

      t.finish("ok", { inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    } catch (error) {
      t.error(error instanceof Error ? error : String(error));
      // processMessage already handled sending error to user
    } finally {
      clearInterval(typingInterval);
    }
  };
}
