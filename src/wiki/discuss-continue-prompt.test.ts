/**
 * «Continue in Claude Code»'s prompt (Discuss P3, `renderContinuePrompt`):
 * the page path, each turn's passage, question and answer in order, and the
 * bound that drops the oldest answers first and never the handed-over turn.
 */
import { describe, expect, test } from "bun:test";
import { CONTINUE_PROMPT_MAX, renderContinuePrompt, type ContinueTurn } from "./discuss-prompt.ts";

const turn = (seq: number, over: Partial<ContinueTurn> = {}): ContinueTurn => ({
  seq,
  selection: "The ferry leaves at nine.",
  location: { found: "exact", fromLine: 12, toLine: 12 },
  question: `Question ${seq}?`,
  answer: `Answer ${seq}.`,
  endState: "done",
  pageChanged: false,
  ...over,
});

describe("renderContinuePrompt", () => {
  test("the path, then every turn oldest first, with where its passage is", () => {
    const p = renderContinuePrompt({ path: "/w/plans/ferry.mdx", turns: [turn(2, { selection: null }), turn(1)] });
    expect(p).toContain("Page: /w/plans/ferry.mdx");
    expect(p.indexOf("Turn 1 (passage, line 12):")).toBeLessThan(p.indexOf("Turn 2 (about the whole page):"));
    expect(p).toContain("> The ferry leaves at nine.");
    expect(p).toContain("Question 2?");
    expect(p).toContain("Answer 1.");
    expect(p.trimEnd().endsWith("show me the edit before you write it.")).toBe(true);
  });

  test("a turn that did not finish says how it ended; a section match is not stated as the passage's lines", () => {
    const p = renderContinuePrompt({ path: "/p", turns: [turn(1, { endState: "timeout", answer: "", location: { found: "section", fromLine: 4, toLine: 9 } })] });
    expect(p).toContain("Answer (the turn ended timeout):\n(none)");
    expect(p).toContain("not placed exactly; in the section at lines 4–9");
  });

  test("a turn whose page has changed since: no stored lines, the change said instead; other turns keep theirs", () => {
    const p = renderContinuePrompt({ path: "/p", turns: [turn(1, { pageChanged: true }), turn(2, { pageChanged: false, location: { found: "exact", fromLine: 30, toLine: 31 } })] });
    expect(p).toContain("Turn 1 (passage, lines not given: the page has changed since this turn):");
    expect(p).not.toContain("line 12");
    expect(p).toContain("Turn 2 (passage, lines 30–31):");
  });

  test("over the bound: the oldest answers go first, the last turn stays whole", () => {
    const long = "x".repeat(2900);
    const turns = Array.from({ length: 8 }, (_, k) => turn(k + 1, { answer: `${long} end ${k + 1}` }));
    const p = renderContinuePrompt({ path: "/p", turns });
    expect(p.length).toBeLessThanOrEqual(CONTINUE_PROMPT_MAX);
    expect(p).toContain("Answer: (left out to fit)");
    expect(p).toContain("end 8");
    expect(p).not.toContain("end 1");
  });
  test("a trace turn (no page): the key, the wiki and how to list the mentions again; no page wording", () => {
    const trace = { wiki: "kode", root: "/w/kode", key: "MEL-77", mentionsUrl: "http://127.0.0.1:3010/api/wiki/mentions?wiki=kode&key=MEL-77" };
    const p = renderContinuePrompt({ path: null, trace, turns: [turn(1, { selection: null, location: null }), turn(2, { selection: null, location: null })] });
    expect(p).not.toContain("Page:");
    expect(p).toContain("Key: MEL-77");
    expect(p).toContain("Wiki: kode (/w/kode)");
    expect(p).toContain("git -C '/w/kode' grep -n -w -F -e 'MEL-77'");
    expect(p).toContain("http://127.0.0.1:3010/api/wiki/mentions?wiki=kode&key=MEL-77");
    expect(p).toContain("Turn 1:\nQuestion: Question 1?");
    expect(p).not.toContain("about the whole page");
    expect(p).not.toContain("this wiki page");
    expect(p).not.toContain("If the page turns out to be wrong");
    expect(p.trimEnd().endsWith("Go on from the last answer.")).toBe(true);
  });

  test("a trace key with a quote is quoted for the shell", () => {
    const p = renderContinuePrompt({ path: null, trace: { wiki: "kode", root: "/w/kode", key: "it's", mentionsUrl: "u" }, turns: [turn(1, { selection: null })] });
    expect(p).toContain("grep -n -w -F -e 'it'\\''s'");
  });
});
