/**
 * The floor's state on a run line: labelled answers given after the frozen prompt,
 * across the wikis in scope. Read at run time, so it can lag a wiki whose answers
 * arrive later that night.
 */

import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import type { GitRun } from "./git.ts";
import { labelAnswers, type LabelledAnswer } from "./history.ts";
import { floorOf } from "./score.ts";
import { DECISION_TRIAGE_PROMPT_FROZEN_ON, type FloorState } from "./schema.ts";

/** The first moment after the frozen prompt's date. */
export function frozenAfterMs(frozenOn = DECISION_TRIAGE_PROMPT_FROZEN_ON): number {
  return Date.parse(`${frozenOn}T00:00:00Z`) + 86_400_000;
}

export interface WikiLabels {
  wiki: string;
  labelled: LabelledAnswer[];
}

/** Answers on or after `sinceMs`, each read against its card as answered. */
export async function labelsSince(
  entries: readonly { wiki: string; root: string }[],
  sinceMs: number,
  history: (wiki: string) => Promise<WikiAnswerVersion[]>,
  git: GitRun,
  opts: { windowMs?: number; untilMs?: number } = {},
): Promise<WikiLabels[]> {
  const out: WikiLabels[] = [];
  for (const { wiki, root } of entries) {
    const versions = (await history(wiki)).filter((v) => opts.untilMs === undefined || v.createdAt <= opts.untilMs);
    const labelled = await labelAnswers(root, versions, git, { ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}), sinceMs });
    out.push({ wiki, labelled });
  }
  return out;
}

export async function computeFloor(
  entries: readonly { wiki: string; root: string }[],
  history: (wiki: string) => Promise<WikiAnswerVersion[]>,
  git: GitRun,
): Promise<FloorState> {
  const wikis = await labelsSince(entries, frozenAfterMs(), history, git);
  return floorOf(wikis.flatMap(({ wiki, labelled }) => labelled.filter((l) => l.status === "ok").map((l) => ({ wiki, relPath: l.settled.relPath, added: l.added }))));
}
