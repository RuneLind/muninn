/**
 * `/api/summaries/factcheck*` — driven through the REAL `streamFactcheckSSE`
 * with three seams faked: the Phase-1 extraction Haiku (`mock.module`), the
 * per-claim/compose `oneShot`, and the route's huginn + store deps.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test` and
 * `test:unit` chains): `mock.module` on `ai/haiku-direct.ts` and `db/traces.ts`
 * invalidates them for every file in the process — see the root CLAUDE.md.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

const realTraces = await import("../../db/traces.ts");
mock.module("../../db/traces.ts", () => ({
  ...realTraces,
  saveSpan: async () => {},
  updateSpan: async () => {},
}));

let extractionPrompts: string[] = [];
let extracted: { title: string; quote?: string }[] = [];
let extractionResult: string | null = null;

const realHaiku = await import("../../ai/haiku-direct.ts");
mock.module("../../ai/haiku-direct.ts", () => ({
  ...realHaiku,
  callHaikuWithFallback: async (prompt: string) => {
    extractionPrompts.push(prompt);
    return {
      result: extractionResult ?? JSON.stringify({ claims: extracted }),
      inputTokens: 1,
      outputTokens: 1,
      numTurns: 1,
      model: "claude-haiku-4-5",
      backend: "cli",
    };
  },
}));

const { registerSummariesFactcheckRoutes, isPartialRun } = await import("./summaries-factcheck.ts");
const { streamFactcheckSSE } = await import("./factcheck-sse.ts");
const { factcheckBodySha256 } = await import("../../summaries/factcheck-body.ts");
type Deps = import("./summaries-factcheck.ts").SummariesFactcheckDeps;
type Row = import("../../db/summary-factchecks.ts").SummaryFactcheck;
type RowInput = import("../../db/summary-factchecks.ts").SummaryFactcheckInput;

type SseEvent = { event: string; data: Record<string, unknown> };
function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const chunk of body.split("\n\n")) {
    const lines = chunk.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!ev || data === undefined) continue;
    out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
}

const config = { tracingEnabled: false, tracingCaptureToolOutputs: false, claudeModel: "sonnet", knowledgeApiUrl: "http://x" } as never;
const webBot = { name: "webbot", dir: "/tmp/webbot", connector: "claude-sdk" } as never;
const localBot = { name: "localbot", dir: "/tmp/localbot", connector: "openai-compat" } as never;

const DOC = "health/sleep/A talk.md";
const SUMMARY = "Sleep is good for you.\n\nCaffeine has a half-life of about five hours.";
const SOURCE_TEXT =
  `${SUMMARY}\n\n## Visual reference\n\n![slide](frames/1.jpg) The slide claims 9 hours.\n\n` +
  "## Transcript\n\n### [00:00:00]\n\nThe speaker says the moon is cheese.\n";

/** Verdict per claim title; anything else answers the compose call. */
let verdicts: Record<string, string> = {};
let failClaims = false;
/** Claim titles whose verify call throws (a per-claim `error` outcome). */
let failTitles = new Set<string>();
/** Claim titles whose verify call times out (a per-claim `timeout` outcome). */
let timeoutTitles = new Set<string>();
const oneShot = async (prompt: string) => {
  const m = /CLAIM \((\d+)\/(\d+)\): (.+)/.exec(prompt);
  if (!m) return { result: "Two claims checked.", inputTokens: 1, outputTokens: 1, numTurns: 1 };
  if (failClaims || failTitles.has(m[3]!)) throw new Error("upstream exploded");
  if (timeoutTitles.has(m[3]!)) throw new Error("Claude Agent SDK timed out after 90000ms");
  const [, i, n, title] = m;
  const v = verdicts[title!] ?? "✅";
  return {
    result: `### ${v} Claim ${i}/${n} — ${title}\n\nConfidence: 85/100\n\nSources: https://example.org/a, https://example.org/b.`,
    inputTokens: 1,
    outputTokens: 1,
    numTurns: 1,
  };
};

let source: string | null = SOURCE_TEXT;
let saved: RowInput[] = [];
let stored: Row | null = null;
let upsertThrows = false;
/** Migration 080's column; `false` ⇒ the route must refuse before any work. */
let schemaReady = true;

