import type { Context } from "grammy";
import type { Config } from "../config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { buildPrompt } from "../ai/prompt-builder.ts";
import { activityLog } from "../dashboard/activity-log.ts";
import { saveMessage } from "../db/messages.ts";
import { extractMemoryAsync } from "../memory/extractor.ts";

export function createMessageHandler(config: Config) {
  return async (ctx: Context) => {
    const text = ctx.message?.text;
    if (!text) return;

    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const userId = ctx.from?.id;
    if (!userId) return;

    activityLog.push("message_in", text, { userId, username });

    // Save user message to DB
    await saveMessage({ userId, username, role: "user", content: text });

    // Build context-aware prompt
    const prompt = await buildPrompt(userId, text);

    // Keep typing indicator alive while Claude processes
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);

    // Send initial typing
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      const result = await executeClaudePrompt(prompt, config);

      clearInterval(typingInterval);

      // Save assistant response to DB
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

      // Extract memories async (don't block response)
      extractMemoryAsync(
        {
          userId,
          userMessage: text,
          assistantResponse: result.result,
          sourceMessageId: messageId,
        },
        config,
      );

      // Telegram has a 4096 char limit per message
      if (result.result.length <= 4096) {
        await ctx.reply(result.result, { parse_mode: "Markdown" }).catch(async () => {
          // Fallback to plain text if markdown parsing fails
          await ctx.reply(result.result);
        });
      } else {
        // Split into chunks
        const chunks = splitMessage(result.result, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(async () => {
            await ctx.reply(chunk);
          });
        }
      }
    } catch (error) {
      clearInterval(typingInterval);

      const errorMessage = error instanceof Error ? error.message : String(error);
      activityLog.push("error", errorMessage, { userId, username });
      await ctx.reply(`Something went wrong: ${errorMessage}`);
    }
  };
}

function splitMessage(text: string, maxLength: number): string[] {
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
