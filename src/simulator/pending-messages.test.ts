import { test, expect, beforeEach } from "bun:test";
import { setPendingMessage, consumePendingMessage } from "./pending-messages.ts";

// Reset state between tests by consuming any leftover entries
beforeEach(() => {
  // Consume known test keys to ensure clean state
  consumePendingMessage("test-thread-1");
  consumePendingMessage("test-thread-2");
});

test("consumePendingMessage returns stored text", () => {
  setPendingMessage("test-thread-1", "hello world");
  expect(consumePendingMessage("test-thread-1")).toBe("hello world");
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
  expect(consumePendingMessage("test-thread-1")).toBe("second");
});

test("separate threads are independent", () => {
  setPendingMessage("test-thread-1", "one");
  setPendingMessage("test-thread-2", "two");
  expect(consumePendingMessage("test-thread-1")).toBe("one");
  expect(consumePendingMessage("test-thread-2")).toBe("two");
});
