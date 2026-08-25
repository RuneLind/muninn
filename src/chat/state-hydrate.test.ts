/**
 * Hydration order — its own file because it needs `mock.module`.
 *
 * Per the repo's `mock.module` rule (CLAUDE.md): mocking a module invalidates it
 * for the whole `bun test` process graph, so any other already-loaded file that
 * transitively imports `db/messages.ts` would fail export resolution. This file
 * therefore gets its OWN `&& bun test <file>` link in the `test` / `test:unit`
 * chains, and the placement is load-bearing — it is invisible from the file
 * itself, which is why it is written down here.
 */
import { test, expect, describe, mock } from "bun:test";

/** Newest first — exactly what `ORDER BY sub.created_at DESC` returns. */
const NEWEST_FIRST = Array.from({ length: 60 }, (_, i) => ({
  userId: `u${i}`,
  botName: "jarvis",
  platform: "web",
  username: `u${i}`,
}));

mock.module("../db/messages.ts", () => ({
  getSimConversations: async () => NEWEST_FIRST,
  getSimMessages: async () => [
    { id: "m", createdAt: 1, role: "user", content: "hei", threadId: null, fromPeerId: null, model: null },
  ],
}));

const { ChatState, MAX_CONVERSATIONS } = await import("./state.ts");

describe("hydrateFromDb", () => {
  test("keeps the MOST recently active conversations, not the stalest", async () => {
    // The Map's ordering contract is LRU-first: `touch()` re-inserts at the tail,
    // so the front is the least-recently-used end and that is what the message
    // trim reclaims. `getSimConversations` returns NEWEST first, so inserting its
    // rows verbatim inverts the contract — and the trim then blanks the busiest
    // conversations and keeps the ones nobody has touched since March.
    const state = new ChatState();
    await state.hydrateFromDb();

    const kept = state.getConversations().filter((c) => c.messages.length > 0).map((c) => c.userId);
    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(kept).toContain("u0");   // newest row in the listing
    expect(kept).toContain("u2");
    expect(kept).not.toContain("u59"); // stalest
    expect(kept).not.toContain("u57");
  });

  test("every hydrated shell survives — only message arrays are reclaimed", async () => {
    const state = new ChatState();
    await state.hydrateFromDb();
    expect(state.getConversations()).toHaveLength(NEWEST_FIRST.length);
  });
});
