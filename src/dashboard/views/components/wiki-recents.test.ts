/**
 * The rail's recall rules: the stored lists, the Jira-key parse and resolution,
 * and `buildRail`'s section arrangement.
 *
 * The cases are written as an ENUMERATION of each rule's state space rather than
 * as samples — the lesson from PR 1 (#501), where a stateful gesture's rule was
 * judged against its running result instead of its start state and four verify
 * rounds went into one drag handle.
 */
import { describe, expect, test } from "bun:test";
import {
  JUMP_MAX,
  PINS_MAX,
  RECENTS_MAX,
  buildRail,
  jiraKeyJump,
  jumpHeaderLabel,
  parseJiraKey,
  parseJiraKeyCandidates,
  isPinnedRelPath,
  parseRelPathList,
  pinsKey,
  pushRecent,
  railSectionsVisible,
  recentsKey,
  serializeRelPathList,
  togglePin,
  type RailEntry,
} from "./wiki-recents.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";

function page(over: Partial<WikiListing> & { relPath: string }): WikiListing {
  return {
    name: over.relPath.slice(over.relPath.lastIndexOf("/") + 1).replace(/\.mdx?$/, ""),
    title: "Untitled",
    type: "note",
    domain: "ai",
    tags: [],
    aliases: [],
    linkCount: 0,
    backlinkCount: 0,
    ...over,
  } as WikiListing;
}

const INERT: WikiFilters = {
  q: "",
  domain: "",
  folder: "",
  type: "",
  tag: "",
  status: "",
  followups: "",
};

describe("storage keys", () => {
  test("are per wiki, and the default wiki gets the bare prefix", () => {
    expect(recentsKey("melosys")).toBe("muninn.wiki.recents.v1:melosys");
    expect(pinsKey("melosys")).toBe("muninn.wiki.pins.v1:melosys");
    expect(recentsKey("")).toBe("muninn.wiki.recents.v1:");
    expect(recentsKey("a")).not.toBe(recentsKey("b"));
  });
});

