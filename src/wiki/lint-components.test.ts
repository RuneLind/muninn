import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkComponents, LINT_MARK_ATTR } from "./lint-components.ts";
import { buildWikiIndex } from "./store.ts";
import { lintWiki } from "./lint.ts";
import { renderWikiHtml } from "./render.ts";
import { observeComponentTags, type ObservedComponentTag } from "../format/markdown-ast.ts";

const page = (...lines: string[]) => ["---", "title: X", "---", "", ...lines].join("\n");
const run = (content: string) => checkComponents("plans/x.mdx", content);
/** The reader's render of a page: the HTML the finding must agree with. */
const html = (content: string) => renderWikiHtml(content, () => undefined);
const lines = (content: string) => run(content).map((f) => `${f.line} ${f.message}`);

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
    "",
    '<Callout tone="">',
    "Empty tone.",
    "</Callout>",
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
    const out = html(fixture);
    // success, type=, toneless and tone="" all render info.
    expect(out.match(/class="callout callout-info"/g)?.length).toBe(4);
    expect(out).toContain('class="verdict verdict-yes">Hm<');
    expect(out).toContain('data-kind="you"');
    expect(out).toContain("fc-mark-ok");
    // The backticked tags are code, the mid-line tag is escaped prose.
    expect(out).toContain("<code>&lt;Callout tone=&quot;success&quot;&gt;</code>");
    expect(out).toContain("mid-line &lt;Callout");
  });
});

describe("checkComponents — one finding each", () => {
  test("an inline Pill with a bad tone in a list item", () => {
    const content = page('- a step <Pill tone="bogus">x</Pill> here', "- another");
    expect(run(content)).toEqual([
      {
        check: "component-value",
        relPath: "plans/x.mdx",
        line: 5,
        message: 'Pill tone="bogus" renders as default',
        detail: "Accepted: default|rec|warn.",
      },
    ]);
    expect(html(content)).toContain('<span class="pill">x</span>');
  });

  test("a Meter with no value, and one with an empty value", () => {
    for (const open of ['<Meter max="10" tone="bogus">', '<Meter value="" tone="bogus">']) {
      const content = page(open, "Coverage", "</Meter>");
      expect(run(content)).toEqual([
        {
          check: "component-value",
          relPath: "plans/x.mdx",
          line: 5,
          message: "Meter has no value; its label renders as plain text",
          detail: "Accepted: a number.",
        },
      ]);
      expect(html(content)).not.toContain('class="meter');
    }
  });
});

/** Each review shape, asserted on the renderer's HTML AND on the finding, so
 *  the test proves agreement rather than a model of the renderer. */
describe("checkComponents agrees with the renderer on the review shapes", () => {
  test("an unclosed fence: the Callout after it renders, so it is reported", () => {
    const content = page("```", "never closed", "", '<Callout tone="success">', "x", "</Callout>");
    expect(html(content)).toContain('class="callout callout-info"');
    expect(lines(content)).toEqual(['8 Callout tone="success" renders as info']);
  });

  test('a 4-space-indented "fence" is no fence: the Callout in it renders', () => {
    const content = page("    ```", '    <Callout tone="success">', "    x", "    </Callout>", "    ```");
    expect(html(content)).toContain('class="callout callout-info"');
    expect(lines(content)).toEqual(['6 Callout tone="success" renders as info']);
  });

  test("a whole-line Fact block: the Pill inside it renders, so it is reported", () => {
    const content = page('<Fact n="1" v="ok">Whole <Pill tone="success">x</Pill> para</Fact>');
    expect(html(content)).toContain('<span class="pill">x</span>');
    expect(lines(content)).toEqual(['5 Pill tone="success" renders as default']);
  });

  test("a backticked Pill is code, the next one renders", () => {
    const content = page('See `<Pill tone="x">` then <Pill tone="success">y</Pill> end');
    const out = html(content);
    expect(out).toContain("<code>&lt;Pill tone=&quot;x&quot;&gt;</code>");
    expect(out).toContain('<span class="pill">y</span>');
    expect(lines(content)).toEqual(['5 Pill tone="success" renders as default']);
  });

  test("a close tag inside backticks leaves the Pill as text: nothing is reported", () => {
    const content = page('a <Pill tone="success">see `</Pill>` only');
    expect(html(content)).toContain("a &lt;Pill tone=&quot;success&quot;&gt;see <code>");
    expect(run(content)).toEqual([]);
  });

  test("a Pill split by a table cell renders as text: nothing is reported", () => {
    const content = page("| a | b |", "|---|---|", '| <Pill tone="success">a|b</Pill> | x |');
    expect(html(content)).toContain("<td>&lt;Pill tone=&quot;success&quot;&gt;a</td>");
    expect(run(content)).toEqual([]);
  });

  test("frontmatter closed by ---- is still frontmatter; the Callout after it is body", () => {
    const content = ["---", "title: X", "----", '<Callout tone="success">', "x", "</Callout>"].join("\n");
    expect(html(content)).toContain('class="callout callout-info"');
    expect(html(content)).not.toContain("title: X");
    expect(lines(content)).toEqual(['4 Callout tone="success" renders as info']);
  });

  test("a tag in frontmatter or a closed fence is never read", () => {
    const content = ["---", 'note: <Pill tone="bogus">x</Pill>', "---", "```mdx", '<Callout tone="success">', "x", "</Callout>", "```"].join("\n");
    expect(html(content)).not.toContain('class="callout');
    expect(run(content)).toEqual([]);
  });
});

