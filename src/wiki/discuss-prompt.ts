/**
 * Discuss's handoff prompt (mimir plan muninn-wiki-discuss, P1): what the
 * reader copies for Claude Code. Five things from the pack (the path, the line
 * range, the passage, the question and, for a plan page, the card command) and
 * the instructions around them. Neither the section's text nor the card's goes
 * in: Claude Code reads the file, so the prompt stays near the prototype's 746
 * characters for one passage and one question. Pure.
 */

import { HANDOFF_QUESTION_MAX } from "./discuss-bounds.ts";
import { buildContextPack, type ContextPack, type PackInput } from "./discuss-pack.ts";

export { HANDOFF_QUESTION_MAX };
/** The whole prompt's bound, as the chat seeds' (`ASK_CHAT_SEED_MAX`). */
export const HANDOFF_PROMPT_MAX = 6000;
/** The heading trail's bound. */
const TRAIL_MAX = 200;
/** The quote never shrinks below this many characters. */
const QUOTE_MIN = 80;

/** The plan-card command for one page: plan-card's own script, run by Bun
 *  without muninn's `.env`. A path with anything but safe characters is quoted. */
export function planCardCommand(bin: string, absPath: string): string {
  const q = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return `bun --no-env-file ${q(bin)} ${q(absPath)}`;
}