describe("parseRelPathList", () => {
  // The whole space of "what can be in that key".
  const junk: Array<[string, string | null | undefined]> = [
    ["absent", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["not json", "a/b.md"],
    ["a JSON string", '"a/b.md"'],
    ["a JSON number", "42"],
    ["a JSON object", '{"0":"a/b.md"}'],
    ["JSON null", "null"],
    ["truncated array", '["a/b.md"'],
  ];
  for (const [what, raw] of junk) {
    test(`${what} reads as an empty list`, () => {
      expect(parseRelPathList(raw, 6)).toEqual([]);
    });
  }

  test("keeps order, drops non-strings and blanks, collapses duplicates to the first", () => {
    const raw = JSON.stringify(["a.md", 3, "b.md", "  ", null, "a.md", { x: 1 }, "c.md"]);
    expect(parseRelPathList(raw, 6)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("trims entries", () => {
    expect(parseRelPathList(JSON.stringify([" a.md "]), 6)).toEqual(["a.md"]);
  });

  test("caps at max — a hand-edited 500-entry key cannot fill the rail", () => {
    const many = Array.from({ length: 500 }, (_, i) => `p${i}.md`);
    expect(parseRelPathList(JSON.stringify(many), RECENTS_MAX)).toHaveLength(RECENTS_MAX);
    expect(parseRelPathList(JSON.stringify(many), PINS_MAX)).toHaveLength(PINS_MAX);
  });

  test("round-trips what serializeRelPathList writes, at the cap", () => {
    const list = Array.from({ length: PINS_MAX }, (_, i) => `p${i}.md`);
    expect(parseRelPathList(serializeRelPathList(list), PINS_MAX)).toEqual(list);
  });
});

describe("pushRecent", () => {
  test("puts a new page first", () => {
    expect(pushRecent(["a.md"], "b.md")).toEqual(["b.md", "a.md"]);
  });
  test("moves an existing page to the front without duplicating it", () => {
    expect(pushRecent(["a.md", "b.md", "c.md"], "c.md")).toEqual(["c.md", "a.md", "b.md"]);
  });
  test("re-opening the head is a no-op in effect", () => {
    expect(pushRecent(["a.md", "b.md"], "a.md")).toEqual(["a.md", "b.md"]);
  });
  test(`caps at ${RECENTS_MAX}, dropping the oldest`, () => {
    let list: string[] = [];
    for (let i = 0; i < RECENTS_MAX + 3; i++) list = pushRecent(list, `p${i}.md`);
    expect(list).toHaveLength(RECENTS_MAX);
    expect(list[0]).toBe(`p${RECENTS_MAX + 2}.md`);
    expect(list).not.toContain("p0.md");
  });
  test("a blank relPath changes nothing — a failed load must not push an unresolvable entry", () => {
    expect(pushRecent(["a.md"], "")).toEqual(["a.md"]);
    expect(pushRecent(["a.md"], "   ")).toEqual(["a.md"]);
  });
  test("does not mutate its input", () => {
    const list = ["a.md"];
    pushRecent(list, "b.md");
    expect(list).toEqual(["a.md"]);
  });
});

describe("togglePin", () => {
  test("adds to the front", () => {
    expect(togglePin(["a.md"], "b.md")).toEqual(["b.md", "a.md"]);
  });
  test("removes an existing pin", () => {
    expect(togglePin(["a.md", "b.md"], "a.md")).toEqual(["b.md"]);
  });
  test("is its own inverse", () => {
    expect(togglePin(togglePin(["a.md"], "b.md"), "b.md")).toEqual(["a.md"]);
  });
  test("a blank relPath changes nothing", () => {
    expect(togglePin(["a.md"], "")).toEqual(["a.md"]);
  });
  test("at the cap the NEW pin survives and the oldest is dropped", () => {
    const full = Array.from({ length: PINS_MAX }, (_, i) => `p${i}.md`);
    const next = togglePin(full, "fresh.md");
    expect(next).toHaveLength(PINS_MAX);
    expect(next[0]).toBe("fresh.md");
    expect(next).not.toContain(`p${PINS_MAX - 1}.md`);
  });
  test("does not mutate its input", () => {
    const list = ["a.md"];
    togglePin(list, "b.md");
    expect(list).toEqual(["a.md"]);
  });
});

describe("parseJiraKey", () => {
  test("a bare four-digit number", () => {
    expect(parseJiraKey("7588")).toEqual({ key: null, num: "7588", display: "7588" });
  });
  test("a prefixed key, in either case", () => {
    expect(parseJiraKey("MELOSYS-7588")).toEqual({
      key: "melosys-7588",
      num: "7588",
      display: "MELOSYS-7588",
    });
    expect(parseJiraKey("melosys-7588")!.key).toBe("melosys-7588");
  });
  test("a key embedded in a sentence", () => {
    expect(parseJiraKey("fikset i MELOSYS-7588 og videre")!.key).toBe("melosys-7588");
    expect(parseJiraKey("noe om 7588 her")!.num).toBe("7588");
  });
  test("a prefixed key WINS over an earlier bare number", () => {
    // The date-plus-key case, which is why the two regexes are tried in order.
    expect(parseJiraKey("2026-08-27 MELOSYS-7588")!.key).toBe("melosys-7588");
  });
  test("a longer digit run is not a bare key", () => {
    expect(parseJiraKey("75880")).toBeNull();
    expect(parseJiraKey("17588")).toBeNull();
    expect(parseJiraKey("758")).toBeNull();
  });
  test("digits welded to letters are not a key", () => {
    expect(parseJiraKey("abc7588")).toBeNull();
    expect(parseJiraKey("v7588x")).toBeNull();
  });
  test("a one-letter prefix is not a project (V155 is a Flyway version)", () => {
    expect(parseJiraKey("V155")).toBeNull();
  });
  test("a prefixed key accepts 3–6 digits", () => {
    expect(parseJiraKey("AB-123")!.key).toBe("ab-123");
    expect(parseJiraKey("AB-123456")!.key).toBe("ab-123456");
    expect(parseJiraKey("AB-12")).toBeNull();
  });
  test("no key at all", () => {
    for (const q of ["", "   ", "nullable", "a/b", "12", "sept 26-09"]) {
      expect(parseJiraKey(q)).toBeNull();
    }
  });
  test("a bare four-digit YEAR is never a bare key", () => {
    // Measured on real mimir: `2026` as a key resolved to 121 of 485 pages,
    // because that wiki files pages as `archive/<yyyy-mm-dd>-<topic>.mdx`.
    for (const q of ["2026-09-01", "2026", "1999", "2099", "notat fra 1900"]) {
      expect(parseJiraKey(q), q).toBeNull();
    }
  });
  test("…but a PREFIXED key in the year range still parses — the project names it", () => {
    expect(parseJiraKey("MELOSYS-2026")!.key).toBe("melosys-2026");
  });
  test("a bare number just outside the year range is still a key", () => {
    expect(parseJiraKey("1899")!.num).toBe("1899");
    expect(parseJiraKey("2100")!.num).toBe("2100");
  });
});

describe("jiraKeyJump", () => {
  const own = page({
    relPath: "sources/jira/MELOSYS-7588.md",
    title: "MELOSYS-7588 — Utvid Trygdeavgiftsperiode",
    tags: ["jira", "melosys-7588"],
  });
  const byTitle = page({
    relPath: "archive/opprydding.md",
    title: "MELOSYS-7588 — Opprydding av avrunding",
    tags: ["rounding"],
  });
  const byTag = page({
    relPath: "flows/datamodel.md",
    title: "Trygdeavgift datamodel",
    tags: ["melosys-7588", "datamodel"],
  });
  const byAlias = page({
    relPath: "concepts/grunnlag.md",
    title: "Grunnlag",
    aliases: ["MELOSYS-7588 datamodel"],
  });
  const unrelated = page({ relPath: "concepts/other.md", title: "Something else", tags: ["x"] });
  const nearMiss = page({ relPath: "concepts/near.md", title: "Sak MELOSYS-75880 og MELOSYS-17588", tags: [] });
  const all = [own, byTitle, byTag, byAlias, unrelated, nearMiss];

  test("the issue's own page is found by its filename stem and listed first", () => {
    const j = jiraKeyJump(all, parseJiraKey("MELOSYS-7588")!);
    expect(j.own.map((p) => p.relPath)).toEqual(["sources/jira/MELOSYS-7588.md"]);
    expect(j.rows[0]).toBe(own);
  });

  test("the ADDRESS makes an own page — a title that merely opens with the key does not", () => {
    // The archive pages on this wiki are titled `MELOSYS-7588 — …`, so a
    // title-opener rule promoted every session note to an issue page.
    const opener = page({ relPath: "archive/notes.md", title: "MELOSYS-7588 — noe" });
    const addressed = page({ relPath: "sources/jira/MELOSYS-7588.md", title: "Utvid" });
    const j = jiraKeyJump([opener, addressed], parseJiraKey("MELOSYS-7588")!);
    expect(j.own).toEqual([addressed]);
    expect(j.refs).toEqual([opener]);
  });

  test("the canonical name is the other address — a page whose stem differs but whose name is the key", () => {
    const named = page({ relPath: "jira/whatever.md", title: "Utvid", name: "MELOSYS-7588" });
    expect(jiraKeyJump([named], parseJiraKey("MELOSYS-7588")!).own).toEqual([named]);
  });

  test("references come from tags, title, aliases and relPath — and only those", () => {
    const j = jiraKeyJump(all, parseJiraKey("MELOSYS-7588")!);
    expect(j.refs.map((p) => p.relPath).sort()).toEqual([
      "archive/opprydding.md",
      "concepts/grunnlag.md",
      "flows/datamodel.md",
    ]);
    expect(j.refs).not.toContain(unrelated);
  });

  test("an own page never appears again among the references", () => {
    const j = jiraKeyJump(all, parseJiraKey("MELOSYS-7588")!);
    expect(j.refs).not.toContain(own);
    expect(new Set(j.rows).size).toBe(j.rows.length);
  });

  test("a BARE number finds the same pages without the project prefix", () => {
    const bare = jiraKeyJump(all, parseJiraKey("7588")!);
    const prefixed = jiraKeyJump(all, parseJiraKey("MELOSYS-7588")!);
    expect(bare.rows.map((p) => p.relPath)).toEqual(prefixed.rows.map((p) => p.relPath));
  });

  test("a bare number does not match inside a longer number", () => {
    const j = jiraKeyJump(all, parseJiraKey("7588")!);
    expect(j.rows).not.toContain(nearMiss);
    expect(j.total).toBe(4);
  });

  test("a bare number matches a tag from ANOTHER project — the reader typed a number, not a project", () => {
    const other = page({ relPath: "x/y.md", title: "Other", tags: ["annet-7588"] });
    expect(jiraKeyJump([other], parseJiraKey("7588")!).refs).toEqual([other]);
    // …while a prefixed query is exact.
    expect(jiraKeyJump([other], parseJiraKey("MELOSYS-7588")!).total).toBe(0);
  });

  test("a key nothing matches resolves to nothing at all", () => {
    const j = jiraKeyJump(all, parseJiraKey("MELOSYS-4242")!);
    expect(j.total).toBe(0);
    expect(j.rows).toEqual([]);
  });

  test("input order is preserved inside each group", () => {
    const a = page({ relPath: "a.md", title: "x MELOSYS-7588", tags: [] });
    const b = page({ relPath: "b.md", title: "y MELOSYS-7588", tags: [] });
    expect(jiraKeyJump([a, b], parseJiraKey("7588")!).refs).toEqual([a, b]);
    expect(jiraKeyJump([b, a], parseJiraKey("7588")!).refs).toEqual([b, a]);
  });

  test(`rows cap at ${JUMP_MAX} while total keeps counting`, () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      page({ relPath: `m${i}.md`, title: `Ref MELOSYS-7588 #${i}`, tags: [] }),
    );
    const j = jiraKeyJump(many, parseJiraKey("7588")!);
    expect(j.rows).toHaveLength(JUMP_MAX);
    expect(j.total).toBe(21);
  });
});

describe("jumpHeaderLabel", () => {
  /** `ownN` pages ADDRESSED as the issue, `refN` that merely mention it. */
  const mk = (ownN: number, refN: number) =>
    jiraKeyJump(
      [
        ...Array.from({ length: ownN }, (_, i) =>
          page({ relPath: `sources/jira/o${i}/MELOSYS-7588.md`, title: "Utvid" }),
        ),
        ...Array.from({ length: refN }, (_, i) =>
          page({ relPath: `r${i}.md`, title: `ref MELOSYS-7588 ${i}` }),
        ),
      ],
      parseJiraKey("MELOSYS-7588")!,
    );

  test("one issue page and several references", () => {
    expect(jumpHeaderLabel(mk(1, 3))).toBe("MELOSYS-7588 · issue page + 3 referencing pages");
  });
  test("one reference is singular", () => {
    expect(jumpHeaderLabel(mk(1, 1))).toBe("MELOSYS-7588 · issue page + 1 referencing page");
  });
  test("an issue page and nothing else", () => {
    expect(jumpHeaderLabel(mk(1, 0))).toBe("MELOSYS-7588 · issue page");
  });
  test("references with no issue page", () => {
    expect(jumpHeaderLabel(mk(0, 4))).toBe("MELOSYS-7588 · 4 referencing pages");
  });
  test("more than one issue page", () => {
    expect(jumpHeaderLabel(mk(2, 0))).toBe("MELOSYS-7588 · 2 issue pages");
  });
  test("past the cap it says how many it is showing, and the count is the TRUE total", () => {
    const label = jumpHeaderLabel(mk(0, 21));
    expect(label).toBe(`MELOSYS-7588 · 21 referencing pages (showing ${JUMP_MAX})`);
  });
  test("a bare key shows the number, not an invented project", () => {
    const j = jiraKeyJump([page({ relPath: "r.md", title: "ref MELOSYS-7588" })], parseJiraKey("7588")!);
    expect(jumpHeaderLabel(j)).toBe("7588 · 1 referencing page");
  });
});

describe("railSectionsVisible", () => {
  test("only with the box empty and every facet inert", () => {
    expect(railSectionsVisible(INERT)).toBe(true);
  });
  // Each axis, one at a time — the enumeration is the point.
  const axes: Array<[keyof WikiFilters, string]> = [
    ["q", "nullable"],
    ["domain", "life"],
    ["folder", "archive"],
    ["type", "note"],
    ["tag", "jira"],
    ["status", "shipped"],
    ["followups", "open"],
  ];
  for (const [axis, value] of axes) {
    test(`an active ${axis} hides them`, () => {
      expect(railSectionsVisible({ ...INERT, [axis]: value })).toBe(false);
    });
  }
  test("a whitespace-only query is still empty", () => {
    expect(railSectionsVisible({ ...INERT, q: "   " })).toBe(true);
  });
});

describe("buildRail", () => {
  const a = page({ relPath: "a.md", title: "Alpha" });
  const b = page({ relPath: "b.md", title: "Beta" });
  const c = page({ relPath: "c.md", title: "Gamma" });
  const all = [a, b, c];
  const build = (over: Partial<Parameters<typeof buildRail>[0]> = {}) =>
    buildRail({ filtered: all, facetOnly: all, filters: INERT, recents: [], pins: [], ...over });

  const headers = (entries: RailEntry[]) =>
    entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label);
  const rows = (entries: RailEntry[]) =>
    entries.filter((e) => e.kind === "row") as Array<
      Extract<RailEntry, { kind: "row" }>
    >;

  test("a fresh browser gets exactly today's rail: rows, no headers", () => {
    const rail = build();
    expect(headers(rail.entries)).toEqual([]);
    expect(rows(rail.entries).map((r) => r.page)).toEqual(all);
    expect(rail.shown).toBe(3);
  });

  test("recents alone: the section, its clear affordance, and the REMAINDER below", () => {
    const rail = build({ recents: ["c.md"] });
    expect(headers(rail.entries)).toEqual(["Recently opened", "Other pages"]);
    const rs = rows(rail.entries);
    expect(rs[0]!.section).toBe("recent");
    expect(rs[0]!.page).toBe(c);
    // The section MOVED the row: `c` is not down there as well.
    expect(rs.filter((r) => r.section === "all").map((r) => r.page)).toEqual([a, b]);
    const clear = rail.entries.find((e) => e.kind === "header" && e.clear);
    expect(clear && (clear as { label: string }).label).toBe("Recently opened");
  });

  test("only the Recently opened header carries clear", () => {
    const rail = build({ recents: ["c.md"], pins: ["a.md"] });
    const clearing = rail.entries.filter((e) => e.kind === "header" && e.clear);
    expect(clearing).toHaveLength(1);
  });

  test("pins alone", () => {
    const rail = build({ pins: ["b.md"] });
    expect(headers(rail.entries)).toEqual(["Pinned", "Other pages"]);
    expect(rows(rail.entries)[0]!.page).toBe(b);
    expect(rows(rail.entries).map((r) => r.page)).toEqual([b, a, c]);
  });

  test("Pinned comes before Recently opened", () => {
    const rail = build({ recents: ["c.md"], pins: ["a.md"] });
    expect(headers(rail.entries)).toEqual(["Pinned", "Recently opened", "Other pages"]);
  });

  test("a page that is both pinned and recent renders under Pinned ONLY", () => {
    const rail = build({ recents: ["a.md", "c.md"], pins: ["a.md"] });
    const section = (s: string) => rows(rail.entries).filter((r) => r.section === s).map((r) => r.page);
    expect(section("pinned")).toEqual([a]);
    expect(section("recent")).toEqual([c]);
  });

  test("…and un-pinning restores it to its place in the recents order", () => {
    // Same stored recents, no pin: `a` is back at the head of the recents section.
    const rail = build({ recents: ["a.md", "c.md"], pins: [] });
    expect(rows(rail.entries).filter((r) => r.section === "recent").map((r) => r.page)).toEqual([a, c]);
  });

  test("sections follow the STORED order, not the sort", () => {
    const rail = build({ recents: ["c.md", "a.md", "b.md"] });
    expect(rows(rail.entries).filter((r) => r.section === "recent").map((r) => r.page)).toEqual([c, a, b]);
  });

  test("an entry naming no page in the listing is dropped from the render", () => {
    const rail = build({ recents: ["gone.md", "a.md"], pins: ["also-gone.md"] });
    expect(headers(rail.entries)).toEqual(["Recently opened", "Other pages"]);
    expect(rows(rail.entries).filter((r) => r.section === "recent").map((r) => r.page)).toEqual([a]);
  });

  test("an empty listing renders no sections at all, though the lists are non-empty", () => {
    // The pre-fetch boot render. Nothing resolves, so nothing is claimed.
    const rail = buildRail({
      filtered: [],
      facetOnly: [],
      filters: INERT,
      recents: ["a.md"],
      pins: ["b.md"],
    });
    expect(rail.entries).toEqual([]);
    expect(rail.shown).toBe(0);
  });

  test("an active facet hides the sections entirely", () => {
    const rail = buildRail({
      filtered: [a],
      facetOnly: [a],
      filters: { ...INERT, type: "note" },
      recents: ["c.md"],
      pins: ["b.md"],
    });
    expect(headers(rail.entries)).toEqual([]);
    expect(rows(rail.entries).map((r) => r.page)).toEqual([a]);
  });

  test("the pinned flag rides the row, and the row is in ONE place", () => {
    const rail = build({ pins: ["a.md"] });
    const pinnedRows = rows(rail.entries).filter((r) => r.pinned);
    expect(pinnedRows.map((r) => [r.section, r.page.relPath])).toEqual([["pinned", "a.md"]]);
  });

  test("shown counts DISTINCT pages — a page in a section and in the listing is one", () => {
    expect(build({ recents: ["a.md"], pins: ["b.md"] }).shown).toBe(3);
  });

  describe("with a key in the query", () => {
    const issue = page({
      relPath: "sources/jira/MELOSYS-7588.md",
      title: "MELOSYS-7588 — Utvid",
      tags: ["melosys-7588"],
    });
    const ref = page({ relPath: "flows/d.md", title: "Datamodel", tags: ["melosys-7588"] });
    const other = page({ relPath: "o.md", title: "Om MELOSYS-7588 i teksten" });
    const corpus = [issue, ref, other];
    // What the substring search itself would return for "MELOSYS-7588".
    const substring = [issue];

    test("the jump block leads, then the remaining ordinary results under Other matches", () => {
      const rail = buildRail({
        filtered: [issue, other],
        facetOnly: corpus,
        filters: { ...INERT, q: "MELOSYS-7588" },
        recents: ["a.md"],
        pins: ["b.md"],
      });
      // The jump swallowed both ordinary results, so there is no remainder and
      // no `Other matches` header to introduce one.
      expect(headers(rail.entries)).toEqual(["MELOSYS-7588 · issue page + 2 referencing pages"]);
      const rs = rows(rail.entries);
      expect(rs.filter((r) => r.section === "jump").map((r) => r.page)).toEqual([issue, ref, other]);
      // …and the pages the jump already showed are NOT repeated below.
      expect(rs.filter((r) => r.section === "all")).toEqual([]);
    });

    test("Other matches only appears when something is left over", () => {
      const spare = page({ relPath: "s.md", title: "Spare" });
      const rail = buildRail({
        filtered: [issue, spare],
        facetOnly: [issue, spare],
        filters: { ...INERT, q: "MELOSYS-7588" },
        recents: [],
        pins: [],
      });
      expect(headers(rail.entries)).toEqual(["MELOSYS-7588 · issue page", "Other matches"]);
      expect(rows(rail.entries).filter((r) => r.section === "all").map((r) => r.page)).toEqual([spare]);
    });

    test("recall sections never render beside a jump — the query is not empty", () => {
      const rail = buildRail({
        filtered: substring,
        facetOnly: corpus,
        filters: { ...INERT, q: "MELOSYS-7588" },
        recents: ["a.md"],
        pins: ["b.md"],
      });
      expect(headers(rail.entries)).not.toContain("Pinned");
      expect(headers(rail.entries)).not.toContain("Recently opened");
    });

    test("a key that resolves to nothing renders no header at all", () => {
      const rail = buildRail({
        filtered: [],
        facetOnly: corpus,
        filters: { ...INERT, q: "2026-09-01" },
        recents: [],
        pins: [],
      });
      expect(rail.entries).toEqual([]);
    });

    test("the jump reads facetOnly, so it finds pages the query's substring search misses", () => {
      const rail = buildRail({
        filtered: substring,
        facetOnly: corpus,
        filters: { ...INERT, q: "MELOSYS-7588" },
        recents: [],
        pins: [],
      });
      const jumped = rows(rail.entries).filter((r) => r.section === "jump").map((r) => r.page);
      expect(jumped).toContain(ref);
      expect(jumped).toContain(other);
      // …and those extra pages are counted, so "N / total" describes the screen.
      expect(rail.shown).toBe(3);
    });

    test("a facet still narrows the jump", () => {
      const rail = buildRail({
        filtered: [issue],
        facetOnly: [issue],
        filters: { ...INERT, q: "MELOSYS-7588", folder: "sources" },
        recents: [],
        pins: [],
      });
      expect(rows(rail.entries).map((r) => r.page)).toEqual([issue]);
      expect(headers(rail.entries)).toEqual(["MELOSYS-7588 · issue page"]);
    });

    test("a pinned page inside the jump still shows as pinned", () => {
      const rail = buildRail({
        filtered: [issue],
        facetOnly: [issue],
        filters: { ...INERT, q: "MELOSYS-7588" },
        recents: [],
        pins: ["sources/jira/MELOSYS-7588.md"],
      });
      expect(rows(rail.entries)[0]!.pinned).toBe(true);
    });
  });
});
// Appended to wiki-recents.test.ts — the RED batch for fix round 1.
describe("fix round 1 — the three root causes", () => {
  const P = (relPath: string, title = "Untitled", tags: string[] = [], aliases: string[] = []) =>
    page({ relPath, title, tags, aliases });

  // ── (B) the key parse ────────────────────────────────────────────────
  describe("a candidate that resolves to nothing falls through to the next", () => {
    const issue = P("sources/jira/MELOSYS-7588.md", "Utvid");
    const corpus = [issue];

    test("a Flyway-shaped token before the key does not suppress it", () => {
      const rail = buildRail({
        filtered: [], facetOnly: corpus,
        filters: { ...INERT, q: "V155-2026 MELOSYS-7588" }, recents: [], pins: [],
      });
      const h = rail.entries.filter((e) => e.kind === "header");
      expect(h.map((e) => (e as { label: string }).label)).toEqual(["MELOSYS-7588 · issue page"]);
    });

    test("a date before the key does not suppress it", () => {
      const rail = buildRail({
        filtered: [], facetOnly: corpus,
        filters: { ...INERT, q: "2026-08-27 MELOSYS-7588" }, recents: [], pins: [],
      });
      expect(rail.entries.filter((e) => e.kind === "row")).toHaveLength(1);
    });

    test("nothing resolves ⇒ no jump", () => {
      const rail = buildRail({
        filtered: [], facetOnly: corpus,
        filters: { ...INERT, q: "V155-2026 og AB-999" }, recents: [], pins: [],
      });
      expect(rail.entries).toEqual([]);
    });
  });

  describe("a bare number that is a YEAR is not a key at all", () => {
    // The mimir case: `archive/2026-08-27-*.md` everywhere, and a `2026` query
    // must not grow a Jira header over the whole wiki.
    const dated = [
      P("archive/2026-08-27-seven-fix-rounds.mdx", "Seven fix rounds"),
      P("archive/2026-08-30-wikilinks.mdx", "Wikilinks inside code", ["retro-2026"]),
      P("blogs/2026-08-27-fix-rounds.mdx", "Fix rounds inject defects"),
    ];
    test("a year query resolves to nothing, so no jump renders", () => {
      const rail = buildRail({
        filtered: dated, facetOnly: dated,
        filters: { ...INERT, q: "2026" }, recents: [], pins: [],
      });
      expect(rail.entries.filter((e) => e.kind === "header")).toEqual([]);
    });
    test("…because a year is not a candidate at all", () => {
      expect(parseJiraKeyCandidates("2026-08-27")).toEqual([]);
    });
    test("a `<prefix>-<year>` TAG cannot stand in for a key either", () => {
      // `retro-2026` is an ordinary tag shape and matched the bare-number rule
      // exactly; the year range is what closes it.
      expect(parseJiraKeyCandidates("2026")).toEqual([]);
    });
    test("a real key in a title is still a reference", () => {
      const refs = jiraKeyJump([P("a.md", "MELOSYS-7588 — Opprydding")], parseJiraKey("7588")!);
      expect(refs.total).toBe(1);
    });
  });

  test("a PREFIXED key does not match inside a longer issue number", () => {
    // MELOSYS-75880 is a different issue, and the more specific query is what
    // used to report it as referencing MELOSYS-7588.
    const other = P("sources/jira/MELOSYS-75880.md", "Et annet");
    const j = jiraKeyJump([other], parseJiraKey("MELOSYS-7588")!);
    expect(j.total).toBe(0);
  });

  test("the two query forms agree about the same wiki", () => {
    const corpus = [
      P("sources/jira/MELOSYS-7588.md", "Utvid"),
      P("sources/jira/MELOSYS-75880.md", "Annet"),
      P("flows/d.md", "Datamodel", ["melosys-7588"]),
    ];
    const bare = jiraKeyJump(corpus, parseJiraKey("7588")!);
    const pre = jiraKeyJump(corpus, parseJiraKey("MELOSYS-7588")!);
    expect(bare.rows.map((p) => p.relPath)).toEqual(pre.rows.map((p) => p.relPath));
    expect(bare.total).toBe(2);
  });

  // ── (A) every page appears exactly ONCE in the rail ───────────────────
  describe("sections MOVE rows, they never copy them", () => {
    const a = P("a.md", "Alpha");
    const b = P("b.md", "Beta");
    const c = P("c.md", "Gamma");
    const all = [a, b, c];

    const rowsOf = (r: ReturnType<typeof buildRail>) =>
      r.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;

    test("a recent page is NOT also in the listing below", () => {
      const rail = buildRail({ filtered: all, facetOnly: all, filters: INERT, recents: ["a.md"], pins: [] });
      const rows = rowsOf(rail);
      expect(rows.map((r) => r.page.relPath)).toEqual(["a.md", "b.md", "c.md"]);
      expect(rows.filter((r) => r.page.relPath === "a.md")).toHaveLength(1);
      expect(rows[0]!.section).toBe("recent");
      expect(rows[1]!.section).toBe("all");
    });

    test("no relPath renders twice, in ANY arrangement", () => {
      for (const recents of [[], ["a.md"], ["a.md", "c.md"], ["c.md", "b.md", "a.md"]]) {
        for (const pins of [[], ["b.md"], ["a.md", "b.md"]]) {
          const rail = buildRail({ filtered: all, facetOnly: all, filters: INERT, recents, pins });
          const rels = rowsOf(rail).map((r) => r.page.relPath);
          expect(new Set(rels).size, `recents=${recents} pins=${pins}`).toBe(rels.length);
          expect(rels.length).toBe(all.length);
        }
      }
    });

    test("the count still equals the rows on screen", () => {
      const rail = buildRail({ filtered: all, facetOnly: all, filters: INERT, recents: ["a.md"], pins: ["b.md"] });
      expect(rail.shown).toBe(rowsOf(rail).length);
      expect(rail.shown).toBe(3);
    });

    test("the remainder header says what it is", () => {
      const rail = buildRail({ filtered: all, facetOnly: all, filters: INERT, recents: ["a.md"], pins: [] });
      expect(rail.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label))
        .toEqual(["Recently opened", "Other pages"]);
    });

    test("with everything pinned or recent there is no remainder header", () => {
      const rail = buildRail({
        filtered: all, facetOnly: all, filters: INERT,
        recents: ["a.md", "b.md", "c.md"], pins: [],
      });
      expect(rail.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label))
        .toEqual(["Recently opened"]);
    });
  });

  // ── relPath resolution is normalized, like every other lookup ─────────
  test("a stored relPath resolves case- and separator-insensitively", () => {
    const p = P("Archive/Notes.md", "Notes");
    const rail = buildRail({
      filtered: [p], facetOnly: [p], filters: INERT,
      recents: ["archive/notes.md"], pins: [],
    });
    const rows = rail.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;
    expect(rows[0]!.section).toBe("recent");
  });
});

