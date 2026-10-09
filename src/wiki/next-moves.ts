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

import { parseBlocks, countedNextMovesLanes, type LaneKind } from "../format/markdown-ast.ts";
import { splitFrontmatter } from "./page-text.ts";
import { leadSentence, MOVES_STEP_CHARS } from "../format/lead-sentence.ts";

export { leadSentence, MOVES_STEP_CHARS };

/** Lead sentences kept per page, and their length cap. */
export const MOVES_STEPS_MAX = 5;

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
