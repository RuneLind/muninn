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

/** Sub-budgets for the article seed's three page-derived parts. All three come
 *  from the wiki INDEX (title, wiki-relative path, frontmatter description), so
 *  they are as long as an author cared to make them — bounded here so the seed
 *  cap stays a real bound rather than one the question alone pays for. */
export const ASK_CHAT_ARTICLE_TITLE_MAX = 120;
export const ASK_CHAT_ARTICLE_PATH_MAX = 200;
export const ASK_CHAT_ARTICLE_DESC_MAX = 400;

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
 *
 * Exported because every OTHER bounded-string surface has the same problem and
 * must not grow a fourth hand-rolled copy: the fact-check claim retry bounds a
 * client-echoed claim `title` and clips its `/agents` run name the same way.
 */
export function truncateUnits(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text.slice(0, max + 1)) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** Name used when a question flattens to nothing — an empty name throws in
 *  `createThread`, so SOMETHING has to be stored. */
export const ASK_CHAT_TITLE_FALLBACK = "wiki ask";

/**
 * Derive a thread name, or `null` when the source flattens to nothing.
 *
 * The null case is the whole point of the split: a caller with a SECOND source
 * (the route's typed `threadName`, falling back to the question) must be able to
 * tell "this text has no name in it" from "this text names the fallback" —
 * otherwise a name of only control characters silently pins the thread to the
 * generic fallback instead of falling back to the question it was typed beside.
 */
export function deriveAskThreadTitleOrNull(question: string): string | null {
  const flat = flatten(question || "").toLowerCase();
  if (!flat) return null;
  if (flat.length <= ASK_CHAT_TITLE_MAX) return flat;
  return truncateUnits(flat, ASK_CHAT_TITLE_MAX - 3) + "...";
}

/**
 * Derive a thread name from the escalated question. `createThread` lowercases,
 * trims, rejects newlines/tabs and hard-fails above 50 chars — so the name is
 * flattened, lowercased and truncated HERE (with an ellipsis marker) rather than
 * discovered as a throw at insert time. A question that flattens to nothing (only
 * control chars) falls back to a stable generic name, since an empty name throws.
 */
export function deriveAskThreadTitle(question: string): string {
  return deriveAskThreadTitleOrNull(question) ?? ASK_CHAT_TITLE_FALLBACK;
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

// ── Article thread identity ───────────────────────────────────────────
//
// An article's discussion thread is found by NAME (`findThreadByName` is scoped
// to user+bot), and a name is a lossy, collision-prone key: mimir + jarvis alone
// carry 13 colliding title groups over 30 pages (`architecture` ×3), and two
// DIFFERENT wikis owned by the same bot collide too (`repos/huginn.md` in mimir
// vs `entities/Huginn.md` in jarvis derive the same name). A plain `/topic` chat
// thread can hold the name as easily as an article thread can.
//
// So the thread's DESCRIPTION carries a deterministic article tag, and the
// route's 409 path parses it: tag matches this wiki+relPath ⇒ this really is the
// article's thread ("Send there →"); anything else ⇒ an unrelated thread that
// happens to own the name, and seeding a question onto it would cross-seed a
// conversation about a different page. Deliberately no schema migration — the
// description column already exists and is already per-mode prose.

/** Fixed head of an article thread's description. Also the parse anchor. */
const ARTICLE_DESC_PREFIX = 'Discussion of the wiki article "';
/** Separator between the (flattened, truncated) title and the machine tag. */
const ARTICLE_DESC_MID = '" (';

/**
 * The description an article-mode thread is created with:
 * `Discussion of the wiki article "<title>" (<wiki>:<relPath>)`.
 *
 * The title is flattened and truncated — it is authored text that used to reach
 * the column raw (control characters, unbounded length) — while the
 * `(<wiki>:<relPath>)` tail is kept whole, because that is the part
 * {@link parseArticleThreadTag} reads back. Parsing anchors on the LAST `" (`,
 * so a title containing quotes or parentheses cannot shadow the tag.
 */
export function buildArticleThreadDescription(input: {
  wikiName: string;
  pageTitle: string;
  relPath: string;
}): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const title = truncateUnits(flatten(str(input.pageTitle)), ASK_CHAT_ARTICLE_TITLE_MAX);
  const wiki = flatten(str(input.wikiName));
  const relPath = flatten(str(input.relPath));
  return ARTICLE_DESC_PREFIX + title + ARTICLE_DESC_MID + wiki + ":" + relPath + ")";
}

