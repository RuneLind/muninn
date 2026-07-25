import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { Watcher } from "../types.ts";
// Captured from huginn's `GET /api/collection/x-feed/documents?include_scores=1` over the
// real corpus (the 2026-07-24 1-day window); every in-window doc carries a combined_score.
import xFeedListing from "./__fixtures__/x-feed-2026-07-24-listing.json";

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
  author?: string | null;
  authorScore?: number | null;
  sourceDocId?: string | null;
}> = [];
let upsertThrow = false;

// Author-scores loader — mocked so capture doesn't depend on the real huginn JSON file.
// normalizeHandle keeps its real behavior (so candidateSrc/author normalization is
// exercised); getAuthorScore returns a fixed lookup keyed by normalized handle.
const authorScoreByHandle: Record<string, number> = {};
// Percentile cuts returned by the mocked getAuthorTierThresholds — mutable per test so
// the tier-floor + prompt-prior paths can be exercised (null = scores file unavailable).
let authorThresholds: { top1: number; top5: number } | null = null;
mock.module("../summaries/author-scores.ts", () => ({
  normalizeHandle: (raw: string | null | undefined) => {
    if (!raw) return null;
    const bare = raw.trim().replace(/^@+/, "").toLowerCase();
    if (!bare || bare === "unknown") return null;
    return bare;
  },
  getAuthorScore: async (raw: string | null | undefined) => {
    if (!raw) return null;
    const bare = raw.trim().replace(/^@+/, "").toLowerCase();
    return authorScoreByHandle[bare] ?? null;
  },
  getAuthorTierThresholds: async () => authorThresholds,
}));
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
    author?: string | null;
    authorScore?: number | null;
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

// Log capture — the coverage warn and the `Collection: … scored=` info line are the
// only signal that tells an operator how much of the window the score-ordered cap
// could actually rank, so they're asserted directly rather than trusted.
// (mock.module leaks across src/watchers/*.test.ts in one process; sibling files
// assert nothing about logs, so a capturing stand-in logger is harmless there.)
const logLines: Array<{ level: string; message: string; props: Record<string, unknown> }> = [];
mock.module("../logging.ts", () => {
  const record = (level: string) => (message: string, props: Record<string, unknown> = {}) => {
    logLines.push({ level, message, props });
  };
  return {
    getLog: () => ({ info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") }),
    setupLogging: async () => {},
  };
});

const {
  extractRankScore,
  buildDateWindow,
  isSkipResult,
  compactTweetText,
  parseDocType,
  extractArticleUrl,
  isLongFormTweet,
  fetchFromCollection,
  checkX,
  resolveAuthorTier,
  captureFloorForTier,
  isLinkTweet,
  captureFloorForXLink,
  orderDocsForCap,
  listingCoverage,
  coverageWarning,
  DEFAULT_X_PROMPT,
  DEFAULT_X_HIGHLIGHTS_PROMPT,
} = await import("./x.ts");

// The REAL trq212 X Article doc, copied verbatim from huginn's x-feed corpus
// (`2026-07-24_trq212_2080710971228918066.md`, combined_score 0.7493). Its body is only
// the article TITLE + a ~190-char preview — exactly why the 800-char long-form fallback
// can't see this class and the `**Type:** article` marker must.
const articleDoc = await Bun.file(`${import.meta.dir}/__fixtures__/x-feed-article-trq212.md`).text();

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
    expect(c.docType).toBe("note");
    // bodyLength measures the joined body PRE-truncation, not the raw doc.
    expect(c.bodyLength).toBeGreaterThan(50);
    // The compact one-liner keeps the [ARTICLE/NOTE] marker + engagement + URL.
    expect(c.text).toContain("[ARTICLE/NOTE]");
    expect(c.text).toContain("@karpathy:");
    expect(c.text).toContain("URL: https://x.com/karpathy/status/1");
  });

  test("an X Article doc is typed `article`, keeps the [ARTICLE/NOTE] prefix, and yields the article permalink", () => {
    const c = compactTweetText(articleDoc, "https://x.com/trq212/status/2080710971228918066");
    expect(c.docType).toBe("article");
    expect(c.articleUrl).toBe("https://x.com/trq212/article/2080710971228918066");
    expect(c.handle).toBe("@trq212");
    expect(c.firstLine).toBe("The new rules of context engineering for Claude 5 models");
    expect(c.text).toContain("[ARTICLE/NOTE]");
    // The measured reason the char floor can never rescue this class.
    expect(c.bodyLength).toBeLessThan(800);
    expect(c.bodyLength).toBeGreaterThan(200);
    // The doc's `**Links:**` footer points at x.com/i/article/… — a SKIP_HOSTS host, so
    // the fetched-link parser stays empty and enrichment can't hit X's login wall.
    expect(c.links).toEqual([]);
  });

  test("a non-article doc has no articleUrl", () => {
    expect(compactTweetText(noteDoc, "https://x.com/karpathy/status/1").articleUrl).toBeNull();
  });

  test("a plain short tweet has no note marker and a small body length", () => {
    const doc = `# @someone — Name\n\nshort tweet\n\n---\n\n- **Engagement:** 3 likes`;
    const c = compactTweetText(doc, "https://x.com/someone/status/2");
    expect(c.docType).toBeNull();
    expect(c.bodyLength).toBe("short tweet".length);
    expect(c.firstLine).toBe("short tweet");
  });

  test("extracts external footer links from the plural **Links:** line only (not the permalink)", () => {
    const doc = `# @karpathy — Andrej Karpathy\n\njust dropped a 28-min video\n\n---\n\n- **Engagement:** 1,200 likes\n- **Link:** https://x.com/karpathy/status/1789\n- **Links:** https://youtu.be/abc123XYZ98`;
    const c = compactTweetText(doc, "https://x.com/karpathy/status/1789");
    // The singular **Link:** permalink is ignored; only the plural **Links:** destination.
    expect(c.links).toEqual(["https://youtu.be/abc123XYZ98"]);
  });

  test("no plural **Links:** line ⇒ empty links (permalink-only tweet)", () => {
    const doc = `# @a — A\n\nplain\n\n---\n\n- **Engagement:** 3 likes\n- **Link:** https://x.com/a/status/9`;
    expect(compactTweetText(doc, "https://x.com/a/status/9").links).toEqual([]);
  });

  test("an internal --- horizontal rule does not truncate the body (footer is the LAST ---)", () => {
    const before = "Part one of a long article. ".repeat(20).trim(); // ~560 chars
    const after = "Part two continues after the rule. ".repeat(20).trim(); // ~700 chars
    const doc = `# @writer — Writer\n\n${before}\n\n---\n\n${after}\n\n---\n\n- **Engagement:** 12 likes\n- **Type:** note`;
    const c = compactTweetText(doc, "https://x.com/writer/status/3");
    // Both halves counted — cutting at the FIRST --- would have dropped part two.
    expect(c.bodyLength).toBeGreaterThan(before.length + after.length);
    expect(c.docType).toBe("note");
    // The gate excerpt carries the longer slice (up to its cap), not the 500-char text.
    expect(c.gateBody.length).toBeGreaterThan(500);
  });
});

