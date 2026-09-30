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

import { parseBlocks, nextMovesLanes, type Block, type LaneKind } from "../format/markdown-ast.ts";

/** Lead sentences kept per page, and their length cap. */
export const MOVES_STEPS_MAX = 5;
export const MOVES_STEP_CHARS = 160;

export interface PageNextMoves {
  /** Top-level items per lane kind, summed over every `<NextMoves>` block. */
  counts: Record<LaneKind, number>;
  /** The `you` lanes' item lead sentences, plain text, first `MOVES_STEPS_MAX`. */
  youSteps: string[];
}

/** Every `<NextMoves>` block in `content`, or null when there is none (the
 *  common case, answered by a substring test before any parse). A block with no
 *  `<Lane>` counts as nothing. */
export function extractNextMoves(content: string): PageNextMoves | null {
  if (!content.includes("<NextMoves")) return null;
  const counts: Record<LaneKind, number> = { you: 0, waiting: 0, draft: 0, blocked: 0 };
  const youSteps: string[] = [];
  let found = false;
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type !== "component") continue;
      if (b.name !== "NextMoves") {
        walk(b.children);
        continue;
      }
      found = true;
      for (const lane of nextMovesLanes(b.children)) {
        counts[lane.kind] += lane.items.length;
        if (lane.kind !== "you") continue;
        for (const item of lane.items) {
          if (youSteps.length < MOVES_STEPS_MAX) youSteps.push(leadSentence(item));
        }
      }
    }
  };
  // The frontmatter is not body: a `description:` quoting the grammar is not a block.
  walk(parseBlocks(content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")));
  return found ? { counts, youSteps } : null;
}

/**
 * An item's lead sentence as plain text: the bold run it opens with (the house
 * shape, `**Send the draft.** Blocks Å3.`), else its first line up to the first
 * sentence end. Markdown emphasis, code ticks and link syntax are flattened;
 * capped at `MOVES_STEP_CHARS` with an ellipsis.
 */
export function leadSentence(item: string): string {
  const first = item.split("\n")[0]!.trim();
  const bold = /^(\*\*|__)(.+?)\1/.exec(first);
  let text = bold ? bold[2]! : first;
  if (!bold) {
    const end = /[.!?](\s|$)/.exec(text);
    if (end) text = text.slice(0, end.index + 1);
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
