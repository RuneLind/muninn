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
    // DESC scores are 1.00..0.01. Top 1% of 100 = exactly 1 author → cut = scores[0]
    // = 1.00; top 5% = 5 authors → cut = scores[4] = 0.96. (Cuts are float4-rounded
    // via Math.fround, hence toBeCloseTo.)
    expect(t!.top1).toBeCloseTo(1.0, 5);
    expect(t!.top5).toBeCloseTo(0.96, 5);
    // Exactly ONE author clears the top-1% cut (pins the off-by-one: a floor-index
    // cut paired with >= would admit two).
    const clearing = Object.values(map).filter((e) => Math.fround(e.author_score) >= t!.top1);
    expect(clearing.length).toBe(1);
    // And exactly five clear top-5%.
    expect(Object.values(map).filter((e) => Math.fround(e.author_score) >= t!.top5).length).toBe(5);
  });

  test("returns no tiers for a degenerate tiny author set (N < 20)", async () => {
    const map: Record<string, { author_score: number }> = {};
    for (let i = 0; i < 10; i++) map[`a${i}`] = { author_score: (10 - i) / 10 };
    const p = path.join(tmpdir(), `author-scores-tiny-${Date.now()}.json`);
    await Bun.write(p, JSON.stringify(map));
    process.env.X_AUTHOR_SCORES_PATH = p;
    __resetAuthorScoresCacheForTest();

    expect(await getAuthorTierThresholds()).toBeNull();
    // Individual score lookups still work — only the tiering degrades.
    expect(await getAuthorScore("@a0")).toBeCloseTo(1.0, 5);
  });

  test("degrades to null on valid JSON of the wrong shape (no silent feature-vanish)", async () => {
    // e.g. huginn someday wraps the entries under a metadata key.
    const wrapped = { generated_at: "2026-07-06", authors: { karpathy: { author_score: 0.6 } } };
    const p = path.join(tmpdir(), `author-scores-shape-${Date.now()}.json`);
    await Bun.write(p, JSON.stringify(wrapped));
    process.env.X_AUTHOR_SCORES_PATH = p;
    __resetAuthorScoresCacheForTest();

    expect(await getAuthorScore("@karpathy")).toBeNull();
    expect(await getAuthorTierThresholds()).toBeNull();
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