// ── parseDocType / extractArticleUrl (pure footer parsers) ──────────

describe("parseDocType", () => {
  test("recognizes both long-form species", () => {
    expect(parseDocType("- **Type:** note")).toBe("note");
    expect(parseDocType("- **Type:** article")).toBe("article");
  });

  test("a plain tweet or a missing line is not long-form", () => {
    expect(parseDocType("- **Type:** tweet")).toBeNull();
    expect(parseDocType("")).toBeNull();
  });
});

describe("extractArticleUrl", () => {
  test("reads the `- **Article:**` footer permalink", () => {
    expect(extractArticleUrl(articleDoc)).toBe("https://x.com/trq212/article/2080710971228918066");
  });

  test("no `**Article:**` line ⇒ null", () => {
    expect(extractArticleUrl("# @a — A\n\nplain\n\n---\n\n- **Link:** https://x.com/a/status/9")).toBeNull();
  });
});

// ── isLongFormTweet: the capture pre-filter ─────────────────────────

describe("isLongFormTweet", () => {
  test("an article marker qualifies at a SHORT body (the whole point of the widening)", () => {
    // Measured range for a real X Article doc body: ~280–460 chars, far under 800.
    expect(isLongFormTweet({ docType: "article", bodyLength: 300 })).toBe(true);
  });

  test("a note marker qualifies regardless of length", () => {
    expect(isLongFormTweet({ docType: "note", bodyLength: 10 })).toBe(true);
  });

  test("a body >= 800 chars qualifies without a note marker", () => {
    expect(isLongFormTweet({ docType: null, bodyLength: 800 })).toBe(true);
  });

  test("a short plain tweet is excluded", () => {
    expect(isLongFormTweet({ docType: null, bodyLength: 799 })).toBe(false);
  });
});

// ── Author tier resolution + per-tier capture floor (pure) ──────────

describe("resolveAuthorTier", () => {
  const th = { top1: 0.9, top5: 0.5 };

  test("score at/above top1 cut is top1", () => {
    expect(resolveAuthorTier(0.95, th)).toBe("top1");
    expect(resolveAuthorTier(0.9, th)).toBe("top1");
  });

  test("score between top5 and top1 is top5", () => {
    expect(resolveAuthorTier(0.6, th)).toBe("top5");
    expect(resolveAuthorTier(0.5, th)).toBe("top5");
  });

  test("score below top5 is null (non-top)", () => {
    expect(resolveAuthorTier(0.49, th)).toBeNull();
  });

  test("unknown score (null) is null", () => {
    expect(resolveAuthorTier(null, th)).toBeNull();
  });

  test("thresholds unavailable ⇒ null even for a high score (degrade to non-top)", () => {
    expect(resolveAuthorTier(0.99, null)).toBeNull();
  });
});

// The precedence table documented on captureFloorForTier, asserted row by row against
// the LIVE X Highlights config (candidateMinScore 0.6, no other floor knobs set).
describe("capture-floor precedence table (article vs note vs short vs x-link)", () => {
  const live = { candidateMinScore: 0.6 };

  test("article by a NON-TOP author: the 0.6 base applies, the 0.75 non-top raise does NOT", () => {
    expect(captureFloorForTier(null, live, true)).toBe(0.6);
  });

  test("article by a top author: unchanged at the base", () => {
    expect(captureFloorForTier("top5", live, true)).toBe(0.6);
  });

  test("note by a NON-TOP author: unchanged — still raised to 0.75", () => {
    expect(captureFloorForTier(null, live, false)).toBe(0.75);
  });

  test("long-form (note or ≥800ch) by a top author: unchanged at 0.6", () => {
    expect(captureFloorForTier("top5", live, false)).toBe(0.6);
  });

  test("the article exemption skips the non-top RAISE, it never undercuts a configured base", () => {
    expect(captureFloorForTier(null, { candidateMinScore: 0.85 }, true)).toBe(0.85);
    expect(captureFloorForTier(null, { candidateMinScoreByKind: { "x-post": 0.8 } }, true)).toBe(0.8);
  });

  test("x-link is unchanged by the article work (its own floor, no tier/type input)", () => {
    expect(captureFloorForXLink({})).toBe(0.7);
    expect(captureFloorForXLink({ candidateMinScoreByKind: { "x-link": 0.6 } })).toBe(0.6);
  });

  test("a short plain tweet is never eligible in the first place (pre-filter, not the floor)", () => {
    expect(isLongFormTweet({ docType: null, bodyLength: 200 })).toBe(false);
    expect(isLinkTweet({ docType: null, bodyLength: 200, links: [] }, "top1")).toBe(false);
  });
});

