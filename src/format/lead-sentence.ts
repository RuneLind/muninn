/**
 * A list item's lead sentence as plain text — the `/plans` board's step line
 * and the «Oppfølging» block's peek. Browser-safe.
 */

import { COMPONENT_TAG_SOURCE_SINGLE_LINE, componentTagSourceSingleLine } from "./markdown-ast.ts";
import { COMPONENT_NAMES } from "./component-spec.ts";
import { isAbbreviation } from "./abbreviations.ts";
import { trailingCheck } from "./check-trailing.ts";
import { lineCodeSpanRanges } from "./code-spans.ts";

/** A lead sentence's length cap. */
export const MOVES_STEP_CHARS = 160;

/** Where the first sentence of `text` ends (the index after its `.`/`!`/`?`),
 *  or -1. A dot closing a known abbreviation is not an end. */
export function sentenceEnd(text: string): number {
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === ".") {
      const word = text.slice(text.lastIndexOf(" ", m.index) + 1, m.index);
      if (isAbbreviation(word.replace(/^[("'\[]+/, ""), text.slice(m.index + 1))) continue;
    }
    return m.index + 1;
  }
  return -1;
}

const COMPONENT_TAG_RE = new RegExp(COMPONENT_TAG_SOURCE_SINGLE_LINE, "g");
/** Main's tag set, before `Check` existed. */
const NO_CHECK_TAG_RE = new RegExp(componentTagSourceSingleLine(COMPONENT_NAMES.filter((n) => n !== "Check")), "g");
const CHECK_TAG_RE = /<\/?Check(?![\w-])/g;
const CHECK_TAG_START_RE = /^<\/?Check\b/;

/** `line` without its component tags. A line with no `<Check>`/`</Check>`
 *  outside a code span reads exactly as before the tag existed. Otherwise a
 *  `<Check>` that starts inside a code span is kept and every other tag goes. */
function withoutTags(line: string): string {
  const code = line.includes("Check") ? lineCodeSpanRanges(line) : [];
  const inCode = (at: number) => code.some((r) => at >= r.start && at < r.end);
  if (![...line.matchAll(CHECK_TAG_RE)].some((m) => !inCode(m.index))) return line.replace(NO_CHECK_TAG_RE, "");
  return line.replace(COMPONENT_TAG_RE, (tag: string, at: number) => CHECK_TAG_START_RE.test(tag) && inCode(at) ? tag : "");
}

/**
 * An item's lead sentence as plain text: the bold run it opens with (the house
 * shape, `**Send the draft.** Blocks Å3.`), else its first line up to the first
 * sentence end. A leading `[ ]` task marker is dropped. A bold LABEL ending in a colon (`**Rune:** send the draft`)
 * names who, not what, so the sentence after it is taken instead; `keepLabel`
 * puts the label back in front of that sentence (`Rune: send the draft`).
 * Component tags, markdown emphasis, code ticks and link syntax are flattened;
 * capped at `MOVES_STEP_CHARS` with an ellipsis.
 */
export function leadSentence(item: string, opts: { keepLabel?: boolean } = {}): string {
  const line = item.split("\n")[0]!;
  // A step's trailing `<Check>` prints nothing, so it is no part of the sentence:
  // it goes with the spaces before it.
  let first = withoutTags(trailingCheck(line)?.[0] ?? line)
    .trim()
    .replace(/^\[[ xX]\][ \t]*/, "");
  // The label run may not contain its own delimiter: only the FIRST bold run
  // can be a label, never a later one ending in a colon.
  const label = /^(\*\*|__)((?:(?!\1).)+?)(?::\1|\1:)\s*(.*)$/.exec(first);
  if (label && label[3]) first = opts.keepLabel ? `${label[2]}: ${label[3]}` : label[3];
  const bold = /^(\*\*|__)(.+?)\1/.exec(first);
  let text = bold ? bold[2]! : first;
  if (!bold) {
    const end = sentenceEnd(text);
    if (end !== -1) text = text.slice(0, end);
  }
  text = text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
  const chars = [...text];
  return chars.length > MOVES_STEP_CHARS ? `${chars.slice(0, MOVES_STEP_CHARS - 1).join("").trimEnd()}…` : text;
}
