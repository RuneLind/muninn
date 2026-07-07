import { test, expect, describe, beforeEach } from "bun:test";
import { createTestBot, createFakeUpdate } from "../test/mock-grammy.ts";
import { createAuthMiddleware } from "./middleware.ts";

describe("auth middleware", () => {
  test("allows authorized user through", async () => {
    const { bot, apiCalls } = createTestBot();
    const middleware = createAuthMiddleware(["12345"]);
    let nextCalled = false;

    bot.use(middleware);
    bot.on("message", () => {
      nextCalled = true;
    });
    await bot.init();

    await bot.handleUpdate(createFakeUpdate("hello", { userId: 12345 }));
    expect(nextCalled).toBe(true);
  });

  test("blocks unauthorized user", async () => {
    const { bot, apiCalls } = createTestBot();
    const middleware = createAuthMiddleware(["12345"]);
    let nextCalled = false;

    bot.use(middleware);
    bot.on("message", () => {
      nextCalled = true;
    });
    await bot.init();

    await bot.handleUpdate(createFakeUpdate("hello", { userId: 99999 }));
    expect(nextCalled).toBe(false);

    // Should have sent "Unauthorized." reply
    const sendMessage = apiCalls.find((c) => c.method === "sendMessage");
    expect(sendMessage).toBeTruthy();
    expect(sendMessage!.payload.text).toBe("Unauthorized.");
  });

  test("allows multiple authorized users", async () => {
    const { bot } = createTestBot();
    const middleware = createAuthMiddleware(["111", "222", "333"]);
    const calledBy: string[] = [];

    bot.use(middleware);
    bot.on("message", (ctx) => {
      calledBy.push(String(ctx.from!.id));
    });
    await bot.init();

    await bot.handleUpdate(createFakeUpdate("hello", { userId: 222 }));
    expect(calledBy).toContain("222");
  });

  test("silently ignores unauthorized message_reaction (no Unauthorized reply)", async () => {
    const { bot, apiCalls } = createTestBot();
    const middleware = createAuthMiddleware(["12345"]);
    let nextCalled = false;

    bot.use(middleware);
    bot.on("message_reaction", () => {
      nextCalled = true;
    });
    await bot.init();

    const update = {
      update_id: 1,
      message_reaction: {
        chat: { id: 123, type: "group" as const, title: "Test group" },
        message_id: 42,
        user: { id: 99999, is_bot: false, first_name: "Stranger" },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [],
        new_reaction: [{ type: "emoji" as const, emoji: "👍" }],
      },
    };
    await bot.handleUpdate(update as any);

    expect(nextCalled).toBe(false);
    // Crucially: no "Unauthorized." reply was sent into the chat
    const sendMessage = apiCalls.find((c) => c.method === "sendMessage");
    expect(sendMessage).toBeFalsy();
  });

  test("blocks when no from id", async () => {
    const { bot, apiCalls } = createTestBot();
    const middleware = createAuthMiddleware(["12345"]);
    let nextCalled = false;

    bot.use(middleware);
    bot.on("message", () => {
      nextCalled = true;
    });
    await bot.init();

    // Create update without from
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" as const, first_name: "Test" },
        text: "hello",
      },
    };
    await bot.handleUpdate(update as any);
    expect(nextCalled).toBe(false);
  });
});
