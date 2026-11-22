import { describe, expect, test } from "bun:test";
import { closeCardEdit, type CloseRuling } from "./question-close.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { eachComponent, lastCanonicalPhrase, parseQuestionPage } from "./question.ts";
import { parseLogItem } from "./genre-lists.ts";
import { codeSpanContent, lineCodeSpanRanges } from "./code-spans.ts";
import { checkPageText } from "../wiki/lint.ts";
import { analyzeDecisionChains } from "./decision-chain.ts";
import { renderWikiHtml } from "../wiki/render.ts";

const TODAY = "2026-11-07";
/** The word joiner the close puts after grammar in the owner's text. */
const J = "\u2060";
const q = (id: string, text = "Which one?") => `<Question id="${id}" choices="A|B">\n\n${text}\n\n</Question>\n`;
const page = (...parts: string[]) => ["---\ntitle: T\n---\n", ...parts].join("\n");
const answer = (over: Partial<Extract<CloseRuling, { kind: "answer" }>> = {}): CloseRuling => ({ kind: "answer", choice: "B", body: "", author: "Rune Lind", date: "06.11.2026", ...over });

function stateOf(content: string, id: string) {
  return parseQuestionPage(parseBlocks(content.replace(/^---\n[\s\S]*?\n---\n/, ""))).states.get(id);
}
function check10(content: string) {
  return checkPageText({ relPath: "plans/t.mdx", title: "T" } as never, content, []).filter((f) => f.check === "question-block");
}
function ok(r: ReturnType<typeof closeCardEdit>) {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}