describe("captureFloorForTier", () => {
  test("top5/top1 authors keep the base candidateMinScore", () => {
    expect(captureFloorForTier("top5", { candidateMinScore: 0.6 })).toBe(0.6);
    expect(captureFloorForTier("top1", { candidateMinScore: 0.6 })).toBe(0.6);
  });

  test("non-top authors get max(base, non-top floor)", () => {
    expect(captureFloorForTier(null, { candidateMinScore: 0.6 })).toBe(0.75); // default non-top
    expect(captureFloorForTier(null, { candidateMinScore: 0.6, candidateMinScoreNonTop: 0.8 })).toBe(0.8);
  });

  test("non-top floor is raise-only — never undercuts a higher base", () => {
    expect(captureFloorForTier(null, { candidateMinScore: 0.85, candidateMinScoreNonTop: 0.75 })).toBe(0.85);
  });

  test("defaults: base 0.6 for top, 0.75 for non-top when unset", () => {
    expect(captureFloorForTier("top5", {})).toBe(0.6);
    expect(captureFloorForTier(null, {})).toBe(0.75);
  });

  test("candidateMinScoreByKind['x-post'] overrides the base (non-top raise still applies)", () => {
    expect(captureFloorForTier("top5", { candidateMinScoreByKind: { "x-post": 0.7 } })).toBe(0.7);
    // Non-top raise sits on top of the overridden base: max(0.7, 0.75) = 0.75.
    expect(captureFloorForTier(null, { candidateMinScoreByKind: { "x-post": 0.7 } })).toBe(0.75);
    // Override beats candidateMinScore.
    expect(captureFloorForTier("top5", { candidateMinScore: 0.6, candidateMinScoreByKind: { "x-post": 0.8 } })).toBe(0.8);
  });
});

// ── isLinkTweet: the pointer-tweet capture pre-filter ───────────────

describe("isLinkTweet", () => {
  const short = { bodyLength: 100, docType: null }; // not long-form

  test("eligible: not long-form + ≥1 link + top-author (tier set)", () => {
    expect(isLinkTweet({ ...short, links: ["https://youtu.be/x"] }, "top5")).toBe(true);
    expect(isLinkTweet({ ...short, links: ["https://youtu.be/x"] }, "top1")).toBe(true);
  });

  test("non-top author (tier null) is excluded even with a link", () => {
    expect(isLinkTweet({ ...short, links: ["https://youtu.be/x"] }, null)).toBe(false);
  });

  test("no external link ⇒ not a link-tweet", () => {
    expect(isLinkTweet({ ...short, links: [] }, "top5")).toBe(false);
  });

  test("a long-form tweet is never a link-tweet (captured as x-post instead)", () => {
    expect(isLinkTweet({ bodyLength: 900, docType: null, links: ["https://youtu.be/x"] }, "top1")).toBe(false);
    expect(isLinkTweet({ bodyLength: 10, docType: "note", links: ["https://youtu.be/x"] }, "top1")).toBe(false);
  });
});

