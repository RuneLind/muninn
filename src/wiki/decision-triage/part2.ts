/**
 * Part (2)'s assembly, pure: which answers it replays, the floor and the day read
 * before any model call, the one decision point, and the headline from what comes
 * back. It holds labels, so only the score script reaches it. Facts and prompt code
 * never do.
 */

import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { isAskedAuthor, parseQuestionTarget } from "../../format/question.ts";
import { sha256 } from "../../utils/date-hash.ts";
import { osloDay } from "../work-map/ids.ts";
import { answeredByChoice, liveAnswers, readPageText, type ReplayCard } from "./facts.ts";
import type { WikiLabels } from "./floor.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, MODEL_OFF_VERSION, replayKey, type CardLine, type FloorState, type RunLine, type VerdictKind } from "./schema.ts";
import {
  CAP_DAY,
  floorOf,
  nightContext,
  nightlyCatches,
  nightlyShares,
  nightsOf,
  part2Headline,
  part2Stop,
  replayReport,
  type NightContext,
  type NightRecord,
  type Part2Headline,
  type Part2Input,
  type Part2Result,
  type ReplayReport,
  type ScoredItem,
} from "./score.ts";

const DAY_MS = 86_400_000;
const FIRST_SCORING_DAY = 14;

/** Answers left out of the score, by why. */
export interface Dropped {
  noHistory: number;
  unreadable: number;
  afterAnswer: number;
  hashMismatch: number;
}

export function droppedOf(wikis: readonly WikiLabels[]): Dropped {
  const rows = wikis.flatMap((w) => w.labelled);
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return { noHistory: count("no-history"), unreadable: count("unreadable"), afterAnswer: count("after-answer"), hashMismatch: count("hash-mismatch") };
}

export interface TriageLog {
  runs: readonly RunLine[];
  cards: readonly CardLine[];
}

/** The current prompt's lines, and how many older ones and model-off ones were left
 *  out. A line with no version predates the field, so it is older. */
export function currentLog(log: TriageLog, version = DECISION_TRIAGE_PROMPT_VERSION): { runs: RunLine[]; cards: CardLine[]; olderLines: number; offLines: number } {
  const runs = log.runs.filter((r) => r.promptVersion === version);
  const cards = log.cards.filter((c) => c.promptVersion === version);
  const offLines = [...log.runs, ...log.cards].filter((l) => l.promptVersion === MODEL_OFF_VERSION).length;
  return { runs, cards, olderLines: log.runs.length + log.cards.length - runs.length - cards.length - offLines, offLines };
}

/** Days since the earliest `ok` or `partial` line of the current prompt, in either wiki. */
export function part2Day(runs: readonly RunLine[], nowMs: number, version = DECISION_TRIAGE_PROMPT_VERSION): number | null {
  const started = runs.filter((r) => r.promptVersion === version && (r.outcome === "ok" || r.outcome === "partial")).map((r) => r.at);
  return started.length ? Math.floor((nowMs - Math.min(...started)) / DAY_MS) : null;
}

/** `--since` may reach back and is cut at the window. A later day would count fewer
 *  answers than the floor on the run line. */
export const sinceAfterWindow = (sinceDay: string, windowMs: number) => sinceDay > osloDay(windowMs);

/** One real scoring, on the append-only record. The figures are aggregates, kept so
 *  a hand sample read afterwards can be added without scoring again. */
export interface ScoringRecord {
  type: "scoring";
  at: number;
  day: number;
  promptVersion: string;
  result: Part2Result;
  /** The hand sample behind this result. */
  hand: { read: number; wrong: number } | null;
  /** Null when the result needed no verdict. */
  input: Part2Input | null;
}

export interface ScoringRecords {
  records: ScoringRecord[];
  broken: number;
}

export function parseScoringRecords(text: string): ScoringRecords {
  const out: ScoringRecords = { records: [], broken: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<ScoringRecord> | null;
      if (row?.type === "scoring" && typeof row.day === "number" && typeof row.result === "string" && typeof row.promptVersion === "string") out.records.push(row as ScoringRecord);
      else out.broken++;
    } catch {
      out.broken++;
    }
  }
  return out;
}

export type ScoringGate =
  /** `before`: nothing can be decided yet, and nothing is recorded. */
  | { allowed: true; kind: "before" | "decision" | "final" }
  /** `amend`: the scoring a hand sample can still be added to. */
  | { allowed: false; line: string; amend: ScoringRecord | null };

/**
 * May a real scoring run now? The first on or after day 14 is the decision point,
 * whatever it reads; after a pass nothing runs, and otherwise the next is the first
 * at or past day 28, once. Only the current prompt's records count: a new version
 * restarts part (2).
 */
