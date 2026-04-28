import { test, expect, describe, beforeEach } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "../db/client.ts";
import { setBotDefaultUser } from "../db/chat-preferences.ts";
import { getOrCreatePeerThread } from "../db/threads.ts";
import { saveMessage } from "../db/messages.ts";
import { checkAutoRespond } from "./loop-guard.ts";

setupTestDb();

const BOT = "loop-guard-bot";
const OWNER = "loop-guard-owner";

async function freshPeerThreadId(peerName: string): Promise<string> {
  await setBotDefaultUser(BOT, OWNER);
  const thread = await getOrCreatePeerThread(OWNER, BOT, peerName);
  // Tests reuse the same DB; clear assistant messages from prior tests
  // so the rolling-hour count starts at zero.
  const sql = getDb();
  await sql`DELETE FROM messages WHERE thread_id = ${thread.id}`;
  return thread.id;
}

describe("checkAutoRespond", () => {
  beforeEach(async () => {
    await setBotDefaultUser(BOT, OWNER);
  });

  test("blocks when alreadyPaused is true", async () => {
    const threadId = await freshPeerThreadId("paused-peer");
    const decision = await checkAutoRespond({
      threadId,
      alreadyPaused: true,
      maxTurnsPerHour: 20,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.capHit).toBeFalsy();
    expect(decision.reason).toBe("thread is paused");
  });

  test("allows when no recent assistant messages and not paused", async () => {
    const threadId = await freshPeerThreadId("fresh-peer");
    const decision = await checkAutoRespond({
      threadId,
      alreadyPaused: false,
      maxTurnsPerHour: 20,
    });
    expect(decision.allowed).toBe(true);
  });

  test("blocks with capHit=true when assistant turns in last hour reach the cap", async () => {
    const threadId = await freshPeerThreadId("loud-peer");
    // Cap of 3 — insert 3 assistant messages, all within the last hour
    for (let i = 0; i < 3; i++) {
      await saveMessage({
        userId: OWNER, botName: BOT, role: "assistant", content: `turn ${i}`,
        platform: "web", threadId,
      });
    }
    const decision = await checkAutoRespond({
      threadId,
      alreadyPaused: false,
      maxTurnsPerHour: 3,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.capHit).toBe(true);
    expect(decision.reason).toBe("3-turn/hour cap");
  });

  test("ignores assistant messages older than 1 hour", async () => {
    const threadId = await freshPeerThreadId("old-peer");
    // Insert messages and back-date their created_at past the hour boundary
    for (let i = 0; i < 5; i++) {
      await saveMessage({
        userId: OWNER, botName: BOT, role: "assistant", content: `old turn ${i}`,
        platform: "web", threadId,
      });
    }
    const sql = getDb();
    await sql`UPDATE messages SET created_at = now() - interval '2 hours' WHERE thread_id = ${threadId}`;

    const decision = await checkAutoRespond({
      threadId,
      alreadyPaused: false,
      maxTurnsPerHour: 3,
    });
    expect(decision.allowed).toBe(true);
  });

  test("ignores non-assistant rows when counting turns", async () => {
    const threadId = await freshPeerThreadId("mixed-peer");
    // Lots of peer + user rows in the last hour shouldn't trip the cap
    for (let i = 0; i < 5; i++) {
      await saveMessage({
        userId: OWNER, botName: BOT, role: "peer", content: `peer ${i}`,
        platform: "web", threadId, fromPeerId: "peer-x",
      });
      await saveMessage({
        userId: OWNER, botName: BOT, role: "user", content: `user ${i}`,
        platform: "web", threadId,
      });
    }
    const decision = await checkAutoRespond({
      threadId,
      alreadyPaused: false,
      maxTurnsPerHour: 3,
    });
    expect(decision.allowed).toBe(true);
  });
});