/** Collapse white space to single spaces and cut at `max`, marking the cut. */
export function clampLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function linesLabel(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

function matchesLabel(lines: number[]): string {
  if (lines.length === 0) return "";
  const shown = lines.slice(0, 6).join(", ");
  return `; the text matches at lines ${shown}${lines.length > 6 ? ", …" : ""}`;
}

const MISS_WORDS: Record<string, string> = {
  "no-match": "the file does not hold it as selected",
  "no-agreement": "the text around it in the file does not match the page as shown",
  ambiguous: "it matches more than one place",
  added: "it starts or ends in text the reader adds",
  reordered: "it spans parts the reader shows in another order",
};

/** Where the passage sits, as the prompt says it. A range is stated as the
 *  passage's own only for an `exact` result; otherwise the words say it was
 *  not placed. */
export function passageWhere(pack: ContextPack): string {
  const loc = pack.location;
  if (!loc) return "";
  const why = MISS_WORDS[loc.reason ?? ""] ?? "";
  switch (loc.found) {
    case "exact": {
      const trail = pack.headingTrail.length ? `, ${clampLine(pack.headingTrail.join(" › "), TRAIL_MAX)}` : "";
      return `${linesLabel(loc.fromLine!, loc.toLine!)}${trail}`;
    }
    case "section":
      return `not placed exactly: ${why}; it is in the section «${clampLine(loc.section?.heading ?? "", TRAIL_MAX)}», ${linesLabel(loc.fromLine!, loc.toLine!)}${matchesLabel(loc.candidates)}`;
    case "none":
      return `not placed: ${why}${matchesLabel(loc.candidates)}`;
  }
}

/** The quote as the prompt carries it: whole when it fits `room`, else cut
 *  with a visible mark. The mark says the lines cover all of it only when
 *  `ranged`: the prompt states the passage's own range. */
export function quoteFor(passage: string, room: number, ranged = false): string {
  const flat = clampLine(passage, passage.length);
  if (flat.length <= room) return flat;
  const covers = ranged ? "; the lines above cover the whole passage" : "";
  const mark = (rest: number) => ` [… ${rest.toLocaleString("en-US")} more characters cut here${covers}]`;
  const keep = Math.max(QUOTE_MIN, room - mark(flat.length).length);
  const head = flat.slice(0, keep).trimEnd();
  return head + mark(flat.length - head.length);
}

/** The prompt for one question, bounded at {@link HANDOFF_PROMPT_MAX} (the
 *  question at {@link HANDOFF_QUESTION_MAX}, the quote by what is left). The
 *  question comes last, so nothing after it can read as its frame. */
export function renderHandoffPrompt(pack: ContextPack, question: string): string {
  const q = question.trim().slice(0, HANDOFF_QUESTION_MAX);
  const head = pack.cardCommand
    ? [
        pack.passage
          ? "Read the card first, then the lines I point at. Do not load the whole page unless you need it:"
          : "Read the card first, then the parts of the page the question needs:",
        `  ${pack.cardCommand}`,
      ]
    : [pack.passage ? "Read the lines I point at. Do not load the whole page unless you need it." : "Read the parts of the page the question needs."];
  const tail = "Check the code before you answer. If the page turns out to be wrong, show me the edit before you write it.";
  const build = (quote: string | null): string =>
    [
      ...head,
      "",
      `Page: ${pack.path}`,
      "",
      ...(quote !== null ? [`Passage (${passageWhere(pack)}):`, `> ${quote}`, ""] : []),
      tail,
      "",
      quote !== null ? `Question: ${q}` : `Question about the whole page: ${q}`,
    ].join("\n");
  if (pack.passage === null) return build(null);
  return build(quoteFor(pack.passage, HANDOFF_PROMPT_MAX - build("").length, pack.location?.found === "exact"));
}

/** The pack and the prompt for one handoff: what the route answers. */
export function buildHandoff(input: PackInput & { question: string }): { pack: ContextPack; prompt: string } {
  const pack = buildContextPack(input);
  return { pack, prompt: renderHandoffPrompt(pack, input.question) };
}

/** One turn of a discussion, as the continue prompt carries it. */
export interface ContinueTurn {
  seq: number;
  selection: string | null;
  /** The turn row's stored location (`{found, fromLine, toLine}`), or null. */
  location: unknown;
  question: string;
  answer: string;
  endState: string;
  /** The live page's hash differs from the turn's `page_hash` (or the page is
   *  gone): the stored lines name the page as it was, so they are left out. */
  pageChanged: boolean;
}

/** The continue prompt's bound: two handoff prompts, since it carries answers. */
export const CONTINUE_PROMPT_MAX = 2 * HANDOFF_PROMPT_MAX;
/** Each answer is cut here before the whole is fitted. */
const CONTINUE_ANSWER_MAX = 3000;

function turnWhere(location: unknown, pageChanged: boolean): string {
  if (pageChanged) return "lines not given: the page has changed since this turn";
  const loc = location as { found?: unknown; fromLine?: unknown; toLine?: unknown } | null;
  if (!loc || typeof loc.fromLine !== "number" || typeof loc.toLine !== "number") return "not placed";
  const lines = linesLabel(loc.fromLine, loc.toLine);
  return loc.found === "exact" ? lines : `not placed exactly; in the section at ${lines}`;
}

function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}… [cut]`;
}

/**
 * «Continue in Claude Code» (P3): the prompt that takes a Discuss discussion
 * on to Claude Code, up to and including the turn handed over. The page path,
 * then each turn's passage, question and answer, oldest first. When the whole
 * is over {@link CONTINUE_PROMPT_MAX}, the oldest turns' answers go first, then
 * the oldest turns; the handed-over turn always stays. Pure.
 */
export function renderContinuePrompt(input: { path: string; turns: ContinueTurn[] }): string {
  const head = [
    "I discussed this wiki page with muninn's wiki agent and want to go on here. Its answers below may be wrong: read the page and the code it names before you answer.",
    "",
    `Page: ${input.path}`,
    "",
  ];
  const tail = ["", "Go on from the last answer. If the page turns out to be wrong, show me the edit before you write it."];
  const block = (t: ContinueTurn, withAnswer: boolean): string[] => [
    `Turn ${t.seq}${t.selection ? ` (passage, ${turnWhere(t.location, t.pageChanged)}):` : " (about the whole page):"}`,
    ...(t.selection ? [`> ${clampLine(t.selection, 1500)}`] : []),
    `Question: ${clampLine(t.question, HANDOFF_QUESTION_MAX)}`,
    withAnswer
      ? `Answer${t.endState === "done" ? "" : ` (the turn ended ${t.endState})`}:\n${cut(t.answer, CONTINUE_ANSWER_MAX) || "(none)"}`
      : "Answer: (left out to fit)",
    "",
  ];
  const turns = [...input.turns].sort((a, b) => a.seq - b.seq);
  let from = 0;
  let answersFrom = 0;
  const build = () =>
    [...head, ...turns.slice(from).flatMap((t, k) => block(t, from + k >= answersFrom)), ...tail].join("\n").replace(/\n{3,}/g, "\n\n");
  let out = build();
  while (out.length > CONTINUE_PROMPT_MAX && answersFrom < turns.length - 1) {
    answersFrom++;
    out = build();
  }
  while (out.length > CONTINUE_PROMPT_MAX && from < turns.length - 1) {
    from++;
    out = build();
  }
  return out.length > CONTINUE_PROMPT_MAX ? out.slice(0, CONTINUE_PROMPT_MAX - 1) + "…" : out;
}
