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
    expect(planBatch(cards, "ai", "approve").ids).toEqual(["a", "b"]);
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
    const approve = planBatch(cards, "ai", "approve");
    expect(approve.ids).toEqual(["ok"]);
    expect(Object.fromEntries(approve.skipped)).toEqual({
      "fact-check lock": 2,
      "page changed since drafting": 1,
      "another draft writes the same page": 2,
    });
    expect(planBatch(cards, "ai", "reject").ids).toEqual(["ok", "locked", "unknown", "drift", "twin1", "twin2"]);
  });

  test("a same-page twin hidden by a filter still blocks the visible one", () => {
    const visible = [card("twin1", { targetPath: "p.mdx" })];
    const all = [...visible, card("twin2", { targetPath: "p.mdx", category: "entertainment" })];
    expect(planBatch(visible, "ai", "approve", new Set(), all).ids).toEqual([]);
  });

  test("a card with a Redraft in flight is skipped by both verbs", () => {
    const cards = [card("a"), card("b")];
    expect(planBatch(cards, "ai", "reject", new Set(["a"])).ids).toEqual(["b"]);
  });
});

describe("batchProgressText", () => {
  const base = { section: "ai" as const, verb: "approve" as const, total: 5, done: 2, failed: 0, running: true, stopped: false };
  test("running, finished, stopped and failed", () => {
    expect(batchProgressText(base)).toBe("Approving 3 of 5…");
    expect(batchProgressText({ ...base, done: 5, running: false })).toBe("5 of 5 approved");
    expect(batchProgressText({ ...base, done: 5, failed: 1, running: false })).toBe("4 of 5 approved · 1 failed (see the cards)");
    expect(batchProgressText({ ...base, verb: "reject", done: 2, running: false, stopped: true })).toBe("Stopped: 2 of 5 rejected");
  });
});

describe("batchHeadHtml", () => {
  const cards = [card("a"), card("film", { category: "entertainment" }), card("locked", { factcheck: { needsRedraft: true } })];
  const head = (section: "ai" | "entertainment", over: Partial<Parameters<typeof batchHeadHtml>[0]> = {}) =>
    batchHeadHtml({ section, label: "L", cards, count: 1, progress: null, anyRunning: false, ...over });

  test("Approve all counts what the batch takes; only entertainment offers Reject all", () => {
    expect(head("ai")).toContain(">Approve all 1 of 2<");
    expect(head("ai")).not.toContain("Reject all");
    expect(head("ai")).toContain("left for you: 1 fact-check lock");
    expect(head("entertainment")).toContain(">Reject all 1<");
  });

  test("a running batch shows Stop; another running batch disables the buttons", () => {
    const progress = { section: "ai" as const, verb: "approve" as const, total: 1, done: 0, failed: 0, running: true, stopped: false };
    expect(head("ai", { progress, anyRunning: true })).toContain("data-batch-stop");
    expect(head("entertainment", { anyRunning: true })).toMatch(/data-batch-action="approve"[^>]*disabled/);
  });
});

// Fix round 1 batch 1 (review findings 1, 5).
import { batchStopReason } from "./wiki-gardener-batch.ts";

describe("planBatch — a page another row already wrote", () => {
  test("a create draft whose page an applied row wrote is left out", () => {
    const cards = [
      card("A", { status: "applied", targetPath: "sources/Fable.mdx", mode: "create" }),
      card("B", { targetPath: "sources/Fable.mdx", mode: "create" }),
    ];
    const plan = planBatch(cards, "ai", "approve");
    expect(plan.ids).toEqual([]);
    expect(Object.fromEntries(plan.skipped)).toEqual({ "page written since drafting": 1 });
  });

  test("an update draft of a page an applied row wrote is taken: that is the normal update", () => {
    const cards = [
      card("A", { status: "applied", targetPath: "sources/Fable.mdx", mode: "create" }),
      card("U", { targetPath: "sources/Fable.mdx", mode: "update" }),
    ];
    expect(planBatch(cards, "ai", "approve").ids).toEqual(["U"]);
  });
});