describe("fix round 2 — what the verify pass found", () => {
  const P = (relPath: string, title = "Untitled", tags: string[] = []) =>
    page({ relPath, title, tags });

  test("a bare number in PROSE is a reference — the recall the round-1 rule quietly removed", () => {
    // `Sak 7588 løst` names the issue the way a person writes it. Requiring a
    // `<prefix>-<number>` token here bought nothing the year range does not
    // already close, and it was not pinned by any test.
    const prose = P("archive/notat.md", "Sak 7588 løst i går");
    expect(jiraKeyJump([prose], parseJiraKey("7588")!).refs).toEqual([prose]);
  });

  test("…still bounded by digits, so a longer number is not a reference", () => {
    const longer = P("archive/annet.md", "Sak 75880 og 17588");
    expect(jiraKeyJump([longer], parseJiraKey("7588")!).total).toBe(0);
  });

  test("a <prefix>-<year> TAG really would match — the year range is what closes it", () => {
    // Both halves, because either alone is vacuous: the tag shape IS a hazard…
    const tagged = P("archive/retro.md", "Retro", ["retro-2026"]);
    expect(jiraKeyJump([tagged], { key: null, num: "2026", display: "2026" }).refs).toEqual([
      tagged,
    ]);
    // …and the reason it never fires is that `2026` is not a candidate at all.
    expect(parseJiraKeyCandidates("2026")).toEqual([]);
  });
});