describe("closeCardEdit", () => {
  test("a hint naming Dn appends the close to the card's item", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one. See the card.\n- **D1** — Answer A on card O1. Rune Lind, 05.11.2026.\n\n</DecisionLog>\n");
    expect(stateOf(text, "O1")?.kind).toBe("open");
    const r = ok(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY));
    expect(r.decision).toBe("D1");
    expect(r.content).toContain("- **O1** — Which one. See the card. Closed 2026-11-07 (D1).\n- **D1**");
    expect(stateOf(r.content, "O1")).toEqual({ kind: "decided", decision: "D1" });
    expect(check10(r.content)).toEqual([]);
    expect(r.lines).toEqual(["- **O1** — Which one. See the card. Closed 2026-11-07 (D1)."]);
  });

  test("a choice answer adds Dn+1 after the last decision and closes the item on it", () => {
    const text = page(q("O2"), "<DecisionLog>\n\n- **D3** — Earlier. Opus-5.5, 01.11.2026.\n- **O2** — Which one\n- **D4** — Later. Opus-5.5, 02.11.2026.\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O2", answer(), TODAY));
    expect(r.decision).toBe("D5");
    expect(r.content).toContain("- **O2** — Which one. Closed 2026-11-07 (D5).\n- **D4** — Later. Opus-5.5, 02.11.2026.\n- **D5** — Answer B on card O2. Rune Lind, 06.11.2026.\n\n</DecisionLog>");
    expect(stateOf(r.content, "O2")).toEqual({ kind: "decided", decision: "D5" });
    expect(check10(r.content)).toEqual([]);
    expect(r.lines).toEqual(["- **O2** — Which one. Closed 2026-11-07 (D5).", "- **D5** — Answer B on card O2. Rune Lind, 06.11.2026."]);
  });

  test("a text answer becomes the decision's text, on one line, a tag broken by a word joiner and no entities", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer({ choice: null, body: "Go with the <second>\n  and {keep} it" }), TODAY));
    expect(r.content).toContain(`- **D1** — Go with the <${J}second> and {keep} it. Rune Lind, 06.11.2026.`);
    expect(stateOf(r.content, "O1")).toEqual({ kind: "decided", decision: "D1" });
    expect(check10(r.content)).toEqual([]);
  });

  // Arch review 2026-11-16 F50: the reader prints an entity as typed, and the
  // answer is the owner's prose, never decision-log grammar.
  test("an answer's «Closes O2», & and < show as written and add no chain edge", () => {
    const text = page(q("O1"), q("O2"), "<DecisionLog>\n\n- **O1** — Which one?\n- **O2** — And this?\n\n</DecisionLog>\n");
    const body = "Closes O2 too & keep 1 < 2 <Fact id=\"f\">x</Fact>, `Closes O2` as code";
    const r = ok(closeCardEdit(text, "O1", answer({ choice: null, body }), TODAY));
    expect(r.content).toContain(
      `- **D1** — C${J}loses O2 too & keep 1 < 2 <${J}Fact id="f">x<${J}/Fact>, \`Closes O2\` as code. Rune Lind, 06.11.2026.`,
    );
    const blocks = parseBlocks(r.content.replace(/^---\n[\s\S]*?\n---\n/, ""));
    const d1 = analyzeDecisionChains(blocks, []).chains.find((c) => c.decision === "D1");
    // The close's own edge O1 → D1 stays; O2 is not pulled in by the answer's words.
    expect(d1?.questions.map((x) => x.id)).toEqual(["O1"]);
    expect(stateOf(r.content, "O2")).toEqual({ kind: "open" });
    const html = renderWikiHtml(r.content, () => undefined, {});
    const item = /<li class="dl-item[^"]*" id="d1"[^>]*>([\s\S]*?)<\/li>/.exec(html)![1]!;
    expect(item).not.toContain("&amp;lt;");
    expect(item).toContain(`too &amp; keep 1 &lt; 2 &lt;${J}Fact id=&quot;f&quot;&gt;x&lt;${J}/Fact&gt;, <code>Closes O2</code>`);
  });

  // The chain reads lowercase «closes»/«lukker» too (`CLOSES_RE`), so the scan breaks those.
  test.each([["closes"], ["lukker"]])("a lowercase «%s O2» in an answer is broken and adds no chain edge", (word) => {
    const text = page(q("O1"), q("O2"), "<DecisionLog>\n\n- **O1** — Which one?\n- **O2** — And this?\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer({ choice: null, body: `this also ${word} O2` }), TODAY));
    expect(r.content).toContain(`- **D1** — this also ${word[0]}${J}${word.slice(1)} O2. Rune Lind, 06.11.2026.`);
    const d1 = analyzeDecisionChains(parseBlocks(r.content.replace(/^---\n[\s\S]*?\n---\n/, "")), []).chains.find((c) => c.decision === "D1");
    expect(d1?.questions.map((x) => x.id)).toEqual(["O1"]);
    expect(stateOf(r.content, "O2")).toEqual({ kind: "open" });
  });

  test("a close or reopen word before a date in an answer is broken by a word joiner", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer({ choice: null, body: "Lukket 01.01.2026 (D9) was wrong; it ``Reopened`` later" }), TODAY));
    expect(r.content).toContain(`- **D1** — L${J}ukket 01.01.2026 (D9) was wrong; it \`\`Reopened\`\` later. Rune Lind, 06.11.2026.`);
    expect(check10(r.content)).toEqual([]);
  });

  test("an empty text answer is refused", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n\n</DecisionLog>\n");
    const r = closeCardEdit(text, "O1", answer({ choice: null, body: "  \n " }), TODAY);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("no-ruling");
  });

  test("a card with no item gets one, before the new decision", () => {
    const text = page(q("O2"), q("O7"), "<DecisionLog>\n\n- **O7** — Decided in the meeting.\n\n</DecisionLog>\n");
    expect(check10(text).some((f) => f.message.includes("O2") && f.message.includes("no item"))).toBe(true);
    const r = ok(closeCardEdit(text, "O2", answer({ choice: "A" }), TODAY));
    expect(r.content).toContain("- **O7** — Decided in the meeting.\n- **O2** — See the card. Closed 2026-11-07 (D1).\n- **D1** — Answer A on card O2. Rune Lind, 06.11.2026.\n");
    expect(stateOf(r.content, "O2")).toEqual({ kind: "decided", decision: "D1" });
    expect(check10(r.content).filter((f) => f.message.includes("O2"))).toEqual([]);
  });

  test("an empty log gets a list", () => {
    const text = page(q("O1"), "<DecisionLog>\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer(), TODAY));
    expect(stateOf(r.content, "O1")).toEqual({ kind: "decided", decision: "D1" });
    expect(check10(r.content)).toEqual([]);
  });

  test("a hint with no item to close is refused", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **D1** — Answer A on card O1. Rune Lind, 05.11.2026.\n\n</DecisionLog>\n");
    const r = closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY);
    expect(!r.ok && r.code).toBe("unplaceable");
  });

  test("a page with no <DecisionLog> is refused (D23)", () => {
    const r = closeCardEdit(page(q("O1")), "O1", answer(), TODAY);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("no-log");
    expect(!r.ok && r.reason).toContain("open it on the page");
  });

  test("a DecisionLog inside a code fence is no log", () => {
    const r = closeCardEdit(page(q("O1"), "```\n<DecisionLog>\n\n- **O1** — x\n\n</DecisionLog>\n```\n"), "O1", answer(), TODAY);
    expect(!r.ok && r.code).toBe("no-log");
  });

  test("a closed card and a missing card are refused", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — x. Closed 2026-11-01 (D1).\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    expect(closeCardEdit(text, "O1", answer(), TODAY)).toMatchObject({ ok: false, code: "not-open" });
    expect(closeCardEdit(text, "O9", answer(), TODAY)).toMatchObject({ ok: false, code: "no-card" });
  });

  test("a reopened card closes again, and the close is the item's last phrase", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — x. Closed 2026-11-01 (D1). Reopened 2026-11-02.\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer(), TODAY));
    expect(stateOf(r.content, "O1")).toEqual({ kind: "decided", decision: "D2" });
  });

  test("a multi-line item and nested lines: the close goes on the first paragraph's last line", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — first line\n  second line\n  - a nested note\n- **D1** — z. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer(), TODAY));
    expect(r.content).toContain("  second line. Closed 2026-11-07 (D2).\n  - a nested note\n- **D1** — z. Rune Lind, 01.11.2026.\n- **D2** — Answer B on card O1.");
    expect(stateOf(r.content, "O1")).toEqual({ kind: "decided", decision: "D2" });
  });

  test("a nested Reopened after the item's text would not read closed: refused, nothing placed", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — x\n  - Closed 2026-11-01 (D1). Reopened 2026-11-02.\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    expect(closeCardEdit(text, "O1", answer(), TODAY)).toMatchObject({ ok: false, code: "unplaceable" });
  });

  test("the decision number follows the highest D the log defines, and CRLF pages keep CRLF", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **D9** — a. Rune Lind, 01.11.2026.\n- **O1** — x\n- **D2** — b. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n").replace(/\n/g, "\r\n");
    const r = ok(closeCardEdit(text, "O1", answer(), TODAY));
    expect(r.decision).toBe("D10");
    expect(r.content).not.toMatch(/[^\r]\n/);
    expect(stateOf(r.content.replace(/\r\n/g, "\n"), "O1")).toEqual({ kind: "decided", decision: "D10" });
  });

  test("a nested fence right after the item text stays a fence: the close goes on the text line", () => {
    for (const fence of ["```"]) {
      const text = page(q("O1"), `<DecisionLog>\n\n- **O1** — x\n  ${fence}ts\n  code\n  ${fence}\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n`);
      const r = ok(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY));
      expect(r.content).toContain(`- **O1** — x. Closed 2026-11-07 (D1).\n  ${fence}ts\n  code\n  ${fence}\n`);
    }
  });

  test("the frontmatter ends where the reader ends it, a closing fence with trailing space included", () => {
    const text = ["---\ntitle: T\n--- ", q("O1"), "<DecisionLog>\n\n- **O1** — x. Closed 2026-01-01 (D1).\n- **D1** — y. Rune Lind, 01.01.2026.\n\n</DecisionLog>\n", "---\n", "<DecisionLog>\n\n- **D5** — z. Rune Lind, 01.01.2026.\n\n</DecisionLog>\n"].join("\n");
    expect(closeCardEdit(text, "O1", answer(), TODAY)).toMatchObject({ ok: false, code: "not-open" });
  });

  test("the author and the choice are made inert like the body", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer({ choice: "<b>", author: "Rune {L} <x>" }), TODAY));
    expect(r.content).toContain(`- **D1** — Answer <${J}b> on card O1. Rune {L} <${J}x>, 06.11.2026.`);
  });

  test("a line break in the author or the choice stays on the decision's line: no second item", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which\n- **D1** — x. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    for (const over of [{ author: "R\r\n- **D7** — ghost" }, { choice: "B\n- **D7** — ghost" }]) {
      const r = ok(closeCardEdit(text, "O1", answer(over), TODAY));
      expect(r.content).not.toMatch(/^- \*\*D7\*\*/m);
      expect(parseQuestionPage(parseBlocks(r.content.replace(/^---\n[\s\S]*?\n---\n/, ""))).decisions).toEqual(new Set(["D1", "D2"]));
    }
  });

  test("a backtick run that is no fence is part of the paragraph: the close goes after it", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — x\n  ```a``` one\n  ```b``` two\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY));
    expect(r.content).toContain("- **O1** — x\n  ```a``` one\n  ```b``` two. Closed 2026-11-07 (D1).\n");
  });

  test("a tilde run is no fence to the reader: the close goes after it, at the paragraph's end", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — x\n  ~~~ts\n  code\n  ~~~\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY));
    expect(r.content).toContain("  code\n  ~~~. Closed 2026-11-07 (D1).\n- **D1**");
  });

  test("one inline triple-backtick line in the log opens no fence: the log is found and the close placed", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — x\n  ```a``` one\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY));
    expect(r.content).toContain("  ```a``` one. Closed 2026-11-07 (D1).\n");
  });

  test("a backtick fence 4 or more spaces in is no fence to the reader, nor an unclosed one: the close goes at the paragraph's end", () => {
    for (const body of ["     ```\n     code\n     ```", "  ```\n  never closed"]) {
      const text = page(q("O1"), `<DecisionLog>\n\n- **O1** — x\n${body}\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n`);
      const r = ok(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY));
      const last = body.split("\n").at(-1)!;
      expect(r.content).toContain(`${last}. Closed 2026-11-07 (D1).\n`);
    }
  });

  test("a line the parser reads as no part of the paragraph (a rule) is refused by the read-back, not written over", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — x\n  ---\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    expect(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY)).toMatchObject({ ok: false, code: "unplaceable" });
    expect(closeCardEdit(text, "O1", answer(), TODAY)).toMatchObject({ ok: false, code: "unplaceable" });
  });

  test("fences by the parser's rule: an inline-backtick line before a real code block stays prose, and a fenced example log is skipped", () => {
    const inline = page(q("O1"), "<DecisionLog>\n\n- **O1** — x\n  ```a``` one\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n\n```\ncode\n```\n");
    expect(ok(closeCardEdit(inline, "O1", { kind: "decision", decision: "D1" }, TODAY)).content).toContain("  ```a``` one. Closed 2026-11-07 (D1).\n");
    const example = page(q("O1"), "```\n<DecisionLog>\n- **O1** — example\n</DecisionLog>\n```\n", "<DecisionLog>\n\n- **O1** — x\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n");
    expect(ok(closeCardEdit(example, "O1", { kind: "decision", decision: "D1" }, TODAY)).content).toContain("- **O1** — x. Closed 2026-11-07 (D1).\n");
  });

  test("«no log» is the parser's answer: a log the parser sees but the line scan cannot place is unplaceable, not no-log", () => {
    // The parser reads an empty DecisionLog here; the line scan needs its tags on lines of their own.
    const text = page(q("O1"), "<DecisionLog></DecisionLog>\n");
    expect(closeCardEdit(text, "O1", answer(), TODAY)).toMatchObject({ ok: false, code: "unplaceable" });
  });

  test("the date goes on the decision's line, one line and escaped", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer({ date: "06.11.2026\n- **D7** — ghost" }), TODAY));
    expect(r.content).not.toMatch(/^- \*\*D7\*\*/m);
  });
});

