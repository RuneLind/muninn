/**
 * Index-time read of a page's `<NextMoves>` blocks: how many steps wait on the
 * reader (`you` lanes) and their lead sentences. The step text lives only in the
 * page body; the `/wiki` ✋ flag and the `/plans` Waiting on you filter derive
 * from it here, so there is no frontmatter flag to keep in step with it.
 *
 * Parsed with the shared block parser (`parseBlocks`), the one the renderer
 * uses, so a `<NextMoves>` inside a code fence is not a block here either, and
 * a lane's count is `NextMovesLane.items`, the same number the reader's pill
 * sums off the rendered `data-count`.
 */

import {
  COMPONENT_TAG_SOURCE_SINGLE_LINE,
  parseBlocks,
  countedNextMovesLanes,
  type LaneKind,
} from "../format/markdown-ast.ts";
import { splitFrontmatter } from "./page-text.ts";

/** Lead sentences kept per page, and their length cap. */
export const MOVES_STEPS_MAX = 5;
export const MOVES_STEP_CHARS = 160;

export interface PageNextMoves {
  /** Open steps per lane kind (`NextMovesLane.items`), summed over every
   *  counted `<NextMoves>` block. */
  counts: Record<LaneKind, number>;
  /** The `you` lanes' item lead sentences, plain text, first `MOVES_STEPS_MAX`. */
  youSteps: string[];
}

/** Every `<NextMoves>` block in `content`, or null when there is none (the
 *  common case, answered by a substring test before any parse). A block with no
 *  `<Lane>`, or one inside a `<Historic>` or a resolved `<Callout>`
 *  (`countedNextMovesLanes`), counts as nothing. */
export function extractNextMoves(content: string): PageNextMoves | null {
  if (!content.includes("<NextMoves")) return null;
  // The frontmatter is not body: a `description:` quoting the grammar is not a
  // block. The renderer's own split (`stripFrontmatter` is this function), so
  // the index and the reader agree on where the body starts.
  const { lanes, found } = countedNextMovesLanes(parseBlocks(splitFrontmatter(content).body));
  if (!found) return null;
  const counts: Record<LaneKind, number> = { you: 0, waiting: 0, draft: 0, blocked: 0 };
  const youSteps: string[] = [];
  for (const lane of lanes) {
    counts[lane.kind] += lane.items.length;
    if (lane.kind !== "you") continue;
    for (const item of lane.items) {
      if (youSteps.length < MOVES_STEPS_MAX) youSteps.push(leadSentence(item));
    }
  }
  return { counts, youSteps };
}

/** Abbreviations whose dot is not a sentence end, lowercased, dot included —
 *  English and Norwegian, the two languages the wikis are written in. */
const ABBREVIATIONS = new Set([
  "e.g.", "i.e.", "etc.", "vs.", "cf.", "approx.", "incl.", "excl.", "no.",
  "f.eks.", "bl.a.", "dvs.", "osv.", "ca.", "jf.", "evt.", "nr.", "pkt.", "inkl.", "ekskl.", "mht.", "mtp.", "ref.", "kap.", "o.l.", "m.m.", "mv.",
]);

/** Where the first sentence of `text` ends (the index after its `.`/`!`/`?`),
 *  or -1. A dot closing a known abbreviation is not an end. */
function sentenceEnd(text: string): number {
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === ".") {
      const word = text.slice(text.lastIndexOf(" ", m.index) + 1, m.index + 1).toLowerCase();
      if (ABBREVIATIONS.has(word.replace(/^[("'\[]+/, ""))) continue;
    }
    return m.index + 1;
  }
  return -1;
}

const COMPONENT_TAG_RE = new RegExp(COMPONENT_TAG_SOURCE_SINGLE_LINE, "g");

/**
 * An item's lead sentence as plain text: the bold run it opens with (the house
 * shape, `**Send the draft.** Blocks Å3.`), else its first line up to the first
 * sentence end. A leading `[ ]` task marker is dropped. A bold LABEL ending in a colon (`**Rune:** send the draft`)
 * names who, not what, so the sentence after it is taken instead. Component
 * tags, markdown emphasis, code ticks and link syntax are flattened; capped at
 * `MOVES_STEP_CHARS` with an ellipsis.
 */
export function leadSentence(item: string): string {
  let first = item
    .split("\n")[0]!
    .replace(COMPONENT_TAG_RE, "")
    .trim()
    .replace(/^\[[ xX]\][ \t]*/, "");
  const label = /^(\*\*|__)(.+?)(?::\1|\1:)\s*(.*)$/.exec(first);
  if (label && label[3]) first = label[3];
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
