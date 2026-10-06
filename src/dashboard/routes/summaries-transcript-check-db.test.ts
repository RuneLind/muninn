/**
 * The transcript check against the REAL test database: the shipped store
 * functions (`defaultSummariesFactcheckDeps`), only huginn and the model call
 * stubbed. Proves D14 end to end — verdicts saved on the web row and joined by
 * index on `/result`, a web re-check upsert nulling both columns — and the 503
 * on a database without migration 081, where the web upsert must keep working.
 *
 * Applies migration 081 itself in `beforeAll` (idempotent `ADD COLUMN IF NOT
 * EXISTS`), so a test database built before it still runs this file.
 * Its own `bun test` link in the `test` and `test:db` chains.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { setupTestDb } from "../../test/setup-db.ts";
import { getDb } from "../../db/client.ts";
import { getSummaryFactcheck, upsertSummaryFactcheck, type SummaryFactcheckInput } from "../../db/summary-factchecks.ts";
import { defaultSummariesFactcheckDeps, registerSummariesFactcheckRoutes } from "./summaries-factcheck.ts";
import { factcheckBodySha256 } from "../../summaries/factcheck-body.ts";

setupTestDb();

const MIGRATION = join(import.meta.dir, "../../../db/migrations/081-summary-factchecks-transcript.sql");
const applyMigration = async () => getDb().unsafe(await Bun.file(MIGRATION).text());

beforeAll(applyMigration);
afterAll(applyMigration);

const DOC = "science/A synthesized talk.md";
const TRANSCRIPT = "### [00:00:00]\n\nThe speaker says the bridge opened in 1931 and carries six lanes.";
const SOURCE_TEXT = `The bridge opened in 1931 and carries six lanes.\n\n## Transcript\n\n${TRANSCRIPT}\n`;

const web: SummaryFactcheckInput = {
  collection: "youtube-summaries",
  docId: DOC,
  url: "https://www.youtube.com/watch?v=synthetic",
  bodySha256: factcheckBodySha256(SOURCE_TEXT),
  answer: "### ❌ Claim 1/2 — opened 1931\n\n### ✅ Claim 2/2 — six lanes",
  claims: [
    { index: 1, title: "The bridge opened in 1931", quote: "opened in 1931", verdict: "❌", outcome: "verified", sources: [] },
    { index: 2, title: "The bridge carries six lanes", verdict: "✅", outcome: "verified", sources: [] },
  ],
  botName: "webbot",
};

let prompts: string[] = [];

function app(): Hono {
  const a = new Hono();
  registerSummariesFactcheckRoutes(a, { knowledgeApiUrl: "http://127.0.0.1:1" } as never, {
    ...defaultSummariesFactcheckDeps("http://127.0.0.1:1"),
    readSourceText: async () => SOURCE_TEXT,
    fetchDocMeta: async () => null,
    bots: () => [{ name: "sumbot", dir: "/tmp/sumbot", connector: "openai-compat" }] as never,
    transcriptCall: async (p) => {
      prompts.push(p);
      return {
        result: JSON.stringify({
          claims: [
            { index: 1, verdict: "supported", note: "\"opened in 1931\"" },
            { index: 2, verdict: "supported", note: "\"carries six lanes\"" },
          ],
        }),
        model: "claude-sonnet-5-5",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  });
  return a;
}

const post = (a: Hono) =>
  a.request("/api/summaries/factcheck/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "youtube", docId: DOC }),
  });

const result = async (a: Hono) =>
  (await (await a.request(`/api/summaries/factcheck/result?source=youtube&docId=${encodeURIComponent(DOC)}`)).json()) as {
    result: { transcript: { claims: { index: number; verdict: string }[] } | null; transcriptSha256: string | null } | null;
    transcriptHtml: string | null;
    hasTranscript: boolean | null;
  };

describe("transcript check on the real store", () => {
  test("web row → transcript POST → /result joins by index → web re-check nulls both columns", async () => {
    prompts = [];
    await upsertSummaryFactcheck(web);
    const a = app();

    const res = await post(a);
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);

    const raw = await getDb()`SELECT transcript_claims, transcript_sha256 FROM summary_factchecks WHERE doc_id = ${DOC}`;
    expect(raw[0]!.transcript_claims.claims).toHaveLength(2);
    expect(raw[0]!.transcript_sha256).toMatch(/^[0-9a-f]{64}$/);

    const r = await result(a);
    expect(r.hasTranscript).toBe(true);
    expect(r.result!.transcript!.claims.map((c) => [c.index, c.verdict])).toEqual([[1, "supported"], [2, "supported"]]);
    const row1 = /<li data-claim-index="1">.*?<\/li>/.exec(r.transcriptHtml!)![0];
    expect(row1).toContain("❌");
    expect(row1).toContain("the source got it wrong");

    // A web re-check is a new claim set: both transcript columns go back to NULL.
    await upsertSummaryFactcheck({ ...web, answer: "re-checked" });
    const after = await getDb()`SELECT transcript_claims, transcript_sha256 FROM summary_factchecks WHERE doc_id = ${DOC}`;
    expect(after[0]!.transcript_claims).toBeNull();
    expect(after[0]!.transcript_sha256).toBeNull();
    const r2 = await result(a);
    expect(r2.result!.transcript).toBeNull();
    expect(r2.transcriptHtml).toBeNull();
  });

  test("a save against a claim set that changed meanwhile matches nothing", async () => {
    const { saveSummaryTranscriptCheck } = await import("../../db/summary-factchecks.ts");
    await upsertSummaryFactcheck(web);
    const ok = await saveSummaryTranscriptCheck({
      collection: web.collection,
      docId: DOC,
      expectClaims: [{ ...web.claims[0]!, verdict: "✅" }, web.claims[1]!],
      check: { claims: [], cut: { truncated: false, keptChars: 0, totalChars: 0 }, model: "m", botName: "b", checkedAt: 0 },
      transcriptSha256: "x",
    });
    expect(ok).toBe(false);
    expect((await getSummaryFactcheck(web.collection, DOC))!.transcript).toBeNull();
  });

  test("without migration 081: the POST is a 503 naming it, and the web upsert and /result still work", async () => {
    await getDb().unsafe(
      "ALTER TABLE summary_factchecks DROP COLUMN IF EXISTS transcript_claims, DROP COLUMN IF EXISTS transcript_sha256",
    );
    try {
      prompts = [];
      await upsertSummaryFactcheck(web);
      await upsertSummaryFactcheck({ ...web, answer: "again" });
      const a = app();
      const res = await post(a);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("migration_081");
      expect(body.error).toContain("081");
      expect(prompts).toHaveLength(0);
      const r = await result(a);
      expect(r.result!.transcript).toBeNull();
      expect(r.transcriptHtml).toBeNull();
    } finally {
      await applyMigration();
    }
  });

  test("a malformed transcript_claims value maps to no transcript check, and /result still renders the web check", async () => {
    await upsertSummaryFactcheck(web);
    const a = app();
    for (const bad of [
      { claims: "nope" },
      [1, 2],
      { claims: [{ index: 1, verdict: "supported", note: "n" }] },
      { claims: [{ index: 1, verdict: "maybe", note: "n" }], cut: { truncated: false, keptChars: 1, totalChars: 1 }, model: "m", botName: "b", checkedAt: 0 },
    ]) {
      await getDb()`UPDATE summary_factchecks SET transcript_claims = ${getDb().json(bad as never)}, transcript_sha256 = ${"d".repeat(64)} WHERE doc_id = ${DOC}`;
      expect((await getSummaryFactcheck(web.collection, DOC))!.transcript).toBeNull();
      const res = await a.request(`/api/summaries/factcheck/result?source=youtube&docId=${encodeURIComponent(DOC)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { html: string; transcriptHtml: string | null };
      expect(body.html).toContain("Claim 1/2");
      expect(body.transcriptHtml).toBeNull();
    }
  });
});

describe("fix round 2", () => {
  test("valid claims with a bad cut, note, model or index map to no check — with no sha — and /result still answers 200", async () => {
    await upsertSummaryFactcheck(web);
    const a = app();
    const claims = [{ index: 1, verdict: "supported", note: "n" }];
    const base = { claims, cut: { truncated: false, keptChars: 1, totalChars: 1 }, model: "m", botName: "b", checkedAt: 0 };
    for (const bad of [
      { ...base, cut: { truncated: true } },
      { ...base, claims: [{ index: 1, verdict: "supported", note: 7 }] },
      { ...base, claims: [{ index: 1.5, verdict: "supported", note: "n" }] },
      { ...base, model: 1 },
      { ...base, botName: null },
      { ...base, checkedAt: "0" },
    ]) {
      await getDb()`UPDATE summary_factchecks SET transcript_claims = ${getDb().json(bad as never)}, transcript_sha256 = ${"d".repeat(64)} WHERE doc_id = ${DOC}`;
      const row = (await getSummaryFactcheck(web.collection, DOC))!;
      expect(row.transcript, JSON.stringify(bad)).toBeNull();
      expect(row.transcriptSha256, JSON.stringify(bad)).toBeNull();
      const res = await a.request(`/api/summaries/factcheck/result?source=youtube&docId=${encodeURIComponent(DOC)}`);
      expect(res.status, JSON.stringify(bad)).toBe(200);
      expect(((await res.json()) as { transcriptHtml: string | null }).transcriptHtml).toBeNull();
    }
    // The same row with a good value keeps its sha.
    await getDb()`UPDATE summary_factchecks SET transcript_claims = ${getDb().json(base as never)}, transcript_sha256 = ${"d".repeat(64)} WHERE doc_id = ${DOC}`;
    expect((await getSummaryFactcheck(web.collection, DOC))!.transcriptSha256).toBe("d".repeat(64));
  });
});
