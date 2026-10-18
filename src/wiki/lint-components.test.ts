import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as lintComponents from "./lint-components.ts";
import { checkComponents, LINT_MARK_ATTR } from "./lint-components.ts";
import { buildWikiIndex } from "./store.ts";
import { lintWiki } from "./lint.ts";
import { renderWikiHtml } from "./render.ts";
import { countedNextMovesLanes, observeComponentTags, parseBlocks, type ObservedComponentTag } from "../format/markdown-ast.ts";
import { COMPONENT_SPEC } from "../format/component-spec.ts";
import { splitFrontmatter } from "./page-text.ts";

const page = (...lines: string[]) => ["---", "title: X", "---", "", ...lines].join("\n");
const run = (content: string) => checkComponents("plans/x.mdx", content);
/** The reader's render of a page: the HTML the finding must agree with. */
const html = (content: string) => renderWikiHtml(content, () => undefined);
const lines = (content: string) => run(content).map((f) => `${f.line} ${f.message}`);
/** A render that sees one more tag in the marked text than in the plain. */
const disagreeing = (content: string) =>
  renderWikiHtml(content.includes(LINT_MARK_ATTR) ? `${content}\n\n<Verdict value="no"/>` : content, () => undefined);

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
      [6, 'Lane kind="next" is not a lane kind; the lane renders as a waiting lane', "Accepted: you|waiting|draft|blocked. Did you mean waiting?"],
      [11, 'Fact v="maybe" renders as unknown', "Accepted: ok|warn|bad|unknown or ✅ ⚠️ ❌ ❓."],
    ]);
  });
});

describe("a tag the renderer reads twice is one finding", () => {
  test("a fold whose body opens with its own heading renders that body twice", () => {
    const content = page('<Fold title="Sec">', "", "## Sec", "", 'x <Pill tone="bogus">p</Pill>', "", "</Fold>");
    const seen: ObservedComponentTag[] = [];
    observeComponentTags((t) => seen.push(t), () => html(content));
    expect(seen.filter((t) => t.name === "Pill").length).toBe(1);
    expect(lines(content)).toEqual(['9 Pill tone="bogus" renders as default']);
  });

  test("a fold read twice is one finding also when the marked render disagrees", () => {
    const content = page('<Fold title="Sec">', "", "## Sec", "", 'x <Pill tone="bogus">p</Pill>', "", "</Fold>");
    expect(checkComponents("plans/x.mdx", content, disagreeing).map((f) => [f.line, f.message])).toEqual([
      [undefined, 'Pill tone="bogus" renders as default'],
    ]);
  });

  test("a render that reads the page twice still gives one finding per located tag", () => {
    const twice = (content: string) => (renderWikiHtml(content, () => undefined), renderWikiHtml(content, () => undefined));
    expect(checkComponents("plans/x.mdx", page('<Callout tone="success">', "x", "</Callout>"), twice).map((f) => f.line)).toEqual([5]);
  });

  test("two identical tags on one line are two findings on that line", () => {
    expect(lines(page('<Pill tone="bad">a</Pill> <Pill tone="bad">b</Pill>'))).toEqual([
      '5 Pill tone="bad" renders as default',
      '5 Pill tone="bad" renders as default',
    ]);
  });

  test("identical unlocated findings on three lines stay three", () => {
    const content = page('<Callout tone="caution">', "a", "</Callout>", "", '<Callout tone="caution">', "b", "</Callout>", "", '<Callout tone="caution">', "c", "</Callout>");
    const found = checkComponents("plans/x.mdx", content, disagreeing);
    expect(found.map((f) => [f.line, f.message])).toEqual([
      [undefined, 'Callout tone="caution" renders as info'],
      [undefined, 'Callout tone="caution" renders as info'],
      [undefined, 'Callout tone="caution" renders as info'],
    ]);
  });

  test("two identical tags on different lines are two findings, each on its own line", () => {
    const content = page('a <Pill tone="bogus">p</Pill>', "", "`<Pill tone=\"bogus\">` in code", "", 'b <Pill tone="bogus">q</Pill>');
    expect(lines(content)).toEqual(['5 Pill tone="bogus" renders as default', '9 Pill tone="bogus" renders as default']);
  });
});

