import { test, expect, describe, afterEach } from "bun:test";
import {
  normalizeHandle,
  getAuthorScore,
  getAuthorTierThresholds,
  __resetAuthorScoresCacheForTest,
} from "./author-scores.ts";
import { tmpdir } from "node:os";
import path from "node:path";

describe("normalizeHandle", () => {
  test("strips a leading @ and lowercases", () => {
    expect(normalizeHandle("@Karpathy")).toBe("karpathy");
    expect(normalizeHandle("handle")).toBe("handle");
    expect(normalizeHandle("@@ClaudeAI")).toBe("claudeai");
    expect(normalizeHandle("  @Foo  ")).toBe("foo");
  });

  test("treats unknown (any case) and empty as no author", () => {
    expect(normalizeHandle("unknown")).toBeNull();
    expect(normalizeHandle("UNKNOWN")).toBeNull();
    expect(normalizeHandle("@unknown")).toBeNull();
    expect(normalizeHandle("")).toBeNull();
    expect(normalizeHandle("   ")).toBeNull();
    expect(normalizeHandle(null)).toBeNull();
    expect(normalizeHandle(undefined)).toBeNull();
  });
});

describe("score loader (temp file)", () => {
  const prev = process.env.X_AUTHOR_SCORES_PATH;

  afterEach(() => {
    if (prev === undefined) delete process.env.X_AUTHOR_SCORES_PATH;
    else process.env.X_AUTHOR_SCORES_PATH = prev;
    __resetAuthorScoresCacheForTest();
  });

  test("looks scores up by normalized handle and computes percentile cuts", async () => {
    // 100 authors so the top-1% / top-5% rank indices are well defined.
    const map: Record<string, { author_score: number }> = {};
    for (let i = 0; i < 100; i++) map[`author${i}`] = { author_score: (100 - i) / 100 };
    const p = path.join(tmpdir(), `author-scores-test-${Date.now()}.json`);
    await Bun.write(p, JSON.stringify(map));
    process.env.X_AUTHOR_SCORES_PATH = p;
    __resetAuthorScoresCacheForTest();

    expect(await getAuthorScore("@Author0")).toBeCloseTo(1.0, 5);
    expect(await getAuthorScore("author99")).toBeCloseTo(0.01, 5);
    expect(await getAuthorScore("@nobody")).toBeNull();
    expect(await getAuthorScore("unknown")).toBeNull();

    const t = await getAuthorTierThresholds();
    expect(t).not.toBeNull();
    // DESC scores are 1.00..0.01; floor(0.01*100)=1 → score at index 1 = 0.99,
    // floor(0.05*100)=5 → index 5 = 0.95.
    expect(t!.top1).toBeCloseTo(0.99, 5);
    expect(t!.top5).toBeCloseTo(0.95, 5);
  });

  test("degrades to null on a missing file (no throw)", async () => {
    process.env.X_AUTHOR_SCORES_PATH = path.join(tmpdir(), `does-not-exist-${Date.now()}.json`);
    __resetAuthorScoresCacheForTest();
    expect(await getAuthorScore("@karpathy")).toBeNull();
    expect(await getAuthorTierThresholds()).toBeNull();
    // A second call must not throw either (one-shot warn already fired).
    expect(await getAuthorScore("@karpathy")).toBeNull();
  });
});
