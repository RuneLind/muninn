import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkComponents } from "./lint-components.ts";
import { buildWikiIndex } from "./store.ts";
import { lintWiki } from "./lint.ts";
import { formatWebHtml } from "../web/web-format.ts";

const page = (...lines: string[]) => ["---", "title: X", "---", "", ...lines].join("\n");
const run = (content: string) => checkComponents("plans/x.mdx", content);

describe("checkComponents — the plan's acceptance fixture", () => {
  const fixture = page(
    '<Callout tone="success">', // line 5
    "Shipped.",
    "</Callout>",
    "",
    '<Callout type="warning">', // line 9
    "Careful.",
    "</Callout>",
    "",
    '<Verdict value="maybe">Hm</Verdict>', // line 13
    "",
    "<NextMoves>",
    '<Lane kind="You" since="14.10.2026">',
    "- one step",
    "</Lane>",
    "</NextMoves>",
    "",
    'A passage <Fact n="1" v="✅">checked</Fact> here.',
    "",
    "<Verdict>x</Verdict>",
    "",
    "<Callout>",
    "No tone.",
    "</Callout>",
    "",
    'Quoted: `tone="success"`, `<Callout tone="success">` and `<Pill tone="bogus">p</Pill>` in code.',
    "",
    'Prose with a mid-line <Callout tone="success"> tag that renders as text.',
  );

  test("exactly three findings, each with a hint naming the replacement", () => {
    expect(run(fixture)).toEqual([
      {
        check: "component-value",
        relPath: "plans/x.mdx",
        line: 5,
        message: 'Callout tone="success" renders as info',
        detail: "Accepted: info|warn|good|bad. Did you mean good?",
      },
      {
        check: "component-attr",
        relPath: "plans/x.mdx",
        line: 9,
        message: 'Callout type="warning" is not a Callout attribute; the renderer drops it',
        detail: 'Callout takes tone, title, resolved. Did you mean tone="warn"?',
      },
      {
        check: "component-value",
        relPath: "plans/x.mdx",
        line: 13,
        message: 'Verdict value="maybe" renders as yes',
        detail: "Accepted: yes|no. Verdict has no middle value; use a warn Callout.",
      },
    ]);
  });

  test("each message says what the renderer does", () => {
    const html = formatWebHtml(fixture.split("\n").slice(4).join("\n"));
    // The success callout renders info, the type= callout renders info too.
    expect(html.match(/class="callout callout-info"/g)?.length).toBe(3);
    expect(html).toContain('class="verdict verdict-yes">Hm<');
    // The mid-line tag is escaped prose, not a callout.
    expect(html).toContain("mid-line &lt;Callout");
  });
});

describe("checkComponents — one finding each", () => {
  test("an inline Pill with a bad tone in a list item", () => {
    const content = page("- a step <Pill tone=\"bogus\">x</Pill> here", "- another");
    expect(run(content)).toEqual([
      {
        check: "component-value",
        relPath: "plans/x.mdx",
        line: 5,
        message: 'Pill tone="bogus" renders as default',
        detail: "Accepted: default|rec|warn.",
      },
    ]);
    expect(formatWebHtml(content.split("\n").slice(4).join("\n"))).toContain('<span class="pill">x</span>');
  });

  test("a Meter with no value", () => {
    const content = page('<Meter max="10" tone="bogus">', "Coverage", "</Meter>");
    expect(run(content)).toEqual([
      {
        check: "component-value",
        relPath: "plans/x.mdx",
        line: 5,
        message: "Meter has no value; its label renders as plain text",
        detail: "Accepted: a number.",
      },
    ]);
    expect(formatWebHtml(content.split("\n").slice(4).join("\n"))).not.toContain('class="meter');
  });

  test("a Meter whose value is not a number, and one with a bad max", () => {
    expect(run(page('<Meter value="high">L</Meter>')).map((f) => f.message)).toEqual([
      'Meter value="high" is not a number; its label renders as plain text',
    ]);
    expect(run(page('<Meter value="3" max="0">L</Meter>')).map((f) => f.message)).toEqual([
      'Meter max="0" is not a positive number; the meter renders out of 5',
    ]);
  });
});

