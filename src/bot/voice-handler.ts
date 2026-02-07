import { InputFile } from "grammy";
import type { Context } from "grammy";
import type { Config } from "../config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { extractGoalAsync } from "../goals/detector.ts";
import { extractScheduleAsync } from "../scheduler/detector.ts";
import { splitMessage } from "./handler.ts";
import { formatTelegramHtml, stripHtml } from "./telegram-format.ts";
import { transcribeVoice } from "../voice/stt.ts";
import { synthesizeVoice } from "../voice/tts.ts";
import { Timing } from "../utils/timing.ts";

export function createVoiceHandler(config: Config) {
  return async (ctx: Context) => {
    const voice = ctx.message?.voice;
    if (!voice) return;

    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const userId = ctx.from?.id;
    if (!userId) return;

    const t = new Timing();

    // Download voice message from Telegram
    t.start("voice_download");
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      await ctx.reply("Failed to download voice message.");
      return;
    }
    const oggBuffer = new Uint8Array(await response.arrayBuffer());
    t.end("voice_download");

    // Transcribe voice → text
    t.start("stt");
    let text: string;
    try {
      text = await transcribeVoice(oggBuffer, config);
    } catch (error) {
      t.end("stt");
      const msg = error instanceof Error ? error.message : String(error);
      activityLog.push("error", `[Voice] Transcription failed: ${msg}`, { userId, username });
      await ctx.reply(`Couldn't transcribe voice: ${msg}`);
      return;
    }
    t.end("stt");

    activityLog.push("message_in", `[Voice] ${text}`, { userId, username });

    // Save transcribed message to DB
    t.start("db_save_user");
    await saveMessage({ userId, username, role: "user", content: text });
    t.end("db_save_user");

    // Build context-aware prompt and run through Claude
    t.start("prompt_build");
    const { systemPrompt, userPrompt, meta: promptMeta } = await buildPrompt(userId, text);
    t.end("prompt_build");

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      t.start("claude");
      const result = await executeClaudePrompt(userPrompt, config, systemPrompt);
      t.end("claude");
      clearInterval(typingInterval);

      // Save assistant response
      t.start("db_save_response");
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
      t.end("db_save_response");

      // Extract memories and goals async
      extractMemoryAsync(
        {
          userId,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
      );
      extractGoalAsync(
        {
          userId,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
      );
      extractScheduleAsync(
        {
          userId,
          userMessage: text,
          assistantResponse: result.result,
        },
        config,
      );

      // Convert to Telegram-safe HTML and send text reply first
      const html = formatTelegramHtml(result.result);

      const footer = `\n\n<i>⏱ ${t.formatTelegram({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        startupMs: result.startupMs,
        apiMs: result.durationApiMs,
      })}</i>`;

      const fullHtml = html + footer;

      t.start("telegram_send");
      if (fullHtml.length <= 4096) {
        await ctx.reply(fullHtml, { parse_mode: "HTML" }).catch(async () => {
          await ctx.reply(stripHtml(result.result));
        });
      } else {
        const chunks = splitMessage(html, 4096 - footer.length);
        for (let i = 0; i < chunks.length; i++) {
          const raw = chunks[i]!;
          const chunk = i === chunks.length - 1 ? raw + footer : raw;
          await ctx.reply(chunk, { parse_mode: "HTML" }).catch(async () => {
            await ctx.reply(stripHtml(raw));
          });
        }
      }
      t.end("telegram_send");

      // Mirror mode: also send voice reply
      t.start("tts");
      try {
        const voiceBuffer = await synthesizeVoice(result.result);
        t.end("tts");

        t.start("telegram_send_voice");
        await ctx.replyWithVoice(new InputFile(voiceBuffer, "response.ogg"));
        t.end("telegram_send_voice");
      } catch (ttsError) {
        if (!t.summary().tts) t.end("tts");
        const msg = ttsError instanceof Error ? ttsError.message : String(ttsError);
        console.error(`[Voice] TTS failed: ${msg}`);
        activityLog.push("error", `[Voice] TTS failed: ${msg}`, { userId, username });
      }

      // Push activity with timing metadata
      const s = t.summary();
      activityLog.push("message_out", result.result, {
        userId,
        username,
        durationMs: Math.round(t.totalMs()),
        costUsd: result.costUsd,
        metadata: {
          totalMs: t.totalMs(),
          startupMs: result.startupMs,
          apiMs: result.durationApiMs,
          promptBuildMs: s.prompt_build ?? 0,
          sttMs: s.stt ?? 0,
          ttsMs: s.tts ?? 0,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          model: result.model,
          numTurns: result.numTurns,
        },
      });

      // Console timing breakdown
      console.log(
        `[Jarvis] 📊 Voice request timing breakdown:\n` +
          `  voice_download: ${pad(s.voice_download)}\n` +
          `  stt:           ${pad(s.stt)}\n` +
          `  prompt_build:   ${pad(s.prompt_build)}  (db: ${Math.round(promptMeta.dbHistoryMs)}ms, embed: ${Math.round(promptMeta.embeddingMs)}ms, search: ${Math.round(promptMeta.memorySearchMs)}ms | ${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)\n` +
          `  claude:        ${pad(s.claude)}  (startup/mcp: ${Math.round(result.startupMs)}ms, api: ${Math.round(result.durationApiMs)}ms, ${result.numTurns} turns, ${fmtTokens(result.inputTokens)} in / ${fmtTokens(result.outputTokens)} out)\n` +
          `  db_save:        ${pad((s.db_save_user ?? 0) + (s.db_save_response ?? 0))}\n` +
          `  format+send:    ${pad(s.telegram_send)}\n` +
          `  tts:           ${pad(s.tts)}\n` +
          `  ─────────────────────\n` +
          `  total:         ${pad(t.totalMs())}  ($${(result.costUsd ?? 0).toFixed(4)})`,
      );
    } catch (error) {
      clearInterval(typingInterval);
      const errorMessage = error instanceof Error ? error.message : String(error);
      activityLog.push("error", errorMessage, { userId, username });
      await ctx.reply(`Something went wrong: ${errorMessage}`);
    }
  };
}

function pad(ms: number | undefined): string {
  return `${Math.round(ms ?? 0)}ms`.padEnd(7);
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
