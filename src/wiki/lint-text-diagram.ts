/**
 * Lint check 20 — a drawing in a plain code fence. One key, `text-diagram`,
 * info, page text only (`checkPageText`, so `wiki-check` reports it). A fence
 * with no language, or `text` in any case, is a drawing when it has at least
 * {@link TEXT_DIAGRAM_MIN_LINES} non-blank lines and at least
 * {@link TEXT_DIAGRAM_MIN_SHARE} of them hold an arrow or box token. The rule
 * counts lines, not characters: measured on mimir and melosys-kode-wiki
 * (2026-10-21), the 30 drawings it flags hold 1.5–38% such characters (median
 * 8%), while 33–100% of their lines (median 90%) hold a token.
 *
 * A tree (`├──`/`└──` branches with no connector) and a box table (a rule
 * line with column joints) are not drawings. Pages under `archive/` and
 * `plans/` are skipped: both wikis keep archive pages verbatim, and a plan is
 * a work record (D13). The finding suggests `sequenceDiagram` when the fence
 * names participants on its first line and numbers its messages, else
 * `flowchart`. A code fence is one the reader renders as code
 * (`readerFences`): backticks only, an unclosed opener is prose, CRLF folded.
 */

import { frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import { readerFences } from "../format/markdown-ast.ts";
import type { LintFinding } from "./lint.ts";

export const TEXT_DIAGRAM_LINT_CHECKS = ["text-diagram"] as const;

/** Tuned on both wikis: the smallest drawing is a chain line over a caption
 *  line; one-line chains (2 fences) are left alone. */
export const TEXT_DIAGRAM_MIN_LINES = 2;
/** Tuned on both wikis: the lowest-share drawing kept is a two-column sequence
 *  at 3 of 9 lines. Below it sit a UI mock at 1 of 4 and two pseudocode or
 *  list fences at 1 of 6, and also two chain-over-captions drawings at 1 of 4
 *  and 1 of 5, which the check misses. */
export const TEXT_DIAGRAM_MIN_SHARE = 1 / 3;

/** Box-drawing and arrow characters, and the ASCII arrow `<--`. */
const BOX_RE = /[─━│┃┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▶◀►◄▼▲]|<--/;
/** A single arrow character counts only when it does not join two word
 *  characters: `red→green` is prose, `A → B` and `──→` are drawing. */
const ARROW_RE = /(?<![\p{L}\p{N}])[→←↓↑↔↕⇒⇐]|[→←↓↑↔↕⇒⇐](?![\p{L}\p{N}])/u;
/** `-->` by the same glue rule (`n-->0` is code, `(A)-->(B)` a drawing), and
 *  not before a number that closes a parenthesis (`while (n --> 0)` is code).
 *  An HTML comment (`<!-- x -->`) is removed from the line first. */
const ASCII_ARROW_RE = /(?<![\p{L}\p{N}])-->(?!\s*\d+\s*\))|-->(?![\p{L}\p{N}]|\s*\d+\s*\))/u;
const HTML_COMMENT_RE = /<!--.*?-->/g;
/** A line of rule characters only: a heading underline, a CLI table rule or
 *  the underline of a sequence's participant heads. */
const RULE_ONLY_RE = /^[\s─═━]*$/;

export function holdsDiagramToken(line: string): boolean {
  return BOX_RE.test(line) || ARROW_RE.test(line) || ASCII_ARROW_RE.test(line.replace(HTML_COMMENT_RE, " "));
}

/** A tree branch: indentation and `│` columns, then `├` or `└` and a dash. */
const TREE_BRANCH_RE = /^[\s│]*[├└]─/;
/** What follows the tree prefix holds a connector: a dash run, a pointer or
 *  an ASCII arrow. A plain `→`/`←` note beside a tree node is not one. */
const CONNECTOR_RE = /─{2,}|[▶◀►◄▼▲]|-->|<--/;

/** A tree: at least half its lines are branches, and no line holds a
 *  connector past the tree prefix. */
function isTree(lines: readonly string[]): boolean {
  const branches = lines.filter((l) => TREE_BRANCH_RE.test(l)).length;
  if (branches * 2 < lines.length) return false;
  return lines.every((l) => !CONNECTOR_RE.test(l.replace(/^[\s│├└─]+/, "")));
}