/** Every special "renders as" message, pinned against the HTML it describes. */
describe("each special message says what the HTML shows", () => {
  test("a bad tone on a resolved callout: a good row that ignores it", () => {
    const content = page('<Callout tone="success" resolved="2026-10-01">', "x", "</Callout>");
    expect(html(content)).toContain('class="callout callout-good callout-resolved"');
    expect(lines(content)).toEqual(['5 Callout tone="success" is not a tone; this resolved callout renders as a good row and ignores it']);
  });

  test("a resolved date that is no date: the callout renders open", () => {
    const content = page('<Callout resolved="2026-02-30">', "x", "</Callout>");
    expect(html(content)).toContain('<div class="callout callout-info">');
    expect(html(content)).not.toContain("callout-resolved");
    expect(run(content).map((f) => [f.message, f.detail])).toEqual([
      ['Callout resolved="2026-02-30" is not an ISO date; the callout renders open, not resolved', "Accepted: an ISO date, YYYY-MM-DD."],
    ]);
  });

  test("a Lane since that is no date: shown as written, with no age", () => {
    const content = page("<NextMoves>", '<Lane kind="waiting" since="next week">', "- step", "</Lane>", "</NextMoves>");
    expect(html(content)).toContain('<span class="nm-since nm-since-raw">next week</span>');
    expect(html(content)).not.toContain("data-since");
    expect(run(content).map((f) => [f.message, f.detail])).toEqual([
      ['Lane since="next week" has no age; shown as written', "Accepted: an ISO date, YYYY-MM-DD, or DD.MM.YYYY."],
    ]);
  });

  test("a Meter max that is no positive number: out of 5", () => {
    const content = page('<Meter value="3" max="0">L</Meter>');
    expect(html(content)).toContain('<span class="meter-value">3/5</span>');
    expect(run(content).map((f) => [f.message, f.detail])).toEqual([
      ['Meter max="0" is not a positive number; the meter renders out of 5', "Accepted: a positive number."],
    ]);
  });

  test("a Meter value that is no number: the label renders as plain text", () => {
    const content = page('<Meter value="high" tone="bogus">L</Meter>');
    expect(html(content)).not.toContain('class="meter');
    expect(html(content)).toContain("L");
    expect(lines(content)).toEqual(['5 Meter value="high" is not a number; its label renders as plain text']);
  });

  test("the generic renders-as names the class the renderer emits", () => {
    const content = page(
      "<NextMoves>",
      '<Lane kind="next">',
      "- step",
      "</Lane>",
      "</NextMoves>",
      "",
      'A <Fact n="1" v="maybe">claim</Fact>.',
    );
    const out = html(content);
    expect(out).toContain('data-kind="waiting"');
    expect(out).toContain("fc-mark-unknown");
    expect(run(content).map((f) => [f.line, f.message, f.detail])).toEqual([
      [6, 'Lane kind="next" renders as waiting', "Accepted: you|waiting|draft|blocked. Did you mean waiting?"],
      [11, 'Fact v="maybe" renders as unknown', "Accepted: ok|warn|bad|unknown or ✅ ⚠️ ❌ ❓."],
    ]);
  });
});

describe("a tag the renderer reads twice is one finding", () => {
  test("a fold whose body opens with its own heading renders that body twice", () => {
    const content = page('<Fold title="Sec">', "", "## Sec", "", 'x <Pill tone="bogus">p</Pill>', "", "</Fold>");
    const seen: ObservedComponentTag[] = [];
    observeComponentTags((t) => seen.push(t), () => html(content));
    expect(seen.filter((t) => t.name === "Pill").length).toBe(2);
    expect(lines(content)).toEqual(['9 Pill tone="bogus" renders as default']);
  });

  test("two identical tags on different lines are two findings, each on its own line", () => {
    const content = page('a <Pill tone="bogus">p</Pill>', "", "`<Pill tone=\"bogus\">` in code", "", 'b <Pill tone="bogus">q</Pill>');
    expect(lines(content)).toEqual(['5 Pill tone="bogus" renders as default', '9 Pill tone="bogus" renders as default']);
  });
});

describe("checkComponents — what the renderer does not claim is not checked", () => {
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
    expect(html(deep)).toContain("&lt;Callout tone=&quot;success&quot;&gt;");
    expect(lines(deep)).toEqual(['9 Pill tone="bogus" renders as default']);
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
    expect(run(page('<Meter value="2" max="" tone=" ">L</Meter>'))).toEqual([]);
  });
});

