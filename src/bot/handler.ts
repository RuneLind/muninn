import type { Context } from "grammy";
import type { Config } from "../config.ts";
import { executeClaudePrompt } from "../ai/executor.ts";
import { activityLog } from "../dashboard/activity-log.ts";

export function createMessageHandler(config: Config) {
  return async (ctx: Context) => {
    const text = ctx.message?.text;
    if (!text) return;

    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const userId = ctx.from?.id;

    activityLog.push("message_in", text, { userId, username });

    // Keep typing indicator alive while Claude processes
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);

    // Send initial typing
    await ctx.replyWithChatAction("typing").catch(() => {});

    try {
      const result = await executeClaudePrompt(text, config);

      clearInterval(typingInterval);

      activityLog.push("message_out", result.result, {
        userId,
        username,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      });

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
