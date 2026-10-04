/**
 * `wiki-find.ts` — the palette's grammar, matching, scoring, pool and grouping,
 * over synthetic listings (a public repo carries no live-corpus fixture).
 */

import { describe, expect, test } from "bun:test";
import {
  applySeriesChip,
  FIND_ROWS_MAX,
  foldText,
  highlightFind,
  parseFindQuery,
  rankFind,
} from "./wiki-find.ts";
import type { WikiListing } from "./wiki-filter.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const DAY = 86_400_000;

function pg(relPath: string, over: Partial<WikiListing> = {}): WikiListing {
  return {
    name: relPath.split("/").pop()!.replace(/\.[^.]+$/, ""),
    title: relPath,
    type: "plan",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath,
    linkCount: 0,
    backlinkCount: 0,
    mtimeMs: NOW - 400 * DAY,
    ...over,
  } as WikiListing;
}

const order = (pages: WikiListing[], q: string, near?: Record<string, number>) =>
  rankFind(pages, q, { now: NOW, near }).rows.map((r) => r.page.relPath);

describe("parseFindQuery", () => {
  test("free words, quoted in:, type:, age:, #tag, is:retired", () => {
    expect(parseFindQuery('fix  Rounds in:"Two Words" type:pl age:<14 age:>2 #Ops is:retired')).toEqual({
      words: ["fix", "rounds"],
      inSeries: ["two words"],
      types: ["pl"],
      tags: ["ops"],
      ageLt: 14,
      ageGt: 2,
      retired: true,
    });
  });

  test("`#<digits>` is a number word, not a tag", () => {
    const q = parseFindQuery("#500");
    expect(q.words).toEqual(["500"]);
    expect(q.tags).toEqual([]);
  });

  test("an unknown key, a bad age and `is:` anything else are free words", () => {
    expect(parseFindQuery("foo:bar age:soon is:open").words).toEqual(["foo:bar", "age:soon", "is:open"]);
  });

  test("diacritics fold", () => {
    expect(foldText("Kjøring Æble café")).toBe("kjoring aeble cafe");
    expect(parseFindQuery("Kjøring").words).toEqual(["kjoring"]);
  });
});

describe("matching", () => {
  test("words are ANDed: a word hitting no field drops the page", () => {
    const pages = [pg("a.md", { title: "Alpha beta" }), pg("b.md", { title: "Alpha gamma" })];
    expect(order(pages, "alpha beta")).toEqual(["a.md"]);
  });

  test("a digit word matches a WHOLE number in the title, ISO dates removed", () => {
    const pages = [
      pg("round9.md", { title: "Review, round 9" }),
      pg("dated.md", { title: "Notes 2026-09-12" }),
      pg("r19.md", { title: "Review, round 19" }),
    ];
    expect(order(pages, "9")).toEqual(["round9.md"]);
  });

  test("`#<digits>` finds a numbered title", () => {
    const pages = [pg("a.md", { title: "Four fix rounds on muninn #500" }), pg("b.md", { title: "PR 5000" })];
    expect(order(pages, "#500")).toEqual(["a.md"]);
  });

  test("the relPath matches only at a segment start", () => {
    const pages = [pg("archive/x.md", { title: "X" }), pg("notes/myarchive.md", { title: "Y" })];
    expect(order(pages, "archive")).toEqual(["archive/x.md"]);
  });

  test("a word hitting several fields sums their weights", () => {
    const both = pg("a.md", { title: "Gardener", tags: ["gardener"] });
    const one = pg("b.md", { title: "Gardener" });
    expect(order([one, both], "gardener")).toEqual(["a.md", "b.md"]);
  });

  test("an empty query answers nothing", () => {
    expect(rankFind([pg("a.md")], "   ", { now: NOW }).rows).toEqual([]);
  });
});

describe("filters", () => {
  const pages = [
    pg("s1.md", { title: "One", series: "two-words-series", seriesLabel: "Two words" }),
    pg("s2.md", { title: "Two", series: "two-words-series" }),
    pg("other.md", { title: "Three", series: "other" }),
    pg("loose.md", { title: "Four" }),
  ];

  test('in:"two words" narrows to the series by its LABEL, members without the label included', () => {
    expect(order(pages, 'in:"two words"').sort()).toEqual(["s1.md", "s2.md"]);
  });

  test("in: matches the series key too", () => {
    expect(order(pages, "in:other")).toEqual(["other.md"]);
  });

  test("a filter-only in: query ranks the one-hop member first", () => {
    expect(order(pages, 'in:"two words"', { "s2.md": 0.5 })[0]).toBe("s2.md");
    expect(order(pages, 'in:"two words"', { "s1.md": 0.5 })[0]).toBe("s1.md");
  });

  test("type: is a prefix; age: needs a date and runs on the worked axis", () => {
    const aged = [
      pg("new.md", { type: "plan", workedMs: NOW - 3 * DAY, title: "N" }),
      pg("old.md", { type: "blog", mtimeMs: NOW - 90 * DAY, title: "O" }),
      pg("undated.md", { type: "plan", mtimeMs: undefined, title: "U" }),
    ];
    expect(order(aged, "type:pl").sort()).toEqual(["new.md", "undated.md"]);
    expect(order(aged, "age:<14")).toEqual(["new.md"]);
    expect(order(aged, "age:>14")).toEqual(["old.md"]);
  });

  test("#tag is a tag prefix", () => {
    const tagged = [pg("a.md", { tags: ["operations"] }), pg("b.md", { tags: ["ux"] })];
    expect(order(tagged, "#oper")).toEqual(["a.md"]);
  });
});