describe("captureFloorForXLink", () => {
  test("default pointer-tweet floor is 0.7", () => {
    expect(captureFloorForXLink({})).toBe(0.7);
  });

  test("candidateMinScoreByKind['x-link'] overrides the default", () => {
    expect(captureFloorForXLink({ candidateMinScoreByKind: { "x-link": 0.6 } })).toBe(0.6);
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
    for (const k of Object.keys(authorScoreByHandle)) delete authorScoreByHandle[k];
    authorThresholds = null;
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
    expect(alice.docType).toBe("note");
    expect(alice.firstLine).toContain("A sharp note on eval design");
    expect(typeof alice.bodyLength).toBe("number");
  });

  test("capture runs on long-form only, and BEFORE the minScore silencing", async () => {
    // Gate scores the two long-form posts (alice=note, bob=long body); carol is
    // pre-filtered out and never reaches the gate. Both scores clear the stricter
    // non-top floor (0.75) — thresholds is null here, so tier gating isn't the subject
    // of this test (the per-tier floor has its own cases below).
    gateResult = JSON.stringify([
      { n: 1, score: 0.82, why: "sharp eval insight" },
      { n: 2, score: 0.78, why: "worthwhile deep dive" },
    ]);
    authorScoreByHandle["alice"] = 0.55; // ranked author → captured with a score
    // bob intentionally absent → authorScore null (handle still normalized + stored)
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
    // Author transparency: normalized handle + looked-up score for a ranked author.
    expect(byUrl["https://x.com/alice/status/1"]!.author).toBe("alice");
    expect(byUrl["https://x.com/alice/status/1"]!.authorScore).toBe(0.55);
    // bob is long-form + captured, but absent from the ranking → handle stored, score null.
    expect(byUrl["https://x.com/bob/status/2"]!.author).toBe("bob");
    expect(byUrl["https://x.com/bob/status/2"]!.authorScore).toBeNull();
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

  test("per-tier floor: a top-5% author keeps 0.6 while a non-top author needs 0.75", async () => {
    authorThresholds = { top1: 0.9, top5: 0.5 };
    authorScoreByHandle["alice"] = 0.55; // top-5% (>= top5, < top1)
    // bob absent from the ranking → tier null → stricter non-top floor (default 0.75)
    // Both score 0.65 from the gate: alice clears her 0.6 floor, bob is below 0.75.
    gateResult = JSON.stringify([
      { n: 1, score: 0.65, why: "alice keep" },
      { n: 2, score: 0.65, why: "bob drop" },
    ]);
    await checkX(
      baseWatcher({
        config: {
          collection: "x-feed",
          windowDays: 1,
          captureCandidates: true,
          candidateMinScore: 0.6,
          // candidateMinScoreNonTop unset → default 0.75
        },
      }),
    );
    expect(upsertCalls.map((c) => c.url)).toEqual(["https://x.com/alice/status/1"]);
    expect(upsertCalls[0]!.authorScore).toBe(0.55);
  });

  test("thresholds unavailable ⇒ every author is non-top ⇒ stricter floor applies globally", async () => {
    authorThresholds = null; // scores file unavailable
    authorScoreByHandle["alice"] = 0.99; // would be top-tier, but no thresholds ⇒ non-top
    // alice scores 0.7 — clears 0.6 but not the non-top 0.75.
    gateResult = JSON.stringify([
      { n: 1, score: 0.7, why: "alice" },
      { n: 2, score: 0.8, why: "bob" },
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
    // alice dropped (0.7 < 0.75), bob kept (0.8 >= 0.75) — the safe degrade direction.
    expect(upsertCalls.map((c) => c.url)).toEqual(["https://x.com/bob/status/2"]);
  });

  test("gate prompt carries the author-rank prior (tier only) for ranked authors, none for unknown", async () => {
    authorThresholds = { top1: 0.9, top5: 0.5 };
    authorScoreByHandle["alice"] = 0.95; // top 1%
    authorScoreByHandle["bob"] = 0.6; // top 5%
    gateResult = "[]"; // scoring irrelevant — we assert the prompt only
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
    expect(lastGatePrompt).toContain("author rank: top 1% of tracked authors");
    expect(lastGatePrompt).toContain("author rank: top 5% of tracked authors");
    // Tier only — never the raw float.
    expect(lastGatePrompt).not.toContain("0.95");
    expect(lastGatePrompt).not.toContain("0.6 of");
  });

  test("no author-rank line when thresholds are unavailable", async () => {
    authorThresholds = null;
    authorScoreByHandle["alice"] = 0.95;
    gateResult = "[]";
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
    expect(lastGatePrompt).not.toContain("author rank:");
  });
});

// ── Link-tweet (x-link) capture: pointer tweets by top authors ───────

describe("link-tweet (x-link) capture", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // dave: a SHORT tweet (not long-form) pointing at a YouTube video via the plural
  // **Links:** footer. erin: a short tweet with NO external link (control — never x-link).
  const docs: Record<string, { text: string; url: string }> = {
    [`${today}_dave_10.md`]: {
      url: "https://x.com/dave/status/10",
      text: `# @dave — Dave\n\nMust-watch: 28-min deep dive on agent design\n\n---\n\n- **Engagement:** 800 likes, 90,000 views\n- **Link:** https://x.com/dave/status/10\n- **Links:** https://youtu.be/AGENTvid001`,
    },
    [`${today}_erin_11.md`]: {
      url: "https://x.com/erin/status/11",
      text: `# @erin — Erin\n\njust a plain short take, no link\n\n---\n\n- **Engagement:** 10 likes\n- **Link:** https://x.com/erin/status/11`,
    },
  };

  function stub() {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/collection/")) {
        const documents = Object.entries(docs).map(([id, d]) => ({ id, url: d.url }));
        return { ok: true, status: 200, json: async () => ({ documents }) } as unknown as Response;
      }
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
    for (const k of Object.keys(authorScoreByHandle)) delete authorScoreByHandle[k];
    authorThresholds = null;
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const baseWatcher = (over: Partial<Watcher>): Watcher => ({
    id: "xw2",
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

  // minScore + quietMode silence the digest path (fixtures carry no rank field ⇒
  // rankScore 0 < 0.6 ⇒ silent early return, no digest spawnHaiku), so lastGatePrompt
  // reflects ONLY the capture gate — not the digest prompt that also runs otherwise.
  const captureOnly = { collection: "x-feed", windowDays: 1, captureCandidates: true, minScore: 0.6, quietMode: true } as const;

  test("a top-author pointer tweet is captured as x-link, gate line names the destination", async () => {
    authorThresholds = { top1: 0.9, top5: 0.5 };
    authorScoreByHandle["dave"] = 0.7; // top-5%
    gateResult = JSON.stringify([{ n: 1, score: 0.75, why: "worth the watch" }]);
    await checkX(baseWatcher({ config: { ...captureOnly } }));
    // Only dave (the pointer tweet) is eligible; erin has no link, is not long-form.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.url).toBe("https://x.com/dave/status/10");
    expect(upsertCalls[0]!.kind).toBe("x-link");
    expect(upsertCalls[0]!.sourceDocId).toBe(`${today}_dave_10.md`);
    // Gate line names the destination for the x-link, so the model weighs the linked video.
    expect(lastGatePrompt).toContain("links to: youtu.be — https://youtu.be/AGENTvid001");
    // erin (no link) never reached the gate.
    expect(lastGatePrompt).not.toContain("@erin");
  });

  test("a non-top-author pointer tweet is NOT captured (link-tweets are top-author-only)", async () => {
    authorThresholds = { top1: 0.9, top5: 0.5 };
    authorScoreByHandle["dave"] = 0.3; // below top5 ⇒ tier null ⇒ excluded
    gateResult = JSON.stringify([{ n: 1, score: 0.95, why: "high but ineligible" }]);
    await checkX(baseWatcher({ config: { ...captureOnly } }));
    expect(upsertCalls).toHaveLength(0);
    // The capture gate was never even called — eligibility (dave non-top, erin no
    // link) excluded every doc before the gate, so lastGatePrompt stays untouched.
    expect(lastGatePrompt).toBe("");
  });

  test("x-link floor is 0.7 by default: a 0.65 pointer tweet is dropped", async () => {
    authorThresholds = { top1: 0.9, top5: 0.5 };
    authorScoreByHandle["dave"] = 0.7; // top-5% (eligible), but score below the 0.7 x-link floor
    gateResult = JSON.stringify([{ n: 1, score: 0.65, why: "borderline" }]);
    await checkX(baseWatcher({ config: { ...captureOnly } }));
    expect(upsertCalls).toHaveLength(0);
  });
});

// ── Rank read prefers whitelisted metadata combined_score over text regex ──

describe("fetchFromCollection rank read (metadata-preferred)", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  let docs: Record<string, { text: string; url: string; metadata?: Record<string, unknown> }> = {};

  function stub() {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/collection/")) {
        const documents = Object.entries(docs).map(([id, d]) => ({ id, url: d.url }));
        return { ok: true, status: 200, json: async () => ({ documents }) } as unknown as Response;
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      const d = docs[id];
      if (!d) return { ok: false, status: 404 } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: d.text, metadata: d.metadata ?? { url: d.url } }),
      } as unknown as Response;
    }) as typeof fetch;
  }

  beforeEach(() => {
    docs = {};
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("metadata combined_score (a STRING) beats the in-text regex fallback", async () => {
    docs = {
      [`${today}_a_1.md`]: {
        url: "https://x.com/a/status/1",
        // Served text carries a LOW score; the whitelisted metadata carries the real one.
        text: `# @a — A\n\ncombined_score: 0.10 mentioned in the body\n\n---\n\n- **Engagement:** 5 likes`,
        metadata: { url: "https://x.com/a/status/1", combined_score: "0.8028" },
      },
    };
    const r = await fetchFromCollection({ collection: "x-feed", windowDays: 1 }, new Set<string>(), "jarvis");
    // The string "0.8028" is Number-coerced (load-bearing) — metadata wins over 0.10.
    expect(r!.topScore).toBe(0.8028);
  });

  test("absent metadata combined_score falls back to the in-text regex", async () => {
    docs = {
      [`${today}_b_2.md`]: {
        url: "https://x.com/b/status/2",
        text: `# @b — B\n\ncombined_score: 0.55 in the body\n\n---\n\n- **Engagement:** 5 likes`,
        metadata: { url: "https://x.com/b/status/2" }, // no combined_score
      },
    };
    const r = await fetchFromCollection({ collection: "x-feed", windowDays: 1 }, new Set<string>(), "jarvis");
    expect(r!.topScore).toBe(0.55);
  });

  test("non-numeric metadata combined_score is ignored ⇒ text-regex fallback", async () => {
    docs = {
      [`${today}_c_3.md`]: {
        url: "https://x.com/c/status/3",
        text: `# @c — C\n\nengagement_score: 0.42 in the body\n\n---\n\n- **Engagement:** 5 likes`,
        metadata: { url: "https://x.com/c/status/3", combined_score: "n/a" },
      },
    };
    const r = await fetchFromCollection({ collection: "x-feed", windowDays: 1 }, new Set<string>(), "jarvis");
    // Number("n/a") is NaN ⇒ not finite ⇒ fall back to extractRankScore (engagement 0.42).
    expect(r!.topScore).toBe(0.42);
  });
});

// ── fetchFromCollection wiring for the score-ordered cap ────────────

describe("fetchFromCollection score-ordered cap wiring", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  let listingUrl = "";
  let listing: Array<{ id: string; url: string; combined_score?: number | string }> = [];

  function stub() {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/collection/")) {
        listingUrl = url;
        return { ok: true, status: 200, json: async () => ({ documents: listing }) } as unknown as Response;
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          text: `# @x — X\n\nbody\n\n---\n\n- **Engagement:** 5 likes`,
          metadata: { url: `https://x.com/x/status/${id}` },
        }),
      } as unknown as Response;
    }) as typeof fetch;
  }

  const dayOffset = (n: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Oslo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Date.now() - n * 86_400_000));

  beforeEach(() => {
    listingUrl = "";
    listing = [];
    logLines.length = 0;
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("asks huginn for include_scores", async () => {
    listing = [{ id: `${today}_a_1.md`, url: "https://x.com/a/status/1", combined_score: "0.5" }];
    await fetchFromCollection({ collection: "x-feed", windowDays: 1 }, new Set<string>(), "jarvis");
    expect(listingUrl).toContain("include_scores=1");
  });

  test("maxDocs keeps the TOP-scoring docs, not the alphabetically-first ones", async () => {
    listing = [
      { id: `${today}_aaa_1.md`, url: "https://x.com/aaa/status/1", combined_score: "0.10" },
      { id: `${today}_bbb_2.md`, url: "https://x.com/bbb/status/2", combined_score: "0.20" },
      { id: `${today}_zzz_3.md`, url: "https://x.com/zzz/status/3", combined_score: "0.90" },
    ];
    const r = await fetchFromCollection(
      { collection: "x-feed", windowDays: 1, maxDocs: 1, captureCandidates: true },
      new Set<string>(),
      "jarvis",
    );
    // Alphabetically the cap would have taken aaa; by score it takes zzz.
    expect(r!.docs!.map((d) => d.docId)).toEqual([`${today}_zzz_3.md`]);
  });

  test("the Collection info line reports the scored FRACTION of the window", async () => {
    listing = [
      { id: `${today}_aaa_1.md`, url: "https://x.com/aaa/status/1", combined_score: "0.10" },
      { id: `${today}_bbb_2.md`, url: "https://x.com/bbb/status/2" },
      { id: `${today}_ccc_3.md`, url: "https://x.com/ccc/status/3", combined_score: "0.90" },
    ];
    await fetchFromCollection({ collection: "x-feed", windowDays: 1 }, new Set<string>(), "jarvis");
    const info = logLines.find((l) => l.level === "info" && l.message.startsWith("Collection:"));
    expect(info).toBeDefined();
    expect(info!.message).toContain("scored={scored}");
    expect(info!.props.scored).toBe("2/3");
  });

  test("healthy coverage logs no degrade warn", async () => {
    listing = [
      { id: `${today}_aaa_1.md`, url: "https://x.com/aaa/status/1", combined_score: "0.10" },
      { id: `${today}_bbb_2.md`, url: "https://x.com/bbb/status/2", combined_score: "0.90" },
    ];
    await fetchFromCollection({ collection: "x-feed", windowDays: 1 }, new Set<string>(), "jarvis");
    expect(logLines.filter((l) => l.level === "warn")).toEqual([]);
  });

  // ── B7: partial coverage, date-major listing ──────────────────────
  // Ids are date-major and localeCompare puts the OLDEST date first, so a block of
  // unscored docs at the alphabetical HEAD occupies the cap outright — the scored docs
  // behind them never make the cut. That is the positional hold working as specified
  // (each unscored doc keeps exactly its old cap odds), not a bug — but it means the
  // score-ordering did nothing this run, which is precisely what the warn is for.
  test("an unscored date-block at the alphabetical HEAD consumes the cap, and the low-coverage warn fires", async () => {
    const older = dayOffset(5);
    const newer = dayOffset(0);
    const unscored = Array.from({ length: 12 }, (_, i) => ({
      id: `${older}_h${String(i).padStart(2, "0")}_${i}.md`,
      url: `https://x.com/h/status/${i}`,
    }));
    const scored = Array.from({ length: 8 }, (_, i) => ({
      id: `${newer}_s${String(i).padStart(2, "0")}_${100 + i}.md`,
      url: `https://x.com/s/status/${100 + i}`,
      combined_score: (0.9 - i * 0.01).toFixed(3),
    }));
    listing = [...scored, ...unscored]; // deliberately not pre-sorted

    const r = await fetchFromCollection(
      { collection: "x-feed", windowDays: 7, maxDocs: 10, captureCandidates: true },
      new Set<string>(),
      "jarvis",
    );

    // 8/20 = 40% coverage ⇒ every cap slot is a pinned unscored doc; not one scored
    // doc is even fetched. This is the positional hold working as specified.
    expect(r!.docs!.map((d) => d.docId)).toEqual(unscored.slice(0, 10).map((d) => d.id));

    const warn = logLines.find((l) => l.level === "warn" && l.message.includes("carry a listing score"));
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("8/20");
    expect(warn!.message).toContain("40.0%");
  });
});

