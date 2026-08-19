import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { Watcher } from "../types.ts";
import { withInterestProfile } from "../profile/inject.ts";
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
// Retry/budget observability: every spawnHaiku call records the timeoutMs it was handed,
// and `gateThrowFirstN` fails exactly the first N calls so the retry path is testable
// without disturbing the always-throw `gateThrow` the older tests use.
const gateCalls: Array<{ timeoutMs?: number; source?: string }> = [];
/** Capture-gate calls only — `checkX` also spawns the digest call on the alert path. */
const captureGateCalls = () => gateCalls.filter((c) => c.source === "watcher-x-capture");
let gateThrowFirstN = 0;
// Injected clock for the budget tests: a capture-gate call advances the offset by
// `gateClockAdvanceMs`, so an attempt can "take" minutes without the test waiting for
// them (and without any wall-clock-dependent assertion). `Date.now` is patched ONLY for
// the duration of the test that needs it (`withInjectedClock`) — a process-wide patch
// leaks across describes AND across sibling watcher test files in the same run.
let gateClockAdvanceMs = 0;
let clockOffsetMs = 0;
const realDateNow = Date.now.bind(Date);
async function withInjectedClock(advanceMs: number, fn: () => Promise<void>): Promise<void> {
  gateClockAdvanceMs = advanceMs;
  clockOffsetMs = 0;
  Date.now = () => realDateNow() + clockOffsetMs;
  try {
    await fn();
  } finally {
    Date.now = realDateNow;
    gateClockAdvanceMs = 0;
    clockOffsetMs = 0;
  }
}
mock.module("../scheduler/executor.ts", () => ({
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  spawnHaiku: async (prompt: string, opts?: { timeoutMs?: number; source?: string }) => {
    lastGatePrompt = prompt;
    gateCalls.push({ timeoutMs: opts?.timeoutMs, source: opts?.source });
    if (opts?.source === "watcher-x-capture") clockOffsetMs += gateClockAdvanceMs;
    if (gateThrow) throw new Error("haiku down");
    if (opts?.source === "watcher-x-capture" && captureGateCalls().length <= gateThrowFirstN) {
      throw new Error("haiku timed out");
    }
    return { result: gateResult, inputTokens: 0, outputTokens: 0, model: "claude-haiku-4-5-20251001" };
  },
}));

interface UpsertParams {
  source: string;
  url: string;
  title: string;
  candidateSrc?: string | null;
  score: number;
  why?: string | null;
  kind?: string | null;
  author?: string | null;
  authorScore?: number | null;
  sourceDocId?: string | null;
}
/** Every write, in order, tagged with WHICH writer the capture path chose. */
const upsertCalls: Array<UpsertParams & { writer?: "shared" | "destination" }> = [];
let upsertThrow = false;

// A tiny stand-in for the `summary_candidates` table, so the destination-keying tests
// can assert the row that SURVIVES across runs (not just the calls made). Only the
// destination writer's semantics are modelled — one coherent set per admission,
// higher score wins, non-`new` rows are never touched.
interface StoredCandidate extends UpsertParams {
  status: "new" | "dismissed" | "summarized" | "summarizing" | "error";
  /** 'manual' (terminal) vs 'expired' (re-admittable) — mirrors the real column. */
  dismissedReason?: string | null;
  updatedAt?: number;
}
const candidateRows = new Map<string, StoredCandidate>();
const rowKey = (source: string, url: string) => `${source}|${url}`;
const storedRow = (source: string, url: string) => candidateRows.get(rowKey(source, url));

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
  upsertCandidate: async (p: UpsertParams) => {
    if (upsertThrow) throw new Error("db down");
    upsertCalls.push({ ...p, writer: "shared" });
  },
  // Destination-keyed writer (pointer candidates). Mirrors the real SQL: insert if
  // absent; on conflict, RE-ADMITTABLE rows (`new`, `error`, and auto-expired
  // dismissals) take the WHOLE set from the incoming member when it strictly beats the
  // stored score — and always bump `updatedAt` even when they don't, so a destination
  // under continuous hype keeps refreshing its expiry clock. Manual dismissals and
  // summarized/summarizing rows are terminal. Returns whether a row was actually
  // written (the real writer's `RETURNING id` row count) — false on a terminal row.
  upsertDestinationCandidate: async (p: UpsertParams) => {
    if (upsertThrow) throw new Error("db down");
    upsertCalls.push({ ...p, writer: "destination" });
    const key = rowKey(p.source, p.url);
    const existing = candidateRows.get(key);
    if (!existing) {
      candidateRows.set(key, { ...p, status: "new", updatedAt: Date.now() });
      return true;
    }
    const readmittable =
      existing.status === "new" ||
      existing.status === "error" ||
      (existing.status === "dismissed" && existing.dismissedReason === "expired");
    if (!readmittable) return false;
    if (!(p.score > existing.score)) {
      candidateRows.set(key, { ...existing, updatedAt: Date.now() });
      return true;
    }
    candidateRows.set(key, { ...p, status: "new", dismissedReason: null, updatedAt: Date.now() });
    return true;
  },
  listCandidates: async () => [],
  getCandidateById: async () => null,
  getCandidateBySourceUrl: async () => null,
  setCandidateStatus: async () => {},
}));

// --- Step 2b: cross-run amplifier votes (stateful, mirrors the real SQL) ---
// A STATEFUL stand-in is required, not a spy: the whole feature is "the 3rd distinct
// author across 3 SEPARATE runs admits a row", which can only be asserted against
// accumulated state. Exports the FULL public surface — mock.module leaks across
// src/watchers/*.test.ts, and a partial mock would break a sibling file's module load.
interface AmplifierRow {
  urlKey: string;
  author: string;
  pointer: boolean;
  tweetPermalink?: string | null;
  sourceDocId?: string | null;
  score?: number | null;
  title?: string | null;
  why?: string | null;
}
/** Keyed `urlKey|author` — the real PRIMARY KEY (url_key, author). */
const amplifierRows = new Map<string, AmplifierRow>();
const amplifierKey = (urlKey: string, author: string) => `${urlKey}|${author}`;
let amplifierThrow = false;
mock.module("../db/x-link-amplifiers.ts", () => ({
  recordAmplifierVote: async (raw: AmplifierRow) => {
    if (amplifierThrow) throw new Error("amplifier db down");
    // Content columns are POINTER-ONLY (mirrors the real module): a long-form vote
    // records its existence, never content that could later represent the group.
    const p: AmplifierRow = raw.pointer
      ? raw
      : { urlKey: raw.urlKey, author: raw.author, pointer: false, tweetPermalink: null, sourceDocId: null, score: null, title: null, why: null };
    const key = amplifierKey(p.urlKey, p.author);
    const existing = amplifierRows.get(key);
    if (!existing) {
      amplifierRows.set(key, { ...p });
      return;
    }
    // `pointer` is sticky-TRUE (an author who has pointed keeps the franchise); the
    // content set moves only on a strictly better POINTER member.
    const pointer = existing.pointer || p.pointer;
    const wins = p.pointer && p.score != null && p.score > (existing.score ?? -1);
    amplifierRows.set(key, wins ? { ...p, pointer } : { ...existing, pointer });
  },
  getAmplifierGroup: async (urlKey: string) => {
    if (amplifierThrow) throw new Error("amplifier db down");
    const members = [...amplifierRows.values()].filter((r) => r.urlKey === urlKey && r.pointer);
    const scored = members
      .filter((r) => r.score != null)
      .sort((a, b) => b.score! - a.score! || a.author.localeCompare(b.author));
    const best = scored[0];
    return {
      pointerAuthors: new Set(members.map((r) => r.author)).size,
      best: best
        ? {
            author: best.author,
            tweetPermalink: best.tweetPermalink ?? null,
            sourceDocId: best.sourceDocId ?? null,
            score: best.score!,
            title: best.title ?? null,
            why: best.why ?? null,
          }
        : null,
    };
  },
  pruneXLinkAmplifiers: async () => 0,
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
  isAmplifierPointer,
  resolveCaptureAmplifyMin,
  DEFAULT_CAPTURE_AMPLIFY_MIN,
  captureFloorForXLink,
  captureBudgetDeadline,
  captureBudgetMs,
  captureAttemptTimeoutMs,
  orderDocsForCap,
  listingCoverage,
  coverageWarning,
  DEFAULT_X_PROMPT,
  DEFAULT_X_HIGHLIGHTS_PROMPT,
  DEFAULT_X_CAPTURE_PROMPT,
  resolveCaptureMaxItems,
  decideAdmissions,
} = await import("./x.ts");
const {
  applyCaptureLimit,
  clampScores,
  REPACKAGING_SCORE_CAP,
  withCaptureLimit,
  DEFAULT_CAPTURE_MAX_ITEMS,
  MAX_CAPTURE_MAX_ITEMS,
} = await import("./gate-scores.ts");
const { isRepackagingShaped } = await import("./repackaging-shape.ts");

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

  test("the value is matched EXACTLY — a superstring is not a species", () => {
    expect(parseDocType("- **Type:** notearticle")).toBeNull();
    expect(parseDocType("- **Type:** article thread")).toBeNull();
  });

  test("the line must be anchored — an unanchored mention is not the footer field", () => {
    expect(parseDocType("I wrote about this in **Type:** article form")).toBeNull();
  });

  test("`note` is checked first — a note that links an article stays a note", () => {
    // Upstream deliberately keeps note-with-article typed `note`; either way it is
    // long-form, so nothing is lost — but the value must not be re-read as `article`
    // (which would also exempt it from the non-top capture raise).
    expect(parseDocType("- **Type:** note")).toBe("note");
  });
});