describe("batchStopReason", () => {
  test("a fault every card shares stops the batch", () => {
    expect(batchStopReason({ status: 500, outcome: "error", error: "bot has no wikiDir configured" })).toContain("bot has no wikiDir");
    expect(batchStopReason({ status: 403, outcome: "", error: "read-only" })).toContain("read-only");
    expect(batchStopReason({ status: 0, outcome: "", error: "Network error: x" })).toContain("Network error");
    // An `error` outcome has turned its row terminal, whatever the status says.
    expect(batchStopReason({ status: 200, outcome: "error", error: "" })).toBe("HTTP 200");
  });

  test("one card's own refusal does not", () => {
    expect(batchStopReason({ status: 409, outcome: "", error: "collision" })).toBeNull();
    expect(batchStopReason({ status: 200, outcome: "stale", error: "" })).toBeNull();
    expect(batchStopReason({ status: 200, outcome: "applied", error: "" })).toBeNull();
  });
});

// Fix round 1 batch 2 (review finding 4).
import { WIKI_READONLY_BLOCKED_SELECTOR } from "./wiki-readonly-client.ts";

test("a read-only instance blocks Approve all, spelled as the header renders it", () => {
  const html = batchHeadHtml({ section: "ai", label: "L", cards: [card("a")], count: 1, progress: null, anyRunning: false });
  expect(html).toContain('data-batch-action="approve"');
  expect(WIKI_READONLY_BLOCKED_SELECTOR.split(",").map((s) => s.trim())).toContain('[data-batch-action="approve"]');
});

// Fix round 2 batch 1 (batch-3 verify findings 1, 2).
import { narrowBatch } from "./wiki-gardener-batch.ts";

describe("narrowBatch", () => {
  test("never adds a draft that arrived after the plan", () => {
    const fresh = [card("a"), card("new")];
    expect(narrowBatch(["a"], [card("a")], fresh, "approve", new Set())).toEqual(["a"]);
  });

  test("drops a row settled or drifted on the fresh listing, or settled in this tab", () => {
    // c is an update draft, so only its local status (not the written-page check) drops it.
    const local = [card("a"), card("b"), card("c", { status: "applied", mode: "update" }), card("d")];
    const fresh = [card("a", { status: "rejected" }), card("b", { drifted: "moved" }), card("c", { mode: "update" }), card("d")];
    expect(narrowBatch(["a", "b", "c", "d"], local, fresh, "approve", new Set())).toEqual(["d"]);
  });

  test("drops a row a single click is working on, and one gone from the listing", () => {
    expect(narrowBatch(["a", "b"], [card("a"), card("b")], [card("a")], "approve", new Set(["a"]))).toEqual([]);
  });
});

// Fix round 2 batch 2 (batch-1 verify finding 3).
describe("planBatch — an applied twin blocks only a draft made before it", () => {
  test("a page applied long before the draft (since deleted or moved) does not block it", () => {
    const cards = [
      card("old", { status: "applied", targetPath: "p.mdx", mode: "create", resolvedAt: 1_000 }),
      card("new", { targetPath: "p.mdx", mode: "create", createdAt: 5_000 }),
    ];
    expect(planBatch(cards, "ai", "approve").ids).toEqual(["new"]);
  });

  test("a page applied after the draft was made blocks it, under its own reason", () => {
    const cards = [
      card("twin", { status: "applied", targetPath: "p.mdx", mode: "create", resolvedAt: 9_000 }),
      card("late", { targetPath: "p.mdx", mode: "create", createdAt: 5_000 }),
    ];
    const plan = planBatch(cards, "ai", "approve");
    expect(plan.ids).toEqual([]);
    expect(Object.fromEntries(plan.skipped)).toEqual({ "page written since drafting": 1 });
  });
});