/** A box table's rule line: dashes with a column joint, nothing else. */
const TABLE_RULE_RE = /^\s*[├┌└╠╔╚]?[─═]*[┼┬┴╬╦╩][─═┼┬┴╬╦╩]*[┤┐┘╣╗╝]?\s*$/;
/** A box table's row: opens and closes with `│` and holds no arrow. */
const TABLE_ROW_RE = /^\s*[│║].*[│║]\s*$/;

function isBoxTable(lines: readonly string[]): boolean {
  if (!lines.some((l) => TABLE_RULE_RE.test(l))) return false;
  return lines.every((l) => /^\s*[┌└├╔╚╠]?[─═┼┬┴┤┐┘╬╦╩╣╗╝\s]*$/.test(l) || (TABLE_ROW_RE.test(l) && !ARROW_RE.test(l) && !/[▶◀►◄▼▲]/.test(l)));
}

/** A numbered message: `1.`, `1)`, `(1)` or `①` opening the line, or those
 *  and `1:` after a lifeline or an arrow stem (`│── 1. GET`, `|-- 1.`,
 *  `<-- 2.`). A stem is a box or pointer character, or an ASCII run of two or
 *  more, so a single `- ` or `> ` marker is prose. The run takes all of its
 *  characters, so a long dash line does not backtrack. */
const NUMBERED_RE = /^\s*(?:\d+[.)]|\(\d+\)|[①-⑳])\s|^\s*(?:(?:[│┃─━◀▶►◄]|[|<>-]{2,}(?![|<>-]))\s*)+(?:\d+[.):]|\(\d+\)|[①-⑳])\s/;
/** A box's top edge (`┌───┐`, `╔═══╗`, `┌─ desk ─┐`) is a participant head. */
const BOX_EDGE_RE = /^[┌╔].*[┐╗]$/;

/** A first-line column head names a participant when it is a box edge, or
 *  holds a letter or digit and no drawing token. Any other head, an arrow or
 *  rule of any spelling, makes the line a chain. */
function namesParticipant(head: string): boolean {
  return BOX_EDGE_RE.test(head) || (/[\p{L}\p{N}]/u.test(head) && !holdsDiagramToken(head));
}

/** `sequenceDiagram` when the first line names two or more participants
 *  (column heads three or more spaces apart, each naming a participant) and
 *  two or more lines are numbered messages; `flowchart` otherwise. */
export function suggestMermaidKind(lines: readonly string[]): "sequenceDiagram" | "flowchart" {
  const heads = lines[0]!.trim().split(/\s{3,}/).filter((h) => h !== "");
  if (!heads.every(namesParticipant)) return "flowchart";
  const numbered = lines.filter((l) => NUMBERED_RE.test(l)).length;
  return heads.length >= 2 && numbered >= 2 ? "sequenceDiagram" : "flowchart";
}

/** Folders whose pages the check skips (D13), matched as a path prefix. */
const SKIPPED_FOLDERS = ["archive/", "plans/"] as const;

export function checkTextDiagrams(page: { relPath: string }, rawContent: string): LintFinding[] {
  if (SKIPPED_FOLDERS.some((f) => page.relPath.startsWith(f))) return [];
  const lines = rawContent.split("\n");
  const start = frontmatterEndLine(lines);
  const findings: LintFinding[] = [];
  for (const { opener, closer, lang } of readerFences(lines.slice(start).join("\n"))) {
    const at = start + opener;
    const body = lines.slice(at + 1, start + closer).filter((l) => l.trim() !== "");
    if (lang !== "" && lang.toLowerCase() !== "text") continue;
    if (body.length < TEXT_DIAGRAM_MIN_LINES) continue;
    const tokenLines = body.filter(holdsDiagramToken).length;
    if (tokenLines < TEXT_DIAGRAM_MIN_SHARE * body.length) continue;
    // Rule lines alone are CLI output under a heading; they count only beside
    // another token line (a sequence's underlined participant heads).
    if (body.every((l) => RULE_ONLY_RE.test(l) || !holdsDiagramToken(l))) continue;
    if (isTree(body) || isBoxTable(body)) continue;
    const kind = suggestMermaidKind(body);
    findings.push({
      check: "text-diagram",
      relPath: page.relPath,
      message: `a text drawing in a code fence (${tokenLines} of ${body.length} lines hold an arrow or box); draw it as a mermaid ${kind}`,
      line: at + 1,
      severity: "info",
    });
  }
  return findings;
}
