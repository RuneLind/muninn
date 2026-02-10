import { test, expect, describe } from "bun:test";
import { splitMessage } from "./handler.ts";

describe("splitMessage", () => {
  test("returns single chunk for short text", () => {
    const chunks = splitMessage("hello world", 100);
    expect(chunks).toEqual(["hello world"]);
  });

  test("splits at newline boundary", () => {
    const text = "line one\nline two\nline three\nline four";
    const chunks = splitMessage(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be within the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  test("splits at space when no newline", () => {
    const text = "word1 word2 word3 word4 word5 word6";
    const chunks = splitMessage(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("handles text exactly at limit", () => {
    const text = "a".repeat(100);
    const chunks = splitMessage(text, 100);
    expect(chunks).toEqual([text]);
  });

  test("handles empty string", () => {
    const chunks = splitMessage("", 100);
    expect(chunks).toEqual([]);
  });

  test("force-splits when no good split point", () => {
    const text = "a".repeat(200);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(100);
    expect(chunks[1]!.length).toBe(100);
  });

  test("preserves all content across chunks", () => {
    const text = "first line\nsecond line\nthird line\nfourth line\nfifth line";
    const chunks = splitMessage(text, 25);
    const rejoined = chunks.join("\n");
    // All original words should be present
    expect(rejoined).toContain("first");
    expect(rejoined).toContain("fifth");
  });
});