describe("fix round 3 — the class check", () => {
  test("a page NAMED as the bare number is the issue's own page, not a reference", () => {
    // `isKeyToken` (tags, page name) and `mentions` (prose) described different
    // key shapes after round 2 reverted the prose half: a page at
    // `sources/jira/7588.md` counted as a REFERENCE to itself.
    const bare = page({ relPath: "sources/jira/7588.md", title: "Utvid" });
    expect(jiraKeyJump([bare], parseJiraKey("7588")!).own).toEqual([bare]);
  });

  test("…and a prefixed query still needs the prefix on the address", () => {
    const bare = page({ relPath: "sources/jira/7588.md", title: "Utvid" });
    expect(jiraKeyJump([bare], parseJiraKey("MELOSYS-7588")!).own).toEqual([]);
  });
});

describe("fix round 5 — one pin comparison, not two", () => {
  test("a pin is recognised however the stored relPath is spelled", () => {
    // `buildRail` resolves pins through `findPageByRelPath` (case- and
    // separator-insensitive) while the DOM painter used a raw `indexOf`, so the
    // two answered differently for the same state — measured live: the section
    // said pinned, the ★ said not, and clicking it added a SECOND entry for one
    // page, which then rendered twice under a count that said otherwise.
    expect(isPinnedRelPath(["CONCEPTS/FILLER-56.MD"], "concepts/Filler-56.md")).toBe(true);
    expect(isPinnedRelPath(["archive\\notes.md"], "archive/notes.md")).toBe(true);
    expect(isPinnedRelPath(["concepts/a.md"], "concepts/b.md")).toBe(false);
    expect(isPinnedRelPath([], "concepts/a.md")).toBe(false);
  });

  test("…and buildRail's own pinned flag uses that same comparison", () => {
    const p = page({ relPath: "Archive/Notes.md", title: "Notes" });
    const rail = buildRail({
      filtered: [p], facetOnly: [p], filters: INERT,
      recents: [], pins: ["archive/notes.md"],
    });
    const rows = rail.entries.filter((e) => e.kind === "row") as Array<
      Extract<RailEntry, { kind: "row" }>
    >;
    expect(rows.map((r) => [r.section, r.pinned])).toEqual([["pinned", true]]);
  });
});

