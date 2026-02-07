import { Bot } from "grammy";
import type { Config } from "../config.ts";
import { createAuthMiddleware } from "./middleware.ts";
import { createMessageHandler } from "./handler.ts";

export function createBot(config: Config): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(createAuthMiddleware(config));

  bot.command("start", async (ctx) => {
    await ctx.reply("Jarvis online. How can I help you?");
  });

  bot.on("message:text", createMessageHandler(config));

  bot.catch((err) => {
    console.error("Bot error:", err.message);
  });

  return bot;
}
