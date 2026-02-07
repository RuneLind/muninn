import type { Context, NextFunction } from "grammy";
import type { Config } from "../config.ts";
import { activityLog } from "../dashboard/activity-log.ts";

export function createAuthMiddleware(config: Config) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;

    if (!userId || !config.allowedUserIds.includes(userId)) {
      activityLog.push("error", `Unauthorized access attempt from user ${userId ?? "unknown"} (@${ctx.from?.username ?? "unknown"})`);
      await ctx.reply("Unauthorized.");
      return;
    }

    await next();
  };
}
