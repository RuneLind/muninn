/**
 * Pure, side-effect-free progressive renderer for the /wiki reader's **Ask**
 * answer body. Split out from `wiki-browser.ts` (which has DOM side effects at
 * module load, so it can't be imported in tests) so these can be unit-tested
 * directly — the same split rationale as `wiki-filter.ts`.
 *
 * `formatWebHtml` is imported directly from its canonical module (the exact
 * pattern `web-format-browser.ts` uses) so the reader renders streaming markdown
 * with the SAME formatter as the server's final `answer_html`. The formatter
 * already tolerates half-finished constructs mid-stream (unclosed fences etc.),
 * exactly as the web chat relies on. No client-side sanitize: the wiki injects
 * server-rendered `answer_html` unsanitized today, so the progressive render
 * matches that convention consciously.
 */

import { formatWebHtml } from "../../../web/web-format.ts";

/**
 * Matches a standalone `Confidence: NN/100` line in **formatWebHtml output**.
 * Critical: `formatWebHtml` emits paragraphs as BARE TEXT NODES (no `<p>`/`<li>`
 * wrapper), so the old DOM enhancer's `querySelectorAll("p, li")` matched nothing
 * and the chip was a silent no-op on every render path. This string-level matcher
 * anchors on a line/tag boundary (`^` / `\n` / `>`), is case-insensitive (models
 * emit `confidence:` too), and is followed by a boundary so it never fires inside
 * an attribute or mid-sentence. Idempotent by construction: the replacement drops
 * the literal `Confidence:` token, so a re-run can't re-match a rewritten line.
 */
const CONFIDENCE_HTML_RE = /(^|\n|>)([ \t]*)Confidence:[ \t]*(\d{1,3})\/100(?=$|\n|<)/gi;

/**
 * Turn every standalone `Confidence: NN/100` line in fact-check HTML into a
 * band-colored evidence-strength chip (green ≥80 · amber 50–79 · red <50) with
 * the score inside. Pure `string → string` (unit-testable, no DOM) and runs over
 * the SAME `formatWebHtml` output the reader paints. The emoji is the ruling; this
 * chip is EVIDENCE STRENGTH only — never derived from the verdict. A no-op on
 * Ask/Explain answers (they carry no such line), so it's safe to apply to every
 * answer body.
 */
export function enhanceConfidenceHtml(html: string): string {
  return html.replace(CONFIDENCE_HTML_RE, (_m, pre: string, ws: string, digits: string) => {
    const n = Math.max(0, Math.min(100, parseInt(digits, 10)));
    const band = n >= 80 ? "hi" : n >= 50 ? "mid" : "lo";
    return (
      pre + ws +
      '<span class="wiki-fc-conf-line">' +
      '<span class="wiki-fc-conf-key">Confidence</span>' +
      '<span class="wiki-fc-conf-chip ' + band + '">' + n + "/100</span>" +
      "</span>"
    );
  });
}

/** Progressive markdown → HTML for the accumulating Ask stream buffer. Rendered
 *  into the same `.wiki-article`-styled body as the final answer, so headings,
 *  lists and code grow formatted during the stream instead of as plain text. The
 *  confidence-chip enhancement is baked in here so EVERY streaming/done render of a
 *  fact-check buffer carries the chip (no per-call-site opt-in to forget). */
export function renderStreamingBody(text: string): string {
  return enhanceConfidenceHtml(formatWebHtml(text));
}

/** Body HTML for one Ask turn: the server-rendered final article once it has
 *  arrived (`html`, confidence-enhanced but otherwise unchanged — it also resolves
 *  citations), else the progressively-formatted streaming buffer (or the stored
 *  plain answer on a history re-show that never received `answer_html`). */
export function askAnswerBodyHtml(html: string | null, buffer: string, answer: string): string {
  return html ? enhanceConfidenceHtml(html) : renderStreamingBody(buffer || answer || "");
}
