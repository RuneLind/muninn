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
  seriesMatchKey,
} from "./wiki-find.ts";
import type { WikiListing } from "./wiki-filter.ts";
import { seriesHead, seriesKeyOf } from "./wiki-groups.ts";

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
      series: [],
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

  test(`rows cap at ${FIND_ROWS_MAX}; chips count ALL matches and emit a quoted series:`, () => {
    const pages = Array.from({ length: 50 }, (_, i) =>
      pg(`s/p${i}.md`, { title: `Ledger ${i}`, series: "Big series" }),
    );
    const r = rankFind(pages, "ledger", { now: NOW });
    expect(r.rows.length).toBe(FIND_ROWS_MAX);
    expect(r.total).toBe(50);
    expect(r.chips).toEqual([{ seriesKey: "big series", label: "Big series", count: 50, token: 'series:"big series"' }]);
    expect(applySeriesChip("ledger in:old series:x", r.chips[0]!.token)).toBe('ledger in:old series:"big series"');
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

describe("series chips apply exactly what they count", () => {
  const pages = [
    pg("a/s1.md", { title: "Review one", series: "ship" }),
    pg("a/s2.md", { title: "Review two", series: "ship" }),
    pg("b/p1.md", { title: "Review three", series: "shipping-pipeline" }),
    pg("b/p2.md", { title: "Review four", series: "shipping-pipeline" }),
    pg("b/p3.md", { title: "Review five", series: "shipping-pipeline" }),
  ];

  test("the `ship` chip counts 2 and applying it yields 2, not the 5 `in:ship` admits", () => {
    const r = rankFind(pages, "review", { now: NOW });
    const ship = r.chips.find((c) => c.label === "ship")!;
    expect(ship.count).toBe(2);
    const applied = rankFind(pages, applySeriesChip("review", ship.token), { now: NOW });
    expect(applied.total).toBe(ship.count);
    for (const c of r.chips) {
      expect(rankFind(pages, applySeriesChip("review", c.token), { now: NOW }).total).toBe(c.count);
    }
  });

  test("`in:` stays a substring match on the key", () => {
    expect(rankFind(pages, "review in:ship", { now: NOW }).total).toBe(5);
  });

  test("series: matches the key exactly, without case; a quote in the key is matched stripped on both sides", () => {
    expect(rankFind(pages, "series:SHIP", { now: NOW }).total).toBe(2);
    const quoted = [pg("q.md", { title: "Q", series: 'say "hi" now' })];
    const chip = rankFind(quoted, "q", { now: NOW }).chips[0]!;
    expect(chip.token).toBe('series:"say hi now"');
    expect(rankFind(quoted, chip.token, { now: NOW }).total).toBe(1);
  });
});

describe("series grouping follows the rail", () => {
  test("the group key is the rail's fold (case only), so `Kjøring` and `kjoring` are two series", () => {
    const pages = [
      pg("a.md", { title: "Ledger a", series: "Kjøring" }),
      pg("b.md", { title: "Ledger b", series: "kjoring" }),
      pg("c.md", { title: "Ledger c", series: "KJØRING" }),
    ];
    const r = rankFind(pages, "ledger", { now: NOW });
    expect(r.chips.map((c) => [c.seriesKey, c.count]).sort()).toEqual([
      ["kjoring", 1],
      ["kjøring", 2],
    ]);
  });

  test("the label is the rail's seriesHead label, not the last one listed", () => {
    const members = [
      pg("s/new.md", { title: "Ledger new", series: "s", seriesLabel: "New label", mtimeMs: NOW - 2 * DAY }),
      pg("s/old.md", { title: "Ledger old", series: "s", seriesLabel: "Old label", mtimeMs: NOW - 90 * DAY }),
    ];
    expect(seriesHead(members)!.seriesLabel).toBe("New label");
    const r = rankFind(members, "ledger", { now: NOW });
    expect(r.chips[0]!.label).toBe("New label");
    expect(r.groups[0]!.seriesLabel).toBe("New label");
  });
});

describe("grammar edge cases", () => {
  test("stray quotes on free words are dropped", () => {
    expect(parseFindQuery('"class check"').words).toEqual(["class", "check"]);
    expect(parseFindQuery('"class').words).toEqual(["class"]);
    expect(parseFindQuery('class"').words).toEqual(["class"]);
    expect(parseFindQuery('"').words).toEqual([]);
  });

  test("a quoted phrase finds the page its words find", () => {
    const pages = [pg("a.md", { title: "The class check fired" })];
    expect(order(pages, '"class check"')).toEqual(["a.md"]);
  });

  test("a known key with no value yet is ignored — no filter, no word", () => {
    for (const raw of ["in:", 'in:"', 'in:""', 'in:" "', "type:", "is:", "series:", 'series:""', "#", "age:<", "age:>", "age:"]) {
      const q = parseFindQuery(raw);
      expect({ raw, words: q.words, tags: q.tags, inSeries: q.inSeries, types: q.types }).toEqual({
        raw,
        words: [],
        tags: [],
        inSeries: [],
        types: [],
      });
      expect(rankFind([pg("in-type-is-series-age.md", { title: "in: type: is: series: # age:" })], raw, { now: NOW }).rows).toEqual([]);
    }
  });

  test("two bounds of one direction keep the tighter", () => {
    expect(parseFindQuery("age:<5 age:<10").ageLt).toBe(5);
    expect(parseFindQuery("age:<10 age:<5").ageLt).toBe(5);
    expect(parseFindQuery("age:>5 age:>10").ageGt).toBe(10);
    expect(parseFindQuery("age:>10 age:>5").ageGt).toBe(10);
  });
});

describe("highlightFind and ISO dates", () => {
  test("a digit term never marks digits inside an ISO date — the scorer's rule", () => {
    expect(highlightFind("Review 2026-10-02, round 10", ["10"])).toBe("Review 2026-10-02, round <mark>10</mark>");
    expect(highlightFind("Month 2026-10 and 10", ["10"])).toBe("Month 2026-10 and <mark>10</mark>");
  });

  test("a non-digit term is unaffected by the date rule", () => {
    expect(highlightFind("2026-10-02 round", ["round", "10"])).toBe("2026-10-02 <mark>round</mark>");
  });
});

/** mulberry32 — a seeded PRNG, so a failing case reproduces from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("chip invariant (property): a chip's count is what applying it yields", () => {
  // Pieces a series key is built from: the grammar's own syntax characters,
  // diacritics, case variants, whitespace, and keys that are substrings of others.
  const PIECES = ["<", ">", '"', " ", ":", "#", "ø", "æ", "å", "Ø", "Å", "a", "A", "b", "ab", "ship", "Ship", "shipping", "in:", "é", "é", "  ", "-", "x"];
  const FIXED = ["<", ">", 'a"b', "ab", "Kjøring", "kjøring", "KJØRING", "  ", '"', "a b", "ship", "shipping-pipeline", "#ops", "in:x", "series:y", '"q"', "<a", ">b c"];
  const WORDS = ["note", "ledger", "review", "ship", "round", "10", "9", "kjoring", "alpha"];
  const LABELS = ["Driftsplan", "Ship", "Notes", "<", "a b", ""];

  function pick<T>(r: () => number, xs: readonly T[]): T {
    return xs[Math.floor(r() * xs.length)]!;
  }

  function listing(r: () => number): WikiListing[] {
    const keys = Array.from({ length: 2 + Math.floor(r() * 5) }, () =>
      r() < 0.5
        ? pick(r, FIXED)
        : Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, PIECES)).join(""),
    );
    const n = 3 + Math.floor(r() * 25);
    return Array.from({ length: n }, (_, i) => {
      const words = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, WORDS));
      const label = pick(r, LABELS);
      return pg(`p/${i}.md`, {
        title: words.join(" "),
        series: r() < 0.8 ? pick(r, keys) : undefined,
        seriesLabel: label || undefined,
        tags: r() < 0.3 ? ["ops"] : [],
        type: r() < 0.5 ? "plan" : "blog",
        culled: r() < 0.1,
        mtimeMs: NOW - Math.floor(r() * 60) * DAY,
      });
    }) as WikiListing[];
  }

  function query(r: () => number, pages: readonly WikiListing[]): string {
    const keys = pages.map((p) => p.series ?? "").filter(Boolean);
    const frag = () => {
      const k = keys.length ? pick(r, keys) : "ab";
      const a = Math.floor(r() * k.length);
      return k.slice(a, a + 1 + Math.floor(r() * 4));
    };
    const toks = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
      const roll = r();
      if (roll < 0.35) return pick(r, WORDS);
      if (roll < 0.55) {
        const f = frag();
        return r() < 0.5 || /\s/.test(f) ? `in:"${f}"` : `in:${f}`;
      }
      if (roll < 0.65) return `series:"${keys.length ? pick(r, keys) : "x"}"`;
      return pick(r, ["type:pl", "#ops", "is:retired", "age:<30", "age:>5", '"', "<", ">", 'foo:"a b"', "#", "in:", 'in:"ab']);
    });
    // An unclosed quote last: the next token a chip appends must not fall into it.
    if (r() < 0.15) toks.push(`in:"${frag()}`);
    return toks.join(" ");
  }

  test("for 600 seeded listings × 4 queries: count == applied total, applying twice is idempotent, every applied row is in the chip's series", () => {
    const bad: string[] = [];
    let chipsSeen = 0;
    for (let seed = 1; seed <= 600 && bad.length < 5; seed++) {
      const r = prng(seed);
      const pages = listing(r);
      for (let k = 0; k < 4; k++) {
        const q = query(r, pages);
        const res = rankFind(pages, q, { now: NOW, limit: 1000 });
        for (const c of res.chips) {
          chipsSeen++;
          const applied = applySeriesChip(q, c.token);
          const got = rankFind(pages, applied, { now: NOW, limit: 1000 });
          const twice = applySeriesChip(applied, c.token);
          const outside = got.rows.filter((x) => seriesMatchKey(seriesKeyOf(x.page)) !== c.seriesKey);
          if (got.total !== c.count || twice !== applied || outside.length) {
            bad.push(
              `seed ${seed}: query ${JSON.stringify(q)} chip ${JSON.stringify(c.token)} count ${c.count} → ` +
                `${JSON.stringify(applied)} yields ${got.total}` +
                (twice !== applied ? `; twice ${JSON.stringify(twice)}` : "") +
                (outside.length ? `; ${outside.length} rows outside the series` : ""),
            );
            break;
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(chipsSeen).toBeGreaterThan(500);
  });

  test("a series key `<` or `>` is a series, not an empty value (only `age:` reads `<`/`>` as unfinished)", () => {
    const pages = [
      pg("a.md", { title: "Note a", series: "<" }),
      pg("b.md", { title: "Note b", series: "<" }),
      pg("c.md", { title: "Note c", series: ">" }),
    ];
    const r = rankFind(pages, "note", { now: NOW });
    const lt = r.chips.find((c) => c.seriesKey === "<")!;
    expect(lt.count).toBe(2);
    expect(rankFind(pages, applySeriesChip("note", lt.token), { now: NOW }).total).toBe(2);
    expect(parseFindQuery("series:<").series).toEqual(["<"]);
    expect(parseFindQuery("in:>").inSeries).toEqual([">"]);
    expect(parseFindQuery("age:<").ageLt).toBeUndefined();
  });

  test("quote twins `a\"b` and `ab` under `in:ab`: the chip keeps `in:` and yields its count", () => {
    const pages = [pg("q.md", { title: "Note q", series: 'a"b' }), pg("p.md", { title: "Note p", series: "ab" })];
    const r = rankFind(pages, "note in:ab", { now: NOW });
    const chip = r.chips[0]!;
    expect(chip.count).toBe(1);
    const applied = applySeriesChip("note in:ab", chip.token);
    expect(applied).toBe("note in:ab series:ab");
    expect(rankFind(pages, applied, { now: NOW }).total).toBe(1);
  });

  test("an unclosed quoted value is closed before a chip is appended", () => {
    expect(applySeriesChip('note in:"ab', "series:ab")).toBe('note in:"ab" series:ab');
  });
});

describe("pinned rules", () => {
  test("the scorer's ISO-date rule: `10` does not hit a date, and does hit a whole 10 beside one", () => {
    expect(order([pg("d.md", { title: "Notes 2026-10-04" })], "10")).toEqual([]);
    expect(order([pg("r.md", { title: "Round 10 on 2026-10-04" })], "10")).toEqual(["r.md"]);
  });

  test("a series label is looked up by the rail's fold of the key — `in:` and a free word both reach it", () => {
    const pages = [pg("k.md", { title: "Plan", series: "Kjøring", seriesLabel: "Driftsplan" })];
    expect(order(pages, "in:drift")).toEqual(["k.md"]);
    expect(order(pages, "driftsplan")).toEqual(["k.md"]);
  });
});
