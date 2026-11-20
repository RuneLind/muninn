/**
 * `resolveDiscussEdit`: the wiki agent's one edit against a page's text — the
 * refusals the design names (frontmatter, a block component's tag line, an
 * inline component tag, inside a fact wrapper, across a wrapper's boundary, a
 * quoted wrapper tag, a double match) and a splice that leaves every wrapper
 * byte-identical. Invented pages only.
 *
 * The class check (fix round 3) at the end holds the guard to the reader: an
 * oracle renders each generated page with the reader's own `renderWikiHtml`
 * and compares what it renders live with the guard's tokens, and each
 * generated edit the guard lets through must leave the reader's markup
 * skeleton as it was.
 */
import { describe, expect, test } from "bun:test";
import { COMPONENT_NAMES } from "../format/component-spec.ts";
import { markdownMarkup } from "../format/markdown-ast.ts";
import { pageMarkup, resolveDiscussEdit, type DiscussEditPlan, type DiscussEditRefusal } from "./discuss-apply.ts";
import { renderWikiHtml } from "./render.ts";

const one = (old: string, neu: string) => ({ edits: [{ claimIndex: 0, verdict: "", old, new: neu, reason: "" }], dropped: [], overLimit: false });

const PAGE = [
  "---",
  "title: Ferry plan",
  "status_date: 2026-11-01",
  "---",
  "",
  "# Ferry plan",
  "",
  '<Fold title="The berths">',
  "",
  "The north pier takes the morning ferry.",
  "",
  "</Fold>",
  "",
  'The night route stops at <Verdict tone="ok">berth four</Verdict> on weekdays.',
  "",
  'The check reads <Fact v="ok" n="1">the frontmatter status date</Fact> and nothing else.',
  "",
  "The harbour opens at six. The harbour opens at six.",
  "",
  "- **R2, behind.** The check compares the frontmatter `status_date` with the date on the Brief's Status line.",
  "",
].join("\n");

const refused = (r: DiscussEditPlan | DiscussEditRefusal): DiscussEditRefusal => {
  if (r.ok) throw new Error(`expected a refusal, got a plan over ${JSON.stringify(r.before)}`);
  return r;
};
const planned = (r: DiscussEditPlan | DiscussEditRefusal): DiscussEditPlan => {
  if (!r.ok) throw new Error(`expected a plan, got ${r.code}: ${r.reason}`);
  return r;
};

const wrappers = (s: string) => s.match(/<\/?Fact\b[^>\n]*>/g) ?? [];

describe("resolveDiscussEdit: refused at preview", () => {
  test("old text in the frontmatter", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("status_date: 2026-11-01", "status_date: 2026-11-20"))).code).toBe("frontmatter");
  });
  test("old text on a block component's tag line", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one('<Fold title="The berths">', '<Fold title="Berths">'))).code).toBe("component-tag");
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one('title="The berths"', 'title="Berths"'))).code).toBe("component-tag");
  });
  test("a range holding an inline component tag", () => {
    const r = refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one('stops at <Verdict tone="ok">berth four</Verdict> on', "stops at berth five on")));
    expect(r.code).toBe("component-tag");
  });
  test("a range inside a fact wrapper", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("frontmatter status date", "frontmatter status_date field"))).code).toBe("fact-wrapper");
  });
  test("a range across a wrapper's boundary (it matches only with the wrapper stripped)", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("The check reads the frontmatter", "The check reads only the frontmatter"))).code).toBe("fact-wrapper");
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("status date and nothing", "status date, nothing"))).code).toBe("fact-wrapper");
  });
  test("old or new text quoting a wrapper tag", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one('<Fact v="ok" n="1">the', "the"))).code).toBe("fact-tag");
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("berth four", '<Fact v="ok">berth four</Fact>'))).code).toBe("fact-tag");
  });
  test("old text that matches twice", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("The harbour opens at six.", "The harbour opens at seven."))).code).toBe("ambiguous");
  });
  test("old text not on the page, more than one edit, and no edit", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("The ferry flies.", "x"))).code).toBe("not-found");
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", { edits: [one("a", "b").edits[0], one("c", "d").edits[0]] })).code).toBe("edit-count");
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", { edits: [{ old: "a" }] })).code).toBe("no-edit");
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", null)).code).toBe("no-edit");
  });
  test("old text in a fenced code block", () => {
    const page = "# P\n\n```\nThe ferry leaves at nine.\n```\n";
    expect(refused(resolveDiscussEdit(page, "notes/p.md", one("The ferry leaves at nine.", "At ten."))).code).toBe("fence");
  });
});

describe("resolveDiscussEdit: new text may not add markup", () => {
  // Markup changes go to Claude Code: the agent's new text is prose only.
  const page = "---\ntitle: P\n---\n\n# P\n\nThe ferry leaves at nine.\n\nThe night ferry is slow.\n";
  const bare = "The ferry leaves at nine.\n\nThe night ferry is slow.\n";
  const code = (neu: string, p = page) => refused(resolveDiscussEdit(p, "plans/p.mdx", one("The ferry leaves at nine.", neu))).code;
  test("a FactCheck tag (no word boundary after Fact)", () => {
    expect(code('The ferry leaves at nine.\n\n<FactCheck date="2026-11-20" ok="1">✅ checked</FactCheck>')).toBe("fact-tag");
  });
  test("a component tag: opening, closing, self-closing, inline", () => {
    expect(code('The ferry leaves at nine.\n\n<Fold title="x">')).toBe("new-markup");
    expect(code("The ferry leaves at nine.\n\n</Fold>")).toBe("new-markup");
    expect(code('The ferry leaves at nine. <Check env="X" />')).toBe("new-markup");
    expect(code('The ferry leaves at <Pill tone="ok">nine</Pill>.')).toBe("new-markup");
    expect(code('The ferry leaves at <Verdict tone="bad">nine</Verdict>.')).toBe("new-markup");
    expect(code('The ferry leaves at nine.\n\n<Chart kind="bars" value="x">\n\nno table\n\n</Chart>')).toBe("new-markup");
  });
  test("a tag the new text completes with the page's own characters", () => {
    const p = "# P\n\nThe route a<b is short.\n";
    expect(refused(resolveDiscussEdit(p, "plans/p.mdx", one("b is short.", 'Pill tone="ok">x is short.'))).code).toBe("new-markup");
  });
  test("a component tag in an inline code span is content", () => {
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("The ferry leaves at nine.", "Wrap it in `<Fold>`."))).after).toBe("Wrap it in `<Fold>`.");
  });
  test("a fenced-code line", () => {
    expect(code("The ferry leaves at nine.\n\n```\nx\n```")).toBe("new-fence");
  });
  test("a line the reader shows as text is prose: a lone ``` and a ~~~ pair (class check, fix round 3)", () => {
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("The ferry leaves at nine.", "The ferry leaves at nine.\n```"))).after).toBe("The ferry leaves at nine.\n```");
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("The ferry leaves at nine.", "The ferry leaves at nine.\n\n~~~\nx\n~~~"))).after).toContain("~~~");
  });
  test("a frontmatter fence that creates frontmatter", () => {
    expect(code("---\ntitle: x\n---\nThe ferry leaves at nine.", bare)).toBe("new-frontmatter");
  });
  test("a thematic break below the frontmatter is prose", () => {
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("The ferry leaves at nine.", "The ferry leaves at nine.\n\n---\n\nMore."))).after).toContain("---");
  });
});

