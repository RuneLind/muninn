import { test, expect, beforeEach } from "bun:test";
import {
  setPendingMessage,
  setPendingMessageIfAbsent,
  consumePendingMessage,
} from "./pending-messages.ts";

// Reset state between tests by consuming any leftover entries
beforeEach(() => {
  consumePendingMessage("test-thread-1");
  consumePendingMessage("test-thread-2");
});

test("consumePendingMessage returns stored text", () => {
  setPendingMessage("test-thread-1", "hello world");
  const result = consumePendingMessage("test-thread-1");
  expect(result).not.toBeNull();
  expect(result!.text).toBe("hello world");
});

test("consumePendingMessage returns null after consumed", () => {
  setPendingMessage("test-thread-1", "hello");
  consumePendingMessage("test-thread-1");
  expect(consumePendingMessage("test-thread-1")).toBeNull();
});

test("consumePendingMessage returns null for unknown thread", () => {
  expect(consumePendingMessage("nonexistent")).toBeNull();
});

test("setPendingMessage overwrites previous value", () => {
  setPendingMessage("test-thread-1", "first");
  setPendingMessage("test-thread-1", "second");
  const result = consumePendingMessage("test-thread-1");
  expect(result!.text).toBe("second");
});

test("separate threads are independent", () => {
  setPendingMessage("test-thread-1", "one");
  setPendingMessage("test-thread-2", "two");
  expect(consumePendingMessage("test-thread-1")!.text).toBe("one");
  expect(consumePendingMessage("test-thread-2")!.text).toBe("two");
});

test("setPendingMessage with meta preserves jiraContent and title", () => {
  setPendingMessage("test-thread-1", "prompt text", { jiraContent: "# PROJ-123\n\nDescription", title: "PROJ-123: Fix bug" });
  const result = consumePendingMessage("test-thread-1");
  expect(result).not.toBeNull();
  expect(result!.text).toBe("prompt text");
  expect(result!.jiraContent).toBe("# PROJ-123\n\nDescription");
  expect(result!.title).toBe("PROJ-123: Fix bug");
});

test("setPendingMessage without meta has undefined jiraContent/title", () => {
  setPendingMessage("test-thread-1", "plain text");
  const result = consumePendingMessage("test-thread-1");
  expect(result!.jiraContent).toBeUndefined();
  expect(result!.title).toBeUndefined();
});

test("setPendingMessageIfAbsent refuses to clobber a queued seed", () => {
  // The peek-then-write pair it replaces is a real TOCTOU for callers that target
  // an EXISTING thread: several awaits sit between the check and the write, and
  // `setPendingMessage` is last-write-wins — so a second escalation landing in
  // that window silently deletes a question nobody has opened yet.
  expect(setPendingMessageIfAbsent("test-thread-1", "first")).toBe(true);
  expect(setPendingMessageIfAbsent("test-thread-1", "second")).toBe(false);
  expect(consumePendingMessage("test-thread-1")!.text).toBe("first");
});

test("setPendingMessageIfAbsent writes again once the seed is consumed", () => {
  setPendingMessageIfAbsent("test-thread-1", "first");
  consumePendingMessage("test-thread-1");
  expect(setPendingMessageIfAbsent("test-thread-1", "second")).toBe(true);
  expect(consumePendingMessage("test-thread-1")!.text).toBe("second");
});

test("setPendingMessageIfAbsent carries its meta and leaves other threads alone", () => {
  setPendingMessageIfAbsent("test-thread-1", "one", { title: "a title" });
  expect(setPendingMessageIfAbsent("test-thread-2", "two")).toBe(true);
  expect(consumePendingMessage("test-thread-1")!.title).toBe("a title");
  expect(consumePendingMessage("test-thread-2")!.text).toBe("two");
});
