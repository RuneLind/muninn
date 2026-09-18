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
  FOLDS_MAX,
  JUMP_MAX,
  PINS_MAX,
  SECTION_META_FOLD_KEY,
  buildRail,
  foldChipCompactLabel,
  foldChipCountsClass,
  foldChipKinds,
  foldChipLabel,
  foldChipLabelClass,
  normalizeFoldKey,
  foldsKey,
  isFoldOpen,
  toggleFold,
  jiraKeyJump,
  jumpHeaderLabel,
  parseJiraKey,
  parseJiraKeyCandidates,
  isPinnedRelPath,
  pairedByWhy,
  parseRelPathList,
  pinsKey,
  railSectionsVisible,
  serializeRelPathList,
  togglePin,
  type RailEntry,
  type RailSection,
} from "./wiki-recents.ts";
import { GROUP_FAMILIES_TOGGLE_KEY, groupRollup, railGroups } from "./wiki-groups.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { ActivityRow } from "./wiki-activity-rank.ts";

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
  project: "",
  jira: "",
};

describe("storage keys", () => {
  test("are per wiki, and the default wiki gets the bare prefix", () => {
    expect(pinsKey("melosys")).toBe("muninn.wiki.pins.v1:melosys");
    expect(pinsKey("")).toBe("muninn.wiki.pins.v1:");
    expect(pinsKey("a")).not.toBe(pinsKey("b"));
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
    expect(parseRelPathList(JSON.stringify(many), 6)).toHaveLength(6);
    expect(parseRelPathList(JSON.stringify(many), PINS_MAX)).toHaveLength(PINS_MAX);
  });

  test("round-trips what serializeRelPathList writes, at the cap", () => {
    const list = Array.from({ length: PINS_MAX }, (_, i) => `p${i}.md`);
    expect(parseRelPathList(serializeRelPathList(list), PINS_MAX)).toEqual(list);
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
  test("with the box empty and every facet inert", () => {
    expect(railSectionsVisible(INERT)).toBe(true);
  });
  test("a query hides them — a search is a find, and the Jira jump owns that head", () => {
    expect(railSectionsVisible({ ...INERT, q: "nullable" })).toBe(false);
  });
  // Each facet, one at a time — the enumeration is the point. A facet NARROWS
  // Pinned (it resolves from the filtered list); it does not hide it.
  const facets: Array<[keyof WikiFilters, string]> = [
    ["domain", "life"],
    ["folder", "archive"],
    ["type", "note"],
    ["tag", "jira"],
    ["status", "shipped"],
    ["followups", "open"],
    ["project", "pomme-core"],
  ];
  for (const [axis, value] of facets) {
    test(`an active ${axis} keeps them`, () => {
      expect(railSectionsVisible({ ...INERT, [axis]: value })).toBe(true);
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
    buildRail({ filtered: all, facetOnly: all, filters: INERT, pins: [], ...over });

  const headers = (entries: RailEntry[]) =>
    entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label);
  const rows = (entries: RailEntry[]) =>
    entries.filter((e) => e.kind === "row") as Array<
      Extract<RailEntry, { kind: "row" }>
    >;

  test("a facet NARROWS Pinned to the filtered list instead of hiding it", () => {
    // Under `type=plan` the reader still wants the plans they pinned on top —
    // the ones outside the filter simply do not resolve.
    const filters = { ...INERT, type: "plan" };
    const m = buildRail({ filtered: [a, c], facetOnly: [a, c], filters, pins: ["a.md", "b.md"] });
    expect(headers(m.entries)).toEqual(["Pinned", "Other pages"]);
    const rs = rows(m.entries);
    expect(rs.filter((r) => r.section === "pinned").map((r) => r.page)).toEqual([a]);
    expect(rs.filter((r) => r.section === "all").map((r) => r.page)).toEqual([c]);
    expect(m.shown).toBe(2);
  });
  test("under a facet the remainder still renders, minus the lifted rows", () => {
    const m = buildRail({ filtered: [a, b, c], facetOnly: [a, b, c], filters: { ...INERT, type: "plan" }, pins: ["a.md"] });
    expect(headers(m.entries)).toEqual(["Pinned", "Other pages"]);
    expect(rows(m.entries).filter((r) => r.section === "all").map((r) => r.page)).toEqual([b, c]);
    expect(m.shown).toBe(3);
  });
  test("every facet keeps Pinned on screen — enumerated, one axis at a time", () => {
    const facets: Array<[keyof WikiFilters, string]> = [
      ["domain", "life"],
      ["folder", "archive"],
      ["type", "plan"],
      ["tag", "jira"],
      ["status", "shipped"],
      ["followups", "open"],
      ["project", "pomme-core"],
    ];
    for (const [axis, value] of facets) {
      const m = buildRail({ filtered: all, facetOnly: all, filters: { ...INERT, [axis]: value }, pins: ["b.md"] });
      expect(headers(m.entries), axis).toEqual(["Pinned", "Other pages"]);
    }
  });
  test("metaTail: the sunk bookkeeping pages get their own header", () => {
    // sortPages already puts index/log/CLAUDE last in a recency mode; without a
    // header the date column jumps back to today at the tail and reads as a
    // broken sort.
    const log = page({ relPath: "log.md", title: "Log" });
    const idx = page({ relPath: "plans/index.md", title: "Index" });
    // COLLAPSED by default (rail-grouping PR 1): the header stays and carries
    // its count, the rows are not emitted, and `shown` says so.
    const collapsed = buildRail({ filtered: [a, b, log, idx], facetOnly: [a, b, log, idx], filters: INERT, pins: [], metaTail: true });
    expect(headers(collapsed.entries)).toEqual(["Bookkeeping"]);
    const metaHeader = collapsed.entries.find((e) => e.kind === "header" && e.section === "meta")!;
    expect(metaHeader).toMatchObject({ folded: true, count: 2, foldKey: SECTION_META_FOLD_KEY });
    expect(rows(collapsed.entries).map((r) => [r.section, r.page.relPath])).toEqual([
      ["all", "a.md"],
      ["all", "b.md"],
    ]);
    expect(collapsed.shown).toBe(2);

    // Opened, it is the pre-fold rail exactly.
    const m = buildRail({ filtered: [a, b, log, idx], facetOnly: [a, b, log, idx], filters: INERT, pins: [], metaTail: true, openFolds: [SECTION_META_FOLD_KEY] });
    expect(headers(m.entries)).toEqual(["Bookkeeping"]);
    expect(rows(m.entries).map((r) => [r.section, r.page.relPath])).toEqual([
      ["all", "a.md"],
      ["all", "b.md"],
      ["meta", "log.md"],
      ["meta", "plans/index.md"],
    ]);
    expect(m.shown).toBe(4);
    // A reader ON a bookkeeping page sees it, whatever the store says.
    const onMeta = buildRail({ filtered: [a, b, log, idx], facetOnly: [a, b, log, idx], filters: INERT, pins: [], metaTail: true, openRelPath: "log.md" });
    expect(rows(onMeta.entries).some((r) => r.page.relPath === "log.md")).toBe(true);
    // Off (title / backlinks modes), they are ordinary rows wherever the sort put them.
    const off = buildRail({ filtered: [log, a], facetOnly: [log, a], filters: INERT, pins: [] });
    expect(headers(off.entries)).toEqual([]);
    expect(rows(off.entries).map((r) => r.section)).toEqual(["all", "all"]);
    // The split's reachable cells, one row each: query × what lifts (a pin, a
    // pin that resolves to nothing) × non-meta in the remainder × meta in the
    // remainder. The header explains a TAIL, so it needs something rendered
    // above it — lifted rows count — and never appears in a search result list.
    type Case = { name: string; q: string; pins?: string[]; filtered: WikiListing[]; headers: string[]; sections: RailSection[] };
    const cases: Case[] = [
      { name: "query", q: "lo", filtered: [a, log], headers: [], sections: ["all", "all"] },
      { name: "query, lifted", q: "lo", pins: ["a.md"], filtered: [a, log], headers: [], sections: ["all", "all"] },
      { name: "nothing above, meta only", q: "", filtered: [log, idx], headers: [], sections: ["all", "all"] },
      { name: "unresolved pin is not 'above'", q: "", pins: ["ghost.md"], filtered: [log, idx], headers: [], sections: ["all", "all"] },
      { name: "non-meta above", q: "", filtered: [a, log], headers: ["Bookkeeping"], sections: ["all", "meta"] },
      { name: "pin-lifted above, meta-only remainder", q: "", pins: ["a.md"], filtered: [a, log, idx], headers: ["Pinned", "Bookkeeping"], sections: ["pinned", "meta", "meta"] },
      { name: "lifted above, mixed remainder", q: "", pins: ["a.md"], filtered: [a, b, log], headers: ["Pinned", "Other pages", "Bookkeeping"], sections: ["pinned", "all", "meta"] },
      { name: "lifted above, empty remainder", q: "", pins: ["a.md"], filtered: [a], headers: ["Pinned"], sections: ["pinned"] },
      { name: "no meta at all", q: "", pins: ["a.md"], filtered: [a, b], headers: ["Pinned", "Other pages"], sections: ["pinned", "all"] },
    ];
    for (const c of cases) {
      // The query case has no key, so the jump never fires; `q` only gates the
      // split. `openFolds` holds Bookkeeping open throughout, so this table keeps
      // measuring the SPLIT rather than the fold (which has its own cases above).
      const m = buildRail({ filtered: c.filtered, facetOnly: c.filtered, filters: { ...INERT, q: c.q }, pins: c.pins ?? [], metaTail: true, openFolds: [SECTION_META_FOLD_KEY] });
      expect(headers(m.entries), c.name).toEqual(c.headers);
      expect(rows(m.entries).map((r) => r.section), c.name).toEqual(c.sections);
      expect(m.shown, c.name).toBe(c.filtered.length);
    }
    // A pinned meta page is lifted like any other; only the remainder is split.
    const pinnedMeta = buildRail({ filtered: [a, log], facetOnly: [a, log], filters: INERT, pins: ["log.md"], metaTail: true });
    expect(headers(pinnedMeta.entries)).toEqual(["Pinned", "Other pages"]);
  });
  test("a query still hides Pinned", () => {
    const m = buildRail({ filtered: [a, b], facetOnly: [a, b], filters: { ...INERT, q: "a" }, pins: ["a.md"] });
    expect(headers(m.entries)).toEqual([]);
  });

  test("a fresh browser gets exactly today's rail: rows, no headers", () => {
    const rail = build();
    expect(headers(rail.entries)).toEqual([]);
    expect(rows(rail.entries).map((r) => r.page)).toEqual(all);
    expect(rail.shown).toBe(3);
  });

  test("pins alone: the section, and the REMAINDER below", () => {
    const rail = build({ pins: ["b.md"] });
    expect(headers(rail.entries)).toEqual(["Pinned", "Other pages"]);
    const rs = rows(rail.entries);
    expect(rs[0]!.section).toBe("pinned");
    expect(rs[0]!.page).toBe(b);
    // The section MOVED the row: `b` is not down there as well.
    expect(rs.filter((r) => r.section === "all").map((r) => r.page)).toEqual([a, c]);
    expect(rs.map((r) => r.page)).toEqual([b, a, c]);
  });

  test("Pinned follows the STORED order, not the sort", () => {
    const rail = build({ pins: ["c.md", "a.md", "b.md"] });
    expect(rows(rail.entries).filter((r) => r.section === "pinned").map((r) => r.page)).toEqual([c, a, b]);
  });

  test("an entry naming no page in the listing is dropped from the render", () => {
    const rail = build({ pins: ["also-gone.md", "a.md"] });
    expect(headers(rail.entries)).toEqual(["Pinned", "Other pages"]);
    expect(rows(rail.entries).filter((r) => r.section === "pinned").map((r) => r.page)).toEqual([a]);
  });

  test("an empty listing renders no sections at all, though the pin list is non-empty", () => {
    // The pre-fetch boot render. Nothing resolves, so nothing is claimed.
    const rail = buildRail({
      filtered: [],
      facetOnly: [],
      filters: INERT,
      pins: ["b.md"],
    });
    expect(rail.entries).toEqual([]);
    expect(rail.shown).toBe(0);
  });

  test("a facet whose scope holds no pinned page renders no section", () => {
    const rail = buildRail({
      filtered: [a],
      facetOnly: [a],
      filters: { ...INERT, type: "note" },
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
    expect(build({ pins: ["b.md"] }).shown).toBe(3);
  });

  describe("Activity", () => {
    // Ranked by the caller, so these cases state the ranking's OUTPUT directly
    // and pin `buildRail`'s half: placement, claim order and the fold.
    const row = (p: WikiListing, kind: "new" | "changed" = "new"): ActivityRow => ({
      page: p,
      kind,
      score: 1,
      why: `${kind} — because`,
      ageMs: 2 * 86_400_000,
    });

    test("Activity leads the rail, above Pinned", () => {
      // Claim ORDER is the whole precedence rule: swap the two blocks and the
      // pinned page renders under `Pinned` with `Activity` below it.
      const rail = build({ activity: [row(c)], pins: ["a.md"] });
      expect(headers(rail.entries)).toEqual(["Activity", "Pinned", "Other pages"]);
      expect(rows(rail.entries).filter((r) => r.section === "activity").map((r) => r.page)).toEqual([c]);
      expect(rows(rail.entries)[0]!.page).toBe(c);
    });

    test("a page that is both new and pinned renders under Activity ONLY", () => {
      const rail = build({ activity: [row(a)], pins: ["a.md"] });
      const lifted = rows(rail.entries).filter((r) => r.page === a);
      expect(lifted).toHaveLength(1);
      expect(lifted[0]!.section).toBe("activity");
      expect(headers(rail.entries)).toEqual(["Activity", "Other pages"]);
    });

    test("Activity CLAIMS its pages, so Pinned and the remainder skip them", () => {
      const rail = build({ activity: [row(a), row(b), row(c)], pins: ["a.md"] });
      expect(headers(rail.entries)).toEqual(["Activity"]);
      expect(rows(rail.entries).map((r) => [r.section, r.page.relPath])).toEqual([
        ["activity", "a.md"],
        ["activity", "b.md"],
        ["activity", "c.md"],
      ]);
      expect(rail.shown).toBe(3);
    });

    test("a page Activity lifted still carries its pinned flag", () => {
      const rail = build({ activity: [row(a)], pins: ["a.md"] });
      const lifted = rows(rail.entries).find((r) => r.page === a)!;
      expect(lifted.section).toBe("activity");
      expect(lifted.pinned).toBe(true);
    });

    test("the kind and the reason ride the row", () => {
      const rail = build({ activity: [row(a, "changed")] });
      expect(rows(rail.entries)[0]!.activity).toEqual({
        kind: "changed",
        why: "changed — because",
        ageMs: 2 * 86_400_000,
      });
      // Only Activity rows carry it — a listing row must not grow a glyph.
      expect(rows(rail.entries).find((r) => r.section === "all")!.activity).toBeUndefined();
    });

    test("an empty ranking renders no header", () => {
      expect(headers(build({ activity: [] }).entries)).toEqual([]);
      expect(headers(build({}).entries)).toEqual([]);
    });

    test("a query hides it, exactly like the Pinned section", () => {
      const rail = buildRail({
        filtered: [a],
        facetOnly: [a],
        filters: { ...INERT, q: "alph" },
        pins: [],
        activity: [row(a)],
      });
      expect(headers(rail.entries)).toEqual([]);
      expect(rows(rail.entries)[0]!.section).toBe("all");
    });

    test("a facet NARROWS it — the caller ranks the filtered pages", () => {
      // What a facet does to Activity is decided upstream, by WHICH pages are
      // ranked; this pins that `buildRail` renders whatever it is handed under a
      // facet rather than hiding the section the way a query does.
      const rail = buildRail({
        filtered: [a, c],
        facetOnly: [a, c],
        filters: { ...INERT, type: "plan" },
        pins: [],
        activity: [row(a)],
      });
      expect(headers(rail.entries)).toEqual(["Activity", "Other pages"]);
      expect(rows(rail.entries).map((r) => [r.section, r.page.relPath])).toEqual([
        ["activity", "a.md"],
        ["all", "c.md"],
      ]);
      expect(rail.shown).toBe(2);
    });

    test("shown still counts distinct pages with Activity in the rail", () => {
      expect(build({ activity: [row(a)], pins: ["c.md"] }).shown).toBe(3);
    });

    test("a duplicate in the ranking renders once", () => {
      const rail = build({ activity: [row(a), row(a)] });
      expect(rows(rail.entries).filter((r) => r.page === a)).toHaveLength(1);
    });
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
        pins: ["b.md"],
      });
      expect(headers(rail.entries)).not.toContain("Pinned");
    });

    test("a key that resolves to nothing renders no header at all", () => {
      const rail = buildRail({
        filtered: [],
        facetOnly: corpus,
        filters: { ...INERT, q: "2026-09-01" },
        pins: [],
      });
      expect(rail.entries).toEqual([]);
    });

    test("the jump reads facetOnly, so it finds pages the query's substring search misses", () => {
      const rail = buildRail({
        filtered: substring,
        facetOnly: corpus,
        filters: { ...INERT, q: "MELOSYS-7588" },
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
        filters: { ...INERT, q: "V155-2026 MELOSYS-7588" }, pins: [],
      });
      const h = rail.entries.filter((e) => e.kind === "header");
      expect(h.map((e) => (e as { label: string }).label)).toEqual(["MELOSYS-7588 · issue page"]);
    });

    test("a date before the key does not suppress it", () => {
      const rail = buildRail({
        filtered: [], facetOnly: corpus,
        filters: { ...INERT, q: "2026-08-27 MELOSYS-7588" }, pins: [],
      });
      expect(rail.entries.filter((e) => e.kind === "row")).toHaveLength(1);
    });

    test("nothing resolves ⇒ no jump", () => {
      const rail = buildRail({
        filtered: [], facetOnly: corpus,
        filters: { ...INERT, q: "V155-2026 og AB-999" }, pins: [],
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
        filters: { ...INERT, q: "2026" }, pins: [],
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

    test("a pinned page is NOT also in the listing below", () => {
      const rail = buildRail({ filtered: all, facetOnly: all, filters: INERT, pins: ["a.md"] });
      const rows = rowsOf(rail);
      expect(rows.map((r) => r.page.relPath)).toEqual(["a.md", "b.md", "c.md"]);
      expect(rows.filter((r) => r.page.relPath === "a.md")).toHaveLength(1);
      expect(rows[0]!.section).toBe("pinned");
      expect(rows[1]!.section).toBe("all");
    });

    test("no relPath renders twice, in ANY arrangement", () => {
      const act = (rels: string[]) =>
        rels.map((rel) => ({
          page: all.find((p) => p.relPath === rel)!,
          kind: "new" as const,
          score: 1,
          why: "new — because",
          ageMs: 0,
        }));
      for (const activity of [[], ["a.md"], ["a.md", "c.md"], ["c.md", "b.md", "a.md"]]) {
        for (const pins of [[], ["b.md"], ["a.md", "b.md"]]) {
          const rail = buildRail({
            filtered: all,
            facetOnly: all,
            filters: INERT,
            pins,
            activity: act(activity),
          });
          const rels = rowsOf(rail).map((r) => r.page.relPath);
          expect(new Set(rels).size, `activity=${activity} pins=${pins}`).toBe(rels.length);
          expect(rels.length).toBe(all.length);
        }
      }
    });

    test("the count still equals the rows on screen", () => {
      const rail = buildRail({ filtered: all, facetOnly: all, filters: INERT, pins: ["b.md"] });
      expect(rail.shown).toBe(rowsOf(rail).length);
      expect(rail.shown).toBe(3);
    });

    test("the remainder header says what it is", () => {
      const rail = buildRail({ filtered: all, facetOnly: all, filters: INERT, pins: ["a.md"] });
      expect(rail.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label))
        .toEqual(["Pinned", "Other pages"]);
    });

    test("with everything pinned there is no remainder header", () => {
      const rail = buildRail({
        filtered: all, facetOnly: all, filters: INERT,
        pins: ["a.md", "b.md", "c.md"],
      });
      expect(rail.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label))
        .toEqual(["Pinned"]);
    });
  });

  // ── relPath resolution is normalized, like every other lookup ─────────
  test("a stored relPath resolves case- and separator-insensitively", () => {
    const p = P("Archive/Notes.md", "Notes");
    const rail = buildRail({
      filtered: [p], facetOnly: [p], filters: INERT,
      pins: ["archive/notes.md"],
    });
    const rows = rail.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;
    expect(rows[0]!.section).toBe("pinned");
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
      pins: ["archive/notes.md"],
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

  // The case above passes an already-normalized LIST, which is all the reader
  // ever produces — so it leaves the writer's own comparison equivalent under the
  // current call graph and unpinned as a contract. This one passes an
  // UNNORMALIZED list, which is what a key written by an older build is, and pins
  // the function rather than its one caller.
  test("togglePin is correct against a list that was never normalized", () => {
    expect(togglePin(["CONCEPTS/A.MD"], "concepts/a.md")).toEqual([]);
  });

  test("buildRail renders a page ONCE even if storage holds two spellings of it", () => {
    // The invariant is buildRail's own, so it must not depend on the storage
    // layer having been perfect — a key written by an older build still renders
    // one row.
    const p = page({ relPath: "concepts/a.md", title: "A" });
    const rail = buildRail({
      filtered: [p], facetOnly: [p], filters: INERT,
      pins: ["concepts/a.md", "CONCEPTS/A.MD"],
    });
    const rows = rail.entries.filter((e) => e.kind === "row");
    expect(rows).toHaveLength(1);
    expect(rail.shown).toBe(1);
  });

  test("…and a page Activity lifted cannot also render under Pinned", () => {
    const p = page({ relPath: "concepts/a.md", title: "A" });
    const rail = buildRail({
      filtered: [p], facetOnly: [p], filters: INERT,
      pins: ["CONCEPTS/A.MD"],
      activity: [{ page: p, kind: "new", score: 1, why: "new — because", ageMs: 0 }],
    });
    expect(rail.entries.filter((e) => e.kind === "row")).toHaveLength(1);
  });
});

/**
 * Attachments — the rail half of the store's pairing pass. The one-row invariant
 * is the thing under test, so the fixture puts a child in EVERY section at once
 * and the last case asserts the invariant over all of them together.
 */
describe("groups (attachments)", () => {
  // NB no `children` field: the wire carries the PARENT link only, and
  // `buildRail` rebuilds each group from the pages it was handed.
  const parent = page({ relPath: "plans/x.mdx", title: "X plan" });
  const stemChild = page({
    relPath: "plans/x.html",
    title: "X diagram",
    parent: "plans/x.mdx",
    pairedBy: "stem",
  });
  const protoChild = page({
    relPath: "plans/x-prototype.html",
    title: "X prototype",
    parent: "plans/x.mdx",
    pairedBy: "suffix",
  });
  const supersededChild = page({
    relPath: "plans/old.mdx",
    title: "Old plan",
    parent: "plans/x.mdx",
    pairedBy: "superseded",
  });
  const loner = page({ relPath: "plans/z.mdx", title: "Zeta" });
  const family = [parent, stemChild, protoChild, supersededChild, loner];
  const rowsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;
  const headersOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "header").map((e) => (e as { label: string }).label);
  const rail = (over: Partial<Parameters<typeof buildRail>[0]> = {}) =>
    buildRail({ filtered: family, facetOnly: family, filters: INERT, pins: [], ...over });

  test("closed by default: the children are not emitted and `shown` says so", () => {
    const m = rail();
    const rs = rowsOf(m);
    expect(rs.map((r) => r.page.relPath)).toEqual(["plans/x.mdx", "plans/z.mdx"]);
    expect(m.shown).toBe(2); // NOT 5 — a closed fold lowers the count
    const parentRow = rs[0]!;
    expect(parentRow.folded).toBe(true);
    expect(parentRow.children!.map((c) => c.relPath)).toEqual([
      "plans/x.html",
      "plans/x-prototype.html",
      "plans/old.mdx",
    ]);
    expect(foldChipLabel(parentRow.children!)).toBe("2 attached · 1 superseded");
  });

  test("open: the children render under the parent, in order, as child rows", () => {
    const m = rail({ openFolds: [normalizeFoldKey("plans/x.mdx")] });
    const rs = rowsOf(m);
    expect(rs.map((r) => r.page.relPath)).toEqual([
      "plans/x.mdx",
      "plans/x.html",
      "plans/x-prototype.html",
      "plans/old.mdx",
      "plans/z.mdx",
    ]);
    expect(rs[0]!.folded).toBe(false);
    expect(rs[1]!.child).toEqual({ parent, pairedBy: "stem" });
    expect(rs[3]!.child).toEqual({ parent, pairedBy: "superseded" });
    expect(rs[4]!.child).toBeUndefined();
    expect(m.shown).toBe(5);
  });

  test("the OPEN PAGE's group is expanded whatever the store holds — parent or child", () => {
    for (const openRelPath of ["plans/x.mdx", "PLANS/X.HTML"]) {
      const m = rail({ openRelPath });
      expect(rowsOf(m).map((r) => r.page.relPath), openRelPath).toContain("plans/x.html");
    }
    // …and a page in ANOTHER group leaves this one closed.
    expect(rowsOf(rail({ openRelPath: "plans/z.mdx" })).map((r) => r.page.relPath)).toEqual([
      "plans/x.mdx",
      "plans/z.mdx",
    ]);
  });

  test("a query FLATTENS: every page is a plain row, no chips, nothing hidden", () => {
    const m = rail({ filters: { ...INERT, q: "x" } });
    const rs = rowsOf(m);
    expect(rs.map((r) => r.page.relPath)).toEqual(family.map((p) => p.relPath));
    expect(rs.some((r) => r.children || r.child || r.folded !== undefined)).toBe(false);
    expect(m.shown).toBe(5);
  });

  test("Activity ranks PAGES: a lifted child leaves the chip's count and renders once", () => {
    const m = rail({
      activity: [{ page: stemChild, kind: "new", score: 1, why: "new — because", ageMs: 0 }],
    });
    const rs = rowsOf(m);
    expect(headersOf(m)).toEqual(["Activity", "Other pages"]);
    const lifted = rs.filter((r) => r.page.relPath === "plans/x.html");
    expect(lifted).toHaveLength(1);
    expect(lifted[0]!.section).toBe("activity");
    // It still says WHY it folds, and the parent's chip is one shorter.
    expect(lifted[0]!.child).toEqual({ parent, pairedBy: "stem" });
    const parentRow = rs.find((r) => r.page.relPath === "plans/x.mdx")!;
    expect(parentRow.children!.map((c) => c.relPath)).toEqual([
      "plans/x-prototype.html",
      "plans/old.mdx",
    ]);
    expect(foldChipLabel(parentRow.children!)).toBe("1 attached · 1 superseded");
  });

  test("Activity ranking the PARENT moves the whole open group with it", () => {
    const m = rail({
      openFolds: [normalizeFoldKey("plans/x.mdx")],
      activity: [{ page: parent, kind: "changed", score: 1, why: "changed — because", ageMs: 0 }],
    });
    const rs = rowsOf(m);
    expect(rs.map((r) => [r.section, r.page.relPath])).toEqual([
      ["activity", "plans/x.mdx"],
      ["activity", "plans/x.html"],
      ["activity", "plans/x-prototype.html"],
      ["activity", "plans/old.mdx"],
      ["all", "plans/z.mdx"],
    ]);
  });

  test("a parent and a child BOTH ranked by Activity still render one row each", () => {
    const m = rail({
      openFolds: [normalizeFoldKey("plans/x.mdx")],
      activity: [
        { page: parent, kind: "changed", score: 2, why: "changed — because", ageMs: 0 },
        { page: stemChild, kind: "new", score: 1, why: "new — because", ageMs: 0 },
      ],
    });
    const rs = rowsOf(m);
    expect(rs.filter((r) => r.page.relPath === "plans/x.html")).toHaveLength(1);
    expect(m.shown).toBe(5);
  });

  test("a pinned child is lifted into Pinned, once, and leaves the chip's count", () => {
    const m = rail({ pins: ["plans/old.mdx"] });
    const rs = rowsOf(m);
    expect(headersOf(m)).toEqual(["Pinned", "Other pages"]);
    expect(rs.filter((r) => r.page.relPath === "plans/old.mdx").map((r) => r.section)).toEqual([
      "pinned",
    ]);
    const parentRow = rs.find((r) => r.page.relPath === "plans/x.mdx")!;
    expect(foldChipLabel(parentRow.children!)).toBe("2 attached");
  });

  test("a child whose PARENT the facet filtered away is an ordinary row, never hidden", () => {
    const filtered = [stemChild, loner];
    const m = buildRail({ filtered, facetOnly: filtered, filters: INERT, pins: [] });
    const rs = rowsOf(m);
    expect(rs.map((r) => r.page.relPath)).toEqual(["plans/x.html", "plans/z.mdx"]);
    expect(rs[0]!.child).toBeUndefined();
    expect(m.shown).toBe(2);
  });

  test("the one-row invariant holds with children in EVERY section at once", () => {
    const logPage = page({ relPath: "log.md", title: "Log" });
    const filtered = [...family, logPage];
    const m = buildRail({
      filtered,
      facetOnly: filtered,
      filters: INERT,
      pins: ["plans/old.mdx"],
      metaTail: true,
      openFolds: [normalizeFoldKey("plans/x.mdx"), SECTION_META_FOLD_KEY],
      activity: [{ page: stemChild, kind: "new", score: 1, why: "new — because", ageMs: 0 }],
    });
    const rs = rowsOf(m);
    const seen = new Map<string, number>();
    for (const r of rs) seen.set(r.page.relPath, (seen.get(r.page.relPath) ?? 0) + 1);
    // Every page exactly once, `shown` equal to the row count, and every page of
    // the input on screen (nothing folded away here — all three folds are open).
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(m.shown).toBe(rs.length);
    expect(seen.size).toBe(filtered.length);
    // …and the sections are the ones each rule dictates.
    expect(rs.find((r) => r.page.relPath === "plans/x.html")!.section).toBe("activity");
    expect(rs.find((r) => r.page.relPath === "plans/old.mdx")!.section).toBe("pinned");
    expect(rs.find((r) => r.page.relPath === "plans/x-prototype.html")!.section).toBe("all");
    expect(rs.find((r) => r.page.relPath === "log.md")!.section).toBe("meta");
  });
});

describe("the fold store's rules", () => {
  test("keys are per wiki, beside the pins key", () => {
    expect(foldsKey("mimir")).toBe("muninn.wiki.folds.v1:mimir");
    expect(foldsKey("")).toBe("muninn.wiki.folds.v1:");
    expect(foldsKey("a")).not.toBe(foldsKey("b"));
  });
  test("everything not stored is CLOSED", () => {
    expect(isFoldOpen([], "plans/x.mdx")).toBe(false);
    expect(isFoldOpen(["plans/y.mdx"], "plans/x.mdx")).toBe(false);
    expect(isFoldOpen(["plans/x.mdx"], "plans/x.mdx")).toBe(true);
  });
  test("comparison is normalized on both sides, like the pins key", () => {
    expect(isFoldOpen(["PLANS\\X.MDX"], "plans/x.mdx")).toBe(true);
    expect(normalizeFoldKey(" PLANS/X.MDX ")).toBe("plans/x.mdx");
  });
  test("toggle is its own inverse and never duplicates an entry", () => {
    expect(toggleFold([], "plans/x.mdx")).toEqual(["plans/x.mdx"]);
    expect(toggleFold(["plans/x.mdx"], "PLANS/X.MDX")).toEqual([]);
    expect(toggleFold(["plans/x.mdx"], "")).toEqual(["plans/x.mdx"]);
  });
  test("the section sentinel shares the namespace and survives normalization", () => {
    expect(toggleFold([], SECTION_META_FOLD_KEY)).toEqual([SECTION_META_FOLD_KEY]);
    expect(isFoldOpen([SECTION_META_FOLD_KEY], SECTION_META_FOLD_KEY)).toBe(true);
  });
  test("chip copy: attached, superseded, and both", () => {
    const attach = (n: number) =>
      Array.from({ length: n }, (_, i) => page({ relPath: `c${i}.html`, pairedBy: "stem" }));
    expect(foldChipLabel(attach(3))).toBe("3 attached");
    expect(foldChipLabel([page({ relPath: "o.mdx", pairedBy: "superseded" })])).toBe(
      "1 superseded",
    );
    expect(foldChipLabel([...attach(1), page({ relPath: "o.mdx", pairedBy: "superseded" })])).toBe(
      "1 attached · 1 superseded",
    );
    expect(foldChipLabel([])).toBe("");
  });
  // The chip's two size classes are the label's WORDS and its DIGITS, judged
  // apart: the words decide when the full form yields to the compact one, the
  // digits decide how much of the row the compact form is guaranteed. Each
  // bucket is the set of labels one measured budget covers (`wiki-rail-width.ts`).
  test("label class: attached-only is the default, superseded-only and both each have their own", () => {
    expect(foldChipLabelClass({ attached: 1, superseded: 0 })).toBe("");
    expect(foldChipLabelClass({ attached: 99, superseded: 0 })).toBe("");
    expect(foldChipLabelClass({ attached: 0, superseded: 1 })).toBe("is-superseded-only");
    expect(foldChipLabelClass({ attached: 0, superseded: 99 })).toBe("is-superseded-only");
    expect(foldChipLabelClass({ attached: 1, superseded: 1 })).toBe("is-wide");
    expect(foldChipLabelClass({ attached: 0, superseded: 0 })).toBe("");
  });
  test("counts class: one count is narrow, two of up to two digits is the default, anything wider is wide", () => {
    expect(foldChipCountsClass("1")).toBe("counts-narrow");
    expect(foldChipCountsClass("999")).toBe("counts-narrow");
    expect(foldChipCountsClass("1 · 1")).toBe("");
    expect(foldChipCountsClass("99 · 99")).toBe("");
    expect(foldChipCountsClass("120 · 100")).toBe("counts-wide");
    expect(foldChipCountsClass("999 · 99")).toBe("counts-wide");
    // A family roll-up can carry three or four counts; they share the wide bucket.
    expect(foldChipCountsClass("3 · 3 · 3 · 3")).toBe("counts-wide");
    expect(foldChipCountsClass("")).toBe("");
  });
});

/**
 * Fix round 1 — what the first cut of the groups got wrong, all of it about the
 * ONE number the rail promises: the chip stands for the rows that are NOT on
 * screen, and every page it was handed is on screen exactly once.
 */
describe("groups — fix round 1", () => {
  const parent = page({ relPath: "plans/x.mdx", title: "X plan" });
  const child = page({
    relPath: "plans/x.html",
    title: "X diagram",
    parent: "plans/x.mdx",
    pairedBy: "stem",
  });
  const sibling = page({
    relPath: "plans/x-prototype.html",
    title: "X prototype",
    parent: "plans/x.mdx",
    pairedBy: "suffix",
  });
  const loner = page({ relPath: "plans/z.mdx", title: "Zeta" });
  const family = [parent, child, sibling, loner];
  const rowsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;
  const act = (p: WikiListing, score: number): ActivityRow => ({
    page: p,
    kind: "new",
    score,
    why: "new — because",
    ageMs: 0,
  });
  const rail = (over: Partial<Parameters<typeof buildRail>[0]> = {}) =>
    buildRail({ filtered: family, facetOnly: family, filters: INERT, pins: [], ...over });

  test("a child Activity ranks BELOW its parent is still out of the chip's count", () => {
    // Activity runs before Pinned and emits in rank order, so when the parent
    // comes first the child is not yet claimed — the chip counted a row the
    // very next iteration then drew.
    const m = rail({ activity: [act(parent, 2), act(child, 1)] });
    const rs = rowsOf(m);
    const parentRow = rs.find((r) => r.page.relPath === "plans/x.mdx")!;
    expect(parentRow.children?.map((c) => c.relPath)).toEqual(["plans/x-prototype.html"]);
    expect(foldChipLabel(parentRow.children ?? [])).toBe("1 attached");
    expect(rs.filter((r) => r.page.relPath === "plans/x.html")).toHaveLength(1);
    expect(m.shown).toBe(3); // parent, lifted child, loner — the sibling is folded
  });

  test("a PINNED child of an Activity-ranked parent is out of the count too", () => {
    const m = rail({ activity: [act(parent, 2)], pins: ["plans/x.html"] });
    const rs = rowsOf(m);
    const parentRow = rs.find((r) => r.page.relPath === "plans/x.mdx")!;
    expect(parentRow.children?.map((c) => c.relPath)).toEqual(["plans/x-prototype.html"]);
    expect(rs.find((r) => r.page.relPath === "plans/x.html")!.section).toBe("pinned");
  });

  test("a child with NO child of its own left keeps no chip at all", () => {
    const two = [parent, child, loner];
    const m = buildRail({
      filtered: two,
      facetOnly: two,
      filters: INERT,
      pins: [],
      activity: [act(parent, 2), act(child, 1)],
    });
    const parentRow = rowsOf(m).find((r) => r.page.relPath === "plans/x.mdx")!;
    expect(parentRow.children).toBeUndefined();
    expect(parentRow.folded).toBeUndefined();
  });

  test("Activity ranks PAGES: a ranked child is lifted even out of an OPEN group", () => {
    const m = rail({
      openFolds: [normalizeFoldKey("plans/x.mdx")],
      activity: [act(child, 2), act(parent, 1)],
    });
    const rs = rowsOf(m);
    const lifted = rs.filter((r) => r.page.relPath === "plans/x.html");
    expect(lifted).toHaveLength(1);
    // It carries its OWN derivation — the reason it was lifted — and says so.
    expect(lifted[0]!.activity?.why).toBe("new — because");
    expect(lifted[0]!.section).toBe("activity");
    // …and it is NOT drawn as an indented child of a row it does not sit under.
    expect(lifted[0]!.lifted).toBe(true);
    expect(lifted[0]!.child).toEqual({ parent, pairedBy: "stem" });
    // The sibling that Activity did not rank IS drawn inside the group.
    const inGroup = rs.find((r) => r.page.relPath === "plans/x-prototype.html")!;
    expect(inGroup.lifted).toBeUndefined();
    expect(m.shown).toBe(4);
  });

  test("a parent chain that cycles renders BOTH pages, never zero", () => {
    // `parent` is payload. One level deep is the store's invariant, not this
    // module's guarantee, and a group whose parent is itself a child renders
    // nowhere at all: two rows silently vanished from the rail.
    const a = page({ relPath: "a.md", parent: "b.md", pairedBy: "superseded" });
    const b = page({ relPath: "b.md", parent: "a.md", pairedBy: "superseded" });
    const m = buildRail({ filtered: [a, b], facetOnly: [a, b], filters: INERT, pins: [] });
    const rs = rowsOf(m);
    expect(rs.map((r) => r.page.relPath).sort()).toEqual(["a.md", "b.md"]);
    expect(m.shown).toBe(2);
    // Neither is drawn as anyone's child — the group it named is not on screen.
    expect(rs.every((r) => !r.child && !r.children)).toBe(true);
  });

  test("Bookkeeping's header count is exactly what opening it reveals", () => {
    const log = page({ relPath: "log.md", title: "Log" });
    const idx = page({ relPath: "plans/index.md", title: "Index" });
    const pages = [loner, log, idx];
    const opts = { filtered: pages, facetOnly: pages, filters: INERT, pins: [], metaTail: true };
    const closed = buildRail(opts);
    const header = closed.entries.find((e) => e.kind === "header" && e.section === "meta")!;
    const opened = buildRail({ ...opts, openFolds: [SECTION_META_FOLD_KEY] });
    const revealed = rowsOf(opened).filter((r) => r.section === "meta");
    expect(revealed).toHaveLength((header as { count?: number }).count!);
    expect(opened.shown - closed.shown).toBe((header as { count?: number }).count!);
  });

  test("a group forced open by the OPEN PAGE says so, so the chip can stop toggling", () => {
    // `isOpen` is `forced || stored`, so a click on this chip flips a stored key
    // with no visible effect — a dead control the reader can only read as broken.
    const m = rail({ openRelPath: "plans/x.html" });
    const parentRow = rowsOf(m).find((r) => r.page.relPath === "plans/x.mdx")!;
    expect(parentRow.folded).toBe(false);
    expect(parentRow.forcedOpen).toBe(true);
    // A group the STORE opened is an ordinary toggle.
    const stored = rail({ openFolds: [normalizeFoldKey("plans/x.mdx")] });
    expect(rowsOf(stored).find((r) => r.page.relPath === "plans/x.mdx")!.forcedOpen).toBeUndefined();
  });

  test("Bookkeeping forced open by the open page says so too", () => {
    const log = page({ relPath: "log.md", title: "Log" });
    const pages = [loner, log];
    const m = buildRail({
      filtered: pages,
      facetOnly: pages,
      filters: INERT,
      pins: [],
      metaTail: true,
      openRelPath: "log.md",
    });
    const header = m.entries.find((e) => e.kind === "header" && e.section === "meta")!;
    expect(header).toMatchObject({ folded: false, forcedOpen: true });
  });
});

describe("pairedByWhy", () => {
  // Every branch, because the sentence is the rail's ONLY statement of a relation
  // two of the four rules leave invisible in the file names.
  test("names the rule and the parent", () => {
    expect(pairedByWhy("stem", "X plan")).toBe('Attached under "X plan" — same name, same folder');
    expect(pairedByWhy("suffix", "X plan")).toBe('Attached under "X plan" — a prototype of it');
    expect(pairedByWhy("link", "X plan")).toBe('Attached under "X plan" — embedded in the page');
  });
  test("superseded reads from the CHILD's side — it is not an attachment", () => {
    expect(pairedByWhy("superseded", "X plan")).toBe('Superseded by "X plan"');
  });
  test("an unknown or absent rule still names the parent", () => {
    expect(pairedByWhy("", "X plan")).toBe('Attached under "X plan"');
    expect(pairedByWhy("future-rule", "X plan")).toBe('Attached under "X plan"');
  });
});

/**
 * Fix round 3 — the chip's COMPACT form, and the one arrangement that pins
 * `mine`'s `!claimed` filter.
 *
 * The filter had no case of its own across the whole suite (dropping it left
 * 1544 unit tests and 44 e2e specs green), and `!lifted` beside it covers every
 * arrangement Activity and Pinned can produce. Enumerating what else can put a
 * child in `claimed`: the Jira jump claims rows, but it needs a query and a
 * query turns grouping off, so `childrenOf` is empty there; `remainder` and the
 * `Bookkeeping` tail are both filtered on `!parentOf.has(...)`, so no child ever
 * reaches them; `resolve` writes to a COPY of `claimed`, not to it. That leaves
 * exactly one: a parent emitted TWICE, which claims its children on the first
 * pass. A listing carrying one page twice is not hypothetical here — this module
 * dedupes the activity rows and the pin list against precisely that, on the
 * stated ground that the one-row invariant "must not depend on the caller's
 * input being duplicate-free".
 */
describe("groups — fix round 3", () => {
  const parent = page({ relPath: "plans/x.mdx", title: "X plan" });
  const child = page({
    relPath: "plans/x.html",
    title: "X diagram",
    parent: "plans/x.mdx",
    pairedBy: "stem",
  });
  const rowsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;

  test("a listing carrying the parent TWICE renders its child once, under the first", () => {
    // OPEN, because that is what makes the first row CLAIM the child — a closed
    // group emits no child rows and claims nothing.
    const filtered = [parent, child, parent];
    const m = buildRail({
      filtered,
      facetOnly: filtered,
      filters: INERT,
      pins: [],
      openFolds: [normalizeFoldKey("plans/x.mdx")],
    });
    const rs = rowsOf(m);
    expect(rs.map((r) => r.page.relPath)).toEqual([
      "plans/x.mdx",
      "plans/x.html",
      "plans/x.mdx",
    ]);
    // The second parent row stands for nothing: its child is already on screen.
    expect(rs[0]!.children!.map((c) => c.relPath)).toEqual(["plans/x.html"]);
    expect(rs[2]!.children).toBeUndefined();
  });

  test("compact chip copy: the counts alone, in the full label's order", () => {
    const attach = (n: number) =>
      Array.from({ length: n }, (_, i) => page({ relPath: `c${i}.html`, pairedBy: "stem" }));
    const retired = (n: number) =>
      Array.from({ length: n }, (_, i) => page({ relPath: `o${i}.mdx`, pairedBy: "superseded" }));
    expect(foldChipCompactLabel(attach(3))).toBe("3");
    expect(foldChipCompactLabel(retired(1))).toBe("1");
    expect(foldChipCompactLabel([...attach(10), ...retired(10)])).toBe("10 · 10");
    expect(foldChipCompactLabel([])).toBe("");
    // Same split, same order, same separator as the words it replaces.
    expect(foldChipLabel([...attach(10), ...retired(10)])).toBe("10 attached · 10 superseded");
  });

  test("foldChipKinds counts anything that is not `superseded` as attached", () => {
    expect(
      foldChipKinds([
        page({ relPath: "a.html", pairedBy: "stem" }),
        page({ relPath: "b.html", pairedBy: "suffix" }),
        page({ relPath: "c.html", pairedBy: "link" }),
        page({ relPath: "d.html", pairedBy: "future-rule" }),
        page({ relPath: "e.mdx", pairedBy: "superseded" }),
      ]),
    ).toEqual({ attached: 4, superseded: 1 });
  });
});

/**
 * FAMILIES and MONTHS in the rail (PR 2). The grouping rule itself is
 * `wiki-groups.test.ts`; these are the arrangement rules — which rows the group
 * stands for, what a lift takes out of it, and the one-row invariant with a
 * second layer of folds on top of the first.
 */
describe("groups (families and months)", () => {
  const rowsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;
  const groupsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "group") as Array<Extract<RailEntry, { kind: "group" }>>;

  const members = [1, 2, 3].map((i) =>
    page({ relPath: `plans/fam-one-${i}.mdx`, title: `Fam ${i}`, plan_status: "shipped" }),
  );
  const retired = page({
    relPath: "plans/fam-one-old.mdx",
    title: "Retired",
    plan_status: "superseded",
    parent: "plans/fam-one-1.mdx",
    pairedBy: "superseded",
  });
  const loner = page({ relPath: "plans/zeta.mdx", title: "Zeta" });
  const listing = [...members, retired, loner];
  const family = railGroups(listing, { folder: "", sort: "updated", projects: {} });
  const famKey = normalizeFoldKey(family[0]!.key);

  const rail = (over: Partial<Parameters<typeof buildRail>[0]> = {}) =>
    buildRail({
      filtered: listing,
      facetOnly: listing,
      filters: INERT,
      pins: [],
      groups: family,
      ...over,
    });

  test("the grouping the rail is handed is the family the rule found", () => {
    expect(family).toHaveLength(1);
    expect(family[0]!.label).toBe("fam-one-*");
    expect(family[0]!.members).toHaveLength(3);
    expect(family[0]!.supersededChildren.map((c) => c.relPath)).toEqual(["plans/fam-one-old.mdx"]);
  });

  test("closed by default: no member is a row, and `shown` says so", () => {
    const m = rail();
    expect(rowsOf(m).map((r) => r.page.relPath)).toEqual(["plans/zeta.mdx"]);
    expect(m.shown).toBe(1); // NOT 5 — the group row is not a page
    const g = groupsOf(m)[0]!;
    expect(g.folded).toBe(true);
    expect(g.members.map((p) => p.relPath)).toEqual(members.map((p) => p.relPath));
    expect(groupRollup("family", g.members, g.superseded).label).toBe("3 shipped · 1 superseded");
  });

  test("open: the members render under it as member rows, in the sort's order", () => {
    const m = rail({ openFolds: [famKey] });
    expect(rowsOf(m).map((r) => r.page.relPath)).toEqual([
      "plans/fam-one-1.mdx",
      "plans/fam-one-2.mdx",
      "plans/fam-one-3.mdx",
      "plans/zeta.mdx",
    ]);
    expect(groupsOf(m)[0]!.folded).toBe(false);
    expect(rowsOf(m)[0]!.member).toEqual({ label: "fam-one-*", kind: "family" });
    expect(rowsOf(m)[3]!.member).toBeUndefined();
    expect(m.shown).toBe(4);
  });

  test("a member's own attachment group opens INSIDE the family, one level in", () => {
    const m = rail({ openFolds: [famKey, normalizeFoldKey("plans/fam-one-1.mdx")] });
    const rs = rowsOf(m);
    const child = rs.find((r) => r.page.relPath === "plans/fam-one-old.mdx")!;
    // It is a CHILD of its own parent AND a member of the family, which is what
    // the painter indents one level further than either alone.
    expect(child.child!.pairedBy).toBe("superseded");
    expect(child.member).toEqual({ label: "fam-one-*", kind: "family" });
    expect(rs.map((r) => r.page.relPath)).toEqual([
      "plans/fam-one-1.mdx",
      "plans/fam-one-old.mdx",
      "plans/fam-one-2.mdx",
      "plans/fam-one-3.mdx",
      "plans/zeta.mdx",
    ]);
  });

  test("a member Activity ranked leaves the family, and the roll-up drops it", () => {
    const m = rail({
      activity: [{ page: members[0]!, kind: "changed", score: 1, why: "changed — because", ageMs: 0 }],
    });
    const lifted = rowsOf(m).filter((r) => r.page.relPath === "plans/fam-one-1.mdx");
    expect(lifted).toHaveLength(1);
    expect(lifted[0]!.section).toBe("activity");
    // It is not in the family's body, so it carries no member marker there…
    expect(lifted[0]!.member).toBeUndefined();
    const g = groupsOf(m)[0]!;
    expect(g.members.map((p) => p.relPath)).toEqual(["plans/fam-one-2.mdx", "plans/fam-one-3.mdx"]);
    // …and the retired page goes WITH it: its successor is the lifted member, so
    // the reader is looking at that whole strand one section up.
    expect(groupRollup("family", g.members, g.superseded).label).toBe("2 shipped");
  });

  test("a PINNED member leaves it the same way", () => {
    const m = rail({ pins: ["plans/fam-one-2.mdx"] });
    expect(
      rowsOf(m).filter((r) => r.page.relPath === "plans/fam-one-2.mdx").map((r) => r.section),
    ).toEqual(["pinned"]);
    expect(groupsOf(m)[0]!.members).toHaveLength(2);
  });

  test("a family whose every member was lifted emits no group row at all", () => {
    const m = rail({
      activity: members.map((p, i) => ({
        page: p,
        kind: "new" as const,
        score: 3 - i,
        why: "new — because",
        ageMs: 0,
      })),
    });
    expect(groupsOf(m)).toHaveLength(0);
    expect(m.shown).toBe(4);
  });

  test("the OPEN page's family is expanded, whatever the store holds", () => {
    const m = rail({ openRelPath: "plans/fam-one-3.mdx" });
    expect(rowsOf(m).map((r) => r.page.relPath)).toContain("plans/fam-one-3.mdx");
    expect(groupsOf(m)[0]!.forcedOpen).toBe(true);
    expect(groupsOf(m)[0]!.folded).toBe(false);
  });

  test("…including when the reader is on an ATTACHMENT of a member", () => {
    const m = rail({ openRelPath: "plans/fam-one-old.mdx" });
    const rs = rowsOf(m).map((r) => r.page.relPath);
    // The family opened, and so did the member's own group inside it.
    expect(rs).toContain("plans/fam-one-1.mdx");
    expect(rs).toContain("plans/fam-one-old.mdx");
  });

  test("a query flattens the groups exactly as it flattens attachments", () => {
    const m = rail({ filters: { ...INERT, q: "fam" } });
    expect(groupsOf(m)).toHaveLength(0);
    expect(rowsOf(m).some((r) => r.member)).toBe(false);
    expect(m.shown).toBe(listing.length);
  });

  test("the one-row invariant holds with a family, an attachment and every section at once", () => {
    const logPage = page({ relPath: "log.md", title: "Log" });
    const filtered = [...listing, logPage];
    const m = buildRail({
      filtered,
      facetOnly: filtered,
      filters: INERT,
      pins: ["plans/fam-one-2.mdx"],
      metaTail: true,
      groups: railGroups(filtered, { folder: "", sort: "updated", projects: {} }),
      openFolds: [famKey, normalizeFoldKey("plans/fam-one-1.mdx"), SECTION_META_FOLD_KEY],
      activity: [{ page: members[0]!, kind: "new", score: 1, why: "new — because", ageMs: 0 }],
    });
    const rs = rowsOf(m);
    const seen = new Map<string, number>();
    for (const r of rs) seen.set(r.page.relPath, (seen.get(r.page.relPath) ?? 0) + 1);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(m.shown).toBe(rs.length);
    expect(seen.size).toBe(filtered.length);
    // The lifted parent took its open attachment group with it, out of the family.
    expect(rs.find((r) => r.page.relPath === "plans/fam-one-1.mdx")!.section).toBe("activity");
    expect(rs.find((r) => r.page.relPath === "plans/fam-one-old.mdx")!.section).toBe("activity");
    expect(rs.find((r) => r.page.relPath === "plans/fam-one-2.mdx")!.section).toBe("pinned");
    expect(rs.find((r) => r.page.relPath === "log.md")!.section).toBe("meta");
    // …and the family still stands for the one member nothing lifted.
    expect(groupsOf(m)[0]!.members.map((p) => p.relPath)).toEqual(["plans/fam-one-3.mdx"]);
  });

  test("a group takes the position of its first remaining member in the sort", () => {
    const first = page({ relPath: "plans/aaa.mdx", title: "Aaa" });
    const filtered = [first, ...members, retired, loner];
    const m = buildRail({
      filtered,
      facetOnly: filtered,
      filters: INERT,
      pins: [],
      groups: railGroups(filtered, { folder: "", sort: "updated", projects: {} }),
    });
    const order = m.entries
      .filter((e) => e.kind !== "header")
      .map((e) => (e.kind === "group" ? e.group.label : e.page.relPath));
    expect(order).toEqual(["plans/aaa.mdx", "fam-one-*", "plans/zeta.mdx"]);
  });

  test("months: the newest is open by default, and its stored key CLOSES it", () => {
    const pages = [
      page({ relPath: "archive/2026-09-02-topic.mdx", title: "Newer" }),
      page({ relPath: "archive/2026-08-30-topic.mdx", title: "Older" }),
    ];
    const months = railGroups(pages, { folder: "archive", sort: "updated", projects: {} });
    const open = buildRail({
      filtered: pages,
      facetOnly: pages,
      filters: { ...INERT, folder: "archive" },
      pins: [],
      groups: months,
    });
    expect(groupsOf(open).map((g) => [g.group.label, g.folded])).toEqual([
      ["2026-09", false],
      ["2026-08", true],
    ]);
    expect(rowsOf(open).map((r) => r.page.relPath)).toEqual(["archive/2026-09-02-topic.mdx"]);

    // The row that defaults open offers the `closed:` spelling, and every other
    // row its own key — each spelling meaning ONE thing, forever.
    expect(groupsOf(open).map((g) => g.toggleKey)).toEqual(["closed:month:2026-09", "month:2026-08"]);

    const flipped = buildRail({
      filtered: pages,
      facetOnly: pages,
      filters: { ...INERT, folder: "archive" },
      pins: [],
      groups: months,
      openFolds: ["closed:month:2026-09", "month:2026-08"],
    });
    expect(groupsOf(flipped).map((g) => [g.group.label, g.folded])).toEqual([
      ["2026-09", true],
      ["2026-08", false],
    ]);
    expect(rowsOf(flipped).map((r) => r.page.relPath)).toEqual(["archive/2026-08-30-topic.mdx"]);
  });

  test("no `groups` at all is the toggle OFF: today's flat rail, unchanged", () => {
    const m = buildRail({ filtered: listing, facetOnly: listing, filters: INERT, pins: [] });
    expect(groupsOf(m)).toHaveLength(0);
    // The attachment group is still folded — layer 1 does not depend on layer 2.
    expect(rowsOf(m).map((r) => r.page.relPath)).toEqual([
      "plans/fam-one-1.mdx",
      "plans/fam-one-2.mdx",
      "plans/fam-one-3.mdx",
      "plans/zeta.mdx",
    ]);
  });
});

describe("groups (families and months) — fix round 1", () => {
  const rowsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;
  const groupsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "group") as Array<Extract<RailEntry, { kind: "group" }>>;
  const rollupOf = (m: ReturnType<typeof buildRail>, i = 0): string => {
    const g = groupsOf(m)[i]!;
    return groupRollup(g.group.kind, g.members, g.superseded).label;
  };

  const shipped = [1, 2, 3].map((i) =>
    page({ relPath: `plans/fam-one-${i}.mdx`, title: `Fam ${i}`, plan_status: "shipped" }),
  );
  const retired = page({
    relPath: "plans/fam-one-old.mdx",
    title: "Retired",
    plan_status: "superseded",
    parent: "plans/fam-one-1.mdx",
    pairedBy: "superseded",
  });
  const famKey = "family:plans/fam-one";

  const railOf = (
    filtered: WikiListing[],
    over: Partial<Parameters<typeof buildRail>[0]> = {},
  ) =>
    buildRail({
      filtered,
      facetOnly: filtered,
      filters: INERT,
      pins: [],
      groups: railGroups(filtered, { folder: "", sort: "updated", projects: {} }),
      ...over,
    });

  describe("the roll-up is a census, computed from the LIFT and not from `claimed`", () => {
    test("a superseded child rendered inside the family body still counts", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing, { openFolds: [famKey, "plans/fam-one-1.mdx"] });
      // The child really is on screen, under its successor, one indent further.
      expect(rowsOf(m).map((r) => r.page.relPath)).toContain("plans/fam-one-old.mdx");
      expect(rollupOf(m)).toBe("3 shipped · 1 superseded");
    });

    test("the census does not depend on where the sort put a child's successor", () => {
      // A retired page NAMED for the family, superseded by the loner. Read off
      // `claimed`, the answer moved with the SORT: with the loner above the
      // family and its attachment fold open, the child was already claimed when
      // the census was taken and the slate read `3 shipped`; with the loner
      // below, the same slate read `3 shipped · 1 superseded`. One slate, one
      // number — and after the successor rule it is the loner's strand anyway.
      const loner = page({ relPath: "plans/zeta.mdx", title: "Zeta" });
      const stray = page({
        relPath: "plans/fam-one-retired.mdx",
        title: "Stray",
        plan_status: "superseded",
        parent: "plans/zeta.mdx",
        pairedBy: "superseded",
      });
      const folds = [famKey, "plans/zeta.mdx"];
      const above = rollupOf(railOf([loner, stray, ...shipped], { openFolds: folds }));
      const below = rollupOf(railOf([...shipped, loner, stray], { openFolds: folds }));
      expect(above).toBe(below);
      expect(above).toBe("3 shipped");
    });

    test("a child the reader PINNED leaves the census", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing, { pins: ["plans/fam-one-old.mdx"] });
      expect(
        rowsOf(m).filter((r) => r.page.relPath === "plans/fam-one-old.mdx").map((r) => r.section),
      ).toEqual(["pinned"]);
      expect(rollupOf(m)).toBe("3 shipped");
    });

    test("a child whose SUCCESSOR was pinned leaves it too", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing, { pins: ["plans/fam-one-1.mdx"] });
      expect(rollupOf(m)).toBe("2 shipped");
    });

    test("a child whose successor is outside the family never reaches the census", () => {
      const loner = page({ relPath: "plans/zeta.mdx", title: "Zeta" });
      const strayChild = page({
        relPath: "plans/fam-one-retired.mdx",
        title: "Stray",
        plan_status: "superseded",
        parent: "plans/zeta.mdx",
        pairedBy: "superseded",
      });
      const listing = [...shipped, loner, strayChild];
      const m = railOf(listing, { openFolds: [famKey] });
      expect(rollupOf(m)).toBe("3 shipped");
      // It renders under the loner, which is where it belongs.
      const row = rowsOf(m).find((r) => r.page.relPath === "plans/fam-one-retired.mdx");
      expect(row?.member).toBeUndefined();
    });
  });

  describe("forced open only while the open page is still a member this render draws", () => {
    test("the open page in the family body forces it open with a dead control", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing, { openRelPath: "plans/fam-one-3.mdx" });
      expect(groupsOf(m)[0]!.forcedOpen).toBe(true);
      expect(groupsOf(m)[0]!.folded).toBe(false);
    });

    test("the open page LIFTED into Activity leaves the family on its stored state", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing, {
        openRelPath: "plans/fam-one-3.mdx",
        activity: [
          { page: shipped[2]!, kind: "changed", score: 1, why: "changed — because", ageMs: 0 },
        ],
      });
      // The reader can see the page: it is a row in Activity.
      expect(
        rowsOf(m).filter((r) => r.page.relPath === "plans/fam-one-3.mdx").map((r) => r.section),
      ).toEqual(["activity"]);
      const g = groupsOf(m)[0]!;
      expect(g.forcedOpen).toBeUndefined();
      expect(g.folded).toBe(true);
    });

    test("…and PINNED is the same", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing, {
        openRelPath: "plans/fam-one-3.mdx",
        pins: ["plans/fam-one-3.mdx"],
      });
      const g = groupsOf(m)[0]!;
      expect(g.forcedOpen).toBeUndefined();
      expect(g.folded).toBe(true);
    });

    test("a lifted open page whose stored key says OPEN still renders open, undisabled", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing, {
        openRelPath: "plans/fam-one-3.mdx",
        openFolds: [famKey],
        pins: ["plans/fam-one-3.mdx"],
      });
      const g = groupsOf(m)[0]!;
      expect(g.folded).toBe(false);
      expect(g.forcedOpen).toBeUndefined();
    });
  });

  describe("the default-open month is chosen among the groups that RENDER", () => {
    const dated = (day: string) =>
      page({ relPath: `archive/${day}-topic.mdx`, title: `Page ${day}` });
    const sept = [dated("2026-09-11"), dated("2026-09-02")];
    const aug = [dated("2026-08-28"), dated("2026-08-04")];
    const archive = (pages: WikiListing[], over: Partial<Parameters<typeof buildRail>[0]> = {}) =>
      buildRail({
        filtered: pages,
        facetOnly: pages,
        filters: { ...INERT, folder: "archive" },
        pins: [],
        groups: railGroups(pages, { folder: "archive", sort: "updated", projects: {} }),
        ...over,
      });

    test("with the newest month FULLY LIFTED, the next month is the one that opens", () => {
      const pages = [...sept, ...aug];
      const m = archive(pages, {
        activity: sept.map((p, i) => ({
          page: p,
          kind: "changed" as const,
          score: 2 - i,
          why: "changed — because",
          ageMs: 0,
        })),
      });
      // September has no group row left at all — every page of it is in Activity.
      expect(groupsOf(m).map((g) => [g.group.label, g.folded])).toEqual([["2026-08", false]]);
      expect(rowsOf(m).filter((r) => r.section === "all").map((r) => r.page.relPath)).toEqual([
        "archive/2026-08-28-topic.mdx",
        "archive/2026-08-04-topic.mdx",
      ]);
    });

    test("a reader's close SURVIVES a newer month arriving", () => {
      const stored = ["closed:month:2026-09"];
      const before = archive([...sept, ...aug], { openFolds: stored });
      expect(groupsOf(before).map((g) => [g.group.label, g.folded])).toEqual([
        ["2026-09", true],
        ["2026-08", true],
      ]);
      // October lands. The stored key still means CLOSED — it cannot mean
      // anything else — and September does not silently spring open.
      const after = archive([dated("2026-10-01"), ...sept, ...aug], { openFolds: stored });
      expect(groupsOf(after).map((g) => [g.group.label, g.folded])).toEqual([
        ["2026-10", false],
        ["2026-09", true],
        ["2026-08", true],
      ]);
    });

    test("a facet that removes the newest month does not flip a stored key", () => {
      // The reader closed August back when it was the newest thing rendering.
      const stored = ["closed:month:2026-08"];
      const withSept = archive([...sept, ...aug], { openFolds: stored });
      expect(groupsOf(withSept).map((g) => [g.group.label, g.folded])).toEqual([
        ["2026-09", false],
        ["2026-08", true],
      ]);
      // A facet narrows the listing to August alone: it is now the default-open
      // month, and the stored key still says the reader closed it.
      const augOnly = archive(aug, { openFolds: stored });
      expect(groupsOf(augOnly).map((g) => [g.group.label, g.folded])).toEqual([["2026-08", true]]);
    });

    test("a plain month key always means OPEN, wherever the default sits", () => {
      const m = archive([...sept, ...aug], { openFolds: ["month:2026-08"] });
      expect(groupsOf(m).map((g) => [g.group.label, g.folded])).toEqual([
        ["2026-09", false],
        ["2026-08", false],
      ]);
    });

    test("the most recently clicked spelling wins when a group has collected both", () => {
      // `toggleFold` prepends, so the head of the list is the reader's last act.
      const augFirst = archive(aug, { openFolds: ["month:2026-08", "closed:month:2026-08"] });
      expect(groupsOf(augFirst)[0]!.folded).toBe(false);
      const closedFirst = archive(aug, { openFolds: ["closed:month:2026-08", "month:2026-08"] });
      expect(groupsOf(closedFirst)[0]!.folded).toBe(true);
    });

    test("a FAMILY never defaults open, and never offers the closed spelling", () => {
      const listing = [...shipped, retired];
      const m = railOf(listing);
      expect(groupsOf(m)[0]!.folded).toBe(true);
      expect(groupsOf(m)[0]!.toggleKey).toBe(famKey);
    });
  });

  describe("the fold store's two group spellings round-trip", () => {
    test("`closed:` survives the store's normalization untouched", () => {
      // Not a red→green case: it pins the property the new key space RESTS on —
      // `normalizeRel` lower-cases and swaps separators, and the prefix has
      // neither, so the key that goes in is the key that comes back.
      const key = "closed:month:2026-09";
      expect(normalizeFoldKey(key)).toBe(key);
      expect(parseRelPathList(serializeRelPathList([key, famKey]), FOLDS_MAX)).toEqual([
        key,
        famKey,
      ]);
    });

    test("toggling the closed spelling is its own inverse", () => {
      const key = "closed:month:2026-09";
      const on = toggleFold([], key);
      expect(on).toEqual([key]);
      expect(toggleFold(on, key)).toEqual([]);
    });
  });

  describe("the `toggle:` sentinel is a MODE, not one of the capped exceptions", () => {
    test("it survives more fold opens than the cap holds", () => {
      let folds = toggleFold([], GROUP_FAMILIES_TOGGLE_KEY);
      for (let i = 0; i < FOLDS_MAX + 5; i++) folds = toggleFold(folds, `plans/p-${i}.mdx`);
      expect(isFoldOpen(folds, GROUP_FAMILIES_TOGGLE_KEY)).toBe(true);
      // …and the fold keys themselves are still capped.
      expect(folds.filter((k) => !k.startsWith("toggle:"))).toHaveLength(FOLDS_MAX);
    });

    test("…and it survives the READ cap too, which is what a boot applies", () => {
      let folds = toggleFold([], GROUP_FAMILIES_TOGGLE_KEY);
      for (let i = 0; i < FOLDS_MAX + 5; i++) folds = toggleFold(folds, `plans/p-${i}.mdx`);
      const reread = parseRelPathList(serializeRelPathList(folds), FOLDS_MAX);
      expect(isFoldOpen(reread, GROUP_FAMILIES_TOGGLE_KEY)).toBe(true);
    });

    test("turning the mode off still removes it", () => {
      const on = toggleFold(["plans/p-1.mdx"], GROUP_FAMILIES_TOGGLE_KEY);
      expect(isFoldOpen(on, GROUP_FAMILIES_TOGGLE_KEY)).toBe(true);
      const off = toggleFold(on, GROUP_FAMILIES_TOGGLE_KEY);
      expect(isFoldOpen(off, GROUP_FAMILIES_TOGGLE_KEY)).toBe(false);
      expect(off).toEqual(["plans/p-1.mdx"]);
    });
  });
});

