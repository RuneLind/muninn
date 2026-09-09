/**
 * The X-video post-model tail, driven outside a capture job — how PR 3's re-run
 * will call it.
 *
 * A ONE-STEP tail still gets its own file, for the two properties nothing else
 * pins. `onCategory` is the only thing this tail owns the timing of, and
 * dropping the call leaves the live card without a category while every
 * assertion in `video.test.ts` still passes (the job store is written by the
 * ingest path too). And the step this vertical does NOT have — TikTok's
 * degraded-frame-Reads warn — is a difference a re-run inherits, so the silence
 * is asserted rather than assumed.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { configure, reset as resetLogging, type LogRecord } from "@logtape/logtape";
import { finishXVideoSummary } from "./video-finish.ts";

/**
 * Configured PER TEST with `reset: true`, the `src/tiktok/finish.test.ts` shape:
 * `bun test` runs many files in one process and any of them may have configured
 * logtape first, so a once-per-file `configure` is a sink another file can take
 * away.
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

const VISUAL = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- the diagram on screen shows the flow";
const NO_VISUAL = "CATEGORY: ai/claude-code\n\nSUMMARY:\n### Heading\n- one spoken point, nothing else";

describe("finishXVideoSummary", () => {
  test("parses the envelope and tells the caller the category once", () => {
    const seen: string[] = [];
    const out = finishXVideoSummary({ raw: VISUAL, onCategory: (c) => seen.push(c) });
    expect(out.category).toBe("ai/claude-code");
    expect(out.summary).toBe("### Heading\n- the diagram on screen shows the flow");
    expect(seen).toEqual(["ai/claude-code"]);
  });

  test("the callback is optional — a caller with no live card still gets the summary", () => {
    const out = finishXVideoSummary({ raw: VISUAL });
    expect(out.category).toBe("ai/claude-code");
    expect(out.summary).toBe("### Heading\n- the diagram on screen shows the flow");
  });

  test("NO degraded-frame-Reads warn: a summary mentioning nothing visual is silent here", () => {
    // The TikTok twin warns on exactly this input. This tail has no frame-count
    // channel at all, and the re-run must inherit that difference rather than
    // acquire the neighbour's second step.
    const out = finishXVideoSummary({ raw: NO_VISUAL });
    expect(out.summary).toBe("### Heading\n- one spoken point, nothing else");
    expect(logs).toEqual([]);
  });
});