describe("a component name inside another tag's quoted value", () => {
  test("gets no marker, so the opener keeps its shape and every finding its line", () => {
    const fold = page('<Fold title="Use <Pill> chips" tone="x">', "", "body", "", "</Fold>", "", '<Pill tone="bad">z</Pill>');
    expect(lines(fold)).toEqual(['5 Fold tone="x" is not a Fold attribute; the renderer drops it', '11 Pill tone="bad" renders as default']);
    const callout = page('<Callout tone="success" title="use <Pill> here">', "", "body", "", "</Callout>", "", '<Pill tone="bad">z</Pill>');
    expect(lines(callout)).toEqual(['5 Callout tone="success" renders as info', '11 Pill tone="bad" renders as default']);
  });

  test("a tag the scanner reads inside an unclaimed opener's value has no marker; the others keep their lines", () => {
    const content = page('Prose <Callout title="x <Pill>a</Pill> y"> more.', "", '<Callout tone="success">', "z", "</Callout>");
    expect(html(content)).toContain('<span class="pill">a</span>');
    expect(lines(content)).toEqual(['7 Callout tone="success" renders as info']);
  });

  test("a quoted value that runs over lines claims nothing: the tags after it keep their lines", () => {
    const pill = page('Prose <Pill title="x', "", "<Meter>", "body", "</Meter>", "", 'y">z</Pill>');
    expect(lines(pill)).toEqual(["7 Meter has no value; its label renders as plain text"]);
    const fold = page('<Fold x="a', "", "<Meter>", "body", "</Meter>", "", 'b">', "c", "</Fold>");
    expect(lines(fold)).toEqual(["7 Meter has no value; its label renders as plain text"]);
  });

  test("an opener no grammar closes is marked as usual: the tag the scanner reads keeps its line", () => {
    const content = page('<Callout tone="success" title="use <Pill tone="bad">a</Pill> here">', "", "body", "", "</Callout>");
    expect(html(content)).toContain('&lt;Callout tone=&quot;success&quot;');
    expect(lines(content)).toEqual(['5 Pill tone="bad" renders as default']);
  });
});

