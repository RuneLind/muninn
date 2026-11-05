/**
 * The decision triage's shapes: the model's verdict (zod, since page text is
 * untrusted and so is what the model made of it) and the log's two line kinds.
 */

import { z } from "zod";

/** Changes only by hand, with the prompt. A new value restarts part (2): its day,
 *  its answer window and the figures read only this version's lines. */
export const DECISION_TRIAGE_PROMPT_VERSION = "2026-11-05.5";
/** The frozen prompt's date: part (2) replays answers given after it. */
export const DECISION_TRIAGE_PROMPT_FROZEN_ON = "2026-11-05";

export const VERDICT_KINDS = ["SETTLED", "VOID", "DEFAULT", "ASK_OWNER", "ASK_OTHER"] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

/** A card line's verdict: the model's five, or the two that took no verdict. */
export type CardOutcome = VerdictKind | "ANSWERED" | "NO_VERDICT";

export const verdictSchema = z.object({
  card: z.string(),
  verdict: z.enum(VERDICT_KINDS),
  costOfDelay: z.enum(["low", "medium", "high"]),
  reversible: z.boolean(),
  onlyOwnerHas: z.string().nullable(),
  why: z.string().min(1),
  evidence: z.array(z.string()),
  /** What the verdict rests on, as `repo#N` or `#N`, without state (D4). */
  restsOnPrs: z.array(z.string()),
});
export type Verdict = z.infer<typeof verdictSchema>;

export const answerSchema = z.object({ verdicts: z.array(z.unknown()) });

export interface TriageUsage {
  calls: number;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Why a read has no result, as distinct from a result of nothing. Fixed words: git's
 *  stderr names paths and varies between runs, and this goes to the model. */
export type SearchFailure = "timed out" | "git error";

/** One repo as the run found it: the run line and every card's facts carry it. */
export interface RepoFact {
  repo: string;
  found: boolean;
  /** Why it counts as not found. */
  reason?: string;
  ref?: string;
  tipDate?: string;
  fetch?: "ok" | "skipped" | { failed: SearchFailure };
  /** Git could not read the tip, so there is no `tipDate`. */
  searchFailed?: SearchFailure;
}

export interface FloorState {
  labelled: number;
  added: number;
  /** Distinct pages holding an answer that added something. */
  addedPages: number;
  met: boolean;
  /** Set when the floor could not be read tonight. */
  error?: string;
}

export type RunOutcome = "ok" | "partial" | "refused" | "failed";

export interface RunLine {
  type: "run";
  runId: string;
  at: number;
  wiki: string;
  model: string;
  promptVersion: string;
  usage: TriageUsage;
  repoRoots: string | null;
  repos: RepoFact[];
  cards: number;
  floor: FloorState | null;
  outcome: RunOutcome;
  reason?: string;
}

export interface CardLine {
  type: "card";
  runId: string;
  at: number;
  wiki: string;
  /** The prompt that read this card: the score reads only the current version's lines. */
  promptVersion: string;
  relPath: string;
  id: string;
  questionHash: string;
  recommendation: string | null;
  verdict: CardOutcome;
  /** Why a card has no verdict. */
  reason?: string;
  /** Replay only: the moment the card was read as of. */
  answeredAt?: string;
  /** Replay only: the digest of what the model read (`replayDigest`). A re-run keeps
   *  this line only for that same message. */
  messageDigest?: string;
  codeFacts?: boolean;
  costOfDelay?: Verdict["costOfDelay"];
  reversible?: boolean;
  onlyOwnerHas?: string | null;
  why?: string;
  evidence?: string[];
  restsOnPrs?: string[];
}

export type LogLine = RunLine | CardLine;

/** A replayed card: the scorer's labels and the replay log both key on this. */
export const replayKey = (c: { wiki: string; relPath: string; id: string; answeredAt?: string | null }) => `${c.wiki}\0${c.relPath}\0${c.id}\0${c.answeredAt ?? ""}`;
