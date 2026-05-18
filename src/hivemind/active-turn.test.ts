import { test, expect, describe, beforeEach } from "bun:test";
import {
  pushActiveTurn,
  popActiveTurn,
  peekActiveTurn,
  _resetActiveTurnsForTests,
} from "./active-turn.ts";

describe("active-turn registry", () => {
  beforeEach(() => _resetActiveTurnsForTests());

  test("peek returns null when nothing is pushed", () => {
    expect(peekActiveTurn("jarvis")).toBeNull();
  });

  test("push then peek returns the threadId", () => {
    pushActiveTurn("jarvis", "thread-1");
    expect(peekActiveTurn("jarvis")).toBe("thread-1");
  });

  test("peek returns the most recent push (LIFO)", () => {
    pushActiveTurn("jarvis", "thread-1");
    pushActiveTurn("jarvis", "thread-2");
    expect(peekActiveTurn("jarvis")).toBe("thread-2");
  });

  test("pop removes the matching entry; peek falls back to previous", () => {
    pushActiveTurn("jarvis", "thread-1");
    pushActiveTurn("jarvis", "thread-2");
    popActiveTurn("jarvis", "thread-2");
    expect(peekActiveTurn("jarvis")).toBe("thread-1");
    popActiveTurn("jarvis", "thread-1");
    expect(peekActiveTurn("jarvis")).toBeNull();
  });

  test("pop tolerates mismatched ordering (inner turn ends after outer)", () => {
    pushActiveTurn("jarvis", "outer");
    pushActiveTurn("jarvis", "inner");
    popActiveTurn("jarvis", "outer"); // outer pops before inner
    expect(peekActiveTurn("jarvis")).toBe("inner");
    popActiveTurn("jarvis", "inner");
    expect(peekActiveTurn("jarvis")).toBeNull();
  });

  test("pop of unknown threadId is a no-op", () => {
    pushActiveTurn("jarvis", "thread-1");
    popActiveTurn("jarvis", "does-not-exist");
    expect(peekActiveTurn("jarvis")).toBe("thread-1");
  });

  test("different bots are independent", () => {
    pushActiveTurn("jarvis", "j-thread");
    pushActiveTurn("melosys", "m-thread");
    expect(peekActiveTurn("jarvis")).toBe("j-thread");
    expect(peekActiveTurn("melosys")).toBe("m-thread");
    popActiveTurn("jarvis", "j-thread");
    expect(peekActiveTurn("jarvis")).toBeNull();
    expect(peekActiveTurn("melosys")).toBe("m-thread");
  });
});
