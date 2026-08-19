/**
 * Pure tests for the windowed acceptance block — the aggregation and the `?days=` clamp
 * only. No database: `summary-candidates.ts` calls `getDb()` inside its query functions,
 * so importing the module is side-effect-free. Co-located with the module (repo
 * convention), which puts it in the `test:db` glob; it needs no container of its own.
 * The DB round-trip (window filtering, dismissed_reason mapping, the float4 repackaging
 * count against real Postgres storage) is covered in `summary-candidates.test.ts`.
 */
import { test, expect, describe } from "bun:test";
import {
  aggregateRecentRows,
  clampRecentWindowDays,
  ACCEPTANCE_TARGET,
  RECENT_WINDOW_DEFAULT_DAYS,
  type RecentRawRow,
} from "./summary-candidates.ts";

function row(over: Partial<RecentRawRow> = {}): RecentRawRow {
  return {
    source: "x",
    status: "new",
    dismissedReason: null,
    title: "@someone: an ordinary tweet about agents",
    score: 0.6,
    ...over,
  };
}

describe("clampRecentWindowDays", () => {
  test("absent / blank / unparseable ⇒ the default window", () => {
    expect(clampRecentWindowDays(undefined)).toBe(RECENT_WINDOW_DEFAULT_DAYS);
    expect(clampRecentWindowDays(null)).toBe(RECENT_WINDOW_DEFAULT_DAYS);
    expect(clampRecentWindowDays("")).toBe(RECENT_WINDOW_DEFAULT_DAYS);
    expect(clampRecentWindowDays("   ")).toBe(RECENT_WINDOW_DEFAULT_DAYS);
    expect(clampRecentWindowDays("abc")).toBe(RECENT_WINDOW_DEFAULT_DAYS);
    expect(clampRecentWindowDays("NaN")).toBe(RECENT_WINDOW_DEFAULT_DAYS);
  });

  test("clamps to 1–90 rather than erroring", () => {
    expect(clampRecentWindowDays("0")).toBe(1);
    expect(clampRecentWindowDays("-5")).toBe(1);
    expect(clampRecentWindowDays("500")).toBe(90);
    expect(clampRecentWindowDays("21")).toBe(21);
  });

  test("Number()+round semantics, not parseInt", () => {
    // parseInt would read these as 1, 12 and 7 — i.e. answer a different window than
    // the query string asked for. Number()+Math.round is the shared idiom.
    expect(clampRecentWindowDays("1e2")).toBe(90); // 100 clamped
    expect(clampRecentWindowDays("12abc")).toBe(RECENT_WINDOW_DEFAULT_DAYS); // NaN ⇒ default
    expect(clampRecentWindowDays("7.9")).toBe(8);
  });
});

describe("aggregateRecentRows", () => {
  test("every captured row lands in exactly one bucket; untriaged is separate from rejected", () => {
    const rows: RecentRawRow[] = [
      row({ status: "new" }),
      row({ status: "new" }),
      row({ status: "summarizing" }),
      row({ status: "summarized" }),
      row({ status: "dismissed", dismissedReason: "manual" }),
      row({ status: "dismissed", dismissedReason: "expired" }),
      row({ status: "dismissed", dismissedReason: "hype-dedup-sweep" }),
      row({ status: "dismissed", dismissedReason: null }),
      row({ status: "error" }),
    ];
    const [x] = aggregateRecentRows(rows);
    expect(x!.source).toBe("x");
    expect(x!.captured).toBe(9);
    // new + summarizing — never looked at, NOT rejections.
    expect(x!.pending).toBe(3);
    expect(x!.triaged).toBe(6);
    expect(x!.summarized).toBe(1);
    expect(x!.dismissedManual).toBe(1);
    // expired + swept + unknown all fold into "other" (bookkeeping, not judgements).
    expect(x!.dismissedOther).toBe(3);
    expect(x!.error).toBe(1);
    // The buckets partition `captured` — nothing may fall out.
    expect(
      x!.pending + x!.summarized + x!.dismissedManual + x!.dismissedOther + x!.error,
    ).toBe(x!.captured);
    // Rate is over judgements only: 1 / (1 + 1).
    expect(x!.acceptanceRate).toBeCloseTo(0.5, 5);
  });

  test("acceptanceRate is null when nothing was judged, even with rows captured", () => {
    // The exact shape the window is in today: everything captured, nothing triaged.
    const [x] = aggregateRecentRows([row(), row(), row()]);
    expect(x!.captured).toBe(3);
    expect(x!.pending).toBe(3);
    expect(x!.triaged).toBe(0);
    expect(x!.acceptanceRate).toBeNull();
  });

  test("splits per source, sorted, and only x carries the repackaging count", () => {
    const out = aggregateRecentRows([
      row({ source: "x" }),
      row({ source: "anthropic", title: "Tool use" }),
      row({ source: "anthropic", title: "Tool use" }),
    ]);
    expect(out.map((o) => o.source)).toEqual(["anthropic", "x"]);
    expect(out[0]!.captured).toBe(2);
    // The metric is X-vertical policy; other sources must not report a misleading 0.
    expect(out[0]!.repackagingShapedAbove08).toBeUndefined();
    expect(out[1]!.repackagingShapedAbove08).toBe(0);
  });

  test("repackaging count: shape on the handle-stripped title, score strictly above the cap", () => {
    const out = aggregateRecentRows([
      // Shaped (ALL-CAPS run) + 0.9 ⇒ counted.
      row({ title: "@a: EVERYONE SHOULD SEE this thread", score: 0.9 }),
      // Shaped (leading 🚨) + 0.85 ⇒ counted.
      row({ title: "@b: 🚨 new agent framework", score: 0.85 }),
      // Shaped ("just released") but exactly AT the cap ⇒ not counted.
      row({ title: "@c: Anthropic just released a course", score: 0.8 }),
      // Shaped but below the cap ⇒ not counted.
      row({ title: "@d: BREAKINGNEWS from the lab", score: 0.7 }),
      // Unshaped at 0.95 ⇒ not counted.
      row({ title: "@e: a careful writeup of tool use", score: 0.95 }),
    ]);
    expect(out[0]!.repackagingShapedAbove08).toBe(2);
  });

  test("the handle prefix itself cannot trigger the shape", () => {
    // "@ALLCAPSHANDLE:" is an 13-letter caps run — if the prefix were left on, this
    // ordinary tweet would be counted as repackaging-shaped forever.
    const out = aggregateRecentRows([
      row({ title: "@ALLCAPSHANDLE: a measured note on evals", score: 0.9 }),
    ]);
    expect(out[0]!.repackagingShapedAbove08).toBe(0);
  });

  test("float4 read-back at the cap does not count (the rounding trap)", () => {
    // Postgres stores 0.8 as float4 and hands it back as 0.800000011920929. A raw
    // `> 0.8` counts that row; rounding to 2 dp first does not.
    const raw = 0.800000011920929;
    expect(raw > 0.8).toBe(true);
    const out = aggregateRecentRows([
      row({ title: "@f: 🚨 clamped to the cap", score: raw }),
    ]);
    expect(out[0]!.repackagingShapedAbove08).toBe(0);
  });

  test("no rows ⇒ no sources (an empty window is empty, not a row of zeros)", () => {
    expect(aggregateRecentRows([])).toEqual([]);
  });

  test("the stated target is the floor heuristic's, not a second number", () => {
    expect(ACCEPTANCE_TARGET).toBe(0.5);
  });
});
