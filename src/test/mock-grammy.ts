import { Bot } from "grammy";

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/**
 * Creates a Grammy bot with a transformer that captures all outgoing API calls
 * instead of hitting Telegram's API.
 */
export function createTestBot(): { bot: Bot; apiCalls: ApiCall[] } {
  const bot = new Bot("test:fake-token");
  const apiCalls: ApiCall[] = [];

  bot.api.config.use((prev, method, payload) => {
    apiCalls.push({ method, payload: { ...payload } as Record<string, unknown> });
    // Return a fake successful response
    return { ok: true, result: true } as any;
  });

  return { bot, apiCalls };
}

/**
 * Creates a fake Telegram Update object for a private text message.
 */
export function createFakeUpdate(text: string, opts: {
  userId?: number;
  username?: string;
  firstName?: string;
  chatId?: number;
  updateId?: number;
} = {}) {
  const userId = opts.userId ?? 12345;
  const chatId = opts.chatId ?? userId;
  return {
    update_id: opts.updateId ?? 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" as const, first_name: opts.firstName ?? "Test" },
      from: {
        id: userId,
        is_bot: false,
        first_name: opts.firstName ?? "Test",
        username: opts.username ?? "testuser",
      },
      text,
    },
  };
}

/**
 * Creates a fake Telegram Update for a command message.
 */
export function createFakeCommandUpdate(command: string, args: string, opts: {
  userId?: number;
  username?: string;
} = {}) {
  const text = args ? `/${command} ${args}` : `/${command}`;
  const update = createFakeUpdate(text, opts);
  // Grammy parses entities for commands
  (update.message as any).entities = [
    {
      type: "bot_command",
      offset: 0,
      length: command.length + 1,
    },
  ];
  return update;
}