function app(bots: unknown[] = [webBot]): Hono {
  const deps: Deps = {
    readSourceText: async () => source,
    fetchDocMeta: async () => ({ title: "A talk", url: "https://www.youtube.com/watch?v=abc" }),
    store: {
      upsert: async (row) => {
        if (upsertThrows) throw new Error("db down");
        saved.push(row);
        stored = { ...row, createdAt: 1_700_000_000_000, transcript: null, transcriptSha256: null, appliedAt: null };
        return stored;
      },
      get: async () => stored,
      schemaReady: async () => schemaReady,
      listBadges: async () => [
        { collection: "youtube-summaries", docId: DOC, bad: 1, total: 2 },
        { collection: "not-a-summary-collection", docId: "x.md", bad: 0, total: 1 },
      ],
      saveTranscript: async () => true,
      transcriptColumnsPresent: async () => true,
    },
    bots: () => bots as never,
    oneShot: oneShot as never,
  };
  const a = new Hono();
  registerSummariesFactcheckRoutes(a, config, deps);
  return a;
}

const run = async (a: Hono, qs = `source=youtube&docId=${encodeURIComponent(DOC)}`) => {
  const res = await a.request(`/api/summaries/factcheck?${qs}`);
  return { res, events: res.headers.get("content-type")?.includes("event-stream") ? parseSse(await res.text()) : [] };
};
const done = (events: SseEvent[]) => events.find((e) => e.event === "done")?.data;

beforeEach(() => {
  extractionPrompts = [];
  extracted = [
    { title: "Sleep is good", quote: "Sleep is good for you." },
    { title: "Caffeine half-life is five hours", quote: "Caffeine has a half-life of about five hours." },
  ];
  extractionResult = null;
  verdicts = { "Caffeine half-life is five hours": "❌" };
  failClaims = false;
  failTitles = new Set();
  timeoutTitles = new Set();
  source = SOURCE_TEXT;
  saved = [];
  stored = null;
  upsertThrows = false;
  schemaReady = true;
});

describe("GET /api/summaries/factcheck — request checks", () => {
  test("an unknown source, an unsafe docId and a missing one are 400 before any work", async () => {
    expect((await run(app(), "source=nope&docId=a.md")).res.status).toBe(400);
    expect((await run(app(), "source=youtube&docId=..%2Fmimir%2Fx.md")).res.status).toBe(400);
    expect((await run(app(), "source=youtube")).res.status).toBe(400);
    expect(extractionPrompts).toEqual([]);
  });

  test("a summarizer bot without web tools is a 503 naming it", async () => {
    const { res } = await run(app([localBot]));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("localbot");
    expect(extractionPrompts).toEqual([]);
  });

  test("no bots at all is a 503", async () => {
    expect((await run(app([]))).res.status).toBe(503);
  });

  test("a database without migration 080 is a 503 naming it, before any model call", async () => {
    schemaReady = false;
    const { res } = await run(app());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("migration_080");
    expect(body.error).toContain("migration 080");
    expect(extractionPrompts).toEqual([]);
    expect(saved).toEqual([]);
  });
});

describe("GET /api/summaries/factcheck — the checked text", () => {
  test("claims are extracted from the summary only: transcript and visual-reference appendix cut", async () => {
    await run(app());
    expect(extractionPrompts).toHaveLength(1);
    expect(extractionPrompts[0]).toContain("Caffeine has a half-life");
    expect(extractionPrompts[0]).not.toContain("moon is cheese");
    expect(extractionPrompts[0]).not.toContain("9 hours");
  });

  test("an unreadable source file is an app_error and saves nothing", async () => {
    source = null;
    const { res, events } = await run(app());
    expect(res.status).toBe(200);
    expect(events.find((e) => e.event === "app_error")?.data.message).toContain("Could not read");
    expect(saved).toEqual([]);
  });
});

