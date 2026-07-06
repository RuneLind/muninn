import { test, expect } from "bun:test";
import {
  filterPages,
  sortPages,
  tagCounts,
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

const NO_FILTER: WikiFilters = { q: "", domain: "", type: "", tag: "" };

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
