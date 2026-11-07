import { describe, expect, test } from "bun:test";
import { closeCardEdit, type CloseRuling } from "./question-close.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { parseQuestionPage } from "./question.ts";
import { checkPageText } from "../wiki/lint.ts";

const TODAY = "2026-11-07";
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

  test("a text answer becomes the decision's text, on one line, escaped for MDX", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer({ choice: null, body: "Go with the <second>\n  and {keep} it" }), TODAY));
    expect(r.content).toContain("- **D1** — Go with the &lt;second> and &#123;keep&#125; it. Rune Lind, 06.11.2026.");
    expect(stateOf(r.content, "O1")).toEqual({ kind: "decided", decision: "D1" });
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
    for (const fence of ["```", "~~~"]) {
      const text = page(q("O1"), `<DecisionLog>\n\n- **O1** — x\n  ${fence}ts\n  code\n  ${fence}\n- **D1** — y. Rune Lind, 01.11.2026.\n\n</DecisionLog>\n`);
      const r = ok(closeCardEdit(text, "O1", { kind: "decision", decision: "D1" }, TODAY));
      expect(r.content).toContain(`- **O1** — x. Closed 2026-11-07 (D1).\n  ${fence}ts\n  code\n  ${fence}\n`);
    }
  });

  test("the frontmatter ends where the reader ends it, a closing fence with trailing space included", () => {
    const text = ["---\ntitle: T\n--- ", q("O1"), "<DecisionLog>\n\n- **O1** — x. Closed 2026-01-01 (D1).\n- **D1** — y. Rune Lind, 01.01.2026.\n\n</DecisionLog>\n", "---\n", "<DecisionLog>\n\n- **D5** — z. Rune Lind, 01.01.2026.\n\n</DecisionLog>\n"].join("\n");
    expect(closeCardEdit(text, "O1", answer(), TODAY)).toMatchObject({ ok: false, code: "not-open" });
  });

  test("the author and the choice are escaped for MDX like the body", () => {
    const text = page(q("O1"), "<DecisionLog>\n\n- **O1** — Which one?\n\n</DecisionLog>\n");
    const r = ok(closeCardEdit(text, "O1", answer({ choice: "<b>", author: "Rune {L} <x>" }), TODAY));
    expect(r.content).toContain("- **D1** — Answer &lt;b> on card O1. Rune &#123;L&#125; &lt;x>, 06.11.2026.");
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
});