export function scoringGate({ records, broken }: ScoringRecords, day: number | null, version = DECISION_TRIAGE_PROMPT_VERSION): ScoringGate {
  if (broken > 0) return { allowed: false, line: `REFUSED: the scoring record has ${broken} broken line(s), so it cannot say what was already scored. Mend the file by hand.`, amend: null };
  if (day === null || day < FIRST_SCORING_DAY) return { allowed: true, kind: "before" };
  const mine = records.filter((r) => r.promptVersion === version);
  const last = mine[mine.length - 1];
  if (!last) return { allowed: true, kind: day >= CAP_DAY ? "final" : "decision" };
  const amend = (last.result === "pass" || last.result === "miss") && last.hand === null && last.input !== null ? last : null;
  const hint = amend ? " A hand sample from it can still be added with --hand." : "";
  if (last.result === "pass") return { allowed: false, line: `REFUSED (day ${day}): the scoring on day ${last.day} passed, and a pass is not scored again.${hint}`, amend };
  const final = mine.find((r) => r.day >= CAP_DAY);
  if (final) return { allowed: false, line: `REFUSED (day ${day}): the scoring on day ${final.day} was the final one (${final.result}), and past day ${CAP_DAY} there is one.${hint}`, amend };
  if (day >= CAP_DAY) return { allowed: true, kind: "final" };
  return { allowed: false, line: `REFUSED (day ${day}): the scoring on day ${last.day} read ${last.result}, so the decision moved to day ${CAP_DAY}, with no scoring between.${hint}`, amend };
}

/** Why `--final` may not run yet. With `floorMet` undefined, what the day alone says. */
export function finalRefusal(day: number | null, floorMet?: boolean): string | null {
  const refused = (d: string) => `REFUSED (${d}): --final prints verdicts, and only at the final scoring: day ${CAP_DAY}, or the first scoring on or after day ${FIRST_SCORING_DAY} that holds the floor.`;
  if (day === null) return refused("no ok or partial run line yet");
  if (day < FIRST_SCORING_DAY) return refused(`day ${day}`);
  if (day < CAP_DAY && floorMet === false) return refused(`day ${day}, under the floor`);
  return null;
}

/** A hand sample read after its scoring: the same figures, not a new scoring. It can
 *  only hold a result or turn a pass into a miss, so it cannot bend toward a pass. */
export function amendWithHand(record: ScoringRecord, hand: { read: number; wrong: number }, nowMs: number): { record: ScoringRecord; headline: Part2Headline } {
  const input: Part2Input = { ...record.input!, handRead: hand.read, handWrong: hand.wrong };
  const headline = part2Headline(input);
  return { headline, record: { ...record, at: nowMs, result: headline.result, hand, input } };
}

export interface Part2Plan {
  cards: ReplayCard[];
  /** The replayed cards that have a label: what the floor counts and the score reads. */
  labelledCards: { card: ReplayCard; added: boolean }[];
  floor: FloorState;
  day: number | null;
  dropped: Dropped;
  nights: NightRecord[];
  context: NightContext;
  /** The headline when it needs no verdict; then no model call is made. */
  stop: Part2Headline | null;
}

/** Everything known with no verdict: `log` is the nightly logs as read. */
export function part2Plan(wikis: readonly WikiLabels[], log: TriageLog, nowMs: number, todayCounts: boolean): Part2Plan {
  const cards: ReplayCard[] = [];
  const labelledCards: Part2Plan["labelledCards"] = [];
  for (const { wiki, labelled } of wikis) {
    for (const l of labelled) {
      if (l.status !== "ok" || l.commit === null) continue;
      const card: ReplayCard = { wiki, relPath: l.settled.relPath, id: l.settled.id, answeredAt: new Date(l.settled.firstAt).toISOString(), commit: l.commit, hashMatches: true, replayable: true };
      cards.push(card);
      if (l.added !== null) labelledCards.push({ card, added: l.added });
    }
  }
  const floor = floorOf(labelledCards.map(({ card, added }) => ({ wiki: card.wiki, relPath: card.relPath, added })));
  const current = currentLog(log);
  const day = part2Day(current.runs, nowMs);
  const nights = nightsOf(current.runs, current.cards, nowMs, todayCounts);
  const context = nightContext(nights, current.olderLines);
  return { cards, labelledCards, floor, day, dropped: droppedOf(wikis), nights, context, stop: part2Stop(day, floor, context) };
}

export interface Part2Run {
  plan: Part2Plan;
  headline: Part2Headline;
  /** Null when the plan's headline stood, so no model was called. */
  scored: { report: ReplayReport; lines: ReadonlyMap<string, CardLine> } | null;
}