// Arch review 2026-11-16 F50, fix round 1: every state the owner's text can be
// in on the decision's one line, each cell read back by the reader, the
// parsers and the lint. The reader renders a component from `<Fact`, pairs
// code spans across the whole line and shows a backslash as typed.
describe("closeCardEdit: owner text stays text in every state (F50 matrix)", () => {
  const HITS: Record<string, string> = {
    component: '<Fact id="a">y</Fact>',
    html: "<b>hi</b>",
    closing: "</Fact>",
    bang: "<!-- c -->",
    tight: "x<y then",
    spaced: "a < b",
    closes: "Closes O2",
    lukker: "Lukker O2",
    closed: "Closed 01.01.2026 (D9)",
    lukket: "Lukket 01.01.2026 (D9)",
    reopened: "Reopened 2026-01-02",
    gjenapnet: "Gjenåpnet 02.01.2026",
    // Fix round 1 batch 2: the log's other grammar. A reversal word dims the item
    // (`parseLogItem`) or, after a struck lead sentence, reverses it in the chain;
    // a prose «PR n» / «oppgave n» is a decision → PR edge.
    superseded: "superseded by D3",
    erstattet: "ERSTATTET AV D3",
    struckSuperseded: "~~Old plan.~~ superseded: do B",
    struckReversed: "~~Go with A.~~ Reversed",
    struckSnudd: "~~Gammel plan.~~ — «Snudd»",
    struckErstattet: "~~Plan.~~ erstattet",
    pr: "Ship it in PR 4 and PR 5",
    prSlash: "PR 22/23",
    oppgave: "gjør oppgave 2 og 3",
    oppgaveCap: "Oppgave 7",
  };
  /** Hits whose `~~` the reader draws as a strike: the owner's own formatting. */
  const STRIKE = new Set(["struckSuperseded", "struckReversed", "struckSnudd", "struckErstattet"]);
  /** `other`: another field's text on the line; `strayPair`: two stray runs that would pair across fields. */
  type Ctx = { name: string; here: (hit: string) => string; other?: string; strayPair?: boolean };
  const mid = (hit: string, run: string) => hit.slice(0, Math.ceil(hit.length / 2)) + run + hit.slice(Math.ceil(hit.length / 2));
  const CTX: Ctx[] = [
    // Where a struck lead sentence counts: the start of the decision's text.
    { name: "the whole text", here: (h) => h },
    { name: "no backticks", here: (h) => `pre ${h} post` },
    { name: "own span right before", here: (h) => `see \`x\`${h}` },
    { name: "own span right after", here: (h) => `${h}\`y\` z` },
    { name: "inside an own span", here: (h) => `in \`${h}\` code` },
    { name: "stray run in this field", here: (h) => `ok \` ${h}` },
    { name: "stray run in another field", here: (h) => `pre ${h}`, other: "Ru`ne" },
    { name: "stray runs in both fields", here: (h) => `ok \` ${h}`, other: "Ru`ne", strayPair: true },
    { name: "stray here, span in another field", here: (h) => `ok \` ${h}`, other: "Ru `ne` x" },
    { name: "stray here, a run inside another field's span", here: (h) => `ok \` ${h}`, other: "R ``a`b`` x", strayPair: true },
    ...[1, 2, 3].map((n): Ctx => ({ name: `run of ${n} inside the hit`, here: (h) => `pre ${mid(h, "`".repeat(n))} post` })),
  ];
  const FIELDS = ["body", "author", "choice"] as const;
  type Field = (typeof FIELDS)[number];
  type Answer = Extract<CloseRuling, { kind: "answer" }>;

  const base = page(q("O1"), q("O2"), "<DecisionLog>\n\n- **O1** — Which one?\n- **O2** — And this?\n\n</DecisionLog>\n");
  const stripFm = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, "");
  const one = (t: string) => t.replace(/\s+/g, " ").trim();
  /** What a text shows on its own, and its code spans' contents. */
  function shown(t: string): { text: string; codes: string[] } {
    const line = one(t);
    let text = "";
    let last = 0;
    const codes: string[] = [];
    for (const r of lineCodeSpanRanges(line)) {
      const c = codeSpanContent(line, r);
      text += line.slice(last, r.start) + c;
      codes.push(c);
      last = r.end;
    }
    return { text: text + line.slice(last), codes };
  }
  function rulingFor(field: Field, here: string, other: string | undefined): Answer {
    const author = other !== undefined ? { author: other } : {};
    if (field === "body") return answer({ choice: null, body: here, ...author }) as Answer;
    if (field === "choice") return answer({ choice: here, ...author }) as Answer;
    return answer({ choice: other ?? "B", author: here }) as Answer;
  }
  /** The decision as each field shows on its own: visible text and code contents, in line order. */
  function expectedOf(r: Answer): { text: string; codes: string[] } {
    const a = shown(r.author);
    if (r.choice === null) {
      const b = shown(r.body);
      const stop = /[.!?]$/.test(one(r.body)) ? "" : ".";
      return { text: `${b.text}${stop} ${a.text}, 06.11.2026.`, codes: [...b.codes, ...a.codes] };
    }
    const c = shown(r.choice);
    return { text: `Answer ${c.text} on card O1. ${a.text}, 06.11.2026.`, codes: [...c.codes, ...a.codes] };
  }
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  /** The reader's own markup in a log item: the text, its first sentence, the rest and its tail. */
  const ALLOWED_TAG = /^(?:<span class="dl-text"[^>]*>|<span class="dl-(?:first|rest|tail)">|<\/span>|<code>|<\/code>)$/;
  const d1Html = (content: string) =>
    /<li class="dl-item[^"]*" id="d1"[^>]*>([\s\S]*?)<\/li>/
      .exec(renderWikiHtml(content, () => undefined, {}))![1]!
      .replace(/^<a class="dl-id"[^>]*>D1<\/a>/, "")
      .replace(/<span class="dl-when"[^>]*>[^<]*<\/span>$/, "");
  const lintChecks = (content: string) => checkPageText({ relPath: "plans/t.mdx", title: "T" } as never, content, []).map((f) => f.check).sort();
  const componentsOf = (content: string) => {
    const names: string[] = [];
    eachComponent(parseBlocks(stripFm(content)), (b) => names.push(b.name));
    return names;
  };
  const baseline = ok(closeCardEdit(base, "O1", answer(), TODAY)).content;

  for (const field of FIELDS) {
    for (const ctx of CTX) {
      for (const [kind, hit] of Object.entries(HITS)) {
        for (const bs of ["", "\\"]) {
          test(`${field} · ${ctx.name} · ${kind}${bs ? " · backslash before" : ""}`, () => {
            const ruling = rulingFor(field, ctx.here(`${bs}${hit}`), ctx.other);
            const r = ok(closeCardEdit(base, "O1", ruling, TODAY));
            // (d) one valid line, read as D1's item.
            const lines = r.content.split("\n");
            const d1Lines = lines.filter((l) => l.startsWith("- **D1**"));
            expect(d1Lines).toHaveLength(1);
            expect(lines).toHaveLength(baseline.split("\n").length);
            expect(parseLogItem(d1Lines[0]!.slice(2)).id).toBe("D1");
            // (b) no close, chain edge, reversal or component from the owner's text;
            // the close's own O1 → D1 edge stays.
            const blocks = parseBlocks(stripFm(r.content));
            const chains = analyzeDecisionChains(blocks, []);
            const d1 = chains.chains.find((c) => c.decision === "D1")!;
            expect(d1.questions.map((x) => `${x.id}:${x.source}`)).toEqual(["O1:close"]);
            expect(d1.reversed).toBeNull();
            expect(d1.outputs).toEqual([]);
            expect(chains.proseEdges).toBe(0);
            expect(chains.orphans).toEqual([]);
            expect(chains.conflicts).toEqual([]);
            const parsed = parseQuestionPage(blocks);
            expect(parsed.states.get("O1")).toEqual({ kind: "decided", decision: "D1" });
            expect(parsed.states.get("O2")).toEqual({ kind: "open" });
            expect(parsed.decisions).toEqual(new Set(["D1"]));
            const d1Entry = parsed.entries.find((e) => e.id === "D1")!;
            expect(lastCanonicalPhrase(d1Entry.itemText)).toBeNull();
            expect(d1Entry.dim).toBe(false);
            expect(parseLogItem(d1Lines[0]!.slice(2)).dim).toBe(false);
            expect(componentsOf(r.content)).toEqual(componentsOf(baseline));
            expect(lintChecks(r.content)).toEqual(lintChecks(baseline));
            // (a) and (c): no element drawn from the text, the text shown as each
            // field shows on its own, and code only where the owner wrote a span.
            const li = d1Html(r.content);
            expect(/<li class="(dl-item[^"]*)" id="d1"/.exec(renderWikiHtml(r.content, () => undefined, {}))![1]).not.toContain("dl-dim");
            const strike = STRIKE.has(kind);
            for (const tag of li.match(/<[^>]*>/g) ?? []) if (!(strike && /^<\/?s>$/.test(tag))) expect(tag).toMatch(ALLOWED_TAG);
            const want = expectedOf(ruling);
            // A strike's `~~` is drawn, or shown where a backtick splits it: compared without it.
            const unstrike = (t: string) => (strike ? t.replaceAll("~~", "") : t);
            expect(unstrike(decode(li.replace(/<[^>]*>/g, "")).replaceAll(J, ""))).toBe(unstrike(want.text));
            // Code keeps its bytes (no joiner in it), so it copies as written.
            const codes = [...li.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => decode(m[1]!));
            // Two stray runs in different fields would pair; one gets a span of its own.
            expect(codes.filter((c) => !(ctx.strayPair && /^`+$/.test(c)))).toEqual(want.codes);
          });
        }
      }
    }
  }

  test("the reported reversal and PR shapes: no dim, no reversal, no output, and the text shows as written", () => {
    for (const body of ["Keep A for now; this is superseded by D3 once B lands", "~~Old plan.~~ superseded: do B", "~~Go with A.~~ Reversed: B", "Ship it in PR 4 and PR 5"]) {
      const r = ok(closeCardEdit(base, "O1", answer({ choice: null, body }), TODAY));
      const blocks = parseBlocks(stripFm(r.content));
      const d1 = analyzeDecisionChains(blocks, []).chains.find((c) => c.decision === "D1")!;
      expect([d1.reversed, d1.outputs]).toEqual([null, []]);
      expect(parseQuestionPage(blocks).entries.find((e) => e.id === "D1")!.dim).toBe(false);
      expect(decode(d1Html(r.content).replace(/<[^>]*>/g, "")).replaceAll(J, "")).toBe(`${body.replace(/~~/g, "")}. Rune Lind, 06.11.2026.`);
    }
  });

  test("both readings of backticks are scanned: runs only `withoutCodeSpans` pairs, and a run only it deletes", () => {
    // `parseLogItem` deletes `` ` plan.~~ superseded: ` `` (runs of 1 and 2, which no reader pairs); the chain reads the raw text.
    for (const body of ["~~Old ` plan.~~ superseded: `` z", "superse``ded by D3"]) {
      const r = ok(closeCardEdit(base, "O1", answer({ choice: null, body }), TODAY));
      const blocks = parseBlocks(stripFm(r.content));
      const d1 = analyzeDecisionChains(blocks, []).chains.find((c) => c.decision === "D1")!;
      expect(d1.reversed).toBeNull();
      expect(parseQuestionPage(blocks).entries.find((e) => e.id === "D1")!.dim).toBe(false);
    }
  });

  test("grammar a parser reads inside the owner's code span (a struck lead closing in a span) is refused, not written", () => {
    const r = closeCardEdit(base, "O1", answer({ choice: null, body: "~~Old. `x.~~ superseded` y" }), TODAY);
    expect(r).toMatchObject({ ok: false, code: "unplaceable" });
    // The cause is the answer, so the reason names it, not the page.
    expect(!r.ok && r.reason).toContain("the answer reads as decision-log grammar");
  });

  test("the three reported shapes: backslash before a tag, a tag after a span, a comparison before Closes, a stray before a tag in the author", () => {
    const cases: [Partial<Answer>, string, string[]][] = [
      [{ body: 'x \\<Fact id="a">y</Fact> z' }, 'x \\<Fact id="a">y</Fact> z.', []],
      [{ body: 'see `x`<Fact id="f">y</Fact>' }, 'see x<Fact id="f">y</Fact>.', ["x"]],
      [{ body: "if x<y then pick B, else Closes O2" }, "if x<y then pick B, else Closes O2.", []],
      [{ body: "ok \\`", author: "Rune <b>" }, "ok \\`. Rune <b>", []],
    ];
    for (const [over, shows, codes] of cases) {
      const r = ok(closeCardEdit(base, "O1", answer({ choice: null, ...over }), TODAY));
      const li = d1Html(r.content);
      expect(li).not.toContain("fc-");
      expect([...li.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => m[1])).toEqual(codes);
      expect(decode(li.replace(/<[^>]*>/g, "")).replaceAll(J, "")).toContain(shows);
      const d1 = analyzeDecisionChains(parseBlocks(stripFm(r.content)), []).chains.find((c) => c.decision === "D1")!;
      expect(d1.questions.map((x) => x.id)).toEqual(["O1"]);
    }
  });

  // Fix round 2: the parsers read the item in NFC (`maskCodeSpans`), so the scan does too.
  test("a decomposed (NFD) close or reopen word before a date is broken like the NFC one", () => {
    const r = ok(closeCardEdit(base, "O1", answer({ choice: null, body: "Gjenåpnet 02.01.2026 if B fails".normalize("NFD") }), TODAY));
    const d1 = parseQuestionPage(parseBlocks(stripFm(r.content))).entries.find((e) => e.id === "D1")!;
    expect(lastCanonicalPhrase(d1.text)).toBeNull();
    expect(r.content).toContain(`G${J}jenåpnet 02.01.2026 if B fails.`);
  });

  test("a character NFC maps to a backtick (U+1FEF) pairs spans as the reader does: no PR edge, no refusal", () => {
    const r = ok(closeCardEdit(base, "O1", answer({ choice: null, body: "` `PR 4` x" }), TODAY));
    const blocks = parseBlocks(stripFm(r.content));
    const d1 = analyzeDecisionChains(blocks, []).chains.find((c) => c.decision === "D1")!;
    expect([d1.reversed, d1.outputs, d1.questions.map((x) => x.id)]).toEqual([null, [], ["O1"]]);
    expect(parseQuestionPage(blocks).entries.find((e) => e.id === "D1")!.dim).toBe(false);
  });
});

describe("closeCardEdit: the new decision's id", () => {
  test("skips an id an orphan close already names, so a plain choice closes and ties nothing else", () => {
    const text = page(q("O1"), q("O2"), "<DecisionLog>\n\n- **O1** — Which one?\n- **O2** — And this? Closed 2026-01-01 (D1).\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer(), TODAY));
    expect(r.decision).toBe("D2");
    expect(r.content).toContain("- **D2** — Answer B on card O1. Rune Lind, 06.11.2026.");
    const blocks = parseBlocks(r.content.replace(/^---\n[\s\S]*?\n---\n/, ""));
    expect(analyzeDecisionChains(blocks, []).chains.find((c) => c.decision === "D2")!.questions.map((x) => x.id)).toEqual(["O1"]);
    expect(stateOf(r.content, "O1")).toEqual({ kind: "decided", decision: "D2" });
    expect(stateOf(r.content, "O2")).toEqual({ kind: "closed" });
  });

  test("skips an id another log item names in a reversal, so the answer is not born superseded", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n- **D1** — Old. Superseded by D2.\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer(), TODAY));
    expect(r.decision).toBe("D3");
  });

  test("does not skip past an id cited in a code span (another plan's `D39`, as mimir's settled-questions plan has it)", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n- **D1** — Keep `D39`'s rule of the other plan.\n\n</DecisionLog>\n");
    expect(ok(closeCardEdit(text, "O1", answer(), TODAY)).decision).toBe("D2");
  });
});