/**
 * The `(<wiki>:<relPath>)` tag out of a thread description, or `null` when the
 * description isn't an article tag at all (a plain chat thread, a direct/escalate
 * thread, or a pre-tag article thread).
 *
 * `null` is the SAFE answer everywhere it is consumed: it means "this thread is
 * not provably this article's", which routes to "start a new thread" rather than
 * to seeding someone else's conversation. The wiki name is split on the FIRST
 * colon so a relPath containing one survives.
 */
export function parseArticleThreadTag(
  description?: string | null,
): { wiki: string; relPath: string } | null {
  const text = typeof description === "string" ? description.trim() : "";
  if (!text.startsWith(ARTICLE_DESC_PREFIX) || !text.endsWith(")")) return null;
  const at = text.lastIndexOf(ARTICLE_DESC_MID);
  // An empty title puts the separator's quote at the prefix's own last index.
  if (at < ARTICLE_DESC_PREFIX.length - 1) return null;
  const tag = text.slice(at + ARTICLE_DESC_MID.length, -1);
  const colon = tag.indexOf(":");
  if (colon <= 0) return null;
  const wiki = tag.slice(0, colon).trim();
  const relPath = tag.slice(colon + 1).trim();
  if (!wiki || !relPath) return null;
  return { wiki, relPath };
}

/**
 * Whether a thread's description says it is THIS article's discussion thread.
 *
 * Wiki names are matched case-insensitively (the registry matches that way);
 * relPaths are compared exactly, since both sides come from the same wiki index.
 */