describe("a guard render the page never emits reports nothing", () => {
  test("a DecisionLog split probe reads a tag the page draws as text", () => {
    const content = page("<DecisionLog>", "", '- **D1** — The long first part <Pill>a sentence here. Next <Pill tone="bad">b</Pill> tail.', "", "</DecisionLog>");
    expect(html(content)).toContain("Next &lt;Pill tone=&quot;bad&quot;&gt;b</span>");
    expect(run(content)).toEqual([]);
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

  test("the last spelling of a repeated attribute is the one judged; the earlier one is reported as dropped", () => {
    const good = page('<Callout tone="success" tone="good">', "x", "</Callout>");
    expect(html(good)).toContain('<div class="callout callout-good">');
    expect(run(good).map((f) => [f.check, f.message])).toEqual([
      ["component-attr", 'Callout tone="success" is given twice; the last one, tone="good", wins'],
    ]);
    const bad = page('<Callout tone="good" tone="success">', "x", "</Callout>");
    expect(html(bad)).toContain('<div class="callout callout-info">');
    expect(run(bad).map((f) => [f.check, f.message])).toEqual([
      ["component-attr", 'Callout tone="good" is given twice; the last one, tone="success", wins'],
      ["component-value", 'Callout tone="success" renders as info'],
    ]);
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
    const findings = checkComponents("plans/x.mdx", page('<Callout tone="success">', "x", "</Callout>"), disagreeing);
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

  test("reports block tags with their raw attributes", () => {
    const seen: ObservedComponentTag[] = [];
    observeComponentTags((t) => seen.push(t), () => renderWikiHtml(["", '<Callout tone="x" bogus="y">', "z", "</Callout>"].join("\n"), () => undefined));
    expect(seen).toEqual([{ name: "Callout", rawAttrs: ' tone="x" bogus="y"', inline: false }]);
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

/** A render seam that counts its calls and renders like the reader. */
const counting = () => {
  const seam = Object.assign((content: string) => (seam.calls++, html(content)), { calls: 0 });
  return seam;
};

describe("a page with no tag the check could judge is not rendered", () => {
  test("tags without attributes, prose and a closed tag render nothing; an attribute or a bare Meter does", () => {
    const seam = counting();
    for (const content of [
      page("<Callout>", "x", "</Callout>"),
      page("<Verdict>x</Verdict> and a < b, <Pill/> and <Fold >"),
      page("no tags at all"),
    ]) {
      expect(checkComponents("plans/x.mdx", content, seam)).toEqual([]);
    }
    expect(seam.calls).toBe(0);
    expect(checkComponents("plans/x.mdx", page("<Meter>", "Coverage", "</Meter>"), seam).map((f) => f.message)).toEqual(["Meter has no value; its label renders as plain text"]);
    expect(seam.calls).toBeGreaterThan(0);
    const before = seam.calls;
    expect(checkComponents("plans/x.mdx", page('<Fold\n  title="x">', "y", "</Fold>"), seam)).toEqual([]);
    expect(seam.calls).toBeGreaterThan(before);
  });
});

describe("a repeat call is served from the memo", () => {
  test("the same relPath and content render once; another content or relPath renders again", () => {
    const seam = counting();
    const content = page('<Callout tone="success">', "x", "</Callout>");
    const first = checkComponents("plans/x.mdx", content, seam);
    const calls = seam.calls;
    expect(calls).toBe(2);
    first[0]!.message = "changed by the caller";
    const second = checkComponents("plans/x.mdx", content, seam);
    expect(seam.calls).toBe(calls);
    expect(second.map((f) => [f.line, f.message])).toEqual([[5, 'Callout tone="success" renders as info']]);
    checkComponents("plans/x.mdx", content.replace("x\n</Callout>", "y\n</Callout>"), seam);
    expect(seam.calls).toBe(calls + 2);
    expect(checkComponents("plans/y.mdx", content, seam).map((f) => f.relPath)).toEqual(["plans/y.mdx"]);
    expect(seam.calls).toBe(calls + 4);
  });

  test("past the cap the oldest entry is evicted", () => {
    const max = lintComponents.COMPONENT_MEMO_MAX;
    expect(max).toBe(2000);
    let calls = 0;
    const seam = () => void calls++;
    const nth = (i: number) => page(`<Pill tone="t${i}">p</Pill>`);
    for (let i = 0; i <= max; i++) checkComponents("plans/x.mdx", nth(i), seam);
    expect(calls).toBe(max + 1);
    checkComponents("plans/x.mdx", nth(max), seam);
    expect(calls).toBe(max + 1);
    checkComponents("plans/x.mdx", nth(0), seam);
    expect(calls).toBe(max + 2);
  });
});

describe("a finding prints the value as written, never a parked sentinel", () => {
  test("a wikilink and a code span in a located tag's attributes", () => {
    const linked = checkComponents("plans/x.mdx", page('<Callout tone="[[Page]]" see="[[Other|x]]">', "x", "</Callout>"));
    expect(linked.map((f) => [f.line, f.message])).toEqual([
      [5, 'Callout see="[[Other|x]]" is not a Callout attribute; the renderer drops it'],
      [5, 'Callout tone="[[Page]]" renders as info'],
    ]);
    const coded = checkComponents("plans/x.mdx", page('Text <Pill tone="`bad`">x</Pill>'));
    expect(coded.map((f) => [f.line, f.message])).toEqual([[5, 'Pill tone="`bad`" renders as default']]);
    expect(JSON.stringify([...linked, ...coded])).not.toContain("\\u0000");
  });

  test("a parked span holding a quote ends the source value early: the finding prints … instead", () => {
    const linked = checkComponents("plans/x.mdx", page('<Callout tone="[[a"b]]">', "x", "</Callout>"));
    expect(linked.map((f) => [f.line, f.message])).toEqual([[5, 'Callout tone="…" renders as info']]);
    const coded = checkComponents("plans/x.mdx", page('Text <Pill tone="`a"b`">p</Pill>'));
    expect(coded.map((f) => [f.line, f.message])).toEqual([[5, 'Pill tone="…" renders as default']]);
    const normal = checkComponents("plans/x.mdx", page('<Callout tone="[[Page]] and `x`">', "x", "</Callout>"));
    expect(normal.map((f) => [f.line, f.message])).toEqual([[5, 'Callout tone="[[Page]] and `x`" renders as info']]);
  });

  test("an unlocated tag prints … for a parked part", () => {
    const found = checkComponents("plans/x.mdx", page('<Callout tone="[[Page]] x">', "x", "</Callout>"), disagreeing);
    expect(found.map((f) => [f.line, f.message])).toEqual([[undefined, 'Callout tone="… x" renders as info']]);
    expect(JSON.stringify(found)).not.toContain("\\u0000");
  });
});

describe("a repeated attribute: every dropped spelling is a finding", () => {
  test("a listed attribute given twice: the earlier spelling, on its line", () => {
    const content = page('A <Pill tone="bad" tone="warn">p</Pill>');
    expect(html(content)).toContain('<span class="pill pill-warn">p</span>');
    expect(run(content).map((f) => [f.check, f.line, f.message, f.detail])).toEqual([
      ["component-attr", 5, 'Pill tone="bad" is given twice; the last one, tone="warn", wins', "Write tone once."],
    ]);
  });

  test("a listed attribute given three times: both earlier spellings", () => {
    const content = page('<Callout tone="good" tone="bad" tone="warn">', "x", "</Callout>");
    expect(html(content)).toContain('<div class="callout callout-warn">');
    expect(lines(content)).toEqual([
      '5 Callout tone="good" is given 3 times; the last one, tone="warn", wins',
      '5 Callout tone="bad" is given 3 times; the last one, tone="warn", wins',
    ]);
  });

  test("an unlisted attribute given twice: both spellings are dropped, both reported", () => {
    const content = page('A <Pill foo="1" foo="2">p</Pill>');
    expect(html(content)).toBe(html(page('A <Pill>p</Pill>')));
    expect(lines(content)).toEqual([
      '5 Pill foo="1" is not a Pill attribute; the renderer drops it',
      '5 Pill foo="2" is not a Pill attribute; the renderer drops it',
    ]);
  });

  test("the unlocated path reports the same spellings", () => {
    const content = page('A <Pill tone="bad" tone="warn">p</Pill> <Pill foo="1" foo="2">q</Pill>');
    expect(checkComponents("plans/x.mdx", content, disagreeing).map((f) => [f.line, f.message])).toEqual([
      [undefined, 'Pill tone="bad" is given twice; the last one, tone="warn", wins'],
      [undefined, 'Pill foo="1" is not a Pill attribute; the renderer drops it'],
      [undefined, 'Pill foo="2" is not a Pill attribute; the renderer drops it'],
    ]);
  });
});

describe("a Lane kind and a Verdict value: the message says what the page shows", () => {
  const inMoves = (attrs: string) => page("<NextMoves>", "", `<Lane ${attrs}>`, "", "- step", "", "</Lane>", "", "</NextMoves>");
  const stray = (attrs: string) => page(`<Lane ${attrs}>`, "", "- step", "", "</Lane>");

  test("in a NextMoves block an unknown kind renders and counts exactly as a waiting lane", () => {
    const claude = html(inMoves('kind="claude"'));
    expect(claude).toContain('class="nm-lane nm-waiting nm-kind-unknown" data-kind="waiting"');
    expect(claude.replace(" nm-kind-unknown", "")).toBe(html(inMoves('kind="waiting"')));
    expect(lines(inMoves('kind="claude"'))).toEqual(['7 Lane kind="claude" is not a lane kind; the lane renders as a waiting lane']);
    expect(lines(inMoves('kind="claude" who="Claude"'))).toEqual(['7 Lane kind="claude" is not a lane kind; the lane renders as a waiting lane']);
  });

  test("outside a NextMoves block a lane with a who reads no kind: no finding", () => {
    const shown = html(stray('kind="claude" who="Rune"'));
    expect(shown).toBe(html(stray('kind="you" who="Rune"')));
    expect(shown).toBe(html(stray('who="Rune"')));
    expect(run(stray('kind="claude" who="Rune"'))).toEqual([]);
  });

  test("outside a NextMoves block a lane with no who takes a waiting lane's label", () => {
    const shown = html(stray('kind="claude"'));
    expect(shown).toBe(html(stray('kind="waiting"')));
    expect(shown).not.toBe(html(stray('kind="you"')));
    expect(shown).not.toContain("nm-lane");
    expect(lines(stray('kind="claude"'))).toEqual([
      '5 Lane kind="claude" is not a lane kind; its label is a waiting lane\'s',
    ]);
  });

  const direct = "is not a lane kind; the lane renders as a waiting lane";
  const label = "is not a lane kind; its label is a waiting lane's";
  const lane = (attrs: string) => [`<Lane ${attrs}>`, "", "- step", "", "</Lane>"];
  const wrap = (open: string, close: string, attrs: string) => page(open, "", ...lane(attrs), "", close);

  test("a lane of a NextMoves block in a settled section renders as a waiting lane and counts nowhere", () => {
    for (const [open, close] of [
      ["<Historic>", "</Historic>"],
      ['<Callout resolved="2026-10-01">', "</Callout>"],
    ] as const) {
      const inSettled = (attrs: string) => page(open, "", "<NextMoves>", "", ...lane(attrs), "", "</NextMoves>", "", close);
      const out = html(inSettled('kind="claude"'));
      expect(out).toContain('class="nm-lane nm-waiting nm-kind-unknown" data-kind="waiting"');
      expect(out.replace(" nm-kind-unknown", "")).toBe(html(inSettled('kind="waiting"')));
      expect(countedNextMovesLanes(parseBlocks(splitFrontmatter(inSettled('kind="claude"')).body)).lanes).toEqual([]);
      expect(run(inSettled('kind="claude"')).map((f) => f.message)).toEqual([`Lane kind="claude" ${direct}`]);
    }
  });

  test("a lane in a Fold inside a NextMoves block is no lane of it: only its label reads the kind", () => {
    const inFold = (attrs: string) => page("<NextMoves>", "", "<Fold>", "", ...lane(attrs), "", "</Fold>", "", "</NextMoves>");
    const out = html(inFold('kind="claude"'));
    expect(out).not.toContain("nm-lane");
    expect(out).toBe(html(inFold('kind="waiting"')));
    expect(out).not.toBe(html(inFold('kind="you"')));
    expect(run(inFold('kind="claude"')).map((f) => f.message)).toEqual([`Lane kind="claude" ${label}`]);
    expect(html(inFold('kind="claude" who="Rune"'))).toBe(html(inFold('kind="you" who="Rune"')));
    expect(run(inFold('kind="claude" who="Rune"'))).toEqual([]);
  });

  test("a NextMoves nested in another is text, so its lane is a lane of the outer block", () => {
    const nested = (attrs: string) => wrap("<NextMoves>\n\n<NextMoves>", "</NextMoves>\n\n</NextMoves>", attrs);
    const out = html(nested('kind="claude"'));
    expect(out).toContain('class="nm-lane nm-waiting nm-kind-unknown" data-kind="waiting"');
    expect(out.replace(" nm-kind-unknown", "")).toBe(html(nested('kind="waiting"')));
    expect(run(nested('kind="claude"')).map((f) => f.message)).toEqual([`Lane kind="claude" ${direct}`]);
  });

  test("a stray lane with a role takes its label from the kind, whatever its who", () => {
    const shown = html(stray('kind="claude" role="fag" who="Rune"'));
    expect(shown).toBe(html(stray('kind="waiting" role="fag" who="Rune"')));
    expect(shown).not.toBe(html(stray('kind="you" role="fag" who="Rune"')));
    expect(run(stray('kind="claude" role="fag" who="Rune"')).map((f) => f.message)).toEqual([`Lane kind="claude" ${label}`]);
  });

  test("a stray lane with a blank who has no who: its label is the kind's", () => {
    const shown = html(stray('kind="claude" who=" "'));
    expect(shown).toBe(html(stray('kind="waiting" who=" "')));
    expect(shown).not.toBe(html(stray('kind="you" who=" "')));
    expect(run(stray('kind="claude" who=" "')).map((f) => f.message)).toEqual([`Lane kind="claude" ${label}`]);
  });

  test("a Verdict value that folds to yes renders as yes and is no finding", () => {
    for (const v of ["Yes", " yes ", "YES"]) {
      const content = page(`A <Verdict value="${v}"/> b`);
      expect({ v, html: html(content) }).toEqual({ v, html: html(page('A <Verdict value="yes"/> b')) });
      expect({ v, found: run(content) }).toEqual({ v, found: [] });
    }
  });

  test("a Verdict value that folds to no renders as yes, and the message says it is not no", () => {
    for (const v of ["NO", " No "]) {
      const content = page(`A <Verdict value="${v}"/> b`);
      expect(html(content)).toBe(html(page('A <Verdict value="yes"/> b')));
      expect(html(content)).not.toBe(html(page('A <Verdict value="no"/> b')));
      expect(run(content).map((f) => [f.message, f.detail])).toEqual([
        [`Verdict value=${JSON.stringify(v)} renders as yes, not no`, "Accepted: yes|no. Did you mean no?"],
      ]);
    }
  });
});

describe("an enum value that folds to the default renders as written and is no finding", () => {
  /** One page per enum attribute, holding one tag with `v` as that attribute's value. */
  const pages: Record<string, (v: string) => string> = {
    "Callout.tone": (v) => page(`<Callout tone="${v}">`, "x", "</Callout>"),
    "Verdict.value": (v) => page(`A <Verdict value="${v}"/> b`),
    "Pill.tone": (v) => page(`A <Pill tone="${v}">p</Pill> b`),
    "Meter.tone": (v) => page(`<Meter value="3" tone="${v}">L</Meter>`),
    "Fact.v": (v) => page(`A <Fact n="1" v="${v}">c</Fact> b`),
    "Lane.kind": (v) => page("<NextMoves>", "", `<Lane kind="${v}">`, "", "- s", "", "</Lane>", "", "</NextMoves>"),
  };
  const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const enumAttrs = Object.entries(COMPONENT_SPEC).flatMap(([name, spec]) =>
    Object.entries(spec.attrs as Record<string, { enum?: readonly string[]; default?: string | number }>)
      .filter(([, a]) => a.enum)
      .map(([attr, a]) => ({ key: `${name}.${attr}`, enum: a.enum!, def: String(a.default) })),
  );

  test("every enum attribute has a page here", () => {
    expect(enumAttrs.map((a) => a.key).sort()).toEqual(Object.keys(pages).sort());
  });

  for (const { key, enum: values, def } of enumAttrs) {
    const other = values.find((v) => v !== def)!;
    const variants: [string, string][] = [
      [def, def],
      [upperFirst(def), def],
      [def.toUpperCase(), def],
      [` ${def} `, def],
      [upperFirst(other), other],
    ];
    test(`${key}: ${variants.map(([v]) => JSON.stringify(v)).join(", ")}`, () => {
      const at = pages[key]!;
      for (const [v, folded] of variants) {
        const out = html(at(v));
        const found = run(at(v)).map((f) => f.message);
        if (out === html(at(folded))) {
          expect({ key, v, found }).toEqual({ key, v, found: [] });
        } else {
          expect({ key, v, asDefault: out === html(at(def)), folded }).toEqual({ key, v, asDefault: true, folded: other });
          expect({ key, v, found }).toEqual({ key, v, found: [`${key.split(".")[0]} ${key.split(".")[1]}=${JSON.stringify(v)} renders as ${def}, not ${other}`] });
        }
      }
    });
  }
});
