/**
 * A question card's body read as its parts: the bold question line, the context
 * under it, one row per lettered choice (`- **A — label:** why`) and the
 * `**Recommendation: A.** why` line. Server-side only: it imports the web
 * renderer for titles, so a browser bundle must not import it.
 */

import { formatWebHtml } from "../web/web-format.ts";
import { parseRecommendation } from "./question.ts";

export interface QuestionChoiceRow {
  letter: string;
  label: string;
  why: string;
}

export interface QuestionChoices {
  context: string;
  rows: QuestionChoiceRow[];
  /** `qualified`: the bold part is not the bare letter: more words (`A, with D
   *  meanwhile`) or markup (`«A»`, `` `A` ``); `why` then opens with that whole part, unsliced. */
  recommendation: { letter: string; why: string; qualified: boolean } | null;
}

/** The body's leading lone `**…**` line as `question` and the body after it as
 *  `rest`; with no such line, the first line and the whole body. Either way the
 *  question is plain text (`plainInline`), as the row title prints it. */
export function splitQuestionLine(body: string): { question: string; rest: string } {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return { question: "", rest: body };
  const first = lines[i]!.trim();
  const bold = /^\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*$/.exec(first);
  if (bold) return { question: plainInline(bold[1]!), rest: lines.slice(i + 1).join("\n").replace(/^\s*\n/, "") };
  return { question: plainInline(first.replace(/^#+\s*/, "")), rest: body };
}

/** One line of markdown as the text the shared renderer prints for it (the card
 *  body's own renderer), so code spans, escapes, links and emphasis follow its
 *  rules: tags and Fact-check chips dropped, `escapeHtml`'s four escapes decoded
 *  (`&#39;` too, which it never emits), `&amp;` last so an author's `&lt;` stays. */
function plainInline(md: string): string {
  return formatWebHtml(md)
    .replace(/<button\b[^>]*>[^]*?<\/button>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * The body's choice rows and recommendation, or null when the body is not in that
 * shape: no rows, row letters other than `choices` (same set, same order), or
 * text the parts would drop (prose after the rows, a recommendation that does
 * not open with a choice), or a recommendation line whose letter is not the
 * card's own (`parseRecommendation` over the whole body). `context` is the markdown
 * between the question line and the first row.
 */
export function parseQuestionChoices(body: string, choices: readonly string[]): QuestionChoices | null {
  const row = /^\s*[-*]\s+\*\*(.+?)(?:\s+[—–-]\s+(.+?))?(?::\*\*|\*\*:)\s*(.*)$/;
  const rec = /^\*\*(?:Recommendation|Anbefaling):\s*(.+?)\.?\*\*\s*(.*)$/;
  const lines = splitQuestionLine(body).rest.split("\n");
  const rows: QuestionChoiceRow[] = [];
  const context: string[] = [];
  let recommendation: QuestionChoices["recommendation"] = null;
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
      // The card's recommendation is the whole body's first marker (facts.ts); a line
      // that names another letter, or none, is refused so «Recommended» marks what ★ and Take do.
      const lead = parseRecommendation(line.trim(), choices);
      if (!lead || lead !== parseRecommendation(body, choices)) return null;
      const qualified = said.normalize("NFC") !== lead.normalize("NFC");
      recommendation = { letter: lead, why: qualified ? `${said}.${why ? ` ${why}` : ""}` : why, qualified };
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
