import { test, expect, describe } from "bun:test";
import {
  aggregateToolCalls,
  fmtToolTime,
  fmtNum,
  fmtDuration,
  computeContextUsage,
  computeLastResponseRows,
} from "./inspector-panel.ts";

// ── aggregateToolCalls ─────────────────────────────────────────────────

describe("aggregateToolCalls", () => {
  test("empty array returns empty array", () => {
    expect(aggregateToolCalls([])).toEqual([]);
  });

  test("single tool call returns one entry with count 1", () => {
    const result = aggregateToolCalls([
      { name: "Read", durationMs: 50 },
    ]);
    expect(result).toEqual([
      { displayName: "Read", callCount: 1, totalMs: 50, totalTokens: 0 },
    ]);
  });

  test("multiple calls to same tool aggregates count and totalMs", () => {
    const result = aggregateToolCalls([
      { name: "Read", durationMs: 100 },
      { name: "Read", durationMs: 200 },
      { name: "Read", durationMs: 50 },
    ]);
    expect(result).toEqual([
      { displayName: "Read", callCount: 3, totalMs: 350, totalTokens: 0 },
    ]);
  });

  test("different tools create separate entries", () => {
    const result = aggregateToolCalls([
      { name: "Read", durationMs: 100 },
      { name: "Write", durationMs: 200 },
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((t) => t.displayName === "Read")!.callCount).toBe(1);
    expect(result.find((t) => t.displayName === "Write")!.callCount).toBe(1);
  });

  test("uses displayName over name when available", () => {
    const result = aggregateToolCalls([
      { name: "mcp__serena__search", displayName: "Serena Search", durationMs: 100 },
      { name: "mcp__serena__search", displayName: "Serena Search", durationMs: 200 },
    ]);
    expect(result).toEqual([
      { displayName: "Serena Search", callCount: 2, totalMs: 300, totalTokens: 0 },
    ]);
  });

  test("sorts by callCount descending", () => {
    const result = aggregateToolCalls([
      { name: "Write", durationMs: 500 },
      { name: "Read", durationMs: 10 },
      { name: "Read", durationMs: 10 },
      { name: "Read", durationMs: 10 },
    ]);
    expect(result[0]!.displayName).toBe("Read");
    expect(result[0]!.callCount).toBe(3);
    expect(result[1]!.displayName).toBe("Write");
    expect(result[1]!.callCount).toBe(1);
  });

  test("sorts by totalMs descending when callCount is equal", () => {
    const result = aggregateToolCalls([
      { name: "Read", durationMs: 100 },
      { name: "Write", durationMs: 500 },
    ]);
    expect(result[0]!.displayName).toBe("Write");
    expect(result[0]!.totalMs).toBe(500);
    expect(result[1]!.displayName).toBe("Read");
    expect(result[1]!.totalMs).toBe(100);
  });

  test("handles missing durationMs (treats as 0)", () => {
    const result = aggregateToolCalls([
      { name: "Read" },
      { name: "Read", durationMs: 100 },
    ]);
    expect(result).toEqual([
      { displayName: "Read", callCount: 2, totalMs: 100, totalTokens: 0 },
    ]);
  });

  test("sums tokensEstimate across calls of the same tool", () => {
    const result = aggregateToolCalls([
      { name: "search", tokensEstimate: 1200 },
      { name: "search", tokensEstimate: 800 },
      { name: "bash", tokensEstimate: 50 },
    ]);
    expect(result.find((t) => t.displayName === "search")!.totalTokens).toBe(2000);
    expect(result.find((t) => t.displayName === "bash")!.totalTokens).toBe(50);
  });

  test("entries without tokensEstimate contribute 0 tokens (live phase before tool_end)", () => {
    const result = aggregateToolCalls([
      { name: "search", durationMs: 100 },
      { name: "search", durationMs: 200, tokensEstimate: 1500 },
    ]);
    expect(result[0]!.totalTokens).toBe(1500);
  });
});

// ── fmtToolTime ────────────────────────────────────────────────────────

describe("fmtToolTime", () => {
  test("returns 'Xms' for values under 1000", () => {
    expect(fmtToolTime(500)).toBe("500ms");
    expect(fmtToolTime(1)).toBe("1ms");
  });

  test("returns 'X.Xs' for values 1000-59999", () => {
    expect(fmtToolTime(1500)).toBe("1.5s");
    expect(fmtToolTime(30000)).toBe("30.0s");
  });

  test("returns 'Xm' for values >= 60000", () => {
    expect(fmtToolTime(60000)).toBe("1m");
    expect(fmtToolTime(120000)).toBe("2m");
    expect(fmtToolTime(90000)).toBe("2m");
  });

  test("edge case: 0", () => {
    expect(fmtToolTime(0)).toBe("0ms");
  });

  test("edge case: 999", () => {
    expect(fmtToolTime(999)).toBe("999ms");
  });

  test("edge case: 1000", () => {
    expect(fmtToolTime(1000)).toBe("1.0s");
  });

  test("edge case: 59999", () => {
    expect(fmtToolTime(59999)).toBe("60.0s");
  });

  test("edge case: 60000", () => {
    expect(fmtToolTime(60000)).toBe("1m");
  });
});

// ── fmtNum ─────────────────────────────────────────────────────────────

describe("fmtNum", () => {
  test("returns raw string for values < 1000", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(42)).toBe("42");
    expect(fmtNum(999)).toBe("999");
  });

  test("returns 'X.Xk' for values 1000-999999", () => {
    expect(fmtNum(1000)).toBe("1.0k");
    expect(fmtNum(1500)).toBe("1.5k");
    expect(fmtNum(999999)).toBe("1000.0k");
  });

  test("returns 'X.XM' for values >= 1000000", () => {
    expect(fmtNum(1000000)).toBe("1.0M");
    expect(fmtNum(2500000)).toBe("2.5M");
  });

  test("edge case: 0", () => {
    expect(fmtNum(0)).toBe("0");
  });

  test("edge case: 999", () => {
    expect(fmtNum(999)).toBe("999");
  });

  test("edge case: 1000", () => {
    expect(fmtNum(1000)).toBe("1.0k");
  });

  test("edge case: 999999", () => {
    expect(fmtNum(999999)).toBe("1000.0k");
  });

  test("edge case: 1000000", () => {
    expect(fmtNum(1000000)).toBe("1.0M");
  });
});