describe("checkComponents — what the renderer does not claim is not checked", () => {
  test("tags in frontmatter and fences are skipped", () => {
    const content = [
      "---",
      'note: <Pill tone="bogus">x</Pill>',
      "---",
      "```mdx",
      '<Callout tone="success">',
      "x",
      "</Callout>",
      "```",
    ].join("\n");
    expect(run(content)).toEqual([]);
  });

  test("an unclosed block tag renders as text and is not checked", () => {
    expect(run(page('<Callout tone="success">', "never closed"))).toEqual([]);
  });

  test("an unknown tag name is not checked", () => {
    expect(run(page('<Calout tone="success">', "x", "</Calout>"))).toEqual([]);
  });

  test("a tag past the depth cap is text; an inline one inside it still renders", () => {
    const deep = page(
      "<Fold>",
      "<Fold>",
      "<Fold>",
      '<Callout tone="success">',
      'x <Pill tone="bogus">p</Pill>',
      "</Callout>",
      "</Fold>",
      "</Fold>",
      "</Fold>",
    );
    expect(run(deep).map((f) => `${f.line} ${f.message}`)).toEqual(['9 Pill tone="bogus" renders as default']);
  });

  test("Question, Lane role, CaseBoard labels and free-text attributes are not reported", () => {
    const content = page(
      '<Question id="nope" choices="" to="x">',
      "Q?",
      "</Question>",
      "",
      "<NextMoves>",
      '<Lane kind="waiting" role="Not A Key!" who="">',
      "- step",
      "</Lane>",
      "</NextMoves>",
      "",
      '<CaseBoard src="x.yaml" labels="bogus" />',
      "",
      '<Fold title="" open="nope" for="whoever">',
      "x",
      "</Fold>",
    );
    expect(run(content)).toEqual([]);
  });

  test("an empty value renders as a missing one and is not reported", () => {
    expect(run(page('<Callout tone="" resolved="">', "x", "</Callout>"))).toEqual([]);
    expect(run(page("<NextMoves>", '<Lane kind="" since=" ">', "- s", "</Lane>", "</NextMoves>"))).toEqual([]);
  });
});

describe("checkComponents — the other fallbacks", () => {
  test("Lane since without an age, Lane kind, Fact v, Callout resolved", () => {
    const content = page(
      "<NextMoves>",
      '<Lane kind="next" since="next week">',
      "- step",
      "</Lane>",
      "</NextMoves>",
      "",
      'A <Fact n="1" v="maybe">claim</Fact>.',
      "",
      '<Callout resolved="2026-02-30">',
      "x",
      "</Callout>",
    );
    expect(run(content).map((f) => [f.line, f.message, f.detail])).toEqual([
      [6, 'Lane kind="next" renders as waiting', "Accepted: you|waiting|draft|blocked. Did you mean waiting?"],
      [6, 'Lane since="next week" has no age; shown as written', "Accepted: an ISO date, YYYY-MM-DD, or DD.MM.YYYY."],
      [11, 'Fact v="maybe" renders as unknown', "Accepted: ok|warn|bad|unknown or ✅ ⚠️ ❌ ❓."],
      [
        13,
        'Callout resolved="2026-02-30" is not an ISO date; the callout renders open, not resolved',
        "Accepted: an ISO date, YYYY-MM-DD.",
      ],
    ]);
  });

  test("a bad tone on a resolved callout says the row ignores it", () => {
    expect(run(page('<Callout tone="success" resolved="2026-10-01">', "x", "</Callout>")).map((f) => f.message)).toEqual([
      'Callout tone="success" is not a tone; this resolved callout renders as a good row and ignores it',
    ]);
  });

  test("a case variant suggests the accepted spelling", () => {
    expect(run(page('<Callout tone="Good">', "x", "</Callout>"))[0]!.detail).toBe(
      "Accepted: info|warn|good|bad. Did you mean good?",
    );
  });

  test("the last spelling of a repeated attribute is the one judged", () => {
    expect(run(page('<Callout tone="success" tone="good">', "x", "</Callout>"))).toEqual([]);
    expect(run(page('<Callout tone="good" tone="success">', "x", "</Callout>")).length).toBe(1);
  });

  test("a single-line nested block is read on its own line", () => {
    const f = run(page('<Callout tone="note"><Verdict value="maybe"/></Callout>'));
    expect(f.map((x) => `${x.line} ${x.message}`)).toEqual([
      '5 Callout tone="note" renders as info',
      '5 Verdict value="maybe" renders as yes',
    ]);
  });

  test("an attribute on a component that takes none, with no alias", () => {
    expect(run(page('<ComparisonTable cols="2">', "| a | b |", "|---|---|", "| 1 | 2 |", "</ComparisonTable>"))).toEqual([
      {
        check: "component-attr",
        relPath: "plans/x.mdx",
        line: 5,
        message: 'ComparisonTable cols="2" is not a ComparisonTable attribute; the renderer drops it',
        detail: "ComparisonTable takes no attributes.",
      },
    ]);
  });

  test("CRLF line endings keep the line numbers", () => {
    const f = run(page('<Callout tone="success">', "x", "</Callout>").replace(/\n/g, "\r\n"));
    expect(f.map((x) => x.line)).toEqual([5]);
  });
});

describe("lintWiki runs the check on .mdx pages only", () => {
  test("an .mdx page reports, the same tag on an .md page does not", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-lint-components-"));
    try {
      const body = page('<Callout tone="success">', "x", "</Callout>");
      await Bun.write(path.join(root, "plans/a.mdx"), body);
      await Bun.write(path.join(root, "plans/b.md"), body);
      const report = await lintWiki(await buildWikiIndex(root));
      const found = report.findings.filter((f) => f.check.startsWith("component-"));
      expect(found.map((f) => [f.relPath, f.line])).toEqual([["plans/a.mdx", 5]]);
      expect(report.counts["component-value"]).toBe(1);
      expect(report.counts["component-attr"]).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