describe("GET /api/summaries/factcheck — persist on done, never on failure", () => {
  test("a completed run saves one row with per-claim verdicts and sources, and says so on done", async () => {
    const { events } = await run(app());
    expect(saved).toHaveLength(1);
    const row = saved[0]!;
    expect(row.collection).toBe("youtube-summaries");
    expect(row.docId).toBe(DOC);
    expect(row.url).toBe("https://www.youtube.com/watch?v=abc");
    expect(row.botName).toBe("webbot");
    expect(row.bodySha256).toBe(factcheckBodySha256(SOURCE_TEXT));
    expect(row.answer).toContain("Two claims checked.");
    expect(row.claims.map((c) => [c.index, c.verdict, c.outcome, c.confidence])).toEqual([
      [1, "✅", "verified", 85],
      [2, "❌", "verified", 85],
    ]);
    expect(row.claims[0]!.quote).toBe("Sleep is good for you.");
    expect(row.claims[0]!.sources).toEqual(["https://example.org/a", "https://example.org/b"]);
    const d = done(events)!;
    expect(d.saved).toBe(true);
    expect(d.checkedAt).toBe(1_700_000_000_000);
    expect(d.baseHash).toBe(row.bodySha256);
  });

  test("a run whose every claim failed saves nothing, so the earlier row stands", async () => {
    failClaims = true;
    const { events } = await run(app());
    expect(saved).toEqual([]);
    expect(done(events)!.saved).toBe(false);
    expect(done(events)!.reason).toBe("no-verdict");
  });

  test("a run that extracted no claims ends in app_error and saves nothing", async () => {
    extractionResult = "not json";
    const { events } = await run(app());
    expect(events.some((e) => e.event === "app_error")).toBe(true);
    expect(done(events)).toBeUndefined();
    expect(saved).toEqual([]);
  });

  test("a run whose client went away saves nothing (its unlaunched claims were skipped)", async () => {
    let releaseClaim: () => void = () => {};
    const claimHeld = new Promise<void>((r) => { releaseClaim = r; });
    let claimStarted: () => void = () => {};
    const started = new Promise<void>((r) => { claimStarted = r; });
    let composed: () => void = () => {};
    const composeCalled = new Promise<void>((r) => { composed = r; });
    const a = new Hono();
    registerSummariesFactcheckRoutes(a, config, {
      readSourceText: async () => SOURCE_TEXT,
      fetchDocMeta: async () => null,
      store: {
        upsert: async (row) => { saved.push(row); return { ...row, createdAt: 1, transcript: null, transcriptSha256: null, appliedAt: null }; },
        get: async () => null,
        listBadges: async () => [],
        saveTranscript: async () => true,
        transcriptColumnsPresent: async () => true,
      },
      bots: () => [webBot],
      oneShot: (async (prompt: string, ...rest: unknown[]) => {
        if (/CLAIM \(/.test(prompt)) { claimStarted(); await claimHeld; }
        else composed();
        return (oneShot as (p: string, ...r: unknown[]) => unknown)(prompt, ...rest);
      }) as never,
    });
    const ac = new AbortController();
    const res = await a.request(`/api/summaries/factcheck?source=youtube&docId=${encodeURIComponent(DOC)}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    void reader.read().catch(() => {});
    await started;
    ac.abort();
    await reader.cancel().catch(() => {});
    releaseClaim();
    await composeCalled;
    await new Promise((r) => setTimeout(r, 30));
    expect(saved).toEqual([]);
  });

  test("a PARTIAL re-run (a claim errored) does not replace an earlier complete row", async () => {
    const a = app();
    await run(a); // earlier complete row: [✅, ❌]
    expect(saved).toHaveLength(1);
    expect(stored!.claims.map((c) => c.verdict)).toEqual(["✅", "❌"]);
    failTitles = new Set(["Caffeine half-life is five hours"]);
    const { events } = await run(a);
    expect(saved).toHaveLength(1);
    expect(stored!.claims.map((c) => c.verdict)).toEqual(["✅", "❌"]);
    const d = done(events)!;
    expect(d.saved).toBe(false);
    expect(d.reason).toBe("partial");
  });

  test("a re-run where a claim TIMED OUT is partial too, and keeps the earlier row", async () => {
    const a = app();
    await run(a);
    timeoutTitles = new Set(["Caffeine half-life is five hours"]);
    const { events } = await run(a);
    expect(saved).toHaveLength(1);
    expect(done(events)!.reason).toBe("partial");
  });

  test("a partial run REPLACES a stale earlier row: its verdicts describe text that is gone", async () => {
    const a = app();
    await run(a); // [✅, ❌] saved against SOURCE_TEXT
    source = SOURCE_TEXT.replace("five hours", "six hours");
    failTitles = new Set(["Caffeine half-life is five hours"]);
    const { events } = await run(a);
    expect(saved).toHaveLength(2);
    expect(saved[1]!.bodySha256).toBe(factcheckBodySha256(source));
    expect(saved[1]!.claims.map((c) => c.outcome)).toEqual(["verified", "error"]);
    const d = done(events)!;
    expect(d.saved).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  test("a partial run with NO earlier row still saves (better than nothing)", async () => {
    failTitles = new Set(["Caffeine half-life is five hours"]);
    const { events } = await run(app());
    expect(saved).toHaveLength(1);
    expect(saved[0]!.claims.map((c) => c.outcome)).toEqual(["verified", "error"]);
    expect(done(events)!.saved).toBe(true);
  });

  test("a failed save still sends done, flagged unsaved", async () => {
    upsertThrows = true;
    const { events } = await run(app());
    expect(done(events)!.saved).toBe(false);
    expect(done(events)!.answer).toContain("Claim 2/2");
  });
});

describe("GET /api/summaries/factcheck/result — stale", () => {
  const result = async (a: Hono) =>
    (await (await a.request(`/api/summaries/factcheck/result?source=youtube&docId=${encodeURIComponent(DOC)}`)).json()) as {
      result: Row | null;
      stale: boolean | null;
    };

  test("no saved row answers null", async () => {
    expect(await result(app())).toEqual({ result: null, stale: null });
  });

  test("fresh when the summary is unchanged — a transcript-only change does not count", async () => {
    const a = app();
    await run(a);
    source = SOURCE_TEXT.replace("moon is cheese", "moon is rock");
    const r = await result(a);
    expect(r.result!.docId).toBe(DOC);
    expect(r.stale).toBe(false);
  });

  test("stale when the summary text changed since the check", async () => {
    const a = app();
    await run(a);
    source = SOURCE_TEXT.replace("five hours", "six hours");
    expect((await result(a)).stale).toBe(true);
  });

  test("unknown (null) when the source cannot be read to compare", async () => {
    const a = app();
    await run(a);
    source = null;
    expect((await result(a)).stale).toBeNull();
  });
});

describe("server-rendered answer HTML (the client bundles no markdown renderer)", () => {
  test("the stream ends with answer_html carrying confidence chips and clickable sources", async () => {
    const { events } = await run(app());
    const names = events.map((e) => e.event);
    expect(names.indexOf("answer_html")).toBeGreaterThan(names.indexOf("done"));
    const html = String(events.find((e) => e.event === "answer_html")!.data.html);
    expect(html).toContain('<span class="wiki-fc-conf-chip hi">85/100</span>');
    expect(html).toContain('href="https://example.org/a"');
    expect(html).not.toContain("Confidence: 85/100");
  });

  test("/result carries the saved answer rendered the same way", async () => {
    const a = app();
    await run(a);
    const r = (await (await a.request(`/api/summaries/factcheck/result?source=youtube&docId=${encodeURIComponent(DOC)}`)).json()) as {
      html?: string;
    };
    expect(r.html).toContain('<span class="wiki-fc-conf-chip hi">85/100</span>');
    expect(r.html).toContain('href="https://example.org/b"');
  });
});

describe("isPartialRun", () => {
  test("any claim without a ruling makes the run partial; rulings and model-chosen ❓ do not", () => {
    const run = (o: string) => ({ claims: [{ outcome: "verified" }, { outcome: o }] }) as never;
    expect(isPartialRun(run("error"))).toBe(true);
    expect(isPartialRun(run("timeout"))).toBe(true);
    expect(isPartialRun(run("skipped"))).toBe(true);
    expect(isPartialRun(run("verified"))).toBe(false);
    expect(isPartialRun(run("unverifiable"))).toBe(false);
  });
});

describe("GET /api/summaries/factcheck/badges", () => {
  test("maps collections to source ids and drops collections that are not summaries", async () => {
    const body = await (await app().request("/api/summaries/factcheck/badges")).json();
    expect(body).toEqual({ badges: [{ source: "youtube", docId: DOC, bad: 1, total: 2 }] });
  });
});

describe("the wiki's done payload is unchanged without onDone", () => {
  test("exactly the standard keys, in order", async () => {
    const a = new Hono();
    a.get("/fc", (c) =>
      streamFactcheckSSE(c, {
        config,
        botConfig: webBot,
        body: SUMMARY,
        meta: { title: "Sky", tags: [], type: "concept" },
        wikiName: "w",
        mode: "article",
        baseHash: "h",
        oneShot: oneShot as never,
      }),
    );
    const d = done(parseSse(await (await a.request("/fc")).text()))!;
    expect(Object.keys(d)).toEqual([
      "type", "answer", "cited", "noHits", "lowConfidence", "claimCount", "baseHash", "annotatable", "mode",
    ]);
  });
});

const { buildSummaryFactcheckBlock, factcheckBlockDate, insertSummaryFactcheckBlock } = await import(
  "../../summaries/factcheck-block.ts"
);
describe("GET /api/summaries/factcheck/result — blockAdded (fix round 1)", () => {
  const withBlock = (answer: string, createdAt: number) => {
    const cut = SOURCE_TEXT.indexOf("\n\n## Transcript");
    const body = insertSummaryFactcheckBlock(SOURCE_TEXT.slice(0, cut), buildSummaryFactcheckBlock(answer, factcheckBlockDate(createdAt)));
    return body + SOURCE_TEXT.slice(cut);
  };
  const result = async (a: Hono) =>
    (await (await a.request(`/api/summaries/factcheck/result?source=youtube&docId=${encodeURIComponent(DOC)}`)).json()) as {
      blockAdded: boolean | null;
      stale: boolean | null;
    };

  test("true when the document carries this check's block, false without one or with an older one", async () => {
    const a = app();
    await run(a);
    expect((await result(a)).blockAdded).toBe(false);
    source = withBlock(stored!.answer, stored!.createdAt);
    const r = await result(a);
    expect(r.blockAdded).toBe(true);
    expect(r.stale).toBe(false);
    source = withBlock("An older check's answer.", stored!.createdAt);
    expect((await result(a)).blockAdded).toBe(false);
    source = null;
    expect((await result(a)).blockAdded).toBeNull();
  });
});

const { notifySummaryDocumentDeleted } = await import("../../summaries/document-deleted.ts");

describe("a deleted document takes its saved check with it", () => {
  const deleted: string[] = [];
  let deleteFails: "reject" | "throw" | null = null;

  beforeEach(() => {
    deleted.length = 0;
    deleteFails = null;
  });

  // ONE registration for the describe: listeners are never unsubscribed.
  const a = new Hono();
  registerSummariesFactcheckRoutes(a, config, {
    readSourceText: async () => null,
    fetchDocMeta: async () => null,
    store: {
      upsert: async () => {
        throw new Error("unused");
      },
      get: async () => null,
      listBadges: async () => [],
      saveTranscript: async () => true,
      transcriptColumnsPresent: async () => true,
      delete: (collection, docId) => {
        if (deleteFails === "throw") throw new Error("sync throw");
        deleted.push(`${collection}|${docId}`);
        return deleteFails === "reject" ? Promise.reject(new Error("db down")) : Promise.resolve();
      },
    },
    bots: () => [],
  });

  const settle = () => new Promise((r) => setTimeout(r, 20));

  test("the row is removed by collection and doc id", async () => {
    notifySummaryDocumentDeleted({ collection: "youtube-summaries", id: DOC });
    await settle();
    expect(deleted).toEqual([`youtube-summaries|${DOC}`]);
  });

  test("a failing delete — rejected or thrown — raises no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const mode of ["reject", "throw"] as const) {
        deleteFails = mode;
        expect(() => notifySummaryDocumentDeleted({ collection: "youtube-summaries", id: DOC })).not.toThrow();
        await settle();
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(deleted).toEqual([`youtube-summaries|${DOC}`]);
  });
});