// ── computeContextUsage ────────────────────────────────────────────────

describe("computeContextUsage", () => {
  test("returns null for null meta", () => {
    expect(computeContextUsage(null)).toBeNull();
  });

  test("returns null for meta with no token counts", () => {
    expect(computeContextUsage({})).toBeNull();
    expect(computeContextUsage({ outputTokens: 500 })).toBeNull();
  });

  test("with contextWindow: calculates correct percentage", () => {
    const result = computeContextUsage({
      contextTokens: 5000,
      contextWindow: 10000,
    });
    expect(result).not.toBeNull();
    expect(result!.percentage).toBe(50);
    expect(result!.label).toBe("5.0k / 10.0k");
    expect(result!.hasBar).toBe(true);
  });

  test("without contextWindow: shows 'in/out' format, pct=0", () => {
    const result = computeContextUsage({
      inputTokens: 3000,
      outputTokens: 500,
    });
    expect(result).not.toBeNull();
    expect(result!.percentage).toBe(0);
    expect(result!.label).toBe("3.0k in, 500 out");
    expect(result!.hasBar).toBe(false);
  });

  test("color threshold: accent for <= 60%", () => {
    const result = computeContextUsage({
      contextTokens: 6000,
      contextWindow: 10000,
    });
    expect(result!.barColor).toBe("accent");
    expect(result!.percentage).toBe(60);
  });

  test("color threshold: warning for 61-80%", () => {
    const result = computeContextUsage({
      contextTokens: 7000,
      contextWindow: 10000,
    });
    expect(result!.barColor).toBe("warning");
    expect(result!.percentage).toBe(70);

    const result80 = computeContextUsage({
      contextTokens: 8000,
      contextWindow: 10000,
    });
    expect(result80!.barColor).toBe("warning");
    expect(result80!.percentage).toBe(80);
  });

  test("color threshold: error for > 80%", () => {
    const result = computeContextUsage({
      contextTokens: 8100,
      contextWindow: 10000,
    });
    expect(result!.barColor).toBe("error");
    expect(result!.percentage).toBe(81);
  });

  test("percentage capped at 100", () => {
    const result = computeContextUsage({
      contextTokens: 15000,
      contextWindow: 10000,
    });
    expect(result!.percentage).toBe(100);
  });

  test("prefers contextTokens over inputTokens", () => {
    const result = computeContextUsage({
      contextTokens: 8000,
      inputTokens: 3000,
      contextWindow: 10000,
    });
    expect(result!.percentage).toBe(80);
    expect(result!.label).toBe("8.0k / 10.0k");
  });

  test("falls back to inputTokens when contextTokens is missing", () => {
    const result = computeContextUsage({
      inputTokens: 4000,
      contextWindow: 10000,
    });
    expect(result!.percentage).toBe(40);
    expect(result!.label).toBe("4.0k / 10.0k");
  });

  test("uses contextTokens=0 literally instead of falling back to inputTokens", () => {
    const result = computeContextUsage({
      contextTokens: 0,
      inputTokens: 5000,
      contextWindow: 10000,
    });
    // contextTokens is explicitly 0 — should return null (no data), not fall back to inputTokens
    expect(result).toBeNull();
  });
});

