import { describe, expect, test } from "bun:test";
import { batchHeadHtml, batchProgressText, planBatch, type BatchCard } from "./wiki-gardener-batch.ts";

const card = (id: string, over: Partial<BatchCard> = {}): BatchCard => ({
  id,
  status: "draft",
  groupKey: null,
  targetPath: `sources/${id}.mdx`,
  category: null,
  ...over,
});

describe("planBatch", () => {
  test("files ungrouped drafts by category and takes them in list order", () => {
    const cards = [
      card("a"),
      card("film", { category: "entertainment" }),
      card("b"),
      card("applied", { status: "applied" }),
      card("lint", { groupKey: "lint:x:1" }),
    ];
    expect(planBatch(cards, "other", "approve").ids).toEqual(["a", "b"]);
    expect(planBatch(cards, "entertainment", "approve").ids).toEqual(["film"]);
  });

  test("approve leaves locked, drifted and same-page drafts for a human; reject takes them", () => {
    const cards = [
      card("ok"),
      card("locked", { factcheck: { needsRedraft: true } }),
      card("unknown", { factcheckUnknown: true }),
      card("drift", { drifted: "hash moved" }),
      card("twin1", { targetPath: "sources/Same.mdx" }),
      card("twin2", { targetPath: "sources/Same.mdx" }),
    ];
    const approve = planBatch(cards, "other", "approve");
    expect(approve.ids).toEqual(["ok"]);
    expect(Object.fromEntries(approve.skipped)).toEqual({
      "fact-check lock": 2,
      "page changed since drafting": 1,
      "another draft writes the same page": 2,
    });
    expect(planBatch(cards, "other", "reject").ids).toEqual(["ok", "locked", "unknown", "drift", "twin1", "twin2"]);
  });

  test("a same-page twin hidden by a filter still blocks the visible one", () => {
    const visible = [card("twin1", { targetPath: "p.mdx" })];
    const all = [...visible, card("twin2", { targetPath: "p.mdx", category: "entertainment" })];
    expect(planBatch(visible, "other", "approve", new Set(), all).ids).toEqual([]);
  });

  test("a card with a Redraft in flight is skipped by both verbs", () => {
    const cards = [card("a"), card("b")];
    expect(planBatch(cards, "other", "reject", new Set(["a"])).ids).toEqual(["b"]);
  });
});

describe("batchProgressText", () => {
  const base = { section: "other" as const, verb: "approve" as const, total: 5, done: 2, failed: 0, running: true, stopped: false };
  test("running, finished, stopped and failed", () => {
    expect(batchProgressText(base)).toBe("Approving 3 of 5…");
    expect(batchProgressText({ ...base, done: 5, running: false })).toBe("5 of 5 approved");
    expect(batchProgressText({ ...base, done: 5, failed: 1, running: false })).toBe("4 of 5 approved · 1 failed (see the cards)");
    expect(batchProgressText({ ...base, verb: "reject", done: 2, running: false, stopped: true })).toBe("Stopped: 2 of 5 rejected");
  });
});

describe("batchHeadHtml", () => {
  const cards = [card("a"), card("film", { category: "entertainment" }), card("locked", { factcheck: { needsRedraft: true } })];
  const head = (section: "other" | "entertainment", over: Partial<Parameters<typeof batchHeadHtml>[0]> = {}) =>
    batchHeadHtml({ section, label: "L", cards, count: 1, progress: null, anyRunning: false, ...over });

  test("Approve all counts what the batch takes; only entertainment offers Reject all", () => {
    expect(head("other")).toContain(">Approve all 1<");
    expect(head("other")).not.toContain("Reject all");
    expect(head("other")).toContain("left for you: 1 fact-check lock");
    expect(head("entertainment")).toContain(">Reject all 1<");
  });

  test("a running batch shows Stop; another running batch disables the buttons", () => {
    const progress = { section: "other" as const, verb: "approve" as const, total: 1, done: 0, failed: 0, running: true, stopped: false };
    expect(head("other", { progress, anyRunning: true })).toContain("data-batch-stop");
    expect(head("entertainment", { anyRunning: true })).toMatch(/data-batch-action="approve"[^>]*disabled/);
  });
});
