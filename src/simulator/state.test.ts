import { test, expect, describe, beforeEach } from "bun:test";
import { SimulatorState, MAX_CONVERSATIONS, type SimEvent, type SimMessage } from "./state.ts";

describe("SimulatorState", () => {
  let state: SimulatorState;

  beforeEach(() => {
    state = new SimulatorState();
  });

  describe("createConversation", () => {
    test("creates conversation with correct fields", () => {
      const conv = state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      expect(conv.id).toBeDefined();
      expect(conv.type).toBe("telegram_dm");
      expect(conv.botName).toBe("jarvis");
      expect(conv.userId).toBe("123");
      expect(conv.username).toBe("testuser");
      expect(conv.messages).toEqual([]);
      expect(conv.channelName).toBeUndefined();
    });

    test("sets channelName when provided", () => {
      const conv = state.createConversation({
        type: "slack_channel",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
        channelName: "#general",
      });

      expect(conv.channelName).toBe("#general");
    });

    test("prunes oldest when MAX_CONVERSATIONS exceeded", () => {
      const ids: string[] = [];
      for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
        const conv = state.createConversation({
          type: "telegram_dm",
          botName: "jarvis",
          userId: String(i),
          username: `user${i}`,
        });
        ids.push(conv.id);
      }

      expect(state.getConversations().length).toBe(MAX_CONVERSATIONS);
      // First 5 should have been pruned
      expect(state.getConversation(ids[0]!)).toBeUndefined();
      expect(state.getConversation(ids[4]!)).toBeUndefined();
      // Last ones should exist
      expect(state.getConversation(ids[ids.length - 1]!)).toBeDefined();
    });
  });

  describe("addMessage", () => {
    test("adds message to conversation", () => {
      const conv = state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      const msg: SimMessage = {
        id: "msg-1",
        timestamp: Date.now(),
        sender: "user",
        text: "hello",
      };
      state.addMessage(conv.id, msg);

      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0]!.text).toBe("hello");
    });

    test("ignores message for non-existent conversation", () => {
      const msg: SimMessage = {
        id: "msg-1",
        timestamp: Date.now(),
        sender: "user",
        text: "hello",
      };
      // Should not throw
      state.addMessage("nonexistent-id", msg);
    });
  });

  describe("subscribe/publish", () => {
    test("subscriber receives events", () => {
      const events: SimEvent[] = [];
      state.subscribe((event) => events.push(event));

      state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("conversation_created");
    });

    test("unsubscribe stops events", () => {
      const events: SimEvent[] = [];
      const unsub = state.subscribe((event) => events.push(event));

      state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "1",
        username: "user1",
      });

      unsub();

      state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "2",
        username: "user2",
      });

      expect(events).toHaveLength(1);
    });

    test("subscriber error does not affect other subscribers", () => {
      const events: SimEvent[] = [];

      // Bad subscriber that throws
      state.subscribe(() => {
        throw new Error("boom");
      });

      // Good subscriber
      state.subscribe((event) => events.push(event));

      state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      expect(events).toHaveLength(1);
    });
  });

  describe("findOrCreateChannel", () => {
    test("creates new channel conversation", () => {
      const conv = state.findOrCreateChannel("jarvis", "#general", "123", "testuser");
      expect(conv.type).toBe("slack_channel");
      expect(conv.channelName).toBe("#general");
      expect(conv.botName).toBe("jarvis");
    });

    test("returns existing channel conversation", () => {
      const first = state.findOrCreateChannel("jarvis", "#general", "123", "testuser");
      const second = state.findOrCreateChannel("jarvis", "#general", "456", "other");
      expect(first.id).toBe(second.id);
    });

    test("separates channels by name", () => {
      const general = state.findOrCreateChannel("jarvis", "#general", "123", "testuser");
      const random = state.findOrCreateChannel("jarvis", "#random", "123", "testuser");
      expect(general.id).not.toBe(random.id);
    });

    test("separates channels by bot", () => {
      const jarvisGeneral = state.findOrCreateChannel("jarvis", "#general", "123", "testuser");
      const otherBotGeneral = state.findOrCreateChannel("jira-assistant", "#general", "123", "testuser");
      expect(jarvisGeneral.id).not.toBe(otherBotGeneral.id);
    });
  });

  describe("deleteConversation", () => {
    test("removes conversation", () => {
      const conv = state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      expect(state.deleteConversation(conv.id)).toBe(true);
      expect(state.getConversation(conv.id)).toBeUndefined();
    });

    test("returns false for missing conversation", () => {
      expect(state.deleteConversation("nonexistent")).toBe(false);
    });
  });

  describe("clear", () => {
    test("empties all conversations", () => {
      state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "1",
        username: "user1",
      });
      state.createConversation({
        type: "slack_dm",
        botName: "jarvis",
        userId: "2",
        username: "user2",
      });

      state.clear();
      expect(state.getConversations()).toEqual([]);
    });
  });

  describe("publishTextDelta", () => {
    test("broadcasts text_delta to subscribers without mutating state", () => {
      const conv = state.createConversation({
        type: "web",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      const events: SimEvent[] = [];
      state.subscribe((event) => events.push(event));

      state.publishTextDelta(conv.id, "Hello ", "thread-1");

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("text_delta");
      const delta = events[0] as Extract<SimEvent, { type: "text_delta" }>;
      expect(delta.conversationId).toBe(conv.id);
      expect(delta.delta).toBe("Hello ");
      expect(delta.threadId).toBe("thread-1");

      // No state mutation — messages unchanged
      expect(conv.messages).toHaveLength(0);
    });

    test("broadcasts multiple deltas", () => {
      const conv = state.createConversation({
        type: "web",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      const events: SimEvent[] = [];
      state.subscribe((event) => events.push(event));

      state.publishTextDelta(conv.id, "Hello ");
      state.publishTextDelta(conv.id, "world");

      expect(events).toHaveLength(2);
      expect((events[0] as any).delta).toBe("Hello ");
      expect((events[1] as any).delta).toBe("world");
    });
  });

  describe("publishStreamClear", () => {
    test("broadcasts stream_clear event", () => {
      const conv = state.createConversation({
        type: "web",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      const events: SimEvent[] = [];
      state.subscribe((event) => events.push(event));

      state.publishStreamClear(conv.id);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("stream_clear");
      expect((events[0] as Extract<SimEvent, { type: "stream_clear" }>).conversationId).toBe(conv.id);
    });

    test("broadcasts stream_clear with threadId", () => {
      const conv = state.createConversation({
        type: "web",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      const events: SimEvent[] = [];
      state.subscribe((event) => events.push(event));

      state.publishStreamClear(conv.id, "thread-42");

      expect(events).toHaveLength(1);
      const event = events[0] as Extract<SimEvent, { type: "stream_clear" }>;
      expect(event.conversationId).toBe(conv.id);
      expect(event.threadId).toBe("thread-42");
    });

    test("broadcasts stream_clear with null threadId", () => {
      const conv = state.createConversation({
        type: "web",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      const events: SimEvent[] = [];
      state.subscribe((event) => events.push(event));

      state.publishStreamClear(conv.id, null);

      expect(events).toHaveLength(1);
      const event = events[0] as Extract<SimEvent, { type: "stream_clear" }>;
      expect(event.threadId).toBeNull();
    });
  });

  describe("setStatus", () => {
    test("updates status and publishes event", () => {
      const conv = state.createConversation({
        type: "telegram_dm",
        botName: "jarvis",
        userId: "123",
        username: "testuser",
      });

      const events: SimEvent[] = [];
      state.subscribe((event) => events.push(event));

      state.setStatus(conv.id, "Thinking...");

      expect(conv.status).toBe("Thinking...");
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("status");
    });
  });
});
