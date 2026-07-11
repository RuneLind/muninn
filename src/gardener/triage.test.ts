import { test, expect, describe } from "bun:test";
import {
  buildTriagePrompt,
  parseTriage,
  rankTriage,
  computeUnoffer,
  type TriageDoc,
} from "./triage.ts";
import { existingPageLines } from "./cluster.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";

function tdoc(key: string, title = key, excerpt = "body"): TriageDoc {
  return { key, title, excerpt };
}

// ── buildTriagePrompt ────────────────────────────────────────────────────────

describe("buildTriagePrompt", () => {
  const docs = [tdoc("youtube-summaries/y1", "Vector Databases", "how HNSW works")];

  test("includes the doc key/title/excerpt and the untrusted-data delimiters", () => {
    const p = buildTriagePrompt(docs);
    expect(p).toContain("youtube-summaries/y1");
    expect(p).toContain("Vector Databases");
    expect(p).toContain("how HNSW works");
    expect(p).toContain("--- BEGIN DOCS ---");
    expect(p).toContain("UNTRUSTED source material");
  });

  test("inlines the already-covered pages block when existingPages present", () => {
    const p = buildTriagePrompt(docs, {
      existingPages: ["Agent Loops (aliases: AI Agent Loops)", "Context Compaction"],
    });
    expect(p).toContain("ALREADY covers these topics");
    expect(p).toContain("Agent Loops (aliases: AI Agent Loops)");
    expect(p).toContain("Context Compaction");
  });

  test("omits the covered-pages block when none given", () => {
    const p = buildTriagePrompt(docs, { existingPages: [] });
    expect(p).not.toContain("ALREADY covers these topics");
  });

  test("appends the interest-profile augment section when a profile is present", () => {
    const p = buildTriagePrompt(docs, { interestProfile: "- retrieval\n- evals" });
    // withInterestProfile marker text.
    expect(p).toContain("current interests");
    expect(p).toContain("retrieval");
    // The profile augments BEFORE the untrusted doc block.
    expect(p.indexOf("current interests")).toBeLessThan(p.indexOf("--- BEGIN DOCS ---"));
  });

  test("byte-identical base when no profile (augment is opt-in)", () => {
    const withNull = buildTriagePrompt(docs, { interestProfile: null });
    const without = buildTriagePrompt(docs, {});
    expect(withNull).toBe(without);
  });
});

// ── existingPageLines (shared helper) ────────────────────────────────────────

describe("existingPageLines", () => {
  function page(overrides: Partial<WikiPageMeta>): WikiPageMeta {
    return {
      name: overrides.name ?? "p",
      title: overrides.title ?? "P",
      type: overrides.type ?? "concept",
      domain: "ai",
      tags: [],
      aliases: overrides.aliases ?? [],
      relPath: overrides.relPath ?? "concepts/P.md",
    };
  }
  function index(pages: WikiPageMeta[]): WikiIndex {
    return {
      pages,
      outgoing: new Map(),
      backlinks: new Map(),
      resolve: () => undefined,
      resolveRelPath: () => undefined,
      scannedAt: 0,
      root: "/tmp",
    };
  }

  test("keeps concept + entity, drops source/analysis, formats aliases", () => {
    const lines = existingPageLines(
      index([
        page({ title: "Agent Loops", type: "concept", aliases: ["AI Agent Loops"] }),
        page({ title: "Anthropic", type: "entity", aliases: [] }),
        page({ title: "Some Video", type: "source", aliases: [] }),
        page({ title: "A Query", type: "analysis", aliases: [] }),
      ]),
    );
    expect(lines).toEqual(["Agent Loops (aliases: AI Agent Loops)", "Anthropic"]);
  });

  test("null index → empty", () => {
    expect(existingPageLines(null)).toEqual([]);
    expect(existingPageLines(undefined)).toEqual([]);
  });
});

// ── parseTriage ──────────────────────────────────────────────────────────────

