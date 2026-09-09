/**
 * The TikTok post-model tail, driven outside a capture job.
 *
 * The warn it carries is the only signal that a frames-on capture's frame Reads
 * degraded — the summary still parses, the job still completes, and the reader
 * gets a transcript-only summary labelled as a visual one. Nothing pinned it
 * before the tail became a function; it does now.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { configure, reset as resetLogging, type LogRecord } from "@logtape/logtape";
import { finishTikTokSummary, mentionsVisualContent } from "./finish.ts";

/**
 * Configured PER TEST with `reset: true`, the `src/summaries/frames.test.ts`
 * shape: `bun test` runs many files in one process and any of them may have
 * configured logtape first, so a once-per-file `configure` is a sink another
 * file can take away.
 */
let logs: LogRecord[] = [];
beforeEach(async () => {
  logs = [];
  await configure({
    sinks: { capture: (r: LogRecord) => logs.push(r) },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
});
afterAll(async () => {
  await resetLogging();
});

function warned(): boolean {
  return logs.some((r) => r.level === "warning" && String(r.message).includes("mentions no visual content"));
}

const VISUAL = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- the diagram on screen shows the flow";
const NO_VISUAL = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- one spoken point, nothing else";

describe("finishTikTokSummary", () => {
  test("parses the envelope and tells the caller the category once", () => {
    const seen: string[] = [];
    const out = finishTikTokSummary({
      raw: VISUAL,
      jobId: "t1",
      videoId: "7523456789",
      frameCount: 2,
      onCategory: (c) => seen.push(c),
    });
    expect(out.category).toBe("ai/claude-code");
    expect(out.summary).toBe("### Heading\n- the diagram on screen shows the flow");
    expect(seen).toEqual(["ai/claude-code"]);
    expect(warned()).toBe(false);
  });

  test("a frames-ON summary that mentions nothing visual warns — the degraded-Reads signal", () => {
    finishTikTokSummary({ raw: NO_VISUAL, jobId: "t2", videoId: "7523456789", frameCount: 2 });
    expect(warned()).toBe(true);
  });

  test("with NO frames the same summary is silent — there was nothing to read", () => {
    finishTikTokSummary({ raw: NO_VISUAL, jobId: "t3", videoId: "7523456789", frameCount: 0 });
    expect(warned()).toBe(false);
  });
});

describe("mentionsVisualContent", () => {
  test("matches the vocabulary a visual summary reaches for, case-insensitively", () => {
    for (const word of ["frame", "Image", "on-screen", "DIAGRAM", "slide", "chart", "text overlay"]) {
      expect(mentionsVisualContent(`the ${word} says so`)).toBe(true);
    }
  });

  test("does not match a summary that only reports speech", () => {
    expect(mentionsVisualContent("The speaker argues that the deploy was too slow.")).toBe(false);
    // Word-bounded: a longer word that merely CONTAINS one of them is not a mention.
    expect(mentionsVisualContent("The framework was rewritten.")).toBe(false);
  });
});
