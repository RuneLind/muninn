import { test, expect } from "bun:test";
import {
  connectionTypeOrder,
  filterPages,
  folderCounts,
  hasTypedHubs,
  hubTypeList,
  mergeWikiTypes,
  pageAddedLabel,
  pageAddedMs,
  pageDateLabel,
  pageFolder,
  pageTimeMs,
  ROOT_FOLDER,
  sanitizeColorToken,
  sortPages,
  tagCounts,
  topPages,
  typeCounts,
  TYPE_LABEL,
  TYPE_ORDER,
  type WikiFilters,
  type WikiListing,
} from "./wiki-filter.ts";

function page(over: Partial<WikiListing>): WikiListing {
  return {
    name: "p",
    title: "Title",
    type: "concept",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "p.md",
    linkCount: 0,
    backlinkCount: 0,
    ...over,
  };
}

const NO_FILTER: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "" };

const PAGES: WikiListing[] = [
  page({ name: "rag", title: "Retrieval Augmented Generation", type: "concept", domain: "ai", tags: ["search", "llm"], aliases: ["RAG"], backlinkCount: 5, created: "2026-01-01", updated: "2026-03-01" }),
  page({ name: "gym", title: "Gym routine", type: "note", domain: "life", tags: ["health"], backlinkCount: 1, created: "2026-02-01", updated: "2026-02-10" }),
  page({ name: "anthropic", title: "Anthropic", type: "entity", domain: "ai", tags: ["llm", "org"], backlinkCount: 9, created: "2026-01-15" }),
];

test("filterPages: empty filters returns all", () => {
  expect(filterPages(PAGES, NO_FILTER)).toHaveLength(3);
});

test("filterPages: domain facet", () => {
  const life = filterPages(PAGES, { ...NO_FILTER, domain: "life" });
  expect(life.map((p) => p.name)).toEqual(["gym"]);
});

test("filterPages: type facet", () => {
  const entities = filterPages(PAGES, { ...NO_FILTER, type: "entity" });
  expect(entities.map((p) => p.name)).toEqual(["anthropic"]);
});

test("filterPages: tag facet is exact-match membership", () => {
  const llm = filterPages(PAGES, { ...NO_FILTER, tag: "llm" });
  expect(llm.map((p) => p.name).sort()).toEqual(["anthropic", "rag"]);
});

test("filterPages: query matches title, name, alias, and tag (case-insensitive)", () => {
  expect(filterPages(PAGES, { ...NO_FILTER, q: "retrieval" }).map((p) => p.name)).toEqual(["rag"]);
  expect(filterPages(PAGES, { ...NO_FILTER, q: "rag" }).map((p) => p.name)).toEqual(["rag"]); // alias RAG
  expect(filterPages(PAGES, { ...NO_FILTER, q: "HEALTH" }).map((p) => p.name)).toEqual(["gym"]); // tag
  expect(filterPages(PAGES, { ...NO_FILTER, q: "zzz" })).toHaveLength(0);
});

test("filterPages: facets AND with the query", () => {
  const res = filterPages(PAGES, { ...NO_FILTER, domain: "ai", q: "llm" });
  expect(res.map((p) => p.name).sort()).toEqual(["anthropic", "rag"]);
});

test("sortPages: title A-Z", () => {
  // "Anthropic" < "Gym routine" < "Retrieval Augmented Generation"
  expect(sortPages(PAGES, "title").map((p) => p.name)).toEqual(["anthropic", "gym", "rag"]);
});

test("sortPages: backlinks descending", () => {
  expect(sortPages(PAGES, "backlinks").map((p) => p.name)).toEqual(["anthropic", "rag", "gym"]);
});

test("sortPages: updated (falls back to created) descending", () => {
  // rag updated 2026-03-01, gym updated 2026-02-10, anthropic created 2026-01-15
  expect(sortPages(PAGES, "updated").map((p) => p.name)).toEqual(["rag", "gym", "anthropic"]);
});