/** Part (2) end to end: the gate first, the model only for a headline that needs it,
 *  and the record written before the caller can print a result. */
export async function runPart2(p: {
  wikis: readonly WikiLabels[];
  log: TriageLog;
  nowMs: number;
  todayCounts: boolean;
  hand: { read: number; wrong: number } | null;
  final?: boolean;
  records: ScoringRecords;
  record: (r: ScoringRecord) => Promise<void>;
  replay: (cards: readonly ReplayCard[]) => Promise<ReadonlyMap<string, CardLine>>;
}): Promise<Part2Run> {
  const plan = part2Plan(p.wikis, p.log, p.nowMs, p.todayCounts);
  const refused = (line: string): Part2Run => ({ plan, headline: { result: "refused", line, notes: [] }, scored: null });
  const gate = scoringGate(p.records, plan.day);
  if (!gate.allowed) return refused(gate.line);
  const final = p.final ? finalRefusal(plan.day, plan.floor.met) : null;
  if (final) return refused(final);
  const write = async (headline: Part2Headline, input: Part2Input | null) => {
    if (gate.kind === "before") return;
    await p.record({ type: "scoring", at: p.nowMs, day: plan.day!, promptVersion: DECISION_TRIAGE_PROMPT_VERSION, result: headline.result, hand: p.hand, input });
  };
  if (plan.stop) {
    await write(plan.stop, null);
    return { plan, headline: plan.stop, scored: null };
  }
  const lines = await p.replay(plan.cards);
  const items: ScoredItem[] = plan.labelledCards.map(({ card, added }) => ({ wiki: card.wiki, relPath: card.relPath, id: card.id, added, verdict: lines.get(replayKey(card))?.verdict }));
  const report = replayReport(items);
  const current = currentLog(p.log);
  const answers = p.wikis.flatMap(({ wiki, labelled }) => labelled.map((l) => ({ wiki, relPath: l.settled.relPath, id: l.settled.id, firstAt: l.settled.firstAt, added: l.added })));
  const input: Part2Input = {
    report,
    floor: plan.floor,
    day: plan.day,
    shares: nightlyShares(plan.nights),
    handRead: p.hand?.read ?? null,
    handWrong: p.hand?.wrong ?? null,
    settledThenAnswered: nightlyCatches(answers, current.cards).settledThenAnswered,
    context: plan.context,
  };
  const headline = part2Headline(input);
  await write(headline, input);
  return { plan, headline, scored: { report, lines } };
}

/**
 * Can Rune read a verdict on this card now? Only when today's page has it closed, or
 * the owner's latest answer on today's wording is a real choice. A not-sure, a
 * text-only answer or a colleague's answer leaves it open, and a card not on today's
 * page may have moved, still open. Anything else would anchor the answer being scored.
 */
export function cardDoneToday(
  card: { relPath: string; id: string },
  pageText: string | null,
  versions: readonly WikiAnswerVersion[],
  owner: string | null,
): boolean {
  if (pageText === null) return false;
  const { page } = readPageText(card.relPath, pageText);
  const q = page.questions.find((x) => x.id === card.id);
  if (!q) return false;
  const state = page.states.get(card.id);
  if (state && state.kind !== "open") return true;
  const target = owner ? parseQuestionTarget(owner) : null;
  if (!target) return false;
  // No groups here: a group as owner has no one person's answer, so only closing counts.
  const mine = versions.filter((v) => isAskedAuthor(v.author, [target]) === true);
  return answeredByChoice(liveAnswers(mine, card.relPath, card.id, sha256(q.hashInput), null));
}

const HAND_ONLY: VerdictKind[] = ["SETTLED", "VOID"];
const FINAL_KINDS: VerdictKind[] = ["SETTLED", "VOID", "DEFAULT", "ASK_OWNER", "ASK_OTHER"];
const SAMPLE_PER_KIND = 5;

/** The hand sample: all `SETTLED` and `VOID` on done cards, and at the final scoring
 *  5 each of the others. A verdict on a card not done never reaches `rows`. */
export function handSample(
  cards: readonly ReplayCard[],
  lines: ReadonlyMap<string, CardLine>,
  isDone: (card: ReplayCard) => boolean,
  final: boolean,
): { kind: VerdictKind; total: number; rows: CardLine[] }[] {
  const done = cards.flatMap((c) => {
    const line = lines.get(replayKey(c));
    return line && isDone(c) ? [line] : [];
  });
  return (final ? FINAL_KINDS : HAND_ONLY).map((kind) => {
    const all = done.filter((r) => r.verdict === kind);
    return { kind, total: all.length, rows: HAND_ONLY.includes(kind) ? all : all.slice(0, SAMPLE_PER_KIND) };
  });
}