describe("checkComponents — the other rules", () => {
  test("a case variant suggests the accepted spelling", () => {
    expect(run(page('<Callout tone="Good">', "x", "</Callout>"))[0]!.detail).toBe("Accepted: info|warn|good|bad. Did you mean good?");
  });

  test("the last spelling of a repeated attribute is the one judged", () => {
    expect(run(page('<Callout tone="success" tone="good">', "x", "</Callout>"))).toEqual([]);
    expect(run(page('<Callout tone="good" tone="success">', "x", "</Callout>")).length).toBe(1);
  });

  test("a single-line nested block is read on its own line", () => {
    expect(lines(page('<Callout tone="note"><Verdict value="maybe"/></Callout>'))).toEqual([
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
    const content = page('<Callout tone="success">', "x", "</Callout>", "", 'a <Pill tone="bogus">p</Pill>').replace(/\n/g, "\r\n");
    expect(run(content).map((f) => f.line)).toEqual([5, 9]);
  });

  test("the marker is not a spec attribute of any component", () => {
    // A marker the renderer kept would change what it renders.
    expect(html(page(`<Callout ${LINT_MARK_ATTR}="0" tone="warn">`, "x", "</Callout>"))).toBe(html(page('<Callout tone="warn">', "x", "</Callout>")));
  });
});

describe("known: a child the renderer parses but never emits", () => {
  test("a non-fence child of Diff and a stray child of CodeTabs are still reported", () => {
    const diff = page("<Diff>", "", '<Callout tone="success">', "x", "</Callout>", "", "```diff", "+a", "```", "", "</Diff>");
    expect(html(diff)).not.toContain("callout");
    expect(lines(diff)).toEqual(['7 Callout tone="success" renders as info']);
    const tabs = page("<CodeTabs>", "", '<Callout tone="success">', 'y <Pill tone="z">p</Pill>', "</Callout>", "", '<Tab label="a">', "", "```ts", "x", "```", "", "</Tab>", "", "</CodeTabs>");
    expect(html(tabs)).not.toContain("callout");
    expect(lines(tabs)).toEqual(['7 Callout tone="success" renders as info', '8 Pill tone="z" renders as default']);
  });
});

describe("when the marked render disagrees with the plain one", () => {
  test("the plain render's findings come back without a line", () => {
    // A render that sees one more tag in the marked text than in the plain.
    const render = (content: string) =>
      renderWikiHtml(content.includes(LINT_MARK_ATTR) ? `${content}\n\n<Verdict value="no"/>` : content, () => undefined);
    const findings = checkComponents("plans/x.mdx", page('<Callout tone="success">', "x", "</Callout>"), render);
    expect(findings).toEqual([
      {
        check: "component-value",
        relPath: "plans/x.mdx",
        message: 'Callout tone="success" renders as info',
        detail: "Accepted: info|warn|good|bad. Did you mean good?",
      },
    ]);
  });
});

describe("the observer", () => {
  test("is unset after the call, also when the call throws", () => {
    const seen: ObservedComponentTag[] = [];
    expect(() =>
      observeComponentTags(
        (t) => seen.push(t),
        () => {
          html(page('<Callout tone="x">', "y", "</Callout>"));
          throw new Error("boom");
        },
      ),
    ).toThrow("boom");
    expect(seen.length).toBe(1);
    html(page('<Callout tone="x">', "y", "</Callout>"));
    expect(seen.length).toBe(1);
  });

  test("an inner call restores the outer observer", () => {
    const outer: string[] = [];
    const inner: string[] = [];
    observeComponentTags(
      (t) => outer.push(t.name),
      () => {
        observeComponentTags((t) => inner.push(t.name), () => html(page("<Verdict>a</Verdict>")));
        html(page('a <Pill tone="rec">b</Pill>'));
      },
    );
    expect({ outer, inner }).toEqual({ outer: ["Pill"], inner: ["Verdict"] });
  });

  test("reports block tags with their parser line and raw attributes", () => {
    const seen: ObservedComponentTag[] = [];
    observeComponentTags((t) => seen.push(t), () => renderWikiHtml(["", '<Callout tone="x" bogus="y">', "z", "</Callout>"].join("\n"), () => undefined));
    expect(seen).toEqual([{ name: "Callout", rawAttrs: ' tone="x" bogus="y"', inline: false, line: 1 }]);
  });
});

describe("lintWiki runs the check on .mdx pages that are not culled", () => {
  test("an .mdx page reports; the same tag on an .md page or a culled .mdx does not", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-lint-components-"));
    try {
      const body = page('<Callout tone="success">', "x", "</Callout>");
      await Bun.write(path.join(root, "plans/a.mdx"), body);
      await Bun.write(path.join(root, "plans/b.md"), body);
      await Bun.write(
        path.join(root, "plans/c.mdx"),
        ["---", "title: C", "signal: none", "signal-reason: retired", "---", "", '<Callout tone="success">', "x", "</Callout>"].join("\n"),
      );
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