export function articleThreadTagMatches(
  description: string | null | undefined,
  wikiName: string,
  relPath: string,
): boolean {
  const tag = parseArticleThreadTag(description);
  if (!tag) return false;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return (
    tag.wiki.toLowerCase() === flatten(str(wikiName)).toLowerCase() &&
    tag.relPath === flatten(str(relPath))
  );
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
 * The question, clamped to whatever {@link ASK_CHAT_SEED_MAX} leaves it after the
 * seed's fixed parts (and any `reserve` a later part is guaranteed), never more
 * than {@link ASK_CHAT_QUESTION_MAX}. Shared by both seed builders — the budget
 * arithmetic was duplicated and is exactly the kind of thing that drifts.
 */
function clampQuestion(raw: string, fixedLen: number, reserve = 0): string {
  const budget = Math.max(
    0,
    Math.min(ASK_CHAT_QUESTION_MAX, ASK_CHAT_SEED_MAX - fixedLen - reserve),
  );
  if (raw.length <= budget) return raw;
  return truncateUnits(raw, Math.max(0, budget - QUESTION_TRUNC_NOTE.length)) + QUESTION_TRUNC_NOTE;
}

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
  const question = clampQuestion(rawQuestion, fixed, reserve);

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

/**
 * Build the message a DIRECT escalation auto-sends — the reader typed a question
 * and skipped the Ask tab entirely, so there is no answer to quote.
 *
 * A separate builder rather than `buildAskChatSeed({answer: ""})`: that one's
 * whole framing ("treat the answer below as PRIOR CONTEXT to build on") and its
 * budget math are written around a quoted answer, and with an empty one it emits
 * a stray blank quote plus a "What else should I know here?" tail that reads as
 * a follow-up to nothing.
 *
 * `webSearch` reflects the EFFECTIVE connector of the thread being created (the
 * chosen connector row's type, or the bot's own default) — `WebSearch` is a
 * built-in of `claude-cli`/`claude-sdk` only, so promising it to a Copilot or
 * openai-compat bot would instruct the agent to use a tool it does not have.
 *
 * `hasCollections` is the same kind of promise about the OTHER tool: "search the
 * wiki's own notes first" is a doomed instruction on a wiki with no backing
 * huginn collections (a `WIKI_EXTRA` entry without the 3rd segment), where it
 * produced answers that opened by apologizing for a search that could never work.
 *
 * `askDeclined` is the third: this question reached chat FROM a wiki Ask that
 * declined it, i.e. the wiki's own index has already been searched for this exact
 * question and came up with nothing solid. Ordering that search again is ordering
 * the one step known to fail — so the clause is replaced by what actually
 * happened, which also tells the bot not to report the empty index as its finding.
 *
 * **The opening is deliberately NOT first-person.** It used to read "I'm reading
 * the … wiki", and the memory extractor duly recorded a biographical fact about a
 * user who had merely clicked a button on a wiki they were browsing (observed: a
 * real memories row asserting the user "maintains" a throwaway test wiki). A
 * bracketed provenance line says where the question came from without putting
 * words in the reader's mouth.
 *
 * Bounded by the same {@link ASK_CHAT_SEED_MAX} the sibling builder is, with the
 * question carrying {@link ASK_CHAT_QUESTION_MAX} and a final surrogate-safe
 * clamp so the bound holds whatever the constants become.
 */
export function buildDirectChatSeed(input: {
  wikiName: string;
  question: string;
  webSearch: boolean;
  /** Whether the wiki has huginn collections its notes can actually be searched
   *  in. Absent ⇒ treated as true (the overwhelmingly common shape). */
  hasCollections?: boolean;
  /** Whether the wiki's Ask already DECLINED this question (no hits / only weak
   *  nearest-neighbours). Absent ⇒ false. */
  askDeclined?: boolean;
}): string {
  const rawQuestion = typeof input.question === "string" ? input.question.trim() : "";
  const wiki = flatten(typeof input.wikiName === "string" ? input.wikiName : "") || "knowledge";
  const declined = input.askDeclined === true;
  const searchable = input.hasCollections !== false;

  const opening = `[Question asked from the "${wiki}" wiki reader]\n\n`;
  const tools = input.webSearch ? "your tools, including web search" : "the tools you have";
  // The declined branch wins over `hasCollections`: a wiki that declined an Ask
  // necessarily HAS collections (that is what ran), and what it knows now is the
  // stronger fact.
  const framing =
    "\n\nAnswer it properly: " +
    (declined
      ? `the "${wiki}" wiki's own index has already been searched for this and had ` +
        `nothing solid on it, so don't stop at that — research it with ${tools}, `
      : searchable
        ? `search the "${wiki}" wiki's own notes first, then research beyond them with ${tools}, `
        : `research it with ${tools}, `) +
    "and cite what you find. Say plainly which parts you couldn't verify.";

  const question = clampQuestion(rawQuestion, opening.length + framing.length);

  const seed = opening + question + framing;
  return seed.length <= ASK_CHAT_SEED_MAX ? seed : truncateUnits(seed, ASK_CHAT_SEED_MAX);
}

/**
 * Build the message an ARTICLE escalation auto-sends — the reader was reading one
 * wiki page and asked about it, without going through the Ask tab at all.
 *
 * A third builder rather than a flag on {@link buildDirectChatSeed}: the whole
 * point of this mode is that the question is ABOUT a specific page, so the seed
 * has to name that page and hand the bot the one thing the chat side cannot
 * derive — its **wiki-relative path**, which is exactly what a knowledge search
 * resolves a hit to. Without it the bot re-searches for the article by title and
 * frequently answers from a different page.
 *
 * The framing follows its two siblings' rules:
 * - **Not first-person.** `buildDirectChatSeed`'s comment has the history: an
 *   "I'm reading the … wiki" opening got a biographical `memories` row written
 *   about a reader who had only clicked a button. Bracketed provenance instead.
 * - **`webSearch` reflects the EFFECTIVE connector** of the thread being created,
 *   so the seed never orders a tool the bot doesn't have.
 * - **`hasCollections`** gates the "pull the page up with your knowledge tools"
 *   instruction for the same reason the direct seed gates its notes-first clause:
 *   on a wiki with no backing huginn collections that lookup cannot work, and
 *   ordering it produces an answer that opens by apologizing.
 *
 * **But `hasCollections` is config-PRESENCE, not capability**, and that is why the
 * searchable branch is phrased as an attempt rather than a precondition: mimir
 * declares a collection named `mimir` that does not exist in huginn, and a real
 * model turn opened with "I can't pull up this article…" — the retrieval failure
 * became the answer. So the seed says what to do when the page isn't indexed
 * (one line, then answer from the question + research), which no
 * collections-config check can ever guarantee on its own.
 *
 * `description` is the page's own summary (frontmatter `description`, else the
 * first prose line). It is a parenthetical, and an ABSENT one leaves no trace —
 * an empty `()` would read as a page whose summary is the empty string.
 *
 * Bounded by the same {@link ASK_CHAT_SEED_MAX} as both siblings: each
 * page-derived part carries its own cap, the question keeps
 * {@link ASK_CHAT_QUESTION_MAX} (shrunk by whatever the fixed parts take), and a
 * final surrogate-safe clamp holds the total whatever the constants become.
 */
export function buildArticleChatSeed(input: {
  wikiName: string;
  /** The page's display title, for the provenance line. */
  pageTitle: string;
  /** The page's wiki-relative path — what the bot needs to pull the real page. */
  pagePath: string;
  question: string;
  /** The page's own summary. Absent/empty ⇒ no parenthetical at all. */
  description?: string;
  webSearch: boolean;
  /** Whether the wiki has huginn collections its pages can be looked up in.
   *  Absent ⇒ treated as true (the overwhelmingly common shape). */
  hasCollections?: boolean;
}): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const rawQuestion = str(input.question).trim();
  const wiki = flatten(str(input.wikiName)) || "knowledge";
  const title = truncateUnits(flatten(str(input.pageTitle)), ASK_CHAT_ARTICLE_TITLE_MAX);
  const path = truncateUnits(flatten(str(input.pagePath)), ASK_CHAT_ARTICLE_PATH_MAX);
  // A page summary is a sentence and usually ends in one period; the parenthetical
  // it sits in ends in another, so the raw value reads `(… pages.).`
  // TRUNCATE FIRST, then strip: stripping first only cleans the tail the reader
  // would have seen if nothing were cut — a summary long enough to be truncated
  // can land the cut right after a mid-sentence period and read `(… pages.).`
  // anyway, which is the exact shape this strip exists to prevent.
  const description = truncateUnits(
    flatten(str(input.description)),
    ASK_CHAT_ARTICLE_DESC_MAX,
  ).replace(/\.$/, "");
  const searchable = input.hasCollections !== false;

  const opening = title
    ? `[Question asked while reading the "${wiki}" wiki article "${title}"]\n\n`
    : `[Question asked while reading the "${wiki}" wiki]\n\n`;
  const tools = input.webSearch ? "your tools, including web search" : "the tools you have";
  const article =
    "\n\nThe article is " +
    (path ? `\`${path}\`` : `"${title || "untitled"}"`) +
    ` in the "${wiki}" wiki` +
    (description ? ` (${description})` : "") +
    ". ";
  const framing =
    (searchable
      ? "Try to pull it up with your knowledge tools first — and if it isn't indexed " +
        "there, say so in ONE line and answer the question from what you can research " +
        "instead; never open with an apology about not finding the page. Research " +
        "beyond it with "
      : "Answer from what you can establish about it — research it with ") +
    tools +
    ", and cite what you find. Say plainly which parts you couldn't verify.";

  const question = clampQuestion(rawQuestion, opening.length + article.length + framing.length);

  const seed = opening + question + article + framing;
  return seed.length <= ASK_CHAT_SEED_MAX ? seed : truncateUnits(seed, ASK_CHAT_SEED_MAX);
}
