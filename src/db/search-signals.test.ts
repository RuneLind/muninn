import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { saveSpan } from "./traces.ts";
import {
  harvestSearchSignals,
  getSearchSignalBySpanId,
  getTopLowConfidenceQueries,
} from "./search-signals.ts";

setupTestDb();

/**
 * Build a research `search` span row as research-knowledge.ts emits it:
 * name = 'search', kind = 'span', attrs carry the quality signal. When
 * `corrective` is passed, nest it under searchTrace.response.corrective —
 * the exact path span-label.ts / the harvest read.
 */
function makeSearchSpan(
  attrs: Record<string, unknown>,
  corrective?: Record<string, unknown>,
) {
  const searchTrace = corrective
    ? { searchTrace: { response: { corrective } } }
    : {};
  return {
    id: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    parentId: crypto.randomUUID(),
    name: "search",
    kind: "span" as const,
    botName: "jarvis",
    startedAt: new Date(),
    durationMs: 1200,
    attributes: { ...attrs, ...searchTrace },
  };
}

describe("search-signals", () => {
  test("harvests a confident search span", async () => {
    const span = makeSearchSpan({
      subQuestion: "How does MCP work?",
      resultCount: 4,
      bestScore: 0.82,
      lowConfidence: false,
      collections: ["anthropic-knowledge", "wiki"],
      huginnTraceId: "h-1",
    });
    await saveSpan(span);

    const inserted = await harvestSearchSignals();
    expect(inserted).toBe(1);

    const row = await getSearchSignalBySpanId(span.id);
    expect(row).not.toBeNull();
    expect(row!.traceId).toBe(span.traceId);
    expect(row!.botName).toBe("jarvis");
    expect(row!.query).toBe("How does MCP work?");
    expect(row!.collections).toEqual(["anthropic-knowledge", "wiki"]);
    expect(row!.resultCount).toBe(4);
    expect(row!.bestScore).toBeCloseTo(0.82, 5);
    expect(row!.lowConfidence).toBe(false);
    expect(row!.noHits).toBe(false);
    expect(row!.rescueFired).toBe(false);
    expect(row!.rescueVerdict).toBeNull();
    expect(row!.rescueRetries).toBeNull();
    expect(row!.spanStartedAt).not.toBeNull();
  });

  test("no_hits is derived from resultCount = 0", async () => {
    const span = makeSearchSpan({
      subQuestion: "totally uncovered topic",
      resultCount: 0,
      lowConfidence: true,
      collections: ["wiki"],
    });
    await saveSpan(span);
    await harvestSearchSignals();

    const row = await getSearchSignalBySpanId(span.id);
    expect(row!.resultCount).toBe(0);
    expect(row!.noHits).toBe(true);
    expect(row!.lowConfidence).toBe(true);
  });

  test("extracts the nested Path-D corrective rescue block", async () => {
    const span = makeSearchSpan(
      {
        subQuestion: "weak query that got rescued",
        resultCount: 3,
        bestScore: 0.55,
        lowConfidence: true,
        collections: ["anthropic-knowledge"],
      },
      {
        rescueFired: true,
        retries: 2,
        queriesTried: ["weak query", "broader query"],
        verdict: "rescued",
      },
    );
    await saveSpan(span);
    await harvestSearchSignals();

    const row = await getSearchSignalBySpanId(span.id);
    expect(row!.rescueFired).toBe(true);
    expect(row!.rescueRetries).toBe(2);
    expect(row!.rescueVerdict).toBe("rescued");
  });

  test("harvest is idempotent via span_id conflict", async () => {
    const span = makeSearchSpan({
      subQuestion: "idempotency check",
      resultCount: 2,
      bestScore: 0.7,
      lowConfidence: false,
      collections: ["wiki"],
    });
    await saveSpan(span);

    const first = await harvestSearchSignals();
    expect(first).toBe(1);
    const second = await harvestSearchSignals();
    expect(second).toBe(0); // already harvested → ON CONFLICT DO NOTHING

    // Exactly one row remains for the span.
    const row = await getSearchSignalBySpanId(span.id);
    expect(row).not.toBeNull();
  });

  test("skips errored sub-searches — a transient failure is not a knowledge gap", async () => {
    const errorSpan = makeSearchSpan({
      subQuestion: "How does MCP work?",
      error: "Search timed out after 15000ms",
      collections: ["anthropic-knowledge"],
    });
    await saveSpan(errorSpan);

    const inserted = await harvestSearchSignals();
    expect(inserted).toBe(0);
    expect(await getSearchSignalBySpanId(errorSpan.id)).toBeNull();
  });

  test("malformed corrective fields from huginn do not fail the harvest", async () => {
    const poisoned = makeSearchSpan(
      { subQuestion: "poison", resultCount: 2, bestScore: "not-a-number" },
      { rescueFired: true, verdict: "rescued", retries: "2.0" },
    );
    const healthy = makeSearchSpan({ subQuestion: "healthy", resultCount: 3, bestScore: 0.9 });
    await saveSpan(poisoned);
    await saveSpan(healthy);

    const inserted = await harvestSearchSignals();
    expect(inserted).toBe(2);

    const poisonedRow = await getSearchSignalBySpanId(poisoned.id);
    expect(poisonedRow!.bestScore).toBeNull();
    expect(poisonedRow!.rescueFired).toBe(true);
    expect(poisonedRow!.rescueVerdict).toBe("rescued");
    expect(poisonedRow!.rescueRetries).toBeNull();
    const healthyRow = await getSearchSignalBySpanId(healthy.id);
    expect(healthyRow!.bestScore).toBeCloseTo(0.9, 5);
  });

  test("rescue verdict and retries are null when rescue did not fire", async () => {
    const span = makeSearchSpan(
      { subQuestion: "no-op corrective", resultCount: 1, bestScore: 0.4, lowConfidence: true },
      { rescueFired: false, verdict: "still_weak", retries: 1 },
    );
    await saveSpan(span);

    await harvestSearchSignals();
    const row = await getSearchSignalBySpanId(span.id);
    expect(row!.rescueFired).toBe(false);
    expect(row!.rescueVerdict).toBeNull();
    expect(row!.rescueRetries).toBeNull();
  });

  test("skips spans that are not research search spans", async () => {
    // A 'search'-named span without a subQuestion attr (defensive filter).
    const notResearch = {
      id: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      name: "search",
      kind: "span" as const,
      botName: "jarvis",
      startedAt: new Date(),
      attributes: { unrelated: true },
    };
    // A differently-named span with a subQuestion — still skipped (name gate).
    const otherName = makeSearchSpan({ subQuestion: "x", resultCount: 1 });
    (otherName as { name: string }).name = "knowledge_decompose";

    await saveSpan(notResearch);
    await saveSpan(otherName);

    const inserted = await harvestSearchSignals();
    expect(inserted).toBe(0);
    expect(await getSearchSignalBySpanId(notResearch.id)).toBeNull();
    expect(await getSearchSignalBySpanId(otherName.id)).toBeNull();
  });

  test("getTopLowConfidenceQueries ranks recurring weak/no-hit queries", async () => {
    // Two weak hits for the same query, one confident (excluded), one no-hit.
    for (let i = 0; i < 2; i++) {
      const s = makeSearchSpan({
        subQuestion: "recurring gap",
        resultCount: 3,
        bestScore: 0.4,
        lowConfidence: true,
        collections: ["wiki"],
      });
      await saveSpan(s);
    }
    const confident = makeSearchSpan({
      subQuestion: "well covered",
      resultCount: 5,
      bestScore: 0.9,
      lowConfidence: false,
      collections: ["wiki"],
    });
    const noHit = makeSearchSpan({
      subQuestion: "empty topic",
      resultCount: 0,
      lowConfidence: false,
      collections: ["wiki"],
    });
    await saveSpan(confident);
    await saveSpan(noHit);
    await harvestSearchSignals();

    const top = await getTopLowConfidenceQueries(7, 20);
    const queries = top.map((t) => t.query);
    expect(queries).toContain("recurring gap");
    expect(queries).toContain("empty topic");
    expect(queries).not.toContain("well covered"); // confident → excluded

    const recurring = top.find((t) => t.query === "recurring gap")!;
    expect(recurring.hits).toBe(2);
    // Most frequent should rank first.
    expect(top[0]!.query).toBe("recurring gap");
  });
});
