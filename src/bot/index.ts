import { Bot } from "grammy";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { createAuthMiddleware } from "./middleware.ts";
import { createMessageHandler } from "./handler.ts";
import { createVoiceHandler } from "./voice-handler.ts";
import { registerWatcherCommands } from "./watcher-commands.ts";

export function createBot(config: Config, botConfig: BotConfig): Bot {
  const bot = new Bot(botConfig.telegramBotToken!);

  bot.use(createAuthMiddleware(botConfig.telegramAllowedUserIds));

  bot.command("start", async (ctx) => {
    await ctx.reply(`${botConfig.name} online. How can I help you?`);
  });

  registerWatcherCommands(bot, botConfig);

  bot.on("message:text", createMessageHandler(config, botConfig));
  bot.on("message:voice", createVoiceHandler(config, botConfig));

  bot.catch((err) => {
    console.error(`[${botConfig.name}] Bot error:`, err.message);
  });

  return bot;
}
