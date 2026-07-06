import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { Watcher } from "../types.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The capture gate spawns Haiku and the capture writer hits the candidate DB; both
// are mocked so the collection + capture paths run without a real `claude -p` spawn
// or a live Postgres. The pure-function tests (extractRankScore/buildDateWindow/
// isSkipResult/compactTweetText/isLongFormTweet) don't touch either.

let gateResult = "[]";
let gateThrow = false;
let lastGatePrompt = "";
mock.module("../scheduler/executor.ts", () => ({
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  spawnHaiku: async (prompt: string) => {
    lastGatePrompt = prompt;
    if (gateThrow) throw new Error("haiku down");
    return { result: gateResult, inputTokens: 0, outputTokens: 0, model: "claude-haiku-4-5-20251001" };
  },
}));

const upsertCalls: Array<{
  source: string;
  url: string;
  title: string;
  candidateSrc?: string | null;
  score: number;
  kind?: string | null;
  sourceDocId?: string | null;
}> = [];
let upsertThrow = false;
// NB: mock.module leaks across the watcher test files (one process). Export the FULL
// public surface — sibling files' graphs (summarizer.ts et al.) statically import
// setCandidateStatus / getCandidateBySourceUrl, and a partial mock would break their
// module load. Only upsertCandidate is exercised here; the rest are inert stand-ins.
mock.module("../db/summary-candidates.ts", () => ({
  upsertCandidate: async (p: {
    source: string;
    url: string;
    title: string;
    candidateSrc?: string | null;
    score: number;
    kind?: string | null;
    sourceDocId?: string | null;
  }) => {
    if (upsertThrow) throw new Error("db down");
    upsertCalls.push(p);
  },
  listCandidates: async () => [],
  getCandidateById: async () => null,
  getCandidateBySourceUrl: async () => null,
  setCandidateStatus: async () => {},
}));

const {
  extractRankScore,
  buildDateWindow,
  isSkipResult,
  compactTweetText,
  isLongFormTweet,
  fetchFromCollection,
  checkX,
} = await import("./x.ts");

// ── Score extraction from markdown (tests the real exported function) ─

