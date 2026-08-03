/**
 * Pure helpers for the wiki Ask → chat escalation ("Continue in chat →").
 *
 * The /wiki Ask tab answers statelessly from wiki chunks — no memories, no
 * goals, no persona, no MCP tools. Escalating spawns a real conversation thread
 * for the wiki's OWNING bot, seeded with the question + the Ask answer + its
 * citations, so the continuation runs through the full prompt-builder context
 * the Ask tab lacks.
 *
 * Everything here is string work only (no DB, no Hono): the route owns thread
 * creation and the pending-message handoff, these functions own the two shapes
 * that are easy to get wrong — a thread NAME that satisfies `createThread`'s
 * constraints, and a bounded seed message.
 */

/** Max thread-name length enforced by `createThread` (db/threads.ts). */
export const ASK_CHAT_TITLE_MAX = 50;

/** Hard upper bound on the WHOLE seeded message — question, quoted answer and
 *  sources line together. Every part has its own sub-budget below so this is a
 *  real bound and not just an answer budget (a 200k-char question used to ride
 *  along untruncated and produce a 205k-char seed). */
export const ASK_CHAT_SEED_MAX = 6000;

/** Sub-budget for the question inside {@link ASK_CHAT_SEED_MAX}. A question long
 *  enough to matter here is a pasted document, not a question. */
export const ASK_CHAT_QUESTION_MAX = 1500;

/** Sub-budget for the whole `Sources cited by the wiki: …` line. */
export const ASK_CHAT_SOURCES_MAX = 500;

/** Chars the answer is guaranteed whenever it is non-empty — the question's
 *  budget shrinks before the answer's does, since a seed that carries the
 *  question and NONE of the answer defeats the point of escalating. */
export const ASK_CHAT_ANSWER_MIN = 2000;

/** A citation as the Ask client holds it — page name preferred, title as fallback. */
export interface AskChatCitation {
  title?: string;
  pageName?: string;
}

/** Control characters `createThread` rejects (newlines/tabs) plus the rest of the
 *  C0/C1 range, which have no business in a thread name or a seed source list. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Collapse every whitespace run (incl. the newlines/tabs `createThread` rejects)
 *  into single spaces and drop other control characters. */
function flatten(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * Truncate to at most `max` UTF-16 code units WITHOUT splitting a surrogate pair.
 * A bare `slice` halves an astral char and stores a U+FFFD (observed in real
 * thread names), and a code-POINT slice can overshoot the unit budget
 * `createThread` actually enforces — so this walks code points and stops before
 * the unit count would exceed `max`. The `slice(0, max + 1)` pre-cut keeps the
 * walk O(max) on a huge input; a pair straddling the cut is left incomplete in
 * the head and is rejected by the same length test.
 */
function truncateUnits(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text.slice(0, max + 1)) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * Derive a thread name from the escalated question. `createThread` lowercases,
 * trims, rejects newlines/tabs and hard-fails above 50 chars — so the name is
 * flattened, lowercased and truncated HERE (with an ellipsis marker) rather than
 * discovered as a throw at insert time. A question that flattens to nothing (only
 * control chars) falls back to a stable generic name, since an empty name throws.
 */
export function deriveAskThreadTitle(question: string): string {
  const flat = flatten(question || "").toLowerCase();
  if (!flat) return "wiki ask";
  if (flat.length <= ASK_CHAT_TITLE_MAX) return flat;
  return truncateUnits(flat, ASK_CHAT_TITLE_MAX - 3) + "...";
}

/**
 * Append a `-YYYY-MM-DD-HHMM` suffix to a thread name so a `forceNew` retry gets
 * a fresh thread instead of colliding with the existing one (mirrors
 * /api/research/chat). The base is trimmed so the result still fits in 50 chars.
 *
 * The suffix is MINUTE-precision, so two escalations of the same question inside
 * one minute derive the same name — and `createThread` is `ON CONFLICT DO UPDATE`,
 * which would hand the second caller the FIRST thread back (and clobber its unsent
 * seed) instead of failing. `attempt` (2, 3, …) appends a disambiguator the route
 * walks until `findThreadByName` reports the name free; room for it is taken out
 * of the base, never out of the 50-char limit.
 */
export function uniqueAskThreadTitle(
  title: string,
  now: Date = new Date(),
  attempt = 1,
): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const suffix =
    `-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}` +
    (attempt > 1 ? `-${attempt}` : "");
  const room = ASK_CHAT_TITLE_MAX - suffix.length;
  return truncateUnits(title, room) + suffix;
}

/** How many citations the seed lists before stopping. */
const SEED_SOURCE_CAP = 8;

/** Citation display names, deduped and capped — the seed's Sources line. The
 *  per-field `typeof` guard is load-bearing: the citations come straight off a
 *  client-posted JSON body, where `{"pageName": 123}` would otherwise reach
 *  `flatten`'s `.replace` and throw a TypeError out of a pure builder. */
