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

/** Progressive markdown → HTML for the accumulating Ask stream buffer. Rendered
 *  into the same `.wiki-article`-styled body as the final answer, so headings,
 *  lists and code grow formatted during the stream instead of as plain text. */
export function renderStreamingBody(text: string): string {
  return formatWebHtml(text);
}

/** Body HTML for one Ask turn: the server-rendered final article once it has
 *  arrived (`html`, unchanged — it also resolves citations), else the
 *  progressively-formatted streaming buffer (or the stored plain answer on a
 *  history re-show that never received `answer_html`). */
export function askAnswerBodyHtml(html: string | null, buffer: string, answer: string): string {
  return html || renderStreamingBody(buffer || answer || "");
}
