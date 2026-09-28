/**
 * The culled page's per-wiki labels, the markups built from them (a Connections
 * row, a mini-graph node, the banner) and the rail's hide rule. Pure, so
 * `bun test` loads it — `wiki-browser.ts` touches `document` at import time.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_CULL_LABELS,
  connItemHtml,
  cullBannerHtml,
  cullLabels,
  cullToggleText,
  miniNodeHtml,
  parseCullLabels,
  railPool,
  RETIRED_REVEAL_ATTR,
  retiredRevealHtml,
  setCullLabels,
} from "./wiki-cull-view.ts";
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

const NORWEGIAN = { toggle: "Vis utfasede ({n})", banner: "Utfaset", marker: "Utfaset", successor: "Erstattet av" };

afterEach(() => setCullLabels(undefined));

describe("parseCullLabels", () => {
  test("absent ⇒ the English defaults, no warnings", () => {
    expect(parseCullLabels(undefined)).toEqual({ labels: { ...DEFAULT_CULL_LABELS }, warnings: [] });
    expect(DEFAULT_CULL_LABELS).toEqual({
      toggle: "Show retired ({n})",
      banner: "Retired",
      marker: "Retired",
      successor: "Superseded by",
    });
  });

  test("a valid block replaces every field it names", () => {
    expect(parseCullLabels(NORWEGIAN)).toEqual({ labels: NORWEGIAN, warnings: [] });
  });

  test("a wrong-typed field warns and drops only itself", () => {
    const { labels, warnings } = parseCullLabels({ banner: 7, marker: "Utfaset" });
    expect(labels).toEqual({ ...DEFAULT_CULL_LABELS, marker: "Utfaset" });
    expect(warnings.map((w) => w.key)).toEqual(["cullLabels.banner"]);
  });

  test("a blank field and a toggle without {n} are dropped, each with its own warning", () => {
    const { labels, warnings } = parseCullLabels({ toggle: "Vis utfasede", marker: "  " , banner: "Utfaset" });
    expect(labels).toEqual({ ...DEFAULT_CULL_LABELS, banner: "Utfaset" });
    expect(warnings.map((w) => w.key).sort()).toEqual(["cullLabels.marker", "cullLabels.toggle"]);
  });

  test("a non-object block warns once and keeps the defaults; an unknown key warns", () => {
    expect(parseCullLabels("Utfaset")).toEqual({
      labels: { ...DEFAULT_CULL_LABELS },
      warnings: [{ key: "cullLabels", reason: "is not an object — ignoring it" }],
    });
    expect(parseCullLabels({ tooltip: "x" }).warnings.map((w) => w.key)).toEqual(["cullLabels.tooltip"]);
  });
});

describe("the active labels", () => {
  test("setCullLabels swaps what every marker site reads, and a bad payload falls back per field", () => {
    setCullLabels(NORWEGIAN);
    expect(cullLabels().marker).toBe("Utfaset");
    expect(cullToggleText(34)).toBe("Vis utfasede (34)");
    setCullLabels({ marker: 3 });
    expect(cullLabels()).toEqual({ ...DEFAULT_CULL_LABELS });
    expect(cullToggleText(3)).toBe("Show retired (3)");
  });
});

describe("railPool", () => {
  const live = page({ relPath: "a.md" });
  const culled = page({ relPath: "b.md", culled: true });
  test("hides culled pages by default, shows them when toggled or searching", () => {
    expect(railPool([live, culled], false, "")).toEqual([live]);
    expect(railPool([live, culled], true, "")).toEqual([live, culled]);
    expect(railPool([live, culled], false, "b")).toEqual([live, culled]);
    expect(railPool([live, culled], false, "   ")).toEqual([live]);
  });
});

describe("retiredRevealHtml", () => {
  test("the toggle's own words and N, as a control the reader's delegate knows", () => {
    setCullLabels(NORWEGIAN);
    const html = retiredRevealHtml(4);
    expect(html).toContain(">Vis utfasede (4)</button>");
    expect(html).toContain(RETIRED_REVEAL_ATTR);
    expect(html.replace(/<[^>]*>/g, "")).toBe("Vis utfasede (4)");
  });
  test("nothing held back ⇒ no control", () => {
    expect(retiredRevealHtml(0)).toBe("");
  });
});

describe("cullBannerHtml", () => {
  test("a live page gets no banner", () => {
    expect(cullBannerHtml(page())).toBe("");
  });

  test("prefix, escaped reason and the successor link", () => {
    const html = cullBannerHtml(page({ culled: true, cullReason: "Replaced <soon>" }), {
      relPath: "concepts/new.md",
      title: "New & better",
      href: "/wiki?relPath=concepts%2Fnew.md",
    });
    expect(html).toContain('<strong class="wiki-cull-banner-label">Retired</strong>');
    expect(html).toContain(": Replaced &lt;soon&gt;");
    expect(html).toContain('data-cull-go="concepts/new.md"');
    expect(html).toContain("Superseded by <a");
    expect(html).toContain(">New &amp; better</a>");
  });

  test("uses the wiki's own words", () => {
    setCullLabels(NORWEGIAN);
    const html = cullBannerHtml(page({ culled: true }), { relPath: "x.md", title: "X", href: "#" });
    expect(html).toContain(">Utfaset</strong>");
    expect(html).toContain("Erstattet av <a");
    expect(html).not.toContain(": ");
  });
});

describe("connItemHtml", () => {
  test("a culled row's marker sits OUTSIDE the clipped title span, as its own flex item", () => {
    const html = connItemHtml(page({ culled: true }), "Long title");
    expect(html).toContain('<span class="wiki-conn-name">Long title</span><em class="wiki-cull-mark" title="Retired">Retired</em></div>');
  });

  test("the marker follows the wiki's label", () => {
    setCullLabels(NORWEGIAN);
    expect(connItemHtml(page({ culled: true }), "T")).toContain(">Utfaset</em>");
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
