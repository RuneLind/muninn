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
    expect(out.map((f) => f.message)).toEqual(["<SystemMap> row a → b is wrong, but repos/a.md («Calls») still links it"]);
  });

  test("parseSystemMapLinkHeadings: absent, bad entries, an empty list", () => {
    expect(parseSystemMapLinkHeadings(undefined)).toEqual({ headings: undefined, warnings: [] });
    expect(parseSystemMapLinkHeadings([" Calls ", 3, "", "Calls"])).toEqual({ headings: ["Calls"], warnings: ["entry 3 is not a heading name — dropped", 'entry "" is not a heading name — dropped'] });
    expect(parseSystemMapLinkHeadings([]).headings).toBeUndefined();
    expect(parseSystemMapLinkHeadings("Calls").headings).toBeUndefined();
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
        message: "<SystemMap> row a → b is wrong, but repos/a.md («External integrations») still links it",
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
      "<SystemMap> has no row between a and c, but repos/a.md («Related repos») links them",
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

  test("a section ends at the next heading of its level or higher, not at a lower one", async () => {
    const out = await drift({
      "repos/a.md": repo("a", "## Related\n\n### Inner\n\n- [[repos/b]]\n\n## Other\n\n- [[repos/c]]"),
      "repos/b.md": repo("b", ""),
      "repos/c.md": repo("c", ""),
      "flows/map.mdx": hub(["| a | b | REST | ok | |"]),
    });
    expect(out).toEqual([]);
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

  test("a .md page is not judged", () => {
    expect(checkPageText({ relPath: "flows/map.md" }, hub(["| a | b | REST | maybe | |"]), []).filter((f) => f.check === "system-map")).toEqual([]);
  });
});
