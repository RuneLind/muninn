/**
 * The culled marker's shared label and the two reader markups built from it
 * (a Connections row, a mini-graph node). Pure, so `bun test` loads it —
 * `wiki-browser.ts` touches `document` at import time.
 */

import { describe, expect, test } from "bun:test";
import { CULL_LABEL, CULL_TITLE, connItemHtml, miniNodeHtml } from "./wiki-cull-view.ts";
import type { WikiListing } from "./wiki-filter.ts";

const page = (over: Partial<WikiListing> = {}): WikiListing =>
  ({
    name: "p",
    title: "A very long page title that the Connections column clips with an ellipsis",
    type: "plan",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "plans/p.md",
    linkCount: 0,
    backlinkCount: 0,
    ...over,
  }) as WikiListing;

describe("the shared label", () => {
  test("is the plan's default wording, with a neutral tooltip", () => {
    expect(CULL_LABEL).toBe("Retired");
    expect(CULL_TITLE).toBe("Retired page");
  });
});

describe("connItemHtml", () => {
  test("a culled row's marker sits OUTSIDE the clipped title span, as its own flex item", () => {
    const html = connItemHtml(page({ culled: true }), "Long title");
    expect(html).toContain('<span class="wiki-conn-name">Long title</span><em class="wiki-cull-mark" title="Retired page">Retired</em></div>');
  });

  test("a live row carries no marker", () => {
    expect(connItemHtml(page(), "T")).not.toContain("wiki-cull-mark");
  });
});

describe("miniNodeHtml", () => {
  test("a culled neighbour is muted and its tooltip says Retired", () => {
    const html = miniNodeHtml(page({ culled: true }), { x: 10, y: 20, labelY: 35, label: "Short", title: "Full title" });
    expect(html).toContain('<g class="mini-node culled"');
    expect(html).toContain("<title>Full title — Retired</title>");
  });

  test("a live neighbour is unmarked", () => {
    const html = miniNodeHtml(page(), { x: 10, y: 20, labelY: 35, label: "Short", title: "Full title" });
    expect(html).toContain('<g class="mini-node"');
    expect(html).toContain("<title>Full title</title>");
  });
});
