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

/** Upper bound on the whole seeded message (question + quoted answer + sources). */
export const ASK_CHAT_SEED_MAX = 6000;

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
  return flat.slice(0, ASK_CHAT_TITLE_MAX - 3) + "...";
}

/**
 * Append a `-YYYY-MM-DD-HHMM` suffix to a thread name so a `forceNew` retry gets
 * a fresh thread instead of colliding with the existing one (mirrors
 * /api/research/chat). The base is trimmed so the result still fits in 50 chars.
 */
export function uniqueAskThreadTitle(title: string, now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const suffix =
    `-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`;
  const room = ASK_CHAT_TITLE_MAX - suffix.length;
  return (title.length > room ? title.slice(0, room) : title) + suffix;
}

/** How many citations the seed lists before stopping. */
const SEED_SOURCE_CAP = 8;

/** Citation display names, deduped and capped — the seed's Sources line. */
function sourceNames(citations: AskChatCitation[] | undefined, cap: number): string[] {
  const out: string[] = [];
  for (const c of citations ?? []) {
    const name = flatten(c?.pageName || c?.title || "");
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Build the message the escalated thread auto-sends.
 *
 * Framing matters: the quoted block is PRIOR CONTEXT the bot should extend or
 * correct, not a question to re-answer from scratch. The whole seed is bounded at
 * {@link ASK_CHAT_SEED_MAX}; when it doesn't fit, the ANSWER is what gets cut
 * (with an explicit truncation note), never the question or the sources — those
 * are what make the continuation addressable.
 */
export function buildAskChatSeed(input: {
  wikiName: string;
  question: string;
  answer: string;
  citations?: AskChatCitation[];
}): string {
  const question = (input.question || "").trim();
  const answer = (input.answer || "").trim();
  const wiki = flatten(input.wikiName || "") || "knowledge";
  const names = sourceNames(input.citations, SEED_SOURCE_CAP);

  const head =
    `I asked the "${wiki}" wiki:\n\n${question}\n\n` +
    "The wiki's Ask tab answered from indexed page excerpts alone — no memories, " +
    "no tools, no wider context. Treat its answer below as PRIOR CONTEXT to build " +
    "on: extend it, correct anything wrong, and bring in everything else you know. " +
    "Don't just repeat it back.\n\n";
  const sources = names.length ? `\nSources cited by the wiki: ${names.join(" · ")}\n` : "";
  const tail = "\nWhat else should I know here?";

  // Budget for the quoted answer = whatever the fixed parts don't use. The quote
  // is blockquoted line-by-line (2 extra chars per line), so the budget is
  // applied to the ALREADY-quoted text.
  const truncNote = "\n> …(answer truncated)";
  const overhead = head.length + sources.length + tail.length + 1;
  const budget = Math.max(0, ASK_CHAT_SEED_MAX - overhead);
  let quoted = answer
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  if (quoted.length > budget) {
    quoted = quoted.slice(0, Math.max(0, budget - truncNote.length)) + truncNote;
  }

  return head + quoted + "\n" + sources + tail;
}
