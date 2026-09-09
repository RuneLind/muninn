/**
 * The SHORT-VIDEO post-model tail, driven outside a capture job — how a re-run
 * calls it.
 *
 * The merge of `src/tiktok/finish.test.ts` and `src/x-article/video-finish.test.ts`,
 * and the reason both files existed is what this one has to keep pinning: the
 * two tails were NOT the same tail. TikTok's carries the degraded-frame-Reads
 * warn — the only signal that a frames-on capture's Reads silently failed, since
 * the summary still parses and the job still completes — and the X one never
 * has. That difference is `visualWarning` on the spec now, and a merge that
 * quietly gave X the neighbour's second step would be invisible everywhere else.
 *
 * `onCategory` is the other thing only this file sees: dropping the call leaves
 * the live card without a category while every assertion in `short-video.test.ts`
 * still passes (the job store is written by the ingest path too).
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { configure, reset as resetLogging, type LogRecord } from "@logtape/logtape";
import { finishShortVideoSummary, mentionsVisualContent } from "./short-video-finish.ts";
import { TIKTOK_SPEC } from "../tiktok/summarizer.ts";
import { X_VIDEO_SPEC } from "../x-article/video.ts";

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
  return logs.some(
    (r) => r.level === "warning" && String(r.message).includes("mentions no visual content"),
  );
}

const VISUAL = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- the diagram on screen shows the flow";
const NO_VISUAL = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- one spoken point, nothing else";

describe("finishShortVideoSummary", () => {
  for (const spec of [TIKTOK_SPEC, X_VIDEO_SPEC]) {
    test(`${spec.id}: parses the envelope and tells the caller the category once`, () => {
      const seen: string[] = [];
      const out = finishShortVideoSummary(spec, {
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

    test(`${spec.id}: the callback is optional — a caller with no live card still gets the summary`, () => {
      const out = finishShortVideoSummary(spec, {
        raw: VISUAL,
        jobId: "t2",
        videoId: "7523456789",
        frameCount: 0,
      });
      expect(out.category).toBe("ai/claude-code");
      expect(out.summary).toBe("### Heading\n- the diagram on screen shows the flow");
    });
  }

  test("TikTok warns on a frames-ON summary that mentions nothing visual — the degraded-Reads signal", () => {
    finishShortVideoSummary(TIKTOK_SPEC, {
      raw: NO_VISUAL,
      jobId: "t3",
      videoId: "7523456789",
      frameCount: 2,
    });
    expect(warned()).toBe(true);
  });

  test("with NO frames the same summary is silent — there was nothing to read", () => {
    finishShortVideoSummary(TIKTOK_SPEC, {
      raw: NO_VISUAL,
      jobId: "t4",
      videoId: "7523456789",
      frameCount: 0,
    });
    expect(warned()).toBe(false);
  });

  test("X video does NOT warn on the input its TikTok twin warns on", () => {
    // The difference is the whole reason `visualWarning` is a spec field: this
    // vertical has never had the warn, and a re-run must inherit that.
    const out = finishShortVideoSummary(X_VIDEO_SPEC, {
      raw: NO_VISUAL,
      jobId: "t5",
      videoId: "2081279674966044799",
      frameCount: 2,
    });
    expect(out.summary).toBe("### Heading\n- one spoken point, nothing else");
    expect(logs).toEqual([]);
  });

  test("the warn is recorded under the VERTICAL's own category, not the shared module's", () => {
    // The searchable field, not the file name: the JSONL sink is queried by
    // category, and moving this code into `src/video/` must not move the records
    // a saved query already selects.
    finishShortVideoSummary(TIKTOK_SPEC, {
      raw: NO_VISUAL,
      jobId: "t6",
      videoId: "7523456789",
      frameCount: 2,
    });
    const warn = logs.find((r) => String(r.message).includes("mentions no visual content"));
    expect(warn).toBeDefined();
    expect(warn!.category).toEqual(["muninn", "tiktok", "summarizer"]);
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