// ── End-to-end replay: a REAL X Article doc through checkX ──────────
// The whole shelf leg in one pass, on the live X Highlights config, against the
// verbatim trq212 doc re-dated into today's window (on disk it is 2026-07-24, out of
// a 1–2 day window today). Proves: article ⇒ long-form ⇒ x-post, the 0.6 floor applies
// while the 0.75 non-top raise does not (trq212 is UNRANKED here — thresholds null ⇒
// tier null, the strictest degrade), and the candidate row points at the ARTICLE url.

describe("checkX: X Article capture (real-doc replay)", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const docId = `${today}_trq212_2080710971228918066.md`;
  const tweetUrl = "https://x.com/trq212/status/2080710971228918066";
  const articleUrl = "https://x.com/trq212/article/2080710971228918066";
  // The doc's own frontmatter score — the value huginn serves in the listing/metadata.
  const combinedScore = "0.7493";

  beforeEach(() => {
    gateResult = "[]";
    gateThrow = false;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    upsertThrow = false;
    for (const k of Object.keys(authorScoreByHandle)) delete authorScoreByHandle[k];
    authorThresholds = null; // scores file unavailable ⇒ every author is non-top
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/collection/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ documents: [{ id: docId, url: tweetUrl, combined_score: combinedScore }] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: articleDoc, metadata: { url: tweetUrl, combined_score: combinedScore } }),
      } as unknown as Response;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const watcher = (): Watcher => ({
    id: "xw-article",
    userId: "u1",
    botName: "jarvis",
    name: "X Highlights",
    type: "x",
    // The live X Highlights config (windowDays raised to the 2 this PR prepares).
    config: {
      collection: "x-feed",
      windowDays: 2,
      maxDocs: 80,
      topN: 10,
      minScore: 0.6,
      quietMode: true,
      dedupByTweetId: true,
      captureCandidates: true,
      candidateMinScore: 0.6,
    },
    intervalMs: 7_200_000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  });

  test("an article by a non-top author is captured as x-post at the 0.6 floor, keyed on the ARTICLE url", async () => {
    // 0.65: clears the x-post base (0.6) but NOT the non-top raise (0.75) — so this row
    // only exists because `**Type:** article` exempts it from the raise.
    gateResult = JSON.stringify([{ n: 1, score: 0.65, why: "context-engineering rules for Claude 5" }]);

    await checkX(watcher(), undefined, "jarvis");

    expect(upsertCalls.length).toBe(1);
    const row = upsertCalls[0]!;
    expect(row.source).toBe("x");
    expect(row.kind).toBe("x-post");
    expect(row.author).toBe("trq212");
    expect(row.url).toBe(articleUrl); // NOT the announcing tweet
    expect(row.title).toBe("@trq212: The new rules of context engineering for Claude 5 models");
    expect(row.candidateSrc).toBe("X (@trq212)");
    expect(row.sourceDocId).toBe(docId); // how the summarizer resolves content
    expect(row.score).toBe(0.65);

    // It reached the gate as long-form, prefixed like a note.
    expect(lastGatePrompt).toContain("[ARTICLE/NOTE] @trq212:");
  });

  test("the doc clears the alert minScore 0.6 at its real combined_score 0.7493", async () => {
    gateResult = "[]";
    const alerts = await checkX(watcher(), undefined, "jarvis");
    // Not the silent below-minScore early return: quietMode's SKIP-less digest alerts.
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.silent).toBeUndefined();
  });

  test("a below-0.6 gate score is still rejected — the exemption drops the raise, not the floor", async () => {
    gateResult = JSON.stringify([{ n: 1, score: 0.59, why: "meh" }]);
    await checkX(watcher(), undefined, "jarvis");
    expect(upsertCalls.length).toBe(0);
  });
});