test("pageTimeMs: frontmatter-less pages rank by mtime", () => {
  const p = page({ mtimeMs: Date.parse("2026-07-11T09:00:00Z") });
  expect(pageTimeMs(p)).toBe(Date.parse("2026-07-11T09:00:00Z"));
  expect(pageDateLabel(p)).toBe("2026-07-11");
});

test("pageTimeMs: takes the newer of mtime and frontmatter", () => {
  // A re-checked-out file (mtime reset to the past) keeps its frontmatter date…
  const stale = page({ updated: "2026-06-01", mtimeMs: Date.parse("2026-01-01T00:00:00Z") });
  expect(pageDateLabel(stale)).toBe("2026-06-01");
  // …and a file edited after its frontmatter was last bumped ranks by mtime.
  const touched = page({ updated: "2026-06-01", mtimeMs: Date.parse("2026-07-11T09:00:00Z") });
  expect(pageDateLabel(touched)).toBe("2026-07-11");
});

test("pageDateLabel: an mtime renders as a LOCAL day, not a UTC one", () => {
  // A late-evening edit in a positive-offset timezone is already "yesterday" in
  // UTC — labeling it from toISOString() would show a date that contradicts the
  // page's position at the top of the recency sort.
  const justAfterMidnightLocal = new Date(2026, 6, 12, 0, 30); // 12 Jul 00:30 local
  expect(pageDateLabel(page({ mtimeMs: justAfterMidnightLocal.getTime() }))).toBe("2026-07-12");
});

test("pageDateLabel: a winning frontmatter date is echoed verbatim", () => {
  // Round-tripping it through Date.parse (UTC midnight) would shift the day back
  // in negative-offset timezones.
  expect(pageDateLabel(page({ updated: "2026-06-01" }))).toBe("2026-06-01");
});

test("pageTimeMs: undated page is 0 and shows no date", () => {
  expect(pageTimeMs(page({}))).toBe(0);
  expect(pageDateLabel(page({}))).toBe("");
});

test("sortPages: updated ranks a frontmatter-less mimir page above older dated ones", () => {
  // The bug: mimir's blogs/plans/archive pages carry no frontmatter, so a
  // frontmatter-only sort key left them below every dated page regardless of
  // when they were actually written.
  const blog = page({
    name: "audit",
    title: "Auditing the AI shipping pipeline",
    relPath: "blogs/auditing-the-ai-shipping-pipeline.md",
    mtimeMs: Date.parse("2026-07-11T09:00:00Z"),
  });
  expect(sortPages([...PAGES, blog], "updated").map((p) => p.name)).toEqual([
    "audit",
    "rag",
    "gym",
    "anthropic",
  ]);
});

test("sortPages: equal recency falls back to title for a stable order", () => {
  const a = page({ name: "a", title: "Bravo", updated: "2026-05-01" });
  const b = page({ name: "b", title: "Alpha", updated: "2026-05-01" });
  expect(sortPages([a, b], "updated").map((p) => p.name)).toEqual(["b", "a"]);
});

test("pageAddedMs: frontmatter-less pages rank by birthtime, not mtime", () => {
  // The point of "Recently added": a sweep that edits many pages bumps every
  // mtime but leaves birthtimes alone, so new pages stay distinguishable.
  const p = page({
    mtimeMs: Date.parse("2026-07-23T09:00:00Z"),
    birthtimeMs: Date.parse("2026-07-11T09:00:00Z"),
  });
  expect(pageAddedMs(p)).toBe(Date.parse("2026-07-11T09:00:00Z"));
  expect(pageAddedLabel(p)).toBe("2026-07-11");
});

test("pageAddedMs: takes the OLDER of birthtime and frontmatter created", () => {
  // A re-checked-out wiki recreates every file — the fresh birthtime is a lie
  // the older frontmatter `created` corrects.
  const recloned = page({ created: "2026-01-01", birthtimeMs: Date.parse("2026-07-20T10:00:00Z") });
  expect(pageAddedMs(recloned)).toBe(Date.parse("2026-01-01"));
  expect(pageAddedLabel(recloned)).toBe("2026-01-01");
});

