import type { Context } from "grammy";
import type { Config } from "../config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { extractGoalAsync } from "../goals/detector.ts";
import { extractScheduleAsync } from "../scheduler/detector.ts";
import { formatTelegramHtml, stripHtml } from "./telegram-format.ts";
import { Timing } from "../utils/timing.ts";

export function createMessageHandler(config: Config) {
  return async (ctx: Context) => {
    const text = ctx.message?.text;
    if (!text) return;

    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const userId = ctx.from?.id;
    if (!userId) return;

    const t = new Timing();

    activityLog.push("message_in", text, { userId, username });

    // Save user message to DB
    t.start("db_save_user");
    await saveMessage({ userId, username, role: "user", content: text });
    t.end("db_save_user");

    // Build context-aware prompt
    t.start("prompt_build");
    const { systemPrompt, userPrompt, meta: promptMeta } = await buildPrompt(userId, text);
    t.end("prompt_build");

    // Keep typing indicator alive while Claude processes
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);

    // Send initial typing
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      t.start("claude");
      const result = await executeClaudePrompt(userPrompt, config, systemPrompt);
      t.end("claude");

      clearInterval(typingInterval);

      // Save assistant response to DB
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

      // Extract memories and goals async (don't block response)
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

      // Convert to Telegram-safe HTML
      const html = formatTelegramHtml(result.result);

      // Build timing footer
      const footer = `\n\n<i>⏱ ${t.formatTelegram({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        startupMs: result.startupMs,
        apiMs: result.durationApiMs,
      })}</i>`;

      const fullHtml = html + footer;

      // Telegram has a 4096 char limit per message
      t.start("telegram_send");
      if (fullHtml.length <= 4096) {
        await ctx.reply(fullHtml, { parse_mode: "HTML" }).catch(async () => {
          await ctx.reply(stripHtml(result.result));
        });
      } else {
        // Split main content, add footer to last chunk
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

      // Push activity with timing metadata
      activityLog.push("message_out", result.result, {
        userId,
        username,
        durationMs: Math.round(t.totalMs()),
        costUsd: result.costUsd,
        metadata: {
          totalMs: t.totalMs(),
          startupMs: result.startupMs,
          apiMs: result.durationApiMs,
          promptBuildMs: t.summary().prompt_build ?? 0,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          model: result.model,
          numTurns: result.numTurns,
        },
      });

      // Console timing breakdown
      const s = t.summary();
      console.log(
        `[Jarvis] 📊 Request timing breakdown:\n` +
          `  prompt_build:   ${pad(s.prompt_build)}  (db: ${Math.round(promptMeta.dbHistoryMs)}ms, embed: ${Math.round(promptMeta.embeddingMs)}ms, search: ${Math.round(promptMeta.memorySearchMs)}ms | ${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)\n` +
          `  claude:        ${pad(s.claude)}  (startup/mcp: ${Math.round(result.startupMs)}ms, api: ${Math.round(result.durationApiMs)}ms, ${result.numTurns} turns, ${fmtTokens(result.inputTokens)} in / ${fmtTokens(result.outputTokens)} out)\n` +
          `  db_save:        ${pad((s.db_save_user ?? 0) + (s.db_save_response ?? 0))}\n` +
          `  format+send:    ${pad(s.telegram_send)}\n` +
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

export function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Fall back to splitting at a space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
