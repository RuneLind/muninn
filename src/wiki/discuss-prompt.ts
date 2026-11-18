/**
 * Discuss's handoff prompt (mimir plan muninn-wiki-discuss, P1): what the
 * reader copies for Claude Code. Five things from the pack (the path, the line
 * range, the passage, the question and, for a plan page, the card command) and
 * the instructions around them. Neither the section's text nor the card's goes
 * in: Claude Code reads the file, so the prompt stays near the prototype's 746
 * characters for one passage and one question. Pure.
 */

import { buildContextPack, type ContextPack, type PackInput } from "./discuss-pack.ts";

/** The question's bound, in characters. */
export const HANDOFF_QUESTION_MAX = 2000;
/** The whole prompt's bound, as the chat seeds' (`ASK_CHAT_SEED_MAX`). */
export const HANDOFF_PROMPT_MAX = 6000;
/** The heading trail's bound. */
const TRAIL_MAX = 200;

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

/** Where the passage sits, as the prompt says it. */
export function passageWhere(pack: ContextPack): string {
  const loc = pack.location;
  if (!loc) return "";
  const trail = pack.headingTrail.length ? `, ${clampLine(pack.headingTrail.join(" › "), TRAIL_MAX)}` : "";
  switch (loc.found) {
    case "one":
    case "occurrence":
      return loc.toLine === null
        ? `from line ${loc.fromLine}; its end was not found${trail}`
        : `${linesLabel(loc.fromLine!, loc.toLine)}${trail}`;
    case "section":
      return `not placed exactly; it is in the section «${clampLine(pack.section.heading ?? "", TRAIL_MAX)}», ${linesLabel(loc.fromLine!, loc.toLine!)}${matchesLabel(loc.candidates)}`;
    case "none":
      return `not found in the file as selected${matchesLabel(loc.candidates)}`;
  }
}

/** The prompt for one question, bounded at {@link HANDOFF_PROMPT_MAX}. */
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
  const build = (passage: string | null): string =>
    [
      ...head,
      "",
      `Page: ${pack.path}`,
      "",
      ...(passage !== null
        ? [`Passage (${passageWhere(pack)}):`, `> ${passage}`, "", `Question: ${q}`]
        : [`Question about the whole page: ${q}`]),
      "",
      tail,
    ].join("\n");
  if (pack.passage === null) return build(null).slice(0, HANDOFF_PROMPT_MAX);
  let passage = clampLine(pack.passage, pack.passage.length);
  let prompt = build(passage);
  if (prompt.length > HANDOFF_PROMPT_MAX) {
    // The passage gives way first: the path, the range and the question stay whole.
    passage = clampLine(passage, Math.max(80, passage.length - (prompt.length - HANDOFF_PROMPT_MAX)));
    prompt = build(passage);
  }
  return prompt.slice(0, HANDOFF_PROMPT_MAX);
}

/** The pack and the prompt for one handoff: what the route answers. */
export function buildHandoff(input: PackInput & { question: string }): { pack: ContextPack; prompt: string } {
  const pack = buildContextPack(input);
  return { pack, prompt: renderHandoffPrompt(pack, input.question) };
}