test("pageAddedMs: no signals is 0 and shows no date", () => {
  expect(pageAddedMs(page({}))).toBe(0);
  expect(pageAddedLabel(page({}))).toBe("");
});

test("pageAddedLabel: a winning frontmatter created is echoed verbatim", () => {
  expect(pageAddedLabel(page({ created: "2026-06-01" }))).toBe("2026-06-01");
});

test("sortPages: created orders by added date and ignores updated/mtime churn", () => {
  const withBirth = PAGES.map((p) =>
    // Everything mass-touched today; anthropic (created 2026-01-15) still ranks
    // between gym (02-01) and rag (01-01) by its creation date alone.
    page({ ...p, mtimeMs: Date.parse("2026-07-23T09:00:00Z") }),
  );
  expect(sortPages(withBirth, "created").map((p) => p.name)).toEqual(["gym", "anthropic", "rag"]);
});

test("sortPages: created lifts a brand-new frontmatter-less page to the top", () => {
  const fresh = page({
    name: "fresh",
    title: "Fresh page",
    birthtimeMs: Date.parse("2026-07-22T09:00:00Z"),
    mtimeMs: Date.parse("2026-07-22T09:00:00Z"),
  });
  expect(sortPages([...PAGES, fresh], "created").map((p) => p.name)[0]).toBe("fresh");
});

test("pageFolder: top-level segment, ROOT_FOLDER for wiki-root pages", () => {
  expect(pageFolder(page({ relPath: "blogs/muninn-x.md" }))).toBe("blogs");
  expect(pageFolder(page({ relPath: "archive/muninn/report.md" }))).toBe("archive");
  expect(pageFolder(page({ relPath: "index.md" }))).toBe(ROOT_FOLDER);
});

test("filterPages: folder facet, including the root sentinel", () => {
  const pages = [
    page({ name: "blog", relPath: "blogs/a.md" }),
    page({ name: "plan", relPath: "plans/b.md" }),
    page({ name: "index", relPath: "index.md" }),
  ];
  expect(filterPages(pages, { ...NO_FILTER, folder: "blogs" }).map((p) => p.name)).toEqual(["blog"]);
  expect(filterPages(pages, { ...NO_FILTER, folder: ROOT_FOLDER }).map((p) => p.name)).toEqual([
    "index",
  ]);
  expect(filterPages(pages, { ...NO_FILTER, folder: "" })).toHaveLength(3);
});

test("folderCounts: honors the domain filter", () => {
  const pages = [
    page({ relPath: "blogs/a.md", domain: "ai" }),
    page({ relPath: "blogs/b.md", domain: "ai" }),
    page({ relPath: "life/c.md", domain: "life" }),
    page({ relPath: "index.md", domain: "ai" }),
  ];
  expect(folderCounts(pages, "")).toEqual({ blogs: 2, life: 1, [ROOT_FOLDER]: 1 });
  expect(folderCounts(pages, "ai")).toEqual({ blogs: 2, [ROOT_FOLDER]: 1 });
});

test("sortPages: does not mutate input", () => {
  const before = PAGES.map((p) => p.name);
  sortPages(PAGES, "title");
  expect(PAGES.map((p) => p.name)).toEqual(before);
});

test("typeCounts: honors domain filter", () => {
  expect(typeCounts(PAGES, "")).toEqual({ concept: 1, note: 1, entity: 1 });
  expect(typeCounts(PAGES, "ai")).toEqual({ concept: 1, entity: 1 });
});

test("tagCounts: honors domain + type filters", () => {
  expect(tagCounts(PAGES, "", "")).toEqual({ search: 1, llm: 2, health: 1, org: 1 });
  expect(tagCounts(PAGES, "ai", "entity")).toEqual({ llm: 1, org: 1 });
});