// ── fmtDuration ────────────────────────────────────────────────────────

describe("fmtDuration", () => {
  test("sub-second values render as ms", () => {
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(999)).toBe("999ms");
  });
  test("1-9.9s renders with one decimal", () => {
    expect(fmtDuration(1500)).toBe("1.5s");
    expect(fmtDuration(9900)).toBe("9.9s");
  });
  test("10s+ renders as integer seconds", () => {
    expect(fmtDuration(10000)).toBe("10s");
    expect(fmtDuration(123456)).toBe("123s");
  });
});

// ── computeLastResponseRows ────────────────────────────────────────────

describe("computeLastResponseRows", () => {
  test("null meta returns empty array", () => {
    expect(computeLastResponseRows(null)).toEqual([]);
  });

  test("empty meta returns empty array", () => {
    expect(computeLastResponseRows({})).toEqual([]);
  });

  test("subtracts cache tokens from inputTokens to show fresh input", () => {
    // inputTokens is the sum (5k fresh + 8k cache_read + 1k cache_create = 14k total)
    const rows = computeLastResponseRows({
      inputTokens: 14000,
      cacheReadTokens: 8000,
      cacheCreationTokens: 1000,
      outputTokens: 500,
    });
    const input = rows.find((r) => r.label === "Input")!;
    expect(input.value).toBe("5.0k");
  });

  test("renders cache hit with percentage of total input", () => {
    const rows = computeLastResponseRows({
      inputTokens: 10000,
      cacheReadTokens: 9000,
      outputTokens: 100,
    });
    const cache = rows.find((r) => r.label === "Cache hit")!;
    expect(cache.value).toBe("9.0k");
    expect(cache.detail).toBe("90%");
    expect(cache.emphasis).toBe("cache");
  });

  test("omits cache row when cacheReadTokens is missing or zero", () => {
    const rows = computeLastResponseRows({
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(rows.find((r) => r.label === "Cache hit")).toBeUndefined();
    expect(rows.find((r) => r.label === "Cache write")).toBeUndefined();
  });

  test("includes cost row only when costUsd > 0", () => {
    const withCost = computeLastResponseRows({ inputTokens: 100, costUsd: 0.0123 });
    expect(withCost.find((r) => r.label === "Cost")?.value).toBe("$0.0123");

    const localModel = computeLastResponseRows({ inputTokens: 100, costUsd: 0 });
    expect(localModel.find((r) => r.label === "Cost")).toBeUndefined();
  });

  test("does not emit a Tools row (count rendered as subsection heading by renderLastResponseCard)", () => {
    const rows = computeLastResponseRows({
      inputTokens: 100,
      toolCalls: [{ displayName: "Read" }, { displayName: "Write" }],
    });
    expect(rows.find((r) => r.label === "Tools")).toBeUndefined();
  });

  test("omits Turns row for single-turn responses", () => {
    const single = computeLastResponseRows({ inputTokens: 100, numTurns: 1 });
    expect(single.find((r) => r.label === "Turns")).toBeUndefined();

    const multi = computeLastResponseRows({ inputTokens: 100, numTurns: 4 });
    expect(multi.find((r) => r.label === "Turns")?.value).toBe("4");
  });
});
