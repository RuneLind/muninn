import { describe, expect, test } from "bun:test";
import { checkRuleTrees } from "./lint-rule-tree.ts";
import { checkPageText, LINT_CHECKS } from "./lint.ts";

const page = { relPath: "plans/loans.mdx" };
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("lint check 18 (rule-tree)", () => {
  test("is a registered check key", () => {
    expect(LINT_CHECKS).toContain("rule-tree");
  });

  test("names the tree by its title and the item by its line, past the frontmatter", () => {
    const text = [
      "---",
      "title: Loans",
      "---",
      "# Loans",
      "",
      '<RuleTree title="Can the book be [[renewal|renewed]]?" outcomes="Renew=good">',
      "",
      "- Is the book reserved?",
      "  - *Yes:* → Return — LIB-101",
      "  - *No:* → Renew — LIB-101",
      "",
      "</RuleTree>",
    ].join("\n");
    const fs = checkRuleTrees(page, text);
    expect(fs.map((f) => [f.message, f.line, f.severity])).toEqual([
      ['<RuleTree title="Can the book be renewed?"> outcome "Return" has no tone in outcomes, first at leaf «Yes: → Return — LIB-101»', lineOf(text, "*Yes:*"), undefined],
      [
        '<RuleTree title="Can the book be renewed?"> case LIB-101 is on 2 leaves that do not each name a different year: «Yes: → Return — LIB-101», «No: → Renew — LIB-101»',
        lineOf(text, "*No:*"),
        undefined,
      ],
    ]);
    expect(fs.every((f) => f.check === "rule-tree" && f.relPath === page.relPath)).toBe(true);
  });

  test("two trees: each finding carries its own tree's title and line", () => {
    const text = [
      '<RuleTree title="First" outcomes="Renew=good">',
      "",
      "- → Renew",
      "- → Return",
      "",
      "</RuleTree>",
      "",
      '<RuleTree title="Second" outcomes="Renew=good">',
      "",
      "- → Renew",
      "- → Return",
      "",
      "</RuleTree>",
    ].join("\n");
    const fs = checkRuleTrees(page, text);
    expect(fs.map((f) => [f.message.split(">")[0], f.line])).toEqual([
      ['<RuleTree title="First"', 4],
      ['<RuleTree title="Second"', 11],
    ]);
  });

  test("a no-list block is a warning on its tag line; info stays info", () => {
    const text = ['<RuleTree title="Empty">', "", "Nothing here.", "", "</RuleTree>", "", '<RuleTree outcomes="Renew=good;Extend=warn">', "", "- → Renew", "", "</RuleTree>"].join("\n");
    expect(checkRuleTrees(page, text).map((f) => [f.message, f.line, f.severity])).toEqual([
      ['<RuleTree title="Empty"> holds no list; it renders as written', 1, undefined],
      ["<RuleTree> outcomes names no leaf outcome: Extend", 7, "info"],
    ]);
  });

  test("a tree quoted in a code fence is not read, and does not shift lines", () => {
    const text = [
      "```mdx",
      '<RuleTree title="Quoted">',
      "- → Return",
      "</RuleTree>",
      "```",
      "",
      '<RuleTree title="Real" outcomes="Renew=good">',
      "",
      "- → Return",
      "",
      "</RuleTree>",
    ].join("\n");
    expect(checkRuleTrees(page, text).map((f) => [f.message.split(">")[0], f.line])).toEqual([
      ['<RuleTree title="Real"', 7],
      ['<RuleTree title="Real"', 9],
    ]);
  });

  test("a tree nested in a Fold is read", () => {
    const text = ['<Fold title="More">', "", '<RuleTree title="Inner" outcomes="Renew=good">', "", "- → Return", "", "</RuleTree>", "", "</Fold>"].join("\n");
    expect(checkRuleTrees(page, text).map((f) => f.line)).toEqual([3, 5]);
  });

  test("on a page with a CaseBoard, a leaf's grammar ids count beside an id the lint cannot see", () => {
    const tree = ['<RuleTree title="T" outcomes="Renew=good">', "", "- *A:* → Renew — LIB-101, loan-7", "- *B:* → Renew — LIB-101, loan-7", "", "</RuleTree>"];
    const cases = (text: string) => checkRuleTrees(page, text).map((f) => f.message).filter((m) => m.includes(" is on "));
    expect(cases(['<CaseBoard src="cases.yaml" />', "", ...tree].join("\n"))).toEqual([
      '<RuleTree title="T"> case LIB-101 is on 2 leaves that do not each name a different year: «A: → Renew — LIB-101, loan-7», «B: → Renew — LIB-101, loan-7»',
    ]);
    // With no board on the page, loan-7 is text and the leaf names no cases.
    expect(cases(tree.join("\n"))).toEqual([]);
    // A board quoted in a fence is no board.
    expect(cases(["```", '<CaseBoard src="cases.yaml" />', "```", "", ...tree].join("\n"))).toEqual([]);
  });

  test.each(["*→ Renew*", "_→ Renew_", "→ [Renew](http://x)"])("%s reads the outcome Renew", (leaf) => {
    const text = (outcomes: string) => [`<RuleTree title="T" outcomes="${outcomes}">`, "", `- ${leaf} — LIB-1`, "", "</RuleTree>"].join("\n");
    expect(checkRuleTrees(page, text("Renew=good"))).toEqual([]);
    expect(checkRuleTrees(page, text("Return=good")).map((f) => f.message)).toContain('<RuleTree title="T"> outcome "Renew" has no tone in outcomes, first at leaf «→ Renew — LIB-1»');
  });

  test("checkPageText runs it on an .mdx page that is not culled", () => {
    const text = ['<RuleTree title="T">', "", "- → Return", "", "</RuleTree>"].join("\n");
    const ruleTree = (fs: { check: string }[]) => fs.filter((f) => f.check === "rule-tree");
    expect(ruleTree(checkPageText({ relPath: "plans/t.mdx" }, text, []))).toHaveLength(1);
    expect(ruleTree(checkPageText({ relPath: "plans/t.mdx", culled: true }, text, []))).toEqual([]);
    expect(ruleTree(checkPageText({ relPath: "plans/t.md" }, text, []))).toEqual([]);
  });
});
