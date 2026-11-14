/** Seed rules shared by the Discover page's seed bar and the weekly watcher. Invented ids only (public repo). */
import { describe, expect, test } from "bun:test";
import * as seedsMod from "./discover-seeds.ts";
import { categoryOfDocId, lastWeekSeeds, newestInCategory, seedCategories, toSeedDocs } from "./discover-seeds.ts";
import { parseCapturedListing } from "./discover-deps.ts";

const NOW = Date.parse("2026-11-14T09:00:00Z");

describe("categoryOfDocId", () => {
  test("the folder, or null at the root", () => {
    expect(categoryOfDocId("ai/claude-code/A talk.md")).toBe("ai/claude-code");
    expect(categoryOfDocId("music/B.md")).toBe("music");
    expect(categoryOfDocId("Root.md")).toBeNull();
    expect(categoryOfDocId("/Leading.md")).toBeNull();
  });
});

describe("toSeedDocs", () => {
  test("titles from the file name, newest first, undated last, ties by id", () => {
    const docs = toSeedDocs([
      { id: "b/Undated.md", url: null, date: null },
      { id: "a/Older.md", url: null, date: "2026-11-01" },
      { id: "b/Same day.md", url: null, date: "2026-11-10" },
      { id: "a/Same day.md", url: null, date: "2026-11-10" },
    ]);
    expect(docs.map((d) => d.id)).toEqual(["a/Same day.md", "b/Same day.md", "a/Older.md", "b/Undated.md"]);
    expect(docs[0]).toEqual({ id: "a/Same day.md", title: "Same day", category: "a", date: "2026-11-10" });
  });
});

describe("seedCategories", () => {
  test("counts per category, largest first then by name; root docs have none", () => {
    const docs = toSeedDocs([
      { id: "z/1.md", url: null, date: null },
      { id: "z/2.md", url: null, date: null },
      { id: "b/1.md", url: null, date: null },
      { id: "a/1.md", url: null, date: null },
      { id: "Root.md", url: null, date: null },
    ]);
    expect(seedCategories(docs)).toEqual([
      { category: "z", count: 2 },
      { category: "a", count: 1 },
      { category: "b", count: 1 },
    ]);
  });
});

describe("newestInCategory", () => {
  test("only that category (not a sub-folder), newest 5", () => {
    const docs = toSeedDocs([
      ...[1, 2, 3, 4, 5, 6].map((d) => ({ id: `ai/T${d}.md`, url: null, date: `2026-11-0${d}` })),
      { id: "ai/sub/Deeper.md", url: null, date: "2026-11-09" },
      { id: "music/Other.md", url: null, date: "2026-11-09" },
    ]);
    expect(newestInCategory(docs, "ai").map((d) => d.id)).toEqual(["ai/T6.md", "ai/T5.md", "ai/T4.md", "ai/T3.md", "ai/T2.md"]);
    expect(newestInCategory(docs, "ai", 2).map((d) => d.id)).toEqual(["ai/T6.md", "ai/T5.md"]);
  });
});

describe("lastWeekSeeds", () => {
  test("today and the six days before it, newest first, at most 5; undated never", () => {
    const docs = toSeedDocs([
      { id: "a/Today.md", url: null, date: "2026-11-14" },
      { id: "a/Six days ago.md", url: null, date: "2026-11-08" },
      { id: "a/Seven days ago.md", url: null, date: "2026-11-07" },
      { id: "a/Undated.md", url: null, date: null },
    ]);
    expect(lastWeekSeeds(docs, NOW).map((d) => d.id)).toEqual(["a/Today.md", "a/Six days ago.md"]);
  });

  test("capped", () => {
    const docs = toSeedDocs([8, 9, 10, 11, 12, 13, 14].map((d) => ({ id: `a/D${d}.md`, url: null, date: `2026-11-${String(d).padStart(2, "0")}` })));
    expect(lastWeekSeeds(docs, NOW).map((d) => d.id)).toEqual(["a/D14.md", "a/D13.md", "a/D12.md", "a/D11.md", "a/D10.md"]);
    expect(lastWeekSeeds(docs, NOW, 7)).toHaveLength(7);
  });
});

describe("parseCapturedListing", () => {
  test("id, url and the day from date, else modifiedTime; rows with no id dropped", () => {
    expect(
      parseCapturedListing({
        documents: [
          { id: "a/One.md", url: "https://youtu.be/aaaaaaaaaaa", date: "2026-11-02" },
          { id: "a/Two.md", url: "", modifiedTime: "2026-11-03T10:11:12Z" },
          { id: "a/Three.md", date: "not a date" },
          { url: "https://youtu.be/bbbbbbbbbbb" },
          null,
        ],
      }),
    ).toEqual([
      { id: "a/One.md", url: "https://youtu.be/aaaaaaaaaaa", date: "2026-11-02" },
      { id: "a/Two.md", url: null, date: "2026-11-03" },
      { id: "a/Three.md", url: null, date: null },
    ]);
    expect(parseCapturedListing(null)).toEqual([]);
    expect(parseCapturedListing({ documents: "x" })).toEqual([]);
  });
});

describe("seedWindowStart (fix round 1 batch 2)", () => {
  const start = (now: number, last: number | null): string =>
    (seedsMod as unknown as { seedWindowStart: (n: number, l: number | null) => string }).seedWindowStart(now, last);
  test("the last 7 days with no earlier success", () => {
    expect(start(NOW, null)).toBe("2026-11-08");
  });
  test("widened back to the last successful run's day, so that day's later captures still count", () => {
    expect(start(NOW, Date.parse("2026-11-07T12:00:00Z"))).toBe("2026-11-07");
    expect(start(NOW, Date.parse("2026-11-03T23:59:00Z"))).toBe("2026-11-03");
  });
  test("never narrower than the week, never wider than 14 days", () => {
    expect(start(NOW, Date.parse("2026-11-12T12:00:00Z"))).toBe("2026-11-08");
    expect(start(NOW, Date.parse("2026-10-01T12:00:00Z"))).toBe("2026-11-01");
  });
});
