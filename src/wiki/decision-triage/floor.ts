/**
 * The floor's state on a run line: labelled answers given after the frozen prompt,
 * across the wikis in scope. Read at run time, so it can lag a wiki whose answers
 * arrive later that night.
 */

import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { cutLine, type GitRun } from "./git.ts";
import { labelAnswers, type LabelledAnswer } from "./history.ts";
import { DECISION_TRIAGE_DIR, nightlyLogPath, readLog } from "./log.ts";
import { floorOf } from "./score.ts";
import { DECISION_TRIAGE_PROMPT_FROZEN_ON, DECISION_TRIAGE_PROMPT_VERSION, type FloorState, type RunLine } from "./schema.ts";

/** The first moment after the frozen prompt's date. */
export function frozenAfterMs(frozenOn = DECISION_TRIAGE_PROMPT_FROZEN_ON): number {
  return Date.parse(`${frozenOn}T00:00:00Z`) + 86_400_000;
}

/** Where part (2)'s answers start, for the run line's floor and the score alike: the
 *  later of the frozen date and the current prompt's first run line, of any outcome. */
export function answerWindowMs(runs: readonly Pick<RunLine, "at" | "promptVersion">[], version = DECISION_TRIAGE_PROMPT_VERSION, frozenOn = DECISION_TRIAGE_PROMPT_FROZEN_ON): number {
  const mine = runs.filter((r) => r.promptVersion === version).map((r) => r.at);
  return Math.max(frozenAfterMs(frozenOn), ...(mine.length ? [Math.min(...mine)] : []));
}

export interface WikiLabels {
  wiki: string;
  labelled: LabelledAnswer[];
  /** Why this wiki's history could not be read at all: a setup fault, never a result. */
  fault?: string;
}

/** Answers on or after `sinceMs`, each read against its card as answered. A root
 *  git cannot read is found before its answers are asked for. */
export async function labelsSince(
  entries: readonly { wiki: string; root: string }[],
  sinceMs: number,
  history: (wiki: string) => Promise<WikiAnswerVersion[]>,
  git: GitRun,
  opts: { windowMs?: number; untilMs?: number } = {},
): Promise<WikiLabels[]> {
  const out: WikiLabels[] = [];
  for (const { wiki, root } of entries) {
    const head = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!head.ok) {
      out.push({ wiki, labelled: [], fault: `${wiki}'s root ${root} has no history to read: ${cutLine(head.stderr?.trim().split("\n")[0] ?? "git failed")}` });
      continue;
    }
    const versions = (await history(wiki)).filter((v) => opts.untilMs === undefined || v.createdAt <= opts.untilMs);
    const labelled = await labelAnswers(root, versions, git, { ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}), sinceMs });
    const wholesale = labelled.length > 0 && labelled.every((l) => l.status === "unreadable");
    out.push({ wiki, labelled, ...(wholesale ? { fault: `none of ${wiki}'s ${labelled.length} answers could be read from git at ${root}` } : {}) });
  }
  return out;
}

/** `ownLineAt`: the line this run is about to write to these logs, which carries
 *  `ownLineVersion` (the current prompt's unless the model call is off). */
export async function computeFloor(
  entries: readonly { wiki: string; root: string }[],
  history: (wiki: string) => Promise<WikiAnswerVersion[]>,
  git: GitRun,
  opts: { dir?: string; ownLineAt?: number; ownLineVersion?: string } = {},
): Promise<FloorState> {
  const logs = await Promise.all(entries.map((e) => readLog(nightlyLogPath(e.wiki, opts.dir ?? DECISION_TRIAGE_DIR))));
  const runs = [...logs.flatMap((l) => l.runs), ...(opts.ownLineAt === undefined ? [] : [{ at: opts.ownLineAt, promptVersion: opts.ownLineVersion ?? DECISION_TRIAGE_PROMPT_VERSION }])];
  const wikis = await labelsSince(entries, answerWindowMs(runs), history, git);
  const faults = wikis.flatMap((w) => w.fault ?? []);
  if (faults.length > 0) throw new Error(faults.join("; "));
  return floorOf(wikis.flatMap(({ wiki, labelled }) => labelled.filter((l) => l.status === "ok").map((l) => ({ wiki, relPath: l.settled.relPath, added: l.added }))));
}
