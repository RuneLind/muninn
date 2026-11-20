/**
 * `resolveDiscussEdit`: the wiki agent's one edit against a page's text — the
 * refusals the design names (frontmatter, a block component's tag line, an
 * inline component tag, inside a fact wrapper, across a wrapper's boundary, a
 * quoted wrapper tag, a double match) and a splice that leaves every wrapper
 * byte-identical. Invented pages only.
 */
import { describe, expect, test } from "bun:test";
import { resolveDiscussEdit, type DiscussEditPlan, type DiscussEditRefusal } from "./discuss-apply.ts";

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
    expect(r.code).toBe("inline-component");
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
    expect(code("The ferry leaves at nine.\n```")).toBe("new-fence");
    expect(code("The ferry leaves at nine.\n\n~~~\nx\n~~~")).toBe("new-fence");
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
    expect(code('is <Pill tone="o', 'is <Pill tone="bad')).toBe("inline-component");
  });
  test("the end of a tag and the prose after it", () => {
    expect(code('ok">green', 'warn">red')).toBe("inline-component");
  });
  test("the inside of a self-closing tag", () => {
    expect(code('env="X" /', 'env="Y" /')).toBe("inline-component");
  });
  test("the tail of a tag whose quoted value holds a >", () => {
    expect(code('b">quoted', 'c">quoted')).toBe("inline-component");
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