describe("compactTweetText: author-controlled body can't forge the Type marker", () => {
  test("a body-injected `**Type:** article` line does NOT flip a plain tweet long-form", () => {
    // Unanchored mentions in author-controlled body text — the shape the old
    // `l.includes("**Type:**")` + substring parse would have read as long-form.
    const doc = `# @spammer — Spam\n\nread my **Type:** article now, it is a real article\n\n---\n\n- **Engagement:** 3 likes`;
    const c = compactTweetText(doc, "https://x.com/spammer/status/7");
    expect(c.docType).toBeNull();
    expect(isLongFormTweet({ docType: c.docType, bodyLength: c.bodyLength })).toBe(false);
  });
});

describe("extractArticleUrl", () => {
  test("reads the `- **Article:**` footer permalink", () => {
    expect(extractArticleUrl(articleDoc)).toBe("https://x.com/trq212/article/2080710971228918066");
  });

  test("no `**Article:**` line ⇒ null", () => {
    expect(extractArticleUrl("# @a — A\n\nplain\n\n---\n\n- **Link:** https://x.com/a/status/9")).toBeNull();
  });

  test("a body-injected Article line BEFORE the footer separator is ignored", () => {
    const doc = `# @spammer — Spam\n\n- **Article:** https://spam.example/evil\n\n---\n\n- **Engagement:** 3 likes\n- **Link:** https://x.com/spammer/status/7`;
    expect(extractArticleUrl(doc)).toBeNull();
  });

  test("a body-injected line does not beat the REAL footer field", () => {
    const doc = `# @spammer — Spam\n\n- **Article:** https://spam.example/evil\n\n---\n\n- **Type:** article\n- **Article:** https://x.com/spammer/article/7`;
    expect(extractArticleUrl(doc)).toBe("https://x.com/spammer/article/7");
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

  // The `docType === "article"` exemption — asserted against the LIVE X Highlights
  // config (candidateMinScore 0.6, no other floor knobs set).
  test("an `article` doc by a NON-TOP author keeps the 0.6 base — the 0.75 raise does NOT apply", () => {
    expect(captureFloorForTier(null, { candidateMinScore: 0.6 }, "article")).toBe(0.6);
  });

  test("an `article` doc by a top author is unchanged at the base", () => {
    expect(captureFloorForTier("top5", { candidateMinScore: 0.6 }, "article")).toBe(0.6);
  });

  test("the article exemption skips the non-top RAISE, it never undercuts a configured base", () => {
    expect(captureFloorForTier(null, { candidateMinScore: 0.85 }, "article")).toBe(0.85);
    expect(captureFloorForTier(null, { candidateMinScoreByKind: { "x-post": 0.8 } }, "article")).toBe(0.8);
    // A `note` (or a null docType — a ≥800ch body) still takes the raise.
    expect(captureFloorForTier(null, { candidateMinScore: 0.6 }, "note")).toBe(0.75);
    expect(captureFloorForTier(null, { candidateMinScore: 0.6 }, null)).toBe(0.75);
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
    gateCalls.length = 0;
    gateThrowFirstN = 0;
    gateClockAdvanceMs = 0;
    clockOffsetMs = 0;
    upsertCalls.length = 0;
    candidateRows.clear();
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
    lastSuccessAt: null,
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

  test("captureMaxItems caps a run to the K highest-scoring floor-passers", async () => {
    // Both long-form posts clear the floor; the budget admits only the better one.
    gateResult = JSON.stringify([
      { n: 1, score: 0.78, why: "good" },
      { n: 2, score: 0.91, why: "better" },
    ]);
    await checkX(
      baseWatcher({
        config: {
          collection: "x-feed",
          windowDays: 1,
          captureCandidates: true,
          candidateMinScore: 0.6,
          captureMaxItems: 1,
        },
      }),
    );
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.url).toBe("https://x.com/bob/status/2");
    expect(upsertCalls[0]!.score).toBe(0.91);
  });

  test("the limit clause reaches the gate prompt with the resolved K", async () => {
    gateResult = "[]";
    await checkX(
      baseWatcher({
        config: { collection: "x-feed", windowDays: 1, captureCandidates: true, captureMaxItems: 2 },
      }),
    );
    expect(lastGatePrompt).toContain("AT MOST 2");
    expect(lastGatePrompt).toContain("never pad");
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

  // ── Capture-gate retry + completion budget (2026-07-26 outage fix) ──
  //
  // The fixture batch yields two eligible docs (alice's note + bob's ~950-char
  // long-form); carol's short tweet is never eligible.

  const captureWatcher = (over: Record<string, unknown> = {}) =>
    baseWatcher({
      config: {
        collection: "x-feed",
        windowDays: 1,
        captureCandidates: true,
        candidateMinScore: 0.6,
        candidateMinScoreNonTop: 0.6,
        ...over,
      },
    });

  // The outcome log is THE measurement surface for this gate — nothing else records a
  // duration (haiku_usage has no duration column and only writes on success, spawnHaiku
  // emits no span here, and `Capture: queued` only fires when captured > 0). So it is
  // asserted, not assumed.
  const gateOutcomeLines = () => logLines.filter((l) => l.message.startsWith("x-capture-gate"));

  test("outcome log fires on the success path with n / scored / aboveFloor / duration / attempt", async () => {
    logLines.length = 0;
    // Two eligible docs; the model scores both but only one clears the 0.6 floor.
    gateResult = JSON.stringify([
      { n: 1, score: 0.9, why: "yes" },
      { n: 2, score: 0.3, why: "meh" },
    ]);
    await checkX(captureWatcher());
    const lines = gateOutcomeLines();
    expect(lines.length).toBe(1);
    const p = lines[0]!.props;
    expect(lines[0]!.level).toBe("info");
    expect(p.outcome).toBe("ok");
    expect(p.n).toBe(2);
    expect(p.scored).toBe(2);
    expect(p.aboveFloor).toBe(1); // matches what actually gets captured, below
    expect(p.attempt).toBe(1);
    expect(typeof p.durationMs).toBe("number");
    expect(typeof p.promptChars).toBe("number");
    expect(upsertCalls.length).toBe(1);
  });

  test("outcome log fires on EVERY failed attempt, carrying n and the error", async () => {
    logLines.length = 0;
    gateThrowFirstN = 99;
    await checkX(captureWatcher());
    const lines = gateOutcomeLines();
    expect(lines.length).toBe(2); // one per attempt — failures are logged, not swallowed
    for (const [i, line] of lines.entries()) {
      expect(line.level).toBe("warn");
      expect(line.props.outcome).toBe("failed");
      expect(line.props.n).toBe(2);
      expect(line.props.attempt).toBe(i + 1);
      expect(typeof line.props.durationMs).toBe("number");
      expect(String(line.props.error)).toContain("haiku timed out");
    }
  });

  test("gate retries once and the retry's result is captured", async () => {
    gateThrowFirstN = 1; // first attempt times out, second succeeds
    gateResult = JSON.stringify([{ n: 1, score: 0.9, why: "worth it" }]);
    await checkX(captureWatcher());
    expect(captureGateCalls().length).toBe(2);
    expect(upsertCalls.length).toBe(1);
  });

  test("gate gives up after exactly one retry and the alert path still returns", async () => {
    gateThrowFirstN = 99; // every attempt fails
    const alerts = await checkX(captureWatcher());
    expect(captureGateCalls().length).toBe(2); // one try + one retry, never more
    expect(upsertCalls.length).toBe(0);
    expect(Array.isArray(alerts)).toBe(true); // capture failure never breaks the run
  });

  test("attempt timeout is capped at the 180s per-attempt cap when budget allows", async () => {
    // config.timeoutMs 600000 ⇒ runner net 630s ⇒ capture budget ~570s ⇒ the 180s
    // per-attempt cap binds, not the budget.
    await checkX(captureWatcher({ timeoutMs: 600_000 }));
    expect(captureGateCalls().length).toBe(1);
    expect(captureGateCalls()[0]!.timeoutMs).toBe(180_000);
  });

  test("attempt timeout falls back to the remaining budget when that is tighter", async () => {
    // config.timeoutMs 180000 ⇒ net 210s ⇒ budget 150s, below the 180s per-attempt cap.
    // Upper bound only — the exact value carries the (real) elapsed fetch time, so a
    // lower bound here would be a wall-clock-dependent flake.
    await checkX(captureWatcher({ timeoutMs: 180_000 }));
    expect(captureGateCalls().length).toBe(1);
    expect(captureGateCalls()[0]!.timeoutMs!).toBeLessThanOrEqual(150_000);
  });

  test("budget exhaustion suppresses the retry and is named in the outer failure", async () => {
    logLines.length = 0;
    gateThrowFirstN = 99; // every attempt fails …
    // … and attempt 1 burns 240s of the 270s default budget (injected clock, no waiting).
    await withInjectedClock(240_000, async () => {
      await checkX(captureWatcher());
    });

    // Attempt 2 is never started — 30s left is under the 45s minimum attempt window.
    expect(captureGateCalls().length).toBe(1);
    const lines = gateOutcomeLines();
    expect(lines.map((l) => l.props.outcome)).toEqual(["failed", "budget-exhausted"]);

    const exhausted = lines[1]!.props;
    expect(exhausted.attempt).toBe(1); // attempts MADE, not the phantom one declined
    expect(exhausted.scored).toBeUndefined(); // non-ok lines never claim "scored 0"
    expect(exhausted.aboveFloor).toBeUndefined();

    // The rethrown error must carry the budget, not just attempt 1's raw message —
    // otherwise the outer log makes a budget kill look like a plain model failure.
    const outer = logLines.find((l) => l.message.startsWith("Capture gate failed"));
    expect(outer).toBeDefined();
    expect(String(outer!.props.error)).toContain("budget exhausted");
    expect(String(outer!.props.error)).toContain("haiku timed out");
    expect(upsertCalls.length).toBe(0);
  });
});

// ── Capture budget math (pure) ───────────────────────────────────────

describe("capture completion budget", () => {
  const w = (timeoutMs?: number): Watcher => ({
    id: "xw-budget",
    userId: "u1",
    botName: "jarvis",
    name: "X Highlights",
    type: "x",
    config: { collection: "x-feed", ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    intervalMs: 7_200_000,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  });

  test("budget is min(watcher net, scheduler tick) minus the safety margin", () => {
    // X Highlights: 600s configured ⇒ 630s net, but the 600s scheduler tick is the TRUE
    // ceiling ⇒ 540s, not 570s.
    expect(captureBudgetMs(w(600_000))).toBe(540_000);
    expect(captureBudgetDeadline(w(600_000), 1_000)).toBe(1_000 + 540_000);
    // No configured timeout ⇒ the SAME 300s default the digest leg reads ⇒ 330s net ⇒
    // 270s budget (NOT the 60s that computeWatcherTimeoutMs's 120s floor used to give).
    expect(captureBudgetMs(w())).toBe(270_000);
    expect(captureBudgetDeadline(w(), 1_000)).toBe(1_000 + 270_000);
  });

  test("the un-configured default leaves room for a full attempt AND a retry", () => {
    // Regression guard for the default-budget bug: the old derivation gave 60s — worse
    // than the pre-retry flat 90s, with attempt 2 permanently budget-dead.
    const budget = captureBudgetMs(w());
    expect(budget).toBeGreaterThanOrEqual(90_000);
    // After one full-cap attempt there is still enough left to START the retry.
    expect(captureAttemptTimeoutMs(budget, 180_000)).not.toBeNull();
  });

  test("deadline never goes backwards past the run start", () => {
    // Even a pathological net below the margin clamps at the run start (budget 0),
    // which the attempt guard then reads as "don't start".
    expect(captureBudgetDeadline(w(1), 5_000)).toBe(5_000);
  });

  test("attempt timeout is min(per-attempt cap, remaining budget)", () => {
    expect(captureAttemptTimeoutMs(1_000_000, 1_000_000 - 500_000)).toBe(180_000);
    expect(captureAttemptTimeoutMs(1_000_000, 1_000_000 - 100_000)).toBe(100_000);
  });

  test("no attempt is started when the remaining budget can't cover one", () => {
    expect(captureAttemptTimeoutMs(1_000_000, 1_000_000 - 45_000)).toBe(45_000); // exactly at the floor
    expect(captureAttemptTimeoutMs(1_000_000, 1_000_000 - 44_999)).toBeNull();
    expect(captureAttemptTimeoutMs(1_000_000, 1_000_000)).toBeNull();
    expect(captureAttemptTimeoutMs(1_000_000, 1_000_001)).toBeNull(); // already past
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
    gateCalls.length = 0;
    gateThrowFirstN = 0;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    candidateRows.clear();
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
    lastSuccessAt: null,
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
    // Keyed on the DESTINATION, not the tweet permalink (the wave-collapse mechanism),
    // and written through the coherent-set destination writer. The youtu.be short form
    // canonicalizes onto the one key per video (see `normalizeDestinationUrl`).
    expect(upsertCalls[0]!.url).toBe("https://youtube.com/watch?v=AGENTvid001");
    expect(upsertCalls[0]!.writer).toBe("destination");
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

// ── Destination-URL keying: a pointer wave collapses to ONE row ACROSS runs ──

describe("destination-URL keying (x-link wave collapse)", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const DEST = "https://example.com/announce";
  let docs: Record<string, { text: string; url: string }> = {};

  /** A short pointer tweet from `handle` at `link` (plural **Links:** footer). */
  function pointerDoc(handle: string, id: string, ...links: string[]) {
    return {
      [`${today}_${handle}_${id}.md`]: {
        url: `https://x.com/${handle}/status/${id}`,
        text: `# @${handle} — ${handle}\n\n${handle.toUpperCase()} JUST DROPPED THIS\n\n---\n\n- **Engagement:** 800 likes\n- **Link:** https://x.com/${handle}/status/${id}\n- **Links:** ${links.join(" ")}`,
      },
    };
  }

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
    gateCalls.length = 0;
    gateThrowFirstN = 0;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    candidateRows.clear();
    upsertThrow = false;
    for (const k of Object.keys(authorScoreByHandle)) delete authorScoreByHandle[k];
    // Every pointer author is top-5% (x-link eligibility requires a tier).
    authorThresholds = { top1: 0.9, top5: 0.5 };
    docs = {};
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const baseWatcher = (over: Partial<Watcher>): Watcher => ({
    id: "xw3",
    userId: "u1",
    botName: "jarvis",
    name: "X Highlights",
    type: "x",
    config: { collection: "x-feed", windowDays: 1 },
    intervalMs: 7_200_000,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  const captureOnly = { collection: "x-feed", windowDays: 1, captureCandidates: true, minScore: 0.6, quietMode: true } as const;

  /** One watcher run over exactly `runDocs`, with the gate scoring item 1 as given. */
  async function runWith(runDocs: typeof docs, score: number, why: string) {
    docs = runDocs;
    gateResult = JSON.stringify([{ n: 1, score, why }]);
    await checkX(baseWatcher({ config: { ...captureOnly } }));
  }

  test("a wave across separate runs yields ONE destination-keyed row with coherent representative fields", async () => {
    authorScoreByHandle["dave"] = 0.7;
    authorScoreByHandle["frank"] = 0.7;
    authorScoreByHandle["grace"] = 0.7;

    // Run 1 — dave points at the destination with tracking params + a fragment.
    await runWith(pointerDoc("dave", "10", `${DEST}?utm_source=twitter&si=abc#top`), 0.75, "dave says watch this");
    // Run 2 — frank points at the same destination over http:// with a trailing slash,
    // and scores HIGHER, so he takes over as representative.
    await runWith(pointerDoc("frank", "11", `http://Example.com/announce/`), 0.9, "frank: the primary source");
    // Run 3 — grace, same destination, LOWER score: the stored representative wins.
    await runWith(pointerDoc("grace", "12", DEST), 0.72, "grace, late to it");

    // Three admissions, all onto ONE key.
    expect(upsertCalls).toHaveLength(3);
    expect(new Set(upsertCalls.map((c) => c.url))).toEqual(new Set([DEST]));
    expect(upsertCalls.every((c) => c.writer === "destination")).toBe(true);

    // …and ONE surviving row, whose fields ALL belong to the same (best) member.
    expect(candidateRows.size).toBe(1);
    const row = storedRow("x", DEST)!;
    expect(row.score).toBe(0.9);
    expect(row.why).toBe("frank: the primary source");
    expect(row.title).toContain("@frank:");
    expect(row.candidateSrc).toBe("X (@frank)");
    expect(row.author).toBe("frank");
    expect(row.sourceDocId).toBe(`${today}_frank_11.md`);
    expect(row.kind).toBe("x-link");
  });

  test("a MANUALLY dismissed destination row is never resurrected by a later wave member", async () => {
    authorScoreByHandle["dave"] = 0.7;
    candidateRows.set(`x|${DEST}`, {
      source: "x",
      url: DEST,
      title: "@earlier: old pointer",
      score: 0.7,
      status: "dismissed",
      dismissedReason: "manual",
    });

    await runWith(pointerDoc("dave", "10", DEST), 0.95, "loud new pointer");

    const row = storedRow("x", DEST)!;
    expect(row.status).toBe("dismissed");
    expect(row.score).toBe(0.7);
    expect(row.title).toBe("@earlier: old pointer");
  });

  test("an AUTO-EXPIRED destination row is re-admitted (it would otherwise poison the key)", async () => {
    authorScoreByHandle["dave"] = 0.7;
    candidateRows.set(`x|${DEST}`, {
      source: "x",
      url: DEST,
      title: "@earlier: old pointer",
      score: 0.7,
      status: "dismissed",
      dismissedReason: "expired",
    });

    await runWith(pointerDoc("dave", "10", DEST), 0.95, "loud new pointer");

    const row = storedRow("x", DEST)!;
    expect(row.status).toBe("new");
    expect(row.dismissedReason).toBeNull();
    expect(row.score).toBe(0.95);
    expect(row.title).toContain("@dave:");
  });

  test("the queued-count log counts DISTINCT rows, not admissions, on in-batch collapse", async () => {
    authorScoreByHandle["dave"] = 0.7;
    authorScoreByHandle["erin"] = 0.7;
    logLines.length = 0;
    docs = { ...pointerDoc("dave", "10", DEST), ...pointerDoc("erin", "11", DEST) };
    gateResult = JSON.stringify([
      { n: 1, score: 0.8, why: "dave" },
      { n: 2, score: 0.9, why: "erin" },
    ]);
    await checkX(baseWatcher({ config: { ...captureOnly } }));

    // Two admissions onto ONE key — the metric that watches wave collapse must say 1.
    expect(upsertCalls).toHaveLength(2);
    expect(candidateRows.size).toBe(1);
    const queued = logLines.find((l) => l.message.startsWith("Capture: queued"));
    expect(queued?.props.n).toBe(1);
  });

  test("a multi-link pointer keys on links[0] only", async () => {
    authorScoreByHandle["dave"] = 0.7;
    await runWith(pointerDoc("dave", "10", DEST, "https://other.test/second"), 0.8, "first link wins");
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.url).toBe(DEST);
  });

  test("a top-tier .pdf pointer keeps TODAY'S tweet-URL-keyed row", async () => {
    authorScoreByHandle["dave"] = 0.7;
    await runWith(pointerDoc("dave", "10", "https://arxiv.org/pdf/2401.00001v1.pdf"), 0.9, "the paper itself");
    expect(upsertCalls).toHaveLength(1);
    // The article content path is `res.text()` with zero PDF handling, so a
    // destination-keyed .pdf row would summarize raw bytes — this class stays as-is.
    expect(upsertCalls[0]!.url).toBe("https://x.com/dave/status/10");
    expect(upsertCalls[0]!.writer).toBe("shared");
    expect(upsertCalls[0]!.kind).toBe("x-link");
    expect(candidateRows.size).toBe(0);
  });

  test("long-form is never re-keyed, even when it carries links", async () => {
    authorScoreByHandle["heidi"] = 0.7;
    const longBody = "insight ".repeat(120).trim();
    docs = {
      [`${today}_heidi_20.md`]: {
        url: "https://x.com/heidi/status/20",
        text: `# @heidi — Heidi\n\n${longBody}\n\n---\n\n- **Type:** note\n- **Links:** ${DEST}`,
      },
    };
    gateResult = JSON.stringify([{ n: 1, score: 0.9, why: "long-form with a link" }]);
    await checkX(baseWatcher({ config: { ...captureOnly } }));

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.kind).toBe("x-post");
    expect(upsertCalls[0]!.url).toBe("https://x.com/heidi/status/20");
    expect(upsertCalls[0]!.writer).toBe("shared");
  });
});

// ── Step 2b: any-tier amplifier admission (flag-gated, OFF by default) ──

describe("resolveCaptureAmplifyMin", () => {
  test("absent ⇒ null (the whole 2b path is OFF by default)", () => {
    expect(resolveCaptureAmplifyMin({})).toBeNull();
  });

  test("a valid integer ≥ 1 is the threshold", () => {
    expect(resolveCaptureAmplifyMin({ captureAmplifyMin: DEFAULT_CAPTURE_AMPLIFY_MIN })).toBe(3);
    expect(resolveCaptureAmplifyMin({ captureAmplifyMin: 1 })).toBe(1);
  });

  test("an invalid value degrades to OFF, never to a default (no silent batch growth)", () => {
    expect(resolveCaptureAmplifyMin({ captureAmplifyMin: 0 })).toBeNull();
    expect(resolveCaptureAmplifyMin({ captureAmplifyMin: 2.5 })).toBeNull();
    expect(resolveCaptureAmplifyMin({ captureAmplifyMin: -1 })).toBeNull();
    expect(resolveCaptureAmplifyMin({ captureAmplifyMin: "3" as unknown as number })).toBeNull();
  });
});

describe("resolveCaptureMaxItems", () => {
  test("absent ⇒ ON at the default (inverse of every other capture knob)", () => {
    expect(resolveCaptureMaxItems({})).toBe(DEFAULT_CAPTURE_MAX_ITEMS);
    expect(DEFAULT_CAPTURE_MAX_ITEMS).toBe(3);
  });

  test("a valid integer in range is used verbatim", () => {
    expect(resolveCaptureMaxItems({ captureMaxItems: 1 })).toBe(1);
    expect(resolveCaptureMaxItems({ captureMaxItems: MAX_CAPTURE_MAX_ITEMS })).toBe(MAX_CAPTURE_MAX_ITEMS);
  });

  test("invalid values fall back to the DEFAULT, never to unlimited", () => {
    // An unbudgeted gate is the defect this knob exists to fix, so a mistyped value must
    // not silently restore it — deliberately the inverse of resolveCaptureAmplifyMin.
    for (const bad of [0, -1, 2.5, NaN, Infinity, "3" as unknown as number]) {
      expect(resolveCaptureMaxItems({ captureMaxItems: bad })).toBe(DEFAULT_CAPTURE_MAX_ITEMS);
    }
  });

  test("an out-of-range value cannot silently uncap the gate", () => {
    // The knob's whole job is to CAP volume — `1e9` is a valid integer ≥ 1 and would
    // otherwise be honoured verbatim, restoring exactly the unbudgeted behaviour.
    expect(resolveCaptureMaxItems({ captureMaxItems: 1e9 })).toBe(DEFAULT_CAPTURE_MAX_ITEMS);
    expect(resolveCaptureMaxItems({ captureMaxItems: MAX_CAPTURE_MAX_ITEMS + 1 })).toBe(
      DEFAULT_CAPTURE_MAX_ITEMS,
    );
  });
});

describe("applyCaptureLimit", () => {
  test("under or at the limit ⇒ everything passes through", () => {
    const passing = [{ n: 1, score: 0.7 }, { n: 2, score: 0.9 }];
    expect(applyCaptureLimit(passing, 3)).toEqual(new Set([1, 2]));
    expect(applyCaptureLimit(passing, 2)).toEqual(new Set([1, 2]));
    expect(applyCaptureLimit([], 3)).toEqual(new Set());
  });

  test("over the limit ⇒ keeps the highest scores, NOT the first parsed", () => {
    // parseGateScores gives no ordering guarantee, so "first K" would be arbitrary.
    const passing = [{ n: 1, score: 0.76 }, { n: 2, score: 0.8 }, { n: 3, score: 0.95 }];
    expect(applyCaptureLimit(passing, 1)).toEqual(new Set([3]));
    expect(applyCaptureLimit(passing, 2)).toEqual(new Set([2, 3]));
  });

  test("exact score ties break toward the lower n (the better-ranked doc)", () => {
    expect(applyCaptureLimit([{ n: 2, score: 0.85 }, { n: 5, score: 0.85 }], 1)).toEqual(new Set([2]));
  });
});

describe("withCaptureLimit", () => {
  test("appends the cap to the prompt and forbids padding", () => {
    const out = withCaptureLimit("BASE RULES", 3);
    expect(out.startsWith("BASE RULES")).toBe(true);
    expect(out).toContain("AT MOST 3");
    // Told only "at most K" a model reliably returns exactly K, turning a quiet batch
    // into K forced captures — the anti-padding sentence is load-bearing.
    expect(out.toLowerCase()).toContain("never pad");
    expect(out).toContain("FEWER");
  });

  test("the interest profile still wraps LAST when both are composed", () => {
    // The profile block's "output-format instructions above still apply" trailer is only
    // truthful if the limit clause sits ABOVE it — this is the ordering invariant itself,
    // not merely a fact about the base constant.
    const composed = withInterestProfile(withCaptureLimit(DEFAULT_X_CAPTURE_PROMPT, 3), "likes agents");
    expect(composed.indexOf("AT MOST 3")).toBeGreaterThan(-1);
    expect(composed.indexOf("likes agents")).toBeGreaterThan(composed.indexOf("AT MOST 3"));
  });
});

describe("decideAdmissions — floor FIRST, then the limit", () => {
  // Minimal EligibleTweet stubs: only the fields passesCaptureFloor reads.
  const item = (kind: "x-post" | "x-link", tier: "top1" | "top5" | null) =>
    ({ doc: { docType: null }, author: "a", authorScore: null, tier, kind }) as never;

  test("a floor-BLOCKED higher scorer does not consume the only slot", () => {
    // The two kinds carry DIFFERENT floors, which is what makes the order observable:
    // x-post (non-top author) floors at 0.75, x-link at 0.7. Budget-then-floor would
    // spend the slot on n=1 (0.74, top score) and then drop it, capturing NOTHING.
    const eligible = [item("x-post", null), item("x-link", "top5")];
    const byN = new Map([
      [1, { n: 1, score: 0.74, why: "under its floor" }],
      [2, { n: 2, score: 0.72, why: "over its floor" }],
    ]);
    const d = decideAdmissions(eligible, byN, { candidateMinScore: 0.6 }, 1);
    expect(d.passedFloor).toEqual(new Set([2]));
    expect(d.admitted).toEqual(new Set([2]));
  });

  test("a strong batch admits exactly the limit; a weak one admits fewer", () => {
    const eligible = [item("x-post", "top5"), item("x-post", "top5"), item("x-post", "top5")];
    const strong = new Map([
      [1, { n: 1, score: 0.9, why: "" }],
      [2, { n: 2, score: 0.8, why: "" }],
      [3, { n: 3, score: 0.7, why: "" }],
    ]);
    expect(decideAdmissions(eligible, strong, { candidateMinScore: 0.6 }, 2).admitted).toEqual(
      new Set([1, 2]),
    );
    // Only one clears the 0.6 floor ⇒ one admitted, not padded up to the limit.
    const weak = new Map([
      [1, { n: 1, score: 0.9, why: "" }],
      [2, { n: 2, score: 0.3, why: "" }],
      [3, { n: 3, score: 0.2, why: "" }],
    ]);
    expect(decideAdmissions(eligible, weak, { candidateMinScore: 0.6 }, 2).admitted).toEqual(
      new Set([1]),
    );
  });

  test("passedFloor is reported PRE-limit, so a limit rejection is distinguishable", () => {
    // The step-2b wave path depends on telling a floor rejection from a limit one.
    const eligible = [item("x-post", "top5"), item("x-post", "top5")];
    const byN = new Map([
      [1, { n: 1, score: 0.9, why: "" }],
      [2, { n: 2, score: 0.8, why: "" }],
    ]);
    const d = decideAdmissions(eligible, byN, { candidateMinScore: 0.6 }, 1);
    expect(d.passedFloor).toEqual(new Set([1, 2]));
    expect(d.admitted).toEqual(new Set([1]));
  });

  test("a sub-tier pointer is floor-blocked whatever it scores, and never eats a slot", () => {
    const eligible = [item("x-link", null), item("x-post", "top5")];
    const byN = new Map([
      [1, { n: 1, score: 0.99, why: "sub-tier pointer" }],
      [2, { n: 2, score: 0.7, why: "ordinary long-form" }],
    ]);
    const d = decideAdmissions(eligible, byN, { candidateMinScore: 0.6 }, 1);
    expect(d.passedFloor).toEqual(new Set([2]));
    expect(d.admitted).toEqual(new Set([2]));
  });
});

describe("isAmplifierPointer", () => {
  const short = { bodyLength: 100, docType: null };

  test("a sub-tier short tweet with a groupable link qualifies", () => {
    expect(isAmplifierPointer({ ...short, links: ["https://example.com/x"] }, null)).toBe(true);
  });

  test("a TOP-tier pointer does not (isLinkTweet already admits it)", () => {
    expect(isAmplifierPointer({ ...short, links: ["https://example.com/x"] }, "top5")).toBe(false);
  });

  test("long-form never qualifies", () => {
    expect(isAmplifierPointer({ bodyLength: 100, docType: "note", links: ["https://example.com/x"] }, null)).toBe(false);
  });

  test("no link, and a PDF destination (no group key), are both excluded — they could never be admitted", () => {
    expect(isAmplifierPointer({ ...short, links: [] }, null)).toBe(false);
    expect(isAmplifierPointer({ ...short, links: ["https://arxiv.org/pdf/2401.00001v1.pdf"] }, null)).toBe(false);
  });
});

describe("any-tier amplifier admission (step 2b)", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const DEST = "https://example.com/wave";
  let docs: Record<string, { text: string; url: string }> = {};

  /** A SHORT pointer tweet — sub-tier because no author score is registered for `handle`. */
  function pointerDoc(handle: string, id: string, link = DEST) {
    return {
      [`${today}_${handle}_${id}.md`]: {
        url: `https://x.com/${handle}/status/${id}`,
        text: `# @${handle} — ${handle}\n\n${handle} POINTS AT IT\n\n---\n\n- **Engagement:** 20 likes\n- **Link:** https://x.com/${handle}/status/${id}\n- **Links:** ${link}`,
      },
    };
  }

  /** A LONG-FORM note that happens to carry the same destination in its footnotes. */
  function longFormDoc(handle: string, id: string, link = DEST) {
    return {
      [`${today}_${handle}_${id}.md`]: {
        url: `https://x.com/${handle}/status/${id}`,
        text: `# @${handle} — ${handle}\n\n${"original analysis ".repeat(60).trim()}\n\n---\n\n- **Type:** note\n- **Links:** ${link}`,
      },
    };
  }

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
    gateCalls.length = 0;
    gateThrowFirstN = 0;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    candidateRows.clear();
    amplifierRows.clear();
    amplifierThrow = false;
    upsertThrow = false;
    for (const k of Object.keys(authorScoreByHandle)) delete authorScoreByHandle[k];
    // Thresholds exist, but none of these handles is in the scores file ⇒ tier null ⇒
    // every pointer below is SUB-TIER (invisible to capture before step 2b).
    authorThresholds = { top1: 0.9, top5: 0.5 };
    docs = {};
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const captureOn = {
    collection: "x-feed",
    windowDays: 1,
    captureCandidates: true,
    minScore: 0.6,
    quietMode: true,
    captureAmplifyMin: 3,
  } as const;

  const baseWatcher = (config: Record<string, unknown>): Watcher => ({
    id: "xw4",
    userId: "u1",
    botName: "jarvis",
    name: "X Highlights",
    type: "x",
    config,
    intervalMs: 7_200_000,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  });

  /** One watcher run over exactly `runDocs`, with the gate returning `scores`. */
  async function run(
    runDocs: typeof docs,
    scores: Array<{ n: number; score: number; why: string }>,
    config: Record<string, unknown> = { ...captureOn },
  ) {
    docs = runDocs;
    gateResult = JSON.stringify(scores);
    await checkX(baseWatcher(config));
  }

  test("three runs, three distinct sub-tier authors: NO row until the third, then ONE built from the BEST recorded pointer", async () => {
    // Run 1 — alice alone. One vote, no admission (1 < 3).
    await run(pointerDoc("alice", "10"), [{ n: 1, score: 0.75, why: "alice points" }]);
    expect(upsertCalls).toHaveLength(0);
    expect(candidateRows.size).toBe(0);
    expect(amplifierRows.size).toBe(1);

    // Run 2 — bob, the HIGHEST-scoring member of the wave. Still no admission (2 < 3).
    await run(pointerDoc("bob", "11"), [{ n: 1, score: 0.9, why: "bob: the primary source" }]);
    expect(upsertCalls).toHaveLength(0);
    expect(candidateRows.size).toBe(0);
    expect(amplifierRows.size).toBe(2);

    // Run 3 — carol crosses the threshold with the LOWEST score of the three. The row is
    // built from bob's RECORDED snapshot, not from the pointer that happened to trip it
    // (alice's and bob's docs are long gone from this run's batch).
    await run(pointerDoc("carol", "12"), [{ n: 1, score: 0.72, why: "carol, late to it" }]);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.writer).toBe("destination");
    expect(upsertCalls[0]!.url).toBe(DEST);
    expect(upsertCalls[0]!.kind).toBe("x-link");

    expect(candidateRows.size).toBe(1);
    const row = storedRow("x", DEST)!;
    expect(row.author).toBe("bob");
    expect(row.score).toBe(0.9);
    expect(row.why).toBe("bob: the primary source");
    expect(row.candidateSrc).toBe("X (@bob)");
    expect(row.sourceDocId).toBe(`${today}_bob_11.md`);
  });

  test("the threshold is crossed by a LATER member of the SAME batch: one row, from the best recorded pointer", async () => {
    // Regression: the check used to run INLINE at the first non-directly-admitted pointer
    // of a group, but votes are written per item as the loop walks — so bob's and carol's
    // votes did not exist yet when bob (n=1) was checked, and the group was never
    // re-checked (alice's and bob's docs are consumed + marked seen). Result was ZERO rows
    // despite 3 distinct authors and a 0.9 best. The drain now runs AFTER the loop.
    await run(pointerDoc("alice", "10"), [{ n: 1, score: 0.75, why: "alice points" }]);
    expect(candidateRows.size).toBe(0);

    // ONE batch carrying the wave's 2nd AND 3rd distinct authors.
    await run({ ...pointerDoc("bob", "11"), ...pointerDoc("carol", "12") }, [
      { n: 1, score: 0.9, why: "bob: the primary source" },
      { n: 2, score: 0.72, why: "carol, late to it" },
    ]);
    expect(amplifierRows.size).toBe(3);
    // Exactly ONE admission for the group, despite two queued pointers in the batch.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.writer).toBe("destination");
    expect(candidateRows.size).toBe(1);
    const row = storedRow("x", DEST)!;
    expect(row.author).toBe("bob");
    expect(row.score).toBe(0.9);
    expect(row.why).toBe("bob: the primary source");
  });

  test("the wave still has to clear the x-link floor — three 0.65 pointers admit nothing", async () => {
    await run(pointerDoc("alice", "10"), [{ n: 1, score: 0.65, why: "meh" }]);
    await run(pointerDoc("bob", "11"), [{ n: 1, score: 0.68, why: "meh" }]);
    await run(pointerDoc("carol", "12"), [{ n: 1, score: 0.6, why: "meh" }]);
    expect(amplifierRows.size).toBe(3);
    expect(upsertCalls).toHaveLength(0);
    expect(candidateRows.size).toBe(0);
  });

  test("a long-form post carrying the URL keeps its own x-post row and votes for OBSERVABILITY ONLY", async () => {
    // Run 1 — alice (pointer) + dave (long-form, scored HIGHER than any pointer).
    // Alphabetical doc-id order ⇒ alice is n=1, dave n=2.
    await run({ ...pointerDoc("alice", "10"), ...longFormDoc("dave", "13") }, [
      { n: 1, score: 0.75, why: "alice points" },
      { n: 2, score: 0.99, why: "dave's own analysis" },
    ]);
    // dave keeps his own TWEET-keyed x-post row through the shared writer — never re-keyed.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.kind).toBe("x-post");
    expect(upsertCalls[0]!.url).toBe("https://x.com/dave/status/13");
    expect(upsertCalls[0]!.writer).toBe("shared");
    // Both voted, but dave's vote is non-pointer.
    expect(amplifierRows.size).toBe(2);
    expect(amplifierRows.get(`${DEST}|dave`)!.pointer).toBe(false);

    // Run 2 — bob. Two POINTER authors + dave = 3 rows, but only 2 count ⇒ no admission.
    // This is the invariant that stops footnote links admitting a duplicate destination
    // row alongside the long-form posts' own rows.
    await run(pointerDoc("bob", "11"), [{ n: 1, score: 0.8, why: "bob points" }]);
    expect(amplifierRows.size).toBe(3);
    expect(storedRow("x", DEST)).toBeUndefined();

    // Run 3 — carol is the third POINTER author. Now it admits — from bob (0.8), the best
    // recorded POINTER, never from dave (0.99), who is not eligible to represent.
    await run(pointerDoc("carol", "12"), [{ n: 1, score: 0.7, why: "carol points" }]);
    const row = storedRow("x", DEST)!;
    expect(row.author).toBe("bob");
    expect(row.score).toBe(0.8);
  });

  test("flag UNSET ⇒ sub-tier pointers vanish exactly as today: no votes, no batch growth", async () => {
    const off = { collection: "x-feed", windowDays: 1, captureCandidates: true, minScore: 0.6, quietMode: true };
    await run({ ...pointerDoc("alice", "10"), ...pointerDoc("bob", "11"), ...pointerDoc("carol", "12") }, [
      { n: 1, score: 0.95, why: "loud" },
      { n: 2, score: 0.95, why: "loud" },
      { n: 3, score: 0.95, why: "loud" },
    ], off);
    expect(amplifierRows.size).toBe(0);
    expect(upsertCalls).toHaveLength(0);
    // Zero batch growth: nothing was eligible, so the capture gate was never called at all.
    expect(lastGatePrompt).toBe("");
  });

  test("flag UNSET on a MIXED batch ⇒ the gate sees only the long-form item, and nothing votes", async () => {
    // The byte-identity claim ("flag unset ⇒ the eligible set is exactly step 2a's") is
    // only really tested when something IS eligible: the flag-off test above asserts an
    // empty prompt, which an unconditionally-broken gate would also produce.
    const off = { collection: "x-feed", windowDays: 1, captureCandidates: true, minScore: 0.6, quietMode: true };
    await run({ ...pointerDoc("alice", "10"), ...longFormDoc("dave", "13") }, [
      { n: 1, score: 0.95, why: "dave's own analysis" },
    ], off);
    // Exactly one numbered item, and it is dave's long-form post.
    const posts = lastGatePrompt.split("\n\nPosts:\n\n")[1]!;
    expect(posts).toContain("1. [ARTICLE/NOTE] @dave:");
    expect(posts).not.toContain("2. ");
    expect(posts).not.toContain("@alice");
    // No pointer line at all — the sub-tier pointer never entered the batch.
    expect(posts).not.toContain("links to:");
    // No votes at all — the amplifier table is untouched with the flag off.
    expect(amplifierRows.size).toBe(0);
    // dave still captures normally through the shared (tweet-keyed) writer.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.kind).toBe("x-post");
    expect(upsertCalls[0]!.writer).toBe("shared");
  });

  test("a sub-tier .pdf pointer is not promoted — and never even enters the gate batch", async () => {
    const pdf = "https://arxiv.org/pdf/2401.00001v1.pdf";
    await run(pointerDoc("alice", "10", pdf), [{ n: 1, score: 0.95, why: "the paper" }]);
    await run(pointerDoc("bob", "11", pdf), [{ n: 1, score: 0.95, why: "the paper" }]);
    await run(pointerDoc("carol", "12", pdf), [{ n: 1, score: 0.95, why: "the paper" }]);
    expect(amplifierRows.size).toBe(0);
    expect(upsertCalls).toHaveLength(0);
    expect(candidateRows.size).toBe(0);
    expect(lastGatePrompt).toBe("");
  });

  test("a pointer the gate OMITTED still votes (votes and admission are decoupled)", async () => {
    // alice is scored, bob is omitted from the gate output entirely.
    await run({ ...pointerDoc("alice", "10"), ...pointerDoc("bob", "11") }, [
      { n: 1, score: 0.9, why: "alice points" },
    ]);
    expect(amplifierRows.size).toBe(2);
    expect(amplifierRows.get(`${DEST}|bob`)!.score).toBeNull();
    // …but an unscored member can never be the representative, so the third author
    // admits from alice.
    await run(pointerDoc("carol", "12"), [{ n: 1, score: 0.72, why: "carol points" }]);
    const row = storedRow("x", DEST)!;
    expect(row.author).toBe("alice");
    expect(row.score).toBe(0.9);
  });

  test("an amplifier DB failure never breaks the capture path", async () => {
    amplifierThrow = true;
    authorScoreByHandle["dave"] = 0.7; // top-5% ⇒ dave admits directly, as in step 2a
    await run({ ...pointerDoc("alice", "10"), ...pointerDoc("dave", "13") }, [
      { n: 1, score: 0.9, why: "alice points" },
      { n: 2, score: 0.9, why: "dave points" },
    ]);
    // dave's direct (top-tier) admission still lands despite every vote/read throwing.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.sourceDocId).toBe(`${today}_dave_13.md`);
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
  // The doc body the mocked huginn serves; swapped per test (see the amplifier case).
  let servedDoc = articleDoc;

  beforeEach(() => {
    servedDoc = articleDoc;
    gateResult = "[]";
    gateThrow = false;
    gateCalls.length = 0;
    gateThrowFirstN = 0;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    candidateRows.clear();
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
        json: async () => ({ text: servedDoc, metadata: { url: tweetUrl, combined_score: combinedScore } }),
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
    lastSuccessAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  });

  test("an article by a non-top author is captured as x-post at the 0.6 floor, keyed on the ARTICLE url", async () => {
    // 0.65: clears the x-post base (0.6) but NOT the non-top raise (0.75) — so this row
    // only exists because `**Type:** article` exempts it from the raise.
    gateResult = JSON.stringify([{ n: 1, score: 0.65, why: "context-engineering rules for Claude 5" }]);

    await checkX(watcher(), "jarvis");

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

  // The AMPLIFIER shape: huginn writes the `- **Article:**` footer for any doc whose
  // tweet OR quote target carries an article, so a `**Type:** note` doc can carry
  // ANOTHER author's article permalink. Keying the candidate on it would collide with
  // the promoted article doc on UNIQUE(source, url) and serve the wrong body.
  test("a `note` doc carrying an `- **Article:**` footer keeps the TWEET url as candidate url", async () => {
    servedDoc = [
      "# @amplifier — Amp",
      "",
      "Great read from @trq212 — everyone building agents should study this one closely.",
      "",
      "---",
      "",
      "- **Engagement:** 900 likes · 120,000 views",
      "- **Type:** note",
      `- **Link:** ${tweetUrl}`,
      `- **Article:** ${articleUrl}`,
    ].join("\n");
    // 0.8 clears the non-top raise (0.75) the note — unlike an article — still takes.
    gateResult = JSON.stringify([{ n: 1, score: 0.8, why: "solid pointer" }]);

    await checkX(watcher(), "jarvis");

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]!.url).toBe(tweetUrl); // NOT another author's article permalink
    expect(upsertCalls[0]!.kind).toBe("x-post");
    expect(upsertCalls[0]!.sourceDocId).toBe(docId);
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

// ── Capture-gate calibration (X hype-dedup, step 1) ────────────────
//
// The displayed candidate score IS this prompt's output, so these are the only
// deterministic assertions available on it — the shelf's 0.9–0.95 pile-up came from a
// prompt whose only anchors were ~1.0/~0.7/~0.6. Guarded here because a later edit that
// drops the pointer carve-out would silently pin every destination-keyed row (which
// inherits its representative pointer's gate score) below the inbox's 0.85 cut.

describe("DEFAULT_X_CAPTURE_PROMPT calibration", () => {
  test("caps secondhand repackaging at 0.8 and scopes the cap to long-form only", () => {
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("REPACKAGING CAP");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("applies ONLY to long-form notes");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("cap the score at 0.8");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("adds original analysis");
    // The cap is unconditional — author rank/standing never lifts it.
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain(
      "This ceiling binds regardless of the author's rank or standing",
    );
    // …and topic-independent, because withInterestProfile appends its "can RAISE
    // relevance" block AFTER this ladder (see src/profile/inject.ts, shared — not edited).
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain(
      "not lifted by how well the item matches the reader's interests",
    );
  });

  test("pointer items are explicitly carved out of the cap and scored on the destination", () => {
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("NEVER to pointer items");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("the repackaging cap above does NOT apply either");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("scored on its DESTINATION with no cap");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("a pointer to a primary source can score 0.9 or above");
  });

  test("anchors the 0.8 and 0.9 bands and reserves >=0.9 for primary sources ONLY", () => {
    for (const anchor of ["~1.0", "~0.9", "~0.8", "~0.7", "~0.6"]) {
      expect(DEFAULT_X_CAPTURE_PROMPT).toContain(anchor);
    }
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("RESERVED for a primary source");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("the artifact itself");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("never coverage of one");
    // Loud framing is not evidence of primary-source standing — the farm-pointer failure mode.
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("do not go above 0.85");
  });

  test("author rank is never a positive prior for the >=0.9 band", () => {
    // Every eligible pointer carries an "(author rank: top 1%/5%)" line BY CONSTRUCTION
    // (isLinkTweet requires tier != null) and that rank is farm PageRank (corr −0.001 with
    // quality), so a top-tier-author license would re-authorize the very farm pointers this
    // calibration removes.
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain(
      'The "author rank" line is a reach statistic from the scraped feed, NOT a credibility signal',
    );
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain(
      "a high author rank never by itself justifies 0.9 or above",
    );
    expect(DEFAULT_X_CAPTURE_PROMPT).not.toContain("top-tier author");
  });

  test("warns against clustering scores at the 0.85 ceiling", () => {
    // The shelf's LIMIT 200 cut sits at 0.85 and 0.85 is already the largest histogram
    // bucket (×140) — a named ceiling invites a pile-up.
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("Do not cluster scores at a ceiling");
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain(
      "0.85 is a maximum for items without primary-source standing, not their default",
    );
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain("use intermediate values (0.75, 0.65) freely");
  });

  test("instructs in-list dedup across every species that carries the same resource", () => {
    // "point at" alone read pointer-only; long-form recap waves escaped it.
    expect(DEFAULT_X_CAPTURE_PROMPT).toContain(
      "If several posts in this list point at, cover, or announce the same resource or announcement, keep only the one whose content (or destination) is most worth reading — score that one and omit the rest.",
    );
  });

  test("the anchor ladder precedes the JSON output contract, and no legacy ladder survives", () => {
    const ladder = DEFAULT_X_CAPTURE_PROMPT.indexOf("Calibration anchors");
    const contract = DEFAULT_X_CAPTURE_PROMPT.indexOf("Return ONLY a JSON array");
    expect(ladder).toBeGreaterThan(-1);
    expect(contract).toBeGreaterThan(-1);
    // A ladder appended AFTER the output contract reads as commentary on the JSON shape.
    expect(ladder).toBeLessThan(contract);
    // Exactly one ladder: a re-introduced old anchor block would duplicate the mid-band rungs.
    expect(DEFAULT_X_CAPTURE_PROMPT.split("~0.7").length - 1).toBe(1);
    expect(DEFAULT_X_CAPTURE_PROMPT.split("~1.0").length - 1).toBe(1);
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
    gateCalls.length = 0;
    gateThrowFirstN = 0;
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
    lastSuccessAt: null,
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

// ── Amplification is wired into the collection path's ranking step ──

describe("fetchFromCollection amplification wiring", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const ARTICLE = "https://x.com/owner/article/999";

  /** An x-feed doc body with the footer fields the amplification parse reads. */
  function body(handle: string, text: string, type: string | null, article: string | null): string {
    const footer = [
      "- **Engagement:** 100 likes",
      type ? `- **Type:** ${type}` : "",
      `- **Link:** https://x.com/${handle}/status/1`,
      article ? `- **Article:** ${article}` : "",
    ].filter(Boolean).join("\n");
    return `# @${handle} — ${handle}\n\n${text}\n\n---\n\n${footer}`;
  }

  const docs: Record<string, { text: string; url: string; metadata: Record<string, unknown> }> = {
    [`${today}_amp1_1.md`]: {
      url: "https://x.com/amp1/status/1",
      text: body("amp1", "Everyone should read this article", "note", ARTICLE),
      metadata: { url: "https://x.com/amp1/status/1", combined_score: "0.61" },
    },
    [`${today}_owner_2.md`]: {
      url: "https://x.com/owner/status/2",
      text: body("owner", "The new rules of context engineering", "article", ARTICLE),
      metadata: { url: "https://x.com/owner/status/2", combined_score: "0.60" },
    },
    [`${today}_amp2_3.md`]: {
      url: "https://x.com/amp2/status/3",
      text: body("amp2", "This article is a must-read", "note", ARTICLE),
      metadata: { url: "https://x.com/amp2/status/3", combined_score: "0.59" },
    },
    [`${today}_plain_4.md`]: {
      url: "https://x.com/plain/status/4",
      text: body("plain", "an unrelated tweet about eval design", null, null),
      metadata: { url: "https://x.com/plain/status/4", combined_score: "0.58" },
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
    gateCalls.length = 0;
    gateThrowFirstN = 0;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    candidateRows.clear();
    authorThresholds = null;
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const watcher = (config: Record<string, unknown>): Watcher => ({
    id: "xw-amp",
    userId: "u1",
    botName: "jarvis",
    name: "X Daily Digest",
    type: "x",
    config: { collection: "x-feed", windowDays: 1, ...config },
    intervalMs: 86_400_000,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  });

  test("the digest sees ONE line per article — the group's HIGHEST-scoring doc", async () => {
    await checkX(watcher({}));
    // @amp1 (0.61) outscores the article doc (0.60), so IT keeps the group's one slot —
    // collapse never downgrades. The article doc and the weaker amplifier are gone.
    expect(lastGatePrompt).toContain("@amp1: Everyone should read this article");
    expect(lastGatePrompt).not.toContain("@owner:");
    expect(lastGatePrompt).not.toContain("@amp2:");
    // Non-article docs are untouched.
    expect(lastGatePrompt).toContain("@plain:");
    expect(lastGatePrompt).toContain("Here are 2 tweets");
  });

  test("collapse does NOT shrink the capture batch — every fetched doc is still gated", async () => {
    gateResult = "[]";
    await checkX(watcher({ captureCandidates: true }));
    // The capture gate's numbered list carries all four fetched docs, amplifiers included.
    expect(lastGatePrompt).toContain("@amp1:");
    expect(lastGatePrompt).toContain("@amp2:");
    expect(lastGatePrompt).toContain("@owner:");
  });
});

// ── Repackaging shape + the deterministic post-gate clamp ───────────

describe("isRepackagingShaped", () => {
  test("the three clauses, on real shelf titles", () => {
    // ALL-CAPS run ≥8 (@vicky_grok, gate-scored 0.92)
    expect(isRepackagingShaped("EXO JUST SHOWED HOW SELF-IMPROVING AI AGENTS ACTUALLY WORK.")).toBe(true);
    // 🚨 opener, after leading whitespace
    expect(isRepackagingShaped("  🚨 Anthropic ships a new agent SDK")).toBe(true);
    // "just <verb>" (@Dipanshu_AI, gate-scored 0.88)
    expect(isRepackagingShaped("Anthropic just released a 4-hour course on building agents")).toBe(true);
    expect(isRepackagingShaped("They Just Dropped the weights")).toBe(true);
  });

  test("ordinary long-form is left alone", () => {
    expect(isRepackagingShaped("A measured look at how retrieval degrades under load")).toBe(false);
    // 7 consecutive capitals — one short of the bar the census measured.
    expect(isRepackagingShaped("MISTRAL ships a smaller model")).toBe(false);
    // Acronym-heavy but no run reaches 8.
    expect(isRepackagingShaped("MCP + RAG with LLM: what actually broke")).toBe(false);
    // "just" without one of the four verbs.
    expect(isRepackagingShaped("I just spent a week benchmarking agent loops")).toBe(false);
    expect(isRepackagingShaped("")).toBe(false);
    // 🚨 mid-line is not the opener shape.
    expect(isRepackagingShaped("my alerting setup 🚨 finally works")).toBe(false);
  });
});

describe("clampScores", () => {
  const all = () => true;

  test("lowers only what is over the cap, and reports how many", () => {
    const scores = [
      { n: 1, score: 0.92, why: "a" },
      { n: 2, score: 0.8, why: "b" },
      { n: 3, score: 0.5, why: "c" },
    ];
    const out = clampScores(scores, all);
    expect(out.scores.map((s) => s.score)).toEqual([0.8, 0.8, 0.5]);
    expect(out.clamped).toBe(1);
    expect(REPACKAGING_SCORE_CAP).toBe(0.8);
  });

  test("never raises, and never touches an entry the predicate rejects", () => {
    const scores = [{ n: 1, score: 0.3, why: "" }, { n: 2, score: 0.95, why: "" }];
    expect(clampScores(scores, (n) => n === 1)).toEqual({ scores, clamped: 0 });
  });

  test("returns a NEW array and leaves the input untouched", () => {
    const scores = [{ n: 1, score: 0.95, why: "keep me" }];
    const out = clampScores(scores, all);
    expect(out.scores).not.toBe(scores);
    expect(scores[0]!.score).toBe(0.95);
    expect(out.scores[0]).toEqual({ n: 1, score: 0.8, why: "keep me" });
  });
});

describe("checkX: repackaging clamp (end-to-end through the capture path)", () => {
  const realFetch = globalThis.fetch;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const noteDoc = (handle: string, firstLine: string) =>
    [
      `# @${handle} — note`,
      "",
      firstLine,
      "",
      "Then several more paragraphs of body text that the gate would read in full.",
      "",
      "---",
      "",
      "- **Engagement:** 900 likes · 120,000 views",
      "- **Type:** note",
      `- **Link:** https://x.com/${handle}/status/1`,
    ].join("\n");

  const pointerDoc = (handle: string, firstLine: string) =>
    [
      `# @${handle} — tweet`,
      "",
      firstLine,
      "",
      "---",
      "",
      "- **Engagement:** 900 likes · 120,000 views",
      `- **Link:** https://x.com/${handle}/status/2`,
      "- **Links:** https://example.com/deep-dive",
    ].join("\n");

  /** docId → body, served by the mocked huginn; set per test. */
  let served: Record<string, string> = {};

  const install = (docs: Record<string, string>) => {
    served = docs;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/collection/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            documents: Object.keys(served).map((id, i) => ({
              id,
              url: `https://x.com/h/status/${i}`,
              combined_score: String(0.75 - i * 0.01),
            })),
          }),
        } as unknown as Response;
      }
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: served[id] ?? "", metadata: { combined_score: "0.7" } }),
      } as unknown as Response;
    }) as typeof fetch;
  };

  beforeEach(() => {
    gateResult = "[]";
    gateThrow = false;
    gateCalls.length = 0;
    gateThrowFirstN = 0;
    lastGatePrompt = "";
    upsertCalls.length = 0;
    candidateRows.clear();
    upsertThrow = false;
    logLines.length = 0;
    for (const k of Object.keys(authorScoreByHandle)) delete authorScoreByHandle[k];
    authorThresholds = null;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const watcher = (captureMaxItems?: number): Watcher => ({
    id: "xw-clamp",
    userId: "u1",
    botName: "jarvis",
    name: "X Highlights",
    type: "x",
    config: {
      collection: "x-feed",
      windowDays: 2,
      maxDocs: 80,
      topN: 10,
      quietMode: true,
      dedupByTweetId: true,
      captureCandidates: true,
      candidateMinScore: 0.6,
      ...(captureMaxItems === undefined ? {} : { captureMaxItems }),
    },
    intervalMs: 7_200_000,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  });

  test("a shaped long-form post scored 0.92 persists at the 0.8 cap, and the gate line says so", async () => {
    install({
      [`${today}_hypeguy_1.md`]: noteDoc(
        "hypeguy",
        "EXO JUST SHOWED HOW SELF-IMPROVING AI AGENTS ACTUALLY WORK.",
      ),
    });
    gateResult = JSON.stringify([{ n: 1, score: 0.92, why: "recap of someone else's release" }]);

    await checkX(watcher(), "jarvis");

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]!.kind).toBe("x-post");
    expect(upsertCalls[0]!.score).toBe(0.8);
    // `why` rides through untouched — the clamp only moves the number.
    expect(upsertCalls[0]!.why).toBe("recap of someone else's release");
    const gateLine = logLines.find((l) => l.message.startsWith("x-capture-gate {outcome}"));
    expect(gateLine?.message).toContain("clamped={clamped}");
    expect(gateLine?.props.clamped).toBe(1);
  });

  test("with K=1 the clamped 0.92 hype note LOSES the slot to a plain 0.85 post", async () => {
    // The mechanism behind the acceptance line: the clamp runs before the limit, so the
    // shaped note drops to 0.8 and no longer out-ranks an ordinary post at 0.85.
    install({
      [`${today}_hypeguy_1.md`]: noteDoc(
        "hypeguy",
        "EXO JUST SHOWED HOW SELF-IMPROVING AI AGENTS ACTUALLY WORK.",
      ),
      [`${today}_analyst_2.md`]: noteDoc(
        "analyst",
        "A measured look at how retrieval degrades under load",
      ),
    });
    gateResult = JSON.stringify([
      { n: 1, score: 0.92, why: "hype recap" },
      { n: 2, score: 0.85, why: "original benchmarks" },
    ]);

    await checkX(watcher(1), "jarvis");

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]!.author).toBe("analyst");
    expect(upsertCalls[0]!.score).toBe(0.85);
  });

  test("a shaped POINTER tweet is NEVER clamped — pointers are scored on their destination", async () => {
    authorThresholds = { top1: 0.9, top5: 0.5 }; // make the pointer author top-tier
    authorScoreByHandle["scout"] = 0.8;
    install({
      [`${today}_scout_1.md`]: pointerDoc("scout", "🚨 ANTHROPIC JUST RELEASED the new agent SDK"),
    });
    gateResult = JSON.stringify([{ n: 1, score: 0.92, why: "primary-source release notes" }]);

    await checkX(watcher(), "jarvis");

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]!.kind).toBe("x-link");
    expect(upsertCalls[0]!.score).toBe(0.92);
    const gateLine = logLines.find((l) => l.message.startsWith("x-capture-gate {outcome}"));
    expect(gateLine?.props.clamped).toBe(0);
  });
});
