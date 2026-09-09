/**
 * The summary-source registry's two wire-facing rules.
 *
 * Both were unpinned and both are read by code that cannot see the registry:
 * `encodeDocIdPath` builds the URL three server routes fetch a document with,
 * and `clientSourcesJson` is the only thing the `/summaries` page knows about a
 * source.
 */

import { test, expect, describe } from "bun:test";
import { SUMMARY_SOURCES, clientSourcesJson, encodeDocIdPath, isSafeDocId } from "./sources.ts";

describe("encodeDocIdPath", () => {
  test("every `/` stays a separator and everything inside a segment is encoded", () => {
    // The rule the three hand-written copies it replaced all implemented: a real
    // doc id IS a path, so encoding it whole would post one segment named
    // `ai%2Fgeneral%2F…` and huginn would answer 404 for every document.
    expect(encodeDocIdPath("ai/general/A Talk.md")).toBe("ai/general/A%20Talk.md");
    expect(encodeDocIdPath("coding/En Talk om æøå.md")).toBe(
      "coding/En%20Talk%20om%20%C3%A6%C3%B8%C3%A5.md",
    );
  });

  test("a `#` is encoded, which is the truncation the bare interpolation caused", () => {
    // Unencoded, everything from `#` on is a fragment the server never sees, so
    // the fetch asked for a different document and got one.
    expect(encodeDocIdPath("ai/general/C# and friends.md")).toBe("ai/general/C%23%20and%20friends.md");
    expect(encodeDocIdPath("ai/general/50% faster.md")).toBe("ai/general/50%25%20faster.md");
  });

  test("it is an ENCODER, not the safety gate — that is `isSafeDocId`, and callers run it first", () => {
    expect(encodeDocIdPath("../mimir/x.md")).toBe("../mimir/x.md");
    expect(isSafeDocId("../mimir/x.md")).toBe(false);
  });
});

describe("clientSourcesJson", () => {
  test("`rerun` is projected as a real boolean, and only the flagged sources carry it", () => {
    const map = JSON.parse(clientSourcesJson()) as Record<string, { rerun: boolean }>;
    const flagged = Object.entries(map)
      .filter(([, v]) => v.rerun)
      .map(([id]) => id)
      .sort();
    expect(flagged).toEqual(["tiktok", "vimeo", "x-article", "youtube"]);
    // An unflagged source answers `false`, never `undefined`: the panel reads
    // `SOURCES[source].rerun` directly and renders the control from it.
    expect(map.article!.rerun).toBe(false);
    expect(map.anthropic!.rerun).toBe(false);
  });

  test("the projection agrees with the registry it is built from", () => {
    const map = JSON.parse(clientSourcesJson()) as Record<string, { rerun: boolean; collection: string }>;
    for (const s of SUMMARY_SOURCES) {
      expect([s.id, map[s.id]!.rerun]).toEqual([s.id, s.rerun === true]);
      expect([s.id, map[s.id]!.collection]).toEqual([s.id, s.collection]);
    }
  });
});
