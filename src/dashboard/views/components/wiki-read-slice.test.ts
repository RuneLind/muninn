import { describe, test, expect } from "bun:test";
import {
  WIKI_READ_SLICE_CLASS,
  WIKI_READ_SLICE_HIDDEN_SELECTOR,
  readSliceStartTab,
  wikiReadSliceStyles,
  wikiToolsFlag,
} from "./wiki-read-slice.ts";
import { renderWikiPage } from "../wiki-page.ts";

describe("the reader under the read slice", () => {
  test("wikiToolsFlag is false only on an explicit false", () => {
    expect(wikiToolsFlag({ __WIKI_TOOLS__: false })).toBe(false);
    expect(wikiToolsFlag({ __WIKI_TOOLS__: true })).toBe(true);
    expect(wikiToolsFlag({})).toBe(true);
    expect(wikiToolsFlag(undefined)).toBe(true);
  });

  test("a stored or linked Atlas tab lands on Hubs, and only under the slice", () => {
    expect(readSliceStartTab("atlas", false)).toBe("hubs");
    expect(readSliceStartTab("atlas", true)).toBe("atlas");
    expect(readSliceStartTab("timeline", false)).toBe("timeline");
  });

  test("the hidden set names every control that reaches a dropped route", () => {
    const hidden = WIKI_READ_SLICE_HIDDEN_SELECTOR.split(",");
    for (const sel of [
      "#wikiExplainBtn", "#wikiFactcheckArticleBtn", "#wikiShareBtn", "#wikiDiscussBtn",
      "#wikiRememberBtn", '[data-conntab="ask"]', "#askBody", "[data-series-menu]",
      "[data-prov-stamp]", "#wikiBoardLink", ".wiki-gardener-icon", "#wikiSimilar",
    ]) {
      expect(hidden, sel).toContain(sel);
    }
    // Every entry is scoped to the body class — none leaks onto a normal page.
    const rules = wikiReadSliceStyles().split("{")[0]!.split(",").map((r) => r.trim()).filter(Boolean);
    expect(rules.length).toBe(hidden.length);
    for (const r of rules) expect(r.startsWith(`body.${WIKI_READ_SLICE_CLASS} `), r).toBe(true);
  });

  test("renderWikiPage({tools:false}) stamps the class, the flag, and drops the presence poll", async () => {
    const html = await renderWikiPage({ wikis: ["felles"], selected: "felles", tools: false, wikiRoot: "/srv/mirror" });
    expect(html).toContain(`<body class="${WIKI_READ_SLICE_CLASS}">`);
    // The host path is withheld from a reader who is not an operator.
    expect(html).not.toContain("/srv/mirror");
    expect(html).toContain('window.__WIKI_ROOT__ = "";');
    expect(html).toContain("window.__WIKI_TOOLS__ = false;");
    // The agent-presence chip polls /api/agents/overview, which role `user` is refused.
    expect(html).not.toContain('id="wikiPresence"');
  });

  test("the default page is unchanged: no class, the flag true, the presence chip present", async () => {
    const html = await renderWikiPage({ wikis: ["felles"], selected: "felles", wikiRoot: "/srv/mirror" });
    expect(html).toContain("<body>");
    expect(html).toContain('window.__WIKI_ROOT__ = "/srv/mirror";');
    expect(html).toContain("window.__WIKI_TOOLS__ = true;");
    expect(html).toContain('id="wikiPresence"');
  });
});