describe("fix round 6 — relPath identity has ONE boundary", () => {
  test("the stored form is normalized, so a raw comparison inside the list is exact", () => {
    expect(parseRelPathList(JSON.stringify(["Archive/Notes.MD"]), 6)).toEqual(["archive/notes.md"]);
    expect(parseRelPathList(JSON.stringify(["archive\\notes.md"]), 6)).toEqual(["archive/notes.md"]);
  });

  test("…so a read collapses spellings of one page instead of keeping both", () => {
    expect(parseRelPathList(JSON.stringify(["a/B.md", "A/b.md"]), 6)).toEqual(["a/b.md"]);
  });

  test("togglePin removes a differently-cased pin instead of adding a second", () => {
    expect(togglePin(["concepts/kildeskatt.md"], "CONCEPTS/KILDESKATT.MD")).toEqual([]);
  });

  test("pushRecent moves a differently-cased entry rather than duplicating it", () => {
    expect(pushRecent(["concepts/a.md", "concepts/b.md"], "CONCEPTS/A.MD")).toEqual([
      "concepts/a.md",
      "concepts/b.md",
    ]);
  });

  // The two above pass an already-normalized LIST, which is all the reader ever
  // produces — so they leave the writers' own comparisons equivalent under the
  // current call graph and unpinned as contracts. These pass an UNNORMALIZED
  // list, which is what a key written by an older build is, and pin the
  // functions rather than their one caller.
  test("togglePin is correct against a list that was never normalized", () => {
    expect(togglePin(["CONCEPTS/A.MD"], "concepts/a.md")).toEqual([]);
  });

  test("pushRecent is correct against a list that was never normalized", () => {
    expect(pushRecent(["CONCEPTS/A.MD", "concepts/b.md"], "concepts/a.md")).toEqual([
      "concepts/a.md",
      "concepts/b.md",
    ]);
  });

  test("buildRail renders a page ONCE even if storage holds two spellings of it", () => {
    // The invariant is buildRail's own, so it must not depend on the storage
    // layer having been perfect — a key written by an older build still renders
    // one row.
    const p = page({ relPath: "concepts/a.md", title: "A" });
    const rail = buildRail({
      filtered: [p], facetOnly: [p], filters: INERT,
      recents: [], pins: ["concepts/a.md", "CONCEPTS/A.MD"],
    });
    const rows = rail.entries.filter((e) => e.kind === "row");
    expect(rows).toHaveLength(1);
    expect(rail.shown).toBe(1);
  });

  test("…and one page cannot appear in both recall sections", () => {
    const p = page({ relPath: "concepts/a.md", title: "A" });
    const rail = buildRail({
      filtered: [p], facetOnly: [p], filters: INERT,
      recents: ["CONCEPTS/A.MD"], pins: ["concepts/a.md"],
    });
    expect(rail.entries.filter((e) => e.kind === "row")).toHaveLength(1);
  });
});
