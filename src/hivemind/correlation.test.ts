import { test, expect, describe, beforeEach } from "bun:test";
import {
  setPendingPeer,
  getPendingPeer,
  clearPendingPeer,
  _resetPendingPeersForTests,
} from "./correlation.ts";

describe("peer-correlation map", () => {
  beforeEach(() => _resetPendingPeersForTests());

  test("get returns null when nothing is set", () => {
    expect(getPendingPeer("jarvis", "peer-huginn")).toBeNull();
  });

  test("set then get returns the threadId", () => {
    setPendingPeer("jarvis", "peer-huginn", "thread-jira-1234");
    expect(getPendingPeer("jarvis", "peer-huginn")).toBe("thread-jira-1234");
  });

  test("last write wins for the same (bot, peer) key", () => {
    setPendingPeer("jarvis", "peer-huginn", "thread-1");
    setPendingPeer("jarvis", "peer-huginn", "thread-2");
    expect(getPendingPeer("jarvis", "peer-huginn")).toBe("thread-2");
  });

  test("entries expire after TTL", () => {
    setPendingPeer("jarvis", "peer-huginn", "thread-1", 1); // 1ms TTL
    // Wait past the TTL — Date.now() resolves on the next event-loop tick.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(getPendingPeer("jarvis", "peer-huginn")).toBeNull();
        resolve();
      }, 10);
    });
  });

  test("get does not consume the entry (follow-ups still route)", () => {
    setPendingPeer("jarvis", "peer-huginn", "thread-1");
    expect(getPendingPeer("jarvis", "peer-huginn")).toBe("thread-1");
    expect(getPendingPeer("jarvis", "peer-huginn")).toBe("thread-1");
  });

  test("different (bot, peer) keys are independent", () => {
    setPendingPeer("jarvis", "peer-huginn", "j-thread");
    setPendingPeer("melosys", "peer-huginn", "m-thread");
    setPendingPeer("jarvis", "peer-yggdrasil", "j-other");
    expect(getPendingPeer("jarvis", "peer-huginn")).toBe("j-thread");
    expect(getPendingPeer("melosys", "peer-huginn")).toBe("m-thread");
    expect(getPendingPeer("jarvis", "peer-yggdrasil")).toBe("j-other");
  });

  test("clear removes the entry", () => {
    setPendingPeer("jarvis", "peer-huginn", "thread-1");
    clearPendingPeer("jarvis", "peer-huginn");
    expect(getPendingPeer("jarvis", "peer-huginn")).toBeNull();
  });
});
