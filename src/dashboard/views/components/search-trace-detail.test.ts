import { test, expect, describe, beforeEach } from "bun:test";
import { searchTraceDetailScript } from "./search-trace-detail.ts";

/**
 * The component is inline JS strings (matching the rest of the dashboard view
 * system, no framework). To unit-test it, we materialize the script into a
 * tiny sandbox with `esc` shimmed and a fake DOM, then call the exported
 * functions and assert on the returned HTML strings.
 */

const SANDBOX_PRELUDE = `
  function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  // Minimal getElementById stub — sttRerender writes innerHTML; we don't care for these tests.
  if (typeof document === 'undefined') {
    globalThis.document = { getElementById: () => ({ innerHTML: '' }) };
  }
`;

function loadSandbox(): { renderSearchTrace: (t: unknown) => string; reset: () => void; getState: () => Record<string, unknown> } {
  const script = SANDBOX_PRELUDE + searchTraceDetailScript() +
    `\n;return { renderSearchTrace, reset: () => { window.__sttState = { sortKey: 'final', sortDir: 'asc', filter: 'kept-top', showRaw: false, trace: null }; }, getState: () => window.__sttState };`;
  // Provide a window object the script writes to.
  const win: Record<string, unknown> = {};
  const fn = new Function("window", script);
  return fn(win);
}

describe("renderSearchTrace", () => {
  let sb: ReturnType<typeof loadSandbox>;
  beforeEach(() => { sb = loadSandbox(); sb.reset(); });

  test("renders the query block with raw and expanded", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: { raw: "hello world", expanded: "hello world A003 SED", expansionTerms: ["A003", "SED"] },
      collections: [],
    });
    expect(html).toContain("raw:");
    expect(html).toContain("hello world");
    expect(html).toContain("expanded:");
    expect(html).toContain("A003");
    expect(html).toContain("stt-expansion");
  });

  test("renders detected entity chips with type and label", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {
        raw: "x", expanded: "x",
        detectedEntities: [{ id: "sed:A003", type: "SED", label: "A003", matchedSpan: "A003" }],
      },
      collections: [],
    });
    expect(html).toContain("stt-chip");
    expect(html).toContain("SED");
    expect(html).toContain(">A003<");
  });

  test("renders graphAnswered and rerankerSkipped flag badges", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: { raw: "x", expanded: "x", graphAnswered: true, rerankerSkipped: true, rerankerSkipReason: "low fanout" },
      collections: [],
    });
    expect(html).toContain("graph answered");
    expect(html).toContain("reranker skipped");
    expect(html).toContain("low fanout");
  });

  test("renders one stage strip segment per non-zero stage", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {},
      collections: [{
        name: "jira",
        timingsMs: { indexFetch: 100, chunkLoad: 0, rerank: 200, titleBoost: 0, assembly: 1, total: 301 },
      }],
    });
    expect(html).toContain("stt-stage-indexFetch");
    expect(html).toContain("stt-stage-rerank");
    expect(html).toContain("stt-stage-assembly");
    expect(html).not.toContain("stt-stage-chunkLoad");
    expect(html).not.toContain("stt-stage-titleBoost");
  });

  test("confidence block shows low-confidence warning and best score", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {},
      collections: [{
        name: "jira",
        confidence: { lowConfidence: true, bestScore: -0.05, lowConfidenceThreshold: -0.1, noiseThreshold: -0.01, filteredCount: 3 },
      }],
    });
    expect(html).toContain("low confidence");
    expect(html).toContain("best=-0.050");
    expect(html).toContain("3 filtered");
    expect(html).toContain("stt-conf-best");
  });

  test("candidates table renders with default top-20 kept filter", () => {
    const cands = Array.from({ length: 25 }, (_, i) => ({
      chunkId: i,
      docTitle: "doc-" + i,
      kept: i < 20,
      stages: {
        faiss: { rank: i, score: 0.5 },
        bm25: { rank: i, score: 1.0 },
        rrf: { rank: i, score: -0.05 },
        ce: { rank: i, score: 0.7 },
        final: { rank: i, score: -1.0 },
      },
    }));
    const html = sb.renderSearchTrace({
      schemaVersion: 1, query: {}, collections: [{ name: "jira", candidates: cands }],
    });
    // Only kept ones, capped at 20
    expect(html).toContain("doc-0");
    expect(html).toContain("doc-19");
    expect(html).not.toContain("doc-20");
    expect(html).toContain("Candidates (20/25)");
  });

  test("flags rows where RRF and CE rank disagree by ≥ 10", () => {
    const cands = [
      { chunkId: 1, docTitle: "agree", kept: true, stages: { rrf: { rank: 1 }, ce: { rank: 2 }, final: { rank: 1 } } },
      { chunkId: 2, docTitle: "disagree", kept: true, stages: { rrf: { rank: 0 }, ce: { rank: 15 }, final: { rank: 2 } } },
    ];
    const html = sb.renderSearchTrace({
      schemaVersion: 1, query: {}, collections: [{ name: "jira", candidates: cands }],
    });
    // The disagree row should carry the highlight class
    const rowMatch = html.match(/<tr class="([^"]*)"[^>]*>\s*<td[^>]*>\d+<\/td><td[^>]*>disagree/);
    expect(rowMatch).not.toBeNull();
    expect(rowMatch![1]).toContain("stt-disagree");
  });

  test("dropped candidates show drop reason and visual treatment", () => {
    const cands = [
      { chunkId: 1, docTitle: "kept-doc", kept: true, stages: { final: { rank: 1 } } },
      { chunkId: 2, docTitle: "dropped-doc", kept: false, dropReason: "noise", stages: { final: { rank: 99 } } },
    ];
    const html = sb.renderSearchTrace({
      schemaVersion: 1, query: {}, collections: [{ name: "jira", candidates: cands, candidates_count: 2 }],
    });
    // With kept-top filter (default) only kept docs are shown
    expect(html).toContain("kept-doc");
    expect(html).not.toContain("dropped-doc");
  });

  test("renders raw JSON view when state.showRaw is true", () => {
    const trace = { schemaVersion: 1, query: { raw: "x" }, collections: [], totalMs: 7 };
    sb.renderSearchTrace(trace); // first render to seed state
    sb.getState().showRaw = true;
    const html = sb.renderSearchTrace(trace);
    expect(html).toContain("stt-raw");
    expect(html).toContain("&quot;raw&quot;: &quot;x&quot;");
    expect(html).toContain("Show structured");
  });
});