// ── Listing-score coverage reporting ────────────────────────────────

describe("listingCoverage / coverageWarning", () => {
  const d = (id: string, combined_score?: unknown) =>
    ({ id, url: `https://x.com/${id}`, combined_score } as unknown as { id: string; url: string });

  test("counts only docs with a usable score", () => {
    expect(listingCoverage([d("a", 0.5), d("b"), d("c", "0.25"), d("d", " ")])).toEqual({ scored: 2, total: 4 });
  });

  test("an empty listing warns about nothing", () => {
    expect(coverageWarning({ scored: 0, total: 0 })).toBeNull();
  });

  test("ZERO scored docs reads as missing enrichment, not as a lagging scorer", () => {
    const msg = coverageWarning({ scored: 0, total: 389 })!;
    expect(msg).toContain("No listing scores on any of 389 docs");
    expect(msg).toContain("include_scores");
  });

  test("the live 38.6%-coverage Weekly window warns with counts", () => {
    const msg = coverageWarning({ scored: 291, total: 754 })!;
    expect(msg).toContain("291/754");
    expect(msg).toContain("38.6%");
    expect(msg).toContain("mostly alphabetical");
  });

  test("coverage at or above 50% is not warned about", () => {
    expect(coverageWarning({ scored: 5, total: 10 })).toBeNull();
    expect(coverageWarning({ scored: 1936, total: 1936 })).toBeNull();
  });

  test("just under half still warns", () => {
    expect(coverageWarning({ scored: 4, total: 10 })).toContain("4/10");
  });
});

// ── Score-ordered document cap (orderDocsForCap) ────────────────────

