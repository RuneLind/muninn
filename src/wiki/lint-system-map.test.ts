/**
 * Lint checks `system-map` and `system-map-drift` (`lint-system-map.ts`):
 * the heading match rule, each drift kind on its own, the unresolved name,
 * the `systemMapLinkHeadings` override, and the real `lintWiki` over a temp
 * wiki. Synthetic names only.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { testTempDirSync } from "../test/temp-dir.ts";
import path from "node:path";
import { linkHeadingMatches, linkHeadingName, SYSTEM_MAP_LINK_HEADINGS_DEFAULT } from "./lint-system-map.ts";
import { lintWiki, PAGE_TEXT_LINT_CHECKS, LINT_CHECKS, checkPageText } from "./lint.ts";
import { buildWikiIndex, parseSystemMapLinkHeadings } from "./store.ts";
import { renderWikiHtml } from "./render.ts";

function wiki(files: Record<string, string>): string {
  const root = testTempDirSync("muninn-sysmap-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const repo = (name: string, sections: string) => `---\ntitle: ${name}\n---\n# ${name}\n\n${sections}\n`;
const hub = (rows: string[], attrs = "") =>
  ["---", "title: Map", "---", "# Map", "", `<SystemMap${attrs}>`, "", "| From | To | Protocol | Status | Evidence |", "|---|---|---|---|---|", ...rows, "", "</SystemMap>", ""].join("\n");

async function drift(files: Record<string, string>) {
  const report = await lintWiki(await buildWikiIndex(wiki(files)));
  return report.findings.filter((f) => f.check === "system-map-drift");
}

describe("the heading match rule", () => {
  test("a trailing parenthetical is dropped; the rest must match exactly", () => {
    expect(linkHeadingName("External integrations (all mocked)")).toBe("External integrations");
    expect(linkHeadingMatches("External integrations (all mocked)", SYSTEM_MAP_LINK_HEADINGS_DEFAULT)).toBe(true);
    expect(linkHeadingMatches("Related", SYSTEM_MAP_LINK_HEADINGS_DEFAULT)).toBe(true);
    expect(linkHeadingMatches("Integrasjoner", SYSTEM_MAP_LINK_HEADINGS_DEFAULT)).toBe(true);
    expect(linkHeadingMatches("Related concepts", SYSTEM_MAP_LINK_HEADINGS_DEFAULT)).toBe(false);
    expect(linkHeadingMatches("related repos", SYSTEM_MAP_LINK_HEADINGS_DEFAULT)).toBe(false);
    expect(linkHeadingMatches("Related (see also) repos", SYSTEM_MAP_LINK_HEADINGS_DEFAULT)).toBe(false);
  });

  test("the default is the four named headings", () => {
    expect([...SYSTEM_MAP_LINK_HEADINGS_DEFAULT]).toEqual(["External integrations", "Related repos", "Related", "Integrasjoner"]);
  });

  test("an override replaces the default", async () => {
    const files = {
      ".wiki-reader.json": JSON.stringify({ systemMapLinkHeadings: ["Calls"] }),
      "repos/a.md": repo("a", "## Calls\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", "## Related\n\n- [[repos/a]]"),
      "flows/map.mdx": hub(["| a | b | REST | wrong | gone |"]),
    };
    const out = await drift(files);
    // Only a's «Calls» counts now; b's «Related» is no longer a link section.
    expect(out.map((f) => f.message)).toEqual(["<SystemMap> row a → b is wrong, but repos/a.md:8 («Calls») still links it"]);
  });

  test("parseSystemMapLinkHeadings: absent, bad entries, an empty list", () => {
    expect(parseSystemMapLinkHeadings(undefined)).toEqual({ headings: undefined, warnings: [] });
    expect(parseSystemMapLinkHeadings([" Calls ", 3, "", "Calls"])).toEqual({ headings: ["Calls"], warnings: ["entry 3 is not a heading name — dropped", 'entry "" is not a heading name — dropped'] });
    expect(parseSystemMapLinkHeadings([]).headings).toBeUndefined();
    expect(parseSystemMapLinkHeadings("Calls").headings).toBeUndefined();
  });

  test("an entry that is only a parenthetical names no heading: dropped with a warning, and never matches", () => {
    expect(parseSystemMapLinkHeadings(["(mock)", "Calls", " ( x ) "])).toEqual({
      headings: ["Calls"],
      warnings: ['entry "(mock)" names no heading once its parenthetical is dropped — dropped', 'entry " ( x ) " names no heading once its parenthetical is dropped — dropped'],
    });
    expect(parseSystemMapLinkHeadings(["(mock)"])).toEqual({
      headings: undefined,
      warnings: ['entry "(mock)" names no heading once its parenthetical is dropped — dropped', "names no heading — using the default"],
    });
    // The matcher refuses an empty name on either side (a hand-built config skips the parse).
    expect(linkHeadingMatches("(draft)", ["(mock)"])).toBe(false);
    expect(linkHeadingMatches("(draft)", [""])).toBe(false);
  });

  test("a configured «(mock)» reads no «## (draft)» section: no finding with an empty heading", async () => {
    const out = await drift({
      ".wiki-reader.json": JSON.stringify({ systemMapLinkHeadings: ["(mock)", "Calls"] }),
      "repos/a.md": repo("a", "## (draft)\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | c | REST | ok | |", "| b | c | REST | ok | |"]),
      "repos/c.md": repo("c", ""),
    });
    expect(out.filter((f) => f.message.includes("has no row"))).toEqual([]);
    expect(out.some((f) => f.message.includes("«»"))).toBe(false);
  });
});

describe("system-map-drift", () => {
  test("a wrong row a page still links", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## External integrations\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | wrong | b dropped the endpoint |"]),
    });
    expect(out).toEqual([
      {
        check: "system-map-drift",
        relPath: "flows/map.mdx",
        message: "<SystemMap> row a → b is wrong, but repos/a.md:8 («External integrations») still links it",
        detail: "evidence: b dropped the endpoint",
        line: 10,
      },
    ]);
  });

  test("an ok row neither end links", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related concepts\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", "Prose naming [[repos/a]] outside any link section."),
      "flows/map.mdx": hub(["| a | b | REST | ok | |"]),
    });
    expect(out.map((f) => [f.message, f.line])).toEqual([["<SystemMap> row a → b is ok, but neither repos/a.md nor repos/b.md links the other in a link section", 10]]);
  });

  test("a link between two table nodes with no row", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related repos\n\n- [[repos/c]]\n- [b](./b.md)"),
      "repos/b.md": repo("b", ""),
      "repos/c.md": repo("c", ""),
      "flows/map.mdx": hub(["| a | b | REST | ok | |", "| b | c | REST | ok | |"]),
    });
    expect(out.map((f) => f.message)).toEqual([
      "<SystemMap> row b → c is ok, but neither repos/b.md nor repos/c.md links the other in a link section",
      "<SystemMap> has no row between a and c, but repos/a.md:8 («Related repos») links them",
    ]);
  });

  test("a name that resolves to no page warns; an external is left out of drift", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Integrasjoner\n\n- [[integrations/reg]]"),
      "integrations/reg.md": "# Reg\n",
      "flows/map.mdx": hub(["| a | Reg | SOAP | ok | |", "| a | ab | REST | ok | |"], ' external="Reg"'),
    });
    expect(out.map((f) => f.message)).toEqual(['<SystemMap> node "ab" resolves to no repos/ page and is not listed in external=']);
  });

  test("a link in a fence or a code span is no link; a matching pair is clean", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/b]]\n\n```\n[[repos/c]]\n```\n\n- `[[repos/c]]`"),
      "repos/b.md": repo("b", ""),
      "repos/c.md": repo("c", ""),
      "flows/map.mdx": hub(["| a | b | REST | ok | |", "| b | c | REST | wrong | gone |"]),
    });
    expect(out).toEqual([]);
  });

  test("a section ends at the next heading, whatever its level", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/c]]\n\n### Inner\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "repos/c.md": repo("c", ""),
      "flows/map.mdx": hub(["| a | b | REST | ok | |", "| a | c | REST | ok | |"]),
    });
    expect(out.map((f) => f.message)).toEqual(["<SystemMap> row a → b is ok, but neither repos/a.md nor repos/b.md links the other in a link section"]);
  });
});

describe("system-map (page text)", () => {
  test("is a page-text check; the drift check is not", () => {
    expect(PAGE_TEXT_LINT_CHECKS as readonly string[]).toContain("system-map");
    expect(PAGE_TEXT_LINT_CHECKS as readonly string[]).not.toContain("system-map-drift");
    expect(LINT_CHECKS as readonly string[]).toContain("system-map-drift");
  });

  test("findings sit on the row's line, else the tag's; an unknown attribute is check 15's", () => {
    const content = hub(["| a | b | REST | maybe | |", "| b | c | REST | wrong | |"], ' colour="red"');
    const out = checkPageText({ relPath: "flows/map.mdx" }, content, []).filter((f) => f.check === "system-map" || f.check === "component-attr");
    expect(out.map((f) => [f.check, f.line, f.message])).toEqual([
      ["component-attr", 6, expect.stringContaining("colour")],
      ["system-map", 10, '<SystemMap> row a → b has Status "maybe"; write ok or wrong'],
      ["system-map", 11, "<SystemMap> row b → c is wrong and gives no reason in the Evidence column"],
    ]);
  });

  test("a map with no table renders as written and says so", () => {
    const out = checkPageText({ relPath: "flows/map.mdx" }, "# Map\n\n<SystemMap>\n\nprose\n\n</SystemMap>\n", []).filter((f) => f.check === "system-map");
    expect(out.map((f) => [f.line, f.message])).toEqual([[3, "<SystemMap> holds no pipe table; it renders as its table"]]);
  });
});

describe("link sections", () => {
  test("a link whose label holds a backtick is still a link", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/b|run `make]] then `x`"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | ok | |"]),
    });
    expect(out).toEqual([]);
  });

  test("a section ends at the next heading of any level: «Related concepts» under «Related» is not read", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n### Related concepts\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | wrong | gone |"]),
    });
    expect(out).toEqual([]);
  });

  test("a configured heading with a trailing parenthetical matches; null reads as absent", async () => {
    const out = await drift({
      ".wiki-reader.json": JSON.stringify({ systemMapLinkHeadings: ["Calls (mock)"] }),
      "repos/a.md": repo("a", "## Calls\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | ok | |"]),
    });
    expect(out).toEqual([]);
    expect(parseSystemMapLinkHeadings(null)).toEqual({ headings: undefined, warnings: [] });
  });
});

describe("node names", () => {
  test("a wikilink cell resolves by its target, anchor dropped, not by its label", async () => {
    const out = await drift({
      "repos/alpha-web.md": repo("alpha-web", "## Related\n\n- [[repos/beta-api]]"),
      "repos/beta-api.md": repo("beta-api", ""),
      "flows/map.mdx": hub(["| [[repos/alpha-web|Alpha Web]] | [[repos/beta-api#api]] | REST | ok | |"]),
    });
    expect(out).toEqual([]);
  });

  test("a name must resolve to a page under repos/: ../plans/secret is unresolved", async () => {
    const out = await drift({
      "repos/a.md": repo("a", ""),
      "plans/secret.md": "---\ntitle: secret\n---\n# secret\n",
      "flows/map.mdx": hub(["| a | ../plans/secret | REST | wrong | gone |"]),
    });
    expect(out.map((f) => f.message)).toEqual(['<SystemMap> node "../plans/secret" resolves to no repos/ page and is not listed in external=']);
  });

  test("external= and groups= entries written as wikilinks read as their target", async () => {
    const content = hub(["| a | PDL | REST | ok | |"], ' external="[[integrations/pdl|PDL]]" groups="[[repos/a|A]]=web"');
    expect(checkPageText({ relPath: "flows/map.mdx" }, content, []).filter((f) => f.check === "system-map")).toEqual([]);
    const out = await drift({ "repos/a.md": repo("a", ""), "integrations/pdl.md": "# PDL\n", "flows/map.mdx": content });
    expect(out).toEqual([]);
  });
});

describe("markup in cells and attributes (lint and reader read alike)", () => {
  const known: Record<string, { relPath: string; name: string }> = {
    "repos/a": { relPath: "repos/a.md", name: "a" },
    "integrations/pdl": { relPath: "integrations/pdl.md", name: "pdl" },
  };
  const readerHtml = (content: string) => renderWikiHtml(content, (t) => known[t.toLowerCase()] as never, { views: true, wiki: "w" });

  test("external= written as code reads as its text, on both paths", async () => {
    const content = hub(["| a | PDL | REST | ok | |"], ' external="`PDL`"');
    expect(checkPageText({ relPath: "flows/map.mdx" }, content, []).filter((f) => f.check === "system-map")).toEqual([]);
    const out = await drift({ "repos/a.md": repo("a", ""), "integrations/pdl.md": "# PDL\n", "flows/map.mdx": content });
    expect(out).toEqual([]);
    const html = readerHtml(content);
    expect(html).toContain('data-relpath="integrations/pdl.md"');
    expect(html).not.toContain("sm-unresolved");
  });

  test("a link's label reads as visible text: the repeat key, the evidence and the drawn label", async () => {
    const rows = ["| [[repos/a|**Alpha**]] | b | [[integrations/kafka|`Kafka`]] | wrong | see [[repos/x|*old*]] |", "| a | b | Kafka | ok | |"];
    const lint = checkPageText({ relPath: "flows/map.mdx" }, hub(rows), []).filter((f) => f.check === "system-map");
    expect(lint.map((f) => f.message)).toEqual(["<SystemMap> row a → b (Kafka) is given as both ok and wrong"]);
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub([rows[0]!]),
    });
    expect(out.map((f) => f.detail)).toEqual(["evidence: see old"]);
    const html = readerHtml(hub([rows[0]!]));
    expect(html).toContain(">Alpha</text>");
    expect(html).toContain("a → b · Kafka · wrong · see old");
    // The drawing only: the table under it renders a wikilink label as written.
    expect(html.slice(0, html.indexOf("<table>"))).not.toMatch(/\*\*Alpha|`Kafka`|\*old\*/);
  });
});

