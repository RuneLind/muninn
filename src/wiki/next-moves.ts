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

import { parseBlocks, countedNextMovesLanes, type Block, type LaneKind } from "../format/markdown-ast.ts";
import {
  isAskedAuthor,
  namedQuestionIds,
  parseQuestionPage,
  parseQuestionsTo,
  parseQuestionTarget,
  resolveQuestionTargets,
  type AnswerGroups,
} from "../format/question.ts";
import { splitFrontmatter, WIKILINK_WITH_LABEL_RE } from "./page-text.ts";
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
  /** The counted `waiting` lanes, each with its parsed `since` (null when absent
   *  or not a date) and its open steps as written. */
  waiting: { since: string | null; items: string[] }[];
  /** The parsed body, so {@link waitsOnOwner} needs no second parse. */
  blocks: Block[];
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
  const blocks = parseBlocks(splitFrontmatter(content).body);
  const { lanes, found } = countedNextMovesLanes(blocks);
  if (!found) return null;
  const counts: Record<LaneKind, number> = { you: 0, waiting: 0, draft: 0, blocked: 0 };
  const youSteps: string[] = [];
  const waiting: PageNextMoves["waiting"] = [];
  for (const lane of lanes) {
    counts[lane.kind] += lane.items.length;
    if (lane.kind === "waiting") waiting.push({ since: lane.since, items: lane.items });
    if (lane.kind !== "you") continue;
    for (const item of lane.items) {
      if (youSteps.length < MOVES_STEPS_MAX) youSteps.push(leadSentence(item));
    }
  }
  return { counts, youSteps, waiting, blocks };
}

/** Who a wait has to ask to count: `WIKI_ANSWER_OWNER` and `WIKI_ANSWER_GROUPS`. */
export interface WaitOwner {
  /** As configured: the question's fallback target when nothing else names one. */
  owner: string;
  author: { name: string; navIdent: string | null };
  groups: AnswerGroups;
}

/** The owner as {@link waitsOnOwner} reads it, or null when none is set. */
export function waitOwnerFrom(cfg: { owner: string | null; groups?: AnswerGroups }): WaitOwner | null {
  const target = cfg.owner ? parseQuestionTarget(cfg.owner) : null;
  if (!cfg.owner || !target) return null;
  return { owner: cfg.owner, author: { name: target.name, navIdent: target.ident }, groups: cfg.groups ?? new Map() };
}

/**
 * What waits on the owner on this page: the one rule behind the strip and the
 * board. The distinct `<Question>` ids a counted `waiting` lane names that are
 * open and ask the owner, and the oldest parsed `since` among the lanes holding
 * one. A wikilink names nothing (the reader parks them before it scans) and a
 * duplicated id does not count, so the reader's lane counts and this agree. An
 * id absent from `states` is open, as the reader treats it.
 */
export function waitsOnOwner(
  moves: PageNextMoves,
  questionsToRaw: unknown,
  who: WaitOwner,
): { ids: string[]; oldestSince: string | null } {
  if (!moves.waiting.length) return { ids: [], oldestSince: null };
  const page = parseQuestionPage(moves.blocks);
  const questionsTo = parseQuestionsTo(questionsToRaw);
  const asked = new Set<string>();
  for (const q of page.questions) {
    if (q.id === null || q.duplicate || (page.states.get(q.id)?.kind ?? "open") !== "open") continue;
    const { to } = resolveQuestionTargets(q.to, questionsTo, who.owner);
    if (isAskedAuthor(who.author, to, who.groups) === true) asked.add(q.id);
  }
  const ids = new Set<string>();
  let oldestSince: string | null = null;
  for (const lane of moves.waiting) {
    const named = lane.items.flatMap((item) => namedQuestionIds(item.replace(WIKILINK_WITH_LABEL_RE, "\x00"), asked));
    if (!named.length) continue;
    for (const id of named) ids.add(id);
    if (lane.since && (!oldestSince || lane.since < oldestSince)) oldestSince = lane.since;
  }
  return { ids: [...ids], oldestSince };
}
