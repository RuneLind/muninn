/**
 * Part (2)'s assembly, pure: which answers it replays, the floor and the day read
 * before any model call, and the headline from what comes back. It holds labels, so
 * only the score script reaches it. Facts and prompt code never do.
 */

import type { ReplayCard } from "./facts.ts";
import type { WikiLabels } from "./floor.ts";
import { replayKey, type CardLine, type FloorState, type RunLine } from "./schema.ts";
import { floorOf, nightlyCatches, nightlyShares, nightsOf, part2Headline, part2Stop, replayReport, type Part2Headline, type ReplayReport, type ScoredItem } from "./score.ts";

const DAY_MS = 86_400_000;

/** Answers left out of the score, by why. */
export interface Dropped {
  noHistory: number;
  unreadable: number;
  afterAnswer: number;
  hashMismatch: number;
}

export interface Part2Plan {
  cards: ReplayCard[];
  /** The replayed cards that have a label: what the floor counts and the score reads. */
  labelledCards: { card: ReplayCard; added: boolean }[];
  floor: FloorState;
  day: number | null;
  dropped: Dropped;
  /** The headline when it needs no verdict; then no model call is made. */
  stop: Part2Headline | null;
}

export function droppedOf(wikis: readonly WikiLabels[]): Dropped {
  const rows = wikis.flatMap((w) => w.labelled);
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return { noHistory: count("no-history"), unreadable: count("unreadable"), afterAnswer: count("after-answer"), hashMismatch: count("hash-mismatch") };
}

/** Everything known with no verdict: `runs` are the nightly logs' run lines. */
export function part2Plan(wikis: readonly WikiLabels[], runs: readonly RunLine[], nowMs: number): Part2Plan {
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
  const started = runs.filter((r) => r.outcome === "ok" || r.outcome === "partial").map((r) => r.at);
  const day = started.length ? Math.floor((nowMs - Math.min(...started)) / DAY_MS) : null;
  return { cards, labelledCards, floor, day, dropped: droppedOf(wikis), stop: part2Stop(day, floor) };
}

export interface Part2Run {
  plan: Part2Plan;
  headline: Part2Headline;
  /** Null when the plan's headline stood, so no model was called. */
  scored: { report: ReplayReport; lines: ReadonlyMap<string, CardLine> } | null;
}

/** Part (2) end to end: the model is called only for a headline that needs it. */
export async function runPart2(p: {
  wikis: readonly WikiLabels[];
  log: { runs: readonly RunLine[]; cards: readonly CardLine[] };
  nowMs: number;
  hand: { read: number; wrong: number } | null;
  replay: (cards: readonly ReplayCard[]) => Promise<ReadonlyMap<string, CardLine>>;
}): Promise<Part2Run> {
  const plan = part2Plan(p.wikis, p.log.runs, p.nowMs);
  if (plan.stop) return { plan, headline: plan.stop, scored: null };
  const lines = await p.replay(plan.cards);
  const items: ScoredItem[] = plan.labelledCards.map(({ card, added }) => ({ wiki: card.wiki, relPath: card.relPath, id: card.id, added, verdict: lines.get(replayKey(card))?.verdict }));
  const report = replayReport(items);
  const answers = p.wikis.flatMap(({ wiki, labelled }) => labelled.map((l) => ({ wiki, relPath: l.settled.relPath, id: l.settled.id, firstAt: l.settled.firstAt, added: l.added })));
  const headline = part2Headline({
    report,
    floor: plan.floor,
    day: plan.day,
    shares: nightlyShares(nightsOf([...p.log.runs], [...p.log.cards], p.nowMs)),
    handRead: p.hand?.read ?? null,
    handWrong: p.hand?.wrong ?? null,
    settledThenAnswered: nightlyCatches(answers, [...p.log.cards]).settledThenAnswered,
  });
  return { plan, headline, scored: { report, lines } };
}
