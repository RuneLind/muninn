import { test, expect, describe } from "bun:test";
import { normalizeUrl } from "./knowledge-links.ts";

describe("normalizeUrl", () => {
  // ── Regular URLs ────────────────────────────────────────────────────

  test("strips www prefix", () => {
    expect(normalizeUrl("https://www.example.com/page")).toBe(
      "example.com/page",
    );
  });

  test("strips trailing slash", () => {
    expect(normalizeUrl("https://example.com/path/")).toBe(
      "example.com/path",
    );
  });

  test("strips both www and trailing slash", () => {
    expect(normalizeUrl("https://www.example.com/")).toBe("example.com");
  });

  test("preserves path without trailing slash", () => {
    expect(normalizeUrl("https://example.com/a/b/c")).toBe(
      "example.com/a/b/c",
    );
  });

  test("root URL normalizes to hostname only", () => {
    expect(normalizeUrl("https://example.com")).toBe("example.com");
  });

  // ── YouTube URLs ────────────────────────────────────────────────────

  test("youtube.com/watch?v=xxx normalizes with video id", () => {
    expect(normalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  test("youtube.com/watch with extra params keeps only v=", () => {
    expect(
      normalizeUrl(
        "https://youtube.com/watch?v=abc123&list=PLxyz&t=42",
      ),
    ).toBe("youtube.com/watch?v=abc123");
  });

  test("youtu.be short URL → youtube.com/watch?v=xxx", () => {
    expect(normalizeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  test("youtu.be with params → youtube.com/watch?v=xxx", () => {
    expect(normalizeUrl("https://youtu.be/abc123?t=42")).toBe(
      "youtube.com/watch?v=abc123",
    );
  });

  // ── Non-YouTube URLs with query params ──────────────────────────────

  test("non-YouTube URLs: query params are NOT included", () => {
    // normalizeUrl only uses hostname + pathname (no search params for non-YouTube)
    expect(normalizeUrl("https://example.com/page?foo=bar&baz=1")).toBe(
      "example.com/page",
    );
  });

  // ── Invalid URLs ────────────────────────────────────────────────────

  test("invalid URL returns input unchanged", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });

  test("empty string returns empty string", () => {
    expect(normalizeUrl("")).toBe("");
  });

  test("relative path returns input unchanged", () => {
    expect(normalizeUrl("/some/path")).toBe("/some/path");
  });

  test("completely invalid string returns input unchanged", () => {
    expect(normalizeUrl(":::invalid")).toBe(":::invalid");
  });
});
