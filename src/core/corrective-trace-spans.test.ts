import { test, expect, describe } from "bun:test";
import { planCorrectiveSpans } from "./corrective-trace-spans.ts";
import type { CorrectiveToolMeta } from "../types.ts";

describe("planCorrectiveSpans", () => {
  test("returns empty when there's no corrective metadata", () => {
    expect(planCorrectiveSpans(undefined, 100)).toEqual([]);
    expect(planCorrectiveSpans({ retries: 0, verdicts: [], reasons: [], queriesTried: [], finalVerdict: "correct" }, 100)).toEqual([]);
  });

  test("one knowledge_grade span when graded but not re-queried", () => {
    const corr: CorrectiveToolMeta = {
      retries: 0,
      verdicts: ["insufficient"],
      reasons: ["Huginn flagged the result as low confidence"],
      queriesTried: [],
      finalVerdict: "insufficient",
      graderMode: "signal",
      graderMs: 0,
    };
    const spans = planCorrectiveSpans(corr, 200);
    expect(spans.map((s) => s.name)).toEqual(["knowledge_grade"]);
    expect(spans[0]!.startOffsetMs).toBe(200);
    expect(spans[0]!.durationMs).toBe(1); // 1ms floor — signal mode has ~0 grader time
    expect(spans[0]!.attributes.mode).toBe("signal");
    expect(spans[0]!.attributes.finalVerdict).toBe("insufficient");
    expect(spans[0]!.attributes.passes).toBe(1);
  });

  test("grade span + one requery span per re-query, laid out sequentially after the tool", () => {
    const corr: CorrectiveToolMeta = {
      retries: 2,
      verdicts: ["insufficient", "ambiguous", "correct"],
      reasons: ["off-topic", "broad", "ok"],
      queriesTried: ["q1", "q2"],
      collectionsTried: [null, ["confluence"]],
      finalVerdict: "correct",
      graderMode: "haiku",
      graderMs: 900,
      requeryMs: [150, 220],
    };
    const spans = planCorrectiveSpans(corr, 300);
    expect(spans.map((s) => s.name)).toEqual(["knowledge_grade", "knowledge_requery", "knowledge_requery"]);
    // grade [300, 1200), requery#1 [1200, 1350), requery#2 [1350, 1570)
    expect(spans[0]!.startOffsetMs).toBe(300);
    expect(spans[0]!.attributes.mode).toBe("haiku");
    expect(spans[1]!.startOffsetMs).toBe(1200);
    expect(spans[1]!.durationMs).toBe(150);
    expect(spans[1]!.attributes.query).toBe("q1");
    expect(spans[1]!.attributes.collection).toBe("(all)");
    expect(spans[2]!.startOffsetMs).toBe(1350);
    expect(spans[2]!.durationMs).toBe(220);
    expect(spans[2]!.attributes.query).toBe("q2");
    expect(spans[2]!.attributes.collection).toBe("confluence");
  });

  test("uses a 1ms floor when timings are missing", () => {
    const spans = planCorrectiveSpans(
      { retries: 1, verdicts: ["insufficient", "correct"], reasons: ["x", "y"], queriesTried: ["q"], finalVerdict: "correct", graderMode: "signal" },
      0,
    );
    expect(spans[0]!.durationMs).toBe(1);
    expect(spans[1]!.durationMs).toBe(1);
    expect(spans[1]!.startOffsetMs).toBe(1);
  });
});