describe("extractRankScore", () => {
  const withCombinedScore = `---
title: "@karpathy — Great thread"
engagement_score: 42.1337
relevance_score: 0.7823
combined_score: 0.8912
---
# @karpathy — Andrej Karpathy

Great thread on transformer architecture improvements.`;

  const engagementOnly = `---
title: "@someone — Some tweet"
engagement_score: 15.5
---
# @someone — Name

Some tweet text`;

  test("prefers combined_score when available", () => {
    expect(extractRankScore(withCombinedScore)).toBe(0.8912);
  });

  test("falls back to engagement_score when no combined_score", () => {
    expect(extractRankScore(engagementOnly)).toBe(15.5);
  });

  test("returns 0 when no scores exist", () => {
    expect(extractRankScore("# @someone — Name\n\nSome tweet text")).toBe(0);
  });

  test("returns 0 for empty text", () => {
    expect(extractRankScore("")).toBe(0);
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

// ── Date window for windowDays config ───────────────────────────────

describe("buildDateWindow", () => {
  // Pin "now" well inside a day in Europe/Oslo (noon UTC = 13:00 or 14:00 Oslo)
  const anchor = new Date("2026-03-15T12:00:00Z");

  test("windowDays=1 returns only today", () => {
    const set = buildDateWindow(1, anchor);
    expect(set.size).toBe(1);
    expect(set.has("2026-03-15")).toBe(true);
  });

  test("windowDays=2 returns today and yesterday (preserves legacy behavior)", () => {
    const set = buildDateWindow(2, anchor);
    expect(set.size).toBe(2);
    expect(set.has("2026-03-15")).toBe(true);
    expect(set.has("2026-03-14")).toBe(true);
  });

  test("windowDays=7 returns a full rolling week", () => {
    const set = buildDateWindow(7, anchor);
    expect(set.size).toBe(7);
    expect(set.has("2026-03-15")).toBe(true);
    expect(set.has("2026-03-09")).toBe(true);
    expect(set.has("2026-03-08")).toBe(false);
  });

  test("clamps windowDays < 1 to 1", () => {
    const set = buildDateWindow(0, anchor);
    expect(set.size).toBe(1);
  });
});

// ── Quiet-mode SKIP detection ───────────────────────────────────────

describe("isSkipResult", () => {
  test("bare SKIP", () => {
    expect(isSkipResult("SKIP")).toBe(true);
  });

  test("SKIP with surrounding whitespace", () => {
    expect(isSkipResult("  SKIP  \n")).toBe(true);
  });

  test("lowercase skip", () => {
    expect(isSkipResult("skip")).toBe(true);
  });

  test("SKIP wrapped in markdown bold", () => {
    expect(isSkipResult("**SKIP**")).toBe(true);
  });

  test("SKIP with trailing period", () => {
    expect(isSkipResult("SKIP.")).toBe(true);
  });

  test("rejects SKIP inside a sentence", () => {
    expect(isSkipResult("I will SKIP this one")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isSkipResult("")).toBe(false);
  });

  test("rejects a real digest", () => {
    expect(isSkipResult("**Top Picks**\n- @karpathy: ...")).toBe(false);
  });
});

// ── compactTweetText: per-doc fields (drives the capture path) ───────

describe("compactTweetText", () => {
  const noteDoc = `[2026-07-04_karpathy_1]
# @karpathy — Andrej Karpathy

This is the first line of a long note.
It continues across several lines with substance.

---

- **Engagement:** 1,508 likes, 524,000 views
- **Type:** note`;

  test("extracts handle, first line, note marker, and body length", () => {
    const c = compactTweetText(noteDoc, "https://x.com/karpathy/status/1");
    expect(c.handle).toBe("@karpathy");
    expect(c.firstLine).toBe("This is the first line of a long note.");
    expect(c.isNote).toBe(true);
    // bodyLength measures the joined body PRE-truncation, not the raw doc.
    expect(c.bodyLength).toBeGreaterThan(50);
    // The compact one-liner keeps the [ARTICLE/NOTE] marker + engagement + URL.
    expect(c.text).toContain("[ARTICLE/NOTE]");
    expect(c.text).toContain("@karpathy:");
    expect(c.text).toContain("URL: https://x.com/karpathy/status/1");
  });

  test("a plain short tweet has no note marker and a small body length", () => {
    const doc = `# @someone — Name\n\nshort tweet\n\n---\n\n- **Engagement:** 3 likes`;
    const c = compactTweetText(doc, "https://x.com/someone/status/2");
    expect(c.isNote).toBe(false);
    expect(c.bodyLength).toBe("short tweet".length);
    expect(c.firstLine).toBe("short tweet");
  });

  test("an internal --- horizontal rule does not truncate the body (footer is the LAST ---)", () => {
    const before = "Part one of a long article. ".repeat(20).trim(); // ~560 chars
    const after = "Part two continues after the rule. ".repeat(20).trim(); // ~700 chars
    const doc = `# @writer — Writer\n\n${before}\n\n---\n\n${after}\n\n---\n\n- **Engagement:** 12 likes\n- **Type:** note`;
    const c = compactTweetText(doc, "https://x.com/writer/status/3");
    // Both halves counted — cutting at the FIRST --- would have dropped part two.
    expect(c.bodyLength).toBeGreaterThan(before.length + after.length);
    expect(c.isNote).toBe(true);
    // The gate excerpt carries the longer slice (up to its cap), not the 500-char text.
    expect(c.gateBody.length).toBeGreaterThan(500);
  });
});

// ── isLongFormTweet: the capture pre-filter ─────────────────────────

describe("isLongFormTweet", () => {
  test("a note marker qualifies regardless of length", () => {
    expect(isLongFormTweet({ isNote: true, bodyLength: 10 })).toBe(true);
  });

  test("a body >= 800 chars qualifies without a note marker", () => {
    expect(isLongFormTweet({ isNote: false, bodyLength: 800 })).toBe(true);
  });

  test("a short plain tweet is excluded", () => {
    expect(isLongFormTweet({ isNote: false, bodyLength: 799 })).toBe(false);
  });
});

// ── Collection path + capture (mocked fetch + Haiku) ────────────────

describe("fetchFromCollection + checkX capture", () => {
  const realFetch = globalThis.fetch;
  // Doc ids must start with a date inside the rolling window; use today's Oslo date.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // Three docs: a note, a plain long-form (>=800 body), and a short plain tweet.
  const longBody = "insight ".repeat(120).trim(); // ~950 chars
  const docs: Record<string, { text: string; url: string }> = {
    [`${today}_alice_1.md`]: {
      url: "https://x.com/alice/status/1",
      text: `# @alice — Alice\n\nA sharp note on eval design and why it matters.\n\n---\n\n- **Engagement:** 900 likes, 120,000 views\n- **Type:** note`,
    },
    [`${today}_bob_2.md`]: {
      url: "https://x.com/bob/status/2",
      text: `# @bob — Bob\n\n${longBody}\n\n---\n\n- **Engagement:** 200 likes`,
    },
    [`${today}_carol_3.md`]: {
      url: "https://x.com/carol/status/3",
      text: `# @carol — Carol\n\njust a quick short take\n\n---\n\n- **Engagement:** 5 likes`,
    },
  };

  function stub() {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/collection/")) {
        const documents = Object.entries(docs).map(([id, d]) => ({ id, url: d.url }));
        return { ok: true, status: 200, json: async () => ({ documents }) } as unknown as Response;
      }
      // /api/document/<collection>/<id>
      const id = decodeURIComponent(url.split("/").pop()!);
      const d = docs[id];
      if (!d) return { ok: false, status: 404 } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: d.text, metadata: { url: d.url } }),
      } as unknown as Response;
    }) as typeof fetch;
  }

  beforeEach(() => {
    gateResult = "[]";
    gateThrow = false;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    upsertThrow = false;
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const baseWatcher = (over: Partial<Watcher>): Watcher => ({
    id: "xw1",
    userId: "u1",
    botName: "jarvis",
    name: "X Highlights",
    type: "x",
    config: { collection: "x-feed", windowDays: 1 },
    intervalMs: 7_200_000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  test("fetchFromCollection returns a per-doc records array for the full batch", async () => {
    const result = await fetchFromCollection(
      { collection: "x-feed", windowDays: 1, captureCandidates: true },
      new Set<string>(),
      "jarvis",
    );
    expect(result).not.toBeNull();
    expect(result!.docs).toBeDefined();
    // All three docs fetched (not the topN-sliced digest subset).
    expect(result!.docs!.length).toBe(3);
    const alice = result!.docs!.find((d) => d.handle === "@alice")!;
    expect(alice.docId).toBe(`${today}_alice_1.md`);
    expect(alice.url).toBe("https://x.com/alice/status/1");
    expect(alice.isNote).toBe(true);
    expect(alice.firstLine).toContain("A sharp note on eval design");
    expect(typeof alice.bodyLength).toBe("number");
  });

  test("capture runs on long-form only, and BEFORE the minScore silencing", async () => {
    // Gate scores the two long-form posts (alice=note, bob=long body); carol is
    // pre-filtered out and never reaches the gate.
    gateResult = JSON.stringify([
      { n: 1, score: 0.82, why: "sharp eval insight" },
      { n: 2, score: 0.71, why: "worthwhile deep dive" },
    ]);
    // minScore + quietMode: the top rankScore is 0 (docs carry no combined/engagement
    // rank field), so the batch is silenced — yet capture still happened.
    const alerts = await checkX(
      baseWatcher({
        config: {
          collection: "x-feed",
          windowDays: 1,
          captureCandidates: true,
          candidateMinScore: 0.6,
          minScore: 0.6,
          quietMode: true,
        },
      }),
    );

    // Silenced (minScore early return): a single silent alert, no digest.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.silent).toBe(true);

    // Captured both long-form posts with source='x' + their x-feed doc ids.
    expect(upsertCalls).toHaveLength(2);
    const byUrl = Object.fromEntries(upsertCalls.map((c) => [c.url, c]));
    expect(byUrl["https://x.com/alice/status/1"]!.source).toBe("x");
    expect(byUrl["https://x.com/alice/status/1"]!.sourceDocId).toBe(`${today}_alice_1.md`);
    expect(byUrl["https://x.com/alice/status/1"]!.candidateSrc).toBe("X (@alice)");
    expect(byUrl["https://x.com/alice/status/1"]!.kind).toBe("x-post");
    expect(byUrl["https://x.com/alice/status/1"]!.title).toContain("@alice:");
    // Carol (short tweet) was pre-filtered — never captured.
    expect(byUrl["https://x.com/carol/status/3"]).toBeUndefined();
    // The gate prompt only carried the two long-form posts.
    expect(lastGatePrompt).toContain("@alice");
    expect(lastGatePrompt).toContain("@bob");
    expect(lastGatePrompt).not.toContain("quick short take");
  });

  test("candidateMinScore drops a below-floor long-form post", async () => {
    gateResult = JSON.stringify([
      { n: 1, score: 0.82, why: "keep" },
      { n: 2, score: 0.4, why: "drop" },
    ]);
    await checkX(
      baseWatcher({
        config: {
          collection: "x-feed",
          windowDays: 1,
          captureCandidates: true,
          candidateMinScore: 0.6,
        },
      }),
    );
    expect(upsertCalls.map((c) => c.url)).toEqual(["https://x.com/alice/status/1"]);
  });

  test("capture-gate error is swallowed: no capture, alert path proceeds", async () => {
    gateThrow = true;
    const alerts = await checkX(
      baseWatcher({
        config: {
          collection: "x-feed",
          windowDays: 1,
          captureCandidates: true,
          candidateMinScore: 0.6,
          minScore: 0.6,
          quietMode: true,
        },
      }),
    );
    // No candidates captured…
    expect(upsertCalls).toHaveLength(0);
    // …but the run still silenced normally (alert path unaffected by capture health).
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.silent).toBe(true);
  });

  test("a DB upsert error never breaks the alert path", async () => {
    gateResult = JSON.stringify([{ n: 1, score: 0.82, why: "x" }, { n: 2, score: 0.71, why: "y" }]);
    upsertThrow = true;
    const alerts = await checkX(
      baseWatcher({
        config: {
          collection: "x-feed",
          windowDays: 1,
          captureCandidates: true,
          candidateMinScore: 0.6,
          minScore: 0.6,
          quietMode: true,
        },
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.silent).toBe(true);
  });

  test("capture is a no-op when captureCandidates is off", async () => {
    gateResult = JSON.stringify([{ n: 1, score: 0.9, why: "x" }]);
    await checkX(
      baseWatcher({
        config: { collection: "x-feed", windowDays: 1, minScore: 0.6, quietMode: true },
      }),
    );
    expect(upsertCalls).toHaveLength(0);
    expect(lastGatePrompt).toBe(""); // gate never called
  });
});
