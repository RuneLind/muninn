import type { Context, NextFunction } from "grammy";
import { activityLog } from "../dashboard/activity-log.ts";

export function createAuthMiddleware(allowedUserIds: string[]) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id ? String(ctx.from.id) : undefined;

    if (!userId || !allowedUserIds.includes(userId)) {
      activityLog.push("error", `Unauthorized access attempt from user ${userId ?? "unknown"} (@${ctx.from?.username ?? "unknown"})`);
      await ctx.reply("Unauthorized.");
      return;
    }

    await next();
  };
}