describe("orderDocsForCap", () => {
  const doc = (id: string, combined_score?: number | string | null) =>
    ({ id, url: `https://x.com/${id}`, ...(combined_score === undefined ? {} : { combined_score }) });

  test("sorts score-descending, not alphabetically", () => {
    const out = orderDocsForCap([doc("2026-07-24_aaa_1.md", 0.2), doc("2026-07-24_zzz_2.md", 0.9)]);
    expect(out.map((d) => d.id)).toEqual(["2026-07-24_zzz_2.md", "2026-07-24_aaa_1.md"]);
  });

  test("coerces STRING scores — a lexicographic sort would rank 0.9 below 0.1234", () => {
    const out = orderDocsForCap([doc("2026-07-24_a_1.md", "0.1234"), doc("2026-07-24_b_2.md", "0.9")]);
    expect(out.map((d) => d.id)).toEqual(["2026-07-24_b_2.md", "2026-07-24_a_1.md"]);
  });

  test("ties break on localeCompare so the cap is deterministic", () => {
    const forward = orderDocsForCap([doc("2026-07-24_b_2.md", 0.5), doc("2026-07-24_a_1.md", 0.5)]);
    const reverse = orderDocsForCap([doc("2026-07-24_a_1.md", 0.5), doc("2026-07-24_b_2.md", 0.5)]);
    expect(forward.map((d) => d.id)).toEqual(["2026-07-24_a_1.md", "2026-07-24_b_2.md"]);
    expect(reverse.map((d) => d.id)).toEqual(forward.map((d) => d.id));
  });

  test("an unscored doc HOLDS its alphabetical index — it neither rises nor sinks", () => {
    // Alphabetical: [a(0.1), b(none), c(0.9)]. b sits at index 1 and stays at index 1;
    // a and c are score-sorted into the leftover slots 0 and 2.
    const out = orderDocsForCap([
      doc("2026-07-24_a_1.md", 0.1),
      doc("2026-07-24_b_2.md"),
      doc("2026-07-24_c_3.md", 0.9),
    ]);
    expect(out.map((d) => d.id)).toEqual([
      "2026-07-24_c_3.md", // highest score → first free slot
      "2026-07-24_b_2.md", // pinned at its alphabetical index
      "2026-07-24_a_1.md",
    ]);
  });

  test("a freshly-ingested unscored doc is not cap-dropped by the reordering", () => {
    // The real transient: huginn's fetch and score phases are separate, so the newest
    // docs are briefly scoreless. `fresh` sits alphabetically inside a cap of 3.
    const docs = [
      doc("2026-07-24_aaa_1.md", 0.9),
      doc("2026-07-24_fresh_2.md"), // unscored
      doc("2026-07-24_mmm_3.md", 0.8),
      doc("2026-07-24_zzz_4.md", 0.7),
    ];
    const capped = orderDocsForCap(docs).slice(0, 3).map((d) => d.id);
    expect(capped).toContain("2026-07-24_fresh_2.md");
    // ...and it kept exactly the slot it had alphabetically (index 1), no promotion.
    expect(capped[1]).toBe("2026-07-24_fresh_2.md");
  });

  test("null/empty scores count as missing, not as 0 (Number(null) === 0 would sink them)", () => {
    const out = orderDocsForCap([
      doc("2026-07-24_a_1.md", 0.1),
      doc("2026-07-24_b_2.md", null),
      doc("2026-07-24_c_3.md", ""),
      doc("2026-07-24_d_4.md", "not-a-number"),
      doc("2026-07-24_e_5.md", 0.9),
    ]);
    // b, c and d hold alphabetical indices 1, 2, 3; e (0.9) and a (0.1) fill 0 and 4.
    expect(out.map((d) => d.id)).toEqual([
      "2026-07-24_e_5.md",
      "2026-07-24_b_2.md",
      "2026-07-24_c_3.md",
      "2026-07-24_d_4.md",
      "2026-07-24_a_1.md",
    ]);
  });

  // A bare `Number()` would make every one of these finite and mis-rank the doc:
  // `true` → 1 (tops the whole listing), `false`/`" "` → 0 (sinks it below every real
  // score), `"0x10"` → 16 (tops it even harder). huginn's server-side guard accepts
  // none of them, so neither does the listing read — all four count as UNSCORED and
  // hold their alphabetical slot.
  test("booleans, whitespace-only and hex strings are NOT scores", () => {
    const rawDoc = (id: string, combined_score: unknown) =>
      ({ id, url: `https://x.com/${id}`, combined_score }) as unknown as { id: string; url: string };
    const out = orderDocsForCap([
      rawDoc("2026-07-24_a_1.md", true),
      rawDoc("2026-07-24_b_2.md", false),
      rawDoc("2026-07-24_c_3.md", " "),
      rawDoc("2026-07-24_d_4.md", "0x10"),
      rawDoc("2026-07-24_e_5.md", 0.9),
      rawDoc("2026-07-24_f_6.md", 0.1),
    ]);
    // a–d pinned at 0–3; only e and f are ranked, into the leftover slots 4 and 5.
    expect(out.map((d) => d.id)).toEqual([
      "2026-07-24_a_1.md",
      "2026-07-24_b_2.md",
      "2026-07-24_c_3.md",
      "2026-07-24_d_4.md",
      "2026-07-24_e_5.md",
      "2026-07-24_f_6.md",
    ]);
  });

  test("padded and exponent decimal strings ARE scores", () => {
    const out = orderDocsForCap([doc("2026-07-24_a_1.md", "  0.75  "), doc("2026-07-24_b_2.md", "9e-1")]);
    expect(out.map((d) => d.id)).toEqual(["2026-07-24_b_2.md", "2026-07-24_a_1.md"]);
  });

  // The all-unscored fallback is covered end-to-end by the real-corpus replay below
  // ("with the listing UNSCORED the cap is byte-identical to the old behavior").

  test("empty input is safe", () => {
    expect(orderDocsForCap([])).toEqual([]);
  });

  test("is a permutation — no doc is dropped or duplicated", () => {
    const docs = [doc("d", 0.4), doc("a"), doc("c", 0.9), doc("b"), doc("e", 0.1)];
    const out = orderDocsForCap(docs);
    expect(out.length).toBe(docs.length);
    expect(new Set(out.map((d) => d.id))).toEqual(new Set(docs.map((d) => d.id)));
  });
});