function sourceNames(citations: AskChatCitation[] | undefined, cap: number): string[] {
  const out: string[] = [];
  for (const c of citations ?? []) {
    const raw =
      typeof c?.pageName === "string" ? c.pageName : typeof c?.title === "string" ? c.title : "";
    const name = flatten(raw);
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= cap) break;
  }
  return out;
}

/** Marker appended when the question didn't fit its sub-budget. */
const QUESTION_TRUNC_NOTE = " …(question truncated)";

/** Marker appended when the quoted answer didn't fit its budget. */
const ANSWER_TRUNC_NOTE = "\n> …(answer truncated)";

/**
 * The `Sources cited by the wiki: …` line, capped at {@link ASK_CHAT_SOURCES_MAX}.
 * Overflowing names are dropped from the end and reported as `+N more` rather
 * than silently vanishing; a single pathologically long name is truncated so the
 * cap holds even at one entry. Empty list ⇒ empty string (no line at all).
 */
function buildSourcesLine(names: string[]): string {
  if (!names.length) return "";
  const label = "Sources cited by the wiki: ";
  const kept = [...names];
  let dropped = 0;
  const body = (): string => kept.join(" · ") + (dropped ? ` · +${dropped} more` : "");
  while (kept.length > 1 && (label + body()).length > ASK_CHAT_SOURCES_MAX) {
    kept.pop();
    dropped++;
  }
  let line = label + body();
  if (line.length > ASK_CHAT_SOURCES_MAX) {
    line = truncateUnits(line, ASK_CHAT_SOURCES_MAX - 1) + "…";
  }
  return `\n${line}\n`;
}

/**
 * Build the message the escalated thread auto-sends.
 *
 * Framing matters: the quoted block is PRIOR CONTEXT the bot should extend or
 * correct, not a question to re-answer from scratch.
 *
 * **The whole seed really is bounded at {@link ASK_CHAT_SEED_MAX}.** Every
 * variable part carries its own sub-budget — question {@link ASK_CHAT_QUESTION_MAX},
 * sources {@link ASK_CHAT_SOURCES_MAX}, and the answer takes whatever is left
 * (never less than {@link ASK_CHAT_ANSWER_MIN} while it is non-empty, since the
 * question's budget shrinks first). Each cut is marked explicitly, so a
 * truncation is visible to the bot rather than a silent amputation. A final
 * surrogate-safe clamp makes the bound hold whatever the constants are set to.
 */
export function buildAskChatSeed(input: {
  wikiName: string;
  question: string;
  answer: string;
  citations?: AskChatCitation[];
}): string {
  const rawQuestion = typeof input.question === "string" ? input.question.trim() : "";
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  const wiki = flatten(typeof input.wikiName === "string" ? input.wikiName : "") || "knowledge";

  const opening = `I asked the "${wiki}" wiki:\n\n`;
  const framing =
    "\n\nThe wiki's Ask tab answered from indexed page excerpts alone — no memories, " +
    "no tools, no wider context. Treat its answer below as PRIOR CONTEXT to build " +
    "on: extend it, correct anything wrong, and bring in everything else you know. " +
    "Don't just repeat it back.\n\n";
  const sources = buildSourcesLine(sourceNames(input.citations, SEED_SOURCE_CAP));
  const tail = "\nWhat else should I know here?";

  // Question sub-budget: its own cap, further reduced if the fixed parts plus the
  // answer's guaranteed minimum wouldn't otherwise leave room. The `+ 1` is the
  // newline between the quote and the sources line.
  const fixed = opening.length + framing.length + sources.length + tail.length + 1;
  const reserve = answer ? ASK_CHAT_ANSWER_MIN + ANSWER_TRUNC_NOTE.length : 0;
  const questionBudget = Math.max(
    0,
    Math.min(ASK_CHAT_QUESTION_MAX, ASK_CHAT_SEED_MAX - fixed - reserve),
  );
  const question =
    rawQuestion.length <= questionBudget
      ? rawQuestion
      : truncateUnits(rawQuestion, Math.max(0, questionBudget - QUESTION_TRUNC_NOTE.length)) +
        QUESTION_TRUNC_NOTE;

  const head = opening + question + framing;

  // Budget for the quoted answer = whatever the (now bounded) fixed parts don't
  // use. The quote is blockquoted line-by-line (2 extra chars per line), so the
  // budget is applied to the ALREADY-quoted text.
  const overhead = head.length + sources.length + tail.length + 1;
  const budget = Math.max(0, ASK_CHAT_SEED_MAX - overhead);
  let quoted = answer
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  if (quoted.length > budget) {
    quoted =
      truncateUnits(quoted, Math.max(0, budget - ANSWER_TRUNC_NOTE.length)) + ANSWER_TRUNC_NOTE;
  }

  const seed = head + quoted + "\n" + sources + tail;
  return seed.length <= ASK_CHAT_SEED_MAX ? seed : truncateUnits(seed, ASK_CHAT_SEED_MAX);
}