describe("pairs", () => {
  test("a wrong row is not reported while the same unordered pair has an ok row", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | wrong | retired |", "| b | a | Kafka | ok | |"]),
    });
    expect(out).toEqual([]);
  });

  test("the same directed pair and protocol twice, or as both ok and wrong, is a system-map finding", () => {
    const content = hub(["| Api | web | REST | ok | |", "| api | WEB | rest | wrong | dup |", "| a | b | Kafka | ok | |", "| a | b | Kafka | ok | |", "| a | b | REST | ok | |"]);
    const out = checkPageText({ relPath: "flows/map.mdx" }, content, []).filter((f) => f.check === "system-map");
    expect(out.map((f) => [f.line, f.message])).toEqual([
      [11, "<SystemMap> row api → WEB (rest) is given as both ok and wrong"],
      [13, "<SystemMap> row a → b (Kafka) is given twice"],
    ]);
  });

  test("a .md hub is judged too: both checks run on it", async () => {
    const content = hub(["| a | b | REST | maybe | |"]);
    expect(checkPageText({ relPath: "flows/map.md" }, content, []).filter((f) => f.check === "system-map").map((f) => f.message)).toEqual(['<SystemMap> row a → b has Status "maybe"; write ok or wrong']);
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.md": hub(["| a | b | REST | wrong | gone |"]),
    });
    expect(out.map((f) => f.message)).toEqual(["<SystemMap> row a → b is wrong, but repos/a.md:8 («Related») still links it"]);
  });
});

