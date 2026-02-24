import { test, expect, describe, beforeEach, mock } from "bun:test";

// Mock ensureDefaultThread to avoid DB dependency
mock.module("../db/threads.ts", () => ({
  ensureDefaultThread: mock(async () => "mock-thread-id"),
}));

const { SimulatorState } = await import("./state.ts");

describe("SimulatorState.hydrateFromConfig", () => {
  let state: InstanceType<typeof SimulatorState>;

  beforeEach(() => {
    state = new SimulatorState();
  });

  test("creates conversations from config users", async () => {
    const count = await state.hydrateFromConfig([
      { id: "u1", name: "Alice", bot: "jarvis" },
      { id: "u2", name: "Bob", bot: "capra" },
    ]);

    expect(count).toBe(2);
    const convs = state.getConversations();
    expect(convs).toHaveLength(2);

    const alice = convs.find((c) => c.userId === "u1");
    expect(alice).toBeDefined();
    expect(alice!.botName).toBe("jarvis");
    expect(alice!.username).toBe("Alice");
    expect(alice!.type).toBe("web");
    expect(alice!.messages).toEqual([]);
  });

  test("generates deterministic IDs (stable across calls)", async () => {
    await state.hydrateFromConfig([{ id: "u1", name: "Alice", bot: "jarvis" }]);
    const firstConvs = state.getConversations();
    const firstId = firstConvs[0]!.id;

    // New instance, same config → same ID
    const state2 = new SimulatorState();
    await state2.hydrateFromConfig([{ id: "u1", name: "Alice", bot: "jarvis" }]);
    const secondId = state2.getConversations()[0]!.id;

    expect(firstId).toBe(secondId);
  });

  test("skips already-existing conversations (dedup)", async () => {
    await state.hydrateFromConfig([{ id: "u1", name: "Alice", bot: "jarvis" }]);
    expect(state.getConversations()).toHaveLength(1);

    // Call again with same user — should not duplicate
    const count = await state.hydrateFromConfig([{ id: "u1", name: "Alice", bot: "jarvis" }]);
    expect(count).toBe(0);
    expect(state.getConversations()).toHaveLength(1);
  });

  test("returns 0 for empty users array", async () => {
    const count = await state.hydrateFromConfig([]);
    expect(count).toBe(0);
    expect(state.getConversations()).toHaveLength(0);
  });

  test("different user+bot combos get different IDs", async () => {
    await state.hydrateFromConfig([
      { id: "u1", name: "Alice", bot: "jarvis" },
      { id: "u1", name: "Alice", bot: "capra" },
    ]);

    const convs = state.getConversations();
    expect(convs).toHaveLength(2);
    expect(convs[0]!.id).not.toBe(convs[1]!.id);
  });
});
