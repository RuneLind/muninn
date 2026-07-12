import { test, expect } from "bun:test";
import {
  filterPages,
  folderCounts,
  hasTypedHubs,
  pageDateLabel,
  pageFolder,
  pageTimeMs,
  ROOT_FOLDER,
  sortPages,
  tagCounts,
  topPages,
  typeCounts,
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

test("hasTypedHubs: true when concepts/entities exist, false for untyped wikis", () => {
  expect(hasTypedHubs(PAGES)).toBe(true);
  const untyped: WikiListing[] = [
    page({ name: "a", type: "note", backlinkCount: 3 }),
    page({ name: "b", type: "note", backlinkCount: 1 }),
  ];
  expect(hasTypedHubs(untyped)).toBe(false);
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
