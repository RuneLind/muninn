import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeMessage } from "../test/fixtures.ts";
import {
  saveMessage,
  setTelegramMessageId,
  getMessageByTelegramId,
  getMessageById,
} from "./messages.ts";
import {
  upsertFeedback,
  deleteFeedback,
  getFeedback,
  getFeedbackForMessage,
} from "./message-feedback.ts";
import { getDb } from "./client.ts";

setupTestDb();

describe("message-feedback", () => {
  test("upsertFeedback inserts a new row", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant", content: "hi" }));
    await upsertFeedback({
      messageId, userId: "user-1", botName: "testbot", platform: "web", source: "web", value: 1,
    });
    const fb = await getFeedback(messageId, "user-1", "web");
    expect(fb).not.toBeNull();
    expect(fb!.value).toBe(1);
    expect(fb!.source).toBe("web");
    expect(fb!.botName).toBe("testbot");
  });

  test("upsertFeedback overwrites value + raw on repeat (idempotent per key)", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant" }));
    await upsertFeedback({ messageId, userId: "u", source: "telegram_reaction", value: 1, raw: "👍" });
    await upsertFeedback({ messageId, userId: "u", source: "telegram_reaction", value: -1, raw: "👎" });

    const rows = await getFeedbackForMessage(messageId);
    expect(rows).toHaveLength(1); // upsert, not a second row
    expect(rows[0]!.value).toBe(-1);
    expect(rows[0]!.raw).toBe("👎");
  });

  test("same message, different source/user are distinct rows", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant" }));
    await upsertFeedback({ messageId, userId: "u1", source: "web", value: 1 });
    await upsertFeedback({ messageId, userId: "u1", source: "telegram_reaction", value: -1, raw: "👎" });
    await upsertFeedback({ messageId, userId: "u2", source: "web", value: 1 });

    const rows = await getFeedbackForMessage(messageId);
    expect(rows).toHaveLength(3);
  });

  test("deleteFeedback removes a row (reaction retraction / web clear)", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant" }));
    await upsertFeedback({ messageId, userId: "u", source: "telegram_reaction", value: 1, raw: "👍" });
    await deleteFeedback(messageId, "u", "telegram_reaction");
    expect(await getFeedback(messageId, "u", "telegram_reaction")).toBeNull();
  });

  test("deleteFeedback is a no-op when absent", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant" }));
    await deleteFeedback(messageId, "nobody", "web"); // must not throw
    expect(await getFeedback(messageId, "nobody", "web")).toBeNull();
  });

  test("value CHECK rejects 0 / out-of-range", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant" }));
    const sql = getDb();
    let threw = false;
    try {
      await sql`
        INSERT INTO message_feedback (message_id, user_id, source, value)
        VALUES (${messageId}, ${"u"}, ${"web"}, ${0})
      `;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("deleting the message cascades feedback rows away", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant" }));
    await upsertFeedback({ messageId, userId: "u", source: "web", value: 1 });
    const sql = getDb();
    await sql`DELETE FROM messages WHERE id = ${messageId}`;
    const rows = await getFeedbackForMessage(messageId);
    expect(rows).toHaveLength(0);
  });

  test("setTelegramMessageId + getMessageByTelegramId round-trip", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant", botName: "tgbot", platform: "telegram" }));
    await setTelegramMessageId(messageId, 555, 42);

    const owner = await getMessageByTelegramId(555, 42);
    expect(owner).not.toBeNull();
    expect(owner!.id).toBe(messageId);
    expect(owner!.botName).toBe("tgbot");
    expect(owner!.platform).toBe("telegram");
  });

  test("getMessageByTelegramId returns null for an untracked (chat, message)", async () => {
    expect(await getMessageByTelegramId(999, 999)).toBeNull();
  });

  test("getMessageById returns owner identity", async () => {
    const messageId = await saveMessage(makeMessage({ role: "assistant", userId: "owner-x", botName: "b", platform: "web" }));
    const owner = await getMessageById(messageId);
    expect(owner!.userId).toBe("owner-x");
    expect(owner!.platform).toBe("web");
  });
});