describe("the pool", () => {
  const pages = [
    pg("plans/p.md", { title: "Topic page" }),
    pg("plans/p.html", { title: "Topic explainer", parent: "plans/p.md", pairedBy: "stem" }),
    pg("plans/p-prototype.html", { title: "Topic proto", parent: "plans/p.md", pairedBy: "suffix" }),
    pg("plans/old.md", { title: "Topic old", parent: "plans/p.md", pairedBy: "superseded" }),
    pg("plans/gone.md", { title: "Topic gone", culled: true }),
    pg("plans/index.md", { title: "Topic index" }),
  ];

  test("bookkeeping, attachment children and culled pages are out; superseded stays", () => {
    expect(order(pages, "topic").sort()).toEqual(["plans/old.md", "plans/p.md"]);
  });

  test("is:retired admits culled pages", () => {
    expect(order(pages, "topic is:retired")).toContain("plans/gone.md");
  });
});

describe("ordering and grouping", () => {
  test("near boosts: a one-hop page outranks an equal text match two hops away", () => {
    const pages = [pg("far.md", { title: "Ledger" }), pg("hop1.md", { title: "Ledger" })];
    expect(order(pages, "ledger", { "hop1.md": 0.5, "far.md": 0.13 })).toEqual(["hop1.md", "far.md"]);
  });

  test("recency breaks a text tie", () => {
    const pages = [
      pg("old.md", { title: "Ledger", mtimeMs: NOW - 300 * DAY }),
      pg("new.md", { title: "Ledger", mtimeMs: NOW - 1 * DAY }),
    ];
    expect(order(pages, "ledger")).toEqual(["new.md", "old.md"]);
  });

  test("a no-series row outscoring a series group is the FIRST row", () => {
    const pages = [
      pg("s/a.md", { title: "Ledger notes", series: "s" }),
      pg("s/b.md", { title: "Ledger", series: "s" }),
      pg("loose.md", { title: "Ledger ledger", tags: ["ledger"], description: "the ledger" }),
    ];
    const r = rankFind(pages, "ledger", { now: NOW });
    expect(r.rows[0]!.page.relPath).toBe("loose.md");
    expect(r.groups[0]!.seriesKey).toBe("");
    expect(r.groups[1]!.rows.map((x) => x.page.relPath).sort()).toEqual(["s/a.md", "s/b.md"]);
  });

  test("series members group together behind their best row", () => {
    const pages = [
      pg("s/a.md", { title: "Ledger", series: "s", tags: ["ledger"] }),
      pg("loose.md", { title: "Ledger" }),
      pg("s/b.md", { title: "Ledger", series: "s" }),
    ];
    const r = rankFind(pages, "ledger", { now: NOW });
    expect(r.rows.map((x) => x.page.relPath)).toEqual(["s/a.md", "s/b.md", "loose.md"]);
  });

  test(`rows cap at ${FIND_ROWS_MAX}; chips count ALL matches and emit a quoted in:`, () => {
    const pages = Array.from({ length: 50 }, (_, i) =>
      pg(`s/p${i}.md`, { title: `Ledger ${i}`, series: "Big series" }),
    );
    const r = rankFind(pages, "ledger", { now: NOW });
    expect(r.rows.length).toBe(FIND_ROWS_MAX);
    expect(r.total).toBe(50);
    expect(r.chips).toEqual([{ seriesKey: "big series", label: "Big series", count: 50, token: 'in:"Big series"' }]);
    expect(applySeriesChip("ledger in:old", r.chips[0]!.token)).toBe('ledger in:"Big series"');
  });
});

describe("highlightFind", () => {
  test("one pass: a later term never matches inside markup an earlier one inserted", () => {
    expect(highlightFind("class check", ["class", "mark", "check"])).toBe("<mark>class</mark> <mark>check</mark>");
    expect(highlightFind("a mark here", ["mark", "class"])).toBe("a <mark>mark</mark> here");
  });

  test("escapes the text and marks folded matches on the raw characters", () => {
    expect(highlightFind("<b>Kjøring</b>", ["kjoring"])).toBe("&lt;b&gt;<mark>Kjøring</mark>&lt;/b&gt;");
  });

  test("a digit term marks whole numbers only", () => {
    expect(highlightFind("round 9 of 19", ["9"])).toBe("round <mark>9</mark> of 19");
  });
});

describe("timing", () => {
  test("rankFind over a 600-page listing", () => {
    const pages = Array.from({ length: 600 }, (_, i) =>
      pg(`f${i % 7}/page-${i}.md`, {
        title: `Page ${i} about ${["ledger", "gardener", "review", "series"][i % 4]} round ${i % 13}`,
        tags: [`t${i % 9}`],
        description: `Description of page ${i}`,
        series: i % 5 === 0 ? `series-${i % 11}` : undefined,
      }),
    );
    const near = Object.fromEntries(pages.slice(0, 200).map((p, i) => [p.relPath, 0.2 + (i % 5) / 10]));
    const runs: number[] = [];
    for (let k = 0; k < 20; k++) {
      const t0 = performance.now();
      rankFind(pages, "ledger round 9", { now: NOW, near });
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    console.log(`rankFind 600 pages: median ${runs[10]!.toFixed(2)} ms, max ${runs[19]!.toFixed(2)} ms`);
    expect(runs[10]!).toBeLessThan(50);
  });
});
