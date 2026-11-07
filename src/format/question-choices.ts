/**
 * A question card's body read as its parts: the bold question line, the context
 * under it, one row per lettered choice (`- **A — label:** why`) and the
 * `**Recommendation: A.** why` line. Pure: the decision inbox renders the parts.
 * Regexes stay in the functions so a browser bundle importing this pays nothing
 * at load.
 */

import { parseRecommendation } from "./question.ts";

export interface QuestionChoiceRow {
  letter: string;
  label: string;
  why: string;
}

export interface QuestionChoices {
  context: string;
  rows: QuestionChoiceRow[];
  recommendation: { letter: string; why: string } | null;
}

/** The body's leading lone `**…**` line as `question` and the body after it as
 *  `rest`; with no such line, the first line and the whole body. Either way the
 *  question is plain text (backticks and bold markers dropped), as the row title prints it. */
export function splitQuestionLine(body: string): { question: string; rest: string } {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return { question: "", rest: body };
  const first = lines[i]!.trim();
  const bold = /^\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*$/.exec(first);
  if (bold) return { question: bold[1]!.replace(/`/g, "").trim(), rest: lines.slice(i + 1).join("\n").replace(/^\s*\n/, "") };
  return { question: first.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, ""), rest: body };
}

/**
 * The body's choice rows and recommendation, or null when the body is not in that
 * shape: no rows, row letters other than `choices` (same set, same order), or
 * text the parts would drop (prose after the rows, a recommendation that does
 * not open with a choice). `context` is the markdown
 * between the question line and the first row.
 */
export function parseQuestionChoices(body: string, choices: readonly string[]): QuestionChoices | null {
  const row = /^\s*[-*]\s+\*\*(.+?)(?:\s+[—–-]\s+(.+?))?(?::\*\*|\*\*:)\s*(.*)$/;
  const rec = /^\*\*(?:Recommendation|Anbefaling):\s*(.+?)\.?\*\*\s*(.*)$/;
  const lines = splitQuestionLine(body).rest.split("\n");
  const rows: QuestionChoiceRow[] = [];
  const context: string[] = [];
  let recommendation: { letter: string; why: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const r = recommendation ? null : row.exec(line);
    if (r) {
      rows.push({ letter: r[1]!.trim(), label: (r[2] ?? "").trim(), why: r[3]!.trim() });
      continue;
    }
    const m = rec.exec(line.trim());
    if (m && rows.length) {
      const said = m[1]!.trim();
      const why = [m[2]!, ...lines.slice(i + 1)].join("\n").trim();
      // The letter by the card's own rule, so «Recommended» marks what ★ and Take do.
      const lead = parseRecommendation(line.trim(), choices);
      if (!lead) return null;
      // `A, with D meanwhile`: the qualifier after the letter opens the why («Why A» names the letter).
      const qualifier = said.slice(said.indexOf(lead) + lead.length).replace(/^[\s»"'”’),;:—–-]+/u, "");
      recommendation = { letter: lead, why: qualifier ? `${qualifier}.${why ? ` ${why}` : ""}` : why };
      break;
    }
    if (!rows.length) context.push(line);
    else if (!line.trim()) continue;
    // An indented line continues the row above it.
    else if (/^\s+\S/.test(line)) rows[rows.length - 1]!.why += ` ${line.trim()}`;
    else return null;
  }
  if (!rows.length || rows.length !== choices.length || rows.some((r, i) => r.letter !== choices[i])) return null;
  return { context: context.join("\n").trim(), rows, recommendation };
}
