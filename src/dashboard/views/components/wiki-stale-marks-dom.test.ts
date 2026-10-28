/**
 * The stale marks' DOM half (PR 2b, D21) on the real render: `renderWikiHtml`
 * output in a happy-dom `Window` of the test's own (no globals installed, so
 * nothing leaks to sibling files), then `placeStaleMarks`. Each case reads
 * which words carry a mark, so a rule that stops holding shows as a mark on
 * the wrong word, on no word, or on a word that must never take one.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderWikiHtml } from "../../../wiki/render.ts";
import { statusLineCandidates } from "../../../wiki/stale.ts";
import type { WikiPageMeta } from "../../../wiki/store.ts";
import { placeStaleMarks, STALE_MARK_CLASS } from "./wiki-stale-marks.ts";
import type { StaleHitView } from "./wiki-stale-tab.ts";

const resolve = (t: string) => (t === "p" || t === "q" ? ({ relPath: `${t}.md`, name: t, title: t } as unknown as WikiPageMeta) : undefined);

type Hit = Partial<StaleHitView> & Pick<StaleHitView, "line" | "text" | "said">;

/** Render `md`, place the marks for `hits` (target `p.md`), and read back the
 *  marked words with the line number each mark carries. */
function marks(md: string, hits: Hit[]): { placed: number; marked: [string, string][] } {
  const doc = new Window().document;
  const c = doc.createElement("div");
  c.innerHTML = renderWikiHtml(md, resolve);
  doc.body.appendChild(c);
  const placed = placeStaleMarks(c as unknown as Element, hits.map((h) => ({ target: "p.md", now: "shipped", ...h })));
  const marked = Array.from(c.querySelectorAll(`mark.${STALE_MARK_CLASS}`)).map((m) => [m.textContent ?? "", m.getAttribute("data-stale-mark") ?? ""] as [string, string]);
  return { placed, marked };
}

