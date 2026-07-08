import { test, expect, describe } from "bun:test";
import { docDateMs, filterWindow, deriveTitle, harvestDocs } from "./harvest.ts";
import type { ListedDoc, RawFetchedDoc } from "./types.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-08T12:00:00Z");

describe("docDateMs", () => {
  test("prefers explicit date", () => {
    expect(docDateMs({ id: "whatever.md", date: "2026-07-01" })).toBe(Date.parse("2026-07-01"));
  });
  test("falls back to YYYY-MM-DD filename prefix", () => {
    expect(docDateMs({ id: "2026-06-30_topic.md" })).toBe(Date.parse("2026-06-30"));
  });
  test("undefined when undeterminable", () => {
    expect(docDateMs({ id: "topic.md" })).toBeUndefined();
  });
});

describe("filterWindow", () => {
  const docs: ListedDoc[] = [
    { id: "2026-07-07_recent.md" },
    { id: "2026-06-01_old.md" },
    { id: "no-date.md" }, // kept (undeterminable)
  ];
  test("keeps in-window and undated, drops old", () => {
    const kept = filterWindow(docs, 14, NOW).map((d) => d.id);
    expect(kept).toContain("2026-07-07_recent.md");
    expect(kept).toContain("no-date.md");
    expect(kept).not.toContain("2026-06-01_old.md");
  });
});

describe("deriveTitle", () => {
  test("uses first markdown heading", () => {
    expect(deriveTitle("2026-07-01_abc.md", "# Context Compaction\n\nbody")).toBe("Context Compaction");
  });
  test("falls back to filename stem, stripping date prefix", () => {
    expect(deriveTitle("2026-07-01_context_compaction.md", "no heading here")).toBe("context compaction");
  });
});

describe("harvestDocs", () => {
  const listed: Record<string, ListedDoc[]> = {
    "youtube-summaries": [
      { id: "2026-07-07_a.md" }, // in window, fetched
      { id: "2026-06-01_b.md" }, // out of window
      { id: "2026-07-06_c.md" }, // in window but consumed
    ],
  };
  const bodies: Record<string, RawFetchedDoc> = {
    "2026-07-07_a.md": { text: "# Topic A\n\nAbout A.", metadata: { url: "https://a", category: "ai" } },
    "2026-07-06_c.md": { text: "# Topic C\n\nAbout C." },
  };

  test("fetches only in-window, unconsumed docs", async () => {
    const fetched: string[] = [];
    const result = await harvestDocs(
      ["youtube-summaries"],
      {
        listDocs: async (c) => listed[c] ?? [],
        fetchDoc: async (_c, id) => {
          fetched.push(id);
          return bodies[id] ?? null;
        },
      },
      {
        lookbackDays: 14,
        consumed: new Set(["youtube-summaries/2026-07-06_c.md"]),
        now: NOW,
      },
    );
    expect(fetched).toEqual(["2026-07-07_a.md"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("youtube-summaries/2026-07-07_a.md");
    expect(result[0]!.title).toBe("Topic A");
    expect(result[0]!.url).toBe("https://a");
    expect(result[0]!.category).toBe("ai");
  });
});