describe("where a finding points", () => {
  test("an unresolved name sits on the first row that names it", async () => {
    const out = await drift({
      "repos/a.md": repo("a", ""),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | ok | |", "| a | ab | REST | ok | |", "| ab | b | REST | ok | |"]),
    });
    expect(out.filter((f) => f.message.includes('"ab"')).map((f) => f.line)).toEqual([11]);
  });

  test("a wrong row names the line of each link that still links it; the verb agrees", async () => {
    const one = await drift({
      "repos/a.md": repo("a", "## Related\n\nIntro.\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | wrong | gone |"]),
    });
    expect(one.map((f) => f.message)).toEqual(["<SystemMap> row a → b is wrong, but repos/a.md:10 («Related») still links it"]);
    const two = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/b]]"),
      "repos/b.md": repo("b", "## Related repos\n\n- [a](./a.md)"),
      "flows/map.mdx": hub(["| a | b | REST | wrong | gone |"]),
    });
    expect(two.map((f) => f.message)).toEqual(["<SystemMap> row a → b is wrong, but repos/a.md:8 («Related») and repos/b.md:8 («Related repos») still link it"]);
  });

  test("a section linking the same node twice is named by its first link's line", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n- [[repos/b]]\n- [b again](./b.md)\n- [[repos/b|b once more]]"),
      "repos/b.md": repo("b", ""),
      "flows/map.mdx": hub(["| a | b | REST | wrong | gone |"]),
    });
    expect(out.map((f) => f.message)).toEqual(["<SystemMap> row a → b is wrong, but repos/a.md:8 («Related») still links it"]);
  });

  test("a link with no row names its line and sits on the first row naming either end", async () => {
    const out = await drift({
      "repos/a.md": repo("a", ""),
      "repos/b.md": repo("b", ""),
      "repos/c.md": repo("c", "## Related\n\n- [[repos/a]]"),
      "flows/map.mdx": hub(["| a | b | REST | ok | |", "| b | c | REST | ok | |"]),
    }).then((fs) => fs.filter((f) => f.message.includes("has no row")));
    expect(out.map((f) => [f.line, f.message])).toEqual([[10, "<SystemMap> has no row between a and c, but repos/c.md:8 («Related») links them"]]);
  });

  test("a pipe line before the table is not its header: rows keep their own lines", () => {
    const content = ["---", "title: Map", "---", "# Map", "", "<SystemMap>", "", "| note line", "", "| From | To | Status |", "|---|---|---|", "| a | b | maybe |", "", "</SystemMap>", ""].join("\n");
    const out = checkPageText({ relPath: "flows/map.mdx" }, content, []).filter((f) => f.check === "system-map");
    expect(out.map((f) => [f.line, f.message])).toEqual([[12, '<SystemMap> row a → b has Status "maybe"; write ok or wrong']]);
  });
});
