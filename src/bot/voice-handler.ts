import { InputFile } from "grammy";
import type { Context } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import type { UserIdentity } from "../types.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { extractGoalAsync } from "../goals/detector.ts";
import { extractScheduleAsync } from "../scheduler/detector.ts";
import { splitMessage } from "../utils/split-message.ts";
import { formatTelegramHtml, stripHtml } from "./telegram-format.ts";
import { transcribeVoice } from "../voice/stt.ts";
import { synthesizeVoice } from "../voice/tts.ts";
import { Tracer } from "../tracing/index.ts";
import { agentStatus } from "../dashboard/agent-status.ts";
import { savePromptSnapshot } from "../db/prompt-snapshots.ts";

export function createVoiceHandler(config: Config, botConfig: BotConfig) {
  const tag = `[${botConfig.name}]`;

  return async (ctx: Context) => {
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

    const t = new Tracer("telegram_voice", { botName: botConfig.name, userId, username, platform: "telegram" });

    // Download voice message from Telegram
    agentStatus.set("receiving", username);
    t.start("voice_download");
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${botConfig.telegramBotToken!}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      await ctx.reply("Failed to download voice message.");
      return;
    }
    const oggBuffer = new Uint8Array(await response.arrayBuffer());
    t.end("voice_download");

    // Transcribe voice → text
    agentStatus.set("transcribing", username);
    t.start("stt");
    let text: string;
    try {
      text = await transcribeVoice(oggBuffer, config);
    } catch (error) {
      t.end("stt");
      const msg = error instanceof Error ? error.message : String(error);
      activityLog.push("error", `[Voice] Transcription failed: ${msg}`, { userId, username, botName: botConfig.name });
      await ctx.reply(`Couldn't transcribe voice: ${msg}`);
      return;
    }
    t.end("stt");

    activityLog.push("message_in", `[Voice] ${text}`, { userId, username, botName: botConfig.name });
    console.log(`${tag} Voice from ${username}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" (STT: ${Math.round(t.summary().stt ?? 0)}ms)`);

    // Save transcribed message to DB
    t.start("db_save_user");
    await saveMessage({ userId, botName: botConfig.name, username, role: "user", content: text });
    t.end("db_save_user");

    // Build context-aware prompt and run through Claude
    agentStatus.set("building_prompt", username);
    t.start("prompt_build");
    const { systemPrompt, userPrompt, meta: promptMeta } = await buildPrompt(userId, text, botConfig.persona, botConfig.name, botConfig.restrictedTools, userIdentity);
    t.end("prompt_build", promptMeta);
    savePromptSnapshot({ traceId: t.traceId, systemPrompt, userPrompt }).catch(() => {});

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      agentStatus.set("calling_claude", username);
      const effectiveModel = botConfig.model ?? config.claudeModel;
      const effectiveTimeout = botConfig.timeoutMs ?? config.claudeTimeoutMs;
      console.log(`${tag} Calling Claude for voice (model: ${effectiveModel}, timeout: ${effectiveTimeout}ms)...`);
      t.start("claude");
      const result = await executeClaudePrompt(userPrompt, config, botConfig, systemPrompt);
      t.end("claude", {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        numTurns: result.numTurns,
        startupMs: result.startupMs,
        apiMs: result.durationApiMs,
        costUsd: result.costUsd,
      });
      console.log(`${tag} Claude responded in ${Math.round(t.summary().claude ?? 0)}ms (${result.numTurns} turns)`);
      clearInterval(typingInterval);

      // Save assistant response
      agentStatus.set("saving_response", username);
      t.start("db_save_response");
      const messageId = await saveMessage({
        userId,
        botName: botConfig.name,
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
      const traceCtx = t.context;
      extractMemoryAsync(
        {
          userId,
          botName: botConfig.name,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
        traceCtx,
      );
      extractGoalAsync(
        {
          userId,
          botName: botConfig.name,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
        traceCtx,
      );
      extractScheduleAsync(
        {
          userId,
          botName: botConfig.name,
          userMessage: text,
          assistantResponse: result.result,
        },
        config,
        traceCtx,
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

      agentStatus.set("sending_telegram", username);
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
      agentStatus.set("synthesizing_voice", username);
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
        activityLog.push("error", `[Voice] TTS failed: ${msg}`, { userId, username, botName: botConfig.name });
      }

      agentStatus.set("idle");
      t.finish("ok", { inputTokens: result.inputTokens, outputTokens: result.outputTokens });

      // Push activity with timing metadata
      const s = t.summary();
      activityLog.push("message_out", result.result, {
        userId,
        username,
        botName: botConfig.name,
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
        `${tag} Voice request timing breakdown:\n` +
          `  voice_download: ${pad(s.voice_download)}\n` +
          `  stt:           ${pad(s.stt)}\n` +
          `  prompt_build:   ${pad(s.prompt_build)}  (db: ${Math.round(promptMeta.dbHistoryMs)}ms, embed: ${Math.round(promptMeta.embeddingMs)}ms, search: ${Math.round(promptMeta.memorySearchMs)}ms | ${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)\n` +
          `  claude:        ${pad(s.claude)}  (startup/mcp: ${Math.round(result.startupMs ?? 0)}ms, api: ${Math.round(result.durationApiMs)}ms, ${result.numTurns} turns, ${fmtTokens(result.inputTokens)} in / ${fmtTokens(result.outputTokens)} out)\n` +
          `  db_save:        ${pad((s.db_save_user ?? 0) + (s.db_save_response ?? 0))}\n` +
          `  format+send:    ${pad(s.telegram_send)}\n` +
          `  tts:           ${pad(s.tts)}\n` +
          `  ─────────────────────\n` +
          `  total:         ${pad(t.totalMs())}  ($${(result.costUsd ?? 0).toFixed(4)})`,
      );
    } catch (error) {
      clearInterval(typingInterval);
      agentStatus.set("idle");
      t.error(error instanceof Error ? error : String(error));
      const errorMessage = error instanceof Error ? error.message : String(error);
      const s = t.summary();
      const elapsed = Math.round(t.totalMs());
      const lastPhase = Object.entries(s)
        .filter(([, v]) => v != null)
        .map(([k]) => k)
        .pop() ?? "unknown";
      console.error(
        `${tag} Voice request failed after ${elapsed}ms (last completed phase: ${lastPhase})\n` +
          `  Error: ${errorMessage}\n` +
          `  Phases: ${Object.entries(s).map(([k, v]) => `${k}=${Math.round(v ?? 0)}ms`).join(", ")}`,
      );
      activityLog.push("error", errorMessage, { userId, username, botName: botConfig.name });
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
