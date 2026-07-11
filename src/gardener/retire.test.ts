import { test, expect, describe } from "bun:test";
import {
  computeRetirePlan,
  parseCutoffDate,
  assembleRetireBacklog,
  type AssembleRetireDeps,
} from "./retire.ts";
import type { QueuedDoc } from "../wiki/ingest-backlog.ts";

function qd(collection: string, id: string, date?: string): QueuedDoc {
  return { collection, id, url: `https://x/${id}`, ...(date ? { date } : {}) };
}

// ── computeRetirePlan ────────────────────────────────────────────────────────

describe("computeRetirePlan", () => {
  const byCollection = [
    {
      collection: "youtube-summaries",
      queuedDocs: [qd("youtube-summaries", "y1", "2026-01-01"), qd("youtube-summaries", "y2", "2026-05-01")],
    },
    { collection: "x-articles", queuedDocs: [qd("x-articles", "x1", "2026-03-01")] },
  ];

  test("no cutoff retires every queued-and-unoffered doc", () => {
    const plan = computeRetirePlan(byCollection, new Set(), null);
    expect(plan.keysToRetire.sort()).toEqual([
      "x-articles/x1",
      "youtube-summaries/y1",
      "youtube-summaries/y2",
    ]);
    expect(plan.queuedTotal).toBe(3);
    expect(plan.alreadyOffered).toBe(0);
    expect(plan.newOffered.sort()).toEqual([
      "x-articles/x1",
      "youtube-summaries/y1",
      "youtube-summaries/y2",
    ]);
    const yt = plan.perCollection.find((c) => c.collection === "youtube-summaries")!;
    expect(yt.queued).toBe(2);
    expect(yt.toRetire).toBe(2);
  });

  test("already-offered keys are skipped (dry-run vs apply parity)", () => {
    const plan = computeRetirePlan(byCollection, new Set(["youtube-summaries/y1"]), null);
    expect(plan.keysToRetire.sort()).toEqual(["x-articles/x1", "youtube-summaries/y2"]);
    expect(plan.alreadyOffered).toBe(1);
    // The union keeps the pre-offered key.
    expect(plan.newOffered).toContain("youtube-summaries/y1");
    expect(plan.newOffered.length).toBe(3);
  });

  test("cutoff protects docs dated on/after it; retires older", () => {
    // Cutoff 2026-04-01: y1 (Jan) + x1 (Mar) retired; y2 (May) protected.
    const cutoff = parseCutoffDate("2026-04-01");
    const plan = computeRetirePlan(byCollection, new Set(), cutoff);
    expect(plan.keysToRetire.sort()).toEqual(["x-articles/x1", "youtube-summaries/y1"]);
    expect(plan.cutoffMs).toBe(cutoff);
  });

  test("cutoff boundary is inclusive (on-the-day stays in pool)", () => {
    const docs = [{ collection: "c", queuedDocs: [qd("c", "onday", "2026-04-01")] }];
    const plan = computeRetirePlan(docs, new Set(), parseCutoffDate("2026-04-01"));
    expect(plan.keysToRetire).toEqual([]);
  });

  test("undated docs are retired even under a cutoff (treated as old tail)", () => {
    const docs = [{ collection: "c", queuedDocs: [qd("c", "undated")] }];
    const plan = computeRetirePlan(docs, new Set(), parseCutoffDate("2026-04-01"));
    expect(plan.keysToRetire).toEqual(["c/undated"]);
  });

  test("idempotency: a second run over the union is a no-op", () => {
    const first = computeRetirePlan(byCollection, new Set(), null);
    const second = computeRetirePlan(byCollection, new Set(first.newOffered), null);
    expect(second.keysToRetire).toEqual([]);
    // The offered set is unchanged (union of a superset with itself).
    expect(second.newOffered.sort()).toEqual(first.newOffered.sort());
  });
});

// ── parseCutoffDate ──────────────────────────────────────────────────────────

describe("parseCutoffDate", () => {
  test("parses a valid YYYY-MM-DD to UTC midnight ms", () => {
    expect(parseCutoffDate("2026-06-01")).toBe(Date.parse("2026-06-01"));
  });

  test("rejects a malformed date", () => {
    expect(() => parseCutoffDate("2026/06/01")).toThrow(/YYYY-MM-DD/);
    expect(() => parseCutoffDate("06-01-2026")).toThrow(/YYYY-MM-DD/);
    expect(() => parseCutoffDate("garbage")).toThrow(/YYYY-MM-DD/);
  });
});

// ── assembleRetireBacklog ────────────────────────────────────────────────────

describe("assembleRetireBacklog", () => {
  function baseDeps(overrides?: Partial<AssembleRetireDeps>): AssembleRetireDeps {
    return {
      botName: "jarvis",
      wikiDir: "/tmp/wiki",
      apiUrl: "http://x",
      listCollections: async () => ({
        byCollection: {
          "youtube-summaries": [
            { id: "y1", url: "https://youtu.be/y1", date: "2026-06-03" }, // queued
            { id: "y2", url: "https://youtu.be/y2", date: "2026-06-02" }, // consumed
            { id: "y3", url: "https://youtu.be/y3", date: "2026-06-01" }, // queued
          ],
          "x-articles": [],
          "anthropic-summaries": [],
          "tiktok-summaries": [],
        },
        errors: [],
      }),
      sweepWikiRefs: async () => ({ urls: new Set<string>(), idTokens: new Set<string>() }),
      getConsumed: async () => new Set<string>(["youtube-summaries/y2"]),
      getPending: async () => new Set<string>(),
      getOffered: async () => new Set<string>(),
      ...overrides,
    };
  }

  test("returns the FULL queued list (not a capped batch) plus the offered set", async () => {
    const a = await assembleRetireBacklog(baseDeps());
    const yt = a.byCollection.find((c) => c.collection === "youtube-summaries")!;
    // y2 consumed → y1 + y3 queued.
    expect(yt.queuedDocs.map((d) => d.id).sort()).toEqual(["y1", "y3"]);
    expect(a.offeredBefore.size).toBe(0);
  });

  test("end-to-end: retire plan over the assembled backlog credits the offered set", async () => {
    const a = await assembleRetireBacklog(
      baseDeps({ getOffered: async () => new Set(["youtube-summaries/y1"]) }),
    );
    const plan = computeRetirePlan(a.byCollection, a.offeredBefore, null);
    // y1 already offered → only y3 retired.
    expect(plan.keysToRetire).toEqual(["youtube-summaries/y3"]);
    expect(plan.newOffered.sort()).toEqual(["youtube-summaries/y1", "youtube-summaries/y3"]);
  });

  test("surfaces listing errors without throwing", async () => {
    const a = await assembleRetireBacklog(
      baseDeps({
        listCollections: async () => ({
          byCollection: {
            "youtube-summaries": [],
            "x-articles": [],
            "anthropic-summaries": [],
            "tiktok-summaries": [],
          },
          errors: [{ source: "x-articles", collection: "x-articles", error: "boom" }],
        }),
      }),
    );
    expect(a.errors).toHaveLength(1);
  });
});