describe("stale marks on the rendered page (PR 2b, D21)", () => {
  test("a table row's cells read as separate words", () => {
    expect(marks("| Plan | Status | When |\n|---|---|---|\n| [[p]] | in-flight | 2026 |\n", [{ line: 3, text: "| [[p]] | in-flight | 2026 |", said: ["in-flight"] }]).marked).toEqual([["in-flight", "3"]]);
    expect(marks("| Plan | Status | n |\n|---|---|---|\n| [[p]] | done | 12 |\n", [{ line: 3, text: "| [[p]] | done | 12 |", said: ["shipped"] }]).marked).toEqual([["done", "3"]]);
    expect(marks("| Plan | Status | Note |\n|---|---|---|\n| [[p]] | blocked | waiting |\n", [{ line: 3, text: "| [[p]] | blocked | waiting |", said: ["blocked"] }]).marked).toEqual([["blocked", "3"]]);
    expect(marks("| Plan | Status |\n|---|---|\n| [[p]] v2 | done |\n", [{ line: 3, text: "| [[p]] v2 | done |", said: ["shipped"] }]).marked).toEqual([["done", "3"]]);
  });

  // The server reads a row's source, `|` between cells, so a phrase never
  // spans a cell edge there.
  test("«open | PR» across cells is no «open PR»", () => {
    const md = "| Plan | a | b | c |\n|---|---|---|---|\n| [[p]] | open | PR | in-flight |\n";
    expect(marks(md, [{ line: 3, text: "| [[p]] | open | PR | in-flight |", said: ["in-flight"] }]).marked).toEqual([["in-flight", "3"]]);
  });

  test("«not | merged» across cells is a shipped word, not a negated one", () => {
    const md = "| Plan | a | b |\n|---|---|---|\n| [[p]] | not | merged |\n";
    expect(marks(md, [{ line: 3, text: "| [[p]] | not | merged |", said: ["shipped"], now: "proposed" }]).marked).toEqual([["merged", "3"]]);
  });

  test("an element edge inside one cell is no cell edge: the phrase still reads", () => {
    // The server reads «open PRs» here; the client's text runs are «open PR» and «s».
    const md = "| Plan | a |\n|---|---|\n| [[p]] | open PR**s** |\n";
    expect(marks(md, [{ line: 3, text: "| [[p]] | open PR**s** |", said: ["in-flight"] }]).marked).toEqual([["open PR", "3"], ["s", "3"]]);
  });

  test("one hit on two lines with the same words and no more takes no mark", () => {
    // The blockquote is no hit on the server, yet it holds the hit's words
    // exactly: score and fit tie, so no line is the hit's.
    const md = "> [[p]] in-flight\n\n- [[p]] in-flight\n";
    const hits = statusLineCandidates(md);
    expect(hits.map((h) => [h.line, h.text])).toEqual([[3, "- [[p]] in-flight"]]);
    expect(marks(md, [{ ...hits[0]!, target: "p.md" }])).toEqual({ placed: 0, marked: [] });
  });

  test("a cut window's hit takes no mark when another line holds its words as well", () => {
    // Over the cap the server cuts the line, so the hit's own line holds more
    // words than the window; the blockquote above (no hit on the server)
    // holds exactly the window's. Same score: a tie, so no mark.
    const w = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const md = `> [[p]] in-flight ${w(88)}\n\n- [[p]] in-flight ${w(90)}\n`;
    const hits = statusLineCandidates(md);
    expect(hits.map((h) => [h.line, h.text.endsWith("…")])).toEqual([[3, true]]);
    const hit = { ...hits[0]!, target: "p.md" };
    expect(marks(md, [hit])).toEqual({ placed: 0, marked: [] });
    // Alone, the cut hit's line takes its mark.
    expect(marks(`- [[p]] in-flight ${w(90)}\n`, [{ ...hit, line: 1 }]).marked).toEqual([["in-flight", "1"]]);
  });

  test("an exact line beats a line that holds more words", () => {
    const md = "- [[p]] in-flight\n- [[p]] in-flight, see PR 12\n";
    const l1 = { line: 1, text: "- [[p]] in-flight", said: ["in-flight"] };
    const l2 = { line: 2, text: "- [[p]] in-flight, see PR 12", said: ["in-flight"] };
    expect(marks(md, [l1]).marked).toEqual([["in-flight", "1"]]);
    expect(marks(md, [l2]).marked).toEqual([["in-flight", "2"]]);
    expect(marks(md, [l1, l2]).marked).toEqual([["in-flight", "1"], ["in-flight", "2"]]);
  });

  test("a frontmatter hit places no mark, and leaves a body hit's mark alone", () => {
    const md = '---\ntitle: T\nrelated:\n  - "[[p]] proposed"\n---\n\n- [[p]] proposed in March, now later\n';
    const fm = { line: 4, text: '- "[[p]] proposed"', said: ["proposed"], frontmatter: true } as Hit;
    const body = { line: 7, text: "- [[p]] proposed in March, now later", said: ["proposed"] };
    expect(marks(md, [fm]).marked).toEqual([]);
    expect(marks(md, [fm, body]).marked).toEqual([["proposed", "7"]]);
  });

  test("a line holding under MATCH_MIN of the hit's words takes no mark", () => {
    // 2 of the hit's 4 words: 0.5, under 0.8, though the said word is there.
    expect(marks("- [[p]] in-flight\n", [{ line: 1, text: "- [[p]] is in-flight today", said: ["in-flight"] }]).marked).toEqual([]);
  });

  test("a status word in inline code or struck text never takes the mark", () => {
    expect(marks("- [[p]] `in-flight` and more\n", [{ line: 1, text: "- [[p]] `in-flight` and more", said: ["in-flight"] }]).marked).toEqual([]);
    expect(marks("- [[p]] ~~in-flight~~ and more\n", [{ line: 1, text: "- [[p]] ~~in-flight~~ and more", said: ["in-flight"] }]).marked).toEqual([]);
    // The unmasked word after it takes the mark.
    expect(marks("- [[p]] `in-flight` then in-flight\n", [{ line: 1, text: "- [[p]] `in-flight` then in-flight", said: ["in-flight"] }]).marked).toEqual([["in-flight", "1"]]);
  });

  test("a link two hits both claim takes no mark", () => {
    const md = "- [[p]] in-flight\n";
    expect(marks(md, [{ line: 1, text: "- [[p]] in-flight", said: ["in-flight"] }]).marked).toEqual([["in-flight", "1"]]);
    expect(marks(md, [{ line: 1, text: "- [[p]] in-flight", said: ["in-flight"] }, { line: 9, text: "- [[p]] in-flight", said: ["in-flight"] }]).placed).toBe(0);
  });

  test("hits whose links share one line root each take their mark", () => {
    // One paragraph (soft breaks) and one list item hold both links, so the
    // second hit reads the root again after the first hit's wrap.
    const para = "[[p]] is in-flight and\n[[q]] is proposed\n";
    const hits = [
      { line: 1, text: "[[p]] is in-flight and", said: ["in-flight"] },
      { line: 2, text: "[[q]] is proposed", said: ["proposed"], target: "q.md" },
    ];
    expect(marks(para, hits)).toEqual({ placed: 2, marked: [["in-flight", "1"], ["proposed", "2"]] });
    expect(marks(para, [...hits].reverse())).toEqual({ placed: 2, marked: [["in-flight", "1"], ["proposed", "2"]] });
    const item = "- [[p]] in-flight, [[q]] proposed\n";
    expect(marks(item, [
      { line: 1, text: "- [[p]] in-flight, [[q]] proposed", said: ["in-flight"] },
      { line: 1, text: "- [[p]] in-flight, [[q]] proposed", said: ["proposed"], target: "q.md" },
    ])).toEqual({ placed: 2, marked: [["in-flight", "1"], ["proposed", "1"]] });
  });
});
