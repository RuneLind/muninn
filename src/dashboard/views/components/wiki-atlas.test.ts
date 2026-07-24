import { test, expect, describe } from "bun:test";
import { shellHtml, nodeHtml } from "./wiki-atlas.ts";

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
});