test("hasTypedHubs: true with ≥2 non-note types, false for untyped/single-type wikis", () => {
  expect(hasTypedHubs(PAGES)).toBe(true); // concept + entity → 2 non-note types
  const untyped: WikiListing[] = [
    page({ name: "a", type: "note", backlinkCount: 3 }),
    page({ name: "b", type: "note", backlinkCount: 1 }),
  ];
  expect(hasTypedHubs(untyped)).toBe(false);
  // A single non-note type isn't enough of an ontology — falls back to the cross-type hub.
  const singleType: WikiListing[] = [
    page({ name: "c1", type: "concept" }),
    page({ name: "n1", type: "note" }),
  ];
  expect(hasTypedHubs(singleType)).toBe(false);
  // A wiki with custom types (mimir) counts them.
  const mimir: WikiListing[] = [
    page({ name: "s", type: "subsystem" }),
    page({ name: "p", type: "plan" }),
  ];
  expect(hasTypedHubs(mimir)).toBe(true);
});

test("mergeWikiTypes: no config yields exactly today's constants (jarvis byte-identity)", () => {
  const merged = mergeWikiTypes(null, ["concept", "entity", "source", "note"]);
  // The whole point of the byte-identity guarantee: order + labels === the constants.
  expect(merged.order).toEqual(TYPE_ORDER);
  expect(merged.labels).toEqual(TYPE_LABEL);
  // …and it's a copy, not the shared constant (client mutates the stored list).
  expect(merged.order).not.toBe(TYPE_ORDER);
  expect(merged.labels).not.toBe(TYPE_LABEL);
});

test("mergeWikiTypes: custom types append after standards, only when present, with labels", () => {
  const config = {
    typeMap: {
      projects: "subsystem",
      plans: "plan",
      archive: "report",
      flows: "concept", // standard target — no duplicate appended
      reading: "source",
    },
    typeLabels: { subsystem: "Subsystems", plan: "Plans", report: "Reports", repo: "Repos" },
  };
  // `repo` is declared (typeLabels) but no page carries it → excluded (count 0).
  const merged = mergeWikiTypes(config, ["concept", "subsystem", "plan", "report", "note"]);
  expect(merged.order).toEqual([
    ...TYPE_ORDER, // standards first, in canonical order
    "subsystem",
    "plan",
    "report",
  ]);
  expect(merged.labels.subsystem).toBe("Subsystems");
  expect(merged.labels.report).toBe("Reports");
  expect(merged.labels).not.toHaveProperty("repo"); // absent type → no label added
  expect(merged.labels.concept).toBe("Concepts"); // standard labels untouched
});

test("mergeWikiTypes: a typeMap-only custom type falls back to a title-cased label", () => {
  const config = { typeMap: { widgets: "widget" }, typeLabels: {} };
  const merged = mergeWikiTypes(config, ["widget"]);
  expect(merged.order).toEqual([...TYPE_ORDER, "widget"]);
  expect(merged.labels.widget).toBe("Widget");
});

test("hubTypeList: non-note, non-explainer types present, ordered by the merged list", () => {
  const order = [...TYPE_ORDER, "subsystem", "plan"];
  const pages: WikiListing[] = [
    page({ type: "subsystem" }),
    page({ type: "plan" }),
    page({ type: "concept" }),
    page({ type: "explainer" }), // excluded — explainers never join the link graph
    page({ type: "note" }), // excluded — the fallback type
  ];
  expect(hubTypeList(pages, order)).toEqual(["concept", "subsystem", "plan"]);
});

test("hubTypeList: a type present but missing from the order is appended (alpha)", () => {
  const pages: WikiListing[] = [page({ type: "zeta" }), page({ type: "alpha" })];
  // Neither is in TYPE_ORDER → both are extras, alpha-sorted.
  expect(hubTypeList(pages, TYPE_ORDER)).toEqual(["alpha", "zeta"]);
});