describe("renderSearchTrace — yggdrasil shape", () => {
  let sb: ReturnType<typeof loadSandbox>;
  beforeEach(() => { sb = loadSandbox(); sb.reset(); });

  // Modeled on a real yggdrasil-search trace pulled from the muninn DB —
  // candidates have varying stage subsets, and `name.score` is a string ("1.0").
  type YggCand = { symbolId: string; qualifiedName: string; kind: string; stages: Record<string, { rank: number; score?: number | string }> };
  const yggFixture = (): { schemaVersion: number; tool: string; query: Record<string, unknown>; timingsMs: Record<string, number>; candidates: YggCand[] } => ({
    schemaVersion: 1,
    tool: "search",
    query: { raw: "BehandlingService", filters: { repo: "melosys-api" } },
    timingsMs: { embedding: 5, fts: 14, semantic: 15, name: 62, rrf: 0, total: 69 },
    candidates: [
      {
        symbolId: "332c9a10-dee7-4d25-8ad5-89cf0c4839ca",
        qualifiedName: "no.nav.melosys.service.behandling.BehandlingService",
        kind: "class",
        stages: {
          fts:      { rank: 9,  score: 0.082 },
          semantic: { rank: 17, score: 0.907 },
          name:     { rank: 1,  score: "1.0" },
          rrf:      { rank: 1,  score: 0.052 },
          final:    { rank: 1,  score: 0.078 },
        },
      },
      {
        symbolId: "b2fb5812-c725-45e7-9c3f-1e54535cefde",
        qualifiedName: "no.nav.melosys.service.behandling.BehandlingService.BehandlingService",
        kind: "constructor",
        stages: {
          fts:   { rank: 2, score: 0.087 },
          name:  { rank: 2, score: "1.0" },
          rrf:   { rank: 2, score: 0.040 },
          final: { rank: 2, score: 0.044 },
        },
      },
      {
        symbolId: "add4c190-0960-4b06-9d73-8418f48a9142",
        qualifiedName: "no.nav.melosys.service.A011Mapper.mapFraSed",
        kind: "function",
        stages: {
          semantic: { rank: 1, score: 0.905 },
          rrf:      { rank: 3, score: 0.016 },
          // No `final` — this candidate didn't survive to the final ranking.
        },
      },
    ],
  });

  test("renders the query header with raw and filter chips", () => {
    const html = sb.renderSearchTrace(yggFixture());
    expect(html).toContain("BehandlingService");
    expect(html).toContain("repo");
    expect(html).toContain("melosys-api");
    expect(html).toContain("tool: search");
  });

  test("renders the timings strip with one segment per non-zero stage", () => {
    const html = sb.renderSearchTrace(yggFixture());
    expect(html).toContain("stt-stage-embedding");
    expect(html).toContain("stt-stage-fts");
    expect(html).toContain("stt-stage-semantic");
    expect(html).toContain("stt-stage-name");
    expect(html).toContain("total=69ms");
    // rrf is 0ms — strip omits the segment
    expect(html).not.toContain("stt-stage-rrf");
  });

  test("candidates table renders one row per candidate without 'undefined' for missing stages", () => {
    sb.getState().filter = 'all'; // include candidates without a final stage
    const html = sb.renderSearchTrace(yggFixture());
    expect(html).toContain("BehandlingService");
    expect(html).toContain("A011Mapper.mapFraSed");
    expect(html).not.toContain("undefined");
    // Candidate 3 has no fts / name / final — those cells must show the em-dash placeholder.
    expect(html).toContain("—");
  });

  test("string-typed name.score (e.g. '1.0') is coerced and rendered as a number", () => {
    const html = sb.renderSearchTrace(yggFixture());
    // sttFmtRank coerces with parseFloat then .toFixed(2) — should produce "1.00"
    expect(html).toContain("1 (1.00)");
    expect(html).not.toContain("undefined");
  });

  test("default filter (kept-top) hides candidates without a final stage", () => {
    const html = sb.renderSearchTrace(yggFixture());
    expect(html).toContain("BehandlingService");
    expect(html).not.toContain("A011Mapper.mapFraSed");
    expect(html).toContain("Candidates (2/3)");
  });

  test("sort by final.rank ASC puts the surviving candidates at the top", () => {
    const trace = yggFixture();
    trace.candidates = [
      {
        symbolId: "ccccccc1",
        qualifiedName: "z.last",
        kind: "class",
        stages: { final: { rank: 5, score: 0.01 } },
      },
      {
        symbolId: "ccccccc2",
        qualifiedName: "a.first",
        kind: "class",
        stages: { final: { rank: 1, score: 0.08 } },
      },
    ];
    const html = sb.renderSearchTrace(trace);
    // first row should be the rank-1 candidate (a.first), not z.last
    const firstRowMatch = html.match(/<tbody>\s*<tr>[\s\S]*?<td class="stt-title"[^>]*>([^<]+)<\/td>/);
    expect(firstRowMatch).not.toBeNull();
    expect(firstRowMatch![1]).toBe("a.first");
  });

  test("substring filter on qualifiedName narrows the candidate list", () => {
    sb.getState().qFilter = 'A011';
    sb.getState().filter = 'all';
    const html = sb.renderSearchTrace(yggFixture());
    expect(html).toContain("A011Mapper.mapFraSed");
    expect(html).not.toContain(">no.nav.melosys.service.behandling.BehandlingService<");
    expect(html).toContain("Candidates (1/3)");
  });

  test("yggdrasil discriminator does not fire for a huginn-shaped trace", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: { raw: "x" },
      collections: [{ name: "wiki", candidates: [] }],
    });
    expect(html).not.toContain("tool: search");
    expect(html).toContain("Collection");
  });
});