describe("resolveDiscussEdit: a range cutting into an inline component tag", () => {
  const page = '# P\n\nThe status is <Pill tone="ok">green</Pill> today.\n\nProbe: <Check env="X" /> runs.\n\nA <Pill tone="a > b">quoted</Pill> pill.\n';
  const code = (old: string, neu: string) => refused(resolveDiscussEdit(page, "plans/p.mdx", one(old, neu))).code;
  test("the start of a tag", () => {
    expect(code('is <Pill tone="o', 'is <Pill tone="bad')).toBe("component-tag");
  });
  test("the end of a tag and the prose after it", () => {
    expect(code('ok">green', 'warn">red')).toBe("component-tag");
  });
  test("the inside of a self-closing tag", () => {
    expect(code('env="X" /', 'env="Y" /')).toBe("component-tag");
  });
  test("the tail of a tag whose quoted value holds a >", () => {
    expect(code('b">quoted', 'c">quoted')).toBe("component-tag");
  });
  test("prose between the tags applies", () => {
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("green", "amber"))).content).toContain('<Pill tone="ok">amber</Pill>');
  });
});

describe("resolveDiscussEdit: a plan", () => {
  test("splices only the old text's range in the file and leaves every wrapper byte-identical", () => {
    const old = "with the date on the Brief's Status line.";
    const p = planned(resolveDiscussEdit(PAGE, "plans/f.mdx", one(old, "with the Brief's Status line, not with the date in the frontmatter.")));
    expect(p.before).toBe(old);
    expect(PAGE.slice(p.start, p.end)).toBe(old);
    expect(p.content).toBe(PAGE.slice(0, p.start) + p.after + PAGE.slice(p.end));
    expect(wrappers(p.content)).toEqual(wrappers(PAGE));
    expect(p.fromLine).toBe(20);
    expect(p.toLine).toBe(20);
  });
  test("an edit next to a wrapper, outside it, applies and keeps the wrapper", () => {
    const p = planned(resolveDiscussEdit(PAGE, "plans/f.mdx", one("and nothing else.", "and no other field.")));
    expect(p.content).toContain('<Fact v="ok" n="1">the frontmatter status date</Fact> and no other field.');
  });
  test("a page with a BOM: the frontmatter is still a zone, and the BOM stays", () => {
    const bom = `\uFEFF${PAGE}`;
    expect(refused(resolveDiscussEdit(bom, "plans/f.mdx", one("title: Ferry plan", "title: Boat plan"))).code).toBe("frontmatter");
    const p = planned(resolveDiscussEdit(bom, "plans/f.mdx", one("The north pier", "The south pier")));
    expect(p.content.startsWith("\uFEFF---\n")).toBe(true);
    expect(p.content).toBe(bom.replace("The north pier", "The south pier"));
  });
  test("a CRLF page keeps CRLF in the replaced text", () => {
    const crlf = PAGE.replace(/\n/g, "\r\n");
    const p = planned(resolveDiscussEdit(crlf, "plans/f.mdx", one("The north pier takes the morning ferry.", "The north pier\ntakes the late ferry.")));
    expect(p.after).toBe("The north pier\r\ntakes the late ferry.");
    expect(p.content.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
  test("a component tag in an inline code span is content, not markup", () => {
    const page = "# P\n\nWrite `<Fold>` around a long list to fold it.\n";
    const p = planned(resolveDiscussEdit(page, "notes/p.mdx", one("Write `<Fold>` around a long list", "Wrap a long list in `<Fold>`")));
    expect(p.content).toBe("# P\n\nWrap a long list in `<Fold>` to fold it.\n");
  });
});

describe("resolveDiscussEdit: the collapsed tier adds no white space the range does not hold", () => {
  test("a CRLF page: an old text ending in a line break matches without it, and the new text's break is not added", () => {
    const crlf = "# T\r\n\r\nThis paragraph starts on line one\r\nand then continues on line two.\r\n\r\nSecond paragraph.\r\n";
    const p = planned(resolveDiscussEdit(crlf, "notes/t.md", one("This paragraph starts on line one\nand then continues on line two.\n", "This paragraph starts on line one\nand then goes on to line two.\n")));
    expect(p.tier).toBe("collapsed");
    expect(p.content).toBe("# T\r\n\r\nThis paragraph starts on line one\r\nand then goes on to line two.\r\n\r\nSecond paragraph.\r\n");
  });
  test("an LF page with collapsed white space", () => {
    const page = "# T\n\nPara one ends.\n\nNext para.\n";
    const p = planned(resolveDiscussEdit(page, "notes/t.md", one("Para  one ends.\n", "Para one stops.\n")));
    expect(p.tier).toBe("collapsed");
    expect(p.content).toBe("# T\n\nPara one stops.\n\nNext para.\n");
  });
  test("leading white space the range does not hold is not added either", () => {
    const page = "# T\n\nPara one ends.\n\nNext para.\n";
    const p = planned(resolveDiscussEdit(page, "notes/t.md", one("\nPara  one ends.", "\nPara one stops.")));
    expect(p.content).toBe("# T\n\nPara one stops.\n\nNext para.\n");
  });
});

describe("resolveDiscussEdit: the line ending comes from the replaced range's line", () => {
  test("an LF line on a page that also has CRLF lines keeps LF", () => {
    const page = "# T\r\n\r\nAlpha.\nBeta.\n";
    const p = planned(resolveDiscussEdit(page, "notes/t.md", one("Alpha.", "Alpha one.\nAlpha two.")));
    expect(p.content).toBe("# T\r\n\r\nAlpha one.\nAlpha two.\nBeta.\n");
  });
  test("a CRLF line on a mixed page takes CRLF", () => {
    const page = "# T\n\nAlpha.\r\nBeta.\n";
    const p = planned(resolveDiscussEdit(page, "notes/t.md", one("Alpha.", "Alpha one.\nAlpha two.")));
    expect(p.content).toBe("# T\n\nAlpha one.\r\nAlpha two.\r\nBeta.\n");
  });
});

describe("resolveDiscussEdit: line endings and edge white space (fix round 2 batch 2)", () => {
  test("an exact old text starting with a line break on a CRLF page takes the CR too: no stray CR", () => {
    const p = planned(resolveDiscussEdit("# T\r\n\r\nA.\r\nB.\r\n", "notes/t.md", one("\nB.", "\nC.")));
    expect(p.content).toBe("# T\r\n\r\nA.\r\nC.\r\n");
  });
  test("a blank line removed on a CRLF page is removed as on an LF page", () => {
    const crlf = planned(resolveDiscussEdit("# T\r\n\r\nA.\r\n\r\nB.\r\n", "notes/t.md", one("A.\n\n", "A.\n")));
    expect(crlf.content).toBe("# T\r\n\r\nA.\r\nB.\r\n");
    const lf = planned(resolveDiscussEdit("# T\n\nA.\n\nB.\n", "notes/t.md", one("A.\n\n", "A.\n")));
    expect(lf.content).toBe("# T\n\nA.\nB.\n");
    const before = planned(resolveDiscussEdit("# T\r\n\r\nA.\r\n\r\nB.\r\n", "notes/t.md", one("\n\nB.", "\nB.")));
    expect(before.content).toBe("# T\r\n\r\nA.\r\nB.\r\n");
  });
  test("an edit of edge white space the page does not hold is refused as edge-space, not no-change", () => {
    const r = refused(resolveDiscussEdit("# T\n\nA.\nB.\n", "notes/t.md", one("A.\n\n", "A.\n")));
    expect(r.code).toBe("edge-space");
    expect(r.reason).not.toContain("already says");
  });
  test("a CRLF range at the end of a file with no final line break takes CRLF from the line before", () => {
    const p = planned(resolveDiscussEdit("# T\r\n\r\nLast line", "notes/t.md", one("Last line", "Last\nline two")));
    expect(p.content).toBe("# T\r\n\r\nLast\r\nline two");
  });
  test("edge white space the page does not hold is cut from the new text no further than the new text has it", () => {
    expect(planned(resolveDiscussEdit("# T\nFoo bar.\n", "notes/t.md", one("\n\nFoo  bar.", "Foo baz."))).content).toBe("# T\nFoo baz.\n");
    expect(planned(resolveDiscussEdit("# T\n\nFoo bar.\nX\n", "notes/t.md", one("Foo  bar.\n\n", "Foo baz."))).content).toBe("# T\n\nFoo baz.\nX\n");
  });
  test("white-space-only new text is written as given", () => {
    expect(planned(resolveDiscussEdit("# T\n\nFoo  bar. Next.\n", "notes/t.md", one("Foo bar.\n", "\n"))).content).toBe("# T\n\n\n Next.\n");
  });
  test("an old text with CRLF edges counts each CRLF as one line break: a break the new text adds beyond them stays", () => {
    expect(planned(resolveDiscussEdit("# T\n\nFoo  bar.\n\nNext.\n", "notes/t.md", one("Foo bar.\r\n\r\n", "Foo baz.\n\n\n"))).content).toBe("# T\n\nFoo baz.\n\n\nNext.\n");
    expect(planned(resolveDiscussEdit("# T\n\nNext.\n\nFoo  bar.\n", "notes/t.md", one("\r\n\r\nFoo bar.", "\n\n\nFoo baz."))).content).toBe("# T\n\nNext.\n\n\nFoo baz.\n");
  });
});

describe("resolveDiscussEdit: an edit that changes nothing", () => {
  test("new text equal to old text is refused as no-change", () => {
    expect(refused(resolveDiscussEdit(PAGE, "plans/f.mdx", one("The north pier takes the morning ferry.", "The north pier takes the morning ferry."))).code).toBe("no-change");
  });
  test("a collapsed match whose new text is the file's own text is refused as no-change", () => {
    const page = "# T\n\nPara one ends.\n\nNext para.\n";
    expect(refused(resolveDiscussEdit(page, "notes/t.md", one("Para  one ends.", "Para one ends."))).code).toBe("no-change");
  });
});

describe("resolveDiscussEdit: the page's markup before and after the edit is compared as a whole", () => {
  // Fix round 2: the markup (frontmatter, fence lines, component tags outside
  // code, multi-line openers included) is read with markdown-ast's parse on the
  // page before and after the edit, and must be the same outside the range.
  test("new text that ends in one backtick in front of the page's own two builds a fence line", () => {
    const page = '# P\n\nThe ferry leaves at nine. ``\ncode\n```\n\nThe status is <Pill tone="ok">green</Pill>.\n';
    expect(refused(resolveDiscussEdit(page, "plans/p.mdx", one("The ferry leaves at nine. ", "The ferry leaves at nine.\n\n`"))).code).toBe("new-fence");
    // A backtick in the info string refuses the opener, in the reader too: prose.
    const inline = '# P\n\nThe ferry leaves at nine. ``x`` is code.\n';
    expect(planned(resolveDiscussEdit(inline, "plans/p.mdx", one("The ferry leaves at nine. ", "The ferry leaves at nine.\n\n`"))).after).toBe("The ferry leaves at nine.\n\n`");
  });
  test("deleting the opening backtick of a code span makes the tag in it live", () => {
    const fold = '# P\n\nUse `<Fold title="x">` to fold it.\n';
    expect(refused(resolveDiscussEdit(fold, "plans/p.mdx", one("Use `", "Use "))).code).toBe("new-markup");
    const pill = '# P\n\nWrite `<Pill tone="bad">` for red.\n';
    expect(refused(resolveDiscussEdit(pill, "plans/p.mdx", one("Write `", "Write "))).code).toBe("new-markup");
  });
  test("an attribute on the second line of a multi-line opener", () => {
    const chart = '# P\n\n<Chart kind="bars"\n  value="x">\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n</Chart>\n';
    expect(refused(resolveDiscussEdit(chart, "plans/p.mdx", one('value="x"', 'value="y"'))).code).toBe("component-tag");
    const fold = '# P\n\n<Fold\n  title="Old title">\n\nBody text.\n\n</Fold>\n';
    expect(refused(resolveDiscussEdit(fold, "plans/p.mdx", one('title="Old title"', 'title="New title"'))).code).toBe("component-tag");
    const pill = '# P\n\nThe status is <Pill\n  tone="ok">green</Pill> today.\n';
    expect(refused(resolveDiscussEdit(pill, "plans/p.mdx", one('tone="ok"', 'tone="bad"'))).code).toBe("component-tag");
  });
  test("prose after an unclosed <Y on the same line applies", () => {
    const page = "# P\n\nIf x <Y then the ferry leaves at nine.\n";
    for (const rel of ["plans/p.mdx", "notes/p.md"]) {
      expect(planned(resolveDiscussEdit(page, rel, one("the ferry leaves at nine.", "the ferry leaves at ten."))).content).toBe("# P\n\nIf x <Y then the ferry leaves at ten.\n");
    }
  });
  test("a name that only starts with Fact, and a Fact tag in a code span, are prose", () => {
    const page = "# P\n\nThe ferry leaves at nine.\n";
    const after = (neu: string) => planned(resolveDiscussEdit(page, "plans/p.mdx", one("The ferry leaves at nine.", neu))).after;
    expect(after("The <Factory> leaves.")).toBe("The <Factory> leaves.");
    expect(after("The <Facts list grows.")).toBe("The <Facts list grows.");
    expect(after("Quote `<Fact>` here.")).toBe("Quote `<Fact>` here.");
  });
  test("new text that starts mid-line with an inline ``` code span is not a fence", () => {
    const page = "# P\n\nThe ferry leaves at nine.\n";
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("nine.", "```x``` o'clock."))).content).toBe("# P\n\nThe ferry leaves at ```x``` o'clock.\n");
  });
  test("new text that keeps a <Placeholder> that is no component applies", () => {
    const page = "# P\n\nRun implement <SPEC> now.\n";
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("Run implement <SPEC> now.", "Run implement <SPEC> today."))).after).toBe("Run implement <SPEC> today.");
  });
  test("a line of 20,000 unclosed <Pill tags resolves in linear time", () => {
    const page = `# P\n\nThe ferry leaves at nine.\n\n${"<Pill ".repeat(20_000)}\n`;
    const t0 = performance.now();
    planned(resolveDiscussEdit(page, "plans/p.mdx", one("The ferry leaves at nine.", "The ferry leaves at ten.")));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

// ── Class check (fix round 3): the guard against the reader ─────────────────

const render = (md: string) => renderWikiHtml(md, () => undefined, { today: "2026-11-20" });
const TAG_START_RE = new RegExp(`</?(${COMPONENT_NAMES.join("|")})\\b`, "g");
const escapedTags = (html: string, name: string) => (html.match(new RegExp(`&lt;/?${name}\\b`, "g")) ?? []).length;

/** Each tag in `body` from `from` on, and whether the reader renders it live:
 *  dropping its `<` takes one escaped `&lt;Name` out of the render iff the
 *  reader printed it as text. */
function readerTags(body: string, from: number): { start: number; live: boolean }[] {
  const base = render(body);
  const out: { start: number; live: boolean }[] = [];
  TAG_START_RE.lastIndex = from;
  for (let m = TAG_START_RE.exec(body); m !== null; m = TAG_START_RE.exec(body)) {
    const without = render(body.slice(0, m.index) + body.slice(m.index + 1));
    out.push({ start: m.index, live: escapedTags(without, m[1]!) >= escapedTags(base, m[1]!) });
  }
  return out;
}

/** Per line, whether the reader shows it as fenced code (null: not probed). A
 *  word appended to each line that is neither fence-like nor a tag line lands
 *  inside a `<pre>` (or a `<Diff>`'s row) iff the line is code. */
function readerCodeLines(body: string, from: number): (boolean | null)[] {
  const lines = body.split("\n");
  let off = 0;
  const probed = lines.map((l) => {
    const at = off;
    off += l.length + 1;
    return at >= from && l.trim() !== "" && !/^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(?:`{3,}|~{3,})/.test(l) && !l.trim().startsWith("<");
  });
  const html = render(lines.map((l, i) => (probed[i] ? `${l} ZQ${i}QZ` : l)).join("\n"));
  return probed.map((p, i) => {
    if (!p) return null;
    const at = html.indexOf(`ZQ${i}QZ`);
    // A `<Diff>` renders its fence as `diff-line` rows, escaped, with no `<pre>`.
    return at < 0 ? null : html.lastIndexOf("<pre", at) > html.lastIndexOf("</pre>", at) || html.lastIndexOf('<div class="diff-line', at) > html.lastIndexOf("</div>", at);
  });
}

/**
 * Where the reader and the guard disagree on one page, the kinds that would let
 * an edit through: a tag the reader renders live with no token, a line the
 * guard reads as fenced code that the reader shows as prose (its tags would be
 * hidden) or the reverse, and a fact-check sentinel with no token. A token the
 * reader prints as text is not listed: its `lead`, `rest` and `gap` are
 * compared too, so an edit that makes it live changes the token.
 */
function parityGaps(body: string): string[] {
  const toks = pageMarkup(body);
  const from = toks[0]?.kind === "frontmatter" ? toks[0].text.length : 0;
  const gaps: string[] = [];
  const tagAt = new Set(toks.filter((t) => t.kind === "tag").map((t) => t.start));
  for (const r of readerTags(body, from)) if (r.live && !tagAt.has(r.start)) gaps.push(`live tag, no token: ${body.slice(r.start, r.start + 30)}`);
  const lines = body.split("\n");
  const fenceLine = toks.filter((t) => t.kind === "fence").map((t) => body.slice(0, t.start).split("\n").length - 1);
  const guardCode = lines.map((_, i) => {
    for (let k = 0; k < fenceLine.length; k += 2) if (i >= fenceLine[k]! && i <= (fenceLine[k + 1] ?? lines.length)) return true;
    return false;
  });
  readerCodeLines(body, from).forEach((code, i) => {
    if (code !== null && code !== guardCode[i]) gaps.push(`${code ? "reader code, guard prose" : "guard code, reader prose"}: ${lines[i]}`);
  });
  const sentinelAt = new Set(toks.filter((t) => t.kind === "sentinel").map((t) => t.start));
  for (const m of body.matchAll(/<!-- factcheck:(?:start|end) -->/g)) if (!sentinelAt.has(m.index!)) gaps.push(`sentinel, no token: ${m[0]}`);
  return gaps;
}

/** The reader's markup skeleton: every start tag that is a `pre` or carries a
 *  class (plain markdown — p, li, strong, a code span — carries none). */
const skeleton = (html: string) =>
  [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)].flatMap((m) => {
    const cls = /\bclass="([^"]*)"/.exec(m[2]!)?.[1];
    return m[1] === "pre" || cls !== undefined ? [`${m[1]}.${cls ?? ""}`] : [];
  });

const FENCE_INDENTS: [string, string][] = [["0 spaces", ""], ["1 space", " "], ["2 spaces", "  "], ["3 spaces", "   "], ["4 spaces", "    "], ["a tab", "\t"]];
const FENCE_MARKERS: [string, string][] = [["backticks", "```"], ["tildes", "~~~"]];
const FENCE_CONTAINERS: [string, string, string][] = [["no container", "", ""], ["a blockquote", "> ", "> "], ["a list item", "- ", "  "]];

describe("class check: guard vs reader on fences — indent (0-3 spaces, 4 spaces, a tab) × marker (backticks, tildes) × closed or unclosed × container (none, blockquote, list item)", () => {
  for (const [ik, ind] of FENCE_INDENTS)
    for (const [mk, m] of FENCE_MARKERS)
      for (const closed of [true, false])
        for (const [ck, first, rest] of FENCE_CONTAINERS) {
          test(`${ik}, ${mk}, ${closed ? "closed" : "unclosed"}, ${ck}`, () => {
            const lines = ["Intro words here.", "", `${first}${ind}${m}`, `${rest}${ind}Body <Pill tone="ok">alpha</Pill> and <Fact v="ok" n="1">beta</Fact> text.`];
            if (closed) lines.push(`${rest}${ind}${m}`);
            lines.push("", 'Outro <Pill tone="ok">gamma</Pill> words.', "");
            expect(parityGaps(lines.join("\n"))).toEqual([]);
          });
        }
});

test("class check: a fence inside a <Diff> component (its rows, not a <pre>)", () => {
  expect(parityGaps('Intro.\n\n<Diff>\n\n```diff\n ## Head <Pill tone="ok">x</Pill>\n-- a\n```\n\n</Diff>\n')).toEqual([]);
});

describe("class check: guard vs reader on inline code spans — opening run (1-3 backticks) × closing run (1-3 backticks)", () => {
  for (const open of [1, 2, 3])
    for (const close of [1, 2, 3])
      test(`${open} then ${close}`, () => {
        expect(parityGaps(`Lead ${"`".repeat(open)}<Pill tone="ok">x</Pill>${"`".repeat(close)} tail <Fact v="ok" n="1">y</Fact> end.\n`)).toEqual([]);
      });
});

const TAG_KINDS: [string, (rest: string) => string[]][] = [
  ["multi-line block", (r) => [`<Callout tone="warn">${r}`, "Body words.", "</Callout>"]],
  ["multi-line Fold", (r) => [`<Fold title="x">${r}`, "", "Body words.", "", "</Fold>"]],
  ["single-line block", (r) => [`<Callout tone="warn">gamma</Callout>${r}`]],
  ["inline Pill", (r) => [`<Pill tone="ok">gamma</Pill>${r}`]],
  ["self-closing", (r) => [`<Pill tone="ok" />${r}`]],
  ["multi-line opener", (r) => ["<Fold", `  title="x">${r}`, "Body words.", "</Fold>"]],
  ["inline Fact", (r) => [`<Fact v="ok" n="1">gamma</Fact>${r}`]],
  ["block Fact", (r) => [`<Fact v="ok" n="1">${r}`, "Body words.", "</Fact>"]],
];
const TAG_LEADS: [string, string][] = [["line start", ""], ["indented", "  "], ["after prose", "Words "], ["after a list marker", "- "], ["after an ordered marker", "1. "], ["after a quote marker", "> "]];
const TAG_PREVS: [string, string[]][] = [["a blank line", ["Prev words.", ""]], ["a prose line", ["Prev words."]], ["a list item", ["- prev item"]], ["a heading", ["## Prev"]], ["page start", []]];
const TAG_RESTS: [string, string][] = [["nothing", ""], ["prose", " trailing words"]];

/** The edits around a tag cell that move it (the line before joined onto it, a
 *  list marker before it, prose after its last line, a line break inside it,
 *  its body joined onto its closer), each the guard lets through that changes
 *  the reader's skeleton. */
function contextEditLeaks(page: string, prev: string[]): string[] {
  const edits: [string, string, string][] = [];
  const last = prev.filter((l) => l !== "").at(-1);
  if (last) {
    const sep = prev.at(-1) === "" ? "\n\n" : "\n";
    edits.push(["line before joined", last + sep, `${last} `], ["list marker before", last + sep, `${last}${sep}- `]);
  }
  edits.push(["prose after", "\n\nAfter words.", " more\n\nAfter words."], ["line break inside", "gamma", "gam\nma"], ["body onto closer", "Body words.\n", "Body words. "]);
  const before = JSON.stringify(skeleton(render(page)));
  const leaks: string[] = [];
  for (const [name, old, neu] of edits) {
    if (page.indexOf(old) < 0 || page.indexOf(old) !== page.lastIndexOf(old)) continue;
    const r = resolveDiscussEdit(page, "plans/p.mdx", one(old, neu));
    if (r.ok && JSON.stringify(skeleton(render(r.content))) !== before) leaks.push(name);
  }
  return leaks;
}

describe("class check: guard vs reader on tags — kind × what precedes it on its line × the line before × what follows the opener; each cell also takes the edits that move the tag", () => {
  for (const [kk, kind] of TAG_KINDS)
    for (const [lk, lead] of TAG_LEADS)
      for (const [pk, prev] of TAG_PREVS)
        for (const [rk, rest] of TAG_RESTS)
          test(`${kk}, ${lk}, after ${pk}, followed by ${rk}`, () => {
            const body = kind(rest);
            body[0] = lead + body[0];
            const page = [...prev, ...body, "", "After words.", ""].join("\n");
            expect(parityGaps(page)).toEqual([]);
            expect(contextEditLeaks(page, prev)).toEqual([]);
          });
});

describe("class check: guard vs reader on fact-check sentinels — a pair, in a fence, inline", () => {
  test.each([
    ["a pair", "Intro.\n\n<!-- factcheck:start -->\n## Fact check\nText.\n<!-- factcheck:end -->\n\nAfter.\n"],
    ["in a fence", "Intro.\n\n```\n<!-- factcheck:start -->\n```\n\nAfter.\n"],
    ["inline", "Intro <!-- factcheck:start --> mid.\n"],
  ])("%s", (_name, page) => {
    expect(parityGaps(page)).toEqual([]);
  });
});

const CC_PAGE = [
  "---",
  "title: T",
  "---",
  "",
  "Para one alpha bravo.",
  "",
  '<Fold title="x">',
  "",
  "Inside charlie delta.",
  "",
  "</Fold>",
  "",
  'Before echo <Pill tone="ok">foxtrot golf</Pill> after hotel.',
  "",
  'Claim <Fact v="ok" n="1">india juliet</Fact> kilo.',
  "",
  '<Callout tone="warn">',
  "Callout lima mike.",
  "</Callout>",
  "",
  "    ```",
  "    november oscar papa",
  "    ```",
  "",
  "```ts",
  "quebec romeo",
  "```",
  "sierra tango.",
  "",
  'Zeta <Pill tone="ok">xray</Pill> yankee.',
  "",
  'Note: <Callout tone="ok">',
  "Literal whiskey body.",
  "</Callout>",
  "",
  "    ```",
  "    dahlia elm",
  "    ```",
  "",
  "Fennel <!-- factcheck:begin --> ginger.",
  "",
].join("\n");

/** [cell, old, new, the guard's outcome]. `ok` cells must leave the reader's skeleton as it was. */
const EDIT_CELLS: [string, string, string, string][] = [
  ["prose word", "alpha bravo", "alpha bravos", "ok"],
  ["prose inside a Fold body", "charlie delta", "charlie deltas", "ok"],
  ["prose inside a Pill", "foxtrot golf", "foxtrot golfs", "ok"],
  ["prose inside a Callout", "lima mike", "lima mikes", "ok"],
  ["prose between 4-space ``` lines (the reader's prose)", "november oscar", "november oscars", "ok"],
  ["prose after a fence closer", "sierra tango", "sierra tangos", "ok"],
  ["a blank line before a block opener dropped", "bravo.\n\n", "bravo.\n", "ok"],
  ["a heading line before a block opener", "bravo.\n\n", "bravo.\n# H\n", "ok"],
  ["a list item line before a block opener", "bravo.\n\n", "bravo.\n- item\n", "ok"],
  ["an indent before a block opener", "bravo.\n\n", "bravo.\n\n    ", "ok"],
  ["a code span around a Pill's text", "foxtrot golf", "`foxtrot golf`", "ok"],
  ["a ~~~ pair (the reader's prose)", "alpha bravo.", "alpha\n~~~\nbravo.\n~~~", "ok"],
  ["a 4-space ``` pair (the reader's prose)", "alpha bravo.", "alpha\n    ```\nbravo.\n    ```", "ok"],
  ["a literal opener's prose changed", "Note: ", "Notes: ", "ok"],
  ["the line before a block opener joined onto it", "bravo.\n\n", "bravo. ", "new-markup"],
  ["a list marker before a block opener", "bravo.\n\n", "bravo.\n\n- ", "new-markup"],
  ["a quote marker before a block opener", "bravo.\n\n", "bravo.\n\n> ", "new-markup"],
  ["prose after a block opener on its line", "\n\nInside charlie", " extra\n\nInside charlie", "new-markup"],
  ["prose before a block closer on its line", "delta.\n\n", "delta.\n\nwords ", "new-markup"],
  ["prose after a block closer on its line", "\n\nBefore echo", " extra\n\nBefore echo", "new-markup"],
  ["a Callout's body joined onto its closer", "lima mike.\n", "lima mike. ", "new-markup"],
  ["a blank line inside a Pill", "foxtrot golf", "foxtrot\n\ngolf", "new-markup"],
  ["a line break inside a Pill", "foxtrot golf", "foxtrot\ngolf", "new-markup"],
  ["a heading inside a Pill", "foxtrot golf", "foxtrot\n# golf", "new-markup"],
  ["a literal opener made live: its prose moved off its line", "Note: ", "Note:\n", "new-markup"],
  ["a new Pill in prose", "alpha bravo", 'alpha <Pill tone="bad">bravo</Pill>', "new-markup"],
  ["a new Fact in prose", "alpha bravo", 'alpha <Fact v="ok" n="2">bravo</Fact>', "fact-tag"],
  ["a new Fact between 4-space ``` lines", "november oscar", '<Fact v="ok" n="1">november</Fact> oscar', "fact-tag"],
  ["a new Pill between 4-space ``` lines", "november oscar", '<Pill tone="bad">november</Pill> oscar', "new-markup"],
  ["a new Fold block between 4-space ``` lines", "november oscar papa", 'november\n<Fold title="y">\nbody\n</Fold>\noscar papa', "new-markup"],
  ["a fence closer turned into ```ts", "\nsierra", "ts\nsierra", "new-fence"],
  ["a fence closer lengthened", "\nsierra", "`\nsierra", "new-fence"],
  ["a new fence the reader renders", "alpha bravo.", "alpha\n```\nbravo.\n```", "new-fence"],
  ["a 4-space ``` line made 3-space, its closer still 4 (unclosed: prose)", "    ```\n    dahlia", "   ```\n    dahlia", "ok"],
  ["a fact-check sentinel built from the page's characters", "factcheck:begin", "factcheck:start", "fact-check-block"],
];

describe("class check: an edit the guard lets through leaves the reader's markup skeleton as it was — prose, block context (line joined, list or quote marker, prose beside a tag), line breaks inside an inline pair, new tags and fences inside and outside the reader's fences, sentinels", () => {
  test.each(EDIT_CELLS)("%s", (_cell, old, neu, want) => {
    const r = resolveDiscussEdit(CC_PAGE, "plans/p.mdx", one(old, neu));
    expect(r.ok ? "ok" : r.code).toBe(want);
    if (r.ok) expect(skeleton(render(r.content))).toEqual(skeleton(render(CC_PAGE)));
  });
});

describe("class check: the verify pass's findings, on their own pages", () => {
  test("finding 1: a live Fact between two 4-space ``` lines is refused (mimir plans/muninn-nested-claude-md-trim.mdx shape)", () => {
    const page = "# P\n\nRun this:\n\n    ```\n    rg --files | tail -n +5 | rg -v '^ '\n    ```\n\nDone.\n";
    expect(refused(resolveDiscussEdit(page, "plans/p.mdx", one("| tail -n +5 | rg -v '^ '", "| tail -n +5 | <Fact v=\"ok\" n=\"1\">rg -v '^ '</Fact>"))).code).toBe("fact-tag");
  });
  test("finding 2: a Pill between tab-indented ``` lines, and a tone changed on a Pill below an indented ``` line", () => {
    const tab = "# P\n\n\t```\n\tThe ferry leaves at nine.\n\t```\n";
    expect(refused(resolveDiscussEdit(tab, "plans/p.mdx", one("leaves at nine", 'leaves at <Pill tone="bad">nine</Pill>'))).code).toBe("new-markup");
    const below = '# P\n\n    ```\nThe status is <Pill tone="ok">green</Pill>.\n';
    expect(refused(resolveDiscussEdit(below, "plans/p.mdx", one('tone="ok"', 'tone="bad"'))).code).toBe("component-tag");
  });
  test("finding 3: joining the line before a <Fold> opener into it, and a list marker before <Callout>", () => {
    const fold = '# P\n\nThe ferry leaves at nine.\n\n<Fold title="x">\n\nBody.\n\n</Fold>\n';
    const joined = refused(resolveDiscussEdit(fold, "plans/p.mdx", one("nine.\n\n", "ten. ")));
    expect(joined.code).toBe("new-markup");
    expect(joined.reason).toContain("change where a component tag stands");
    const callout = '# P\n\nThe ferry leaves at nine.\n\n<Callout tone="warn">\nBody.\n</Callout>\n';
    expect(refused(resolveDiscussEdit(callout, "plans/p.mdx", one("nine.\n\n", "nine.\n\n- "))).code).toBe("new-markup");
  });
  test("finding 4: a fact-check sentinel the edit builds from the page's characters", () => {
    const page = "# P\n\n<!-- factcheck:begin -->\n\nThe ferry leaves at nine.\n";
    expect(refused(resolveDiscussEdit(page, "plans/p.mdx", one("factcheck:begin", "factcheck:start"))).code).toBe("fact-check-block");
  });
  test("M4 and M11: a fence closer's text is compared, not only its place", () => {
    const page = "# P\n\n```\nx\n```\nThe ferry leaves at nine.\n";
    expect(refused(resolveDiscussEdit(page, "plans/p.mdx", one("\nThe ferry", "`\nThe ferry"))).code).toBe("new-fence");
    expect(refused(resolveDiscussEdit(page, "plans/p.mdx", one("\nThe ferry", "ts\nThe ferry"))).code).toBe("new-fence");
  });
  test("M5 and M6: the old text's Fact rule reads code spans and a word boundary", () => {
    const page = "# P\n\nQuote `<Fact>` here. The <Factory> stands.\n";
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("Quote `<Fact>` here.", "Quote `<Fact>` there."))).after).toBe("Quote `<Fact>` there.");
    expect(planned(resolveDiscussEdit(page, "plans/p.mdx", one("The <Factory> stands.", "The <Factory> stood."))).after).toBe("The <Factory> stood.");
  });
});

describe("class check: pageMarkup adds the sentinels to markdownMarkup", () => {
  test("a sentinel is a token in code too, and the rest is markdownMarkup's", () => {
    const body = "Intro.\n\n<!-- factcheck:start -->\nx\n<!-- factcheck:end -->\n\n`<!-- factcheck:end -->`\n";
    expect(pageMarkup(body).filter((t) => t.kind === "sentinel").map((t) => t.start)).toEqual([8, 35, 60]);
    expect(pageMarkup(body).filter((t) => t.kind !== "sentinel")).toEqual(markdownMarkup(body));
  });
});

// ── Class check (fix round 3, widening): the edge white space an edit takes ──

const toCrlf = (s: string) => s.replace(/\n/g, "\r\n");
/** What the reader shows, line breaks and white space left out: two pages whose
 *  only difference is a paragraph split or a blank line read the same. */
const readerText = (md: string) => render(md).replace(/<br\s*\/?>/g, "").replace(/\s+/g, "");
const outcome = (r: DiscussEditPlan | DiscussEditRefusal) => (r.ok ? "ok" : r.code);
/** The codes an edit that changes the page's markup is refused with; never one
 *  that says the old text sits inside a zone, since its words matched outside. */
const MARKUP_CHANGE_CODES = ["new-fence", "new-frontmatter", "new-markup", "fact-check-block"];

const BEFORE_RANGE: [string, string | null][] = [
  ["frontmatter closer", "---\ntitle: x\n---"],
  ["fence closer", "```js\ncode\n```"],
  ["block component closer", "<Callout>\n\nInside.\n\n</Callout>"],
  ["list item", "- item one\n- item two"],
  ["table row", "| a | b |\n| - | - |\n| 1 | 2 |"],
  ["heading", "# Heading"],
  ["plain paragraph", "Plain para."],
  ["fact-check sentinel", "<!-- factcheck:start -->\nChecked.\n<!-- factcheck:end -->"],
  ["page start", null],
];
const AFTER_RANGE: [string, string | null][] = [
  ["fence opener", "```js\ncode\n```"],
  ["block component opener", "<Callout>\n\nInside.\n\n</Callout>"],
  ["list item", "- item one\n- item two"],
  ["table row", "| a | b |\n| - | - |\n| 1 | 2 |"],
  ["heading", "# Heading"],
  ["plain paragraph", "Plain para."],
  ["fact-check sentinel", "<!-- factcheck:start -->\nChecked.\n<!-- factcheck:end -->"],
  ["page end", null],
];
const EDGE_SPACE: [string, string][] = [["none", ""], ["a line break", "\n"], ["a blank line", "\n\n"], ["spaces", "  "], ["mixed", " \n\n"]];
const NEW_EDGE = ["keeps", "drops", "adds a line break to"] as const;

/**
 * One cell: a page of a neighbour block, a blank line and the edited paragraph
 * (or the paragraph at the page's start or end), and an edit whose old text
 * carries `ws` on one side of the paragraph's words. The expected result is
 * read off the page, not off the code:
 * - the page holds `ws` there: the edit is the old text with that white space
 *   replaced by the new text, as the exact tier would write it;
 * - it does not: only the words change, and a line break the new text adds
 *   beyond the old text's white space stays.
 * An edit that applies writes that result, on LF and on the page's CRLF copy
 * (with CRLF line endings, from an LF or a CRLF edit); an edit refused on one
 * is refused with the same code on the other, the code is one that names a
 * markup change, and the reader shows the result asked for differently from
 * the words-only result: a refusal needs a markup change to justify it.
 */
function edgeCell(side: "lead" | "trail", block: string | null, ws0: string, op: (typeof NEW_EDGE)[number], tier: "exact" | "collapsed") {
  const ws = side === "trail" ? [...ws0].reverse().join("") : ws0;
  const [w, w2] = ["Core para here.", "Core para there."];
  const core = tier === "exact" ? w : "Core  para here.";
  const page = side === "lead" ? (block ? `${block}\n\n` : "") + `${core}\n\nTail para.\n` : `Head para.\n\n${core}` + (block ? `\n\n${block}\n` : "\n");
  const at = page.indexOf(core);
  const [head, tail] = [page.slice(0, at), page.slice(at + core.length)];
  const old = side === "lead" ? ws + w : w + ws;
  const neu = op === "keeps" ? (side === "lead" ? ws + w2 : w2 + ws) : op === "drops" ? w2 : side === "lead" ? `${ws}\n${w2}` : `${w2}\n${ws}`;
  const held = side === "lead" ? head.endsWith(ws) : tail.startsWith(ws);
  const added = op === "adds a line break to" ? "\n" : "";
  const asked = !held
    ? side === "lead" ? head + added + w2 + tail : head + w2 + added + tail
    : side === "lead" ? head.slice(0, head.length - ws.length) + neu + tail : head + neu + tail.slice(ws.length);
  const wordsOnly = head + w2 + tail;
  const lf = resolveDiscussEdit(page, "notes/p.mdx", one(old, neu));
  for (const cr of [resolveDiscussEdit(toCrlf(page), "notes/p.mdx", one(old, neu)), resolveDiscussEdit(toCrlf(page), "notes/p.mdx", one(toCrlf(old), toCrlf(neu)))]) {
    expect(outcome(cr)).toBe(outcome(lf));
    if (lf.ok && cr.ok) expect(cr.content).toBe(toCrlf(lf.content));
  }
  if (lf.ok) expect(lf.content).toBe(asked);
  else {
    expect(MARKUP_CHANGE_CODES).toContain(lf.code);
    expect(readerText(asked)).not.toBe(readerText(wordsOnly));
  }
}

describe("class check (widening): what precedes or follows the range (frontmatter closer, fence opener/closer, block component opener/closer, list item, table row, heading, plain paragraph, fact-check sentinel, page start/end) × edge white space in the old text (none, a line break, a blank line, spaces, mixed) × what the new text does with it (keeps, drops, adds a line break) × exact or collapsed match × LF/CRLF", () => {
  for (const [side, list] of [["lead", BEFORE_RANGE], ["trail", AFTER_RANGE]] as const) {
    for (const [where, block] of list) {
      for (const [wsName, ws] of EDGE_SPACE) {
        for (const op of NEW_EDGE) {
          for (const tier of ["exact", "collapsed"] as const) {
            test(`${side === "lead" ? "after" : "before"} a ${where}, ${wsName} ${side === "lead" ? "leading" : "trailing"}, the new text ${op} it, ${tier}`, () => edgeCell(side, block, ws, op, tier));
          }
        }
      }
    }
  }
});

describe("class check (widening): the verify pass's findings and surviving mutants", () => {
  test("finding 1: a blank-line-led old text right after the frontmatter applies and leaves the frontmatter as it was, LF and CRLF", () => {
    const page = "---\ntitle: x\n---\n\nFirst para here.\n";
    for (const p of [page, toCrlf(page)]) {
      const r = planned(resolveDiscussEdit(p, "notes/p.md", one("\n\nFirst para here.", "\n\nFirst para there.")));
      expect(r.content).toBe(p === page ? "---\ntitle: x\n---\n\nFirst para there.\n" : toCrlf("---\ntitle: x\n---\n\nFirst para there.\n"));
      expect(r.before).toBe("First para here.");
    }
    // Dropping the blank line keeps the frontmatter's own line break; joining onto its closer is a frontmatter change.
    expect(planned(resolveDiscussEdit(page, "notes/p.md", one("\n\nFirst para here.", "\nFirst para there."))).content).toBe("---\ntitle: x\n---\nFirst para there.\n");
    for (const p of [page, toCrlf(page)]) expect(refused(resolveDiscussEdit(p, "notes/p.md", one("\n\nFirst  para here.", "First para there."))).code).toBe("new-frontmatter");
  });
  test("finding 2: a blank-line-led old text after a closing fence resolves on the CRLF copy as on the LF copy", () => {
    const page = "# T\n\n```js\ncode\n```\n\nAfter  para.\n";
    const lf = planned(resolveDiscussEdit(page, "notes/p.md", one("\n\nAfter para.", "\n\nAfter text.")));
    const cr = planned(resolveDiscussEdit(toCrlf(page), "notes/p.md", one("\n\nAfter para.", "\n\nAfter text.")));
    expect(lf.content).toBe("# T\n\n```js\ncode\n```\n\nAfter text.\n");
    expect(cr.content).toBe(toCrlf(lf.content));
    for (const p of [page, toCrlf(page)]) expect(refused(resolveDiscussEdit(p, "notes/p.md", one("\n\nAfter para.", "After text."))).code).toBe("new-fence");
  });
  test("M18: the markup guard reads the range the edit replaces, edge white space included", () => {
    const callout = "# T\n\nPara  x.\n\n<Callout>\n\nIn.\n\n</Callout>\n";
    expect(refused(resolveDiscussEdit(callout, "notes/p.mdx", one("Para x.\n\n", "Para y."))).code).toBe("new-markup");
    const fence = toCrlf("# T\n\nPara  x.\n\n```js\ncode\n```\n");
    expect(refused(resolveDiscussEdit(fence, "notes/p.md", one("Para x.\n\n", "Para y."))).code).toBe("new-fence");
  });
  test("M19 and M20: an exact match's edge white space is not widened over the page's next line break", () => {
    expect(planned(resolveDiscussEdit("A.\n\nB.\n", "notes/p.md", one("\nB.", "\nC."))).content).toBe("A.\n\nC.\n");
    expect(planned(resolveDiscussEdit("A.\n\nB.\n", "notes/p.md", one("A.\n", "C.\n"))).content).toBe("C.\n\nB.\n");
  });
  test("M13: an edit of leading edge white space the page does not hold is refused as edge-space", () => {
    expect(refused(resolveDiscussEdit("# T\n\nA.\nB.\n", "notes/p.md", one("\n\nB.", "\nB."))).code).toBe("edge-space");
  });
  test("M21: an old text's CRLF edges are read as LF breaks on an LF page", () => {
    expect(planned(resolveDiscussEdit("# T\n\nFoo  bar.\n\nNext.\n", "notes/p.md", one("Foo bar.\r\n\r\n", "Foo baz.\r\n"))).content).toBe("# T\n\nFoo baz.\nNext.\n");
  });
  test("trailing edge white space that takes a fence line's indent is a fence change, not an old text inside the fence", () => {
    const page = "# T\n\nPara  x.\n\n  ```js\n  code\n  ```\n";
    for (const p of [page, toCrlf(page)]) expect(refused(resolveDiscussEdit(p, "notes/p.md", one("Para x.\n\n  ", "Para y."))).code).toBe("new-fence");
    // Kept, the indent stays out of the range.
    for (const p of [page, toCrlf(page)]) expect(planned(resolveDiscussEdit(p, "notes/p.md", one("Para x.\n\n  ", "Para y.\n\n  "))).content).toBe(p.replace("Para  x.", "Para y."));
  });
  test("a white-space-only new text is kept once, not by both edges", () => {
    expect(planned(resolveDiscussEdit("A.\n\nB.\n\nC.\n", "notes/p.md", one("\nB.\n", "\n"))).content).toBe("A.\n\n\nC.\n");
  });
  test("an exact old text that takes the line break after a fact-check sentinel is refused, as its CRLF copy is", () => {
    const page = "Intro.\n\n<!-- factcheck:start -->\nChecked.\n<!-- factcheck:end -->\n\nNext para.\n";
    for (const p of [page, toCrlf(page)]) expect(refused(resolveDiscussEdit(p, "notes/p.md", one("\n\nNext para.", "Next text."))).code).toBe("fact-check-block");
  });
});
