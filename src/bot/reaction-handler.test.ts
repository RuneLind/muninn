import { test, expect, describe, mock, beforeEach } from "bun:test";

// ── Mock the DB layer the handler depends on ──────────────────────────────
const mockGetMessageByTelegramId = mock(() =>
  Promise.resolve<{ id: string; userId: string; botName: string; platform: string | null } | null>({
    id: "msg-1", userId: "owner", botName: "testbot", platform: "telegram",
  }),
);
const mockUpsertFeedback = mock(() => Promise.resolve());
const mockDeleteFeedback = mock(() => Promise.resolve());

mock.module("../db/messages.ts", () => ({
  getMessageByTelegramId: mockGetMessageByTelegramId,
}));
mock.module("../db/message-feedback.ts", () => ({
  upsertFeedback: mockUpsertFeedback,
  deleteFeedback: mockDeleteFeedback,
}));

const { createReactionHandler, mapReactionEmojiToValue, firstMappableReaction } = await import("./reaction-handler.ts");

const config = {} as any;
const botConfig = { name: "testbot" } as any;

/** Build a minimal grammy-like ctx for a message_reaction update. */
function makeCtx(newReaction: any[], opts: { fromId?: number; chatId?: number; messageId?: number } = {}) {
  const reaction = {
    chat: { id: opts.chatId ?? 100 },
    message_id: opts.messageId ?? 42,
    new_reaction: newReaction,
    old_reaction: [],
  };
  return {
    messageReaction: reaction,
    from: opts.fromId === null ? undefined : { id: opts.fromId ?? 7 },
  } as any;
}

const emoji = (e: string) => ({ type: "emoji", emoji: e });

describe("mapReactionEmojiToValue", () => {
  test("positive emojis map to +1", () => {
    for (const e of ["👍", "❤️", "❤", "🔥", "👏", "💯"]) {
      expect(mapReactionEmojiToValue(e)).toBe(1);
    }
  });
  test("negative emojis map to -1", () => {
    for (const e of ["👎", "💩", "🤮"]) {
      expect(mapReactionEmojiToValue(e)).toBe(-1);
    }
  });
  test("unknown emoji maps to null", () => {
    expect(mapReactionEmojiToValue("🎉")).toBeNull();
    expect(mapReactionEmojiToValue("🤔")).toBeNull();
  });
});

describe("firstMappableReaction", () => {
  test("skips unmapped emoji and returns the first mappable one", () => {
    expect(firstMappableReaction([emoji("🎉"), emoji("👍")] as any)).toEqual({ emoji: "👍", value: 1 });
  });
  test("skips custom reactions and returns the first mappable emoji", () => {
    expect(firstMappableReaction([{ type: "custom_emoji", custom_emoji_id: "x" }, emoji("👎")] as any)).toEqual({ emoji: "👎", value: -1 });
  });
  test("returns null when only custom/paid reactions present", () => {
    expect(firstMappableReaction([{ type: "custom_emoji", custom_emoji_id: "x" }, { type: "paid" }] as any)).toBeNull();
  });
  test("returns null when only unmapped emojis present", () => {
    expect(firstMappableReaction([emoji("🎉"), emoji("🤔")] as any)).toBeNull();
  });
});

describe("createReactionHandler", () => {
  const handler = createReactionHandler(config, botConfig);

  beforeEach(() => {
    mockGetMessageByTelegramId.mockClear();
    mockUpsertFeedback.mockClear();
    mockDeleteFeedback.mockClear();
    mockGetMessageByTelegramId.mockResolvedValue({ id: "msg-1", userId: "owner", botName: "testbot", platform: "telegram" });
  });

  test("positive reaction upserts +1 with the raw emoji", async () => {
    await handler(makeCtx([emoji("👍")]));
    expect(mockUpsertFeedback).toHaveBeenCalledTimes(1);
    const arg = (mockUpsertFeedback.mock.calls[0] as any[])[0];
    expect(arg.messageId).toBe("msg-1");
    expect(arg.userId).toBe("7");
    expect(arg.value).toBe(1);
    expect(arg.raw).toBe("👍");
    expect(arg.source).toBe("telegram_reaction");
  });

  test("negative reaction upserts -1", async () => {
    await handler(makeCtx([emoji("👎")]));
    const arg = (mockUpsertFeedback.mock.calls[0] as any[])[0];
    expect(arg.value).toBe(-1);
  });

  test("unknown emoji clears any existing vote (no upsert, delete instead)", async () => {
    // Changing 👍 → 🎉 arrives as new_reaction=[🎉]: the recorded +1 is stale.
    await handler(makeCtx([emoji("🎉")]));
    expect(mockUpsertFeedback).not.toHaveBeenCalled();
    expect(mockDeleteFeedback).toHaveBeenCalledTimes(1);
    const args = mockDeleteFeedback.mock.calls[0] as any[];
    expect(args[0]).toBe("msg-1");
    expect(args[1]).toBe("7");
    expect(args[2]).toBe("telegram_reaction");
  });

  test("changing back from unknown to a mapped emoji upserts again", async () => {
    // 🎉 → 👍 arrives as new_reaction=[👍]: record +1.
    await handler(makeCtx([emoji("👍")]));
    expect(mockUpsertFeedback).toHaveBeenCalledTimes(1);
    expect(mockDeleteFeedback).not.toHaveBeenCalled();
  });

  test("mixed [unknown, mapped] records the mapped emoji, not ignored", async () => {
    await handler(makeCtx([emoji("🎉"), emoji("👍")]));
    expect(mockUpsertFeedback).toHaveBeenCalledTimes(1);
    const arg = (mockUpsertFeedback.mock.calls[0] as any[])[0];
    expect(arg.value).toBe(1);
    expect(arg.raw).toBe("👍");
    expect(mockDeleteFeedback).not.toHaveBeenCalled();
  });

  test("empty new_reaction (retraction) deletes the feedback row", async () => {
    await handler(makeCtx([]));
    expect(mockDeleteFeedback).toHaveBeenCalledTimes(1);
    const args = mockDeleteFeedback.mock.calls[0] as any[];
    expect(args[0]).toBe("msg-1");
    expect(args[1]).toBe("7");
    expect(args[2]).toBe("telegram_reaction");
    expect(mockUpsertFeedback).not.toHaveBeenCalled();
  });

  test("custom-emoji-only reaction clears any existing vote", async () => {
    await handler(makeCtx([{ type: "custom_emoji", custom_emoji_id: "abc" }]));
    expect(mockUpsertFeedback).not.toHaveBeenCalled();
    expect(mockDeleteFeedback).toHaveBeenCalledTimes(1);
  });

  test("reaction on an untracked message does nothing", async () => {
    mockGetMessageByTelegramId.mockResolvedValue(null);
    await handler(makeCtx([emoji("👍")]));
    expect(mockUpsertFeedback).not.toHaveBeenCalled();
    expect(mockDeleteFeedback).not.toHaveBeenCalled();
  });

  test("anonymous reaction (no from) is ignored", async () => {
    await handler(makeCtx([emoji("👍")], { fromId: null as any }));
    expect(mockGetMessageByTelegramId).not.toHaveBeenCalled();
    expect(mockUpsertFeedback).not.toHaveBeenCalled();
  });
});
