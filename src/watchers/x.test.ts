import { test, expect, describe } from "bun:test";

// Since compactTweetText is not exported, we duplicate the parsing logic
// here for testing. This validates the regex patterns and score extraction.

function extractRankScore(rawText: string): number {
  const lines = rawText.split("\n");
  // Prefer combined_score (engagement + relevance), fall back to engagement_score
  const combinedLine = lines.find((l) => l.includes("combined_score:")) ?? "";
  const combinedMatch = combinedLine.match(/combined_score:\s*([\d.]+)/);
  if (combinedMatch) return parseFloat(combinedMatch[1]!);

  const engScoreLine = lines.find((l) => l.includes("engagement_score:")) ?? "";
  const engScoreMatch = engScoreLine.match(/engagement_score:\s*([\d.]+)/);
  return engScoreMatch ? parseFloat(engScoreMatch[1]!) : 0;
}

function extractEngagementSignals(rawText: string): { likes: string | null; views: string | null } {
  const lines = rawText.split("\n");
  const engagementLine = lines.find((l) => l.includes("**Engagement:**")) ?? "";
  const likesMatch = engagementLine.match(/([\d,]+)\s*likes/);
  const viewsMatch = engagementLine.match(/([\d,]+)\s*views/);
  return {
    likes: likesMatch ? likesMatch[1]! : null,
    views: viewsMatch ? viewsMatch[1]! : null,
  };
}

// ── Score extraction from markdown frontmatter ──────────────────────

describe("rank score extraction from huginn markdown", () => {
  const withCombinedScore = `---
title: "@karpathy — Great thread"
engagement_score: 42.1337
relevance_score: 0.7823
combined_score: 0.8912
---
# @karpathy — Andrej Karpathy

Great thread on transformer architecture improvements.

---

- **Engagement:** 1,508 likes · 234 retweets · 524,000 views · 89 bookmarks
- **Engagement Score:** 42.1337
- **Date:** Thu Mar 20 14:30:00 +0000 2026
- **Type:** tweet
- **Link:** https://x.com/karpathy/status/123456`;

  const engagementOnly = `---
title: "@someone — Some tweet"
engagement_score: 15.5
---
# @someone — Name

Some tweet text

---

- **Engagement:** 100 likes · 10 retweets · 5,000 views
- **Engagement Score:** 15.5`;

  test("prefers combined_score when available", () => {
    expect(extractRankScore(withCombinedScore)).toBe(0.8912);
  });

  test("falls back to engagement_score when no combined_score", () => {
    expect(extractRankScore(engagementOnly)).toBe(15.5);
  });

  test("returns 0 when no scores exist", () => {
    const noScore = `# @someone — Name\n\nSome tweet text`;
    expect(extractRankScore(noScore)).toBe(0);
  });

  test("returns 0 for empty text", () => {
    expect(extractRankScore("")).toBe(0);
  });

  test("extracts likes from engagement line", () => {
    const { likes } = extractEngagementSignals(withCombinedScore);
    expect(likes).toBe("1,508");
  });

  test("extracts views from engagement line", () => {
    const { views } = extractEngagementSignals(withCombinedScore);
    expect(views).toBe("524,000");
  });

  test("handles integer scores (no decimal)", () => {
    expect(extractRankScore("engagement_score: 100")).toBe(100);
  });

  test("handles very small scores", () => {
    expect(extractRankScore("combined_score: 0.0012")).toBe(0.0012);
  });
});

// ── Tweet sorting by score ──────────────────────────────────────────

interface MinimalTweet {
  id: string;
  handle: string;
  engagement_score?: number;
}

describe("tweet ranking by engagement_score (legacy path)", () => {
  const tweets: MinimalTweet[] = [
    { id: "1", handle: "low", engagement_score: 1.5 },
    { id: "2", handle: "high", engagement_score: 42.0 },
    { id: "3", handle: "medium", engagement_score: 12.3 },
    { id: "4", handle: "zero" },
    { id: "5", handle: "also_high", engagement_score: 41.9 },
  ];

  test("sorts descending by engagement_score", () => {
    const sorted = [...tweets].sort(
      (a, b) => (b.engagement_score ?? 0) - (a.engagement_score ?? 0),
    );
    expect(sorted.map((t) => t.handle)).toEqual([
      "high", "also_high", "medium", "low", "zero",
    ]);
  });

  test("top-N slicing returns highest scored tweets", () => {
    const sorted = [...tweets].sort(
      (a, b) => (b.engagement_score ?? 0) - (a.engagement_score ?? 0),
    );
    const topN = 3;
    const top = sorted.slice(0, topN);
    expect(top).toHaveLength(3);
    expect(top[0]!.handle).toBe("high");
    expect(top[2]!.handle).toBe("medium");
  });

  test("handles all tweets missing engagement_score", () => {
    const noScores: MinimalTweet[] = [
      { id: "1", handle: "a" },
      { id: "2", handle: "b" },
    ];
    const sorted = [...noScores].sort(
      (a, b) => (b.engagement_score ?? 0) - (a.engagement_score ?? 0),
    );
    expect(sorted).toHaveLength(2);
  });
});
