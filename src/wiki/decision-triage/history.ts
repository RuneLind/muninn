/**
 * A card as it read when it was answered, from git: the scorer's label and part
 * (2)'s replay moment both need it. Never used to build tonight's facts.
 */

import { parseRecommendation } from "../../format/question.ts";
import { sha256 } from "../../gardener/util.ts";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { readPageText } from "./facts.ts";
import type { GitRun } from "./git.ts";
import { labelOf, settledAnswers, type Settled } from "./score.ts";

const COMMITS_READ_MAX = 80;

export type AnsweredStatus =
  /** The newest commit before the answer holds the card, on the answered wording. */
  | "ok"
  /** The page at that commit holds other wording. */
  | "hash-mismatch"
  /** No commit before the answer holds the card: first committed after it. */
  | "after-answer"
  /** No commit holds the card at all. */
  | "no-history";

export interface CardAsAnswered {
  status: AnsweredStatus;
  /** The newest commit before the answer holding the card. */
  commit: string | null;
  /** The card's text as answered, or null with no text anywhere. */
  body: string | null;
  choices: string[];
}

interface CardAt {
  sha: string;
  at: number;
  hash: string;
  body: string;
  choices: string[];
}

/**
 * Read the card as answered: at the newest commit before the answer when its
 * hash agrees; else at the commit nearest the answer holding the answered hash;
 * else at that newest commit, or the earliest commit after it, which is the
 * closest text there is.
 */
export async function cardAsAnswered(root: string, relPath: string, id: string, hash: string, atMs: number, git: GitRun): Promise<CardAsAnswered> {
  const log = await git(root, ["log", "--format=%H %ct", "HEAD", "--", relPath], { maxLines: COMMITS_READ_MAX });
  const commits = log.stdout.split("\n").filter(Boolean).map((l) => {
    const [sha, ct] = l.split(" ");
    return { sha: sha!, at: Number(ct) * 1000 };
  });
  const cache = new Map<string, CardAt | null>();
  const read = async (c: { sha: string; at: number }): Promise<CardAt | null> => {
    if (cache.has(c.sha)) return cache.get(c.sha)!;
    const show = await git(root, ["show", `${c.sha}:./${relPath}`]);
    const q = show.ok ? readPageText(relPath, show.stdout).page.questions.find((x) => x.id === id) : undefined;
    const card = q ? { sha: c.sha, at: c.at, hash: sha256(q.hashInput), body: q.body, choices: q.choices } : null;
    cache.set(c.sha, card);
    return card;
  };

  const before = commits.filter((c) => c.at <= atMs);
  const after = commits.filter((c) => c.at > atMs).reverse();
  let newestBefore: CardAt | null = null;
  for (const c of before) {
    newestBefore = await read(c);
    if (newestBefore) break;
  }
  if (newestBefore?.hash === hash) return { status: "ok", commit: newestBefore.sha, body: newestBefore.body, choices: newestBefore.choices };

  // Nearest first: earlier text before the answer, then later text after it.
  let holding: CardAt | null = null;
  for (const c of [...before, ...after]) {
    const card = await read(c);
    if (card?.hash === hash) {
      holding = card;
      break;
    }
  }
  if (newestBefore) {
    const text = holding ?? newestBefore;
    return { status: "hash-mismatch", commit: newestBefore.sha, body: text.body, choices: text.choices };
  }
  if (holding) return { status: "after-answer", commit: null, body: holding.body, choices: holding.choices };
  for (const c of after) {
    const card = await read(c);
    if (card) return { status: "after-answer", commit: null, body: card.body, choices: card.choices };
  }
  return { status: "no-history", commit: null, body: null, choices: [] };
}

/** A question's first answer, read against its card as answered. */
export interface LabelledAnswer {
  settled: Settled;
  status: AnsweredStatus;
  commit: string | null;
  recommendation: string | null;
  /** It added something; null when it has no label. */
  added: boolean | null;
}

export async function labelAnswers(
  root: string,
  versions: readonly WikiAnswerVersion[],
  git: GitRun,
  opts: { windowMs?: number; sinceMs?: number } = {},
): Promise<LabelledAnswer[]> {
  const out: LabelledAnswer[] = [];
  for (const settled of settledAnswers(versions, opts)) {
    if (opts.sinceMs !== undefined && settled.firstAt < opts.sinceMs) continue;
    const card = await cardAsAnswered(root, settled.relPath, settled.id, settled.questionHash, settled.firstAt, git);
    const recommendation = card.body === null ? null : parseRecommendation(card.body, card.choices);
    out.push({ settled, status: card.status, commit: card.commit, recommendation, added: labelOf(settled, recommendation) });
  }
  return out;
}
