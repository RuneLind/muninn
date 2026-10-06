/**
 * `GET /api/research/ask?factcheck=<source>:<docId>` — a follow-up from a
 * summary's doc panel carries that summary's saved fact check as a bounded
 * rider. The stream and the row lookup are injected, so no retrieval, model or
 * database runs; `streamResearchAnswer`'s use of the rider is `ask.test.ts`'s.
 */

import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { registerResearchRoutes, type ResearchRouteDeps } from "./research-routes.ts";
import type { ResearchSseOptions } from "./research-sse.ts";
import type { SummaryFactcheck } from "../../db/summary-factchecks.ts";
import { ASK_FACTCHECK_RIDER_MAX } from "../../summaries/factcheck-rider.ts";

const config = { knowledgeApiUrl: "http://127.0.0.1:1" } as never;

const DOC = "health/Talk: part 2.md";
const row: SummaryFactcheck = {
  collection: "vimeo-summaries",
  docId: DOC,
  url: "https://vimeo.com/1",
  bodySha256: "a".repeat(64),
  answer: "### ❌ Claim 1/1 — Coffee cures colds\n\nNo trial supports it.\n\nConfidence: 20/100",
  claims: [{ index: 1, title: "Coffee cures colds", quote: "Coffee cures colds.", verdict: "❌", outcome: "verified", sources: [] }],
  botName: "jarvis",
  createdAt: Date.UTC(2026, 9, 5, 10, 0, 0),
  transcript: null,
  transcriptSha256: null,
  appliedAt: null,
};

function harness(get: ResearchRouteDeps["getFactcheck"]) {
  const seen: { opts: ResearchSseOptions[]; lookups: string[] } = { opts: [], lookups: [] };
  const app = new Hono();
  registerResearchRoutes(app, config, {
    getFactcheck: async (collection, docId) => {
      seen.lookups.push(`${collection}|${docId}`);
      return get(collection, docId);
    },
    stream: ((c: { text: (s: string) => Response }, opts: ResearchSseOptions) => {
      seen.opts.push(opts);
      return c.text("ok");
    }) as never,
  });
  return { app, seen };
}

const ask = (app: Hono, extra = "") => app.request(`/api/research/ask?q=${encodeURIComponent("Does coffee cure colds?")}${extra}`);

describe("GET /api/research/ask — factcheck", () => {
  test("a summary with a saved ❌ claim: the rider carries the correction, bounded", async () => {
    const { app, seen } = harness(async () => row);
    const res = await ask(app, `&factcheck=${encodeURIComponent(`vimeo:${DOC}`)}`);
    expect(res.status).toBe(200);
    // Split on the FIRST colon: the doc id keeps its own.
    expect(seen.lookups).toEqual([`vimeo-summaries|${DOC}`]);
    const rider = seen.opts[0]!.factcheckRider!;
    expect(rider).toContain("the talk claims “Coffee cures colds”");
    expect(rider).toContain("No trial supports it.");
    expect(rider).toContain("The talk claims X; the saved fact check found Y.");
    expect(Array.from(rider).length).toBeLessThanOrEqual(ASK_FACTCHECK_RIDER_MAX);
  });

  // Fix round 1: a declined ask runs no synthesis, so the route also hands the
  // stream a reader-facing note of the same findings.
  test("the options also carry the decline note with the correction", async () => {
    const { app, seen } = harness(async () => row);
    await ask(app, `&factcheck=${encodeURIComponent(`vimeo:${DOC}`)}`);
    const note = seen.opts[0]!.factcheckNote!;
    expect(note).toContain("The saved fact check of this summary (2026-10-05) found:");
    expect(note).toContain("No trial supports it.");
  });

  test("without the parameter the options carry no rider and nothing is looked up", async () => {
    const { app, seen } = harness(async () => row);
    await ask(app);
    expect(seen.lookups).toEqual([]);
    expect("factcheckRider" in seen.opts[0]!).toBe(false);
  });

  test.each([
    ["unknown source", "&factcheck=bogus:x.md"],
    ["no colon", "&factcheck=vimeo"],
    ["dot segment", `&factcheck=${encodeURIComponent("vimeo:../x.md")}`],
    ["empty", "&factcheck="],
  ])("%s: no rider, no error, no lookup", async (_name, extra) => {
    const { app, seen } = harness(async () => row);
    const res = await ask(app, extra);
    expect(res.status).toBe(200);
    expect(seen.lookups).toEqual([]);
    expect("factcheckRider" in seen.opts[0]!).toBe(false);
  });

  test("no row, a row with nothing wrong, or a failed lookup: no rider, no error", async () => {
    const getters: ResearchRouteDeps["getFactcheck"][] = [
      async () => null,
      async () => ({ ...row, claims: [{ ...row.claims[0]!, verdict: "✅" }] }),
      async () => {
        throw new Error("db down");
      },
    ];
    for (const get of getters) {
      const { app, seen } = harness(get);
      const res = await ask(app, `&factcheck=${encodeURIComponent(`vimeo:${DOC}`)}`);
      expect(res.status).toBe(200);
      expect(seen.lookups).toHaveLength(1);
      expect("factcheckRider" in seen.opts[0]!).toBe(false);
      expect("factcheckNote" in seen.opts[0]!).toBe(false);
    }
  });
});
