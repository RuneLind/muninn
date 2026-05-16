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

  test("expansion highlight does not match inside other words", () => {
    // The naive global-replace would highlight "EØS" inside "EU/EØS" because
    // there's no word-boundary check. We expect "EU/EØS" (the longer term) to
    // win, plus the standalone "EØS" added later in the expanded line. The
    // "EØS" inside "EU/EØS" must NOT get its own wrapper.
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {
        raw: "EU/EØS",
        expanded: "EU/EØS EØS MELOSYS",
        expansionTerms: ["EØS", "EU/EØS", "MELOSYS"],
      },
      collections: [],
    });
    // Exactly three highlighted spans: EU/EØS, standalone EØS, and MELOSYS.
    const spans = html.match(/<span class="stt-expansion"[^>]*>/g) || [];
    expect(spans.length).toBe(3);
    // Sanity-check the wrapped texts.
    expect(html).toMatch(/<span class="stt-expansion"[^>]*>EU\/EØS<\/span>/);
    expect(html).toMatch(/<span class="stt-expansion"[^>]*>EØS<\/span>/);
    expect(html).toMatch(/<span class="stt-expansion"[^>]*>MELOSYS<\/span>/);
    // No nested span inside EU/EØS.
    expect(html).not.toMatch(/<span class="stt-expansion"[^>]*>EU\/<span/);
  });

  test("expansion highlight respects detected entity spans even when they are not in expansionTerms", () => {
    // The real bug: "EU/EØS" is a Concept entity but only "EØS" is in the
    // expansion list. The highlight pass must still treat "EU/EØS" as off
    // limits so it doesn't wrap the EØS substring inside it.
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {
        raw: "journalføring EU/EØS",
        expanded: "journalføring EU/EØS EØS MELOSYS",
        expansionTerms: ["EØS", "MELOSYS"],
        detectedEntities: [
          { id: "entity:eu/eøs", type: "Concept", label: "EU/EØS" },
          { id: "entity:eøs",    type: "Concept", label: "EØS" },
        ],
      },
      collections: [],
    });
    // Two highlights: standalone EØS and MELOSYS. EU/EØS stays unwrapped.
    const spans = html.match(/<span class="stt-expansion"[^>]*>/g) || [];
    expect(spans.length).toBe(2);
    expect(html).toMatch(/<span class="stt-expansion"[^>]*>EØS<\/span>/);
    expect(html).toMatch(/<span class="stt-expansion"[^>]*>MELOSYS<\/span>/);
    // The EU/EØS in the expanded line is rendered as plain escaped text — no
    // partial wrap inside it.
    expect(html).toMatch(/journalf[^<]*EU\/EØS <span class="stt-expansion"[^>]*>EØS<\/span>/);
  });

  test("inline expansion-term highlights in the expanded line carry an origin tooltip", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: { raw: "x", expanded: "x EØS MELOSYS", expansionTerms: ["EØS", "MELOSYS"] },
      collections: [],
    });
    // Every wrapped span has a title= attribute that explains its origin.
    const wraps = html.match(/<span class="stt-expansion"[^>]*>/g) || [];
    expect(wraps.length).toBe(2);
    for (const w of wraps) {
      expect(w).toMatch(/title="[^"]*Expansion term appended[^"]*"/);
    }
  });

  test("Concept and + chips carry origin tooltips", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {
        raw: "x", expanded: "x",
        detectedEntities: [{ id: "e:foo", type: "Concept", label: "Foo" }],
        expansionTerms: ["Bar"],
      },
      collections: [],
    });
    // Concept chip explains it's a graph entity.
    expect(html).toMatch(/<span class="stt-chip" title="[^"]*Detected as a graph entity[^"]*">/);
    // + chip explains it's an appended expansion term.
    expect(html).toMatch(/<span class="stt-chip" title="[^"]*Expansion term appended[^"]*">\+ Bar/);
  });

  test("expansion highlight respects letter boundaries — skips embedded matches", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: { raw: "x", expanded: "EØSnoise EØS sak", expansionTerms: ["EØS"] },
      collections: [],
    });
    // Only the standalone EØS gets wrapped — the "EØSnoise" prefix does not.
    const spans = html.match(/<span class="stt-expansion"[^>]*>/g) || [];
    expect(spans.length).toBe(1);
    expect(html).toContain("EØSnoise");
    expect(html).not.toMatch(/<span class="stt-expansion"[^>]*>EØS<\/span>noise/);
  });

  test("entity chip is marked re-injected and the duplicate + chip is dropped", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {
        raw: "x", expanded: "x",
        detectedEntities: [
          { id: "entity:eøs", type: "Concept", label: "EØS" },
          { id: "entity:journalføring", type: "Concept", label: "Journalføring" },
        ],
        expansionTerms: ["EØS", "MELOSYS", "Norge"],
      },
      collections: [],
    });
    // The Concept EØS chip carries the re-injected marker and tooltip.
    expect(html).toMatch(/stt-chip stt-chip-reinjected[^>]*title="[^"]*re-injected[^"]*"/);
    expect(html).toContain('class="stt-chip-plus"');
    // Concept Journalføring is plain — not in the expansionTerms list — but
    // still gets the base "detected as a graph entity" tooltip.
    expect(html).toMatch(/<span class="stt-chip" title="[^"]*Detected as a graph entity[^"]*"><span class="stt-chip-type">Concept<\/span>Journalf/);
    // Standalone "+ EØS" chip is gone (it's already represented by the entity chip).
    expect(html).not.toMatch(/<span class="stt-chip">\+ EØS</);
    // But "+ MELOSYS" and "+ Norge" survive — they have no entity chip.
    expect(html).toContain("+ MELOSYS");
    expect(html).toContain("+ Norge");
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

  test("confidence block summary calls strong vs weak match correctly", () => {
    // Strong match: -1.779 best, -0.1 cutoff, margin 1.679 → "strong match"
    let html = sb.renderSearchTrace({
      schemaVersion: 1, query: {},
      collections: [{ name: "wiki", confidence: { lowConfidence: false, bestScore: -1.779, lowConfidenceThreshold: -0.1, noiseThreshold: -0.1, filteredCount: 0 } }],
    });
    expect(html).toContain("strong match");
    expect(html).toContain("1.679");
    expect(html).toContain("below the cutoff");
    expect(html).toContain("no noise filtering");
    expect(html).toContain("stt-good");

    // Weak / low confidence: -0.05 best, -0.1 cutoff, margin -0.05 → "weak match"
    sb.reset();
    html = sb.renderSearchTrace({
      schemaVersion: 1, query: {},
      collections: [{ name: "kb", confidence: { lowConfidence: true, bestScore: -0.05, lowConfidenceThreshold: -0.1, noiseThreshold: -0.01, filteredCount: 3 } }],
    });
    expect(html).toContain("weak match");
    expect(html).toContain("0.050");
    expect(html).toContain("above the cutoff");
    expect(html).toContain("flagged as low confidence");
    expect(html).toContain("3 candidates dropped");
    expect(html).toContain("stt-bad");
  });

  test("confidence block renders inline marker labels and stacks duplicate thresholds", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1, query: {},
      collections: [{ name: "wiki", confidence: { lowConfidence: false, bestScore: -1.779, lowConfidenceThreshold: -0.1, noiseThreshold: -0.1, filteredCount: 0 } }],
    });
    // All three markers carry their own inline label with the marker value.
    expect(html).toMatch(/stt-conf-mark-label stt-mk-best[^>]*>best -1\.78</);
    expect(html).toMatch(/stt-conf-mark-label stt-mk-thr[^>]*>lowConfThr -0\.1</);
    // Both thresholds end at the right edge → noise label gets the right anchor
    // and the stack-1 offset so the two labels don't write over each other.
    expect(html).toMatch(/stt-conf-mark-label stt-mk-thr stt-anchor-right[^>]*>lowConfThr -0\.1</);
    expect(html).toMatch(/stt-conf-mark-label stt-mk-noise stt-anchor-right stt-stack-1[^>]*>noiseThr -0\.1</);
  });

  test("confidence marker labels use plain anchor when not at an edge", () => {
    // Use values where best lands well inside the bar (not within 5% of either edge).
    const html = sb.renderSearchTrace({
      schemaVersion: 1, query: {},
      collections: [{ name: "kb", confidence: { lowConfidence: false, bestScore: -0.5, lowConfidenceThreshold: -0.1, noiseThreshold: -0.9, filteredCount: 0 } }],
    });
    // Best is in the middle → no edge-anchor class on its label.
    expect(html).toMatch(/<div class="stt-conf-mark-label stt-mk-best"[^>]*>best -0\.50</);
  });

  test("confidence block adds legend and explainer help icon", () => {
    const html = sb.renderSearchTrace({
      schemaVersion: 1,
      query: {},
      collections: [{
        name: "confluence",
        confidence: { lowConfidence: false, bestScore: -0.987, lowConfidenceThreshold: -0.1, noiseThreshold: -0.1, filteredCount: 0 },
      }],
    });
    // Per-marker legend with values.
    expect(html).toContain("stt-conf-leg-best");
    expect(html).toContain("best -0.987");
    expect(html).toContain("lowConfThr -0.1");
    expect(html).toContain("noiseThr -0.1");
    // Hover-only "?" explainer next to the badge.
    expect(html).toContain('class="stt-help"');
    // Marker tooltips spell out the rule, not just the number.
    expect(html).toContain("more negative = more relevant");
    // Axis labels were removed in favor of inline marker labels — they were
    // colliding with the right-edge "noiseThr" label and adding no signal
    // beyond what the per-marker labels already carry.
    expect(html).not.toContain("stt-conf-axis");
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
    const trace = yggFixture();
    sb.renderSearchTrace(trace); // seed state for this trace identity
    sb.getState().filter = 'all'; // include candidates without a final stage
    const html = sb.renderSearchTrace(trace);
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
    const trace = yggFixture();
    sb.renderSearchTrace(trace); // seed state for this trace identity
    sb.getState().qFilter = 'A011';
    sb.getState().filter = 'all';
    const html = sb.renderSearchTrace(trace);
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

  describe("Corrective Retrieval panel", () => {
    test("renders verdict badge, mode, retries, and queries timeline when rescue fired", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "meningen med livet", expanded: "meningen med livet" },
        response: {
          bestScore: 0,
          noConfidentResults: true,
          corrective: {
            mode: "force",
            retries: 1,
            verdict: "still_weak",
            rescueFired: true,
            queriesTried: ["meningen med livet", "meningen"],
          },
          retryHints: {
            broaderQuery: "meningen",
            relatedTerms: ["oppgaver/plukk", "fullmakt"],
            detectedEntities: ["MED"],
          },
        },
        collections: [],
      });
      expect(html).toContain("Corrective Retrieval");
      expect(html).toContain("verdict: still_weak");
      expect(html).toContain("stt-warn");
      expect(html).toContain("mode: force");
      expect(html).toContain("retries: 1");
      expect(html).toContain(">original<");
      expect(html).toContain(">broader<");
      expect(html).toContain("relatedTerms:");
      expect(html).toContain("oppgaver/plukk, fullmakt");
      expect(html).toContain("detectedEntities:");
      expect(html).toContain("Post-rescue:");
      expect(html).toContain("bestScore 0.000");
      expect(html).toContain("no confident results");
    });

    test("rescued verdict uses non-warn badge palette", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "x" },
        response: {
          bestScore: 0.954,
          corrective: {
            mode: "auto",
            retries: 1,
            verdict: "rescued",
            rescueFired: true,
            queriesTried: ["x", "y"],
          },
          retryHints: { broaderQuery: "y" },
        },
        collections: [],
      });
      expect(html).toContain("verdict: rescued");
      const badge = html.match(/<span class="stt-badge[^"]*">verdict: rescued/);
      expect(badge).not.toBeNull();
      expect(badge![0]).not.toContain("stt-warn");
    });

    test("skips the panel entirely on confident searches with no hints", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "x" },
        response: {
          bestScore: 0.95,
          corrective: {
            mode: "auto",
            retries: 0,
            verdict: "confident",
            rescueFired: false,
            queriesTried: ["x"],
          },
        },
        collections: [],
      });
      expect(html).not.toContain("Corrective Retrieval");
    });

    test("still renders for weak_no_hint verdict so operators see what huginn detected", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "x" },
        response: {
          bestScore: 0.2,
          corrective: {
            mode: "auto",
            retries: 0,
            verdict: "weak_no_hint",
            rescueFired: false,
            queriesTried: ["x"],
          },
          retryHints: { detectedEntities: ["ent1"] },
        },
        collections: [],
      });
      expect(html).toContain("Corrective Retrieval");
      expect(html).toContain("verdict: weak_no_hint");
      expect(html).toContain("detectedEntities:");
      expect(html).toContain("ent1");
    });

    test("collection panels gain pass labels when corrective fired", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "meningen med livet" },
        response: {
          corrective: {
            rescueFired: true,
            retries: 1,
            verdict: "still_weak",
            queriesTried: ["meningen med livet", "meningen"],
          },
        },
        collections: [
          { name: "nav-wiki", candidates: [{ kept: true, docTitle: "first" }] },
          { name: "nav-wiki", candidates: [{ kept: true, docTitle: "second" }] },
        ],
      });
      expect(html).toContain("stt-coll-pass");
      expect(html).toMatch(/pass 1[^"]*"meningen med livet"/);
      expect(html).toMatch(/pass 2[^"]*"meningen"/);
    });

    test("collection panels stay unlabeled when no corrective block", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "x" },
        collections: [
          { name: "wiki", candidates: [{ kept: true, docTitle: "first" }] },
        ],
      });
      expect(html).not.toContain("stt-coll-pass");
      expect(html).not.toContain("pass 1");
    });

    test("renders inline strategy chip next to broaderQuery when broaderQueryStrategy is set", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "meningen med livet" },
        response: {
          corrective: { mode: "force", retries: 1, verdict: "still_weak", rescueFired: true, queriesTried: ["meningen med livet", "meningen med"] },
          retryHints: { broaderQuery: "meningen med", broaderQueryStrategy: "drop_last_word" },
        },
        collections: [],
      });
      // Chip lives in the broaderQuery hint row, with the verbatim tooltip from Phase 0c.
      expect(html).toMatch(
        /broaderQuery:[^<]*<\/span> "meningen med"<span class="stt-corr-strategy" title="Dropped the last content word \(skipping stopwords\) and trimmed any stopwords left behind\.">\[drop_last_word\]<\/span>/,
      );
    });

    test("renders inline strategy chip next to narrowerQuery when narrowerQueryStrategy is set", () => {
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "EØS" },
        response: {
          corrective: { mode: "auto", retries: 1, verdict: "rescued", rescueFired: true, queriesTried: ["EØS", "EØS EU/EØS"] },
          retryHints: { narrowerQuery: "EØS EU/EØS", narrowerQueryStrategy: "entity_label_append" },
        },
        collections: [],
      });
      expect(html).toMatch(
        /narrowerQuery:[^<]*<\/span> "EØS EU\/EØS"<span class="stt-corr-strategy" title="Appended the top detected entity label to the original query\.">\[entity_label_append\]<\/span>/,
      );
    });

    test("omits strategy chip when hint is present but strategy is missing", () => {
      // Defensive: huginn's contract is "both or neither", but older traces
      // may carry only the rewrite. We render the row without a chip.
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "x" },
        response: {
          corrective: { mode: "auto", retries: 1, verdict: "still_weak", rescueFired: true, queriesTried: ["x", "y"] },
          retryHints: { broaderQuery: "y" },
        },
        collections: [],
      });
      expect(html).toContain('broaderQuery:');
      expect(html).not.toContain("stt-corr-strategy");
    });

    test("strategy chip uses generic fallback tooltip on unknown enum values", () => {
      // Locks the upgrade story: when huginn adds a new strategy before muninn
      // syncs, the chip still renders so operators see the new name.
      const html = sb.renderSearchTrace({
        schemaVersion: 1,
        query: { raw: "x" },
        response: {
          corrective: { mode: "auto", retries: 1, verdict: "rescued", rescueFired: true, queriesTried: ["x", "y"] },
          retryHints: { broaderQuery: "y", broaderQueryStrategy: "shiny_new_strategy" },
        },
        collections: [],
      });
      expect(html).toMatch(
        /stt-corr-strategy" title="Rewrite heuristic name emitted by huginn \(no local description\)\.">\[shiny_new_strategy\]/,
      );
    });

    test("strategy chip tooltips are locked to the Phase 0c wording for every enum value", () => {
      // One render per strategy so the verbatim tooltip text is anchored in
      // tests — if huginn changes the wording, this test fails loudly.
      const cases: Array<[string, string]> = [
        ["conjunction_split",   "Kept the first conjunct; dropped everything after ' og ' / ' and ' / ' vs ' / ', '."],
        ["trailing_parens",     "Stripped a trailing parenthetical qualifier from the query."],
        ["unquote",             "Removed quote marks from the query so phrases were searched as loose tokens."],
        ["drop_last_word",      "Dropped the last content word (skipping stopwords) and trimmed any stopwords left behind."],
        ["entity_label_append", "Appended the top detected entity label to the original query."],
        ["fallback_seed",       "No entity detected; appended the closest-matching graph node's neighbour label."],
      ];
      for (const [strategy, tip] of cases) {
        sb.reset();
        const html = sb.renderSearchTrace({
          schemaVersion: 1,
          query: { raw: "x" },
          response: {
            corrective: { mode: "auto", retries: 1, verdict: "rescued", rescueFired: true, queriesTried: ["x", "y"] },
            retryHints: { broaderQuery: "y", broaderQueryStrategy: strategy },
          },
          collections: [],
        });
        // esc() escapes single quotes to &#39; — check the escaped tooltip text appears.
        const escapedTip = tip
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        expect(html).toContain('title="' + escapedTip + '"');
        expect(html).toContain("[" + strategy + "]");
      }
    });
  });

  test("clicking a new trace resets sort/filter state from the previous trace", () => {
    const trace1 = yggFixture();
    sb.renderSearchTrace(trace1);
    sb.getState().sortKey = 'fts';
    sb.getState().sortDir = 'desc';
    sb.getState().qFilter = 'A011';
    // Same trace identity — state should persist across re-renders.
    sb.renderSearchTrace(trace1);
    expect(sb.getState().sortKey).toBe('fts');
    expect(sb.getState().qFilter).toBe('A011');
    // Different trace identity (next click) — state should reset.
    sb.renderSearchTrace(yggFixture());
    expect(sb.getState().sortKey).toBe('final');
    expect(sb.getState().sortDir).toBe('asc');
    expect(sb.getState().qFilter).toBe('');
  });
});
