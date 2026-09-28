import { test, expect, describe } from "bun:test";
import { atlasPoolView, shellHtml, nodeHtml } from "./wiki-atlas.ts";

/**
 * The Atlas tab has no browser test env (no jsdom/happy-dom — the interactive DOM
 * paths are covered by the orchestrator's headless smoke). Here we lock the ONE
 * property that matters at the string-build seam: a payload WITHOUT `semantic`
 * produces byte-identical markup to the pre-overlay behaviour — no toggle, no
 * slider, no legend container, no community dots. `nodeHtml` reads the module
 * `coloring`, which is null until a build runs, so a bare call is the no-overlay
 * pill.
 */

const baseData = {
  types: [
    { key: "source", label: "Sources" },
    { key: "concept", label: "Concepts" },
  ],
  nodes: {
    "a.md": { name: "A", t: "source", hub: false, in: 1, tags: [], links: [] },
  },
  monthKeys: [],
  months: {},
  topics: [],
  trails: [],
  omitted: { byType: {}, byMonth: {} },
} as unknown as Parameters<typeof shellHtml>[0];

describe("wiki-atlas no-overlay byte-identity", () => {
  test("shellHtml without `semantic` emits no overlay chrome", () => {
    const html = shellHtml(baseData, true, false);
    expect(html).not.toContain("wiki-atlas-semctl");
    expect(html).not.toContain("wiki-atlas-semtoggle");
    expect(html).not.toContain("wiki-atlas-semthresh");
    expect(html).not.toContain("wiki-atlas-semlegend");
    // The Types/Months toggle + type legend are still there, unchanged.
    expect(html).toContain("wiki-atlas-toggle");
    expect(html).toContain('data-proj="types"');
  });

  test("shellHtml WITH `semantic` adds the toggle + slider + legend container", () => {
    const withSem = { ...baseData, semantic: { edges: [], communities: [], nodeCommunity: {} } };
    const html = shellHtml(withSem as Parameters<typeof shellHtml>[0], true, false);
    expect(html).toContain("wiki-atlas-semtoggle");
    expect(html).toContain("wiki-atlas-semthresh");
    expect(html).toContain("wiki-atlas-semlegend");
  });

  test("nodeHtml with no active coloring emits no community dot (byte-identical pill)", () => {
    const html = nodeHtml("a.md", baseData.nodes["a.md"]!, "source");
    expect(html).not.toContain("wiki-atlas-dot");
    expect(html).not.toContain("data-slot");
    expect(html).toContain('data-key="a.md"');
    expect(html).toContain("wiki-atlas-badge");
  });

  test("nodeHtml labels a colliding node with its displayTitle", () => {
    // Three `architecture` cards in one Atlas column say nothing about which
    // subsystem each is; the store already computed the discriminator.
    const n = {
      name: "architecture",
      displayTitle: "muninn/architecture",
      t: "subsystem",
      hub: false,
      in: 2,
      tags: [],
      links: [],
    };
    const html = nodeHtml("projects/muninn/architecture.md", n, "subsystem");
    expect(html).toContain("<b>muninn/architecture</b>");
    // The hover title says it too — it is the only place the full label fits.
    expect(html).toContain('title="muninn/architecture"');
    // A node with no displayTitle is byte-identical to before.
    expect(nodeHtml("a.md", baseData.nodes["a.md"]!, "source")).toContain("<b>A</b>");
  });
});

describe("atlasPoolView — the Atlas restricted to the rail's pool (retired pages hidden)", () => {
  const data = {
    types: [
      { key: "source", label: "Sources" },
      { key: "concept", label: "Concepts" },
      { key: "analysis", label: "Analyses" },
    ],
    nodes: {
      "s/live.md": { name: "live", t: "source", hub: false, in: 2, tags: [], links: ["c/old.md", "c/new.md"] },
      "c/old.md": { name: "Old", t: "concept", hub: false, in: 1, tags: [], links: [] },
      "c/new.md": { name: "New", t: "concept", hub: false, in: 1, tags: [], links: [] },
      "a/gone.md": { name: "gone", t: "analysis", hub: false, in: 0, tags: [], links: [] },
    },
    monthKeys: ["2026-01", "2026-02", "2026-03"],
    months: { "2026-01": ["s/live.md"], "2026-02": ["a/gone.md"], "2026-03": ["c/new.md", "c/old.md"] },
    topics: [
      { name: "Old", count: 1, perMonth: [1, 0, 0] },
      { name: "New", count: 2, perMonth: [1, 0, 1] },
    ],
    trails: [],
    omitted: { byType: {}, byMonth: {} },
  } as unknown as Parameters<typeof atlasPoolView>[0];
  const view = atlasPoolView(data, new Set(["c/old.md", "a/gone.md"]), new Set(["old"]));

  test("culled nodes, and the links and month slots that named them, are gone", () => {
    expect(Object.keys(view.nodes).sort()).toEqual(["c/new.md", "s/live.md"]);
    expect(view.nodes["s/live.md"]!.links).toEqual(["c/new.md"]);
    expect(view.months["2026-03"]).toEqual(["c/new.md"]);
  });

  test("a month or type column left empty is dropped, and topic sparklines stay aligned", () => {
    expect(view.monthKeys).toEqual(["2026-01", "2026-03"]);
    expect(view.types.map((t) => t.key)).toEqual(["source", "concept"]);
    expect(view.topics.map((t) => t.name)).toEqual(["New"]);
    expect(view.topics[0]!.perMonth).toEqual([1, 1]);
  });

  test("the served payload is not mutated", () => {
    expect(Object.keys(data.nodes)).toHaveLength(4);
    expect(data.nodes["s/live.md"]!.links).toHaveLength(2);
  });
});

describe("atlasPoolView — a capped column's `+ N more` leaves out the culled pages", () => {
  const data = {
    types: [{ key: "archive", label: "Archive" }],
    nodes: {
      "a/live.md": { name: "live", t: "archive", hub: false, in: 3, tags: [], links: [] },
      "a/dead.md": { name: "dead", t: "archive", hub: false, in: 2, tags: [], links: [] },
    },
    monthKeys: [],
    months: {},
    topics: [],
    trails: [],
    omitted: { byType: { archive: 10 }, byMonth: {} },
  } as unknown as Parameters<typeof atlasPoolView>[0];

  test("5 culled archive pages, 1 drawn: 4 of the 10 hidden by the cap were culled", () => {
    const view = atlasPoolView(data, new Set(["a/dead.md"]), new Set(), { archive: 5 });
    expect(view.omitted.byType.archive).toBe(6);
  });

  test("never below zero, and unchanged without per-type counts", () => {
    expect(atlasPoolView(data, new Set(["a/dead.md"]), new Set(), { archive: 99 }).omitted.byType.archive).toBe(0);
    expect(atlasPoolView(data, new Set(["a/dead.md"]), new Set()).omitted.byType.archive).toBe(10);
  });
});