test("connectionTypeOrder: stored order first, then extras present in items (alpha)", () => {
  const order = [...TYPE_ORDER, "subsystem"];
  // `plan` is a real custom type NOT in the stored order (late/empty stored list) —
  // it must still be grouped, never dropped (the :918 regression case).
  const itemTypes = ["subsystem", "concept", "plan", "note"];
  expect(connectionTypeOrder(itemTypes, order)).toEqual([
    "concept",
    "note",
    "subsystem",
    "plan", // extra, appended so its neighbor is never dropped
  ]);
});

test("connectionTypeOrder: empty stored order still surfaces every present type", () => {
  expect(connectionTypeOrder(["plan", "concept"], [])).toEqual(["concept", "plan"]);
});

test("topPages: type predicate filters and sorts by backlinkCount desc, honors limit", () => {
  const pages: WikiListing[] = [
    page({ name: "c1", type: "concept", backlinkCount: 2 }),
    page({ name: "c2", type: "concept", backlinkCount: 8 }),
    page({ name: "n1", type: "note", backlinkCount: 99 }),
  ];
  expect(topPages(pages, (p) => p.type === "concept").map((p) => p.name)).toEqual(["c2", "c1"]);
  expect(topPages(pages, (p) => p.type === "concept", 1).map((p) => p.name)).toEqual(["c2"]);
});

test("topPages: backlinked-only predicate (untyped fallback) drops orphans", () => {
  const pages: WikiListing[] = [
    page({ name: "hub", type: "note", backlinkCount: 7 }),
    page({ name: "mid", type: "note", backlinkCount: 3 }),
    page({ name: "orphan", type: "note", backlinkCount: 0 }),
  ];
  expect(topPages(pages, (p) => p.backlinkCount > 0).map((p) => p.name)).toEqual(["hub", "mid"]);
  // Nothing linked → empty (drives the muted empty-state in hubsHtml).
  const none: WikiListing[] = [page({ name: "x", type: "note", backlinkCount: 0 })];
  expect(topPages(none, (p) => p.backlinkCount > 0)).toEqual([]);
});

test("sanitizeColorToken accepts strict hex color tokens", () => {
  for (const v of ["#abc", "#abcd", "#a1b2c3", "#a1b2c3d4", "#FFF", "  #6c63ff  "]) {
    expect(sanitizeColorToken(v)).toBe(v.trim());
  }
});

test("sanitizeColorToken accepts rgb/rgba/hsl/hsla with numeric args", () => {
  for (const v of ["rgb(108, 99, 255)", "rgba(0,0,0,0.5)", "hsl(240, 100%, 60%)", "HSLA(240, 100%, 60%, 0.4)"]) {
    expect(sanitizeColorToken(v)).toBe(v);
  }
});

test("sanitizeColorToken drops named colors, functions with non-numeric args, and non-strings", () => {
  for (const v of ["red", "blue", "transparent", "var(--accent)", "url(x)", "#12", "#12345", "rgb(a,b,c)", "#xyz"]) {
    expect(sanitizeColorToken(v)).toBeUndefined();
  }
  expect(sanitizeColorToken(undefined)).toBeUndefined();
  expect(sanitizeColorToken(["#fff"])).toBeUndefined(); // frontmatter array value
  expect(sanitizeColorToken("")).toBeUndefined();
});

test("sanitizeColorToken drops a CSS-injection attempt (style-sink breakout)", () => {
  // The load-bearing security case: a value crafted to escape the <style> sink and
  // inject arbitrary rules must never survive validation.
  for (const attack of [
    "red;} body{display:none}",
    "#fff;} html{background:url(evil)}",
    "#fff</style><script>alert(1)</script>",
    "rgb(0,0,0);} .x{color:red",
    "#fff /* comment */",
  ]) {
    expect(sanitizeColorToken(attack)).toBeUndefined();
  }
});
