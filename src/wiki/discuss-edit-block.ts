/**
 * Where a Discuss answer's proposed edit sits: the fenced block the server
 * reads as the edit (`extractProposedEdit`, `discuss-agent.ts`) and replaces
 * with `STORED_EDIT_MARKER` in a thread's message (`stripProposedEdit`). Pure
 * and free of node imports, so the reader bundle finds the same block in an old
 * one-shot turn's raw answer («Earlier discussions», Discuss v2 PR 4).
 */
import { editListShape } from "./core/wiki-integrate.ts";

/** A fenced block's info string and body, with its line span in the
 *  CRLF-normalized text: `from` is the opening fence's line, `to` the closing
 *  fence's (the last line for an unclosed fence). */
export interface FencedBlockSpan {
  info: string;
  body: string;
  from: number;
  to: number;
}

/**
 * An answer's fenced code blocks, in order. A fence opens with three or more
 * backticks or tildes (up to three spaces in, any info string) and closes on a
 * line of the same character, at least as long, and nothing else; an unclosed
 * fence runs to the end. CRLF reads as LF.
 */
export function fencedBlockSpans(text: string): FencedBlockSpan[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: FencedBlockSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    const info = open[2]!.trim();
    // A backtick fence's info string holds no backtick (CommonMark): that line is inline code.
    if (fence[0] === "`" && info.includes("`")) continue;
    const closer = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \t]*$`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !closer.test(lines[j]!); j++) body.push(lines[j]!);
    out.push({ info, body: body.join("\n"), from: i, to: Math.min(j, lines.length - 1) });
    i = j;
  }
  return out;
}

/**
 * The proposed edit's block: the last fenced block, whatever its info string,
 * that holds `"edits"` and reads as an edit list with at least one item (each
 * item is an edit or a dropped one to `parseEditList`). Null when there is none.
 */
export function proposedEditSpan(answer: string): FencedBlockSpan | null {
  for (const span of fencedBlockSpans(answer).reverse()) {
    if (!/"edits"\s*:/.test(span.body)) continue;
    if ((editListShape(span.body)?.items.length ?? 0) > 0) return span;
  }
  return null;
}

/** The answer with its proposed edit's block (fences included) replaced by
 *  the one line `line`; an answer with no edit unchanged. */
export function replaceProposedEdit(answer: string, line: string): string {
  const span = proposedEditSpan(answer);
  if (!span) return answer;
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  return [...lines.slice(0, span.from), line, ...lines.slice(span.to + 1)].join("\n");
}