// ── Replay over the REAL 2026-07-24 x-feed listing (389 in-window docs) ──

describe("orderDocsForCap replay — real x-feed corpus, 2026-07-24 1-day window", () => {
  const listing: Array<{ id: string; url: string; combined_score?: number }> = xFeedListing;
  const MAX_DOCS = 80; // DEFAULT_MAX_DOCS

  test("fixture is the full in-window day", () => {
    expect(listing.length).toBe(389);
    expect(listing.every((d) => d.id.startsWith("2026-07-24_"))).toBe(true);
  });

  test("the capped set IS the in-window score top-80", () => {
    const capped = orderDocsForCap(listing).slice(0, MAX_DOCS);
    const expected = [...listing]
      .sort((a, b) => b.combined_score! - a.combined_score! || a.id.localeCompare(b.id))
      .slice(0, MAX_DOCS);
    expect(capped.map((d) => d.id)).toEqual(expected.map((d) => d.id));
  });

  test("thdxr's 0.604 doc makes the cap (it is rank 39 by score)", () => {
    const capped = orderDocsForCap(listing).slice(0, MAX_DOCS);
    const thdxr = capped.find((d) => d.id.includes("_thdxr_"));
    expect(thdxr).toBeDefined();
    expect(thdxr!.combined_score).toBe(0.604);
    expect(capped.indexOf(thdxr!)).toBe(38); // 0-indexed rank 39
  });

  test("the 80th-place score is the real cut bar (~0.56)", () => {
    const capped = orderDocsForCap(listing).slice(0, MAX_DOCS);
    // The set-equality test above already proves everything kept clears this bar.
    expect(capped[MAX_DOCS - 1]!.combined_score!).toBe(0.5598);
  });

  test("the OLD alphabetical cap stopped in the B's and dropped thdxr", () => {
    const alphabetical = [...listing].sort((a, b) => a.id.localeCompare(b.id));
    const oldCap = alphabetical.slice(0, MAX_DOCS);
    // The cut lands mid-alphabet by handle — the whole defect this PR fixes.
    expect(oldCap[MAX_DOCS - 1]!.id).toBe("2026-07-24_ben_burtenshaw_2080661125822030164.md");
    expect(alphabetical[MAX_DOCS]!.id).toBe("2026-07-24_BharukaShraddha_2080630911889297858.md");
    expect(oldCap.some((d) => d.id.includes("_thdxr_"))).toBe(false);
  });

  test("with the listing UNSCORED the cap is byte-identical to the old behavior", () => {
    const unscored = listing.map((d) => ({ id: d.id, url: d.url }));
    const out = orderDocsForCap(unscored).slice(0, MAX_DOCS);
    const alphabetical = [...unscored].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_DOCS);
    expect(out.map((d) => d.id)).toEqual(alphabetical.map((d) => d.id));
  });
});

// ── Prompt topic-constraint content (pure string assertions) ────────

const TOPIC_BASELINE =
  "AI, LLMs and agents, developer tools, software engineering, open source, cloud/infrastructure, and tech industry news";

describe("default prompt topic constraints", () => {
  test("DEFAULT_X_PROMPT declares the topic baseline, off-topic skip clause, and drops view-to-like", () => {
    expect(DEFAULT_X_PROMPT).toContain(TOPIC_BASELINE);
    expect(DEFAULT_X_PROMPT).toContain("regardless of how high its engagement is");
    expect(DEFAULT_X_PROMPT.toLowerCase()).not.toContain("view-to-like");
  });

  test("DEFAULT_X_HIGHLIGHTS_PROMPT scopes 'exceptional' to the baseline topics + off-topic exclusion", () => {
    expect(DEFAULT_X_HIGHLIGHTS_PROMPT).toContain(TOPIC_BASELINE);
    expect(DEFAULT_X_HIGHLIGHTS_PROMPT).toContain("regardless of how high its engagement is");
  });
});

// ── Assembled digest wrapper is ranking-neutral (item 3b) ───────────

describe("runAlertPath framing wrapper (fronts Daily/Highlights/Weekly)", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const docs: Record<string, { text: string; url: string; metadata: Record<string, unknown> }> = {
    [`${today}_c_3.md`]: {
      url: "https://x.com/c/status/3",
      text: `# @c — C\n\na tweet about LLM agents and eval design\n\n---\n\n- **Engagement:** 50 likes`,
      metadata: { url: "https://x.com/c/status/3", combined_score: "0.7" },
    },
  };

  function stub() {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/collection/")) {
        const documents = Object.entries(docs).map(([id, d]) => ({ id, url: d.url }));
        return { ok: true, status: 200, json: async () => ({ documents }) } as unknown as Response;
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      const d = docs[id];
      if (!d) return { ok: false, status: 404 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ text: d.text, metadata: d.metadata }) } as unknown as Response;
    }) as typeof fetch;
  }

  beforeEach(() => {
    gateResult = "[]";
    gateThrow = false;
    lastGatePrompt = "";
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const baseWatcher = (over: Partial<Watcher>): Watcher => ({
    id: "xw3",
    userId: "u1",
    botName: "jarvis",
    name: "X Daily Digest",
    type: "x",
    config: { collection: "x-feed", windowDays: 1 },
    intervalMs: 86_400_000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  test("assembled digest prompt is relevance-framed, not engagement-ranked", async () => {
    // No minScore/quietMode and captureCandidates off ⇒ the ONLY spawnHaiku call is the
    // digest, so lastGatePrompt is exactly the assembled digest prompt (wrapper + prompt).
    await checkX(baseWatcher({ config: { collection: "x-feed", windowDays: 1 } }));
    expect(lastGatePrompt).toContain("pre-ranked by relevance to the user's interests");
    // The stale engagement-ranking framing is gone. Assert the EXACT phrases only — the
    // bare token "engagement" legitimately survives in DEFAULT_X_PROMPT ("engagement bait",
    // "how high its engagement is").
    expect(lastGatePrompt.toLowerCase()).not.toContain("engagement score");
    expect(lastGatePrompt.toLowerCase()).not.toContain("highest engagement first");
  });
});
