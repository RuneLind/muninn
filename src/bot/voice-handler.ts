import { InputFile } from "grammy";
import type { Context } from "grammy";
import type { Config } from "../config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { splitMessage } from "./handler.ts";
import { formatTelegramHtml } from "./telegram-format.ts";
import { transcribeVoice } from "../voice/stt.ts";
import { synthesizeVoice } from "../voice/tts.ts";

export function createVoiceHandler(config: Config) {
  return async (ctx: Context) => {
    const voice = ctx.message?.voice;
    if (!voice) return;

    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const userId = ctx.from?.id;
    if (!userId) return;

    // Download voice message from Telegram
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      await ctx.reply("Failed to download voice message.");
      return;
    }
    const oggBuffer = new Uint8Array(await response.arrayBuffer());

    // Transcribe voice → text
    let text: string;
    try {
      text = await transcribeVoice(oggBuffer, config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      activityLog.push("error", `[Voice] Transcription failed: ${msg}`, { userId, username });
      await ctx.reply(`Couldn't transcribe voice: ${msg}`);
      return;
    }

    activityLog.push("message_in", `[Voice] ${text}`, { userId, username });

    // Save transcribed message to DB
    await saveMessage({ userId, username, role: "user", content: text });

    // Build context-aware prompt and run through Claude
    const prompt = await buildPrompt(userId, text);

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      const result = await executeClaudePrompt(prompt, config);
      clearInterval(typingInterval);

      // Save assistant response
      const messageId = await saveMessage({
        userId,
        username,
        role: "assistant",
        content: result.result,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      activityLog.push("message_out", result.result, {
        userId,
        username,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      });

      // Extract memories async
      extractMemoryAsync(
        {
          userId,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
      );

      // Convert to Telegram-safe HTML and send text reply first
      const html = formatTelegramHtml(result.result);
      if (html.length <= 4096) {
        await ctx.reply(html, { parse_mode: "HTML" }).catch(async () => {
          await ctx.reply(result.result);
        });
      } else {
        const chunks = splitMessage(html, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: "HTML" }).catch(async () => {
            await ctx.reply(chunk);
          });
        }
      }

      // Mirror mode: also send voice reply
      try {
        const voiceBuffer = await synthesizeVoice(result.result);
        await ctx.replyWithVoice(new InputFile(voiceBuffer, "response.ogg"));
      } catch (ttsError) {
        // Graceful fallback — text already sent, just log the TTS failure
        const msg = ttsError instanceof Error ? ttsError.message : String(ttsError);
        console.error(`[Voice] TTS failed: ${msg}`);
        activityLog.push("error", `[Voice] TTS failed: ${msg}`, { userId, username });
      }
    } catch (error) {
      clearInterval(typingInterval);
      const errorMessage = error instanceof Error ? error.message : String(error);
      activityLog.push("error", errorMessage, { userId, username });
      await ctx.reply(`Something went wrong: ${errorMessage}`);
    }
  };
}
