import type { Context, NextFunction } from "grammy";
import { activityLog } from "../observability/activity-log.ts";

export function createAuthMiddleware(allowedUserIds: string[]) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id ? String(ctx.from.id) : undefined;

    if (!userId || !allowedUserIds.includes(userId)) {
      // A reaction is not a conversation turn — you can't meaningfully reply to
      // it, and in group chats non-allowlisted members can react to bot messages.
      // Drop silently instead of spamming "Unauthorized." into the chat.
      if (ctx.messageReaction) return;
      activityLog.push("error", `Unauthorized access attempt from user ${userId ?? "unknown"} (@${ctx.from?.username ?? "unknown"})`);
      await ctx.reply("Unauthorized.");
      return;
    }

    await next();
  };
}
