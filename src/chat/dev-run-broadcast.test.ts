import { test, expect, describe } from "bun:test";
import { ChatState, type ChatEvent } from "./state.ts";
import { broadcastDevRun, broadcastDevRunEvent } from "./dev-run-broadcast.ts";
import type { DevRun, DevRunHandoff, DevRunEvent } from "../db/dev-runs.ts";

function makeRun(over: Partial<DevRun> = {}): DevRun {
  return {
    id: "run-1", botName: "jarvis", userId: "u1", issueKey: "MELOSYS-1",
    status: "building", threadId: "t1", reengageCount: 0, createdAt: 1, updatedAt: 2, ...over,
  };
}

function makeEvent(over: Partial<DevRunEvent> = {}): DevRunEvent {
  return {
    id: "ev-1", runId: "run-1", peerName: "melosys-api", role: "build",
    kind: "discovery", text: "found it", createdAt: 7, ...over,
  };
}

describe("broadcastDevRun", () => {
  test("resolves a run by id + publishes a dev_run event to the run's conversation", async () => {
    const state = new ChatState();
    const events: ChatEvent[] = [];
    state.subscribe((e) => events.push(e));

    const run = makeRun();
    const handoffs: DevRunHandoff[] = [
      { id: "h1", runId: "run-1", peerName: "melosys-api", role: "build", status: "done", createdAt: 1, updatedAt: 2 },
    ];
    const ok = await broadcastDevRun(state, { runId: "run-1" }, {
      getRunById: async (id) => (id === "run-1" ? run : null),
      listHandoffs: async () => handoffs,
    });

    expect(ok).toBe(true);
    const ev = events.find((e) => e.type === "dev_run") as Extract<ChatEvent, { type: "dev_run" }>;
    expect(ev).toBeDefined();
    expect(ev.run.id).toBe("run-1");
    expect(ev.handoffs).toHaveLength(1);
    // The event addresses the deterministic conversation for (userId, botName).
    expect(ev.conversationId).toBe(await state.botConversationId("u1", "jarvis"));
  });

  test("resolves a run by threadId", async () => {
    const state = new ChatState();
    const events: ChatEvent[] = [];
    state.subscribe((e) => events.push(e));

    const run = makeRun({ threadId: "t9" });
    const ok = await broadcastDevRun(state, { threadId: "t9" }, {
      getRunByThreadId: async (tid) => (tid === "t9" ? run : null),
      listHandoffs: async () => [],
    });

    expect(ok).toBe(true);
    expect(events.some((e) => e.type === "dev_run")).toBe(true);
  });

  test("returns false (no event) when the run can't be resolved", async () => {
    const state = new ChatState();
    const events: ChatEvent[] = [];
    state.subscribe((e) => events.push(e));

    const ok = await broadcastDevRun(state, { runId: "missing" }, {
      getRunById: async () => null,
    });

    expect(ok).toBe(false);
    expect(events.some((e) => e.type === "dev_run")).toBe(false);
  });

  test("returns false (no throw) when a dependency throws", async () => {
    const state = new ChatState();
    const ok = await broadcastDevRun(state, { runId: "run-1" }, {
      getRunById: async () => { throw new Error("db down"); },
    });
    expect(ok).toBe(false);
  });
});

describe("broadcastDevRunEvent", () => {
  test("resolves the run by id + publishes a dev_run_event to the run's conversation", async () => {
    const state = new ChatState();
    const events: ChatEvent[] = [];
    state.subscribe((e) => events.push(e));

    const run = makeRun({ threadId: "t1" });
    const ok = await broadcastDevRunEvent(state, { runId: "run-1", event: makeEvent() }, {
      getRunById: async (id) => (id === "run-1" ? run : null),
    });

    expect(ok).toBe(true);
    const ev = events.find((e) => e.type === "dev_run_event") as Extract<ChatEvent, { type: "dev_run_event" }>;
    expect(ev).toBeDefined();
    expect(ev.runId).toBe("run-1");
    expect(ev.threadId).toBe("t1"); // carries the run's thread so the client can match the card
    expect(ev.event.kind).toBe("discovery");
    expect(ev.event.text).toBe("found it");
    expect(ev.conversationId).toBe(await state.botConversationId("u1", "jarvis"));
  });

  test("returns false (no event) when the run can't be resolved", async () => {
    const state = new ChatState();
    const events: ChatEvent[] = [];
    state.subscribe((e) => events.push(e));

    const ok = await broadcastDevRunEvent(state, { runId: "missing", event: makeEvent() }, {
      getRunById: async () => null,
    });
    expect(ok).toBe(false);
    expect(events.some((e) => e.type === "dev_run_event")).toBe(false);
  });

  test("returns false (no throw) when a dependency throws", async () => {
    const state = new ChatState();
    const ok = await broadcastDevRunEvent(state, { runId: "run-1", event: makeEvent() }, {
      getRunById: async () => { throw new Error("db down"); },
    });
    expect(ok).toBe(false);
  });
});