// Fix round 2 batch 3 (batch-1 verify finding 2).
test("a halted batch says it stopped after an error, not that the fault is shared", () => {
  const b = { section: "ai" as const, verb: "approve" as const, total: 3, done: 1, failed: 1, running: false, stopped: false, haltedBy: "path confinement failed" };
  expect(batchProgressText(b)).toBe("Stopped after an error (path confinement failed): 0 of 3 approved · 1 failed (see the cards)");
});

// Three sections and their chips.
import { sectionCounts, sectionLabel, sectionOf } from "./wiki-gardener-batch.ts";

describe("sections", () => {
  test("AI outside life/, Life inside it, Entertainment by category wherever it is", () => {
    expect(sectionOf(card("a", { targetPath: "sources/X.mdx" }))).toBe("ai");
    expect(sectionOf(card("l", { targetPath: "life/sources/Clove.mdx" }))).toBe("life");
    expect(sectionOf(card("e", { targetPath: "life/sources/Films.mdx", category: "entertainment" }))).toBe("entertainment");
  });

  test("the chip counts are drafts per section, ungrouped only", () => {
    const cards = [
      card("a"),
      card("a2"),
      card("l", { targetPath: "life/sources/L.mdx" }),
      card("e", { targetPath: "life/sources/E.mdx", category: "entertainment" }),
      card("done", { status: "applied" }),
      card("lint", { groupKey: "lint:x:1" }),
    ];
    expect(sectionCounts(cards)).toEqual({ ai: 2, life: 1, entertainment: 1 });
  });

  test("a wiki with only AI-side drafts calls that section Drafts", () => {
    expect(sectionLabel("ai", [card("a")])).toBe("Drafts");
    expect(sectionLabel("ai", [card("a"), card("l", { targetPath: "life/x.mdx" })])).toBe("AI and tech");
    expect(sectionLabel("life", [card("l", { targetPath: "life/x.mdx" })])).toBe("Life");
  });

  test("Approve all on Life leaves the AI and entertainment drafts alone", () => {
    const cards = [card("a"), card("l", { targetPath: "life/sources/L.mdx" }), card("e", { targetPath: "life/sources/E.mdx", category: "entertainment" })];
    expect(planBatch(cards, "life", "approve").ids).toEqual(["l"]);
  });
});

// Fix round 1 batch 1 (review findings 3, 4): the life domain is read off every row, not live drafts.
import { hasLifeDomain } from "./wiki-gardener-batch.ts";

describe("hasLifeDomain and the AI label", () => {
  test("a wiki with any life/ row, in any status, has a life domain", () => {
    expect(hasLifeDomain([card("a"), card("l", { status: "applied", targetPath: "life/sources/L.mdx" })])).toBe(true);
    expect(hasLifeDomain([card("a"), card("b", { status: "applied" })])).toBe(false);
  });

  test("the AI label does not flip to Drafts when the last life draft is approved", () => {
    const cards = [card("a"), card("l", { status: "applied", targetPath: "life/sources/L.mdx" })];
    expect(sectionLabel("ai", cards)).toBe("AI and tech");
  });
});

// Fix round 1 batch 2 (review findings 2, 5) and the two asks: a total chip, "N of M".
describe("batch 2", () => {
  test("Approve all names what it skips: N of M; no skip reads plain", () => {
    const html = batchHeadHtml({ section: "ai", label: "L", cards: [card("a"), card("b")], count: 2, progress: null, anyRunning: false });
    expect(html).toContain(">Approve all 2<");
  });

  test("a lifestyle/ path is not Life", () => {
    expect(sectionOf(card("x", { targetPath: "lifestyle/x.mdx" }))).toBe("ai");
    expect(hasLifeDomain([card("x", { targetPath: "lifestyle/x.mdx" }), card("y", { targetPath: "projects/life/y.md" })])).toBe(false);
  });
});
