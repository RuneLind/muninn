import type { Context } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";
import { extractGoalAsync } from "../goals/detector.ts";
import { extractScheduleAsync } from "../scheduler/detector.ts";
import { formatTelegramHtml, stripHtml } from "./telegram-format.ts";
import { Tracer } from "../tracing/index.ts";
import { agentStatus } from "../dashboard/agent-status.ts";
import { savePromptSnapshot } from "../db/prompt-snapshots.ts";

export function createMessageHandler(config: Config, botConfig: BotConfig) {
  const tag = `[${botConfig.name}]`;

  return async (ctx: Context) => {
    const text = ctx.message?.text;
    if (!text) return;

    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    if (!ctx.from?.id) return;
    const userId = String(ctx.from.id);

    const t = new Tracer("telegram_text", { botName: botConfig.name, userId, username, platform: "telegram" });

    activityLog.push("message_in", text, { userId, username, botName: botConfig.name });
    agentStatus.set("receiving", username);
    console.log(`${tag} Message from ${username}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

    // Save user message to DB
    t.start("db_save_user");
    await saveMessage({ userId, botName: botConfig.name, username, role: "user", content: text });
    t.end("db_save_user");

    // Build context-aware prompt
    agentStatus.set("building_prompt", username);
    t.start("prompt_build");
    const { systemPrompt, userPrompt, meta: promptMeta } = await buildPrompt(userId, text, botConfig.persona, botConfig.name, botConfig.restrictedTools);
    t.end("prompt_build", promptMeta);
    savePromptSnapshot({ traceId: t.traceId, systemPrompt, userPrompt }).catch(() => {});
    console.log(`${tag} Prompt built in ${Math.round(t.summary().prompt_build ?? 0)}ms (${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)`);

    // Keep typing indicator alive while Claude processes
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);

    // Send initial typing
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      agentStatus.set("calling_claude", username);
      const effectiveModel = botConfig.model ?? config.claudeModel;
      const effectiveTimeout = botConfig.timeoutMs ?? config.claudeTimeoutMs;
      console.log(`${tag} Calling Claude (model: ${effectiveModel}, timeout: ${effectiveTimeout}ms)...`);
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

      // Save assistant response to DB
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

      // Extract memories and goals async (don't block response)
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
          platform: "telegram",
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
          platform: "telegram",
        },
        config,
        traceCtx,
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
      agentStatus.set("sending_telegram", username);
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
        botName: botConfig.name,
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

      agentStatus.set("idle");
      t.finish("ok");

      // Console timing breakdown
      const s = t.summary();
      console.log(
        `${tag} Request timing breakdown:\n` +
          `  prompt_build:   ${pad(s.prompt_build)}  (db: ${Math.round(promptMeta.dbHistoryMs)}ms, embed: ${Math.round(promptMeta.embeddingMs)}ms, search: ${Math.round(promptMeta.memorySearchMs)}ms | ${promptMeta.messagesCount} msgs, ${promptMeta.memoriesCount} memories)\n` +
          `  claude:        ${pad(s.claude)}  (startup/mcp: ${Math.round(result.startupMs)}ms, api: ${Math.round(result.durationApiMs)}ms, ${result.numTurns} turns, ${fmtTokens(result.inputTokens)} in / ${fmtTokens(result.outputTokens)} out)\n` +
          `  db_save:        ${pad((s.db_save_user ?? 0) + (s.db_save_response ?? 0))}\n` +
          `  format+send:    ${pad(s.telegram_send)}\n` +
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
        `${tag} Request failed after ${elapsed}ms (last completed phase: ${lastPhase})\n` +
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
