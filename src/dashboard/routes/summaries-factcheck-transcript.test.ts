/**
 * `POST /api/summaries/factcheck/transcript` and the transcript half of
 * `/result`, with the store, huginn and the model call faked through the
 * route's deps (no `mock.module`). The real-database twin is
 * `summaries-transcript-check-db.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSummariesFactcheckRoutes, type SummariesFactcheckDeps } from "./summaries-factcheck.ts";
import { TRANSCRIPT_MIGRATION_MISSING, transcriptSha256 } from "./summaries-factcheck-transcript.ts";
import { isSideEffectingRequest, SIDE_EFFECTING_GETS, decideOrigin } from "../../auth/origin.ts";
import type { SummaryFactcheck } from "../../db/summary-factchecks.ts";
import type { SavedTranscriptCheck } from "../../summaries/transcript-check.ts";

const DOC = "health/sleep/A talk.md";
const TRANSCRIPT = "### [00:00:00]\n\nThe speaker says caffeine's half-life is nine hours.";
const SOURCE_TEXT = `Caffeine has a half-life of nine hours.\n\n## Transcript\n\n${TRANSCRIPT}\n`;
const config = { knowledgeApiUrl: "http://x" } as never;
const bot = { name: "sumbot", dir: "/tmp/sumbot", connector: "openai-compat" } as never;

const webRow = (): SummaryFactcheck => ({
  collection: "youtube-summaries",
  docId: DOC,
  url: null,
  bodySha256: "a".repeat(64),
  answer: "### ❌ Claim 1/2 — half-life nine hours\n\n### ✅ Claim 2/2 — coffee exists",
  claims: [
    { index: 1, title: "Caffeine's half-life is nine hours", quote: "a half-life of nine hours", verdict: "❌", outcome: "verified", sources: [] },
    { index: 2, title: "Coffee contains caffeine", verdict: "✅", outcome: "verified", sources: [] },
  ],
  botName: "webbot",
  createdAt: 1_700_000_000_000,
  transcript: null,
  transcriptSha256: null,
});

let stored: SummaryFactcheck | null;
let source: string | null;
let columns: boolean;
let saveResult: boolean;
let saves: Parameters<SummariesFactcheckDeps["store"]["saveTranscript"]>[0][];
let prompts: string[];
let answer: string | Error;

function app(bots: unknown[] = [bot]): Hono {
  const deps: SummariesFactcheckDeps = {
    readSourceText: async () => source,
    fetchDocMeta: async () => null,
    store: {
      upsert: async () => { throw new Error("not used"); },
      get: async () => stored,
      listBadges: async () => [],
      saveTranscript: async (input) => {
        saves.push(input);
        if (saveResult && stored) stored = { ...stored, transcript: input.check, transcriptSha256: input.transcriptSha256 };
        return saveResult;
      },
      transcriptColumnsPresent: async () => columns,
    },
    bots: () => bots as never,
    transcriptCall: async (p) => {
      prompts.push(p);
      if (answer instanceof Error) throw answer;
      return { result: answer, model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 5 };
    },
  };
  const a = new Hono();
  registerSummariesFactcheckRoutes(a, config, deps);
  return a;
}

const post = (a: Hono, body: unknown = { source: "youtube", docId: DOC }, contentType = "application/json") =>
  a.request("/api/summaries/factcheck/transcript", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  stored = webRow();
  source = SOURCE_TEXT;
  columns = true;
  saveResult = true;
  saves = [];
  prompts = [];
  answer = JSON.stringify({
    claims: [
      { index: 1, verdict: "supported", note: "\"half-life is nine hours\"" },
      { index: 2, verdict: "not in transcript", note: "coffee never named" },
    ],
  });
});

describe("POST /api/summaries/factcheck/transcript — request and preflight", () => {
  test("a non-JSON body is 415 before any work", async () => {
    const res = await post(app(), { source: "youtube", docId: DOC }, "text/plain");
    expect(res.status).toBe(415);
    expect(prompts).toHaveLength(0);
  });

  test("being a POST, the origin guard covers it by method — no SIDE_EFFECTING_GETS entry needed", () => {
    const path = "/api/summaries/factcheck/transcript";
    expect(SIDE_EFFECTING_GETS).not.toContain(path);
    expect(isSideEffectingRequest("POST", path)).toBe(true);
    const refused = decideOrigin({
      mode: "off",
      method: "POST",
      path,
      origin: "https://evil.example",
      secFetchSite: "cross-site",
      host: "127.0.0.1:3010",
      allowedOrigins: ["http://127.0.0.1:3010"],
    });
    expect(refused.allowed).toBe(false);
  });

  test("bad source / docId are 400; no bot is 503", async () => {
    expect((await post(app(), { source: "nope", docId: DOC })).status).toBe(400);
    expect((await post(app(), { source: "youtube", docId: "../x" })).status).toBe(400);
    expect((await post(app(), {})).status).toBe(400);
    expect((await post(app([]))).status).toBe(503);
  });

  test("migration 081 missing is a 503 naming it, and no model call", async () => {
    columns = false;
    const res = await post(app());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("migration_081");
    expect(body.error).toBe(TRANSCRIPT_MIGRATION_MISSING);
    expect(body.error).toContain("081");
    expect(prompts).toHaveLength(0);
  });

  test("no saved web check, or one without claims, is 409 — the check reads its claims", async () => {
    stored = null;
    expect(((await (await post(app())).json()) as { code: string }).code).toBe("no_web_check");
    stored = { ...webRow(), claims: [] };
    expect((await post(app())).status).toBe(409);
    expect(prompts).toHaveLength(0);
  });

  test("a document without a transcript is 409; an unreadable one 502", async () => {
    source = "Only a summary.";
    expect(((await (await post(app())).json()) as { code: string }).code).toBe("no_transcript");
    source = null;
    expect((await post(app())).status).toBe(502);
    expect(prompts).toHaveLength(0);
  });

  test("the summarizer needs no web tools: an openai-compat bot runs it", async () => {
    expect((await post(app())).status).toBe(200);
  });
});

describe("POST /api/summaries/factcheck/transcript — the check", () => {
  test("one call over the saved claims and the transcript; saved against that claim set; joined chips in the HTML", async () => {
    const res = await post(app());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transcript: SavedTranscriptCheck; html: string; cutNote: string | null };
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[1] Caffeine's half-life is nine hours");
    expect(prompts[0]).toContain("half-life is nine hours.");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.expectClaims).toEqual(webRow().claims);
    expect(saves[0]!.transcriptSha256).toBe(transcriptSha256(TRANSCRIPT));
    expect(body.transcript.claims.map((c) => c.verdict)).toEqual(["supported", "not in transcript"]);
    expect(body.cutNote).toBeNull();
    // Web ❌ + transcript supported: the source's error, on claim 1's row.
    const row1 = /<li data-claim-index="1">.*?<\/li>/.exec(body.html)![0];
    expect(row1).toContain("❌");
    expect(row1).toContain('data-tverdict="supported"');
    expect(row1).toContain("the source got it wrong");
    const row2 = /<li data-claim-index="2">.*?<\/li>/.exec(body.html)![0];
    expect(row2).toContain("transcript: not in transcript");
    expect(row2).toContain("not from the source");
  });

  test("a failed call or an unusable answer is 502 and saves nothing", async () => {
    answer = new Error("model down");
    expect((await post(app())).status).toBe(502);
    answer = JSON.stringify({ claims: [{ index: 1, verdict: "supported" }] });
    const res = await post(app());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("claim(s) 2");
    expect(saves).toHaveLength(0);
  });

  test("a web re-check that replaced the claims mid-call is 409, not verdicts on the wrong claims", async () => {
    saveResult = false;
    const res = await post(app());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("web_check_changed");
  });

  test("a second click while one runs is 409", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const a = new Hono();
    registerSummariesFactcheckRoutes(a, config, {
      readSourceText: async () => source,
      fetchDocMeta: async () => null,
      store: {
        upsert: async () => { throw new Error("x"); },
        get: async () => stored,
        listBadges: async () => [],
        saveTranscript: async () => true,
        transcriptColumnsPresent: async () => true,
      },
      bots: () => [bot],
      transcriptCall: async () => {
        await held;
        return { result: answer as string, model: "m", inputTokens: 1, outputTokens: 1 };
      },
    });
    const first = post(a);
    await new Promise((r) => setTimeout(r, 10));
    expect((await post(a)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});

describe("GET /api/summaries/factcheck/result — transcript half", () => {
  const result = async (a: Hono) =>
    (await (await a.request(`/api/summaries/factcheck/result?source=youtube&docId=${encodeURIComponent(DOC)}`)).json()) as {
      hasTranscript: boolean | null;
      transcriptHtml: string | null;
      transcriptStale: boolean | null;
      result: SummaryFactcheck;
    };

  test("hasTranscript follows the document; no check yet means no transcript HTML", async () => {
    const r = await result(app());
    expect(r.hasTranscript).toBe(true);
    expect(r.transcriptHtml).toBeNull();
    source = "Only a summary.";
    expect((await result(app())).hasTranscript).toBe(false);
    source = null;
    expect((await result(app())).hasTranscript).toBeNull();
  });

  test("a reload shows the saved verdicts joined by index, and a changed transcript marks them stale", async () => {
    const a = app();
    await post(a);
    const r = await result(a);
    expect(r.result.transcript!.claims).toHaveLength(2);
    expect(r.transcriptStale).toBe(false);
    expect(r.transcriptHtml).toContain("the source got it wrong");
    source = SOURCE_TEXT.replace("half-life is nine hours", "half-life is ten hours");
    const later = await result(a);
    expect(later.transcriptStale).toBe(true);
    expect(later.transcriptHtml).toContain("sum-fc-stale");
  });
});