describe("parseTriage", () => {
  test("parses valid rows, clamps + rounds score, trims reason", () => {
    const raw = JSON.stringify([
      { key: "c/1", score: 5, reason: " novel " },
      { key: "c/2", score: 2.6, reason: "partial" },
      { key: "c/3", score: 9, reason: "over" }, // clamped to 5
      { key: "c/4", score: -3, reason: "under" }, // clamped to 0
    ]);
    const r = parseTriage(raw);
    expect(r).toHaveLength(4);
    expect(r[0]).toEqual({ key: "c/1", score: 5, reason: "novel" });
    expect(r[1]!.score).toBe(3); // 2.6 rounds to 3
    expect(r[2]!.score).toBe(5);
    expect(r[3]!.score).toBe(0);
  });

  test("drops rows with no key, non-numeric score, or non-object", () => {
    const raw = JSON.stringify([
      { key: "", score: 5, reason: "x" },
      { key: "c/2", score: "abc", reason: "x" },
      "garbage",
      { key: "c/3", score: 4, reason: "ok" },
    ]);
    const r = parseTriage(raw);
    expect(r.map((x) => x.key)).toEqual(["c/3"]);
  });

  test("drops hallucinated keys when validKeys is given", () => {
    const raw = JSON.stringify([
      { key: "c/1", score: 5, reason: "real" },
      { key: "c/ghost", score: 5, reason: "hallucinated" },
    ]);
    const r = parseTriage(raw, new Set(["c/1"]));
    expect(r.map((x) => x.key)).toEqual(["c/1"]);
  });

  test("first score wins on a duplicate key", () => {
    const raw = JSON.stringify([
      { key: "c/1", score: 5, reason: "first" },
      { key: "c/1", score: 0, reason: "second" },
    ]);
    const r = parseTriage(raw);
    expect(r).toHaveLength(1);
    expect(r[0]!.reason).toBe("first");
  });

  test("non-array / non-JSON → []", () => {
    expect(parseTriage("{}")).toEqual([]);
    expect(parseTriage("not json at all")).toEqual([]);
  });
});

// ── rankTriage ───────────────────────────────────────────────────────────────

describe("rankTriage", () => {
  test("orders by score desc", () => {
    const ranked = rankTriage([
      { key: "a", score: 2 },
      { key: "b", score: 5 },
      { key: "c", score: 3 },
    ]);
    expect(ranked.map((r) => r.key)).toEqual(["b", "c", "a"]);
  });

  test("ties broken newest-first (higher dateMs wins); undated sorts last", () => {
    const ranked = rankTriage([
      { key: "old", score: 4, dateMs: 100 },
      { key: "new", score: 4, dateMs: 900 },
      { key: "undated", score: 4 },
    ]);
    expect(ranked.map((r) => r.key)).toEqual(["new", "old", "undated"]);
  });

  test("does not mutate the input", () => {
    const input = [
      { key: "a", score: 1 },
      { key: "b", score: 2 },
    ];
    rankTriage(input);
    expect(input.map((r) => r.key)).toEqual(["a", "b"]);
  });
});

// ── computeUnoffer ───────────────────────────────────────────────────────────

describe("computeUnoffer", () => {
  test("removes exactly the given keys from the offered set", () => {
    const { newOffered, removed } = computeUnoffer(
      new Set(["a", "b", "c"]),
      ["a", "c"],
    );
    expect(newOffered.sort()).toEqual(["b"]);
    expect(removed.sort()).toEqual(["a", "c"]);
  });

  test("a key not in the offered set is a no-op (not reported as removed)", () => {
    const { newOffered, removed } = computeUnoffer(new Set(["a"]), ["a", "missing"]);
    expect(newOffered).toEqual([]);
    expect(removed).toEqual(["a"]);
  });

  test("empty removal list leaves the set unchanged", () => {
    const { newOffered, removed } = computeUnoffer(new Set(["a", "b"]), []);
    expect(newOffered.sort()).toEqual(["a", "b"]);
    expect(removed).toEqual([]);
  });
});