describe("groups (families and months) — fix round 2", () => {
  const rowsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "row") as Array<Extract<RailEntry, { kind: "row" }>>;
  const groupsOf = (m: ReturnType<typeof buildRail>) =>
    m.entries.filter((e) => e.kind === "group") as Array<Extract<RailEntry, { kind: "group" }>>;

  describe("a group toggle flips the RENDERED state, whichever spellings the store holds", () => {
    const dated = (day: string) =>
      page({ relPath: `archive/${day}-topic.mdx`, title: `Page ${day}` });
    const aug = dated("2026-08-28");
    const sept = dated("2026-09-11");
    /** August alone is the newest month that renders, so it DEFAULTS OPEN. */
    const alone = [aug];
    /** With September on screen August is an ordinary row, defaulting closed. */
    const withSept = [sept, aug];

    const archiveRail = (pages: WikiListing[], openFolds: string[]) =>
      buildRail({
        filtered: pages,
        facetOnly: pages,
        filters: { ...INERT, folder: "archive" },
        pins: [],
        groups: railGroups(pages, { folder: "archive", sort: "updated", projects: {} }),
        openFolds,
      });
    const augRow = (pages: WikiListing[], store: string[]) =>
      groupsOf(archiveRail(pages, store)).find((g) => g.group.label === "2026-08")!;

    // The store is built by `toggleFold` calls ALONE — never hand-written — because
    // what the bug turns on is exactly what a sequence of clicks leaves behind.
    const clicker = () => {
      let store: string[] = [];
      return {
        click: (pages: WikiListing[]): void => {
          store = toggleFold(store, augRow(pages, store).toggleKey);
        },
        folded: (pages: WikiListing[]): boolean | undefined => augRow(pages, store).folded,
        store: () => store,
      };
    };

    test("closed first, as the default-open row: every later click still moves it", () => {
      const s = clicker();
      expect(s.folded(alone)).toBe(false);
      s.click(alone);
      expect(s.folded(alone)).toBe(true);

      // September arrives: same stored state, read through the plain spelling.
      expect(s.folded(withSept)).toBe(true);
      s.click(withSept);
      expect(s.folded(withSept)).toBe(false);

      // September filtered away: August is the default-open row again, and its
      // chip offers `closed:` once more. This is the click that did nothing.
      expect(s.folded(alone)).toBe(false);
      s.click(alone);
      expect(s.folded(alone)).toBe(true);
    });

    test("opened first, as an ordinary row: the mirror sequence moves on every click too", () => {
      const s = clicker();
      expect(s.folded(withSept)).toBe(true);
      s.click(withSept);
      expect(s.folded(withSept)).toBe(false);

      expect(s.folded(alone)).toBe(false);
      s.click(alone);
      expect(s.folded(alone)).toBe(true);

      // Back to an ordinary row, carrying a `closed:` key its chip cannot write.
      expect(s.folded(withSept)).toBe(true);
      s.click(withSept);
      expect(s.folded(withSept)).toBe(false);
    });

    test("a click leaves ONE spelling of the group's key, never both", () => {
      const s = clicker();
      s.click(alone); // writes `closed:month:2026-08`
      expect(s.store()).toEqual(["closed:month:2026-08"]);
      s.click(withSept); // the plain spelling replaces it
      expect(s.store()).toEqual(["month:2026-08"]);
      s.click(alone); // …and back, still one entry
      expect(s.store()).toEqual(["closed:month:2026-08"]);
    });
  });

  describe("a group is forced open only while NEITHER the open page nor its holder is lifted", () => {
    const shipped = [1, 2, 3].map((i) =>
      page({ relPath: `plans/fam-two-${i}.mdx`, title: `Fam ${i}`, plan_status: "shipped" }),
    );
    const retired = page({
      relPath: "plans/fam-two-old.mdx",
      title: "Retired",
      plan_status: "superseded",
      parent: "plans/fam-two-1.mdx",
      pairedBy: "superseded",
    });
    const listing = [...shipped, retired];
    const railOf = (over: Partial<Parameters<typeof buildRail>[0]> = {}) =>
      buildRail({
        filtered: listing,
        facetOnly: listing,
        filters: INERT,
        pins: [],
        groups: railGroups(listing, { folder: "", sort: "updated", projects: {} }),
        ...over,
      });

    test("the open page is a PINNED superseded child: stored state, live chip", () => {
      const m = railOf({
        openRelPath: "plans/fam-two-old.mdx",
        pins: ["plans/fam-two-old.mdx"],
      });
      // The reader can see the page: it is a row in Pinned, one section up.
      expect(
        rowsOf(m)
          .filter((r) => r.page.relPath === "plans/fam-two-old.mdx")
          .map((r) => r.section),
      ).toEqual(["pinned"]);
      const g = groupsOf(m)[0]!;
      expect(g.forcedOpen).toBeUndefined();
      expect(g.folded).toBe(true);
    });

    test("…un-pinned, the same open child still forces its SUCCESSOR's family open", () => {
      const m = railOf({ openRelPath: "plans/fam-two-old.mdx" });
      const g = groupsOf(m)[0]!;
      expect(g.forcedOpen).toBe(true);
      expect(g.folded).toBe(false);
    });
  });
});
